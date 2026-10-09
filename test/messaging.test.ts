/**
 * v0.13 → v0.17: the messaging routes of the optional service, with an
 * in-memory KV and in-memory Inbox Durable Objects. Keys are wallet-signed
 * claims; sends and reads are signed by the device signer the claim names;
 * each wallet's inbox keeps ciphertext and who wrote to whom.
 */
import { describe, expect, it } from "vitest";
import { eraseMessage, messagingKeyClaimMessage, messagingKeyRemoveMessage, msgDeleteMessage, msgSocketMessage, toB64 } from "../src/lib/claims";
import { MSG_SEALED_SIZES, dayOf, threadId } from "../src/lib/msgCrypto";
import { MSG_DAILY_LIMIT, MSG_PAGE, MSG_TTL } from "../worker/src/index";
import { InboxCore } from "../worker/src/inbox";
import { MemGuardStorage, MemKV, NOW, call, env, getMsgs, guardStore, inboxStore, msgKeys, msgSized, postMsg, postMsgAt, registerKeys, wallet } from "./svc";
import { ed25519 } from "@noble/curves/ed25519.js";

describe("messaging keys", () => {
  it("publishes a wallet-signed claim, serves it, refuses forgeries and replays, and removes it", async () => {
    const e = env();
    const w = wallet();
    const k = msgKeys(w);
    expect((await call(e, "GET", `/keys/${w.pk}`)).status).toBe(404);
    expect((await registerKeys(e, w, k, NOW)).status).toBe(200);
    const got = await call(e, "GET", `/keys/${w.pk}`);
    expect(got.body).toMatchObject({ owner: w.pk, enc: k.encPk, signer: k.signPk, issued: NOW });
    expect((e.KV as MemKV).ttl.get(`mk:${w.pk}`)).toBe(400 * 86400);
    const other = wallet();
    expect((await call(e, "PUT", "/keys", { owner: w.pk, enc: k.encPk, signer: k.signPk, issued: NOW + 1, sig: other.sign(messagingKeyClaimMessage(w.pk, k.encPk, k.signPk, NOW + 1)) })).status).toBe(401);
    expect((await call(e, "PUT", "/keys", { owner: w.pk, enc: msgKeys(other).encPk, signer: k.signPk, issued: NOW + 1, sig: w.sign(messagingKeyClaimMessage(w.pk, k.encPk, k.signPk, NOW + 1)) })).status).toBe(401);
    expect((await registerKeys(e, w, k, NOW)).status).toBe(409); // replay
    expect((await registerKeys(e, w, k, NOW - 700)).status).toBe(400); // stale
    expect((await call(e, "DELETE", "/keys", { owner: w.pk, issued: NOW + 2, sig: w.sign(messagingKeyRemoveMessage(w.pk, NOW + 2)) })).status).toBe(200);
    expect((await call(e, "GET", `/keys/${w.pk}`)).status).toBe(404);
  });
});

