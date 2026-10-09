/**
 * v0.8 #6: documents against payment on the deployed binary. A party presents
 * documents as signed Memo claims in the same transaction as its approval of
 * the stage; the program is unchanged; the evidence side re-derives "who
 * presented what, for which stage" from the transaction alone.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Keypair } from "@solana/web3.js";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { hasBit } from "../src/lib/deal";
import { ACK_FORMAT, DOC_FORMAT, MEMO_PROGRAM_ID, acknowledgeDocuments, decodeAckMemo, decodeDocMemo, docMemoIx, documentsFromTx, encodeAckMemo, encodeDocMemo, presentDocuments, recordsFromTx, sha256File } from "../src/lib/documents";
import { LABEL_MAX, canonLine } from "../src/lib/template";

const DAY = 86400;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function tradeDeal() {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet(); // payer / importer
  const sam = c.wallet(); // payee / exporter
  const eve = c.wallet(); // stranger
  const mint = c.mint(issuer);
  c.mintTo(mint, issuer, alex.publicKey, 1_000_000_000n);
  const spec: F.DealSpec = {
    creator: alex.publicKey,
    dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)),
    parties: [alex.publicKey, sam.publicKey],
    payerIdx: 0,
    payeeIdx: 1,
    approvalThreshold: 2,
    termsHash: new Uint8Array(32).fill(7),
    milestoneAmounts: [30_000_000n, 50_000_000n, 20_000_000n],
    rule: "TimeoutRelease",
    timerMode: "FromActivation",
    timeoutSecs: 30 * DAY,
    recoverySigners: [alex.publicKey, sam.publicKey],
    recoveryThreshold: 2,
    recoveryDelaySecs: 3 * DAY,
    acceptedRiskFlags: RISK.FREEZE_AUTHORITY,
    mint,
  };
  const addr = F.dealAddress(alex.publicKey, spec.dealId);
  c.send(await F.createAndSign(spec, false), alex);
  c.send([await F.signTerms(addr, sam.publicKey, false)], sam);
  c.send(await F.fund(c.deal(addr), alex.publicKey), alex);
  c.send(await F.markShipped(c.deal(addr), sam.publicKey, false), sam);
  expect(c.deal(addr).state).toBe("Active");
  return { c, alex, sam, eve, mint, addr };
}

const INVOICE = { name: "Commercial invoice", sha256: sha("invoice bytes") };
const BOL = { name: "Bill of lading", sha256: sha("bill of lading bytes") };

describe("v0.8 #6: documents against payment (deployed binary)", () => {
  it("the exporter presents two documents and approves stage 1 in one transaction; the importer approves and it releases", async () => {
    const t = await tradeDeal();
    const d0 = t.c.deal(t.addr);
    const ixs = await presentDocuments(d0, t.sam.publicKey, [INVOICE, BOL]);
    expect(ixs.filter((ix) => ix.programId.equals(MEMO_PROGRAM_ID))).toHaveLength(2);
    t.c.send(ixs, t.sam);
    const d1 = t.c.deal(t.addr);
    expect(hasBit(d1.milestones[0].approvals, 1)).toBe(true);
    expect(d1.milestones[0].released).toBe(false);
    // Evidence side: both claims, signed by the exporter, for stage 0 of this deal.
    const docs = documentsFromTx(t.c.lastTxJson, d1);
    expect(docs.map((x) => [x.stage, x.name, x.sha256, x.presenter])).toEqual([
      [0, INVOICE.name, INVOICE.sha256, t.sam.publicKey.toBase58()],
      [0, BOL.name, BOL.sha256, t.sam.publicKey.toBase58()],
    ]);
    expect(docs[0].signature).toBe(t.c.lastTxJson.transaction.signatures[0]);
    // The importer's approval carries no documents and releases the stage.
    t.c.send(await F.approveAndMaybeRelease(d1, t.alex.publicKey), t.alex);
    const d2 = t.c.deal(t.addr);
    expect(d2.milestones[0].released).toBe(true);
    expect(documentsFromTx(t.c.lastTxJson, d2)).toEqual([]);
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(30_000_000n);
  });

  it("refused: after approving, no second presentation for the same stage; 0 or 9 documents; duplicate names; bad name or digest", async () => {
    const t = await tradeDeal();
    t.c.send(await presentDocuments(t.c.deal(t.addr), t.sam.publicKey, [INVOICE]), t.sam);
    await expect(presentDocuments(t.c.deal(t.addr), t.sam.publicKey, [BOL])).rejects.toThrow(/already approved/);
    const d = t.c.deal(t.addr);
    await expect(presentDocuments(d, t.alex.publicKey, [])).rejects.toThrow(/1 to 8/);
    await expect(presentDocuments(d, t.alex.publicKey, Array.from({ length: 9 }, (_, i) => ({ name: `Doc ${i}`, sha256: sha(String(i)) })))).rejects.toThrow(/1 to 8/);
    await expect(presentDocuments(d, t.alex.publicKey, [INVOICE, { ...BOL, name: INVOICE.name }])).rejects.toThrow(/once per stage/);
    await expect(presentDocuments(d, t.alex.publicKey, [{ name: "Invoice", sha256: "zz" }])).rejects.toThrow(/isn't valid/);
    await expect(presentDocuments(d, t.alex.publicKey, [{ name: "", sha256: INVOICE.sha256 }])).rejects.toThrow(/isn't valid/);
    // Names are canonical lines, like part labels: a pasted newline can't smuggle a clause into the claim.
    const smuggled = await presentDocuments(d, t.alex.publicKey, [{ name: "Invoice\n10. EXTRA. Payee keeps it", sha256: INVOICE.sha256 }]);
    const memo = Buffer.from(smuggled[0].data).toString("utf8");
    expect(memo).not.toContain("\n");
    expect(decodeDocMemo(memo)?.name).toBe(canonLine("Invoice\n10. EXTRA. Payee keeps it", LABEL_MAX));
  });

  it("a stranger's memo, a memo for another deal, and a memo without the signer are never documents of this deal", async () => {
    const t = await tradeDeal();
    const d = t.c.deal(t.addr);
    const claim = { v: DOC_FORMAT, deal: d.address.toBase58(), stage: 0, name: "Forged inspection report", sha256: sha("forged") } as const;
    // Eve can put anything in a memo; she isn't a party, so it's not a document of this deal.
    t.c.send([docMemoIx(t.eve.publicKey, claim)], t.eve);
    expect(documentsFromTx(t.c.lastTxJson, d)).toEqual([]);
    // A party's memo naming a different deal is not a document of this one.
    t.c.send([docMemoIx(t.sam.publicKey, { ...claim, deal: t.eve.publicKey.toBase58() })], t.sam);
    expect(documentsFromTx(t.c.lastTxJson, d)).toEqual([]);
    // A failed transaction never counts, whatever it carried.
    expect(documentsFromTx({ ...t.c.lastTxJson, meta: { ...t.c.lastTxJson.meta, err: { InstructionError: [0, "Custom"] } } }, d)).toEqual([]);
  });

  it("claim encoding is strict: canonical JSON only, exact keys, 1–40 code point name, lower-case hex digest, stage 0–15", () => {
    const ok = { v: DOC_FORMAT, deal: "11111111111111111111111111111111", stage: 2, name: "Packing list", sha256: "ab".repeat(32) } as const;
    const enc = encodeDocMemo(ok);
    expect(enc).toBe(`{"deal":"11111111111111111111111111111111","name":"Packing list","sha256":"${"ab".repeat(32)}","stage":2,"v":"latch-doc@1"}`);
    expect(decodeDocMemo(enc)).toEqual(ok);
    for (const bad of [
      enc.replace("}", ',"x":1}'),
      enc.replace("latch-doc@1", "latch-doc@2"),
      enc.replace('"stage":2', '"stage":16'),
      enc.replace('"stage":2', '"stage":"2"'),
      enc.replace("Packing list", "Packing\nlist"),
      enc.replace("Packing list", " Packing list"),
      enc.replace("Packing list", "x".repeat(41)),
      enc.replace("ab".repeat(32), "AB".repeat(32)),
      enc.replace("ab".repeat(32), "ab".repeat(31)),
      enc.replace('"deal":"11111111111111111111111111111111"', '"deal":"not-a-key"'),
      JSON.stringify(JSON.parse(enc), null, 1), // same object, non-canonical bytes
      "not json",
      "[]",
    ]) expect(decodeDocMemo(bad), bad).toBeNull();
  });

  it("sha256File hashes the bytes on the device and matches node:crypto", async () => {
    const bytes = new TextEncoder().encode("bill of lading bytes");
    expect(await sha256File(new Blob([bytes]))).toBe(BOL.sha256);
  });
});

describe("v0.15: receipt acknowledgements (deployed binary)", () => {
  it("the importer acknowledges both digests and approves stage 1 in one transaction; the pair is readable from the evidence side", async () => {
    const t = await tradeDeal();
    t.c.send(await presentDocuments(t.c.deal(t.addr), t.sam.publicKey, [INVOICE, BOL]), t.sam);
    const d1 = t.c.deal(t.addr);
    const ixs = await acknowledgeDocuments(d1, t.alex.publicKey, [INVOICE.sha256, BOL.sha256]);
    expect(ixs.filter((ix) => ix.programId.equals(MEMO_PROGRAM_ID))).toHaveLength(2);
    t.c.send(ixs, t.alex);
    const d2 = t.c.deal(t.addr);
    expect(d2.milestones[0].released).toBe(true);
    const r = recordsFromTx(t.c.lastTxJson, d2);
    expect(r.presented).toEqual([]);
    expect(r.acknowledged.map((a) => [a.stage, a.sha256, a.by])).toEqual([
      [0, INVOICE.sha256, t.alex.publicKey.toBase58()],
      [0, BOL.sha256, t.alex.publicKey.toBase58()],
    ]);
    expect(r.acknowledged[0].signature).toBe(t.c.lastTxJson.transaction.signatures[0]);
    expect(t.c.tokenBalance(t.sam.publicKey, t.mint)).toBe(30_000_000n);
  });

  it("refused: after approving; 0 or 9 digests; duplicates; bad digest — and a stranger's ack is not this deal's", async () => {
    const t = await tradeDeal();
    const d = t.c.deal(t.addr);
    await expect(acknowledgeDocuments(d, t.alex.publicKey, [])).rejects.toThrow(/1 to 8/);
    await expect(acknowledgeDocuments(d, t.alex.publicKey, Array.from({ length: 9 }, (_, i) => sha(String(i))))).rejects.toThrow(/1 to 8/);
    await expect(acknowledgeDocuments(d, t.alex.publicKey, [INVOICE.sha256, INVOICE.sha256])).rejects.toThrow(/once per stage/);
    await expect(acknowledgeDocuments(d, t.alex.publicKey, ["nope"])).rejects.toThrow(/digest/);
    t.c.send(await F.approveAndMaybeRelease(d, t.alex.publicKey), t.alex);
    await expect(acknowledgeDocuments(t.c.deal(t.addr), t.alex.publicKey, [INVOICE.sha256])).rejects.toThrow(/already approved/);
    // A memo signed by a stranger, even with a perfect payload, is ignored.
    const { TransactionInstruction } = await import("@solana/web3.js");
    const ack = { v: ACK_FORMAT, deal: t.addr.toBase58(), stage: 1, sha256: BOL.sha256 } as const;
    t.c.send([new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: t.eve.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(encodeAckMemo(ack), "utf8") })], t.eve);
    expect(recordsFromTx(t.c.lastTxJson, t.c.deal(t.addr)).acknowledged).toEqual([]);
  });

  it("ack encoding is strict: exact keys, canonical bytes, lower-case hex, stage 0–15", () => {
    const ok = { v: ACK_FORMAT, deal: "11111111111111111111111111111111", stage: 2, sha256: sha("x") } as const;
    expect(decodeAckMemo(encodeAckMemo(ok))).toEqual(ok);
    expect(decodeAckMemo(encodeAckMemo({ ...ok, sha256: sha("x").toUpperCase() }))).toBeNull();
    expect(decodeAckMemo(encodeAckMemo({ ...ok, stage: 16 }))).toBeNull();
    expect(decodeAckMemo(JSON.stringify({ ...ok, name: "extra" }))).toBeNull();
    expect(decodeAckMemo(JSON.stringify({ v: ok.v, deal: ok.deal, stage: ok.stage, sha256: ok.sha256 }))).toBeNull(); // key order not canonical
    expect(decodeAckMemo(encodeDocMemo({ v: DOC_FORMAT, deal: ok.deal, stage: 0, name: "Invoice", sha256: ok.sha256 }))).toBeNull();
    expect(decodeDocMemo(encodeAckMemo(ok))).toBeNull();
  });
});
