/**
 * Every user-facing sentence that carries a legal or trust claim lives here,
 * so it can be reviewed in one place (R1 §7.10 copy rules; founder copy
 * discipline). Banned in UI copy: "escrow", "free", "money back",
 * "guarantee", "insured", "safe", "trustless", "L2", "court-ready",
 * "open standard", "automatically released". test/copy.test.ts enforces this
 * across src/.
 */

/** The one truthful custody line (A1/A3): reused wherever the app talks about who can move the money. */
/** v0.7.1: the dispute limit adds up every pause and never resets. */
const CUMULATIVE = "All pauses count toward it and it never resets —";
export const CUSTODY = "No instruction lets any Latch key move the money; on devnet the program can be upgraded by its maintainer.";

export const COPY = {
  custody: CUSTODY,
  brandLine: "Protected payments between strangers.",
  /** v0.6 #2: what "held" means, always with the date rule (no open-ended promises). */
  heldUntil: (name: string, days: number, work = false) =>
    work
      ? `Held until you say it's OK — or ${days} days after ${name} starts the clock (by 3 days after you pay in), unless you pause the clock.`
      : `Held until you say it's OK — or ${days} days after ${name} marks it shipped, unless you pause the clock.`,
  /**
   * v0.7: a deal's dispute policy in plain words. `days` is the cumulative
   * pause allowance; `pctToPayee` is the split (AutoSplit's, else 50).
   */
  disputeLimit: (policy: string, days: string, payer: string, payee: string, pctToPayee: number) =>
    policy === "ResumeRule"
      ? `Dispute time limit: once the clock has been paused for ${days} in total, anyone can end the pause and the clock resumes toward ${payee}. ${CUMULATIVE} after that, anyone can end any new pause straight away.`
      : policy === "Split"
        ? `Dispute time limit: once the clock has been paused for ${days} in total, anyone can split what's left — ${pctToPayee}% to ${payee}, the rest to ${payer}. ${CUMULATIVE} after that, any new pause lets anyone carry out the split straight away.`
        : policy === "RefundPayer"
          ? `Dispute time limit: once the clock has been paused for ${days} in total, anyone can return everything left to ${payer}. ${CUMULATIVE} after that, any new pause lets anyone return it to ${payer} straight away.`
          : "No dispute time limit: a pause holds the money until you both sign the same split.",
  recoveryBeforeStart: "A backup signers' division proposed before the payment starts doesn't count — the program clears it, and every signature on it, when the payment starts",
  recoveryAfterStart: "Backup signers can propose a division once the payment has started. Signatures collected before the start are cleared then and don't count.",
  disputeUsed: (used: string, window: string) => `${used} of ${window}`,
  endDisputeButton: "End the paused dispute",
  endDisputeReady: "The dispute time limit has passed — anyone can end the paused dispute; the clock resumes.",
  disputeSplitReady: (pct: number, payee: string, payer: string) =>
    `The dispute time limit has passed — anyone can carry out the split: ${pct}% to ${payee}, the rest to ${payer}.`,
  disputeRefundReady: (payer: string) => `The dispute time limit has passed — anyone can return it to ${payer}.`,
  disputeLimitUsedUp: "This payment's dispute time limit is used up: if you pause now, anyone can end the pause right away.",
  disputeLimitBeforeAccept: "Read this before you accept — it changes what a pause can do.",
  refundButton: (payer: string) => `Refund ${payer}`,
  refundTitle: (payer: string) => `Refund ${payer}?`,
  refundConfirm: (payer: string, amount: string) =>
    `${amount} — everything still in this payment — goes back to ${payer} now. This can't be undone, and ${payer} doesn't have to agree.`,
  refundedYou: (payee: string, amount: string) => `${payee} refunded you ${amount}`,
  youRefunded: (payer: string, amount: string) => `You refunded ${payer} ${amount}`,
  theyRefunded: (payee: string, payer: string, amount: string) => `${payee} refunded ${payer} ${amount}`,
  previewTag: "Preview",
  previewNote: "Preview: usernames and Telegram linking stay in preview until the data-retention and legal-requests pages are live on a deployed Latch service.",
  /** v0.13: messages, said once at setup and as the footer of every conversation list. */
  messagesIntro: "Chat with contacts and talk through the terms of a deal before anyone signs. Messages are encrypted on this device with a key only your wallet can recreate; the Latch service stores ciphertext and which wallets wrote to each other, and can't read what you wrote.",
  messagesSetup: "Turning this on asks your wallet to sign twice (to check it signs the same way every time) and once more to publish your messaging keys. Each later visit asks once. There is no forward secrecy: anyone who later obtains your messaging key can read your conversations.",
  messagesFooter: "Encrypted on this device. Only you and the other wallet can read these; the service sees who wrote to whom and when.",
  requestCreated: (name: string) => `${name}'s app will find this payment. When they accept, come back here to pay in.`,
  /** The requester's side of heldUntil. */
  heldForYou: (days: number, work = false) =>
    `Held until they say it's OK — or ${days} days after you ${work ? "start the clock (by 3 days after they pay in)" : "mark it shipped"}, unless they pause the clock. You can't take it early; they can't pull it back alone.`,
  /** Protection-window chip. Work counts from the start of work, not delivery. */
  /** v0.10 #4: one line under each Protected category chip. */
  categorySummary: {
    inperson: "Handed over face to face. Unlocks 3 days after they mark it handed over, unless you pause.",
    shipped: "Sent to you. Unlocks 10 days after they mark it shipped, unless you pause.",
    work: "A job or a service. Unlocks 14 days after they start the clock, unless you pause.",
    deposit: "Held for a booking or an order and returned to you after the window unless you both release it. Opens the agreement builder, pre-filled.",
    vehicle: "Payment only; title transfer is separate. Opens the agreement builder, pre-filled with a 14-day window.",
  } as Record<string, string>,
  presetChip: (p: { id: string; label: string; days: number }) => (p.id === "work" ? `${p.label} · ${p.days} d from start` : `${p.label} · ${p.days} d`),
  startWorkButton: "Start the clock — work has begun",
  payeeFundedWork: (payer: string, startBy: string, endIfNow: string, days: number) =>
    `Start the clock when work begins — by ${startBy}. The ${days} days run from the start, not from delivery: start now and it becomes collectable by you on ${endIfNow}, unless ${payer} pauses. After ${startBy}, anyone can return the money to ${payer}.`,
  payerFundedWork: (name: string, date: string, days: number) =>
    `The ${days} days run from when ${name} starts the clock, not from delivery. Returns to you from ${date} if ${name} hasn't started it. Until someone sends it back, ${name} can still start it.`,
  heldUntilGeneric: "Held until you say it's OK — or 3, 10 or 14 days (you choose) after the recipient marks it shipped, unless you pause the clock.",
  splitsOn: (date: string) => `Splits on ${date} — anyone can carry it out.`,
  splitsAfter: (days: number) => `Splits ${days} days after it's marked shipped — anyone can carry it out.`,
  welcomeBody:
    "Pay anyone. Choose how much protection you want: instant, protected, or your own rules. The money is held by the deal's own rules on Solana. " + CUSTODY,

  testBanner: "Test mode — Solana devnet, no real money",

  protectedCard: (name: string) =>
    `${name} can't take it early; you can't pull it back alone.`,
  pauseLine: "Problem? Either of you can pause the clock — no time limit. While paused it moves only when you both sign the same split; only whoever paused can resume.",
  /**
   * v0.6 #3 — the full pause rules, for either party. `recipient` is how to
   * name the payee from the reader's side ("you" or their name).
   */
  pauseRules: (recipient: string) =>
    `Either of you can pause the clock. Pausing has no time limit. While paused, the money moves only when you both sign the same split. Only whoever paused can resume, and resuming restarts the clock toward ${recipient === "you" ? "you" : recipient}. ${CUSTODY}`,
  /** The pause sheet, written for the person about to pause. */
  /** `limit` (v0.7): the deal's dispute policy sentence; absent = NeverExpire ("no time limit"). */
  pauseSheet: (other: string, recipient: string, limit?: string) =>
    limit
      ? `${limit} Until then, the money moves only when you and ${other} sign the same split. Only you can resume, and resuming restarts the clock toward ${recipient}. ${CUSTODY}`
      : `Pausing has no time limit. While paused, the money moves only when you and ${other} sign the same split. Only you can resume, and resuming restarts the clock toward ${recipient}. ${CUSTODY}`,
  /** Banner on a paused deal, for whichever party paused. */
  pausedBanner: (pauserIsMe: boolean, pauser: string, other: string, recipient: string, limit?: string) =>
    limit
      ? `${pauserIsMe ? "You" : pauser} paused the clock. ${limit} Until then, the money moves only when you${pauserIsMe ? ` and ${other}` : " both"} sign the same split. Only ${pauserIsMe ? "you" : pauser} can resume, and resuming restarts the clock toward ${recipient}.`
      : pauserIsMe
      ? `You paused the clock. There's no time limit. While paused, the money moves only when you and ${other} sign the same split. Only you can resume, and resuming restarts the clock toward ${recipient}.`
      : `${pauser} paused the clock. There's no time limit. While paused, the money moves only when you both sign the same split. Only ${pauser} can resume, and resuming restarts the clock toward ${recipient}.`,
  noLatch: "No one at Latch decides.",
  instantCard: (name: string) => `Arrives now. Final. Nobody can undo it — not ${name}, not you, not Latch.`,
  customCard: "Your own rules: pay in parts, name someone you both trust to decide, or set your own timer.",

  costProtected: (rent: string) => `No Latch fee · network deposit ≈${rent} SOL (not returned in this version)`,
  costInstant: "No Latch fee · network fee under 0.001 SOL",

  pausedNoOne: "No one at Latch decides. " + CUSTODY,

  // Activation window (refund_unactivated, 3 days after paying in).
  prePayLapse: (name: string) =>
    `If ${name} hasn't marked it shipped within 3 days of you paying in, you — or anyone — can return the full amount to you. The ≈0.01 SOL network deposit isn't returned.`,
  // v0.7 #4: a partly paid-in Signed deal lapses 3 days after SIGNING (signed_at), not after paying in.
  partialPayer: (dep: string, total: string, date: string) =>
    `You've paid in ${dep} of ${total}. Pay in the rest to continue. From ${date} (3 days after you both signed), anyone can return what's in it to you if it still isn't fully paid in.`,
  partialPayerLapsed: (dep: string) => `Not fully paid in within 3 days of signing — you (or anyone) can return the ${dep} to yourself now.`,
  partialOther: (payer: string, dep: string, total: string, date: string) =>
    `${payer} has paid in ${dep} of ${total}. From ${date} (3 days after signing), anyone can return it to ${payer} if the rest isn't paid in.`,
  partialOtherLapsed: (payer: string) => `Not fully paid in within 3 days of signing — anyone can return it to ${payer}.`,
  paidInAgo: (ago: string) => `You paid in ${ago} ago.`,
  payeeNoFee: "No Latch fee for you.",
  payerFunded: (name: string, date: string) =>
    `Returns to you from ${date} if ${name} hasn't marked it shipped. Until someone sends it back, ${name} can still mark it shipped.`,
  payerLapsed: (name: string) =>
    `${name} didn't mark it shipped in time. You — or anyone — can return the full amount to you now. Until someone does, ${name} can still mark it shipped.`,
  payeeFunded: (payer: string, date: string) => `Mark as shipped BEFORE you ship — by ${date}. After that, anyone can return the money to ${payer}.`,
  payeeLapsed: (payer: string) =>
    `Don't ship. The time to mark it shipped has passed and anyone can now return the money to ${payer}. Only ship if you mark it shipped first and this page then shows the protection clock running.`,
  returnMoney: (payer: string) => `Return the money to ${payer}`,
  lateShipButton: "I've already shipped — mark as shipped",
  lateShipConfirm: (payer: string) => `Only if you've already shipped — ${payer} can take back the money until you do this.`,

  arbiterNoUnlock: "No automatic unlock — the person you both name decides any split if you disagree.",
  trueDeadlock: "Nobody decides and there is no timer. If you disagree, the money stays locked until you both sign the same split.",

  evidenceName: "Evidence packet (court-readable)",
  evidenceLimits:
    "This record is generated from public Solana data and can be checked by anyone. It is not a legal certification, and Latch Labs does not certify it.",

  issuerFreeze: "The USDC issuer can freeze any USDC, including USDC held in a protected payment.",

  howItWorks: [
    {
      q: "What happens",
      a: "Your money goes into a deal account on Solana that moves by the deal's rules. When you say everything's OK — or when the protection window ends — the money becomes collectable by the recipient: anyone can send it to them. " + CUSTODY,
    },
    {
      q: "When it unlocks",
      a: "The window starts when the recipient marks it shipped or handed over. You see the exact unlock date and time on the payment page.",
    },
    {
      q: "If something's wrong",
      a: "Either of you can pause the clock before the window ends. Pausing has no time limit; while paused, the money moves only when you both sign the same split. Only whoever paused can resume, and resuming restarts the clock toward the recipient. No one at Latch decides. " + CUSTODY,
    },
    {
      q: "If they never start",
      a: "After you pay in, the recipient has 3 days to mark it shipped or handed over. If they haven't by then, you — or anyone — can return the full amount to you. Until someone sends it back, they can still mark it shipped. The ≈0.01 SOL network deposit isn't returned.",
    },
    {
      q: "Can the rules change?",
      a: "This test version runs on Solana devnet, where the program's code can be replaced by whoever holds its upgrade key. Each time you create, accept, pay in or mark shipped, the app checks the deployed code's fingerprint against the one it was checked with and refuses if they differ. Settings → Verify Latch shows both, and every agreement states the fingerprint the app verified.",
    },
    {
      q: "What it isn't",
      a: "It is not insurance and not a refund promise. It holds the money until the two of you agree, or until the window ends unpaused.",
    },
    {
      q: "Keep your wallet",
      a: "Only your wallet can act for you. Protected payments have no backup signers — if you lose your wallet while paused, it stays locked. On a custom payment, the backup signers you chose (if any) are the only way to divide the money.",
    },
    {
      q: "Costs",
      a: "No Latch fee. Whoever creates the payment locks a small network deposit (about 0.01 SOL) that is not returned in this version.",
    },
    {
      q: "Token issuer",
      a: "The USDC issuer can freeze any USDC, including USDC held in a protected payment.",
    },
  ],

  simulatedLabel: "Simulated",
  partnerGated: "Not available yet — needs a licensed partner",
  rampsBody:
    "Card and bank top-ups will come from a licensed partner, inside the partner's own screens. Latch never touches your card or bank money. Until then, add test USDC or SOL from a faucet.",
} as const;

export const BANNED_WORDS = [
  "escrow",
  "free",
  "money back",
  "guarantee",
  "insured",
  "trustless",
  "court-ready",
  "court ready",
  "open standard",
  "automatically released",
  "layer 2",
  "safe",
  "admissible",
  "judicially noticeable",
  "buyer protection",
];

/** Banned phrasings (v0.6 #1): open-ended or automatic promises the program doesn't make. */
export const BANNED_PHRASES = [/until (it'?s|it is) received/i, /automatic(ally)? (split|unlock|release)/i, /refund(ed)? to you/i];
