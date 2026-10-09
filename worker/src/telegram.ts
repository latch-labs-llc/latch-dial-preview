/**
 * Telegram ↔ wallet linking (v0.4 B1).
 *
 * Login Widget path (default): the widget payload is a bearer token signed
 * by Telegram but NOT bound to the wallet, so it is accepted only if
 *   - every field has the documented type and no unknown field is present,
 *   - auth_date is within 5 minutes,
 *   - the HMAC matches (constant-time),
 *   - its hash has never been used before (single use; recorded with a TTL).
 *
 * OIDC path (flag: TELEGRAM_OIDC_CLIENT_ID + _SECRET): authorization code +
 * PKCE. The Worker redeems the code itself (it holds the client secret, the
 * browser holds the PKCE verifier), verifies the id_token against Telegram's
 * JWKS, and requires id_token.nonce = H(wallet ‖ issued) — the same wallet
 * and timestamp the wallet signed. Fails closed if the nonce is absent.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { telegramNonce, type TelegramAuth } from "../../src/lib/claims";

export const TELEGRAM_AUTH_MAX_AGE = 300;
export const TELEGRAM_FUTURE_SKEW = 60;
export const TELEGRAM_LINK_TTL = 60 * 86400;
/** Used-login markers outlive the acceptance window. */
export const TELEGRAM_USED_TTL = 2 * (TELEGRAM_AUTH_MAX_AGE + TELEGRAM_FUTURE_SKEW);

export const TG_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const WIDGET_FIELDS = new Set(["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]);

/** Strict shape check of a Login Widget payload. Returns why it's unacceptable, or null. */
export function telegramAuthProblem(tg: unknown): string | null {
  if (!tg || typeof tg !== "object" || Array.isArray(tg)) return "not an object";
  const o = tg as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!WIDGET_FIELDS.has(k)) return `unexpected field ${k}`;
  if (typeof o.id !== "number" || !Number.isSafeInteger(o.id) || o.id <= 0) return "bad id";
  if (typeof o.auth_date !== "number" || !Number.isSafeInteger(o.auth_date) || o.auth_date <= 0) return "bad auth_date";
  if (typeof o.hash !== "string" || !/^[0-9a-f]{64}$/.test(o.hash)) return "bad hash";
  if (o.username !== undefined && (typeof o.username !== "string" || !TG_USERNAME_RE.test(o.username))) return "bad username";
  for (const k of ["first_name", "last_name"]) if (o[k] !== undefined && (typeof o[k] !== "string" || (o[k] as string).length > 256)) return `bad ${k}`;
  if (o.photo_url !== undefined && (typeof o.photo_url !== "string" || o.photo_url.length > 1024 || !o.photo_url.startsWith("https://"))) return "bad photo_url";
  return null;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Telegram Login Widget check: HMAC-SHA256(data_check_string, SHA256(bot_token)), within 5 minutes. */
export function verifyTelegramAuth(tg: TelegramAuth, botToken: string, now: number): boolean {
  if (telegramAuthProblem(tg)) return false;
  if (now - tg.auth_date > TELEGRAM_AUTH_MAX_AGE || tg.auth_date - now > TELEGRAM_FUTURE_SKEW) return false;
  const fields = Object.entries(tg)
    .filter(([k, v]) => k !== "hash" && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = sha256(new TextEncoder().encode(botToken));
  const mac = bytesToHex(hmac(sha256, secret, new TextEncoder().encode(fields)));
  return constantTimeEqual(mac, tg.hash);
}

// ------------------------------------------------------------------- OIDC

export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
export const TELEGRAM_TOKEN_URL = "https://oauth.telegram.org/token";
export const TELEGRAM_JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

const ALGS: Record<string, { importAlg: any; verifyAlg: any }> = {
  RS256: { importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAlg: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { importAlg: { name: "ECDSA", namedCurve: "P-256" }, verifyAlg: { name: "ECDSA", hash: "SHA-256" } },
  EdDSA: { importAlg: { name: "Ed25519" }, verifyAlg: { name: "Ed25519" } },
};

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  sub: string;
  exp: number;
  iat: number;
  nbf?: number;
  nonce?: string;
  preferred_username?: string;
}

/** Verify a compact JWS id_token against a JWKS and the expected OIDC claims. Throws on any failure. */
export async function verifyIdToken(
  jwt: string,
  jwks: { keys: any[] },
  expect: { aud: string; nonce: string; now: number },
): Promise<IdTokenClaims> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64urlJson(parts[0]);
  // Only asymmetric algorithms we implement: "none", HS256 etc. are refused outright.
  const alg = Object.prototype.hasOwnProperty.call(ALGS, header.alg) ? ALGS[header.alg] : undefined;
  if (!alg) throw new Error("unsupported alg");
  if (typeof header.kid !== "string" || !header.kid) throw new Error("missing kid");
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown key");
  if (jwk.alg !== undefined && jwk.alg !== header.alg) throw new Error("key/alg mismatch");
  if (jwk.use !== undefined && jwk.use !== "sig") throw new Error("key not for signing");
  const key = await crypto.subtle.importKey("jwk", jwk, alg.importAlg, false, ["verify"]);
  const ok = await crypto.subtle.verify(alg.verifyAlg, key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("bad signature");
  const c = b64urlJson(parts[1]) as IdTokenClaims;
  if (c.iss !== TELEGRAM_ISSUER) throw new Error("wrong issuer");
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(expect.aud)) throw new Error("wrong audience");
  if (typeof c.exp !== "number" || c.exp <= expect.now) throw new Error("expired");
  if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > expect.now + TELEGRAM_FUTURE_SKEW)) throw new Error("not yet valid");
  // azp: if present it must be us; with several audiences it is required (OIDC Core 3.1.3.7).
  if (c.azp !== undefined ? c.azp !== expect.aud : auds.length > 1) throw new Error("wrong authorized party");
  if (typeof c.iat !== "number" || c.iat > expect.now + TELEGRAM_FUTURE_SKEW || expect.now - c.iat > TELEGRAM_AUTH_MAX_AGE) throw new Error("stale");
  // Fail closed: without a nonce the token isn't bound to the wallet.
  if (typeof c.nonce !== "string" || !constantTimeEqual(c.nonce, expect.nonce)) throw new Error("nonce mismatch");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("no subject");
  return c;
}

