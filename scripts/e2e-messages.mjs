// Two SIGNING mock wallets drive the production bundle through the whole
// messaging + negotiation flow against the LIVE identity service and devnet:
// turn on → message → reply → propose → counter → accept → create the deal →
// the other side opens it and signs. Both wallets are throwaway keypairs
// funded by the public demo tap; their service data is erased at the end.
//
//   CHROMIUM=... node scripts/e2e-messages.mjs
//
// The mock wallet signs messages and transactions in Node (the browser only
// relays bytes), so no secret ever lives in the page. Service requests are
// relayed through Node too: the Worker's CORS allowlist is the real app
// origin, not localhost.
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Connection, Keypair, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { chromium } from "playwright-core";
import { chromiumPath, startPreview, waitForHttp, withCleanup } from "./smoke-lib.mjs";

const PORT = Number(process.env.E2E_PORT ?? 4185);
const SERVICE = process.env.LIVE_SERVICE ?? "https://latch-dial-service.latchlabs.workers.dev";
const RPC = process.env.RPC_URL ?? (readFileSync(".env.production", "utf8").match(/^VITE_RPC_URL=(.+)$/m)?.[1] ?? "https://api.devnet.solana.com");
const conn = new Connection(RPC, "confirmed");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b64 = (b) => Buffer.from(b).toString("base64");

// The public demo tap (same bytes as src/lib/demo.ts; worthless devnet SOL by design).
const tapBytes = readFileSync("src/lib/demo.ts", "utf8").match(/TAP_SECRET = new Uint8Array\(\[([\s\S]*?)\]\)/)[1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const tap = Keypair.fromSecretKey(Uint8Array.from(tapBytes));

const A = Keypair.generate();
const B = Keypair.generate();
const errors = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fundFromTap(to) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: tap.publicKey, toPubkey: to, lamports: 60_000_000 }));
  tx.feePayer = tap.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(tap);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/** Node-side signer for one wallet: Ed25519 over message bytes; sign + send a serialized transaction. */
function signer(kp) {
  return {
    sign: (bytes) => Array.from(ed25519.sign(Uint8Array.from(bytes), kp.secretKey.slice(0, 32))),
    sendTx: async (bytes) => {
      const raw = Uint8Array.from(bytes);
      let sig;
      try {
        const tx = VersionedTransaction.deserialize(raw);
        tx.sign([kp]);
        sig = await conn.sendTransaction(tx, { skipPreflight: false });
      } catch (e) {
        const tx = Transaction.from(raw);
        tx.partialSign(kp);
        sig = await conn.sendRawTransaction(tx.serialize());
      }
      return sig;
    },
  };
}

/** A Phantom-shaped provider whose signing goes to Node through exposed functions. */
const mock = (pk, id) => `(() => {
  const A='${B58}'; const s=${JSON.stringify(pk)}; let n=0n; for (const c of s) n=n*58n+BigInt(A.indexOf(c));
  const b=new Uint8Array(32); for (let i=31;i>=0;i--){ b[i]=Number(n&255n); n>>=8n; }
  const pub={ toBytes:()=>b, toString:()=>s, toBase58:()=>s, equals:(o)=>String(o)===s };
  const h={};
  window.isPhantomInstalled=true;
  window.phantom={ solana:{ isPhantom:true, publicKey:null, isConnected:false,
    connect: async()=>{ window.phantom.solana.publicKey=pub; window.phantom.solana.isConnected=true; (h.connect||[]).forEach(f=>f(pub)); return { publicKey: pub }; },
    disconnect: async()=>{}, on:(e,f)=>{(h[e]=h[e]||[]).push(f)}, off:()=>{}, removeListener:()=>{}, removeAllListeners:()=>{},
    signMessage: async(m)=>{ const sig = await window.__sign_${id}(Array.from(m)); return { signature: Uint8Array.from(sig), publicKey: pub }; },
    signAndSendTransaction: async(tx)=>{ const bytes = tx.serialize ? Array.from(tx.serialize({ requireAllSignatures:false, verifySignatures:false })) : []; const signature = await window.__sendTx_${id}(bytes); return { signature }; },
    signTransaction: async()=>{ throw new Error('use signAndSendTransaction'); }, signAllTransactions: async()=>{ throw new Error('n/a'); } } };
  localStorage.setItem('walletName', JSON.stringify('Phantom'));
})();`;

