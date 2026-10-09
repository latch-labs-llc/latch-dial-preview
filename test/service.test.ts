/**
 * Optional service (worker/) — every route, with an in-memory KV. Wallet
 * signatures are real Ed25519 signatures from fresh throwaway keys.
 */
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { handle, type KV, type Env } from "../worker/src/index";
import {
  b58encode,
  backupWriterMessage,
  handleClaimMessage,
  handleReleaseMessage,
  sha256Hex,
  telegramLinkMessage,
  toB64,
  verifyHandleClaim,
} from "../src/lib/claims";

import { BOT, MemKV, NOW, call, env, getBackups, putBackup, registerWriter, sized, tgAuth, wallet } from "./svc";

describe("handles", () => {
  it("claims, looks up, exports, and the claim re-verifies client-side", async () => {
    const e = env();
    const w = wallet();
    const r = await call(e, "POST", "/handles", { handle: "@Sam_92", owner: w.pk, issued: NOW, sig: w.sign(handleClaimMessage("sam_92", w.pk, NOW)) });
    expect(r.status).toBe(200);
    const got = await call(e, "GET", "/handles/sam_92");
    expect(got.body.owner).toBe(w.pk);
    expect(verifyHandleClaim(got.body)).toBe(true);
    expect((await call(e, "GET", "/handles")).body.claims).toHaveLength(1);
    expect((await call(e, "GET", `/owners/${w.pk}`)).body.handle.handle).toBe("sam_92");
  });
  it("rejects bad signatures, stale requests, reserved and malformed names", async () => {
    const e = env();
    const w = wallet();
    const other = wallet();
    expect((await call(e, "POST", "/handles", { handle: "alice", owner: w.pk, issued: NOW, sig: other.sign(handleClaimMessage("alice", w.pk, NOW)) })).status).toBe(401);
    expect((await call(e, "POST", "/handles", { handle: "alice", owner: w.pk, issued: NOW - 3600, sig: w.sign(handleClaimMessage("alice", w.pk, NOW - 3600)) })).status).toBe(400);
    expect((await call(e, "POST", "/handles", { handle: "latchsupport", owner: w.pk, issued: NOW, sig: w.sign(handleClaimMessage("latchsupport", w.pk, NOW)) })).status).toBe(400);
    expect((await call(e, "POST", "/handles", { handle: "ab", owner: w.pk, issued: NOW, sig: w.sign(handleClaimMessage("ab", w.pk, NOW)) })).status).toBe(400);
  });
  it("first come first served; changing your name frees the old one; release works", async () => {
    const e = env();
    const a = wallet();
    const b = wallet();
    await call(e, "POST", "/handles", { handle: "alice", owner: a.pk, issued: NOW, sig: a.sign(handleClaimMessage("alice", a.pk, NOW)) });
    expect((await call(e, "POST", "/handles", { handle: "alice", owner: b.pk, issued: NOW, sig: b.sign(handleClaimMessage("alice", b.pk, NOW)) })).status).toBe(409);
    await call(e, "POST", "/handles", { handle: "alice2", owner: a.pk, issued: NOW + 1, sig: a.sign(handleClaimMessage("alice2", a.pk, NOW + 1)) });
    expect((await call(e, "GET", "/handles/alice")).status).toBe(404);
    expect((await call(e, "DELETE", "/handles", { owner: a.pk, issued: NOW + 2, sig: a.sign(handleReleaseMessage(a.pk, NOW + 2)) })).status).toBe(200);
    expect((await call(e, "GET", "/handles/alice2")).status).toBe(404);
  });
});

