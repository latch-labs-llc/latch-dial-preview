# Latch Dial agreement format — template v2, format c5

Status: **v2, format c5** (2026-10-07; c5 vectors under the deployed build, c3 vectors kept as historical) · Documents: the `*@2` templates exactly as rendered by
[`src/lib/template.ts`](src/lib/template.ts) in this repository · Program:
`BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv` (Solana devnet) · Modeled on
Latch `SPEC.md` v0.1 (template v1), which it does not replace.

This document specifies how Latch Dial turns a deal's on-chain fields plus a
short **link blob** into agreement text whose SHA-256 digest is the deal's
`terms_hash`. Any client that implements it regenerates the text byte for
byte from the chain and the link, and checks it against the chain.

The key words MUST, MUST NOT, SHOULD and MAY are to be interpreted as
described in RFC 2119.

## 1. Design goals

1. **Self-verifying.** The text is a pure function of (a) the deal's on-chain
   fields and (b) the link blob. Same inputs → same bytes → same hash.
2. **Opaque to the program.** The program stores `terms_hash` as 32 opaque
   bytes and never parses the text. New templates need no program change.
3. **Nothing private on-chain.** Only the digest is on-chain. The blob carries
   a 128-bit secret reference `n`, so the digest is a hiding commitment: a
   stranger who knows every on-chain field still can't confirm a guessed
   subject.
4. **Link data cannot add terms.** Every link field is validated against a
   per-template schema, every free-text value is a single line, and every
   free-text value is rendered as a JSON string literal. Nothing in a link can
   add a line, a numbered clause or a section to the signed text (§4.3).
5. **The first line names the version** (§9).

## 2. On-chain binding

`Deal.terms_hash` (32 bytes) = `SHA-256(UTF-8(text))`. Each party's
`sign_terms` transaction is their signature over a deal account carrying that
digest. The program does not check that a text exists.

## 3. Inputs

### 3.1 On-chain fields (read from the deal account)

| Field | Rendered as |
|---|---|
| `deal` address, `deal_id` | base58 / decimal |
| `parties[]`, `payer_idx`, `payee_idx`, `approval_threshold` | one line per party, role `Payer` / `Payee` / `Party` |
| `mint`, `decimals` (from the mint account) | base58 / decimal |
| `milestones[].amount` | §6.1, unit `token units` |
| `rule`, `timer_mode`, `timeout_secs`, `split_bps`, `tie_breaker` | §5 clause text |
| `recovery_signers[]`, `recovery_threshold`, `recovery_delay_secs` | base58 lines, §6.2 duration |
| `risk_flags`, `accepted_risk_flags`, `price_risk_term` | fixed risk names, decimal |

### 3.1a Program hash stated in the text

Section 3 states the SHA-256 of the program's deployed code (program-data
bytes after the 45-byte header, trailing zero padding removed) that the
creating app VERIFIED: in format c3 the sentence is "The app that prepared this
text verified the deployed program's code as SHA-256 {hash} (…)". A conforming
app MUST compare the observed program-data hash with this value before it
creates, accepts, pays into or confirms ready on a deal (re-reading it each time), and MUST refuse on a mismatch or when it
cannot check (Latch Dial: `src/lib/programGuard.ts`). The value is not read
from the deal. A verifier MUST try each hash
in its append-only list of pinned hashes (Latch Dial: `PROGRAM_HASH_HISTORY`)
and report which one matched. The text says plainly that the devnet program
is upgradeable and that no instruction lets a Latch Labs key move the money.

The unit is the literal `token units`. A client MUST NOT substitute its own
label (`USDC`, `SOL`), because that would make the text depend on the app.

### 3.2 Link blob

A JSON object, transported as base64url (no padding) of its RFC 8785 (JCS)
serialization, at most **4096** base64url characters, decoded as strict
UTF-8 (invalid UTF-8 → reject).

| Key | Required | Rule |
|---|---|---|
| `t` | yes | one of the template ids in §3.3 |
| `p` | yes | object; EXACTLY the keys of that template's schema (§3.3) — none missing, none extra |
| `s` | yes | subject: a canonical line (§4.2), 1–90 code points. PUBLIC |
| `n` | yes | 32 lowercase hex chars (128-bit secret reference) |
| `a` | no | 64 lowercase hex chars: SHA-256 of a salted attachment held by the parties |

Any other top-level key → reject.

### 3.3 Template schemas

`line(N)` = a canonical line (§4.2), 1–N code points. `labels` = array of
1–16 canonical lines of 0–40 code points each; when rendering, its length
MUST equal the number of on-chain milestones.

