/**
 * Encrypted messages between wallets (v0.13). Pure functions only.
 *
 * One deterministic wallet signature over messagingKeyMessage unlocks a
 * wallet's messaging identity on this domain:
 *   encSk  = HKDF-SHA256(sig, salt, "msg-enc|<domain>|<cluster>|<owner>")   X25519 secret
 *   signSk = HKDF-SHA256(sig, salt, "msg-sign|…")                             Ed25519 device signer
 *   kcv    = HMAC(encSk, "kcv")[0..16]   detects a wallet that doesn't sign deterministically
 * The two PUBLIC keys are published through the service in a wallet-signed
 * claim (claims.ts MessagingKeyClaim); peers re-verify it and pin it.
 *
 * A thread between two wallets has one key, the same from both sides:
 *   key = HKDF-SHA256(X25519(myEncSk, peerEncPk), salt, "thread|<domain>|<cluster>|<lo>|<hi>")
 * and each message is
 *   0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, pad(json), aad = "latch-dial msg v1|<thread>|<from>|<seq>")
 * padded to 256 B, 1, 4 or 16 KiB. The service stores that ciphertext plus who
 * wrote to whom and when; it cannot read the content.
 *
 * Static keys, so there is NO forward secrecy: whoever later obtains either
 * party's messaging key (i.e. a signature over messagingKeyMessage) can read
 * the whole thread. A ratchet is a later change; this format is versioned.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { pad, unpad } from "./backupCrypto";
import { CLAIM_CLUSTER, b58decode, b58encode, sha256Hex } from "./claims";

export const MSG_VERSION = 1;
export const MSG_PAD_BUCKETS = [256, 1024, 4096, 16384] as const;
/** Sealed sizes the service accepts: version + nonce + tag + padded plaintext. */
export const MSG_SEALED_SIZES = MSG_PAD_BUCKETS.map((b) => 1 + 24 + 16 + b);
/** Longest text in one message (code points). */
export const MSG_TEXT_MAX = 2000;
/** Largest proposal payload (JSON bytes) carried in one message. */
export const MSG_PROPOSAL_MAX = 8 * 1024;
export const MSG_BODY_FORMAT = "latch-msg@1";

const SALT = new TextEncoder().encode("latch-dial messages v1");
const te = (s: string) => new TextEncoder().encode(s);

export function messagingKeyMessage(domain: string, owner: string): string {
  return `Latch messaging key v1\ndomain: ${domain}\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\n\nSigning this unlocks your encrypted messages on ${domain}. Only sign it there. It cannot move any money.`;
}

export interface MessagingKeys {
  encSk: Uint8Array;
  encPk: string; // base58
  signSk: Uint8Array;
  signPk: string; // base58
  kcv: string;
}

export function deriveMessagingKeys(sig: Uint8Array, domain: string, owner: string): MessagingKeys {
  const ctx = `${domain}|${CLAIM_CLUSTER}|${owner}`;
  const encSk = hkdf(sha256, sig, SALT, te(`msg-enc|${ctx}`), 32);
  const signSk = hkdf(sha256, sig, SALT, te(`msg-sign|${ctx}`), 32);
  return {
    encSk,
    encPk: b58encode(x25519.getPublicKey(encSk)),
    signSk,
    signPk: b58encode(ed25519.getPublicKey(signSk)),
    kcv: bytesToHex(hmac(sha256, encSk, te("kcv"))).slice(0, 32),
  };
}

/** The same id from either side: both wallet addresses, sorted. */
export function threadId(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return sha256Hex(te(`latch-thread v1|${lo}|${hi}`)).slice(0, 32);
}

/** The thread key between me and a peer: X25519 agreement, then HKDF bound to the domain and both wallets. */
export function threadKey(myEncSk: Uint8Array, peerEncPk: string, domain: string, me: string, peer: string): Uint8Array {
  const [lo, hi] = [me, peer].sort();
  const shared = x25519.getSharedSecret(myEncSk, b58decode(peerEncPk));
  return hkdf(sha256, shared, SALT, te(`thread|${domain}|${CLAIM_CLUSTER}|${lo}|${hi}`), 32);
}

const aad = (thread: string, from: string, seq: number) => te(`latch-dial msg v${MSG_VERSION}|${thread}|${from}|${seq}`);

