/**
 * Content-Security-Policy for the built app (v0.4 B8). Computed from the
 * build-time endpoints so the only scripts are the app's own bundle, the only
 * network peers are the RPC endpoints and the optional service, and the only
 * frames are the service's sandboxed Telegram page and Solflare's connector.
 * Imported by vite.config.ts (injected as a <meta>) and by the tests.
 */
export interface CspInputs {
  rpcUrls: string[];
  /** Explicit WebSocket endpoint (VITE_WS_URL) when it isn't one of the RPC hosts. */
  wsUrl?: string;
  serviceUrl?: string;
  /** Separate origin serving the sandboxed Telegram widget (framed). */
  widgetUrl?: string;
  /** As an HTTP header: adds frame-ancestors 'none' (ignored by browsers in a <meta>). */
  header?: boolean;
}

function origin(u: string): string {
  return new URL(u).origin;
}
function wsOrigin(u: string): string {
  const x = new URL(u);
  return `${x.protocol === "https:" ? "wss" : "ws"}://${x.host}`;
}

export function buildCsp({ rpcUrls, wsUrl, serviceUrl, widgetUrl, header }: CspInputs): string {
  const connect = new Set<string>(["'self'"]);
  for (const u of rpcUrls) {
    connect.add(origin(u));
    connect.add(wsOrigin(u));
  }
  if (wsUrl) connect.add(origin(wsUrl)); // WHATWG URL gives "wss://host" for ws(s) schemes
  if (serviceUrl) {
    connect.add(origin(serviceUrl));
    connect.add(wsOrigin(serviceUrl)); // live message nudges (v0.17)
  }
  connect.add("ws://localhost:*"); // Mobile Wallet Adapter (Android) talks to the wallet over a local socket
  // connect.solflare.com: with no Solflare extension installed, @solana/wallet-adapter-solflare
  // loads @solflare-wallet/sdk, which embeds https://connect.solflare.com/ in an iframe
  // (IFRAME_URL in the sdk's src/index.ts). Remove it if Solflare is dropped from the allowlist.
  // The API origin is never framed; only the separate widget origin is (v0.5 #7).
  const frames = ["https://connect.solflare.com", ...(widgetUrl ? [origin(widgetUrl)] : [])];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
    `frame-src ${frames.join(" ")}`,
    "manifest-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(header ? ["frame-ancestors 'none'"] : []),
  ].join("; ");
}

/**
 * Cloudflare Pages / Netlify `_headers` file: the full CSP including
 * frame-ancestors (clickjacking), plus the usual hardening headers.
 */
export function buildHeadersFile(i: CspInputs): string {
  return [
    "/*",
    `  Content-Security-Policy: ${buildCsp({ ...i, header: true })}`,
    "  X-Frame-Options: DENY",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  Permissions-Policy: camera=(self), microphone=(), geolocation=()",
    "",
  ].join("\n");
}
