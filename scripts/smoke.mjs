// Production smoke test: serves dist/ via `vite preview`, loads key screens in
// headless Chromium, fails on any page error, and saves screenshots.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { chromiumPath, startPreview, waitForHttp, withCleanup } from "./smoke-lib.mjs";

const PORT = Number(process.env.SMOKE_PORT ?? 4179);
const DEAL = process.env.SMOKE_DEAL; // optional: a real devnet deal address
const out = "screenshots";
mkdirSync(out, { recursive: true });
const server = startPreview(PORT);
let browser;
const errors = [];
const cleanup = async () => {
  try {
    await browser?.close();
  } catch {}
  server.stop();
};

await withCleanup(cleanup, async () => {
await waitForHttp(`http://localhost:${PORT}/`);
browser = await chromium.launch({ executablePath: chromiumPath() });

// The sandbox proxy rejects browser CORS preflights, so devnet RPC calls are
// relayed through Node for these screenshots. App code is unchanged.
async function relay(ctx) {
  await ctx.route("https://api.devnet.solana.com/**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, GET, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    try {
      const r = await fetch(req.url(), { method: req.method(), headers: { "content-type": "application/json" }, body: req.postData() });
      await route.fulfill({ status: r.status, headers: { ...cors, "content-type": "application/json" }, body: await r.text() });
    } catch {
      await route.abort();
    }
  });
}

/** Any Content-Security-Policy violation fails the smoke test (the build ships a strict CSP). */
async function cspWatch(page, label) {
  await page.exposeFunction("__cspViolation", (v) => errors.push(`${label} CSP violation: ${v}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolation(`${e.violatedDirective} blocked ${e.blockedURI}`));
  });
  page.on("console", (m) => /Content Security Policy/i.test(m.text()) && errors.push(`${label} CSP: ${m.text()}`));
}
const shots = [
  ["welcome", "#/"],
  ["settings", "#/settings"],
  ...(DEAL ? [["deal", `#/deal/${DEAL}`], ["evidence", `#/evidence/${DEAL}`]] : []),
];
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  await relay(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${scheme}: ${e.message}`));
  await cspWatch(page, scheme);
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/.test(m.text()) && errors.push(`${scheme} console: ${m.text()}`));
  for (const [name, hash] of shots) {
    await page.goto(`http://localhost:${PORT}/${hash}`);
    await page.waitForTimeout(name === "welcome" || name === "settings" ? 1200 : 6000);
    const text = await page.locator("#root").innerText();
    if (text.trim().length < 20) errors.push(`${scheme}/${name}: blank page`);
    await page.screenshot({ path: `${out}/${name}-${scheme}.png`, fullPage: true });
  }
  await ctx.close();
}
// Connected screens: a TEST-ONLY, read-only mock of an allowlisted wallet
// provider (cannot sign anything) so the UI renders real devnet reads.
const AS = process.env.SMOKE_AS;
if (AS) {
  const mock = `(() => {
    const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const s=${JSON.stringify(AS)}; let n=0n; for (const c of s) n=n*58n+BigInt(A.indexOf(c));
    const b=new Uint8Array(32); for (let i=31;i>=0;i--){ b[i]=Number(n&255n); n>>=8n; }
    const pk={ toBytes:()=>b, toString:()=>s, toBase58:()=>s };
    const h={};
    window.isPhantomInstalled=true;
    window.phantom={ solana:{ isPhantom:true, publicKey:null, isConnected:false,
      connect: async()=>{ window.phantom.solana.publicKey=pk; window.phantom.solana.isConnected=true; (h.connect||[]).forEach(f=>f(pk)); return { publicKey: pk }; },
      disconnect: async()=>{}, on:(e,f)=>{(h[e]=h[e]||[]).push(f)}, off:()=>{}, removeListener:()=>{}, removeAllListeners:()=>{},
      signTransaction: async()=>{ throw new Error('read-only smoke wallet'); }, signAllTransactions: async()=>{ throw new Error('read-only'); },
      signMessage: async()=>{ throw new Error('read-only'); } } };
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
  })();`;
  const connected = [
    ["activity", "#/"],
    ["pay", `#/pay?to=${process.env.SMOKE_TO ?? AS}&amount=120&for=Used%20road%20bike`],
    ["request", "#/request"],
    ["agreement-builder", "#/new-agreement"],
    ["contacts", "#/contacts"],
    ["messages", "#/messages"],
    ["paycode", "#/paycode"],
    ...(DEAL ? [["deal-as-party", `#/deal/${DEAL}`]] : []),
  ];
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
    await ctx.addInitScript(mock);
    await relay(ctx);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${scheme} connected: ${e.message}`));
    await cspWatch(page, `${scheme} connected`);
    for (const [name, hash] of connected) {
      await page.goto(`http://localhost:${PORT}/${hash}`);
      await page.waitForTimeout(7000);
      const text = await page.locator("#root").innerText();
      if (text.trim().length < 20) errors.push(`${scheme}/${name}: blank page`);
      await page.screenshot({ path: `${out}/${name}-${scheme}.png`, fullPage: true });
    }
    await ctx.close();
  }
}
}).catch((e) => {
  errors.push(`smoke aborted: ${e?.message ?? e}`);
});
if (errors.length) {
  console.error("SMOKE FAILED\n" + errors.join("\n"));
  process.exit(1);
}
console.log(`smoke ok — screenshots in ${out}/`);
process.exit(0);
