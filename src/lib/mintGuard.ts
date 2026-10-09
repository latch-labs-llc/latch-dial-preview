/**
 * Client-side port of the program's mint vetting (latch
 * programs/latch/src/mint_guard.rs), so the Builder can show the risks a
 * token carries — and the parties can accept them on the record — before
 * create_deal runs the same checks on-chain (v0.9 #2). Same flags, same
 * rejects; the program's verdict is the one that counts.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { AccountState, ExtensionType, TOKEN_2022_PROGRAM_ID, getDefaultAccountState, getExtensionTypes, getTransferHook, unpackMint } from "@solana/spl-token";
import { RISK, TOKEN_PROGRAM } from "./config";

/** Token-2022 extension type 16; @solana/spl-token's enum has no member for it. */
const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16 as ExtensionType;

export interface MintVetting {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  /** Risk flags the program will detect (bits of `RISK`). */
  flags: number;
  /** Why the program would refuse this mint outright, or null. */
  rejected: string | null;
}

/** Vet a mint from its raw account (owner + data), exactly as the program does. */
export function vetMintAccount(mint: PublicKey, owner: PublicKey, data: Uint8Array): MintVetting {
  const classic = owner.equals(TOKEN_PROGRAM);
  const t22 = owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!classic && !t22) return { mint, tokenProgram: owner, decimals: 0, flags: 0, rejected: "Not a token mint." };
  let m;
  try {
    m = unpackMint(mint, { owner, data: Buffer.from(data), executable: false, lamports: 0 }, owner);
  } catch {
    return { mint, tokenProgram: owner, decimals: 0, flags: 0, rejected: "Not a token mint." };
  }
  let flags = 0;
  if (m.freezeAuthority) flags |= RISK.FREEZE_AUTHORITY;
  const out = (rejected: string | null = null): MintVetting => ({ mint, tokenProgram: owner, decimals: m.decimals, flags, rejected });
  if (classic) return out();
  for (const ext of getExtensionTypes(m.tlvData)) {
    switch (ext) {
      case ExtensionType.PermanentDelegate:
        flags |= RISK.PERMANENT_DELEGATE;
        break;
      case ExtensionType.TransferHook: {
        const hook = getTransferHook(m);
        // A live hook program can block or reorder transfers: refused. A dormant hook is flagged.
        if (hook?.programId && !hook.programId.equals(PublicKey.default)) return out("This token runs a transfer hook program; a protected payment can't hold it.");
        flags |= RISK.DORMANT_TRANSFER_HOOK;
        break;
      }
      case ExtensionType.TransferFeeConfig:
        flags |= RISK.TRANSFER_FEE;
        break;
      case ExtensionType.ConfidentialTransferMint:
        flags |= RISK.CONFIDENTIAL_CAPABLE;
        break;
      case CONFIDENTIAL_TRANSFER_FEE_CONFIG:
        flags |= RISK.TRANSFER_FEE | RISK.CONFIDENTIAL_CAPABLE;
        break;
      case ExtensionType.DefaultAccountState: {
        const s = getDefaultAccountState(m);
        if (s?.state === AccountState.Frozen) return out("New accounts of this token start frozen; the vault could never receive it.");
        break;
      }
      case ExtensionType.NonTransferable:
        return out("This token can't be transferred, so it can't be held or released.");
      case ExtensionType.InterestBearingConfig:
        flags |= RISK.INTEREST_BEARING;
        break;
      case ExtensionType.MintCloseAuthority:
        flags |= RISK.MINT_CLOSE_AUTHORITY;
        break;
      case ExtensionType.MetadataPointer:
      case ExtensionType.TokenMetadata:
      case ExtensionType.GroupPointer:
      case ExtensionType.TokenGroup:
      case ExtensionType.GroupMemberPointer:
      case ExtensionType.TokenGroupMember:
        break; // cosmetic: no escrow impact
      default:
        return out("This token uses an extension Latch doesn't recognise; refused by default.");
    }
  }
  return out();
}

/** Vet a mint by address over RPC. Null when no account exists. */
export async function vetMint(conn: Connection, mint: PublicKey): Promise<MintVetting | null> {
  const info = await conn.getAccountInfo(mint, "confirmed");
  if (!info) return null;
  return vetMintAccount(mint, info.owner, info.data);
}
