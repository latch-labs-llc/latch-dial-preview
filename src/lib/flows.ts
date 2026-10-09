/**
 * Transaction builders for every dial flow. Pure: each returns instructions
 * built from already-known deal fields (no RPC reads), so the same code runs
 * in the browser and in the LiteSVM tests against the deployed binary.
 *
 * Every instruction here is a user-signed party action or a permissionless
 * crank. Nothing is signed by any Latch Labs key — none exists.
 */
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { IDL, dealPda, vaultAta, type Latch } from "@latch-labs/sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { NATIVE_MINT, PROGRAM_ID, TOKEN_PROGRAM } from "./config";
import { allMask, hasBit, nextMilestone, partyIndex, type Deal, type DisputePolicyName, type RuleName, type TimerModeName } from "./deal";

const RULES: Record<RuleName, object> = {
  TimeoutRelease: { timeoutRelease: {} },
  TimeoutRefund: { timeoutRefund: {} },
  AutoSplit: { autoSplit: {} },
  TieBreaker: { tieBreaker: {} },
  LongSunset: { longSunset: {} },
  TrueDeadlock: { trueDeadlock: {} },
};
const TIMERS: Record<TimerModeName, object> = {
  FromDeadlock: { fromDeadlock: {} },
  FromActivation: { fromActivation: {} },
};

/** An Anchor Program used only to encode instructions (never to send or fetch). */
function encoderProgram(): Program<Latch> {
  const dummy = Keypair.generate();
  const wallet = {
    publicKey: dummy.publicKey,
    signTransaction: async (t: any) => t,
    signAllTransactions: async (t: any) => t,
  };
  const provider = new AnchorProvider(new Connection("http://127.0.0.1:1"), wallet as any, {});
  return new Program<Latch>(IDL as any, provider);
}
let _program: Program<Latch> | null = null;
const program = () => (_program ??= encoderProgram());
/** The encoder Program (IDL + coders), for decoding events too. */
export const latchProgram = program;

export const ata = (owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM) =>
  getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);

function ensureAta(feePayer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM) {
  return createAssociatedTokenAccountIdempotentInstruction(
    feePayer,
    ata(owner, mint, tokenProgram),
    owner,
    mint,
    tokenProgram,
  );
}

// ------------------------------------------------------------- formation

export interface DealSpec {
  creator: PublicKey;
  dealId: bigint;
  parties: PublicKey[];
  payerIdx: number;
  payeeIdx: number;
  approvalThreshold: number;
  termsHash: Uint8Array;
  milestoneAmounts: bigint[];
  rule: RuleName;
  timerMode: TimerModeName;
  timeoutSecs: number;
  splitBps?: number;
  tieBreaker?: PublicKey;
  recoverySigners: PublicKey[];
  recoveryThreshold: number;
  recoveryDelaySecs: number;
  acceptedRiskFlags: number;
  priceRiskTerm?: number;
  mint: PublicKey;
  tokenProgram?: PublicKey;
  /** Set in the creating transaction only (v0.7 #5). Default NeverExpire / 0. */
  disputePolicy?: DisputePolicyName;
  disputeWindowSecs?: number;
}

export function dealAddress(creator: PublicKey, dealId: bigint): PublicKey {
  return dealPda(creator, new BN(dealId.toString()), PROGRAM_ID);
}

export function newDealId(nowMs: number): bigint {
  return BigInt(nowMs);
}

/**
 * createDeal + the creator's own signTerms, in one transaction (one prompt).
 * With a dispute policy: create → set_dispute_policy → sign, all in this ONE
 * transaction. There is deliberately no way to set a policy later (the
 * program is being changed to reject it outside the creating transaction).
 */
export async function createAndSign(spec: DealSpec, consentTrueDeadlock: boolean): Promise<TransactionInstruction[]> {
  const total = spec.milestoneAmounts.reduce((a, b) => a + b, 0n);
  const params = {
    dealId: new BN(spec.dealId.toString()),
    parties: spec.parties,
    payerIdx: spec.payerIdx,
    payeeIdx: spec.payeeIdx,
    approvalThreshold: spec.approvalThreshold,
    termsHash: Array.from(spec.termsHash),
    priceRiskTerm: spec.priceRiskTerm ?? 0,
    totalAmount: new BN(total.toString()),
    milestoneAmounts: spec.milestoneAmounts.map((a) => new BN(a.toString())),
    deadlockRule: RULES[spec.rule],
    timerMode: TIMERS[spec.timerMode],
    timeoutSecs: new BN(spec.timeoutSecs),
    splitBps: spec.splitBps ?? 0,
    tieBreaker: spec.tieBreaker ?? PublicKey.default,
    recoverySigners: spec.recoverySigners,
    recoveryThreshold: spec.recoveryThreshold,
    recoveryDelaySecs: new BN(spec.recoveryDelaySecs),
    acceptedRiskFlags: spec.acceptedRiskFlags,
  };
  const deal = dealAddress(spec.creator, spec.dealId);
  const tokenProgram = spec.tokenProgram ?? TOKEN_PROGRAM;
  const create = await program()
    .methods.createDeal(params as any)
    .accounts({ creator: spec.creator, mint: spec.mint, tokenProgram } as any)
    .instruction();
  const sign = await program()
    .methods.signTerms(consentTrueDeadlock)
    .accounts({ party: spec.creator, deal } as any)
    .instruction();
  const policy = spec.disputePolicy ?? "NeverExpire";
  if (policy === "NeverExpire" && !spec.disputeWindowSecs) return [create, sign];
  if (spec.timerMode !== "FromActivation") throw new Error("A dispute time limit needs a clock that runs from the start");
  return [create, await setDisputePolicyIx(deal, spec.creator, policy, spec.disputeWindowSecs ?? 0), sign];
}

