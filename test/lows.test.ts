/** v0.4 B9: CORS, HTTPS-only service URL, generic errors, devnet guard, confusable names, Telegram HMAC KAT, lying-server responses. */
import { describe, expect, it, vi } from "vitest";
import { handleProblem, isReservedName, nameSkeleton, handleClaimMessage } from "../src/lib/claims";
import { normalizeServiceUrl } from "../src/lib/serviceUrl";
import { DEVNET_GENESIS, assertDevnet, handle, verifyTelegramAuth } from "../worker/src/index";
import { NOW, env, wallet } from "./svc";

describe("CORS is pinned", () => {
  const req = (origin: string) => new Request("https://svc.test/health", { headers: { origin } });
  it("only listed origins get Access-Control-Allow-Origin; '*' is ignored; unset → nobody", async () => {
    const e = env({ ALLOWED_ORIGINS: "https://app.example, *" });
    expect((await handle(req("https://app.example"), e, NOW)).headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect((await handle(req("https://evil.example"), e, NOW)).headers.get("access-control-allow-origin")).toBeNull();
    expect((await handle(req("https://app.example"), env({ ALLOWED_ORIGINS: "*" }), NOW)).headers.get("access-control-allow-origin")).toBeNull();
    expect((await handle(req("https://app.example"), env(), NOW)).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("service URL", () => {
  it("HTTPS only (plain http just for localhost); no credentials, query or fragment", () => {
    expect(normalizeServiceUrl("https://svc.example/")).toBe("https://svc.example");
    expect(normalizeServiceUrl("https://svc.example/api/")).toBe("https://svc.example/api");
    expect(normalizeServiceUrl("http://svc.example")).toBeUndefined();
    // v0.5 #12: plain-http localhost only for the dev server.
    expect(normalizeServiceUrl("http://localhost:8787")).toBeUndefined();
    expect(normalizeServiceUrl("http://127.0.0.1:8787", false)).toBeUndefined();
    expect(normalizeServiceUrl("http://localhost:8787", true)).toBe("http://localhost:8787");
    expect(normalizeServiceUrl("http://svc.example", true)).toBeUndefined();
    expect(normalizeServiceUrl("https://user:pw@svc.example")).toBeUndefined();
    expect(normalizeServiceUrl("https://svc.example/?x=1")).toBeUndefined();
    expect(normalizeServiceUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeServiceUrl("not a url")).toBeUndefined();
    expect(normalizeServiceUrl(undefined)).toBeUndefined();
  });
});

describe("v0.5 #12: the build never allows plain-http localhost", () => {
  it("config passes DEV, vite.config passes nothing (= production rule)", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = readFileSync(new URL("../src/lib/config.ts", import.meta.url), "utf8");
    expect(cfg).toMatch(/normalizeServiceUrl\(env\.VITE_SERVICE_URL, IS_DEV\)/);
    expect(cfg).toMatch(/const IS_DEV = \(env as Record<string, unknown>\)\.DEV === true;/);
    const vc = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(vc).toMatch(/normalizeServiceUrl\(env\.VITE_SERVICE_URL\)/);
    // The test runner isn't the dev server: http://localhost must be off here too.
    const { SERVICE_URL } = await import("../src/lib/config");
    expect(SERVICE_URL === undefined || SERVICE_URL.startsWith("https://")).toBe(true);
  });
});

describe("generic errors", () => {
  it("an internal failure doesn't echo its message", async () => {
    const secret = "FAKE-SECRET-FOR-TESTS-0000000000"; // obviously not a key
    const e = env();
    (e.KV as any).get = async () => {
      throw new Error(`decode failed near ${secret}`);
    };
    const r = await handle(new Request(`https://svc.test/owners/${wallet().pk}`), e, NOW);
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).toBe(JSON.stringify({ error: "internal error" }));
    expect(body).not.toContain(secret.slice(0, 10));
  });
});

describe("devnet only", () => {
  it("the faucet path refuses any RPC whose genesis isn't devnet's", async () => {
    expect(DEVNET_GENESIS).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    await expect(assertDevnet(async () => DEVNET_GENESIS)).resolves.toBeUndefined();
    await expect(assertDevnet(async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).rejects.toThrow(/not Solana devnet/); // mainnet-beta
  });
  it("the mint script checks the genesis hash before doing anything", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/create-test-mint.mjs", import.meta.url), "utf8");
    const check = src.indexOf("getGenesisHash()");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(src.indexOf("getBalance("));
  });
});

describe("reserved names catch look-alikes", () => {
  it.each(["latch", "l4tch", "iatch", "the_latch_team", "la_tch", "laaatch", "phant0m", "phantom_support", "c0inbase", "so1ana", "metamask_help", "adm1n", "supp0rt_desk", "v3rified", "es_crow"])("%s is reserved", (n) => {
    expect(isReservedName(n)).toBe(true);
    expect(handleProblem(n)).toBe("That name is reserved.");
  });
  it.each(["alice", "sam_92", "bob_the_builder", "photon", "lattice"])("%s is fine", (n) => {
    expect(handleProblem(n)).toBeNull();
  });
  it("the service enforces it too", async () => {
    const w = wallet();
    const r = await handle(new Request("https://svc.test/handles", { method: "POST", body: JSON.stringify({ handle: "l4tch_team", owner: w.pk, issued: NOW, sig: w.sign(handleClaimMessage("l4tch_team", w.pk, NOW)) }) }), env(), NOW);
    expect(r.status).toBe(400);
    expect(nameSkeleton("L4TCH__0fficial")).toBe("latchoflclal");
    expect(isReservedName("1atch")).toBe(true); // also fails the format rule (must start with a letter)
  });
});

describe("Telegram Login Widget HMAC known answer", () => {
  // Obviously fake token. The expected digest was computed once with node:crypto
  // exactly as Telegram documents it (secret = SHA256(token), HMAC-SHA256 over
  // the sorted "key=value" lines) and is pinned here, so it checks the
  // Worker's @noble implementation against an independent one.
  // TODO(before launch): add a captured REAL Login Widget payload from the
  // production bot (token kept out of the repo; store only payload + hash and
  // check with a test-only bot token) — see BUILD-NOTES open questions.
  const token = "000000:FAKE-BOT-TOKEN-FOR-TESTS-ONLY";
  const payload = { id: 424242, first_name: "Sam", username: "sam_test", photo_url: "https://t.me/i/userpic/320/x.jpg", auth_date: 1790000000 };
  const expected = "271bbd264a8eb9d341cc5612eb9fd9677e9ceeb9f18a8ee6ce87373607cf9c39";
  it("the Worker accepts exactly the pinned digest, and nothing else", () => {
    expect(verifyTelegramAuth({ ...payload, hash: expected } as any, token, 1790000000)).toBe(true);
    expect(verifyTelegramAuth({ ...payload, username: "sam_tesu", hash: expected } as any, token, 1790000000)).toBe(false);
    expect(verifyTelegramAuth({ ...payload, hash: expected } as any, token + "x", 1790000000)).toBe(false);
  });
});

describe("the app doesn't trust a lying service", () => {
  async function client(responses: Record<string, unknown>) {
    const s = await import("../src/lib/service");
    s.setServiceUrlForTesting("https://svc.example");
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      const body = responses[path];
      return new Response(body === undefined ? "{}" : JSON.stringify(body), { status: body === undefined ? 404 : 200 });
    });
    return s;
  }
  const a = wallet();
  const b = wallet();
  const goodClaim = { handle: "alice_ok", owner: a.pk, issued: NOW, sig: a.sign(handleClaimMessage("alice_ok", a.pk, NOW)) };

  it("control: an honest service's answers ARE accepted (so the refusals below aren't vacuous)", async () => {
    const s = await client({ [`/owners/${a.pk}`]: { handle: goodClaim, telegram: null }, "/handles/alice_ok": goodClaim });
    expect((await s.profileOf(a.pk)).handle?.handle).toBe("alice_ok");
    expect(await s.resolveName("@alice_ok")).toMatchObject({ owner: a.pk, via: "handle", issued: NOW });
    vi.unstubAllGlobals();
  });
  it("a forged or swapped handle claim is dropped", async () => {
    const s = await client({
      [`/owners/${a.pk}`]: { handle: { ...goodClaim, owner: b.pk }, telegram: null },
      [`/owners/${b.pk}`]: { handle: { ...goodClaim, sig: b.sign(handleClaimMessage("alice_ok", a.pk, NOW)) }, telegram: null },
      "/handles/alice_ok": { ...goodClaim, owner: b.pk },
    });
    expect((await s.profileOf(a.pk)).handle).toBeNull();
    expect((await s.profileOf(b.pk)).handle).toBeNull();
    expect(await s.resolveName("@alice_ok")).toBeNull();
    vi.unstubAllGlobals();
  });
  it("a valid claim for a DIFFERENT name than asked is refused", async () => {
    const s = await client({ "/handles/alice_other": goodClaim });
    expect(await s.resolveName("@alice_other")).toBeNull();
    vi.unstubAllGlobals();
  });
  it("Telegram: wrong owner, expired, or a different username are dropped", async () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const s = await client({
      [`/owners/${a.pk}`]: { handle: null, telegram: { username: "x_user", owner: b.pk, verifiedAt: 1, expiresAt: future } },
      [`/owners/${b.pk}`]: { handle: null, telegram: { username: "x_user", owner: b.pk, verifiedAt: 1, expiresAt: 1 } },
      "/telegram/asked_for": { username: "someone_else", owner: a.pk, verifiedAt: 1, expiresAt: future },
      "/telegram/good_one": { username: "good_one", owner: a.pk, verifiedAt: 1, expiresAt: future },
    });
    expect((await s.profileOf(a.pk)).telegram).toBeNull();
    expect((await s.profileOf(b.pk)).telegram).toBeNull();
    expect(await s.resolveName("tg:@asked_for")).toBeNull();
    expect(await s.resolveName("tg:@good_one")).toMatchObject({ owner: a.pk, via: "telegram" });
    expect(await s.resolveName("@good_one")).toBeNull(); // @ never falls through to Telegram
    vi.unstubAllGlobals();
  });
});

describe("v0.5 #13: no real-looking secrets committed", () => {
  it("no Telegram-bot-token or WIF-shaped strings in src/, worker/, scripts/ or test/", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const root = new URL("../", import.meta.url).pathname;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = `${d}/${f}`;
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js|json|toml|md)$/.test(f) ? [p] : [];
      });
    const BOT_TOKEN = /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/;
    const WIF = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/;
    const hits: string[] = [];
    for (const dir of ["src", "worker", "scripts", "test"])
      for (const f of walk(root + dir)) {
        const t = readFileSync(f, "utf8");
        if (BOT_TOKEN.test(t) || WIF.test(t)) hits.push(f.slice(root.length));
      }
    expect(hits).toEqual([]);
    // the detectors themselves work (samples assembled at runtime, so this file stays clean)
    expect(BOT_TOKEN.test(["1234567890", "AA" + "x".repeat(33)].join(":"))).toBe(true);
    expect(WIF.test("5K" + "z".repeat(49))).toBe(true);
  });
});
