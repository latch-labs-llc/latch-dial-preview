/**
 * Latch dial — optional product-layer service (Cloudflare Worker + KV).
 *
 *   /handles      @username directory of wallet-signed claims (public export)
 *   /telegram     verified Telegram usernames linked to a wallet (opt-in)
 *   /backup       encrypted agreement backups (ciphertext only)
 *   /keys, /msg   encrypted messages between wallets (ciphertext + who wrote to whom; Inbox Durable Objects)
 *   /faucet       devnet TEST-token faucet
 *
 * Invariants (R8 §3.2): nothing here is needed for any deal to settle; the
 * service never holds a key that can sign for a party; every claim it serves
 * is signed by the wallet it concerns and re-verified by clients. The only
 * key it holds is the faucet's devnet test-mint authority (a Worker secret,
 * never in the repo), which can mint worthless test tokens and nothing else.
 *
 * Data minimisation: Telegram data stored = username,
 * verification time, "findable" flag. No names, photos or phone numbers.
 */
import {
  b58decode,
  fresh,
  fromB64,
  handleClaimMessage,
  handleProblem,
  handleReleaseMessage,
  normalizeHandle,
  sha256Hex,
  telegramLinkMessage,
  telegramLinkMessageV2,
  telegramUnlinkMessage,
  backupDeleteMessage,
  backupReadMessage,
  backupWriteMessage,
  backupWriterMessage,
  eraseMessage,
  messagingKeyRemoveMessage,
  msgDeleteMessage,
  msgPostMessage,
  msgReadMessage,
  msgSocketMessage,
  verifyMessagingKeyClaim,
  verifySig,
  type HandleClaim,
  type MessagingKeyClaim,
  type TelegramAuth,
} from "../../src/lib/claims";
import { MSG_SEALED_SIZES, dayOf, msgId, threadId } from "../../src/lib/msgCrypto";
import { inbox, type InboxNamespace, type InboxRecord } from "./inbox";
export { Inbox } from "./inbox";
import {
  TELEGRAM_USED_TTL,
  TELEGRAM_LINK_TTL,
  redeemTelegramCode,
  telegramAuthProblem,
  verifyTelegramAuth,
  type Fetch,
} from "./telegram";
export { verifyTelegramAuth } from "./telegram";
import { guards, type GuardsNamespace } from "./guards";
export { Guards } from "./guards";
import { SEALED_SIZES } from "../../src/lib/backupCrypto";

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export interface Env {
  KV: KV;
  /** Telegram bot token (Worker secret) — only for verifying Login Widget data. */
  TELEGRAM_BOT_TOKEN?: string;
  /** JSON array secret key of the devnet TEST mint authority (Worker secret). */
  FAUCET_SECRET?: string;
  TEST_MINT?: string;
  RPC_URL?: string;
  /** Comma-separated allowed origins for CORS ("*" for any). */
  ALLOWED_ORIGINS?: string;
  /** Public bot username for the sandboxed Login Widget page (its /setdomain must be the widget origin). */
  TELEGRAM_BOT_USERNAME?: string;
  /** Separate origin that serves ONLY the widget pages, e.g. https://tg-widget.example (v0.5 #7). */
  TELEGRAM_WIDGET_ORIGIN?: string;
  /** Telegram OIDC (flag): both set → POST /telegram/oidc is enabled. */
  TELEGRAM_OIDC_CLIENT_ID?: string;
  TELEGRAM_OIDC_CLIENT_SECRET?: string;
  /** Injected by tests: Telegram token/JWKS endpoints. */
  oidcFetch?: Fetch;
  /** Durable Object for the atomic checks (tgu:, li:, f:) — see guards.ts. */
  GUARDS?: GuardsNamespace;
  /** One Durable Object per wallet holding its messages — see inbox.ts. */
  INBOX?: InboxNamespace;
  /** Injected by tests: is `owner` a party to `deal`? (default: devnet RPC) */
  dealHasOwner?: (deal: string, owner: string) => Promise<boolean>;
  /** Injected by tests: sends faucet instructions. */
  faucetSender?: (address: string) => Promise<string>;
}

const MAX_BACKUPS_PER_OWNER = 500;
const FAUCET_COOLDOWN_SECS = 20 * 3600;
/** Messages and their inbox pointers expire; the parties keep their own copies. */
export const MSG_TTL = 90 * 86400;
/** Sends per wallet per day (best effort, KV counter). */
export const MSG_DAILY_LIMIT = 500;
const MSG_COUNTER_TTL = 2 * 86400;
/** A poll returns at most this many messages; the client continues from the last one. */
export const MSG_PAGE = 200;

/**
 * CORS pinned to the app's origin(s) (B9). No wildcard: "*" in
 * ALLOWED_ORIGINS is ignored, and an unlisted origin gets no
 * Access-Control-Allow-Origin at all (the browser then blocks the response).
 */
function cors(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "*");
  return {
    ...(allowed.includes(origin) ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-latch-issued, x-latch-sig",
    vary: "origin",
  };
}

const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });

