/** Item 5: "Nobody decides" (TrueDeadlock) can be created and needs every party's consent. */
import { describe, expect, it } from "vitest";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { agreementSpec } from "../src/lib/agreementSpec";

const usd = (n: number) => BigInt(Math.round(n * 1e6));

async function setup() {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, usd(100));
  const asset = { id: "USDC" as const, label: "x", mint, decimals: 6, knownRiskFlags: RISK.FREEZE_AUTHORITY, dollar: true };
  const spec = agreementSpec({
    creator: alex.publicKey, dealId: BigInt(Date.now()), role: "payer", other: sam.publicKey, amounts: [usd(100)],
    settle: "nobody", windowDays: 10, splitPct: 50, backupDelayDays: 3, asset,
  });
  return { c, alex, sam, mint, spec, deal: F.dealAddress(alex.publicKey, spec.dealId) };
}

describe("TrueDeadlock via the builder's spec", () => {
  it("builder spec: TrueDeadlock + FromDeadlock + no timeout", async () => {
    const t = await setup();
    expect([t.spec.rule, t.spec.timerMode, t.spec.timeoutSecs]).toEqual(["TrueDeadlock", "FromDeadlock", 0]);
  });
  it("creator WITHOUT consent fails (the v0.2 bug: Builder always passed false)", async () => {
    const t = await setup();
    expectProgramError(t.c.trySend(await F.createAndSign(t.spec, false), t.alex), "TrueDeadlockConsentRequired");
  });
  it("creator WITH consent succeeds; the counterparty must consent too; then it never resolves by time", async () => {
    const t = await setup();
    t.c.send(await F.createAndSign(t.spec, true), t.alex);
    expectProgramError(t.c.trySend([await F.signTerms(t.deal, t.sam.publicKey, false)], t.sam), "TrueDeadlockConsentRequired");
    t.c.send([await F.signTerms(t.deal, t.sam.publicKey, true)], t.sam);
    expect(t.c.deal(t.deal).state).toBe("Signed");
    t.c.send(await F.fund(t.c.deal(t.deal), t.alex.publicKey), t.alex);
    t.c.send(await F.markShipped(t.c.deal(t.deal), t.sam.publicKey), t.sam);
    t.c.send(await F.pause(t.deal, t.alex.publicKey), t.alex);
    t.c.warp(400 * 86400);
    expectProgramError(t.c.trySend(await F.collect(t.c.deal(t.deal), t.sam.publicKey), t.sam), "ResolutionConditionsNotMet");
    t.c.send(await F.proposeSplit(t.deal, t.sam.publicKey, usd(30)), t.sam);
    t.c.send(await F.acceptSplit(t.c.deal(t.deal), t.alex.publicKey), t.alex);
    expect(t.c.deal(t.deal).state).toBe("Completed");
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(usd(30));
  });
});
