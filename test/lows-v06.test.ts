/** v0.6 #9: lows. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/lib/copy";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("v0.6 #9: lows", () => {
  it("'not returned in this version' (no 'in v1')", () => {
    expect(COPY.costProtected("0.01")).toBe("No Latch fee · network deposit ≈0.01 SOL (not returned in this version)");
    expect(read("src/screens/HowItWorks.tsx")).not.toMatch(/in v1/);
    expect(read("src/lib/copy.ts")).not.toMatch(/in v1/);
  });
  it("Instant's compare-sheet cost includes a new token account", () => {
    expect(read("src/screens/HowItWorks.tsx")).toContain('"< 0.001 SOL, +≈0.002 SOL if a new token account"');
  });
  it("the payer's Funded view shows time since paying in; the recipient's accept screen says no Latch fee", () => {
    const page = read("src/screens/DealPage.tsx");
    expect(COPY.paidInAgo("1 d 0 h")).toBe("You paid in 1 d 0 h ago.");
    expect(page).toContain("COPY.paidInAgo(duration(now - d.fundedAt))");
    expect(COPY.payeeNoFee).toBe("No Latch fee for you.");
    expect(page).toContain('v.role === "payee" && actions.includes("accept") && <div className="caption" style={{ textAlign: "center" }}>{COPY.payeeNoFee}');
  });
  it("README labels this repo's count as dial client tests, distinct from the main Latch repo", () => {
    expect(read("README.md")).toMatch(/# \d+ dial client tests \(this repo only — not the main Latch repo's suite\)/);
  });
});
