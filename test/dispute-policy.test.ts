/** v0.7 #5: dispute policy in the Builder — one creating transaction, c4 text, expiry actions, on the deployed binary. */
import { describe, expect, it } from "vitest";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { ASSETS } from "../src/lib/config";
import { agreementSpec, type AgreementSettings } from "../src/lib/agreementSpec";

const DAY = 86400;

function txBytes(ixs: any[], payer: Keypair): number {
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx.serialize().length;
}

describe("v0.7 #5: create + set_dispute_policy + sign in ONE transaction", () => {
  it("the largest Builder deal (16 parts, 2-of-3 backup, AutoSplit, policy) fits 1232 bytes and lands on the deployed binary", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const me = c.wallet();
    const other = Keypair.generate().publicKey;
    const backup = Keypair.generate().publicKey;
    const mint = c.mint(issuer);
    const a: AgreementSettings = {
      creator: me.publicKey, dealId: 2n ** 63n - 1n, role: "payer", other, amounts: Array.from({ length: 16 }, () => 18_446_744_073n),
      settle: "split", windowDays: 365, splitPct: 33.33, backup, backupDelayDays: 30, asset: { ...ASSETS.USDC, mint }, disputePolicy: "Split", disputeDays: 365,
    };
    const spec = { ...agreementSpec(a), termsHash: new Uint8Array(32).fill(255) };
    const ixs = await F.createAndSign(spec, false);
    expect(ixs).toHaveLength(3);
    const size = txBytes(ixs, me);
    console.log(`bundled create + set_dispute_policy + sign: ${size} bytes`);
    expect(size).toBeLessThanOrEqual(1232);
    c.send(ixs, me);
    const d = c.deal(F.dealAddress(me.publicKey, spec.dealId));
    expect([d.disputePolicy, d.disputeWindowSecs, d.signed]).toEqual(["Split", 365 * DAY, 1]);
  });
});

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { RISK } from "../src/lib/config";
import { COPY } from "../src/lib/copy";
import { agreementStatus } from "../src/lib/agreementCheck";
import { encodeBlob, fieldsFromSpec, newNonce, renderAgreement, termsHash, verifyAgreement, type LinkBlob } from "../src/lib/template";
import { disputeExpired, disputeLimitText, disputeUsed, viewDeal } from "../src/lib/view";
import { evidenceDealRecord, evidenceEventSentence } from "../src/lib/evidence";
import { explainError } from "../src/lib/wallet";
import { buildProtectedPayment } from "../src/lib/protected";
import { expectProgramError } from "./harness";
import type { DisputePolicyName } from "../src/lib/deal";

const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

/** A Builder deal (goods, 10-day timer, or a split) with a dispute policy, formed exactly as the Builder does, then funded and started. */
async function builderDeal(policy: DisputePolicyName, days: number, settle: "timer" | "split" = "timer") {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet(); // payer, creator
  const sam = c.wallet(); // payee
  const eve = c.wallet(); // stranger
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
  const asset = { ...ASSETS.USDC, mint };
  const spec0 = agreementSpec({ creator: alex.publicKey, dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)), role: "payer", other: sam.publicKey, amounts: [100_000_000n], settle, windowDays: 10, splitPct: 30, backupDelayDays: 3, asset, disputePolicy: policy, disputeDays: days });
  const addr = F.dealAddress(alex.publicKey, spec0.dealId);
  const blob: LinkBlob = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: "Standing desk", n: newNonce() };
  const text = renderAgreement(fieldsFromSpec(spec0, addr, 6, asset.knownRiskFlags), blob);
  const spec = { ...spec0, termsHash: termsHash(text) };
  c.send(await F.createAndSign(spec, false), alex);
  return { c, alex, sam, eve, mint, addr, blob, text };
}
async function startAndPause(t: Awaited<ReturnType<typeof builderDeal>>, by: Keypair) {
  t.c.send([await F.signTerms(t.addr, t.sam.publicKey, false)], t.sam);
  t.c.send(await F.fund(t.c.deal(t.addr), t.alex.publicKey), t.alex);
  t.c.send(await F.markShipped(t.c.deal(t.addr), t.sam.publicKey, false), t.sam);
  t.c.send(await F.pause(t.addr, by.publicKey), by);
}