const POLICIES: Record<DisputePolicyName, object> = {
  NeverExpire: { neverExpire: {} },
  ResumeRule: { resumeRule: {} },
  Split: { split: {} },
  RefundPayer: { refundPayer: {} },
};

/**
 * set_dispute_policy (program 4e5fa0a6…): creator only, FromActivation only,
 * and ONLY in the deal's creating transaction, after its create_deal — the
 * program reads the instructions sysvar to check (else
 * PolicyMustBeSetAtCreation). Accounts come from the SDK 0.1.5 IDL: creator,
 * deal, instructions sysvar, then the event accounts. Use createAndSign.
 */
export async function setDisputePolicyIx(deal: PublicKey, creator: PublicKey, policy: DisputePolicyName, windowSecs: number) {
  return program()
    .methods.setDisputePolicy(POLICIES[policy] as any, windowSecs)
    .accounts({ creator, deal, instructions: SYSVAR_INSTRUCTIONS_PUBKEY } as any)
    .instruction();
}

export async function signTerms(deal: PublicKey, me: PublicKey, consentTrueDeadlock: boolean) {
  return program().methods.signTerms(consentTrueDeadlock).accounts({ party: me, deal } as any).instruction();
}

// --------------------------------------------------------------- funding

/** Wrap native SOL into the payer's wSOL account so it can be deposited. */
export function wrapSolIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const wsol = ata(owner, NATIVE_MINT);
  return [
    ensureAta(owner, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports }),
    createSyncNativeInstruction(wsol),
  ];
}

/** Unwrap: close the wSOL account, returning all its lamports as SOL. */
export function unwrapSolIx(owner: PublicKey): TransactionInstruction {
  return createCloseAccountInstruction(ata(owner, NATIVE_MINT), owner, owner);
}

export async function depositIx(d: Deal, me: PublicKey, amount: bigint) {
  return program()
    .methods.deposit(new BN(amount.toString()))
    .accounts({
      payer: me,
      deal: d.address,
      mint: d.mint,
      vault: d.vault,
      payerTokenAccount: ata(me, d.mint, d.tokenProgram),
      tokenProgram: d.tokenProgram,
    } as any)
    .instruction();
}

async function confirmReadyIx(deal: PublicKey, me: PublicKey) {
  return program().methods.confirmReady().accounts({ party: me, deal } as any).instruction();
}

/**
 * Payer pays in and confirms readiness in one prompt. For SOL deals the
 * client wraps exactly the shortfall first. `alsoSign` covers the
 * request-first flow, where the payer's acceptance is the last signature.
 */
export async function fund(
  d: Deal,
  me: PublicKey,
  opts: { alsoSign?: boolean; consentTrueDeadlock?: boolean; wrapLamports?: bigint; amount?: bigint } = {},
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  const i = partyIndex(d, me);
  if (opts.alsoSign && !hasBit(d.signed, i)) ixs.push(await signTerms(d.address, me, opts.consentTrueDeadlock ?? false));
  const owed = d.totalAmount - d.deposited;
  // v0.9 #5: a partial pay-in (the program allows deposits in any number of steps). Ready only once everything is in.
  const paying = opts.amount != null && opts.amount > 0n && opts.amount < owed ? opts.amount : owed;
  if (d.mint.equals(NATIVE_MINT) && opts.wrapLamports && opts.wrapLamports > 0n) {
    ixs.push(...wrapSolIxs(me, opts.wrapLamports));
  }
  if (paying > 0n) ixs.push(await depositIx(d, me, paying));
  if (paying >= owed && !hasBit(d.ready, i)) ixs.push(await confirmReadyIx(d.address, me));
  return ixs;
}

