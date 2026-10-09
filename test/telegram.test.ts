/**
 * v0.4 B1: Telegram link hardening (Login Widget) and the flagged OIDC path.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { telegramLinkMessage, telegramLinkMessageV2, telegramNonce } from "../src/lib/claims";
import { constantTimeEqual, telegramAuthProblem, verifyIdToken, TELEGRAM_ISSUER, TELEGRAM_JWKS_URL, TELEGRAM_TOKEN_URL, TELEGRAM_LINK_TTL } from "../worker/src/telegram";
import { authorizeUrl, pkcePair, savePending, takeCallback } from "../src/lib/telegramOidc";
import { MemKV, NOW, call, env, guardStore, tgAuth, wallet } from "./svc";

function link(e: any, w: ReturnType<typeof wallet>, tg: any) {
  return call(e, "POST", "/telegram", { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessage(w.pk, tg.id, tg.username, NOW)), tg, findable: true });
}

describe("Login Widget payloads", () => {
  it("are single use: the same payload can't be replayed — not by its owner, not by anyone who saw it", async () => {
    const e = env();
    const victim = wallet();
    const attacker = wallet();
    const tg = tgAuth({ id: 4242, username: "samtg", auth_date: NOW - 10 });
    expect((await link(e, victim, tg)).status).toBe(200);
    const replay = await link(e, attacker, tg);
    expect(replay.status).toBe(409);
    expect((await call(e, "GET", "/telegram/samtg")).body.owner).toBe(victim.pk); // not moved
    expect((await link(e, victim, tg)).status).toBe(409);
    expect(guardStore(e).m.get(`tgu:${tg.hash}`).exp - NOW).toBeGreaterThanOrEqual(300);
  });

  it("are accepted for 5 minutes, not 24 hours", async () => {
    const e = env();
    expect((await link(e, wallet(), tgAuth({ id: 1, username: "fresh_one", auth_date: NOW - 290 }))).status).toBe(200);
    expect((await link(e, wallet(), tgAuth({ id: 2, username: "stale_one", auth_date: NOW - 310 }))).status).toBe(401);
    expect((await link(e, wallet(), tgAuth({ id: 3, username: "future_one", auth_date: NOW + 120 }))).status).toBe(401);
  });

  it.each([
    ["unknown field", { id: 1, username: "abcde", auth_date: NOW, extra: "x" }],
    ["id as string", { id: "1", username: "abcde", auth_date: NOW }],
    ["negative id", { id: -5, username: "abcde", auth_date: NOW }],
    ["fractional auth_date", { id: 1, username: "abcde", auth_date: NOW + 0.5 }],
    ["username with a newline", { id: 1, username: "abc\nde", auth_date: NOW }],
    ["username too short", { id: 1, username: "abc", auth_date: NOW }],
    ["photo over http", { id: 1, username: "abcde", auth_date: NOW, photo_url: "http://x/y.jpg" }],
  ])("reject %s (before any HMAC work)", async (_, fields) => {
    const tg = tgAuth(fields as any);
    expect(telegramAuthProblem(tg)).not.toBeNull();
    expect((await link(env(), wallet(), tg)).status).toBe(400);
  });

  it("hash must be 64 lowercase hex; comparison is constant-time", () => {
    const tg = tgAuth({ id: 1, username: "abcde", auth_date: NOW });
    expect(telegramAuthProblem({ ...tg, hash: tg.hash.toUpperCase() })).toBe("bad hash");
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("links expire after 60 days (record TTL and lookups)", async () => {
    const e = env();
    const w = wallet();
    const r = await link(e, w, tgAuth({ id: 9, username: "expiring", auth_date: NOW }));
    expect(r.body.expiresAt).toBe(NOW + 60 * 86400);
    expect((e.KV as MemKV).ttl.get("tg:expiring")).toBe(TELEGRAM_LINK_TTL);
    expect((e.KV as MemKV).ttl.get(`tgo:${w.pk}`)).toBe(TELEGRAM_LINK_TTL);
    const { handle } = await import("../worker/src/index");
    const later = await handle(new Request("https://svc.test/telegram/expiring"), e, NOW + 61 * 86400);
    expect(later.status).toBe(404);
  });
});

describe("badge wording", () => {
  it("no screen calls a Telegram link 'verified'", () => {
    const dir = new URL("../src/screens", import.meta.url).pathname;
    for (const f of readdirSync(dir)) {
      const t = readFileSync(`${dir}/${f}`, "utf8");
      expect(/Telegram[^"`\n]*verified|Verified with Telegram/i.test(t), f).toBe(false);
    }
  });
});

// ------------------------------------------------------------------- OIDC

const CLIENT_ID = "1234567";
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

async function issuer(alg: "ES256" | "EdDSA" = "ES256") {
  const kp = (await crypto.subtle.generateKey((alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" }) as EcKeyGenParams, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg };
  const sign = async (claims: Record<string, unknown>, kid = "k1") => {
    const head = b64url(Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })));
    const body = b64url(Buffer.from(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign(alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" }, kp.privateKey, Buffer.from(`${head}.${body}`));
    return `${head}.${body}.${b64url(sig)}`;
  };
  return { jwks: { keys: [jwk] }, sign };
}

function oidcEnv(idToken: string, jwks: any, seen: { body?: string }) {
  return env({
    TELEGRAM_OIDC_CLIENT_ID: CLIENT_ID,
    TELEGRAM_OIDC_CLIENT_SECRET: "s3cret",
    oidcFetch: async (url: string, init?: RequestInit) => {
      if (url === TELEGRAM_TOKEN_URL) {
        seen.body = String(init?.body);
        return new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" }), { status: 200 });
      }
      if (url === TELEGRAM_JWKS_URL) return new Response(JSON.stringify(jwks), { status: 200 });
      return new Response("", { status: 404 });
    },
  });
}

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
function oidcBody(w: ReturnType<typeof wallet>, code = "CODE-1") {
  return { owner: w.pk, issued: NOW, sig: w.sign(telegramLinkMessageV2(w.pk, NOW)), code, verifier: VERIFIER, redirectUri: "https://app.example/", findable: false };
}
const goodClaims = (w: ReturnType<typeof wallet>) => ({ iss: TELEGRAM_ISSUER, aud: CLIENT_ID, sub: "777", iat: NOW - 5, exp: NOW + 600, nonce: telegramNonce(w.pk, NOW), preferred_username: "oidc_user" });

describe("Telegram OIDC (flag)", () => {
  it("links when the id_token carries nonce = H(wallet ‖ issued); the code is redeemed with PKCE + client secret", async () => {
    for (const alg of ["ES256", "EdDSA"] as const) {
      const iss = await issuer(alg);
      const w = wallet();
      const seen: { body?: string } = {};
      const e = oidcEnv(await iss.sign(goodClaims(w)), iss.jwks, seen);
      const r = await call(e, "POST", "/telegram/oidc", oidcBody(w));
      expect(r.status, alg).toBe(200);
      expect(r.body).toMatchObject({ username: "oidc_user", owner: w.pk });
      const form = new URLSearchParams(seen.body);
      expect(form.get("code_verifier")).toBe(VERIFIER);
      expect(form.get("client_secret")).toBe("s3cret");
      expect(form.get("grant_type")).toBe("authorization_code");
    }
  });

  it("a token minted for another wallet's nonce is refused (the code can't be moved to an attacker's wallet)", async () => {
    const iss = await issuer();
    const victim = wallet();
    const attacker = wallet();
    const e = oidcEnv(await iss.sign(goodClaims(victim)), iss.jwks, {});
    expect((await call(e, "POST", "/telegram/oidc", oidcBody(attacker))).status).toBe(401);
  });

  it.each([
    ["no nonce (fails closed)", (c: any) => ({ ...c, nonce: undefined })],
    ["wrong audience", (c: any) => ({ ...c, aud: "999" })],
    ["wrong issuer", (c: any) => ({ ...c, iss: "https://evil.example" })],
    ["expired", (c: any) => ({ ...c, exp: NOW - 1 })],
    ["issued long ago", (c: any) => ({ ...c, iat: NOW - 3600 })],
    ["no username", (c: any) => ({ ...c, preferred_username: undefined })],
  ])("refuses an id_token with %s", async (_, tweak) => {
    const iss = await issuer();
    const w = wallet();
    const e = oidcEnv(await iss.sign(tweak(goodClaims(w))), iss.jwks, {});
    expect((await call(e, "POST", "/telegram/oidc", oidcBody(w))).status).toBe(401);
  });

  it("refuses a token signed by a key not in Telegram's JWKS, and a tampered token", async () => {
    const real = await issuer();
    const fake = await issuer();
    const w = wallet();
    expect((await call(oidcEnv(await fake.sign(goodClaims(w)), real.jwks, {}), "POST", "/telegram/oidc", oidcBody(w))).status).toBe(401);
    const tok = await real.sign(goodClaims(w));
    const [h, , s] = tok.split(".");
    const forged = `${h}.${b64url(Buffer.from(JSON.stringify({ ...goodClaims(w), preferred_username: "someone_else" })))}.${s}`;
    await expect(verifyIdToken(forged, real.jwks, { aud: CLIENT_ID, nonce: telegramNonce(w.pk, NOW), now: NOW })).rejects.toThrow(/signature/);
  });

  it("a code is used once; a wrong wallet signature is refused; off unless configured", async () => {
    const iss = await issuer();
    const w = wallet();
    const e = oidcEnv(await iss.sign(goodClaims(w)), iss.jwks, {});
    expect((await call(e, "POST", "/telegram/oidc", oidcBody(w, "C2"))).status).toBe(200);
    expect((await call(e, "POST", "/telegram/oidc", oidcBody(w, "C2"))).status).toBe(409);
    expect((await call(e, "POST", "/telegram/oidc", { ...oidcBody(w, "C3"), sig: wallet().sign(telegramLinkMessageV2(w.pk, NOW)) })).status).toBe(401);
    expect((await call(env(), "POST", "/telegram/oidc", oidcBody(w))).status).toBe(503);
  });
});

describe("OIDC client helpers", () => {
  it("PKCE S256 matches RFC 7636 Appendix B", () => {
    const bytes = Uint8Array.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    expect(pkcePair(bytes)).toEqual({ verifier: VERIFIER, challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" });
  });
  it("the authorize URL carries the wallet-bound nonce and S256 challenge", () => {
    const w = wallet();
    const u = new URL(authorizeUrl({ clientId: CLIENT_ID, redirectUri: "https://app.example/", state: "st", challenge: "ch", owner: w.pk, issued: NOW }));
    expect(u.origin + u.pathname).toBe("https://oauth.telegram.org/auth");
    expect(u.searchParams.get("nonce")).toBe(telegramNonce(w.pk, NOW));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("response_type")).toBe("code");
  });
  it("the callback is accepted only with the matching state, and only once", () => {
    const m = new Map<string, string>();
    const store = { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
    const p = { state: "abc", verifier: VERIFIER, owner: "o", issued: NOW, sig: "s", findable: false, redirectUri: "https://app.example/" };
    savePending(p, store);
    expect(takeCallback("?code=X&state=wrong", store)).toBeNull();
    savePending(p, store);
    expect(takeCallback("?code=X&state=abc", store)).toEqual({ code: "X", pending: p });
    expect(takeCallback("?code=X&state=abc", store)).toBeNull();
  });
});

describe("v0.5 #8: stricter id_token checks and a JWKS cache", () => {
  const enc = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)));
  async function es256() {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" } as EcKeyGenParams, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const signRaw = async (header: Record<string, unknown>, claims: Record<string, unknown>) => {
      const input = `${enc(header)}.${enc(claims)}`;
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, Buffer.from(input));
      return `${input}.${b64url(sig)}`;
    };
    return { pub, signRaw };
  }
  const w = wallet();
  const expect0 = { aud: CLIENT_ID, nonce: telegramNonce(w.pk, NOW), now: NOW };

  it("refuses alg:none", async () => {
    const { pub } = await es256();
    const tok = `${enc({ alg: "none", kid: "k1" })}.${enc(goodClaims(w))}.`;
    await expect(verifyIdToken(tok, { keys: [{ ...pub, kid: "k1" }] }, expect0)).rejects.toThrow(/unsupported alg/);
  });
  it("refuses HS256 (e.g. an HMAC keyed with the public key)", async () => {
    const { pub } = await es256();
    const input = `${enc({ alg: "HS256", kid: "k1" })}.${enc(goodClaims(w))}`;
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", JSON.stringify(pub)).update(input).digest("base64url");
    await expect(verifyIdToken(`${input}.${sig}`, { keys: [{ ...pub, kid: "k1" }] }, expect0)).rejects.toThrow(/unsupported alg/);
  });
  it("requires a kid, and a kid that exists", async () => {
    const { pub, signRaw } = await es256();
    const jwks = { keys: [{ ...pub, kid: "k1" }] };
    await expect(verifyIdToken(await signRaw({ alg: "ES256" }, goodClaims(w)), jwks, expect0)).rejects.toThrow(/missing kid/);
    await expect(verifyIdToken(await signRaw({ alg: "ES256", kid: "k2" }, goodClaims(w)), jwks, expect0)).rejects.toThrow(/unknown key/);
  });
  it("the key's declared alg must match the header's", async () => {
    const { pub, signRaw } = await es256();
    const tok = await signRaw({ alg: "ES256", kid: "k1" }, goodClaims(w));
    await expect(verifyIdToken(tok, { keys: [{ ...pub, kid: "k1", alg: "RS256" }] }, expect0)).rejects.toThrow(/key\/alg mismatch/);
    await expect(verifyIdToken(tok, { keys: [{ ...pub, kid: "k1", use: "enc" }] }, expect0)).rejects.toThrow(/not for signing/);
    await expect(verifyIdToken(tok, { keys: [{ ...pub, kid: "k1", alg: "ES256" }] }, expect0)).resolves.toMatchObject({ sub: "777" });
  });
  it("nbf in the future and a foreign azp are refused; several audiences need azp", async () => {
    const { pub, signRaw } = await es256();
    const jwks = { keys: [{ ...pub, kid: "k1" }] };
    const t = (c: Record<string, unknown>) => signRaw({ alg: "ES256", kid: "k1" }, { ...goodClaims(w), ...c });
    await expect(verifyIdToken(await t({ nbf: NOW + 3600 }), jwks, expect0)).rejects.toThrow(/not yet valid/);
    await expect(verifyIdToken(await t({ nbf: NOW - 10 }), jwks, expect0)).resolves.toBeTruthy();
    await expect(verifyIdToken(await t({ azp: "someone-else" }), jwks, expect0)).rejects.toThrow(/authorized party/);
    await expect(verifyIdToken(await t({ aud: [CLIENT_ID, "other"] }), jwks, expect0)).rejects.toThrow(/authorized party/);
    await expect(verifyIdToken(await t({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID }), jwks, expect0)).resolves.toBeTruthy();
  });
  it("JWKS is cached for 5 minutes per fetcher, and refetched once on an unknown kid (rotation)", async () => {
    const { jwksFor, redeemTelegramCode } = await import("../worker/src/telegram");
    const a = await issuer();
    const b = await issuer();
    let jwks = a.jwks;
    let jwksFetches = 0;
    let idToken = "";
    const f = async (url: string) => {
      if (url === TELEGRAM_TOKEN_URL) return new Response(JSON.stringify({ id_token: idToken }));
      jwksFetches++;
      return new Response(JSON.stringify(jwks));
    };
    const p = { clientId: CLIENT_ID, clientSecret: "s", code: "c", verifier: VERIFIER, redirectUri: "https://app.example/", owner: w.pk, issued: NOW, now: NOW };
    idToken = await a.sign(goodClaims(w));
    await redeemTelegramCode(f, p);
    await redeemTelegramCode(f, { ...p, now: NOW + 60 });
    expect(jwksFetches).toBe(1);
    await jwksFor(f, NOW + 301);
    expect(jwksFetches).toBe(2);
    // Rotation: Telegram now signs with a new key ("k1" again but different material → use a fresh kid).
    jwks = { keys: [...a.jwks.keys, { ...b.jwks.keys[0], kid: "k2" }] };
    idToken = await b.sign({ ...goodClaims(w), iat: NOW + 340 }, "k2");
    await redeemTelegramCode(f, { ...p, now: NOW + 340 });
    expect(jwksFetches).toBe(3);
  });
});