async function relay(ctx) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
  await ctx.route(`${SERVICE}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    try {
      const r = await fetch(req.url(), { method: req.method(), headers: { "content-type": "application/json", ...(req.headers()["x-latch-issued"] ? { "x-latch-issued": req.headers()["x-latch-issued"], "x-latch-sig": req.headers()["x-latch-sig"] } : {}) }, body: req.postData() ?? undefined });
      const text = await r.text();
      if (process.env.E2E_TRACE) log("relay", req.method(), req.url().slice(SERVICE.length, SERVICE.length + 60), r.status, text.slice(0, 80));
      await route.fulfill({ status: r.status, headers: { ...cors, "content-type": "application/json" }, body: text });
    } catch (e) {
      errors.push(`relay ${req.url()}: ${e.message}`);
      await route.abort();
    }
  });
}

async function wallet(browser, kp, id) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const s = signer(kp);
  await ctx.exposeFunction(`__sign_${id}`, s.sign);
  await ctx.exposeFunction(`__sendTx_${id}`, s.sendTx);
  await ctx.addInitScript(mock(kp.publicKey.toBase58(), id));
  await relay(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${id} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|cloudflareinsights|404 \(Not Found\)/.test(m.text()) && errors.push(`${id} console: ${m.text().slice(0, 200)}`));
  // A full reload every time (a hash-only change would keep the app's module state, e.g. caches and the unlocked session).
  const go = async (hash, ms = 2500) => {
    await page.goto(`http://localhost:${PORT}/${hash}`);
    await page.reload();
    await page.waitForTimeout(ms);
  };
  const unlockIfAsked = async () => {
    const u = page.getByRole("button", { name: "Unlock", exact: true });
    if (await u.count()) {
      await u.first().click();
      await page.waitForTimeout(2500);
    }
  };
  const shot = (n) => page.screenshot({ path: `screenshots/e2e/${id}-${n}.png`, fullPage: true });
  return { ctx, page, go, unlockIfAsked, shot, id };
}

async function erase(kp) {
  const owner = kp.publicKey.toBase58();
  const issued = Math.floor(Date.now() / 1000);
  const msg = `Latch delete my service data v1\ncluster: devnet\nowner: ${owner}\nissued: ${issued}`;
  const sig = b64(ed25519.sign(new TextEncoder().encode(msg), kp.secretKey.slice(0, 32)));
  const r = await fetch(`${SERVICE}/me`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, issued, sig }) });
  return r.status;
}

