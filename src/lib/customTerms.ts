/**
 * Custom agreements: every parameter the Latch program accepts, validated
 * with the program's own rules before anything is signed, and mapped to the
 * clause of the agreement text it writes (v0.9).
 *
 * `customProblems` mirrors `create_deal`'s checks one for one (latch
 * programs/latch/src/instructions/create_deal.rs) so the Builder can say
 * exactly why a step is not ready, in the section where the fix belongs.
 * `custom.test.ts` sends each violation to the deployed binary and expects
 * the matching program error, so the two can't drift silently.
 */
import { PublicKey } from "@solana/web3.js";
import type { DisputePolicyName, RuleName, TimerModeName } from "./deal";
import { dealAddress, type DealSpec } from "./flows";
import { disputeClause, fieldsFromSpec, riskList, ruleClause, type ChainFields } from "./template";

/** Program limits (constants.rs). */
export const LIMITS = {
  MAX_PARTIES: 8,
  MAX_MILESTONES: 16,
  MAX_RECOVERY_SIGNERS: 3,
  /** 10 years. */
  MAX_TIMEOUT_SECS: 315_360_000,
  MIN_DISPUTE_WINDOW_SECS: 86_400,
  MAX_DISPUTE_WINDOW_SECS: 31_536_000,
  BPS: 10_000,
  U64: (1n << 64n) - 1n,
} as const;

export const RULES: RuleName[] = ["TimeoutRelease", "TimeoutRefund", "AutoSplit", "LongSunset", "TieBreaker", "TrueDeadlock"];
/** Rules whose clock may only start at a dispute (program: InvalidTimerMode otherwise). */
export const DISPUTE_CLOCK_ONLY: RuleName[] = ["TieBreaker", "TrueDeadlock"];
/** Rules that need a window (program: InvalidDeadlockParams otherwise). */
export const TIMED_RULES: RuleName[] = ["TimeoutRelease", "TimeoutRefund", "AutoSplit", "LongSunset"];

export interface CustomPart {
  label: string;
  amount: bigint;
}

export interface CustomTerms {
  creator: PublicKey;
  dealId: bigint;
  /** §2 */
  parties: PublicKey[];
  payerIdx: number;
  payeeIdx: number;
  approvalThreshold: number;
  /** §3–§4 */
  mint: PublicKey;
  tokenProgram?: PublicKey;
  decimals: number;
  parts: CustomPart[];
  /** §5 */
  rule: RuleName;
  timerMode: TimerModeName;
  timeoutSecs: number;
  splitBps: number;
  tieBreaker?: PublicKey | null;
  disputePolicy: DisputePolicyName;
  disputeWindowSecs: number;
  consentTrueDeadlock: boolean;
  /** §6 */
  recoverySigners: PublicKey[];
  recoveryThreshold: number;
  recoveryDelaySecs: number;
  /** §7 */
  detectedRiskFlags: number;
  acceptedRiskFlags: number;
  priceRiskTerm: number;
}

/** Agreement section the control lives in (template §1–§8; 9 is the signature clause). */
export type Section = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface Problem {
  section: Section;
  /** The program error this would produce, or a client-only gate. */
  code:
    | "InvalidParties"
    | "DuplicateParty"
    | "CreatorNotParty"
    | "InvalidThreshold"
    | "InvalidMilestones"
    | "MilestoneSumMismatch"
    | "Overflow"
    | "InvalidDeadlockParams"
    | "InvalidTimerMode"
    | "InvalidRecoveryConfig"
    | "RiskFlagsNotAccepted"
    | "InvalidDisputeWindow"
    | "DisputePolicyNeedsStartClock"
    | "ConsentRequired"
    | "InvalidPriceRiskTerm";
  text: string;
}

const same = (a: PublicKey, b: PublicKey | null | undefined) => !!b && a.equals(b);
const distinct = (keys: PublicKey[]) => keys.every((k, i) => keys.findIndex((x) => x.equals(k)) === i);