describe("telegram", () => {
  it("links a verified Telegram username; findable lookup; stores no names or photos", async () => {
    const e = env();
    const w = wallet();
    const tg = tgAuth({ id: 4242, first_name: "Sam", username: "SamT", auth_date: NOW - 30, photo_url: "https://t.me/x.jpg" });
    const r = await call(e, "POST", "/telegram", { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessage(w.pk, 4242, "SamT", NOW)), tg, findable: true });
    expect(r.status).toBe(200);
    expect((await call(e, "GET", "/telegram/samt")).body.owner).toBe(w.pk);
    const stored = [...(e.KV as MemKV).m.values()].join(" ");
    expect(stored).not.toContain("Sam\"");
    expect(stored).not.toContain("t.me/x.jpg");
    expect(stored).not.toContain("4242");
    // B6: no hash of the Telegram id either (an unpeppered hash is reversible by enumeration).
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const { bytesToHex } = await import("@noble/hashes/utils.js");
    expect(stored).not.toContain(bytesToHex(sha256(new TextEncoder().encode("latch-tg:4242"))));
    for (const v of (e.KV as MemKV).m.values()) if (v.startsWith("{")) expect(Object.keys(JSON.parse(v))).not.toContain("idHash");
  });
  it("rejects forged Telegram data, old logins, and the wrong wallet signature", async () => {
    const e = env();
    const w = wallet();
    const good = tgAuth({ id: 1, username: "bobby", auth_date: NOW - 30 });
    expect((await call(e, "POST", "/telegram", { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessage(w.pk, 1, "bobby", NOW)), tg: { ...good, username: "mallory" } })).status).toBe(401);
    const old = tgAuth({ id: 1, username: "bobby", auth_date: NOW - 3 * 86400 });
    expect((await call(e, "POST", "/telegram", { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessage(w.pk, 1, "bobby", NOW)), tg: old })).status).toBe(401);
    expect((await call(e, "POST", "/telegram", { owner: w.pk, issued: NOW, sig: wallet().sign(telegramLinkMessage(w.pk, 1, "bobby", NOW)), tg: good })).status).toBe(401);
  });
  it("not findable → not searchable by username", async () => {
    const e = env();
    const w = wallet();
    const tg = tgAuth({ id: 7, username: "quiet", auth_date: NOW });
    await call(e, "POST", "/telegram", { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessage(w.pk, 7, "quiet", NOW)), tg, findable: false });
    expect((await call(e, "GET", "/telegram/quiet")).status).toBe(404);
    expect((await call(e, "GET", `/owners/${w.pk}`)).body.telegram).toBeNull(); // B2: not revealed by wallet either
  });
});

describe("backup", () => {
  it("stores ciphertext only via the owner-registered writer key; anyone can read ciphertext", async () => {
    const e = env();
    const owner = wallet();
    const w = wallet(); // device-derived writer key
    const deal = wallet().pk;
    const id = "ab".repeat(32);
    expect((await putBackup(e, owner, w, id, deal, sized(1), NOW)).status).toBe(403);
    expect((await call(e, "POST", `/backup/${owner.pk}/writer`, { writer: w.pk, kcv: "0".repeat(32), issued: NOW, sig: w.sign(backupWriterMessage(owner.pk, w.pk, "0".repeat(32), NOW)) })).status).toBe(401);
    expect((await registerWriter(e, owner, w, NOW)).status).toBe(200);
    expect((await putBackup(e, owner, wallet(), id, deal, sized(1), NOW)).status).toBe(401);
    expect((await putBackup(e, owner, w, id, deal, sized(1), NOW)).status).toBe(200);
    const list = await getBackups(e, owner, w, NOW + 1);
    expect(list.body.backups[0]).toMatchObject({ id });
  });
});

describe("faucet", () => {
  it("sends once per address per day", async () => {
    const sent: string[] = [];
    const e = env({ faucetSender: async (a) => (sent.push(a), "sig123") });
    const w = wallet();
    expect((await call(e, "POST", "/faucet", { address: w.pk })).status).toBe(200);
    expect((await call(e, "POST", "/faucet", { address: w.pk })).status).toBe(429);
    expect(sent).toEqual([w.pk]);
  });
  it("is off when not configured", async () => {
    expect((await call(env(), "POST", "/faucet", { address: wallet().pk })).status).toBe(503);
  });
});
