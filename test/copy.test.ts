/**
 * Copy discipline: banned words must not appear in any user-facing string in
 * src/ (comments are stripped first; the ban list itself is exempt).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_PHRASES, BANNED_WORDS, COPY } from "../src/lib/copy";
import { chooseDefault, findLookAlike, riskSignals } from "../src/lib/policy";
import { canonSubject, decodeBlob, encodeBlob, newNonce } from "../src/lib/template";

const ROOT = new URL("..", import.meta.url).pathname;
const rel = (f: string) => f.slice(ROOT.length);

/**
 * Explicit exceptions (v0.6 #1). Each names the file, the exact text, and
 * why it may stay. A stale entry (text no longer present) fails the test.
 */
const ALLOWED: { file: string; text: string; why: string }[] = [
  { file: "src/lib/template.ts", text: "Rule: AUTOMATIC SPLIT.", why: "signed agreement text (format c3): changing it needs a new format id" },
  { file: "src/lib/template.ts", text: "There is NO automatic unlock by time under this rule.", why: "signed agreement text, and a negation" },
  { file: "src/lib/templateC1.ts", text: "Rule: AUTOMATIC SPLIT.", why: "frozen v0.2 signed text (verify-only)" },
  { file: "src/lib/templateC1.ts", text: "There is NO automatic unlock by time under this rule.", why: "frozen v0.2 signed text (verify-only)" },
  { file: "src/lib/copy.ts", text: "No automatic unlock — the person you both name decides", why: "negation" },
  { file: "src/screens/DealPage.tsx", text: "Someone you both named decides — no automatic unlock", why: "negation" },
  { file: "src/screens/Builder.tsx", text: 'FCA: "Free Carrier"', why: "official Incoterms 2020 rule names (v0.8 #5)" },
  { file: "src/screens/Builder.tsx", text: 'FAS: "Free Alongside Ship", FOB: "Free on Board"', why: "official Incoterms 2020 rule names (v0.8 #5)" },
  { file: "BUILD-NOTES.md", text: 'the copy test bans "free", and "Free Carrier"/"Free on Board" are the', why: "v0.8 judgment call quotes the ban and the Incoterm names" },
  { file: "BUILD-NOTES.md", text: 'Judgment calls: "Automatic split" is the rule', why: "v0.9 judgment call quotes the banned phrase it renamed" },
  { file: "BUILD-NOTES.md", text: '"money back" is on the copy ban list.', why: "quotes the ban list" },
  { file: "BUILD-NOTES.md", text: 'not "take the money back", because', why: "quotes the banned form" },
  { file: "BUILD-NOTES.md", text: 'and a test bans "escrow", "free", "court-ready",', why: "quotes the ban list" },
  { file: "BUILD-NOTES.md", text: '"open standard", etc. across `src/`.', why: "quotes the ban list" },
  { file: "BUILD-NOTES.md", text: "| 1 | Copy test gaps. | BANNED_WORDS + safe", why: "v0.6 table quotes the ban list" },
  { file: "BUILD-NOTES.md", text: '| 2 | "Held until it\'s received" (false', why: "v0.6 table quotes the finding" },
  { file: "BUILD-NOTES.md", text: '1. **Signed template text keeps "Rule: AUTOMATIC SPLIT."', why: "quotes the allowlisted template lines" },
];

function files(dir: string, re = /\.(tsx?|css)$/): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, re) : re.test(p) ? [p] : [];
  });
}

/** Code: comments and the ban/reserved lists are not user copy. */
const stripCode = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/export const BANNED_WORDS[\s\S]*?\];/, "")
    .replace(/export const BANNED_PHRASES = .*$/m, "")
    .replace(/^const RESERVED_(BRANDS|ROLES) = .*$/gm, ""); // reserved-username ban lists, not user copy
const stripHtml = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const strip = stripCode;
const noSafeArea = (s: string) => s.replace(/safe-area[-\w]*/gi, ""); // CSS env(safe-area-inset-*) is not copy

const TARGETS: [string, (s: string) => string][] = [
  ...files(ROOT + "src").map((f) => [f, stripCode] as [string, (s: string) => string]),
  ...files(ROOT + "worker/src").map((f) => [f, stripCode] as [string, (s: string) => string]),
  ...["README.md", "BUILD-NOTES.md", "HOSTING.md", "DATA-AND-RETENTION.md", "index.html", "public/manifest.webmanifest"].map((f) => [ROOT + f, stripHtml] as [string, (s: string) => string]),
];

