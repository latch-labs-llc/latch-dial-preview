/**
 * v0.6 #7: @usernames and Telegram linking are labelled "Preview" by default.
 * A build whose service is live sets VITE_IDENTITY_LIVE=1 (CI does, since
 * v0.12); the flag reaches these tests too, so the live assertions follow it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IDENTITY_PREVIEW } from "../src/lib/config";
import { COPY } from "../src/lib/copy";
import { TG_BADGE } from "../src/lib/service";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

describe("v0.6 #7: identity features are Preview", () => {
  const live = process.env.VITE_IDENTITY_LIVE === "1";
  it("is on unless a build sets VITE_IDENTITY_LIVE=1", () => {
    expect(IDENTITY_PREVIEW).toBe(!live);
    expect(src("lib/config.ts")).toContain('env.VITE_IDENTITY_LIVE !== "1"');
  });
  it("labels the Profile and Telegram sections, the Telegram badge, the username row and the recipient field", () => {
    const prof = src("screens/ProfileSections.tsx");
    expect(prof).toContain('header={<PreviewHeader title="Profile" />}');
    expect(prof).toContain('header={<PreviewHeader title="Telegram" />}');
    expect(prof.match(/IDENTITY_PREVIEW \? COPY\.previewNote/g)).toHaveLength(2);
    expect(COPY.previewNote).toMatch(/data-retention and legal-requests pages are live on a deployed Latch service/);
    expect(TG_BADGE).toBe(live ? "linked via Latch service" : "linked via Latch service · Preview");
    expect(src("screens/UserPage.tsx")).toContain('IDENTITY_PREVIEW ? " · Preview"');
    for (const f of ["screens/Pay.tsx", "screens/AddContact.tsx"]) expect(src(f)).toContain("@username / tg:@telegram (preview)");
  });
});
