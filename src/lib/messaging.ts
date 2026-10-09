/**
 * Messages between wallets (v0.13): the session, peers' keys, send and poll.
 *
 * The messaging identity is derived from one wallet signature each session
 * (two the first time on a device, to prove the wallet signs deterministically)
 * and kept in memory only, like backup keys. Peers' keys are pinned on first
 * use: a changed key blocks sending until the user confirms it. Every stored
 * message keeps the service record (ciphertext + the sender's signature), so a
 * conversation can later be exported with proof of who sent what.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { APP_DOMAIN } from "./config";
import { KCV_MISMATCH, deterministicSignature } from "./backupCrypto";
import { fromB64, messagingKeyClaimMessage, msgPostMessage, sha256Hex, toB64, verifySig, type MessagingKeyClaim } from "./claims";
import { MSG_BODY_FORMAT, decodeBody, deriveMessagingKeys, encodeBody, messagingKeyMessage, msgId, openMsg, sealMsg, threadId, threadKey, type MessagingKeys, type MsgBody } from "./msgCrypto";
import { deleteMessages, fetchMessages, forgetKeysOf, keysOf, postMessage, putMessagingKeys, removeMessagingKeys, serviceAvailable, socketUrl, type MsgRecord, type SignMessage } from "./service";
import { getLocal, updateLocal, type PeerKeys, type StoredMsg, type Thread } from "./store";

export const NONDETERMINISTIC_MSG = "This wallet doesn't sign the same message the same way twice, so it can't recreate a messaging key. Messages aren't available with this wallet.";
/** Messages kept per conversation on this device (oldest dropped first). */
export const THREAD_CAP = 500;
/** Polls look back this far past the last poll so a record that arrived late is still picked up. */
const POLL_OVERLAP = 120;

interface MsgSession {
  owner: string;
  keys: MessagingKeys;
}
let session: MsgSession | null = null;
/** The thread currently on screen: its new messages don't count as unread. */
let openThread: string | null = null;

export const messagingUnlocked = (owner: string | undefined) => !!owner && session?.owner === owner;
export const messagingOn = (owner: string | undefined) => !!owner && getLocal().msgEnabled.includes(owner);
export const myMessagingKeys = () => session?.keys ?? null;

/** Unlock: one wallet signature (two the first time on a device). A different key than before is refused. */
export async function unlockMessaging(owner: string, signMessage: SignMessage): Promise<MessagingKeys> {
  if (session?.owner === owner) return session.keys;
  const msg = messagingKeyMessage(APP_DOMAIN, owner);
  const known = getLocal().msgKcv[owner];
  let sig: Uint8Array;
  try {
    sig = known ? await signMessage(new TextEncoder().encode(msg)) : await deterministicSignature(signMessage, msg);
  } catch (e: any) {
    throw /same way twice/.test(String(e?.message)) ? new Error(NONDETERMINISTIC_MSG) : e;
  }
  const keys = deriveMessagingKeys(sig, APP_DOMAIN, owner);
  if (known && keys.kcv !== known) throw new Error(KCV_MISMATCH);
  if (!known) updateLocal((d) => void (d.msgKcv[owner] = keys.kcv));
  session = { owner, keys };
  return keys;
}

/** Turn messages on: unlock, then publish the keys (one more wallet signature, once per device). */
export async function enableMessaging(owner: string, signMessage: SignMessage): Promise<void> {
  if (!serviceAvailable()) throw new Error("Messages need the Latch service.");
  const keys = await unlockMessaging(owner, signMessage);
  const d = getLocal();
  if (d.msgEnabled.includes(owner) && d.msgSigner[owner] === keys.signPk) return;
  const issued = Math.floor(Date.now() / 1000);
  const sig = toB64(await signMessage(new TextEncoder().encode(messagingKeyClaimMessage(owner, keys.encPk, keys.signPk, issued))));
  await putMessagingKeys({ owner, enc: keys.encPk, signer: keys.signPk, issued, sig });
  updateLocal((x) => {
    if (!x.msgEnabled.includes(owner)) x.msgEnabled.push(owner);
    x.msgSigner[owner] = keys.signPk;
  });
}

/** Turn messages off on the service; conversations stay on this device. One wallet signature. */
export async function disableMessaging(owner: string, signMessage: SignMessage): Promise<void> {
  await removeMessagingKeys(owner, signMessage);
  updateLocal((d) => void (d.msgEnabled = d.msgEnabled.filter((w) => w !== owner)));
  if (session?.owner === owner) {
    session = null;
    disconnectLive();
  }
}

export type PeerStatus = { status: "none" } | { status: "ok"; keys: PeerKeys } | { status: "changed"; keys: PeerKeys; pinned: PeerKeys };

