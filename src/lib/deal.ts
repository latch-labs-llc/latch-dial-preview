/**
 * Deal account model: decoding, discovery offsets, and the derived facts the
 * UI shows (roles, state, absolute unlock time). Everything here is computed
 * from on-chain fields only, so any client can reproduce it.
 */
import { BorshAccountsCoder } from "@anchor-lang/core";
import { IDL } from "@latch-labs/sdk";
import { PublicKey } from "@solana/web3.js";

export type DealStateName =
  | "Draft"
  | "Signed"
  | "Funded"
  | "Active"
  | "Deadlocked"
  | "Completed"
  | "Cancelled";

export type RuleName =
  | "TimeoutRelease"
  | "TimeoutRefund"
  | "AutoSplit"
  | "TieBreaker"
  | "LongSunset"
  | "TrueDeadlock";

export type TimerModeName = "FromDeadlock" | "FromActivation";

/**
 * What an unresolved FromActivation dispute turns into once the deal has
 * spent `disputeWindowSecs` paused (cumulative). NeverExpire is the zero
 * value — every deal that never set a policy (program upgrade 0928c78).
 */
export type DisputePolicyName = "NeverExpire" | "ResumeRule" | "Split" | "RefundPayer";
export const DISPUTE_POLICIES: DisputePolicyName[] = ["NeverExpire", "ResumeRule", "Split", "RefundPayer"];
/** Anything but the default: a dispute can end without both parties agreeing. */
export const hasDisputeLimit = (d: { disputePolicy?: DisputePolicyName; disputeWindowSecs?: number }) =>
  (d.disputePolicy ?? "NeverExpire") !== "NeverExpire" || (d.disputeWindowSecs ?? 0) !== 0;

/** Byte offsets inside the Deal account (8-byte Anchor discriminator first).
 *  Pinned against a real account on the deployed binary by the
 *  "discovery offsets and account size match a real deal account"
 *  test in test/flows.test.ts. */
export const OFFSETS = {
  creator: 18,
  state: 50,
  numParties: 51,
  party: (i: number) => 52 + 32 * i,
  tieBreaker: 709,
  recoverySigner: (i: number) => 810 + 32 * i,
  /** Carved from the front of _reserved (now 47 bytes) by the 0928c78 upgrade. */
  disputePolicy: 980,
  disputeWindowSecs: 981,
  disputedSecs: 985,
} as const;
export const DEAL_ACCOUNT_SIZE = 1036;
export const MAX_PARTIES = 8;

const STATE_ORDER: DealStateName[] = [
  "Draft",
  "Signed",
  "Funded",
  "Active",
  "Deadlocked",
  "Completed",
  "Cancelled",
];

export interface Milestone {
  amount: bigint;
  approvals: number;
  released: boolean;
}

/** A decoded deal with plain JS types (bigint amounts, unix-second numbers). */
export interface Deal {
  address: PublicKey;
  dealId: bigint;
  creator: PublicKey;
  state: DealStateName;
  parties: PublicKey[];
  payerIdx: number;
  payeeIdx: number;
  approvalThreshold: number;
  signed: number;
  ready: number;
  deadlockConsent: number;
  cancelApprovals: number;
  termsHash: Uint8Array;
  priceRiskTerm: number;
  mint: PublicKey;
  tokenProgram: PublicKey;
  vault: PublicKey;
  totalAmount: bigint;
  deposited: bigint;
  releasedTotal: bigint;
  riskFlags: number;
  acceptedRiskFlags: number;
  milestones: Milestone[];
  rule: RuleName;
  timerMode: TimerModeName;
  timeoutSecs: number;
  splitBps: number;
  tieBreaker: PublicKey;
  deadlockRaisedAt: number;
  deadlockRaisedBy: PublicKey;
  elapsedAtPause: number;
  lastResumedAt: number;
  proposalActive: boolean;
  proposedToPayee: bigint;
  resolutionApprovals: number;
  tieBreakerDecided: boolean;
  tieBreakerAmount: bigint;
  recoverySigners: PublicKey[];
  recoveryThreshold: number;
  recoveryDelaySecs: number;
  /** A recovery division is on the table (recovery_sign). */
  recoveryProposalActive: boolean;
  recoveryProposedToPayee: bigint;
  /** Bitmask over recoverySigners. Reset when a different amount is proposed. */
  recoveryApprovals: number;
  /** When the proposal first met the threshold (0 = not yet). Executable at + recoveryDelaySecs. */
  recoveryReadyAt: number;
  createdAt: number;
  signedAt: number;
  fundedAt: number;
  activatedAt: number;
  eventSeq: bigint;
  disputePolicy: DisputePolicyName;
  /** 0 when NeverExpire; else 86400..31536000. */
  disputeWindowSecs: number;
  /** Time spent paused so far, cumulative across disputes. */
  disputedSecs: number;
}

const coder = new BorshAccountsCoder(IDL as any);

function enumKey(v: object): string {
  const k = Object.keys(v)[0] ?? "unknown";
  return k.charAt(0).toUpperCase() + k.slice(1);
}
function camelize(o: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
}
const big = (v: any): bigint => BigInt(v.toString());
const num = (v: any): number => Number(v.toString());