describe("v0.7 #5: the policy is a signed term (format c4)", () => {
  it("the counterparty's app verifies the c4 text, which states the policy; a text that leaves it out never verifies", async () => {
    const t = await builderDeal("RefundPayer", 7);
    const d = t.c.deal(t.addr);
    expect([d.disputePolicy, d.disputeWindowSecs]).toEqual(["RefundPayer", 7 * DAY]);
    const s = agreementStatus(d, encodeBlob(t.blob), 6);
    expect(s.kind).toBe("verified");
    expect(s.kind === "verified" && s.format).toBe("c5");
    expect(t.text).toContain("Dispute time limit: 7 day(s) (604800 seconds) in total across all pauses. Once the clock has been paused that long, anyone may return the remaining money to the Payer. The limit counts all pauses together and never resets: once it has been reached, any later pause lets anyone return the remaining money to the Payer at once.");
    // The same deal described as if it had no policy does not verify.
    const lying = renderAgreement({ ...fieldsFromSpec({ ...agreementSpec({ creator: t.alex.publicKey, dealId: d.dealId, role: "payer", other: t.sam.publicKey, amounts: [100_000_000n], settle: "timer", windowDays: 10, splitPct: 30, backupDelayDays: 3, asset: { ...ASSETS.USDC, mint: t.mint } }) }, t.addr, 6, 1) }, t.blob);
    expect(createHash("sha256").update(lying).digest("hex")).not.toBe(Buffer.from(d.termsHash).toString("hex"));
  });

  it("section 5, hand-checked for each policy (goods, 30% AutoSplit, 10-day window)", () => {
    const k = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
    const f: any = { deal: k(9), dealId: 42n, parties: [k(1), k(2)], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, mint: k(3), decimals: 6, milestoneAmounts: [25_000_000n], rule: "AutoSplit", timerMode: "FromActivation", timeoutSecs: 864000, splitBps: 3000, tieBreaker: PublicKey.default, recoverySigners: [k(1), k(2)], recoveryThreshold: 2, recoveryDelaySecs: 259200, riskFlags: 1, acceptedRiskFlags: 1, priceRiskTerm: 0 };
    const blob: any = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: "Desk", n: "00112233445566778899aabbccddeeff" };
    // c4 (v0.7) is frozen: these bytes must never change. c5 is checked below.
    const s5 = (p: DisputePolicyName, w: number) => renderAgreement({ ...f, disputePolicy: p, disputeWindowSecs: w }, blob, undefined, "c4").split("\n").find((l) => l.startsWith("5."))!;
    const head = "5. IF THERE IS A PROBLEM. Rule: AUTOMATIC SPLIT. 10 day(s) (864000 seconds) after the clock starts, anyone may split the remaining money: 30.00% to the Payee, the rest to the Payer. The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, the Payee returns it to the Payer, ";
    const tail = " The parties may always settle by every party signing the same division. While money is held, the Payee may at any time, alone, return all of it to the Payer; this cannot be undone.";
    expect(s5("NeverExpire", 0)).toBe(head + "or the recovery signers act." + tail + " Dispute time limit: none. A pause holds the money for as long as it lasts.");
    const lim = "the recovery signers act, or the dispute time limit below is reached." + tail;
    expect(s5("ResumeRule", 7 * DAY)).toBe(head + lim + " Dispute time limit: 7 day(s) (604800 seconds) in total across all pauses. Once the clock has been paused that long, anyone may end the pause, and the clock resumes under the rule above.");
    expect(s5("Split", DAY)).toBe(head + lim + " Dispute time limit: 1 day(s) (86400 seconds) in total across all pauses. Once the clock has been paused that long, anyone may divide the remaining money: 30.00% to the Payee, the rest to the Payer.");
    expect(s5("RefundPayer", 365 * DAY)).toBe(head + lim + " Dispute time limit: 365 day(s) (31536000 seconds) in total across all pauses. Once the clock has been paused that long, anyone may return the remaining money to the Payer.");
    // c3 / c2 keep rendering (and verifying) deals without a policy, byte-for-byte as before.
    expect(renderAgreement(f, blob, undefined, "c3")).not.toContain("Dispute time limit");
    expect(() => renderAgreement({ ...f, disputePolicy: "Split", disputeWindowSecs: DAY }, blob, undefined, "c3")).toThrow(/can't state a dispute time limit/);
  });
});

