/** Shared helpers for the service (worker) tests: in-memory KV, throwaway wallets, request runner. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { handle, type KV, type Env } from "../worker/src/index";
import { Guards, type GuardStorage, type GuardsNamespace } from "../worker/src/guards";
import { Inbox, type InboxNamespace } from "../worker/src/inbox";
import { b58encode, backupReadMessage, backupWriteMessage, backupWriterMessage, messagingKeyClaimMessage, msgPostMessage, msgReadMessage, sha256Hex, toB64 } from "../src/lib/claims";
import { SEALED_SIZES } from "../src/lib/backupCrypto";
import { MSG_SEALED_SIZES, deriveMessagingKeys, messagingKeyMessage, threadId, type MessagingKeys } from "../src/lib/msgCrypto";

export class MemKV implements KV {
  m = new Map<string, string>();
  ttl = new Map<string, number | undefined>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string, opts?: { expirationTtl?: number }) {
    this.m.set(k, v);
    this.ttl.set(k, opts?.expirationTtl);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
    const all = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const keys = all.slice(start, start + limit).map((name) => ({ name }));
    const done = start + limit >= all.length;
    return { keys, list_complete: done, cursor: done ? undefined : String(start + limit) };
  }
}

export function wallet() {
  const sk = ed25519.utils.randomSecretKey();
  const pk = b58encode(ed25519.getPublicKey(sk));
  return {
    pk,
    sk,
    sign: (msg: string) => toB64(ed25519.sign(new TextEncoder().encode(msg), sk)),
    /** A wallet-adapter-style signMessage (Ed25519 is deterministic). */
    signBytes: async (m: Uint8Array) => ed25519.sign(m, sk),
  };
}

/** Register `writer` for `owner` (v2 message, with a key-check value). */
export function registerWriter(e: Env, owner: ReturnType<typeof wallet>, writer: ReturnType<typeof wallet>, t: number, kcv = "0".repeat(32)) {
  return call(e, "POST", `/backup/${owner.pk}/writer`, { writer: writer.pk, kcv, issued: t, sig: owner.sign(backupWriterMessage(owner.pk, writer.pk, kcv, t)) });
}

/** Upload a (padded-size) ciphertext under a 64-hex id, signed by the writer. */
export function putBackup(e: Env, owner: ReturnType<typeof wallet>, writer: ReturnType<typeof wallet>, id: string, deal: string, ct: Uint8Array, t: number) {
  return call(e, "PUT", `/backup/${owner.pk}/${id}`, { ct: toB64(ct), deal, issued: t, sig: writer.sign(backupWriteMessage(owner.pk, id, deal, sha256Hex(ct), t)) });
}

/** List backups with a writer-signed read. */
export function getBackups(e: Env, owner: ReturnType<typeof wallet>, writer: ReturnType<typeof wallet>, t: number) {
  return call(e, "GET", `/backup/${owner.pk}`, undefined, { "x-latch-issued": String(t), "x-latch-sig": writer.sign(backupReadMessage(owner.pk, t)) });
}

export const sized = (fill: number) => new Uint8Array(SEALED_SIZES[0]).fill(fill);

// ---------------------------------------------------------------- messages