export function decodeDeal(address: PublicKey, data: Uint8Array): Deal {
  // The IDL uses snake_case field names; normalize to camelCase.
  const a: any = camelize(coder.decode("Deal", Buffer.from(data)));
  const n = a.numParties as number;
  return {
    address,
    dealId: big(a.dealId),
    creator: a.creator,
    state: enumKey(a.state) as DealStateName,
    parties: (a.parties as PublicKey[]).slice(0, n),
    payerIdx: a.payerIdx,
    payeeIdx: a.payeeIdx,
    approvalThreshold: a.approvalThreshold,
    signed: a.signed,
    ready: a.ready,
    deadlockConsent: a.deadlockConsent,
    cancelApprovals: a.cancelApprovals,
    termsHash: Uint8Array.from(a.termsHash),
    priceRiskTerm: a.priceRiskTerm,
    mint: a.mint,
    tokenProgram: a.tokenProgram,
    vault: a.vault,
    totalAmount: big(a.totalAmount),
    deposited: big(a.deposited),
    releasedTotal: big(a.releasedTotal),
    riskFlags: a.riskFlags,
    acceptedRiskFlags: a.acceptedRiskFlags,
    milestones: (a.milestones as any[]).slice(0, a.numMilestones).map((m) => ({
      amount: big(m.amount),
      approvals: m.approvals,
      released: m.released,
    })),
    rule: enumKey(a.deadlockRule) as RuleName,
    timerMode: enumKey(a.timerMode) as TimerModeName,
    timeoutSecs: num(a.timeoutSecs),
    splitBps: a.splitBps,
    tieBreaker: a.tieBreaker,
    deadlockRaisedAt: num(a.deadlockRaisedAt),
    deadlockRaisedBy: a.deadlockRaisedBy,
    elapsedAtPause: num(a.elapsedAtPause),
    lastResumedAt: num(a.lastResumedAt),
    proposalActive: a.proposalActive,
    proposedToPayee: big(a.proposedToPayee),
    resolutionApprovals: a.resolutionApprovals,
    tieBreakerDecided: a.tieBreakerDecided,
    tieBreakerAmount: big(a.tieBreakerAmount),
    recoverySigners: (a.recoverySigners as PublicKey[]).slice(0, a.numRecovery),
    recoveryThreshold: a.recoveryThreshold,
    recoveryDelaySecs: num(a.recoveryDelaySecs),
    recoveryProposalActive: a.recoveryProposalActive,
    recoveryProposedToPayee: big(a.recoveryProposedToPayee),
    recoveryApprovals: a.recoveryApprovals,
    recoveryReadyAt: num(a.recoveryReadyAt),
    createdAt: num(a.createdAt),
    signedAt: num(a.signedAt),
    fundedAt: num(a.fundedAt),
    activatedAt: num(a.activatedAt),
    eventSeq: big(a.eventSeq),
    disputePolicy: enumKey(a.disputePolicy) as DisputePolicyName,
    disputeWindowSecs: num(a.disputeWindowSecs),
    disputedSecs: num(a.disputedSecs),
  };
}

export const stateIndex = (s: DealStateName) => STATE_ORDER.indexOf(s);

// ------------------------------------------------------------------ roles

export function partyIndex(d: Deal, who: PublicKey | null | undefined): number {
  if (!who) return -1;
  return d.parties.findIndex((p) => p.equals(who));
}
export const payer = (d: Deal) => d.parties[d.payerIdx];
export const payee = (d: Deal) => d.parties[d.payeeIdx];
export const allMask = (d: Deal) => (1 << d.parties.length) - 1;
export const hasBit = (mask: number, i: number) => i >= 0 && (mask & (1 << i)) !== 0;

export type Role = "payer" | "payee" | "party" | "arbiter" | "recovery" | "viewer";
export function roleOf(d: Deal, who: PublicKey | null | undefined): Role {
  if (!who) return "viewer";
  const i = partyIndex(d, who);
  if (i === d.payerIdx) return "payer";
  if (i === d.payeeIdx) return "payee";
  if (i >= 0) return "party";
  if (d.rule === "TieBreaker" && d.tieBreaker.equals(who)) return "arbiter";
  if (d.recoverySigners.some((r) => r.equals(who))) return "recovery";
  return "viewer";
}

// ------------------------------------------------------------- dial mode

export type Mode = "instant" | "protected" | "custom";

/** A deal is "Protected" when it is exactly the dial's middle-stop shape. */
export function modeOf(d: Deal): Mode {
  // A dispute time limit is never the Protected preset (v0.7 #2): such a deal
  // is shown as Custom, with its rules spelled out.
  const simple =
    !hasDisputeLimit(d) &&
    d.parties.length === 2 &&
    d.milestones.length === 1 &&
    d.rule === "TimeoutRelease" &&
    d.timerMode === "FromActivation";
  return simple ? "protected" : "custom";
}

// ------------------------------------------------------------------ clock

/** Seconds of protection window left, from on-chain fields (resolve.rs formula). */
export function secondsLeft(d: Deal, now: number): number | null {
  if (d.timerMode !== "FromActivation" || d.timeoutSecs <= 0) return null;
  if (d.state === "Active") {
    return d.timeoutSecs - (d.elapsedAtPause + (now - d.lastResumedAt));
  }
  if (d.state === "Deadlocked") return d.timeoutSecs - d.elapsedAtPause; // frozen while paused
  return null;
}

/** Absolute unlock time (unix seconds) while Active in FromActivation mode. */
export function unlockAt(d: Deal): number | null {
  if (d.state !== "Active" || d.timerMode !== "FromActivation") return null;
  return d.lastResumedAt + (d.timeoutSecs - d.elapsedAtPause);
}

/** Next milestone that has not been released (strict order). */
export function nextMilestone(d: Deal): number {
  const i = d.milestones.findIndex((m) => !m.released);
  return i < 0 ? d.milestones.length : i;
}

export function remaining(d: Deal): bigint {
  return d.deposited - d.releasedTotal;
}
