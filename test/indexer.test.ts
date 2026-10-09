/**
 * v0.8 #8: incremental deal sync. A refresh reads only the deal accounts that
 * changed since the last slot (Helius getProgramAccountsV2, one call per
 * page) instead of twelve filtered listings; the membership filter is the
 * same one the full listing uses; an RPC without the method → null.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { address } from "@solana/kit";
import { Chain } from "./harness";
import * as F from "../src/lib/flows";
import { RISK } from "../src/lib/config";
import { DEAL_ACCOUNT_SIZE } from "../src/lib/deal";
import { fetchChangedDeals, fetchMyDeals, isMember } from "../src/lib/chain";

const DAY = 86400;

async function twoDeals() {
  const c = new Chain();
  const issuer = c.wallet();
  const alex = c.wallet();
  const sam = c.wallet();
  const other = c.wallet();
  const mint = c.mint(issuer);
  const mk = async (payer: Keypair, payee: Keypair) => {
    const spec: F.DealSpec = {
      creator: payer.publicKey,
      dealId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)),
      parties: [payer.publicKey, payee.publicKey],
      payerIdx: 0,
      payeeIdx: 1,
      approvalThreshold: 2,
      termsHash: new Uint8Array(32).fill(3),
      milestoneAmounts: [1_000_000n],
      rule: "TimeoutRelease",
      timerMode: "FromActivation",
      timeoutSecs: 10 * DAY,
      recoverySigners: [payer.publicKey, payee.publicKey],
      recoveryThreshold: 2,
      recoveryDelaySecs: 3 * DAY,
      acceptedRiskFlags: RISK.FREEZE_AUTHORITY,
      mint,
    };
    const addr = F.dealAddress(payer.publicKey, spec.dealId);
    c.send(await F.createAndSign(spec, false), payer);
    return addr;
  };
  const mine = await mk(alex, sam);
  const theirs = await mk(other, sam); // sam is in both; alex only in the first
  const raw = (pk: PublicKey) => Buffer.from(Uint8Array.from((c.svm.getAccount(address(pk.toBase58())) as any).data)).toString("base64");
  return { c, alex, sam, other, mine, theirs, raw };
}

/** A fake Helius endpoint: pages of accounts, then an empty page; records every request body. */
function fakeRpc(pages: { pubkey: string; data: string }[][], error?: { code: number; message: string }) {
  const bodies: any[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (error) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error }));
    const key = body.params[1].paginationKey;
    const idx = key ? Number(key) : 0;
    const page = pages[idx] ?? [];
    const result = { accounts: page.map((a) => ({ pubkey: a.pubkey, account: { data: [a.data, "base64"], owner: "", lamports: 0, executable: false } })), paginationKey: page.length ? String(idx + 1) : null };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { fetchFn, bodies };
}

describe("v0.8 #8: incremental deal sync", () => {
  it("one call per page, dataSize filter + changedSinceSlot in the request; membership filtered client-side; short page ends the loop", async () => {
    const t = await twoDeals();
    const { fetchFn, bodies } = fakeRpc([[{ pubkey: t.mine.toBase58(), data: t.raw(t.mine) }], [{ pubkey: t.theirs.toBase58(), data: t.raw(t.theirs) }], []]);
    const r = await fetchChangedDeals("https://rpc.example", t.alex.publicKey, 12345, fetchFn);
    expect(r).not.toBeNull();
    expect(r!.calls).toBe(3);
    expect(r!.deals.map((d) => d.address.toBase58())).toEqual([t.mine.toBase58()]); // alex is not in the second deal
    expect(bodies[0].method).toBe("getProgramAccountsV2");
    expect(bodies[0].params[1]).toMatchObject({ changedSinceSlot: 12345, filters: [{ dataSize: DEAL_ACCOUNT_SIZE }], encoding: "base64", limit: 1000 });
    expect(bodies[0].params[1].paginationKey).toBeUndefined();
    expect(bodies[1].params[1].paginationKey).toBe("1");
    // Sam sees both.
    const s = await fetchChangedDeals("https://rpc.example", t.sam.publicKey, 0, fakeRpc([[{ pubkey: t.mine.toBase58(), data: t.raw(t.mine) }, { pubkey: t.theirs.toBase58(), data: t.raw(t.theirs) }], []]).fetchFn);
    expect(s!.deals.map((d) => d.address.toBase58()).sort()).toEqual([t.mine.toBase58(), t.theirs.toBase58()].sort());
  });

  it("an RPC without the method → null (caller falls back to the twelve-call listing); other errors throw", async () => {
    const t = await twoDeals();
    expect(await fetchChangedDeals("https://rpc.example", t.alex.publicKey, 1, fakeRpc([], { code: -32601, message: "Method not found" }).fetchFn)).toBeNull();
    await expect(fetchChangedDeals("https://rpc.example", t.alex.publicKey, 1, fakeRpc([], { code: -32005, message: "Node is behind" }).fetchFn)).rejects.toThrow(/Node is behind/);
  });

  it("garbage accounts in a page are skipped, never thrown", async () => {
    const t = await twoDeals();
    const junk = Buffer.alloc(DEAL_ACCOUNT_SIZE, 0xff).toString("base64");
    const r = await fetchChangedDeals("https://rpc.example", t.alex.publicKey, 1, fakeRpc([[{ pubkey: Keypair.generate().publicKey.toBase58(), data: junk }, { pubkey: t.mine.toBase58(), data: t.raw(t.mine) }], []]).fetchFn);
    expect(r!.deals).toHaveLength(1);
  });

  it("the full listing and the incremental path agree on membership (same predicate)", async () => {
    const t = await twoDeals();
    const d = (await fetchChangedDeals("https://rpc.example", t.sam.publicKey, 0, fakeRpc([[{ pubkey: t.theirs.toBase58(), data: t.raw(t.theirs) }], []]).fetchFn))!.deals[0];
    expect(isMember(d, t.sam.publicKey)).toBe(true);
    expect(isMember(d, t.alex.publicKey)).toBe(false);
    // The full listing's shape: twelve filtered getProgramAccounts calls per refresh (what #8 replaces after the first load).
    let calls = 0;
    const conn: any = { getProgramAccounts: async () => (calls++, []) };
    await expect(fetchMyDeals(conn, t.alex.publicKey)).resolves.toMatchObject({ deals: [], failed: 0 });
    expect(calls).toBe(12);
  });
});