export function sealMsg(key: Uint8Array, thread: string, from: string, seq: number, plaintext: Uint8Array, nonce: Uint8Array = randomBytes(24)): Uint8Array {
  const ct = xchacha20poly1305(key, nonce, aad(thread, from, seq)).encrypt(pad(plaintext, MSG_PAD_BUCKETS));
  const out = new Uint8Array(1 + 24 + ct.length);
  out[0] = MSG_VERSION;
  out.set(nonce, 1);
  out.set(ct, 25);
  return out;
}

/** Throws unless this key, thread, sender and seq produced it. */
export function openMsg(key: Uint8Array, thread: string, from: string, seq: number, sealed: Uint8Array): Uint8Array {
  if (sealed[0] !== MSG_VERSION) throw new Error("unsupported message version");
  return unpad(xchacha20poly1305(key, sealed.slice(1, 25), aad(thread, from, seq)).decrypt(sealed.slice(25)));
}

/** Message id: a prefix of the ciphertext hash (the service computes the same one). */
export const msgId = (ct: Uint8Array) => sha256Hex(ct).slice(0, 16);

// ------------------------------------------------------------------- body

export type MsgKind = "text" | "proposal" | "accept" | "decline" | "system";
export const MSG_KINDS: MsgKind[] = ["text", "proposal", "accept", "decline", "system"];

/** What a message says, inside the ciphertext. Proposal fields arrive with term negotiation (v0.14). */
export interface MsgBody {
  v: typeof MSG_BODY_FORMAT;
  kind: MsgKind;
  /** Plain text (text, decline, system). */
  text?: string;
  /** A term proposal (kind "proposal"). */
  proposal?: unknown;
  /** Hash the message refers to (accept/decline → a proposal; system → a deal). */
  ref?: string;
  /** Deal address + link blob (kind "system": "the deal was created"). */
  deal?: string;
  k?: string;
  /** Wallet signature + its issued time over a proposal/accept claim. */
  walletSig?: string;
  issued?: number;
  /** Sender's clock, unix seconds. */
  sentAt: number;
}

const str = (x: unknown) => typeof x === "string";

/** Strict shape check for a decrypted body (unknown kinds and oversize content are refused, not shown). */
export function bodyProblem(v: any): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "not an object";
  if (v.v !== MSG_BODY_FORMAT) return "unknown format";
  if (!MSG_KINDS.includes(v.kind)) return "unknown kind";
  if (!Number.isSafeInteger(v.sentAt) || v.sentAt < 0) return "bad sentAt";
  const allowed = new Set(["v", "kind", "text", "proposal", "ref", "deal", "k", "walletSig", "issued", "sentAt"]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) return `unknown field ${k}`;
  if (v.text !== undefined && (!str(v.text) || [...v.text].length > MSG_TEXT_MAX)) return "text too long";
  if (v.ref !== undefined && (!str(v.ref) || !/^[0-9a-f]{16,64}$/.test(v.ref))) return "bad ref";
  if (v.deal !== undefined && !str(v.deal)) return "bad deal";
  if (v.k !== undefined && !str(v.k)) return "bad link";
  if (v.walletSig !== undefined && !str(v.walletSig)) return "bad signature";
  if (v.issued !== undefined && !Number.isSafeInteger(v.issued)) return "bad issued";
  if (v.proposal !== undefined && JSON.stringify(v.proposal).length > MSG_PROPOSAL_MAX) return "proposal too large";
  switch (v.kind as MsgKind) {
    case "text":
      if (!str(v.text) || !v.text.trim()) return "empty text";
      break;
    case "proposal":
      if (v.proposal === undefined || !str(v.ref)) return "proposal needs content and its hash";
      break;
    case "accept":
    case "decline":
      if (!str(v.ref)) return `${v.kind} needs a ref`;
      break;
    case "system":
      if (!str(v.text)) return "system needs text";
      break;
  }
  return null;
}

export const encodeBody = (b: MsgBody) => te(JSON.stringify(b));
export function decodeBody(pt: Uint8Array): MsgBody {
  const v = JSON.parse(new TextDecoder().decode(pt));
  const p = bodyProblem(v);
  if (p) throw new Error(p);
  return v as MsgBody;
}

/** Server-side day bucket for inbox indexes. */
export const dayOf = (unix: number) => Math.floor(unix / 86400);
