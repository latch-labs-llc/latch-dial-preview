# Hosting the built app

`npm run build` writes `dist/`. Serve it as static files over HTTPS.

## Security headers (required)

The build emits **`dist/_headers`**, computed from the build's `VITE_RPC_URL`,
`VITE_RPC_URL_2` and `VITE_SERVICE_URL`. It carries the full
Content-Security-Policy **including `frame-ancestors 'none'`** (no one may frame
the app — clickjacking), plus `X-Frame-Options: DENY`, `nosniff`, a no-referrer
policy and a restrictive Permissions-Policy.

- **Cloudflare Pages / Netlify** read `_headers` automatically. Nothing else to do.
- **Any other host** (nginx, Caddy, S3 + CloudFront, Vercel, GitHub Pages…):
  copy the header lines from `dist/_headers` into the host's header config
  for every path. GitHub Pages can't set headers; don't use it for production.

The same CSP (without `frame-ancestors`, which browsers ignore in a `<meta>`)
is also embedded in `index.html` as a fallback, so scripts, connections and
frames stay restricted even on a host that drops the headers. Clickjacking
protection needs the header.

Why each frame source is there:
- the optional service's origin — its sandboxed Telegram Login Widget page;
- `https://connect.solflare.com` — with no Solflare extension installed,
  `@solana/wallet-adapter-solflare` loads `@solflare-wallet/sdk`, which
  embeds that page in an iframe. Remove it if Solflare leaves the allowlist.

## Production: dial.latchlabs.org on Cloudflare Pages

Build inputs live in `.env.production` (gitignored; `.env.example` documents every
variable, none of them secret):

```
VITE_RPC_URL=<Helius devnet URL>          # getProgramAccounts-capable; key is origin-restricted
VITE_RPC_URL_2=https://api.devnet.solana.com   # independent cross-check for the evidence packet
VITE_WS_URL=wss://api.devnet.solana.com   # confirmations on the public socket, see below
VITE_APP_DOMAIN=dial.latchlabs.org        # FIXED: changing it changes every user's backup keys
VITE_TEST_MINT=2fZy4obHV2oUBqptHiANRmQU4A2vF8fTriT1mTPVLANi   # Latch Demo Dollar; demo mode mints it
VITE_SERVICE_URL=https://latch-dial-service.latchlabs.workers.dev   # the identity service (below)
VITE_IDENTITY_LIVE=1                      # the Data & legal requests page names the contact
```

**Why the WebSocket is split from the RPC:** a metered provider caps concurrent
WebSocket connections per key, and that cap is shared with latchlabs.org, which
uses the same key over HTTP. `confirmTransaction` subscribes over the socket, so
confirmations ride the public devnet socket instead (`VITE_WS_URL`); the CSP
allows exactly that origin.

Deploy (direct upload; the GitHub-integrated build is not used so the repo
can stay private without granting Cloudflare access to it):

```
npm run build
npx wrangler pages deploy dist --project-name latch-dial --branch main
```

`wrangler` needs `CLOUDFLARE_API_TOKEN` (Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`
in the environment. The custom domain `dial.latchlabs.org` is attached to the
Pages project once; Cloudflare manages its CNAME. The apex `latchlabs.org` is
GitHub Pages and stays DNS-only — do not proxy it. CI (`.github/workflows/ci.yml`)
runs the same build and deploys on every green push to `main` when those two
secrets are set.

## The service: latch-dial-service.latchlabs.workers.dev

The identity service (`worker/`) is a Cloudflare Worker on the account's
`latchlabs.workers.dev` subdomain: @usernames, encrypted messages, encrypted backups and the TEST
faucet. Telegram linking stays off until a bot exists (its secrets are unset).
Deploy from `worker/` with the same token, which also needs Workers Scripts: Edit
and Workers KV Storage: Edit:

```
npx wrangler deploy                         # vars + KV id live in wrangler.toml
npx wrangler secret put FAUCET_SECRET       # JSON secret key of the LDD mint authority
```

`ALLOWED_ORIGINS` in `wrangler.toml` is the app origin; the build's CSP admits
the service origin from `VITE_SERVICE_URL` (https and wss: messages use a
WebSocket to the wallet's Inbox Durable Object for live nudges). A deploy applies
the Durable Object migrations in `wrangler.toml` (`Guards` v1, `Inbox` v2). The legal-process contact in
`DATA-AND-RETENTION.md` was set before the first deploy.

## Usernames and Telegram are labelled "Preview"

Until the data-retention and legal-requests pages are live on a deployed Latch
service, the app tags @usernames and Telegram linking "Preview". Build with
`VITE_IDENTITY_LIVE=1` only once the service you point `VITE_SERVICE_URL` at
publishes both pages.
