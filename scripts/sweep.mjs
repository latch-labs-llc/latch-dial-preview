// Cold-judge sweep: every public route, disconnected, at phone and desktop
// widths, light and dark. Fails on page errors, console errors, CSP
// violations, blank screens, horizontal overflow, and dead links (hash routes
// that don't exist, http links that don't answer). Runs against the production
// bundle via `vite preview` (default) or a live origin with SWEEP_BASE.
//
//   npm run build && node scripts/sweep.mjs
//   SWEEP_BASE=https://dial.latchlabs.org node scripts/sweep.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { chromiumPath, startPreview, waitForHttp, withCleanup } from "./smoke-lib.mjs";

const PORT = Number(process.env.SWEEP_PORT ?? 4181);
const BASE = process.env.SWEEP_BASE ?? `http://localhost:${PORT}`;
// A real devnet deal (any state); defaults to a Cancelled main-app deal so the
// terminal-state screens render too.
const DEAL = process.env.SWEEP_DEAL ?? "3zoJG4jhaQRL7uxaKohxuNzoQR6uosfaybetU9wHKLqR";
const ADDR = "4xzMch6CR5wdK5QffZzRN8TRXns3XhHt1vZWTNx8R7J4";
const out = "screenshots/sweep";
mkdirSync(out, { recursive: true });

const ROUTES = [
  ["welcome", "#/"],
  ["settings", "#/settings"],
  ["data", "#/data"],
  ["deal", `#/deal/${DEAL}`],
  ["agreement", `#/agreement/${DEAL}`],
  ["evidence", `#/evidence/${DEAL}`],
  ["user", "#/u/harrison"],
  ["pay-disconnected", `#/pay?to=${ADDR}&amount=5&for=Sweep`],
  ["request-disconnected", "#/request"],
  ["builder-disconnected", "#/new-agreement"],
  ["contacts-disconnected", "#/contacts"],
  ["messages-disconnected", "#/messages"],
  ["chat-disconnected", "#/chat/4QQQf1kVaCuwfDMZhzMsE4abSMXzYrEgGH7jgGbp6PaS"],
  ["deal-bad-address", "#/deal/not-an-address"],
  ["unknown-route", "#/this-route-does-not-exist"],
];
const KNOWN_ROUTES = ["", "requests", "deal", "agreement", "evidence", "pay", "request", "new-agreement", "contacts", "paycode", "u", "add-money", "settings", "data"];
// Known, accepted noise: Cloudflare's auto-injected analytics beacon is blocked
// by the CSP on the live host until the zone's Web Analytics is switched off.
// The preview runs on localhost, which the live service's CORS allowlist (the real app origin) refuses: not a finding.
const IGNORE = [/cloudflareinsights\.com/, /favicon/, /Failed to load resource/, /latch-dial-service[\s\S]*blocked by CORS policy/];

const server = BASE.startsWith("http://localhost") ? startPreview(PORT) : null;
let browser;
const findings = [];
const seenHttp = new Map();

async function checkHttp(url) {
  if (seenHttp.has(url)) return seenHttp.get(url);
  const p = (async () => {
    try {
      // Explorer links are checked by shape, not by fetching: explorer.solana.com
      // rate-limits scripted requests (429), which says nothing about the link.
      if (/^https:\/\/explorer\.solana\.com\/(address|tx)\/[1-9A-HJ-NP-Za-km-z]{32,88}\?cluster=devnet$/.test(url)) return null;
      const r = await fetch(url, { method: "GET", redirect: "follow", headers: { range: "bytes=0-0", "user-agent": "latch-dial-sweep" } });
      return r.status < 400 || r.status === 429 ? null : `HTTP ${r.status}`;
    } catch (e) {
      return `unreachable (${e.message})`;
    }
  })();
  seenHttp.set(url, p);
  return p;
}

await withCleanup(async () => { await browser?.close().catch(() => {}); server?.stop(); }, async () => {
  if (server) await waitForHttp(`${BASE}/`);
  browser = await chromium.launch({ executablePath: chromiumPath() });
  for (const [vw, vh, tag] of [[390, 844, "phone"], [1280, 800, "desktop"]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, colorScheme: scheme });
      const page = await ctx.newPage();
      const label = () => `${tag}/${scheme}/${current}`;
      let current = "";
      page.on("pageerror", (e) => findings.push(`${label()}: pageerror ${e.message}`));
      page.on("console", (m) => {
        const t = m.text();
        if (IGNORE.some((re) => re.test(t))) return;
        if (m.type() === "error") findings.push(`${label()}: console ${t.slice(0, 200)}`);
        if (/Content Security Policy/i.test(t)) findings.push(`${label()}: CSP ${t.slice(0, 200)}`);
      });
      await page.exposeFunction("__cspViolation", (v) => findings.push(`${label()}: CSP violation ${v}`));
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          if (/cloudflareinsights/.test(e.blockedURI)) return;
          window.__cspViolation(`${e.violatedDirective} blocked ${e.blockedURI}`);
        });
      });
      for (const [name, hash] of ROUTES) {
        current = name;
        await page.goto(`${BASE}/${hash}`, { waitUntil: "load" });
        await page.waitForTimeout(/deal|agreement|evidence|user/.test(name) ? 7000 : 1500);
        const text = (await page.locator("#root").innerText()).trim();
        if (text.length < 20) findings.push(`${label()}: blank page`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) findings.push(`${label()}: horizontal overflow ${overflow}px`);
        const links = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")));
        for (const href of new Set(links)) {
          if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) continue;
          if (href.startsWith("#")) {
            const seg = href.slice(1).split("?")[0].split("/").filter(Boolean)[0] ?? "";
            if (!KNOWN_ROUTES.includes(seg)) findings.push(`${label()}: dead hash link ${href}`);
          } else if (/^https?:/.test(href)) {
            const bad = await checkHttp(href);
            if (bad) findings.push(`${label()}: dead link ${href} → ${bad}`);
          }
        }
        if (scheme === "light") await page.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
});

if (findings.length) {
  console.error(`sweep: ${findings.length} finding(s)\n` + findings.map((f) => " - " + f).join("\n"));
  process.exit(1);
}
console.log(`sweep ok — ${ROUTES.length} routes × 2 widths × 2 schemes; screenshots in ${out}/`);
