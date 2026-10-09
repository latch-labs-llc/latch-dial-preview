// Screenshot driver for review rounds: `node scripts/shots.mjs <outDir>`.
// Serves dist/ (build with VITE_SERVICE_URL=https://svc.example so the
// profile screens render), answers Solana RPC from screenshots/v0.7/fixture.json
// (SHOTS_FIXTURE_FILE to change)
// (real Deal accounts made on the deployed program in LiteSVM — see
// test/shots-fixture.test.ts), relays anything else read-only to devnet, and
// drives each screen in light and dark. The mock wallet is a TEST-ONLY stand-in:
// it never holds a key, and "sending" only returns a fake signature so success
// screens can render. Nothing is ever submitted to a real network.
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { chromiumPath, startPreview, waitForHttp, withCleanup } from "./smoke-lib.mjs";

const OUT = process.argv[2] ?? "screenshots/v0.7";
const PORT = Number(process.env.SHOTS_PORT ?? 4185);
const fx = JSON.parse(readFileSync(process.env.SHOTS_FIXTURE_FILE ?? "screenshots/v0.7/fixture.json", "utf8"));
fx.txs ??= {};
const txBySig = Object.fromEntries(Object.values(fx.txs).map((t) => [t.transaction.signatures[0], t]));
mkdirSync(OUT, { recursive: true });

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

