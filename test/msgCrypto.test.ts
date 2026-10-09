/** v0.13: messaging key derivation, thread keys and the sealed message format. */
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b58decode, messagingKeyClaimMessage, verifyMessagingKeyClaim } from "../src/lib/claims";
import {
  MSG_BODY_FORMAT,
  MSG_PAD_BUCKETS,
  MSG_SEALED_SIZES,
  MSG_TEXT_MAX,
  bodyProblem,
  decodeBody,
  deriveMessagingKeys,
  encodeBody,
  messagingKeyMessage,
  msgId,
  openMsg,
  sealMsg,
  threadId,
  threadKey,
  type MsgBody,
} from "../src/lib/msgCrypto";
import { msgKeys, wallet } from "./svc";

const D = "dial.test";

describe("messaging keys", () => {
  it("derive from one signature, bound to domain, cluster and owner; encryption and signing keys differ", () => {
    const w = wallet();
    const sig = ed25519.sign(new TextEncoder().encode(messagingKeyMessage(D, w.pk)), w.sk);
    const a = deriveMessagingKeys(sig, D, w.pk);
    const b = deriveMessagingKeys(sig, D, w.pk);
    expect(a.encPk).toBe(b.encPk);
    expect(a.signPk).toBe(b.signPk);
    expect(a.kcv).toBe(b.kcv);
    expect(a.encPk).not.toBe(a.signPk);
    expect(b58decode(a.encPk)).toHaveLength(32);
    expect(deriveMessagingKeys(sig, "other.test", w.pk).encPk).not.toBe(a.encPk);
    expect(deriveMessagingKeys(sig, D, wallet().pk).signPk).not.toBe(a.signPk);
    expect(messagingKeyMessage(D, w.pk)).toMatch(/^Latch messaging key v1\ndomain: dial\.test\ncluster: devnet\nowner: /);
    expect(messagingKeyMessage(D, w.pk)).toMatch(/cannot move any money/);
  });
  it("the published claim verifies only with the wallet's signature and matching keys", () => {
    const w = wallet();
    const k = msgKeys(w);
    const claim = { owner: w.pk, enc: k.encPk, signer: k.signPk, issued: 1, sig: w.sign(messagingKeyClaimMessage(w.pk, k.encPk, k.signPk, 1)) };
    expect(verifyMessagingKeyClaim(claim)).toBe(true);
    expect(verifyMessagingKeyClaim({ ...claim, enc: msgKeys(wallet()).encPk })).toBe(false);
    expect(verifyMessagingKeyClaim({ ...claim, owner: wallet().pk })).toBe(false);
    expect(verifyMessagingKeyClaim({ ...claim, enc: "not-base58!" })).toBe(false);
  });
});

describe("thread key and sealed messages", () => {
  it("both sides derive the same thread key and id; a third wallet derives neither", () => {
    const a = wallet();
    const b = wallet();
    const c = wallet();
    const ka = msgKeys(a);
    const kb = msgKeys(b);
    const kc = msgKeys(c);
    expect(threadId(a.pk, b.pk)).toBe(threadId(b.pk, a.pk));
    expect(threadId(a.pk, b.pk)).toMatch(/^[0-9a-f]{32}$/);
    expect(threadId(a.pk, c.pk)).not.toBe(threadId(a.pk, b.pk));
    const fromA = threadKey(ka.encSk, kb.encPk, D, a.pk, b.pk);
    const fromB = threadKey(kb.encSk, ka.encPk, D, b.pk, a.pk);
    expect(Buffer.from(fromA).toString("hex")).toBe(Buffer.from(fromB).toString("hex"));
    expect(Buffer.from(threadKey(kc.encSk, ka.encPk, D, c.pk, a.pk)).toString("hex")).not.toBe(Buffer.from(fromA).toString("hex"));
    expect(Buffer.from(threadKey(ka.encSk, kb.encPk, "other.test", a.pk, b.pk)).toString("hex")).not.toBe(Buffer.from(fromA).toString("hex"));
  });
  it("seals to a standard size per bucket and opens only with the same thread, sender and seq", () => {
    const a = wallet();
    const b = wallet();
    const key = threadKey(msgKeys(a).encSk, msgKeys(b).encPk, D, a.pk, b.pk);
    const t = threadId(a.pk, b.pk);
    for (const [i, bucket] of MSG_PAD_BUCKETS.entries()) {
      const pt = new Uint8Array(bucket - 4).fill(7);
      const ct = sealMsg(key, t, a.pk, i, pt);
      expect(ct.length).toBe(MSG_SEALED_SIZES[i]);
      expect(MSG_SEALED_SIZES).toContain(ct.length);
      expect(openMsg(key, t, a.pk, i, ct)).toEqual(pt);
      expect(() => openMsg(key, t, b.pk, i, ct)).toThrow();
      expect(() => openMsg(key, t, a.pk, i + 1, ct)).toThrow();
      expect(() => openMsg(key, "0".repeat(32), a.pk, i, ct)).toThrow();
      expect(() => openMsg(threadKey(msgKeys(wallet()).encSk, msgKeys(b).encPk, D, a.pk, b.pk), t, a.pk, i, ct)).toThrow();
    }
    const short = sealMsg(key, t, a.pk, 0, new TextEncoder().encode("ok"));
    expect(short.length).toBe(MSG_SEALED_SIZES[0]);
    expect(msgId(short)).toMatch(/^[0-9a-f]{16}$/);
    expect(() => sealMsg(key, t, a.pk, 0, new Uint8Array(MSG_PAD_BUCKETS[3]))).toThrow(/too large/);
  });
});

describe("message body", () => {
  const ok: MsgBody = { v: MSG_BODY_FORMAT, kind: "text", text: "hi", sentAt: 1 };
  it("round-trips and refuses unknown kinds, fields, oversize text and empty text", () => {
    expect(decodeBody(encodeBody(ok))).toEqual(ok);
    expect(bodyProblem(ok)).toBeNull();
    expect(bodyProblem({ ...ok, kind: "sticker" })).toMatch(/kind/);
    expect(bodyProblem({ ...ok, extra: 1 })).toMatch(/unknown field/);
    expect(bodyProblem({ ...ok, text: "x".repeat(MSG_TEXT_MAX + 1) })).toMatch(/too long/);
    expect(bodyProblem({ ...ok, text: "   " })).toMatch(/empty/);
    expect(bodyProblem({ ...ok, v: "latch-msg@2" })).toMatch(/format/);
    expect(bodyProblem({ v: MSG_BODY_FORMAT, kind: "accept", sentAt: 1 })).toMatch(/ref/);
    expect(bodyProblem({ v: MSG_BODY_FORMAT, kind: "accept", ref: "ab".repeat(32), sentAt: 1 })).toBeNull();
    expect(bodyProblem({ v: MSG_BODY_FORMAT, kind: "proposal", ref: "ab".repeat(16), proposal: { x: 1 }, sentAt: 1 })).toBeNull();
    expect(bodyProblem({ v: MSG_BODY_FORMAT, kind: "proposal", ref: "ab".repeat(16), proposal: "x".repeat(9000), sentAt: 1 })).toMatch(/large/);
    expect(() => decodeBody(new TextEncoder().encode("[]"))).toThrow();
  });
});
