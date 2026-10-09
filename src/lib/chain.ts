/**
 * Read side: discover and fetch deals straight from Solana RPC. No Latch
 * server is involved (R3 §3.3: the client query is the fallback path; an
 * indexer would only be a speed-up).
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./config";
import { DEAL_ACCOUNT_SIZE, MAX_PARTIES, OFFSETS, decodeDeal, type Deal } from "./deal";

export async function fetchDeal(conn: Connection, addr: PublicKey): Promise<Deal | null> {
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info || !info.owner.equals(PROGRAM_ID)) return null;
  return decodeDeal(addr, info.data);
}

export interface MyDeals {
  deals: Deal[];
  /** Lookups that still failed after retries. >0 means the list may be INCOMPLETE. */
  failed: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every deal where `me` is a party, the named decider, or a recovery signer.
 * One getProgramAccounts per slot offset; each failed lookup is retried
 * (`retries` times, backoff from `backoffMs`) and any that still fail are
 * REPORTED, never silently dropped — a missing lookup can hide a deal, and a
 * hidden deal can hide a request conflict.
 */
export async function fetchMyDeals(conn: Connection, me: PublicKey, retries = 2, backoffMs = 400): Promise<MyDeals> {
  const offsets = [
    ...Array.from({ length: MAX_PARTIES }, (_, i) => OFFSETS.party(i)),
    OFFSETS.tieBreaker,
    OFFSETS.recoverySigner(0),
    OFFSETS.recoverySigner(1),
    OFFSETS.recoverySigner(2),
  ];
  const lookup = async (offset: number) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await conn.getProgramAccounts(PROGRAM_ID, {
          commitment: "confirmed",
          filters: [{ dataSize: DEAL_ACCOUNT_SIZE }, { memcmp: { offset, bytes: me.toBase58() } }],
        });
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  };
  const results = await Promise.allSettled(offsets.map(lookup));
  if (results.every((r) => r.status === "rejected")) {
    throw new Error("This RPC endpoint refused the deal lookup. Set VITE_RPC_URL to an endpoint that allows getProgramAccounts.");
  }
  const seen = new Map<string, Deal>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const { pubkey, account } of r.value) {
      const k = pubkey.toBase58();
      if (seen.has(k)) continue;
      try {
        const d = decodeDeal(pubkey, account.data);
        // A memcmp hit in an unused party slot is not membership.
        if (isMember(d, me)) seen.set(k, d);
      } catch {
        /* not a deal */
      }
    }
  }
  return {
    deals: [...seen.values()].sort((a, b) => b.createdAt - a.createdAt),
    failed: results.filter((r) => r.status === "rejected").length,
  };
}

/** A party, the named decider, or a recovery signer. */
export function isMember(d: Deal, me: PublicKey): boolean {
  return d.parties.some((p) => p.equals(me)) || (d.rule === "TieBreaker" && d.tieBreaker.equals(me)) || d.recoverySigners.some((p) => p.equals(me));
}

/**
 * v0.8 #8: incremental sync. After the first full listing, a refresh only
 * needs the deal accounts that changed since the slot we last saw. Helius
 * `getProgramAccountsV2` does that server-side (`changedSinceSlot`, paginated;
 * the end of pagination is an empty page). Any deal whose account changed is
 * returned, member or not, so the membership filter runs here. Returns null
 * when the endpoint doesn't offer the method (JSON-RPC -32601), and the caller
 * falls back to `fetchMyDeals`.
 */
export async function fetchChangedDeals(
  rpcUrl: string,
  me: PublicKey,
  sinceSlot: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ deals: Deal[]; calls: number } | null> {
  const out = new Map<string, Deal>();
  let paginationKey: string | undefined;
  let calls = 0;
  for (let page = 0; page < 50; page++) {
    calls++;
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccountsV2",
        params: [
          PROGRAM_ID.toBase58(),
          { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: DEAL_ACCOUNT_SIZE }], changedSinceSlot: sinceSlot, limit: 1000, ...(paginationKey ? { paginationKey } : {}) },
        ],
      }),
    });
    const j: any = await res.json();
    if (j.error) {
      if (j.error.code === -32601 || /not found|unknown method|unsupported/i.test(String(j.error.message))) return null;
      throw new Error(`getProgramAccountsV2: ${j.error.message ?? JSON.stringify(j.error)}`);
    }
    const accounts: any[] = j.result?.accounts ?? [];
    for (const a of accounts) {
      try {
        const pk = new PublicKey(a.pubkey);
        const d = decodeDeal(pk, Buffer.from(a.account.data[0], "base64"));
        if (isMember(d, me)) out.set(pk.toBase58(), d);
      } catch {
        /* not a deal */
      }
    }
    paginationKey = j.result?.paginationKey ?? undefined;
    if (!accounts.length || !paginationKey) break;
  }
  return { deals: [...out.values()], calls };
}

export const INCOMPLETE_LIST = "Some lookups failed, so this list may be missing payments. Pull to refresh.";

export async function tokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    const r = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, true));
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * SHA-256 of the program's deployed bytecode as observed right now (trailing
 * zero padding stripped, matching solana-verify), plus the program-data
 * account it was read from. Lets the evidence packet record what actually
 * ran next to the expected verified-build hash — the devnet program is
 * upgradeable, so these can differ.
 */
export async function observedProgramHash(conn: Connection, commitment: "confirmed" | "finalized" = "finalized"): Promise<{ programData: string; hash: string; slot: number | null }> {
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const { bytesToHex } = await import("@noble/hashes/utils.js");
  const prog = await conn.getAccountInfo(PROGRAM_ID, commitment);
  if (!prog) throw new Error("program account not found");
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData, commitment);
  if (!pd) throw new Error("program data account not found");
  // UpgradeableLoaderState::ProgramData = 4-byte tag + 8-byte slot + 1+32 authority option
  const slot = Number(Buffer.from(pd.data.subarray(4, 12)).readBigUInt64LE());
  const raw = pd.data.subarray(45);
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  return { programData: programData.toBase58(), hash: bytesToHex(sha256(raw.subarray(0, end))), slot };
}
