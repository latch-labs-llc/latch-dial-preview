/**
 * v0.3 coverage on the deployed binary: AutoSplit, LongSunset, FromDeadlock,
 * crankRelease, cancelDraft, resume clock math, SOL accept+pay transaction
 * size, and the view.ts action matrix.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { NATIVE_MINT, RISK } from "../src/lib/config";
import { secondsLeft, unlockAt, type Deal } from "../src/lib/deal";
import { terminalPill, viewDeal, type Action } from "../src/lib/view";

const DAY = 86400;
const T0 = 1_760_000_000;
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

function baseSpec(creator: PublicKey, payer: PublicKey, payee: PublicKey, mint: PublicKey, amounts: bigint[], flags: number): F.DealSpec {
  return {
    creator,
    dealId: BigInt(Math.floor(Math.random() * 1e12)),
    parties: [payer, payee],
    payerIdx: 0,
    payeeIdx: 1,
    approvalThreshold: 2,
    termsHash: new Uint8Array(32).fill(7),
    milestoneAmounts: amounts,
    rule: "TimeoutRelease",
    timerMode: "FromActivation",
    timeoutSecs: 10 * DAY,
    recoverySigners: [payer, payee],
    recoveryThreshold: 2,
    recoveryDelaySecs: 3 * DAY,
    acceptedRiskFlags: flags,
    mint,
  };
}

/** Fresh chain at a real date; alex pays sam `amounts`; returns at the requested stage. */
async function deal(over: Partial<F.DealSpec>, stage: "Draft" | "Signed" | "Funded" | "Active", amounts = [usd(100)]) {
  const c = new Chain();
  c.warp(T0);
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const stranger = c.wallet();
  const mint = c.mint(issuer);
  const total = amounts.reduce((a, b) => a + b, 0n);
  c.mintTo(mint, issuer, alex.publicKey, total);
  const spec = { ...baseSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, amounts, RISK.FREEZE_AUTHORITY), ...over };
  const addr = F.dealAddress(alex.publicKey, spec.dealId);
  c.send(await F.createAndSign(spec, false), alex);
  if (stage !== "Draft") c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
  if (stage === "Funded" || stage === "Active") c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
  if (stage === "Active") c.send(await F.markShipped(c.deal(addr), sam.publicKey, false), sam);
  expect(c.deal(addr).state).toBe(stage);
  const d = () => c.deal(addr);
  return { c, alex, sam, stranger, mint, addr, d };
}

describe("settlement rules", () => {
  it("AutoSplit: at the window's end anyone splits by split_bps (30% payee / 70% payer)", async () => {
    const t = await deal({ rule: "AutoSplit", splitBps: 3000 }, "Active");
    t.c.warp(10 * DAY - 10);
    expectProgramError(t.c.trySend(await F.collect(t.d(), t.stranger.publicKey), t.stranger), "TimeoutNotElapsed");
    t.c.warp(11);
    expect(viewDeal(t.d(), t.stranger.publicKey, local, t.c.now()).actions).toContain("collect");
    t.c.send(await F.collect(t.d(), t.stranger.publicKey), t.stranger);
    expect(t.d().state).toBe("Completed");
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(usd(30));
    expect(t.c.tokenBalance(t.alex.publicKey, t.mint)).toBe(usd(70));
  });

  it("LongSunset (FromDeadlock): no clock while active; after a pause, returns to the payer when the sunset passes", async () => {
    const t = await deal({ rule: "LongSunset", timerMode: "FromDeadlock", timeoutSecs: 30 * DAY }, "Active");
    expect(unlockAt(t.d())).toBeNull();
    t.c.warp(365 * DAY);
    expectProgramError(t.c.trySend(await F.collect(t.d(), t.stranger.publicKey), t.stranger), "InvalidState");
    t.c.send(await F.pause(t.addr, t.sam.publicKey), t.sam);
    t.c.warp(30 * DAY - 10);
    expect(viewDeal(t.d(), t.stranger.publicKey, local, t.c.now()).actions).not.toContain("collect");
    expectProgramError(t.c.trySend(await F.collect(t.d(), t.stranger.publicKey), t.stranger), "TimeoutNotElapsed");
    t.c.warp(11);
    expect(viewDeal(t.d(), t.stranger.publicKey, local, t.c.now()).actions).toContain("collect");
    t.c.send(await F.collect(t.d(), t.stranger.publicKey), t.stranger);
    expect(t.c.tokenBalance(t.alex.publicKey, t.mint)).toBe(usd(100));
  });

  it("TimeoutRelease FromDeadlock: the clock starts at the pause, then releases to the payee", async () => {
    const t = await deal({ timerMode: "FromDeadlock", timeoutSecs: 5 * DAY }, "Active");
    t.c.send(await F.pause(t.addr, t.alex.publicKey), t.alex);
    expect(t.d().state).toBe("Deadlocked");
    t.c.warp(5 * DAY - 1);
    expectProgramError(t.c.trySend(await F.collect(t.d(), t.stranger.publicKey), t.stranger), "TimeoutNotElapsed");
    t.c.warp(2);
    t.c.send(await F.collect(t.d(), t.stranger.publicKey), t.stranger);
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(usd(100));
  });
});

