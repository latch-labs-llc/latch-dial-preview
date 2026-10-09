import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const TEST_DECIMALS = 6;

/** Mint 100 TEST to the recipient's token account (created if needed). The authority pays. */
export function buildFaucetIxs(authority: PublicKey, mint: PublicKey, recipient: PublicKey, uiAmount = 100): TransactionInstruction[] {
  const ata = getAssociatedTokenAddressSync(mint, recipient, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(authority, ata, recipient, mint),
    createMintToCheckedInstruction(mint, ata, authority, BigInt(uiAmount) * 10n ** BigInt(TEST_DECIMALS), TEST_DECIMALS),
  ];
}
