/**
 * Demo mode (v0.11 #1): enough on devnet for one person to try everything.
 *
 * Three devnet keypairs with DELIBERATELY PUBLIC secrets, copied from the
 * open-source latch/app (latchlabs.org uses the same ones): a SOL tap that
 * hands out fee money, the mint authority of the Latch Demo Dollar (LDD), and
 * a "demo seller" wallet (the Walnut & Oak demo merchant). Devnet SOL and LDD
 * are worthless by construction and anyone being able to mint them is the
 * point. The demo seller's key is public too, so the app can press ITS buttons
 * for you — accept, mark shipped, approve, refund — and you see both sides of
 * a deal alone. Never do any of this with a real token or a real counterparty;
 * this app has no mainnet code path (config.ts).
 */
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { Deal } from "./deal";
import * as F from "./flows";
import type { LocalData } from "./store";
import { viewDeal, type Action } from "./view";

const TAP_SECRET = new Uint8Array([
  222, 233, 214, 14, 105, 244, 207, 34, 81, 125, 20, 58, 183, 72, 223, 134, 250, 63, 98, 158, 191, 93, 116, 229, 65, 8, 241, 82, 166, 218, 201, 63, 61, 155, 19, 187, 86, 57, 227, 30, 16, 68, 150, 108, 65,
  238, 154, 141, 128, 66, 203, 193, 196, 36, 136, 29, 34, 178, 62, 196, 121, 122, 105, 96,
]);
const LDD_AUTHORITY_SECRET = new Uint8Array([
  164, 121, 250, 107, 96, 83, 124, 88, 155, 252, 141, 249, 233, 253, 66, 38, 150, 154, 8, 202, 106, 233, 63, 104, 121, 184, 169, 196, 239, 108, 98, 255, 63, 39, 36, 97, 232, 62, 94, 59, 54, 123, 54, 57, 245,
  205, 2, 27, 91, 106, 12, 175, 163, 106, 201, 193, 2, 76, 58, 183, 70, 165, 143, 21,
]);
const DEMO_SELLER_SECRET = new Uint8Array([
  192, 15, 102, 9, 56, 132, 118, 177, 148, 2, 79, 10, 69, 12, 203, 172, 171, 97, 217, 34, 20, 244, 243, 242, 127, 86, 217, 0, 148, 224, 127, 47, 4, 96, 103, 0, 119, 87, 97, 32, 142, 36, 62, 13, 177, 43, 22,
  249, 45, 100, 125, 209, 199, 184, 253, 199, 16, 246, 66, 28, 235, 175, 73, 227,
]);

export const LDD_MINT = new PublicKey("2fZy4obHV2oUBqptHiANRmQU4A2vF8fTriT1mTPVLANi");
export const LDD_DECIMALS = 6;
export const TAP_SOL = 0.05;
export const DEMO_LDD = 1_000;

export const tapKeypair = () => Keypair.fromSecretKey(TAP_SECRET);
export const lddAuthority = () => Keypair.fromSecretKey(LDD_AUTHORITY_SECRET);
export const demoSeller = () => Keypair.fromSecretKey(DEMO_SELLER_SECRET);
export const DEMO_SELLER = demoSeller().publicKey;
export const ORBIT_SUPPLY = new PublicKey("4QQQf1kVaCuwfDMZhzMsE4abSMXzYrEgGH7jgGbp6PaS");

/** Contacts the "Add demo contacts" button saves (names alongside addresses, never instead). */
export const DEMO_CONTACTS: { address: string; name: string; note: string }[] = [
  { address: DEMO_SELLER.toBase58(), name: "Demo seller (Walnut & Oak)", note: "A demo wallet whose key is public devnet play money. On its deals you can press its buttons too." },
  { address: ORBIT_SUPPLY.toBase58(), name: "Orbit Supply Co. (demo store)", note: "The second demo storefront on latchlabs.org." },
];

export const isDemoSeller = (k: PublicKey | string | null | undefined) => !!k && (typeof k === "string" ? k : k.toBase58()) === DEMO_SELLER.toBase58();

/** SOL for fees from the tap: the tap pays its own fee, so a brand-new wallet needs nothing. */
export async function demoSol(connection: Connection, to: PublicKey): Promise<string> {
  const tap = tapKeypair();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: tap.publicKey, toPubkey: to, lamports: Math.round(TAP_SOL * 1e9) }));
  tx.feePayer = tap.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(tap);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/** Instructions that mint `ui` LDD to `owner` (ATA created if needed). The authority signs; `payer` pays rent for a new ATA. */
