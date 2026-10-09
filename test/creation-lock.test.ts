/** v0.7.1 #3: set_dispute_policy only in the deal's creating transaction, after create_deal (program 4e5fa0a6…). */
import { describe, expect, it } from "vitest";
import { Chain, expectProgramError } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { explainError } from "../src/lib/wallet";

const DAY = 86400;

function setup() {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const mint = c.mint(issuer);
  const spec = (dealId: bigint): F.DealSpec => ({
    creator: alex.publicKey, dealId, parties: [alex.publicKey, sam.publicKey], payerIdx: 0, payeeIdx: 1, approvalThreshold: 2, termsHash: new Uint8Array(32).fill(1),
    milestoneAmounts: [1_000_000n], rule: "TimeoutRelease", timerMode: "FromActivation", timeoutSecs: 10 * DAY,
    recoverySigners: [alex.publicKey, sam.publicKey], recoveryThreshold: 2, recoveryDelaySecs: 3 * DAY, acceptedRiskFlags: RISK.FREEZE_AUTHORITY, mint,
  });
  return { c, alex, sam, spec, addr: (id: bigint) => F.dealAddress(alex.publicKey, id) };
}

describe("v0.7.1 #3: the creation lock on the deployed binary", () => {
  it("bundled create → set_dispute_policy → sign succeeds (what createAndSign builds)", async () => {
    const t = setup();
    const ixs = await F.createAndSign({ ...t.spec(1n), disputePolicy: "RefundPayer", disputeWindowSecs: 7 * DAY }, false);
    expect(ixs).toHaveLength(3);
    t.c.send(ixs, t.alex);
    const d = t.c.deal(t.addr(1n));
    expect([d.disputePolicy, d.disputeWindowSecs, d.signed]).toEqual(["RefundPayer", 7 * DAY, 1]);
  });

  it("a separate, later transaction fails with PolicyMustBeSetAtCreation — even on an untouched Draft", async () => {
    const t = setup();
    const [create] = await F.createAndSign(t.spec(2n), false);
    t.c.send([create], t.alex); // created, nothing else: not signed, nothing set
    expect(t.c.deal(t.addr(2n))).toMatchObject({ state: "Draft", signed: 0, disputePolicy: "NeverExpire" });
    const err = t.c.trySend([await F.setDisputePolicyIx(t.addr(2n), t.alex.publicKey, "RefundPayer", DAY)], t.alex);
    expectProgramError(err, "PolicyMustBeSetAtCreation");
    expect(t.c.deal(t.addr(2n)).disputePolicy).toBe("NeverExpire");
  });

  it("before create_deal in the same transaction it fails (the deal doesn't exist yet: Anchor's AccountNotInitialized, 3012)", async () => {
    const t = setup();
    const [create, sign] = await F.createAndSign(t.spec(3n), false);
    const err = t.c.trySend([await F.setDisputePolicyIx(t.addr(3n), t.alex.publicKey, "Split", DAY), create, sign], t.alex);
    expect(err).toMatch(/Error Code: AccountNotInitialized\. Error Number: 3012\./);
    expect(t.c.raw(t.addr(3n))).toBeNull(); // the whole transaction rolled back
  });

  it("nor after the creator's signature, nor a second time in the creating transaction", async () => {
    const t = setup();
    const [c4, s4] = await F.createAndSign(t.spec(4n), false);
    expectProgramError(t.c.trySend([c4, s4, await F.setDisputePolicyIx(t.addr(4n), t.alex.publicKey, "Split", DAY)], t.alex), "DisputePolicyLocked");
    const [c5, s5] = await F.createAndSign(t.spec(5n), false);
    const twice = [c5, await F.setDisputePolicyIx(t.addr(5n), t.alex.publicKey, "Split", DAY), await F.setDisputePolicyIx(t.addr(5n), t.alex.publicKey, "RefundPayer", DAY), s5];
    expectProgramError(t.c.trySend(twice, t.alex), "PolicyMustBeSetAtCreation");
  });

  it("PolicyMustBeSetAtCreation is explained in plain words", () => {
    const msg = "A dispute time limit can only be set in the same step that creates the payment. Start a new agreement to choose one.";
    expect(explainError(new Error("Error Code: PolicyMustBeSetAtCreation. Error Number: 6045."))).toBe(msg);
    expect(explainError(new Error("custom program error: 0x179d"))).toBe(msg);
  });
});
