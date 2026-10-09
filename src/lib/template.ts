/**
 * Agreement template v2 (R4 Architecture A, with the Architecture B
 * attachment path). The signed text is a pure function of:
 *   - the deal's on-chain fields (all of them that the program enforces), and
 *   - a canonical link blob {t, p, s, n, a?} carried in the share link:
 *       t  template id ("protected-payment@2" …)
 *       p  typed, non-PII template params (enums, numbers, short labels)
 *       s  subject line (≤ 90 chars, treated as PUBLIC)
 *       n  128-bit secret nonce — makes the on-chain hash a hiding commitment
 *       a  optional SHA-256 of a salted, party-held attachment (never on-chain)
 * terms_hash = SHA-256(UTF-8(text)). No PII ever goes on-chain.
 *
 * Format "c2" (TEMPLATE-V2-SPEC.md): the first line names the template and
 * format; UTF-8 with NO Unicode normalization (as SPEC.md v1); LF line
 * endings; trailing spaces trimmed. Every link field is checked against a
 * per-template schema before anything renders, and every free-text value is
 * a single line rendered as a JSON string literal, so link data can never
 * add a line, a clause or a section to the signed text.
 */
import canonicalize from "canonicalize";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, PRESETS, PROGRAM_HASH_HISTORY, PROGRAM_ID, RISK, VERIFIED_BUILD_HASH } from "./config";
import { hasDisputeLimit, type Deal, type DisputePolicyName, type RuleName, type TimerModeName } from "./deal";
import type { DealSpec } from "./flows";

/**
 * Current rendering format. c4 (v0.7): section 5 states the deal's dispute
 * policy and the Payee's right to refund (program 0c4af8ba…). c3 (v0.4) and
 * c2 (v0.3) render only to verify older texts, and only for deals without a
 * dispute time limit.
 */
export const CANON = "c5";
export type Format = "c2" | "c3" | "c4" | "c5";
/** Newest first: the order verifyAgreement tries. */
export const FORMATS: readonly Format[] = ["c5", "c4", "c3", "c2"];
/** Formats that state the dispute policy and the payee's refund right. c5 (v0.7.1) adds that the limit is cumulative and never resets. */
const STATES_POLICY = (f: Format) => f === "c4" || f === "c5";
/** Longest base64url link blob accepted (a full 16-part blob is ~1.6 KB). */
export const BLOB_MAX = 4096;
export const SUBJECT_MAX = 90;
export const TEMPLATE_IDS = ["protected-payment@2", "goods-sale@2", "freelance@2", "deposit@2", "vehicle-sale@2", "trade@2", "general@2"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface LinkBlob {
  t: TemplateId;
  p: Record<string, string | number | boolean | string[]>;
  s: string;
  n: string;
  a?: string;
}

/** The on-chain fields the text renders. Built from a spec (before creation) or a deal. */
export interface ChainFields {
  deal: PublicKey;
  dealId: bigint;
  parties: PublicKey[];
  payerIdx: number;
  payeeIdx: number;
  approvalThreshold: number;
  mint: PublicKey;
  decimals: number;
  milestoneAmounts: bigint[];
  rule: RuleName;
  timerMode: TimerModeName;
  timeoutSecs: number;
  splitBps: number;
  tieBreaker: PublicKey;
  recoverySigners: PublicKey[];
  recoveryThreshold: number;
  recoveryDelaySecs: number;
  riskFlags: number;
  acceptedRiskFlags: number;
  priceRiskTerm: number;
  /** Absent = NeverExpire / 0 (every deal before the 0928c78 upgrade). */
  disputePolicy?: DisputePolicyName;
  disputeWindowSecs?: number;
}

export function fieldsFromSpec(spec: DealSpec, deal: PublicKey, decimals: number, riskFlags: number): ChainFields {
  return {
    deal,
    dealId: spec.dealId,
    parties: spec.parties,
    payerIdx: spec.payerIdx,
    payeeIdx: spec.payeeIdx,
    approvalThreshold: spec.approvalThreshold,
    mint: spec.mint,
    decimals,
    milestoneAmounts: spec.milestoneAmounts,
    rule: spec.rule,
    timerMode: spec.timerMode,
    timeoutSecs: spec.timeoutSecs,
    splitBps: spec.splitBps ?? 0,
    tieBreaker: spec.tieBreaker ?? PublicKey.default,
    recoverySigners: spec.recoverySigners,
    recoveryThreshold: spec.recoveryThreshold,
    recoveryDelaySecs: spec.recoveryDelaySecs,
    riskFlags,
    acceptedRiskFlags: spec.acceptedRiskFlags,
    priceRiskTerm: spec.priceRiskTerm ?? 0,
    disputePolicy: spec.disputePolicy ?? "NeverExpire",
    disputeWindowSecs: spec.disputeWindowSecs ?? 0,
  };
}

export function fieldsFromDeal(d: Deal, decimals: number): ChainFields {
  return {
    deal: d.address,
    dealId: d.dealId,
    parties: d.parties,
    payerIdx: d.payerIdx,
    payeeIdx: d.payeeIdx,
    approvalThreshold: d.approvalThreshold,
    mint: d.mint,
    decimals,
    milestoneAmounts: d.milestones.map((m) => m.amount),
    rule: d.rule,
    timerMode: d.timerMode,
    timeoutSecs: d.timeoutSecs,
    splitBps: d.splitBps,
    tieBreaker: d.tieBreaker,
    recoverySigners: d.recoverySigners,
    recoveryThreshold: d.recoveryThreshold,
    recoveryDelaySecs: d.recoveryDelaySecs,
    riskFlags: d.riskFlags,
    acceptedRiskFlags: d.acceptedRiskFlags,
    priceRiskTerm: d.priceRiskTerm,
    disputePolicy: d.disputePolicy,
    disputeWindowSecs: d.disputeWindowSecs,
  };
}

// ------------------------------------------------------- canonicalization

/** Whole-text canonicalization. No Unicode normalization (SPEC.md v1 §4). */
export function canonText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

/**
 * Characters never allowed in a link string: C0/C1 controls (incl. CR, LF,
 * TAB), line/paragraph separators, and bidi embedding/override/isolate marks
 * (which can visually reorder a line).
 */
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu;
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

/** One display line: forbidden chars dropped, whitespace runs → one space, cut to `max` CODE POINTS. */
export function canonLine(s: string, max: number): string {
  const flat = s.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, max).join("").trim();
}