/** A peer's published keys, checked against the pin made on first use. */
export async function peerKeysFor(wallet: string): Promise<PeerStatus> {
  const c = await keysOf(wallet);
  const pinned = getLocal().peerKeys[wallet];
  if (!c) return pinned ? { status: "ok", keys: pinned } : { status: "none" };
  const keys: PeerKeys = { enc: c.enc, signer: c.signer, issued: c.issued };
  if (!pinned) {
    updateLocal((d) => void (d.peerKeys[wallet] = keys));
    return { status: "ok", keys };
  }
  if (pinned.enc === keys.enc && pinned.signer === keys.signer) return { status: "ok", keys: pinned };
  return { status: "changed", keys, pinned };
}

/** The user confirmed a peer's new keys out of band. */
export function trustPeerKeys(wallet: string, keys: PeerKeys): void {
  updateLocal((d) => void (d.peerKeys[wallet] = keys));
  forgetKeysOf(wallet);
}

function append(thread: string, peer: string, m: StoredMsg, countUnread: boolean): void {
  updateLocal((d) => {
    const t: Thread = d.threads[thread] ?? { peer, lastAt: 0, mySeq: 0, unread: 0, messages: [] };
    if (t.messages.some((x) => x.id === m.id)) return;
    t.messages.push(m);
    t.messages.sort((a, b) => a.at - b.at || a.from.localeCompare(b.from) || a.seq - b.seq);
    if (t.messages.length > THREAD_CAP) t.messages.splice(0, t.messages.length - THREAD_CAP);
    t.lastAt = Math.max(t.lastAt, m.at);
    if (countUnread && openThread !== thread) t.unread++;
    d.threads[thread] = t;
  });
}

/** Send any body to a peer whose keys are pinned and current. */
export async function sendBody(peer: string, body: MsgBody): Promise<StoredMsg> {
  if (!session) throw new Error("Messages are locked.");
  const me = session.owner;
  const p = await peerKeysFor(peer);
  if (p.status === "none") throw new Error("They haven't turned on messages yet.");
  if (p.status === "changed") throw new Error("Their messaging key changed. Confirm it with them before sending.");
  const thread = threadId(me, peer);
  const seq = getLocal().threads[thread]?.mySeq ?? 0;
  const key = threadKey(session.keys.encSk, p.keys.enc, APP_DOMAIN, me, peer);
  const sealed = sealMsg(key, thread, me, seq, encodeBody(body));
  const ct = toB64(sealed);
  const r = await postMessage({ thread, from: me, to: peer, seq, ct }, session.keys.signSk);
  const m: StoredMsg = { id: r.id || msgId(sealed), from: me, to: peer, seq, at: r.at, body, ct, issued: r.issued, sig: r.sig };
  updateLocal((d) => {
    const t = d.threads[thread] ?? { peer, lastAt: 0, mySeq: 0, unread: 0, messages: [] };
    t.mySeq = seq + 1;
    d.threads[thread] = t;
  });
  append(thread, peer, m, false);
  return m;
}

export const sendText = (peer: string, text: string) => sendBody(peer, { v: MSG_BODY_FORMAT, kind: "text", text: text.trim(), sentAt: Math.floor(Date.now() / 1000) });

/**
 * Pull new records for the unlocked wallet, verify each sender's signature
 * against their pinned keys, decrypt, and file them. Unknown senders' keys are
 * fetched and pinned on first contact. Returns the number of new messages.
 */
export async function pollMessages(owner: string): Promise<number> {
  if (!session || session.owner !== owner || !serviceAvailable()) return 0;
  const me = owner;
  let since = Math.max(0, (getLocal().msgSince[owner] ?? 0) - POLL_OVERLAP);
  let added = 0;
  for (let page = 0; page < 10; page++) {
    const r = await fetchMessages(owner, since, session.keys.signSk);
    let lastAt = since;
    for (const rec of r.messages) {
      lastAt = Math.max(lastAt, rec.at);
      const m = await fileRecord(me, rec);
      if (m) added++;
    }
    if (!r.more) {
      updateLocal((d) => void (d.msgSince[owner] = r.now || lastAt));
      break;
    }
    since = lastAt;
  }
  return added;
}