describe("v0.7 #5: when the time limit runs out (deployed binary)", () => {
  it("ResumeRule: before the limit only the pauser can resume; after it anyone can end the pause and the clock resumes", async () => {
    const t = await builderDeal("ResumeRule", 1);
    await startAndPause(t, t.alex);
    let d = t.c.deal(t.addr);
    expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).not.toContain("endDispute");
    expect(viewDeal(d, t.sam.publicKey, local, t.c.now()).sentence).toMatch(/Dispute time limit in 1 d 0 h$/);
    expectProgramError(t.c.trySend(await F.resume(t.addr, t.eve.publicKey), t.eve), "OnlyRaiserMayWithdraw");
    t.c.warp(DAY);
    d = t.c.deal(t.addr);
    expect(disputeExpired(d, t.c.now())).toBe(true);
    const v = viewDeal(d, t.eve.publicKey, local, t.c.now());
    expect(v.actions).toContain("endDispute");
    expect(v.actions).not.toContain("collect");
    expect(v.sentence).toBe("The dispute time limit has passed — anyone can end the paused dispute; the clock resumes.");
    // resolve is refused until the pause is ended — the error is mapped.
    const err = t.c.trySend(await F.collect(d, t.eve.publicKey), t.eve);
    expectProgramError(err, "ExpiredDisputeMustBeWithdrawn");
    expect(explainError(new Error(err!))).toBe("The dispute time limit has passed: the pause has to be ended first (anyone can), then the clock resumes.");
    t.c.send(await F.resume(t.addr, t.eve.publicKey), t.eve);
    expect(t.c.deal(t.addr).state).toBe("Active");
    // The allowance is used up: the pause sheet says so.
    expect(disputeExpired(t.c.deal(t.addr), t.c.now())).toBe(true);
    expect(COPY.disputeLimitUsedUp).toMatch(/anyone can end the pause right away/);
  });

  for (const [policy, settle, payee, payer] of [
    ["Split", "timer", 50_000_000n, 50_000_000n],
    ["Split", "split", 30_000_000n, 70_000_000n],
    ["RefundPayer", "timer", 0n, 100_000_000n],
  ] as const) {
    it(`${policy}${settle === "split" ? " under a 30% AutoSplit" : ""}: anyone can carry it out after the limit (DisputeExpired), counted across pauses`, async () => {
      const t = await builderDeal(policy, 1, settle);
      await startAndPause(t, t.sam);
      t.c.warp(10 * 3600);
      t.c.send(await F.resume(t.addr, t.sam.publicKey), t.sam);
      t.c.send(await F.pause(t.addr, t.alex.publicKey), t.alex);
      t.c.warp(14 * 3600 - 60);
      let d = t.c.deal(t.addr);
      expect(disputeUsed(d, t.c.now())).toBe(DAY - 60);
      expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).not.toContain("collect");
      expectProgramError(t.c.trySend(await F.collect(d, t.eve.publicKey), t.eve), "TimeoutPausedByDispute");
      t.c.warp(60);
      d = t.c.deal(t.addr);
      const v = viewDeal(d, t.eve.publicKey, local, t.c.now());
      expect(v.actions).toContain("collect");
      expect(v.sentence).toMatch(policy === "Split" ? /^The dispute time limit has passed — anyone can carry out the split: (50|30)% to / : /^The dispute time limit has passed — anyone can return it to /);
      const a0 = t.c.tokenBalance(t.alex.publicKey, t.mint);
      t.c.send(await F.collect(d, t.eve.publicKey), t.eve);
      expect(t.c.deal(t.addr).state).toBe("Completed");
      expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(payee);
      expect(t.c.tokenBalance(t.alex.publicKey, t.mint) - a0).toBe(payer);
      expect(t.c.lastEvents[0]).toMatchObject({ name: "DealResolved", data: { path: "DisputeExpired" } });
      expect(evidenceEventSentence(t.c.lastEvents, t.c.deal(t.addr))).toContain("settled by its dispute policy");
      expect(evidenceDealRecord(t.c.deal(t.addr)).dispute).toEqual({ policy, windowSecs: DAY, disputedSecs: expect.any(Number) });
    });
  }
});

