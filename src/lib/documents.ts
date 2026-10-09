/**
 * Documents against payment, on today's program (v0.8 #6).
 *
 * A party "presents" a document by recording its SHA-256 in a Memo instruction
 * that the presenting party signs, in the same transaction as their approval
 * of the stage the document belongs to. The Latch program is unchanged: the
 * memo is a public, signed, timestamped claim ("I presented a file with this
 * digest for stage N of deal D"); the approval is what moves the deal. The
 * document itself stays with the parties; anyone holding a copy can hash it
 * and compare.
 *
 * Memo payload: JCS-canonical JSON, format `latch-doc@1`.
 *
 * v0.15: the other side can acknowledge receipt the same way — a
 * `latch-doc-ack@1` memo ("I received a file with this digest for stage N of
 * deal D"), signed by the acknowledging party in the same transaction as its
 * own approval of that stage. Presentation + acknowledgement + release then
 * sit in the deal's own transactions, each signed by the party it binds.
 */
import { PublicKey, TransactionInstruction, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import type { Deal } from "./deal";
import { hasBit, nextMilestone, partyIndex } from "./deal";
import { approveAndMaybeRelease } from "./flows";
import { LABEL_MAX, canonLine } from "./template";

/** SPL Memo v2: every account passed to it must sign, which is what makes "presented by" trustworthy. */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const DOC_FORMAT = "latch-doc@1";
export const ACK_FORMAT = "latch-doc-ack@1";
export const MAX_DOCS_PER_PRESENTATION = 8;

export interface DocumentClaim {
  v: typeof DOC_FORMAT;
  deal: string;
  /** Zero-based stage (milestone) index. */
  stage: number;
  /** Canonical line, 1–40 code points: the document's name as listed in the agreement. */
  name: string;
  /** Lower-case hex SHA-256 of the file's bytes. */
  sha256: string;
}

/** A claim as found on-chain: who signed it, in which transaction. */
export interface PresentedDocument extends DocumentClaim {
  presenter: string;
  signature: string;
  slot: number | null;
  blockTime: number | null;
}

/** "I received a file with this digest for this stage" — no name: the digest ties it to the presentation. */
export interface DocumentAck {
  v: typeof ACK_FORMAT;
  deal: string;
  stage: number;
  sha256: string;
}
export interface AcknowledgedDocument extends DocumentAck {
  by: string;
  signature: string;
  slot: number | null;
  blockTime: number | null;
}
export interface DocumentRecords {
  presented: PresentedDocument[];
  acknowledged: AcknowledgedDocument[];
}

export function encodeDocMemo(c: DocumentClaim): string {
  return canonicalize({ v: c.v, deal: c.deal, stage: c.stage, name: c.name, sha256: c.sha256 }) as string;
}

/** Strict decode: anything off-shape is "not a document claim" (never an error, never partially trusted). */
export function decodeDocMemo(text: string): DocumentClaim | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.join(",") !== "deal,name,sha256,stage,v") return null;
  if (r.v !== DOC_FORMAT) return null;
  if (typeof r.deal !== "string") return null;
  try {
    new PublicKey(r.deal);
  } catch {
    return null;
  }
  if (typeof r.stage !== "number" || !Number.isInteger(r.stage) || r.stage < 0 || r.stage > 15) return null;
  if (typeof r.name !== "string" || r.name.length === 0 || canonLine(r.name, LABEL_MAX) !== r.name) return null;
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  const c: DocumentClaim = { v: DOC_FORMAT, deal: r.deal, stage: r.stage, name: r.name, sha256: r.sha256 };
  // Round-trip: the on-chain bytes must be exactly the canonical encoding.
  return encodeDocMemo(c) === text ? c : null;
}

export function encodeAckMemo(a: DocumentAck): string {
  return canonicalize({ v: a.v, deal: a.deal, stage: a.stage, sha256: a.sha256 }) as string;
}
export function decodeAckMemo(text: string): DocumentAck | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "deal,sha256,stage,v") return null;
  if (r.v !== ACK_FORMAT || typeof r.deal !== "string") return null;
  try {
    new PublicKey(r.deal);
  } catch {
    return null;
  }
  if (typeof r.stage !== "number" || !Number.isInteger(r.stage) || r.stage < 0 || r.stage > 15) return null;
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  const a: DocumentAck = { v: ACK_FORMAT, deal: r.deal, stage: r.stage, sha256: r.sha256 };
  return encodeAckMemo(a) === text ? a : null;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** RPC JSON carries instruction data as base58; web3.js objects carry bytes. */
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return new Uint8Array();
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function docMemoIx(presenter: PublicKey, claim: DocumentClaim): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: presenter, isSigner: true, isWritable: false }],
    data: Buffer.from(encodeDocMemo(claim), "utf8"),
  });
}

export function ackMemoIx(party: PublicKey, ack: DocumentAck): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: party, isSigner: true, isWritable: false }],
    data: Buffer.from(encodeAckMemo(ack), "utf8"),
  });
}

/**
 * Acknowledge receipt of 1–8 presented documents for the next stage and
 * approve that stage, as one transaction signed by the acknowledging party.
 * `digests` come from the presentations already on-chain for that stage.
 */