/**
 * Payee's "Mark as shipped / handed over": confirmReady, which starts the
 * clock once every party is ready. If that makes the deal Active, the payee
 * also pre-approves the next milestone so the payer's "Everything's OK" is a
 * single prompt.
 */
export async function markShipped(d: Deal, me: PublicKey, preApprove = true): Promise<TransactionInstruction[]> {
  const i = partyIndex(d, me);
  const ixs = [await confirmReadyIx(d.address, me)];
  const othersReady = (d.ready | (1 << i)) === allMask(d);
  const m = nextMilestone(d);
  if (preApprove && othersReady && m < d.milestones.length && !hasBit(d.milestones[m].approvals, i)) {
    ixs.push(await approveIx(d.address, me, m));
  }
  return ixs;
}

async function approveIx(deal: PublicKey, me: PublicKey, index: number) {
  return program().methods.approveMilestone(index).accounts({ party: me, deal } as any).instruction();
}

async function releaseIx(d: Deal, index: number, payeeTokenAccount: PublicKey) {
  return program()
    .methods.releaseMilestone(index)
    .accounts({
      deal: d.address,
      mint: d.mint,
      vault: d.vault,
      payeeTokenAccount,
      tokenProgram: d.tokenProgram,
    } as any)
    .instruction();
}

/** Approve the next milestone; if that meets the threshold, release it too. */
export async function approveAndMaybeRelease(d: Deal, me: PublicKey): Promise<TransactionInstruction[]> {
  const m = nextMilestone(d);
  if (m >= d.milestones.length) return [];
  const i = partyIndex(d, me);
  const ixs: TransactionInstruction[] = [];
  let approvals = d.milestones[m].approvals;
  if (!hasBit(approvals, i)) {
    ixs.push(await approveIx(d.address, me, m));
    approvals |= 1 << i;
  }
  if (popcount(approvals) >= d.approvalThreshold) {
    const payeeKey = d.parties[d.payeeIdx];
    ixs.push(ensureAta(me, payeeKey, d.mint, d.tokenProgram));
    ixs.push(await releaseIx(d, m, ata(payeeKey, d.mint, d.tokenProgram)));
  }
  return ixs;
}

/** Permissionless release crank for a milestone that already has its approvals. */
export async function crankRelease(d: Deal, feePayer: PublicKey): Promise<TransactionInstruction[]> {
  const m = nextMilestone(d);
  const payeeKey = d.parties[d.payeeIdx];
  return [ensureAta(feePayer, payeeKey, d.mint, d.tokenProgram), await releaseIx(d, m, ata(payeeKey, d.mint, d.tokenProgram))];
}

export function popcount(x: number): number {
  let c = 0;
  while (x) {
    c += x & 1;
    x >>= 1;
  }
  return c;
}

// --------------------------------------------------------------- disputes

export async function pause(deal: PublicKey, me: PublicKey) {
  return [await program().methods.raiseDeadlock().accounts({ party: me, deal } as any).instruction()];
}
export async function resume(deal: PublicKey, me: PublicKey) {
  return [await program().methods.withdrawDeadlock().accounts({ party: me, deal } as any).instruction()];
}
export async function proposeSplit(deal: PublicKey, me: PublicKey, toPayee: bigint) {
  return [
    await program()
      .methods.resolutionSign(new BN(toPayee.toString()))
      .accounts({ signer: me, deal } as any)
      .instruction(),
  ];
}

/** Permissionless: settle a deal whose conditions hold (timeout, mutual split, or ruling). */
export async function collect(d: Deal, feePayer: PublicKey): Promise<TransactionInstruction[]> {
  const payerKey = d.parties[d.payerIdx];
  const payeeKey = d.parties[d.payeeIdx];
  const ix = await program()
    .methods.resolve()
    .accounts({
      deal: d.address,
      mint: d.mint,
      vault: d.vault,
      payerTokenAccount: ata(payerKey, d.mint, d.tokenProgram),
      payeeTokenAccount: ata(payeeKey, d.mint, d.tokenProgram),
      tokenProgram: d.tokenProgram,
    } as any)
    .instruction();
  return [
    ensureAta(feePayer, payerKey, d.mint, d.tokenProgram),
    ensureAta(feePayer, payeeKey, d.mint, d.tokenProgram),
    ix,
  ];
}

// --------------------------------------------------------------- recovery

/**
 * A recovery signer proposes (or co-signs) a division of what's left:
 * `toPayee` to the payee, the rest to the payer. Signing a DIFFERENT amount
 * replaces the proposal and resets every earlier recovery signature.
 */
export async function recoverySign(deal: PublicKey, signer: PublicKey, toPayee: bigint): Promise<TransactionInstruction[]> {
  return [
    await program()
      .methods.recoverySign(new BN(toPayee.toString()))
      .accounts({ signer, deal } as any)
      .instruction(),
  ];
}

