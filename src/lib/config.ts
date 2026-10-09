/**
 * Cluster, program and asset configuration. Devnet only — there is no mainnet
 * code path in this app, by design (see BUILD-NOTES.md).
 */
import { normalizeServiceUrl } from "./serviceUrl";
import { PublicKey } from "@solana/web3.js";
import { ACTIVATION_WINDOW_SECS as SDK_ACTIVATION_WINDOW_SECS, LATCH_PROGRAM_ID } from "@latch-labs/sdk";

export const CLUSTER = "devnet" as const;

export const RPC_URL: string =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_RPC_URL) ||
  "https://api.devnet.solana.com";

/**
 * WebSocket endpoint for confirmations and subscriptions. Defaults to the
 * RPC host; set VITE_WS_URL when the HTTP RPC is a metered provider whose
 * concurrent-socket cap is shared with other sites (the public devnet
 * WebSocket is fine for confirmations — same split as latchlabs.org).
 */
export const WS_URL: string =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_WS_URL) ||
  RPC_URL.replace(/^http/, "ws");

/** Verified against the published IDL (`address`) and the public README. */
export const PROGRAM_ID_EXPECTED = "BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv";
export const PROGRAM_ID: PublicKey = LATCH_PROGRAM_ID;
if (PROGRAM_ID.toBase58() !== PROGRAM_ID_EXPECTED) {
  throw new Error(`Latch program ID mismatch: SDK has ${PROGRAM_ID.toBase58()}`);
}
/**
 * A Funded deal not Active by funded_at + this many seconds can be returned
 * to the payer by anyone (refund_unactivated, program upgrade 2026-10-05).
 */
export const ACTIVATION_WINDOW_SECS: number = Number(SDK_ACTIVATION_WINDOW_SECS);
if (ACTIVATION_WINDOW_SECS !== 259_200) throw new Error("Unexpected ACTIVATION_WINDOW_SECS from the SDK");

/** Published verified-build hash (solana-verify), shown on Settings → Verify Latch. */
export const VERIFIED_BUILD_HASH = "4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d";
/** v0.7 pin (refund_by_payee + dispute policies, before the creation lock). */
export const V07_BUILD_HASH = "0c4af8ba38fe78cd46283dad80af9792a9cb19943d279a8438510da0860ddb9e";
/** v0.3–v0.6 pin (before refund_by_payee and dispute policies). */
export const PREVIOUS_BUILD_HASH = "3785ede684cfaa05b84cc14f06c71f6932d1c97b85aeb9ccd9a8620f1d556a5d";

/**
 * Every program hash this app has ever written into an agreement text
 * (section 3), newest first. APPEND-ONLY: when re-pinning after an upgrade,
 * add the new hash at the front and keep the old ones, or texts signed under
 * the old program stop verifying.
 */
export const PROGRAM_HASH_HISTORY: readonly string[] = [VERIFIED_BUILD_HASH, V07_BUILD_HASH, PREVIOUS_BUILD_HASH];

export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Mint risk-flag bits (mirror of the program's `risk_flags`). */
export const RISK = {
  FREEZE_AUTHORITY: 1 << 0,
  PERMANENT_DELEGATE: 1 << 1,
  DORMANT_TRANSFER_HOOK: 1 << 2,
  TRANSFER_FEE: 1 << 3,
  CONFIDENTIAL_CAPABLE: 1 << 4,
  INTEREST_BEARING: 1 << 5,
  MINT_CLOSE_AUTHORITY: 1 << 6,
} as const;

export type AssetId = "USDC" | "SOL" | "TEST";

export interface Asset {
  id: AssetId;
  label: string;
  /** The mint a protected deal escrows (wSOL for SOL). */
  mint: PublicKey;
  decimals: number;
  /** Risk flags this mint is known to carry; shown to the user and accepted explicitly. */
  knownRiskFlags: number;
  riskNote?: string;
  /** Dollar-ish display: USDC renders as $; SOL renders as "SOL". */
  dollar: boolean;
}

/**
 * Allowlisted assets. Unknown mints are never given a symbol anywhere in the
 * app (R3 §3.3). Circle's devnet USDC has a freeze authority (verified on
 * devnet), so protected USDC deals carry the FREEZE_AUTHORITY consent.
 */
const env: Record<string, string | undefined> = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};

/**
 * Optional product-layer service (worker/): @handles directory, Telegram
 * username verification, encrypted agreement backups, TEST-token faucet.
 * Every feature that uses it degrades gracefully when it's absent, and no
 * deal ever depends on it.
 */
/**
 * The app's domain, written into the backup key messages the wallet signs.
 * FIXED per deployment: changing it changes every user's backup keys.
 */
export const APP_DOMAIN: string = env.VITE_APP_DOMAIN ?? "latch-dial.localhost";

