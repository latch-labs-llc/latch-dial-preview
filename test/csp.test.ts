/** v0.4 B8: sandboxed Telegram widget and a strict CSP for the app. */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCsp, buildHeadersFile } from "../build/csp";
import { acceptWidgetMessage, widgetUrl } from "../src/lib/telegramWidget";
import { handle } from "../worker/src/index";
import { NOW, env } from "./svc";

describe("app CSP", () => {
  const p = buildCsp({ rpcUrls: ["https://api.devnet.solana.com", "https://rpc.example/path?k=1"], serviceUrl: "https://svc.example/" });
  const dir = (name: string) => p.split("; ").find((d) => d.startsWith(name + " "))!.slice(name.length + 1).split(" ");
  it("scripts only from the app itself; no inline, no eval", () => {
    expect(dir("script-src")).toEqual(["'self'"]);
    expect(p).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  });
  it("network peers: self, the RPCs (https + wss), the service (https + wss), and the MWA local socket only", () => {
    expect(dir("connect-src").sort()).toEqual(
      ["'self'", "https://api.devnet.solana.com", "wss://api.devnet.solana.com", "https://rpc.example", "wss://rpc.example", "https://svc.example", "wss://svc.example", "ws://localhost:*"].sort(),
    );
  });
  it("frames: Solflare's connector only when no widget origin is set; no objects, base or forms", () => {
    expect(dir("frame-src")).toEqual(["https://connect.solflare.com"]);
    for (const d of ["object-src 'none'", "base-uri 'none'", "form-action 'none'", "default-src 'self'"]) expect(p).toContain(d);
  });
  it("no service → no service origin anywhere", () => {
    expect(buildCsp({ rpcUrls: ["https://api.devnet.solana.com"] })).not.toContain("svc.example");
  });
  it("an explicit WebSocket endpoint (VITE_WS_URL) is allowed as its own origin, nothing more", () => {
    const q = buildCsp({ rpcUrls: ["https://rpc.example/path?k=1"], wsUrl: "wss://api.devnet.solana.com/" });
    const c = q.split("; ").find((d) => d.startsWith("connect-src "))!.slice("connect-src ".length).split(" ");
    expect(c).toContain("wss://api.devnet.solana.com");
    expect(c).not.toContain("https://api.devnet.solana.com");
    expect(buildCsp({ rpcUrls: ["https://rpc.example"] })).not.toContain("api.devnet");
  });
  it("the app no longer injects Telegram's script into its own origin", () => {
    const dir2 = new URL("../src", import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    for (const f of walk(dir2)) expect(readFileSync(f, "utf8"), f).not.toContain("telegram.org/js/telegram-widget");
  });
});

describe("v0.5 #4: headers, not just a <meta>", () => {
  const inputs = { rpcUrls: ["https://api.devnet.solana.com"], serviceUrl: "https://svc.example" };
  it("the header policy forbids framing; the meta fallback omits it (browsers ignore it there)", () => {
    expect(buildCsp({ ...inputs, header: true })).toContain("frame-ancestors 'none'");
    expect(buildCsp(inputs)).not.toContain("frame-ancestors");
  });
  it("_headers applies the full policy and anti-framing headers to every path", () => {
    const f = buildHeadersFile(inputs);
    const lines = f.split("\n");
    expect(lines[0]).toBe("/*");
    expect(lines).toContain(`  Content-Security-Policy: ${buildCsp({ ...inputs, header: true })}`);
    expect(lines).toContain("  X-Frame-Options: DENY");
    expect(lines).toContain("  X-Content-Type-Options: nosniff");
  });
  it("Solflare's frame source is justified in the code, and HOSTING.md tells other hosts what to do", () => {
    const src = readFileSync(new URL("../build/csp.ts", import.meta.url), "utf8");
    expect(src).toMatch(/connect\.solflare\.com: with no Solflare extension installed/);
    const sdk = readFileSync(new URL("../node_modules/@solflare-wallet/sdk/src/index.ts", import.meta.url), "utf8");
    expect(sdk).toContain("https://connect.solflare.com/"); // the reason still holds in the installed SDK
    const hosting = readFileSync(new URL("../HOSTING.md", import.meta.url), "utf8");
    expect(hosting).toContain("frame-ancestors 'none'");
  });
});

describe("v0.5 #7: widget on its own origin, no 'unsafe-eval'", () => {
  const W = "https://tg-widget.example";
  const e = () => env({ TELEGRAM_BOT_USERNAME: "latch_test_bot", ALLOWED_ORIGINS: "https://app.example", TELEGRAM_WIDGET_ORIGIN: W });
  const get = (u: string, en = e()) => handle(new Request(u), en, NOW);
  it("served only on the widget origin; the API origin has no widget pages, the widget origin has no API", async () => {
    expect((await get(`${W}/?origin=${encodeURIComponent("https://app.example")}`)).status).toBe(200);
    expect((await get(`https://svc.test/telegram-widget?origin=${encodeURIComponent("https://app.example")}`)).status).toBe(404);
    expect((await get(`${W}/health`)).status).toBe(404);
    expect((await get(`${W}/owners/x?origin=https%3A%2F%2Fapp.example`)).status).toBe(404);
  });
  it("widget page: data-auth-url (not data-onauth), CSP without 'unsafe-eval', framed only by the app", async () => {
    const r = await get(`${W}/?origin=${encodeURIComponent("https://app.example")}`);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline'; ".slice(0, 0) + "script-src 'unsafe-inline");
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{32}' https:\/\/telegram\.org/);
    expect(csp).toContain("frame-ancestors https://app.example");
    const html = await r.text();
    expect(html).not.toContain("data-onauth");
    expect(html).toContain(`data-auth-url="${W}/done?origin=https%3A%2F%2Fapp.example"`);
    expect(html).toContain('data-telegram-login="latch_test_bot"');
  });
  it("done page: posts the login (numbers parsed) to exactly the app origin, strips it from the URL, no eval", async () => {
    const r = await get(`${W}/done?origin=${encodeURIComponent("https://app.example")}&id=42&username=abcde&auth_date=${NOW}&hash=${"a".repeat(64)}`);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^default-src 'none'; script-src 'nonce-[0-9a-f]{32}'; frame-ancestors https:\/\/app\.example/);
    const html = await r.text();
    const script = /<script nonce="[0-9a-f]+">([\s\S]*?)<\/script>/.exec(html)![1];
    // Run it in a tiny fake window and capture what it posts.
    const posted: any[] = [];
    const fakeLocation = { search: `?origin=x&id=42&username=abcde&auth_date=${NOW}&hash=${"a".repeat(64)}`, pathname: "/done" };
    let replaced = "";
    new Function("location", "history", "parent", "URLSearchParams", script)(
      fakeLocation,
      { replaceState: (_a: unknown, _b: unknown, u: string) => (replaced = u) },
      { postMessage: (m: unknown, o: string) => posted.push([m, o]) },
      URLSearchParams,
    );
    expect(posted).toEqual([[{ type: "latch-telegram-auth", user: { id: 42, username: "abcde", auth_date: NOW, hash: "a".repeat(64) } }, "https://app.example"]]);
    expect(replaced).toBe("/done");
  });
  it("either page refuses origins that aren't allowed", async () => {
    for (const bad of ["https://evil.example", "*", "https://app.example/path"]) {
      expect((await get(`${W}/?origin=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
      expect((await get(`${W}/done?origin=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
  });
  it("app CSP frames the widget origin, never the API origin", () => {
    const p = buildCsp({ rpcUrls: ["https://api.devnet.solana.com"], serviceUrl: "https://svc.example", widgetUrl: W });
    const frames = p.split("; ").find((d) => d.startsWith("frame-src "))!;
    expect(frames).toBe(`frame-src https://connect.solflare.com ${W}`);
  });
  it("evidence is recorded: why data-onauth would need eval", () => {
    const src = readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/telegram-widget\.js\?22 turns data-onauth into code with eval\(\)/);
  });
});

describe("app accepts widget messages only from the widget origin", () => {
  const user = { id: 1, username: "abcde", auth_date: NOW, hash: "a".repeat(64) };
  it("right origin + shape → login; anything else → ignored", () => {
    expect(acceptWidgetMessage({ origin: "https://svc.example", data: { type: "latch-telegram-auth", user } }, "https://svc.example/")).toEqual(user);
    expect(acceptWidgetMessage({ origin: "https://evil.example", data: { type: "latch-telegram-auth", user } }, "https://svc.example")).toBeNull();
    expect(acceptWidgetMessage({ origin: "https://svc.example", data: { type: "other", user } }, "https://svc.example")).toBeNull();
    expect(acceptWidgetMessage({ origin: "https://svc.example", data: { type: "latch-telegram-auth", user: { ...user, extra: 1 } } }, "https://svc.example")).toBeNull();
    expect(acceptWidgetMessage({ origin: "https://svc.example", data: null }, "https://svc.example")).toBeNull();
  });
  it("widget URL carries the app origin", () => {
    expect(widgetUrl("https://tg-widget.example", "https://app.example")).toBe("https://tg-widget.example/?origin=https%3A%2F%2Fapp.example");
  });
});
