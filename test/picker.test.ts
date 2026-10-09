/** v0.10 #3: recipient suggestions are contact-first, then recents by recency, then a pasted address. */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { suggestRecipients } from "../src/lib/recipients";

const me = Keypair.generate().publicKey;
const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();
const C = Keypair.generate().publicKey.toBase58();
const D = Keypair.generate().publicKey.toBase58();
const local: any = {
  contacts: { [A]: { address: A, name: "Zed", createdAt: 1 }, [B]: { address: B, name: "Olivia", createdAt: 2 } },
  payments: [
    { address: C, mode: "instant", at: 100, amount: "$1", asset: "USDC" },
    { address: A, mode: "instant", at: 300, amount: "$2", asset: "USDC" }, // a contact: stays in contacts, not recents
    { address: C, mode: "instant", at: 250, amount: "$3", asset: "USDC" },
  ],
  blocked: [],
};
const deal = (other: string, at: number): any => ({ parties: [me, { equals: (k: any) => k.toBase58?.() === other, toBase58: () => other }], activatedAt: at, signedAt: 0, createdAt: 0 });

describe("suggestRecipients", () => {
  it("contacts alphabetical, recents by latest interaction, contacts never duplicated in recents, self and blocked excluded", () => {
    const s = suggestRecipients(local, [deal(D, 500), deal(C, 50)], me, "");
    expect(s.contacts.map((c) => c.name)).toEqual(["Olivia", "Zed"]);
    expect(s.recent.map((r) => [r.address, r.why, r.at])).toEqual([
      [D, "deal", 500],
      [C, "paid", 250],
    ]);
    expect(s.typed).toBeNull();
    const blockedLocal = { ...local, blocked: [D] };
    expect(suggestRecipients(blockedLocal, [deal(D, 500)], me, "").recent.map((r) => r.address)).toEqual([C]);
  });
  it("filters by name or address fragment; a pasted valid address that isn't known becomes `typed`", () => {
    // "oli" contains an "l", which base58 lacks, so no address can match it by accident.
    expect(suggestRecipients(local, [], me, "oli").contacts.map((c) => c.name)).toEqual(["Olivia"]);
    expect(suggestRecipients(local, [], me, A.slice(0, 10)).contacts.map((c) => c.address)).toEqual([A]);
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(suggestRecipients(local, [], me, fresh).typed).toMatchObject({ address: fresh, why: "typed" });
    expect(suggestRecipients(local, [], me, A).typed).toBeNull(); // already a contact
    expect(suggestRecipients(local, [], me, "not an address").typed).toBeNull();
    expect(suggestRecipients(local, [], me, me.toBase58()).typed).toBeNull();
  });
});
