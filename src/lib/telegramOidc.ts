/**
 * Telegram OIDC (flag: VITE_TELEGRAM_OIDC_CLIENT_ID). Authorization code +
 * PKCE: the browser keeps the verifier, the service redeems the code with
 * its client secret, and the id_token must carry nonce = H(wallet ‖ issued)
 * for the wallet that signed "Latch Telegram link v2". Nothing from Telegram
 * runs in the app's origin — it's a full-page redirect.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { telegramNonce } from "./claims";

export const TELEGRAM_AUTHORIZE_URL = "https://oauth.telegram.org/auth";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(rand: Uint8Array = randomBytes(32)): { verifier: string; challenge: string } {
  const verifier = b64url(rand); // 43 chars
  return { verifier, challenge: b64url(sha256(new TextEncoder().encode(verifier))) };
}

export interface PendingOidc {
  state: string;
  verifier: string;
  owner: string;
  issued: number;
  sig: string;
  findable: boolean;
  redirectUri: string;
}

export function authorizeUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string; owner: string; issued: number }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: "openid profile",
    state: p.state,
    nonce: telegramNonce(p.owner, p.issued),
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  return `${TELEGRAM_AUTHORIZE_URL}?${q.toString()}`;
}

const KEY = "latch-dial/telegram-oidc";

export function savePending(p: PendingOidc, store: Pick<Storage, "setItem"> = sessionStorage) {
  store.setItem(KEY, JSON.stringify(p));
}

/**
 * On return from Telegram: the pending request whose state matches the
 * callback, or null. The pending entry is consumed either way (single use).
 */
export function takeCallback(search: string, store: Pick<Storage, "getItem" | "removeItem"> = sessionStorage): { code: string; pending: PendingOidc } | null {
  const q = new URLSearchParams(search);
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) return null;
  let pending: PendingOidc | null = null;
  try {
    pending = JSON.parse(store.getItem(KEY) ?? "null");
  } catch {
    pending = null;
  }
  store.removeItem(KEY);
  if (!pending || pending.state !== state) return null;
  return { code, pending };
}