| Template | Params |
|---|---|
| `protected-payment@2` | `preset` ∈ {`inperson`, `shipped`, `work`}; `window_days` integer, and MUST equal the preset's days (3, 10, 14) |
| `goods-sale@2` | `condition` ∈ {`new`, `like-new`, `used-good`, `used-fair`, `for-parts`}; `inspection_days` integer 0–30; `milestones` labels |
| `freelance@2` | `revisions` integer 0–10; `ip_transfer_on_final_payment` boolean; `milestones` labels |
| `deposit@2` | `purpose` ∈ {`booking`, `custom-order`, `event`, `rental-equipment`, `other`}; `not_residential_security_deposit` MUST be `true`; `milestones` labels |
| `vehicle-sale@2` | `year` integer 1900–2100; `make_model` line(40); `mileage_band` ∈ {`under-25k`, `25k-50k`, `50k-100k`, `100k-150k`, `over-150k`}; `title_status` ∈ {`clean`, `lien`, `salvage`, `rebuilt`}; `inspection_days` integer 0–30; `milestones` labels |
| `trade@2` (v0.8) | `incoterm` ∈ {`EXW`, `FCA`, `CPT`, `CIP`, `DAP`, `DPU`, `DDP`, `FAS`, `FOB`, `CFR`, `CIF`} (Incoterms 2020); `origin` line(40); `destination` line(40); `documents` = array of 1–8 non-empty canonical lines of ≤40 code points (the documents the Payee presents; each is later anchored on-chain as a memo of its SHA-256); `inspection_days` integer 0–30; `milestones` labels (the trade's stages) |
| `general@2` (v0.9) | `milestones` labels only. For agreements no other template fits; the obligations live in the subject, the attachment digest and the chain fields. |

"Integer" means a JSON number with no fractional part (`10` and `10.0` are the
same JSON value). Strings where a number is required, and numbers where a
string is required, → reject.

A verifier MUST reject a blob that fails any rule in §3 and MUST NOT render
or display a text for it.

## 4. Canonical text construction

### 4.1 Whole text

- Encoding UTF-8. **No Unicode normalization** (as SPEC.md v1): the bytes in
  the blob are the bytes in the text. A composed `é` (U+00E9) and a decomposed
  `é` (U+0065 U+0301) are different texts with different digests (vector 2).
- Line ending LF. Trailing spaces and tabs on each line are removed; leading
  and trailing blank space of the whole text is removed; then exactly one LF
  is appended.

Why no NFC: the link carries exact bytes, so the verifier never has to
reconcile two spellings; normalization would only add a dependency on the
verifier's Unicode tables. (Format c1, shipped in v0.2, applied NFC; see §9.)

### 4.2 Canonical lines (subject, labels, `make_model`)

A string is a canonical line iff applying these steps leaves it unchanged:

1. Replace every **forbidden** code point with U+0020: U+0000–U+001F,
   U+007F–U+009F, U+2028, U+2029, U+200E, U+200F, U+061C, U+202A–U+202E,
   U+2066–U+2069 (controls incl. CR/LF/TAB, line separators, bidi marks).
2. Replace every run of whitespace (ECMAScript `\s`) with one U+0020.
3. Trim; keep the first N **code points** (never split a surrogate pair);
   trim again.

It MUST also be well-formed UTF-16 (no lone surrogates). Encoders apply the
steps; decoders reject anything that isn't already canonical.

### 4.3 How link values appear in the text

- Subject: `1. SUBJECT. ` + JSON string literal of `s`.
- Labels: ` — ` + JSON string literal, after the amount (empty label → nothing).
- Params in section 8: keys sorted by UTF-16 code unit, `milestones` omitted,
  each as three spaces + key + `: ` + JSON serialization of the value
  (`"used-good"`, `2`, `true`).

Because a canonical line contains no control characters, its JSON literal is
the line wrapped in `"` with only `"` and `\` escaped. Keys come from the
schema, never from the link.

### 4.4 Skeleton

```
LATCH PROTECTED PAYMENT AGREEMENT · template {t} · format c5
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. {json(s)}

2. PARTIES (by wallet address).
   {i}. {Payer|Payee|Party}: {base58}            (one line per party, i from 1)

3. AMOUNT AND HOLDING. {total, mint, decimals, deal, deal id, program, cluster; custody and upgradeability statement; program hash}

4. RELEASES. The money is released in this order, each part when {k} of {n} parties approve it:
   {i}. {amount} token units[ — {json(label)}]

5. IF THERE IS A PROBLEM. {rule clause} The parties may always settle by every party signing the same division.

6. RECOVERY SIGNERS ({k} of {n}):
   {base58}
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of {duration}.

7. TOKEN RISKS. Detected on this token: {names}. Accepted by the parties: {names}. Price-risk term code: {code}.

8. TEMPLATE DETAILS.
   {key}: {json(value)}                          (or "   none")
   {template note, if any}
   Attachment: {SHA-256 a (held by the parties, never on-chain) | none}
   Reference: {n}

9. ELECTRONIC SIGNATURE. {fixed text}
```

The exact prose of sections 3, 5 (one clause per rule), 8 (template notes)
and 9 is normative as written in `renderAgreement` in
[`src/lib/template.ts`](src/lib/template.ts); the vectors in §8 pin it.

## 5. Hashing

`terms_hash = SHA-256(UTF-8(text))`, compared as 32 raw bytes.

## 6. Formatting rules

### 6.1 Amounts

Integer `raw` and `decimals` d. If d = 0 the amount is `raw` in decimal.
Otherwise left-pad `raw` with zeros to d+1 digits, insert `.` before the last
d digits, remove trailing zeros of the fraction, and remove the `.` if the
fraction is empty: `25000000`/6 → `25`, `1`/9 → `0.000000001`, `7`/0 → `7`.
(This differs from SPEC.md v1, which prints all d digits and treats d = 0 as
malformed.)

### 6.2 Durations

`s` seconds: if divisible by 86400 → `{s/86400} day(s) ({s} seconds)`; else if
divisible by 3600 → `{s/3600} hour(s) ({s} seconds)`; else `{s} seconds`.

## 7. Verification procedure

1. Decode the blob strictly (§3). Reject on any failure.
2. Read the deal account and the mint's `decimals`.
3. If the template has `milestones`, check its length equals the deal's
   milestone count.
4. Render (§4), hash (§5), compare with `Deal.terms_hash`.
5. Only on a match show the text as "the signed agreement".

## 8. Test vectors

Keys are the base58 encodings of 32 repeated bytes, as in SPEC.md v1:
`0x01`×32 payer `4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi`, `0x02`×32 payee
`8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR`, `0x03`×32 mint,
`0x04`×32 deal, `0x05`×32 third recovery signer. Everything between the
markers below is generated from the code by `test/template.test.ts`, which
fails if this file and the code disagree: first format c5 under the deployed
build (what the app signs today), then the frozen c3 set.

<!-- vectors:begin (generated by test/template.test.ts) -->

### Format c5 under the deployed build `4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d` (current)

What the app renders today: section 5 states the dispute policy and the payee's refund right, and the limit never resets.

#### Vector 1 — protected-payment@2, Shipped preset (USDC-like, freeze flag)

The shape the app's Protected payment and payer-created requests produce.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            1759600000
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 6
milestoneAmounts  [25000000]
rule / timer      TimeoutRelease / FromActivation, timeout 864000
recovery          2-of-2, delay 259200
risk / accepted   1 / 1, priceRiskTerm 0
link blob (JCS)   {"n":"000102030405060708090a0b0c0d0e0f","p":{"preset":"shipped","window_days":10},"s":"Vintage lamp, as pictured","t":"protected-payment@2"}
link (base64url)  eyJuIjoiMDAwMTAyMDMwNDA1MDYwNzA4MDkwYTBiMGMwZDBlMGYiLCJwIjp7InByZXNldCI6InNoaXBwZWQiLCJ3aW5kb3dfZGF5cyI6MTB9LCJzIjoiVmludGFnZSBsYW1wLCBhcyBwaWN0dXJlZCIsInQiOiJwcm90ZWN0ZWQtcGF5bWVudEAyIn0
```

Expected: **2877 bytes**, SHA-256
`bc7d9f6504423caadd65f5f6e69a99f051095f1387c8d632d9ec9650f06a0b5d`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template protected-payment@2 · format c5
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "Vintage lamp, as pictured"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 25 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 6 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 1759600000) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 25 token units

