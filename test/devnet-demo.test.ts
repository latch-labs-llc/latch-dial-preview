/**
 * Live devnet check of demo mode (skipped unless DEVNET_DEMO=1; creates one
 * real deal — log it in LAUNCH-POSTS §5 as ours). A fresh wallet gets SOL and
 * test dollars from the demo tap/mint, pays the demo seller protected, the
 * seller accepts and ships via demoAct, the user approves → Completed.
 *
 *   DEVNET_DEMO=1 RPC_URL=<helius devnet url> npx vitest run test/devnet-demo.test.ts
 */
import { describe, expect, it } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import * as F from "../src/lib/flows";
import { DEMO_SELLER, LDD_MINT, demoAct, demoActions, demoLdd, demoSol, sendAs } from "../src/lib/demo";
import { fetchDeal } from "../src/lib/chain";

const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

describe.skipIf(!process.env.DEVNET_DEMO)("demo mode on live devnet", () => {
  it("tap → mint → protected payment to the demo seller → seller accepts and ships → user approves → Completed", async () => {
    const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const user = Keypair.generate();
    console.log("user", user.publicKey.toBase58());
    console.log("sol tap", await demoSol(conn, user.publicKey));
    console.log("ldd mint", await demoLdd(conn, user.publicKey, 200));
    const spec: F.DealSpec = {
      creator: user.publicKey, dealId: F.newDealId(Date.now()), parties: [user.publicKey, DEMO_SELLER], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2,
      termsHash: new Uint8Array(32).fill(1), milestoneAmounts: [120_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 10 * 86400,
      recoverySigners: [user.publicKey, DEMO_SELLER], recoveryThreshold: 2, recoveryDelaySecs: 3 * 86400, acceptedRiskFlags: 0, mint: LDD_MINT,
    };
    const addr = F.dealAddress(user.publicKey, spec.dealId);
    console.log("deal", addr.toBase58());
    await sendAs(conn, await F.createAndSign(spec, false), user, []);
    let d = (await fetchDeal(conn, addr))!;
    expect(demoActions(d, local, Date.now() / 1000)).toContain("accept");
    console.log("demo accept", await demoAct(conn, d, "accept"));
    d = (await fetchDeal(conn, addr))!;
    await sendAs(conn, await F.fund(d, user.publicKey), user, []);
    d = (await fetchDeal(conn, addr))!;
    expect(demoActions(d, local, Date.now() / 1000)).toContain("markShipped");
    console.log("demo ship", await demoAct(conn, d, "markShipped"));
    d = (await fetchDeal(conn, addr))!;
    expect(d.state).toBe("Active");
    await sendAs(conn, await F.approveAndMaybeRelease(d, user.publicKey), user, []);
    d = (await fetchDeal(conn, addr))!;
    expect(d.state).toBe("Completed");
  }, 180_000);
});