function hits(file: string, strip: (s: string) => string): string[] {
  const out: string[] = [];
  const allowed = ALLOWED.filter((a) => a.file === rel(file));
  for (const line of noSafeArea(strip(readFileSync(file, "utf8"))).split("\n")) {
    const lower = line.toLowerCase();
    const bad = [
      ...BANNED_WORDS.filter((w) => new RegExp(`\\b${w.replace(/[-\s]/g, "[-\\s]")}\\b`).test(lower)).map((w) => `"${w}"`),
      ...BANNED_PHRASES.filter((r) => r.test(line)).map(String),
      ...(/\bl2\b/.test(lower) ? ['"L2"'] : []),
    ];
    if (bad.length && !allowed.some((a) => line.includes(a.text))) out.push(`${bad.join(", ")} in: ${line.trim().slice(0, 120)}`);
  }
  return out;
}

describe("copy discipline", () => {
  for (const [f, strip] of TARGETS) {
    it(`no banned words or phrases in ${rel(f)}`, () => {
      expect(hits(f, strip)).toEqual([]);
    });
  }
  it("every allowlist entry is still needed", () => {
    for (const a of ALLOWED) expect(readFileSync(ROOT + a.file, "utf8"), `${a.file}: ${a.text}`).toContain(a.text);
  });
  it("the scanner catches what it should (and ignores CSS safe-area)", () => {
    const probe = (t: string) => hits(writeTmp(t), (s) => s);
    expect(probe("It's totally safe.")).toHaveLength(1);
    expect(probe("Evidence is admissible in court")).toHaveLength(1);
    expect(probe("judicially noticeable record")).toHaveLength(1);
    expect(probe("Buyer Protection program")).toHaveLength(1);
    expect(probe("held until it's received")).toHaveLength(1);
    expect(probe("it splits automatically")).toHaveLength(0); // phrase is 'automatic split', checked next
    expect(probe("automatic split at the end")).toHaveLength(1);
    expect(probe("automatically released to Sam")).toHaveLength(1);
    expect(probe("refunded to you")).toHaveLength(1);
    expect(probe("padding: env(safe-area-inset-top)")).toHaveLength(0);
  });
});

function writeTmp(text: string): string {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const p = join(mkdtempSync(join(tmpdir(), "copy-")), "probe.txt");
  writeFileSync(p, text);
  return p;
}

describe("custody claims stay truthful while the program is upgradeable (A3)", () => {
  // Absolute custody claims that ignore upgradeability. Every user-facing
  // file is scanned; the custody line itself is the only allowed framing.
  const OVERCLAIMS = [
    /no one at latch can (decide, )?(refund or )?move/,
    /only the deal's rules can move/,
    /no latch labs key can move/,
    /gives no one at latch a way to move/,
    /latch can't touch/,
  ];
  // templateC1.ts is exempt: it must reproduce v0.2's signed text verbatim to verify old deals.
  for (const f of files(new URL("../src", import.meta.url).pathname).filter((f) => !f.endsWith("templateC1.ts"))) {
    it(`no absolute custody claim in ${f.split("/src/")[1]}`, () => {
      const text = strip(readFileSync(f, "utf8")).toLowerCase();
      for (const re of OVERCLAIMS) expect(re.test(text), `${re} found`).toBe(false);
    });
  }
  it("the custody line names both halves", () => {
    expect(COPY.custody).toBe("No instruction lets any Latch key move the money; on devnet the program can be upgraded by its maintainer.");
    for (const s of [COPY.welcomeBody, COPY.pausedNoOne, COPY.howItWorks[0].a, COPY.howItWorks[2].a]) expect(s).toContain(COPY.custody);
  });
});

describe("evidence-keyed default (R1 §6)", () => {
  const base = { isContact: false, completedPayments: 0, explicitInstant: false };
  it("unknown → Protected, recommended", () => {
    const c = chooseDefault(base, false);
    expect(c.mode).toBe("protected");
    expect(c.tag).toMatch(/Recommended/);
  });
  it("look-alike → Protected with Instant locked", () => {
    expect(chooseDefault({ ...base, lookAlikeOf: "x" }, false).instantLocked).toBe(true);
  });
  it("explicit per-contact Instant, but not above the threshold", () => {
    expect(chooseDefault({ ...base, isContact: true, explicitInstant: true }, false).mode).toBe("instant");
    expect(chooseDefault({ ...base, isContact: true, explicitInstant: true }, true).mode).toBe("protected");
  });
  it("paid before → last mode", () => {
    expect(chooseDefault({ ...base, completedPayments: 2, lastMode: "instant" }, false).mode).toBe("instant");
  });
  it("risk signals only fire for Instant", () => {
    const ev = { ...base };
    expect(riskSignals({ mode: "protected", evidence: ev, amountAboveThreshold: true, memo: "bike", openedFromLink: true })).toEqual([]);
    expect(riskSignals({ mode: "instant", evidence: ev, amountAboveThreshold: false, memo: "Used road bike", openedFromLink: false })).toEqual(["first-payment", "purchase-memo"]);
  });
  it("look-alike detection", () => {
    expect(findLookAlike("ABCDxxxxWXYZ", ["ABCDyyyyWXYZ"])).toBe("ABCDyyyyWXYZ");
    expect(findLookAlike("ABCDxxxxWXYZ", ["ABCDxxxxWXYZ"])).toBeUndefined();
  });
});

