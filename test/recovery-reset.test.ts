/** v0.7 #6: the program clears recovery signatures at activation — the app never shows pre-start signatures as counting. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { viewDeal } from "../src/lib/view";
import { COPY } from "../src/lib/copy";

const DAY = 86400;
const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

describe("v0.7 #6: recovery approvals reset at activation (deployed binary)", () => {
  it("signatures gathered while Funded never count: no recovery actions offered, notice says so, and activation clears them", async () => {
    const c = new Chain();
    const issuer = c.wallet();
    const alex = c.wallet();
    const sam = c.wallet();
    const bob = c.wallet(); // third-party backup signer
    const mint = c.mint(issuer);
    c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
    const spec: F.DealSpec = {
      creator: alex.publicKey, dealId: 9n, parties: [alex.publicKey, sam.publicKey], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, termsHash: new Uint8Array(32).fill(1),
      milestoneAmounts: [100_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 10 * DAY,
      recoverySigners: [alex.publicKey, sam.publicKey, bob.publicKey], recoveryThreshold: 2, recoveryDelaySecs: 3 * DAY, acceptedRiskFlags: RISK.FREEZE_AUTHORITY, mint,
    };
    const addr = F.dealAddress(alex.publicKey, 9n);
    c.send(await F.createAndSign(spec, false), alex);
    c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
    // While Funded the app offers nothing to a backup signer…
    for (const k of [bob, alex, sam]) {
      const acts = viewDeal(c.deal(addr), k.publicKey, local, c.now()).actions;
      expect(acts).not.toContain("recoveryPropose");
      expect(acts).not.toContain("recoverySign");
    }
    // …but another client can still sign; the program then holds a "met" count it will never honour.
    c.send(await F.recoverySign(addr, bob.publicKey, 40_000_000n), bob);
    c.send(await F.recoverySign(addr, alex.publicKey, 40_000_000n), alex);
    let d = c.deal(addr);
    expect([d.recoveryProposalActive, d.recoveryApprovals, d.recoveryReadyAt]).toEqual([true, 0b101, 0]);
    const v = viewDeal(d, sam.publicKey, local, c.now());
    expect(v.sentence).toContain(COPY.recoveryBeforeStart);
    expect(v.sentence).not.toMatch(/2 of 2 signatures|agreed to divide/);
    expect(v.actions).not.toContain("recoveryExecute");
    // Activation clears the proposal and every signature.
    c.send(await F.markShipped(c.deal(addr), sam.publicKey, false), sam);
    d = c.deal(addr);
    expect([d.state, d.recoveryProposalActive, d.recoveryApprovals, d.recoveryProposedToPayee]).toEqual(["Active", false, 0, 0n]);
    expect(viewDeal(d, sam.publicKey, local, c.now()).sentence).not.toContain("backup");
    // After the start, a backup signer can propose again — from zero.
    expect(viewDeal(d, bob.publicKey, local, c.now()).actions).toContain("recoveryPropose");
    c.send(await F.recoverySign(addr, bob.publicKey, 40_000_000n), bob);
    d = c.deal(addr);
    expect(viewDeal(d, sam.publicKey, local, c.now()).sentence).toMatch(/— 1 of 2 signatures$/);
  });

  it("the deal page says pre-start signatures don't count while the payment hasn't started", () => {
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toContain('d.state === "Draft" || d.state === "Signed" || d.state === "Funded" ? `. ${COPY.recoveryAfterStart}`');
    expect(COPY.recoveryAfterStart).toBe("Backup signers can propose a division once the payment has started. Signatures collected before the start are cleared then and don't count.");
  });
});
