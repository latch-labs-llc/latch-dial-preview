/** v0.14: a draft of custom terms that travels in a message and renders the exact text the deal will carry. */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { address } from "@solana/kit";
import { ASSETS, RISK } from "../src/lib/config";
import { customFields, customSpec, type CustomTerms } from "../src/lib/customTerms";
import * as F from "../src/lib/flows";
import { agreementStatus } from "../src/lib/agreementCheck";
import { encodeBlob, renderAgreement, sealAttachment, termsHash, type LinkBlob } from "../src/lib/template";
import { counterpartyOf, detailsFromAttachment, draftHash, draftProblem, draftSummary, draftText, fromCustomTerms, toCustomTerms } from "../src/lib/termsDraft";
import { Chain } from "./harness";

const DAY = 86400;
const alex = Keypair.generate();
const sam = Keypair.generate();
const base = (over: Partial<CustomTerms> = {}): CustomTerms => ({
  creator: alex.publicKey,
  dealId: 1_790_000_000_000n,
  parties: [alex.publicKey, sam.publicKey],
  payerIdx: 0,
  payeeIdx: 1,
  approvalThreshold: 2,
  mint: ASSETS.USDC.mint,
  decimals: 6,
  parts: [{ label: "Deposit", amount: 50_000_000n }, { label: "Balance", amount: 70_000_000n }],
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
const blob = (a?: string): LinkBlob => ({ t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: ["Deposit", "Balance"] }, s: "Used road bike", n: "ab".repeat(16), ...(a ? { a } : {}) });

describe("TermsDraft", () => {
  it("round-trips CustomTerms, hashes independently of key order, and renders the Builder's exact text", () => {
    const t = base();
    const d = fromCustomTerms(t, blob(), 1);
    expect(draftProblem(d)).toBeNull();
    const back = toCustomTerms(d);
    expect(back.creator.equals(t.creator)).toBe(true);
    expect(back.dealId).toBe(t.dealId);
    expect(back.parts).toEqual(t.parts);
    expect(back.recoverySigners.map(String)).toEqual(t.recoverySigners.map(String));
    expect(back.tieBreaker).toBeNull();
    expect(draftText(d)).toBe(renderAgreement(customFields(t), blob()));
    const shuffled = JSON.parse(JSON.stringify({ terms: d.terms, blob: d.blob, version: d.version, v: d.v }));
    expect(draftHash(shuffled)).toBe(draftHash(d));
    expect(draftHash(fromCustomTerms(t, blob(), 2, draftHash(d)))).not.toBe(draftHash(d));
    expect(draftSummary(d)).toMatch(/^\$120\.00 in 2 parts · Timeout release · 10 days$/);
    expect(counterpartyOf(d, alex.publicKey.toBase58())).toBe(sam.publicKey.toBase58());
    expect(counterpartyOf(d, Keypair.generate().publicKey.toBase58())).toBeNull();
  });

  it("carries private details in full, bound to the blob's hash", () => {
    const att = sealAttachment("Serial number 1234. Scratch on the top tube.");
    const d = fromCustomTerms(base(), blob(att.hash), 1, undefined, att.text);
    expect(draftProblem(d)).toBeNull();
    expect(detailsFromAttachment(att.text)).toBe("Serial number 1234. Scratch on the top tube.");
    expect(draftProblem({ ...d, attachment: att.text + "x" })).toMatch(/don't match/);
    expect(draftProblem({ ...d, attachment: undefined })).toMatch(/missing/);
  });

  it("refuses malformed or program-invalid drafts", () => {
    const d = fromCustomTerms(base(), blob(), 1);
    expect(draftProblem(null)).toMatch(/not a draft/);
    expect(draftProblem({ ...d, v: "latch-draft@2" })).toMatch(/format/);
    expect(draftProblem({ ...d, version: 0 })).toMatch(/version/);
    expect(draftProblem({ ...d, extra: 1 })).toMatch(/unknown field/);
    expect(draftProblem({ ...d, terms: { ...d.terms, creator: "nope" } })).toMatch(/address/);
    expect(draftProblem({ ...d, terms: { ...d.terms, parts: [{ label: "x", amount: "0" }] } })).toMatch(/bad parts/);
    expect(draftProblem({ ...d, terms: { ...d.terms, parts: [{ label: "x", amount: "-5" }] } })).toMatch(/bad parts/);
    expect(draftProblem({ ...d, terms: { ...d.terms, rule: "Magic" } })).toMatch(/rule/);
    expect(draftProblem({ ...d, terms: { ...d.terms, bonus: 1 } })).toMatch(/unknown term/);
    // The program's own rules apply too (here: creator not a party).
    expect(draftProblem({ ...d, terms: { ...d.terms, parties: [sam.publicKey.toBase58(), Keypair.generate().publicKey.toBase58()] } })).toMatch(/one of the parties/);
    expect(draftProblem({ ...d, blob: { ...d.blob, t: "nope@9" } })).toMatch(/template/);
  });

  it("a deal created from a draft verifies against the draft's blob (the text the other party regenerates)", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const a = c.wallet();
    const b = c.wallet();
    c.svm.airdrop(address(a.publicKey.toBase58()), BigInt(2e9) as any);
    const mint = c.mint(issuer);
    const t = base({ creator: a.publicKey, parties: [a.publicKey, b.publicKey], recoverySigners: [a.publicKey, b.publicKey], mint, dealId: BigInt(Date.now()) });
    const d = fromCustomTerms(t, blob(), 1);
    const text = draftText(d);
    const spec = { ...customSpec(toCustomTerms(d)), termsHash: termsHash(text) };
    c.send(await F.createAndSign(spec, false), a);
    const addr = F.dealAddress(a.publicKey, t.dealId);
    const deal = c.deal(addr);
    expect(deal.state).toBe("Draft");
    const st = agreementStatus(deal, encodeBlob(d.blob), 6);
    expect(st.kind).toBe("verified");
    if (st.kind === "verified") expect(st.text).toBe(text);
    expect(new PublicKey(d.terms.creator).equals(a.publicKey)).toBe(true);
  });
});

describe("v0.16: saved presets reuse TermsDraft", () => {
  it("a draft saved without its private details is still a valid draft, and the contacts export carries presets", async () => {
    const att = sealAttachment("Serial 1234");
    const { a: _a, ...blobNoAttachment } = blob(att.hash);
    void _a;
    const d = fromCustomTerms(base(), blobNoAttachment, 1);
    expect(draftProblem(d)).toBeNull();
    expect(d.attachment).toBeUndefined();
    const { exportLocal, importLocal, updateLocal, getLocal } = await import("../src/lib/store");
    updateLocal((x) => void (x.presets["p1"] = { name: "Bike sale", at: 1, draft: d }));
    const json = exportLocal();
    expect(JSON.parse(json).presets.p1.name).toBe("Bike sale");
    updateLocal((x) => void (x.presets = {}));
    importLocal(json);
    expect(getLocal().presets.p1.draft.blob.s).toBe("Used road bike");
  });
});
