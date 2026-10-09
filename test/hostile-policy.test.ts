/**
 * v0.7 #2 (critical): in the request flow the PAYER creates the deal, so a
 * hostile payer can call set_dispute_policy before signing — e.g.
 * RefundPayer after 1 day: pause after the seller ships, take the money back
 * a day later. Everything here runs on the deployed binary.
 */
import { describe, expect, it } from "vitest";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { buildProtectedPayment, protectedBlob } from "../src/lib/protected";
import { decodeBlob, encodeBlob, fieldsFromDeal, fieldsFromSpec, renderAgreement, termsHash, verifyAgreement } from "../src/lib/template";
import { hasRequestShape, matchRequests } from "../src/lib/request";
import { agreementStatus, signBlocked } from "../src/lib/agreementCheck";
import { modeOf, type DisputePolicyName } from "../src/lib/deal";
import { disputeLimitText, viewDeal } from "../src/lib/view";

const DAY = 86400;

async function setup() {
  const c = new Chain();
  const alex = c.wallet(); // hostile payer
  const sam = c.wallet(); // requester (payee)
  const issuer = c.wallet();
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
  const blob = protectedBlob("shipped", "Vintage lamp");
  const local: any = {
    contacts: {},
    links: {},
    requests: { [blob.n]: { blob: encodeBlob(blob), amount: "80000000", asset: "USDC", createdAt: 0 } },
    payments: [],
  };
  const config = await import("../src/lib/config");
  const real = config.ASSETS.USDC.mint;
  (config.ASSETS.USDC as any).mint = mint;
  const restore = () => ((config.ASSETS.USDC as any).mint = real);
  const asset = { ...config.ASSETS.USDC, mint };
  /** The attacker: the request's blob and honest-looking terms, a c3 fingerprint that leaves the policy out, then set_dispute_policy before signing. */
  const make = async (policy: DisputePolicyName | null, windowSecs = DAY) => {
    const { spec, deal } = buildProtectedPayment({ creator: alex.publicKey, payer: alex.publicKey, payee: sam.publicKey, raw: 80_000_000n, asset, presetId: "shipped", dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)), subject: blob.s, blob });
    const text = renderAgreement(fieldsFromSpec(spec, deal, 6, asset.knownRiskFlags), blob);
    const [create, sign] = await F.createAndSign({ ...spec, termsHash: termsHash(text) }, false);
    c.send(policy ? [create, await F.setDisputePolicyIx(deal, alex.publicKey, policy, windowSecs), sign] : [create, sign], alex);
    return deal;
  };
  return { c, alex, sam, mint, local, make, restore, blob };
}

describe("v0.7 #2: a payer-set dispute policy never passes as 'your request'", () => {
  it("the threat is real: RefundPayer + 1 day lets the payer take the money back after the seller ships", async () => {
    const t = await setup();
    try {
      const deal = await t.make("RefundPayer");
      t.c.send([await F.signTerms(deal, t.sam.publicKey, false)], t.sam);
      t.c.send(await F.fund(t.c.deal(deal), t.alex.publicKey), t.alex);
      t.c.send(await F.markShipped(t.c.deal(deal), t.sam.publicKey, false), t.sam);
      t.c.send(await F.pause(deal, t.alex.publicKey), t.alex);
      t.c.warp(DAY + 1);
      t.c.send(await F.collect(t.c.deal(deal), t.alex.publicKey), t.alex);
      expect(t.c.deal(deal).state).toBe("Completed");
      expect(t.c.tokenBalance(t.alex.publicKey, t.mint)).toBe(1_000_000_000n); // all of it back
    } finally {
      t.restore();
    }
  });

  for (const [policy, words] of [
    ["RefundPayer", /anyone can return everything left to /],
    ["Split", /anyone can split what's left — 50% to /],
    ["ResumeRule", /anyone can end the pause and the clock resumes toward /],
  ] as const) {
    it(`${policy} + 1 day: refused as a request answer, blocked from signing, shown before accept`, async () => {
      const t = await setup();
      try {
        const d = t.c.deal(await t.make(policy));
        const me = t.sam.publicKey.toBase58();
        expect(d.disputePolicy).toBe(policy);
        expect(d.disputeWindowSecs).toBe(DAY);
        // The c3 fingerprint ignores the policy — exactly why it can't vouch:
        expect(verifyAgreement({ ...fieldsFromDeal(d, 6), disputePolicy: undefined, disputeWindowSecs: undefined }, t.blob, d.termsHash).ok).toBe(true);
        expect(verifyAgreement(fieldsFromDeal(d, 6), t.blob, d.termsHash).ok).toBe(false);
        expect(hasRequestShape(d, me, 10, 1)).toBe(false);
        expect(matchRequests([d], me, t.local)).toEqual({ matches: [], conflicts: [], cleared: [] });
        const status = agreementStatus(d, encodeBlob(t.blob), 6);
        expect(status.kind).toBe("mismatch");
        expect(signBlocked(status)).toBe(true);
        expect(modeOf(d)).toBe("custom"); // never labelled Protected
        const v = viewDeal(d, t.sam.publicKey, t.local, t.c.now());
        expect(v.sentence).toMatch(/has a dispute time limit$/);
        expect(disputeLimitText(d, t.local)).toMatch(/^Dispute time limit: once the clock has been paused for 1 day in total, /);
        expect(disputeLimitText(d, t.local)).toMatch(words);
      } finally {
        t.restore();
      }
    });
  }

  it("control: the same request answered with no policy still matches", async () => {
    const t = await setup();
    try {
      const d = t.c.deal(await t.make(null));
      expect(matchRequests([d], t.sam.publicKey.toBase58(), t.local).matches).toHaveLength(1);
      expect(modeOf(d)).toBe("protected");
      expect(agreementStatus(d, encodeBlob(t.blob), 6).kind).toBe("verified");
      expect(decodeBlob(encodeBlob(t.blob))).not.toBeNull();
    } finally {
      t.restore();
    }
  });
});

describe("v0.7 #2: the deal page states a non-default policy before accept", () => {
  it("banner (with the before-accept line for an unsigned party) and the 'If a pause lasts' row", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/hasDisputeLimit\(d\) && d\.state !== "Completed" && d\.state !== "Cancelled" && d\.state !== "Deadlocked" && \(\s*<div className="banner warn" data-testid="dispute-limit">\s*\{disputeLimitText\(d, local, publicKey\)\}\s*\{myIdx >= 0 && !hasBit\(d\.signed, myIdx\) \? ` \$\{COPY\.disputeLimitBeforeAccept\}`/);
    expect(page).toContain('<KV k="If a pause lasts" v={disputeLimitText(d, local, publicKey)} />');
    // While paused, the paused banner carries the policy instead (and says when the limit has passed).
    expect(page).toContain("limit && disputeExpired(d, now)");
  });
});