async function fileRecord(me: string, rec: MsgRecord): Promise<StoredMsg | null> {
  if (!session) return null;
  const peer = rec.from === me ? rec.to : rec.from;
  if (rec.thread !== threadId(me, peer)) return null;
  const thread = rec.thread;
  const sealed = fromB64(rec.ct);
  const id = msgId(sealed);
  if (getLocal().threads[thread]?.messages.some((x) => x.id === id)) return null;
  // Who signed it: my own device key for my sends, the peer's pinned key otherwise.
  let signer: string;
  let peerEnc: string;
  if (rec.from === me) {
    signer = session.keys.signPk;
    const p = await peerKeysFor(peer);
    if (p.status === "none") return null;
    peerEnc = p.keys.enc;
  } else {
    const p = await peerKeysFor(peer);
    if (p.status === "none") return null;
    // A sender whose key changed: file nothing until the user trusts the new key (the record is re-fetched later).
    if (p.status === "changed") return null;
    signer = p.keys.signer;
    peerEnc = p.keys.enc;
  }
  if (!verifySig(msgPostMessage(rec.from, rec.to, rec.thread, rec.seq, sha256Hex(sealed), rec.issued), rec.sig, signer)) return null;
  let body: MsgBody;
  try {
    body = decodeBody(openMsg(threadKey(session.keys.encSk, peerEnc, APP_DOMAIN, me, peer), thread, rec.from, rec.seq, sealed));
  } catch {
    return null; // not for this key, tampered, or a format this build doesn't know
  }
  const m: StoredMsg = { id, from: rec.from, to: rec.to, seq: rec.seq, at: rec.at, body, ct: rec.ct, issued: rec.issued, sig: rec.sig };
  if (rec.from === me) updateLocal((d) => {
    const t = d.threads[thread] ?? { peer, lastAt: 0, mySeq: 0, unread: 0, messages: [] };
    t.mySeq = Math.max(t.mySeq, rec.seq + 1);
    d.threads[thread] = t;
  });
  append(thread, peer, m, rec.from !== me);
  return m;
}

export function setOpenThread(thread: string | null): void {
  openThread = thread;
  if (thread) markRead(thread);
}
export function markRead(thread: string): void {
  if (getLocal().threads[thread]?.unread) updateLocal((d) => void (d.threads[thread].unread = 0));
}
export const unreadTotal = (threads: Record<string, Thread>) => Object.values(threads).reduce((n, t) => n + t.unread, 0);

/** Delete a conversation on this device and this wallet's records of it on the service (one wallet signature). */
export async function deleteThread(owner: string, peer: string, signMessage: SignMessage): Promise<void> {
  const thread = threadId(owner, peer);
  if (serviceAvailable()) await deleteMessages(owner, signMessage, thread);
  updateLocal((d) => void delete d.threads[thread]);
}

/** Verify a stored message's signature again (used by the export and the UI's "signed" mark). */
export function verifyStored(m: StoredMsg, signer: string): boolean {
  return verifySig(msgPostMessage(m.from, m.to, threadId(m.from, m.to), m.seq, sha256Hex(fromB64(m.ct)), m.issued), m.sig, signer);
}

// ------------------------------------------------------------ live nudges

let socket: WebSocket | null = null;
let socketOwner: string | null = null;
let reconnectIn = 5000;
let reconnectTimer = 0;
let pingTimer = 0;

/**
 * Keep one WebSocket to the wallet's inbox while messages are unlocked. It
 * carries a one-word "new" nudge; the app then fetches as it always does, so
 * nothing changes about what the service can read. Reconnects with backoff;
 * polling stays as the fallback.
 */
export function connectLive(owner: string): void {
  if (!session || session.owner !== owner || !serviceAvailable() || typeof WebSocket === "undefined") return;
  if (socket && socketOwner === owner && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  disconnectLive();
  socketOwner = owner;
  const signSk = session.keys.signSk;
  socketUrl(owner, signSk)
    .then((url) => {
      if (!session || session.owner !== owner) return;
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        reconnectIn = 5000;
        pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30000);
        pollMessages(owner).catch(() => {});
      };
      ws.onmessage = (ev) => {
        if (ev.data === "new") pollMessages(owner).catch(() => {});
      };
      ws.onclose = () => {
        window.clearInterval(pingTimer);
        if (socket === ws) socket = null;
        if (session?.owner === owner && socketOwner === owner) {
          reconnectTimer = window.setTimeout(() => connectLive(owner), reconnectIn);
          reconnectIn = Math.min(reconnectIn * 2, 60000);
        }
      };
      ws.onerror = () => ws.close();
    })
    .catch(() => {
      reconnectTimer = window.setTimeout(() => connectLive(owner), reconnectIn);
      reconnectIn = Math.min(reconnectIn * 2, 60000);
    });
}

export function disconnectLive(): void {
  window.clearTimeout(reconnectTimer);
  window.clearInterval(pingTimer);
  socketOwner = null;
  const ws = socket;
  socket = null;
  try {
    ws?.close();
  } catch {
    /* already closed */
  }
}
export const liveConnected = () => !!socket && socket.readyState === WebSocket.OPEN;

/** Tests only. */
export function _resetMessagingForTesting(): void {
  session = null;
  openThread = null;
  if (typeof window !== "undefined") disconnectLive();
}
export const _signerOf = (keys: MessagingKeys) => (m: string) => toB64(ed25519.sign(new TextEncoder().encode(m), keys.signSk));
