/**
 * v0.13: the app's messaging client against the real Worker code (fetch is
 * routed into handle() with an in-memory KV). Two wallets turn messages on,
 * exchange text, and each side decrypts the other's; a changed peer key is
 * shown, not silently accepted; unread counts follow the open thread.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type Env } from "../worker/src/index";
import { APP_DOMAIN } from "../src/lib/config";
import { messagingKeyClaimMessage } from "../src/lib/claims";
import { threadId } from "../src/lib/msgCrypto";
import * as svc from "../src/lib/service";
import * as M from "../src/lib/messaging";
import { getLocal, updateLocal } from "../src/lib/store";
import { env, msgKeys, wallet } from "./svc";

let e: Env;
/** Both clocks (the client's Date.now and the service's `now`) move together. */
let clock = 1_790_000_000;
const advance = (s: number) => {
  clock += s;
  vi.setSystemTime(clock * 1000);
};

function route(e: Env) {
  return async (input: any, init?: RequestInit) => handle(new Request(String(input), init), e, clock);
}

function reset() {
  M._resetMessagingForTesting();
  updateLocal((d) => {
    d.msgEnabled = [];
    d.msgSigner = {};
    d.msgKcv = {};
    d.peerKeys = {};
    d.threads = {};
    d.msgSince = {};
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock * 1000);
  e = env();
  svc.setServiceUrlForTesting("https://svc.test");
  vi.stubGlobal("fetch", route(e));
  reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  svc.setServiceUrlForTesting(undefined);
});

/** Act as `w` on this device: unlock (and publish) its keys. */
async function become(w: ReturnType<typeof wallet>, prompts?: { n: number }) {
  M._resetMessagingForTesting();
  const counted = async (m: Uint8Array) => {
    if (prompts) prompts.n++;
    return w.signBytes(m);
  };
  await M.enableMessaging(w.pk, counted);
}

describe("enable", () => {
  it("first time: two signatures to check determinism plus one to publish; later sessions: one; the claim verifies", async () => {
    const a = wallet();
    const p = { n: 0 };
    await become(a, p);
    expect(p.n).toBe(3);
    expect(getLocal().msgEnabled).toEqual([a.pk]);
    expect(getLocal().msgSigner[a.pk]).toBe(msgKeys(a, APP_DOMAIN).signPk);
    expect((await svc.keysOf(a.pk))?.enc).toBe(msgKeys(a, APP_DOMAIN).encPk);
    p.n = 0;
    await become(a, p);
    expect(p.n).toBe(1);
    expect(M.messagingUnlocked(a.pk)).toBe(true);
    // A wallet that signs differently each time is refused with the messaging copy.
    const flaky = wallet();
    let i = 0;
    await expect(M.enableMessaging(flaky.pk, async (m) => (i++ ? wallet().signBytes(m) : flaky.signBytes(m)))).rejects.toThrow(M.NONDETERMINISTIC_MSG);
  });
});

describe("send and receive", () => {
  it("a → b text is sealed, stored as ciphertext, and decrypted only by b; b replies; both threads agree", async () => {
    const a = wallet();
    const b = wallet();
    await become(a);
    await become(b);
    await become(a);
    advance(1);
    const sent = await M.sendText(b.pk, "hello b");
    expect(sent.body.text).toBe("hello b");
    expect(sent.seq).toBe(0);
    expect(getLocal().threads[threadId(a.pk, b.pk)].messages).toHaveLength(1);
    // Nothing on the service says "hello".
    for (const v of (e.KV as any).m.values()) expect(String(v)).not.toContain("hello");
    // b polls on a fresh device: pins a's keys, verifies a's signature, decrypts.
    reset();
    await become(b);
    advance(1);
    expect(await M.pollMessages(b.pk)).toBe(1);
    const t = getLocal().threads[threadId(a.pk, b.pk)];
    expect(t.peer).toBe(a.pk);
    expect(t.unread).toBe(1);
    expect(t.messages[0].body).toMatchObject({ kind: "text", text: "hello b" });
    expect(getLocal().peerKeys[a.pk].enc).toBe(msgKeys(a, APP_DOMAIN).encPk);
    expect(M.verifyStored(t.messages[0], getLocal().peerKeys[a.pk].signer)).toBe(true);
    // Reading the open thread clears unread; a reply goes back with its own seq.
    M.setOpenThread(threadId(a.pk, b.pk));
    expect(getLocal().threads[threadId(a.pk, b.pk)].unread).toBe(0);
    advance(1);
    const reply = await M.sendText(a.pk, "hi a");
    expect(reply.seq).toBe(0);
    expect(getLocal().threads[threadId(a.pk, b.pk)].mySeq).toBe(1);
    // a, on its own fresh device, gets both (its own send re-filed as sent, b's as unread) and its seq counter catches up.
    reset();
    await become(a);
    advance(1);
    expect(await M.pollMessages(a.pk)).toBe(2);
    const ta = getLocal().threads[threadId(a.pk, b.pk)];
    expect(ta.messages.map((m) => m.body.text)).toEqual(["hello b", "hi a"]);
    expect(ta.unread).toBe(1);
    expect(ta.mySeq).toBe(1);
    expect(M.unreadTotal(getLocal().threads)).toBe(1);
    // Polling again adds nothing (dedupe by id).
    advance(1);
    expect(await M.pollMessages(a.pk)).toBe(0);
  });

  it("sending to a wallet without keys fails plainly; a changed peer key blocks sending until trusted", async () => {
    const a = wallet();
    const b = wallet();
    await become(a);
    await expect(M.sendText(b.pk, "x")).rejects.toThrow(/haven't turned on messages/);
    await become(b);
    await become(a);
    advance(1);
    await M.sendText(b.pk, "x");
    // b re-publishes different keys (another device, different derivation): a sees "changed".
    const other = msgKeys(wallet(), APP_DOMAIN);
    advance(1);
    const issued = clock;
    await svc.putMessagingKeys({ owner: b.pk, enc: other.encPk, signer: other.signPk, issued, sig: b.sign(messagingKeyClaimMessage(b.pk, other.encPk, other.signPk, issued)) });
    svc.forgetKeysOf(b.pk);
    const st = await M.peerKeysFor(b.pk);
    expect(st.status).toBe("changed");
    await expect(M.sendText(b.pk, "y")).rejects.toThrow(/key changed/);
    if (st.status === "changed") M.trustPeerKeys(b.pk, st.keys);
    expect((await M.peerKeysFor(b.pk)).status).toBe("ok");
  });

  it("deleteThread removes the conversation here and this wallet's records on the service", async () => {
    const a = wallet();
    const b = wallet();
    await become(a);
    await become(b);
    await become(a);
    advance(1);
    await M.sendText(b.pk, "gone soon");
    advance(1);
    await M.deleteThread(a.pk, b.pk, a.signBytes);
    expect(getLocal().threads[threadId(a.pk, b.pk)]).toBeUndefined();
    expect([...(e.KV as any).m.keys()].filter((k: string) => k.startsWith("m:"))).toEqual([]);
  });
});
