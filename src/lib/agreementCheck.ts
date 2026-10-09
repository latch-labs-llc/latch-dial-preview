/**
 * One answer to "what does this device know about this deal's agreement?",
 * used by the deal page, the agreement view and the evidence packet so they
 * never disagree (v0.4 A2).
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { hasDisputeLimit, type Deal } from "./deal";
import { decodeBlob, fieldsFromDeal, sha256Hex, verifyAgreement, type Format, type LinkBlob } from "./template";
import { decodeBlobC1, renderAgreementC1, type LinkBlobC1 } from "./templateC1";

export type AgreementStatus =
  /** No link for this deal on this device. */
  | { kind: "none" }
  /** The text regenerates to the on-chain hash. */
  | { kind: "verified"; format: Format | "c1"; text: string; hex: string; programHash?: string; blob: LinkBlob | LinkBlobC1 }
  /** A strict blob that does NOT regenerate the on-chain hash: don't sign. */
  | { kind: "mismatch"; text: string; hex: string; blob: LinkBlob }
  /** A link that fails the strict schema and isn't a verifiable c1 link either. */
  | { kind: "unreadable" };

const C1_MAX = 16384;

export function agreementStatus(d: Deal, blobStr: string | null | undefined, decimals: number): AgreementStatus {
  if (!blobStr) return { kind: "none" };
  const f = fieldsFromDeal(d, decimals);
  const blob = decodeBlob(blobStr);
  if (blob) {
    const r = verifyAgreement(f, blob, d.termsHash);
    if (r.ok) return { kind: "verified", format: r.format!, text: r.text, hex: r.hex, programHash: r.programHash, blob };
  }
  // v0.2 links: lax decode, frozen c1 renderer, verify only.
  const old = blobStr.length <= C1_MAX && !hasDisputeLimit(d) ? decodeBlobC1(blobStr) : null;
  if (old) {
    try {
      const text = renderAgreementC1(f, old);
      const hex = sha256Hex(text);
      if (hex === bytesToHex(d.termsHash)) return { kind: "verified", format: "c1", text, hex, blob: old };
    } catch {
      /* fall through */
    }
  }
  if (blob) {
    const r = verifyAgreement(f, blob, d.termsHash);
    return { kind: "mismatch", text: r.text, hex: r.hex, blob };
  }
  return { kind: "unreadable" };
}

/** Accepting, signing or paying in is allowed only on a verified agreement. */
export const canSign = (s: AgreementStatus) => s.kind === "verified";

/**
 * v0.5 #1: the ONLY gate for Accept / Accept & pay / Pay in. A legacy `&s=`
 * subject from a link is display-only — it can never unblock signing, since
 * anyone can append it to any link.
 */
export function signBlocked(s: AgreementStatus, _legacySubjectFromLink?: string | null): boolean {
  return !canSign(s);
}

export const C1_NOTE =
  "Older format (c1). This text is exactly what was signed, but c1 didn't check the details fields, so a field could contain text that looks like an extra clause. Read it all.";
export const UNREADABLE =
  "Made with an older or different app — verify your saved copy with sha256sum against the on-chain fingerprint.";

/** Short label for a status row. */
export function statusLabel(s: AgreementStatus): string {
  switch (s.kind) {
    case "none":
      return "not on this device";
    case "unreadable":
      return "made with an older or different app";
    case "mismatch":
      return "✗ does not match";
    case "verified":
      return s.format === "c5" || s.format === "c4" || s.format === "c3" ? "✓ matches on-chain" : `Older format (${s.format}) — verified`;
  }
}

/** The evidence packet's agreement section. matchesOnChain is null when this device couldn't determine it. */
export function evidenceAgreementRecord(s: AgreementStatus) {
  switch (s.kind) {
    case "none":
      return { status: "not on this device", matchesOnChain: null };
    case "unreadable":
      return { status: "made with an older or different app", matchesOnChain: null, note: UNREADABLE };
    case "mismatch":
      return { status: "does not match", matchesOnChain: false, template: s.blob.t, text: s.text, sha256: s.hex };
    case "verified":
      return {
        status: "verified",
        matchesOnChain: true,
        format: s.format,
        template: s.blob.t,
        text: s.text,
        sha256: s.hex,
        programHashStatedInText: s.programHash ?? null,
        ...(s.format === "c1" ? { note: C1_NOTE } : {}),
      };
  }
}

/** One plain sentence for the evidence summary. */
export function evidenceSentence(s: AgreementStatus): string {
  switch (s.kind) {
    case "none":
      return "The agreement text is not available on this device.";
    case "unreadable":
      return UNREADABLE;
    case "mismatch":
      return "The agreement text available here does NOT match the signed fingerprint.";
    case "verified":
      return `The agreement text below regenerates exactly to the fingerprint the parties signed${s.format === "c5" || s.format === "c4" || s.format === "c3" ? "" : ` (older format ${s.format})`}.`;
  }
}
