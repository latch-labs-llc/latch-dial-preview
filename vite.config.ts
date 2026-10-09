import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildCsp, buildHeadersFile } from "./build/csp";
import { normalizeServiceUrl } from "./src/lib/serviceUrl";

/**
 * Production builds only (the dev server needs inline HMR scripts):
 *  - dist/_headers with the full CSP + frame-ancestors 'none' (the real policy;
 *    Cloudflare Pages / Netlify read it — see HOSTING.md for other hosts);
 *  - the same CSP minus frame-ancestors as a <meta> fallback.
 */
function csp(env: Record<string, string>): Plugin {
  const inputs = {
    rpcUrls: [env.VITE_RPC_URL || "https://api.devnet.solana.com", ...(env.VITE_RPC_URL_2 ? [env.VITE_RPC_URL_2] : [])],
    wsUrl: env.VITE_WS_URL || undefined,
    serviceUrl: normalizeServiceUrl(env.VITE_SERVICE_URL),
    widgetUrl: normalizeServiceUrl(env.VITE_TELEGRAM_WIDGET_URL),
  };
  return {
    name: "latch-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${buildCsp(inputs)}" />`);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: buildHeadersFile(inputs) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    base: "./",
    plugins: [react(), csp(env)],
    define: { "process.env": {} },
    build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 2500 },
    optimizeDeps: { esbuildOptions: { target: "es2022" } },
  };
});