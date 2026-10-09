/**
 * Client for the optional service (worker/). Everything here is a
 * convenience: when SERVICE_URL is unset, these features are hidden and the
 * app works with raw addresses, local contacts and downloads only.
 * Every claim read back is re-verified locally; the service can't forge one.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { APP_DOMAIN, IDENTITY_PREVIEW, SERVICE_URL, TELEGRAM_OIDC_CLIENT_ID } from "./config";
import {
  KCV_MISMATCH,
  backupId,
  backupKeyMessage,
  backupWriterKeyMessage,
  deriveKeys,
  deriveWriter,
  deterministicSignature,
  open,
  seal,
  type BackupKeys,
} from "./backupCrypto";
import { updateLocal } from "./store";
import { parseNameInput } from "./namePins";
import { authorizeUrl, pkcePair, savePending, type PendingOidc } from "./telegramOidc";
import {
  backupDeleteMessage,
  backupReadMessage,
  eraseMessage,
  backupWriteMessage,
  backupWriterMessage,
  b58encode,
  fromB64,
  handleClaimMessage,
  handleReleaseMessage,
  messagingKeyRemoveMessage,
  msgDeleteMessage,
  msgPostMessage,
  msgReadMessage,
  msgSocketMessage,
  verifyMessagingKeyClaim,
  type MessagingKeyClaim,
  sha256Hex,
  telegramLinkMessage,
  telegramLinkMessageV2,
  telegramUnlinkMessage,
  toB64,
  verifyHandleClaim,
  type HandleClaim,
  type TelegramAuth,
} from "./claims";

export type SignMessage = (msg: Uint8Array) => Promise<Uint8Array>;

export const serviceOn = !!SERVICE_URL;
let baseUrl: string | undefined = SERVICE_URL;
/** Like serviceOn, but follows setServiceUrlForTesting. */
export const serviceAvailable = () => !!baseUrl;
/** Tests only: point the client at a (fake) service. The app always uses VITE_SERVICE_URL. */
export function setServiceUrlForTesting(url: string | undefined) {
  baseUrl = url;
  profileCache.clear();
}
const now = () => Math.floor(Date.now() / 1000);

async function api(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<any> {
  if (!baseUrl) throw new Error("Service not configured");
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `Service error ${r.status}`), { status: r.status });
  return j;
}

async function sign(signMessage: SignMessage, text: string): Promise<string> {
  return toB64(await signMessage(new TextEncoder().encode(text)));
}

// ----------------------------------------------------------------- handles

/**
 * What the app may say about a Telegram link. Clients can't check the
 * Telegram→wallet link themselves (only the service saw Telegram's proof),
 * so it is never shown as "verified".
 */
export const TG_BADGE = `linked via Latch service${IDENTITY_PREVIEW ? " · Preview" : ""}`;

export interface Profile {
  handle: HandleClaim | null;
  telegram: { username: string; verifiedAt: number; expiresAt: number; owner: string } | null;
}

const profileCache = new Map<string, { at: number; p: Profile }>();

export async function profileOf(owner: string): Promise<Profile> {
  if (!baseUrl) return { handle: null, telegram: null };
  const c = profileCache.get(owner);
  if (c && Date.now() - c.at < 120_000) return c.p;
  const p: Profile = await api("GET", `/owners/${owner}`).catch(() => ({ handle: null, telegram: null }));
  // Never trust the service: drop claims that don't verify or don't match the owner.
  if (p.handle && (!verifyHandleClaim(p.handle) || p.handle.owner !== owner)) p.handle = null;
  if (p.telegram && (p.telegram.owner !== owner || !(p.telegram.expiresAt > Date.now() / 1000))) p.telegram = null;
  profileCache.set(owner, { at: Date.now(), p });
  return p;
}

export interface Resolved {
  owner: string;
  via: "handle" | "telegram";
  name: string;
  /** Signed claim time (handles only). */
  issued?: number;
}

