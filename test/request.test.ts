/**
 * Item 2: request links can't control the payer's window. Everything goes
 * through decodeRequest + buildProtectedPayment — the same code Pay.tsx runs.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { ASSETS } from "../src/lib/config";
import { decodeRequest, encodeRequest, matchRequests, matchRequestsIfComplete } from "../src/lib/request";
import { buildProtectedPayment, presetFromParams, protectedBlob } from "../src/lib/protected";
import { encodeBlob, newNonce } from "../src/lib/template";
import { Chain, rawBlob } from "./harness";
import * as F from "../src/lib/flows";

const payee = Keypair.generate().publicKey;
function link(p: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const k = rawBlob({ t: "protected-payment@2", p, s: "Lamp", n: newNonce(), ...extra });
  return encodeRequest({ to: payee.toBase58(), amount: "120000000", asset: "USDC", k });
}

describe("request link validation", () => {
  it("accepts only integer windows equal to a preset, with the matching preset id", () => {
    expect(decodeRequest(link({ preset: "shipped", window_days: 10 }))?.preset).toBe("shipped");
    expect(decodeRequest(link({ preset: "inperson", window_days: 3 }))?.preset).toBe("inperson");
    expect(decodeRequest(link({ preset: "work", window_days: 14 }))?.preset).toBe("work");
  });
  it.each([
    ["14-minute window shown as 10 days", { preset: "shipped", window_days: 0.01 }],
    ["non-preset integer", { preset: "shipped", window_days: 9 }],
    ["string window", { preset: "shipped", window_days: "10" }],
    ["preset/window disagree", { preset: "inperson", window_days: 10 }],
    ["missing preset", { window_days: 10 }],
    ["extra key", { preset: "shipped", window_days: 10, x: 1 }],
    ["negative", { preset: "shipped", window_days: -10 }],
  ])("rejects %s", (_, p) => {
    expect(decodeRequest(link(p))).toBeNull();
  });
  it("rejects bad amount, unknown asset, prototype keys, attachments and other templates", () => {
    const k = encodeBlob(protectedBlob("shipped", "Lamp"));
    const ok = { to: payee.toBase58(), amount: "1", asset: "USDC", k };
    expect(decodeRequest(encodeRequest(ok))).not.toBeNull();
    expect(decodeRequest(encodeRequest({ ...ok, amount: "0" }))).toBeNull();
    expect(decodeRequest(encodeRequest({ ...ok, amount: "1.5" }))).toBeNull();
    expect(decodeRequest(encodeRequest({ ...ok, asset: "constructor" }))).toBeNull();
    expect(decodeRequest(encodeRequest({ ...ok, asset: "DOGE" }))).toBeNull();
    expect(decodeRequest(encodeRequest({ ...ok, to: "not-an-address" }))).toBeNull();
    expect(decodeRequest(link({ preset: "shipped", window_days: 10 }, { a: "0".repeat(64) }))).toBeNull();
    expect(decodeRequest(link({ preset: "shipped", window_days: 10 }, { t: "goods-sale@2" }))).toBeNull();
  });
  it("presetFromParams is strict", () => {
    expect(presetFromParams(null)).toBeNull();
    expect(presetFromParams([])).toBeNull();
    expect(presetFromParams({ preset: "shipped", window_days: 10.0 })).toBe("shipped");
  });
});

describe("Pay spec building (shared with Pay.tsx)", () => {
  it("derives timeout_secs from the displayed preset, and the deployed program stores exactly that", async () => {
    const c = new Chain();
    const alex = c.wallet();
    const sam = c.wallet();
    const req = decodeRequest(link({ preset: "shipped", window_days: 10 }))!;
    const mint = c.mint(c.wallet());
    const asset = { ...ASSETS.USDC, mint };
    const { spec, deal } = buildProtectedPayment({
      creator: alex.publicKey, payer: alex.publicKey, payee: sam.publicKey, raw: req.amount, asset,
      presetId: req.preset, dealId: F.newDealId(Date.now()), subject: req.blob.s, blob: req.blob,
    });
    expect(spec.timeoutSecs).toBe(10 * 86400);
    c.send(await F.createAndSign({ ...spec, parties: [alex.publicKey, sam.publicKey] }, false), alex);
    expect(c.deal(deal).timeoutSecs).toBe(864000);
  });
  it("refuses a request blob that disagrees with the preset shown", () => {
    const alex = Keypair.generate().publicKey;
    const hostile = { t: "protected-payment@2" as const, p: { preset: "shipped", window_days: 0.01 }, s: "x", n: newNonce() };
    expect(() =>
      buildProtectedPayment({ creator: alex, payer: alex, payee, raw: 1n, asset: ASSETS.USDC, presetId: "shipped", dealId: 1n, subject: "x", blob: hostile }),
    ).toThrow(/don't match/);
  });
});

describe("request fingerprint never vouches for hostile terms (deployed binary)", () => {
  async function setup() {
    const c = new Chain();
    const alex = c.wallet(); // payer (possibly hostile)
    const sam = c.wallet(); // requester
    const mint = c.mint(c.wallet());
    const blob = protectedBlob("shipped", "Vintage lamp");
    const local: any = { links: {}, requests: { [blob.n]: { blob: encodeBlob(blob), amount: "80000000", asset: "USDC", createdAt: 0 } } };
    const config = await import("../src/lib/config");
    const real = config.ASSETS.USDC.mint;
    (config.ASSETS.USDC as any).mint = mint;
    const restore = () => ((config.ASSETS.USDC as any).mint = real);
    const asset = { ...config.ASSETS.USDC, mint };
    /** Build a deal the way an attacker would: the request's blob, then any terms they like. */
    const make = async (tweak: (s: F.DealSpec) => F.DealSpec, id = Date.now() + Math.random() * 1e6) => {
      const base = buildProtectedPayment({ creator: alex.publicKey, payer: alex.publicKey, payee: sam.publicKey, raw: 80_000_000n, asset, presetId: "shipped", dealId: BigInt(Math.floor(id)), subject: blob.s, blob }).spec;
      const spec = tweak(base);
      const deal = F.dealAddress(alex.publicKey, spec.dealId);
      const { fieldsFromSpec, renderAgreement, termsHash } = await import("../src/lib/template");
      const text = renderAgreement(fieldsFromSpec(spec, deal, 6, 1), blob);
      c.send(await F.createAndSign({ ...spec, termsHash: termsHash(text) }, false), alex);
      return c.deal(deal);
    };
    return { c, alex, sam, local, make, restore };
  }

  it("an honest answer matches", async () => {
    const t = await setup();
    try {
      const d = await t.make((s) => s);
      expect(matchRequests([d], t.sam.publicKey.toBase58(), t.local).matches).toHaveLength(1);
    } finally {
      t.restore();
    }
  });
  it("matching is skipped on an incomplete deal list, and only then (a hidden Draft could be the conflicting one)", async () => {
    const t = await setup();
    try {
      const d = await t.make((s) => s);
      const me = t.sam.publicKey.toBase58();
      expect(matchRequestsIfComplete({ deals: [d], failed: 0 }, me, t.local).matches).toHaveLength(1);
      expect(matchRequestsIfComplete({ deals: [d], failed: 1 }, me, t.local)).toEqual({ matches: [], conflicts: [], cleared: [] });
    } finally {
      t.restore();
    }
  });
  it("hostile 1-of-1 recovery held by the payer: fingerprint matches, shape check refuses", async () => {
    const t = await setup();
    try {
      const d = await t.make((s) => ({ ...s, recoverySigners: [t.alex.publicKey], recoveryThreshold: 1 }));
      const { decodeBlob, fieldsFromDeal, verifyAgreement } = await import("../src/lib/template");
      const blob = decodeBlob(Object.values<any>(t.local.requests)[0].blob)!;
      expect(verifyAgreement(fieldsFromDeal(d, 6), blob, d.termsHash).ok).toBe(true); // the fingerprint alone would vouch
      expect(matchRequests([d], t.sam.publicKey.toBase58(), t.local)).toEqual({ matches: [], conflicts: [], cleared: [] });
    } finally {
      t.restore();
    }
  });
  it("hostile 1-second TimeoutRefund is refused", async () => {
    const t = await setup();
    try {
      const d = await t.make((s) => ({ ...s, rule: "TimeoutRefund", timeoutSecs: 1 }));
      expect(matchRequests([d], t.sam.publicKey.toBase58(), t.local).matches).toEqual([]);
    } finally {
      t.restore();
    }
  });
  it("hostile 1-of-2 approval threshold is refused", async () => {
    const t = await setup();
    try {
      const d = await t.make((s) => ({ ...s, approvalThreshold: 1 }));
      expect(matchRequests([d], t.sam.publicKey.toBase58(), t.local).matches).toEqual([]);
    } finally {
      t.restore();
    }
  });
  it("a conflict clears once the conflicting Draft is cancelled on-chain, and matching resumes (A6)", async () => {
    const t = await setup();
    try {
      const d1 = await t.make((s) => s, 1);
      const d2 = await t.make((s) => s, 2);
      const me = t.sam.publicKey.toBase58();
      const n = Object.keys(t.local.requests)[0];
      t.local.requests[n].conflict = [d1.address.toBase58(), d2.address.toBase58()];
      // Both still open: the conflict stands, nothing cleared or linked.
      const both = matchRequests([d1, d2], me, t.local);
      expect(both.cleared).toEqual([]);
      expect(both.matches).toEqual([]);
      // The payer cancels d2 on the deployed program.
      t.c.send(await F.cancelDraft(d2.address, t.alex.publicKey), t.alex);
      const d2now = t.c.deal(d2.address);
      expect(d2now.state).toBe("Cancelled");
      const after = matchRequests([d1, d2now], me, t.local);
      expect(after.cleared).toEqual([n]);
      expect(after.matches.map((m) => m.deal)).toEqual([d1.address.toBase58()]);
      // A Draft that vanished from the (complete) list entirely also clears it.
      expect(matchRequests([d1], me, t.local).cleared).toEqual([n]);
    } finally {
      t.restore();
    }
  });
  it("duplicates: two well-shaped Drafts for one request → conflict, none linked", async () => {
    const t = await setup();
    try {
      const d1 = await t.make((s) => s, 1);
      const d2 = await t.make((s) => s, 2);
      const r = matchRequests([d1, d2], t.sam.publicKey.toBase58(), t.local);
      expect(r.matches).toEqual([]);
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts[0].deals.sort()).toEqual([d1.address.toBase58(), d2.address.toBase58()].sort());
      // A second Draft arriving after the first was already matched also flags a conflict.
      const n = Object.keys(t.local.requests)[0];
      t.local.requests[n].matchedDeal = d1.address.toBase58();
      expect(matchRequests([d2], t.sam.publicKey.toBase58(), t.local).conflicts).toHaveLength(1);
    } finally {
      t.restore();
    }
  });
});