export function canonSubject(s: string): string {
  return canonLine(s, SUBJECT_MAX);
}

/** A link string is acceptable only if it is already canonical (a fixpoint). */
function isLine(v: unknown, max: number, allowEmpty: boolean): v is string {
  return typeof v === "string" && wellFormed(v) && canonLine(v, max) === v && (allowEmpty || v.length > 0);
}

// ---------------------------------------------------------- link schema

type Field =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min: number; max: number }
  | { kind: "true" }
  | { kind: "bool" }
  | { kind: "line"; max: number }
  | { kind: "labels" }
  /** 1+ non-empty canonical lines of up to LABEL_MAX code points (trade@2 `documents`). */
  | { kind: "lines"; min: number; max: number };

export const LABEL_MAX = 40;
export const MAX_PARTS = 16;
const LABELS: Field = { kind: "labels" };
/** Incoterms 2020 rules, by three-letter code. */
export const INCOTERMS = ["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"] as const;

/** Every key is required; no other key is allowed. */
export const TEMPLATE_SCHEMAS: Record<TemplateId, Record<string, Field>> = {
  "protected-payment@2": {
    preset: { kind: "enum", values: PRESETS.map((p) => p.id) },
    window_days: { kind: "int", min: 1, max: 365 },
  },
  "goods-sale@2": {
    condition: { kind: "enum", values: ["new", "like-new", "used-good", "used-fair", "for-parts"] },
    inspection_days: { kind: "int", min: 0, max: 30 },
    milestones: LABELS,
  },
  "freelance@2": {
    revisions: { kind: "int", min: 0, max: 10 },
    ip_transfer_on_final_payment: { kind: "bool" },
    milestones: LABELS,
  },
  "deposit@2": {
    purpose: { kind: "enum", values: ["booking", "custom-order", "event", "rental-equipment", "other"] },
    not_residential_security_deposit: { kind: "true" },
    milestones: LABELS,
  },
  "vehicle-sale@2": {
    year: { kind: "int", min: 1900, max: 2100 },
    make_model: { kind: "line", max: 40 },
    mileage_band: { kind: "enum", values: ["under-25k", "25k-50k", "50k-100k", "100k-150k", "over-150k"] },
    title_status: { kind: "enum", values: ["clean", "lien", "salvage", "rebuilt"] },
    inspection_days: { kind: "int", min: 0, max: 30 },
    milestones: LABELS,
  },
  // v0.9 #3: any agreement the other templates don't fit; the terms are the chain fields, the subject and the private details.
  "general@2": {
    milestones: LABELS,
  },
  // v0.8 #5: cross-border sale of physical goods, paid in stages against documents.
  "trade@2": {
    incoterm: { kind: "enum", values: INCOTERMS },
    origin: { kind: "line", max: 40 },
    destination: { kind: "line", max: 40 },
    documents: { kind: "lines", min: 1, max: 8 },
    inspection_days: { kind: "int", min: 0, max: 30 },
    milestones: LABELS,
  },
};