describe("clock", () => {
  it("resume: paused time doesn't count; unlockAt/secondsLeft match what the program enforces", async () => {
    const t = await deal({}, "Active");
    const start = t.d().lastResumedAt;
    expect(unlockAt(t.d())).toBe(start + 10 * DAY);
    t.c.warp(4 * DAY);
    t.c.send(await F.pause(t.addr, t.alex.publicKey), t.alex);
    expect(t.d().elapsedAtPause).toBe(4 * DAY);
    t.c.warp(20 * DAY); // paused: no time counts
    expect(secondsLeft(t.d(), t.c.now())).toBe(6 * DAY);
    expectProgramError(t.c.trySend(await F.collect(t.d(), t.stranger.publicKey), t.stranger), "TimeoutPausedByDispute");
    // Only the pauser can resume.
    expectProgramError(t.c.trySend(await F.resume(t.addr, t.sam.publicKey), t.sam), "OnlyRaiserMayWithdraw");
    t.c.send(await F.resume(t.addr, t.alex.publicKey), t.alex);
    const unlock = unlockAt(t.d())!;
    expect(unlock).toBe(t.c.now() + 6 * DAY);
    t.c.warp(unlock - t.c.now() - 1);
    expect(secondsLeft(t.d(), t.c.now())).toBe(1);
    expectProgramError(t.c.trySend(await F.collect(t.d(), t.stranger.publicKey), t.stranger), "TimeoutNotElapsed");
    t.c.warp(1);
    expect(secondsLeft(t.d(), t.c.now())).toBe(0);
    t.c.send(await F.collect(t.d(), t.stranger.publicKey), t.stranger);
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(usd(100));
  });
});

describe("milestones and cancelling", () => {
  it("crankRelease: once both approved a part, ANYONE can release it — in order", async () => {
    const t = await deal({}, "Active", [usd(40), usd(60)]);
    // Approve part 1 by both, without releasing.
    const approve = async (who: Keypair) => (await F.approveAndMaybeRelease(t.d(), who.publicKey)).slice(0, 1);
    t.c.send(await approve(t.alex), t.alex);
    t.c.send(await approve(t.sam), t.sam);
    expect(t.d().milestones[0].released).toBe(false);
    const v = viewDeal(t.d(), t.stranger.publicKey, local, t.c.now());
    expect(v.actions).toContain("crankRelease");
    t.c.send(await F.crankRelease(t.d(), t.stranger.publicKey), t.stranger);
    expect(t.d().milestones[0].released).toBe(true);
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(usd(40));
    expect(t.d().state).toBe("Active");
    // Part 2 has no approvals: the crank must fail.
    const err = t.c.trySend(await F.crankRelease(t.d(), t.stranger.publicKey), t.stranger);
    expectProgramError(err, "InsufficientApprovals");
    // The helper itself can fail: a different program error, or success, is rejected.
    expect(() => expectProgramError(err, "InvalidState")).toThrow(/expected InvalidState \(6010\), got InsufficientApprovals \(6019\)/);
    expect(() => expectProgramError(null, "InvalidState")).toThrow(/succeeded/);
    expect(() => expectProgramError("Transaction too large", "InvalidState")).toThrow(/non-program failure/);
  });

  it("cancelDraft: a party cancels a Draft; a stranger can't; nothing moves", async () => {
    const t = await deal({}, "Draft");
    expectProgramError(t.c.trySend(await F.cancelDraft(t.addr, t.stranger.publicKey), t.stranger), "NotAParty");
    // The payee declines (it's their right before signing).
    t.c.send(await F.cancelDraft(t.addr, t.sam.publicKey), t.sam);
    expect(t.d().state).toBe("Cancelled");
    expect(terminalPill(t.d())).toEqual({ cls: "ended", text: "✕ Cancelled" }); // v0.8 #1: nothing was paid in
    expect(t.c.tokenBalance(t.alex.publicKey, t.mint)).toBe(usd(100));
    expectProgramError(t.c.trySend(await F.cancelDraft(t.addr, t.alex.publicKey), t.alex), "InvalidState");
  });
});

