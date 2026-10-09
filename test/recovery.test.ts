/**
 * Item 8: recovery_sign / recovery_execute on the deployed binary, the
 * recovery-role view, the evidence deal record, and deal discovery that
 * reports (instead of swallowing) failed lookups.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { agreementSpec } from "../src/lib/agreementSpec";
import { viewDeal } from "../src/lib/view";
import { evidenceDealRecord } from "../src/lib/evidence";
import { fetchMyDeals } from "../src/lib/chain";
import { DEAL_ACCOUNT_SIZE, OFFSETS } from "../src/lib/deal";

const DAY = 86400;
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

/** A 2-of-3 deal (payer, payee, named backup), funded and shipped: Active. */
async function active(withBackup = true) {
  const c = new Chain();
  // LiteSVM's clock starts at 0, and the program treats recovery_ready_at = 0
  // as "threshold not met" — start at a real date.
  c.warp(1_760_000_000);
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const backup = c.wallet();
  const stranger = c.wallet();
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, usd(100));
  const asset = { id: "USDC" as const, label: "x", mint, decimals: 6, knownRiskFlags: RISK.FREEZE_AUTHORITY, dollar: true };
  const spec = agreementSpec({
    creator: alex.publicKey,
    dealId: BigInt(Date.now()),
    role: "payer",
    other: sam.publicKey,
    amounts: [usd(100)],
    settle: "timer",
    windowDays: 10,
    splitPct: 50,
    decider: null,
    backup: withBackup ? backup.publicKey : null,
    backupDelayDays: 3,
    asset,
  } as any);
  spec.termsHash = new Uint8Array(32).fill(9);
  const deal = F.dealAddress(alex.publicKey, spec.dealId);
  c.send(await F.createAndSign(spec, false), alex);
  c.send([await F.signTerms(deal, sam.publicKey, false)], sam);
  c.send(await F.fund(c.deal(deal), alex.publicKey), alex);
  c.send(await F.markShipped(c.deal(deal), sam.publicKey), sam);
  expect(c.deal(deal).state).toBe("Active");
  expect(c.deal(deal).recoverySigners.map((k) => k.toBase58())).toEqual((withBackup ? [alex, sam, backup] : [alex, sam]).map((k) => k.publicKey.toBase58()));
  return { c, alex, sam, backup, stranger, mint, deal };
}

describe("recovery on the deployed binary", () => {
  it("backup proposes, payer co-signs, notice period runs, then ANYONE carries it out; money goes only to the parties", async () => {
    const t = await active();
    const v0 = viewDeal(t.c.deal(t.deal), t.backup.publicKey, local, t.c.now());
    expect(v0.role).toBe("recovery");
    expect(v0.actions).toContain("recoveryPropose");
    expect(v0.sentence).toMatch(/backup signer.*2 of 3.*3 d 0 h in public/);
    // With a third-party backup (2-of-3), parties may propose too (A6 ruling).
    expect(viewDeal(t.c.deal(t.deal), t.alex.publicKey, local, t.c.now()).actions).toContain("recoveryPropose");

    t.c.send(await F.recoverySign(t.deal, t.backup.publicKey, usd(30)), t.backup);
    let d = t.c.deal(t.deal);
    expect(d.recoveryProposalActive).toBe(true);
    expect(d.recoveryProposedToPayee).toBe(usd(30));
    expect(d.recoveryReadyAt).toBe(0);
    // The parties see a public notice and can co-sign (both are recovery signers here).
    const va = viewDeal(d, t.alex.publicKey, local, t.c.now());
    expect(va.sentence).toMatch(/^Notice: a backup signer proposed a division .* 1 of 2 signatures/);
    expect(va.needsYou).toBe(true);
    expect(va.actions).toContain("recoverySign");

    t.c.send(await F.recoverySign(t.deal, t.alex.publicKey, d.recoveryProposedToPayee), t.alex);
    d = t.c.deal(t.deal);
    expect(d.recoveryReadyAt).toBeGreaterThan(0);
    const vs = viewDeal(d, t.sam.publicKey, local, t.c.now());
    expect(vs.sentence).toMatch(/^Notice: backup signers agreed to divide it .* can be carried out from/);
    expect(vs.actions).not.toContain("recoveryExecute");

    expectProgramError(t.c.trySend(await F.recoveryExecute(d, t.stranger.publicKey), t.stranger), "RecoveryDelayNotElapsed");
    t.c.warp(3 * DAY + 1);
    const vx = viewDeal(t.c.deal(t.deal), t.stranger.publicKey, local, t.c.now());
    expect(vx.role).toBe("viewer");
    expect(vx.actions).toContain("recoveryExecute");

    t.c.send(await F.recoveryExecute(t.c.deal(t.deal), t.stranger.publicKey), t.stranger);
    expect(t.c.deal(t.deal).state).toBe("Completed");
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(usd(30));
    expect(t.c.tokenBalance(t.alex.publicKey, t.mint)).toBe(usd(70));
    expect(t.c.tokenBalance(t.backup.publicKey, t.mint)).toBe(0n);
    expect(t.c.tokenBalance(t.stranger.publicKey, t.mint)).toBe(0n);
  });

  it("2-of-2 parties only: parties are not offered a recovery proposal (it would just be a slower split)", async () => {
    const t = await active(false);
    for (const w of [t.alex, t.sam]) expect(viewDeal(t.c.deal(t.deal), w.publicKey, local, t.c.now()).actions).not.toContain("recoveryPropose");
  });

  it("2-of-3: a party proposes, the backup co-signs, and the threshold is met on-chain", async () => {
    const t = await active();
    t.c.send(await F.recoverySign(t.deal, t.sam.publicKey, usd(60)), t.sam);
    const vb = viewDeal(t.c.deal(t.deal), t.backup.publicKey, local, t.c.now());
    expect(vb.actions).toContain("recoverySign");
    t.c.send(await F.recoverySign(t.deal, t.backup.publicKey, usd(60)), t.backup);
    expect(t.c.deal(t.deal).recoveryReadyAt).toBeGreaterThan(0);
  });

  it("a different amount replaces the proposal and resets signatures", async () => {
    const t = await active();
    t.c.send(await F.recoverySign(t.deal, t.backup.publicKey, usd(30)), t.backup);
    t.c.send(await F.recoverySign(t.deal, t.sam.publicKey, usd(90)), t.sam);
    const d = t.c.deal(t.deal);
    expect(d.recoveryProposedToPayee).toBe(usd(90));
    expect(d.recoveryApprovals).toBe(1 << 1); // only sam
    expect(d.recoveryReadyAt).toBe(0);
    expectProgramError(t.c.trySend(await F.recoveryExecute(d, t.stranger.publicKey), t.stranger), "InsufficientRecoverySignatures");
  });

  it("a non-signer can't sign, and nothing can happen before funding", async () => {
    const t = await active();
    expectProgramError(t.c.trySend(await F.recoverySign(t.deal, t.stranger.publicKey, 0n), t.stranger), "NotARecoverySigner");

    const c = new Chain();
    const a = c.wallet();
    const b = c.wallet();
    const mint = c.mint(c.wallet());
    const asset = { id: "USDC" as const, label: "x", mint, decimals: 6, knownRiskFlags: RISK.FREEZE_AUTHORITY, dollar: true };
    const spec = agreementSpec({ creator: a.publicKey, dealId: 5n, role: "payer", other: b.publicKey, amounts: [usd(1)], settle: "timer", windowDays: 10, splitPct: 50, decider: null, backup: null, backupDelayDays: 3, asset } as any);
    spec.termsHash = new Uint8Array(32).fill(1);
    c.send(await F.createAndSign(spec, false), a);
    const addr = F.dealAddress(a.publicKey, 5n);
    expectProgramError(c.trySend(await F.recoverySign(addr, a.publicKey, 0n), a), "InvalidState");
    expect(viewDeal(c.deal(addr), a.publicKey, local, c.now()).actions.filter((x) => x.startsWith("recovery"))).toEqual([]);
  });
});