function fieldOk(f: Field, v: unknown): boolean {
  switch (f.kind) {
    case "enum":
      return typeof v === "string" && f.values.includes(v);
    case "int":
      return typeof v === "number" && Number.isInteger(v) && v >= f.min && v <= f.max;
    case "true":
      return v === true;
    case "bool":
      return typeof v === "boolean";
    case "line":
      return isLine(v, f.max, false);
    case "labels":
      return Array.isArray(v) && v.length >= 1 && v.length <= MAX_PARTS && v.every((x) => isLine(x, LABEL_MAX, true));
    case "lines":
      return Array.isArray(v) && v.length >= f.min && v.length <= f.max && v.every((x) => isLine(x, LABEL_MAX, false));
  }
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Why a link blob is not acceptable, or null if it is. Pure; used by decode, encode and render. */
export function blobProblem(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "not an object";
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["t", "p", "s", "n", "a"].includes(k)) return `unknown field ${k}`;
  if (typeof o.t !== "string" || !(TEMPLATE_IDS as readonly string[]).includes(o.t)) return "unknown template";
  if (typeof o.n !== "string" || !/^[0-9a-f]{32}$/.test(o.n)) return "bad reference";
  if (own(o, "a") && (typeof o.a !== "string" || !/^[0-9a-f]{64}$/.test(o.a))) return "bad attachment hash";
  if (!isLine(o.s, SUBJECT_MAX, false)) return "bad subject";
  const p = o.p;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "bad params";
  const schema = TEMPLATE_SCHEMAS[o.t as TemplateId];
  const keys = Object.keys(p);
  for (const k of keys) if (!own(schema, k)) return `unknown param ${k}`;
  for (const k of Object.keys(schema)) {
    if (!own(p, k)) return `missing param ${k}`;
    if (!fieldOk(schema[k], (p as Record<string, unknown>)[k])) return `bad param ${k}`;
  }
  if (o.t === "protected-payment@2") {
    const q = p as { preset: string; window_days: number };
    if (PRESETS.find((x) => x.id === q.preset)?.days !== q.window_days) return "window doesn't match preset";
  }
  return null;
}

/** Canonicalize free-text fields the way the encoder does (subject, labels, line params). */
export function canonBlob(blob: LinkBlob): LinkBlob {
  const schema = TEMPLATE_SCHEMAS[blob.t];
  if (!blob.p || typeof blob.p !== "object") return blob;
  const p: LinkBlob["p"] = {};
  for (const [k, v] of Object.entries(blob.p)) {
    const f = schema?.[k];
    p[k] =
      f?.kind === "line" && typeof v === "string"
        ? canonLine(v, f.max)
        : f?.kind === "labels" && Array.isArray(v)
          ? v.map((x) => (typeof x === "string" ? canonLine(x, LABEL_MAX) : x))
          : v;
  }
  return { ...blob, s: typeof blob.s === "string" ? canonSubject(blob.s) : blob.s, p };
}

export function newNonce(): string {
  return bytesToHex(randomBytes(16));
}

const b64url = {
  enc(bytes: Uint8Array): string {
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  },
};

/** Canonicalize, validate (throws on a schema violation), then base64url(JCS(blob)). */
export function encodeBlob(blob: LinkBlob): string {
  const c = canonBlob(blob);
  const problem = blobProblem(c);
  if (problem) throw new Error(`Agreement details aren't valid: ${problem}`);
  return b64url.enc(new TextEncoder().encode(canonicalize(c) as string));
}