export function mintLddIxs(owner: PublicKey, ui: number, payer: PublicKey = owner): TransactionInstruction[] {
  const ata = getAssociatedTokenAddressSync(LDD_MINT, owner, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, LDD_MINT),
    createMintToInstruction(LDD_MINT, ata, lddAuthority().publicKey, BigInt(Math.round(ui * 10 ** LDD_DECIMALS))),
  ];
}

/** Mint test dollars to a wallet; the tap pays the fee so the recipient needs no SOL yet. */
export async function demoLdd(connection: Connection, to: PublicKey, ui = DEMO_LDD): Promise<string> {
  const tap = tapKeypair();
  return sendAs(connection, mintLddIxs(to, ui, tap.publicKey), tap, [lddAuthority()]);
}

/** What the demo seller can do on this deal right now (same rules as a real party: viewDeal from its side). */
export function demoActions(d: Deal, local: LocalData, now: number): Action[] {
  if (!d.parties.some((p) => p.equals(DEMO_SELLER))) return [];
  const v = viewDeal(d, DEMO_SELLER, local, now);
  const offered: Action[] = ["accept", "acceptAndPay", "pay", "markShipped", "confirmReady", "release", "crankRelease", "refundByPayee", "pause", "resume", "cancelDraft", "cancelTogether", "acceptSplit"];
  return v.actions.filter((a) => offered.includes(a));
}

/** The demo seller's instructions for one action (pure: the test harness sends them with the seller's keypair). */
export async function demoInstructions(d: Deal, action: Action): Promise<{ ixs: TransactionInstruction[]; extraSigners: Keypair[] }> {
  const me = DEMO_SELLER;
  switch (action) {
    case "accept":
      return { ixs: [await F.signTerms(d.address, me, false)], extraSigners: [] };
    case "acceptAndPay":
    case "pay": {
      // The demo seller paying in (you requested money from it): mint it the amount first, LDD only.
      if (!d.mint.equals(LDD_MINT)) throw new Error("The demo seller can only pay in test dollars (LDD).");
      const owed = d.totalAmount - d.deposited;
      const mint = mintLddIxs(me, Number(owed) / 10 ** LDD_DECIMALS);
      return { ixs: [...mint, ...(await F.fund(d, me, { alsoSign: action === "acceptAndPay" }))], extraSigners: [lddAuthority()] };
    }
    case "markShipped":
      return { ixs: await F.markShipped(d, me, true), extraSigners: [] };
    case "confirmReady":
      return { ixs: await F.markShipped(d, me, false), extraSigners: [] };
    case "release":
      return { ixs: await F.approveAndMaybeRelease(d, me), extraSigners: [] };
    case "crankRelease":
      return { ixs: await F.crankRelease(d, me), extraSigners: [] };
    case "refundByPayee":
      return { ixs: await F.refundByPayee(d, me), extraSigners: [] };
    case "pause":
      return { ixs: await F.pause(d.address, me), extraSigners: [] };
    case "resume":
      return { ixs: await F.resume(d.address, me), extraSigners: [] };
    case "cancelDraft":
      return { ixs: await F.cancelDraft(d.address, me), extraSigners: [] };
    case "cancelTogether":
      return { ixs: await F.cancelTogether(d, me), extraSigners: [] };
    case "acceptSplit":
      return { ixs: await F.acceptSplit(d, me), extraSigners: [] };
    default:
      throw new Error(`The demo seller can't ${action} here.`);
  }
}

/** Sign and send as the demo seller (fee paid by the tap so the seller never runs dry). */
export async function demoAct(connection: Connection, d: Deal, action: Action): Promise<string> {
  const { ixs, extraSigners } = await demoInstructions(d, action);
  return sendAs(connection, ixs, tapKeypair(), [demoSeller(), ...extraSigners]);
}

/** v0 transaction signed by `feePayer` plus `signers`, confirmed. */
export async function sendAs(connection: Connection, ixs: TransactionInstruction[], feePayer: Keypair, signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const uniq = new Map<string, Keypair>();
  for (const k of [feePayer, ...signers]) uniq.set(k.publicKey.toBase58(), k);
  tx.sign([...uniq.values()]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/** Plain-words labels for the demo seller's buttons. */
export const DEMO_LABEL: Partial<Record<Action, string>> = {
  accept: "Demo seller accepts",
  acceptAndPay: "Demo seller accepts & pays in",
  pay: "Demo seller pays in",
  markShipped: "Demo seller marks it shipped",
  confirmReady: "Demo seller confirms ready",
  release: "Demo seller approves this part",
  crankRelease: "Demo seller sends this part",
  refundByPayee: "Demo seller refunds you",
  pause: "Demo seller pauses the clock",
  resume: "Demo seller resumes the clock",
  cancelDraft: "Demo seller declines",
  cancelTogether: "Demo seller agrees to cancel",
  acceptSplit: "Demo seller accepts your split",
};
