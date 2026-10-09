/**
 * A draft of custom terms that can travel inside an encrypted message
 * (v0.14): the JSON-safe form of CustomTerms plus the link blob, versioned
 * and chained by hash so a counter-proposal names what it answers.
 *
 * `draftText` renders the EXACT agreement text the deal will carry: the deal
 * address is a PDA of (creator, dealId), both in the draft, so nothing changes
 * between "proposed" and "created" except the signature on chain. Private
 * details (§8) ride along in full — the message is sealed between the two
 * parties, and the other side needs them to agree — while only their hash is
 * in the blob, as always.
 */
import { PublicKey } from "@solana/web3.js";
import canonicalize from "canonicalize";
import { b58decode } from "./claims";
import { ASSETS, assetForMint } from "./config";
import { DISPUTE_CLOCK_ONLY, RULES, TIMED_RULES, customFields, customProblems, type CustomTerms } from "./customTerms";
import type { DisputePolicyName, RuleName, TimerModeName } from "./deal";
import { money } from "./format";
import { TEMPLATE_IDS, blobProblem, canonBlob, renderAgreement, sha256Hex, type LinkBlob } from "./template";

export const DRAFT_FORMAT = "latch-draft@1";

export interface DraftTerms {
  creator: string;
  dealId: string;
  parties: string[];
  payerIdx: number;
  payeeIdx: number;
  approvalThreshold: number;
  mint: string;
  tokenProgram?: string;
  decimals: number;
  parts: { label: string; amount: string }[];
  rule: RuleName;
  timerMode: TimerModeName;
  timeoutSecs: number;
  splitBps: number;
  tieBreaker?: string;
  disputePolicy: DisputePolicyName;
  disputeWindowSecs: number;
  consentTrueDeadlock: boolean;
  recoverySigners: string[];
  recoveryThreshold: number;
  recoveryDelaySecs: number;
  detectedRiskFlags: number;
  acceptedRiskFlags: number;
  priceRiskTerm: number;
}

export interface TermsDraft {
  v: typeof DRAFT_FORMAT;
  /** 1 for the first proposal in a thread; a counter is the previous version + 1. */
  version: number;
  /** draftHash of the version this one answers. */
  basedOn?: string;
  blob: LinkBlob;
  terms: DraftTerms;
  /** The salted private-details text whose hash is `blob.a`, when there is one. */
  attachment?: string;
}

const TIMER_MODES: TimerModeName[] = ["FromActivation", "FromDeadlock"];
const POLICIES: DisputePolicyName[] = ["NeverExpire", "ResumeRule", "Split", "RefundPayer"];

export function fromCustomTerms(t: CustomTerms, blob: LinkBlob, version: number, basedOn?: string, attachment?: string): TermsDraft {
  const terms: DraftTerms = {
    creator: t.creator.toBase58(),
    dealId: t.dealId.toString(),
    parties: t.parties.map((p) => p.toBase58()),
    payerIdx: t.payerIdx,
    payeeIdx: t.payeeIdx,
    approvalThreshold: t.approvalThreshold,
    mint: t.mint.toBase58(),
    ...(t.tokenProgram ? { tokenProgram: t.tokenProgram.toBase58() } : {}),
    decimals: t.decimals,
    parts: t.parts.map((p) => ({ label: p.label, amount: p.amount.toString() })),
    rule: t.rule,
    timerMode: t.timerMode,
    timeoutSecs: t.timeoutSecs,
    splitBps: t.splitBps,
    ...(t.tieBreaker ? { tieBreaker: t.tieBreaker.toBase58() } : {}),
    disputePolicy: t.disputePolicy,
    disputeWindowSecs: t.disputeWindowSecs,
    consentTrueDeadlock: t.consentTrueDeadlock,
    recoverySigners: t.recoverySigners.map((p) => p.toBase58()),
    recoveryThreshold: t.recoveryThreshold,
    recoveryDelaySecs: t.recoveryDelaySecs,
    detectedRiskFlags: t.detectedRiskFlags,
    acceptedRiskFlags: t.acceptedRiskFlags,
    priceRiskTerm: t.priceRiskTerm,
  };
  return { v: DRAFT_FORMAT, version, ...(basedOn ? { basedOn } : {}), blob: canonBlob(blob), terms, ...(attachment ? { attachment } : {}) };
}