/**
 * Resolve a typed name. "@sam" is ONLY a Latch handle (wallet-signed claim,
 * re-verified here); "tg:@sam" is ONLY a findable Telegram username. The two
 * namespaces never fall through to each other.
 */
export async function resolveName(input: string): Promise<Resolved | null> {
  if (!baseUrl) return null;
  const parsed = parseNameInput(input);
  if (!parsed) return null;
  const { via, name } = parsed;
  try {
    if (via === "handle") {
      const c: HandleClaim = await api("GET", `/handles/${encodeURIComponent(name)}`);
      if (verifyHandleClaim(c) && c.handle === name) return { owner: c.owner, via, name, issued: c.issued };
    } else {
      const t = await api("GET", `/telegram/${encodeURIComponent(name)}`);
      if (t?.owner && t.username === name && t.expiresAt > now()) return { owner: t.owner, via, name: t.username };
    }
  } catch {
    /* not found */
  }
  return null;
}

export async function claimHandle(owner: string, handle: string, signMessage: SignMessage): Promise<HandleClaim> {
  const issued = now();
  const sig = await sign(signMessage, handleClaimMessage(handle, owner, issued));
  profileCache.delete(owner);
  return api("POST", "/handles", { handle, owner, issued, sig });
}

export async function releaseHandle(owner: string, signMessage: SignMessage): Promise<void> {
  const issued = now();
  profileCache.delete(owner);
  await api("DELETE", "/handles", { owner, issued, sig: await sign(signMessage, handleReleaseMessage(owner, issued)) });
}

// ---------------------------------------------------------------- telegram

export async function linkTelegram(owner: string, tg: TelegramAuth, findable: boolean, signMessage: SignMessage) {
  const issued = now();
  const sig = await sign(signMessage, telegramLinkMessage(owner, tg.id, tg.username ?? "", issued));
  profileCache.delete(owner);
  return rememberMyTelegram(owner, findable, await api("POST", "/telegram", { owner, issued, sig, tg, findable }));
}

/** The service won't reveal a non-findable link, so this device remembers its own. */
function rememberMyTelegram(owner: string, findable: boolean, r: { username: string; verifiedAt: number; expiresAt: number }) {
  updateLocal((d) => void (d.myTelegram[owner] = { username: r.username, verifiedAt: r.verifiedAt, expiresAt: r.expiresAt, findable }));
  return r;
}

/** OIDC flag: sign the v2 link message, remember the PKCE verifier, and go to Telegram. */
export async function startTelegramOidc(owner: string, findable: boolean, signMessage: SignMessage, go: (url: string) => void = (u) => window.location.assign(u)) {
  if (!TELEGRAM_OIDC_CLIENT_ID) throw new Error("Telegram sign-in isn't configured");
  const issued = now();
  const sig = await sign(signMessage, telegramLinkMessageV2(owner, issued));
  const { verifier, challenge } = pkcePair();
  const state = toB64(randomBytes(16)).replace(/[+/=]/g, "");
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  savePending({ state, verifier, owner, issued, sig, findable, redirectUri });
  go(authorizeUrl({ clientId: TELEGRAM_OIDC_CLIENT_ID, redirectUri, state, challenge, owner, issued }));
}

export async function completeTelegramOidc(code: string, p: PendingOidc) {
  profileCache.delete(p.owner);
  return rememberMyTelegram(p.owner, p.findable, await api("POST", "/telegram/oidc", { owner: p.owner, issued: p.issued, sig: p.sig, code, verifier: p.verifier, redirectUri: p.redirectUri, findable: p.findable }));
}

export async function unlinkTelegram(owner: string, signMessage: SignMessage) {
  const issued = now();
  profileCache.delete(owner);
  updateLocal((d) => void delete d.myTelegram[owner]);
  return api("DELETE", "/telegram", { owner, issued, sig: await sign(signMessage, telegramUnlinkMessage(owner, issued)) });
}

