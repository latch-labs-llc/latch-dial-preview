/**
 * Per-viewer view model of a deal: the state sentence (R1 §7.6), whether it
 * needs the viewer, which actions are available, and the Requests
 * classification (R3 §3.3). Pure functions of chain data + local data.
 */
import type { PublicKey } from "@solana/web3.js";
import { ACTIVATION_WINDOW_SECS, assetForMint } from "./config";
import {
  allMask,
  hasBit,
  hasDisputeLimit,
  modeOf,
  nextMilestone,
  partyIndex,
  remaining,
  roleOf,
  secondsLeft,
  unlockAt,
  type Deal,
  type Mode,
  type Role,
} from "./deal";
import { absTime, duration, money, short } from "./format";
import type { LocalData } from "./store";
import { popcount } from "./flows";
import { COPY } from "./copy";
import type { LatchEvent } from "./events";
import { decodeBlob } from "./template";
import { presetDays, presetFromParams } from "./protected";

/**
 * A Protected payment made with the Work preset: its window runs from the
 * start of work (the payee starts the clock), not from delivery. Wording
 * only — read from this device's link and cross-checked against the
 * on-chain window, never used to decide what a button does.
 */
export function isWorkDeal(d: Deal, local: LocalData): boolean {
  const b = decodeBlob(local.links[d.address.toBase58()] ?? "");
  return !!b && b.t === "protected-payment@2" && presetFromParams(b.p) === "work" && modeOf(d) === "protected" && d.timeoutSecs === presetDays("work") * 86400;
}

export type Action =
  | "accept" // sign terms (payee of a payer-initiated, or any unsigned party)
  | "acceptAndPay" // payer of a request: sign + deposit + ready
  | "pay" // payer after everyone signed: deposit + ready
  | "markShipped" // payee: confirm ready (+ pre-approve)
  | "confirmReady" // other parties / payer not yet ready
  | "release" // approve (+ release) next milestone
  | "crankRelease" // approvals met, anyone can release
  | "pause"
  | "resume"
  | "proposeSplit"
  | "acceptSplit"
  | "collect" // permissionless resolve
  | "cancelDraft"
  | "cancelTogether"
  | "decide" // named decider rules a split
  | "refundUnactivated" // anyone: return a Funded deal that never became Active
  | "recoveryPropose" // recovery signer: put a division on the table
  | "recoverySign" // recovery signer: co-sign the division on the table
  | "recoveryExecute" // anyone: carry out a signed division after the notice period
  | "endDispute" // anyone: end a pause whose ResumeRule time limit has passed
  | "refundByPayee"; // payee alone: return everything in the vault to the payer

/**
 * v0.9 #5: the section of the signed agreement each action carries out —
 * shown under the buttons so a party, a decider or a recovery signer can see
 * the clause they are executing. 4 = releases, 5 = if there is a problem
 * (incl. the payee's refund right), 6 = recovery signers, 9 = signing.
 */
export const ACTION_SECTION: Record<Action, 2 | 4 | 5 | 6 | 9> = {
  accept: 9,
  acceptAndPay: 9,
  pay: 9,
  markShipped: 4,
  confirmReady: 4,
  release: 4,
  crankRelease: 4,
  pause: 5,
  resume: 5,
  proposeSplit: 5,
  acceptSplit: 5,
  collect: 5,
  cancelDraft: 2,
  cancelTogether: 2,
  decide: 5,
  refundUnactivated: 5,
  recoveryPropose: 6,
  recoverySign: 6,
  recoveryExecute: 6,
  endDispute: 5,
  refundByPayee: 5,
};
export const ALL_ACTIONS = Object.keys(ACTION_SECTION) as Action[];

export interface DealView {
  role: Role;
  mode: Mode;
  title: string;
  sentence: string;
  /** v0.10 #2: one line for list rows; the full `sentence` lives on the deal page. */
  short: string;
  /** v0.10 #2: trailing status pill for list rows, or null for a quiet row. */
  pill: { cls: "move" | "paused" | "done" | "ended"; text: string } | null;
  needsYou: boolean;
  done: boolean;
  actions: Action[];
  amount: string;
  unlock: number | null;
  left: number | null;
  /** Mark-as-shipped is offered after the 3-day lapse: show it secondary, behind a confirm sheet. */
  lateShip: boolean;
}

export function nameFor(addr: PublicKey | string, local: LocalData): string {
  const a = typeof addr === "string" ? addr : addr.toBase58();
  return local.contacts[a]?.name ?? short(a);
}