describe("v0.7 #5: limits, defaults and copy", () => {
  it("1–365 days only; rules whose clock starts at a dispute never carry a policy", () => {
    const base = { creator: Keypair.generate().publicKey, dealId: 1n, role: "payer" as const, other: Keypair.generate().publicKey, amounts: [1n], windowDays: 10, splitPct: 50, backupDelayDays: 3, asset: ASSETS.USDC };
    expect(() => agreementSpec({ ...base, settle: "timer", disputePolicy: "Split", disputeDays: 0 })).toThrow(/1 to 365/);
    expect(() => agreementSpec({ ...base, settle: "timer", disputePolicy: "Split", disputeDays: 366 })).toThrow(/1 to 365/);
    expect(agreementSpec({ ...base, settle: "timer", disputePolicy: "Split", disputeDays: 365 }).disputeWindowSecs).toBe(365 * DAY);
    expect(agreementSpec({ ...base, settle: "decider", decider: Keypair.generate().publicKey, disputePolicy: "Split", disputeDays: 3 }).disputePolicy).toBeUndefined();
    expect(agreementSpec({ ...base, settle: "nobody", disputePolicy: "RefundPayer", disputeDays: 3 }).disputePolicy).toBeUndefined();
    expect(agreementSpec({ ...base, settle: "timer" }).disputePolicy).toBeUndefined(); // default: Hold until you both agree
  });

  it("Pay and requests stay NeverExpire: the Protected preset creates with exactly [create, sign]", async () => {
    const k = () => Keypair.generate().publicKey;
    const me = k();
    const { spec } = buildProtectedPayment({ creator: me, payer: me, payee: k(), raw: 1n, asset: ASSETS.USDC, presetId: "shipped", dealId: 5n, subject: "x" });
    expect(spec.disputePolicy).toBeUndefined();
    expect(await F.createAndSign(spec, false)).toHaveLength(2);
  });

  it("no sequenced fallback: set_dispute_policy is only ever built inside createAndSign", () => {
    const flows = readFileSync(new URL("../src/lib/flows.ts", import.meta.url), "utf8");
    expect(flows.match(/setDisputePolicyIx\(/g)).toHaveLength(2); // its definition + the one call in createAndSign
    for (const f of ["screens/Builder.tsx", "screens/DealPage.tsx", "screens/Pay.tsx", "lib/agreementSpec.ts"]) {
      expect(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).not.toContain("setDisputePolicyIx");
    }
  });

  it("Builder offers the four choices, default 'Hold until you all agree', and shows the policy in review", () => {
    const b = readFileSync(new URL("../src/screens/Builder.tsx", import.meta.url), "utf8");
    // v0.9: the Custom builder addresses every party ("you all"); the four choices and the review line stay.
    for (const s of ['"Hold until you all agree"', '"Resume the clock"', '"Split"', '"Return to payer"']) expect(b).toContain(`title: ${s}`);
    expect(b).toContain('useState<DisputePolicyName>(init?.disputePolicy ?? "NeverExpire")'); // v0.14: a counter-proposal may start elsewhere
    expect(b).toContain('<KV k="If a pause lasts" v={policyLine}');
  });

  it("pause copy: NeverExpire keeps 'no time limit'; a policy states the window and what happens", () => {
    expect(COPY.pauseSheet("Sam", "Sam")).toMatch(/^Pausing has no time limit\./);
    const lim = "Dispute time limit: once the clock has been paused for 3 days in total, anyone can return everything left to Alex.";
    expect(COPY.pauseSheet("Sam", "Sam", lim)).toMatch(/^Dispute time limit: once the clock has been paused for 3 days in total, anyone can return everything left to Alex\. Until then, the money moves only when you and Sam sign the same split\./);
    expect(COPY.pausedBanner(true, "You", "Sam", "Sam", lim)).toMatch(/^You paused the clock\. Dispute time limit: .* Until then, /);
    expect(COPY.pausedBanner(false, "Sam", "Sam", "you")).toContain("There's no time limit.");
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toContain('nameFor(payeeKey, local), limit)');
    expect(page).toContain('<KV k="Paused so far"');
    expect(page).toContain('btn("endDispute", COPY.endDisputeButton');
  });

  it("errors from set_dispute_policy are mapped", () => {
    expect(explainError(new Error("Error Code: InvalidDisputeWindow. Error Number: 6041."))).toMatch(/1 and 365 days/);
    expect(explainError(new Error("Error Code: DisputePolicyLocked. Error Number: 6043."))).toMatch(/only be set when the payment is created/);
    expect(explainError(new Error("Error Code: OnlyCreatorMaySetPolicy. Error Number: 6042."))).toMatch(/Only whoever creates/);
  });

  it("disputeLimitText reads the deal's own fields", async () => {
    const t = await builderDeal("Split", 3, "split");
    expect(disputeLimitText(t.c.deal(t.addr), local)).toMatch(/paused for 3 days in total, anyone can split what's left — 30% to /);
    expect(RISK.FREEZE_AUTHORITY).toBe(1);
  });
});

describe("v0.7.1 #2: set_dispute_policy account list (SDK 0.1.5 IDL)", () => {
  it("creator, deal, instructions sysvar, event authority, program — in the IDL's order", async () => {
    const { IDL } = await import("@latch-labs/sdk");
    const { SYSVAR_INSTRUCTIONS_PUBKEY } = await import("@solana/web3.js");
    const idlAccounts = (IDL as any).instructions.find((i: any) => i.name === "set_dispute_policy").accounts.map((a: any) => a.name);
    expect(idlAccounts).toEqual(["creator", "deal", "instructions", "event_authority", "program"]);
    const creator = Keypair.generate().publicKey;
    const deal = F.dealAddress(creator, 1n);
    const ix = await F.setDisputePolicyIx(deal, creator, "Split", DAY);
    expect(ix.keys.slice(0, 3).map((k) => k.pubkey.toBase58())).toEqual([creator.toBase58(), deal.toBase58(), SYSVAR_INSTRUCTIONS_PUBKEY.toBase58()]);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2]).toMatchObject({ isSigner: false, isWritable: false });
    expect(ix.keys).toHaveLength(5);
  });
});