export async function acknowledgeDocuments(d: Deal, me: PublicKey, digests: string[]): Promise<TransactionInstruction[]> {
  if (digests.length < 1 || digests.length > MAX_DOCS_PER_PRESENTATION) throw new Error(`Acknowledge 1 to ${MAX_DOCS_PER_PRESENTATION} documents at a time.`);
  const stage = nextMilestone(d);
  if (stage >= d.milestones.length) throw new Error("Every part of this deal has been released.");
  if (hasBit(d.milestones[stage].approvals, partyIndex(d, me))) throw new Error("You already approved this part; documents are acknowledged with your approval.");
  const acks = digests.map((h) => {
    const a: DocumentAck = { v: ACK_FORMAT, deal: d.address.toBase58(), stage, sha256: h.toLowerCase() };
    if (!decodeAckMemo(encodeAckMemo(a))) throw new Error("Document digest isn't valid.");
    return a;
  });
  if (new Set(acks.map((a) => a.sha256)).size !== acks.length) throw new Error("Each document can be acknowledged once per stage.");
  return [...acks.map((a) => ackMemoIx(me, a)), ...(await approveAndMaybeRelease(d, me))];
}

/** SHA-256 of a file's bytes, hex. Runs on the device; the file never leaves it. */
export async function sha256File(file: Blob): Promise<string> {
  return bytesToHex(sha256(new Uint8Array(await file.arrayBuffer())));
}

/**
 * Present 1–8 documents for the next stage and approve that stage, as one
 * transaction signed by the presenter. Refused if the presenter already
 * approved the stage (a presentation without an approval would be a memo on
 * its own and would not reference the deal account).
 */
export async function presentDocuments(d: Deal, me: PublicKey, docs: { name: string; sha256: string }[]): Promise<TransactionInstruction[]> {
  if (docs.length < 1 || docs.length > MAX_DOCS_PER_PRESENTATION) throw new Error(`Present 1 to ${MAX_DOCS_PER_PRESENTATION} documents at a time.`);
  const stage = nextMilestone(d);
  if (stage >= d.milestones.length) throw new Error("Every part of this deal has been released.");
  if (hasBit(d.milestones[stage].approvals, partyIndex(d, me))) throw new Error("You already approved this part; documents are presented with your approval.");
  const claims = docs.map((x) => {
    const c: DocumentClaim = { v: DOC_FORMAT, deal: d.address.toBase58(), stage, name: canonLine(x.name, LABEL_MAX), sha256: x.sha256.toLowerCase() };
    if (!decodeDocMemo(encodeDocMemo(c))) throw new Error(`Document name or digest isn't valid: ${JSON.stringify(x.name)}`);
    return c;
  });
  const names = new Set(claims.map((c) => c.name));
  if (names.size !== claims.length) throw new Error("Each document name can be presented once per stage.");
  return [...claims.map((c) => docMemoIx(me, c)), ...(await approveAndMaybeRelease(d, me))];
}

/**
 * Document claims in a fetched transaction, for one deal. Only memos signed by
 * one of the deal's parties count; the Latch program never sees them, so a
 * verifier applies the same filter: deal matches, signer is a party.
 */
export function documentsFromTx(tx: VersionedTransactionResponse, d: Deal): PresentedDocument[] {
  return recordsFromTx(tx, d).presented;
}

/** Both kinds of claim in one transaction (same filter: a signing party, this deal, canonical bytes). */
export function recordsFromTx(tx: VersionedTransactionResponse, d: Deal): DocumentRecords {
  const none: DocumentRecords = { presented: [], acknowledged: [] };
  if (tx.meta?.err) return none;
  const msg: any = tx.transaction.message;
  const keys: PublicKey[] = typeof msg.getAccountKeys === "function"
    ? msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined }).keySegments().flat()
    : (msg.accountKeys ?? []).map((k: any) => (k instanceof PublicKey ? k : new PublicKey(k.pubkey ?? k)));
  const header = msg.header;
  const isSigner = (i: number) => (header ? i < header.numRequiredSignatures : typeof msg.isAccountSigner === "function" && msg.isAccountSigner(i));
  const ixs: any[] = msg.compiledInstructions ?? msg.instructions ?? [];
  const out: DocumentRecords = { presented: [], acknowledged: [] };
  const parties = new Set(d.parties.map((p) => p.toBase58()));
  for (const ix of ixs) {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(MEMO_PROGRAM_ID)) continue;
    const accountIdx: number[] = Array.from(ix.accountKeyIndexes ?? ix.accounts ?? []);
    if (accountIdx.length !== 1 || !isSigner(accountIdx[0])) continue;
    const presenter = keys[accountIdx[0]];
    if (!presenter || !parties.has(presenter.toBase58())) continue;
    const raw = ix.data instanceof Uint8Array ? ix.data : base58Decode(String(ix.data));
    const text = Buffer.from(raw).toString("utf8");
    const where = { signature: tx.transaction.signatures[0], slot: tx.slot ?? null, blockTime: tx.blockTime ?? null };
    const claim = decodeDocMemo(text);
    if (claim && claim.deal === d.address.toBase58()) out.presented.push({ ...claim, presenter: presenter.toBase58(), ...where });
    const ack = decodeAckMemo(text);
    if (ack && ack.deal === d.address.toBase58()) out.acknowledged.push({ ...ack, by: presenter.toBase58(), ...where });
  }
  return out;
}

/** Every document presented on a deal, oldest first, from its successful transactions (one getTransaction per signature). */
export async function fetchDocuments(conn: Connection, d: Deal): Promise<PresentedDocument[]> {
  return (await fetchDocumentRecords(conn, d)).presented;
}

/** Presentations and acknowledgements, oldest first, in one pass over the deal's transactions. */
export async function fetchDocumentRecords(conn: Connection, d: Deal): Promise<DocumentRecords> {
  const sigs = await conn.getSignaturesForAddress(d.address, { limit: 200 }, "confirmed");
  const out: DocumentRecords = { presented: [], acknowledged: [] };
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (tx) {
      const r = recordsFromTx(tx, d);
      out.presented.push(...r.presented);
      out.acknowledged.push(...r.acknowledged);
    }
  }
  return out;
}