5. IF THERE IS A PROBLEM. Rule: TIMEOUT RELEASE. If no release has happened 10 day(s) (864000 seconds) after the clock starts, anyone may send the remaining money to the Payee. The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, the Payee returns it to the Payer, or the recovery signers act. The parties may always settle by every party signing the same division. While money is held, the Payee may at any time, alone, return all of it to the Payer; this cannot be undone. Dispute time limit: none. A pause holds the money for as long as it lasts.

6. RECOVERY SIGNERS (2 of 2):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 3 day(s) (259200 seconds).

7. TOKEN RISKS. Detected on this token: the token issuer can freeze the vault. Accepted by the parties: the token issuer can freeze the vault. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   preset: "shipped"
   window_days: 10
   Attachment: none
   Reference: 000102030405060708090a0b0c0d0e0f

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

#### Vector 2 — freelance@2, three parts, non-ASCII, NO normalization, attachment

The subject's `é` is DECOMPOSED (`e` + U+0301) and the second label uses a precomposed `ü`, `—` and an emoji: implementations MUST hash them as given.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            42
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 6
milestoneAmounts  [1000000, 2500000, 500000]
rule / timer      TrueDeadlock / FromDeadlock, timeout 0
recovery          2-of-3, delay 604800
risk / accepted   1 / 1, priceRiskTerm 0
link blob (JCS)   {"a":"5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f","n":"ffeeddccbbaa99887766554433221100","p":{"ip_transfer_on_final_payment":true,"milestones":["Sketches","Entwürfe — \"v2\" 🎨",""],"revisions":2},"s":"Café logo commission","t":"freelance@2"}
link (base64url)  eyJhIjoiNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZiIsIm4iOiJmZmVlZGRjY2JiYWE5OTg4Nzc2NjU1NDQzMzIyMTEwMCIsInAiOnsiaXBfdHJhbnNmZXJfb25fZmluYWxfcGF5bWVudCI6dHJ1ZSwibWlsZXN0b25lcyI6WyJTa2V0Y2hlcyIsIkVudHfDvHJmZSDigJQgXCJ2MlwiIPCfjqgiLCIiXSwicmV2aXNpb25zIjoyfSwicyI6IkNhZmXMgSBsb2dvIGNvbW1pc3Npb24iLCJ0IjoiZnJlZWxhbmNlQDIifQ
```

Expected: **2955 bytes**, SHA-256
`468e213877de1ee99b92a1219c6d4ad619aa5bfaf026b793751bc3a680b8a07b`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template freelance@2 · format c5
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "Café logo commission"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 4 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 6 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 42) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 1 token units — "Sketches"
   2. 2.5 token units — "Entwürfe — \"v2\" 🎨"
   3. 0.5 token units

5. IF THERE IS A PROBLEM. Rule: NO DECIDER, NO TIMER. If a problem is reported, the remaining money stays locked until every party signs the same split or the recovery signers act. It never unlocks by time. Each party must give separate, explicit consent to this rule when signing. The parties may always settle by every party signing the same division. While money is held, the Payee may at any time, alone, return all of it to the Payer; this cannot be undone.

6. RECOVERY SIGNERS (2 of 3):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 7 day(s) (604800 seconds).

7. TOKEN RISKS. Detected on this token: the token issuer can freeze the vault. Accepted by the parties: the token issuer can freeze the vault. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   ip_transfer_on_final_payment: true
   revisions: 2
   Each part is released when both parties approve the work for that part. Revisions and rights follow the details above.
   Attachment: SHA-256 5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f (held by the parties, never on-chain)
   Reference: ffeeddccbbaa99887766554433221100

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

#### Vector 3 — vehicle-sale@2, zero-decimal mint, TimeoutRefund

Pins decimals = 0 formatting (`7`, not `0.7` or `7.`) and a seconds-only duration.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            7
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 0
milestoneAmounts  [7]
rule / timer      TimeoutRefund / FromActivation, timeout 5400
recovery          2-of-2, delay 259200
risk / accepted   0 / 0, priceRiskTerm 0
link blob (JCS)   {"n":"0f0e0d0c0b0a09080706050403020100","p":{"inspection_days":2,"make_model":"Honda Civic","mileage_band":"50k-100k","milestones":[""],"title_status":"clean","year":2015},"s":"2015 Honda Civic, silver","t":"vehicle-sale@2"}
link (base64url)  eyJuIjoiMGYwZTBkMGMwYjBhMDkwODA3MDYwNTA0MDMwMjAxMDAiLCJwIjp7Imluc3BlY3Rpb25fZGF5cyI6MiwibWFrZV9tb2RlbCI6IkhvbmRhIENpdmljIiwibWlsZWFnZV9iYW5kIjoiNTBrLTEwMGsiLCJtaWxlc3RvbmVzIjpbIiJdLCJ0aXRsZV9zdGF0dXMiOiJjbGVhbiIsInllYXIiOjIwMTV9LCJzIjoiMjAxNSBIb25kYSBDaXZpYywgc2lsdmVyIiwidCI6InZlaGljbGUtc2FsZUAyIn0
```

