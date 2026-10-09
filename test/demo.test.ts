/**
 * v0.11 #1: demo mode. The demo seller's actions are ordinary party actions
 * built by the same flows as a real wallet's, chosen by viewDeal from ITS
 * side; LDD minting uses the public devnet authority. Run on the deployed
 * binary; the demo seller is just another funded keypair here.
 */
import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { DEMO_CONTACTS, DEMO_LABEL, DEMO_SELLER, demoActions, demoInstructions, demoSeller, isDemoSeller } from "../src/lib/demo";

const DAY = 86400;
const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

describe("demo seller", () => {
  it("accepts, ships, and is paid by the user's approval — every step built by demoInstructions from its own viewDeal", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const seller = demoSeller();
    c.svm.airdrop(address(seller.publicKey.toBase58()), BigInt(2e9) as any);
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
    const spec: F.DealSpec = {
      creator: alex.publicKey,
      dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)),
      parties: [alex.publicKey, DEMO_SELLER],
      payerIdx: 0,
      payeeIdx: 1,
      approvalThreshold: 2,
      termsHash: new Uint8Array(32).fill(5),
      milestoneAmounts: [120_000_000n],
      rule: "TimeoutRelease",
      timerMode: "FromActivation",
      timeoutSecs: 10 * DAY,
      recoverySigners: [alex.publicKey, DEMO_SELLER],
      recoveryThreshold: 2,
      recoveryDelaySecs: 3 * DAY,
      acceptedRiskFlags: RISK.FREEZE_AUTHORITY,
      mint,
    };
    const addr = F.dealAddress(alex.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), alex);
    const now = () => c.now();
    // Draft: the demo seller can accept or decline.
    expect(demoActions(c.deal(addr), local, now())).toEqual(expect.arrayContaining(["accept", "cancelDraft"]));
    let step = await demoInstructions(c.deal(addr), "accept");
    c.send(step.ixs, seller, step.extraSigners);
    expect(c.deal(addr).state).toBe("Signed");
    expect(demoActions(c.deal(addr), local, now())).not.toContain("accept");
    // The user pays in; the seller marks it shipped (confirm ready + pre-approve).
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    expect(demoActions(c.deal(addr), local, now())).toContain("markShipped");
    step = await demoInstructions(c.deal(addr), "markShipped");
    c.send(step.ixs, seller, step.extraSigners);
    expect(c.deal(addr).state).toBe("Active");
    // The user says it's OK → released to the demo seller.
    c.send(await F.approveAndMaybeRelease(c.deal(addr), alex.publicKey), alex);
    expect(c.deal(addr).state).toBe("Completed");
    expect(c.tokenBalance(DEMO_SELLER, mint)).toBe(120_000_000n);
    for (const a of ["accept", "markShipped", "release", "refundByPayee"] as const) expect(DEMO_LABEL[a]).toMatch(/^Demo seller /);
  });

  it("refunds the user from Active, and never offers actions on deals it isn't part of", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const seller = demoSeller();
    c.svm.airdrop(address(seller.publicKey.toBase58()), BigInt(2e9) as any);
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
    const mk = async (payee: typeof DEMO_SELLER) => {
      const spec: F.DealSpec = {
        creator: alex.publicKey, dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)), parties: [alex.publicKey, payee], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2,
        termsHash: new Uint8Array(32).fill(6), milestoneAmounts: [50_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 10 * DAY,
        recoverySigners: [alex.publicKey, payee], recoveryThreshold: 2, recoveryDelaySecs: 3 * DAY, acceptedRiskFlags: RISK.FREEZE_AUTHORITY, mint,
      };
      const addr = F.dealAddress(alex.publicKey, spec.dealId);
      c.send(await F.createAndSign(spec, false), alex);
      return addr;
    };
    const addr = await mk(DEMO_SELLER);
    let step = await demoInstructions(c.deal(addr), "accept");
    c.send(step.ixs, seller);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    step = await demoInstructions(c.deal(addr), "markShipped");
    c.send(step.ixs, seller);
    const before = c.tokenBalance(alex.publicKey, mint);
    expect(demoActions(c.deal(addr), local, c.now())).toContain("refundByPayee");
    step = await demoInstructions(c.deal(addr), "refundByPayee");
    c.send(step.ixs, seller);
    expect(c.deal(addr).state).toBe("Cancelled");
    expect(c.tokenBalance(alex.publicKey, mint) - before).toBe(50_000_000n);
    // Not a party → nothing to press.
    const other = await mk(sam.publicKey);
    expect(demoActions(c.deal(other), local, c.now())).toEqual([]);
    expect(isDemoSeller(DEMO_SELLER)).toBe(true);
    expect(isDemoSeller(sam.publicKey)).toBe(false);
    expect(DEMO_CONTACTS[0].address).toBe(DEMO_SELLER.toBase58());
  });
});
