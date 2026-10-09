/**
 * FORMAT c1 — VERIFY ONLY. Frozen copy of the renderer shipped in v0.2
 * (latch-dial commit 2aa7c2b, src/lib/template.ts), kept byte-for-byte in
 * behaviour so deals created by v0.2 still verify. Never used to create.
 *
 * Known weaknesses (why c1 was withdrawn in v0.3): link params were not
 * validated, so a param or label could contain a newline and add text that
 * looks like an extra clause; Unicode NFC was applied; the format marker is
 * on line 2; decimals = 0 rendered wrongly. A c1 text that verifies is still
 * exactly what was signed — it must just be read with that in mind.
 */
import { PROGRAM_ID, CLUSTER, RISK } from "./config";
import type { ChainFields } from "./template";

const CANON = "c1";
const SUBJECT_MAX = 90;
const TEMPLATE_IDS = ["protected-payment@2", "goods-sale@2", "freelance@2", "deposit@2", "vehicle-sale@2"] as const;
type TemplateId = (typeof TEMPLATE_IDS)[number];

/** A c1 link blob: only t/n/s were checked by v0.2. */
export interface LinkBlobC1 {
  t: TemplateId;
  p: Record<string, unknown>;
  s: string;
  n: string;
  a?: string;
}

function canonText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function canonSubject(s: string): string {
  return canonText(s).replace(/\s+/g, " ").slice(0, SUBJECT_MAX);
}


const b64url = {
  enc(bytes: Uint8Array): string {
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  },
};

/** v0.2's lax decoder, verbatim. */
export function decodeBlobC1(s: string): LinkBlobC1 | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64url.dec(s)));
    if (!TEMPLATE_IDS.includes(v.t) || typeof v.n !== "string" || typeof v.s !== "string") return null;
    return v as LinkBlobC1;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ rendering

function uiAmount(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function duration(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400} day(s) (${secs} seconds)`;
  if (secs % 3600 === 0) return `${secs / 3600} hour(s) (${secs} seconds)`;
  return `${secs} seconds`;
}

const RISK_NAMES: [number, string][] = [
  [RISK.FREEZE_AUTHORITY, "the token issuer can freeze the vault"],
  [RISK.PERMANENT_DELEGATE, "the token issuer can take tokens from the vault"],
  [RISK.DORMANT_TRANSFER_HOOK, "the token has a dormant transfer hook"],
  [RISK.TRANSFER_FEE, "the token charges a transfer fee"],
  [RISK.CONFIDENTIAL_CAPABLE, "the token supports confidential transfers"],
  [RISK.INTEREST_BEARING, "the token is interest-bearing"],
  [RISK.MINT_CLOSE_AUTHORITY, "the token's mint can be closed"],
];
function riskList(flags: number): string {
  const xs = RISK_NAMES.filter(([b]) => flags & b).map(([, n]) => n);
  return xs.length ? xs.join("; ") : "none";
}

function ruleClause(f: ChainFields, payeeLabel: string, payerLabel: string): string {
  const t = duration(f.timeoutSecs);
  const pause =
    f.timerMode === "FromActivation"
      ? `The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, or the recovery signers act.`
      : `The clock starts only when a party reports a problem.`;
  switch (f.rule) {
    case "TimeoutRelease":
      return `Rule: TIMEOUT RELEASE. If no release has happened ${t} after the clock starts, anyone may send the remaining money to the ${payeeLabel}. ${pause}`;
    case "TimeoutRefund":
      return `Rule: TIMEOUT REFUND. If no release has happened ${t} after the clock starts, anyone may return the remaining money to the ${payerLabel}. ${pause}`;
    case "AutoSplit":
      return `Rule: AUTOMATIC SPLIT. ${t} after the clock starts, anyone may split the remaining money: ${(f.splitBps / 100).toFixed(2)}% to the ${payeeLabel}, the rest to the ${payerLabel}. ${pause}`;
    case "LongSunset":
      return `Rule: LONG SUNSET. The money stays locked until the parties agree; if they never do, anyone may return it to the ${payerLabel} ${t} after the clock starts. ${pause}`;
    case "TieBreaker":
      return `Rule: NAMED DECIDER. ${f.tieBreaker.toBase58()} (not a party) is named by all parties. Once any party reports a problem, this decider ALONE may set how the remaining money is divided between the ${payeeLabel} and the ${payerLabel}, and anyone may then carry out that division. Only a split signed by every party takes priority over the decider's ruling. There is NO automatic unlock by time under this rule.`;
    case "TrueDeadlock":
      return `Rule: NO DECIDER, NO TIMER. If a problem is reported, the remaining money stays locked until every party signs the same split or the recovery signers act. It never unlocks by time. Each party must give separate, explicit consent to this rule when signing.`;
  }
}

