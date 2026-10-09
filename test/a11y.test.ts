/** v0.6 #8: accessibility fixes. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dial } from "../src/components/ui";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

describe("v0.6 #8: a11y", () => {
  it("Dial labels itself with useId (no hard-coded id) and RequestMoney reuses it", () => {
    const ui = src("components/ui.tsx");
    expect(ui).not.toContain('id="dial-label"');
    expect(ui).toContain("const labelId = useId()");
    expect(ui).toContain("aria-labelledby={labelId}");
    const req = src("screens/RequestMoney.tsx");
    expect(req).toContain("<Dial");
    expect(req).not.toMatch(/role="radiogroup"|role="radio"/);
  });
  it("two Dials on one page get distinct label ids; only the checked option is tabbable", () => {
    const opts = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    const html = renderToStaticMarkup(
      createElement("div", null, createElement(Dial<string>, { value: "b", onChange: () => {}, options: opts, label: "One" }), createElement(Dial, { value: "protected", onChange: () => {} })),
    );
    const ids = [...html.matchAll(/class="dial-label" id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(html).toContain(`aria-labelledby="${id}"`);
    expect(html).toMatch(/aria-checked="false" tabindex="-1">A<\/button><button role="radio" aria-checked="true" tabindex="0">B/);
  });
  it("the ⓘ button is a 44px target with a name", () => {
    expect(src("screens/Pay.tsx")).toContain('className="navbtn info-btn" aria-label="How protection works"');
    expect(src("styles/app.css")).toMatch(/\.info-btn \{[^}]*min-width: 44px; min-height: 44px;/);
  });
  it("the countdown has no role-less aria-label; its caption is the text", () => {
    const page = src("screens/DealPage.tsx");
    expect(page).not.toMatch(/className="ring" aria-label/);
    expect(page).toContain('viewBox="0 0 84 84" aria-hidden="true"');
  });
  it("v0.10: no emoji in the UI (icons are SVG and inherit colour); text symbols like ✓ are fine", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = new URL("../src/", import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    // Pictographs and the lightning bolt; the ⚠ text symbol in warnings stays.
    const emoji = /[\u{1F000}-\u{1FAFF}\u{26A1}]/u;
    for (const f of walk(dir).filter((f) => /\.tsx?$/.test(f))) {
      const bad = readFileSync(f, "utf8").split("\n").filter((l) => emoji.test(l));
      expect(bad, f).toEqual([]);
    }
  });
});
