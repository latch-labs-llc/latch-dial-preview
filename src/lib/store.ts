/**
 * Device-local data (IndexedDB via idb-keyval, with an in-memory fallback
 * when storage is blocked). Nothing here is sent anywhere; the protocol never
 * needs it. Exportable/importable from Settings → Data & privacy.
 */
import { createStore, get, set } from "idb-keyval";
import { useEffect, useState } from "react";
import type { Mode } from "./deal";

export interface Contact {
  address: string;
  name: string;
  note?: string;
  /** How this contact was verified, in the user's own words ("met in person", "QR scan"). */
  verifiedHow?: string;
  /** Explicit, revocable per-contact default (R1 §6). */
  defaultInstant?: boolean;
  createdAt: number;
}

export interface PaymentRecord {
  address: string;
  mode: Mode;
  /** unix seconds */
  at: number;
  amount: string;
  asset: string;
  sig?: string;
  deal?: string;
  memo?: string;
}

export interface PendingRequest {
  /** link blob (base64url) — the payer's deal must regenerate to it */
  blob: string;
  amount: string; // raw units, decimal string
  asset: string;
  createdAt: number;
  matchedDeal?: string;
  /** Several Drafts claim this request — none is labelled "your request". */
  conflict?: string[];
}

export type Theme = "system" | "light" | "dark";

export interface Settings {
  theme: Theme;
  requestsFrom: "anyone" | "contacts";
  largePaymentUsd: number;
  seenHowItWorks: boolean;
  haptics: boolean;
}

import type { Pin } from "./namePins";
import type { MsgBody } from "./msgCrypto";
import type { TermsDraft } from "./termsDraft";

/** A custom agreement saved on this device to start the next one from (v0.16). */
export interface Preset {
  name: string;
  at: number;
  draft: TermsDraft;
}

/** One decrypted message kept on this device (the sealed record stays too, as evidence of who sent what). */
export interface StoredMsg {
  id: string;
  from: string;
  to: string;
  seq: number;
  at: number;
  body: MsgBody;
  /** The service's record: ciphertext, the sender's device-signer signature and its issued time. */
  ct: string;
  issued: number;
  sig: string;
}

export interface Thread {
  peer: string;
  lastAt: number;
  /** My next send's sequence number in this thread. */
  mySeq: number;
  unread: number;
  messages: StoredMsg[];
}

export interface PeerKeys {
  enc: string;
  signer: string;
  issued: number;
}

export interface LocalData {
  contacts: Record<string, Contact>;
  payments: PaymentRecord[];
  hidden: string[];
  blocked: string[];
  /** deal address → link blob (base64url) so the agreement stays regenerable on this device */
  links: Record<string, string>;
  /** deal address → attachment text the user saved (Arch B) */
  attachments: Record<string, string>;
  /** Protected requests I sent (payer creates the deal). nonce → request. */
  requests: Record<string, PendingRequest>;
  /** deal address → unix time the user downloaded their copy of the agreement */
  saved: Record<string, number>;
  /** Encrypted backups turned on for this wallet (key is derived per session, never stored). */
  backupsFor: string[];
  /** deal addresses already uploaded to the service backup */
  backedUp: string[];
  /** My own Telegram link per wallet (the service only reveals it publicly if findable). */
  myTelegram: Record<string, { username: string; verifiedAt: number; expiresAt: number; findable: boolean }>;
  /** name key ("@sam" / "tg:sam") → wallet first used with it (B3 pin-on-first-use). */
  pins: Record<string, Pin>;
  /** Backup key-check value per wallet (detects a wallet that doesn't sign deterministically). */
  backupKcv: Record<string, string>;
  /** Backup writer public key per wallet, once derived on this device (one signature afterwards). */
  backupWriter: Record<string, string>;
  /** Wallets whose messaging keys this device published (keys are derived per session, never stored). */
  msgEnabled: string[];
  /** Messaging signer public key per wallet, once derived on this device (one signature afterwards). */
  msgSigner: Record<string, string>;
  msgKcv: Record<string, string>;
  /** Other wallets' messaging keys, pinned on first use; a change is shown, never silently accepted. */
  peerKeys: Record<string, PeerKeys>;
  /** thread id → the conversation as decrypted on this device. */
  threads: Record<string, Thread>;
  /** Per wallet: service time of the last poll. */
  msgSince: Record<string, number>;
  /** Saved Builder presets, by id. */
  presets: Record<string, Preset>;
  settings: Settings;
}

const DEFAULTS: LocalData = {
  contacts: {},
  payments: [],
  hidden: [],
  blocked: [],
  links: {},
  attachments: {},
  requests: {},
  saved: {},
  backupsFor: [],
  backedUp: [],
  myTelegram: {},
  pins: {},
  backupKcv: {},
  backupWriter: {},
  msgEnabled: [],
  msgSigner: {},
  msgKcv: {},
  peerKeys: {},
  threads: {},
  msgSince: {},
  presets: {},
  settings: {
    theme: "system",
    requestsFrom: "anyone",
    largePaymentUsd: 500,
    seenHowItWorks: false,
    haptics: true,
  },
};

let idb: ReturnType<typeof createStore> | null = null;
try {
  if (typeof indexedDB !== "undefined") idb = createStore("latch-dial", "kv");
} catch {
  idb = null;
}

let state: LocalData = structuredClone(DEFAULTS);
let loaded = false;
const listeners = new Set<() => void>();

export async function loadLocal(): Promise<void> {
  if (loaded) return;
  try {
    const v = idb ? await get<LocalData>("data", idb) : undefined;
    if (v) state = { ...DEFAULTS, ...v, settings: { ...DEFAULTS.settings, ...v.settings } };
  } catch {
    /* storage blocked: stay in memory */
  }
  loaded = true;
  listeners.forEach((l) => l());
}

export function getLocal(): LocalData {
  return state;
}

export function updateLocal(fn: (d: LocalData) => void): void {
  const next = structuredClone(state);
  fn(next);
  state = next;
  listeners.forEach((l) => l());
  if (idb) set("data", state, idb).catch(() => {});
}

export function useLocal<T>(select: (d: LocalData) => T): T {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return select(state);
}

export function exportLocal(): string {
  const { contacts, blocked, settings, presets } = state;
  return JSON.stringify({ format: "latch-dial/contacts@1", contacts, blocked, settings, presets }, null, 2);
}

export function importLocal(json: string): number {
  const v = JSON.parse(json);
  if (v.format !== "latch-dial/contacts@1") throw new Error("Not a Latch contacts export");
  let n = 0;
  updateLocal((d) => {
    for (const [k, c] of Object.entries<Contact>(v.contacts ?? {})) {
      if (!d.contacts[k]) n++;
      d.contacts[k] = c;
    }
    d.blocked = Array.from(new Set([...d.blocked, ...(v.blocked ?? [])]));
    for (const [k, p] of Object.entries<Preset>(v.presets ?? {})) if (p?.draft && !d.presets[k]) d.presets[k] = p;
  });
  return n;
}

export function clearLocal(): void {
  updateLocal((d) => Object.assign(d, structuredClone(DEFAULTS)));
}

// ------------------------------------------------------------- evidence

export function paymentsTo(address: string): PaymentRecord[] {
  return state.payments.filter((p) => p.address === address);
}

export function recordPayment(p: PaymentRecord): void {
  updateLocal((d) => {
    d.payments.unshift(p);
    d.payments = d.payments.slice(0, 500);
  });
}

export function knownAddresses(): string[] {
  return Array.from(new Set([...Object.keys(state.contacts), ...state.payments.map((p) => p.address)]));
}
