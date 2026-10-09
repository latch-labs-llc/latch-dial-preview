/**
 * v0.10 #3: who to pay, contact-first. Pure so the ordering is testable:
 * contacts (by name, then address), then people you've paid or dealt with
 * before who aren't contacts yet (most recent first), then a pasted address.
 * Names sit alongside addresses, never instead of them (R3 B1).
 */
import { PublicKey } from "@solana/web3.js";
import type { Deal } from "./deal";
import { parseAddress } from "./evidence";
import type { LocalData } from "./store";

export interface Suggestion {
  address: string;
  /** Contact name when it is a contact; otherwise undefined (the UI shows the address). */
  name?: string;
  /** Why it's suggested: "contact" | "paid" | "deal" | "typed". */
  why: "contact" | "paid" | "deal" | "typed";
  /** Unix seconds of the latest interaction, for ordering recents. */
  at: number;
}

export interface Suggestions {
  contacts: Suggestion[];
  recent: Suggestion[];
  /** The query itself when it is a valid address that isn't already listed. */
  typed: Suggestion | null;
}

export function suggestRecipients(local: LocalData, deals: Deal[], me: PublicKey | null, query: string): Suggestions {
  const q = query.trim().toLowerCase();
  const matches = (s: string | undefined) => !q || (s ?? "").toLowerCase().includes(q);
  const contacts: Suggestion[] = Object.values(local.contacts)
    .filter((c) => c.address !== me?.toBase58() && (matches(c.name) || matches(c.address)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ address: c.address, name: c.name, why: "contact", at: c.createdAt }));
  const known = new Set(contacts.map((c) => c.address));
  const seen = new Map<string, Suggestion>();
  const bump = (address: string, why: "paid" | "deal", at: number) => {
    if (!address || address === me?.toBase58() || known.has(address) || local.blocked.includes(address)) return;
    const prev = seen.get(address);
    if (!prev || prev.at < at) seen.set(address, { address, why, at });
  };
  for (const p of local.payments) bump(p.address, "paid", p.at);
  for (const d of deals) {
    if (!me) continue;
    const mine = d.parties.some((p) => p.equals(me));
    if (!mine) continue;
    for (const p of d.parties) if (!p.equals(me)) bump(p.toBase58(), "deal", d.activatedAt || d.signedAt || d.createdAt);
  }
  const recent = [...seen.values()].filter((s) => matches(s.address)).sort((a, b) => b.at - a.at).slice(0, 12);
  const typedKey = parseAddress(query);
  const typedAddr = typedKey?.toBase58() ?? null;
  const typed: Suggestion | null =
    typedAddr && typedAddr !== me?.toBase58() && !known.has(typedAddr) && !seen.has(typedAddr) ? { address: typedAddr, why: "typed", at: 0 } : null;
  return { contacts, recent, typed };
}
