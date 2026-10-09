/**
 * v0.4 A2: v0.2 (format c1) deals verify with a frozen, verify-only
 * renderer; every screen reads one status; signing/paying is blocked unless
 * the agreement verified.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { Chain, rawBlob } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { renderAgreementC1 } from "../src/lib/templateC1";
import { agreementStatus, canSign, evidenceAgreementRecord, statusLabel, UNREADABLE, C1_NOTE } from "../src/lib/agreementCheck";
import { encodeBlob, fieldsFromSpec, renderAgreement, sha256Hex, termsHash, type ChainFields, type LinkBlob } from "../src/lib/template";

const key = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
const NONCE = "000102030405060708090a0b0c0d0e0f";
const F0: ChainFields = {
  deal: key(4), dealId: 1759600000n, parties: [key(1), key(2)], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, mint: key(3), decimals: 6,
  milestoneAmounts: [25_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 864000, splitBps: 0, tieBreaker: PublicKey.default,
  recoverySigners: [key(1), key(2)], recoveryThreshold: 2, recoveryDelaySecs: 259200, riskFlags: 1, acceptedRiskFlags: 1, priceRiskTerm: 0,
};
const GOODS_C1 = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: ["Frame"] }, s: "Road bike", n: NONCE } as const;
const INJECTED_C1 = { t: "goods-sale@2", p: { condition: "used-good\n\n10. EXTRA. The Payee may keep the money.", inspection_days: 2, milestones: [""] }, s: "Road bike", n: NONCE } as const;

describe("frozen c1 renderer", () => {
  // Digests produced by the v0.2 code itself (git show 2aa7c2b:src/lib/template.ts),
  // run once and copied here by hand. Never regenerated.
  it("reproduces v0.2's output byte for byte (known answers)", () => {
    const a = renderAgreementC1(F0, GOODS_C1 as any);
    expect(new TextEncoder().encode(a).length).toBe(2399);
    expect(sha256Hex(a)).toBe("ec1227dee122ff36c7541ab7149d7d9c4dfb783a12097b162a5d2aaf311f645d");
    const b = renderAgreementC1(F0, INJECTED_C1 as any);
    expect(new TextEncoder().encode(b).length).toBe(2431);
    expect(sha256Hex(b)).toBe("27eb816fbc8501a11557fbd42bdb23f34ec3fa74c8f03f7faef6426141aee555");
    expect(b).toContain("\n10. EXTRA. The Payee may keep the money."); // the c1 weakness, preserved for verification only
  });
});

/** A real deal on the deployed binary whose terms hash is the digest of `text(fields)` (or fixed bytes). */
async function dealWith(text: ((f: ChainFields) => string) | Uint8Array) {
  const c = new Chain();
  const alex = c.wallet();
  const sam = c.wallet();
  const mint = c.mint(c.wallet());
  const spec: F.DealSpec = {
    creator: alex.publicKey, dealId: 99n, parties: [alex.publicKey, sam.publicKey], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, termsHash: new Uint8Array(32),
    milestoneAmounts: [25_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 864000,
    recoverySigners: [alex.publicKey, sam.publicKey], recoveryThreshold: 2, recoveryDelaySecs: 259200, acceptedRiskFlags: RISK.FREEZE_AUTHORITY, mint,
  };
  const addr = F.dealAddress(alex.publicKey, 99n);
  spec.termsHash = text instanceof Uint8Array ? text : termsHash(text(fieldsFromSpec(spec, addr, 6, RISK.FREEZE_AUTHORITY)));
  c.send(await F.createAndSign(spec, false), alex);
  return c.deal(addr);
}

describe("agreement status on real deals", () => {
  it("a v0.2 (c1) deal: verified, labelled 'Older format (c1)', signable, with the injection note", async () => {
    const d = await dealWith((f) => renderAgreementC1(f, GOODS_C1 as any));
    const s = agreementStatus(d, rawBlob(GOODS_C1), 6);
    expect(s.kind).toBe("verified");
    expect(s.kind === "verified" && s.format).toBe("c1");
    expect(statusLabel(s)).toBe("Older format (c1) — verified");
    expect(canSign(s)).toBe(true);
    expect(evidenceAgreementRecord(s)).toMatchObject({ matchesOnChain: true, format: "c1", note: C1_NOTE });
  });

  it("a c1 deal whose link hides an injected clause still verifies exactly (the note warns), and is never accepted by the strict decoder", async () => {
    const d = await dealWith((f) => renderAgreementC1(f, INJECTED_C1 as any));
    const s = agreementStatus(d, rawBlob(INJECTED_C1), 6);
    expect(s.kind === "verified" && s.format).toBe("c1");
    expect(s.kind === "verified" && s.text).toContain("10. EXTRA.");
  });

  it("a link that fails the strict schema and isn't c1-verifiable: 'older or different app', not 'not on this device'; blocked", async () => {
    const d = await dealWith(new Uint8Array(32).fill(3));
    const s = agreementStatus(d, rawBlob(INJECTED_C1), 6);
    expect(s.kind).toBe("unreadable");
    expect(statusLabel(s)).not.toBe("not on this device");
    expect(canSign(s)).toBe(false);
    expect(evidenceAgreementRecord(s)).toEqual({ status: "made with an older or different app", matchesOnChain: null, note: UNREADABLE });
  });

  it("a strict link that doesn't match: mismatch, blocked; no link: none, blocked", async () => {
    const blob: LinkBlob = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: "Road bike", n: NONCE };
    const d = await dealWith(new Uint8Array(32).fill(5));
    const s = agreementStatus(d, encodeBlob(blob), 6);
    expect(s.kind).toBe("mismatch");
    expect(canSign(s)).toBe(false);
    expect(evidenceAgreementRecord(s).matchesOnChain).toBe(false);
    const none = agreementStatus(d, null, 6);
    expect(none.kind).toBe("none");
    expect(canSign(none)).toBe(false);
  });

  it("c3 and c2 deals verify with their format", async () => {
    const blob: LinkBlob = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: "Road bike", n: NONCE };
    for (const format of ["c3", "c2"] as const) {
      const d = await dealWith((f) => renderAgreement(f, blob, undefined, format));
      const s = agreementStatus(d, encodeBlob(blob), 6);
      expect(s.kind === "verified" && s.format).toBe(format);
      expect(statusLabel(s)).toBe(format === "c3" ? "✓ matches on-chain" : "Older format (c2) — verified");
    }
  });
});