// ------------------------------------------------------------------ backup

export interface BackupPayload {
  format: "latch-dial/agreement-backup@2";
  deal: string;
  link: string; // the link blob (base64url) that regenerates the agreement
  attachment?: string; // private details text, if any
}

export interface BackupSession {
  owner: string;
  keys: BackupKeys;
  writer?: { sk: Uint8Array; pk: string };
}

/**
 * Unlock: one wallet signature (two the first time on a device, to prove the
 * wallet signs deterministically). `knownKcv` is this device's earlier
 * key-check value, if any: a different one means a different key.
 */
export async function unlockBackupKeys(owner: string, signMessage: SignMessage, knownKcv?: string): Promise<BackupKeys> {
  const msg = backupKeyMessage(APP_DOMAIN, owner);
  const sig = knownKcv ? await signMessage(new TextEncoder().encode(msg)) : await deterministicSignature(signMessage, msg);
  const keys = deriveKeys(sig, APP_DOMAIN, owner);
  if (knownKcv && keys.kcv !== knownKcv) throw new Error(KCV_MISMATCH);
  return keys;
}

/**
 * Writer key: two signatures the first time on a device (to prove the wallet
 * signs deterministically), one afterwards — `knownWriter` is the public key
 * this device derived before, and a different result is refused.
 */
export async function unlockWriter(owner: string, signMessage: SignMessage, knownWriter?: string) {
  const msg = backupWriterKeyMessage(APP_DOMAIN, owner);
  const sig = knownWriter ? await signMessage(new TextEncoder().encode(msg)) : await deterministicSignature(signMessage, msg);
  const w = deriveWriter(sig, APP_DOMAIN, owner);
  if (knownWriter && w.pk !== knownWriter) throw new Error(KCV_MISMATCH);
  return w;
}

export function sealPayload(s: BackupSession, p: BackupPayload): { id: string; sealed: Uint8Array } {
  const id = backupId(s.keys.idKey, p.deal);
  return { id, sealed: seal(s.keys.key, s.owner, id, new TextEncoder().encode(JSON.stringify(p))) };
}
export function openPayload(s: BackupSession, id: string, sealed: Uint8Array): BackupPayload {
  const p = JSON.parse(new TextDecoder().decode(open(s.keys.key, s.owner, id, sealed))) as BackupPayload;
  if (backupId(s.keys.idKey, p.deal) !== id) throw new Error("backup id doesn't match its deal");
  return p;
}

/** One wallet signature, once: registers the writer key and key-check value. */
export async function registerBackupWriter(s: BackupSession, signMessage: SignMessage) {
  const issued = now();
  await api("POST", `/backup/${s.owner}/writer`, {
    writer: s.writer!.pk,
    kcv: s.keys.kcv,
    issued,
    sig: await sign(signMessage, backupWriterMessage(s.owner, s.writer!.pk, s.keys.kcv, issued)),
  });
}

/**
 * Strictly increasing `issued` per device-key lane (the service refuses repeats
 * for 20 minutes): "w" backups, "m" messages. Remembered across reloads so a
 * fresh page can't reuse a second this device already spent.
 */
const lastIssued: Record<string, number> = {};
const issuedKey = (lane: string) => `latch-dial:issued:${lane}`;
export function nextIssued(lane: string, t = now()): number {
  let last = lastIssued[lane] ?? 0;
  try {
    last = Math.max(last, Number(localStorage.getItem(issuedKey(lane)) ?? 0) || 0);
  } catch {
    /* storage blocked: memory only */
  }
  lastIssued[lane] = Math.max(t, last + 1);
  try {
    localStorage.setItem(issuedKey(lane), String(lastIssued[lane]));
  } catch {
    /* ignore */
  }
  return lastIssued[lane];
}
/** After a 409 (the service saw a later `issued` than this device remembers): skip ahead once. */
export function skipIssued(lane: string, by = 5): void {
  lastIssued[lane] = (lastIssued[lane] ?? now()) + by;
}
export const nextWriterIssued = (t = now()) => nextIssued("w", t);

