/**
 * Wallets: allowlisted external wallets only (R8 D6, C3). No burner, no
 * Latch-generated keys. The provider auto-detects Wallet Standard wallets;
 * the allowlist is enforced in our own picker (R8 ⚠6).
 */
import { WalletAdapterNetwork, WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { useCallback, useMemo, type ReactNode } from "react";
import { MWA_NAME, RPC_URL, WALLET_ALLOWLIST, WS_URL } from "./config";
import { haptic } from "./haptics";
import { guardedSend, programGuard } from "./programGuard";

export function Wallets({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter({ network: WalletAdapterNetwork.Devnet } as any),
      new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet }),
    ],
    [],
  );
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed", wsEndpoint: WS_URL }}>
      <WalletProvider wallets={wallets} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

export interface PickerEntry {
  name: string;
  icon?: string;
  installed: boolean;
  outsideAllowlist?: boolean;
  select: () => void;
  getUrl: string;
}

const GET_URLS: Record<string, string> = {
  Phantom: "https://phantom.com/download",
  Solflare: "https://solflare.com/download",
  Backpack: "https://backpack.app/downloads",
};

/** Allowlisted wallets, in allowlist order, plus the Android MWA entry (labelled). */
export function useWalletPicker(): PickerEntry[] {
  const { wallets, select } = useWallet();
  return useMemo(() => {
    const out: PickerEntry[] = [];
    for (const name of WALLET_ALLOWLIST) {
      const w = wallets.find((x) => x.adapter.name === name);
      out.push({
        name,
        icon: w?.adapter.icon,
        installed: !!w && (w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable),
        select: () => w && select(w.adapter.name as WalletName),
        getUrl: GET_URLS[name],
      });
    }
    const mwa = wallets.find((x) => x.adapter.name === MWA_NAME);
    if (mwa && mwa.readyState !== WalletReadyState.Unsupported) {
      out.push({
        name: "Installed Solana wallet (Android)",
        icon: mwa.adapter.icon,
        installed: true,
        outsideAllowlist: true,
        select: () => select(mwa.adapter.name as WalletName),
        getUrl: "",
      });
    }
    return out;
  }, [wallets, select]);
}

/** Universal links that open this page inside a wallet's in-app browser (iOS/Android web). */
export function openInWalletLinks(): { name: string; url: string }[] {
  const url = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  return [
    { name: "Phantom", url: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: "Solflare", url: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
    { name: "Backpack", url: `https://backpack.app/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

export function isMobileWeb(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** The connected wallet is on the allowlist (or is the labelled Android MWA). */
export function useAllowedWallet() {
  const w = useWallet();
  const name = w.wallet?.adapter.name ?? "";
  const allowed = (WALLET_ALLOWLIST as readonly string[]).includes(name) || name === MWA_NAME;
  return { ...w, allowed, publicKey: allowed ? w.publicKey : null };
}

/** Build a v0 transaction, ask the wallet to sign and send it, then confirm. */
export function useSend() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useAllowedWallet();
  return useCallback(
    async (ixs: TransactionInstruction[]): Promise<string> => {
      if (!publicKey) throw new Error("Connect a wallet first");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({ payerKey: publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      try {
        const sig = await sendTransaction(tx, connection, { skipPreflight: false });
        const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
        haptic("success");
        return sig;
      } catch (e) {
        haptic("error");
        throw e;
      }
    },
    [connection, publicKey, sendTransaction],
  );
}

/**
 * useSend for anything that signs an agreement or pays in (create, accept,
 * pay-in): first checks the deployed program still matches the pinned hash
 * the agreement text vouches for (programGuard), else refuses.
 */
export function useAgreementSend() {
  const { connection } = useConnection();
  const send = useSend();
  return useMemo(() => guardedSend(programGuard(connection), send), [connection, send]);
}

/** Human message for wallet/program errors (Anchor error names → plain words). */
export function explainError(e: any): string {
  const s = String(e?.message ?? e);
  const map: [RegExp, string][] = [
    [/User rejected|rejected the request/i, "You cancelled in your wallet."],
    [/insufficient (funds|lamports)|0x1\b/i, "Not enough balance for this payment and its network fee."],
    [/TimeoutNotElapsed/i, "The protection window hasn't ended yet."],
    [/TimeoutPausedByDispute/i, "The clock is paused. The money moves only when you both agree."],
    [/OnlyRaiserMayWithdraw/i, "Only the person who paused can resume the clock."],
    [/NotAParty/i, "This wallet isn't part of this payment."],
    [/RiskFlagsNotAccepted/i, "This token has risks that weren't accepted."],
    [/InvalidDisputeWindow|0x1799\b/i, "The dispute time limit must be between 1 and 365 days."],
    [/OnlyCreatorMaySetPolicy|0x179a\b/i, "Only whoever creates the payment can set its dispute time limit."],
    [/PolicyMustBeSetAtCreation|0x179d\b/i, "A dispute time limit can only be set in the same step that creates the payment. Start a new agreement to choose one."],
    [/DisputePolicyLocked|0x179b\b/i, "The dispute time limit can only be set when the payment is created."],
    [/ExpiredDisputeMustBeWithdrawn|0x179c\b/i, "The dispute time limit has passed: the pause has to be ended first (anyone can), then the clock resumes."],
    [/OnlyPayeeMayRefund|0x1798\b/i, "Only the recipient can refund this payment."],
    [/ActivationWindowOpen|0x1797\b/i, "It's too early: the money can be returned only 3 days after it was paid in, if it still hasn't been marked shipped."],
    [/TrueDeadlockConsentRequired/i, "This agreement has no decider and no timer. Tick the box to agree to that rule before signing."],
    [/InvalidDeadlockParams/i, "The settlement rule's settings aren't valid (for example a missing window or decider)."],
    [/InvalidState/i, "This payment has moved on since you opened it — refresh to see where it is now."],
    [/NotARecoverySigner/i, "This wallet isn't one of this payment's backup signers."],
    [/RecoveryDelayNotElapsed/i, "The backup signers' division is still in its public notice period."],
    [/InsufficientRecoverySignatures/i, "The division doesn't have enough backup-signer signatures yet."],
    [/PayoutExceedsVault/i, "That's more than is left in the payment."],
    [/AccountNotInitialized|could not find account/i, "An account doesn't exist yet. Try again in a moment."],
    [/Blockhash not found|block height exceeded/i, "The network was slow. Please try again."],
  ];
  for (const [re, msg] of map) if (re.test(s)) return msg;
  return s.length > 180 ? s.slice(0, 180) + "…" : s;
}