describe("v0.7.1 #4: c5 says the limit is cumulative and never resets", () => {
  it("section 5 in c5: c4's sentence plus what happens to any later pause, hand-checked per policy; NeverExpire unchanged but line 1", () => {
    const k = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
    const f: any = { deal: k(9), dealId: 42n, parties: [k(1), k(2)], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, mint: k(3), decimals: 6, milestoneAmounts: [25_000_000n], rule: "AutoSplit", timerMode: "FromActivation", timeoutSecs: 864000, splitBps: 3000, tieBreaker: PublicKey.default, recoverySigners: [k(1), k(2)], recoveryThreshold: 2, recoveryDelaySecs: 259200, riskFlags: 1, acceptedRiskFlags: 1, priceRiskTerm: 0 };
    const blob: any = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: "Desk", n: "00112233445566778899aabbccddeeff" };
    const r = (p: DisputePolicyName, w: number, fmt: "c4" | "c5") => renderAgreement({ ...f, disputePolicy: p, disputeWindowSecs: w }, blob, undefined, fmt);
    const s5 = (p: DisputePolicyName, w: number, fmt: "c4" | "c5") => r(p, w, fmt).split("\n").find((l) => l.startsWith("5."))!;
    expect(s5("ResumeRule", 7 * DAY, "c5")).toBe(s5("ResumeRule", 7 * DAY, "c4") + " The limit counts all pauses together and never resets: once it has been reached, anyone may end any later pause at once.");
    expect(s5("Split", DAY, "c5")).toBe(s5("Split", DAY, "c4") + " The limit counts all pauses together and never resets: once it has been reached, any later pause lets anyone divide the remaining money that way at once.");
    expect(s5("RefundPayer", DAY, "c5")).toBe(s5("RefundPayer", DAY, "c4") + " The limit counts all pauses together and never resets: once it has been reached, any later pause lets anyone return the remaining money to the Payer at once.");
    expect(r("NeverExpire", 0, "c5")).toBe(r("NeverExpire", 0, "c4").replace("· format c4", "· format c5"));
  });

  it("a deal signed with c4 text (v0.7) still verifies, as c4", () => {
    const k = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
    const f: any = { deal: k(9), dealId: 42n, parties: [k(1), k(2)], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, mint: k(3), decimals: 6, milestoneAmounts: [25_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 864000, splitBps: 0, tieBreaker: PublicKey.default, recoverySigners: [k(1), k(2)], recoveryThreshold: 2, recoveryDelaySecs: 259200, riskFlags: 1, acceptedRiskFlags: 1, priceRiskTerm: 0, disputePolicy: "Split", disputeWindowSecs: DAY };
    const blob: any = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: "Desk", n: "00112233445566778899aabbccddeeff" };
    const c4 = renderAgreement(f, blob, undefined, "c4");
    expect(verifyAgreement(f, blob, termsHash(c4))).toMatchObject({ ok: true, format: "c4" });
  });

  it("the app says it before signing: Builder choices, the policy line (review, deal page banner, pause sheet)", () => {
    const b = readFileSync(new URL("../src/screens/Builder.tsx", import.meta.url), "utf8");
    expect(b).toContain('const LIMIT_ADDS_UP = "The limit adds up every pause and never resets: once it\'s used up, any new pause ends that way straight away.";');
    expect(b.match(/\$\{LIMIT_ADDS_UP\}/g)).toHaveLength(3);
    expect(COPY.disputeLimit("ResumeRule", "3 days", "Alex", "Sam", 50)).toMatch(/All pauses count toward it and it never resets — after that, anyone can end any new pause straight away\.$/);
    expect(COPY.disputeLimit("Split", "3 days", "Alex", "Sam", 50)).toMatch(/never resets — after that, any new pause lets anyone carry out the split straight away\.$/);
    expect(COPY.disputeLimit("RefundPayer", "3 days", "Alex", "Sam", 50)).toMatch(/never resets — after that, any new pause lets anyone return it to Alex straight away\.$/);
    expect(COPY.disputeLimit("NeverExpire", "", "Alex", "Sam", 50)).not.toMatch(/never resets/);
  });
});