const keySign = (sk: Uint8Array, msg: string) => toB64(ed25519.sign(new TextEncoder().encode(msg), sk));
const writerSign = (s: BackupSession, msg: string) => keySign(s.writer!.sk, msg);

/** Silent: signed by the writer key, no wallet prompt. */
export async function uploadBackup(s: BackupSession, payload: BackupPayload) {
  const { id, sealed } = sealPayload(s, payload);
  const issued = nextWriterIssued();
  const sig = writerSign(s, backupWriteMessage(s.owner, id, payload.deal, sha256Hex(sealed), issued));
  await api("PUT", `/backup/${s.owner}/${id}`, { ct: toB64(sealed), deal: payload.deal, issued, sig });
}

/** Authenticated list (writer signature); refuses a service whose key-check value differs. */
export async function fetchBackups(s: BackupSession): Promise<BackupPayload[]> {
  const issued = nextWriterIssued();
  const r = await api("GET", `/backup/${s.owner}`, undefined, { "x-latch-issued": String(issued), "x-latch-sig": writerSign(s, backupReadMessage(s.owner, issued)) });
  // Required, not optional: a service that omits it could be serving someone else's (or stale) backups.
  if (typeof r?.kcv !== "string") throw new Error("The backup service didn't confirm the key check, so nothing was restored.");
  if (r.kcv !== s.keys.kcv) throw new Error(KCV_MISMATCH);
  const out: BackupPayload[] = [];
  for (const b of Array.isArray(r.backups) ? r.backups : []) {
    try {
      out.push(openPayload(s, String(b.id), fromB64(String(b.ct))));
    } catch {
      /* not ours, tampered, or moved between slots: skip */
    }
  }
  return out;
}

// --------------------------------------------------------------- deletion

/** Delete every backup (or one) from the service. One wallet signature. */
export async function deleteServiceBackups(owner: string, signMessage: SignMessage, target = "all") {
  const issued = now();
  const sig = await sign(signMessage, backupDeleteMessage(owner, target, issued));
  return api("DELETE", target === "all" ? `/backup/${owner}` : `/backup/${owner}/${target}`, { issued, sig });
}

/** Delete everything the service keeps for this wallet. One wallet signature. */
export async function eraseServiceData(owner: string, signMessage: SignMessage): Promise<{ deleted: number }> {
  const issued = now();
  const sig = await sign(signMessage, eraseMessage(owner, issued));
  profileCache.delete(owner);
  return api("DELETE", "/me", { owner, issued, sig });
}

// ---------------------------------------------------------------- messages

/** Publish this wallet's messaging keys (one wallet signature, made by the caller). */
export async function putMessagingKeys(claim: MessagingKeyClaim): Promise<MessagingKeyClaim> {
  keysCache.delete(claim.owner);
  return api("PUT", "/keys", claim);
}

const keysCache = new Map<string, { at: number; c: MessagingKeyClaim | null }>();
export const forgetKeysOf = (wallet: string) => keysCache.delete(wallet);

/** A wallet's published messaging keys, re-verified (null: none, or the claim doesn't verify). */
export async function keysOf(wallet: string): Promise<MessagingKeyClaim | null> {
  if (!baseUrl) return null;
  const c = keysCache.get(wallet);
  // A wallet that has no keys yet may turn messages on any minute: remember "none" only briefly.
  if (c && Date.now() - c.at < (c.c ? 120_000 : 15_000)) return c.c;
  const r: MessagingKeyClaim | null = await api("GET", `/keys/${wallet}`).catch(() => null);
  const ok = r && r.owner === wallet && verifyMessagingKeyClaim(r) ? r : null;
  keysCache.set(wallet, { at: Date.now(), c: ok });
  return ok;
}

