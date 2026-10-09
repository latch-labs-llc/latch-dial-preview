import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { StatusPill, Accordion, Avatar, Button, Cell, KV, NavBar, Section, Sheet, download, useAsync, useNow, useToast } from "../components/ui";
import { ACTIVATION_WINDOW_SECS, assetForMint, explorerAddr, explorerTx, NATIVE_MINT } from "../lib/config";
import { fetchDeal, tokenBalance } from "../lib/chain";
import { COPY } from "../lib/copy";
import { useData } from "../lib/data";
import { hasBit, hasDisputeLimit, partyIndex, remaining, type Deal } from "../lib/deal";
import * as F from "../lib/flows";
import { MAX_DOCS_PER_PRESENTATION, acknowledgeDocuments, fetchDocumentRecords, presentDocuments, sha256File } from "../lib/documents";
import { absTime, chunked, duration, money, parseAmount, short } from "../lib/format";
import { haptic } from "../lib/haptics";
import { go } from "../lib/router";
import { updateLocal, useLocal } from "../lib/store";
import { decodeBlob } from "../lib/template";
import { decodeBlobC1 } from "../lib/templateC1";
import { C1_NOTE, UNREADABLE, agreementStatus, signBlocked as signGate, statusLabel } from "../lib/agreementCheck";
import { ACTION_SECTION, disputeExpired, disputeLimitText, disputeUsed, isWorkDeal, nameFor, refundNote, terminalPill, viewDeal, type Action } from "../lib/view";
import { clauseIndex } from "../lib/customTerms";
import { lastEvents } from "../lib/events";
import { DEMO_LABEL, demoAct, demoActions, isDemoSeller } from "../lib/demo";
import { explainError, useAllowedWallet, useAgreementSend, useSend } from "../lib/wallet";
import HowItWorks from "./HowItWorks";
import ShareSheet from "./ShareSheet";
import WalletSheet from "./WalletSheet";

const RULE_TEXT: Record<string, string> = {
  TimeoutRelease: "Unlocks to the recipient when the window ends, unless paused",
  TimeoutRefund: "Returns to the payer when the window ends, unless settled",
  AutoSplit: "", // dated: see ruleText
  TieBreaker: "Someone you both named decides — no automatic unlock",
  LongSunset: "Locked until you agree; returns to the payer after a long sunset",
  TrueDeadlock: "Nobody decides, no timer — locked until you both agree",
};

/** A3/A4/A5: the deal page. Every number shown here is derived from chain data. */
/** Actions that sign, fund or activate a deal: each re-checks the deployed program first (v0.5 #2). */
// Guarded by the program check (programGuard) before sending. v0.7: the payee
// refund moves money on the program's say-so, so it is guarded too.
export const SIGNS_AGREEMENT: Action[] = ["accept", "acceptAndPay", "pay", "markShipped", "confirmReady", "refundByPayee"];

