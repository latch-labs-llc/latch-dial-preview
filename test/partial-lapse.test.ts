/** v0.7 #4: refund_unactivated for a partly paid-in Signed deal counts from signed_at + 3 days; a Funded deal still from funded_at. */
import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { viewDeal } from "../src/lib/view";

const DAY = 86400;
const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

async function signed() {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const eve = c.wallet();
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
  const spec: F.DealSpec = {
    creator: alex.publicKey, dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)), parties: [alex.publicKey, sam.publicKey], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2,
    termsHash: new Uint8Array(32).fill(5), milestoneAmounts: [100_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 10 * DAY,
    recoverySigners: [alex.publicKey, sam.publicKey], recoveryThreshold: 2, recoveryDelaySecs: 3 * DAY, acceptedRiskFlags: RISK.FREEZE_AUTHORITY, mint,
  };
  const addr = F.dealAddress(alex.publicKey, spec.dealId);
  c.send(await F.createAndSign(spec, false), alex);
  c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
  const deposit = async (amount: number) => {
    const d = c.deal(addr);
    const ix = await F.latchProgram().methods.deposit(new BN(amount)).accounts({ payer: alex.publicKey, deal: addr, mint, vault: d.vault, payerTokenAccount: F.ata(alex.publicKey, mint), tokenProgram: d.tokenProgram } as any).instruction();
    c.send([ix], alex);
  };
  return { c, alex, sam, eve, mint, addr, deposit };
}

describe("v0.7 #4: partly paid-in Signed deals lapse from signed_at", () => {
  it("base = signed_at: paying in 2 days after signing doesn't restart the 3 days", async () => {
    const t = await signed();
    const signedAt = t.c.deal(t.addr).signedAt;
    t.c.warp(2 * DAY);
    await t.deposit(30_000_000);
    let d = t.c.deal(t.addr);
    expect(d.state).toBe("Signed");
    // Not yet: the program refuses and the view offers nothing.
    expectProgramError(t.c.trySend(await F.refundUnactivated(d, t.eve.publicKey), t.eve), "ActivationWindowOpen");
    expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).not.toContain("refundUnactivated");
    const payerView = viewDeal(d, t.alex.publicKey, local, t.c.now());
    expect(payerView.actions).toContain("pay");
    expect(payerView.sentence).toMatch(/^You've paid in 30 tokens of 100 tokens\. Pay in the rest to continue\. From .* \(3 days after you both signed\)/);
    // signed_at + 3 days (only 1 day after the deposit): open to anyone.
    t.c.warp(signedAt + 3 * DAY - t.c.now());
    d = t.c.deal(t.addr);
    expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).toContain("refundUnactivated");
    expect(viewDeal(d, t.alex.publicKey, local, t.c.now()).sentence).toBe("Not fully paid in within 3 days of signing — you (or anyone) can return the 30 tokens to yourself now.");
    expect(viewDeal(d, t.sam.publicKey, local, t.c.now()).sentence).toMatch(/^Not fully paid in within 3 days of signing — anyone can return it to /);
    const before = t.c.tokenBalance(t.alex.publicKey, t.mint);
    t.c.send(await F.refundUnactivated(d, t.eve.publicKey), t.eve);
    expect(t.c.tokenBalance(t.alex.publicKey, t.mint) - before).toBe(30_000_000n);
    expect(t.c.deal(t.addr).state).toBe("Cancelled");
  });

  it("base = funded_at for a Funded deal: 3 days after signing isn't enough when it was paid in later", async () => {
    const t = await signed();
    const signedAt = t.c.deal(t.addr).signedAt;
    t.c.warp(2 * DAY);
    t.c.send(await F.fund(t.c.deal(t.addr), t.alex.publicKey), t.alex);
    let d = t.c.deal(t.addr);
    expect(d.state).toBe("Funded");
    t.c.warp(signedAt + 3 * DAY + 60 - t.c.now());
    d = t.c.deal(t.addr);
    expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).not.toContain("refundUnactivated");
    expectProgramError(t.c.trySend(await F.refundUnactivated(d, t.eve.publicKey), t.eve), "ActivationWindowOpen");
    t.c.warp(d.fundedAt + 3 * DAY - t.c.now());
    d = t.c.deal(t.addr);
    expect(viewDeal(d, t.eve.publicKey, local, t.c.now()).actions).toContain("refundUnactivated");
    t.c.send(await F.refundUnactivated(d, t.eve.publicKey), t.eve);
    expect(t.c.deal(t.addr).state).toBe("Cancelled");
  });

  it("a Signed deal with nothing paid in never offers it", async () => {
    const t = await signed();
    t.c.warp(5 * DAY);
    expect(viewDeal(t.c.deal(t.addr), t.eve.publicKey, local, t.c.now()).actions).not.toContain("refundUnactivated");
  });
});

describe("v0.7 #4 follow-up: the pay-in button names what's still owed", () => {
  it("'Pay in the remaining …' once something is paid in", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toContain('btn("pay", `Pay in ${d.deposited > 0n ? `the remaining ${money(d.totalAmount - d.deposited, asset)}` : v.amount}`');
  });
});