Expected: **3026 bytes**, SHA-256
`720627f40d336969c9aa9b31c007cd61652b20adf92ea236bbc1bef673e4644c`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template vehicle-sale@2 · format c5
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "2015 Honda Civic, silver"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 7 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 0 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 7) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 7 token units

5. IF THERE IS A PROBLEM. Rule: TIMEOUT REFUND. If no release has happened 5400 seconds after the clock starts, anyone may return the remaining money to the Payer. The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, the Payee returns it to the Payer, or the recovery signers act. The parties may always settle by every party signing the same division. While money is held, the Payee may at any time, alone, return all of it to the Payer; this cannot be undone. Dispute time limit: none. A pause holds the money for as long as it lasts.

6. RECOVERY SIGNERS (2 of 2):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 3 day(s) (259200 seconds).

7. TOKEN RISKS. Detected on this token: none. Accepted by the parties: none. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   inspection_days: 2
   make_model: "Honda Civic"
   mileage_band: "50k-100k"
   title_status: "clean"
   year: 2015
   This agreement covers payment only. It does not transfer the vehicle's title; title and registration transfer happen separately under the law of the place of sale.
   Attachment: none
   Reference: 0f0e0d0c0b0a09080706050403020100

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

#### Vector 4 — trade@2, three stages, named decider as examiner