/** Turn messages off: nobody can send to this wallet afterwards. One wallet signature. */
export async function removeMessagingKeys(owner: string, signMessage: SignMessage): Promise<void> {
  const issued = now();
  keysCache.delete(owner);
  await api("DELETE", "/keys", { owner, issued, sig: await sign(signMessage, messagingKeyRemoveMessage(owner, issued)) });
}

/** One stored message, as the service keeps and returns it. */
export interface MsgRecord {
  thread: string;
  from: string;
  to: string;
  seq: number;
  ct: string; // base64 sealed message
  at: number; // service clock
  issued: number;
  sig: string; // sender's device signer over msgPostMessage
}

/** Silent: signed by the device signer, no wallet prompt. */
/**
 * Run a signer-lane request. Requests in one lane go one after another (the
 * service wants `issued` strictly increasing in arrival order, so two polls
 * racing each other would refuse one); on a 409 anyway, skip the counter ahead
 * and try once more.
 */
const laneQueue: Record<string, Promise<unknown>> = {};
async function inLane<T>(lane: string, fn: (issued: number) => Promise<T>): Promise<T> {
  const run = async () => {
    try {
      return await fn(nextIssued(lane));
    } catch (e: any) {
      if (e?.status !== 409) throw e;
      skipIssued(lane);
      return fn(nextIssued(lane));
    }
  };
  const next = (laneQueue[lane] ?? Promise.resolve()).then(run, run);
  laneQueue[lane] = next.catch(() => undefined);
  return next;
}

export async function postMessage(rec: Pick<MsgRecord, "thread" | "from" | "to" | "seq" | "ct">, signSk: Uint8Array): Promise<{ id: string; at: number; issued: number; sig: string }> {
  return inLane("m", async (issued) => {
    const sig = keySign(signSk, msgPostMessage(rec.from, rec.to, rec.thread, rec.seq, sha256Hex(fromB64(rec.ct)), issued));
    const r = await api("POST", "/msg", { ...rec, issued, sig });
    return { id: String(r.id), at: Number(r.at), issued, sig };
  });
}

/** This wallet's messages (both directions) since `since`, signed by the device signer. */
export async function fetchMessages(owner: string, since: number, signSk: Uint8Array): Promise<{ messages: MsgRecord[]; now: number; more: boolean }> {
  return inLane("m", async (issued) => {
    const r = await api("GET", `/msg/${owner}?since=${since}`, undefined, { "x-latch-issued": String(issued), "x-latch-sig": keySign(signSk, msgReadMessage(owner, since, issued)) });
    return { messages: Array.isArray(r?.messages) ? r.messages : [], now: Number(r?.now ?? 0), more: !!r?.more };
  });
}

/** The wallet's live-nudge socket URL (signer-signed in the query string; same replay lane as reads). */
export async function socketUrl(owner: string, signSk: Uint8Array): Promise<string> {
  if (!baseUrl) throw new Error("Service not configured");
  const issued = nextIssued("m");
  const sig = keySign(signSk, msgSocketMessage(owner, issued));
  return `${baseUrl.replace(/^http/, "ws")}/msg/${owner}/ws?issued=${issued}&sig=${encodeURIComponent(sig)}`;
}

/** Delete this wallet's messages on the service (one thread or all). One wallet signature. */
export async function deleteMessages(owner: string, signMessage: SignMessage, target = "all"): Promise<{ deleted: number }> {
  const issued = now();
  const sig = await sign(signMessage, msgDeleteMessage(owner, target, issued));
  return api("DELETE", target === "all" ? `/msg/${owner}` : `/msg/${owner}/${target}`, { issued, sig });
}

// ------------------------------------------------------------------ faucet

export async function requestTestTokens(address: string): Promise<{ signature: string; amount: number }> {
  return api("POST", "/faucet", { address });
}
