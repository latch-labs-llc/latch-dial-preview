/** v0.6 #6: a request the payer answers has its own success screen and comes back pinned under Needs you. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/lib/copy";
import { pinPayIn } from "../src/lib/view";

describe("v0.6 #6: request flow", () => {
  it("own success copy; no 'send them this link' for requests", () => {
    expect(COPY.requestCreated("Sam")).toBe("Sam's app will find this payment. When they accept, come back here to pay in.");
    const pay = readFileSync(new URL("../src/screens/Pay.tsx", import.meta.url), "utf8");
    const i = pay.indexOf("{locked ? (");
    const branch = pay.slice(i, pay.indexOf(") : (", i));
    expect(branch).toContain("COPY.requestCreated(name)");
    expect(branch).not.toMatch(/this link|ShareSheet/);
  });
  it("'Pay in' deals are pinned first under Needs you", () => {
    const x = (id: string, actions: string[]) => ({ id, v: { actions } as any });
    expect(pinPayIn([x("a", ["markShipped"]), x("b", ["pay", "cancelTogether"]), x("c", ["release"]), x("d", ["pay"])]).map((y) => y.id)).toEqual(["b", "d", "a", "c"]);
    const act = readFileSync(new URL("../src/screens/Activity.tsx", import.meta.url), "utf8");
    expect(act).toContain("pinPayIn(views.filter((x) => x.v.needsYou && !x.v.done))");
  });
});
