/**
 * Name pinning (v0.4 B3): the first time this device pays or saves someone by
 * name, it remembers name → wallet (and, for signed handles, the claim's
 * issued time). If the name later resolves to a different wallet — or the
 * service serves an OLDER claim than the one pinned — the app warns loudly
 * and makes the user confirm before paying.
 */
export interface Pin {
  owner: string;
  /** For @handles: the issued time of the signed claim we saw. */
  issued?: number;
  at: number;
}

export type PinStatus = "new" | "same" | "changed" | "stale";

/** "@sam" for a Latch handle, "tg:sam" for a Telegram username — never the same key. */
export function nameKey(via: "handle" | "telegram", name: string): string {
  return via === "handle" ? `@${name.toLowerCase()}` : `tg:${name.toLowerCase()}`;
}

export function checkPin(pins: Record<string, Pin>, key: string, owner: string, issued?: number): PinStatus {
  const p = pins[key];
  if (!p) return "new";
  if (p.owner !== owner) return "changed";
  if (issued !== undefined && p.issued !== undefined && issued < p.issued) return "stale";
  return "same";
}

export function pinName(pins: Record<string, Pin>, key: string, owner: string, issued: number | undefined, now: number): void {
  const p = pins[key];
  pins[key] = { owner, issued: Math.max(issued ?? 0, p?.owner === owner ? p.issued ?? 0 : 0) || undefined, at: now };
}

/** Parse what the user typed: "@sam" is a Latch handle, "tg:@sam" / "tg:sam" a Telegram username. */
export function parseNameInput(input: string): { via: "handle" | "telegram"; name: string } | null {
  const s = input.trim();
  if (/^tg:/i.test(s)) {
    const name = s.slice(3).replace(/^@/, "").toLowerCase();
    return name ? { via: "telegram", name } : null;
  }
  if (s.startsWith("@")) {
    const name = s.slice(1).toLowerCase();
    return name ? { via: "handle", name } : null;
  }
  return null;
}

export function pinWarning(status: PinStatus, display: string, oldOwner: string | undefined, newOwner: string): string | null {
  if (status === "changed")
    return `⚠ ${display} now points to a DIFFERENT wallet than when you last used it (was ${oldOwner?.slice(0, 4)}…${oldOwner?.slice(-4)}, now ${newOwner.slice(0, 4)}…${newOwner.slice(-4)}). Only continue if they told you, outside this app, that they changed wallets.`;
  if (status === "stale") return `⚠ The service returned an older claim for ${display} than this device has seen before. Don't pay by this name until it's sorted out.`;
  return null;
}
