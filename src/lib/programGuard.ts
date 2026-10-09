/**
 * Signing guard (v0.4 A1, v0.5 #2). The agreement text says the app verified
 * the deployed program's code as the pinned hash, so before anything that
 * signs, funds or activates a deal (create, accept, pay-in, confirm ready /
 * mark shipped) the app reads the program-data account AGAIN and compares
 * its hash with the pinned one. No caching: two getAccountInfo calls per
 * signature. Mismatch or failure to check → refuse.
 */
import type { Connection } from "@solana/web3.js";
import { observedProgramHash } from "./chain";
import { VERIFIED_BUILD_HASH } from "./config";

export const PROGRAM_CHANGED = "The Latch program changed since this app was checked — update the app before signing.";
/** The check itself failed (RPC/fetch): still blocks, but says so honestly (v0.6 ruling). */
export const PROGRAM_UNCHECKED = "Couldn't check the Latch program right now — try again in a moment.";

export type GuardResult =
  | { ok: true; expected: string; observed: string }
  | { ok: false; expected: string; observed: string | null; reason: "mismatch" | "unavailable" };

export function makeProgramGuard(observe: () => Promise<string>, expected: string = VERIFIED_BUILD_HASH) {
  async function check(): Promise<GuardResult> {
    let observed: string;
    try {
      observed = await observe();
    } catch {
      return { ok: false, expected, observed: null, reason: "unavailable" };
    }
    return observed === expected ? { ok: true, expected, observed } : { ok: false, expected, observed, reason: "mismatch" };
  }
  async function assert(): Promise<void> {
    const r = await check();
    if (!r.ok) throw new Error(r.reason === "mismatch" ? PROGRAM_CHANGED : PROGRAM_UNCHECKED);
  }
  return { check, assert };
}

/** Run `send` only if the guard passes. */
export function guardedSend<T, R>(guard: { assert(): Promise<void> }, send: (x: T) => Promise<R>) {
  return async (x: T): Promise<R> => {
    await guard.assert();
    return send(x);
  };
}

/** A guard bound to THIS connection; every check reads the chain. */
export function programGuard(conn: Connection) {
  return makeProgramGuard(async () => (await observedProgramHash(conn, "confirmed")).hash);
}