/** Time this deal has spent paused so far, counting a pause in progress (cumulative, like disputed_secs). */
export function disputeUsed(d: Deal, now: number): number {
  return d.disputedSecs + (d.state === "Deadlocked" ? Math.max(0, now - d.deadlockRaisedAt) : 0);
}
/** A dispute time limit exists and the pause allowance is used up. */
export function disputeExpired(d: Deal, now: number): boolean {
  return d.disputePolicy !== "NeverExpire" && d.disputeWindowSecs > 0 && disputeUsed(d, now) >= d.disputeWindowSecs;
}

/** "{name} refunded you {amount}" from a PayeeRefunded event (v0.7 #3), or null. */
export function refundNote(events: LatchEvent[], d: Deal, me: PublicKey | null, local: LocalData): string | null {
  const e = events.find((x) => x.name === "PayeeRefunded" && x.data.deal === d.address.toBase58());
  if (!e) return null;
  const amount = money(BigInt(e.data.refundedToPayer), assetForMint(d.mint));
  const payerName = nameFor(d.parties[d.payerIdx], local);
  const payeeName = nameFor(d.parties[d.payeeIdx], local);
  const role = roleOf(d, me);
  return role === "payer" ? COPY.refundedYou(payeeName, amount) : role === "payee" ? COPY.youRefunded(payerName, amount) : COPY.theyRefunded(payeeName, payerName, amount);
}

/**
 * Status pill for a deal that has ended (v0.8 #1). A Cancelled deal used to
 * show no pill and a ladder with "Agreed" as the current step, which read as
 * "still waiting to be agreed" on a deal whose money had already gone back.
 */
export function terminalPill(d: Deal): { cls: "done" | "ended"; text: string } | null {
  if (d.state === "Completed") return { cls: "done", text: "✓ Done" };
  if (d.state === "Cancelled") return { cls: "ended", text: d.deposited > 0n ? "↩ Refunded" : "✕ Cancelled" };
  return null;
}

/** The dispute policy sentence for a deal (v0.7). */
export function disputeLimitText(d: Deal, local: LocalData, me: PublicKey | null = null): string {
  const days = d.disputeWindowSecs % 86400 === 0 ? `${d.disputeWindowSecs / 86400} day${d.disputeWindowSecs === 86400 ? "" : "s"}` : duration(d.disputeWindowSecs);
  const pct = d.rule === "AutoSplit" ? d.splitBps / 100 : 50;
  const who = (i: number) => (me && d.parties[i].equals(me) ? "you" : nameFor(d.parties[i], local));
  return COPY.disputeLimit(d.disputePolicy, days, who(d.payerIdx), who(d.payeeIdx), pct);
}

/** "Needs you" order: deals waiting for you to pay in are pinned first (a request you answered comes back here). */
export function pinPayIn<T extends { v: DealView }>(xs: T[]): T[] {
  return [...xs.filter((x) => x.v.actions.includes("pay")), ...xs.filter((x) => !x.v.actions.includes("pay"))];
}

