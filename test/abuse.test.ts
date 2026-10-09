/** v0.4 B7: abuse and cost controls on the service. */
import { describe, expect, it } from "vitest";
import { handleClaimMessage, handleReleaseMessage, telegramLinkMessage, telegramUnlinkMessage } from "../src/lib/claims";
import { PROGRAM_ID } from "../src/lib/config";
import * as F from "../src/lib/flows";
import { LATCH_PROGRAM_ID, MAX_BODY_BYTES, dealHasParty, handle } from "../worker/src/index";
import { Chain } from "./harness";
import { MemKV, NOW, call, env, putBackup, registerWriter, sized, tgAuth, wallet } from "./svc";

type W = ReturnType<typeof wallet>;
const claim = (e: any, w: W, name: string, t: number) => call(e, "POST", "/handles", { handle: name, owner: w.pk, issued: t, sig: w.sign(handleClaimMessage(name, w.pk, t)) });

describe("no blind deletes", () => {
  it("a stale o: pointer never deletes someone else's handle (rename or release)", async () => {
    const e = env();
    const kv = e.KV as MemKV;
    const a = wallet();
    const b = wallet();
    await claim(e, a, "alpha", NOW);
    // Simulate: alpha expired and B claimed it later, while A's o: pointer survived.
    kv.m.set("h:alpha", JSON.stringify({ handle: "alpha", owner: b.pk, issued: NOW, sig: "x" }));
    await claim(e, a, "beta", NOW + 1);
    expect(JSON.parse(kv.m.get("h:alpha")!).owner).toBe(b.pk);
    expect(kv.m.has("hr:alpha")).toBe(false); // and no hold placed on B's name
    kv.m.set(`o:${a.pk}`, "alpha");
    await call(e, "DELETE", "/handles", { owner: a.pk, issued: NOW + 2, sig: a.sign(handleReleaseMessage(a.pk, NOW + 2)) });
    expect(JSON.parse(kv.m.get("h:alpha")!).owner).toBe(b.pk);
  });
  it("unlinking Telegram with a stale back-pointer leaves the new owner's link alone", async () => {
    const e = env();
    const kv = e.KV as MemKV;
    const a = wallet();
    const b = wallet();
    const tg = tgAuth({ id: 1, username: "shared_tg", auth_date: NOW });
    await call(e, "POST", "/telegram", { owner: a.pk, issued: NOW, sig: a.sign(telegramLinkMessage(a.pk, 1, "shared_tg", NOW)), tg, findable: true });
    kv.m.set("tg:shared_tg", JSON.stringify({ ...JSON.parse(kv.m.get("tg:shared_tg")!), owner: b.pk }));
    await call(e, "DELETE", "/telegram", { owner: a.pk, issued: NOW + 1, sig: a.sign(telegramUnlinkMessage(a.pk, NOW + 1)) });
    expect(JSON.parse(kv.m.get("tg:shared_tg")!).owner).toBe(b.pk);
    expect(kv.m.has(`tgo:${a.pk}`)).toBe(false);
  });
  it("moving a Telegram name drops the old wallet's pointer only if it still points at that name", async () => {
    const e = env();
    const kv = e.KV as MemKV;
    const a = wallet();
    const b = wallet();
    await call(e, "POST", "/telegram", { owner: a.pk, issued: NOW, sig: a.sign(telegramLinkMessage(a.pk, 2, "movable", NOW)), tg: tgAuth({ id: 2, username: "movable", auth_date: NOW }) });
    kv.m.set(`tgo:${a.pk}`, JSON.stringify({ ...JSON.parse(kv.m.get(`tgo:${a.pk}`)!), username: "something_else" }));
    await call(e, "POST", "/telegram", { owner: b.pk, issued: NOW, sig: b.sign(telegramLinkMessage(b.pk, 2, "movable", NOW)), tg: tgAuth({ id: 2, username: "movable", auth_date: NOW - 1 }) });
    expect(JSON.parse(kv.m.get(`tgo:${a.pk}`)!).username).toBe("something_else");
    expect(JSON.parse(kv.m.get("tg:movable")!).owner).toBe(b.pk);
  });
});

