/** v0.4 B5: encrypted backups, format v2. */
import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KCV_MISMATCH,
  NONDETERMINISTIC,
  PAD_BUCKETS,
  SEALED_SIZES,
  backupId,
  backupKeyMessage,
  backupWriterKeyMessage,
  deriveKeys,
  deriveWriter,
  open,
  pad,
  seal,
  unpad,
} from "../src/lib/backupCrypto";
import { openPayload, sealPayload, unlockBackupKeys, type BackupPayload, type BackupSession } from "../src/lib/service";
import { APP_DOMAIN } from "../src/lib/config";
import { MemKV, NOW, env, getBackups, putBackup, registerWriter, sized, wallet } from "./svc";

const SIG = Uint8Array.from({ length: 64 }, (_, i) => i);
const OWNER = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

describe("key derivation", () => {
  it("HKDF-SHA256 with domain-, cluster- and owner-bound info (checked against node:crypto)", () => {
    const k = deriveKeys(SIG, "latch.example", OWNER);
    const ref = (info: string) => new Uint8Array(hkdfSync("sha256", SIG, Buffer.from("latch-dial backup v2"), Buffer.from(info), 32));
    expect(k.key).toEqual(ref(`enc|latch.example|devnet|${OWNER}`));
    expect(k.idKey).toEqual(ref(`id|latch.example|devnet|${OWNER}`));
    expect(k.kcv).toBe(createHmac("sha256", Buffer.from(k.key)).update("kcv").digest("hex").slice(0, 32));
    expect(backupId(k.idKey, "DEAL")).toBe(createHmac("sha256", Buffer.from(k.idKey)).update("DEAL").digest("hex"));
  });
  it("enc key, id key and writer key are all different; another domain gives other keys", () => {
    const k = deriveKeys(SIG, "latch.example", OWNER);
    const w = deriveWriter(SIG, "latch.example", OWNER);
    expect(Buffer.from(k.key).equals(Buffer.from(k.idKey))).toBe(false);
    expect(Buffer.from(k.key).equals(Buffer.from(w.sk))).toBe(false);
    expect(deriveKeys(SIG, "evil.example", OWNER).kcv).not.toBe(k.kcv);
  });
  it("the two messages are different, name the app domain, and are fixed for a given domain", () => {
    expect(backupKeyMessage("latch.example", OWNER)).toContain("domain: latch.example");
    expect(backupWriterKeyMessage("latch.example", OWNER)).toContain("domain: latch.example");
    expect(backupKeyMessage("latch.example", OWNER)).not.toBe(backupWriterKeyMessage("latch.example", OWNER));
    expect(backupKeyMessage("latch.example", OWNER)).toBe(backupKeyMessage("latch.example", OWNER));
  });
});

describe("deterministic wallets only", () => {
  it("a real Ed25519 wallet unlocks to the same keys every time", async () => {
    const w = wallet();
    const a = await unlockBackupKeys(w.pk, w.signBytes);
    const b = await unlockBackupKeys(w.pk, w.signBytes, a.kcv);
    expect(b.kcv).toBe(a.kcv);
    expect(Buffer.from(b.key).equals(Buffer.from(a.key))).toBe(true);
  });
  it("a wallet that signs randomly is refused at setup with a clear message", async () => {
    let n = 0;
    const flaky = async (m: Uint8Array) => Uint8Array.from({ length: 64 }, () => (n++ * 7 + m.length) & 255);
    await expect(unlockBackupKeys(OWNER, flaky)).rejects.toThrow(NONDETERMINISTIC);
  });
  it("a later unlock producing a different key is caught by the key-check value", async () => {
    const w = wallet();
    const other = wallet();
    const a = await unlockBackupKeys(w.pk, w.signBytes);
    await expect(unlockBackupKeys(w.pk, other.signBytes, a.kcv)).rejects.toThrow(KCV_MISMATCH);
  });
});

