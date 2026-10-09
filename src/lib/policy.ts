/**
 * The evidence-keyed default and downgrade risk signals (R1 §6). Everything
 * is computed on the device from history the user created; nothing is sent
 * anywhere and nothing here is a protocol dependency.
 */
import type { Mode } from "./deal";

export interface AddressEvidence {
  /** Saved in the local address book. */
  isContact: boolean;
  /** Completed payments this wallet made to this exact address, with the mode used last. */
  completedPayments: number;
  lastMode?: Mode;
  /** User explicitly chose "Default to Instant for <name>". */
  explicitInstant: boolean;
  /** Prefix/suffix match of an address paid before, but a different address. */
  lookAlikeOf?: string;
  /** A conversation with this wallet exists on this device (v0.14): known, but still never paid. */
  messaged?: boolean;
}

export interface DefaultChoice {
  mode: Mode;
  /** Instant is locked until the user re-pastes and confirms (look-alikes). */
  instantLocked: boolean;
  tag?: string;
  evidence: string;
}

export function chooseDefault(e: AddressEvidence, amountAboveThreshold: boolean): DefaultChoice {
  if (e.lookAlikeOf) {
    return {
      mode: "protected",
      instantLocked: true,
      tag: "Looks like an address you paid before",
      evidence: "Not the address you paid before",
    };
  }
  if (e.explicitInstant && !amountAboveThreshold) {
    return { mode: "instant", instantLocked: false, evidence: "You set Instant as the default for this contact" };
  }
  if (e.completedPayments > 0 && e.lastMode && !amountAboveThreshold) {
    return {
      mode: e.lastMode,
      instantLocked: false,
      evidence: `Paid ${e.completedPayments} time${e.completedPayments > 1 ? "s" : ""} before`,
    };
  }
  if (e.isContact) {
    return { mode: "protected", instantLocked: false, evidence: "In your contacts · no completed payments yet" };
  }
  if (e.messaged) {
    return { mode: "protected", instantLocked: false, evidence: "You've messaged with them · no completed payments yet" };
  }
  return {
    mode: "protected",
    instantLocked: false,
    tag: "Recommended for new recipients",
    evidence: "New to you · never paid",
  };
}

export type RiskSignal = "first-payment" | "look-alike" | "large-amount" | "purchase-memo" | "from-link";

const PURCHASE_WORDS = [
  "bike", "ticket", "tickets", "deposit", "rent", "iphone", "phone", "laptop", "console", "ps5",
  "car", "puppy", "concert", "sneakers", "shoes", "watch", "camera", "order", "item", "buy",
  "purchase", "sale", "used", "shipping", "deliver", "delivery",
];

export function riskSignals(input: {
  mode: Mode;
  evidence: AddressEvidence;
  amountAboveThreshold: boolean;
  memo: string;
  openedFromLink: boolean;
}): RiskSignal[] {
  if (input.mode !== "instant") return [];
  const out: RiskSignal[] = [];
  if (input.evidence.lookAlikeOf) out.push("look-alike");
  if (input.evidence.completedPayments === 0) out.push("first-payment");
  if (input.amountAboveThreshold) out.push("large-amount");
  const words = input.memo.toLowerCase().split(/[^a-z0-9]+/);
  if (words.some((w) => PURCHASE_WORDS.includes(w))) out.push("purchase-memo");
  if (input.openedFromLink) out.push("from-link");
  return out;
}

/**
 * Look-alike: same first 4 and last 4 characters as a known address, but a
 * different address (the address-poisoning shape).
 */
export function findLookAlike(candidate: string, known: string[]): string | undefined {
  const head = candidate.slice(0, 4);
  const tail = candidate.slice(-4);
  return known.find((k) => k !== candidate && k.slice(0, 4) === head && k.slice(-4) === tail);
}
