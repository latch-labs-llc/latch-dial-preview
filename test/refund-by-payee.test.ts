/** v0.7 #3: refund_by_payee on the deployed binary — every allowed state, who may call it, and how the deal ends. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { refundNote, terminalPill, viewDeal } from "../src/lib/view";
import { evidenceEventSentence } from "../src/lib/evidence";
import { explainError } from "../src/lib/wallet";
import { COPY } from "../src/lib/copy";

const DAY = 86400;
const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

type Stage = "signedPartial" | "funded" | "active" | "deadlocked";

async function setup(stage: Stage, milestones: bigint[] = [100_000_000n]) {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet(); // payer
  const sam = c.wallet(); // payee
  const eve = c.wallet(); // stranger
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
  const spec: F.DealSpec = {
    creator: alex.publicKey,
    dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)),
    parties: [alex.publicKey, sam.publicKey],
    payerIdx: 0,
    payeeIdx: 1,
    approvalThreshold: 2,
    termsHash: new Uint8Array(32).fill(9),
    milestoneAmounts: milestones,
    rule: "TimeoutRelease",
    timerMode: "FromActivation",
    timeoutSecs: 10 * DAY,
    recoverySigners: [alex.publicKey, sam.publicKey],
    recoveryThreshold: 2,
    recoveryDelaySecs: 3 * DAY,
    acceptedRiskFlags: RISK.FREEZE_AUTHORITY,
    mint,
  };
  const addr = F.dealAddress(alex.publicKey, spec.dealId);
  c.send(await F.createAndSign(spec, false), alex);
  c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
  if (stage === "signedPartial") {
    const d = c.deal(addr);
    const ix = await F.latchProgram()
      .methods.deposit(new BN(30_000_000))
      .accounts({ payer: alex.publicKey, deal: addr, mint, vault: d.vault, payerTokenAccount: F.ata(alex.publicKey, mint), tokenProgram: d.tokenProgram } as any)
      .instruction();
    c.send([ix], alex);
  } else {
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    if (stage === "active" || stage === "deadlocked") c.send(await F.markShipped(c.deal(addr), sam.publicKey, false), sam);
    if (stage === "deadlocked") c.send(await F.pause(addr, alex.publicKey), alex);
  }
  return { c, alex, sam, eve, mint, addr };
}

const bal = (c: Chain, k: Keypair, mint: PublicKey) => c.tokenBalance(k.publicKey, mint);

describe("v0.7 #3: refund_by_payee", () => {
  for (const [stage, state, back] of [
    ["signedPartial", "Signed", 30_000_000n],
    ["funded", "Funded", 100_000_000n],
    ["active", "Active", 100_000_000n],
    ["deadlocked", "Deadlocked", 100_000_000n],
  ] as const) {
    it(`${state}${stage === "signedPartial" ? " (partly paid in)" : ""}: offered to the payee only; returns everything; ends Cancelled`, async () => {
      const t = await setup(stage);
      const d = t.c.deal(t.addr);
      expect(d.state).toBe(state);
      expect(viewDeal(d, t.sam.publicKey, local, t.c.now()).actions).toContain("refundByPayee");
      expect(viewDeal(d, t.alex.publicKey, local, t.c.now()).actions).not.toContain("refundByPayee");
      expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).not.toContain("refundByPayee");
      // The program agrees: payer and stranger are refused.
      expectProgramError(t.c.trySend(await F.refundByPayee(d, t.alex.publicKey), t.alex), "OnlyPayeeMayRefund");
      expectProgramError(t.c.trySend(await F.refundByPayee(d, t.eve.publicKey), t.eve), "OnlyPayeeMayRefund");
      const before = bal(t.c, t.alex, t.mint);
      t.c.send(await F.refundByPayee(d, t.sam.publicKey), t.sam);
      expect(bal(t.c, t.alex, t.mint) - before).toBe(back);
      const after = t.c.deal(t.addr);
      expect(after.state).toBe("Cancelled");
      const ev = t.c.lastEvents.find((e) => e.name === "PayeeRefunded")!;
      expect(ev.data).toMatchObject({ deal: t.addr.toBase58(), payee: t.sam.publicKey.toBase58(), refundedToPayer: back.toString() });
      // Payer-side copy, from the event (the account alone reads like any cancel).
      const names = { ...local, contacts: { [t.sam.publicKey.toBase58()]: { name: "Sam" }, [t.alex.publicKey.toBase58()]: { name: "Alex" } } };
      expect(refundNote(t.c.lastEvents, after, t.alex.publicKey, names)).toMatch(/^Sam refunded you /);
      expect(refundNote(t.c.lastEvents, after, t.sam.publicKey, names)).toMatch(/^You refunded Alex /);
      expect(viewDeal(after, t.sam.publicKey, local, t.c.now()).actions).not.toContain("refundByPayee");
      expect(evidenceEventSentence(t.c.lastEvents, after)).toContain(`refunded ${back} token units to the payer`);
      // v0.8 #1: the deal page says so in its pill instead of pointing the ladder at "Agreed".
      expect(terminalPill(after)).toEqual({ cls: "ended", text: "↩ Refunded" });
      expect(terminalPill(d)).toBeNull();
    });
  }

  it("not before anything is paid in (Signed, nothing deposited) — the view doesn't offer it", async () => {
    const t = await setup("signedPartial");
    // A fresh Signed deal with no deposit:
    const c = t.c;
    const d = c.deal(t.addr);
    expect(viewDeal({ ...d, deposited: 0n }, t.sam.publicKey, local, c.now()).actions).not.toContain("refundByPayee");
  });

  it("after a partial release it ends Completed (something was paid out), refunding only what's left", async () => {
    const t = await setup("active", [40_000_000n, 60_000_000n]);
    t.c.send(await F.approveAndMaybeRelease(t.c.deal(t.addr), t.sam.publicKey), t.sam);
    t.c.send(await F.approveAndMaybeRelease(t.c.deal(t.addr), t.alex.publicKey), t.alex);
    const d = t.c.deal(t.addr);
    expect(d.releasedTotal).toBe(40_000_000n);
    const before = bal(t.c, t.alex, t.mint);
    t.c.send(await F.refundByPayee(d, t.sam.publicKey), t.sam);
    expect(bal(t.c, t.alex, t.mint) - before).toBe(60_000_000n);
    expect(t.c.deal(t.addr).state).toBe("Completed");
    expect(bal(t.c, t.sam, t.mint)).toBe(40_000_000n);
  });

  it("UI: behind a confirm sheet with the amount and 'can't be undone', through the guarded send; error mapped; wSOL unwrap offered after", () => {
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toContain('"confirmReady", "refundByPayee"]'); // SIGNS_AGREEMENT → programGuard
    expect(page).toMatch(/onClick=\{\(\) => setSheet\("refund"\)\}/);
    expect(page).toContain("COPY.refundConfirm(nameFor(payerKey, local), money(remaining(d), asset))");
    expect(COPY.refundConfirm("Alex", "$100.00")).toBe("$100.00 — everything still in this payment — goes back to Alex now. This can't be undone, and Alex doesn't have to agree.");
    expect(page).toMatch(/\(d\.state === "Completed" \|\| d\.state === "Cancelled"\) && d\.mint\.equals\(NATIVE_MINT\)/);
    expect(explainError(new Error("Error Code: OnlyPayeeMayRefund. Error Number: 6040."))).toBe("Only the recipient can refund this payment.");
    expect(explainError(new Error("custom program error: 0x1798"))).toBe("Only the recipient can refund this payment.");
  });
});

describe("v0.7 #3: events read back through a real RPC response", () => {
  it("lastEvents(): getSignaturesForAddress → getTransaction (web3.js parsing) → PayeeRefunded", async () => {
    const { Connection } = await import("@solana/web3.js");
    const { lastEvents } = await import("../src/lib/events");
    const t = await setup("active");
    t.c.send(await F.refundByPayee(t.c.deal(t.addr), t.sam.publicKey), t.sam);
    const txJson = t.c.lastTxJson;
    const sig = txJson.transaction.signatures[0];
    const fetchStub = async (_url: any, init: any) => {
      const req = JSON.parse(init.body);
      const result =
        req.method === "getSignaturesForAddress"
          ? [{ signature: sig, slot: 1, err: null, memo: null, blockTime: txJson.blockTime, confirmationStatus: "confirmed" }]
          : req.method === "getTransaction"
            ? txJson
            : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { headers: { "content-type": "application/json" } });
    };
    const conn = new Connection("http://rpc.invalid", { fetch: fetchStub as any, commitment: "confirmed" });
    const evs = await lastEvents(conn, t.addr);
    expect(evs.map((e) => e.name)).toEqual(["PayeeRefunded"]);
    expect(evs[0].data.refundedToPayer).toBe("100000000");
  });
});