/** Throws on a malformed address or number (draftProblem reports the same in words). */
export function toCustomTerms(d: TermsDraft): CustomTerms {
  const t = d.terms;
  const pk = (s: string) => new PublicKey(s);
  return {
    creator: pk(t.creator),
    dealId: BigInt(t.dealId),
    parties: t.parties.map(pk),
    payerIdx: t.payerIdx,
    payeeIdx: t.payeeIdx,
    approvalThreshold: t.approvalThreshold,
    mint: pk(t.mint),
    tokenProgram: t.tokenProgram ? pk(t.tokenProgram) : undefined,
    decimals: t.decimals,
    parts: t.parts.map((p) => ({ label: p.label, amount: BigInt(p.amount) })),
    rule: t.rule,
    timerMode: t.timerMode,
    timeoutSecs: t.timeoutSecs,
    splitBps: t.splitBps,
    tieBreaker: t.tieBreaker ? pk(t.tieBreaker) : null,
    disputePolicy: t.disputePolicy,
    disputeWindowSecs: t.disputeWindowSecs,
    consentTrueDeadlock: t.consentTrueDeadlock,
    recoverySigners: t.recoverySigners.map(pk),
    recoveryThreshold: t.recoveryThreshold,
    recoveryDelaySecs: t.recoveryDelaySecs,
    detectedRiskFlags: t.detectedRiskFlags,
    acceptedRiskFlags: t.acceptedRiskFlags,
    priceRiskTerm: t.priceRiskTerm,
  };
}

const isKey = (s: unknown) => {
  try {
    return typeof s === "string" && b58decode(s).length === 32;
  } catch {
    return false;
  }
};
const isInt = (x: unknown, min = 0) => Number.isSafeInteger(x) && (x as number) >= min;
const isAmount = (s: unknown) => typeof s === "string" && /^[1-9][0-9]{0,19}$/.test(s);