describe("template v2 link blob", () => {
  it("round-trips and canonicalizes the subject", () => {
    const blob = { t: "goods-sale@2" as const, p: { condition: "new", inspection_days: 2, milestones: [""] }, s: "  Café́  bike ", n: newNonce() };
    const back = decodeBlob(encodeBlob(blob))!;
    expect(back.s).toBe(canonSubject(blob.s));
    expect(back.n).toHaveLength(32);
  });
  it("rejects garbage", () => {
    expect(decodeBlob("not-a-blob")).toBeNull();
  });
});



describe("v0.6 #2: no undated 'held until' promises", () => {
  it("'held until you're happy' / 'until it's received' / 'splits automatically' are gone from the app and README", () => {
    const files = [...(function walk(d: string): string[] {
      return readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : /\.(tsx?)$/.test(p) ? [p] : [];
      });
    })(new URL("../src", import.meta.url).pathname), new URL("../README.md", import.meta.url).pathname];
    for (const f of files) {
      const t = readFileSync(f, "utf8").toLowerCase();
      expect(t, f).not.toMatch(/until (you're|they're) happy|until it's received|splits automatically/);
    }
  });
  it("the replacement sentences carry the rule and a date", async () => {
    const { COPY } = await import("../src/lib/copy");
    expect(COPY.heldUntil("Sam", 10)).toBe("Held until you say it's OK — or 10 days after Sam marks it shipped, unless you pause the clock.");
    expect(COPY.splitsOn("Tue, Oct 13")).toBe("Splits on Tue, Oct 13 — anyone can carry it out.");
    expect(COPY.splitsAfter(10)).toBe("Splits 10 days after it's marked shipped — anyone can carry it out.");
    expect(readFileSync(new URL("../src/screens/Pay.tsx", import.meta.url), "utf8")).toContain("COPY.heldUntil(name, days, preset === \"work\")");
    expect(readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8")).toContain("COPY.splitsOn(absTime(v.unlock))");
  });
});

describe("v0.6 #3: pause copy states every rule, for whichever party paused", () => {
  const RULES = [/no time limit/i, /moves only when you (both|and \w+) sign the same split/i, /restarts the clock toward/i];
  it("pauseRules, pauseSheet and both banner variants carry each rule", async () => {
    const { COPY, CUSTODY } = await import("../src/lib/copy");
    const texts = {
      rules: COPY.pauseRules("Sam"),
      sheet: COPY.pauseSheet("Sam", "Sam"),
      bannerMe: COPY.pausedBanner(true, "You", "Sam", "Sam") + " " + COPY.pausedNoOne,
      bannerThem: COPY.pausedBanner(false, "Sam", "Sam", "you") + " " + COPY.pausedNoOne,
    };
    for (const [k, t] of Object.entries(texts)) {
      for (const r of RULES) expect(t, k).toMatch(r);
      expect(t, k).toContain(CUSTODY);
    }
    expect(texts.rules).toMatch(/only whoever paused can resume/i);
    expect(texts.sheet).toMatch(/only you can resume/i);
    expect(texts.bannerMe).toMatch(/^You paused the clock.*Only you can resume/);
    expect(texts.bannerThem).toMatch(/^Sam paused the clock.*Only Sam can resume/);
    expect(COPY.pauseLine).toMatch(/either of you can pause/i);
    expect(COPY.pauseLine).toMatch(/no time limit/i);
  });
  it("the screens use them", () => {
    const deal = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(deal).toContain("COPY.pauseSheet(");
    expect(deal).toContain("COPY.pausedBanner(");
    expect(readFileSync(new URL("../src/screens/Pay.tsx", import.meta.url), "utf8")).toContain("COPY.pauseRules(name)");
  });
});

describe("v0.6 #4: How it works", () => {
  it("says collectable, not 'gets it', and warns that protected payments have no backup signers", async () => {
    const { COPY } = await import("../src/lib/copy");
    const all = COPY.howItWorks.map((x) => x.a).join(" ");
    expect(all).toContain("becomes collectable by the recipient: anyone can send it to them");
    expect(all).not.toMatch(/gets it/);
    expect(all).toContain("Protected payments have no backup signers — if you lose your wallet while paused, it stays locked.");
  });
});