const server = startPreview(PORT);
let browser;
await withCleanup(
  async () => {
    try {
      await browser?.close();
    } catch {}
    server.stop();
  },
  async () => {
    await waitForHttp(`http://localhost:${PORT}/`);
    log("A", A.publicKey.toBase58(), "B", B.publicKey.toBase58());
    log("fund A", await fundFromTap(A.publicKey));
    log("fund B", await fundFromTap(B.publicKey));
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const { mkdirSync } = await import("node:fs");
    mkdirSync("screenshots/e2e", { recursive: true });
    const a = await wallet(browser, A, "a");
    const b = await wallet(browser, B, "b");
    const apk = A.publicKey.toBase58();
    const bpk = B.publicKey.toBase58();
    const expectText = async (w, re, what, ms = 15000) => {
      try {
        await w.page.locator("#root").getByText(re).first().waitFor({ timeout: ms });
        log(`${w.id}: ${what} ✓`);
      } catch {
        errors.push(`${w.id}: ${what} — not found: ${re}`);
        await w.shot(`FAIL-${what.replace(/\W+/g, "-")}`);
      }
    };

    // 1. A turns messages on (3 signatures, automatic); B hasn't yet.
    await a.go("#/messages", 4000);
    await a.page.getByRole("button", { name: "Turn on messages" }).click();
    await a.page.waitForTimeout(4000);
    await expectText(a, /No conversations yet/, "A messages on");
    await a.go(`#/chat/${bpk}`, 4000);
    await a.unlockIfAsked();
    await expectText(a, /hasn't turned on messages yet/, "A sees B is not on");
    await a.shot("1-chat-before-b");

    // 2. B turns messages on; A sends; B reads and replies; A reads.
    await b.go("#/messages", 4000);
    await b.page.getByRole("button", { name: "Turn on messages" }).click();
    await b.page.waitForTimeout(4000);
    await expectText(b, /No conversations yet/, "B messages on");
    await b.shot("1b-on");
    log("waiting 65 s: the service's edge cache remembers A's earlier miss on B's keys for a minute");
    await b.page.waitForTimeout(65000);
    await a.go(`#/chat/${bpk}`, 4000);
    await a.unlockIfAsked();
    await a.page.waitForTimeout(2000);
    await a.shot("1c-chat-after-b");
    if (!(await a.page.getByLabel("Message", { exact: true }).count())) {
      errors.push("A: composer missing after B turned on; page text: " + (await a.page.locator("#root").innerText()).replace(/\s+/g, " ").slice(0, 400));
      throw new Error("stop");
    }
    await a.page.getByLabel("Message", { exact: true }).fill("hi B, want to do the logo job?");
    await a.page.getByRole("button", { name: "Send", exact: true }).click();
    await a.page.waitForTimeout(3000);
    await expectText(a, /want to do the logo job/, "A sees own bubble");
    await b.go(`#/chat/${apk}`, 4000);
    await b.unlockIfAsked();
    await expectText(b, /want to do the logo job/, "B receives", 75000);
    await b.page.getByLabel("Message", { exact: true }).fill("yes, send me terms");
    await b.page.getByRole("button", { name: "Send", exact: true }).click();
    await b.page.waitForTimeout(3000);
    await a.go(`#/chat/${bpk}`, 4000);
    await a.unlockIfAsked();
    await expectText(a, /send me terms/, "A receives reply", 75000);
    await a.shot("2-chat");

    // 3. A proposes terms from the Builder (general template, $120, one part).
    await a.go(`#/new-agreement?to=${bpk}`, 4000);
    const cont = async (w) => {
      await w.page.getByRole("button", { name: "Continue" }).click();
      await w.page.waitForTimeout(500);
    };
    await a.page.getByPlaceholder(/Consulting/).fill("Logo design for the bakery");
    await cont(a);
    await cont(a);
    await a.page.getByPlaceholder("$0.00").first().fill("120");
    await cont(a);
    await cont(a);
    await cont(a);
    await cont(a);
    await cont(a);
    await a.page.waitForTimeout(1000);
    await a.shot("3-review");
    const propose = a.page.getByRole("button", { name: "Propose in chat first" });
    if (!(await propose.isEnabled())) errors.push("A: Propose in chat first is disabled");
    await propose.click();
    await a.page.waitForTimeout(5000);
    await expectText(a, /Proposed terms/, "A sees proposal card");
    await expectText(a, /Signed by you · waiting for/, "A proposal status");
    await a.shot("4-proposed");

    // 4. B counters at $100.
    await b.go(`#/chat/${apk}`, 4000);
    await b.unlockIfAsked();
    await expectText(b, /Proposed terms/, "B sees proposal", 75000);
    await b.page.getByRole("button", { name: "Counter", exact: true }).click();
    await b.page.waitForTimeout(3000);
    const subj = await b.page.getByPlaceholder(/Consulting/).inputValue().catch(() => "");
    if (subj === "Logo design for the bakery") log("b: Builder prefilled from the proposal ✓");
    else errors.push(`B: Builder not prefilled (subject input = ${JSON.stringify(subj)})`);
    await cont(b);
    await cont(b);
    await b.page.getByPlaceholder("$0.00").first().fill("100");
    await cont(b);
    await cont(b);
    await cont(b);
    await cont(b);
    await cont(b);
    await b.page.waitForTimeout(1000);
    const counter = b.page.getByRole("button", { name: /Send counter-proposal \(v2\)/ });
    if (!(await counter.count())) errors.push("B: counter button missing");
    await counter.click();
    await b.page.waitForTimeout(5000);
    await expectText(b, /Counter-proposal · v2/, "B sees v2 card");
    await b.shot("5-countered");

    // 5. A accepts v2 → agreed; B (creator of v2) creates the deal.
    await a.go(`#/chat/${bpk}`, 4000);
    await a.unlockIfAsked();
    await expectText(a, /Counter-proposal · v2/, "A sees v2", 75000);
    await a.page.getByRole("button", { name: "Accept", exact: true }).click();
    await a.page.waitForTimeout(5000);
    await expectText(a, /Accepted by both/, "A sees agreed");
    await a.shot("6-accepted");
    await b.go(`#/chat/${apk}`, 4000);
    await b.unlockIfAsked();
    await expectText(b, /you create the deal/, "B sees it is the creator", 75000);
    await b.page.getByRole("button", { name: "Create the deal" }).click();
    await b.page.waitForTimeout(20000);
    await expectText(b, /The deal was created/, "B created + announced", 30000);
    await b.shot("7-created");

    // 6. A opens the deal from chat: the agreement regenerates and verifies; A accepts (signs) on chain.
    await a.go(`#/chat/${bpk}`, 4000);
    await a.unlockIfAsked();
    await expectText(a, /The deal was created/, "A sees the announcement", 75000);
    await a.page.getByRole("button", { name: "Open the deal" }).click();
    await a.page.waitForTimeout(8000);
    const url = a.page.url();
    const dealAddr = url.match(/#\/deal\/([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
    log("deal", dealAddr, url);
    await a.shot("8-deal-page");
    const txt = await a.page.locator("#root").innerText();
    if (!/Logo design for the bakery/.test(txt)) errors.push("A: deal page doesn't show the subject");
    if (/doesn't match|can't be read|not on this device/i.test(txt)) errors.push("A: agreement status problem on the deal page");
    // A is the payer of v2: the agreement must regenerate and match, and the pay-in button must be offered.
    if (/matches on-chain/.test(txt)) log("a: agreement matches on-chain ✓");
    else errors.push("A: agreement not shown as matching on-chain");
    if (await a.page.getByRole("button", { name: /^Accept & pay/ }).count()) log("a: Accept & pay offered ✓");
    else errors.push("A: no Accept & pay button on the deal page");
    console.log("E2E_DEAL", dealAddr);
    log("erase A", await erase(A), "erase B", await erase(B));
  },
  { timeoutMs: 15 * 60 * 1000 },
).catch((e) => errors.push("thrown: " + e.message));
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "e2e ok");
process.exit(errors.length ? 1 : 0);
