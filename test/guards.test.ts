/** v0.5 #5: the atomic checks live in one Durable Object. */
import { describe, expect, it } from "vitest";
import { GuardsCore } from "../worker/src/guards";
import { handleClaimMessage, telegramLinkMessage } from "../src/lib/claims";
import { handle } from "../worker/src/index";
import { MemGuardStorage, NOW, call, env, guardStore, memGuards, tgAuth, wallet } from "./svc";

describe("GuardsCore", () => {
  const core = () => {
    const s = new MemGuardStorage();
    return { s, g: new GuardsCore(s) };
  };
  it("useOnce: first true, then false until it expires", async () => {
    const { g } = core();
    expect(await g.run({ op: "useOnce", key: "tgu:x", ttl: 720, now: NOW })).toBe(true);
    expect(await g.run({ op: "useOnce", key: "tgu:x", ttl: 720, now: NOW + 719 })).toBe(false);
    expect(await g.run({ op: "useOnce", key: "tgu:x", ttl: 720, now: NOW + 720 })).toBe(true);
  });
  it("bumpIssued: strictly increasing per owner", async () => {
    const { g } = core();
    const b = (owner: string, issued: number) => g.run({ op: "bumpIssued", owner, issued, ttl: 1200, now: NOW });
    expect(await b("A", 10)).toBe(true);
    expect(await b("A", 10)).toBe(false);
    expect(await b("A", 9)).toBe(false);
    expect(await b("B", 9)).toBe(true);
    expect(await b("A", 11)).toBe(true);
  });
  it("claimAll is all-or-nothing; releaseAll only frees our own claim", async () => {
    const { g, s } = core();
    expect(await g.run({ op: "claimAll", keys: ["f:i:1.1.1.1"], value: "other", ttl: 72000, now: NOW })).toBe(true);
    expect(await g.run({ op: "claimAll", keys: ["f:a:W", "f:i:1.1.1.1"], value: "mine", ttl: 72000, now: NOW })).toBe(false);
    expect(s.m.has("f:a:W")).toBe(false); // nothing half-claimed
    await g.run({ op: "releaseAll", keys: ["f:i:1.1.1.1"], value: "mine", now: NOW });
    expect(s.m.has("f:i:1.1.1.1")).toBe(true);
    await g.run({ op: "releaseAll", keys: ["f:i:1.1.1.1"], value: "other", now: NOW });
    expect(s.m.has("f:i:1.1.1.1")).toBe(false);
  });
  it("only guard prefixes; expired records are swept by the alarm", async () => {
    const { g, s } = core();
    await expect(g.run({ op: "useOnce", key: "h:alice", ttl: 60, now: NOW })).rejects.toThrow(/unknown guard key/);
    await g.run({ op: "useOnce", key: "tgu:a", ttl: 60, now: NOW });
    await g.run({ op: "useOnce", key: "tgu:b", ttl: 6000, now: NOW });
    expect(s.alarm).not.toBeNull();
    expect(await g.sweep(NOW + 61)).toBe(1);
    expect([...s.m.keys()]).toEqual(["tgu:b"]);
  });
});

describe("through the Worker, concurrently", () => {
  it("20 simultaneous submissions of one Telegram login: exactly one links", async () => {
    const e = env();
    const tg = tgAuth({ id: 77, username: "racer_one", auth_date: NOW });
    const ws = Array.from({ length: 20 }, () => wallet());
    const rs = await Promise.all(ws.map((w) => call(e, "POST", "/telegram", { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessage(w.pk, 77, "racer_one", NOW)), tg })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(19);
  });
  it("10 simultaneous copies of one signed claim: exactly one accepted", async () => {
    const e = env();
    const w = wallet();
    const body = { handle: "same_sig", owner: w.pk, issued: NOW, sig: w.sign(handleClaimMessage("same_sig", w.pk, NOW)) };
    const rs = await Promise.all(Array.from({ length: 10 }, () => call(e, "POST", "/handles", body)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });
  it("records go to the Durable Object, not KV", async () => {
    const e = env();
    const w = wallet();
    await call(e, "POST", "/handles", { handle: "where_now", owner: w.pk, issued: NOW, sig: w.sign(handleClaimMessage("where_now", w.pk, NOW)) });
    expect(guardStore(e).m.has(`li:${w.pk}`)).toBe(true);
    expect([...(e.KV as any).m.keys()].some((k: string) => k.startsWith("li:"))).toBe(false);
  });
  it("without the binding the Worker fails closed (no unguarded writes)", async () => {
    const e = env({ GUARDS: undefined });
    const w = wallet();
    const r = await handle(new Request("https://svc.test/handles", { method: "POST", body: JSON.stringify({ handle: "no_guard", owner: w.pk, issued: NOW, sig: w.sign(handleClaimMessage("no_guard", w.pk, NOW)) }) }), e, NOW);
    expect(r.status).toBe(500);
    expect((e.KV as any).m.has("h:no_guard")).toBe(false);
    expect(memGuards).toBeDefined();
  });
});
