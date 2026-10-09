/** Shared by the app config and the build (CSP), so both apply the same rule. */
/**
 * HTTPS only (B9). Plain http://localhost / 127.0.0.1 is accepted ONLY when
 * `allowLocalHttp` is true — the dev server — never in a production build
 * (v0.5 #12). Anything else disables the service.
 */
export function normalizeServiceUrl(raw: string | undefined, allowLocalHttp = false): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(allowLocalHttp && u.protocol === "http:" && local)) return undefined;
    if (u.username || u.password || u.search || u.hash) return undefined;
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
