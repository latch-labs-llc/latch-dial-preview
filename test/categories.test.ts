/** v0.10 #4: Protected categories are a UI layer over the three presets; the other two push into Custom pre-filled. */
import { describe, expect, it } from "vitest";
import { CATEGORIES, PRESETS } from "../src/lib/config";
import { COPY } from "../src/lib/copy";
import { presetFromParams } from "../src/lib/protected";

describe("Protected categories", () => {
  it("every category has a summary; preset-backed ones round-trip the request-link shape; builder-backed ones name a template and a rule", () => {
    for (const c of CATEGORIES) {
      expect(COPY.categorySummary[c.id], c.id).toBeTruthy();
      if ("preset" in c) {
        const p = PRESETS.find((x) => x.id === c.preset)!;
        expect(p).toBeTruthy();
        expect(presetFromParams({ preset: p.id, window_days: p.days })).toBe(p.id);
      } else {
        expect(["deposit", "vehicle"]).toContain(c.builder.tpl);
        expect(["TimeoutRefund", "TimeoutRelease"]).toContain(c.builder.rule);
        expect(Number(c.builder.days)).toBeGreaterThan(0);
      }
    }
    expect(CATEGORIES.filter((c) => "preset" in c).map((c) => c.preset)).toEqual(PRESETS.map((p) => p.id));
  });
});