Documents are listed in the link; each one is later presented on-chain as a memo of its SHA-256 (v0.8 #6). Pins the `documents` lines field and the Incoterm enum.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            4471
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 6
milestoneAmounts  [3000000000, 5000000000, 2000000000]
rule / timer      TieBreaker / FromActivation, timeout 2592000
recovery          2-of-2, delay 259200
risk / accepted   1 / 1, priceRiskTerm 0
link blob (JCS)   {"n":"4471447144714471447144714471aaaa","p":{"destination":"Detroit, MI","documents":["Commercial invoice","Packing list","Bill of lading"],"incoterm":"FOB","inspection_days":5,"milestones":["Deposit at order","Documents presented","Goods received and inspected"],"origin":"Port of Haiphong"},"s":"1,200 oak desks, PO 4471","t":"trade@2"}
link (base64url)  eyJuIjoiNDQ3MTQ0NzE0NDcxNDQ3MTQ0NzE0NDcxNDQ3MWFhYWEiLCJwIjp7ImRlc3RpbmF0aW9uIjoiRGV0cm9pdCwgTUkiLCJkb2N1bWVudHMiOlsiQ29tbWVyY2lhbCBpbnZvaWNlIiwiUGFja2luZyBsaXN0IiwiQmlsbCBvZiBsYWRpbmciXSwiaW5jb3Rlcm0iOiJGT0IiLCJpbnNwZWN0aW9uX2RheXMiOjUsIm1pbGVzdG9uZXMiOlsiRGVwb3NpdCBhdCBvcmRlciIsIkRvY3VtZW50cyBwcmVzZW50ZWQiLCJHb29kcyByZWNlaXZlZCBhbmQgaW5zcGVjdGVkIl0sIm9yaWdpbiI6IlBvcnQgb2YgSGFpcGhvbmcifSwicyI6IjEsMjAwIG9hayBkZXNrcywgUE8gNDQ3MSIsInQiOiJ0cmFkZUAyIn0
```

Expected: **3883 bytes**, SHA-256
`637ead22cc37e6d92db0920a9831c14b9b5c57899d996f39c2126c70f79f97ae`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template trade@2 · format c5
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "1,200 oak desks, PO 4471"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 10000 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 6 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 4471) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 3000 token units — "Deposit at order"
   2. 5000 token units — "Documents presented"
   3. 2000 token units — "Goods received and inspected"

5. IF THERE IS A PROBLEM. Rule: NAMED DECIDER. LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY (not a party) is named by all parties. Once any party reports a problem, this decider ALONE may set how the remaining money is divided between the Payee and the Payer, and anyone may then carry out that division. Only a split signed by every party takes priority over the decider's ruling. There is NO automatic unlock by time under this rule. The parties may always settle by every party signing the same division. While money is held, the Payee may at any time, alone, return all of it to the Payer; this cannot be undone. Dispute time limit: none. A pause holds the money for as long as it lasts.

6. RECOVERY SIGNERS (2 of 2):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 3 day(s) (259200 seconds).

7. TOKEN RISKS. Detected on this token: the token issuer can freeze the vault. Accepted by the parties: the token issuer can freeze the vault. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   destination: "Detroit, MI"
   documents: ["Commercial invoice","Packing list","Bill of lading"]
   incoterm: "FOB"
   inspection_days: 5
   origin: "Port of Haiphong"
   Cross-border sale of goods. Delivery terms are the Incoterms 2020 rule named above, from the origin to the destination stated. The parts above are the trade's stages, released in order when both parties approve each one; the Payee presents the documents listed above before asking for the stage they belong to, and the Payer has the inspection period above, counted from arrival, to check the goods before approving the final part. A document is presented by recording its SHA-256 on-chain in a memo signed by the presenting party; the documents themselves stay with the parties. If a decider is named on-chain, that decider acts as the examiner of documents. This agreement covers payment only; title to the goods, customs and carriage follow the documents and the law of the places of shipment and delivery.
   Attachment: none
   Reference: 4471447144714471447144714471aaaa

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

#### Vector 5 — general@2, one part, TrueDeadlock with consent, attachment

No template parameters beyond the part labels: everything the parties agreed is in the subject, the attachment digest and the chain fields.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            5
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 6
milestoneAmounts  [25000000]
rule / timer      TrueDeadlock / FromDeadlock, timeout 0
recovery          2-of-2, delay 259200
risk / accepted   1 / 1, priceRiskTerm 0
link blob (JCS)   {"a":"9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a","n":"55555555555555555555555555555555","p":{"milestones":[""]},"s":"Settlement of the March invoice dispute","t":"general@2"}
link (base64url)  eyJhIjoiOWE5YTlhOWE5YTlhOWE5YTlhOWE5YTlhOWE5YTlhOWE5YTlhOWE5YTlhOWE5YTlhOWE5YTlhOWE5YTlhOWE5YSIsIm4iOiI1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NSIsInAiOnsibWlsZXN0b25lcyI6WyIiXX0sInMiOiJTZXR0bGVtZW50IG9mIHRoZSBNYXJjaCBpbnZvaWNlIGRpc3B1dGUiLCJ0IjoiZ2VuZXJhbEAyIn0
```

Expected: **2824 bytes**, SHA-256
`8b4a54a7d0ef7de6c5a10a5ccf7e6eb72798cefda2fcf0d82666779705316d77`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template general@2 · format c5
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "Settlement of the March invoice dispute"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 25 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 6 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 5) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 25 token units

5. IF THERE IS A PROBLEM. Rule: NO DECIDER, NO TIMER. If a problem is reported, the remaining money stays locked until every party signs the same split or the recovery signers act. It never unlocks by time. Each party must give separate, explicit consent to this rule when signing. The parties may always settle by every party signing the same division. While money is held, the Payee may at any time, alone, return all of it to the Payer; this cannot be undone.

6. RECOVERY SIGNERS (2 of 2):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 3 day(s) (259200 seconds).

