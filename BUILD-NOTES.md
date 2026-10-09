# latch-dial — BUILD-NOTES (v0.17, 2026-10-08)

A standalone client — the "dial app" from `research-synthesis.md` (R8) — built as
post-hackathon work in its own repo. It touches no existing Latch repo and never deploys
or modifies any on-chain program.

## v0.17 — Messages: a Durable Object inbox per wallet, live nudges; offline evidence re-check — 2 items

`npm test` → **609 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | Messages lived in KV, which is eventually consistent: the two-wallet E2E measured cross-party delivery lagging up to a minute, and the only way to notice a new message was a 15-second poll. | `worker/src/inbox.ts`: one **Inbox Durable Object per wallet** (`idFromName(wallet)`) holding that wallet's copy of every message it sent or received (`msg:<at>:<id>`, 90-day expiry swept by an alarm). `POST /msg` appends to both parties' inboxes; `GET /msg/:wallet` lists from the owner's own (strongly consistent, 200 per page); `DELETE /msg` and `DELETE /me` remove the owner's copies and its sent records from the other party's inbox. **Live nudges**: `GET /msg/:wallet/ws?issued&sig` (signer-signed in the query string — browsers can't set headers on an upgrade; same replay lane as reads) upgrades to a hibernating WebSocket on the wallet's Inbox; an append sends the one word `new` to every open socket and the app fetches over HTTP as before, so the socket carries no content. Client: `connectLive` (reconnect with backoff, 30 s ping; polling drops to a 30 s fallback). CSP: the service origin is allowed over `wss:` too. KV keeps only keys (`mk:`) and the day counter (`mc:`); the retention table moves messages to a Durable Object row; `wrangler.toml` migration v2. The E2E now shows the other side receiving within seconds. | `messaging.test` rewritten against the in-memory Inbox (both copies land at once, paging via `InboxCore`, delete scopes, erase, socket route auth 401/426/409/404, expiry sweep); `retention.test` (Durable Object rows = Guards + Inbox prefixes; erase count 11); `csp.test` (+wss service origin); E2E deal J8BcRPtB… | |
| 2 | An exported evidence bundle could only be read; nothing re-checked it away from the app (todo D9 "offline evidence-bundle re-checker"). | `scripts/recheck-evidence.mjs <bundle.json> [--rpc url] [--expect-hash hex]`: no dependencies beyond node:crypto and JCS — recomputes the bundle's SHA-256 (what the page printed; the file name carries its prefix), hashes the agreement text against `agreement.sha256` and the captured on-chain terms hash, checks line 1 names the template and the stated program hash is in the text, validates every document claim and acknowledgement (format, this deal, a party, a signature that is in the bundle; acks paired with presentations), transaction rows (unique signatures, events name this deal). With `--rpc`: the account is still owned by the program and each successful signature is known to the network (expired history is a note, not a failure). | `recheck.test` (consistent bundle passes and hashes; edited text, wrong terms hash, claim for another deal, stranger's ack, unknown signature all fail; online path through an injected RPC). | |

## v0.16 — Scan a code; saved presets — 2 items

WP8 from the v0.10 UX plan, and todo D9's "Builder presets saved on device". `npm test` → **603 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | Pay codes could be shown but not read: adding a contact or paying someone in front of you meant typing or pasting an address. | `src/screens/ScanSheet.tsx`: camera (`getUserMedia`, rear-facing) decoded with `BarcodeDetector` where the browser has it and `jsQR` otherwise (iOS Safari), frames never leave the device; a paste field for everything else. `src/lib/scan.ts` `parseScan`: a bare address, a `solana:` payment URI (amount/label carried into Pay), or any of our own links (pay, request, @user, deal) in full or as a hash route; `routeFor` sends it on. Entry points: Pay → "Who are you paying?" → **Scan a code**; New contact → **Scan their code**; Contacts navbar scan icon. `Permissions-Policy: camera=(self)` (the app only; nothing framed). | `scan.test` (parse + route; junk and malformed addresses refused); csp test unchanged; smoke clean. | |
| 2 | Someone who writes the same kind of agreement often had to rebuild it from §1 every time. | **Presets** reuse the v0.14 draft format: Review → "Save as a preset on this device" stores a `TermsDraft` (private details stripped; their salt would otherwise repeat) under a name in `LocalData.presets`; §1 lists "Start from a saved preset" and `?preset=<id>` seeds the Builder through the same `draftInit` a counter-proposal uses. Presets travel with the contacts export/import. | `termsDraft.test` (a draft without its attachment stays valid; export → import round trip). | |

## v0.15 — Receipt acknowledgements for presented documents — 1 item

todo D9 (first candidate). `npm test` → **596 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | A presentation was one-sided: the exporter's signed memo said "I presented this file", but the record held nothing from the receiving side, so "did the documents reach them?" had no on-chain answer. | `latch-doc-ack@1` (`src/lib/documents.ts`): the receiving party signs one Memo per digest (`{deal, sha256, stage, v}`, no name — the digest ties it to the presentation) in the same transaction as its own `approve_milestone`, via `acknowledgeDocuments(d, me, digests)` (1–8, distinct, refused after approving). `recordsFromTx` / `fetchDocumentRecords` read presentations and acknowledgements in one pass with the same filter (signing party, this deal, canonical bytes). Deal page: "Acknowledge N documents & approve part k" appears for a party who can approve while another party's documents for that part are unacknowledged; a sheet lists them by name + digest with a tick each ("untick anything you didn't get"); the documents section shows "received, says <name>". Evidence page lists acknowledgements and its methodology names them. Spec §10.1. | `documents.test` (deployed binary): importer acknowledges both digests and approves in one tx, pair readable from the evidence side, release happens; refusals (after approving, 0/9, duplicates, bad digest); a stranger's ack ignored; strict encoding (keys, canonical bytes, lower-case hex, stage 0–15, never confused with a claim). | |

## v0.14 — Term proposals in chat: propose, counter, accept, create — 2 items (stage 2 of 2)

