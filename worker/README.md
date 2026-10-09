# latch-dial service (optional)

A Cloudflare Worker + KV that adds four conveniences to the dial app. The app
works without it, and no deal ever depends on it.

| Route | What | Trust |
|---|---|---|
| `/handles` | @username directory | Every claim is signed by the owning wallet; clients re-verify. `GET /handles` exports everything so anyone can mirror it. |
| `/telegram` | Telegram usernames linked to a wallet (opt-in, "findable" toggle, expire after 60 days) | Widget path: Telegram's HMAC (constant-time), strict field types, 5-minute window, each login usable once, plus the wallet's signature. OIDC path (flag): code + PKCE redeemed by the Worker, id_token checked against Telegram's JWKS with nonce = H(wallet ‖ issued). Clients can't re-check the Telegram side, so the app shows "linked via Latch service", never "verified". |
| `/backup` | Encrypted agreement backups | Ciphertext only; the key is derived on the device from a wallet signature. Writes need the owner's signature. |
| `/faucet` | 100 TEST/day (devnet test token) | Holds the test-mint authority as a Worker secret. It can mint worthless test tokens and nothing else. |

## Storage

- **Workers KV** — handles, Telegram links, holds, backup writer keys, encrypted
  backups, rate-limit counters (eventually consistent; fine for these).
- **One Durable Object (`Guards`)** — the checks that must be atomic: single-use
  Telegram logins (`tgu:`), per-wallet last signed `issued` (`li:`), and faucet
  cooldowns (`f:a:`, `f:i:`). A single global instance processes one request at
  a time, so each check-and-set is exact. Without the `GUARDS` binding the
  Worker refuses those requests (fails closed).

**Deploy change in v0.5:** `wrangler.toml` now declares the `GUARDS` Durable
Object binding and a `v1` migration (`new_sqlite_classes = ["Guards"]`). The
first `npx wrangler deploy` after upgrading applies the migration. Durable
Objects need a Workers plan that includes them (the SQLite-backed class works
on the free plan). Old `tgu:`/`li:`/`f:` keys in KV, if any, simply expire.

## Telegram widget (separate origin, no `unsafe-eval`)

The Login Widget never runs in the app's origin or the API's. Route a second
hostname (e.g. `tg-widget.<domain>`) to this Worker and set
`TELEGRAM_WIDGET_ORIGIN` to it; on that host the Worker serves only:

- `/?origin=<app>` — the widget, with `data-auth-url`;
- `/done?origin=<app>&…` — where Telegram sends the login; a nonce'd script
  posts it to the app and removes it from the URL.

Both pages have `default-src 'none'`, nonce'd scripts, `frame-ancestors <app>`,
and **no `'unsafe-eval'`**. On the API host these paths return 404. In
@BotFather, `/setdomain` must be the widget hostname. Build the app with
`VITE_TELEGRAM_WIDGET_URL=https://tg-widget.<domain>` (it's framed, sandboxed,
and only its messages are accepted).

Why `data-auth-url` and not `data-onauth`: in `telegram-widget.js?22`
(fetched 2026-10-05, sha256 `3c8c27bf6f51a778ed94f452cf6b501f54703b67ef162551f677171916fbcd99`),
`data-onauth` goes through `__parseFunction`, which wraps the attribute in
`(function(user){…})` and calls `eval()` (lines 3–6, used at line 194). So that
path really does need `'unsafe-eval'`. The `data-auth-url` branch (lines 196–207)
only builds a URL and sets `location.href`, so no eval is needed. Not yet tried
against a live bot.

## Deploy

```sh
npx wrangler kv namespace create KV        # put the id in wrangler.toml
node ../scripts/create-test-mint.mjs       # optional: TEST token (needs ~0.05 devnet SOL)
npx wrangler secret put FAUCET_SECRET      # paste .secrets/test-mint-authority.json
npx wrangler secret put TELEGRAM_BOT_TOKEN # optional: @BotFather token
# and set TELEGRAM_BOT_USERNAME + TELEGRAM_WIDGET_ORIGIN in wrangler.toml [vars] (see "Telegram widget").
# optional, instead of the widget: Telegram OIDC (register a client with Telegram first)
npx wrangler secret put TELEGRAM_OIDC_CLIENT_ID
npx wrangler secret put TELEGRAM_OIDC_CLIENT_SECRET
npx wrangler deploy
```

Then build the app with `VITE_SERVICE_URL=<worker url>`, and optionally
`VITE_TEST_MINT=<mint>` and `VITE_TELEGRAM_BOT=<bot username>` (widget) or
`VITE_TELEGRAM_OIDC_CLIENT_ID=<client id>` (OIDC; the Worker must have the same id + secret).
The OIDC flag stays off until a real Telegram client confirms it echoes the `nonce`
in the id_token — the Worker refuses tokens without it.

Retention and legal process: see `../DATA-AND-RETENTION.md` (also shown in the app under Settings → Data & legal requests). Set the legal-process contact before launch.
