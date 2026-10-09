/**
 * What a scanned (or pasted) code means (v0.16): one of the app's own links,
 * a `solana:` payment URI, or a bare wallet address. Pure; the camera lives
 * in ScanSheet.
 */
import { parseAddress } from "./evidence";

export type Scanned =
  | { kind: "pay"; query: URLSearchParams; address: string | null }
  | { kind: "user"; name: string }
  | { kind: "deal"; address: string; k: string | null }
  | { kind: "request"; req: string }
  | { kind: "address"; address: string };

const b58 = (s: string) => parseAddress(s.trim())?.toBase58() ?? null;

export function parseScan(raw: string): Scanned | null {
  const text = raw.trim();
  if (!text) return null;
  // A bare address.
  const bare = b58(text);
  if (bare) return { kind: "address", address: bare };
  // solana:<address>[?amount=…&label=…] (Solana Pay transfer request)
  const sp = /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})(\?.*)?$/.exec(text);
  if (sp) {
    const address = b58(sp[1]);
    if (!address) return null;
    const q = new URLSearchParams(sp[2]?.slice(1) ?? "");
    const query = new URLSearchParams({ to: address, src: "scan" });
    if (q.get("amount")) query.set("amount", q.get("amount")!);
    if (q.get("label") || q.get("message")) query.set("for", q.get("message") ?? q.get("label")!);
    return { kind: "pay", query, address };
  }
  // One of our own links: full URL or just the hash route.
  const hashAt = text.indexOf("#/");
  const route = hashAt >= 0 ? text.slice(hashAt + 1) : text.startsWith("/") ? text : null;
  if (!route) return null;
  const [pathPart, queryPart = ""] = route.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart);
  switch (parts[0]) {
    case "pay": {
      if (query.get("req")) return { kind: "request", req: query.get("req")! };
      const to = query.get("to") ? b58(query.get("to")!) : null;
      if (query.get("to") && !to) return null;
      return { kind: "pay", query, address: to };
    }
    case "u":
      return parts[1] ? { kind: "user", name: decodeURIComponent(parts[1]) } : null;
    case "deal": {
      const address = parts[1] ? b58(parts[1]) : null;
      return address ? { kind: "deal", address, k: query.get("k") } : null;
    }
    default:
      return null;
  }
}

/** Where a scan takes the user (hash route), or null when it carries no destination. */
export function routeFor(s: Scanned): string {
  switch (s.kind) {
    case "pay":
      return `/pay?${s.query.toString()}`;
    case "request":
      return `/pay?req=${encodeURIComponent(s.req)}`;
    case "user":
      return `/u/${encodeURIComponent(s.name)}`;
    case "deal":
      return `/deal/${s.address}${s.k ? `?k=${s.k}` : ""}`;
    case "address":
      return `/pay?to=${s.address}&src=scan`;
  }
}