export const JWKS_TTL = 300;
const jwksCache = new WeakMap<Fetch, { at: number; jwks: { keys: any[] } }>();

/** Telegram's JWKS, cached for 5 minutes per fetcher; `refresh` refetches unless fetched in the last 30 s. */
export async function jwksFor(f: Fetch, now: number, refresh = false): Promise<{ keys: any[] }> {
  const c = jwksCache.get(f);
  if (c && now - c.at < (refresh ? 30 : JWKS_TTL)) return c.jwks;
  const jr = await f(TELEGRAM_JWKS_URL);
  if (!jr.ok) throw new Error("jwks unavailable");
  const jwks = (await jr.json()) as { keys: any[] };
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error("bad jwks");
  jwksCache.set(f, { at: now, jwks });
  return jwks;
}

/** Redeem an authorization code (client_secret_post + PKCE) and verify the id_token. */
export async function redeemTelegramCode(
  f: Fetch,
  p: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string; owner: string; issued: number; now: number },
): Promise<{ sub: string; username: string }> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
    client_id: p.clientId,
    client_secret: p.clientSecret,
  });
  const tr = await f(TELEGRAM_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  if (!tr.ok) throw new Error("token exchange failed");
  const tok = (await tr.json()) as { id_token?: string };
  if (typeof tok.id_token !== "string") throw new Error("no id_token");
  const expect = { aud: p.clientId, nonce: telegramNonce(p.owner, p.issued), now: p.now };
  let claims: IdTokenClaims;
  try {
    claims = await verifyIdToken(tok.id_token, await jwksFor(f, p.now), expect);
  } catch (e) {
    // Key rotation: on an unknown kid, refetch once (if the cache isn't brand new) and retry.
    if (!(e instanceof Error && e.message === "unknown key")) throw e;
    claims = await verifyIdToken(tok.id_token, await jwksFor(f, p.now, true), expect);
  }
  if (typeof claims.preferred_username !== "string" || !TG_USERNAME_RE.test(claims.preferred_username)) throw new Error("no Telegram username");
  return { sub: claims.sub, username: claims.preferred_username };
}
