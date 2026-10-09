/** v0.4 B2: Telegram identities aren't linkable to wallets unless the user opted in. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { telegramLinkMessage } from "../src/lib/claims";
import { handle } from "../worker/src/index";
import { MemKV, NOW, call, env, tgAuth, wallet } from "./svc";

async function link(e: any, w: ReturnType<typeof wallet>, username: string, id: number, findable?: boolean) {
  const tg = tgAuth({ id, username, auth_date: NOW });
  const body: any = { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessage(w.pk, id, username, NOW)), tg };
  if (findable !== undefined) body.findable = findable;
  return call(e, "POST", "/telegram", body);
}

describe("findable is opt-in", () => {
  it("defaults OFF: omitted or non-true 'findable' is not findable", async () => {
    for (const f of [undefined, "yes", 1, false]) {
      const e = env();
      const w = wallet();
      expect((await link(e, w, "someone", 11, f as any)).status).toBe(200);
      expect((await call(e, "GET", "/telegram/someone")).status).toBe(404);
      expect((await call(e, "GET", `/owners/${w.pk}`)).body.telegram).toBeNull();
    }
  });
  it("findable: name → wallet and wallet → name both resolve", async () => {
    const e = env();
    const w = wallet();
    await link(e, w, "openbook", 12, true);
    expect((await call(e, "GET", "/telegram/openbook")).body.owner).toBe(w.pk);
    expect((await call(e, "GET", `/owners/${w.pk}`)).body.telegram.username).toBe("openbook");
  });
  it("the app's checkbox starts unchecked and the UI says a linked name is public", () => {
    const src = readFileSync(new URL("../src/screens/ProfileSections.tsx", import.meta.url), "utf8");
    expect(src).toContain("const [findable, setFindable] = useState(false);");
    expect(src).toContain("A linked name is public next to your wallet: anyone who looks it up can see this wallet's payments on Solana.");
  });
});

describe("lookups are rate-limited per IP", () => {
  it("61st lookup in a minute from one IP gets 429; another IP and the next minute are fine", async () => {
    const e = env();
    const w = wallet();
    const get = (ip: string, t = NOW) => handle(new Request(`https://svc.test/owners/${w.pk}`, { headers: { "cf-connecting-ip": ip } }), e, t);
    for (let i = 0; i < 60; i++) expect((await get("1.1.1.1")).status).toBe(200);
    expect((await get("1.1.1.1")).status).toBe(429);
    expect((await get("2.2.2.2")).status).toBe(200);
    expect((await get("1.1.1.1", NOW + 60)).status).toBe(200);
    const rl = [...(e.KV as MemKV).ttl.entries()].filter(([k]) => k.startsWith("rl:"));
    expect(rl.length).toBeGreaterThan(0);
    for (const [, ttl] of rl) expect(ttl).toBeGreaterThanOrEqual(60);
  });
  it("name lookups count too", async () => {
    const e = env();
    for (let i = 0; i < 60; i++) await handle(new Request("https://svc.test/handles/someone", { headers: { "cf-connecting-ip": "9.9.9.9" } }), e, NOW);
    expect((await handle(new Request("https://svc.test/telegram/someone", { headers: { "cf-connecting-ip": "9.9.9.9" } }), e, NOW)).status).toBe(429);
  });
});