/** Strict shape check of an untrusted draft, then the program's own rules. Null = usable. */
export function draftProblem(v: any): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "not a draft";
  if (v.v !== DRAFT_FORMAT) return "unknown draft format";
  if (!isInt(v.version, 1)) return "bad version";
  if (v.basedOn !== undefined && !/^[0-9a-f]{64}$/.test(String(v.basedOn))) return "bad basedOn";
  const extra = Object.keys(v).filter((k) => !["v", "version", "basedOn", "blob", "terms", "attachment"].includes(k));
  if (extra.length) return `unknown field ${extra[0]}`;
  if (!v.blob || !TEMPLATE_IDS.includes(v.blob.t)) return "unknown template";
  const bp = blobProblem(v.blob);
  if (bp) return `agreement details: ${bp}`;
  if (v.attachment !== undefined) {
    if (typeof v.attachment !== "string" || v.attachment.length > 6000) return "private details too long";
    if (v.blob.a !== sha256Hex(v.attachment)) return "private details don't match their hash";
  } else if (v.blob.a) return "private details missing";
  const t = v.terms;
  if (!t || typeof t !== "object") return "no terms";
  const keys = Object.keys(t);
  const allowed = ["creator", "dealId", "parties", "payerIdx", "payeeIdx", "approvalThreshold", "mint", "tokenProgram", "decimals", "parts", "rule", "timerMode", "timeoutSecs", "splitBps", "tieBreaker", "disputePolicy", "disputeWindowSecs", "consentTrueDeadlock", "recoverySigners", "recoveryThreshold", "recoveryDelaySecs", "detectedRiskFlags", "acceptedRiskFlags", "priceRiskTerm"];
  const unknown = keys.find((k) => !allowed.includes(k));
  if (unknown) return `unknown term ${unknown}`;
  if (!isKey(t.creator) || !isKey(t.mint)) return "bad address";
  if (t.tokenProgram !== undefined && !isKey(t.tokenProgram)) return "bad token program";
  if (t.tieBreaker !== undefined && !isKey(t.tieBreaker)) return "bad decider";
  if (!Array.isArray(t.parties) || t.parties.length > 8 || !t.parties.every(isKey)) return "bad parties";
  if (!Array.isArray(t.recoverySigners) || t.recoverySigners.length > 3 || !t.recoverySigners.every(isKey)) return "bad recovery signers";
  if (!/^[0-9]{1,20}$/.test(String(t.dealId))) return "bad deal id";
  if (!Array.isArray(t.parts) || t.parts.length > 16 || !t.parts.every((p: any) => p && typeof p.label === "string" && p.label.length <= 40 && isAmount(p.amount))) return "bad parts";
  for (const k of ["payerIdx", "payeeIdx", "approvalThreshold", "decimals", "timeoutSecs", "splitBps", "disputeWindowSecs", "recoveryThreshold", "recoveryDelaySecs", "detectedRiskFlags", "acceptedRiskFlags", "priceRiskTerm"])
    if (!isInt(t[k])) return `bad ${k}`;
  if (t.decimals > 18) return "bad decimals";
  if (!RULES.includes(t.rule) || !TIMER_MODES.includes(t.timerMode) || !POLICIES.includes(t.disputePolicy)) return "unknown rule";
  if (typeof t.consentTrueDeadlock !== "boolean") return "bad consent";
  let ct: CustomTerms;
  try {
    ct = toCustomTerms(v as TermsDraft);
  } catch {
    return "bad address";
  }
  const p = customProblems(ct);
  return p.length ? p[0].text : null;
}

/** JCS hash of the whole draft: what proposals and acceptances sign. */
export function draftHash(d: TermsDraft): string {
  return sha256Hex(canonicalize(d) as string);
}

/** The exact text the deal will carry. */
export function draftText(d: TermsDraft): string {
  return renderAgreement(customFields(toCustomTerms(d)), d.blob);
}

/** One line for a card: amount, parts, rule, window. */
export function draftSummary(d: TermsDraft): string {
  const t = toCustomTerms(d);
  const asset = assetForMint(t.mint) ?? (t.mint.equals(ASSETS.USDC.mint) ? ASSETS.USDC : null);
  const total = t.parts.reduce((a, p) => a + p.amount, 0n);
  const rule = { TimeoutRelease: "Timeout release", TimeoutRefund: "Timeout refund", AutoSplit: "Timed split", LongSunset: "Long sunset", TieBreaker: "Named decider", TrueDeadlock: "No decider, no timer" }[t.rule];
  const days = Math.round(t.timeoutSecs / 86400);
  return `${money(total, asset, t.decimals)} in ${t.parts.length} part${t.parts.length === 1 ? "" : "s"} · ${rule}${TIMED_RULES.includes(t.rule) ? ` · ${days} day${days === 1 ? "" : "s"}` : ""}${DISPUTE_CLOCK_ONLY.includes(t.rule) ? "" : ""}`;
}

/** The other party of a two-party draft (null for other counts). */
export function counterpartyOf(d: TermsDraft, me: string): string | null {
  if (d.terms.parties.length !== 2) return null;
  const other = d.terms.parties.find((p) => p !== me);
  return other && d.terms.parties.includes(me) ? other : null;
}

/** Private details as typed, from the salted attachment text (the salt line is dropped; saving again re-salts). */
export function detailsFromAttachment(text: string): string {
  return text.replace(/\n\nSalt: [0-9a-f]{32}\n$/, "");
}
