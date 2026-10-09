/**
 * Signed-message formats shared by the app and the optional service
 * (worker/). Every write to the service is authorised by an Ed25519
 * signature from the wallet it concerns, so the service can store and serve
 * claims but can never forge one: clients re-verify every claim they read.
 *
 * Each message starts with a fixed, versioned, human-readable header and
 * names the cluster, so a signature can't be replayed as a transaction, on
 * another cluster, or as a different kind of claim.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const CLAIM_CLUSTER = "devnet";
/** Signed requests older/newer than this are rejected by the service. */
export const MAX_SKEW_SECS = 600;

// ------------------------------------------------------------------ base58

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
export function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

export const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ----------------------------------------------------------------- handles

/** Telegram-style: 4–20 chars, starts with a letter, a–z 0–9 _. */
export const HANDLE_RE = /^[a-z][a-z0-9_]{3,19}$/;
/**
 * Reserved (B9): impersonation bait. Brand names are blocked ANYWHERE in the
 * name and generic roles at the start — after folding look-alikes
 * (l4tch → latch, phant0m → phantom, c0inbase → coinbase, so1ana → solana)
 * and dropping underscores. No "latch"-branded names before trademark
 * clearance (R8 K19).
 */
const RESERVED_BRANDS = ["latch", "phantom", "solflare", "backpack", "solana", "telegram", "coinbase", "binance", "kraken", "metamask", "circle", "usdc", "tether", "usdt", "stripe", "paypal", "venmo", "cashapp", "zelle", "revolut"];
const RESERVED_ROLES = ["admin", "support", "help", "official", "security", "team", "staff", "mod", "moderator", "system", "wallet", "escrow", "refund", "verify", "verified", "root", "null", "undefined", "service", "billing"];
const FOLD: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "2": "z", "6": "g", i: "l" };

/** Look-alike skeleton: underscores dropped, digits and i folded to the letters they imitate, runs collapsed. */
export function nameSkeleton(h: string): string {
  return h
    .toLowerCase()
    .replace(/_/g, "")
    .replace(/[0-9i]/g, (c) => FOLD[c] ?? c)
    .replace(/(.)\1+/g, "$1");
}
const sk = (w: string) => nameSkeleton(w);
const BRAND_SKELETONS = RESERVED_BRANDS.map(sk);
const ROLE_SKELETONS = RESERVED_ROLES.map(sk);

export function isReservedName(h: string): boolean {
  const s = nameSkeleton(h);
  return BRAND_SKELETONS.some((b) => s.includes(b)) || ROLE_SKELETONS.some((r) => s.startsWith(r));
}

export function normalizeHandle(s: string): string {
  return s.trim().replace(/^@/, "").toLowerCase();
}
export function handleProblem(h: string): string | null {
  if (!HANDLE_RE.test(h)) return "4–20 characters: letters, numbers and _ , starting with a letter.";
  if (isReservedName(h)) return "That name is reserved.";
  return null;
}

export interface HandleClaim {
  handle: string;
  owner: string; // base58 pubkey
  issued: number; // unix seconds
  sig: string; // base64 Ed25519 signature over handleClaimMessage
}

export function handleClaimMessage(handle: string, owner: string, issued: number): string {
  return `Latch handle claim v1\ncluster: ${CLAIM_CLUSTER}\nhandle: @${handle}\nowner: ${owner}\nissued: ${issued}`;
}
export function handleReleaseMessage(owner: string, issued: number): string {
  return `Latch handle release v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nissued: ${issued}`;
}

export function verifySig(message: string, sigB64: string, ownerB58: string): boolean {
  try {
    return ed25519.verify(fromB64(sigB64), new TextEncoder().encode(message), b58decode(ownerB58));
  } catch {
    return false;
  }
}

export function verifyHandleClaim(c: HandleClaim): boolean {
  return !handleProblem(c.handle) && verifySig(handleClaimMessage(c.handle, c.owner, c.issued), c.sig, c.owner);
}

// ---------------------------------------------------------------- telegram

