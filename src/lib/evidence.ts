import { PublicKey } from "@solana/web3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Deal, Mode } from "./deal";
import { hasBit, modeOf } from "./deal";
import { findLookAlike, type AddressEvidence } from "./policy";
import type { LocalData } from "./store";

/** Local evidence about a recipient address (R1 §6), from this device's history + my on-chain deals. */
export function evidenceFor(address: string, me: PublicKey, local: LocalData, deals: Deal[]): AddressEvidence {
  const instant = local.payments.filter((p) => p.address === address && p.mode === "instant");
  const completed = deals.filter(
    (d) => d.state === "Completed" && d.parties[d.payerIdx].equals(me) && d.parties[d.payeeIdx].toBase58() === address,
  );
  const history: { at: number; mode: Mode }[] = [
    ...instant.map((p) => ({ at: p.at, mode: "instant" as Mode })),
    ...completed.map((d) => ({ at: d.activatedAt || d.createdAt, mode: modeOf(d) })),
  ].sort((a, b) => b.at - a.at);
  const paidAddresses = Array.from(
    new Set([
      ...local.payments.map((p) => p.address),
      ...deals.filter((d) => d.parties[d.payerIdx].equals(me)).map((d) => d.parties[d.payeeIdx].toBase58()),
      ...Object.keys(local.contacts),
    ]),
  );
  return {
    isContact: !!local.contacts[address],
    completedPayments: history.length,
    lastMode: history[0]?.mode,
    explicitInstant: !!local.contacts[address]?.defaultInstant,
    lookAlikeOf: findLookAlike(address, paidAddresses),
    messaged: Object.values(local.threads ?? {}).some((th) => th.peer === address && th.messages.length > 0),
  };
}

export function parseAddress(s: string): PublicKey | null {
  try {
    const k = new PublicKey(s.trim());
    return PublicKey.isOnCurve(k.toBytes()) ? k : k; // PDAs (e.g. Squads vaults) are allowed as parties
  } catch {
    return null;
  }
}

/** The deal section of the evidence packet: on-chain fields only, nothing inferred. */
export function evidenceDealRecord(d: Deal) {
  return {
    address: d.address.toBase58(),
    state: d.state,
    parties: d.parties.map((p) => p.toBase58()),
    payer: d.parties[d.payerIdx].toBase58(),
    payee: d.parties[d.payeeIdx].toBase58(),
    mint: d.mint.toBase58(),
    totalAmount: d.totalAmount.toString(),
    deposited: d.deposited.toString(),
    releasedTotal: d.releasedTotal.toString(),
    termsHash: bytesToHex(d.termsHash),
    rule: d.rule,
    timerMode: d.timerMode,
    timeoutSecs: d.timeoutSecs,
    createdAt: d.createdAt,
    signedAt: d.signedAt,
    fundedAt: d.fundedAt,
    activatedAt: d.activatedAt,
    // Per-party status from the account's own bitmasks. The deal stores no
    // per-party signing time; each party's transaction (with its block time)
    // is in `transactions` below.
    partyStatus: d.parties.map((p, i) => ({ party: p.toBase58(), signedTerms: hasBit(d.signed, i), confirmedReady: hasBit(d.ready, i) })),
    dispute: { policy: d.disputePolicy, windowSecs: d.disputeWindowSecs, disputedSecs: d.disputedSecs },
    recovery: {
      signers: d.recoverySigners.map((r) => r.toBase58()),
      threshold: d.recoveryThreshold,
      delaySecs: d.recoveryDelaySecs,
      proposalActive: d.recoveryProposalActive,
      proposedToPayee: d.recoveryProposedToPayee.toString(),
      approvalsMask: d.recoveryApprovals,
      thresholdMetAt: d.recoveryReadyAt,
    },
  };
}

/** Plain-words lines for events a reader must not miss (v0.7). Raw events are in the bundle's `transactions`. */
export function evidenceEventSentence(events: { name: string; data: Record<string, string> }[], d: Deal): string {
  const out: string[] = [];
  for (const e of events) {
    if (e.data.deal && e.data.deal !== d.address.toBase58()) continue;
    if (e.name === "PayeeRefunded") out.push(` The recipient (${e.data.payee}) refunded ${e.data.refundedToPayer} token units to the payer at ${new Date(Number(e.data.timestamp) * 1000).toISOString()} (PayeeRefunded).`);
    if (e.name === "ActivationLapsed") out.push(` It was never started; ${e.data.refundedToPayer} token units went back to the payer (ActivationLapsed).`);
    if (e.name === "DisputePolicySet") out.push(` A dispute policy was set at creation: ${e.data.policy}, window ${e.data.windowSecs} s (DisputePolicySet).`);
    if (e.name === "DealResolved" && e.data.path === "DisputeExpired") out.push(` The dispute window ran out and the deal settled by its dispute policy: ${e.data.paidToPayee} to the payee, ${e.data.refundedToPayer} to the payer (DealResolved, DisputeExpired).`);
  }
  return out.join("");
}