7. TOKEN RISKS. Detected on this token: the token issuer can freeze the vault. Accepted by the parties: the token issuer can freeze the vault. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   none
   The parties' obligations are those stated in the subject and in any attachment whose digest appears below; the money moves only as sections 4 to 6 provide.
   Attachment: SHA-256 9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a (held by the parties, never on-chain)
   Reference: 55555555555555555555555555555555

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

### Historical: format c3 under `3785ede684cfaa05b84cc14f06c71f6932d1c97b85aeb9ccd9a8620f1d556a5d`

Texts signed by v0.3–v0.6 clients. Still verified by `PROGRAM_HASH_HISTORY`; digests are pinned by hand in `test/template.test.ts` and never regenerated.

#### Vector 1 — protected-payment@2, Shipped preset (USDC-like, freeze flag)

The shape the app's Protected payment and payer-created requests produce.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            1759600000
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 6
milestoneAmounts  [25000000]
rule / timer      TimeoutRelease / FromActivation, timeout 864000
recovery          2-of-2, delay 259200
risk / accepted   1 / 1, priceRiskTerm 0
link blob (JCS)   {"n":"000102030405060708090a0b0c0d0e0f","p":{"preset":"shipped","window_days":10},"s":"Vintage lamp, as pictured","t":"protected-payment@2"}
link (base64url)  eyJuIjoiMDAwMTAyMDMwNDA1MDYwNzA4MDkwYTBiMGMwZDBlMGYiLCJwIjp7InByZXNldCI6InNoaXBwZWQiLCJ3aW5kb3dfZGF5cyI6MTB9LCJzIjoiVmludGFnZSBsYW1wLCBhcyBwaWN0dXJlZCIsInQiOiJwcm90ZWN0ZWQtcGF5bWVudEAyIn0
```

Expected: **2658 bytes**, SHA-256
`57e62d6f7875022406cfd4183a790d0c6383d4057ae310f040674e7138ae22ba`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template protected-payment@2 · format c3
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "Vintage lamp, as pictured"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 25 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 6 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 1759600000) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 3785ede684cfaa05b84cc14f06c71f6932d1c97b85aeb9ccd9a8620f1d556a5d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 25 token units

5. IF THERE IS A PROBLEM. Rule: TIMEOUT RELEASE. If no release has happened 10 day(s) (864000 seconds) after the clock starts, anyone may send the remaining money to the Payee. The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, or the recovery signers act. The parties may always settle by every party signing the same division.

6. RECOVERY SIGNERS (2 of 2):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 3 day(s) (259200 seconds).

7. TOKEN RISKS. Detected on this token: the token issuer can freeze the vault. Accepted by the parties: the token issuer can freeze the vault. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   preset: "shipped"
   window_days: 10
   Attachment: none
   Reference: 000102030405060708090a0b0c0d0e0f

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

#### Vector 2 — freelance@2, three parts, non-ASCII, NO normalization, attachment

The subject's `é` is DECOMPOSED (`e` + U+0301) and the second label uses a precomposed `ü`, `—` and an emoji: implementations MUST hash them as given.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            42
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 6
milestoneAmounts  [1000000, 2500000, 500000]
rule / timer      TrueDeadlock / FromDeadlock, timeout 0
recovery          2-of-3, delay 604800
risk / accepted   1 / 1, priceRiskTerm 0
link blob (JCS)   {"a":"5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f","n":"ffeeddccbbaa99887766554433221100","p":{"ip_transfer_on_final_payment":true,"milestones":["Sketches","Entwürfe — \"v2\" 🎨",""],"revisions":2},"s":"Café logo commission","t":"freelance@2"}
link (base64url)  eyJhIjoiNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZiIsIm4iOiJmZmVlZGRjY2JiYWE5OTg4Nzc2NjU1NDQzMzIyMTEwMCIsInAiOnsiaXBfdHJhbnNmZXJfb25fZmluYWxfcGF5bWVudCI6dHJ1ZSwibWlsZXN0b25lcyI6WyJTa2V0Y2hlcyIsIkVudHfDvHJmZSDigJQgXCJ2MlwiIPCfjqgiLCIiXSwicmV2aXNpb25zIjoyfSwicyI6IkNhZmXMgSBsb2dvIGNvbW1pc3Npb24iLCJ0IjoiZnJlZWxhbmNlQDIifQ
```

Expected: **2846 bytes**, SHA-256
`33e8dc296b9a8c737d2ada944a1b96f2937898eff886c72822d69f2ca3106015`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template freelance@2 · format c3
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "Café logo commission"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 4 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 6 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 42) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 3785ede684cfaa05b84cc14f06c71f6932d1c97b85aeb9ccd9a8620f1d556a5d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 1 token units — "Sketches"
   2. 2.5 token units — "Entwürfe — \"v2\" 🎨"
   3. 0.5 token units

5. IF THERE IS A PROBLEM. Rule: NO DECIDER, NO TIMER. If a problem is reported, the remaining money stays locked until every party signs the same split or the recovery signers act. It never unlocks by time. Each party must give separate, explicit consent to this rule when signing. The parties may always settle by every party signing the same division.

