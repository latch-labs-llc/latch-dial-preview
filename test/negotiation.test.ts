/**
 * v0.14: propose → counter → accept → create, through the real messaging
 * client and Worker code. Signatures are re-verified when the state is read,
 * so an edited or forged card never counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type Env } from "../worker/src/index";
import { ASSETS, RISK } from "../src/lib/config";
import type { CustomTerms } from "../src/lib/customTerms";
import * as M from "../src/lib/messaging";
import { threadId } from "../src/lib/msgCrypto";
import { acceptTerms, announceDeal, declineTerms, exportNegotiation, negotiationState, proposeTerms } from "../src/lib/negotiation";
import * as svc from "../src/lib/service";
import { getLocal, updateLocal } from "../src/lib/store";
import { draftHash, fromCustomTerms, type TermsDraft } from "../src/lib/termsDraft";
import type { LinkBlob } from "../src/lib/template";
import { env, wallet } from "./svc";

let e: Env;
let clock = 1_790_000_000;
const advance = (s: number) => {
  clock += s;
  vi.setSystemTime(clock * 1000);
};
const reset = () => {
  M._resetMessagingForTesting();
  updateLocal((d) => {
    d.msgEnabled = [];
    d.msgSigner = {};
    d.msgKcv = {};
    d.peerKeys = {};
    d.threads = {};
    d.msgSince = {};
  });
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock * 1000);
  e = env();
  svc.setServiceUrlForTesting("https://svc.test");
  vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => handle(new Request(String(input), init), e, clock));
  reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  svc.setServiceUrlForTesting(undefined);
});
async function become(w: ReturnType<typeof wallet>) {
  M._resetMessagingForTesting();
  await M.enableMessaging(w.pk, w.signBytes);
  advance(1);
  await M.pollMessages(w.pk);
}

const DAY = 86400;
describe("negotiation", () => {
  it("propose (signed) → counter → accept → agreed → create and announce; export carries every signature", async () => {
    const { PublicKey } = await import("@solana/web3.js");
    const a = wallet();
    const b = wallet();
    const mk = (creator: string, other: string, over: Partial<CustomTerms> = {}): CustomTerms => ({
      creator: new PublicKey(creator),
      dealId: BigInt(clock) * 1000n,
      parties: [new PublicKey(creator), new PublicKey(other)],
      payerIdx: 0,
      payeeIdx: 1,
      approvalThreshold: 2,
      mint: ASSETS.USDC.mint,
      decimals: 6,
      parts: [{ label: "", amount: 100_000_000n }],
      rule: "TimeoutRelease",
      timerMode: "FromActivation",
      timeoutSecs: 10 * DAY,
      splitBps: 0,
      tieBreaker: null,
      disputePolicy: "NeverExpire",
      disputeWindowSecs: 0,
      consentTrueDeadlock: false,
      recoverySigners: [new PublicKey(creator), new PublicKey(other)],
      recoveryThreshold: 2,
      recoveryDelaySecs: 3 * DAY,
      detectedRiskFlags: RISK.FREEZE_AUTHORITY,
      acceptedRiskFlags: RISK.FREEZE_AUTHORITY,
      priceRiskTerm: 0,
      ...over,
    });
    const blob: LinkBlob = { t: "general@2", p: { milestones: [""] }, s: "Logo design", n: "cd".repeat(16) };
    await become(a);
    await become(b);
    // a proposes v1.
    await become(a);
    const d1 = fromCustomTerms(mk(a.pk, b.pk), blob, 1);
    const p1 = await proposeTerms(a.pk, b.pk, d1, a.signBytes);
    let st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], a.pk);
    expect(st.latest?.hash).toBe(p1.hash);
    expect(st.latest?.signed).toBe(true);
    expect(st.agreed).toBe(false);
    // b reads it on its own device and counters with v2 (as creator, new dealId).
    reset();
    await become(b);
    st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], b.pk);
    expect(st.latest?.m.from).toBe(a.pk);
    expect(st.latest?.draft.version).toBe(1);
    advance(1);
    const d2: TermsDraft = fromCustomTerms(mk(b.pk, a.pk, { parts: [{ label: "", amount: 80_000_000n }] }), blob, 2, p1.hash);
    const p2 = await proposeTerms(b.pk, a.pk, d2, b.signBytes);
    st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], b.pk);
    expect(st.proposals.map((p) => p.draft.version)).toEqual([1, 2]);
    expect(st.latest?.hash).toBe(p2.hash);
    expect(st.latest?.draft.basedOn).toBe(p1.hash);
    // a accepts v2 (wallet-signed); now agreed, and b (v2's creator) is the one to create.
    reset();
    await become(a);
    advance(1);
    await acceptTerms(a.pk, b.pk, p2.hash, a.signBytes);
    st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], a.pk);
    expect(st.acceptedBy.has(a.pk)).toBe(true);
    expect(st.agreed).toBe(true);
    expect(st.latest?.draft.terms.creator).toBe(b.pk);
    expect(st.deal).toBeNull();
    // b creates (simulated here) and announces; a sees the deal.
    reset();
    await become(b);
    expect(negotiationState(getLocal().threads[threadId(a.pk, b.pk)], b.pk).agreed).toBe(true);
    advance(1);
    await announceDeal(a.pk, p2.hash, "DeaL111111111111111111111111111111111111111", "k-blob");
    reset();
    await become(a);
    st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], a.pk);
    expect(st.deal?.address).toBe("DeaL111111111111111111111111111111111111111");
    expect(st.deal?.k).toBe("k-blob");
    const exp = JSON.parse(exportNegotiation(getLocal().threads[threadId(a.pk, b.pk)], a.pk));
    expect(exp.format).toBe("latch-negotiation@1");
    expect(exp.proposals.map((p: any) => [p.version, p.signed])).toEqual([[1, true], [2, true]]);
    expect(exp.latest.agreed).toBe(true);
    expect(exp.messages.every((m: any) => typeof m.sig === "string" && typeof m.ct === "string")).toBe(true);
  });

  it("a forged or tampered proposal doesn't count; a decline is recorded; a stale accept of an older version is ignored", async () => {
    const { PublicKey } = await import("@solana/web3.js");
    const a = wallet();
    const b = wallet();
    const mk = (creator: string, other: string): CustomTerms => ({
      creator: new PublicKey(creator),
      dealId: BigInt(clock) * 1000n,
      parties: [new PublicKey(creator), new PublicKey(other)],
      payerIdx: 0,
      payeeIdx: 1,
      approvalThreshold: 2,
      mint: ASSETS.USDC.mint,
      decimals: 6,
      parts: [{ label: "", amount: 100_000_000n }],
      rule: "TimeoutRelease",
      timerMode: "FromActivation",
      timeoutSecs: 10 * DAY,
      splitBps: 0,
      tieBreaker: null,
      disputePolicy: "NeverExpire",
      disputeWindowSecs: 0,
      consentTrueDeadlock: false,
      recoverySigners: [new PublicKey(creator), new PublicKey(other)],
      recoveryThreshold: 2,
      recoveryDelaySecs: 3 * DAY,
      detectedRiskFlags: RISK.FREEZE_AUTHORITY,
      acceptedRiskFlags: RISK.FREEZE_AUTHORITY,
      priceRiskTerm: 0,
    });
    const blob: LinkBlob = { t: "general@2", p: { milestones: [""] }, s: "Logo design", n: "ef".repeat(16) };
    await become(a);
    await become(b);
    await become(a);
    const d1 = fromCustomTerms(mk(a.pk, b.pk), blob, 1);
    // Signed by someone else's wallet: delivered, but "unsigned" and never agreed.
    const other = wallet();
    const forged = await proposeTerms(a.pk, b.pk, d1, other.signBytes);
    let st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], a.pk);
    expect(st.latest?.hash).toBe(forged.hash);
    expect(st.latest?.signed).toBe(false);
    // A draft naming the other party as creator can't be proposed by me.
    advance(1);
    const wrongCreator = fromCustomTerms(mk(b.pk, a.pk), blob, 2, forged.hash);
    await M.sendBody(b.pk, { v: "latch-msg@1", kind: "proposal", proposal: wrongCreator, ref: draftHash(wrongCreator), sentAt: clock });
    st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], a.pk);
    expect(st.proposals).toHaveLength(1);
    // A tampered body (ref doesn't match the draft) is ignored.
    advance(1);
    await M.sendBody(b.pk, { v: "latch-msg@1", kind: "proposal", proposal: d1, ref: "0".repeat(64), sentAt: clock });
    expect(negotiationState(getLocal().threads[threadId(a.pk, b.pk)], a.pk).proposals).toHaveLength(1);
    // A real v2; b declines it; b's acceptance of v1 (older) doesn't count for v2.
    advance(1);
    const p2 = await proposeTerms(a.pk, b.pk, fromCustomTerms(mk(a.pk, b.pk), blob, 2, forged.hash), a.signBytes);
    reset();
    await become(b);
    advance(1);
    await acceptTerms(b.pk, a.pk, forged.hash, b.signBytes);
    advance(1);
    await declineTerms(a.pk, p2.hash, "Too much for a first job.");
    st = negotiationState(getLocal().threads[threadId(a.pk, b.pk)], b.pk);
    expect(st.latest?.hash).toBe(p2.hash);
    expect(st.acceptedBy.size).toBe(0);
    expect(st.declinedBy.has(b.pk)).toBe(true);
    expect(st.agreed).toBe(false);
  });
});
