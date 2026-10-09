/**
 * Every record the optional Latch service keeps (v0.4 B4). One table feeds
 * the in-app "Data & legal requests" page and DATA-AND-RETENTION.md, and a
 * test checks that the Worker writes no KV prefix that isn't listed here.
 */
export interface RetentionRow {
  prefix: string;
  holds: string;
  ttl: string;
  ttlSecs: number;
  deletedBy: string;
  /** Where it lives: Workers KV, or the Guards Durable Object (atomic checks). */
  store: "KV" | "Durable Object";
}

const DAY = 86400;

export const RETENTION: RetentionRow[] = [
  { prefix: "h:<name>", holds: "Your @username claim: name, wallet address, time, wallet signature. Public.", ttl: "400 days, renewed when you re-claim", ttlSecs: 400 * DAY, deletedBy: "Release username; Delete my service data", store: "KV" },
  { prefix: "o:<wallet>", holds: "Which @username a wallet holds.", ttl: "400 days, renewed with the claim", ttlSecs: 400 * DAY, deletedBy: "Release username; Delete my service data", store: "KV" },
  { prefix: "hr:<name>", holds: "A released @username held for its previous wallet (wallet address, hold end).", ttl: "60 days", ttlSecs: 60 * DAY, deletedBy: "Expiry; Delete my service data", store: "KV" },
  { prefix: "ho:<wallet>:<name>", holds: "Index of the names held for a wallet (so deletion only touches that wallet's holds).", ttl: "60 days", ttlSecs: 60 * DAY, deletedBy: "Expiry; Delete my service data", store: "KV" },
  { prefix: "tg:<telegram username>", holds: "Telegram username → wallet link, link time, findable flag. No Telegram id.", ttl: "60 days", ttlSecs: 60 * DAY, deletedBy: "Unlink Telegram; Delete my service data", store: "KV" },
  { prefix: "tgo:<wallet>", holds: "Same record, looked up by wallet.", ttl: "60 days", ttlSecs: 60 * DAY, deletedBy: "Unlink Telegram; Delete my service data", store: "KV" },
  { prefix: "tgu:<hash>", holds: "A used Telegram login (its hash only), so it can't be replayed.", ttl: "12 minutes", ttlSecs: 720, deletedBy: "Expiry", store: "Durable Object" },
  { prefix: "w:<wallet>", holds: "The public key your device uses to write backups.", ttl: "400 days, renewed on each backup", ttlSecs: 400 * DAY, deletedBy: "Delete backups; Delete my service data", store: "KV" },
  { prefix: "b:<wallet>:<id>", holds: "One encrypted agreement backup and its upload time. Stored encrypted; the service only receives ciphertext.", ttl: "400 days, renewed on each backup", ttlSecs: 400 * DAY, deletedBy: "Delete backups; Delete my service data", store: "KV" },
  { prefix: "mk:<wallet>", holds: "Your messaging keys: the public key others encrypt messages to, the public key your device signs sends with, and your wallet's signature over them. Public.", ttl: "400 days, renewed when you send a message", ttlSecs: 400 * DAY, deletedBy: "Turn off messages; Delete my service data", store: "KV" },
  { prefix: "msg:<time>:<id>", holds: "In each wallet's own inbox: one encrypted message it sent or received — sender and recipient wallet addresses, a thread id, send time, ciphertext, the sender's device signature. The service can't read it.", ttl: "90 days", ttlSecs: 90 * DAY, deletedBy: "Delete conversation (your copy, and your sent records in the other party's inbox); Delete my service data", store: "Durable Object" },
  { prefix: "mc:<wallet>:<day>", holds: "How many messages a wallet sent that day (a counter).", ttl: "2 days", ttlSecs: 2 * DAY, deletedBy: "Expiry; Delete my service data", store: "KV" },
  { prefix: "li:<wallet>", holds: "Time of your last signed request, and separately (li:<wallet>:w, li:<wallet>:m) of your device's last backup or messaging request (replay protection).", ttl: "20 minutes", ttlSecs: 1200, deletedBy: "Expiry (kept through deletion so old signatures can't be replayed)", store: "Durable Object" },
  { prefix: "f:a:<wallet>", holds: "When this wallet last used the TEST faucet.", ttl: "20 hours", ttlSecs: 20 * 3600, deletedBy: "Expiry", store: "Durable Object" },
  { prefix: "f:i:<ip>", holds: "When this IP address last used the TEST faucet.", ttl: "20 hours", ttlSecs: 20 * 3600, deletedBy: "Expiry", store: "Durable Object" },
  { prefix: "rl:<bucket>:<ip>:<minute>", holds: "A request counter per IP address per minute (rate limits).", ttl: "2 minutes", ttlSecs: 120, deletedBy: "Expiry", store: "KV" },
];

/** The literal KV prefix of a row ("f:a:<wallet>" → "f:a:"). */
export const literalPrefix = (r: RetentionRow) => r.prefix.slice(0, r.prefix.indexOf("<"));

/** Data that passes THROUGH the service (and third parties) without being stored. */
export const IN_TRANSIT = [
  "When you upload a backup, the payment's deal address travels with it: the service checks on Solana (through its RPC provider) that your wallet is a party, then discards it. Only a scrambled id is stored. The service and that RPC provider see the address while the check runs.",
  "Your IP address reaches the service with every request; it's kept only as listed above (faucet and rate-limit records).",
];

export const NOT_KEPT = [
  "Your name, photo or phone number from Telegram",
  "Agreement text, amounts or deal terms (backups are encrypted on your device first)",
  "What your messages say or what proposed terms contain (messages are encrypted on your device first; the service sees only ciphertext and which wallets wrote to each other, when)",
  "Your contacts, payment history or settings (they stay on your device)",
  "Any key that can move money",
];
