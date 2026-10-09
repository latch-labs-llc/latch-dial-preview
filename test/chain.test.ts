/** Read-side helpers against fake RPC responses built from the real deployed bytes. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { observedProgramHash } from "../src/lib/chain";
import { VERIFIED_BUILD_HASH } from "../src/lib/config";
import { FIXTURE } from "./harness";

describe("observedProgramHash", () => {
  it("hashes the program-data bytecode exactly like solana-verify", async () => {
    const pdAddr = Keypair.generate().publicKey;
    const prog = Buffer.concat([Buffer.from([2, 0, 0, 0]), pdAddr.toBuffer()]);
    const slot = Buffer.alloc(8);
    slot.writeBigUInt64LE(424242n);
    const pd = Buffer.concat([Buffer.from([3, 0, 0, 0]), slot, Buffer.alloc(33), readFileSync(FIXTURE), Buffer.alloc(4096)]);
    const conn: any = {
      getAccountInfo: async (k: any) => (k.equals(pdAddr) ? { data: pd } : { data: prog }),
    };
    const r = await observedProgramHash(conn);
    expect(r.hash).toBe(VERIFIED_BUILD_HASH);
    expect(r.programData).toBe(pdAddr.toBase58());
    expect(r.slot).toBe(424242);
  });
});