const isB58Key = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export async function handle(req: Request, env: Env, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  // The Telegram widget has its OWN origin (v0.5 #7): on that host only the two
  // widget pages exist; on the API host they don't.
  const reqUrl = new URL(req.url);
  if (env.TELEGRAM_WIDGET_ORIGIN && reqUrl.origin === env.TELEGRAM_WIDGET_ORIGIN) return widgetHost(req, env, reqUrl);
  const h = cors(env, req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const body = async () => {
    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) throw new TooLarge();
    try {
      return JSON.parse(text) as any;
    } catch {
      return null;
    }
  };

  try {
    // Every write is rate-limited per IP and size-capped before parsing (B7).
    if (["POST", "PUT", "DELETE"].includes(req.method)) {
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) return json(413, { error: "request too large" }, h);
      if (parts[0] !== "faucet" && (await rateLimited(env, "write", clientIp(req), WRITE_LIMIT, 60, now))) return json(429, { error: "Too many requests. Try again in a minute." }, h);
    }
    // Lookups by name or wallet are rate-limited per client IP (best effort on KV; see DATA-AND-RETENTION.md).
    if (req.method === "GET" && ["owners", "telegram", "handles", "keys", "msg"].includes(parts[0]) && parts[1]) {
      if (await rateLimited(env, "lookup", clientIp(req), LOOKUP_LIMIT, 60, now)) return json(429, { error: "Too many lookups. Try again in a minute." }, h);
    }
    // ------------------------------------------------------------ health
    if (parts[0] === "health") return json(200, { ok: true }, h);

    // ----------------------------------------------------------- handles
    if (parts[0] === "handles") {
      if (req.method === "GET" && parts[1]) {
        const v = await env.KV.get(`h:${normalizeHandle(parts[1])}`);
        return v ? json(200, JSON.parse(v), h) : json(404, { error: "not found" }, h);
      }
      if (req.method === "GET") {
        // Public export, one page at a time (anyone can mirror the directory),
        // cacheable at the edge; follow `cursor` for the next page.
        if (await rateLimited(env, "export", clientIp(req), EXPORT_LIMIT, 60, now)) return json(429, { error: "Too many requests. Try again in a minute." }, h);
        const page = await env.KV.list({ prefix: "h:", cursor: url.searchParams.get("cursor") ?? undefined, limit: HANDLES_PAGE });
        const claims: HandleClaim[] = [];
        for (const k of page.keys) {
          const v = await env.KV.get(k.name);
          if (v) claims.push(JSON.parse(v));
        }
        return json(200, { format: "latch-handles@1", claims, cursor: page.list_complete ? null : page.cursor }, { ...h, "cache-control": "public, max-age=300" });
      }
      if (req.method === "POST") {
        const b = await body();
        const handleName = normalizeHandle(String(b?.handle ?? ""));
        const problem = handleProblem(handleName);
        if (problem) return json(400, { error: problem }, h);
        if (!isB58Key(b?.owner) || typeof b?.issued !== "number" || typeof b?.sig !== "string") return json(400, { error: "bad request" }, h);
        if (!fresh(b.issued, now)) return json(400, { error: "stale signature" }, h);
        if (!verifySig(handleClaimMessage(handleName, b.owner, b.issued), b.sig, b.owner)) return json(401, { error: "bad signature" }, h);
        const existing = await env.KV.get(`h:${handleName}`);
        if (existing && JSON.parse(existing).owner !== b.owner) return json(409, { error: "That name is taken." }, h);
        const hold = await env.KV.get(`hr:${handleName}`);
        if (hold && JSON.parse(hold).owner !== b.owner && JSON.parse(hold).until > now)
          return json(409, { error: "That name was released recently and is held for its previous owner for 60 days." }, h);
        if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        const prev = await env.KV.get(`o:${b.owner}`);
        if (prev && prev !== handleName) await releaseOwnedName(env, prev, b.owner, now);
        const claim: HandleClaim = { handle: handleName, owner: b.owner, issued: b.issued, sig: b.sig };
        await env.KV.put(`h:${handleName}`, JSON.stringify(claim), { expirationTtl: RECORD_TTL });
        await env.KV.put(`o:${b.owner}`, handleName, { expirationTtl: RECORD_TTL });
        return json(200, claim, h);
      }
      if (req.method === "DELETE") {
        const b = await body();
        if (!isB58Key(b?.owner) || typeof b?.issued !== "number" || !fresh(b.issued, now)) return json(400, { error: "bad request" }, h);
        if (!verifySig(handleReleaseMessage(b.owner, b.issued), b.sig, b.owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        const prev = await env.KV.get(`o:${b.owner}`);
        if (prev) await releaseOwnedName(env, prev, b.owner, now);
        await env.KV.delete(`o:${b.owner}`);
        return json(200, { ok: true }, h);
      }
    }

    if (parts[0] === "owners" && parts[1] && req.method === "GET") {
      const owner = parts[1];
      const handleName = await env.KV.get(`o:${owner}`);
      const claim = handleName ? await env.KV.get(`h:${handleName}`) : null;
      const tgRaw = await env.KV.get(`tgo:${owner}`);
      const tg = tgRaw ? (JSON.parse(tgRaw) as TgRecord) : null;
      // A Telegram identity is only ever revealed for a wallet that opted in to being findable.
      const telegram = tg && tg.findable && tg.expiresAt > now ? publicTg(tg) : null;
      return json(200, { handle: claim ? JSON.parse(claim) : null, telegram }, h);
    }

    // ---------------------------------------------------------- telegram
    if (parts[0] === "telegram") {
      if (req.method === "GET" && parts[1] && parts[1] !== "oidc") {
        const v = await env.KV.get(`tg:${normalizeHandle(parts[1])}`);
        const rec = v ? (JSON.parse(v) as TgRecord) : null;
        return rec && rec.findable && rec.expiresAt > now ? json(200, publicTg(rec), h) : json(404, { error: "not found" }, h);
      }
      if (req.method === "POST" && parts[1] === "oidc") {
        if (!env.TELEGRAM_OIDC_CLIENT_ID || !env.TELEGRAM_OIDC_CLIENT_SECRET) return json(503, { error: "Telegram sign-in isn't configured" }, h);
        const b = await body();
        if (!isB58Key(b?.owner) || typeof b?.issued !== "number" || typeof b?.sig !== "string") return json(400, { error: "bad request" }, h);
        if (typeof b?.code !== "string" || b.code.length > 512 || typeof b?.verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(b.verifier)) return json(400, { error: "bad request" }, h);
        if (typeof b?.redirectUri !== "string" || !/^https:\/\//.test(b.redirectUri)) return json(400, { error: "bad request" }, h);
        if (!fresh(b.issued, now)) return json(400, { error: "stale signature" }, h);
        if (!verifySig(telegramLinkMessageV2(b.owner, b.issued), b.sig, b.owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        // Single use, atomically (Durable Object).
        if (!(await guards(env.GUARDS).useOnce(`tgu:${sha256Hex(new TextEncoder().encode(`code|${b.code}`))}`, TELEGRAM_USED_TTL, now)))
          return json(409, { error: "This Telegram sign-in was already used." }, h);
        let who: { sub: string; username: string };
        try {
          who = await redeemTelegramCode(env.oidcFetch ?? fetch, {
            clientId: env.TELEGRAM_OIDC_CLIENT_ID,
            clientSecret: env.TELEGRAM_OIDC_CLIENT_SECRET,
            code: b.code,
            verifier: b.verifier,
            redirectUri: b.redirectUri,
            owner: b.owner,
            issued: b.issued,
            now,
          });
        } catch {
          return json(401, { error: "Telegram sign-in could not be verified" }, h);
        }
        return json(200, publicTg(await storeTgLink(env, b.owner, who.username, b.findable === true, now)), h);
      }
      if (req.method === "POST") {
        if (!env.TELEGRAM_BOT_TOKEN) return json(503, { error: "Telegram linking isn't configured" }, h);
        const b = await body();
        const tg = b?.tg as TelegramAuth | undefined;
        if (!isB58Key(b?.owner) || typeof b?.issued !== "number" || typeof b?.sig !== "string" || telegramAuthProblem(tg)) return json(400, { error: "bad request" }, h);
        if (!tg!.username) return json(400, { error: "Set a Telegram username first (Telegram → Settings → Username)." }, h);
        if (!fresh(b.issued, now)) return json(400, { error: "stale signature" }, h);
        if (!verifyTelegramAuth(tg!, env.TELEGRAM_BOT_TOKEN, now)) return json(401, { error: "Telegram login could not be verified" }, h);
        if (!verifySig(telegramLinkMessage(b.owner, tg!.id, tg!.username, b.issued), b.sig, b.owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        // Single use: a login payload seen by anyone else can't be replayed.
        if (!(await guards(env.GUARDS).useOnce(`tgu:${tg!.hash}`, TELEGRAM_USED_TTL, now)))
          return json(409, { error: "This Telegram login was already used. Log in with Telegram again." }, h);
        return json(200, publicTg(await storeTgLink(env, b.owner, tg!.username, b.findable === true, now)), h);
      }
      if (req.method === "DELETE") {
        const b = await body();
        if (!isB58Key(b?.owner) || typeof b?.issued !== "number" || !fresh(b.issued, now)) return json(400, { error: "bad request" }, h);
        if (!verifySig(telegramUnlinkMessage(b.owner, b.issued), b.sig, b.owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        const prev = await env.KV.get(`tgo:${b.owner}`);
        if (prev) await deleteIfOwned(env, `tg:${JSON.parse(prev).username}`, b.owner);
        await env.KV.delete(`tgo:${b.owner}`);
        return json(200, { ok: true }, h);
      }
    }

    // ------------------------------------------------------------ backup
    if (parts[0] === "backup" && isB58Key(parts[1])) {
      const owner = parts[1];
      if (req.method === "GET") {
        // Authenticated: only the owner's registered writer key may list ciphertext.
        const w = await getWriter(env, owner);
        const issued = Number(req.headers.get("x-latch-issued"));
        const sig = req.headers.get("x-latch-sig") ?? "";
        if (!w) return json(404, { error: "not found" }, h);
        if (!Number.isSafeInteger(issued) || !fresh(issued, now) || !verifySig(backupReadMessage(owner, issued), sig, w.writer)) return json(401, { error: "bad signature" }, h);
        // Writer-signed requests have their own monotonic lane (li:<wallet>:w), so a captured read can't be replayed.
        if (!(await bumpIssued(env, `${owner}:w`, issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        const out: { id: string; ct: string; at: number }[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.KV.list({ prefix: `b:${owner}:`, cursor, limit: 1000 });
          for (const k of page.keys) {
            const v = await env.KV.get(k.name);
            if (v) out.push(JSON.parse(v));
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return json(200, { kcv: w.kcv, backups: out }, h);
      }
      if (req.method === "DELETE") {
        const b = await body();
        const target = parts[2] ?? "all";
        if (typeof b?.issued !== "number" || typeof b?.sig !== "string" || !fresh(b.issued, now) || (target !== "all" && !isB58Key(target) && !/^[0-9a-f]{64}$/.test(target)))
          return json(400, { error: "bad request" }, h);
        if (!verifySig(backupDeleteMessage(owner, target, b.issued), b.sig, owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        if (target === "all") {
          const n = await deletePrefix(env, `b:${owner}:`);
          await env.KV.delete(`w:${owner}`);
          return json(200, { deleted: n }, h);
        }
        await env.KV.delete(`b:${owner}:${target}`);
        return json(200, { deleted: 1 }, h);
      }
      if (req.method === "POST" && parts[2] === "writer") {
        const b = await body();
        if (!isB58Key(b?.writer) || typeof b?.kcv !== "string" || !/^[0-9a-f]{32}$/.test(b.kcv) || typeof b?.issued !== "number" || typeof b?.sig !== "string")
          return json(400, { error: "bad request" }, h);
        if (!fresh(b.issued, now)) return json(400, { error: "stale signature" }, h);
        if (!verifySig(backupWriterMessage(owner, b.writer, b.kcv, b.issued), b.sig, owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        await env.KV.put(`w:${owner}`, JSON.stringify({ writer: b.writer, kcv: b.kcv }), { expirationTtl: RECORD_TTL });
        return json(200, { ok: true }, h);
      }
      if (req.method === "PUT" && /^[0-9a-f]{64}$/.test(parts[2] ?? "")) {
        // The id is HMAC(user key, deal): the deal address is never stored.
        const id = parts[2];
        const b = await body();
        if (typeof b?.ct !== "string" || !isB58Key(b?.deal) || typeof b?.issued !== "number" || typeof b?.sig !== "string") return json(400, { error: "bad request" }, h);
        const ct = fromB64(b.ct);
        if (!SEALED_SIZES.includes(ct.length)) return json(400, { error: "backup must be padded to a standard size" }, h);
        if (!fresh(b.issued, now)) return json(400, { error: "stale signature" }, h);
        const w = await getWriter(env, owner);
        if (!w) return json(403, { error: "no backup writer registered" }, h);
        if (!verifySig(backupWriteMessage(owner, id, b.deal, sha256Hex(ct), b.issued), b.sig, w.writer)) return json(401, { error: "bad signature" }, h);
        // A replayed upload could put back older ciphertext: refuse anything not newer.
        if (!(await bumpIssued(env, `${owner}:w`, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        // Only agreements this wallet is a party to (checked, never stored).
        const isParty = await (env.dealHasOwner ?? ((d: string, o: string) => rpcDealHasOwner(env, d, o)))(b.deal, owner).catch(() => false);
        if (!isParty) return json(403, { error: "backups are only for payments this wallet is part of" }, h);
        const count = (await env.KV.list({ prefix: `b:${owner}:`, limit: MAX_BACKUPS_PER_OWNER + 1 })).keys.length;
        if (count >= MAX_BACKUPS_PER_OWNER && !(await env.KV.get(`b:${owner}:${id}`))) return json(429, { error: "backup limit reached" }, h);
        await env.KV.put(`b:${owner}:${id}`, JSON.stringify({ id, ct: b.ct, at: now }), { expirationTtl: RECORD_TTL });
        await env.KV.put(`w:${owner}`, JSON.stringify(w), { expirationTtl: RECORD_TTL }); // renew the writer with use
        return json(200, { ok: true }, h);
      }
    }

    // ---------------------------------------------------- messaging keys
    // A wallet publishes the X25519 key peers encrypt to and the Ed25519 key
    // its device signs sends with (one wallet-signed claim, re-verified by peers).
    if (parts[0] === "keys") {
      if (req.method === "GET" && isB58Key(parts[1])) {
        const v = await env.KV.get(`mk:${parts[1]}`);
        return v ? json(200, JSON.parse(v), h) : json(404, { error: "not found" }, h);
      }
      if (req.method === "PUT") {
        const b = await body();
        if (!isB58Key(b?.owner) || !isB58Key(b?.enc) || !isB58Key(b?.signer) || typeof b?.issued !== "number" || typeof b?.sig !== "string") return json(400, { error: "bad request" }, h);
        if (!fresh(b.issued, now)) return json(400, { error: "stale signature" }, h);
        const claim: MessagingKeyClaim = { owner: b.owner, enc: b.enc, signer: b.signer, issued: b.issued, sig: b.sig };
        if (!verifyMessagingKeyClaim(claim)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        await env.KV.put(`mk:${b.owner}`, JSON.stringify(claim), { expirationTtl: RECORD_TTL });
        return json(200, claim, h);
      }
      if (req.method === "DELETE") {
        const b = await body();
        if (!isB58Key(b?.owner) || typeof b?.issued !== "number" || typeof b?.sig !== "string" || !fresh(b.issued, now)) return json(400, { error: "bad request" }, h);
        if (!verifySig(messagingKeyRemoveMessage(b.owner, b.issued), b.sig, b.owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        await env.KV.delete(`mk:${b.owner}`);
        return json(200, { ok: true }, h);
      }
    }

    // ---------------------------------------------------------- messages
    // Ciphertext only, kept in each party's own Inbox (a Durable Object per
    // wallet: strongly consistent, with a live nudge to open sockets). Each
    // record names who wrote to whom and when; what it says is sealed between
    // the two.
    if (parts[0] === "msg") {
      if (req.method === "POST") {
        const b = await body();
        if (!isB58Key(b?.from) || !isB58Key(b?.to) || typeof b?.thread !== "string" || !Number.isSafeInteger(b?.seq) || b.seq < 0 || typeof b?.ct !== "string" || typeof b?.issued !== "number" || typeof b?.sig !== "string")
          return json(400, { error: "bad request" }, h);
        if (b.from === b.to) return json(400, { error: "bad request" }, h);
        if (b.thread !== threadId(b.from, b.to)) return json(400, { error: "thread id doesn't match the parties" }, h);
        if (!fresh(b.issued, now)) return json(400, { error: "stale signature" }, h);
        const ct = fromB64(b.ct);
        if (!MSG_SEALED_SIZES.includes(ct.length)) return json(400, { error: "message must be padded to a standard size" }, h);
        const sender = await getMsgKeys(env, b.from);
        if (!sender) return json(403, { error: "no messaging keys registered" }, h);
        if (!verifySig(msgPostMessage(b.from, b.to, b.thread, b.seq, sha256Hex(ct), b.issued), b.sig, sender.signer)) return json(401, { error: "bad signature" }, h);
        if (!(await getMsgKeys(env, b.to))) return json(404, { error: "That wallet hasn't turned on messages." }, h);
        // Signer-signed sends have their own monotonic lane (li:<wallet>:m).
        if (!(await bumpIssued(env, `${b.from}:m`, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        const day = dayKey(now);
        const sent = Number((await env.KV.get(`mc:${b.from}:${day}`)) ?? "0");
        if (sent >= MSG_DAILY_LIMIT) return json(429, { error: "Daily message limit reached. Try again tomorrow." }, h);
        await env.KV.put(`mc:${b.from}:${day}`, String(sent + 1), { expirationTtl: MSG_COUNTER_TTL });
        const id = msgId(ct);
        // The signature travels with the record so the recipient's device can re-verify the sender (and keep it as evidence).
        const rec: InboxRecord = { thread: b.thread, from: b.from, to: b.to, seq: b.seq, ct: b.ct, at: now, issued: b.issued, sig: b.sig };
        await inbox(env.INBOX, b.from).append(id, rec, MSG_TTL, now);
        await inbox(env.INBOX, b.to).append(id, rec, MSG_TTL, now);
        await env.KV.put(`mk:${b.from}`, JSON.stringify(sender), { expirationTtl: RECORD_TTL }); // renew the keys with use
        return json(200, { id, at: now }, h);
      }
      if (req.method === "GET" && isB58Key(parts[1]) && parts[2] === "ws") {
        // Live nudges: the upgrade carries its signer signature in the query string (browsers can't set headers on an upgrade).
        const owner = parts[1];
        const keys = await getMsgKeys(env, owner);
        const issued = Number(url.searchParams.get("issued"));
        const sig = url.searchParams.get("sig") ?? "";
        if (!keys) return json(404, { error: "not found" }, h);
        if (!Number.isSafeInteger(issued) || !fresh(issued, now) || !verifySig(msgSocketMessage(owner, issued), sig, keys.signer)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, `${owner}:m`, issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        if (req.headers.get("upgrade") !== "websocket") return json(426, { error: "upgrade required" }, h);
        return inbox(env.INBOX, owner).socket(req);
      }
      if (req.method === "GET" && isB58Key(parts[1])) {
        // Authenticated: only the owner's registered signer may list its ciphertext.
        const owner = parts[1];
        const keys = await getMsgKeys(env, owner);
        const issued = Number(req.headers.get("x-latch-issued"));
        const sig = req.headers.get("x-latch-sig") ?? "";
        const since = Number(url.searchParams.get("since") ?? "0");
        if (!keys) return json(404, { error: "not found" }, h);
        if (!Number.isSafeInteger(since) || since < 0) return json(400, { error: "bad request" }, h);
        if (!Number.isSafeInteger(issued) || !fresh(issued, now) || !verifySig(msgReadMessage(owner, since, issued), sig, keys.signer)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, `${owner}:m`, issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        const r = await inbox(env.INBOX, owner).list(since, MSG_PAGE, now);
        return json(200, { messages: r.messages, now, more: r.more }, h);
      }
      if (req.method === "DELETE" && isB58Key(parts[1])) {
        const owner = parts[1];
        const b = await body();
        const target = parts[2] ?? "all";
        if (typeof b?.issued !== "number" || typeof b?.sig !== "string" || !fresh(b.issued, now) || (target !== "all" && !/^[0-9a-f]{32}$/.test(target))) return json(400, { error: "bad request" }, h);
        if (!verifySig(msgDeleteMessage(owner, target, b.issued), b.sig, owner)) return json(401, { error: "bad signature" }, h);
        if (!(await bumpIssued(env, owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
        return json(200, { deleted: await deleteMessages(env, owner, target === "all" ? "all" : { thread: target }, now) }, h);
      }
    }

    // ------------------------------------------------------ erase (B4)
    if (parts[0] === "me" && req.method === "DELETE") {
      const b = await body();
      if (!isB58Key(b?.owner) || typeof b?.issued !== "number" || typeof b?.sig !== "string" || !fresh(b.issued, now)) return json(400, { error: "bad request" }, h);
      if (!verifySig(eraseMessage(b.owner, b.issued), b.sig, b.owner)) return json(401, { error: "bad signature" }, h);
      if (!(await bumpIssued(env, b.owner, b.issued, now))) return json(409, { error: "replayed or out-of-order signature" }, h);
      return json(200, { deleted: await eraseOwner(env, b.owner, now) }, h);
    }

    // ------------------------------------------------------------ faucet
    if (parts[0] === "faucet" && req.method === "POST") {
      if (!env.faucetSender && (!env.FAUCET_SECRET || !env.TEST_MINT)) return json(503, { error: "The TEST faucet isn't configured" }, h);
      const b = await body();
      if (!isB58Key(b?.address)) return json(400, { error: "bad address" }, h);
      const ip = clientIp(req);
      const keys = [`f:a:${b.address}`, `f:i:${ip}`];
      const busy = () => json(429, { error: "You've already received TEST today. Try again tomorrow." }, h);
      // Claim both cooldowns atomically BEFORE sending (Durable Object): of
      // any number of concurrent requests, exactly one gets through.
      const claim = `${now}:${crypto.randomUUID()}`;
      if (!(await guards(env.GUARDS).claimAll(keys, claim, FAUCET_COOLDOWN_SECS, now))) return busy();
      const send = env.faucetSender ?? ((addr: string) => sendFaucet(env, addr));
      let sig: string;
      try {
        sig = await send(b.address);
      } catch (e: any) {
        console.error("faucet send failed:", e?.message ?? e); // Worker logs only; the body stays generic (B9)
        await guards(env.GUARDS).releaseAll(keys, claim, now); // let them retry
        return json(502, { error: "The faucet couldn't send right now. Try again later." }, h);
      }
      return json(200, { signature: sig, amount: FAUCET_AMOUNT_UI }, h);
    }

    return json(404, { error: "not found" }, h);
  } catch (e: any) {
    if (e instanceof TooLarge) return json(413, { error: "request too large" }, h);
    // Generic body (B9): exception messages can echo parts of keys or inputs.
    return json(500, { error: "internal error" }, h);
  }
}

export const LOOKUP_LIMIT = 60;
export const NAME_HOLD_SECS = 60 * 86400;
export const WRITE_LIMIT = 30;
export const EXPORT_LIMIT = 30;
export const HANDLES_PAGE = 200;
/** Largest request: a 64 KiB padded backup in base64 plus the signed envelope. */
export const MAX_BODY_BYTES = 96 * 1024;

class TooLarge extends Error {}

/**
 * Widget host (v0.5 #7). Served only on TELEGRAM_WIDGET_ORIGIN, a separate
 * origin from the API, framed only by an allowed app origin:
 *   /      the Login Widget, using data-auth-url — NOT data-onauth, because
 *          telegram-widget.js?22 turns data-onauth into code with eval()
 *          (__parseFunction); data-auth-url just navigates. So no 'unsafe-eval'.
 *   /done  where Telegram sends the login (as query parameters); a nonce'd
 *          script posts it to the app origin and strips it from the URL.
 */
async function widgetHost(req: Request, env: Env, url: URL): Promise<Response> {
  const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  if (req.method !== "GET" || !env.TELEGRAM_BOT_USERNAME || (url.pathname !== "/" && url.pathname !== "/done")) return notFound();
  const app = url.searchParams.get("origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "*");
  if (!/^https?:\/\/[^/]+$/.test(app) || !allowed.includes(app)) return new Response("origin not allowed", { status: 400 });
  if (url.pathname === "/") return widgetPage(env.TELEGRAM_BOT_USERNAME, app, `${url.origin}/done?origin=${encodeURIComponent(app)}`);
  if (url.pathname === "/done") return widgetDonePage(app);
  return notFound();
}

function pageHeaders(nonce: string, appOrigin: string, extra: string[]): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": ["default-src 'none'", `script-src 'nonce-${nonce}'${extra.includes("telegram") ? " https://telegram.org" : ""}`, ...(extra.includes("telegram") ? ["frame-src https://oauth.telegram.org", "img-src https: data:", "style-src 'unsafe-inline'"] : []), `frame-ancestors ${appOrigin}`, "base-uri 'none'", "form-action 'none'"].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

export function widgetPage(bot: string, appOrigin: string, authUrl: string): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const esc = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "");
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram login</title></head>
<body style="margin:0;background:transparent">
<script nonce="${nonce}" async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${esc(bot)}" data-size="large" data-radius="10" data-request-access="" data-auth-url="${attr(authUrl)}"></script>
</body></html>`;
  return new Response(html, { status: 200, headers: pageHeaders(nonce, appOrigin, ["telegram"]) });
}

const TG_FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"];

export function widgetDonePage(appOrigin: string): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const js = `(function(){var q=new URLSearchParams(location.search),u={};${JSON.stringify(TG_FIELDS)}.forEach(function(k){var v=q.get(k);if(v!==null)u[k]=(k==="id"||k==="auth_date")?Number(v):v;});history.replaceState(null,"",location.pathname);parent.postMessage({type:"latch-telegram-auth",user:u},${JSON.stringify(appOrigin)});})();`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Telegram login</title></head><body><script nonce="${nonce}">${js}</script></body></html>`;
  return new Response(html, { status: 200, headers: pageHeaders(nonce, appOrigin, []) });
}

export const LATCH_PROGRAM_ID = "BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv";
const DEAL_SIZE = 1036;
const NUM_PARTIES_AT = 51;
const PARTY_AT = (i: number) => 52 + 32 * i;

/** Is `owner` one of the parties in this raw Deal account? (layout pinned by the app's offsets test) */
export function dealHasParty(data: Uint8Array, owner: string): boolean {
  if (data.length !== DEAL_SIZE) return false;
  const n = data[NUM_PARTIES_AT];
  if (n < 2 || n > 8) return false;
  const want = b58decode(owner);
  if (want.length !== 32) return false;
  for (let i = 0; i < n; i++) {
    const p = data.subarray(PARTY_AT(i), PARTY_AT(i) + 32);
    if (p.every((x, j) => x === want[j])) return true;
  }
  return false;
}

/** Default check: read the deal from devnet RPC; it must be a Latch deal naming the owner as a party. */
async function rpcDealHasOwner(env: Env, deal: string, owner: string): Promise<boolean> {
  const r = await fetch(env.RPC_URL ?? "https://api.devnet.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [deal, { encoding: "base64", commitment: "confirmed" }] }),
  });
  const j = (await r.json()) as any;
  const v = j?.result?.value;
  if (!v || v.owner !== LATCH_PROGRAM_ID) return false;
  return dealHasParty(fromB64(v.data[0]), owner);
}

/** Read a request body, giving up (null) as soon as it passes `max` bytes. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all);
}

/** Delete a record only if it still belongs to `owner` (B7: no blind deletes). */
async function deleteIfOwned(env: Env, key: string, owner: string): Promise<void> {
  const v = await env.KV.get(key);
  if (!v) return;
  try {
    if (JSON.parse(v).owner === owner) await env.KV.delete(key);
  } catch {
    /* not a record we understand: leave it */
  }
}

/** Release a handle the owner holds: owner-checked delete, then a 60-day hold. */
async function releaseOwnedName(env: Env, name: string, owner: string, now: number): Promise<void> {
  const v = await env.KV.get(`h:${name}`);
  if (!v || JSON.parse(v).owner !== owner) return; // stale o: pointer — someone else's name now
  await env.KV.delete(`h:${name}`);
  await holdName(env, name, owner, now);
}
/** li: only has to outlive the freshness window (MAX_SKEW_SECS each way). */
export const LAST_ISSUED_TTL = 1200;
/** Long-lived records expire unless renewed (B4). */
export const RECORD_TTL = 400 * 86400;

/**
 * Per-owner monotonic clock (li:<owner>): every wallet-signed write must have
 * issued > the last accepted one. Kills replays inside the freshness window
 * and the rename-revert replay (re-posting an older, still-fresh claim).
 */
export async function bumpIssued(env: Env, owner: string, issued: number, now: number): Promise<boolean> {
  return guards(env.GUARDS).bumpIssued(owner, issued, LAST_ISSUED_TTL, now); // atomic (Durable Object)
}

async function getWriter(env: Env, owner: string): Promise<{ writer: string; kcv: string } | null> {
  const v = await env.KV.get(`w:${owner}`);
  if (!v) return null;
  try {
    const w = JSON.parse(v);
    return isB58Key(w?.writer) && typeof w?.kcv === "string" ? w : null;
  } catch {
    return null; // v1 (bare key) writers must re-register
  }
}

const dayKey = (unix: number) => String(dayOf(unix)).padStart(5, "0");

async function getMsgKeys(env: Env, owner: string): Promise<MessagingKeyClaim | null> {
  const v = await env.KV.get(`mk:${owner}`);
  if (!v) return null;
  try {
    const c = JSON.parse(v);
    return isB58Key(c?.signer) && isB58Key(c?.enc) && c?.owner === owner ? c : null;
  } catch {
    return null;
  }
}

/**
 * Delete a wallet's messages (one thread or all) from its own Inbox; the
 * records it SENT are dropped from the recipient's Inbox too. Records the
 * other party sent stay in theirs until they delete or they expire.
 */
async function deleteMessages(env: Env, owner: string, target: "all" | { thread: string }, now: number): Promise<number> {
  const r = await inbox(env.INBOX, owner).remove(target, owner, now);
  let n = r.deleted;
  const byPeer = new Map<string, string[]>();
  for (const s of r.sent) byPeer.set(s.to, [...(byPeer.get(s.to) ?? []), s.id]);
  for (const [peer, ids] of byPeer) n += (await inbox(env.INBOX, peer).remove({ ids }, owner, now)).deleted;
  return n;
}

async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) {
      await env.KV.delete(k.name);
      n++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}

/**
 * Everything the service keeps for a wallet: handle (+ any hold in its name),
 * Telegram link, backups and writer key, messaging keys and messages. li:
 * stays until it expires (20 min) so signatures made before the deletion
 * can't be replayed.
 */
async function eraseOwner(env: Env, owner: string, now: number): Promise<number> {
  let n = 0;
  const del = async (k: string) => {
    if ((await env.KV.get(k)) !== null) n++;
    await env.KV.delete(k);
  };
  const handleName = await env.KV.get(`o:${owner}`);
  if (handleName) {
    const c = await env.KV.get(`h:${handleName}`);
    if (c && JSON.parse(c).owner === owner) await del(`h:${handleName}`);
  }
  await del(`o:${owner}`);
  const tg = await env.KV.get(`tgo:${owner}`);
  if (tg) {
    const u = JSON.parse(tg).username;
    const fwd = await env.KV.get(`tg:${u}`);
    if (fwd && JSON.parse(fwd).owner === owner) await del(`tg:${u}`);
  }
  await del(`tgo:${owner}`);
  n += await deletePrefix(env, `b:${owner}:`);
  await del(`w:${owner}`);
  await del(`mk:${owner}`);
  n += await deleteMessages(env, owner, "all", now);
  n += await deletePrefix(env, `mc:${owner}:`);
  // Holds naming this wallet, via its own index (never a scan of every hold).
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: `ho:${owner}:`, cursor, limit: 1000 });
    for (const k of page.keys) {
      const name = k.name.slice(`ho:${owner}:`.length);
      const v = await env.KV.get(`hr:${name}`);
      if (v && JSON.parse(v).owner === owner) await del(`hr:${name}`);
      await env.KV.delete(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}

/** A released or renamed-away handle stays reserved for its previous owner for 60 days. */
async function holdName(env: Env, name: string, owner: string, now: number) {
  await env.KV.put(`hr:${name}`, JSON.stringify({ owner, until: now + NAME_HOLD_SECS }), { expirationTtl: NAME_HOLD_SECS });
  // Per-owner index so deleting a wallet's data touches only its own holds.
  await env.KV.put(`ho:${owner}:${name}`, "1", { expirationTtl: NAME_HOLD_SECS });
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * Fixed-window counter in KV: rl:<bucket>:<ip>:<window>. KV is eventually
 * consistent, so this caps bursts per edge location rather than exactly —
 * a Durable Object or Cloudflare's rate-limiting binding is the production fix.
 */
export async function rateLimited(env: Env, bucket: string, ip: string, limit: number, windowSecs: number, now: number): Promise<boolean> {
  const key = `rl:${bucket}:${ip}:${Math.floor(now / windowSecs)}`;
  const n = Number((await env.KV.get(key)) ?? "0");
  if (n >= limit) return true;
  await env.KV.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSecs * 2) });
  return false;
}

export interface TgRecord {
  owner: string;
  username: string;
  verifiedAt: number;
  expiresAt: number;
  findable: boolean;
}

/** Link (or move) a Telegram username to `owner`; links expire after 60 days. */
async function storeTgLink(env: Env, owner: string, rawUsername: string, findable: boolean, now: number): Promise<TgRecord> {
  const username = rawUsername.toLowerCase();
  const other = await env.KV.get(`tg:${username}`);
  if (other && JSON.parse(other).owner !== owner) {
    // A fresh Telegram login moves the name: drop the previous wallet's back-pointer, but only if it still points here.
    const victim = JSON.parse(other).owner as string;
    const back = await env.KV.get(`tgo:${victim}`);
    if (back && JSON.parse(back).username === username) await env.KV.delete(`tgo:${victim}`);
  }
  const prev = await env.KV.get(`tgo:${owner}`);
  if (prev && JSON.parse(prev).username !== username) await deleteIfOwned(env, `tg:${JSON.parse(prev).username}`, owner);
  const rec: TgRecord = {
    owner,
    username,
    verifiedAt: now,
    expiresAt: now + TELEGRAM_LINK_TTL,
    findable,
  };
  await env.KV.put(`tg:${username}`, JSON.stringify(rec), { expirationTtl: TELEGRAM_LINK_TTL });
  await env.KV.put(`tgo:${owner}`, JSON.stringify(rec), { expirationTtl: TELEGRAM_LINK_TTL });
  return rec;
}

function publicTg(rec: TgRecord) {
  return { username: rec.username, verifiedAt: rec.verifiedAt, expiresAt: rec.expiresAt, owner: rec.owner };
}

// ------------------------------------------------------------ faucet send

export const FAUCET_AMOUNT_UI = 100;

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Refuse to act unless the RPC is Solana devnet (B9): the faucet key must never touch another cluster. */
export async function assertDevnet(getGenesisHash: () => Promise<string>): Promise<void> {
  const g = await getGenesisHash();
  if (g !== DEVNET_GENESIS) throw new Error("RPC is not Solana devnet");
}

async function sendFaucet(env: Env, address: string): Promise<string> {
  const { Connection, Keypair, PublicKey, Transaction } = await import("@solana/web3.js");
  const { buildFaucetIxs } = await import("./faucet");
  const conn = new Connection(env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  await assertDevnet(() => conn.getGenesisHash());
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.FAUCET_SECRET!)));
  const tx = new Transaction().add(...buildFaucetIxs(authority.publicKey, new PublicKey(env.TEST_MINT!), new PublicKey(address)));
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(authority);
  const sig = await conn.sendRawTransaction(tx.serialize());
  // Poll over HTTP: confirmTransaction subscribes over a WebSocket, which never
  // delivers inside a Worker (the send went through; only the wait timed out).
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 750));
    const s = (await conn.getSignatureStatuses([sig])).value[0];
    if (s?.err) throw new Error("faucet transaction failed");
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return sig;
  }
  throw new Error("faucet transaction not confirmed in time");
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
