/** v0.6 #5: the Work preset's 14 days run from the start of work, and the app says so. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { address } from "@solana/kit";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { ASSETS, PRESETS } from "../src/lib/config";
import { buildProtectedPayment, protectedBlob } from "../src/lib/protected";
import { encodeBlob } from "../src/lib/template";
import { COPY } from "../src/lib/copy";
import { isWorkDeal, viewDeal } from "../src/lib/view";

const local = (links: Record<string, string>): any => ({ contacts: {}, requests: {}, links, payments: [], hidden: [], blocked: [], attachments: {}, saved: {}, backupsFor: [], backedUp: [], settings: {} });

describe("v0.6 #5: Work preset", () => {
  it("chips: Work says 'from start'; the others don't", () => {
    expect(PRESETS.map(COPY.presetChip)).toEqual(["In person · 3 d", "Shipped · 10 d", "Work · 14 d from start"]);
    for (const f of ["Pay.tsx", "RequestMoney.tsx"]) expect(readFileSync(new URL(`../src/screens/${f}`, import.meta.url), "utf8")).toContain("COPY.presetChip(p)");
  });

  it("on the deployed program: a funded Work deal tells the payee to start the clock, with both deadlines", async () => {
    const c = new Chain();
    const alex = Keypair.generate();
    const me = Keypair.generate();
    for (const k of [alex, me]) c.svm.airdrop(address(k.publicKey.toBase58()), 10_000_000_000n as any);
    const mint = c.mint(alex);
    c.mintTo(mint, alex, alex.publicKey, 2_000_000_000n);
    const asset = { ...ASSETS.USDC, mint };
    const mk = async (presetId: "work" | "shipped", dealId: bigint) => {
      const { spec, blob, deal } = buildProtectedPayment({ creator: alex.publicKey, payer: alex.publicKey, payee: me.publicKey, raw: 600_000_000n, asset, presetId, dealId, subject: "Logo" });
      c.send(await F.createAndSign(spec, false), alex);
      c.send([await F.signTerms(deal, me.publicKey, false)], me);
      c.send(await F.fund(c.deal(deal), alex.publicKey), alex);
      return { deal, link: encodeBlob(blob) };
    };
    const w = await mk("work", 1n);
    const s = await mk("shipped", 2n);
    const L = local({ [w.deal.toBase58()]: w.link, [s.deal.toBase58()]: s.link });
    const dw = c.deal(w.deal);
    expect(isWorkDeal(dw, L)).toBe(true);
    expect(isWorkDeal(c.deal(s.deal), L)).toBe(false);
    // A Work link pasted onto a deal whose on-chain window isn't 14 days is not trusted for wording.
    expect(isWorkDeal(c.deal(s.deal), local({ [s.deal.toBase58()]: encodeBlob(protectedBlob("work", "Logo")) }))).toBe(false);

    const v = viewDeal(dw, me.publicKey, L, c.now());
    expect(v.actions).toContain("markShipped");
    expect(v.sentence).toMatch(/^.* paid .* in\. Start the clock when work begins — by /);
    expect(viewDeal(c.deal(s.deal), me.publicKey, L, c.now()).sentence).toMatch(/Mark as shipped BEFORE you ship/);

    const banner = COPY.payeeFundedWork("Alex", "Thu, Oct 8", "Mon, Oct 19", 14);
    expect(banner).toContain("by Thu, Oct 8");
    expect(banner).toContain("The 14 days run from the start, not from delivery");
    expect(banner).toContain("collectable by you on Mon, Oct 19");
    expect(COPY.startWorkButton).toBe("Start the clock — work has begun");
    expect(COPY.heldUntil("Sam", 14, true)).toContain("14 days after Sam starts the clock");
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("work ? COPY.startWorkButton");
    expect(page).toContain("COPY.payeeFundedWork(");
    expect(readFileSync(new URL("../src/screens/Pay.tsx", import.meta.url), "utf8")).toContain("after they start the clock — not after delivery.");
    expect(page).toContain(`work ? " from the start of work" : " from “shipped”"`);
  });
});

describe("v0.7 #7: Work deals' progress step", () => {
  it("says 'Started', not 'Shipped'", () => {
    const page = readFileSync(new URL("../src/screens/DealPage.tsx", import.meta.url), "utf8");
    expect(page).toContain('{ l: work ? "Started" : "Shipped", done: ["Active", "Deadlocked", "Completed"].includes(d.state) }');
  });
});
