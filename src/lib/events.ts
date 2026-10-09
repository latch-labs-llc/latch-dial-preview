/**
 * Latch events (Anchor `emit_cpi!`): they ride in the program's self-CPI
 * inner-instruction data, not in logs. Decoded here for the evidence packet
 * and for "who closed this deal" on the deal page (v0.7 #3).
 */
import { PublicKey, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { decodeEventsFromTransaction } from "@latch-labs/sdk";
import { latchProgram } from "./flows";

const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export interface LatchEvent {
  name: string;
  /** Every field as a plain string: base58 keys, decimal integers, enum names. */
  data: Record<string, string>;
}

function plain(v: any): string {
  if (v instanceof PublicKey) return v.toBase58();
  if (v && typeof v === "object" && typeof v.toString === "function" && "words" in v) return v.toString(); // BN
  if (v && typeof v === "object" && Object.keys(v).length === 1 && typeof Object.values(v)[0] === "object") {
    const k = Object.keys(v)[0];
    return k.charAt(0).toUpperCase() + k.slice(1); // Anchor enum
  }
  return String(v);
}

function normalize(e: { name: string; data: any }): LatchEvent {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.data ?? {})) data[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = plain(v);
  return { name: e.name.charAt(0).toUpperCase() + e.name.slice(1), data };
}

/** One self-CPI instruction's data → its event, or null if it isn't one. */
export function decodeEventIx(data: Uint8Array): LatchEvent | null {
  if (data.length < 16 || !EVENT_IX_TAG.every((b, i) => data[i] === b)) return null;
  const e = latchProgram().coder.events.decode(Buffer.from(data.subarray(8)).toString("base64"));
  return e ? normalize(e as any) : null;
}

/** All Latch events in a fetched transaction (only inner instructions of the Latch program). */
export function eventsFromTx(tx: VersionedTransactionResponse): LatchEvent[] {
  return decodeEventsFromTransaction(latchProgram() as any, tx).map((e) => normalize(e as any));
}

/** Events of the most recent successful transaction on a deal (what closed it, for a Completed/Cancelled deal). */
export async function lastEvents(conn: Connection, deal: PublicKey): Promise<LatchEvent[]> {
  const sigs = await conn.getSignaturesForAddress(deal, { limit: 5 }, "confirmed");
  const last = sigs.find((s) => !s.err);
  if (!last) return [];
  const tx = await conn.getTransaction(last.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  return tx ? eventsFromTx(tx) : [];
}