/** Strict decode: null unless the blob satisfies its template's schema exactly. */
export function decodeBlob(s: string): LinkBlob | null {
  try {
    if (typeof s !== "string" || s.length > BLOB_MAX || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64url.dec(s)));
    return blobProblem(v) ? null : (v as LinkBlob);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ rendering

export function uiAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function duration(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400} day(s) (${secs} seconds)`;
  if (secs % 3600 === 0) return `${secs / 3600} hour(s) (${secs} seconds)`;
  return `${secs} seconds`;
}

export const RISK_NAMES: [number, string][] = [
  [RISK.FREEZE_AUTHORITY, "the token issuer can freeze the vault"],
  [RISK.PERMANENT_DELEGATE, "the token issuer can take tokens from the vault"],
  [RISK.DORMANT_TRANSFER_HOOK, "the token has a dormant transfer hook"],
  [RISK.TRANSFER_FEE, "the token charges a transfer fee"],
  [RISK.CONFIDENTIAL_CAPABLE, "the token supports confidential transfers"],
  [RISK.INTEREST_BEARING, "the token is interest-bearing"],
  [RISK.MINT_CLOSE_AUTHORITY, "the token's mint can be closed"],
];
export function riskList(flags: number): string {
  const xs = RISK_NAMES.filter(([b]) => flags & b).map(([, n]) => n);
  return xs.length ? xs.join("; ") : "none";
}

export function ruleClause(f: ChainFields, payeeLabel: string, payerLabel: string, format: Format = "c3"): string {
  const t = duration(f.timeoutSecs);
  const pause =
    f.timerMode === "FromActivation"
      ? STATES_POLICY(format)
        ? `The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, the ${payeeLabel} returns it to the ${payerLabel}${(f.disputePolicy ?? "NeverExpire") === "NeverExpire" ? ", or the recovery signers act." : ", the recovery signers act, or the dispute time limit below is reached."}`
        : `The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, or the recovery signers act.`
      : `The clock starts only when a party reports a problem.`;
  switch (f.rule) {
    case "TimeoutRelease":
      return `Rule: TIMEOUT RELEASE. If no release has happened ${t} after the clock starts, anyone may send the remaining money to the ${payeeLabel}. ${pause}`;
    case "TimeoutRefund":
      return `Rule: TIMEOUT REFUND. If no release has happened ${t} after the clock starts, anyone may return the remaining money to the ${payerLabel}. ${pause}`;
    case "AutoSplit":
      return `Rule: AUTOMATIC SPLIT. ${t} after the clock starts, anyone may split the remaining money: ${(f.splitBps / 100).toFixed(2)}% to the ${payeeLabel}, the rest to the ${payerLabel}. ${pause}`;
    case "LongSunset":
      return `Rule: LONG SUNSET. The money stays locked until the parties agree; if they never do, anyone may return it to the ${payerLabel} ${t} after the clock starts. ${pause}`;
    case "TieBreaker":
      return `Rule: NAMED DECIDER. ${f.tieBreaker.toBase58()} (not a party) is named by all parties. Once any party reports a problem, this decider ALONE may set how the remaining money is divided between the ${payeeLabel} and the ${payerLabel}, and anyone may then carry out that division. Only a split signed by every party takes priority over the decider's ruling. There is NO automatic unlock by time under this rule.`;
    case "TrueDeadlock":
      return `Rule: NO DECIDER, NO TIMER. If a problem is reported, the remaining money stays locked until every party signs the same split or the recovery signers act. It never unlocks by time. Each party must give separate, explicit consent to this rule when signing.`;
  }
}

/**
 * c4: the dispute policy (set in the creating transaction, never after) and
 * the Payee's refund right (refund_by_payee). Chain-derived only.
 */