describe("v0.7.1 #4: the program does what the copy says (deployed binary)", () => {
  for (const policy of ["Split", "RefundPayer"] as const) {
    it(`${policy}: after the limit is used up and the pause is lifted, a NEW pause is executable at once`, async () => {
      const t = await builderDeal(policy, 1);
      await startAndPause(t, t.alex);
      t.c.warp(DAY + 1);
      t.c.send(await F.resume(t.addr, t.alex.publicKey), t.alex); // the pauser lifts it before anyone settles
      expect(t.c.deal(t.addr).state).toBe("Active");
      t.c.send(await F.pause(t.addr, t.sam.publicKey), t.sam);
      const d = t.c.deal(t.addr);
      expect(disputeExpired(d, t.c.now())).toBe(true);
      expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).toContain("collect");
      t.c.send(await F.collect(d, t.eve.publicKey), t.eve); // no waiting
      expect(t.c.deal(t.addr).state).toBe("Completed");
    });
  }
  it("ResumeRule: after the limit is used up, anyone can end a new pause at once", async () => {
    const t = await builderDeal("ResumeRule", 1);
    await startAndPause(t, t.alex);
    t.c.warp(DAY + 1);
    t.c.send(await F.resume(t.addr, t.eve.publicKey), t.eve);
    t.c.send(await F.pause(t.addr, t.sam.publicKey), t.sam);
    expect(viewDeal(t.c.deal(t.addr), t.eve.publicKey, local, t.c.now()).actions).toContain("endDispute");
    t.c.send(await F.resume(t.addr, t.eve.publicKey), t.eve);
    expect(t.c.deal(t.addr).state).toBe("Active");
  });
});