export function viewDeal(d: Deal, me: PublicKey | null, local: LocalData, now: number): DealView {
  const role = roleOf(d, me);
  const i = partyIndex(d, me);
  const asset = assetForMint(d.mint);
  const amount = money(d.totalAmount, asset);
  const payerName = nameFor(d.parties[d.payerIdx], local);
  const payeeName = nameFor(d.parties[d.payeeIdx], local);
  const other = role === "payer" ? payeeName : payerName;
  const mode = modeOf(d);
  const unlock = unlockAt(d);
  const left = secondsLeft(d, now);
  const work = isWorkDeal(d, local);
  const actions: Action[] = [];
  let sentence = "";
  let needsYou = false;
  let lateShip = false;
  const isParty = i >= 0;
  const signedMe = hasBit(d.signed, i);
  const readyMe = hasBit(d.ready, i);

  switch (d.state) {
    case "Draft": {
      const unsigned = d.parties.length - popcount(d.signed);
      if (isParty && !signedMe) {
        needsYou = true;
        // Last signature + payer → the payer can sign and pay in one step.
        if (role === "payer" && unsigned === 1) actions.push("acceptAndPay");
        else actions.push("accept");
        const addr = d.address.toBase58();
        const answered = Object.values(local.requests).some((r) => r.matchedDeal === addr && !r.conflict);
        const conflicted = Object.values(local.requests).some((r) => r.conflict?.includes(addr));
        sentence =
          role === "payer"
            ? `${payeeName} asks you for ${amount} — review & pay`
            : conflicted
              ? `Conflict: more than one payment claims to answer your request for ${amount}. Check with the payer before accepting any`
              : answered
                ? `${payerName} set up your request for ${amount} — accept to continue`
                : `${payerName} wants to pay you ${amount} — review & accept`;
      } else {
        sentence = role === "payer" ? `Waiting for ${payeeName} to accept` : `Waiting for ${role === "payee" ? payerName : "the other parties"} to accept`;
      }
      if (isParty && !signedMe && hasDisputeLimit(d)) sentence += " · has a dispute time limit";
      if (isParty) actions.push("cancelDraft");
      break;
    }
    case "Signed": {
      if (role === "payer") {
        needsYou = true;
        actions.push("pay");
        sentence = `${payeeName} accepted. Pay in to start`;
      } else sentence = `Waiting for ${payerName} to pay in`;
      if (d.deposited > 0n) {
        // Partly paid in: refund_unactivated counts from signed_at (v0.7 #4).
        const lapse = d.signedAt + ACTIVATION_WINDOW_SECS;
        const lapsed = now >= lapse;
        const dep = money(d.deposited, asset);
        sentence =
          role === "payer"
            ? lapsed
              ? COPY.partialPayerLapsed(dep)
              : COPY.partialPayer(dep, amount, absTime(lapse))
            : lapsed
              ? COPY.partialOtherLapsed(payerName)
              : COPY.partialOther(payerName, dep, amount, absTime(lapse));
        if (lapsed) actions.push("refundUnactivated"); // permissionless, any viewer
      }
      if (isParty) actions.push("cancelTogether");
      break;
    }
    case "Funded": {
      const lapse = d.fundedAt + ACTIVATION_WINDOW_SECS;
      const lapsed = now >= lapse;
      if (role === "payee" && !readyMe) {
        needsYou = true;
        actions.push("markShipped");
        lateShip = lapsed;
        sentence = lapsed
          ? `Don't ship — anyone can now return the money to ${payerName}`
          : work
            ? `${payerName} paid ${amount} in. Start the clock when work begins — by ${absTime(lapse)}`
            : `${payerName} paid ${amount} in. Mark as shipped BEFORE you ship — by ${absTime(lapse)}`;
      } else if (isParty && !readyMe) {
        needsYou = true;
        actions.push("confirmReady");
        sentence = "Confirm you're ready to start";
      } else if (role === "payer") {
        sentence = lapsed ? `${payeeName} didn't mark it shipped in time — you can return it to yourself` : `Paid in. Returns to you from ${absTime(lapse)} if ${payeeName} hasn't marked it shipped`;
      } else {
        sentence = lapsed ? `Not started in time — anyone can return it to ${payerName}` : `Paid in. Waiting for the others to start`;
      }
      if (lapsed) {
        // Permissionless: offered to ANY viewer, connected party or not.
        actions.push("refundUnactivated");
        if (role === "payer") needsYou = true;
      }
      if (isParty) actions.push("cancelTogether");
      break;
    }
    case "Active": {
      const m = nextMilestone(d);
      const ms = d.milestones[m];
      const approvals = ms ? ms.approvals : 0;
      const met = ms && popcount(approvals) >= d.approvalThreshold;
      if (met) actions.push("crankRelease");
      else if (isParty && ms && !hasBit(approvals, i)) actions.push("release");
      if (isParty) actions.push("pause");
      if (unlock != null && left != null && left <= 0) {
        actions.push("collect");
        needsYou = d.rule === "TimeoutRefund" ? role === "payer" : role === "payee" || d.rule === "AutoSplit";
        sentence =
          d.rule === "TimeoutRefund"
            ? `Window ended — anyone can return it to ${payerName} now`
            : d.rule === "AutoSplit"
              ? "Window ended — anyone can carry out the split now"
              : `Unlocked — anyone can send it to ${payeeName} now`;
      } else if (unlock != null && d.rule === "TimeoutRefund") {
        sentence = `Returns to ${payerName} ${absTime(unlock)} unless released`;
      } else if (unlock != null && d.rule === "AutoSplit") {
        sentence = `${d.splitBps / 100}% to ${payeeName}. Splits on ${absTime(unlock)} — anyone can carry it out`;
      } else if (unlock != null) {
        sentence =
          role === "payee"
            ? `Unlocks for you ${absTime(unlock)} unless ${payerName} reports a problem`
            : `Protected — unlocks for ${payeeName} ${absTime(unlock)}`;
      } else {
        sentence = d.milestones.length > 1 ? `Part ${m + 1} of ${d.milestones.length} in progress` : "In progress";
      }
      break;
    }
    case "Deadlocked": {
      const paused = d.timerMode === "FromActivation" && left != null ? ` with ${duration(left)} left` : "";
      sentence =
        d.timerMode === "FromActivation" && d.disputePolicy !== "NeverExpire" && d.disputeWindowSecs > 0
          ? `Paused${paused}. Dispute time limit in ${duration(Math.max(0, d.disputeWindowSecs - disputeUsed(d, now)))}`
          : `Paused${paused}. Money moves only when you both agree`;
      if (d.rule === "TieBreaker") {
        sentence = d.tieBreakerDecided
          ? `The named decider ruled: ${money(d.tieBreakerAmount, asset)} to ${payeeName}`
          : "Paused. Waiting for the person you both named to decide";
        if (role === "arbiter") {
          actions.push("decide");
          needsYou = !d.tieBreakerDecided;
        }
        if (d.tieBreakerDecided) actions.push("collect");
      }
      if (isParty) {
        if (d.proposalActive && !hasBit(d.resolutionApprovals, i)) {
          needsYou = true;
          actions.push("acceptSplit");
          sentence = `Split proposed: ${money(d.proposedToPayee, asset)} to ${payeeName}, ${money(remaining(d) - d.proposedToPayee, asset)} to ${payerName}`;
        }
        if (d.proposalActive && d.resolutionApprovals === allMask(d)) actions.push("collect");
        actions.push("proposeSplit");
        if (me && d.deadlockRaisedBy.equals(me)) actions.push("resume");
      }
      if (d.timerMode === "FromActivation" && disputeExpired(d, now)) {
        // v0.7 #5: the deal's dispute policy takes over once its time limit is used up.
        if (d.disputePolicy === "ResumeRule") {
          sentence = COPY.endDisputeReady;
          if (!(me && d.deadlockRaisedBy.equals(me))) actions.push("endDispute");
          if (role === "payee") needsYou = true;
        } else {
          actions.push("collect");
          const pct = d.rule === "AutoSplit" ? d.splitBps / 100 : 50;
          const payerWho = role === "payer" ? "you" : payerName;
          const payeeWho = role === "payee" ? "you" : payeeName;
          sentence = d.disputePolicy === "Split" ? COPY.disputeSplitReady(pct, payeeWho, payerWho) : COPY.disputeRefundReady(payerWho);
          if (role === "payee" || role === "payer") needsYou = true;
        }
      }
      if (d.timerMode === "FromDeadlock" && d.rule !== "TieBreaker" && d.rule !== "TrueDeadlock") {
        const end = d.deadlockRaisedAt + d.timeoutSecs;
        if (now >= end) actions.push("collect");
      }
      break;
    }
    case "Completed":
      sentence = d.releasedTotal === d.deposited ? `Paid to ${payeeName}` : `Settled`;
      break;
    case "Cancelled":
      sentence = d.deposited > 0n ? `Cancelled — returned to ${payerName}` : "Cancelled";
      break;
  }

  // --------------------------------------------------------- payee refund
  // Program: Signed with a partial deposit, Funded, Active, Deadlocked.
  if (role === "payee" && remaining(d) > 0n && (d.state === "Funded" || d.state === "Active" || d.state === "Deadlocked" || (d.state === "Signed" && d.deposited > 0n))) {
    actions.push("refundByPayee");
  }

  // ------------------------------------------------------------ recovery
  // v0.7 #6: the program clears every recovery signature (and the proposal)
  // when the deal activates, and never marks a Funded proposal as met. So in
  // Funded nothing a backup signer signs can count: don't offer it, and say so
  // if someone (another client) proposed anyway.
  if (d.state === "Funded" && d.recoveryProposalActive) {
    sentence = `${sentence}. ${COPY.recoveryBeforeStart}`;
  }
  // Only once the deal is running (program: Active | Deadlocked).
  if (d.state === "Active" || d.state === "Deadlocked") {
    const ri = me ? d.recoverySigners.findIndex((r) => r.equals(me)) : -1;
    const isRecovery = ri >= 0;
    if (d.recoveryProposalActive) {
      const sigs = popcount(d.recoveryApprovals);
      const met = sigs >= d.recoveryThreshold && d.recoveryReadyAt > 0;
      const execAt = d.recoveryReadyAt + d.recoveryDelaySecs;
      const division = `${money(d.recoveryProposedToPayee, asset)} to ${payeeName}, the rest to ${payerName}`;
      // A pending recovery is a public notice to the parties: always say so.
      sentence = met
        ? now >= execAt
          ? `Backup signers' division is ready: ${division} — anyone can carry it out`
          : `Notice: backup signers agreed to divide it (${division}). It can be carried out from ${absTime(execAt)}`
        : `Notice: a backup signer proposed a division (${division}) — ${sigs} of ${d.recoveryThreshold} signatures`;
      if (isParty && !(met && now >= execAt)) needsYou = true;
      if (isRecovery && !hasBit(d.recoveryApprovals, ri)) {
        actions.push("recoverySign");
        needsYou = true;
      }
      if (isRecovery) actions.push("recoveryPropose");
      if (met && now >= execAt) actions.push("recoveryExecute");
    } else if (isRecovery && isParty && d.recoverySigners.some((r) => !d.parties.some((p) => p.equals(r)))) {
      // A third-party backup signer exists (e.g. 2-of-3): a party who is also
      // a recovery signer may start a recovery too (the backup must co-sign).
      actions.push("recoveryPropose");
    } else if (role === "recovery") {
      // Pure backup signer (not a party): it's their only lever.
      sentence = `You're a backup signer. A division needs ${d.recoveryThreshold} of ${d.recoverySigners.length} backup signers, then waits ${duration(d.recoveryDelaySecs)} in public before anyone can carry it out`;
      actions.push("recoveryPropose");
    }
  }

  const ended = terminalPill(d);
  const pill: DealView["pill"] = needsYou
    ? { cls: "move", text: actions.includes("pay") || actions.includes("acceptAndPay") ? "Pay in" : "Your move" }
    : d.state === "Deadlocked"
      ? { cls: "paused", text: "Paused" }
      : d.state === "Cancelled" && ended
        ? { cls: ended.cls, text: ended.text.replace(/^[^A-Za-z]+/, "") } // Completed rows show their date instead; the group already says Done
        : null;
  const short = shortLine(d, role, needsYou, actions, unlock, work);
  return {
    role,
    mode,
    title: role === "payer" ? `${amount} → ${other}` : role === "payee" ? `${amount} ← ${other}` : `${amount} · ${payerName} → ${payeeName}`,
    sentence,
    short,
    pill,
    needsYou,
    done: d.state === "Completed" || d.state === "Cancelled",
    actions: Array.from(new Set(actions)),
    amount,
    unlock,
    left,
    lateShip,
  };
}

