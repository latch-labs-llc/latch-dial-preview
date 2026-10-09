/**
 * Encrypted agreement backups, format v2 (v0.4 B5). Pure functions only.
 *
 * Two SEPARATE deterministic wallet signatures:
 *   sig_enc  over backupKeyMessage    → encryption key, id key, key-check value
 *   sig_wr   over backupWriterKeyMessage → the writer key that signs uploads/reads
 * so the key that authenticates to the service is never derived from the key
 * that decrypts. Both messages name the app domain, so a signature made for
 * another site isn't the same signature.
 *
 *   key  = HKDF-SHA256(sig_enc, salt, "enc|<domain>|<cluster>|<owner>")
 *   idk  = HKDF-SHA256(sig_enc, salt, "id|…")      id  = HMAC(idk, deal) — the service never stores deal addresses
 *   kcv  = HMAC(key, "kcv")[0..16]                  detects a wallet that doesn't sign deterministically
 *   wsk  = HKDF-SHA256(sig_wr,  salt, "writer|…")   Ed25519 writer secret
 *   blob = 0x02 ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, pad(json), aad = "latch-dial backup v2|<owner>|<id>")
 * Plaintext is padded to 1, 4, 16 or 64 KiB so sizes don't reveal content.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { CLAIM_CLUSTER, b58encode } from "./claims";

export const BACKUP_VERSION = 2;
export const PAD_BUCKETS = [1024, 4096, 16384, 65536] as const;
/** Sealed sizes the service accepts: version + nonce + tag + padded plaintext. */
export const SEALED_SIZES = PAD_BUCKETS.map((b) => 1 + 24 + 16 + b);

const SALT = new TextEncoder().encode("latch-dial backup v2");
const te = (s: string) => new TextEncoder().encode(s);

export function backupKeyMessage(domain: string, owner: string): string {
  return `Latch backup key v2\ndomain: ${domain}\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\n\nSigning this unlocks your encrypted agreement backups on ${domain}. Only sign it there. It cannot move any money.`;
}
export function backupWriterKeyMessage(domain: string, owner: string): string {
  return `Latch backup writer key v2\ndomain: ${domain}\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\n\nSigning this lets ${domain} upload and list your encrypted backups. It can't read them and cannot move any money.`;
}

export interface BackupKeys {
  key: Uint8Array;
  idKey: Uint8Array;
  kcv: string;
}

export const NONDETERMINISTIC =
  "This wallet doesn't sign the same message the same way twice, so it can't recreate a backup key. Encrypted backups aren't available with this wallet — keep downloaded copies instead.";
export const KCV_MISMATCH =
  "This wallet produced a different backup key than before (it may not sign deterministically, or it's a different wallet). Backups made earlier can't be opened with it.";

export function deriveKeys(sigEnc: Uint8Array, domain: string, owner: string): BackupKeys {
  const ctx = `${domain}|${CLAIM_CLUSTER}|${owner}`;
  const key = hkdf(sha256, sigEnc, SALT, te(`enc|${ctx}`), 32);
  const idKey = hkdf(sha256, sigEnc, SALT, te(`id|${ctx}`), 32);
  return { key, idKey, kcv: bytesToHex(hmac(sha256, key, te("kcv"))).slice(0, 32) };
}

export function deriveWriter(sigWr: Uint8Array, domain: string, owner: string): { sk: Uint8Array; pk: string } {
  const sk = hkdf(sha256, sigWr, SALT, te(`writer|${domain}|${CLAIM_CLUSTER}|${owner}`), 32);
  return { sk, pk: b58encode(ed25519.getPublicKey(sk)) };
}

/** Sign twice and compare: refuse wallets whose signatures aren't repeatable. */
export async function deterministicSignature(sign: (m: Uint8Array) => Promise<Uint8Array>, message: string): Promise<Uint8Array> {
  const a = await sign(te(message));
  const b = await sign(te(message));
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new Error(NONDETERMINISTIC);
  return a;
}

export function backupId(idKey: Uint8Array, deal: string): string {
  return bytesToHex(hmac(sha256, idKey, te(deal)));
}

export function pad(pt: Uint8Array, buckets: readonly number[] = PAD_BUCKETS): Uint8Array {
  const need = pt.length + 4;
  const size = buckets.find((b) => b >= need);
  if (!size) throw new Error("too large to pad");
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, pt.length);
  out.set(pt, 4);
  return out;
}
export function unpad(p: Uint8Array): Uint8Array {
  const n = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0);
  if (n > p.length - 4) throw new Error("bad padding");
  return p.slice(4, 4 + n);
}

const aad = (owner: string, id: string) => te(`latch-dial backup v${BACKUP_VERSION}|${owner}|${id}`);

export function seal(key: Uint8Array, owner: string, id: string, plaintext: Uint8Array, nonce: Uint8Array = randomBytes(24)): Uint8Array {
  const ct = xchacha20poly1305(key, nonce, aad(owner, id)).encrypt(pad(plaintext));
  const out = new Uint8Array(1 + 24 + ct.length);
  out[0] = BACKUP_VERSION;
  out.set(nonce, 1);
  out.set(ct, 25);
  return out;
}

/** Throws unless this key, owner and id produced it (AAD binds the record to its slot). */
export function open(key: Uint8Array, owner: string, id: string, sealed: Uint8Array): Uint8Array {
  if (sealed[0] !== BACKUP_VERSION) throw new Error("unsupported backup version");
  return unpad(xchacha20poly1305(key, sealed.slice(1, 25), aad(owner, id)).decrypt(sealed.slice(25)));
}
