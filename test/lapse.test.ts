/**
 * Item 4: refund_unactivated on the deployed (upgraded) binary, plus the
 * view model that offers it.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { ACTIVATION_WINDOW_SECS, RISK } from "../src/lib/config";
import { viewDeal } from "../src/lib/view";
import { buildProtectedPayment } from "../src/lib/protected";

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const local: any = { contacts: {}, requests: {}, links: {}, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} };

async function funded() {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const stranger = c.wallet();
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, usd(75));
  const asset = { id: "USDC" as const, label: "x", mint, decimals: 6, knownRiskFlags: RISK.FREEZE_AUTHORITY, dollar: true };
  const { spec, deal } = buildProtectedPayment({ creator: alex.publicKey, payer: alex.publicKey, payee: sam.publicKey, raw: usd(75), asset, presetId: "shipped", dealId: BigInt(Date.now()), subject: "Bike" });
  c.send(await F.createAndSign(spec, false), alex);
  c.send([await F.signTerms(deal, sam.publicKey, false)], sam);
  c.send(await F.fund(c.deal(deal), alex.publicKey), alex);
  expect(c.deal(deal).state).toBe("Funded");
  expect(c.tokenBalance(alex.publicKey, mint)).toBe(0n);
  return { c, alex, sam, stranger, mint, deal };
}

describe("refund_unactivated (activation window lapse)", () => {
  it("is rejected before the window ends (ActivationWindowOpen)", async () => {
    const t = await funded();
    t.c.warp(ACTIVATION_WINDOW_SECS - 60);
    const err = t.c.trySend(await F.refundUnactivated(t.c.deal(t.deal), t.stranger.publicKey), t.stranger);
    expectProgramError(err, "ActivationWindowOpen");
    expect(t.c.deal(t.deal).state).toBe("Funded");
  });

  it("after the window, a stranger returns the whole vault to the payer; state Cancelled", async () => {
    const t = await funded();
    t.c.warp(ACTIVATION_WINDOW_SECS + 1);
    t.c.send(await F.refundUnactivated(t.c.deal(t.deal), t.stranger.publicKey), t.stranger);
    expect(t.c.deal(t.deal).state).toBe("Cancelled");
    expect(t.c.tokenBalance(t.alex.publicKey, t.mint)).toBe(usd(75));
    expect(t.c.tokenBalance(t.stranger.publicKey, t.mint)).toBe(0n);
  });

  it("works even if the payer closed their token account (cranker recreates it)", async () => {
    const t = await funded();
    t.c.warp(ACTIVATION_WINDOW_SECS + 1);
    const { createCloseAccountInstruction, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    t.c.send([createCloseAccountInstruction(getAssociatedTokenAddressSync(t.mint, t.alex.publicKey), t.alex.publicKey, t.alex.publicKey)], t.alex);
    t.c.send(await F.refundUnactivated(t.c.deal(t.deal), t.stranger.publicKey), t.stranger);
    expect(t.c.tokenBalance(t.alex.publicKey, t.mint)).toBe(usd(75));
  });

  it("race, payee first: a late confirm_ready still activates; the refund then fails", async () => {
    const t = await funded();
    t.c.warp(ACTIVATION_WINDOW_SECS + 3600);
    t.c.send(await F.markShipped(t.c.deal(t.deal), t.sam.publicKey), t.sam);
    expect(t.c.deal(t.deal).state).toBe("Active");
    expectProgramError(t.c.trySend(await F.refundUnactivated(t.c.deal(t.deal), t.stranger.publicKey), t.stranger), "InvalidState");
  });

  it("race, refund first: once returned, a late confirm_ready fails", async () => {
    const t = await funded();
    t.c.warp(ACTIVATION_WINDOW_SECS + 3600);
    t.c.send(await F.refundUnactivated(t.c.deal(t.deal), t.stranger.publicKey), t.stranger);
    expectProgramError(t.c.trySend(await F.markShipped(t.c.deal(t.deal), t.sam.publicKey), t.sam), "InvalidState");
  });

  it("view: before the window no one is offered it; after, any viewer is, and it's 'your move' for the payer", async () => {
    const t = await funded();
    const d = t.c.deal(t.deal);
    const before = d.fundedAt + ACTIVATION_WINDOW_SECS - 1;
    const after = d.fundedAt + ACTIVATION_WINDOW_SECS;
    expect(viewDeal(d, t.stranger.publicKey, local, before).actions).not.toContain("refundUnactivated");
    expect(viewDeal(d, t.alex.publicKey, local, before).sentence).toMatch(/Returns to you from/);
    expect(viewDeal(d, t.sam.publicKey, local, before).sentence).toMatch(/BEFORE you ship/);
    for (const who of [t.alex.publicKey, t.sam.publicKey, t.stranger.publicKey, null, Keypair.generate().publicKey]) {
      expect(viewDeal(d, who, local, after).actions).toContain("refundUnactivated");
    }
    expect(viewDeal(d, t.alex.publicKey, local, after).needsYou).toBe(true);
    expect(viewDeal(d, t.sam.publicKey, local, after).sentence).toMatch(/Don't ship/);
    expect(viewDeal(d, t.sam.publicKey, local, after).actions).toContain("markShipped"); // still possible: the race
    // A6: after the lapse it's a secondary action behind a confirm sheet; before, it's the normal button.
    expect(viewDeal(d, t.sam.publicKey, local, after).lateShip).toBe(true);
    expect(viewDeal(d, t.sam.publicKey, local, before).lateShip).toBe(false);
    const { COPY } = await import("../src/lib/copy");
    expect(COPY.lateShipConfirm("Alex")).toBe("Only if you've already shipped — Alex can take back the money until you do this.");
  });
});

describe("explainError mappings", () => {
  it("maps the new and previously unmapped program errors", async () => {
    const { explainError } = await import("../src/lib/wallet");
    expect(explainError(new Error("AnchorError: ActivationWindowOpen. Error Number: 6039"))).toMatch(/too early/);
    expect(explainError(new Error("custom program error: 0x1797"))).toMatch(/too early/);
    expect(explainError(new Error("Error Code: TrueDeadlockConsentRequired"))).toMatch(/Tick the box/);
    expect(explainError(new Error("Error Code: InvalidDeadlockParams"))).toMatch(/settlement rule/);
    expect(explainError(new Error("Error Code: InvalidState"))).toMatch(/moved on/);
  });
});
