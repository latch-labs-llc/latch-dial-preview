/**
 * Term negotiation inside a conversation (v0.14): propose, counter, accept,
 * decline, then create the deal from the accepted version.
 *
 * Every proposal and acceptance carries a WALLET signature over the draft's
 * hash (claims.ts termsProposalMessage / termsAcceptMessage), on top of the
 * device-signer signature every message has. The proposer's signature is
 * their assent; the other party's acceptance completes it. The accepted
 * version's creator then creates the deal on chain with that exact text, and
 * a system message hands the other party the link blob.
 *
 * `negotiationState` is pure: it reads a thread's decrypted messages and
 * re-verifies every signature, so a forged or edited card never counts.
 */
import { termsAcceptMessage, termsProposalMessage, toB64, verifySig } from "./claims";
import { sendBody } from "./messaging";
import { MSG_BODY_FORMAT, threadId } from "./msgCrypto";
import type { SignMessage } from "./service";
import type { StoredMsg, Thread } from "./store";
import { draftHash, draftProblem, type TermsDraft } from "./termsDraft";

export interface Proposal {
  m: StoredMsg;
  draft: TermsDraft;
  hash: string;
  /** The proposer's wallet signature verifies (their assent to this version). */
  signed: boolean;
}

export interface NegotiationState {
  /** Every verified proposal, oldest first. */
  proposals: Proposal[];
  latest: Proposal | null;
  /** Wallets whose signed acceptance of `latest` verifies. */
  acceptedBy: Set<string>;
  declinedBy: Set<string>;
  /** The proposer signed it and the other party accepted. */
  agreed: boolean;
  /** The deal created from `latest`, if announced. */
  deal: { address: string; k: string; m: StoredMsg } | null;
}

const now = () => Math.floor(Date.now() / 1000);

/** Read a proposal card from a message, verifying its content and the proposer's wallet signature. */
export function proposalOf(m: StoredMsg, thread: string): Proposal | null {
  if (m.body.kind !== "proposal" || !m.body.ref || !m.body.proposal) return null;
  const draft = m.body.proposal as TermsDraft;
  if (draftProblem(draft)) return null;
  const hash = draftHash(draft);
  if (hash !== m.body.ref) return null;
  // The draft's creator must be its proposer, so "create the deal" lands with the right wallet.
  if (draft.terms.creator !== m.from) return null;
  const signed = !!m.body.walletSig && typeof m.body.issued === "number" && verifySig(termsProposalMessage(m.from, thread, draft.version, hash, m.body.issued), m.body.walletSig, m.from);
  return { m, draft, hash, signed };
}

export function negotiationState(t: Thread | undefined, me: string): NegotiationState {
  const empty: NegotiationState = { proposals: [], latest: null, acceptedBy: new Set(), declinedBy: new Set(), agreed: false, deal: null };
  if (!t) return empty;
  const thread = threadId(me, t.peer);
  const proposals = t.messages.map((m) => proposalOf(m, thread)).filter((p): p is Proposal => !!p);
  const latest = proposals[proposals.length - 1] ?? null;
  if (!latest) return { ...empty, proposals };
  const acceptedBy = new Set<string>();
  const declinedBy = new Set<string>();
  let deal: NegotiationState["deal"] = null;
  for (const m of t.messages) {
    if (m.at < latest.m.at || m.body.ref !== latest.hash) continue;
    if (m.body.kind === "accept" && m.body.walletSig && typeof m.body.issued === "number" && verifySig(termsAcceptMessage(m.from, thread, latest.hash, m.body.issued), m.body.walletSig, m.from)) acceptedBy.add(m.from);
    if (m.body.kind === "decline") declinedBy.add(m.from);
    if (m.body.kind === "system" && m.body.deal && m.body.k && m.from === latest.m.from) deal = { address: m.body.deal, k: m.body.k, m };
  }
  const other = t.peer === latest.m.from ? me : t.peer;
  const agreed = latest.signed && acceptedBy.has(other);
  return { proposals, latest, acceptedBy, declinedBy, agreed, deal };
}

/** Send a draft as a signed proposal (one wallet signature). */
export async function proposeTerms(me: string, peer: string, draft: TermsDraft, signMessage: SignMessage): Promise<{ hash: string; m: StoredMsg }> {
  const problem = draftProblem(draft);
  if (problem) throw new Error(problem);
  const hash = draftHash(draft);
  const issued = now();
  const walletSig = toB64(await signMessage(new TextEncoder().encode(termsProposalMessage(me, threadId(me, peer), draft.version, hash, issued))));
  const m = await sendBody(peer, { v: MSG_BODY_FORMAT, kind: "proposal", proposal: draft, ref: hash, walletSig, issued, text: draft.blob.s, sentAt: issued });
  return { hash, m };
}

/** Accept the latest proposal (one wallet signature). */
export async function acceptTerms(me: string, peer: string, hash: string, signMessage: SignMessage): Promise<StoredMsg> {
  const issued = now();
  const walletSig = toB64(await signMessage(new TextEncoder().encode(termsAcceptMessage(me, threadId(me, peer), hash, issued))));
  return sendBody(peer, { v: MSG_BODY_FORMAT, kind: "accept", ref: hash, walletSig, issued, sentAt: issued });
}

export async function declineTerms(peer: string, hash: string, text?: string): Promise<StoredMsg> {
  return sendBody(peer, { v: MSG_BODY_FORMAT, kind: "decline", ref: hash, ...(text?.trim() ? { text: text.trim() } : {}), sentAt: now() });
}

/** After creating the deal: hand the other party the address and the link blob. */
export async function announceDeal(peer: string, hash: string, deal: string, k: string): Promise<StoredMsg> {
  return sendBody(peer, { v: MSG_BODY_FORMAT, kind: "system", text: "The deal was created from the accepted terms.", ref: hash, deal, k, sentAt: now() });
}

/** The conversation as evidence of formation: every message with its service record and signatures, proposals re-verified. */
export function exportNegotiation(t: Thread, me: string): string {
  const thread = threadId(me, t.peer);
  const st = negotiationState(t, me);
  return JSON.stringify(
    {
      format: "latch-negotiation@1",
      thread,
      parties: [me, t.peer].sort(),
      exportedAt: now(),
      proposals: st.proposals.map((p) => ({ version: p.draft.version, hash: p.hash, proposer: p.m.from, signed: p.signed, basedOn: p.draft.basedOn ?? null, draft: p.draft })),
      latest: st.latest ? { hash: st.latest.hash, acceptedBy: [...st.acceptedBy], agreed: st.agreed, deal: st.deal?.address ?? null } : null,
      messages: t.messages.map((m) => ({ id: m.id, from: m.from, to: m.to, seq: m.seq, at: m.at, issued: m.issued, sig: m.sig, ct: m.ct, body: m.body })),
      how: "Each message's `sig` is the sender's device signer over 'Latch message v1' (claims.ts) with sha256(ct); `ct` opens with the thread key the two wallets share. Proposals and acceptances carry a wallet signature over the draft hash ('Latch terms proposal v1' / 'Latch terms accept v1').",
    },
    null,
    2,
  );
}
