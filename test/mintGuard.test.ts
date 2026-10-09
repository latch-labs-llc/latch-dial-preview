/**
 * v0.9 #2: the client-side mint vetting says what the program will say.
 * Token-2022 mints are built in LiteSVM with each extension; the verdicts
 * are checked against `create_deal` on the deployed binary.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { address } from "@solana/kit";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeDefaultAccountStateInstruction,
  createInitializeInterestBearingMintInstruction,
  createInitializeMint2Instruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
} from "@solana/spl-token";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { RISK, TOKEN_PROGRAM } from "../src/lib/config";
import { vetMintAccount } from "../src/lib/mintGuard";
import { toDealSpec, type CustomTerms } from "../src/lib/customTerms";

const DAY = 86400;

function t22Mint(c: Chain, authority: Keypair, exts: ExtensionType[], init: (mint: PublicKey) => any[], freeze = false): PublicKey {
  const m = Keypair.generate();
  const space = getMintLen(exts);
  const rent = c.svm.minimumBalanceForRentExemption(BigInt(space));
  c.send(
    [
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: m.publicKey, lamports: Number(rent), space, programId: TOKEN_2022_PROGRAM_ID }),
      ...init(m.publicKey),
      createInitializeMint2Instruction(m.publicKey, 6, authority.publicKey, freeze ? authority.publicKey : null, TOKEN_2022_PROGRAM_ID),
    ],
    authority,
    [m],
  );
  return m.publicKey;
}

function vet(c: Chain, mint: PublicKey) {
  const a: any = c.svm.getAccount(address(mint.toBase58()));
  return vetMintAccount(mint, new PublicKey(String(a.programAddress)), Uint8Array.from(a.data));
}

describe("v0.9 #2: mint vetting mirrors mint_guard.rs", () => {
  it("classic SPL mint: freeze authority → FREEZE_AUTHORITY; nothing else", () => {
    const c = new Chain();
    const issuer = c.wallet();
    const v = vet(c, c.mint(issuer));
    expect(v).toMatchObject({ flags: RISK.FREEZE_AUTHORITY, rejected: null, decimals: 6 });
    expect(v.tokenProgram.equals(TOKEN_PROGRAM)).toBe(true);
  });

  it("Token-2022 flags: permanent delegate, transfer fee, dormant hook, interest-bearing, mint close authority; plain = 0", () => {
    const c = new Chain();
    const a = c.wallet();
    const cases: [ExtensionType[], (m: PublicKey) => any[], number][] = [
      [[], () => [], 0],
      [[ExtensionType.PermanentDelegate], (m) => [createInitializePermanentDelegateInstruction(m, a.publicKey, TOKEN_2022_PROGRAM_ID)], RISK.PERMANENT_DELEGATE],
      [[ExtensionType.TransferFeeConfig], (m) => [createInitializeTransferFeeConfigInstruction(m, a.publicKey, a.publicKey, 100, 1_000_000n, TOKEN_2022_PROGRAM_ID)], RISK.TRANSFER_FEE],
      [[ExtensionType.TransferHook], (m) => [createInitializeTransferHookInstruction(m, a.publicKey, PublicKey.default, TOKEN_2022_PROGRAM_ID)], RISK.DORMANT_TRANSFER_HOOK],
      [[ExtensionType.InterestBearingConfig], (m) => [createInitializeInterestBearingMintInstruction(m, a.publicKey, 500, TOKEN_2022_PROGRAM_ID)], RISK.INTEREST_BEARING],
      [[ExtensionType.MintCloseAuthority], (m) => [createInitializeMintCloseAuthorityInstruction(m, a.publicKey, TOKEN_2022_PROGRAM_ID)], RISK.MINT_CLOSE_AUTHORITY],
    ];
    for (const [exts, init, flags] of cases) {
      const v = vet(c, t22Mint(c, a, exts, init));
      expect(v, String(exts)).toMatchObject({ flags, rejected: null });
      expect(v.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    }
    // Freeze authority adds its bit on Token-2022 too.
    expect(vet(c, t22Mint(c, a, [ExtensionType.PermanentDelegate], (m) => [createInitializePermanentDelegateInstruction(m, a.publicKey, TOKEN_2022_PROGRAM_ID)], true)).flags).toBe(RISK.PERMANENT_DELEGATE | RISK.FREEZE_AUTHORITY);
  });

  it("rejects: active transfer hook, default-frozen, non-transferable; and a non-mint account", () => {
    const c = new Chain();
    const a = c.wallet();
    const hookProgram = Keypair.generate().publicKey;
    expect(vet(c, t22Mint(c, a, [ExtensionType.TransferHook], (m) => [createInitializeTransferHookInstruction(m, a.publicKey, hookProgram, TOKEN_2022_PROGRAM_ID)])).rejected).toMatch(/transfer hook program/);
    expect(vet(c, t22Mint(c, a, [ExtensionType.DefaultAccountState], (m) => [createInitializeDefaultAccountStateInstruction(m, AccountState.Frozen, TOKEN_2022_PROGRAM_ID)], true)).rejected).toMatch(/start frozen/);
    expect(vet(c, t22Mint(c, a, [ExtensionType.NonTransferable], (m) => [createInitializeNonTransferableMintInstruction(m, TOKEN_2022_PROGRAM_ID)])).rejected).toMatch(/can't be transferred/);
    expect(vetMintAccount(a.publicKey, SystemProgram.programId, new Uint8Array()).rejected).toBe("Not a token mint.");
  });

  it("the program agrees: a permanent-delegate mint needs that flag accepted; an active hook is refused outright", async () => {
    const c = new Chain();
    const a = c.wallet();
    const sam = c.wallet();
    const pd = t22Mint(c, a, [ExtensionType.PermanentDelegate], (m) => [createInitializePermanentDelegateInstruction(m, a.publicKey, TOKEN_2022_PROGRAM_ID)]);
    const terms = (mint: PublicKey, accepted: number): CustomTerms => ({
      creator: a.publicKey,
      dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)),
      parties: [a.publicKey, sam.publicKey],
      payerIdx: 0,
      payeeIdx: 1,
      approvalThreshold: 2,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      decimals: 6,
      parts: [{ label: "", amount: 1_000_000n }],
      rule: "TimeoutRelease",
      timerMode: "FromActivation",
      timeoutSecs: 10 * DAY,
      splitBps: 0,
      tieBreaker: null,
      disputePolicy: "NeverExpire",
      disputeWindowSecs: 0,
      consentTrueDeadlock: false,
      recoverySigners: [a.publicKey, sam.publicKey],
      recoveryThreshold: 2,
      recoveryDelaySecs: 3 * DAY,
      detectedRiskFlags: vet(c, mint).flags,
      acceptedRiskFlags: accepted,
      priceRiskTerm: 0,
    });
    expectProgramError(c.trySend(await F.createAndSign(toDealSpec(terms(pd, 0)), false), a), "RiskFlagsNotAccepted");
    expect(c.trySend(await F.createAndSign(toDealSpec(terms(pd, RISK.PERMANENT_DELEGATE)), false), a)).toBeNull();
    const hooked = t22Mint(c, a, [ExtensionType.TransferHook], (m) => [createInitializeTransferHookInstruction(m, a.publicKey, Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID)]);
    expectProgramError(c.trySend(await F.createAndSign(toDealSpec(terms(hooked, 0xffff)), false), a), "ActiveTransferHook");
  });
});