export function disputeClause(f: ChainFields, payeeLabel: string, payerLabel: string, format: Format = "c4"): string {
  const refund = `While money is held, the ${payeeLabel} may at any time, alone, return all of it to the ${payerLabel}; this cannot be undone.`;
  const policy = f.disputePolicy ?? "NeverExpire";
  const w = f.disputeWindowSecs ?? 0;
  if (f.timerMode !== "FromActivation") return refund;
  // c5: the limit is cumulative and never resets, so once it is used up any
  // later pause ends (or settles) at once. Stated before anyone signs.
  const usedUp = (later: string) => (format === "c5" ? ` The limit counts all pauses together and never resets: once it has been reached, ${later}` : "");
  const limit = (outcome: string, later: string) =>
    `Dispute time limit: ${duration(w)} in total across all pauses. Once the clock has been paused that long, ${outcome}${usedUp(later)}`;
  const pct = ((f.rule === "AutoSplit" ? f.splitBps : 5000) / 100).toFixed(2);
  switch (policy) {
    case "NeverExpire":
      return `${refund} Dispute time limit: none. A pause holds the money for as long as it lasts.`;
    case "ResumeRule":
      return `${refund} ${limit("anyone may end the pause, and the clock resumes under the rule above.", "anyone may end any later pause at once.")}`;
    case "Split":
      return `${refund} ${limit(`anyone may divide the remaining money: ${pct}% to the ${payeeLabel}, the rest to the ${payerLabel}.`, "any later pause lets anyone divide the remaining money that way at once.")}`;
    case "RefundPayer":
      return `${refund} ${limit(`anyone may return the remaining money to the ${payerLabel}.`, `any later pause lets anyone return the remaining money to the ${payerLabel} at once.`)}`;
  }
}

/** Template-specific clauses (part of the signed text). */
const TEMPLATE_NOTES: Record<TemplateId, string> = {
  "protected-payment@2": "",
  "goods-sale@2": "   The item details above describe what the Payee is selling; the Payer approves release once the item is received as described.",
  "freelance@2": "   Each part is released when both parties approve the work for that part. Revisions and rights follow the details above.",
  "deposit@2": "   This is a booking or order deposit. It is NOT a residential security deposit and must not be used as one.",
  "vehicle-sale@2": "   This agreement covers payment only. It does not transfer the vehicle's title; title and registration transfer happen separately under the law of the place of sale.",
  "general@2": "   The parties' obligations are those stated in the subject and in any attachment whose digest appears below; the money moves only as sections 4 to 6 provide.",
  "trade@2":
    "   Cross-border sale of goods. Delivery terms are the Incoterms 2020 rule named above, from the origin to the destination stated. The parts above are the trade's stages, released in order when both parties approve each one; the Payee presents the documents listed above before asking for the stage they belong to, and the Payer has the inspection period above, counted from arrival, to check the goods before approving the final part. A document is presented by recording its SHA-256 on-chain in a memo signed by the presenting party; the documents themselves stay with the parties. If a decider is named on-chain, that decider acts as the examiner of documents. This agreement covers payment only; title to the goods, customs and carriage follow the documents and the law of the places of shipment and delivery.",
};

/** Render the agreement text for a template + chain fields + link blob. */
export function renderAgreement(f: ChainFields, input: LinkBlob, programHash: string = VERIFIED_BUILD_HASH, format: Format = CANON): string {
  if (!/^[0-9a-f]{64}$/.test(programHash)) throw new Error("bad program hash");
  // c2/c3 have no words for a dispute time limit: a text in those formats can
  // never vouch for a deal that has one (v0.7 #2).
  if (!STATES_POLICY(format) && hasDisputeLimit(f)) throw new Error("This agreement format can't state a dispute time limit");
  // Identity for a decoded (already canonical) blob; for a blob being built,
  // this is exactly what encodeBlob will carry.
  const blob = canonBlob(input);
  const problem = blobProblem(blob);
  if (problem) throw new Error(`Agreement details aren't valid: ${problem}`);
  const labels = TEMPLATE_SCHEMAS[blob.t].milestones ? (blob.p.milestones as string[]) : [];
  if (labels.length && labels.length !== f.milestoneAmounts.length) throw new Error("Agreement details aren't valid: part labels don't match the parts");
  // Chain-derived only: never an app display label, so future app versions
  // regenerate byte-identical text.
  const unit = "token units";
  const total = f.milestoneAmounts.reduce((a, b) => a + b, 0n);
  const payerLabel = "Payer";
  const payeeLabel = "Payee";

  const partyLines = f.parties
    .map((p, i) => {
      const role = i === f.payerIdx ? "Payer" : i === f.payeeIdx ? "Payee" : "Party";
      return `   ${i + 1}. ${role}: ${p.toBase58()}`;
    })
    .join("\n");

  const msLines = f.milestoneAmounts
    .map((m, i) => `   ${i + 1}. ${uiAmount(m, f.decimals)} ${unit}${labels[i] ? ` — ${JSON.stringify(labels[i])}` : ""}`)
    .join("\n");

  const paramLines = Object.keys(blob.p)
    .filter((k) => k !== "milestones")
    .sort()
    .map((k) => `   ${k}: ${JSON.stringify(blob.p[k])}`)
    .join("\n");

  const text = `LATCH PROTECTED PAYMENT AGREEMENT · template ${blob.t} · format ${format}
Status: Solana ${CLUSTER} demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. ${JSON.stringify(blob.s)}

2. PARTIES (by wallet address).
${partyLines}

3. AMOUNT AND HOLDING. The Payer pays ${uiAmount(total, f.decimals)} ${unit} (mint ${f.mint.toBase58()}, ${f.decimals} decimals) into the vault of deal ${f.deal.toBase58()} (deal id ${f.dealId.toString()}) under the Latch program ${PROGRAM_ID.toBase58()} on Solana ${CLUSTER}. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana ${CLUSTER}: whoever holds its upgrade authority can replace its code, and new code could change these rules. ${
    format === "c2"
      ? `When this text was prepared, the program's deployed code had SHA-256 ${programHash} (its program-data bytes, trailing zero padding removed).`
      : `The app that prepared this text verified the deployed program's code as SHA-256 ${programHash} (its program-data bytes, trailing zero padding removed).`
  }

