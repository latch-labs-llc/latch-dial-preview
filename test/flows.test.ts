/**
 * End-to-end flow tests against the deployed Latch binary in LiteSVM.
 * Covers what R8 §8 Phase 0 item 3 asks to be tested before relying on it:
 * bundled transactions (size + execution), the request-first flow, pause and
 * split, timeout collect, wSOL wrap → deposit → payout → unwrap, and the
 * memcmp discovery offsets.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Chain, fixtureHash, expectProgramError } from "./harness";
import { VERIFIED_BUILD_HASH } from "../src/lib/config";
import * as F from "../src/lib/flows";
import { DEAL_ACCOUNT_SIZE, OFFSETS, unlockAt } from "../src/lib/deal";
import { NATIVE_MINT, RISK } from "../src/lib/config";
import { buildFaucetIxs } from "../worker/src/faucet";
import { matchRequests } from "../src/lib/request";
import { encodeBlob } from "../src/lib/template";
import { fieldsFromDeal, fieldsFromSpec, newNonce, renderAgreement, termsHash, verifyAgreement, type LinkBlob } from "../src/lib/template";

const DAY = 86400;
const usd = (n: number) => BigInt(Math.round(n * 1e6));

function protectedSpec(creator: PublicKey, payer: PublicKey, payee: PublicKey, mint: PublicKey, amount: bigint, days: number, flags: number): F.DealSpec {
  return {
    creator,
    dealId: F.newDealId(Date.now() + Math.floor(Math.random() * 1e6)),
    parties: [payer, payee],
    payerIdx: 0,
    payeeIdx: 1,
    approvalThreshold: 2,
    termsHash: new Uint8Array(32),
    milestoneAmounts: [amount],
    rule: "TimeoutRelease",
    timerMode: "FromActivation",
    timeoutSecs: days * DAY,
    recoverySigners: [payer, payee],
    recoveryThreshold: 2,
    recoveryDelaySecs: 3 * DAY,
    acceptedRiskFlags: flags,
    mint,
  };
}

function withTerms(spec: F.DealSpec, decimals: number, riskFlags: number, subject: string): { spec: F.DealSpec; blob: LinkBlob } {
  const blob: LinkBlob = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: spec.milestoneAmounts.map(() => "") }, s: subject, n: newNonce() };
  const deal = F.dealAddress(spec.creator, spec.dealId);
  const text = renderAgreement(fieldsFromSpec(spec, deal, decimals, riskFlags), blob);
  return { spec: { ...spec, termsHash: termsHash(text) }, blob };
}

// Never skip: a missing or stale fixture must turn the suite red, not green.
describe("deployed binary fixture", () => {
  it("is present and matches the verified build hash (run scripts/fetch-program.mjs)", () => {
    expect(fixtureHash(), "test/fixtures/latch.so missing — run `node scripts/fetch-program.mjs`").toBe(VERIFIED_BUILD_HASH);
  });
});

describe("Latch flows on the deployed binary (LiteSVM)", () => {
  it("payer-initiated protected payment: create → accept → fund → ship → release", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(500));

    const { spec, blob } = withTerms(protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(120), 10, RISK.FREEZE_AUTHORITY), 6, RISK.FREEZE_AUTHORITY, "Used road bike");
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    let d = c.deal(addr);
    expect(d.state).toBe("Draft");
    expect(d.riskFlags & RISK.FREEZE_AUTHORITY).toBeTruthy();

    // Agreement regenerates byte-identically from chain + link.
    expect(verifyAgreement(fieldsFromDeal(d, 6), blob, d.termsHash).ok).toBe(true);
    const tampered = { ...blob, s: "Used road bike (new)" };
    expect(verifyAgreement(fieldsFromDeal(d, 6), tampered, d.termsHash).ok).toBe(false);

    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    d = c.deal(addr);
    expect(d.state).toBe("Signed");

    c.send(await F.fund(d, alex.publicKey), alex);
    d = c.deal(addr);
    expect(d.state).toBe("Funded");
    expect(d.deposited).toBe(usd(120));

    c.send(await F.markShipped(d, sam.publicKey), sam);
    d = c.deal(addr);
    expect(d.state).toBe("Active");
    expect(d.milestones[0].approvals).toBe(0b10); // payee pre-approved
    expect(unlockAt(d)).toBe(d.lastResumedAt + 10 * DAY);

    c.send(await F.approveAndMaybeRelease(d, alex.publicKey), alex);
    d = c.deal(addr);
    expect(d.state).toBe("Completed");
    expect(c.tokenBalance(sam.publicKey, mint)).toBe(usd(120));
    expect(c.maxTxSize).toBeLessThan(1232);
  });

  it("request-first: payee creates; payer signs + deposits + confirms in ONE transaction", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(50));

    const { spec } = withTerms(protectedSpec(sam.publicKey, alex.publicKey, sam.publicKey, mint, usd(40), 3, RISK.FREEZE_AUTHORITY), 6, RISK.FREEZE_AUTHORITY, "Concert ticket");
    const addr = F.dealAddress(sam.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), sam);
    let d = c.deal(addr);
    c.send(await F.fund(d, alex.publicKey, { alsoSign: true }), alex);
    d = c.deal(addr);
    expect(d.state).toBe("Funded");
    expect(d.ready).toBe(0b01);

    c.send(await F.markShipped(d, sam.publicKey), sam);
    d = c.deal(addr);
    expect(d.state).toBe("Active");
    expect(c.maxTxSize).toBeLessThan(1232);
  });

  it("window ends: anyone can collect for the payee (permissionless resolve)", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const stranger = c.wallet();
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(20));
    const { spec } = withTerms(protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(20), 3, RISK.FREEZE_AUTHORITY), 6, RISK.FREEZE_AUTHORITY, "Lamp");
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    c.send(await F.markShipped(c.deal(addr), sam.publicKey, false), sam);

    expectProgramError(c.trySend(await F.collect(c.deal(addr), stranger.publicKey), stranger), "TimeoutNotElapsed");
    c.warp(3 * DAY + 5);
    c.send(await F.collect(c.deal(addr), stranger.publicKey), stranger);
    expect(c.deal(addr).state).toBe("Completed");
    expect(c.tokenBalance(sam.publicKey, mint)).toBe(usd(20));
  });

  it("pause stops the clock; money then moves only when both agree", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(100));
    const { spec } = withTerms(protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(100), 3, RISK.FREEZE_AUTHORITY), 6, RISK.FREEZE_AUTHORITY, "Phone");
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    c.send(await F.markShipped(c.deal(addr), sam.publicKey), sam);

    c.send(await F.pause(addr, alex.publicKey), alex);
    expect(c.deal(addr).state).toBe("Deadlocked");
    c.warp(30 * DAY);
    expectProgramError(c.trySend(await F.collect(c.deal(addr), sam.publicKey), sam), "TimeoutPausedByDispute");
    expectProgramError(c.trySend(await F.resume(addr, sam.publicKey), sam), "OnlyRaiserMayWithdraw");

    c.send(await F.proposeSplit(addr, sam.publicKey, usd(60)), sam);
    c.send(await F.acceptSplit(c.deal(addr), alex.publicKey), alex);
    expect(c.deal(addr).state).toBe("Completed");
    expect(c.tokenBalance(sam.publicKey, mint)).toBe(usd(60));
    expect(c.tokenBalance(alex.publicKey, mint)).toBe(usd(40));
  });

  it("pay with SOL: wSOL wrap → deposit → release → unwrap", async () => {
    const c = new Chain();
    const alex = c.wallet(5);
    const sam = c.wallet(1);
    const lamports = 1_500_000_000n;
    const { spec } = withTerms(protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, NATIVE_MINT, lamports, 3, 0), 9, 0, "Desk");
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    expect(c.deal(addr).riskFlags).toBe(0); // native mint passes vet_mint with no flags
    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(addr), alex.publicKey, { wrapLamports: lamports }), alex);
    expect(c.deal(addr).state).toBe("Funded");
    c.send(await F.markShipped(c.deal(addr), sam.publicKey), sam);
    c.send(await F.approveAndMaybeRelease(c.deal(addr), alex.publicKey), alex);
    expect(c.deal(addr).state).toBe("Completed");
    expect(c.tokenBalance(sam.publicKey, NATIVE_MINT)).toBe(lamports);

    const before = c.lamports(sam.publicKey);
    c.send([F.unwrapSolIx(sam.publicKey)], sam);
    const after = c.lamports(sam.publicKey);
    expect(after - before).toBeGreaterThan(lamports); // payout + ATA rent back, minus fee
    expect(c.raw(getAssociatedTokenAddressSync(NATIVE_MINT, sam.publicKey, true))).toBeNull();
  });

  it("cancel together while funded returns the money to the payer", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(30));
    const { spec } = withTerms(protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(30), 10, RISK.FREEZE_AUTHORITY), 6, RISK.FREEZE_AUTHORITY, "Chair");
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    c.send(await F.cancelTogether(c.deal(addr), alex.publicKey), alex);
    expect(c.deal(addr).state).toBe("Funded");
    c.send(await F.cancelTogether(c.deal(addr), sam.publicKey), sam);
    expect(c.deal(addr).state).toBe("Cancelled");
    expect(c.tokenBalance(alex.publicKey, mint)).toBe(usd(30));
  });

  it("custom: two milestones, named decider (no automatic unlock), decider rules a split", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const judge = c.wallet();
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(300));
    const spec: F.DealSpec = {
      ...protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, 0n, 1, RISK.FREEZE_AUTHORITY),
      milestoneAmounts: [usd(100), usd(200)],
      rule: "TieBreaker",
      timerMode: "FromDeadlock",
      timeoutSecs: 0,
      tieBreaker: judge.publicKey,
      recoverySigners: [judge.publicKey],
      recoveryThreshold: 1,
    };
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    c.send(await F.markShipped(c.deal(addr), sam.publicKey), sam);
    c.send(await F.approveAndMaybeRelease(c.deal(addr), alex.publicKey), alex);
    expect(c.tokenBalance(sam.publicKey, mint)).toBe(usd(100));
    expect(c.deal(addr).state).toBe("Active");

    c.send(await F.pause(addr, alex.publicKey), alex);
    c.send(await F.proposeSplit(addr, judge.publicKey, usd(50)), judge);
    c.send(await F.collect(c.deal(addr), judge.publicKey), judge);
    expect(c.deal(addr).state).toBe("Completed");
    expect(c.tokenBalance(sam.publicKey, mint)).toBe(usd(150));
    expect(c.tokenBalance(alex.publicKey, mint)).toBe(usd(150));
  });

  it("discovery offsets and account size match a real deal account", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const judge = c.wallet();
    const r1 = Keypair.generate().publicKey;
    const mint = c.mint(issuer);
    const spec: F.DealSpec = {
      ...protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(1), 1, RISK.FREEZE_AUTHORITY),
      rule: "TieBreaker",
      timerMode: "FromDeadlock",
      timeoutSecs: 0,
      tieBreaker: judge.publicKey,
      recoverySigners: [r1, judge.publicKey],
      recoveryThreshold: 1,
    };
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    const raw = c.raw(addr)!;
    const at = (o: number) => new PublicKey(raw.slice(o, o + 32));
    expect(raw.length).toBe(DEAL_ACCOUNT_SIZE);
    expect(at(OFFSETS.creator).equals(alex.publicKey)).toBe(true);
    expect(raw[OFFSETS.state]).toBe(0); // Draft
    expect(raw[OFFSETS.numParties]).toBe(2);
    expect(at(OFFSETS.party(0)).equals(alex.publicKey)).toBe(true);
    expect(at(OFFSETS.party(1)).equals(sam.publicKey)).toBe(true);
    expect(at(OFFSETS.tieBreaker).equals(judge.publicKey)).toBe(true);
    expect(at(OFFSETS.recoverySigner(0)).equals(r1)).toBe(true);
    expect(at(OFFSETS.recoverySigner(1)).equals(judge.publicKey)).toBe(true);
  });

  it("v0.7: dispute policy fields — offsets on a real account; deals made before the upgrade decode as NeverExpire / 0 / 0", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const mint = c.mint(issuer);
    // A deal that never sets a policy.
    const plain = protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(1), 10, RISK.FREEZE_AUTHORITY);
    const plainAddr = F.dealAddress(alex.publicKey, plain.dealId);
    c.send(await F.createAndSign(plain, false), alex);
    const p = c.deal(plainAddr);
    expect([p.disputePolicy, p.disputeWindowSecs, p.disputedSecs]).toEqual(["NeverExpire", 0, 0]);
    // One that sets RefundPayer / 2 days in its creating transaction.
    const spec = protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(1), 10, RISK.FREEZE_AUTHORITY);
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    const [create, sign] = await F.createAndSign(spec, false);
    c.send([create, await F.setDisputePolicyIx(addr, alex.publicKey, "RefundPayer", 2 * DAY), sign], alex);
    const raw = c.raw(addr)!;
    expect(raw.length).toBe(DEAL_ACCOUNT_SIZE);
    expect(raw[OFFSETS.disputePolicy]).toBe(3);
    expect(Buffer.from(raw).readUInt32LE(OFFSETS.disputeWindowSecs)).toBe(2 * DAY);
    expect(Buffer.from(raw).readUInt32LE(OFFSETS.disputedSecs)).toBe(0);
    const d = c.deal(addr);
    expect([d.disputePolicy, d.disputeWindowSecs, d.disputedSecs]).toEqual(["RefundPayer", 2 * DAY, 0]);
    // Accounts written by the PREVIOUS binary (3785ede6…, the v0.6 screenshot fixture) decode with the defaults.
    const { readFileSync } = await import("node:fs");
    const fx = JSON.parse(readFileSync(new URL("../screenshots/v0.6/fixture.json", import.meta.url), "utf8"));
    const { decodeDeal } = await import("../src/lib/deal");
    const old = Object.values(fx.deals as Record<string, string>).map((k) => decodeDeal(new PublicKey(k), Buffer.from(fx.accounts[k].data, "base64")));
    expect(old.length).toBeGreaterThan(5);
    for (const o of old) expect([o.disputePolicy, o.disputeWindowSecs, o.disputedSecs]).toEqual(["NeverExpire", 0, 0]);
  });

  it("faucet: mints 100 TEST to a brand-new wallet (authority pays)", async () => {
    const c = new Chain();
    const authority = c.wallet();
    const newcomer = Keypair.generate().publicKey;
    const mint = c.mint(authority);
    c.send(buildFaucetIxs(authority.publicKey, mint, newcomer), authority);
    expect(c.tokenBalance(newcomer, mint)).toBe(100_000_000n);
  });

  it("payer-created request: the requester's app recognises the deal by fingerprint; payer locks the deposit", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet(); // payer
    const sam = c.wallet(); // requester
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(80));
    // Sam's request (stored on Sam's device, shared in the link).
    const blob: LinkBlob = { t: "protected-payment@2", p: { preset: "shipped", window_days: 10 }, s: "Vintage lamp", n: newNonce() };
    const local: any = { links: {}, requests: { [blob.n]: { blob: encodeBlob(blob), amount: usd(80).toString(), asset: "USDC", createdAt: 0 } } };
    // Alex creates the deal from the request blob (Alex pays rent).
    const spec0 = protectedSpec(alex.publicKey, alex.publicKey, sam.publicKey, mint, usd(80), 10, RISK.FREEZE_AUTHORITY);
    const addr = F.dealAddress(alex.publicKey, spec0.dealId);
    const spec = { ...spec0, termsHash: termsHash(renderAgreement(fieldsFromSpec(spec0, addr, 6, RISK.FREEZE_AUTHORITY), blob)) };
    const samBefore = c.lamports(sam.publicKey);
    c.send(await F.createAndSign(spec, false), alex);
    expect(c.lamports(sam.publicKey)).toBe(samBefore); // requester paid nothing
    // The test mint is unknown to the app's asset list, so map it as USDC for matching.
    const config = await import("../src/lib/config");
    const real = config.ASSETS.USDC.mint;
    (config.ASSETS.USDC as any).mint = mint;
    try {
      const m = matchRequests([c.deal(addr)], sam.publicKey.toBase58(), local);
      expect(m.matches).toEqual([{ deal: addr.toBase58(), nonce: blob.n, blob: encodeBlob(blob) }]);
      const forged = { ...local, requests: { x: { ...local.requests[blob.n], blob: encodeBlob({ ...blob, n: newNonce() }) } } };
      expect(matchRequests([c.deal(addr)], sam.publicKey.toBase58(), forged).matches).toEqual([]);
    } finally {
      (config.ASSETS.USDC as any).mint = real;
    }
    // Sam accepts, Alex pays in, Sam ships: Active.
    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    c.send(await F.markShipped(c.deal(addr), sam.publicKey), sam);
    expect(c.deal(addr).state).toBe("Active");
  });

  it("deposit template: returns to the payer when the window ends (TimeoutRefund) and the text verifies", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const venue = c.wallet();
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, usd(250));
    const spec0: F.DealSpec = { ...protectedSpec(alex.publicKey, alex.publicKey, venue.publicKey, mint, usd(250), 7, RISK.FREEZE_AUTHORITY), rule: "TimeoutRefund" };
    const addr = F.dealAddress(alex.publicKey, spec0.dealId);
    const blob: LinkBlob = { t: "deposit@2", p: { purpose: "booking", not_residential_security_deposit: true, milestones: [""] }, s: "Photography booking deposit", n: newNonce() };
    const text = renderAgreement(fieldsFromSpec(spec0, addr, 6, RISK.FREEZE_AUTHORITY), blob);
    expect(text).toContain("NOT a residential security deposit");
    expect(text).toContain("TIMEOUT REFUND");
    c.send(await F.createAndSign({ ...spec0, termsHash: termsHash(text) }, false), alex);
    expect(verifyAgreement(fieldsFromDeal(c.deal(addr), 6), blob, c.deal(addr).termsHash).ok).toBe(true);
    c.send([await F.signTerms(addr, venue.publicKey, false)], venue);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    c.send(await F.markShipped(c.deal(addr), venue.publicKey, false), venue);
    c.warp(7 * DAY + 5);
    c.send(await F.collect(c.deal(addr), alex.publicKey), alex);
    expect(c.tokenBalance(alex.publicKey, mint)).toBe(usd(250));
  });

  it("vehicle template renders the title disclaimer and every enforced field", async () => {
    const alex = Keypair.generate().publicKey;
    const sam = Keypair.generate().publicKey;
    const backup = Keypair.generate().publicKey;
    const spec: F.DealSpec = { ...protectedSpec(alex, alex, sam, NATIVE_MINT, 5_000_000_000n, 14, 0), recoverySigners: [alex, sam, backup] };
    const blob: LinkBlob = { t: "vehicle-sale@2", p: { year: 2015, make_model: "Honda Civic", mileage_band: "50k-100k", title_status: "clean", inspection_days: 2, milestones: [""] }, s: "2015 Honda Civic, silver", n: newNonce() };
    const text = renderAgreement(fieldsFromSpec(spec, F.dealAddress(alex, spec.dealId), 9, 0), blob);
    for (const needle of ["does not transfer the vehicle's title", 'make_model: "Honda Civic"', 'title_status: "clean"', backup.toBase58(), "2 of 3", "TIMEOUT RELEASE"]) expect(text).toContain(needle);
  });
});