/** A wallet's messaging identity, derived exactly as the app does (one signature over the domain-bound message). */
export function msgKeys(w: ReturnType<typeof wallet>, domain = "dial.test"): MessagingKeys {
  return deriveMessagingKeys(ed25519.sign(new TextEncoder().encode(messagingKeyMessage(domain, w.pk)), w.sk), domain, w.pk);
}
/** Publish `keys` for `w` (wallet-signed claim). */
export function registerKeys(e: Env, w: ReturnType<typeof wallet>, keys: MessagingKeys, t: number) {
  return call(e, "PUT", "/keys", { owner: w.pk, enc: keys.encPk, signer: keys.signPk, issued: t, sig: w.sign(messagingKeyClaimMessage(w.pk, keys.encPk, keys.signPk, t)) });
}
const signerSign = (keys: MessagingKeys, msg: string) => toB64(ed25519.sign(new TextEncoder().encode(msg), keys.signSk));
/** Send a (padded-size) ciphertext from `from` to `to`, signed by the sender's device signer. */
export function postMsg(e: Env, from: ReturnType<typeof wallet>, keys: MessagingKeys, to: string, seq: number, ct: Uint8Array, t: number) {
  const thread = threadId(from.pk, to);
  return call(e, "POST", "/msg", { from: from.pk, to, thread, seq, ct: toB64(ct), issued: t, sig: signerSign(keys, msgPostMessage(from.pk, to, thread, seq, sha256Hex(ct), t)) });
}
/** Same as postMsg, but the service's clock is `at` (the record lands on that day). */
export async function postMsgAt(e: Env, from: ReturnType<typeof wallet>, keys: MessagingKeys, to: string, seq: number, ct: Uint8Array, at: number) {
  const thread = threadId(from.pk, to);
  const body = { from: from.pk, to, thread, seq, ct: toB64(ct), issued: at, sig: signerSign(keys, msgPostMessage(from.pk, to, thread, seq, sha256Hex(ct), at)) };
  const res = await handle(new Request("https://svc.test/msg", { method: "POST", body: JSON.stringify(body) }), e, at);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
/** Fetch messages for `w` since `since` (signer-signed read). */
export function getMsgs(e: Env, w: ReturnType<typeof wallet>, keys: MessagingKeys, since: number, t: number) {
  return call(e, "GET", `/msg/${w.pk}?since=${since}`, undefined, { "x-latch-issued": String(t), "x-latch-sig": signerSign(keys, msgReadMessage(w.pk, since, t)) });
}
export const msgSized = (fill: number) => new Uint8Array(MSG_SEALED_SIZES[0]).fill(fill);

export const NOW = 1_790_000_000;
export const BOT = "123456:TEST-TOKEN";
export function env(extra: Partial<Env> = {}): Env {
  return { KV: new MemKV(), GUARDS: memGuards(), INBOX: memInbox(), TELEGRAM_BOT_TOKEN: BOT, dealHasOwner: async () => true, ...extra };
}
export async function call(e: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handle(new Request(`https://svc.test${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers }), e, NOW);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
export function tgAuth(fields: Record<string, string | number>) {
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const hash = bytesToHex(hmac(sha256, sha256(new TextEncoder().encode(BOT)), new TextEncoder().encode(dcs)));
  return { ...fields, hash } as any;
}


/** In-memory Durable Object storage. */
export class MemGuardStorage implements GuardStorage {
  m = new Map<string, any>();
  alarm: number | null = null;
  async get<T>(k: string) {
    return this.m.get(k) as T | undefined;
  }
  async put<T>(k: string, v: T) {
    this.m.set(k, structuredClone(v));
  }
  async delete(k: string) {
    return this.m.delete(k);
  }
  async list<T>(opts: { prefix?: string } = {}) {
    return new Map([...this.m].filter(([k]) => !opts.prefix || k.startsWith(opts.prefix))) as Map<string, T>;
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async getAlarm() {
    return this.alarm;
  }
}

/**
 * The real Guards class behind a fake namespace. Requests to the one
 * instance are processed strictly one after another, as the Durable Object
 * runtime does (its input gate holds other events while storage is awaited).
 */
export function memGuards(): GuardsNamespace & { storage: MemGuardStorage; instance: Guards } {
  const storage = new MemGuardStorage();
  const instance = new Guards({ storage });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    storage,
    instance,
    idFromName: (n: string) => n,
    get: () => ({
      fetch: (req: Request) => {
        const run = queue.then(() => instance.fetch(req));
        queue = run.catch(() => undefined);
        return run;
      },
    }),
  };
}

/** Guard records (tgu:, li:, f:) live in the Durable Object, not KV. */
export const guardStore = (e: Env) => (e.GUARDS as ReturnType<typeof memGuards>).storage;

/** The real Inbox class behind a fake namespace: one instance per wallet, each processing requests one after another. */
export function memInbox(): InboxNamespace & { instances: Map<string, { storage: MemGuardStorage; instance: Inbox; queue: Promise<unknown> }> } {
  const instances = new Map<string, { storage: MemGuardStorage; instance: Inbox; queue: Promise<unknown> }>();
  const slotFor = (name: string) => {
    if (!instances.has(name)) {
      const storage = new MemGuardStorage();
      instances.set(name, { storage, instance: new Inbox({ storage }), queue: Promise.resolve() });
    }
    return instances.get(name)!;
  };
  return {
    instances,
    idFromName: (n: string) => n,
    get: (id: unknown) => ({
      fetch: (req: Request) => {
        const slot = slotFor(String(id));
        const run = slot.queue.then(() => slot.instance.fetch(req));
        slot.queue = run.catch(() => undefined);
        return run;
      },
    }),
  };
}
/** Inbox storage of one wallet in tests (undefined until that wallet's inbox was touched). */
export const inboxStore = (e: Env, wallet: string) => (e.INBOX as ReturnType<typeof memInbox>).instances.get(wallet)?.storage;
