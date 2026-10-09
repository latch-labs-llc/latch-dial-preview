/**
 * The one place that turns "a Protected payment" into deal terms. Pay,
 * Request and the tests all build through here, so what the UI displays
 * (the preset) is exactly what goes on-chain (timeout_secs).
 */
import type { PublicKey } from "@solana/web3.js";
import { PRESETS, type Asset, type PresetId } from "./config";
import * as F from "./flows";
import { fieldsFromSpec, newNonce, renderAgreement, termsHash, type LinkBlob } from "./template";

const DAY = 86400;

export function presetDays(id: PresetId): number {
  return PRESETS.find((p) => p.id === id)!.days;
}

/**
 * Validate the params of a protected-payment link blob. Accepts ONLY
 * {preset, window_days} where window_days is an integer equal to a PRESETS
 * entry and preset names that same entry. Anything else → null (reject).
 */
export function presetFromParams(p: unknown): PresetId | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const keys = Object.keys(p).sort();
  if (keys.length !== 2 || keys[0] !== "preset" || keys[1] !== "window_days") return null;
  const { preset, window_days } = p as Record<string, unknown>;
  if (typeof window_days !== "number" || !Number.isInteger(window_days)) return null;
  const entry = PRESETS.find((x) => x.days === window_days);
  if (!entry || entry.id !== preset) return null;
  return entry.id;
}

export function protectedBlob(presetId: PresetId, subject: string, nonce = newNonce()): LinkBlob {
  return { t: "protected-payment@2", p: { preset: presetId, window_days: presetDays(presetId) }, s: subject, n: nonce };
}

export interface ProtectedPaymentInput {
  creator: PublicKey;
  payer: PublicKey;
  payee: PublicKey;
  raw: bigint;
  asset: Asset;
  presetId: PresetId;
  dealId: bigint;
  subject: string;
  /** A requester's blob (protected request). Must agree with presetId. */
  blob?: LinkBlob;
}

export function buildProtectedPayment(i: ProtectedPaymentInput): { spec: F.DealSpec; blob: LinkBlob; text: string; deal: PublicKey } {
  if (i.blob) {
    if (i.blob.t !== "protected-payment@2" || presetFromParams(i.blob.p) !== i.presetId) {
      throw new Error("Request terms don't match the protection window shown");
    }
  }
  const blob = i.blob ?? protectedBlob(i.presetId, i.subject);
  const spec: F.DealSpec = {
    creator: i.creator,
    dealId: i.dealId,
    parties: [i.payer, i.payee],
    payerIdx: 0,
    payeeIdx: 1,
    approvalThreshold: 2,
    termsHash: new Uint8Array(32),
    milestoneAmounts: [i.raw],
    rule: "TimeoutRelease",
    timerMode: "FromActivation",
    // Derived from the preset the user sees — never from link params directly.
    timeoutSecs: presetDays(i.presetId) * DAY,
    // The program requires ≥1 recovery signer; the preset names the two
    // parties (2-of-2). It is NOT a backup for a lost key (R8 D24).
    recoverySigners: [i.payer, i.payee],
    recoveryThreshold: 2,
    recoveryDelaySecs: 3 * DAY,
    acceptedRiskFlags: i.asset.knownRiskFlags,
    mint: i.asset.mint,
  };
  const deal = F.dealAddress(i.creator, i.dealId);
  const text = renderAgreement(fieldsFromSpec(spec, deal, i.asset.decimals, i.asset.knownRiskFlags), blob);
  spec.termsHash = termsHash(text);
  return { spec, blob, text, deal };
}