describe("SOL accept + pay in one transaction", () => {
  it("sign_terms + wrap + deposit + confirm_ready fits one v0 transaction and executes", async () => {
    const c = new Chain();
    c.warp(T0);
    const alex = c.wallet(5);
    const sam = c.wallet(1);
    const lamports = 2_000_000_000n;
    const spec = baseSpec(sam.publicKey, alex.publicKey, sam.publicKey, NATIVE_MINT, [lamports], 0);
    const addr = F.dealAddress(sam.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), sam);
    const ixs = await F.fund(c.deal(addr), alex.publicKey, { alsoSign: true, wrapLamports: lamports });
    const msg = new TransactionMessage({ payerKey: alex.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message();
    const size = new VersionedTransaction(msg).serialize().length;
    expect(size).toBeLessThanOrEqual(1232);
    c.send(ixs, alex);
    const d = c.deal(addr);
    expect(d.state).toBe("Funded");
    expect(d.deposited).toBe(lamports);
    console.log(`SOL accept+pay transaction: ${size} bytes of 1232`);
  });
});

// ------------------------------------------------------------ view matrix

type Who = "payer" | "payee" | "stranger";
const pick = (t: { alex: Keypair; sam: Keypair; stranger: Keypair }, w: Who) => (w === "payer" ? t.alex : w === "payee" ? t.sam : t.stranger).publicKey;
const acts = (d: Deal, me: PublicKey, now: number) => viewDeal(d, me, local, now).actions.slice().sort();

describe("view.ts action matrix (state × role) on real accounts", () => {
  it("Draft / Signed / Funded / Active / Deadlocked / Completed", async () => {
    const rows: [string, Who, Action[]][] = [];
    const record = (label: string, d: Deal, t: any, now: number) => {
      for (const w of ["payer", "payee", "stranger"] as Who[]) rows.push([label, w, acts(d, pick(t, w), now) as Action[]]);
    };

    const draft = await deal({}, "Draft");
    record("Draft (payer signed)", draft.d(), draft, draft.c.now());
    const signed = await deal({}, "Signed");
    record("Signed", signed.d(), signed, signed.c.now());
    const funded = await deal({}, "Funded");
    record("Funded", funded.d(), funded, funded.c.now());
    const active = await deal({}, "Active");
    record("Active", active.d(), active, active.c.now());
    record("Active, window over", active.d(), active, active.c.now() + 10 * DAY);
    active.c.send(await F.pause(active.addr, active.alex.publicKey), active.alex);
    record("Deadlocked (payer paused)", active.d(), active, active.c.now());
    active.c.send(await F.proposeSplit(active.addr, active.sam.publicKey, usd(50)), active.sam);
    record("Deadlocked, payee proposed", active.d(), active, active.c.now());
    active.c.send(await F.acceptSplit(active.d(), active.alex.publicKey), active.alex);
    record("Completed (split)", active.d(), active, active.c.now());

    const got = rows.map(([l, w, a]) => `${l} | ${w} | ${a.join(",") || "—"}`);
    expect(got).toEqual([
      "Draft (payer signed) | payer | cancelDraft",
      "Draft (payer signed) | payee | accept,cancelDraft",
      "Draft (payer signed) | stranger | —",
      "Signed | payer | cancelTogether,pay",
      "Signed | payee | cancelTogether",
      "Signed | stranger | —",
      "Funded | payer | cancelTogether",
      "Funded | payee | cancelTogether,markShipped,refundByPayee",
      "Funded | stranger | —",
      "Active | payer | pause,release",
      "Active | payee | pause,refundByPayee,release",
      "Active | stranger | —",
      "Active, window over | payer | collect,pause,release",
      "Active, window over | payee | collect,pause,refundByPayee,release",
      "Active, window over | stranger | collect",
      "Deadlocked (payer paused) | payer | proposeSplit,resume",
      "Deadlocked (payer paused) | payee | proposeSplit,refundByPayee",
      "Deadlocked (payer paused) | stranger | —",
      "Deadlocked, payee proposed | payer | acceptSplit,proposeSplit,resume",
      "Deadlocked, payee proposed | payee | proposeSplit,refundByPayee",
      "Deadlocked, payee proposed | stranger | —",
      "Completed (split) | payer | —",
      "Completed (split) | payee | —",
      "Completed (split) | stranger | —",
    ]);
    expect(active.c.tokenBalance(active.sam.publicKey, active.mint)).toBe(usd(50));
  });

  it("needsYou follows whose move it is", async () => {
    const t = await deal({}, "Funded");
    expect(viewDeal(t.d(), t.sam.publicKey, local, t.c.now()).needsYou).toBe(true);
    expect(viewDeal(t.d(), t.alex.publicKey, local, t.c.now()).needsYou).toBe(false);
    expect(viewDeal(t.d(), t.stranger.publicKey, local, t.c.now()).needsYou).toBe(false);
  });
});
