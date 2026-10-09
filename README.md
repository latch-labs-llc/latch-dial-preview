# Latch dial

> **Source snapshot for Colosseum judging (October 2026).** This is a point-in-time copy of a
> private repository, published so the code behind https://dial.latchlabs.org can be read. It is
> not the development repository and will not track it. Licensed under the Business Source
> License 1.1 (see `LICENSE`); the Latch protocol it builds on is Apache-2.0.

Live on devnet at https://dial.latchlabs.org.

A Telegram-style protected-payments app for the [Latch](https://github.com/latch-labs-llc/latch)
open protocol. Pay anyone, and choose how much protection the payment gets:

- **⚡ Instant** — a plain transfer, final on arrival.
- **🛡 Protected** — held until you say it's OK — or 3, 10 or 14 days (you choose) after the
  recipient marks it shipped, unless you pause the clock. While paused it moves only when you
  both agree.
- **◇ Custom** — pay in parts, name someone you both trust to decide, or set your own rules.

> ⚠ Unaudited, experimental reference implementation on **Solana devnet only**. Test tokens only.
> The app is a client: it never deploys or changes any on-chain program, and no Latch Labs
> key exists anywhere in it. The devnet program itself is **upgradeable**: no instruction lets a
> Latch key move deal money, but new code could change the rules. Each time it creates, accepts, pays in or marks shipped,
> the app compares the deployed program-data hash with the pinned one and refuses on a mismatch
> (or if it can't check); Settings → Verify Latch shows expected and observed; every agreement text
> states the hash the app verified.

## Run it

```sh
npm install
npm run dev            # http://localhost:5173
npm run build && npm run preview   # verify the production bundle
```

Connect Phantom, Solflare or Backpack set to **Devnet**. The hosted build at dial.latchlabs.org
has the identity service on (@usernames, encrypted messages with term proposals, encrypted backups, TEST faucet). Get test USDC from
[Circle's faucet](https://faucet.circle.com/) and test SOL from [faucet.solana.com](https://faucet.solana.com/).

Optional env: `VITE_RPC_URL` (an RPC that allows `getProgramAccounts`),
`VITE_RPC_URL_2` (second RPC for the evidence packet cross-check), and for the optional
service in `worker/`: `VITE_SERVICE_URL` (@usernames, Telegram verification, encrypted
backups, faucet), `VITE_TEST_MINT` (self-serve TEST token), `VITE_TELEGRAM_BOT`.

## Try it on devnet in two minutes

Connect a wallet on devnet → **Add money** → *Demo money (instant)* gives you fee SOL and $1,000 test dollars (play money from the public devnet tap and the Latch Demo Dollar mint). **Contacts → Add demo contacts** gives you a *Demo seller* whose key is public, so on any deal with it the deal page shows the seller's buttons too: accept, mark shipped, approve, refund. You can walk a protected payment, a dispute and a refund alone. **Messages** (turn on from the Messages tab) lets two wallets chat and send each other signed term proposals before anything is created on chain; **Scan a code** reads a pay code or payment link with the camera. (`src/lib/demo.ts`; devnet only — this app has no mainnet code path.)

## Test it

```sh
node scripts/fetch-program.mjs   # downloads the DEPLOYED program bytes (read-only) and
                                 # refuses unless they match the published verified-build hash
npm test                         # 609 dial client tests (this repo only — not the main Latch repo's suite): every flow runs against that exact binary in LiteSVM,
                                 # plus the optional service, copy rules and backup crypto
node scripts/smoke.mjs           # production bundle via `vite preview` in headless Chromium
```

All test keypairs are generated fresh in memory per run and never written to disk.

## Layout

```
src/lib/      config, deal model + discovery offsets, flow builders (pure), template v2,
              evidence-keyed default policy, local store, wallet allowlist, router
src/screens/  Activity, Requests, Pay, Request, Builder, Deal, Agreement, Evidence,
              Contacts, Pay code, Add money, Settings, Welcome, sheets
src/components/ui.tsx   Telegram-style cells, sections, sheets (vaul), the dial radiogroup
worker/       optional Cloudflare Worker: handles, Telegram, backups, TEST faucet
test/         LiteSVM harness + flow tests on the deployed binary; service tests; copy test
```


Business Source License 1.1 — see `LICENSE`. Change Date 2030-10-09, Change License Apache-2.0.
