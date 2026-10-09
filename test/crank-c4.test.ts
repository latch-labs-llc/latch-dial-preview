/**
 * One-off, env-gated: crank refund_unactivated on a Funded-but-never-activated
 * devnet deal once its window has passed (todo C4). Anyone may submit the
 * crank; the money can only go back to the payer. The public demo tap pays
 * the fee.
 *
 *   CRANK_DEAL=<address> RPC_URL=<helius devnet url> npx vitest run test/crank-c4.test.ts
 */
import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchDeal } from "../src/lib/chain";
import { sendAs, tapKeypair } from "../src/lib/demo";
import * as F from "../src/lib/flows";

describe.skipIf(!process.env.CRANK_DEAL)("C4 crank", () => {
  it("refund_unactivated → Cancelled, money back to the payer", async () => {
    const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const addr = new PublicKey(process.env.CRANK_DEAL!);
    let d = (await fetchDeal(conn, addr))!;
    console.log("before", d.state, "funded at", String((d as any).fundedAt), "window", String(d.timeoutSecs));
    expect(d.state).toBe("Funded");
    const tap = tapKeypair();
    const sig = await sendAs(conn, await F.refundUnactivated(d, tap.publicKey), tap, []);
    console.log("CRANK_SIG", sig);
    d = (await fetchDeal(conn, addr))!;
    console.log("after", d.state, "deposited", String(d.deposited));
    expect(d.state).toBe("Cancelled");
  }, 120_000);
});