6. RECOVERY SIGNERS (2 of 3):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 7 day(s) (604800 seconds).

7. TOKEN RISKS. Detected on this token: the token issuer can freeze the vault. Accepted by the parties: the token issuer can freeze the vault. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   ip_transfer_on_final_payment: true
   revisions: 2
   Each part is released when both parties approve the work for that part. Revisions and rights follow the details above.
   Attachment: SHA-256 5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f (held by the parties, never on-chain)
   Reference: ffeeddccbbaa99887766554433221100

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

#### Vector 3 — vehicle-sale@2, zero-decimal mint, TimeoutRefund

Pins decimals = 0 formatting (`7`, not `0.7` or `7.`) and a seconds-only duration.

```
deal              GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
dealId            7
parties           [payer 0x01×32, payee 0x02×32]  approvals 2
mint / decimals   0x03×32 / 0
milestoneAmounts  [7]
rule / timer      TimeoutRefund / FromActivation, timeout 5400
recovery          2-of-2, delay 259200
risk / accepted   0 / 0, priceRiskTerm 0
link blob (JCS)   {"n":"0f0e0d0c0b0a09080706050403020100","p":{"inspection_days":2,"make_model":"Honda Civic","mileage_band":"50k-100k","milestones":[""],"title_status":"clean","year":2015},"s":"2015 Honda Civic, silver","t":"vehicle-sale@2"}
link (base64url)  eyJuIjoiMGYwZTBkMGMwYjBhMDkwODA3MDYwNTA0MDMwMjAxMDAiLCJwIjp7Imluc3BlY3Rpb25fZGF5cyI6MiwibWFrZV9tb2RlbCI6IkhvbmRhIENpdmljIiwibWlsZWFnZV9iYW5kIjoiNTBrLTEwMGsiLCJtaWxlc3RvbmVzIjpbIiJdLCJ0aXRsZV9zdGF0dXMiOiJjbGVhbiIsInllYXIiOjIwMTV9LCJzIjoiMjAxNSBIb25kYSBDaXZpYywgc2lsdmVyIiwidCI6InZlaGljbGUtc2FsZUAyIn0
```

Expected: **2807 bytes**, SHA-256
`e989c9665f7b360dd73c9dfee136432321b958dd69f558b74314b21da90e1a1b`.

Full canonical text (between the fence lines; every line ends with LF, including the last):

````
LATCH PROTECTED PAYMENT AGREEMENT · template vehicle-sale@2 · format c3
Status: Solana devnet demonstration. Creates no legal obligations and involves no real money.

1. SUBJECT. "2015 Honda Civic, silver"

2. PARTIES (by wallet address).
   1. Payer: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   2. Payee: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR

3. AMOUNT AND HOLDING. The Payer pays 7 token units (mint CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8, 0 decimals) into the vault of deal GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq (deal id 7) under the Latch program BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv on Solana devnet. The vault is controlled only by this deal's rules: the program has no instruction that lets any Latch Labs key move, freeze, refund or redirect the money. The program is upgradeable on Solana devnet: whoever holds its upgrade authority can replace its code, and new code could change these rules. The app that prepared this text verified the deployed program's code as SHA-256 3785ede684cfaa05b84cc14f06c71f6932d1c97b85aeb9ccd9a8620f1d556a5d (its program-data bytes, trailing zero padding removed).

4. RELEASES. The money is released in this order, each part when 2 of 2 parties approve it:
   1. 7 token units

5. IF THERE IS A PROBLEM. Rule: TIMEOUT REFUND. If no release has happened 5400 seconds after the clock starts, anyone may return the remaining money to the Payer. The clock starts when every party has confirmed ready and runs while the deal is active. Any party may pause it by reporting a problem; while paused, the money moves only when every party signs the same split, the pausing party resumes the clock, or the recovery signers act. The parties may always settle by every party signing the same division.

6. RECOVERY SIGNERS (2 of 2):
   4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
   8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
   They can only divide the money between the Payer and the Payee, and only after a public on-chain notice period of 3 day(s) (259200 seconds).

7. TOKEN RISKS. Detected on this token: none. Accepted by the parties: none. Price-risk term code: 0.

8. TEMPLATE DETAILS.
   inspection_days: 2
   make_model: "Honda Civic"
   mileage_band: "50k-100k"
   title_status: "clean"
   year: 2015
   This agreement covers payment only. It does not transfer the vehicle's title; title and registration transfer happen separately under the law of the place of sale.
   Attachment: none
   Reference: 0f0e0d0c0b0a09080706050403020100

9. ELECTRONIC SIGNATURE. The parties agree to transact electronically. Each party signs by sending a Solana transaction from their wallet that records approval of this text's SHA-256 digest on the deal account. The on-chain record of the digest, signatures and timestamps is the record of signing.
````

<!-- vectors:end -->

A conforming implementation MUST reproduce every digest exactly.

## 10. Document claims (`latch-doc@1`, v0.8)