export function customProblems(t: CustomTerms): Problem[] {
  const p: Problem[] = [];
  const n = t.parties.length;
  // §2 parties and approvals
  if (n < 2 || n > LIMITS.MAX_PARTIES) p.push({ section: 2, code: "InvalidParties", text: `Between 2 and ${LIMITS.MAX_PARTIES} parties.` });
  if (!distinct(t.parties)) p.push({ section: 2, code: "DuplicateParty", text: "Each party once." });
  if (!t.parties.some((x) => x.equals(t.creator))) p.push({ section: 2, code: "CreatorNotParty", text: "You must be one of the parties." });
  if (!(t.payerIdx >= 0 && t.payerIdx < n && t.payeeIdx >= 0 && t.payeeIdx < n && t.payerIdx !== t.payeeIdx))
    p.push({ section: 2, code: "InvalidParties", text: "Pick a payer and a different recipient." });
  if (!(Number.isInteger(t.approvalThreshold) && t.approvalThreshold >= 1 && t.approvalThreshold <= n))
    p.push({ section: 2, code: "InvalidThreshold", text: `Approvals needed per part: 1 to ${n}.` });
  // §3–§4 money and parts
  const m = t.parts.length;
  if (m < 1 || m > LIMITS.MAX_MILESTONES) p.push({ section: 4, code: "InvalidMilestones", text: `Between 1 and ${LIMITS.MAX_MILESTONES} parts.` });
  if (t.parts.some((x) => x.amount <= 0n)) p.push({ section: 4, code: "InvalidMilestones", text: "Every part needs an amount above zero." });
  const total = t.parts.reduce((a, b) => a + (b.amount > 0n ? b.amount : 0n), 0n);
  if (total > LIMITS.U64) p.push({ section: 4, code: "Overflow", text: "The total is larger than the token can represent." });
  // §5 if there is a problem
  if (TIMED_RULES.includes(t.rule) && !(Number.isInteger(t.timeoutSecs) && t.timeoutSecs > 0 && t.timeoutSecs <= LIMITS.MAX_TIMEOUT_SECS))
    p.push({ section: 5, code: "InvalidDeadlockParams", text: "The window must be between 1 second and 10 years." });
  if (t.rule === "TieBreaker") {
    if (!t.tieBreaker || t.tieBreaker.equals(PublicKey.default)) p.push({ section: 5, code: "InvalidDeadlockParams", text: "Name the decider's wallet." });
    else if (t.parties.some((x) => same(x, t.tieBreaker))) p.push({ section: 5, code: "InvalidDeadlockParams", text: "The decider can't be one of the parties." });
  }
  if (DISPUTE_CLOCK_ONLY.includes(t.rule) && t.timerMode !== "FromDeadlock")
    p.push({ section: 5, code: "InvalidTimerMode", text: "With a decider, or with no decider and no timer, the clock can only start at a dispute." });
  if (t.rule === "AutoSplit" && !(Number.isInteger(t.splitBps) && t.splitBps >= 0 && t.splitBps <= LIMITS.BPS))
    p.push({ section: 5, code: "InvalidDeadlockParams", text: "The split must be between 0% and 100%." });
  if (t.rule === "TrueDeadlock" && !t.consentTrueDeadlock) p.push({ section: 5, code: "ConsentRequired", text: "This rule needs your separate consent when you sign." });
  if (t.disputePolicy !== "NeverExpire") {
    if (t.timerMode !== "FromActivation") p.push({ section: 5, code: "DisputePolicyNeedsStartClock", text: "A dispute time limit needs a clock that runs from the start." });
    if (!(Number.isInteger(t.disputeWindowSecs) && t.disputeWindowSecs >= LIMITS.MIN_DISPUTE_WINDOW_SECS && t.disputeWindowSecs <= LIMITS.MAX_DISPUTE_WINDOW_SECS))
      p.push({ section: 5, code: "InvalidDisputeWindow", text: "The dispute time limit must be 1 to 365 days." });
  }
  // §6 recovery signers
  const r = t.recoverySigners.length;
  if (r < 1 || r > LIMITS.MAX_RECOVERY_SIGNERS) p.push({ section: 6, code: "InvalidRecoveryConfig", text: `Between 1 and ${LIMITS.MAX_RECOVERY_SIGNERS} recovery signers.` });
  if (!distinct(t.recoverySigners)) p.push({ section: 6, code: "InvalidRecoveryConfig", text: "Each recovery signer once." });
  if (!(Number.isInteger(t.recoveryThreshold) && t.recoveryThreshold >= 1 && t.recoveryThreshold <= Math.max(r, 1)))
    p.push({ section: 6, code: "InvalidRecoveryConfig", text: `Recovery signatures needed: 1 to ${Math.max(r, 1)}.` });
  if (!(Number.isInteger(t.recoveryDelaySecs) && t.recoveryDelaySecs >= 0)) p.push({ section: 6, code: "InvalidRecoveryConfig", text: "The notice period can't be negative." });
  // §7 token risks
  if ((t.acceptedRiskFlags & t.detectedRiskFlags) !== t.detectedRiskFlags)
    p.push({ section: 7, code: "RiskFlagsNotAccepted", text: "Every risk detected on this token must be accepted by the parties, on the record." });
  if (!(Number.isInteger(t.priceRiskTerm) && t.priceRiskTerm >= 0 && t.priceRiskTerm <= 255)) p.push({ section: 7, code: "InvalidPriceRiskTerm", text: "Price-risk term code: 0 to 255." });
  return p;
}

