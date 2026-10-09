/**
 * Screenshot fixture (not a regular test): real Deal accounts in every state
 * the v0.6 screenshots need, created on the DEPLOYED program in LiteSVM at
 * real dates, then dumped for scripts/shots.mjs to serve through a mocked RPC.
 *   SHOTS_FIXTURE=1 npx vitest run test/shots-fixture.test.ts
 * Writes screenshots/v0.7/fixture.json (SHOTS_DIR to change). The v0.6 fixture
 * is kept: test/flows.test.ts decodes its accounts (made by the previous binary).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { address } from "@solana/kit";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { ASSETS, PROGRAM_ID, TOKEN_PROGRAM } from "../src/lib/config";
import { buildProtectedPayment } from "../src/lib/protected";
import { agreementSpec } from "../src/lib/agreementSpec";
import { encodeBlob, fieldsFromSpec, newNonce, renderAgreement, termsHash, type LinkBlob } from "../src/lib/template";
import { BN } from "@anchor-lang/core";

const DAY = 86400;
const usd = (n: number) => BigInt(Math.round(n * 1e6));

const DIR = process.env.SHOTS_DIR ?? "screenshots/v0.7";

describe.skipIf(!process.env.SHOTS_FIXTURE)("screenshot fixture", () => {
  it("generates the screenshot fixture", async () => {
    const c = new Chain();
    const now = Math.floor(Date.now() / 1000);
    const start = now - 4 * DAY;
    c.warp(start - c.now());
    const seed = (b: number) => Keypair.fromSeed(new Uint8Array(32).fill(b));
    const me = seed(7);
    const alex = seed(8);
    const sam = seed(9);
    const jordan = seed(10);
    for (const k of [me, alex, sam, jordan]) c.svm.airdrop(address(k.publicKey.toBase58()), 50_000_000_000n as any);

    // Devnet USDC's address, so the app recognises the asset (freeze authority like Circle's).
    const tmp = c.mint(alex);
    const USDC = ASSETS.USDC.mint;
    const m = c.svm.getAccount(address(tmp.toBase58())) as any;
    c.svm.setAccount({ ...m, address: address(USDC.toBase58()) });
    for (const k of [me, alex, sam, jordan]) c.mintTo(USDC, alex, k.publicKey, usd(5000));
    const asset = ASSETS.USDC;

    const links: Record<string, string> = {};
    const deals: Record<string, string> = {};
    let id = 1000n;
    const protectedDeal = async (name: string, creator: Keypair, payer: Keypair, payee: Keypair, amount: number, presetId: "inperson" | "shipped" | "work", subject: string) => {
      const { spec, blob, deal } = buildProtectedPayment({ creator: creator.publicKey, payer: payer.publicKey, payee: payee.publicKey, raw: usd(amount), asset, presetId, dealId: id++, subject });
      c.send(await F.createAndSign(spec, false), creator);
      links[deal.toBase58()] = encodeBlob(blob);
      deals[name] = deal.toBase58();
      return deal;
    };
    const other = (payer: Keypair, payee: Keypair, creator: Keypair) => (creator.publicKey.equals(payer.publicKey) ? payee : payer);

    // D1: Alex wants to pay me (I'm the payee, haven't accepted) → recipient accept screen.
    await protectedDeal("accept", alex, alex, me, 120, "shipped", "Used road bike");
    // D2: request flow — I'm the payer, I created it, Sam accepted → I must come back to pay in.
    const d2 = await protectedDeal("payIn", me, me, sam, 80, "shipped", "Vintage lamp");
    c.send([await F.signTerms(d2, sam.publicKey, false)], sam);
    // D3: I paid in a day ago; Jordan hasn't shipped → payer Funded view.
    const d3 = await protectedDeal("funded", me, me, jordan, 45, "shipped", "Concert tickets x2");
    c.send([await F.signTerms(d3, jordan.publicKey, false)], jordan);
    // D7: work preset, I'm the payee and the payer funded → "Start the clock — work has begun".
    const d7 = await protectedDeal("workPayee", alex, alex, me, 600, "work", "Logo and brand kit");
    c.send([await F.signTerms(d7, me.publicKey, false)], me);
    // D4: Active, shipped two days ago (payer view).
    const d4 = await protectedDeal("active", me, me, alex, 250, "shipped", "Mechanical keyboard");
    c.send([await F.signTerms(d4, alex.publicKey, false)], alex);
    c.send(await F.fund(c.deal(d4), me.publicKey), me);
    // D6: paused by me.
    const d6 = await protectedDeal("paused", me, me, sam, 300, "shipped", "Camera lens");
    c.send([await F.signTerms(d6, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(d6), me.publicKey), me);
    // D5: custom AutoSplit (Builder), Active.
    const spec5 = agreementSpec({ creator: me.publicKey, dealId: id++, role: "payer", other: jordan.publicKey, amounts: [usd(400)], settle: "split", windowDays: 10, splitPct: 50, decider: null, backup: null, backupDelayDays: 3, asset } as any);
    const d5 = F.dealAddress(me.publicKey, spec5.dealId);
    const blob5: LinkBlob = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 3, milestones: [""] }, s: "Standing desk", n: "0123456789abcdef0123456789abcdef" };
    const text5 = renderAgreement(fieldsFromSpec(spec5, d5, 6, asset.knownRiskFlags), blob5);
    c.send(await F.createAndSign({ ...spec5, termsHash: termsHash(text5) }, false), me);
    links[d5.toBase58()] = encodeBlob(blob5);
    deals.autoSplit = d5.toBase58();
    c.send([await F.signTerms(d5, jordan.publicKey, false)], jordan);
    c.send(await F.fund(c.deal(d5), me.publicKey), me);

    // ---- v0.7 deals ----------------------------------------------------
    const txs: Record<string, any> = {};
    const builderDeal = async (name: string, creator: Keypair, other: Keypair, role: "payer" | "payee", policy: any, days: number, subject: string, settle: "timer" | "split" = "timer", backup?: Keypair) => {
      const spec0 = agreementSpec({ creator: creator.publicKey, dealId: id++, role, other: other.publicKey, amounts: [usd(role === "payer" ? 240 : 240)], settle, windowDays: 10, splitPct: 30, decider: null, backup: backup?.publicKey ?? null, backupDelayDays: 3, asset, disputePolicy: policy, disputeDays: days } as any);
      const addr = F.dealAddress(creator.publicKey, spec0.dealId);
      const blob: LinkBlob = { t: "goods-sale@2", p: { condition: "used-good", inspection_days: 2, milestones: [""] }, s: subject, n: newNonce() };
      const text = renderAgreement(fieldsFromSpec(spec0, addr, 6, asset.knownRiskFlags), blob);
      c.send(await F.createAndSign({ ...spec0, termsHash: termsHash(text) }, false), creator);
      links[addr.toBase58()] = encodeBlob(blob);
      deals[name] = addr.toBase58();
      return addr;
    };
    // Split after 1 day: I pay Jordan; Jordan paused 4 days ago → expired, anyone can settle.
    const dSplit = await builderDeal("policySplit", me, jordan, "payer", "Split", 1, "Bookshelf");
    c.send([await F.signTerms(dSplit, jordan.publicKey, false)], jordan);
    c.send(await F.fund(c.deal(dSplit), me.publicKey), me);
    c.send(await F.markShipped(c.deal(dSplit), jordan.publicKey, false), jordan);
    c.send(await F.pause(dSplit, jordan.publicKey), jordan);
    // ResumeRule after 1 day: Alex pays me; Alex pauses two days ago → anyone can end it.
    const dResume = await builderDeal("policyResume", alex, me, "payer", "ResumeRule", 1, "Garden table");
    c.send([await F.signTerms(dResume, me.publicKey, false)], me);
    c.send(await F.fund(c.deal(dResume), alex.publicKey), alex);
    c.send(await F.markShipped(c.deal(dResume), me.publicKey, false), me);
    // RefundPayer after 7 days, Active (I pay Sam) → pause sheet with the limit; c4 agreement view.
    const dRefundPolicy = await builderDeal("policyActive", me, sam, "payer", "RefundPayer", 7, "Drum kit");
    c.send([await F.signTerms(dRefundPolicy, sam.publicKey, false)], sam);
    c.send(await F.fund(c.deal(dRefundPolicy), me.publicKey), me);
    // Payee refund: Alex pays me, Active → "Refund Alex" + its sheet.
    const dRefundable = await protectedDeal("refundable", alex, alex, me, 150, "shipped", "Espresso machine");
    c.send([await F.signTerms(dRefundable, me.publicKey, false)], me);
    c.send(await F.fund(c.deal(dRefundable), alex.publicKey), alex);
    // Refunded: I pay Jordan; Jordan refunds me (one day ago, below).
    const dRefunded = await protectedDeal("refunded", me, me, jordan, 45, "shipped", "Vinyl box set");
    c.send([await F.signTerms(dRefunded, jordan.publicKey, false)], jordan);
    c.send(await F.fund(c.deal(dRefunded), me.publicKey), me);

    // Two days ago: shipped / ready on D4, D5, D6.
    c.warp(now - 2 * DAY - c.now());
    c.send(await F.markShipped(c.deal(d4), alex.publicKey, false), alex);
    c.send(await F.markShipped(c.deal(d5), jordan.publicKey, false), jordan);
    c.send(await F.markShipped(c.deal(d6), sam.publicKey, false), sam);
    c.send(await F.pause(dResume, alex.publicKey), alex);
    c.send(await F.markShipped(c.deal(dRefundPolicy), sam.publicKey, false), sam);
    c.send(await F.markShipped(c.deal(dRefundable), me.publicKey, false), me);
    // One day ago: I paid into D3; Alex paid into D7; I paused D6.
    c.warp(now - 1 * DAY - c.now());
    c.send(await F.fund(c.deal(d3), me.publicKey), me);
    c.send(await F.fund(c.deal(d7), alex.publicKey), alex);
    c.send(await F.pause(d6, me.publicKey), me);
    // v0.7, one day ago: Jordan refunds me; a partly paid-in request answer; a hostile policy; a pre-start recovery proposal.
    c.send(await F.refundByPayee(c.deal(dRefunded), jordan.publicKey), jordan);
    {
      const j = c.lastTxJson;
      j.slot = 1;
      txs[dRefunded.toBase58()] = j;
    }
    const dPartial = await protectedDeal("partial", me, me, sam, 80, "shipped", "Desk lamp pair");
    c.send([await F.signTerms(dPartial, sam.publicKey, false)], sam);
    {
      const d = c.deal(dPartial);
      const ix = await F.latchProgram()
        .methods.deposit(new BN(usd(30).toString()))
        .accounts({ payer: me.publicKey, deal: dPartial, mint: USDC, vault: d.vault, payerTokenAccount: F.ata(me.publicKey, USDC), tokenProgram: d.tokenProgram } as any)
        .instruction();
      c.send([ix], me);
    }
    // Hostile: Alex "pays" me with RefundPayer after 1 day, fingerprinted as if there were no policy.
    {
      const { spec, blob, deal } = buildProtectedPayment({ creator: alex.publicKey, payer: alex.publicKey, payee: me.publicKey, raw: usd(500), asset, presetId: "shipped", dealId: id++, subject: "Laptop" });
      const [create, sign] = await F.createAndSign(spec, false);
      c.send([create, await F.setDisputePolicyIx(deal, alex.publicKey, "RefundPayer", DAY), sign], alex);
      links[deal.toBase58()] = encodeBlob(blob);
      deals.hostile = deal.toBase58();
    }
    // Pre-start recovery: Alex pays me with Jordan as backup; Jordan and Alex sign a division while Funded.
    {
      const dRec = await builderDeal("recoveryFunded", alex, me, "payer", "NeverExpire", 0, "Road bike frame", "timer", jordan);
      c.send([await F.signTerms(dRec, me.publicKey, false)], me);
      c.send(await F.fund(c.deal(dRec), alex.publicKey), alex);
      c.send(await F.recoverySign(dRec, jordan.publicKey, usd(100)), jordan);
      c.send(await F.recoverySign(dRec, alex.publicKey, usd(100)), alex);
    }

    const accounts: Record<string, { data: string; owner: string; lamports: number }> = {};
    const put = (k: PublicKey) => {
      const a: any = c.svm.getAccount(address(k.toBase58()));
      if (!a?.exists) return;
      accounts[k.toBase58()] = { data: Buffer.from(a.data).toString("base64"), owner: String(a.programAddress), lamports: Number(a.lamports) };
    };
    put(USDC);
    for (const d of Object.values(deals)) {
      put(new PublicKey(d));
      put(c.deal(new PublicKey(d)).vault);
    }
    for (const k of [me, alex, sam, jordan]) put(getAssociatedTokenAddressSync(USDC, k.publicKey, true, TOKEN_PROGRAM));
    const contacts = Object.fromEntries(
      [
        [alex, "Alex"],
        [sam, "Sam"],
        [jordan, "Jordan"],
      ].map(([k, name]) => [(k as Keypair).publicKey.toBase58(), { address: (k as Keypair).publicKey.toBase58(), name, createdAt: now - 30 * DAY }]),
    );
    // A protected request from Sam to me ($95, Shipped), as Sam's app would share it.
    const { protectedBlob } = await import("../src/lib/protected");
    const { encodeRequest } = await import("../src/lib/request");
    const reqBlob = protectedBlob("shipped", "Record player", "fedcba9876543210fedcba9876543210");
    const requestLink = encodeRequest({ to: sam.publicKey.toBase58(), amount: usd(95).toString(), asset: "USDC", k: encodeBlob(reqBlob) });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      `${DIR}/fixture.json`,
      JSON.stringify({ generatedAt: now, program: PROGRAM_ID.toBase58(), me: me.publicKey.toBase58(), people: { alex: alex.publicKey.toBase58(), sam: sam.publicKey.toBase58(), jordan: jordan.publicKey.toBase58() }, requestLink, deals, accounts, txs, local: { contacts, links } }, null, 1),
    );
  }, 120_000);
});
