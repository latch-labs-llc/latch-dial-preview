/**
 * App-wide chain data: my deals (polled), balances, and the counterparties I
 * have completed deals with (Requests classification). Reads go straight to
 * Solana RPC.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ASSETS, RPC_URL } from "./config";
import { INCOMPLETE_LIST, fetchChangedDeals, fetchMyDeals, tokenBalance } from "./chain";
/** Re-read a little before the last slot we saw: changedSinceSlot is not a stream of every write. */
const SLOT_MARGIN = 150;
import type { Deal } from "./deal";
import { useAllowedWallet } from "./wallet";
import { matchRequestsIfComplete } from "./request";
import { getLocal, updateLocal, useLocal } from "./store";
import { syncBackups } from "./backup";
import { connectLive, disconnectLive, messagingUnlocked, pollMessages } from "./messaging";

interface Data {
  deals: Deal[];
  loading: boolean;
  error: string | null;
  balances: { usdc: bigint; sol: bigint; wsol: bigint; test: bigint } | null;
  completedWith: Set<string>;
  refresh: () => void;
  upsert: (d: Deal) => void;
}

const Ctx = createContext<Data>({
  deals: [],
  loading: false,
  error: null,
  balances: null,
  completedWith: new Set(),
  refresh: () => {},
  upsert: () => {},
});

export function DataProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const { publicKey } = useAllowedWallet();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Data["balances"]>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const dealsRef = useRef<Deal[]>([]);
  const syncRef = useRef<{ slot: number | null; complete: boolean; v2: boolean | null; owner: string | null }>({ slot: null, complete: false, v2: null, owner: null });

  useEffect(() => {
    if (!publicKey) {
      setDeals([]);
      setBalances(null);
      return;
    }
    let live = true;
    setLoading(true);
    // v0.8 #8: after a complete first listing, refreshes read only what changed
    // since the last slot (one call) instead of twelve filtered listings.
    const sync = syncRef.current;
    const listDeals = async (): Promise<{ deals: Deal[]; failed: number }> => {
      const slotNow = await connection.getSlot("confirmed");
      if (sync.slot != null && sync.complete && sync.v2 !== false && sync.owner === publicKey.toBase58()) {
        const changed = await fetchChangedDeals(RPC_URL, publicKey, Math.max(0, sync.slot - SLOT_MARGIN)).catch(() => null);
        if (changed) {
          sync.v2 = true;
          sync.slot = slotNow;
          const prev = dealsRef.current;
          const merged = [...changed.deals, ...prev.filter((p) => !changed.deals.some((x) => x.address.equals(p.address)))].sort((a, b) => b.createdAt - a.createdAt);
          return { deals: merged, failed: 0 };
        }
        sync.v2 = false;
      }
      const full = await fetchMyDeals(connection, publicKey);
      sync.slot = slotNow;
      sync.complete = full.failed === 0;
      sync.owner = publicKey.toBase58();
      return full;
    };
    Promise.all([
      listDeals(),
      tokenBalance(connection, publicKey, ASSETS.USDC.mint),
      connection.getBalance(publicKey, "confirmed").then(BigInt),
      tokenBalance(connection, publicKey, ASSETS.SOL.mint),
      ASSETS.TEST ? tokenBalance(connection, publicKey, ASSETS.TEST.mint) : Promise.resolve(0n),
    ])
      .then(([{ deals: d, failed }, usdc, sol, wsol, test]) => {
        if (!live) return;
        // Recognise payer-created deals that answer my protected requests —
        // but only from a COMPLETE list: a failed lookup could be hiding the
        // second Draft that would make a match a conflict.
        const { matches, conflicts, cleared } = matchRequestsIfComplete({ deals: d, failed }, publicKey.toBase58(), getLocal());
        if (matches.length || conflicts.length || cleared.length)
          updateLocal((x) => {
            // A conflicting Draft disappeared: drop the conflict (matching resumes below).
            for (const n of cleared) delete x.requests[n].conflict;
            for (const m of matches) {
              x.links[m.deal] = m.blob;
              x.requests[m.nonce].matchedDeal = m.deal;
            }
            for (const c of conflicts) {
              // A conflict un-links everything: no Draft is vouched for.
              const r = x.requests[c.nonce];
              r.conflict = c.deals;
              if (r.matchedDeal) {
                delete x.links[r.matchedDeal];
                delete r.matchedDeal;
              }
            }
          });
        // Incomplete: keep what we already knew rather than make deals vanish.
        setDeals((prev) => (failed ? [...d, ...prev.filter((p) => !d.some((x) => x.address.equals(p.address)))] : d));
        dealsRef.current = failed ? [...d, ...dealsRef.current.filter((p) => !d.some((x) => x.address.equals(p.address)))] : d;
        setBalances({ usdc, sol, wsol, test });
        setError(failed ? INCOMPLETE_LIST : null);
      })
      .catch((e) => live && setError(String(e?.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [connection, publicKey, tick]);

  // Poll gently while the tab is visible.
  useEffect(() => {
    if (!publicKey) return;
    const t = window.setInterval(() => document.visibilityState === "visible" && refresh(), 20000);
    return () => window.clearInterval(t);
  }, [publicKey, refresh]);

  // Messages: a live socket to the wallet's inbox once unlocked (v0.17), with a slow poll as the fallback and a poll when the tab comes back.
  useEffect(() => {
    if (!publicKey) return;
    const owner = publicKey.toBase58();
    const tick = () => {
      if (document.visibilityState !== "visible" || !messagingUnlocked(owner)) return;
      connectLive(owner);
      pollMessages(owner).catch(() => {});
    };
    const t = window.setInterval(tick, 30000);
    const fast = window.setInterval(() => document.visibilityState === "visible" && messagingUnlocked(owner) && connectLive(owner), 2000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      window.clearInterval(fast);
      document.removeEventListener("visibilitychange", tick);
      disconnectLive();
    };
  }, [publicKey]);

  // Silent service backup of new agreement copies (only once the user turned it on).
  const linkCount = useLocal((d) => Object.keys(d.links).length);
  useEffect(() => {
    if (publicKey) syncBackups(publicKey.toBase58()).catch(() => {});
  }, [publicKey, linkCount]);

  const upsert = useCallback((d: Deal) => {
    setDeals((xs) => {
      const i = xs.findIndex((x) => x.address.equals(d.address));
      if (i < 0) return [d, ...xs];
      const next = xs.slice();
      next[i] = d;
      return next;
    });
  }, []);

  const completedWith = useMemo(() => {
    const s = new Set<string>();
    if (!publicKey) return s;
    for (const d of deals) {
      if (d.state !== "Completed") continue;
      for (const p of d.parties) if (!p.equals(publicKey)) s.add(p.toBase58());
    }
    return s;
  }, [deals, publicKey]);

  return <Ctx.Provider value={{ deals, loading, error, balances, completedWith, refresh, upsert }}>{children}</Ctx.Provider>;
}

export const useData = () => useContext(Ctx);
