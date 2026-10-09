/**
 * v0.4 A1: before create / accept / pay-in, the deployed program must match
 * the pinned hash the agreement text vouches for.
 */
import { describe, expect, it, vi } from "vitest";
import { PROGRAM_CHANGED, PROGRAM_UNCHECKED, guardedSend, makeProgramGuard } from "../src/lib/programGuard";
import { VERIFIED_BUILD_HASH } from "../src/lib/config";

const OTHER = "ab".repeat(32);

describe("program guard", () => {
  it("mismatch blocks signing: the transaction is never sent", async () => {
    const send = vi.fn(async () => "sig");
    const g = makeProgramGuard(async () => OTHER);
    await expect(guardedSend(g, send)(["ix"])).rejects.toThrow(PROGRAM_CHANGED);
    expect(send).not.toHaveBeenCalled();
    expect(await g.check()).toEqual({ ok: false, expected: VERIFIED_BUILD_HASH, observed: OTHER, reason: "mismatch" });
  });

  it("match proceeds, and EVERY signature re-reads the chain (no cache)", async () => {
    const send = vi.fn(async () => "sig");
    const observe = vi.fn(async () => VERIFIED_BUILD_HASH);
    const g = makeProgramGuard(observe);
    expect(await guardedSend(g, send)(["ix"])).toBe("sig");
    expect(await guardedSend(g, send)(["ix2"])).toBe("sig");
    expect(send).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("an upgrade mid-session blocks the next signature (a past success isn't reused)", async () => {
    const send = vi.fn(async () => "sig");
    let deployed = VERIFIED_BUILD_HASH;
    const g = makeProgramGuard(async () => deployed);
    expect(await guardedSend(g, send)(["ix"])).toBe("sig");
    deployed = OTHER;
    await expect(guardedSend(g, send)(["ix"])).rejects.toThrow(PROGRAM_CHANGED);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await g.check()).ok).toBe(false); // Settings "Deployed now" re-reads too
  });

  it("a failed check blocks too, and is retried next time (not cached)", async () => {
    const send = vi.fn(async () => "sig");
    let n = 0;
    const g = makeProgramGuard(async () => {
      if (n++ === 0) throw new Error("RPC down");
      return VERIFIED_BUILD_HASH;
    });
    // v0.6: a failed check says so (and still blocks); it is NOT reported as a changed program.
    const e = await guardedSend(g, send)(["ix"]).catch((x) => x);
    expect(e.message).toBe(PROGRAM_UNCHECKED);
    expect(e.message).not.toBe(PROGRAM_CHANGED);
    expect(send).not.toHaveBeenCalled();
    expect(await guardedSend(g, send)(["ix"])).toBe("sig");
  });

  it("both block messages are exactly the decided wording", async () => {
    expect(PROGRAM_CHANGED).toBe("The Latch program changed since this app was checked — update the app before signing.");
    expect(PROGRAM_UNCHECKED).toBe("Couldn't check the Latch program right now — try again in a moment.");
    // and a real mismatch still uses the 'changed' message
    const e = await makeProgramGuard(async () => OTHER).assert().catch((x) => x);
    expect(e.message).toBe(PROGRAM_CHANGED);
    const { explainError } = await import("../src/lib/wallet");
    expect(explainError(new Error(PROGRAM_UNCHECKED))).toBe(PROGRAM_UNCHECKED);
    expect(explainError(new Error(PROGRAM_CHANGED))).toBe(PROGRAM_CHANGED);
  });
});

describe("every signing/funding/activating call goes through the guarded send (source scan)", () => {
  const { readFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const dir = new URL("../src/screens/", import.meta.url).pathname;
  const CALLS = /F\.(createAndSign|fund|signTerms|markShipped|confirmReady)\(/;
  it("DealPage: each such call sits in an action listed in SIGNS_AGREEMENT", () => {
    const src = readFileSync(dir + "DealPage.tsx", "utf8");
    const listed = JSON.parse(/SIGNS_AGREEMENT: Action\[\] = (\[[^\]]*\])/.exec(src)![1]);
    expect(listed).toEqual(expect.arrayContaining(["accept", "acceptAndPay", "pay", "markShipped", "confirmReady"]));
    expect(src).toMatch(/await \(SIGNS_AGREEMENT\.includes\(a\) \? sendAgreement : send\)\(await build\(\)\)/);
    const lines = src.split("\n").filter((l) => CALLS.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const l of lines) {
      const action = /(?:btn|run)\("(\w+)"/.exec(l)?.[1];
      expect(action, l.trim()).toBeDefined();
      expect(listed, l.trim()).toContain(action);
    }
  });
  it("other screens only call them inside the guarded send", () => {
    for (const f of readdirSync(dir).filter((f: string) => f.endsWith(".tsx") && f !== "DealPage.tsx")) {
      const src = readFileSync(dir + f, "utf8");
      for (const l of src.split("\n").filter((l: string) => CALLS.test(l))) {
        const guardedName = /const (\w+) = useAgreementSend\(\)/.exec(src)?.[1];
        expect(guardedName, `${f}: ${l.trim()}`).toBeDefined();
        expect(l, `${f}`).toContain(`${guardedName}(await F.`);
      }
    }
  });
});