Founder: "terms of the agreement sent back and forth off chain before assent." `npm test` →
**593 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | Terms could be chatted about but not exchanged as something either side could accept, counter or turn into the deal. | `src/lib/termsDraft.ts`: **TermsDraft** = `latch-draft@1` — the JSON-ready form of `CustomTerms` (base58 addresses, decimal-string amounts) plus the link blob, `version` and `basedOn` (hash chain); `draftProblem` (strict shape + `blobProblem` + the program's `customProblems`), `draftHash` (JCS), `draftText` = `renderAgreement(customFields(...), blob)` — the EXACT text the deal will carry, since the deal address is a PDA of (creator, dealId) and both are in the draft. Private details ride inside the sealed message in full (`attachment`, bound to `blob.a`). `src/lib/negotiation.ts`: `proposeTerms` / `acceptTerms` carry a **wallet signature** over the draft hash (`termsProposalMessage`, `termsAcceptMessage` in claims.ts); `negotiationState(thread, me)` is pure and re-verifies every signature (a forged, tampered or wrong-creator card never counts; accepts bind to the latest version only); `announceDeal` sends a system message with the deal address + link blob; `exportNegotiation` → `latch-negotiation@1` JSON with every message's service record and signatures. **Builder**: "Propose in chat first" beside "Sign & create" (two-party drafts, messages on); `?draft=<thread>:<hash>` opens a received proposal pre-filled for a counter (`draftInit`: ~30 initial values incl. the private details, re-salted on save; creator becomes the counter-proposer with a fresh dealId). **Thread**: proposal cards (kicker, subject, amount/parts/rule/window, status line, Full text sheet; Accept / Counter / Decline for the other party's latest signed proposal; "Create the deal" for the accepted version's creator, which creates + signs with `draftText`'s hash, stores `links`/`attachments`, and announces); the counterparty's "Open the deal" stores the link and private details, then lands on the existing verified accept path. Composer gained a "Propose terms" button; menu gained "Propose terms" and "Export conversation". | `termsDraft.test` (round trip, hash stable under key order, attachment binding, malformed/invalid drafts, **create from draft on the deployed binary → `agreementStatus` verified with the draft's blob**); `negotiation.test` (propose → counter (basedOn) → accept → agreed → announce → export, each side on a fresh device; forged wallet sig = unsigned, wrong creator and tampered ref ignored, decline recorded, stale accept of an older version ignored). `dispute-policy.test` literal updated. | |

## v0.13 — Messages: encrypted chat between wallets — 1 item (stage 1 of 2)

Founder: "Users should be able to send basic messages back and forth, but users negotiating a
contract (smart and regular) and terms of the agreement sent back and forth off chain before
assent." Decisions: end-to-end encrypted (the service stores ciphertext it can't read), both plain
text and signed term proposals in one thread (proposals are stage 2, v0.14), keys in memory
only (one wallet signature per visit). `npm test` → **583 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | No way to talk to a counterparty inside the app; terms reached the other side only after the Draft was on chain. | **Keys** (`src/lib/msgCrypto.ts`): one deterministic wallet signature over the domain-bound `messagingKeyMessage` → HKDF → an X25519 key (peers encrypt to it) and an Ed25519 device signer (signs sends, no wallet prompt per message); published in a wallet-signed `MessagingKeyClaim` (`PUT /keys`, `mk:<wallet>`, 400 d) that peers re-verify and **pin on first use** (`peerKeys`; a change blocks sending until "Trust the new key"). **Thread key** = HKDF(X25519 shared secret, domain, cluster, both wallets) — the same from both sides; **message** = `0x01 ‖ nonce24 ‖ XChaCha20-Poly1305(pad(body), aad = thread|from|seq)`, padded to 256 B / 1 / 4 / 16 KiB. **Worker**: `POST /msg` (signer-signed, lane `li:<wallet>:m`, recipient must have keys, 500/day), `GET /msg/:wallet?since=` (signer-signed; per-day inbox index `mi:`, 200 per page, full sync for gaps > 7 days), `DELETE /msg/:wallet[/:thread]` and `DELETE /keys` (wallet-signed); records `m:<thread>:<time>:<id>` keep the sender's signature so the recipient re-verifies and can export proof later; 90-day TTL; `DELETE /me` erases keys, messages, pointers and the day counter. **App**: `src/lib/messaging.ts` (session, enable/unlock, TOFU pins, send, poll with 120 s overlap + dedupe by id, unread), 4th tab **Messages** with unread badge, `#/chat/:addr` thread (bubbles, composer, key states: none → share pay code, changed → trust, ok), **Message** on contact cards, Settings → Profile → Messages (on/off), polling every 15 s while visible. No forward secrecy (static keys) — said in the code, the setup copy, DATA-AND-RETENTION and the retention table. | `msgCrypto.test` (derivation binding, symmetric thread key, seal/open per bucket, AAD, body shape); `messaging.test` (keys 401/409/400, send 404/403/401/400/409/429, day buckets, paging, delete scope, erase); `messaging-client.test` (the app client against the real Worker code: 3 prompts first time then 1, a → b decrypts, reply, fresh-device resync, changed key blocks, delete); retention table regenerated (`mk/m/mi/mc`, erase count 12); copy/a11y/csp unchanged. | |

| 2 | Nothing from v0.13/v0.14 had met a signing wallet; the first run of a real two-wallet flow found three things. | `scripts/e2e-messages.mjs`: two throwaway keypairs funded by the public tap drive the production bundle in two browser contexts against the LIVE Worker and devnet — turn on → message → reply → propose → counter (Builder prefilled) → accept → create the deal (a real `create_deal` signed by the mock) → the other side opens it and sees "matches on-chain" with Accept & pay offered; service data erased at the end. The mock wallet signs in Node (bytes relayed; no secret in the page); service calls are relayed because the Worker's CORS allowlist is the real origin. Found and fixed: (a) KV serves a *miss* from the edge cache for ~60 s, so a chat opened before the peer turned messages on stayed "not on" for a minute → the Thread re-checks every 20 s while in that state, the copy says so, and the client remembers a miss for only 15 s; (b) a reload within seconds of signer-lane requests tripped the replay guard (409) → `nextIssued` is remembered in localStorage per lane, requests in a lane are serialized client-side, and a 409 skips ahead once; (c) a counterparty you only know from chat read as "New to you · never paid" and its Draft landed in Requests → `AddressEvidence.messaged` ("You've messaged with them · no completed payments yet"), `isUnsolicited` and the deal-page banner count a conversation as known. Cross-party delivery can lag up to a minute (KV list consistency); the E2E allows 75 s — the realtime upgrade is the fix. | The E2E itself (E2E deals 6icqdq2C…, AdWFGMLC… logged in LAUNCH-POSTS §5); `copy.test` policy block still green. | |

Rule for stage 2: proposal/accept/decline bodies already have a place in `MsgBody`; the Thread
screen renders them as labelled cards until v0.14 fills them in.

## v0.12 — The identity service is live: real @usernames, backups, TEST faucet — 1 item

Founder set the legal-process contact (latchlabs@protonmail.com) so the Worker could ship.
`npm test` → **559 dial client tests** (+2 live checks, env-gated).

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | @usernames, Telegram and backups were "Preview" because `worker/` had never been deployed (no legal-process contact, no KV, no token scope). | Contact set in `DATA-AND-RETENTION.md` and the Data & legal requests page (`LEGAL_CONTACT` in config.ts). Worker deployed as `latch-dial-service` on the account's new `latchlabs.workers.dev` subdomain: KV `4939edb2…`, `Guards` Durable Object (migration v1), `ALLOWED_ORIGINS=https://dial.latchlabs.org`, `TEST_MINT`=LDD, secrets `FAUCET_SECRET` (LDD mint authority) and `RPC_URL` (a provider URL: the public devnet RPC answers Cloudflare Workers with 403 "Your IP or provider is blocked"). `sendFaucet` now confirms by polling `getSignatureStatuses` over HTTP — `confirmTransaction` subscribes over a WebSocket that never delivers inside a Worker, so the grant landed but the request reported 502. App built with `VITE_SERVICE_URL` + `VITE_IDENTITY_LIVE=1` (CI and `.env.production`); the CSP admits the service origin. Telegram stays off (no bot yet). | `live-service.test` (LIVE_SERVICE=url): a throwaway key claims a random @handle through the app's client, resolves it, releases it. Faucet: grant 2LhsT47H…fp3q (100 LDD) and the first, WebSocket-timed-out grant 3DuNJoJM…Vh3J, both Finalized. | |

Operational note: `RPC_URL` is a secret, not a var, so the provider key stays out of the repo;
`wrangler secret put` fails while a var of the same name exists — remove the var and deploy first.

## v0.11 — Demo mode: enough on devnet for one person to try everything — 1 item

Founder: "fill it with enough demo ability for a user to test things." `npm test` → **559 dial
client tests** (+1 live devnet check, env-gated).

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | A new visitor had no money, no one to pay, and no counterparty, so nothing could be tried past the first screen. | `src/lib/demo.ts`: the three DELIBERATELY PUBLIC devnet keys latchlabs.org already ships (SOL tap, LDD mint authority, the Walnut & Oak demo merchant as **demo seller**). Add money → "Demo money (instant)": `Get 0.05 SOL for fees`, `Get $1,000 test dollars` (LDD is now the TEST asset, `VITE_TEST_MINT`). Contacts → "Add demo contacts" (Demo seller, Orbit Supply; names alongside addresses, `verifiedHow: "demo wallet (public key)"`). Deal page → "Demo seller's side": the seller's own actions from `viewDeal` on ITS side (accept, pay in with freshly minted LDD, mark shipped, approve, refund, pause/resume, decline, cancel together, accept a split), signed by the public key with the tap paying fees. | `demo.test` (deployed binary): accept → ship → user approves → Completed; refund from Active; nothing offered on deals it isn't part of. `devnet-demo.test` (DEVNET_DEMO=1): the same on live devnet with a fresh wallet — deal D6m6zjUz8LbgKQhyZ8KpfNews94kavpckj2JTvwEpTEp, Completed in 10 s. | |

Judgment call: this is the one place the app holds keys, and they are play money whose
publicity is the feature (same posture, same bytes, as the open-source latch/app). There is no
mainnet code path (config.ts), the section says so on screen, and the seller's actions are
ordinary party actions — nothing the program wouldn't let a real counterparty do.

## v0.10 — UX/UI pass: Venmo-simple for novices, contract-faithful for experts — 7 items

Founder, after v0.9 on a real device: "fine for now; major UX/UI work needs to be done." The
intent: Telegram/Venmo for novices who track friends' wallets as contacts; Protected payments
with categories that streamline the options; Custom only for people who want a real contract
the protocol faithfully represents. Every feature kept. Audit = 12 screens at 390 px before,
screenshots in `screenshots/v0.10/before/`. `npm test` → **554 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | Two dark-mode CSS blocks drifting apart; emoji glyphs rendering differently per platform; no shared primitives for sticky actions, progress, folding sections or status pills. | Tokens (`--testbar-h`, `--radius-card`, spacing), one dark block with "System" resolved via `matchMedia` in App.tsx, slimmer test bar, `ModeIcon` + an SVG icon set (`MODE_GLYPH` keeps its name), `ActionBar`, `StatusPill`, `ProgressStrip`, `Accordion`. | existing a11y/csp tests; smoke light+dark | e7d2903 |
| 2 | Home had no primary action (a pencil icon), rows led with truncated base58 and held paragraphs, "1 units". | Action row **Pay · Request · Receive** under a compact balance; `DealView.short` (one line per state) + `DealView.pill`; "tokens" for unknown mints; icon refresh; compose sheet with icons. | `custom.test` v0.10 #2 (every state's line and pill on the deployed binary); `partial-lapse.test` wording | 35f5ded |
| 3 | "To" was a raw address box with a Contacts link. | Contact-first picker sheet: search, pasted address, Contacts, "People you've paid or dealt with" (`suggestRecipients`, pure). | `picker.test` (ordering, filtering, self/blocked/contacts excluded from recents, typed address) | 8870847 |
| 4 | Protected's outcome card was a paragraph pile; nothing said what the payment was *for*. | `CATEGORIES`: Buying in person / Something shipped / Paying for work (the three presets, so request links are unchanged) and Booking deposit / Vehicle (push into Custom pre-filled via `tpl`/`rule`/`days` query); two-line category chips in Pay and Request; Builder reads the prefill. | `categories.test` (presets round-trip `presetFromParams`; builder-backed name a template and rule) | 8de4160 |
| 5 | Deal page: details list before the actions; emoji pills. | Hero with `StatusPill` → warnings → actions → ladder → **Terms** accordion (folded for Protected, open for Custom) → documents → record; save-as-contact banner after Completed. | existing source-scan tests unchanged; connected smoke | 097334c |
| 6 | Custom builder: raw units in captions, truncated titles, no progress, review as one wall of text, emoji template icons. | `ProgressStrip`, "Agreement" nav + large step title, "So far" summaries of finished sections, money-formatted captions (`writes(…, fmtAmount)`), review **Summary / Full text** toggle (default Summary), SVG template icons. | `a11y.test` no-emoji scan over `src/`; `walk-builder` opens Full text before checking the signature clause | |
| 7 | Settings showed program hashes and the RPC mid-page; Receive showed two QR codes. | "Advanced" accordion (Verify Latch + RPC, status in the summary line); one QR, address behind "Show my wallet address". | `retention.test` footer pin kept | eb16760 |

Not done in this pass (logged): a QR **scan** sheet (needs `BarcodeDetector` + `camera=(self)`), and
@usernames for real, which is the identity Worker on devnet — founder-gated on the legal-process
contact (HOSTING.md). The picker already branches on `serviceOn`.

## v0.9 — Custom = the whole protocol, clause by clause — 5 items

Founder's finding from real-device testing: Custom felt like what Protected should be (two
parties, 2-of-2, a five-way "settle" abstraction). Now Custom exposes every parameter
`create_deal` accepts and shows, per control, the sentence it writes. Protected and Instant
are unchanged. `npm test` → **548 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | No model of the full term set; the Builder's `agreementSpec` fixed parties at 2, approvals at 2-of-2, recovery at the parties (+1), and derived the timer mode. | `src/lib/customTerms.ts`: `CustomTerms` (2–8 parties, payer/payee, M-of-N approvals, any mint, 1–16 parts, six rules, timer mode, window to 10 y, split bps, decider, dispute policy + window, consent, 1–3 recovery signers M-of-R + notice, detected/accepted risk flags, price-risk code), `customProblems` mirroring every create_deal check and tagging each with its agreement section, `toDealSpec`/`customSpec`, `clauseIndex` (sections of a rendered text), `writes` (captions from the template's own `ruleClause`/`disputeClause`/`riskList`). | `custom.test`: 25 violations each refused by the deployed binary with the same error name; client-only gates; 3-party 2-of-3 two-part release; LongSunset collect after the window; AutoSplit 33.33 %; named decider from a dispute; 3 recovery signers 2-of-3 with a non-party + 10-year window; clause index titles; captions are substrings of the text | 78ad222 |
| 2 | Custom mints were impossible: the app knew only the allowlist's flags. | `src/lib/mintGuard.ts`: port of `mint_guard.rs` (freeze authority; Token-2022 permanent delegate, dormant hook, transfer fee, confidential, interest-bearing, close authority; refuses active hook, default-frozen, non-transferable, unknown extensions). | `mintGuard.test`: Token-2022 mints built in LiteSVM per extension; program agrees (RiskFlagsNotAccepted / ActiveTransferHook) | 37faa60 |
| 3 | No template for agreements the five presets don't fit. | `general@2` (labels only); spec §3.3 row; vector 5 (c5). | `template.test` | a01106b |
| 4 | The Builder's steps were a form, not the contract. | Rewritten clause by clause: §1 subject & template (+ General), §2 parties & approvals (add/remove parties, Pays / Is paid chips, co-signers, M-of-N), §3 token (allowlist or any mint, vetted live) & §4 parts (1–16), §5 rule (all six by contract name) + clock + window (days/hours) + split + decider + dispute policy + consent, §6 recovery signers (the parties, or 1–3 wallets M-of-R) + notice, §7 detected risks with accept boxes + price-risk code, §8 private details, review with the text split into sections and "Edit" per section. Every step shows "Writes: …" and its own program problems; the nav's "Text · n/8" opens the agreement so far with the current section highlighted. `scripts/walk-builder.mjs` (`npm run walk`, in CI) drives every step with a mock wallet on the production bundle. | `dispute-policy.test` (source), `copy.test`, walk-builder; `custom.test` covers the terms the UI emits | c277a12 |
| 5 | On the deal page nothing said which clause a button carries out, and a payer could only pay the whole remainder. | `ACTION_SECTION` (view.ts): every action → §2/§4/§5/§6/§9; the page prints "§n title — first sentence" under each action group from the **verified** text; "Pay in part of it now" sheet (`fund({ amount })` deposits in steps, `confirm_ready` only once everything is in); ladder shows `k/M` approvals per part. | `custom.test` (#5 block): partial then remainder on the binary; every action mapped; source scan | fd49f34 |

Judgment calls: "Automatic split" is the rule's contract name (allowlisted in the signed text) but
"automatic … split" is a banned promise in app copy, so the Builder calls it "Timed split".
Captions quote the template's clause functions directly so the Builder can never describe a
rule the text won't carry. Allowlisted assets keep their known risks pre-accepted (as
Protected does); a custom mint starts with nothing accepted.

## v0.8 — live at dial.latchlabs.org, CI, cold-judge sweep — 4 items

Hosting and CI (see HOSTING.md): Cloudflare Pages, custom domain,
Helius HTTP RPC with confirmations on the public devnet WebSocket, `VITE_APP_DOMAIN`
fixed, deploy on every green push to `main`. `npm test` → **506 dial client tests**.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | A Cancelled deal showed no status pill and the ladder pointed at "Agreed" as the current step, so a refunded payment read as "still waiting to be agreed". | `terminalPill()`: "↩ Refunded" when something was paid in, "✕ Cancelled" otherwise; an ended deal has no current step. | `refund-by-payee.test` (deployed binary: Refunded after refund_by_payee, null before), `coverage.test` (Cancelled on a plain draft cancel) | |
| 2 | No cold-judge pass existed: a judge opening a share link disconnected, on a phone, in dark mode, had never been simulated. | `scripts/sweep.mjs`: 13 public routes × 390/1280 px × light/dark, disconnected; fails on page errors, console errors, CSP violations, blank screens, horizontal overflow and dead links (explorer links checked by shape — explorer.solana.com 429s scripted fetches). Clean on the production bundle. | the script itself (`npm run sweep`) | |
| 3 | TEMPLATE-V2-SPEC.md was "draft" and its vectors were format c3 under the v0.3–v0.6 hash while the app signs c5. | Status: v2, format c5. §8 now generates c5 vectors under the deployed build first, then the frozen c3 set as historical; the c3 digests stay hand-pinned in the test. Skeleton line says c5. | `template.test` regenerates and diffs both sets | |
| 4 | Confirmations subscribed over the Helius WebSocket, whose per-key concurrent-socket cap is shared with latchlabs.org. | `VITE_WS_URL` → `wsEndpoint` on the ConnectionProvider; CSP gains that origin only. | `csp.test` | 6ee5355 |
| 5 | No template for the product the founder pitched: a cross-border sale of goods paid in stages against documents. | `trade@2`: `incoterm` (Incoterms 2020 enum), `origin`/`destination` line(40), `documents` (new `lines` field kind: 1–8 non-empty canonical lines), `inspection_days`, `milestones` = the stages; §8 clause states that stages release on approvals, documents are presented as on-chain memos of their SHA-256, and a named decider acts as examiner. Builder preset "Cross-border trade" (three stages pre-filled, 30-day window, 5-day inspection). Spec §3.3 row + vector 4 (c5 only). | `template.test`: well-formed blob round-trips; eight rejects (bad incoterm, 0/9 documents, empty or multi-line document name, empty origin, 41-code-point destination, 31-day inspection); vector 4 regenerated and diffed | |

| 6 | Nothing tied a stage's approval to the documents a trade runs on; "documents against payment" was a sentence, not a mechanism. | `src/lib/documents.ts`: `latch-doc@1` claims (JCS JSON: deal, stage, name, SHA-256) in SPL Memo v2 instructions signed by the presenter, bundled with that party's `approve_milestone` for the stage (`presentDocuments`); files hashed on-device (`sha256File`), never uploaded. `documentsFromTx` re-derives claims from a transaction (signer must be a party; deal must match; bytes must be canonical). Deal page: "Present documents for part N" sheet (names suggested from the trade@2 link) + "Documents presented" list; Evidence: section + `documents` in the bundle + methodology. Spec §10. | `documents.test` (deployed binary + LiteSVM's Memo program): two claims + approval in one tx, importer's approval releases; refused after approving / 0 or 9 docs / duplicate names / bad digest; a stranger's memo, a memo for another deal and a failed tx are never documents; strict decode (13 malformed forms); `sha256File` = node:crypto | |
| 7 | The evidence page had a methodology sentence inside the JSON bundle and no declaration; the main app's certificate has both on the page. | Visible "How this record was produced" (four numbered steps: sources and commitment; transactions, events and document claims; agreement regeneration with the result; reproducible build with the observed hash) and a "Declaration of the person producing this packet" block to complete by hand; print styles keep each block on one page. | `copy.test` (new strings), smoke/sweep render the evidence route | |
| 8 | Activity refreshed with twelve filtered `getProgramAccounts` calls every 20 s per connected wallet (8 party slots + decider + 3 recovery slots): 250 ms and 12 × 10 credits per refresh on Helius. | `fetchChangedDeals`: after a complete first listing, a refresh reads only accounts changed since the last slot with Helius `getProgramAccountsV2` (`changedSinceSlot`, 150-slot margin, paginated until an empty page), same membership predicate (`isMember`), merged into the list; an RPC without the method (public devnet, -32601) falls back to the twelve-call path. Measured against Helius devnet with a 14-deal wallet: full listing 12 calls / 250 ms; incremental 1 call / 136 ms (0 changed in the last 150 slots); `changedSinceSlot: 0` returns the same 14 deals in 1 call. | `indexer.test`: request shape, pagination, membership (same deal set as the full path), junk accounts skipped, -32601 → null, other errors throw, full path = 12 calls | |

Judgment calls: (#5) the copy test bans "free", and "Free Carrier"/"Free on Board" are the
official Incoterm names — allowlisted for the Builder's Incoterm dropdown only. (#6) A
presentation is always bundled with an approval: a memo on its own would not reference the deal
account, so it would not appear in the deal's transaction history; a party who already
approved a stage is told so and presents with the next stage. No program change was needed;
a `present_document` instruction with the hash stored on the deal would be the post-judging
version (added to the main repo's upgrade list).

Judgment calls: Cloudflare's auto-injected Web Analytics beacon is blocked by the CSP
(console error on the live host until Web Analytics is switched off for the zone —
founder's dashboard); the sweep ignores that one URL and nothing else.

## v0.7.1 — creation-locked dispute policy (program 4e5fa0a6…) — 4 items

Re-pinned to `4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d`
(f3f2ca5; fixture re-fetched and hash-checked; SDK ^0.1.5). `npm test` → **486 dial
client tests passing** on the new binary (+1 env-gated screenshot fixture).

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | New binary. | Re-pin; history is now 4e5fa0a6… → 0c4af8ba… → 3785ede6…, so c4 texts (v0.7) and c3 texts (≤ v0.6) still verify. | `template.test`: c4 under 0c4af8ba… and c3 under 3785ede6… verify against the current history | 5b54eb7 |
| 2 | set_dispute_policy gained the instructions sysvar (3005 with the old account list). | The encoder is built from the SDK 0.1.5 IDL, which pins the sysvar address, so bumping the SDK alone fixed it. The account is now also passed explicitly. Largest Builder transaction: **889 of 1232 bytes** (was 856). | `dispute-policy.test`: account list = IDL order (creator, deal, sysvar, event authority, program), signer/writable flags; size assertion | e071931 |
| 3 | Creation lock. | `PolicyMustBeSetAtCreation` mapped (plain words: start a new agreement to choose one). | `creation-lock.test` on the new binary: bundled create → policy → sign succeeds; a later transaction fails with PolicyMustBeSetAtCreation even on an untouched Draft; **before create_deal in the same transaction it fails with Anchor's AccountNotInitialized (3012)**, not PolicyMustBeSetAtCreation (see below); after the creator's sign: DisputePolicyLocked; set twice in the creating transaction: PolicyMustBeSetAtCreation | 021402d |
| 4 | The limit is cumulative: once used up, any later pause ends or settles at once. | Said before signing: each Builder choice with a limit, the policy line (Builder footer and review, deal-page banner before accept, "If a pause lasts", pause sheet) and the agreement text, as **format c5**. No client workaround. | `dispute-policy.test`: c5 sentences hand-checked per policy; c4 bytes frozen and still verifying; on the binary, after the limit is used up a new pause is settleable at once (Split, RefundPayer) or endable by anyone at once (ResumeRule) | 7144466 |

### Notes (v0.7.1)

1. **c5, not an edit to c4.** The used-up sentence changes bytes for the same
   inputs, and the spec's rule is a new format id for that. Deals created under
   v0.7 may already be signed with c4 text, so c4 stays verifiable and frozen
   (its section 5 is pinned in tests).
2. **"Before create_deal" fails, but not with the new error.** The deal account
   doesn't exist yet, so Anchor's account validation rejects the instruction
   (AccountNotInitialized, 3012) before the program's own check runs. The
   ordering is still enforced; the test asserts the error that actually occurs.
   If you want PolicyMustBeSetAtCreation there, the account constraint would
   need to change in the program.
3. **The dial never sends set_dispute_policy outside createAndSign** (tested since
   v0.7), so the creation lock needed no UI change.

## v0.7 — program 0c4af8ba… (refund_by_payee, dispute policies) — 7 items

Re-pinned to `0c4af8ba38fe78cd46283dad80af9792a9cb19943d279a8438510da0860ddb9e`
(fixture re-fetched and hash-checked; SDK ^0.1.4). One commit per item, plus small
follow-ups named by item. `npm test` → **473 dial client tests passing** (+1
env-gated screenshot fixture). Screenshots, light and dark:
`screenshots/v0.7/` (34 screens, including every new one; `screenshots/v0.6/after/`
is the "before" for the screens that already existed).

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| 1 | New program: three Deal fields, new instructions/errors/events. | Re-pin; old hash kept in `PROGRAM_HASH_HISTORY` so texts signed under `3785ede6…` still verify; spec vectors render under the hash they were pinned with. Decoder + `OFFSETS` for `dispute_policy` (980), `dispute_window_secs` (981), `disputed_secs` (985). | `flows.test`: offsets on a real account with RefundPayer/2 d; every account written by the **previous** binary (v0.6 fixture) decodes as NeverExpire/0/0 | 72f173c |
| 2 | **Critical:** in the request flow the payer creates, so it can `set_dispute_policy(RefundPayer, 1 day)` before signing, pause after the seller ships, and have everything returned to itself a day later. | Request shape check requires NeverExpire/0/0. c2/c3 texts can't state a policy, so they **never verify** a deal that has one (signing blocked). Such a deal is never labelled Protected (shown as Custom). Policy shown before accept: banner (+ "read this before you accept"), "If a pause lasts" row, note in Activity. | `hostile-policy.test` (deployed binary): the theft plays out end to end; RefundPayer / Split / ResumeRule + 1 day each refused, blocked, visible; honest control still matches | 2148136 |
| 3 | `refund_by_payee`. | Payee action "Refund {payer}" in partly-paid Signed / Funded / Active / Deadlocked, behind a confirm sheet (amount, can't be undone, payer needn't agree), through the guarded send. Events are now decoded (emit_cpi inner instructions): payer sees "{payee} refunded you {amount}"; evidence lists events per transaction + a plain-words line. `OnlyPayeeMayRefund` mapped; the wSOL unwrap after Completed/Cancelled covers it. | `refund-by-payee.test`: each state; payer and stranger refused by the program; Cancelled vs Completed after a partial release; event read back through web3.js's own `getTransaction` parsing | 942e332 |
| 4 | Lapse refund for partly paid-in Signed deals. | View offers `refundUnactivated` from `signed_at + 3 d` (Funded still `funded_at + 3 d`); copy for payer / others, before and after. Button says "Pay in the remaining …". | `partial-lapse.test`: both bases on the deployed binary (paying in 2 days after signing doesn't restart the clock; a Funded deal isn't refundable 3 days after signing) | d6e551b, 4096a19 |
| 5 | Dispute policy in the Builder. | Clock-from-the-start rules only: Hold until you both agree (default) / Resume the clock / Split / Return to payer, 1–365 days. **create → set_dispute_policy → sign in one transaction**, no sequenced fallback. Largest Builder deal: **856 of 1232 bytes**. New format **c4** states the policy (and the payee's refund right); c3/c2 stay verifiable. Deal page + evidence: policy, window, time paused so far. Expiry: ResumeRule → "End the paused dispute" for anyone; Split / RefundPayer → settle via DisputeExpired; `ExpiredDisputeMustBeWithdrawn` and the set_dispute_policy errors mapped. Pause copy: NeverExpire keeps "no time limit"; a policy states its window and outcome. Pay/requests stay NeverExpire. | `dispute-policy.test` (14): size + landing; c4 §5 hand-checked per policy; counterparty verifies c4; a text without the policy never verifies; ResumeRule / Split / Split-under-AutoSplit / RefundPayer expiry on the deployed binary, counted across two pauses to the second; 1–365 bounds; preset = `[create, sign]`; `setDisputePolicyIx` only built inside `createAndSign` | 17c180e, e0d8407 |
| 6 | Recovery approvals reset at activation. | Probed: while Funded, signatures collect but `recovery_ready_at` is never set, and activation clears the proposal. The app no longer offers recovery signing before the start, says a pre-start proposal doesn't count, and the Backup signers row says so. | `recovery-reset.test` (deployed binary) | 396f611 |
| 7 | Work deals' step said "Shipped". | "Started". | `work.test` | 52e7b4e |

Tooling (test-only): the v0.7 fixture adds policy, refund, partial and recovery
deals, and records transactions as `getTransaction` JSON so the screenshots show
real events (9b997f5).

### Disagreements and judgment calls (v0.7)

1. **c4 for every new deal, not only those with a policy.** `refund_by_payee` changed
   the rules for all deals: c3 says that while paused the money moves only by a
   joint split, a resume or the recovery signers, and that's no longer complete.
   So every new text (Protected preset included) is c4 and states the payee's
   refund right. c3/c2 still verify existing deals.
2. **Item 2 goes further than the shape check.** A c2/c3 fingerprint can't vouch
   for any deal with a policy, wherever it came from (request, plain link, another
   client), and such a deal is shown as Custom, never Protected.
3. **Recovery before activation: I removed the actions, not only the copy.** The
   program accepts signatures it will never honour. Offering them would mislead.
   Worth considering in the program: reject `recovery_sign` before activation.
4. **ResumeRule after the window is used up** (probed): any later pause can be
   ended by anyone at once. The pause sheet says so. If that isn't intended,
   it's a program question.
5. **The pending upgrade** (set_dispute_policy only in the creating transaction):
   the dial already only bundles it, so the re-pin should be hash + fixture. The
   bundling test will confirm on the new binary.
6. **Time paused so far** while a pause is running uses the device clock
   (`now − deadlock_raised_at`); the program uses chain time. Buttons appear only
   when the view says the limit has passed, and the program has the final say.
7. **Evidence now fetches every transaction** (one `getTransaction` each) to list
   events: slower on public RPC, but events are what a reader needs.

## v0.6 — final polish (ruling + 9 items)

Strings and UX only, apart from the guard-message split (ruled) and one test-only
harness. One commit per item, plus small follow-ups named by item. `npm test` →
**435 dial client tests passing** (this repo only; separate from the main Latch repo's
suite). Before/after screenshots, light and dark: `screenshots/v0.6/before/` (v0.5 code)
and `screenshots/v0.6/after/`, same names.

| # | Finding | Fix | Test | Commit |
|---|---|---|---|---|
| ruling | One message for "couldn't check" and "program changed". | RPC/fetch failure → "Couldn't check the Latch program right now — try again in a moment" (still blocks); real hash mismatch keeps "The Latch program changed…". | `guard.test`: both paths, both block | 9f1f8cd |
| 1 | Copy test gaps. | BANNED_WORDS + safe (CSS `safe-area` excluded), admissible, judicially noticeable, buyer protection. Phrase checks `/until (it'?s\|it is) received/`, `/automatic(ally)? (split\|unlock\|release)/`, `/refund(ed)? to you/`. Scans src, worker/src, README, BUILD-NOTES, HOSTING, DATA-AND-RETENTION, index.html, manifest. Quoted ban-list/negation lines are an explicit allowlist; a stale allowlist entry fails. | `copy.test` (+ probe files that must be caught) | fad69e3 |
| 2 | "Held until it's received" (false: the clock starts at shipped); undated "held until you're happy"; "splits automatically". | "Held until you say it's OK — or {N} days after {name} marks it shipped, unless you pause the clock." (Pay, Welcome, README; requester side too). "Splits on {date} — anyone can carry it out." (DealPage, Builder, view). | `copy.test` item-2 block | f5504b0, a3eafda |
| 3 | Pause copy incomplete. | Pay review, pause sheet and paused banner each say: no time limit; while paused it moves only when you both sign the same split; only whoever paused can resume; resuming restarts the clock toward the recipient; plus the custody line. Banner written for whichever party paused. | `copy.test` item-3 block (every clause, both banner variants) | bb76490 |
| 4 | How it works overstated "gets it"; no warning about lost wallets. | "…becomes collectable by the recipient: anyone can send it to them." "Protected payments have no backup signers — if you lose your wallet while paused, it stays locked." | `copy.test` item-4 | f9f2e27 |
| 5 | Work preset: 14 days run from the start (3-day start rule), not delivery. | Chip "Work · 14 d from start"; button "Start the clock — work has begun"; payee banner shows the start-by date AND the collectable date if started now; payer banner, Window row, Pay outcome/ladder/review and request banner say "from the start". Builder/freelance milestone deals untouched. | `work.test` (deployed binary: Work deal vs Shipped deal vs Work link pasted on a 10-day deal) | 032ccac, 9fa1eaf, c52051d, e496f4e, fa39c89 |
| 6 | Request flow: payer creates + signs, requester accepts, payer must come back. | Own success screen: "{name}'s app will find this payment. When they accept, come back here to pay in." No "send them this link". "Pay in" deals pinned first under Needs you with a "Pay in" pill. | `request-flow.test` | 116375b |
| 7 | Usernames/Telegram shown as finished. | "Preview" tag on Profile and Telegram sections, Telegram badge, username row and recipient field, with a note, until a build sets `VITE_IDENTITY_LIVE=1` (HOSTING.md). | `preview.test` | f775b83 |
| 8 | A11y. | RequestMoney uses `<Dial>` (arrow keys + roving tabindex); Dial label id from `useId`; ⓘ is 44×44 with a name; countdown ring is `aria-hidden`, its caption carries the time. | `a11y.test` (SSR: two Dials → distinct ids) | d1bec3f |
| 9 | Lows. | "(not returned in this version)"; Instant cost "+≈0.002 SOL if a new token account"; "You paid in {time} ago." on the payer's Funded view; "No Latch fee for you." on the recipient accept screen; README count labelled "dial client tests". | `lows-v06.test` | 0908e4d |

Already done before this round: none of the nine; all needed changes.

Tooling (test-only, not shipped): `scripts/shots.mjs` + `test/shots-fixture.test.ts`
build real Deal accounts on the deployed binary in LiteSVM at real dates and serve them
through a mocked RPC, with a mock Phantom whose "send" returns a fake signature
(b01970d, b475ffe, 414aaca).

### Devnet program changed during this round — the guard caught it

Between the "before" screenshots and the "after" run (same day), the program at
`BT8tr7YX…` was upgraded on devnet: program data `HtqsjQtB…` now hashes to
`1a0a8d44fcf05cc4c5925654f1847a39aa8eb3d73891efff9a310824f641ed99` (deployed slot
507866912). The pinned hash is still `3785ede6…`. Against live devnet the app now shows
"Deployed now ✗ DIFFERENT" and **refuses to create, accept, pay in or mark shipped**,
with the "program changed" message. That's the intended behaviour. I did **not** re-pin:
that needs the new build verified and the account layout re-checked, and it's your call.
The screenshot harness now serves the verified binary (`test/fixtures/latch.so`, whose
trimmed hash is the pinned one) so the shots don't depend on live devnet. LiteSVM tests
were never affected.

### Disagreements and judgment calls (v0.6)

1. **Signed template text keeps "Rule: AUTOMATIC SPLIT." and "There is NO automatic
   unlock by time under this rule."** They match the new phrase check, but they're inside
   the signed agreement formats (c3, and c1 frozen). Changing them changes every terms
   hash and needs a new format id. They're allowlisted by exact line, not by file.
2. **Item 2 landed before item 1.** The new phrase checks would have failed on the old
   copy, so the copy fix went first and the test second; both are green at HEAD.
3. **Work wording is chosen from this device's link AND the on-chain window (14 days).**
   It changes words only, never what a button does. Without the link the deal reads as
   a normal Protected payment.
4. **Preview is a build flag, not detection.** The app can't reliably tell whether the
   retention/legal pages are live on a deployed service, so whoever deploys flips
   `VITE_IDENTITY_LIVE=1`.
5. **The Durable Object stays one global instance for devnet** (accepted). Shard by key
   (e.g. per-wallet for `li:`) before real traffic.
6. **v1 (latchlabs.org) deals stay view-only here** (accepted).

## v0.5 — review fixes (15 items)

One commit per item, each with tests that fail without the fix (several mutation-checked
as noted). `npm test` → **404 passing** (358 at v0.4). Build clean; the smoke test passes
on the production bundle with zero CSP violations and now always stops its server.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 HIGH | `signBlocked = !canSign(status) && !legacySubject`: appending `&s=x` to any link re-enabled Accept / Accept & pay / Pay in on a mismatched or unreadable agreement. | `signBlocked(status)` ignores the link subject; the legacy subject is display-only. | `c1.test`: mismatched, unreadable and missing + `&s=x` stay blocked (mutation-checked against the old expression); DealPage's three buttons use the gate |
| 2 HIGH | Guard cached one success for the page's life, ignoring the connection; c3 text claims verification; confirm_ready unguarded. | No cache: every guarded send and Settings' "Deployed now" re-read the program-data account. Guard covers create, accept, accept & pay, pay in, **mark shipped / confirm ready**. | `guard.test`: re-reads each time; an upgrade mid-session blocks the next signature; **source scan**: every `F.createAndSign/fund/signTerms/markShipped` call is in a guarded path |
| 3 | `/u/<handle>` always said "No one is @x yet" (bare name vs `@` syntax); Pay bypassed pinning. | Resolve `@`+segment; Pay / Save go through the **name** (`profileLinks.ts`). | `names.test`: PayCode link → UserPage resolve → Pay's `to` → resolve → pin "new", then "changed" after a wallet swap |
| 4 | CSP only as `<meta>`: no `frame-ancestors`. | Build emits `dist/_headers` (full CSP + `frame-ancestors 'none'`, XFO DENY, nosniff, …); meta kept as fallback; `HOSTING.md` for other hosts. `connect.solflare.com` kept, reason in code. | `csp.test`: header vs meta policy, `_headers` content, Solflare reason checked against the installed SDK |
| 5 | KV get-then-put under single-use logins, lastIssued and faucet cooldown. | One `Guards` Durable Object (`tgu:`, `li:`, `f:`), true check-and-set, expiry + alarm sweep; fails closed without the binding; wrangler + README deploy notes. | `guards.test`: 20 concurrent replays of one login → 1 link; 10 concurrent copies of a claim → 1 accepted (**both fail** with the double's serialization removed, i.e. KV-like behaviour) |
| 6 | `DELETE /me` listed every `hr:` key. | Per-owner index `ho:<wallet>:<name>`. | `retention.test`: only wallet-scoped prefixes listed; others' holds untouched |
| 7 | Widget page had `'unsafe-eval'` on the API origin. | Widget served only on a **separate origin** (`TELEGRAM_WIDGET_ORIGIN`), using **`data-auth-url`** + a nonce'd `/done` page; no `'unsafe-eval'`. Evidence: `telegram-widget.js?22` (sha256 `3c8c27bf…cd99`) evals `data-onauth` via `__parseFunction`; the `data-auth-url` branch only navigates. | `csp.test`: host separation, CSP, `data-auth-url`, the done script run against a fake window |
| 8 | OIDC: kid optional, no jwk.alg/nbf/azp checks, JWKS fetched every time. | kid required; only RS256/ES256/EdDSA; jwk.alg/use must match; nbf; azp; JWKS cached 5 min, one refetch on unknown kid. | `telegram.test`: alg:none, HS256 (keyed with the public key), missing/mismatched kid, jwk.alg/use, nbf, azp single/multi-aud, cache + rotation |
| 9 | Backup PUT/GET replayable for 10 minutes. | `bumpIssued` on a writer lane `li:<wallet>:w`; client issues strictly increasing values. | `backup.test`: old PUT replayed after a newer one → 409 and newer ciphertext stays; repeated list → 409 |
| 10 | KCV skipped when the service omitted it. | Required. | `backup.test` via the client: missing / wrong / matching |
| 11 | Writer key double-signed every session; copy said "first time"; "Latch can't read them". | Fixed the **behaviour**: remembered writer pk → one signature afterwards (mismatch refused). Copy: "Stored encrypted; the service only receives ciphertext." | `backup.test` counts signatures (2 then 1) |
| 12 | `http://localhost` accepted in production builds. | Only with Vite's `DEV`. | `lows.test` + a real production build with `VITE_SERVICE_URL=http://localhost:8787` (absent from `_headers`, bundle `DEV:false`) |
| 13 | Real-looking bot token / WIF strings in tests; tautological KAT assertion. | Obviously fake values; pinned digest; TODO for a captured real payload. | Repo scan for token/WIF shapes (samples built at runtime) |
| 14 | Smoke hard-coded the sandbox Chromium; hung when launch failed. | `$CHROMIUM` → sandbox path → Playwright's own; preview in its own process group, killed in `finally`, on signals and on a global timeout. | `smoke.test`: resolution, cleanup paths, end to end with a bogus browser (exits in ~2 s, port released) |
| 15 | Transit of deal addresses undisclosed. | `IN_TRANSIT` in the app page + generated into DATA-AND-RETENTION.md. | `retention.test` |

### Disagreements and judgment calls (v0.5)

1. **#4: `_headers` is generated into `dist/`, not committed as `public/_headers`.** The
   policy depends on build-time endpoints (RPC, service, widget). A static file would be
   wrong whenever those differ. The deploy result on Pages/Netlify is the same.
2. **#5: one global Durable Object instance.** It serializes all three checks across all
   users, which is ample for devnet (roughly hundreds of requests per second). Before real
   traffic, shard by key (e.g. per-wallet instances for `li:`). Rate-limit counters (`rl:`)
   stay in KV as approximate limits; they weren't in the list.
3. **#2: fail closed has a cost.** Every signature now needs two extra RPC reads, and a
   flaky RPC blocks signing with the "program changed" message. I'd add a distinct
   "couldn't check, try again" wording; I didn't change the decided text.
4. **#1: legacy v1 deals (from the original Latch app) can no longer be accepted or paid
   in this app.** They only display. That's the intended consequence; say if v1 support
   matters.
5. **#7: untested against a live bot.** The `data-auth-url` → `/done` path is verified
   only against Telegram's script source and with simulated pages.
6. **#9: a separate writer lane** (`li:<wallet>:w`) rather than sharing `li:<wallet>`, so a
   silent upload on one device can't make a wallet action on another device fail in the
   same second.
7. **#13: the old fake strings remain in git history.** I invented them (they were never
   credentials), so there's nothing to rotate, and rewriting pushed history would break
   clones.
8. **#14: off-sandbox runs need a browser**: `npx playwright install chromium` (playwright-core
   doesn't download one) or `CHROMIUM=/path/to/chrome`.

## v0.4 — corrections to v0.3 (Part A) and a service security/privacy pass (Part B)

One commit per item. `npm test` → **358 passing** in 20 files (233 after Part A, 167 at
v0.3). The production bundle passes the smoke test under the new CSP with zero violations
(the detector was checked to fire on forced ones). Fund-safety invariants are unchanged:
the service still holds no key that can move money, and no deal depends on it.

### Part A — corrections

| # | Finding | Fix | Test |
|---|---|---|---|
| A1 | The signed text stated the pinned hash as "the program's deployed code had SHA-256 …", nothing compared it with what was deployed, and Settings/FAQ/README claimed a mismatch was shown. | `programGuard`: before create, accept or pay-in, the observed program-data hash must equal the pinned one (cached per session once seen). If it differs, or can't be checked, signing is blocked: "The Latch program changed since this app was checked — update the app before signing." Settings shows expected **and** observed. Line now: "The app that prepared this text verified the deployed program's code as SHA-256 X" → **format c3**. c2 still verifies. | `guard.test` (mismatch never calls send; match proceeds + caches; failed check blocks and retries); `template.test` frozen c2 digests |
| A2 | v0.2 (c1) deals showed red "Don't sign", ✗ in Record and `matchesOnChain:false`; pay-in wasn't blocked by a failed check. | `templateC1.ts`: the v0.2 renderer + lax decoder copied from git (2aa7c2b), verify-only. One `agreementStatus` for DealPage, AgreementView and Evidence: c1 → "Older format (c1) — verified" + injection note; schema-failing link → "Made with an older or different app — verify your saved copy with sha256sum"; evidence `matchesOnChain` null when undetermined. Accept **and** pay-in need a verified agreement. Spec: c1 shipped in v0.2, deprecated. | `c1.test`: digests produced by the v0.2 code itself, pinned by hand; c1/c2/c3/mismatch/unreadable/none on real deals |
| A3 | "No one at Latch can … move it" and "only the deal's rules can move" ignored upgradeability. | One line everywhere: "No instruction lets any Latch key move the money; on devnet the program can be upgraded by its maintainer." | `copy.test` scans every file for absolute custody claims |
| A4 | Negative tests accepted any error (`/Name\|0x/`). | `expectProgramError(err, Name)`: Anchor's error name **and** IDL number. | All 23 converted; the helper's own failure modes are tested |
| A5 | Two tests couldn't fail. | Vector 1's c3 text hand-checked and pasted into the test; digests pinned there (node:crypto), never regenerated. Incomplete-list matching tested with a real Draft (match at failed=0, none at failed=1). | Mutation-checked: one changed word / ignoring `failed` turns them red |
| A6 | Rulings. | Late "mark as shipped" = secondary button + confirm sheet; parties may propose recovery when a third-party backup exists; request conflicts clear when the other Draft is cancelled/gone; version string. | `lapse.test`, `recovery.test`, `request.test` (cancel_draft on the deployed binary) |

### Part B — service security and privacy

| # | Finding | Fix | Test |
|---|---|---|---|
| B1 | Telegram widget payload = 24 h bearer token, not wallet-bound, reusable; "verified ✓" though clients can't verify. | Strict field types; 5-minute window; constant-time HMAC compare; each login single-use (`tgu:`); links expire after 60 days; badge "linked via Latch service". **OIDC** (code + PKCE, Worker redeems, JWKS-verified id_token, nonce = H(wallet ‖ issued), fails closed) **behind a flag**. | `telegram.test` (replay by owner/attacker, 290 s vs 310 s, 7 malformed payloads, expiry; OIDC ES256+EdDSA, foreign nonce, no nonce, wrong aud/iss, expired, stale, foreign key, tampered, code reuse; RFC 7636 PKCE vector) |
| B2 | findable defaulted ON; `/owners` revealed Telegram even when not findable; unlimited lookups. | Default OFF (server and checkbox); `/owners` hides non-findable/expired; 60 lookups/min/IP; "a linked name is public next to your wallet" in the UI. | `linkability.test` |
| B3 | One namespace for @handle and Telegram; instant reuse of released names; replayable old claims. | `@sam` = handle only, `tg:@sam` = Telegram only; 60-day holds; client pins name → wallet (and claim time) on first use, loud warning + explicit confirm on change, older claim blocks; per-owner `lastIssued`. | `names.test` (rename-revert replay, stale release, holds) |
| B4 | No deletion; no TTLs; "Latch has no server" while the service was on. | `DELETE /backup`, `DELETE /me` (wallet-signed); TTL on every KV write; conditional copy; Clear data offers service deletion; `DATA-AND-RETENTION.md` + in-app "Data & legal requests", both from `retention.ts`. | `retention.test` fails on an unlisted prefix, a write without TTL, or a listed-but-unused prefix; checks real TTLs; deletion |
| B5 | Unauthenticated reads; writer key derived from the encryption key; raw deal addresses as keys; no padding/AAD/domain/determinism check. | Separate writer signature; domain in both messages; double-sign at setup + key-check value; HKDF with info; AAD = owner + id; 1/4/16/64 KiB padding (service accepts only those sizes); id = HMAC(id key, deal); writer-signed list. | `backup.test` (HKDF vs node:crypto, random signer refused, KCV mismatch, slot-move and tamper fail, no deal address in KV, auth on list) |
| B6 | Unpeppered Telegram-id hash: reversible, never read. | Dropped. | `service.test` |
| B7 | Blind deletes, racy faucet, unbounded export, uncapped bodies, unlimited writes, backups for any "deal". | Owner-checked deletes; faucet write-before-send + read-back, cleared on failure; `/handles` pages of 200 + cache header; 96 KiB body cap; 30 writes/min/IP; backups only for Latch deals naming the owner (checked, not stored). | `abuse.test` (5 concurrent faucet calls → 1 send; real Deal account parsed) |
| B8 | Telegram widget script in the app origin; no CSP. | Widget served by the Worker (own CSP, nonce, frame-ancestors = app) in a sandboxed iframe, one message shape from one origin; production CSP `<meta>`: `script-src 'self'`, connect only to RPC/service/MWA, frames only service + Solflare. | `csp.test`; smoke fails on any violation |
| B9 | Lows. | CORS pinned (no `*`); HTTPS-only service URL; generic 500 bodies; devnet genesis asserted (Worker faucet + mint script); look-alike reserved names; HMAC known-answer vector; lying-server tests. | `lows.test` (with a positive control — see below) |

Found along the way: the first version of the lying-server tests passed **without
reaching the client** (the env stub never took effect). They now use a test-only base-URL
setter and include a control that must accept an honest answer.

### Disagreements and judgment calls

1. **B5 vs B7 (deal addresses).** B5 hides deal addresses at rest (HMAC ids); B7 asks the
   service to check the owner is a party, which needs the address. I did both: the address
   is sent with each upload, checked against devnet, and never stored. The service still
   sees it in transit (and so could Cloudflare request logging, if enabled).
2. **`GET /handles` stays a public export** (paginated, cacheable, rate-limited). Handles
   are wallet-signed public claims meant to be mirrorable. Removing the export is a
   one-line change if you prefer.
3. **OIDC is off by default.** I couldn't register a Telegram client from here or confirm
   Telegram echoes `nonce` in the id_token. The Worker refuses tokens without it, so turning
   the flag on early fails closed. The widget path (sandboxed, single-use, 5 minutes) stays
   the default until then.
4. **KV isn't atomic.** Rate limits and the faucet cooldown are best effort across
   Cloudflare locations. A Durable Object is the strict fix; I didn't add one because it
   changes the deploy setup.
5. **Program guard scope.** As decided: create, accept, pay-in. `confirm_ready` (mark as
   shipped) also activates a deal under whatever code is deployed. I'd guard it too.
6. **Late-ship wording**: "can take **back the money**", not "take the money back", because
   "money back" is on the copy ban list.
7. **`li:` survives `DELETE /me` for up to 20 minutes** so signatures made just before the
   deletion can't be replayed.
8. **Backup format v1 is not readable by v2** (service backups and exported files). The
   service was never deployed, and v0.2/v0.3 lived two days.
9. **Handles expire after 400 days** unless re-claimed (B4 asks for TTLs everywhere). There's
   no renewal reminder yet.
10. **Widget page CSP allows `'unsafe-eval'`**. I added it on the assumption that Telegram's
   script evaluates `data-onauth`; it's confined to the service's empty origin. It's
   unverified without a live bot, so try removing it during the first real test.
11. **The app CSP keeps `style-src 'unsafe-inline'`** (React/vaul inline styles).
   `frame-ancestors` can't be set from a `<meta>`, so the host must send it as a header.
12. **Version string is v0.4.** A6 said v0.3; this release is v0.4.

### Open questions for counsel

Tracked in the private development repository.

### Not verified here

A live Telegram bot or OIDC client, a deployed Worker (real KV TTLs, CORS, headers), real
wallets signing in a browser, and the widget page under Telegram's real script.

## v0.3 — correctness + re-pin (2026-10-05)

No new features. One commit per item; every behaviour change is tested against the
**deployed, upgraded binary** (hash `3785ede6…6a5d`) running in LiteSVM. `npm test` →
**167 passing** (was 105 at the start of v0.3, 74 at v0.2).

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Program upgraded in place; app pinned `fa6d6982…4f82`. A missing/stale fixture *skipped* every flow test (green CI on nothing). | Re-pinned hash in `fetch-program.mjs`, `config.ts`, these notes; SDK `^0.1.2`; fixture re-fetched. Fixture test now **fails**; no `skipIf`. Evidence packet records the program-data hash **observed** at read time next to the expected one. | `flows.test` "is present and matches the verified build hash"; `chain.test` "hashes the program-data bytecode exactly like solana-verify" (real devnet bytes) |
| 2 | A request link's `window_days` set the payer's on-chain window while the UI showed the preset (e.g. 0.01 days shown as "10 days"). | `presetFromParams`: only `{preset, window_days}`, integer, equal to a `PRESETS` entry, ids agree; else the link is rejected. `timeoutSecs` derived from the **displayed** preset in `buildProtectedPayment`, which Pay.tsx and the tests share. | `request.test` "rejects 14-minute window shown as 10 days" (+6 variants), "derives timeout_secs from the displayed preset, and the deployed program stores exactly that" |
| 3 | The request fingerprint vouched for any Draft that reused the blob — the text regenerates from the deal's *own* fields, so hostile terms still matched. | `hasRequestShape`: exactly 2 parties, payer = creator, 1 milestone, threshold 2, TimeoutRelease + FromActivation, `timeoutSecs = window_days × 86400`, recovery {payer, payee} 2-of-2, default tie-breaker, no split/price term, `acceptedRiskFlags` = the asset's known flags. Two well-shaped Drafts → **conflict**, none linked. | `request.test` "hostile 1-of-1 recovery … shape check refuses", "hostile 1-second TimeoutRefund", "hostile 1-of-2 approval threshold", "duplicates … conflict, none linked" |
| 4 | New `refund_unactivated` not integrated: a payer whose payee never starts had no way out. | Builder; view offers "Return the money to {payer}" to **any** viewer after `funded_at + 3 d` (your move for the payer); payee sees "Mark as shipped BEFORE you ship — by {date}" / "Don't ship…"; wSOL unwrap after Cancelled; `explainError` for ActivationWindowOpen, InvalidState, TrueDeadlockConsentRequired, InvalidDeadlockParams; FAQ "If they never start". | `lapse.test`: early rejected; stranger returns whole vault; payer ATA closed; both race orders; view before/after; error mappings |
| 5 | "Nobody decides" (TrueDeadlock) could never be created: Builder passed `consent = false` for the creator. | Required consent checkbox; `createAndSign(spec, true)` only when ticked; spec built by shared `agreementSpec`. | `truedeadlock.test`: without consent fails, with consent succeeds, counterparty must consent too, never resolves by time |
| 6 | Link params rendered raw: a newline could inject numbered clauses into the **signed** text. Version marker on line 2; NFC applied despite SPEC v1; `decimals = 0` broke; subject cut by UTF-16 unit. | Per-template schema (exact keys, enums, int ranges, booleans, single-line text by code point; `n` 32 hex, `a` 64 hex; ≤4096 chars; strict UTF-8; no controls/bidi/U+2028). User-typed text rendered as JSON string literals. Line 1: `… · template {t} · format c2`. No normalization. `TEMPLATE-V2-SPEC.md` with 3 vectors **generated by the test** (fails on drift). | `template.test`: 33 hostile blobs rejected at decode and never add a line at render; line-1 marker; NFC ≠ NFD digests; decimals 0; truncation that never splits a surrogate pair; spec vectors match code byte for byte |
| 7 | Signed text said "No Latch Labs key can move, freeze, refund or redirect it" — false while the program is upgradeable. | Section 3: no instruction lets a Latch Labs key move the money; the devnet program is upgradeable and new code could change the rules; states the program-data hash. Append-only `PROGRAM_HASH_HISTORY` so texts survive re-pins. Consumer copy, README, Settings, new FAQ "Can the rules change?". | `template.test` "states the program is upgradeable and the program-data hash…", "texts made under an earlier pinned hash still verify after a re-pin" |
| 8a | Evidence `partiesSignedAt` held slot **indexes**. | Removed; `partyStatus` from the account bitmasks + recovery state; extracted `evidenceDealRecord`. | `recovery.test` "evidence deal record" |
| 8b | `deal.ts` cited a nonexistent `test/offsets.test.ts`. | Points at the real offsets test in `flows.test.ts`. | (that test) |
| 8c | `fetchMyDeals` swallowed partial `getProgramAccounts` failures. A hidden deal can also hide a request **conflict**. | Retry with backoff; failures reported; "list may be incomplete" banner; known deals kept; request matching skipped on incomplete lists. | `recovery.test` "deal discovery reports failed lookups" (4 tests) |
| 8d | No `recovery_sign` / `recovery_execute`; backup signers had no screen. | Builders, Deal decodes the proposal fields, view (backup proposes; any recovery signer co-signs; parties get a public notice; anyone executes after the delay), DealPage buttons/sheet, error mappings. | `recovery.test`: propose → co-sign → delay → stranger executes (payout only to parties); amount change resets; non-signer and pre-funding rejected |
| cov | Untested paths. | — | `coverage.test`: AutoSplit 30/70; LongSunset FromDeadlock; TimeoutRelease FromDeadlock; resume clock math vs the program to the second; crankRelease; cancelDraft; SOL accept+pay **514 / 1232 bytes**; view action matrix (24 state × role rows on real accounts) |

### Where I disagree or went my own way

1. **Format c1 texts no longer verify in-app.** Deals made with v0.2 (devnet, a few days
   old) render under c1, which v0.3 withdraws instead of keeping a second renderer for a
   format with a known injection bug. Their saved `.txt` copies still check with
   `sha256sum` against the on-chain hash. If you want, I can add a read-only c1 verifier
   that labels results "old format".
2. **NFC: dropped, not pinned.** The link carries the exact bytes, so normalization buys
   nothing for regeneration, would add a dependency on the verifier's Unicode tables, and
   SPEC v1 forbids it. Vector 2 pins this with a decomposed `é`.
3. **New format id, not new template ids.** I kept `*@2` (the param schemas didn't change
   meaning) and versioned the rendering as `format c2` on line 1. Bumping to `@3` would
   be just as valid; tell me if you prefer that.
4. **The stated program hash is the app's pinned hash, not one read at signing time.**
   If the program is upgraded and the app isn't re-pinned, new texts state the old hash.
   Blocking signing when observed ≠ pinned would fix that, but it's a behaviour change
   I didn't make without asking. Settings → Verify Latch and the evidence packet already
   show the mismatch.
5. **"Mark as shipped" stays enabled after the lapse.** The program accepts a late
   `confirm_ready` (no deadline), and a payee who *already* shipped needs it to activate.
   The payee instead sees "Don't ship — anyone can now return the money…".
6. **A party who is also a recovery signer can co-sign a recovery but isn't offered
   "propose".** In the default 2-of-2 (payer + payee) set, a recovery is just a slower
   mutual split, and "propose a split" already exists for that. Pure backup signers
   get "propose".
7. **Incomplete deal lists skip request matching entirely** rather than matching what was
   found. It may delay "your request was answered" by a refresh; the alternative can
   label a Draft as answered when its conflicting twin was in the failed lookup.
8. Observation, not a change: the program uses `recovery_ready_at == 0` for "threshold not
   met", which collides with unix time 0. That only matters in LiteSVM (clock starts at 0);
   tests start at a real date.

## What changed in v0.2 (your decisions → what shipped)

| # | Your decision | What I built |
|---|---|---|
| 1 | Keep building on today's devnet program; integrate the fixed program after Oct 12 | No change in behaviour. All program calls are in `src/lib/flows.ts` and the account layout is in `src/lib/deal.ts` (offsets pinned by a test), so a new program version is a one-file swap plus re-running `scripts/fetch-program.mjs` and the tests. |
| 2 | Who pays: least friction, "each signer pays" | **Requests are now a link only — the payer creates the deal.** Whoever pays the money also locks the ≈0.01 SOL network deposit; every signer pays their own network fee; requesting costs nothing. The requester's app recognises the payer's deal **by its fingerprint**: the request link carries the agreement parameters incl. a secret nonce, the payer creates the deal with exactly those, and the requester's device regenerates the on-chain terms hash from its own stored copy. No spam folder, no link needed back, and a forged deal can't match without the nonce. Cost: one extra tap for the seller ("Accept") vs. the old seller-created flow. The program can't split rent between signers; that would be an audit-gated change. |
| 3 | Android "installed wallet" — your call | **Kept, labelled** "Installed Solana wallet (Android) — outside Latch's wallet list". Dropping it would leave Android browser users with only "Open in wallet". Revisit if security review prefers strict enforcement. |
| 4 | All three ways to keep the agreement | (a) **Save gate:** you must download your copy (agreement + private details) before paying in. (b) **Encrypted backup file:** Settings → Agreement copies; only your wallet can open it. (c) **Online encrypted backup** (optional service): one-time setup (two wallet signatures), then new agreements back up silently. Key = derived on-device from a deterministic wallet signature; the service stores ciphertext only. |
| 5 | Deposit and Vehicle templates now | **Deposit / reservation** (`deposit@2`): purpose, required "not a residential security deposit" tick, rule = returns to payer when the window ends (TimeoutRefund) / a dated split (AutoSplit, % slider) / unlocks to recipient / decider. **Private vehicle sale** (`vehicle-sale@2`): year, make & model, mileage band, title status, inspection days; text states it does not transfer title; VIN/plate go in private details. Both render every enforced field and verify on-chain in tests. |
| 6 | "Court-readable" | All copy now says **"Evidence packet (court-readable)"**. |
| 7 | Both tokens, default USDC | **USDC stays the default.** A self-serve **TEST** token (no issuer freeze) appears when the optional service + `VITE_TEST_MINT` are configured, with a 100/day faucet button in Add money. `scripts/create-test-mint.mjs` makes the mint; its authority key goes in a gitignored `.secrets/` file and then into a Worker secret — never in the repo. |
| 8 | Telegram = its UI + usernames/contacts; real API integration if meaningful | **@usernames** (Telegram-style, 4–20 chars): pay `@sam`, add contacts by `@sam`, shareable profile `#/u/sam`, pay code shows your name. Each claim is **signed by the wallet**, so the directory can't point a name at another wallet; clients re-verify every claim; `GET /handles` exports the whole directory. Reserved names include anything starting with "latch" (trademark caution). **Telegram integration (meaningful + feasible):** link your **verified Telegram username** via Telegram's official Login Widget → profile badge "Telegram @sam ✓", and (opt-in "findable") friends can pay or add you by your Telegram @username. Stored: username + hashed Telegram id only. No bot, no Mini App. |

## The optional service (`worker/`)

Cloudflare Worker + KV — handles directory, Telegram verification, encrypted backups,
TEST faucet. **The app runs fully without it** (those features hide themselves), and no deal
ever depends on it. It holds one key: the TEST mint authority (mints worthless test tokens,
nothing else). Deploy steps in `worker/README.md`. Before any public launch: retention
policy + legal-process page (R8 D22).

## Flags

1. **Program ID typo in the original build prompt** (`…3g…` vs the real
   `BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv`). The app uses the IDL value and refuses
   to start if they ever disagree.
2. **Deployed binary = verified build.** `scripts/fetch-program.mjs` checks the devnet
   bytes against `3785ede6…6a5d` before writing the test fixture.
3. **Copy discipline.** Every sentence carrying a legal or trust claim
   lives in `src/lib/copy.ts`, and a test bans "escrow", "free", "court-ready",
   "open standard", etc. across `src/`.
4. **Determinism fix found in this pass:** the agreement text used to include the app's
   token label, so renaming a label would have broken old agreements' fingerprints. It now
   renders only chain-derived facts (mint address + decimals). Remaining dependency:
   decimals come from the app's allowlist (fine for USDC/SOL/TEST; unknown tokens are
   hidden anyway).
5. **Telegram login flavour.** Telegram now documents an OpenID Connect login and marks
   the classic Login Widget docs "archived" (R3). The widget is what's integrated (simple,
   still served); migrating the service check to OIDC is a contained change in
   `worker/src/index.ts`. Needs a bot from @BotFather with `/setdomain` = your app domain.
6. **Backup key phishing risk:** the backup key comes from signing a fixed message. A
   malicious site that tricks you into signing the same text could decrypt your backups
   (agreement copies only — it can't move money). The message says "Only sign it inside
   the Latch app". Worth a security note.
7. **Recovery signers can't be "none" on-chain** (program needs 1–3). "None" = the two
   parties at 2-of-2, labelled "None — only the two of you", never called a backup.

## What's verified

- v0.3: `npm test` → **167 passing** (table above). At v0.2 it was **74 passing**:
  - **12 flow tests on the deployed binary (LiteSVM):** payer-initiated payment end to end;
    **payer-created request recognised by fingerprint** (requester pays nothing; a forged
    nonce doesn't match); request-first bundle; window end → anyone collects; pause →
    timeout blocked → raiser-only resume → mutual split; wSOL wrap/deposit/release/unwrap;
    cancel together; two-part decider ruling; **deposit refunds to payer at window end**;
    vehicle text completeness; **faucet mint to a brand-new wallet**; discovery offsets +
    1036-byte account size. All bundled transactions < 1232 bytes.
  - **9 service tests:** signed handle claims (bad sig, stale, reserved, taken, rename,
    release, export), Telegram (valid hash, forged data, expired login, wrong wallet,
    non-findable, no names/photos/ids stored), backups (writer registration, ciphertext only),
    faucet (rate limit, off when unconfigured).
  - Backup encryption round trip + wrong key refused; copy discipline over every file;
    default-policy rules; link-blob round trip.
- `npm run build` clean; Buffer polyfill first in `main.tsx`; `scripts/smoke.mjs` runs the
  **production bundle via `vite preview`** in headless Chromium (light + dark), including
  connected screens against a real devnet deal with a read-only mock wallet.

**Still not verified:** a real wallet signing from the browser, and the service deployed to
Cloudflare. Both need things this sandbox doesn't have (devnet SOL, a Cloudflare account,
a bot token). First manual test: two wallets, Request → Pay → Accept → Pay in → Ship → OK.

## Not built yet

Labelled devnet parcel-tracking demo; `latch verify-packet` offline verifier; `.sns`/ANS
read-only names; domain-verified business badge; Squads-vault parties; comprehension-test
build; native shell for iOS haptics; an indexer (Activity uses `getProgramAccounts` —
12 queries per refresh; set `VITE_RPC_URL` to a dedicated endpoint before real traffic).

## Run

```sh
npm install
npm run dev                         # or: npm run build && npm run preview
node scripts/fetch-program.mjs && npm test
```

Optional env: `VITE_RPC_URL`, `VITE_RPC_URL_2`, `VITE_SERVICE_URL`, `VITE_TEST_MINT`,
`VITE_TELEGRAM_BOT`.