describe("sealing", () => {
  const k = deriveKeys(SIG, APP_DOMAIN, OWNER);
  it("pads to 1 / 4 / 16 / 64 KiB buckets", () => {
    expect(pad(new Uint8Array(10)).length).toBe(1024);
    expect(pad(new Uint8Array(1020)).length).toBe(1024);
    expect(pad(new Uint8Array(1021)).length).toBe(4096);
    expect(pad(new Uint8Array(65532)).length).toBe(65536);
    expect(() => pad(new Uint8Array(65533))).toThrow(/too large/);
    expect(unpad(pad(Uint8Array.from([1, 2, 3])))).toEqual(Uint8Array.from([1, 2, 3]));
    expect(SEALED_SIZES).toEqual(PAD_BUCKETS.map((b) => b + 41));
  });
  it("a short and a long agreement in the same bucket are the same size", () => {
    const a = seal(k.key, OWNER, "x", new Uint8Array(5));
    const b = seal(k.key, OWNER, "x", new Uint8Array(900));
    expect(a.length).toBe(b.length);
  });
  it("AAD binds owner and id: a ciphertext moved to another slot or wallet doesn't open", () => {
    const sealed = seal(k.key, OWNER, "id-1", new TextEncoder().encode("secret"));
    expect(new TextDecoder().decode(open(k.key, OWNER, "id-1", sealed))).toBe("secret");
    expect(() => open(k.key, OWNER, "id-2", sealed)).toThrow();
    expect(() => open(k.key, "someone-else", "id-1", sealed)).toThrow();
    const flipped = sealed.slice();
    flipped[40] ^= 1;
    expect(() => open(k.key, OWNER, "id-1", flipped)).toThrow();
  });
  it("openPayload also checks the id matches the deal inside", () => {
    const s: BackupSession = { owner: OWNER, keys: k };
    const p: BackupPayload = { format: "latch-dial/agreement-backup@2", deal: "DealA", link: "L", attachment: "VIN 123" };
    const { id, sealed } = sealPayload(s, p);
    expect(new TextDecoder().decode(sealed)).not.toContain("VIN 123");
    expect(openPayload(s, id, sealed)).toEqual(p);
    const q = sealPayload(s, { ...p, deal: "DealB" });
    // Re-sealed under A's id with B inside: AAD passes, id check fails.
    const forged = seal(k.key, OWNER, id, new TextEncoder().encode(JSON.stringify({ ...p, deal: "DealB" })));
    expect(() => openPayload(s, id, forged)).toThrow(/doesn't match/);
    expect(q.id).not.toBe(id);
  });
});

describe("service", () => {
  it("stores no deal address: the key is HMAC(id key, deal); the address is only checked in the request", async () => {
    const e = env();
    const owner = wallet();
    const writer = wallet();
    const deal = wallet().pk;
    const keys = deriveKeys(SIG, APP_DOMAIN, owner.pk);
    const s: BackupSession = { owner: owner.pk, keys };
    const { id, sealed } = sealPayload(s, { format: "latch-dial/agreement-backup@2", deal, link: "L" });
    await registerWriter(e, owner, writer, NOW, keys.kcv);
    expect((await putBackup(e, owner, writer, id, deal, sealed, NOW)).status).toBe(200);
    const kv = e.KV as MemKV;
    for (const [k, v] of kv.m) {
      expect(k).not.toContain(deal);
      expect(v).not.toContain(deal);
    }
    const list = await getBackups(e, owner, writer, NOW + 1);
    expect(list.body.kcv).toBe(keys.kcv);
    expect(openPayload(s, list.body.backups[0].id, Uint8Array.from(Buffer.from(list.body.backups[0].ct, "base64"))).deal).toBe(deal);
  });
  it("listing needs the registered writer's signature", async () => {
    const e = env();
    const owner = wallet();
    const writer = wallet();
    await registerWriter(e, owner, writer, NOW);
    await putBackup(e, owner, writer, "aa".repeat(32), wallet().pk, sized(1), NOW);
    expect((await getBackups(e, owner, wallet(), NOW)).status).toBe(401);
    expect((await getBackups(e, owner, owner, NOW)).status).toBe(401); // not even the wallet itself: the writer key
    const { call } = await import("./svc");
    expect((await call(e, "GET", `/backup/${owner.pk}`)).status).toBe(401);
    expect((await getBackups(e, owner, writer, NOW - 3600)).status).toBe(401); // stale
    expect((await getBackups(e, owner, writer, NOW + 1)).status).toBe(200);
  });
  it("only padded sizes are accepted; writer registration must carry a key-check value", async () => {
    const e = env();
    const owner = wallet();
    const writer = wallet();
    const { call } = await import("./svc");
    expect((await call(e, "POST", `/backup/${owner.pk}/writer`, { writer: writer.pk, issued: NOW, sig: "x" })).status).toBe(400);
    await registerWriter(e, owner, writer, NOW);
    expect((await putBackup(e, owner, writer, "aa".repeat(32), wallet().pk, new Uint8Array(100), NOW)).status).toBe(400);
    expect((await putBackup(e, owner, writer, "aa".repeat(32), wallet().pk, sized(2), NOW)).status).toBe(200);
    expect((await putBackup(e, owner, writer, "not-hex", wallet().pk, sized(2), NOW)).status).toBe(404);
  });
});

describe("v0.5 #9: captured backup requests can't be replayed", () => {
  it("a replayed PUT can't restore older ciphertext; a replayed list is refused", async () => {
    const e = env();
    const owner = wallet();
    const writer = wallet();
    const id = "ab".repeat(32);
    const deal = wallet().pk;
    await registerWriter(e, owner, writer, NOW);
    const { call } = await import("./svc");
    const { toB64, backupWriteMessage, sha256Hex } = await import("../src/lib/claims");
    const oldCt = sized(1);
    const oldPut = { ct: toB64(oldCt), deal, issued: NOW + 1, sig: writer.sign(backupWriteMessage(owner.pk, id, deal, sha256Hex(oldCt), NOW + 1)) };
    expect((await call(e, "PUT", `/backup/${owner.pk}/${id}`, oldPut)).status).toBe(200);
    expect((await putBackup(e, owner, writer, id, deal, sized(2), NOW + 2)).status).toBe(200); // newer version
    expect((await call(e, "PUT", `/backup/${owner.pk}/${id}`, oldPut)).status).toBe(409); // replay of the old one
    const stored = JSON.parse((e.KV as MemKV).m.get(`b:${owner.pk}:${id}`)!);
    expect(Buffer.from(stored.ct, "base64")[0]).toBe(2);
    expect((await getBackups(e, owner, writer, NOW + 3)).status).toBe(200);
    expect((await getBackups(e, owner, writer, NOW + 3)).status).toBe(409);
  });
  it("writer requests have their own lane: a wallet action in the same second still works", async () => {
    const e = env();
    const owner = wallet();
    const writer = wallet();
    await registerWriter(e, owner, writer, NOW);
    expect((await putBackup(e, owner, writer, "cd".repeat(32), wallet().pk, sized(3), NOW + 5)).status).toBe(200);
    const { call } = await import("./svc");
    const { handleClaimMessage } = await import("../src/lib/claims");
    expect((await call(e, "POST", "/handles", { handle: "same_second", owner: owner.pk, issued: NOW + 5, sig: owner.sign(handleClaimMessage("same_second", owner.pk, NOW + 5)) })).status).toBe(200);
  });
  it("the client hands out strictly increasing issued values", async () => {
    const { nextWriterIssued } = await import("../src/lib/service");
    const a = nextWriterIssued(NOW + 100);
    const b = nextWriterIssued(NOW + 100);
    const c = nextWriterIssued(NOW + 50);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });
});

describe("v0.5 #10: the list must carry the matching key-check value", () => {
  async function client(body: unknown) {
    const { vi } = await import("vitest");
    const s = await import("../src/lib/service");
    s.setServiceUrlForTesting("https://svc.example");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
    return { s, done: () => (vi.unstubAllGlobals(), s.setServiceUrlForTesting(undefined)) };
  }
  const owner = wallet().pk;
  const keys = deriveKeys(SIG, APP_DOMAIN, owner);
  const session: BackupSession = { owner, keys, writer: deriveWriter(SIG, APP_DOMAIN, owner) };
  const item = () => {
    const { id, sealed } = sealPayload(session, { format: "latch-dial/agreement-backup@2", deal: "D1", link: "L" });
    return { id, ct: Buffer.from(sealed).toString("base64"), at: NOW };
  };
  it("missing kcv → refused (nothing restored)", async () => {
    const { s, done } = await client({ backups: [item()] });
    try {
      await expect(s.fetchBackups(session)).rejects.toThrow(/didn't confirm the key check/);
    } finally {
      done();
    }
  });
  it("wrong kcv → refused; matching kcv → restored", async () => {
    let c = await client({ kcv: "0".repeat(32), backups: [item()] });
    try {
      await expect(c.s.fetchBackups(session)).rejects.toThrow(KCV_MISMATCH);
    } finally {
      c.done();
    }
    c = await client({ kcv: keys.kcv, backups: [item()] });
    try {
      expect((await c.s.fetchBackups(session)).map((p) => p.deal)).toEqual(["D1"]);
    } finally {
      c.done();
    }
  });
});

describe("v0.5 #11: writer key asks twice only the first time on a device", () => {
  it("first unlock: two signatures; later: one, checked against the remembered writer key", async () => {
    const { unlockWriter } = await import("../src/lib/service");
    const w = wallet();
    let n = 0;
    const counted = async (m: Uint8Array) => (n++, w.signBytes(m));
    const first = await unlockWriter(w.pk, counted);
    expect(n).toBe(2);
    n = 0;
    const again = await unlockWriter(w.pk, counted, first.pk);
    expect(n).toBe(1);
    expect(again.pk).toBe(first.pk);
    await expect(unlockWriter(w.pk, wallet().signBytes, first.pk)).rejects.toThrow(KCV_MISMATCH);
  });
  it("the copy matches: no 'Latch can't read them'; says the service only receives ciphertext", async () => {
    const { readFileSync } = await import("node:fs");
    const ps = readFileSync(new URL("../src/screens/ProfileSections.tsx", import.meta.url), "utf8");
    const rt = readFileSync(new URL("../src/lib/retention.ts", import.meta.url), "utf8");
    for (const t of [ps, rt]) {
      expect(t).not.toContain("Latch can't read");
      expect(t).toContain("Stored encrypted; the service only receives ciphertext");
    }
    expect(ps).toContain("also twice the first time on a device, then once");
    const bk = readFileSync(new URL("../src/lib/backup.ts", import.meta.url), "utf8");
    expect(bk).toMatch(/unlockWriter\(owner, signMessage, known\)/);
  });
});