A party presents a document for a stage by including, in the same transaction
as its `approve_milestone` for that stage, one SPL Memo (v2,
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) instruction per document whose
only account is the presenting party (so the Memo program requires that
party's signature) and whose data is the UTF-8 of this JCS-canonical JSON:

```
{"deal":"<deal address, base58>","name":"<canonical line, 1–40 code points>","sha256":"<64 lower-case hex>","stage":<integer 0–15>,"v":"latch-doc@1"}
```

The Latch program never reads these memos; they are a public, signed,
timestamped claim ("I presented a file with this digest for this stage of
this deal") that rides with the approval that moves the deal. The file itself
stays with the parties.

A verifier lists a deal's documents from its successful transactions only:
for each Memo instruction with exactly one account, that account MUST be a
transaction signer and one of the deal's `parties`, the data MUST decode
under the rules above byte for byte (non-canonical bytes → not a claim), and
`deal` MUST equal the deal being examined. Anything else is ignored, never
reported as an error. The same name may appear more than once (a corrected
file is a new claim); readers show them in transaction order.

### 10.1 Receipt acknowledgements (`latch-doc-ack@1`, v0.15)

The receiving party may acknowledge a presented document the same way: a Memo
instruction, in the same transaction as its own `approve_milestone` for that
stage, whose only account is the acknowledging party and whose data is the
UTF-8 of this JCS-canonical JSON:

```
{"deal":"<deal address, base58>","sha256":"<64 lower-case hex>","stage":<integer 0–15>,"v":"latch-doc-ack@1"}
```

It carries no name: the digest ties it to the presentation. A verifier applies
the same filter as for claims (signing party, this deal, canonical bytes) and
pairs an acknowledgement with every presentation of the same digest and stage.
An acknowledgement without a matching presentation is still shown, as the
party's own statement. Neither memo is read by the Latch program.

## 9. Versioning

- Line 1 names the template id and format: `… · template {t} · format c3`.
  A verifier that parses (rather than just re-hashes) MUST check it.
- Any change that alters one byte of output for the same inputs needs a new
  format id (`c4`) or a new template id (`@3`). Prose changes to this file
  don't.
- **Format c5 (v0.7.1, program `4e5fa0a6…`) is current.** It is c4 with line 1
  reading `… · format c5` and, for ResumeRule / Split / RefundPayer only, one
  more sentence after the dispute sentence: ` The limit counts all pauses
  together and never resets: once it has been reached, {L}` where {L} is
  `anyone may end any later pause at once.` (ResumeRule), `any later pause lets
  anyone divide the remaining money that way at once.` (Split) or `any later
  pause lets anyone return the remaining money to the Payer at once.`
  (RefundPayer). For NeverExpire, c5 differs from c4 only in line 1. Verifiers
  MUST still accept c4 (texts signed under v0.7).
- **Format c4 (v0.7, program `0c4af8ba…`).** It is c3 with three
  changes, all in line 1 and section 5:
  1. line 1 reads `… · format c4`;
  2. for a clock that runs from the start (`FromActivation`), the pause
     sentence lists "the Payee returns it to the Payer" among the ways money
     moves while paused, and — only when the deal has a dispute policy other
     than NeverExpire — "or the dispute time limit below is reached";
  3. after "The parties may always settle by every party signing the same
     division." it appends ` While money is held, the Payee may at any time,
     alone, return all of it to the Payer; this cannot be undone.` and, for a
     `FromActivation` deal, one dispute sentence from the deal's
     `dispute_policy` / `dispute_window_secs` ({D} = the window as in 6.2):
     - NeverExpire: `Dispute time limit: none. A pause holds the money for as long as it lasts.`
     - ResumeRule: `Dispute time limit: {D} in total across all pauses. Once the clock has been paused that long, anyone may end the pause, and the clock resumes under the rule above.`
     - Split: `… anyone may divide the remaining money: {P}% to the Payee, the rest to the Payer.` ({P} = split_bps/100 with two decimals under AutoSplit, else `50.00`)
     - RefundPayer: `… anyone may return the remaining money to the Payer.`

  The policy is set in the deal's creating transaction (create → set_dispute_policy
  → the creator's sign_terms), so the text the creator signs already states it.
  A c2 or c3 text MUST NOT be accepted for a deal whose policy isn't
  NeverExpire / 0: those formats can't state one. The section 5 sentences above
  are pinned per policy in `test/dispute-policy.test.ts`. The vectors in
  section 8 are c3 and stay as they were.
- Format c2 (v0.3) is identical to c3 except line 1 and the program-hash
  sentence, which read "When this text was prepared, the program's deployed
  code had SHA-256 {hash} (…)" — a fact the v0.3 app didn't check. Verifiers
  MUST still accept c2 texts; Latch Dial renders c2 only to verify.
- Format c1 **shipped in Latch Dial v0.2** and is **deprecated**: it applied
  NFC, did not validate link params (a newline in a param or label could add
  text that looks like an extra clause), put the format marker on line 2, and
  mis-rendered decimals = 0. New texts are never c1. Verifiers SHOULD still
  verify c1 deals with a frozen copy of the v0.2 renderer and its lax decoder
  (Latch Dial: `src/lib/templateC1.ts`, verify-only) and MUST label them as an
  older format; a c1 text that verifies is exactly what was signed.
