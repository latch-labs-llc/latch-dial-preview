/**
 * Builder settings → deal terms. Extracted from the Builder screen so the
 * exact code the UI runs is what the tests exercise on the deployed binary.
 */
import type { PublicKey } from "@solana/web3.js";
import type { Asset } from "./config";
import type { DisputePolicyName, RuleName, TimerModeName } from "./deal";
import type { DealSpec } from "./flows";

export type Settle = "timer" | "refund" | "split" | "decider" | "nobody";

export interface AgreementSettings {
  creator: PublicKey;
  dealId: bigint;
  role: "payer" | "payee";
  other: PublicKey;
  amounts: bigint[];
  settle: Settle;
  windowDays: number;
  splitPct: number;
  decider?: PublicKey | null;
  backup?: PublicKey | null;
  backupDelayDays: number;
  asset: Asset;
  /** v0.7 #5: only for clock-from-the-start rules (timer / refund / split). Default NeverExpire. */
  disputePolicy?: DisputePolicyName;
  /** 1..365 when disputePolicy isn't NeverExpire. */
  disputeDays?: number;
}

export const DISPUTE_DAYS_MIN = 1;
export const DISPUTE_DAYS_MAX = 365;

export function agreementSpec(a: AgreementSettings): DealSpec {
  const payer = a.role === "payer" ? a.creator : a.other;
  const payee = a.role === "payer" ? a.other : a.creator;
  let rule: RuleName = "TimeoutRelease";
  let timerMode: TimerModeName = "FromActivation";
  let timeoutSecs = a.windowDays * 86400;
  if (a.settle === "refund") rule = "TimeoutRefund";
  if (a.settle === "split") rule = "AutoSplit";
  if (a.settle === "decider" || a.settle === "nobody") {
    rule = a.settle === "decider" ? "TieBreaker" : "TrueDeadlock";
    timerMode = "FromDeadlock"; // the program forbids FromActivation for these rules
    timeoutSecs = 0;
  }
  // Program needs ≥1 recovery signer. "None" = the two parties, 2-of-2
  // (not a lost-key backup — R8 D24). A named third signer makes it 2-of-3.
  const recoverySigners = a.backup ? [payer, payee, a.backup] : [payer, payee];
  return {
    creator: a.creator,
    dealId: a.dealId,
    parties: [payer, payee],
    payerIdx: 0,
    payeeIdx: 1,
    approvalThreshold: 2,
    termsHash: new Uint8Array(32),
    milestoneAmounts: a.amounts,
    rule,
    timerMode,
    timeoutSecs,
    tieBreaker: a.settle === "decider" && a.decider ? a.decider : undefined,
    splitBps: a.settle === "split" ? Math.round(a.splitPct * 100) : 0,
    recoverySigners,
    recoveryThreshold: 2,
    recoveryDelaySecs: a.backupDelayDays * 86400,
    acceptedRiskFlags: a.asset.knownRiskFlags,
    mint: a.asset.mint,
    ...disputeTerms(a, timerMode),
  };
}

function disputeTerms(a: AgreementSettings, timerMode: TimerModeName): { disputePolicy?: DisputePolicyName; disputeWindowSecs?: number } {
  const policy = a.disputePolicy ?? "NeverExpire";
  if (policy === "NeverExpire" || timerMode !== "FromActivation") return {};
  const days = a.disputeDays ?? 0;
  if (!Number.isInteger(days) || days < DISPUTE_DAYS_MIN || days > DISPUTE_DAYS_MAX) throw new Error("The dispute time limit must be 1 to 365 days");
  return { disputePolicy: policy, disputeWindowSecs: days * 86400 };
}
