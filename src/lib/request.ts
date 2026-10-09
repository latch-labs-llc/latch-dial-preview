/**
 * Protected requests, payer-created (founder decision: whoever pays the money
 * also locks the network deposit; every signer pays their own fees).
 *
 * The requester shares a link carrying {to, amount, asset, k}. `k` is the
 * full agreement link blob, including its secret nonce. The payer's app
 * creates the deal with exactly that blob, so the on-chain terms hash
 * regenerates from the requester's own stored blob — the requester's app
 * recognises the deal cryptographically (no spam folder, no link needed
 * back) and anyone else's Draft can't fake a match without the nonce.
 */
import canonicalize from "canonicalize";
import { PublicKey } from "@solana/web3.js";
import { ASSETS, PRESETS, type AssetId, type PresetId } from "./config";
import { presetFromParams } from "./protected";
import type { Deal } from "./deal";
import type { LocalData, PendingRequest } from "./store";
import { decodeBlob, fieldsFromDeal, verifyAgreement, type LinkBlob } from "./template";

export interface RequestLink {
  to: string;
  amount: string; // raw units
  asset: string;
  k: string; // link blob (base64url)
}

const enc = (o: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(canonicalize(o) as string)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function encodeRequest(r: RequestLink): string {
  return enc(r);
}

export interface DecodedRequest {
  req: RequestLink;
  blob: LinkBlob;
  to: PublicKey;
  amount: bigint;
  asset: AssetId;
  preset: PresetId;
}

/**
 * Parse and VALIDATE a protected request link. Rejects (null) anything the
 * app couldn't display faithfully: unknown asset, non-positive amount, bad
 * address, a template other than protected-payment@2, or a window that
 * isn't exactly one of the presets (e.g. window_days 0.01 or 9).
 */
export function decodeRequest(s: string): DecodedRequest | null {
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const req = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)))) as RequestLink;
    if (!req || typeof req !== "object" || typeof req.to !== "string" || typeof req.amount !== "string" || typeof req.k !== "string") return null;
    if (!/^[1-9]\d{0,19}$/.test(req.amount) || BigInt(req.amount) > 18446744073709551615n) return null;
    if (typeof req.asset !== "string" || !Object.hasOwn(ASSETS, req.asset) || !ASSETS[req.asset as AssetId]) return null;
    const blob = decodeBlob(req.k);
    if (!blob || blob.t !== "protected-payment@2" || blob.a !== undefined) return null;
    const preset = presetFromParams(blob.p);
    if (!preset) return null;
    const to = new PublicKey(req.to);
    return { req, blob, to, amount: BigInt(req.amount), asset: req.asset as AssetId, preset };
  } catch {
    return null;
  }
}

/**
 * The exact on-chain shape a payer-created answer to a protected request
 * must have. The fingerprint alone proves only that the payer used the
 * request's blob — the text is regenerated from the deal's OWN fields, so a
 * hostile payer could pair the blob with hostile terms and still match.
 */
export function hasRequestShape(d: Deal, me: string, presetDaysValue: number, knownRiskFlags: number): boolean {
  if (d.parties.length !== 2 || d.payerIdx === d.payeeIdx) return false;
  const payer = d.parties[d.payerIdx];
  const payee = d.parties[d.payeeIdx];
  if (payee.toBase58() !== me || payer.toBase58() === me) return false;
  if (!d.creator.equals(payer)) return false;
  if (d.milestones.length !== 1 || d.approvalThreshold !== 2) return false;
  if (d.rule !== "TimeoutRelease" || d.timerMode !== "FromActivation") return false;
  if (d.timeoutSecs !== presetDaysValue * 86400) return false;
  if (d.recoveryThreshold !== 2 || d.recoverySigners.length !== 2) return false;
  const rs = d.recoverySigners.map((k) => k.toBase58()).sort();
  if (rs.join() !== [payer.toBase58(), payee.toBase58()].sort().join()) return false;
  if (!d.tieBreaker.equals(PublicKey.default)) return false;
  if (d.splitBps !== 0 || d.priceRiskTerm !== 0) return false;
  if (d.acceptedRiskFlags !== knownRiskFlags) return false;
  // v0.7 #2: the payer creates the deal, so the payer could also have set a
  // dispute policy (e.g. RefundPayer after 1 day). A request answer has none.
  if (d.disputePolicy !== "NeverExpire" || d.disputeWindowSecs !== 0 || d.disputedSecs !== 0) return false;
  return true;
}

/** matchRequests, but only on a complete deal list (see fetchMyDeals). */
export function matchRequestsIfComplete(r: { deals: Deal[]; failed: number }, me: string, local: LocalData): RequestMatches {
  return r.failed ? { matches: [], conflicts: [], cleared: [] } : matchRequests(r.deals, me, local);
}

export interface RequestMatches {
  /** Exactly one well-shaped Draft answers this request → safe to label "your request". */
  matches: { deal: string; nonce: string; blob: string }[];
  /** More than one Draft claims the same request → show a conflict, link none. */
  conflicts: { nonce: string; deals: string[] }[];
  /**
   * Requests whose stored conflict no longer holds: at most one of the
   * conflicting Drafts is still a Draft (the others were cancelled or closed).
   * Only meaningful on a COMPLETE deal list.
   */
  cleared: string[];
}

/**
 * Find Drafts that answer one of my pending requests: I'm the payee, the
 * mint and amount match, the deal has exactly the protected shape the
 * request implies, and the terms hash regenerates from my stored blob.
 */
export function matchRequests(deals: Deal[], me: string, local: LocalData): RequestMatches {
  const out: RequestMatches = { matches: [], conflicts: [], cleared: [] };
  for (const [nonce, r] of Object.entries(local.requests) as [string, PendingRequest][]) {
    const blob = decodeBlob(r.blob);
    const preset = blob ? presetFromParams(blob.p) : null;
    const asset = ASSETS[r.asset as AssetId];
    if (!blob || !preset || !asset) continue;
    const days = PRESETS.find((p) => p.id === preset)!.days;
    const hits = deals.filter(
      (d) =>
        d.state === "Draft" &&
        d.mint.equals(asset.mint) &&
        d.totalAmount.toString() === r.amount &&
        hasRequestShape(d, me, days, asset.knownRiskFlags) &&
        verifyAgreement(fieldsFromDeal(d, asset.decimals), blob, d.termsHash).ok,
    );
    const ids = hits.map((d) => d.address.toBase58());
    const known = r.matchedDeal ? [r.matchedDeal] : [];
    const all = Array.from(new Set([...known, ...ids]));
    if (all.length > 1) {
      out.conflicts.push({ nonce, deals: all });
      continue;
    }
    if (r.conflict) {
      // Still-open Drafts among the ones that conflicted (complete list: a missing one is gone).
      const open = r.conflict.filter((a) => deals.some((d) => d.address.toBase58() === a && d.state === "Draft"));
      if (open.length > 1) continue;
      out.cleared.push(nonce);
    }
    if (ids.length === 1 && !r.matchedDeal) out.matches.push({ deal: ids[0], nonce, blob: r.blob });
  }
  return out;
}