export { normalizeServiceUrl };
/** Vite sets DEV only for the dev server; production builds never accept plain-http localhost. */
const IS_DEV = (env as Record<string, unknown>).DEV === true;
export const SERVICE_URL: string | undefined = normalizeServiceUrl(env.VITE_SERVICE_URL, IS_DEV);
/** Self-serve devnet test token (no freeze authority), minted by the service faucet. */
export const TEST_MINT: string | undefined = env.VITE_TEST_MINT;
export const TELEGRAM_BOT: string | undefined = env.VITE_TELEGRAM_BOT;
/** Separate origin serving only the sandboxed Telegram widget (v0.5 #7). */
export const TELEGRAM_WIDGET_URL: string | undefined = normalizeServiceUrl(env.VITE_TELEGRAM_WIDGET_URL, IS_DEV);
/**
 * v0.6 #7: @usernames and Telegram linking are labelled "Preview" until the
 * retention and legal-process pages are live on a deployed service. Set
 * VITE_IDENTITY_LIVE=1 only for a build whose service publishes them.
 */
export const IDENTITY_PREVIEW: boolean = env.VITE_IDENTITY_LIVE !== "1";
/** Flag: Telegram OIDC sign-in (code + PKCE + wallet-bound nonce) instead of the Login Widget. */
export const TELEGRAM_OIDC_CLIENT_ID: string | undefined = env.VITE_TELEGRAM_OIDC_CLIENT_ID;

export const ASSETS: Partial<Record<AssetId, Asset>> & Record<"USDC" | "SOL", Asset> = {
  USDC: {
    id: "USDC",
    label: "USDC (devnet test)",
    mint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    decimals: 6,
    knownRiskFlags: RISK.FREEZE_AUTHORITY,
    riskNote: "The USDC issuer can freeze any USDC, including USDC held in a protected payment.",
    dollar: true,
  },
  SOL: {
    id: "SOL",
    label: "SOL (devnet test)",
    mint: NATIVE_MINT,
    decimals: 9,
    knownRiskFlags: 0,
    dollar: false,
  },
  ...(TEST_MINT
    ? {
        TEST: {
          id: "TEST" as const,
          label: "Test dollars (LDD, devnet)",
          mint: new PublicKey(TEST_MINT),
          decimals: 6,
          knownRiskFlags: 0,
          dollar: true,
        },
      }
    : {}),
};

/** Assets offered in pickers, USDC first (the default). */
export const ASSET_IDS = (["USDC", "SOL", "TEST"] as AssetId[]).filter((a) => ASSETS[a]);

export function assetForMint(mint: PublicKey): Asset | null {
  for (const a of Object.values(ASSETS)) if (a && a.mint.equals(mint)) return a;
  return null;
}

/** Protection-window presets (R1 D8 / R8 C1). Shipped 10 d is the stranger default. */
export const PRESETS = [
  { id: "inperson", label: "In person", days: 3 },
  { id: "shipped", label: "Shipped", days: 10 },
  { id: "work", label: "Work", days: 14 },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

/**
 * v0.10 #4: what a Protected payment is for. The first three are the presets
 * under new names (a request link stays `protected-payment@2 {preset,
 * window_days}`); the last two need another template or rule, so they open
 * the Custom builder pre-filled — Custom is a pushed builder, never an inline
 * reveal (R1 §7.1).
 */
export const CATEGORIES = [
  { id: "inperson", preset: "inperson", title: "Buying in person", icon: "box" },
  { id: "shipped", preset: "shipped", title: "Something shipped", icon: "box" },
  { id: "work", preset: "work", title: "Paying for work", icon: "work" },
  { id: "deposit", builder: { tpl: "deposit", rule: "TimeoutRefund", days: "10" }, title: "Booking deposit", icon: "bookmark" },
  { id: "vehicle", builder: { tpl: "vehicle", rule: "TimeoutRelease", days: "14" }, title: "Vehicle", icon: "car" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** Network deposit (rent) a creator locks per deal, shown on the cost line. */
export const RENT_ESTIMATE_SOL = 0.01;

/** Wallets the consumer app accepts (R8 D6). Matched by adapter name. */
export const WALLET_ALLOWLIST = ["Phantom", "Solflare", "Backpack"] as const;
export const MWA_NAME = "Mobile Wallet Adapter";

/** Where legal and data requests go (DATA-AND-RETENTION.md). Shown on the Data & legal requests page. */
export const LEGAL_CONTACT = "latchlabs@protonmail.com";

export const FAUCETS = {
  usdc: "https://faucet.circle.com/",
  sol: "https://faucet.solana.com/",
};

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}
export function explorerAddr(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=${CLUSTER}`;
}