/** Terms → the program's create_deal parameters, with no validation (tests send bad ones on purpose). */
export function toDealSpec(t: CustomTerms): DealSpec {
  return {
    creator: t.creator,
    dealId: t.dealId,
    parties: t.parties,
    payerIdx: t.payerIdx,
    payeeIdx: t.payeeIdx,
    approvalThreshold: t.approvalThreshold,
    termsHash: new Uint8Array(32),
    milestoneAmounts: t.parts.map((x) => x.amount),
    rule: t.rule,
    timerMode: t.timerMode,
    timeoutSecs: TIMED_RULES.includes(t.rule) ? t.timeoutSecs : 0,
    splitBps: t.rule === "AutoSplit" ? t.splitBps : 0,
    tieBreaker: t.rule === "TieBreaker" && t.tieBreaker ? t.tieBreaker : undefined,
    recoverySigners: t.recoverySigners,
    recoveryThreshold: t.recoveryThreshold,
    recoveryDelaySecs: t.recoveryDelaySecs,
    acceptedRiskFlags: t.acceptedRiskFlags,
    priceRiskTerm: t.priceRiskTerm,
    mint: t.mint,
    tokenProgram: t.tokenProgram,
    ...(t.disputePolicy !== "NeverExpire" ? { disputePolicy: t.disputePolicy, disputeWindowSecs: t.disputeWindowSecs } : {}),
  };
}

/** Validated terms → spec. Throws the first problem's text. */
export function customSpec(t: CustomTerms): DealSpec {
  const problems = customProblems(t);
  if (problems.length) throw new Error(problems[0].text);
  return toDealSpec(t);
}

export function customFields(t: CustomTerms): ChainFields {
  return fieldsFromSpec(toDealSpec(t), dealAddress(t.creator, t.dealId), t.decimals, t.detectedRiskFlags);
}

export interface Clause {
  n: number;
  title: string;
  body: string;
}

/** The numbered sections of a rendered agreement, in order (title = the capitalised heading before the first period). */
export function clauseIndex(text: string): Clause[] {
  const out: Clause[] = [];
  // "N. TITLE. rest" or "N. TITLE:" — the title runs to the first period or colon.
  const re = /^(\d+)\. ([A-Z][^.:\n]*?)[.:](.*)$/;
  const lines = text.split("\n");
  let cur: Clause | null = null;
  for (const line of lines) {
    const m = re.exec(line);
    if (m && (!cur || Number(m[1]) === cur.n + 1)) {
      if (cur) out.push(cur);
      cur = { n: Number(m[1]), title: m[2], body: m[3].trim() };
    } else if (cur) {
      cur.body = cur.body ? `${cur.body}\n${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => ({ ...c, body: c.body.replace(/\n+$/, "") }));
}

/**
 * What a section's controls write, as the fragments that will appear in the
 * signed text. Built from the template's own clause functions so a caption
 * in the Builder can never say something the agreement won't.
 */
export function writes(section: Section, t: CustomTerms, fmtAmount: (raw: bigint) => string = (raw) => `${raw.toString()} raw units`): string[] {
  const f = customFields(t);
  switch (section) {
    case 2:
      return [`each part when ${t.approvalThreshold} of ${t.parties.length} parties approve it`];
    case 4:
      return t.parts.map((x, i) => `${i + 1}. ${x.label ? `${JSON.stringify(x.label)} — ` : ""}${fmtAmount(x.amount)}`);
    case 5:
      return [ruleClause(f, "Payee", "Payer", "c5"), disputeClause(f, "Payee", "Payer", "c5")];
    case 6:
      return [
        `RECOVERY SIGNERS (${t.recoveryThreshold} of ${t.recoverySigners.length})`,
        "They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period.",
      ];
    case 7:
      return [`Detected on this token: ${riskList(t.detectedRiskFlags)}. Accepted by the parties: ${riskList(t.acceptedRiskFlags)}. Price-risk term code: ${t.priceRiskTerm}.`];
    default:
      return [];
  }
}