/** Permissionless: carry out a recovery division once it has its signatures and the public notice period is over. */
export async function recoveryExecute(d: Deal, feePayer: PublicKey): Promise<TransactionInstruction[]> {
  const payerKey = d.parties[d.payerIdx];
  const payeeKey = d.parties[d.payeeIdx];
  const ix = await program()
    .methods.recoveryExecute()
    .accounts({
      deal: d.address,
      mint: d.mint,
      vault: d.vault,
      payerTokenAccount: ata(payerKey, d.mint, d.tokenProgram),
      payeeTokenAccount: ata(payeeKey, d.mint, d.tokenProgram),
      tokenProgram: d.tokenProgram,
    } as any)
    .instruction();
  return [ensureAta(feePayer, payerKey, d.mint, d.tokenProgram), ensureAta(feePayer, payeeKey, d.mint, d.tokenProgram), ix];
}

/** Agree to the split already on the table and, if that makes it unanimous, settle. */
export async function acceptSplit(d: Deal, me: PublicKey): Promise<TransactionInstruction[]> {
  const ixs = await proposeSplit(d.address, me, d.proposedToPayee);
  const i = partyIndex(d, me);
  if ((d.resolutionApprovals | (1 << i)) === allMask(d)) ixs.push(...(await collect(d, me)));
  return ixs;
}

// ------------------------------------------------- activation window lapse

/**
 * Permissionless: a Funded deal not Active by funded_at + ACTIVATION_WINDOW_SECS
 * — or a partly paid-in Signed deal by signed_at + ACTIVATION_WINDOW_SECS
 * (program upgrade ef45c9a) — returns the whole vault to the payer's own token account. Anyone may sign
 * (the cranker); funds can only go to the payer. Creates the payer's token
 * account first if needed (the cranker pays that rent).
 */
export async function refundUnactivated(d: Deal, cranker: PublicKey): Promise<TransactionInstruction[]> {
  const payerKey = d.parties[d.payerIdx];
  return [
    ensureAta(cranker, payerKey, d.mint, d.tokenProgram),
    await program()
      .methods.refundUnactivated()
      .accounts({
        cranker,
        deal: d.address,
        mint: d.mint,
        vault: d.vault,
        payerTokenAccount: ata(payerKey, d.mint, d.tokenProgram),
        tokenProgram: d.tokenProgram,
      } as any)
      .instruction(),
  ];
}

// ------------------------------------------------------------ payee refund

/**
 * refund_by_payee: the payee alone returns EVERYTHING in the vault to the
 * payer (Signed with a partial deposit, Funded, Active, Deadlocked). Ends
 * Cancelled if nothing was released yet, else Completed. Can't be undone.
 */
export async function refundByPayee(d: Deal, payee: PublicKey): Promise<TransactionInstruction[]> {
  const payerKey = d.parties[d.payerIdx];
  return [
    ensureAta(payee, payerKey, d.mint, d.tokenProgram),
    await program()
      .methods.refundByPayee()
      .accounts({
        payee,
        deal: d.address,
        mint: d.mint,
        vault: d.vault,
        payerTokenAccount: ata(payerKey, d.mint, d.tokenProgram),
        tokenProgram: d.tokenProgram,
      } as any)
      .instruction(),
  ];
}

// ------------------------------------------------------------ cancelling

export async function cancelDraft(deal: PublicKey, me: PublicKey) {
  return [await program().methods.cancelDraft().accounts({ party: me, deal } as any).instruction()];
}

export async function cancelTogether(d: Deal, me: PublicKey): Promise<TransactionInstruction[]> {
  const payerKey = d.parties[d.payerIdx];
  return [
    ensureAta(me, payerKey, d.mint, d.tokenProgram),
    await program()
      .methods.cancelSign()
      .accounts({
        party: me,
        deal: d.address,
        mint: d.mint,
        vault: d.vault,
        payerTokenAccount: ata(payerKey, d.mint, d.tokenProgram),
        tokenProgram: d.tokenProgram,
      } as any)
      .instruction(),
  ];
}

// ----------------------------------------------------------------- instant

/** Instant = a plain transfer outside Latch (the dial's left stop). */
export function instantTransfer(
  from: PublicKey,
  to: PublicKey,
  asset: { mint: PublicKey; decimals: number },
  raw: bigint,
): TransactionInstruction[] {
  if (asset.mint.equals(NATIVE_MINT)) {
    return [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: raw })];
  }
  return [
    ensureAta(from, to, asset.mint),
    createTransferCheckedInstruction(ata(from, asset.mint), asset.mint, ata(to, asset.mint), from, raw, asset.decimals),
  ];
}

export { vaultAta };