4. RELEASES. The money is released in this order, each part when ${f.approvalThreshold} of ${f.parties.length} parties approve it:
${msLines}

5. IF THERE IS A PROBLEM. ${ruleClause(f, payeeLabel, payerLabel, format)} The parties may always settle by every party signing the same division.${STATES_POLICY(format) ? ` ${disputeClause(f, payeeLabel, payerLabel, format)}` : ""}

6. RECOVERY SIGNERS (${f.recoveryThreshold} of ${f.recoverySigners.length}):
${f.recoverySigners.map((r) => `   ${r.toBase58()}`).join("\n")}
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of ${duration(f.recoveryDelaySecs)}.

7. TOKEN RISKS. Detected on this token: ${riskList(f.riskFlags)}. Accepted by the parties: ${riskList(f.acceptedRiskFlags)}. Price-risk term code: ${f.priceRiskTerm}.

8. TEMPLATE DETAILS.
${paramLines || "   none"}${TEMPLATE_NOTES[blob.t] ? `\n${TEMPLATE_NOTES[blob.t]}` : ""}
   Attachment: ${blob.a ? `SHA-256 ${blob.a} (held by the parties, never on-chain)` : "none"}
   Reference: ${blob.n}

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
`;
  return canonText(text) + "\n";
}

export function sha256Hex(text: string): string {
  return bytesToHex(nobleSha256(new TextEncoder().encode(text)));
}
export function termsHash(text: string): Uint8Array {
  return nobleSha256(new TextEncoder().encode(text));
}

/** Attachment (Arch B): free text + a salt line; its hash rides in the link blob. */
export function sealAttachment(details: string): { text: string; hash: string } {
  const text = `${canonText(details)}\n\nSalt: ${bytesToHex(randomBytes(16))}\n`;
  return { text, hash: sha256Hex(text) };
}

/**
 * Does a link blob regenerate exactly the on-chain terms hash? Tries the
 * current format, then older ones, and each program hash the app has ever
 * pinned (newest first); `format` and `programHash` say which matched.
 */
export function verifyAgreement(
  f: ChainFields,
  blob: LinkBlob,
  onchain: Uint8Array,
  history: readonly string[] = PROGRAM_HASH_HISTORY,
): { ok: boolean; text: string; hex: string; programHash?: string; format?: Format } {
  const want = bytesToHex(onchain);
  let first: { text: string; hex: string } | null = null;
  for (const format of FORMATS) {
    for (const programHash of history) {
      let text: string;
      try {
        text = renderAgreement(f, blob, programHash, format);
      } catch {
        return { ok: false, text: "", hex: "" };
      }
      const hex = sha256Hex(text);
      if (hex === want) return { ok: true, text, hex, programHash, format };
      first ??= { text, hex };
    }
  }
  return { ok: false, ...(first ?? { text: "", hex: "" }) };
}