/** One line a list row can hold (v0.10 #2). Verbs for what I do; nouns for what I wait for. */
function shortLine(d: Deal, role: Role, needsYou: boolean, actions: Action[], unlock: number | null, work: boolean): string {
  switch (d.state) {
    case "Draft":
      return needsYou ? (role === "payer" ? "Review & pay" : "Review & accept") : "Waiting for signatures";
    case "Signed":
      return d.deposited > 0n ? "Partly paid in" : role === "payer" ? "Pay in to continue" : "Waiting for the pay-in";
    case "Funded":
      return needsYou ? (role === "payee" ? (work ? "Start the clock" : "Mark as shipped") : "Confirm you're ready") : "Waiting to start";
    case "Active":
      if (actions.includes("release")) return d.milestones.length > 1 ? "Approve the next part" : "Say it's OK, or pause";
      return unlock ? `Unlocks ${absTime(unlock)}` : "In progress";
    case "Deadlocked":
      return actions.includes("decide") ? "Your decision" : "Paused until you agree";
    case "Completed":
      return d.milestones.length > 1 ? "All parts paid out" : role === "payer" ? "Paid" : "Paid to you";
    case "Cancelled":
      return d.deposited > 0n ? "Returned to the payer" : "Cancelled before pay-in";
  }
}

/**
 * Requests quarantine (R3 §3.3): a Draft naming me is solicited if I created
 * it, already signed it, its creator is a contact, or I have a past completed
 * deal with the creator, or I opened its share link on this device.
 */
export function isUnsolicited(d: Deal, me: PublicKey, local: LocalData, completedCounterparties: Set<string>): boolean {
  if (d.state !== "Draft") return false;
  const creator = d.creator.toBase58();
  if (d.creator.equals(me)) return false;
  if (hasBit(d.signed, partyIndex(d, me))) return false;
  if (local.contacts[creator]) return false;
  if (completedCounterparties.has(creator)) return false;
  if (local.links[d.address.toBase58()]) return false; // opened via its link
  if (Object.values(local.threads ?? {}).some((th) => th.peer === creator && th.messages.length > 0)) return false; // someone you've messaged with
  return true;
}

/** Only allowlisted mints get a symbol; unknown mints are hidden in Requests. */
export function isKnownMint(d: Deal): boolean {
  return assetForMint(d.mint) != null;
}