export interface TelegramAuth {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export function telegramLinkMessage(owner: string, tgId: number, username: string, issued: number): string {
  return `Latch Telegram link v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\ntelegram id: ${tgId}\ntelegram username: @${username.toLowerCase()}\nissued: ${issued}`;
}
/** OIDC path: the wallet signs this BEFORE the Telegram redirect; the id_token must carry telegramNonce(owner, issued). */
export function telegramLinkMessageV2(owner: string, issued: number): string {
  return `Latch Telegram link v2\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nissued: ${issued}`;
}
/** nonce = H(wallet ‖ issued), hex. */
export function telegramNonce(owner: string, issued: number): string {
  return bytesToHex(sha256(new TextEncoder().encode(`latch-tg-nonce v1|${owner}|${issued}`)));
}

export function telegramUnlinkMessage(owner: string, issued: number): string {
  return `Latch Telegram unlink v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nissued: ${issued}`;
}

// ------------------------------------------------------------------ backup
// Key messages live in backupCrypto.ts (they name the app domain).

/** Registers the device writer key and the key-check value. Signed by the WALLET, once. */
export function backupWriterMessage(owner: string, writer: string, kcv: string, issued: number): string {
  return `Latch backup writer v2\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nwriter: ${writer}\nkey check: ${kcv}\nissued: ${issued}`;
}

/** One upload. Signed by the WRITER key. `id` = HMAC(id key, deal); `deal` is checked, never stored. */
export function backupWriteMessage(owner: string, id: string, deal: string, ctHash: string, issued: number): string {
  return `Latch backup write v2\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nid: ${id}\ndeal: ${deal}\nciphertext sha256: ${ctHash}\nissued: ${issued}`;
}

/** List this owner's backups. Signed by the WRITER key. */
export function backupReadMessage(owner: string, issued: number): string {
  return `Latch backup read v2\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nissued: ${issued}`;
}

/** Delete backups: target is "all" or one backup id. Signed by the WALLET. */
export function backupDeleteMessage(owner: string, target: string, issued: number): string {
  return `Latch backup delete v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\ndelete: ${target}\nissued: ${issued}`;
}

/** Delete everything the service keeps for this wallet. Signed by the WALLET. */
export function eraseMessage(owner: string, issued: number): string {
  return `Latch delete my service data v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nissued: ${issued}`;
}

// --------------------------------------------------------------- messages
// Key derivation messages live in msgCrypto.ts (they name the app domain).

/** The keys a wallet publishes for messages: an X25519 key others encrypt to and the Ed25519 key its device signs sends with. */
export interface MessagingKeyClaim {
  owner: string;
  enc: string; // base58 X25519 public key
  signer: string; // base58 Ed25519 public key (device signer, derived from a wallet signature)
  issued: number;
  sig: string; // base64 wallet signature over messagingKeyClaimMessage
}

export function messagingKeyClaimMessage(owner: string, enc: string, signer: string, issued: number): string {
  return `Latch messaging keys v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nencryption key: ${enc}\nsigner: ${signer}\nissued: ${issued}`;
}
export function messagingKeyRemoveMessage(owner: string, issued: number): string {
  return `Latch messaging keys remove v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nissued: ${issued}`;
}
export function verifyMessagingKeyClaim(c: MessagingKeyClaim): boolean {
  try {
    return b58decode(c.enc).length === 32 && b58decode(c.signer).length === 32 && verifySig(messagingKeyClaimMessage(c.owner, c.enc, c.signer, c.issued), c.sig, c.owner);
  } catch {
    return false;
  }
}

/** One message. Signed by the sender's SIGNER key; the service checks it against the sender's published claim. */
export function msgPostMessage(from: string, to: string, thread: string, seq: number, ctHash: string, issued: number): string {
  return `Latch message v1\ncluster: ${CLAIM_CLUSTER}\nfrom: ${from}\nto: ${to}\nthread: ${thread}\nseq: ${seq}\nciphertext sha256: ${ctHash}\nissued: ${issued}`;
}
/** Fetch this wallet's messages since a time. Signed by the SIGNER key. */
export function msgReadMessage(owner: string, since: number, issued: number): string {
  return `Latch message read v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nsince: ${since}\nissued: ${issued}`;
}
/** Open a live notification socket for this wallet's inbox (query-string auth: browsers can't set headers on an upgrade). Signed by the SIGNER key. */
export function msgSocketMessage(owner: string, issued: number): string {
  return `Latch message socket v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nissued: ${issued}`;
}
/** Delete this wallet's messages: target is "all" or one thread id. Signed by the WALLET. */
export function msgDeleteMessage(owner: string, target: string, issued: number): string {
  return `Latch message delete v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\ndelete: ${target}\nissued: ${issued}`;
}

/** A term proposal in a conversation (v0.14). Signed by the WALLET: the proposer's assent to this exact draft. */
export function termsProposalMessage(owner: string, thread: string, version: number, draftHash: string, issued: number): string {
  return `Latch terms proposal v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nthread: ${thread}\nversion: ${version}\ndraft sha256: ${draftHash}\nissued: ${issued}`;
}
/** Acceptance of a proposed draft. Signed by the WALLET. */
export function termsAcceptMessage(owner: string, thread: string, draftHash: string, issued: number): string {
  return `Latch terms accept v1\ncluster: ${CLAIM_CLUSTER}\nowner: ${owner}\nthread: ${thread}\ndraft sha256: ${draftHash}\nissued: ${issued}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function fresh(issued: number, now: number): boolean {
  return Math.abs(now - issued) <= MAX_SKEW_SECS;
}