const SLOT = 400_000_000;
const acct = (a) => (a ? { data: [a.data, "base64"], executable: false, lamports: a.lamports, owner: a.owner, rentEpoch: 0, space: Buffer.from(a.data, "base64").length } : null);
async function rpc(body) {
  const one = async (req) => {
    const p = req.params ?? [];
    const ok = (result) => ({ jsonrpc: "2.0", id: req.id, result });
    const ctx = (value) => ok({ context: { slot: SLOT }, value });
    switch (req.method) {
      case "getAccountInfo":
        if (fx.accounts[p[0]]) return ctx(acct(fx.accounts[p[0]]));
        break; // relay (e.g. the program, for the guard)
      case "getMultipleAccounts":
        return ctx(p[0].map((k) => acct(fx.accounts[k])));
      case "getProgramAccounts": {
        if (p[0] !== fx.program) return ok([]);
        const filters = p[1]?.filters ?? [];
        const res = Object.entries(fx.accounts)
          .filter(([, a]) => a.owner === fx.program)
          .filter(([, a]) => {
            const d = Buffer.from(a.data, "base64");
            return filters.every((f) => (f.dataSize !== undefined ? d.length === f.dataSize : b58(f.memcmp.bytes).equals(d.subarray(f.memcmp.offset, f.memcmp.offset + b58(f.memcmp.bytes).length))));
          })
          .map(([pubkey, a]) => ({ pubkey, account: acct(a) }));
        return ok(res);
      }
      case "getBalance":
        return ctx(3_000_000_000);
      case "getTokenAccountBalance": {
        const a = fx.accounts[p[0]];
        const amt = a ? Buffer.from(a.data, "base64").readBigUInt64LE(64).toString() : "0";
        if (!a) return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "could not find account" } };
        return ctx({ amount: amt, decimals: 6, uiAmount: Number(amt) / 1e6, uiAmountString: String(Number(amt) / 1e6) });
      }
      case "getLatestBlockhash":
        return ctx({ blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", lastValidBlockHeight: SLOT + 150 });
      case "getSignaturesForAddress": {
        // A deal's recorded closing transaction (e.g. a payee refund), so its events can be read.
        const t = fx.txs[p[0]];
        return ok(t ? [{ signature: t.transaction.signatures[0], slot: SLOT - 10, err: null, memo: null, blockTime: t.blockTime, confirmationStatus: "finalized" }] : []);
      }
      case "getTransaction":
        if (txBySig[p[0]]) return ok({ ...txBySig[p[0]], slot: SLOT - 10 });
        return ok(null);
      case "getSlot":
      case "getBlockHeight":
        return ok(SLOT);
      case "getBlockTime":
        return ok(Math.floor(Date.now() / 1000));
      case "getGenesisHash":
        return ok("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
      case "getSignatureStatuses":
        return ctx(p[0].map(() => ({ slot: SLOT, confirmations: null, err: null, confirmationStatus: "confirmed" })));
      case "sendTransaction":
        return ok("5".repeat(87));
      case "getMinimumBalanceForRentExemption":
        return ok(2_039_280);
    }
    const r = await fetch("https://api.devnet.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    return r.json();
  };
  return Array.isArray(body) ? Promise.all(body.map(one)) : one(body);
}

const mockWallet = (me) => `(() => {
  const A=${JSON.stringify(A)}; const s=${JSON.stringify(me)}; let n=0n; for (const c of s) n=n*58n+BigInt(A.indexOf(c));
  const b=new Uint8Array(32); for (let i=31;i>=0;i--){ b[i]=Number(n&255n); n>>=8n; }
  const pk={ toBytes:()=>b, toString:()=>s, toBase58:()=>s };
  const h={};
  window.isPhantomInstalled=true;
  window.phantom={ solana:{ isPhantom:true, publicKey:null, isConnected:false,
    connect: async()=>{ window.phantom.solana.publicKey=pk; window.phantom.solana.isConnected=true; (h.connect||[]).forEach(f=>f(pk)); return { publicKey: pk }; },
    disconnect: async()=>{}, on:(e,f)=>{(h[e]=h[e]||[]).push(f)}, off:()=>{}, removeListener:()=>{}, removeAllListeners:()=>{},
    signTransaction: async(t)=>t, signAllTransactions: async(t)=>t,
    signAndSendTransaction: async()=>({ signature: ${JSON.stringify("5".repeat(87))} }),
    signMessage: async()=>{ throw new Error('screenshot wallet'); } } };
  localStorage.setItem('walletName', JSON.stringify('Phantom'));
})();`;

async function seed(page, extra = {}) {
  const data = {
    contacts: fx.local.contacts,
    links: fx.local.links,
    saved: Object.fromEntries(Object.values(fx.deals).map((d) => [d, fx.generatedAt])),
    settings: { theme: "system", requestsFrom: "anyone", largePaymentUsd: 500, seenHowItWorks: true, haptics: true },
    ...extra,
  };
  await page.evaluate(
    (d) =>
      new Promise((res, rej) => {
        const r = indexedDB.open("latch-dial");
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => {
          const tx = r.result.transaction("kv", "readwrite");
          tx.objectStore("kv").put(d, "data");
          tx.oncomplete = () => res(null);
          tx.onerror = () => rej(tx.error);
        };
        r.onerror = () => rej(r.error);
      }),
    data,
  );
}

// Serve the VERIFIED program (test/fixtures/latch.so, whose hash is the pinned one)
// so the signing guard sees what the app was checked against. Without this the
// guard reads live devnet, and screenshots change whenever devnet is upgraded.
{
  const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
  const PD = "HtqsjQtBqxo1W8uXargaQeZ1tTosd93T73ejzHnuXVca";
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0);
  b58(PD).copy(prog, 4);
  const so = readFileSync("test/fixtures/latch.so");
  const head = Buffer.alloc(45);
  head.writeUInt32LE(3, 0);
  head.writeBigUInt64LE(400_000_000n, 4);
  fx.accounts[fx.program] = { data: prog.toString("base64"), owner: LOADER, lamports: 1_141_440 };
  fx.accounts[PD] = { data: Buffer.concat([head, so]).toString("base64"), owner: LOADER, lamports: 1_000_000_000 };
}

const D = fx.deals;
const P = fx.people;
const wait = (page, ms = 2500) => page.waitForTimeout(ms);
// v0.9: the Custom builder is clause by clause (§1 subject → §2 parties → §3–4 money → §5 rule …).
async function builderToSettle(p) {
  await p.goto(url("#/new-agreement"));
  await wait(p);
  await click(p, "Goods sale");
  await p.getByPlaceholder(/Used road bike/).fill("Standing desk");
  await click(p, "Continue");
  await p.getByPlaceholder("Wallet address").nth(1).fill(P.jordan);
  await click(p, "Continue");
  await p.getByPlaceholder("$0.00").first().fill("400");
  await click(p, "Continue");
}
const click = (page, text) => page.getByText(text, { exact: false }).first().click();
const scenarios = [
  ["welcome", { wallet: false }, async (p) => p.goto(url("#/"))],
  ["activity", {}, async (p) => p.goto(url("#/"))],
  ["pay-form", {}, async (p) => p.goto(url(`#/pay?to=${P.alex}&amount=120&for=Used%20road%20bike`))],
  ["pay-form-work", {}, async (p) => (await p.goto(url(`#/pay?to=${P.alex}&amount=600&for=Logo%20and%20brand%20kit`)), await wait(p), await p.getByRole("button", { name: /^Work · / }).click())],
  ["pay-compare", {}, async (p) => (await p.goto(url(`#/pay?to=${P.alex}&amount=120&for=Used%20road%20bike`)), await wait(p), await click(p, "Compare options"))],
  ["pay-review", {}, async (p) => (await p.goto(url(`#/pay?to=${P.alex}&amount=120&for=Used%20road%20bike`)), await wait(p), await click(p, "Review payment"))],
  ["request-pay-success", {}, async (p) => (await p.goto(url(`#/pay?req=${fx.requestLink}`)), await wait(p, 3000), await click(p, "Review payment"), await wait(p, 800), await click(p, "Create protected payment"), await wait(p, 5000))],
  ["request-money", {}, async (p) => p.goto(url("#/request"))],
  // New in v0.6 (no "before"): the requester's link screen for a Work request.
  [
    "request-money-work-link",
    {},
    async (p) => {
      await p.goto(url("#/request"));
      await wait(p);
      await p.getByLabel("Amount").fill("600");
      await p.locator("#for").fill("Logo and brand kit");
      await p.getByRole("button", { name: /^Work · / }).click();
      await click(p, "Create link");
      await wait(p, 1500);
    },
  ],
  ["builder-what", {}, async (p) => p.goto(url("#/new-agreement"))],
  ["builder-settle", {}, async (p) => builderToSettle(p)],
  ["deal-accept", {}, async (p) => p.goto(url(`#/deal/${D.accept}`))],
  ["deal-pay-in", {}, async (p) => p.goto(url(`#/deal/${D.payIn}`))],
  ["deal-funded-payer", {}, async (p) => p.goto(url(`#/deal/${D.funded}`))],
  ["deal-work-payee", {}, async (p) => p.goto(url(`#/deal/${D.workPayee}`))],
  ["deal-active", {}, async (p) => p.goto(url(`#/deal/${D.active}`))],
  ["deal-pause-sheet", {}, async (p) => (await p.goto(url(`#/deal/${D.active}`)), await wait(p, 4000), await click(p, "Something's wrong"))],
  ["deal-paused", {}, async (p) => p.goto(url(`#/deal/${D.paused}`))],
  ["deal-autosplit", {}, async (p) => p.goto(url(`#/deal/${D.autoSplit}`))],
  // ---- v0.7: new and changed screens
  ["deal-hostile-policy", {}, async (p) => p.goto(url(`#/deal/${D.hostile}`))],
  ["deal-refund-button", {}, async (p) => p.goto(url(`#/deal/${D.refundable}`))],
  ["deal-refund-sheet", {}, async (p) => (await p.goto(url(`#/deal/${D.refundable}`)), await wait(p, 4000), await p.getByRole("button", { name: /^Refund / }).first().click())],
  ["deal-refunded-payer", {}, async (p) => p.goto(url(`#/deal/${D.refunded}`))],
  ["evidence-refunded", {}, async (p) => p.goto(url(`#/evidence/${D.refunded}`))],
  ["deal-partial-signed", {}, async (p) => p.goto(url(`#/deal/${D.partial}`))],
  ["deal-policy-split-expired", {}, async (p) => p.goto(url(`#/deal/${D.policySplit}`))],
  ["deal-policy-resume-expired", {}, async (p) => p.goto(url(`#/deal/${D.policyResume}`))],
  ["deal-policy-pause-sheet", {}, async (p) => (await p.goto(url(`#/deal/${D.policyActive}`)), await wait(p, 4000), await click(p, "Something's wrong"))],
  ["agreement-c4", {}, async (p) => p.goto(url(`#/agreement/${D.policyActive}`))],
  ["deal-recovery-funded", {}, async (p) => p.goto(url(`#/deal/${D.recoveryFunded}`))],
  [
    "builder-dispute",
    {},
    async (p) => {
      await builderToSettle(p);
      await click(p, "Return to payer");
      await p.locator("#dispute-days").fill("7");
    },
  ],
  [
    "builder-review-policy",
    {},
    async (p) => {
      await builderToSettle(p);
      await click(p, "Return to payer");
      await p.locator("#dispute-days").fill("7");
      await click(p, "Continue");
      await wait(p, 600);
      await click(p, "Continue");
    },
  ],
  ["how-it-works", {}, async (p) => (await p.goto(url("#/settings")), await wait(p), await click(p, "How protection works"))],
  ["settings", {}, async (p) => p.goto(url("#/settings"))],
];
const only = process.env.SHOTS_ONLY?.split(",");
function url(hash) {
  return `http://localhost:${PORT}/${hash}`;
}

const server = startPreview(PORT);
let browser;
const errors = [];
await withCleanup(
  async () => {
    try {
      await browser?.close();
    } catch {}
    server.stop();
  },
  async () => {
    await waitForHttp(url(""));
    browser = await chromium.launch({ executablePath: chromiumPath() });
    for (const scheme of ["light", "dark"]) {
      for (const [name, opts, run] of scenarios) {
        if (only && !only.includes(name)) continue;
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
        if (opts.wallet !== false) await ctx.addInitScript(mockWallet(fx.me));
        await ctx.route("https://api.devnet.solana.com/**", async (route) => {
          const req = route.request();
          const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
          if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
          try {
            const out = await rpc(JSON.parse(req.postData() ?? "{}"));
            await route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(out) });
          } catch {
            await route.abort();
          }
        });
        // Websocket confirmations (signatureSubscribe) answered at once, so success screens render.
        await ctx.routeWebSocket(/^wss?:\/\/api\.devnet\.solana\.com/, (ws) => {
          ws.onMessage((m) => {
            let r;
            try {
              r = JSON.parse(String(m));
            } catch {
              return;
            }
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: 7 }));
            if (r.method === "signatureSubscribe")
              ws.send(JSON.stringify({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: 7, result: { context: { slot: SLOT }, value: { err: null } } } }));
          });
        });
        // The Telegram widget origin (separate host in production): a stand-in button.
        await ctx.route("https://tgw.example/**", (route) =>
          route.fulfill({ status: 200, headers: { "content-type": "text/html" }, body: '<button style="font:600 15px system-ui;padding:9px 18px;border-radius:10px;border:0;background:#2aabee;color:#fff">Log in with Telegram</button>' }),
        );
        await ctx.route("https://svc.example/**", (route) =>
          route.fulfill({ status: route.request().url().includes("/owners/") ? 200 : 404, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ handle: null, telegram: null }) }),
        );
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errors.push(`${scheme}/${name}: ${e.message}`));
        await page.goto(url("#/settings"));
        await seed(page);
        await page.reload(); // load the seeded local data
        try {
          await run(page);
          await wait(page, 3500);
          // Grow the viewport to the content instead of fullPage (keeps fixed bars where they belong).
          const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 844));
          await page.setViewportSize({ width: 390, height: Math.min(h, 4000) });
          await wait(page, 400);
          await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
        } catch (e) {
          errors.push(`${scheme}/${name}: ${e.message.split("\n")[0]}`);
        }
        await ctx.close();
      }
    }
  },
  { timeoutMs: 20 * 60 * 1000 },
).catch((e) => errors.push(`aborted: ${e.message}`));
if (errors.length) console.error("shots: some screens failed\n" + errors.join("\n"));
console.log(`shots → ${OUT}`);
process.exit(errors.length ? 1 : 0);