/** Template-specific clauses (part of the signed text). */
const TEMPLATE_NOTES: Record<TemplateId, string> = {
  "protected-payment@2": "",
  "goods-sale@2": "   The item details above describe what the Payee is selling; the Payer approves release once the item is received as described.",
  "freelance@2": "   Each part is released when both parties approve the work for that part. Revisions and rights follow the details above.",
  "deposit@2": "   This is a booking or order deposit. It is NOT a residential security deposit and must not be used as one.",
  "vehicle-sale@2": "   This agreement covers payment only. It does not transfer the vehicle's title; title and registration transfer happen separately under the law of the place of sale.",
};

/** Render the agreement text for a template + chain fields + link blob. */
export function renderAgreementC1(f: ChainFields, blob: LinkBlobC1): string {
  // Chain-derived only: never an app display label, so future app versions
  // regenerate byte-identical text.
  const unit = "token units";
  const total = f.milestoneAmounts.reduce((a, b) => a + b, 0n);
  const payerLabel = "Payer";
  const payeeLabel = "Payee";
  const labels = Array.isArray(blob.p.milestones) ? (blob.p.milestones as string[]) : [];

  const partyLines = f.parties
    .map((p, i) => {
      const role = i === f.payerIdx ? "Payer" : i === f.payeeIdx ? "Payee" : "Party";
      return `   ${i + 1}. ${role}: ${p.toBase58()}`;
    })
    .join("\n");

  const msLines = f.milestoneAmounts
    .map((m, i) => `   ${i + 1}. ${uiAmount(m, f.decimals)} ${unit}${labels[i] ? ` — ${canonSubject(labels[i])}` : ""}`)
    .join("\n");

  const paramLines = Object.keys(blob.p)
    .filter((k) => k !== "milestones")
    .sort()
    .map((k) => `   ${k}: ${String(blob.p[k])}`)
    .join("\n");

  const text = `LATCH PROTECTED PAYMENT AGREEMENT
Template: ${blob.t} · canonicalization ${CANON}
Status: Solana ${CLUSTER} demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "${canonSubject(blob.s)}"

2. PARTIES (by wallet address).
${partyLines}

3. AMOUNT AND HOLDING. The Payer pays ${uiAmount(total, f.decimals)} ${unit} (mint ${f.mint.toBase58()}, ${f.decimals} decimals) into the vault of deal ${f.deal.toBase58()} (deal id ${f.dealId.toString()}) under the Latch program ${PROGRAM_ID.toBase58()} on Solana ${CLUSTER}. The vault is controlled only by this deal's rules. No Latch Labs key can move, freeze, refund or redirect it.

4. RELEASES. The money is released in this order, each part when ${f.approvalThreshold} of ${f.parties.length} parties approve it:
${msLines}

5. IF THERE IS A PROBLEM. ${ruleClause(f, payeeLabel, payerLabel)} The parties may always settle by every party signing the same division.

6. RECOVERY SIGNERS (${f.recoveryThreshold} of ${f.recoverySigners.length}):
${f.recoverySigners.map((r) => `   ${r.toBase58()}`).join("\n")}
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of ${duration(f.recoveryDelaySecs)}.

7. TOKEN RISKS. Detected on this token: ${riskList(f.riskFlags)}. Accepted by the parties: ${riskList(f.acceptedRiskFlags)}. Price-risk term code: ${f.priceRiskTerm}.

8. TEMPLATE DETAILS.
${paramLines || "   none"}${TEMPLATE_NOTES[blob.t] ? `\n${TEMPLATE_NOTES[blob.t]}` : ""}
   Attachment: ${blob.a ? `SHA-256 ${blob.a} (held by the parties, never on-chain)` : "none"}
   Reference: ${blob.n}

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
`;
  return canonText(text) + "\n";
}

