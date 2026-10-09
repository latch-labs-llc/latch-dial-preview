/**
 * v0.9 #1: Custom terms = the whole protocol. `customProblems` mirrors the
 * program's create_deal checks; every violation below is sent to the deployed
 * binary too and must fail with the same error name. Happy paths exercise
 * what the old Custom could not express: 3 parties with 2-of-3 approvals,
 * LongSunset, AutoSplit at 33.33%, a decider with the clock from a dispute,
 * three recovery signers with a non-party, a 10-year window, partial pay-in.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { LIMITS, clauseIndex, customFields, customProblems, customSpec, toDealSpec, writes, type CustomTerms } from "../src/lib/customTerms";
import { renderAgreement, type LinkBlob } from "../src/lib/template";

const DAY = 86400;

function world() {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const kim = c.wallet();
  const eve = c.wallet();
  const mint = c.mint(issuer); // carries a freeze authority → FREEZE_AUTHORITY must be accepted
  c.mintTo(mint, issuer, alex.publicKey, 10_000_000_000n);
  const base = (over: Partial<CustomTerms> = {}): CustomTerms => ({
    creator: alex.publicKey,
    dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)),
    parties: [alex.publicKey, sam.publicKey],
    payerIdx: 0,
    payeeIdx: 1,
    approvalThreshold: 2,
    mint,
    decimals: 6,
    parts: [{ label: "", amount: 100_000_000n }],
    rule: "TimeoutRelease",
    timerMode: "FromActivation",
    timeoutSecs: 10 * DAY,
    splitBps: 0,
    tieBreaker: null,
    disputePolicy: "NeverExpire",
    disputeWindowSecs: 0,
    consentTrueDeadlock: false,
    recoverySigners: [alex.publicKey, sam.publicKey],
    recoveryThreshold: 2,
    recoveryDelaySecs: 3 * DAY,
    detectedRiskFlags: RISK.FREEZE_AUTHORITY,
    acceptedRiskFlags: RISK.FREEZE_AUTHORITY,
    priceRiskTerm: 0,
    ...over,
  });
  const create = async (t: CustomTerms, signer = alex) => c.trySend(await F.createAndSign(toDealSpec(t), t.consentTrueDeadlock), signer);
  return { c, alex, sam, kim, eve, mint, base, create };
}

describe("v0.9 #1: customProblems mirrors create_deal (each violation refused by the deployed binary with the same error)", () => {
  const cases: [string, (w: ReturnType<typeof world>) => CustomTerms, string, number][] = [
    ["one party", (w) => w.base({ parties: [w.alex.publicKey], payeeIdx: 0 }), "InvalidParties", 2],
    ["nine parties", (w) => w.base({ parties: [w.alex.publicKey, w.sam.publicKey, ...Array.from({ length: 7 }, () => Keypair.generate().publicKey)] }), "InvalidParties", 2],
    ["a party twice", (w) => w.base({ parties: [w.alex.publicKey, w.sam.publicKey, w.sam.publicKey] }), "DuplicateParty", 2],
    ["creator not a party", (w) => w.base({ parties: [w.sam.publicKey, w.eve.publicKey] }), "CreatorNotParty", 2],
    ["payer = payee", (w) => w.base({ payeeIdx: 0 }), "InvalidParties", 2],
    ["threshold 0", (w) => w.base({ approvalThreshold: 0 }), "InvalidThreshold", 2],
    ["threshold n+1", (w) => w.base({ approvalThreshold: 3 }), "InvalidThreshold", 2],
    ["no parts", (w) => w.base({ parts: [] }), "InvalidMilestones", 4],
    ["17 parts", (w) => w.base({ parts: Array.from({ length: 17 }, () => ({ label: "", amount: 1n })) }), "InvalidMilestones", 4],
    ["a zero part", (w) => w.base({ parts: [{ label: "", amount: 0n }] }), "InvalidMilestones", 4],
    ["timed rule, no window", (w) => w.base({ timeoutSecs: 0 }), "InvalidDeadlockParams", 5],
    ["window over 10 years", (w) => w.base({ timeoutSecs: LIMITS.MAX_TIMEOUT_SECS + 1 }), "InvalidDeadlockParams", 5],
    ["LongSunset, no window", (w) => w.base({ rule: "LongSunset", timeoutSecs: 0 }), "InvalidDeadlockParams", 5],
    ["decider not named", (w) => w.base({ rule: "TieBreaker", timerMode: "FromDeadlock", tieBreaker: null }), "InvalidDeadlockParams", 5],
    ["decider is a party", (w) => w.base({ rule: "TieBreaker", timerMode: "FromDeadlock", tieBreaker: w.sam.publicKey }), "InvalidDeadlockParams", 5],
    ["decider with the clock from the start", (w) => w.base({ rule: "TieBreaker", timerMode: "FromActivation", tieBreaker: w.eve.publicKey }), "InvalidTimerMode", 5],
    ["no decider no timer, clock from the start", (w) => w.base({ rule: "TrueDeadlock", timerMode: "FromActivation", consentTrueDeadlock: true }), "InvalidTimerMode", 5],
    ["split over 100%", (w) => w.base({ rule: "AutoSplit", splitBps: 10_001 }), "InvalidDeadlockParams", 5],
    ["no recovery signer", (w) => w.base({ recoverySigners: [], recoveryThreshold: 1 }), "InvalidRecoveryConfig", 6],
    ["four recovery signers", (w) => w.base({ recoverySigners: [w.alex.publicKey, w.sam.publicKey, w.kim.publicKey, w.eve.publicKey], recoveryThreshold: 2 }), "InvalidRecoveryConfig", 6],
    ["a recovery signer twice", (w) => w.base({ recoverySigners: [w.alex.publicKey, w.alex.publicKey] }), "InvalidRecoveryConfig", 6],
    ["recovery threshold 0", (w) => w.base({ recoveryThreshold: 0 }), "InvalidRecoveryConfig", 6],
    ["recovery threshold r+1", (w) => w.base({ recoveryThreshold: 3 }), "InvalidRecoveryConfig", 6],
    ["negative notice", (w) => w.base({ recoveryDelaySecs: -1 }), "InvalidRecoveryConfig", 6],
    ["freeze risk not accepted", (w) => w.base({ acceptedRiskFlags: 0 }), "RiskFlagsNotAccepted", 7],
  ];
  for (const [name, mk, code, section] of cases) {
    it(`${name} → ${code} (§${section})`, async () => {
      const w = world();
      const t = mk(w);
      const problems = customProblems(t);
      expect(problems.map((p) => p.code), name).toContain(code);
      expect(problems.find((p) => p.code === code)!.section).toBe(section);
      expect(() => customSpec(t)).toThrow();
      expectProgramError(await w.create(t), code);
    });
  }

  it("client-only gates: dispute limit needs the start clock and 1–365 days; TrueDeadlock needs consent; price-risk code 0–255", async () => {
    const w = world();
    expect(customProblems(w.base({ rule: "TieBreaker", timerMode: "FromDeadlock", tieBreaker: w.eve.publicKey, disputePolicy: "Split", disputeWindowSecs: 7 * DAY })).map((p) => p.code)).toContain("DisputePolicyNeedsStartClock");
    expect(customProblems(w.base({ disputePolicy: "ResumeRule", disputeWindowSecs: 100 })).map((p) => p.code)).toContain("InvalidDisputeWindow");
    expect(customProblems(w.base({ disputePolicy: "ResumeRule", disputeWindowSecs: 366 * DAY })).map((p) => p.code)).toContain("InvalidDisputeWindow");
    // The program agrees on the window bounds (set_dispute_policy in the creating transaction).
    expectProgramError(await w.create(w.base({ disputePolicy: "ResumeRule", disputeWindowSecs: 100 })), "InvalidDisputeWindow");
    expect(customProblems(w.base({ rule: "TrueDeadlock", timerMode: "FromDeadlock", consentTrueDeadlock: false })).map((p) => p.code)).toContain("ConsentRequired");
    expect(customProblems(w.base({ priceRiskTerm: 256 })).map((p) => p.code)).toContain("InvalidPriceRiskTerm");
    expect(customProblems(w.base())).toEqual([]);
  });
});

describe("v0.9 #1: what the old Custom could not express, on the deployed binary", () => {
  it("three parties, 2-of-3 approvals, two parts: two approvals release each part", async () => {
    const w = world();
    const t = w.base({ parties: [w.alex.publicKey, w.sam.publicKey, w.kim.publicKey], approvalThreshold: 2, parts: [{ label: "Half", amount: 50_000_000n }, { label: "Rest", amount: 50_000_000n }] });
    expect(customProblems(t)).toEqual([]);
    expect(await w.create(t)).toBeNull();
    const addr = F.dealAddress(w.alex.publicKey, t.dealId);
    for (const k of [w.sam, w.kim]) w.c.send([await F.signTerms(addr, k.publicKey, false)], k);
    w.c.send(await F.fund(w.c.deal(addr), w.alex.publicKey), w.alex);
    for (const k of [w.sam, w.kim]) w.c.send(await F.markShipped(w.c.deal(addr), k.publicKey, false), k);
    expect(w.c.deal(addr).state).toBe("Active");
    w.c.send(await F.approveAndMaybeRelease(w.c.deal(addr), w.sam.publicKey), w.sam);
    expect(w.c.deal(addr).milestones[0].released).toBe(false);
    w.c.send(await F.approveAndMaybeRelease(w.c.deal(addr), w.kim.publicKey), w.kim); // 2 of 3 → released
    expect(w.c.deal(addr).milestones[0].released).toBe(true);
    expect(w.c.tokenBalance(w.sam.publicKey, w.mint)).toBe(50_000_000n);
    expect(writes(2, t)).toEqual(["each part when 2 of 3 parties approve it"]);
  });

  it("LongSunset: locked until agreement; after the window anyone returns it to the payer", async () => {
    const w = world();
    const t = w.base({ rule: "LongSunset", timerMode: "FromActivation", timeoutSecs: 365 * DAY });
    expect(await w.create(t)).toBeNull();
    const addr = F.dealAddress(w.alex.publicKey, t.dealId);
    w.c.send([await F.signTerms(addr, w.sam.publicKey, false)], w.sam);
    w.c.send(await F.fund(w.c.deal(addr), w.alex.publicKey), w.alex);
    w.c.send(await F.markShipped(w.c.deal(addr), w.sam.publicKey, false), w.sam);
    const before = w.c.tokenBalance(w.alex.publicKey, w.mint);
    expectProgramError(w.c.trySend(await F.collect(w.c.deal(addr), w.eve.publicKey), w.eve), "TimeoutNotElapsed");
    w.c.warp(365 * DAY + 1);
    w.c.send(await F.collect(w.c.deal(addr), w.eve.publicKey), w.eve);
    expect(w.c.tokenBalance(w.alex.publicKey, w.mint) - before).toBe(100_000_000n);
    expect(writes(5, t)[0]).toMatch(/^Rule: LONG SUNSET\./);
  });

  it("AutoSplit 33.33%: after the window the payee gets 3333 bps, the payer the rest", async () => {
    const w = world();
    const t = w.base({ rule: "AutoSplit", splitBps: 3333, timeoutSecs: 5 * DAY });
    expect(await w.create(t)).toBeNull();
    const addr = F.dealAddress(w.alex.publicKey, t.dealId);
    w.c.send([await F.signTerms(addr, w.sam.publicKey, false)], w.sam);
    w.c.send(await F.fund(w.c.deal(addr), w.alex.publicKey), w.alex);
    w.c.send(await F.markShipped(w.c.deal(addr), w.sam.publicKey, false), w.sam);
    w.c.warp(5 * DAY + 1);
    w.c.send(await F.collect(w.c.deal(addr), w.eve.publicKey), w.eve);
    expect(w.c.tokenBalance(w.sam.publicKey, w.mint)).toBe(33_330_000n);
    expect(writes(5, t)[0]).toContain("33.33%");
  });

  it("named decider, clock from a dispute: the decider's ruling is carried out by anyone", async () => {
    const w = world();
    const t = w.base({ rule: "TieBreaker", timerMode: "FromDeadlock", tieBreaker: w.eve.publicKey, timeoutSecs: 0 });
    expect(await w.create(t)).toBeNull();
    const addr = F.dealAddress(w.alex.publicKey, t.dealId);
    w.c.send([await F.signTerms(addr, w.sam.publicKey, false)], w.sam);
    w.c.send(await F.fund(w.c.deal(addr), w.alex.publicKey), w.alex);
    w.c.send(await F.markShipped(w.c.deal(addr), w.sam.publicKey, false), w.sam);
    w.c.send(await F.pause(addr, w.alex.publicKey), w.alex);
    w.c.send(await F.proposeSplit(addr, w.eve.publicKey, 25_000_000n), w.eve); // the decider rules
    w.c.send(await F.collect(w.c.deal(addr), w.kim.publicKey), w.kim);
    expect(w.c.tokenBalance(w.sam.publicKey, w.mint)).toBe(25_000_000n);
    expect(writes(5, t)[0]).toContain(w.eve.publicKey.toBase58());
  });

  it("three recovery signers, 2-of-3 with a non-party, and a 10-year window: accepted; the text states both", async () => {
    const w = world();
    const t = w.base({ recoverySigners: [w.alex.publicKey, w.sam.publicKey, w.kim.publicKey], recoveryThreshold: 2, recoveryDelaySecs: 14 * DAY, timeoutSecs: LIMITS.MAX_TIMEOUT_SECS, priceRiskTerm: 7 });
    expect(await w.create(t)).toBeNull();
    const d = w.c.deal(F.dealAddress(w.alex.publicKey, t.dealId));
    expect(d.recoverySigners.map((k) => k.toBase58())).toContain(w.kim.publicKey.toBase58());
    expect(d.recoveryThreshold).toBe(2);
    expect(d.timeoutSecs).toBe(LIMITS.MAX_TIMEOUT_SECS);
    const blob: LinkBlob = { t: "goods-sale@2", p: { condition: "new", inspection_days: 2, milestones: [""] }, s: "Ten-year hold", n: "00112233445566778899aabbccddeeff" };
    const text = renderAgreement(customFields(t), blob);
    expect(text).toContain("RECOVERY SIGNERS (2 of 3)");
    expect(text).toContain(w.kim.publicKey.toBase58());
    expect(text).toContain("Price-risk term code: 7.");
    expect(writes(6, t)[0]).toBe("RECOVERY SIGNERS (2 of 3)");
    expect(writes(7, t)[0]).toContain("Price-risk term code: 7.");
    // clauseIndex: nine numbered sections, titles as in the skeleton, every body a substring of the text.
    const idx = clauseIndex(text);
    expect(idx.map((c) => `${c.n}. ${c.title}`)).toEqual(["1. SUBJECT", "2. PARTIES (by wallet address)", "3. AMOUNT AND HOLDING", "4. RELEASES", "5. IF THERE IS A PROBLEM", "6. RECOVERY SIGNERS (2 of 3)", "7. TOKEN RISKS", "8. TEMPLATE DETAILS", "9. ELECTRONIC SIGNATURE"]);
    for (const c of idx) expect(text).toContain(c.body.split("\n")[0]);
    // The §5 caption is exactly the clause the text carries.
    expect(text).toContain(writes(5, t)[0]);
    expect(text).toContain(writes(5, t)[1]);
  });

  it("partial pay-in: the payer deposits in two transactions; the deal is Funded only when the total is in", async () => {
    const w = world();
    const t = w.base();
    expect(await w.create(t)).toBeNull();
    const addr = F.dealAddress(w.alex.publicKey, t.dealId);
    w.c.send([await F.signTerms(addr, w.sam.publicKey, false)], w.sam);
    w.c.send([await F.depositIx(w.c.deal(addr), w.alex.publicKey, 40_000_000n)], w.alex);
    expect(w.c.deal(addr).state).toBe("Signed");
    expect(w.c.deal(addr).deposited).toBe(40_000_000n);
    w.c.send(await F.fund(w.c.deal(addr), w.alex.publicKey), w.alex); // the remaining 60
    expect(w.c.deal(addr).deposited).toBe(100_000_000n);
    expect(["Funded", "Active"]).toContain(w.c.deal(addr).state);
  });
});

describe("v0.9 #5: deal page follows the clauses", () => {
  it("fund() pays in part when asked, and confirms ready only once everything is in", async () => {
    const w = world();
    const t = w.base();
    expect(await w.create(t)).toBeNull();
    const addr = F.dealAddress(w.alex.publicKey, t.dealId);
    w.c.send([await F.signTerms(addr, w.sam.publicKey, false)], w.sam);
    const part = await F.fund(w.c.deal(addr), w.alex.publicKey, { amount: 30_000_000n });
    expect(part).toHaveLength(1); // deposit only, no confirm_ready
    w.c.send(part, w.alex);
    expect(w.c.deal(addr)).toMatchObject({ state: "Signed", deposited: 30_000_000n });
    const rest = await F.fund(w.c.deal(addr), w.alex.publicKey, { amount: 999_000_000n }); // more than owed → just the remainder, then ready
    expect(rest).toHaveLength(2);
    w.c.send(rest, w.alex);
    expect(w.c.deal(addr).deposited).toBe(100_000_000n);
    expect(w.c.deal(addr).state).toBe("Funded");
  });

  it("every action maps to a section of the agreement, and the deal page shows the clause from the verified text", async () => {
    const { ACTION_SECTION, ALL_ACTIONS } = await import("../src/lib/view");
    expect(ALL_ACTIONS.length).toBe(21);
    for (const a of ALL_ACTIONS) expect([2, 4, 5, 6, 9]).toContain(ACTION_SECTION[a]);
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("clauseIndex(check.text)");
    expect(page).toContain('sheet === "payPart"');
    expect(page).toContain("F.popcount(m.approvals)");
  });
});

describe("v0.10 #2: list rows", () => {
  it("every deal state yields a one-line `short` and a pill only when something is happening", async () => {
    const { viewDeal } = await import("../src/lib/view");
    const w = world();
    const t = w.base();
    expect(await w.create(t)).toBeNull();
    const addr = F.dealAddress(w.alex.publicKey, t.dealId);
    const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };
    const v = (me: PublicKey) => viewDeal(w.c.deal(addr), me, local, w.c.now());
    expect(v(w.sam.publicKey)).toMatchObject({ short: "Review & accept", pill: { cls: "move", text: "Your move" } });
    expect(v(w.alex.publicKey)).toMatchObject({ short: "Waiting for signatures", pill: null });
    w.c.send([await F.signTerms(addr, w.sam.publicKey, false)], w.sam);
    expect(v(w.alex.publicKey)).toMatchObject({ short: "Pay in to continue", pill: { cls: "move", text: "Pay in" } });
    w.c.send(await F.fund(w.c.deal(addr), w.alex.publicKey), w.alex);
    expect(v(w.sam.publicKey).short).toBe("Mark as shipped");
    w.c.send(await F.markShipped(w.c.deal(addr), w.sam.publicKey, false), w.sam);
    expect(v(w.alex.publicKey).short).toMatch(/^Say it's OK, or pause|^Unlocks /);
    w.c.send(await F.pause(addr, w.alex.publicKey), w.alex);
    expect(v(w.alex.publicKey)).toMatchObject({ short: "Paused until you agree", pill: { cls: "paused", text: "Paused" } });
    w.c.send(await F.refundByPayee(w.c.deal(addr), w.sam.publicKey), w.sam);
    expect(v(w.alex.publicKey)).toMatchObject({ short: "Returned to the payer", pill: { cls: "ended", text: "Refunded" } });
    for (const s of [v(w.alex.publicKey).short, v(w.sam.publicKey).short]) expect(s.length).toBeLessThan(40);
  });
});