describe("messages", () => {
  async function pair() {
    const e = env();
    const a = wallet();
    const b = wallet();
    const ka = msgKeys(a);
    const kb = msgKeys(b);
    await registerKeys(e, a, ka, NOW);
    await registerKeys(e, b, kb, NOW);
    return { e, a, b, ka, kb, kv: e.KV as MemKV };
  }

  it("a send lands in both inboxes at once (no eventual consistency), renews the sender's keys, and both parties can read it", async () => {
    const { e, a, b, ka, kb, kv } = await pair();
    const r = await postMsg(e, a, ka, b.pk, 0, msgSized(1), NOW + 1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{16}$/), at: NOW });
    const t = threadId(a.pk, b.pk);
    for (const w of [a, b]) {
      const store = inboxStore(e, w.pk)!;
      const [key, v] = [...store.m.entries()][0] as [string, any];
      expect(key).toBe(`msg:${String(NOW).padStart(10, "0")}:${r.body.id}`);
      expect(v.r).toMatchObject({ thread: t, from: a.pk, to: b.pk, seq: 0, ct: toB64(msgSized(1)), at: NOW, issued: NOW + 1, sig: expect.any(String) });
      expect(v.exp - NOW).toBe(MSG_TTL);
    }
    expect(kv.m.get(`mc:${a.pk}:${String(dayOf(NOW)).padStart(5, "0")}`)).toBe("1");
    // No plaintext anywhere on the service.
    for (const v of [...kv.m.values(), ...[...inboxStore(e, b.pk)!.m.values()].map((x) => JSON.stringify(x))]) expect(String(v)).not.toContain("hello");
    const forB = await getMsgs(e, b, kb, 0, NOW + 2);
    expect(forB.status).toBe(200);
    expect(forB.body.messages).toHaveLength(1);
    expect(forB.body.messages[0].from).toBe(a.pk);
    expect(forB.body.more).toBe(false);
    expect((await getMsgs(e, a, ka, 0, NOW + 2)).body.messages).toHaveLength(1);
    // Nobody else can read either inbox: the wrong signer, a replayed or stale read.
    expect((await getMsgs(e, b, ka, 0, NOW + 3)).status).toBe(401);
    expect((await getMsgs(e, b, kb, 0, NOW + 2)).status).toBe(409);
    expect((await getMsgs(e, b, kb, 0, NOW - 700)).status).toBe(401);
  });

  it("refuses sends without the recipient's keys, with the wrong signer, a wrong thread id, an odd size, stale or replayed", async () => {
    const { e, a, b, ka, kb } = await pair();
    const c = wallet();
    expect((await postMsg(e, a, ka, c.pk, 0, msgSized(1), NOW + 1)).status).toBe(404); // c never turned messages on
    expect((await postMsg(e, c, msgKeys(c), a.pk, 0, msgSized(1), NOW + 1)).status).toBe(403); // c has no keys registered
    expect((await postMsg(e, a, kb, b.pk, 0, msgSized(1), NOW + 1)).status).toBe(401); // signed with b's signer
    expect((await postMsg(e, a, ka, b.pk, 0, new Uint8Array(MSG_SEALED_SIZES[0] + 1), NOW + 1)).status).toBe(400);
    expect((await postMsg(e, a, ka, b.pk, 0, msgSized(1), NOW - 700)).status).toBe(400);
    expect((await call(e, "POST", "/msg", { from: a.pk, to: b.pk, thread: "0".repeat(32), seq: 0, ct: toB64(msgSized(1)), issued: NOW + 1, sig: "x" })).status).toBe(400);
    expect((await postMsg(e, a, ka, a.pk, 0, msgSized(1), NOW + 1)).status).toBe(400); // to self
    expect((await postMsg(e, a, ka, b.pk, 0, msgSized(1), NOW + 1)).status).toBe(200);
    expect((await postMsg(e, a, ka, b.pk, 1, msgSized(2), NOW + 1)).status).toBe(409); // same issued in the :m lane
    // The signer lane is separate from the wallet lane: a wallet action at the same time still works.
    expect((await call(e, "DELETE", "/keys", { owner: a.pk, issued: NOW + 1, sig: a.sign(messagingKeyRemoveMessage(a.pk, NOW + 1)) })).status).toBe(200);
  });

  it("reads since a time, pages at MSG_PAGE, and a full read returns everything oldest first", async () => {
    const { e, a, b, ka, kb } = await pair();
    const days = [NOW - 2 * 86400, NOW - 86400, NOW];
    for (const [i, at] of days.entries()) expect((await postMsgAt(e, a, ka, b.pk, i, msgSized(10 + i), at)).status).toBe(200);
    expect((await getMsgs(e, b, kb, 0, NOW + 1)).body.messages.map((m: any) => m.seq)).toEqual([0, 1, 2]);
    expect((await getMsgs(e, b, kb, NOW - 86400, NOW + 2)).body.messages.map((m: any) => m.seq)).toEqual([1, 2]);
    expect((await getMsgs(e, b, kb, NOW, NOW + 3)).body.messages.map((m: any) => m.seq)).toEqual([2]);
    // Paging: more than MSG_PAGE records since → `more`.
    const core = new InboxCore(inboxStore(e, b.pk)!);
    for (let i = 0; i < MSG_PAGE + 1; i++) await core.append(String(i).padStart(16, "0"), { thread: threadId(a.pk, b.pk), from: a.pk, to: b.pk, seq: 10 + i, ct: "", at: NOW + 5, issued: NOW + 5, sig: "" }, MSG_TTL, NOW + 5);
    const page = await getMsgs(e, b, kb, NOW + 5, NOW + 6);
    expect(page.body.more).toBe(true);
    expect(page.body.messages).toHaveLength(MSG_PAGE);
  });

  it("caps sends per wallet per day", async () => {
    const { e, a, b, ka, kv } = await pair();
    kv.m.set(`mc:${a.pk}:${String(dayOf(NOW)).padStart(5, "0")}`, String(MSG_DAILY_LIMIT));
    expect((await postMsg(e, a, ka, b.pk, 0, msgSized(1), NOW + 1)).status).toBe(429);
  });

  it("DELETE /msg removes the owner's copies and its sent records from the other party's inbox, per thread or all; wallet-signed", async () => {
    const { e, a, b, ka, kb } = await pair();
    const c = wallet();
    const kc = msgKeys(c);
    await registerKeys(e, c, kc, NOW);
    expect((await postMsg(e, a, ka, b.pk, 0, msgSized(1), NOW + 1)).status).toBe(200);
    expect((await postMsg(e, b, kb, a.pk, 0, msgSized(2), NOW + 1)).status).toBe(200);
    expect((await postMsg(e, a, ka, c.pk, 0, msgSized(3), NOW + 2)).status).toBe(200);
    const tab = threadId(a.pk, b.pk);
    const other = wallet();
    expect((await call(e, "DELETE", `/msg/${a.pk}/${tab}`, { issued: NOW + 3, sig: other.sign(msgDeleteMessage(a.pk, tab, NOW + 3)) })).status).toBe(401);
    const r = await call(e, "DELETE", `/msg/${a.pk}/${tab}`, { issued: NOW + 3, sig: a.sign(msgDeleteMessage(a.pk, tab, NOW + 3)) });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(3); // a's two copies in that thread + b's copy of what a sent
    // b's own record (b → a) stays with b; a no longer has it.
    expect((await getMsgs(e, b, kb, 0, NOW + 4)).body.messages.map((m: any) => m.from)).toEqual([b.pk]);
    expect((await getMsgs(e, a, ka, 0, NOW + 4)).body.messages.map((m: any) => m.to)).toEqual([c.pk]);
    expect((await call(e, "DELETE", `/msg/${a.pk}`, { issued: NOW + 5, sig: a.sign(msgDeleteMessage(a.pk, "all", NOW + 5)) })).body.deleted).toBe(2); // a's copy + c's copy
    expect(inboxStore(e, a.pk)!.m.size).toBe(0);
    expect((await getMsgs(e, c, kc, 0, NOW + 6)).body.messages).toEqual([]);
  });

  it("DELETE /me also removes keys and messages; the signer lane's replay guard stays", async () => {
    const { e, a, b, ka, kv } = await pair();
    await postMsg(e, a, ka, b.pk, 0, msgSized(1), NOW + 1);
    const r = await call(e, "DELETE", "/me", { owner: a.pk, issued: NOW + 2, sig: a.sign(eraseMessage(a.pk, NOW + 2)) });
    expect(r.body.deleted).toBe(4); // mk, own copy, the peer's copy, the day counter
    expect([...kv.m.keys()].filter((k) => k.includes(a.pk))).toEqual([]);
    expect(inboxStore(e, b.pk)!.m.size).toBe(0);
    expect(guardStore(e).m.has(`li:${a.pk}:m`)).toBe(true);
  });

  it("the live socket route checks the signer signature in the query string before upgrading", async () => {
    const { e, a, ka } = await pair();
    const sig = toB64(ed25519.sign(new TextEncoder().encode(msgSocketMessage(a.pk, NOW + 1)), ka.signSk));
    expect((await call(e, "GET", `/msg/${a.pk}/ws?issued=${NOW + 1}&sig=nope`)).status).toBe(401);
    expect((await call(e, "GET", `/msg/${a.pk}/ws?issued=${NOW + 1}&sig=${encodeURIComponent(sig)}`)).status).toBe(426); // valid, but no Upgrade header in a plain request
    expect((await call(e, "GET", `/msg/${a.pk}/ws?issued=${NOW + 1}&sig=${encodeURIComponent(sig)}`)).status).toBe(409); // replayed
    expect((await call(e, "GET", `/msg/${wallet().pk}/ws?issued=${NOW + 1}&sig=x`)).status).toBe(404);
  });

  it("InboxCore: expired records are invisible and swept; a duplicate append is a no-op", async () => {
    const s = new MemGuardStorage();
    const core = new InboxCore(s);
    const rec = { thread: "t", from: "a", to: "b", seq: 0, ct: "", at: 100, issued: 100, sig: "" };
    expect(await core.append("id1", rec, 10, 100)).toBe(true);
    expect(await core.append("id1", rec, 10, 100)).toBe(false);
    expect((await core.list(0, 10, 105)).messages).toHaveLength(1);
    expect((await core.list(0, 10, 111)).messages).toHaveLength(0);
    expect(await core.sweep(111)).toBe(1);
    expect(s.m.size).toBe(0);
  });
});
