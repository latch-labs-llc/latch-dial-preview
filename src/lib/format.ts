import type { Asset } from "./config";
import { uiAmount } from "./template";

/** Dollars-first: "$120.00" for USDC; "1.5 SOL" for SOL. */
export function money(raw: bigint, asset: Asset | null, decimalsFallback = 6, unknownLabel = "tokens"): string {
  if (!asset) return `${uiAmount(raw, decimalsFallback)} ${unknownLabel}`;
  if (asset.dollar) {
    const s = uiAmount(raw, asset.decimals);
    const [w, f = ""] = s.split(".");
    return `$${Number(w).toLocaleString("en-US")}.${(f + "00").slice(0, 2)}`;
  }
  return `${uiAmount(raw, asset.decimals)} SOL`;
}

export function parseAmount(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/[$,\s]/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) return null;
  const raw = BigInt((w || "0") + (f + "0".repeat(decimals)).slice(0, decimals));
  return raw > 0n ? raw : null;
}

/** Full address in 4-char chunks so the middle can be compared (R3 §3.3). */
export function chunked(addr: string): string {
  return addr.match(/.{1,4}/g)!.join(" ");
}
export function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function absTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relTime(unix: number, now = Date.now() / 1000): string {
  const d = Math.round(now - unix);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)}d`;
  return new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function duration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  return `${m} m`;
}