describe("evidence deal record", () => {
  it("reports per-party status from the account's bitmasks (no fake 'signed at' indexes) and the recovery state", async () => {
    const t = await active();
    t.c.send(await F.recoverySign(t.deal, t.backup.publicKey, usd(10)), t.backup);
    const r = evidenceDealRecord(t.c.deal(t.deal));
    expect(r).not.toHaveProperty("partiesSignedAt");
    expect(r.partyStatus).toEqual([
      { party: t.alex.publicKey.toBase58(), signedTerms: true, confirmedReady: true },
      { party: t.sam.publicKey.toBase58(), signedTerms: true, confirmedReady: true },
    ]);
    expect(r.recovery).toMatchObject({ threshold: 2, delaySecs: 3 * DAY, proposalActive: true, proposedToPayee: usd(10).toString(), approvalsMask: 1 << 2, thresholdMetAt: 0 });
    expect(r.signedAt).toBe(t.c.deal(t.deal).signedAt);
  });
});

describe("deal discovery reports failed lookups", () => {
  const me = Keypair.generate().publicKey;
  const N = 12; // 8 party slots + decider + 3 recovery slots
  function fakeConn(failures: (offset: number, attempt: number) => boolean) {
    const attempts = new Map<number, number>();
    return {
      calls: attempts,
      async getProgramAccounts(_p: PublicKey, cfg: any) {
        const offset = cfg.filters[1].memcmp.offset as number;
        expect(cfg.filters[0].dataSize).toBe(DEAL_ACCOUNT_SIZE);
        const n = attempts.get(offset) ?? 0;
        attempts.set(offset, n + 1);
        if (failures(offset, n)) throw new Error("429 Too Many Requests");
        return [];
      },
    } as any;
  }
  it("retries a transient failure and reports a complete list", async () => {
    const conn = fakeConn((o, n) => o === OFFSETS.party(1) && n === 0);
    const r = await fetchMyDeals(conn, me, 2, 1);
    expect(r.failed).toBe(0);
    expect(conn.calls.get(OFFSETS.party(1))).toBe(2);
    expect(conn.calls.size).toBe(N);
  });
  it("a lookup that keeps failing is surfaced, not swallowed", async () => {
    const conn = fakeConn((o) => o === OFFSETS.recoverySigner(2));
    const r = await fetchMyDeals(conn, me, 2, 1);
    expect(r.failed).toBe(1);
    expect(conn.calls.get(OFFSETS.recoverySigner(2))).toBe(3);
  });
  it("all lookups failing is an error", async () => {
    await expect(fetchMyDeals(fakeConn(() => true), me, 1, 1)).rejects.toThrow(/refused the deal lookup/);
  });
});