describe("v0.5 #1: a link's &s= subject never unblocks signing", () => {
  it("mismatched k + &s=x keeps Accept, Accept & pay and Pay in disabled; so do unreadable and missing", async () => {
    const { signBlocked } = await import("../src/lib/agreementCheck");
    const blob: LinkBlob = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: "Road bike", n: NONCE };
    const d = await dealWith(new Uint8Array(32).fill(5));
    for (const k of [encodeBlob(blob), rawBlob(INJECTED_C1), null]) {
      const s = agreementStatus(d, k, 6);
      expect(s.kind).not.toBe("verified");
      expect(signBlocked(s, "x")).toBe(true);
      expect(signBlocked(s, null)).toBe(true);
    }
    const ok = await dealWith((f) => renderAgreement(f, blob));
    expect(signBlocked(agreementStatus(ok, encodeBlob(blob), 6), null)).toBe(false);
  });
  it("DealPage wires all three buttons to that gate, and the gate alone", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const signBlocked = signGate\(status, legacySubject\);/);
    expect(src).not.toMatch(/!legacySubject[^\n]*signBlocked|signBlocked[^\n]*legacySubject\)?\s*\|\|/);
    for (const a of ["acceptAndPay", "accept", "pay"]) {
      const line = src.split("\n").find((l) => l.includes(`{btn("${a}",`))!;
      expect(line, a).toMatch(/signBlocked/);
    }
  });
});