describe("faucet", () => {
  it("five concurrent requests for one address send once (write-before-send, read-back)", async () => {
    const sent: string[] = [];
    const e = env({ faucetSender: async (a) => (await new Promise((r) => setTimeout(r, 5)), sent.push(a), "sig") });
    const w = wallet();
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(e, "POST", "/faucet", { address: w.pk })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(sent).toEqual([w.pk]);
  });
  it("a failed send clears the cooldown so the user can retry", async () => {
    let fail = true;
    const e = env({ faucetSender: async () => (fail ? Promise.reject(new Error("rpc down")) : "sig") });
    const w = wallet();
    expect((await call(e, "POST", "/faucet", { address: w.pk })).status).toBe(502);
    fail = false;
    expect((await call(e, "POST", "/faucet", { address: w.pk })).status).toBe(200);
  });
});

describe("/handles export is paginated and cacheable", () => {
  it("pages of 200 with a cursor; every claim exactly once", async () => {
    const e = env();
    const kv = e.KV as MemKV;
    for (let i = 0; i < 450; i++) kv.m.set(`h:user_${String(i).padStart(4, "0")}`, JSON.stringify({ handle: `user_${i}`, owner: "x", issued: 1, sig: "s" }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await handle(new Request(`https://svc.test/handles${cursor ? `?cursor=${cursor}` : ""}`), e, NOW);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      const j = (await res.json()) as any;
      expect(j.claims.length).toBeLessThanOrEqual(200);
      seen.push(...j.claims.map((c: any) => c.handle));
      cursor = j.cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(450);
  });
});

describe("request limits", () => {
  it("bodies over the cap are refused before parsing (declared or streamed)", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES + 10) });
    const e = env();
    expect((await handle(new Request("https://svc.test/handles", { method: "POST", body: big }), e, NOW)).status).toBe(413);
    expect((await handle(new Request("https://svc.test/handles", { method: "POST", body: big, headers: { "content-length": String(big.length) } }), e, NOW)).status).toBe(413);
  });
  it("31st write in a minute from one IP gets 429", async () => {
    const e = env();
    const post = () => handle(new Request("https://svc.test/handles", { method: "POST", body: "{}", headers: { "cf-connecting-ip": "7.7.7.7" } }), e, NOW);
    for (let i = 0; i < 30; i++) expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(429);
  });
});

describe("backups only for deals the owner is party to", () => {
  it("the service refuses a backup for a deal the owner isn't in", async () => {
    const e = env({ dealHasOwner: async () => false });
    const owner = wallet();
    const writer = wallet();
    await registerWriter(e, owner, writer, NOW);
    expect((await putBackup(e, owner, writer, "aa".repeat(32), wallet().pk, sized(1), NOW)).status).toBe(403);
  });
  it("dealHasParty reads a real Deal account from the deployed program", async () => {
    expect(LATCH_PROGRAM_ID).toBe(PROGRAM_ID.toBase58());
    const c = new Chain();
    const a = c.wallet();
    const b = c.wallet();
    const mint = c.mint(c.wallet());
    const spec: F.DealSpec = {
      creator: a.publicKey, dealId: 1n, parties: [a.publicKey, b.publicKey], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, termsHash: new Uint8Array(32).fill(1),
      milestoneAmounts: [5n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 86400, recoverySigners: [a.publicKey, b.publicKey], recoveryThreshold: 2, recoveryDelaySecs: 86400, acceptedRiskFlags: 1, mint,
    };
    c.send(await F.createAndSign(spec, false), a);
    const raw = c.raw(F.dealAddress(a.publicKey, 1n))!;
    expect(dealHasParty(raw, a.publicKey.toBase58())).toBe(true);
    expect(dealHasParty(raw, b.publicKey.toBase58())).toBe(true);
    expect(dealHasParty(raw, wallet().pk)).toBe(false);
    expect(dealHasParty(raw.slice(0, 500), a.publicKey.toBase58())).toBe(false);
  });
});