export default function DealPage({ address, blobParam, legacySubject }: { address?: string; blobParam: string | null; legacySubject: string | null }) {
  const { connection } = useConnection();
  const { publicKey } = useAllowedWallet();
  const { refresh, upsert, completedWith } = useData();
  const local = useLocal((d) => d);
  const send = useSend();
  const sendAgreement = useAgreementSend();
  const toast = useToast();
  const now = useNow(1000);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState<null | "refund" | "pause" | "split" | "decide" | "recovery" | "lateShip" | "share" | "wallet" | "how" | "save" | "documents" | "acks" | "payPart">(null);
  const [partStr, setPartStr] = useState("");
  // v0.10 #5: the terms list is folded for Protected payments (the hero says what matters); open for custom agreements.
  const [termsOpen, setTermsOpen] = useState<boolean | null>(null);
  // v0.8 #6: documents picked for the next stage (hashed on this device; the files stay here).
  const [docQueue, setDocQueue] = useState<{ name: string; sha256: string; file: string }[]>([]);
  const [docName, setDocName] = useState("");
  const [docError, setDocError] = useState("");
  // v0.15: digests the receiving party ticks before acknowledging (all presented for the next stage, by default).
  const [ackSkip, setAckSkip] = useState<Record<string, boolean>>({});
  const [afterSave, setAfterSave] = useState<null | { a: Action; build: () => Promise<any[]> }>(null);
  const [splitStr, setSplitStr] = useState("");
  const [consentTD, setConsentTD] = useState(false);

  const key = useMemo(() => {
    try {
      return address ? new PublicKey(address) : null;
    } catch {
      return null;
    }
  }, [address]);

  // Remember the link blob on this device (keeps the agreement regenerable).
  useEffect(() => {
    if (key && blobParam && (decodeBlob(blobParam) || decodeBlobC1(blobParam))) updateLocal((d) => void (d.links[key.toBase58()] = blobParam));
  }, [key?.toBase58(), blobParam]);

  const q = useAsync(async () => (key ? fetchDeal(connection, key) : null), [key?.toBase58(), connection]);
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === "visible" && q.reload(), 10000);
    return () => window.clearInterval(t);
  }, [q.reload]);
  const d = q.data;

  const wsol = useAsync(
    async () => (publicKey && d && d.mint.equals(NATIVE_MINT) ? tokenBalance(connection, publicKey, NATIVE_MINT) : 0n),
    [publicKey?.toBase58(), d?.state, d?.address.toBase58()],
  );

  // v0.7 #3: who closed it (a payee refund reads the same on-chain as a cancel).
  const closing = useAsync(
    async () => (d && (d.state === "Completed" || d.state === "Cancelled") ? lastEvents(connection, d.address) : []),
    [d?.state, d?.address.toBase58()],
  );
  // v0.8 #6: documents presented so far (only staged deals carry them; one RPC read per transaction).
  const presented = useAsync(
    async () => (d && d.milestones.length > 1 ? fetchDocumentRecords(connection, d) : { presented: [], acknowledged: [] }),
    [d?.address.toBase58(), d ? d.milestones.map((m) => `${m.approvals}${m.released ? "r" : ""}`).join(",") : ""],
  );

  if (!key) return <><NavBar title="Payment" backTo="/" /><div className="empty">That isn't a valid payment link.</div></>;
  if (q.loading && !d) return <><NavBar title="Payment" backTo="/" /><div className="empty"><span className="spinner" /></div></>;
  if (!d) return <><NavBar title="Payment" backTo="/" /><div className="empty">{q.error ?? "No Latch payment exists at this address on devnet."}</div></>;

  const asset = assetForMint(d.mint);
  const decimals = asset?.decimals ?? 6;
  const v = viewDeal(d, publicKey, local, now);
  const me = publicKey;
  const myIdx = partyIndex(d, me);
  const payerKey = d.parties[d.payerIdx];
  const payeeKey = d.parties[d.payeeIdx];
  const other = v.role === "payer" ? payeeKey : payerKey;
  const otherName = nameFor(other, local);
  const blobStr = blobParam ?? local.links[d.address.toBase58()];
  const status = agreementStatus(d, blobStr, decimals);
  const linkBlob = blobStr ? decodeBlob(blobStr) : null;
  const suggestedDocs: string[] = linkBlob?.t === "trade@2" ? (linkBlob.p.documents as string[]) : [];
  const staged = d.milestones.length > 1;
  const check = status.kind === "verified" ? status : null;
  // v0.9 #5: the clause behind each action group, from the verified text itself.
  const clauses = check ? clauseIndex(check.text) : [];
  const why = (actionsHere: Action[], pick?: RegExp) => {
    const live = actionsHere.filter((a) => actions.includes(a));
    if (!live.length || !clauses.length) return null;
    const n = ACTION_SECTION[live[0]];
    const c = clauses.find((x) => x.n === n);
    if (!c) return null;
    const sentences = c.body.replace(/\n\s*/g, " ").split(/(?<=\.)\s+/);
    const s = (pick && sentences.find((x) => pick.test(x))) || sentences[0];
    return (
      <div className="caption" style={{ padding: "0 4px", lineHeight: "16px" }}>
        §{n} {c.title.replace(/ \(.*\)$/, "").toLowerCase()} — {s}
      </div>
    );
  };
  const blob = status.kind === "verified" || status.kind === "mismatch" ? status.blob : null;
  const subject = (check ? check.blob.s : null) ?? legacySubject ?? "";
  const known = !!local.contacts[other.toBase58()] || completedWith.has(other.toBase58()) || Object.values(local.threads).some((th) => th.peer === other.toBase58() && th.messages.length > 0);
  const unknownMint = !asset;
  const work = isWorkDeal(d, local);
  // v0.7 #5: a dispute time limit (custom deals) — stated wherever the pause rules are.
  const limit = d.timerMode === "FromActivation" && d.disputePolicy !== "NeverExpire" && d.disputeWindowSecs > 0 ? disputeLimitText(d, local, publicKey) : undefined;

  // v0.11 #1: on a deal with the demo seller, the user can press the seller's buttons too (its key is public devnet play money).
  const demoHere = d.parties.some((p) => isDemoSeller(p)) && !isDemoSeller(me);
  const demoAvail = demoHere ? demoActions(d, local, now) : [];
  const demoRun = async (a: Action) => {
    setBusy(a);
    setError("");
    try {
      await demoAct(connection, d, a);
      const fresh = await fetchDeal(connection, d.address);
      if (fresh) upsert(fresh);
      q.reload();
      refresh();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async (a: Action, build: () => Promise<any[]>) => {
    if (!me) return setSheet("wallet");
    setBusy(a);
    setError("");
    try {
      // Accepting, paying in or confirming ready signs/funds/activates the deal: guard the program first.
      await (SIGNS_AGREEMENT.includes(a) ? sendAgreement : send)(await build());
      const fresh = await fetchDeal(connection, d.address);
      if (fresh) upsert(fresh);
      q.reload();
      refresh();
      if (a === "markShipped" || a === "release") haptic("impact");
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(null);
      setSheet(null);
    }
  };

  const wrapNeeded = async (): Promise<bigint> => {
    if (!me || !d.mint.equals(NATIVE_MINT)) return 0n;
    const have = await tokenBalance(connection, me, NATIVE_MINT);
    const owed = d.totalAmount - d.deposited;
    return owed > have ? owed - have : 0n;
  };

  // v0.9 #5: options for a partial pay-in from the sheet (amount typed, SOL wrapped only as far as needed).
  const partOpts = async (): Promise<{ amount: bigint; wrapLamports: bigint }> => {
    const amount = parseAmount(partStr, decimals) ?? 0n;
    const have = d.mint.equals(NATIVE_MINT) && me ? await tokenBalance(connection, me, NATIVE_MINT) : 0n;
    return { amount, wrapLamports: d.mint.equals(NATIVE_MINT) && amount > have ? amount - have : 0n };
  };

  // Save gate (founder decision): keep your own copy before paying in.
  const savedCopy = !!local.saved[d.address.toBase58()];
  const gated = (a: Action, build: () => Promise<any[]>) => {
    if (!savedCopy && check) {
      setAfterSave({ a, build });
      setSheet("save");
      return;
    }
    run(a, build);
  };
  const saveCopy = () => {
    if (!check) return;
    download(`latch-agreement-${check.hex.slice(0, 8)}.txt`, check.text);
    const att = local.attachments[d.address.toBase58()];
    if (att) download(`latch-details-${d.address.toBase58().slice(0, 8)}.txt`, att);
    updateLocal((x) => void (x.saved[d.address.toBase58()] = Math.floor(Date.now() / 1000)));
  };

  const needsTDConsent = d.rule === "TrueDeadlock";
  // Never accept, sign or pay in on text we can't regenerate (v1 deals are checked in the original app).
  const signBlocked = signGate(status, legacySubject); // legacy subject is display-only (v0.5 #1)
  const actions = v.actions;
  const btn = (a: Action, label: string, build: () => Promise<any[]>, kind: "primary" | "secondary" | "danger" = "primary", disabled = false) =>
    actions.includes(a) ? (
      <Button key={a} kind={kind} busy={busy === a} disabled={!!busy || disabled} onClick={() => (a === "pay" || a === "acceptAndPay" ? gated(a, build) : run(a, build))}>
        {label}
      </Button>
    ) : null;

  // --------------------------------------------------------------- ladder
  const steps =
    v.mode === "protected"
      ? [
          { l: "Agreed", done: d.state !== "Draft" && d.state !== "Cancelled" },
          { l: "Paid in", done: d.deposited >= d.totalAmount && d.totalAmount > 0n },
          { l: work ? "Started" : "Shipped", done: ["Active", "Deadlocked", "Completed"].includes(d.state) },
          { l: d.state === "Completed" ? "Paid out" : v.unlock ? absTime(v.unlock) : "Unlocks", done: d.state === "Completed" },
        ]
      : [
          { l: "Agreed", done: d.state !== "Draft" && d.state !== "Cancelled" },
          { l: "Paid in", done: d.deposited >= d.totalAmount && d.totalAmount > 0n },
          ...d.milestones.map((m, i) => ({ l: `Part ${i + 1}${!m.released && m.approvals ? ` · ${F.popcount(m.approvals)}/${d.approvalThreshold}` : ""}`, done: m.released })),
        ];
  // An ended deal has no "current" step (v0.8 #1): a Cancelled deal's ladder used to point at "Agreed".
  const ended = terminalPill(d);
  const termsOpenNow = termsOpen ?? v.mode !== "protected";
  const nextStage = d.milestones.findIndex((m) => !m.released);
  // v0.15: documents another party presented for the next part that I haven't acknowledged yet.
  const presentedDocs = presented.data?.presented ?? [];
  const acks = presented.data?.acknowledged ?? [];
  const ackedByMe = (sha256: string, stage: number) => !!me && acks.some((a) => a.by === me.toBase58() && a.sha256 === sha256 && a.stage === stage);
  const toAck = me ? presentedDocs.filter((x) => x.stage === nextStage && x.presenter !== me.toBase58() && !ackedByMe(x.sha256, x.stage)) : [];
  const ackChosen = toAck.filter((x) => !ackSkip[x.sha256]).map((x) => x.sha256);
  const nowIdx = ended ? -1 : steps.findIndex((s) => !s.done);

  return (
    <>
      <NavBar
        title={v.mode === "protected" ? "Protected payment" : v.mode === "custom" ? "Agreement" : "Payment"}
        backTo="/"
        right={
          blobStr ? (
            <button className="navbtn" onClick={() => setSheet("share")}>
              Share
            </button>
          ) : undefined
        }
      />

      {!known && v.role !== "viewer" && d.state !== "Completed" && (
        <div className="banner stranger">
          <b>New to you · never paid.</b> Check the address below before doing anything.
          <div className="mono caption" style={{ marginTop: 4 }}>{chunked(other.toBase58())}</div>
          <div className="actions">
            <button onClick={() => go(`/contact/new?address=${other.toBase58()}`)}>Save as contact</button>
            <button
              onClick={() => {
                updateLocal((x) => void x.blocked.push(d.creator.toBase58()));
                toast("Blocked on this device");
                go("/");
              }}
            >
              Block
            </button>
            <button
              onClick={() => {
                updateLocal((x) => void x.hidden.push(d.address.toBase58()));
                go("/");
              }}
            >
              Hide
            </button>
          </div>
        </div>
      )}

      <div className="hero">
        <Avatar address={other.toBase58()} name={otherName} mode={v.mode === "instant" ? undefined : v.mode} />
        <div className="amt" style={{ marginTop: 10 }}>{v.amount}</div>
        <div className="sub">
          {v.role === "payer" ? `to ${otherName}` : v.role === "payee" ? `from ${otherName}` : `${nameFor(payerKey, local)} → ${nameFor(payeeKey, local)}`}
          {subject ? ` · “${subject}”` : ""}
        </div>
        <div className="state">
          {d.state === "Deadlocked" ? <StatusPill kind="paused">Paused</StatusPill> : ended ? <StatusPill kind={ended.cls}>{ended.text.replace(/^[^A-Za-z]+/, "")}</StatusPill> : v.needsYou ? <StatusPill kind="move">Your move</StatusPill> : null}
        </div>
        <div className="state">{refundNote(closing.data ?? [], d, publicKey, local) ?? v.sentence}</div>
        {d.state === "Active" && v.left != null && v.left > 0 && <Countdown left={v.left} total={d.timeoutSecs} />}
      </div>


      {Object.values(local.requests).some((r) => r.conflict?.includes(d.address.toBase58())) && (
        <div className="banner error">More than one payment claims to answer your request. This one is not confirmed as yours — check with the payer before accepting.</div>
      )}
      {unknownMint && <div className="banner warn">This payment uses a token Latch doesn't recognise, so amounts are shown as plain token counts.</div>}
      {status.kind === "mismatch" && <div className="banner error">The agreement text from this link does NOT match what's on-chain. Don't sign or pay. Ask for the original link.</div>}
      {status.kind === "unreadable" && <div className="banner warn">{UNREADABLE}</div>}
      {check?.format === "c1" && <div className="banner">{C1_NOTE}</div>}
      {status.kind === "none" && !legacySubject && d.state === "Draft" && myIdx >= 0 && !hasBit(d.signed, myIdx) && (
        <div className="banner warn">This device doesn't have the agreement for this payment. Open it from the link you were sent so you can read what you're signing.</div>
      )}
      {legacySubject && !blob && <div className="banner">Made with an older agreement template (v1). The text can be checked in the original Latch app.</div>}

      {d.state === "Funded" && (() => {
        const lapse = d.fundedAt + ACTIVATION_WINDOW_SECS;
        const lapsed = now >= lapse;
        const payerName = nameFor(payerKey, local);
        const payeeName = nameFor(payeeKey, local);
        if (v.role === "payer" && !hasBit(d.ready, d.payeeIdx))
          return <div className="banner warn">{d.fundedAt > 0 && `${COPY.paidInAgo(duration(now - d.fundedAt))} `}{lapsed ? COPY.payerLapsed(payeeName) : work ? COPY.payerFundedWork(payeeName, absTime(lapse), d.timeoutSecs / 86400) : COPY.payerFunded(payeeName, absTime(lapse))}</div>;
        if (v.role === "payee" && !hasBit(d.ready, d.payeeIdx))
          return (
            <div className={`banner ${lapsed ? "error" : "warn"}`}>
              {lapsed ? COPY.payeeLapsed(payerName) : work ? COPY.payeeFundedWork(payerName, absTime(lapse), absTime(now + d.timeoutSecs), d.timeoutSecs / 86400) : COPY.payeeFunded(payerName, absTime(lapse))}
            </div>
          );
        if (lapsed) return <div className="banner">This payment wasn't started within 3 days of being paid in. Anyone can return it to {payerName}.</div>;
        return null;
      })()}
      {d.state === "Deadlocked" && (v.mode === "protected" || limit) && (
        <div className="banner">
          {(limit && disputeExpired(d, now)
            ? `${me && d.deadlockRaisedBy.equals(me) ? "You" : nameFor(d.deadlockRaisedBy, local)} paused the clock. ${v.sentence}`
            : COPY.pausedBanner(!!me && d.deadlockRaisedBy.equals(me), nameFor(d.deadlockRaisedBy, local), otherName, v.role === "payee" ? "you" : nameFor(payeeKey, local), limit))} {COPY.pausedNoOne}
        </div>
      )}
      {d.rule === "TieBreaker" && d.state !== "Completed" && <div className="banner">{COPY.arbiterNoUnlock}</div>}
      {hasDisputeLimit(d) && d.state !== "Completed" && d.state !== "Cancelled" && d.state !== "Deadlocked" && (
        <div className="banner warn" data-testid="dispute-limit">
          {disputeLimitText(d, local, publicKey)}
          {myIdx >= 0 && !hasBit(d.signed, myIdx) ? ` ${COPY.disputeLimitBeforeAccept}` : ""}
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      {/* ----------------------------------------------------------- actions */}
      <div className="stack no-print">
        {needsTDConsent && (actions.includes("accept") || actions.includes("acceptAndPay")) && (
          <label className="banner" style={{ display: "flex", gap: 10, margin: 0 }}>
            <input type="checkbox" checked={consentTD} onChange={(e) => setConsentTD(e.target.checked)} />
            <span>{COPY.trueDeadlock} I understand and agree.</span>
          </label>
        )}
        {btn("acceptAndPay", `Accept & pay ${v.amount}`, async () => F.fund(d, me!, { alsoSign: true, consentTrueDeadlock: consentTD, wrapLamports: await wrapNeeded() }), "primary", signBlocked || (needsTDConsent && !consentTD))}
        {v.role === "payee" && actions.includes("accept") && <div className="caption" style={{ textAlign: "center" }}>{COPY.payeeNoFee}</div>}
        {btn("accept", v.role === "payee" ? "Accept payment" : "Accept & sign", async () => [await F.signTerms(d.address, me!, consentTD)], "primary", signBlocked || (needsTDConsent && !consentTD))}
        {btn("pay", `Pay in ${d.deposited > 0n ? `the remaining ${money(d.totalAmount - d.deposited, asset)}` : v.amount}`, async () => F.fund(d, me!, { wrapLamports: await wrapNeeded() }), "primary", signBlocked)}
        {actions.includes("pay") && !signBlocked && (
          <Button kind="plain" disabled={!!busy} onClick={() => (setPartStr(""), setSheet("payPart"))}>
            Pay in part of it now
          </Button>
        )}
        {why(["accept", "acceptAndPay", "pay"])}
        {v.lateShip ? (
          <Button kind="secondary" disabled={!!busy} onClick={() => setSheet("lateShip")}>
            {COPY.lateShipButton}
          </Button>
        ) : (
          btn("markShipped", work ? COPY.startWorkButton : "Mark as shipped / handed over", async () => F.markShipped(d, me!, v.mode === "protected"))
        )}
        {btn("confirmReady", "Confirm ready", async () => F.markShipped(d, me!, false))}
        {staged && actions.includes("release") && (
          <Button kind="secondary" disabled={!!busy} onClick={() => (setDocError(""), setSheet("documents"))}>
            Present documents for part {nextStage + 1}
          </Button>
        )}
        {staged && actions.includes("release") && toAck.length > 0 && (
          <Button kind="secondary" disabled={!!busy} onClick={() => (setDocError(""), setAckSkip({}), setSheet("acks"))}>
            Acknowledge {toAck.length} document{toAck.length === 1 ? "" : "s"} & approve part {nextStage + 1}
          </Button>
        )}
        {actions.includes("release") && actions.includes("pause") ? (
          <div className="btn-row">
            {btn("release", d.milestones.length > 1 ? "Approve this part" : "Everything's OK", async () => F.approveAndMaybeRelease(d, me!), "secondary")}
            <Button kind="secondary" disabled={!!busy} onClick={() => setSheet("pause")}>
              Something's wrong
            </Button>
          </div>
        ) : (
          <>
            {btn("release", d.milestones.length > 1 ? "Approve this part" : "Everything's OK — release now", async () => F.approveAndMaybeRelease(d, me!), "secondary")}
            {actions.includes("pause") && (
              <Button kind="secondary" disabled={!!busy} onClick={() => setSheet("pause")}>
                Something's wrong — pause the clock
              </Button>
            )}
          </>
        )}
        {why(["markShipped", "confirmReady", "release"])}
        {btn("crankRelease", "Send this part now", async () => F.crankRelease(d, me!))}
        {btn("collect", v.role === "payee" ? "Collect now" : "Settle now", async () => F.collect(d, me!))}
        {btn(
          "refundUnactivated",
          v.role === "payer" ? "Return my money" : COPY.returnMoney(nameFor(payerKey, local)),
          async () => F.refundUnactivated(d, me!),
          v.role === "payer" ? "primary" : "secondary",
        )}
        {btn("acceptSplit", "Accept this split", async () => F.acceptSplit(d, me!))}
        {actions.includes("proposeSplit") && (
          <Button kind="secondary" disabled={!!busy} onClick={() => setSheet("split")}>
            {d.proposalActive ? "Propose a different split" : "Propose a split"}
          </Button>
        )}
        {actions.includes("decide") && (
          <Button disabled={!!busy} onClick={() => setSheet("decide")}>
            Decide the split
          </Button>
        )}
        {why(["crankRelease"])}
        {why(["pause", "collect", "acceptSplit", "proposeSplit", "decide", "resume", "endDispute", "refundUnactivated"])}
        {btn("recoverySign", "Co-sign this division", async () => F.recoverySign(d.address, me!, d.recoveryProposedToPayee))}
        {actions.includes("recoveryPropose") && (
          <Button kind="secondary" disabled={!!busy} onClick={() => setSheet("recovery")}>
            {d.recoveryProposalActive ? "Propose a different division (resets signatures)" : "Propose a division (backup signer)"}
          </Button>
        )}
        {btn("recoveryExecute", "Carry out the division", async () => F.recoveryExecute(d, me!))}
        {why(["recoverySign", "recoveryPropose", "recoveryExecute"])}
        {btn("resume", "Resume the clock", async () => F.resume(d.address, me!), "secondary")}
        {btn("endDispute", COPY.endDisputeButton, async () => F.resume(d.address, me!), "secondary")}
        {actions.includes("cancelDraft") && d.state === "Draft" && (
          <Button kind="plain" busy={busy === "cancelDraft"} disabled={!!busy} onClick={() => run("cancelDraft", () => F.cancelDraft(d.address, me!))}>
            {v.role === "payer" && d.creator.equals(me!) ? "Cancel" : "Decline (costs a small network fee)"}
          </Button>
        )}
        {actions.includes("refundByPayee") && (
          <Button kind="plain" disabled={!!busy} onClick={() => setSheet("refund")}>
            {COPY.refundButton(nameFor(payerKey, local))}
          </Button>
        )}
        {actions.includes("cancelTogether") && (
          <Button kind="plain" busy={busy === "cancelTogether"} disabled={!!busy || hasBit(d.cancelApprovals, myIdx)} onClick={() => run("cancelTogether", () => F.cancelTogether(d, me!))}>
            {hasBit(d.cancelApprovals, myIdx) ? `Waiting for ${otherName} to cancel too` : "Cancel together"}
          </Button>
        )}
        {(d.state === "Completed" || d.state === "Cancelled") && d.mint.equals(NATIVE_MINT) && (wsol.data ?? 0n) > 0n && (
          <Button kind="secondary" busy={busy === "collect"} onClick={() => run("collect", async () => [F.unwrapSolIx(me!)])}>
            Unwrap {money(wsol.data!, asset)} to SOL
          </Button>
        )}
        {d.state === "Completed" && !local.contacts[other.toBase58()] && v.role !== "viewer" && (
          <div className="banner" style={{ margin: 0 }}>
            Done with {short(other.toBase58())}. Save them so next time you pay a name, not an address.
            <div className="actions">
              <button onClick={() => go(`/contact/new?address=${other.toBase58()}`)}>Save {short(other.toBase58())} as a contact</button>
            </div>
          </div>
        )}
        {!me && (
          <Button onClick={() => setSheet("wallet")}>Connect a wallet to act</Button>
        )}
      </div>

      {demoHere && (
        <Section header="Demo seller's side" footer="This wallet's key is public devnet play money, so you can press its buttons and watch both sides of the deal. A real counterparty would do this from their own phone.">
          {demoAvail.length === 0 ? (
            <Cell title="Nothing for the demo seller to do right now" subtitle="Your move, or the deal is done." wrap />
          ) : (
            demoAvail.map((a) => <Cell key={a} title={busy === a ? "Sending…" : DEMO_LABEL[a] ?? a} link onClick={() => !busy && demoRun(a)} />)
          )}
        </Section>
      )}
      <Section>
        <div style={{ padding: "4px 12px 10px" }}>
          <div className="ladder">
            {steps.map((s, i) => (
              <div key={i} className={`step ${s.done ? "done" : ""} ${i === nowIdx ? (d.state === "Deadlocked" ? "paused" : "now") : ""}`}>
                <div className="dot" />
                <div className="lbl">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ----------------------------------------------------------- details */}
      <Accordion title="Terms" summary={RULE_TEXT[d.rule]} open={termsOpenNow} onToggle={setTermsOpen}>
        <KV k="Rule" v={d.rule === "AutoSplit" ? (v.unlock ? COPY.splitsOn(absTime(v.unlock)) : COPY.splitsAfter(Math.round(d.timeoutSecs / 86400))) : RULE_TEXT[d.rule]} />
        {d.timerMode === "FromActivation" && <KV k="If a pause lasts" v={disputeLimitText(d, local, publicKey)} />}
        {limit && <KV k="Paused so far" v={COPY.disputeUsed(duration(disputeUsed(d, now)), duration(d.disputeWindowSecs))} />}
        {d.timeoutSecs > 0 && <KV k="Window" v={`${duration(d.timeoutSecs)}${d.timerMode === "FromActivation" ? (work ? " from the start of work" : " from “shipped”") : " from a reported problem"}`} />}
        {d.state === "Deadlocked" && d.timerMode === "FromActivation" && <KV k="Clock" v={`Paused with ${duration(d.timeoutSecs - d.elapsedAtPause)} left`} />}
        {d.milestones.length > 1 && <KV k="Parts" v={d.milestones.map((m, i) => `${i + 1}. ${money(m.amount, asset, decimals)}${m.released ? " ✓" : ""}`).join("\n")} />}
        <KV k="Approvals" v={`${d.approvalThreshold} of ${d.parties.length} per part`} />
        <KV k="Payer" v={<><div>{nameFor(payerKey, local)}</div><div className="caption mono">{chunked(payerKey.toBase58())}</div></>} />
        <KV k="Recipient" v={<><div>{nameFor(payeeKey, local)}</div><div className="caption mono">{chunked(payeeKey.toBase58())}</div></>} />
        {d.rule === "TieBreaker" && <KV k="Decider" v={<span className="mono caption">{chunked(d.tieBreaker.toBase58())}</span>} />}
        <KV
          k="Backup signers"
          v={
            d.recoverySigners.length === 2 && d.recoverySigners.every((r) => d.parties.some((p) => p.equals(r)))
              ? "None — only the two of you"
              : `${d.recoveryThreshold} of ${d.recoverySigners.length}, after ${duration(d.recoveryDelaySecs)} notice${d.state === "Draft" || d.state === "Signed" || d.state === "Funded" ? `. ${COPY.recoveryAfterStart}` : ""}`
          }
        />
        {d.state === "Deadlocked" && d.proposalActive && <KV k="On the table" v={`${money(d.proposedToPayee, asset, decimals)} to recipient · ${money(remaining(d) - d.proposedToPayee, asset, decimals)} back`} />}
        {d.riskFlags !== 0 && <KV k="Token" v={asset?.riskNote ?? "This token carries issuer risks the parties accepted."} />}
      </Accordion>

      {staged && presentedDocs.length > 0 && (
        <Section header={`Documents presented (${presentedDocs.length})`} footer="Signed on-chain by the party that presented each file; an acknowledgement is the receiving party's own signed memo that a file with that digest reached them. The files themselves stay with the parties; a holder can hash a copy and compare.">
          {presentedDocs.map((x, i) => (
            <Cell
              key={`${x.signature}-${i}`}
              title={`Part ${x.stage + 1} · ${x.name}`}
              subtitle={`SHA-256 ${x.sha256.slice(0, 16)}… · by ${nameFor(x.presenter, local)}${x.blockTime ? ` · ${absTime(x.blockTime)}` : ""}${acks.filter((a) => a.sha256 === x.sha256 && a.stage === x.stage).map((a) => ` · received, says ${nameFor(a.by, local)}`).join("")}`}
              wrap
              href={explorerTx(x.signature)}
            />
          ))}
        </Section>
      )}
      <Section header="Record" footer={check ? `Agreement fingerprint ${check.hex.slice(0, 12)}… matches the on-chain record.` : undefined}>
        <Cell title="Agreement" value={statusLabel(status)} onClick={() => go(`/agreement/${d.address.toBase58()}`)} chevron />
        <Cell title={COPY.evidenceName} onClick={() => go(`/evidence/${d.address.toBase58()}`)} chevron />
        <Cell title="View on Solana Explorer" href={explorerAddr(d.address.toBase58())} chevron />
        <Cell title="How protection works" onClick={() => setSheet("how")} chevron />
      </Section>

      {/* ------------------------------------------------------------ sheets */}
      <Sheet open={sheet === "refund"} onClose={() => setSheet(null)} title={COPY.refundTitle(nameFor(payerKey, local))}>
        <p className="lead">{COPY.refundConfirm(nameFor(payerKey, local), money(remaining(d), asset))}</p>
        <div className="stack">
          <Button kind="danger" busy={busy === "refundByPayee"} onClick={() => run("refundByPayee", async () => F.refundByPayee(d, me!))}>
            {COPY.refundButton(nameFor(payerKey, local))} — {money(remaining(d), asset)}
          </Button>
          <Button kind="plain" onClick={() => setSheet(null)}>
            Keep the payment
          </Button>
        </div>
      </Sheet>
      <Sheet open={sheet === "documents"} onClose={() => setSheet(null)} title={`Present documents for part ${nextStage + 1}`}>
        <p className="lead">
          Each file is hashed on this device; only its name and SHA-256 go on-chain, signed by you, together with your approval of this part. The files stay with you — send them to {otherName} the way you normally would.
        </p>
        <Section footer={suggestedDocs.length ? `The agreement lists: ${suggestedDocs.join(", ")}.` : undefined}>
          <div className="field">
            <label>Name</label>
            <input list="latch-doc-names" value={docName} maxLength={40} onChange={(e) => setDocName(e.target.value)} placeholder={suggestedDocs[0] ?? "e.g. Bill of lading"} />
            <datalist id="latch-doc-names">
              {suggestedDocs.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label>File</label>
            <input
              type="file"
              disabled={!docName.trim() || docQueue.length >= MAX_DOCS_PER_PRESENTATION}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  const sha256 = await sha256File(f);
                  setDocQueue((q) => [...q.filter((x) => x.name !== docName.trim()), { name: docName.trim(), sha256, file: f.name }]);
                  setDocName("");
                  setDocError("");
                } catch (err) {
                  setDocError(explainError(err));
                }
              }}
            />
          </div>
          {docQueue.map((x) => (
            <Cell key={x.name} title={x.name} subtitle={`${x.file} · SHA-256 ${x.sha256.slice(0, 16)}…`} wrap after={<button className="navbtn" aria-label="Remove" onClick={() => setDocQueue((q) => q.filter((y) => y.name !== x.name))}>✕</button>} />
          ))}
        </Section>
        {docError && <div className="banner error">{docError}</div>}
        <div className="stack">
          <Button
            busy={busy === "release"}
            disabled={!!busy || docQueue.length === 0}
            onClick={() =>
              run("release", async () => {
                const ixs = await presentDocuments(d, me!, docQueue);
                setDocQueue([]);
                return ixs;
              })
            }
          >
            Present {docQueue.length || ""} document{docQueue.length === 1 ? "" : "s"} & approve part {nextStage + 1}
          </Button>
          <Button kind="plain" onClick={() => setSheet(null)}>
            Not now
          </Button>
        </div>
      </Sheet>
      <Sheet open={sheet === "acks"} onClose={() => setSheet(null)} title={`Acknowledge documents for part ${nextStage + 1}`}>
        <p className="lead">
          Each line is a file the other party says they presented, by its digest. Ticking one records your own signed note that a file with that digest reached you, in the same transaction as your approval of this part. Untick anything you didn't get.
        </p>
        <Section>
          {toAck.map((x) => (
            <Cell
              key={x.sha256}
              title={x.name}
              subtitle={`SHA-256 ${x.sha256.slice(0, 16)}… · by ${nameFor(x.presenter, local)}`}
              wrap
              after={<input type="checkbox" checked={!ackSkip[x.sha256]} onChange={(e) => setAckSkip({ ...ackSkip, [x.sha256]: !e.target.checked })} aria-label={`Received ${x.name}`} />}
            />
          ))}
        </Section>
        {docError && <div className="banner error">{docError}</div>}
        <div className="stack">
          <Button busy={busy === "release"} disabled={!!busy || ackChosen.length === 0} onClick={() => run("release", async () => acknowledgeDocuments(d, me!, ackChosen))}>
            Acknowledge {ackChosen.length} & approve part {nextStage + 1}
          </Button>
          <Button kind="plain" onClick={() => setSheet(null)}>
            Not now
          </Button>
        </div>
      </Sheet>
      <Sheet open={sheet === "payPart"} onClose={() => setSheet(null)} title="Pay in part of it">
        <p className="lead">
          {money(d.totalAmount - d.deposited, asset)} is still to pay in. You can pay it in steps; the deal starts only once everything is in, and the recipient can return it all to you at any time before then.
        </p>
        <Section>
          <div className="amount-input">
            <input inputMode="decimal" value={partStr} onChange={(e) => setPartStr(e.target.value)} placeholder="0" aria-label="Amount to pay in now" />
          </div>
        </Section>
        <div className="stack">
          <Button
            busy={busy === "pay"}
            disabled={!!busy || !parseAmount(partStr, decimals) || (parseAmount(partStr, decimals) ?? 0n) <= 0n}
            onClick={() => run("pay", async () => F.fund(d, me!, await partOpts()))}
          >
            Pay in {parseAmount(partStr, decimals) ? money(parseAmount(partStr, decimals)!, asset) : "…"}
          </Button>
          <Button kind="plain" onClick={() => setSheet(null)}>
            Not now
          </Button>
        </div>
      </Sheet>
      <Sheet open={sheet === "lateShip"} onClose={() => setSheet(null)} title="Mark as shipped?">
        <p className="lead">{COPY.lateShipConfirm(nameFor(payerKey, local))}</p>
        <div className="stack">
          <Button busy={busy === "markShipped"} onClick={() => run("markShipped", async () => F.markShipped(d, me!, v.mode === "protected"))}>
            I've shipped it — mark as shipped
          </Button>
          <Button kind="plain" onClick={() => setSheet(null)}>
            Not yet — don't ship
          </Button>
        </div>
      </Sheet>
      <Sheet open={sheet === "pause"} onClose={() => setSheet(null)} title="Pause the clock?">
        <p className="lead">
          {v.mode === "protected" || limit
            ? COPY.pauseSheet(otherName, v.role === "payee" ? "you" : nameFor(payeeKey, local), limit) + (limit && d.disputePolicy === "ResumeRule" && disputeExpired(d, now) ? ` ${COPY.disputeLimitUsedUp}` : "")
            : d.rule === "TieBreaker"
              ? "The person you both named can then decide how to split the money."
              : "The deal's rule then applies to the money that's left."}
        </p>
        <div className="stack">
          <Button kind="danger" busy={busy === "pause"} onClick={() => run("pause", () => F.pause(d.address, me!))}>
            Pause the clock
          </Button>
          <Button kind="plain" onClick={() => setSheet(null)}>
            Not now
          </Button>
        </div>
      </Sheet>

      <Sheet open={sheet === "split" || sheet === "decide" || sheet === "recovery"} onClose={() => setSheet(null)} title={sheet === "decide" ? "Decide the split" : sheet === "recovery" ? "Backup signers' division" : "Propose a split"}>
        <p className="lead">
          {money(remaining(d), asset, decimals)} is in the deal. How much goes to {nameFor(payeeKey, local)}? The rest goes back to {nameFor(payerKey, local)}.
          {sheet === "split" ? " It settles once you both sign the same split." : ""}
          {sheet === "recovery"
            ? ` It needs ${d.recoveryThreshold} of ${d.recoverySigners.length} backup signers on the same amount, then stays public for ${duration(d.recoveryDelaySecs)} before anyone can carry it out — the parties can still settle first.`
            : ""}
        </p>
        <Section>
          <div className="amount-input">
            <input inputMode="decimal" value={splitStr} onChange={(e) => setSplitStr(e.target.value)} placeholder="0" aria-label="Amount to recipient" />
          </div>
        </Section>
        <div className="stack">
          {(() => {
            const amt = splitStr.trim() === "0" ? 0n : parseAmount(splitStr, decimals);
            const ok = amt != null && amt <= remaining(d);
            return (
              <Button
                disabled={!ok}
                busy={busy === "proposeSplit" || busy === "decide" || busy === "recoveryPropose"}
                onClick={() =>
                  sheet === "recovery"
                    ? run("recoveryPropose", () => F.recoverySign(d.address, me!, amt ?? 0n))
                    : run(sheet === "decide" ? "decide" : "proposeSplit", () => F.proposeSplit(d.address, me!, amt ?? 0n))
                }
              >
                {ok ? `${money(amt!, asset, decimals)} to ${nameFor(payeeKey, local)} · ${money(remaining(d) - amt!, asset, decimals)} back` : "Enter an amount"}
              </Button>
            );
          })()}
        </div>
      </Sheet>

      <Sheet open={sheet === "share"} onClose={() => setSheet(null)} title="Share">
        {blobStr && <ShareSheet url={`${window.location.origin}${window.location.pathname}#/deal/${d.address.toBase58()}?k=${blobStr}`} text={subject ? `Protected payment: ${subject}` : "Protected payment"} />}
      </Sheet>
      <Sheet open={sheet === "save"} onClose={() => setSheet(null)} title="Keep your copy">
        <p className="lead">
          {COPY.prePayLapse(nameFor(payeeKey, local))}
          <br />
          <br />
          Before you pay in, save your own copy of the agreement{local.attachments[d.address.toBase58()] ? " and its private details" : ""}. It's the only way to show exactly what you both agreed if the link is ever lost. The fingerprint on-chain proves it's the same text.
        </p>
        <div className="stack">
          <Button kind={savedCopy ? "secondary" : "primary"} onClick={saveCopy}>
            {savedCopy ? "✓ Saved — download again" : "Download my copy"}
          </Button>
          <Button
            disabled={!savedCopy}
            onClick={() => {
              const next = afterSave;
              setSheet(null);
              setAfterSave(null);
              if (next) run(next.a, next.build);
            }}
          >
            Continue to pay in
          </Button>
        </div>
      </Sheet>
      <WalletSheet open={sheet === "wallet"} onClose={() => setSheet(null)} />
      <HowItWorks open={sheet === "how"} onClose={() => setSheet(null)} />
    </>
  );
}

function Countdown({ left, total }: { left: number; total: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, left / total));
  return (
    // The caption below carries the time for screen readers; the ring is decorative.
    <div className="ring">
      <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true">
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--fill)" strokeWidth="6" />
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--protected)" strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 42 42)" />
        <text x="42" y="47" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--text)">
          {duration(left).split(" ").slice(0, 2).join(" ")}
        </text>
      </svg>
      <div className="caption">{duration(left)} left</div>
    </div>
  );
}

export type { Deal };
