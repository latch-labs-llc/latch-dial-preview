import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { ModeIcon,
  Avatar,
  Button,
  Cell,
  Dial,
  KV,
  NavBar,
  Section,
  Sheet,
  copyText,
  useToast,
  type DialMode,
} from "../components/ui";
import { ASSETS, CATEGORIES, IDENTITY_PREVIEW, ASSET_IDS, PRESETS, RENT_ESTIMATE_SOL, explorerTx, type AssetId, type PresetId } from "../lib/config";
import { COPY } from "../lib/copy";
import { useData } from "../lib/data";
import { evidenceFor, parseAddress } from "../lib/evidence";
import { suggestRecipients } from "../lib/recipients";
import * as F from "../lib/flows";
import { chunked, money, parseAmount, short } from "../lib/format";
import { haptic } from "../lib/haptics";
import { chooseDefault, riskSignals, type RiskSignal } from "../lib/policy";
import { appUrl, go } from "../lib/router";
import { getLocal, recordPayment, updateLocal, useLocal } from "../lib/store";
import { encodeBlob, uiAmount } from "../lib/template";
import { decodeRequest } from "../lib/request";
import { buildProtectedPayment } from "../lib/protected";
import { TG_BADGE, resolveName, serviceOn, type Resolved } from "../lib/service";
import { checkPin, nameKey, parseNameInput, pinName, pinWarning } from "../lib/namePins";
import { nameFor } from "../lib/view";
import { explainError, useAllowedWallet, useAgreementSend, useSend } from "../lib/wallet";
import { CompareSheet } from "./HowItWorks";
import HowItWorks from "./HowItWorks";
import ShareSheet from "./ShareSheet";
import ScanSheet from "./ScanSheet";
import { routeFor } from "../lib/scan";

type Step = "form" | "review";

/** S1–S7: Pay with the dial (evidence-keyed default, outcome card, Review, interstitial). */
export default function Pay({ query }: { query: URLSearchParams }) {
  const { publicKey } = useAllowedWallet();
  const send = useSend();
  const sendAgreement = useAgreementSend();
  const toast = useToast();
  const { deals, balances, refresh } = useData();
  const local = useLocal((d) => d);

  // A protected request link fixes recipient, amount, asset, note and window.
  const [request] = useState(() => (query.get("req") ? decodeRequest(query.get("req")!) : null));
  const badRequest = !!query.get("req") && !request;
  const reqAsset = request ? request.asset : null;
  const locked = !!request;
  const fromLink = query.get("src") === "link" || locked;
  const qAsset = (query.get("asset") as AssetId) ?? "USDC";
  const [to, setTo] = useState(locked ? request!.to.toBase58() : badRequest ? "" : query.get("to") ?? "");
  const [assetId, setAssetId] = useState<AssetId>(locked ? reqAsset! : ASSETS[qAsset] ? qAsset : "USDC");
  const [amountStr, setAmountStr] = useState(locked ? uiAmount(request!.amount, ASSETS[reqAsset!]!.decimals) : query.get("amount") ?? "");
  const [memo, setMemo] = useState(locked ? request!.blob.s : query.get("for") ?? "");
  const [mode, setMode] = useState<DialMode>("protected");
  const [touchedMode, setTouchedMode] = useState(locked);
  const reqPreset: PresetId = locked ? request!.preset : "shipped";
  const [preset, setPreset] = useState<PresetId>(reqPreset);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [pinConfirmed, setPinConfirmed] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pickContact, setPickContact] = useState(false);
  const [scan, setScan] = useState(false);
  const pickScan = (address: string) => {
    setTo(address);
    setTouchedMode(false);
    setPickQuery("");
  };
  const [pickQuery, setPickQuery] = useState("");
  const [compare, setCompare] = useState(false);
  const [how, setHow] = useState(false);
  const [interstitial, setInterstitial] = useState<RiskSignal[] | null>(null);
  const [lookAlikeConfirmed, setLookAlikeConfirmed] = useState("");
  const [share, setShare] = useState<{ url: string; deal: string } | null>(null);
  const [receipt, setReceipt] = useState<{ sig: string; amount: string } | null>(null);

  const asset = ASSETS[assetId]!;
  const typedName = !!parseNameInput(to);
  useEffect(() => {
    setResolved(null);
    if (!typedName || !serviceOn || to.length < 5) return;
    const t = window.setTimeout(() => resolveName(to).then(setResolved), 350);
    return () => window.clearTimeout(t);
  }, [to]);
  const recipient = typedName ? (resolved ? parseAddress(resolved.owner) : null) : parseAddress(to);
  const raw = parseAmount(amountStr, asset.decimals);
  const ev = useMemo(
    () => (recipient && publicKey ? evidenceFor(recipient.toBase58(), publicKey, local, deals) : null),
    [recipient?.toBase58(), publicKey?.toBase58(), local, deals],
  );
  const usdValue = assetId === "USDC" && raw ? Number(raw) / 1e6 : 0;
  const aboveThreshold = usdValue >= local.settings.largePaymentUsd;
  const choice = ev ? chooseDefault(ev, aboveThreshold) : null;
  const instantLocked = !!choice?.instantLocked && lookAlikeConfirmed !== recipient?.toBase58();

  // Apply the evidence-keyed default whenever the recipient changes, unless the user chose.
  useEffect(() => {
    if (choice && !touchedMode) setMode(choice.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipient?.toBase58(), choice?.mode]);
  useEffect(() => {
    if (instantLocked && mode === "instant") setMode("protected");
  }, [instantLocked, mode]);

  if (!publicKey) return null;
  const self = recipient?.equals(publicKey);
  const name = recipient ? nameFor(recipient, local) : "them";
  const days = PRESETS.find((p) => p.id === preset)!.days;
  const balance = assetId === "USDC" ? balances?.usdc ?? 0n : assetId === "TEST" ? balances?.test ?? 0n : balances?.sol ?? 0n;
  const enough = raw != null && raw <= balance;
  // B3: a name that now points somewhere else (or an older claim) must be confirmed / is blocked.
  const pinKey = resolved ? nameKey(resolved.via, resolved.name) : null;
  const pinStatus = resolved && pinKey ? checkPin(local.pins, pinKey, resolved.owner, resolved.issued) : null;
  const pinMsg = resolved && pinKey && pinStatus ? pinWarning(pinStatus, resolved.via === "handle" ? `@${resolved.name}` : `tg:@${resolved.name}`, local.pins[pinKey]?.owner, resolved.owner) : null;
  const pinBlocks = pinStatus === "stale" || (pinStatus === "changed" && pinConfirmed !== resolved?.owner);
  const rememberName = () => {
    if (resolved && pinKey) updateLocal((d) => pinName(d.pins, pinKey, resolved.owner, resolved.issued, Math.floor(Date.now() / 1000)));
  };
  const valid = !pinBlocks && !!recipient && !self && raw != null && memo.trim().length <= 90 && (mode === "instant" || memo.trim().length > 0);

  const goCustom = (prefill: Record<string, string> = {}) => {
    const q = new URLSearchParams({ to, amount: amountStr, for: memo, asset: assetId, ...prefill });
    go(`/new-agreement?${q.toString()}`);
  };
  const chipLabel = (p: (typeof PRESETS)[number]) => COPY.presetChip(p);

  const onDial = (m: DialMode) => {
    setTouchedMode(true);
    if (m === "custom") return goCustom();
    setMode(m);
  };

  const submit = async (force = false) => {
    if (!recipient || raw == null) return;
    const signals = ev ? riskSignals({ mode, evidence: ev, amountAboveThreshold: aboveThreshold, memo, openedFromLink: fromLink }) : [];
    if (!force && signals.length > 0) {
      haptic("warning");
      setInterstitial(signals);
      return;
    }
    setInterstitial(null);
    setBusy(true);
    setError("");
    try {
      if (mode === "instant") {
        const sig = await send(F.instantTransfer(publicKey, recipient, asset, raw));
        recordPayment({ address: recipient.toBase58(), mode: "instant", at: Math.floor(Date.now() / 1000), amount: money(raw, asset), asset: asset.id, sig, memo: memo.trim() || undefined });
        rememberName();
        setReceipt({ sig, amount: money(raw, asset) });
      } else {
        // Built through the shared builder: the on-chain window is derived from
        // the preset displayed here; a request's blob must agree with it.
        const { spec, blob, deal } = buildProtectedPayment({
          creator: publicKey,
          payer: publicKey,
          payee: recipient,
          raw,
          asset,
          presetId: preset,
          dealId: F.newDealId(Date.now()),
          subject: memo,
          blob: locked ? request!.blob : undefined,
        });
        await sendAgreement(await F.createAndSign(spec, false));
        const k = locked ? request!.req.k : encodeBlob(blob);
        updateLocal((d) => void (d.links[deal.toBase58()] = k));
        refresh();
        rememberName();
        setShare({ url: appUrl(`/deal/${deal.toBase58()}?k=${k}`), deal: deal.toBase58() });
      }
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- result
  if (receipt && recipient) {
    return (
      <>
        <NavBar title="Sent" right={<button className="navbtn" onClick={() => go("/")}>Done</button>} />
        <div className="hero">
          <div style={{ width: 48, margin: "0 auto", color: "var(--instant)" }}>{ModeIcon.instant}</div>
          <div className="amt">{receipt.amount}</div>
          <div className="sub">sent to {name} · final</div>
        </div>
        <Section>
          <Cell title="View transaction" href={explorerTx(receipt.sig)} chevron link />
          {!local.contacts[recipient.toBase58()] && <Cell title="Save as contact" onClick={() => go(`/contact/new?address=${recipient.toBase58()}`)} chevron link />}
        </Section>
      </>
    );
  }
  if (share) {
    return (
      <>
        <NavBar title="Protected payment" right={<button className="navbtn" onClick={() => go(`/deal/${share.deal}`)}>Open</button>} />
        <div className="hero">
          <div style={{ width: 48, margin: "0 auto", color: "var(--protected)" }}>{ModeIcon.protected}</div>
          <div className="amt">{raw != null ? money(raw, asset) : ""}</div>
          <div className="sub">Created and signed by you. Nothing has been paid in yet.</div>
        </div>
        {locked ? (
          // A request: the requester's app finds the deal on-chain — there's no link to send.
          <div className="banner">{COPY.requestCreated(name)}</div>
        ) : (
          <>
            <div className="banner">
              Send {name} this link. When they accept, you pay in from the payment page — {name} then {preset === "work" ? "starts the clock when work begins" : "marks it shipped or handed over"} and the {days}-day clock starts.
            </div>
            <ShareSheet inline url={share.url} text={`Protected payment: ${memo.trim()}`} />
          </>
        )}
        <div className="stack">
          <Button kind="secondary" onClick={() => go(`/deal/${share.deal}`)}>
            Open payment page
          </Button>
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------- review
  if (step === "review" && recipient && raw != null) {
    const protectedMode = mode === "protected";
    return (
      <>
        <NavBar title="Check before you sign" left={<button className="navbtn" onClick={() => setStep("form")}>Edit</button>} />
        <Section>
          <KV k="To" v={<>{name}<div className="caption mono">{chunked(recipient.toBase58())}</div></>} onChange={() => setStep("form")} />
          <KV k="Amount" v={<span className="num">{money(raw, asset)} {asset.dollar ? "USDC" : ""}</span>} onChange={() => setStep("form")} />
          {memo.trim() && <KV k="For" v={memo.trim()} onChange={() => setStep("form")} />}
          <KV k="Protection" v={protectedMode ? `Protected · ${days} days after ${name} ${preset === "work" ? "starts the clock" : "marks it shipped"}` : "Instant · final"} onChange={() => setStep("form")} />
          {protectedMode && <KV k="If disputed" v={COPY.pauseRules(name)} />}
          {protectedMode && <KV k="Backup" v="None — the two of you only" />}
          <KV k="Cost" v={protectedMode ? COPY.costProtected(String(RENT_ESTIMATE_SOL)) : COPY.costInstant} />
          {protectedMode && <KV k="If not started" v={COPY.prePayLapse(name)} />}
          {protectedMode && asset.riskNote && <KV k="Token" v={asset.riskNote} />}
        </Section>
        {protectedMode && (
          <div className="caption" style={{ padding: "0 32px 16px" }}>
            Your wallet signs the agreement generated from these settings. Its fingerprint goes on-chain; the text never does.
          </div>
        )}
        {!enough && <div className="banner warn">Your balance is {money(balance, asset)}. You can create it now, but you'll need {money(raw, asset)} to pay in.</div>}
        {error && <div className="banner error">{error}</div>}
        <div className="stack">
          <Button busy={busy} onClick={() => submit(false)} disabled={mode === "instant" && !enough}>
            {protectedMode ? `Create protected payment (${money(raw, asset)})` : `Send ${money(raw, asset)} now — can't be undone`}
          </Button>
          <div className="caption" style={{ textAlign: "center" }}>
            {protectedMode ? "1 approval in your wallet. Nothing is paid in yet." : "1 approval in your wallet."}
          </div>
        </div>

        <Sheet open={!!interstitial} onClose={() => setInterstitial(null)} title="">
          <h2>{interstitialTitle(interstitial ?? [])}</h2>
          <p className="lead">{interstitialBody(interstitial ?? [], name, days, preset === "work")}</p>
          <div className="stack">
            <Button
              onClick={() => {
                setMode("protected");
                setTouchedMode(true);
                setInterstitial(null);
              }}
            >
              Keep it protected
            </Button>
            <Button kind="plain" onClick={() => submit(true)}>
              Send instantly anyway
            </Button>
          </div>
        </Sheet>
      </>
    );
  }

  // ------------------------------------------------------------------ form
  const contacts = Object.values(local.contacts).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <NavBar title={locked ? "Pay a request" : "Pay"} backTo="/" />
      {locked && (
        <div className="banner">
          <b>Protected request.</b> The requester set the amount, note and window. You set up the payment and pay in; nothing moves until they accept and mark it handed over.
        </div>
      )}
      {badRequest && <div className="banner error">This request link is invalid or uses terms this app can't show faithfully (for example a protection window that isn't 3, 10 or 14 days). Don't pay from it — ask for a new link.</div>}
      <Section>
        <div className="field">
          <label htmlFor="to">To</label>
          <input
            id="to"
            value={to}
            readOnly={locked}
            onChange={(e) => setTo(e.target.value.trim())}
            placeholder={serviceOn ? (IDENTITY_PREVIEW ? "Address, or @username / tg:@telegram (preview)" : "@username, tg:@telegram or address") : "Wallet address"}
            autoComplete="off"
            spellCheck={false}
            style={{ fontFamily: to ? "var(--mono)" : undefined, fontSize: to ? 14 : undefined }}
          />
          {!locked && (
            <button className="navbtn" onClick={() => setPickContact(true)} aria-label="Choose contact">
              Choose
            </button>
          )}
        </div>
        {resolved && recipient && (
          <div className="cell">
            <span className="s">
              {resolved.via === "handle" ? `@${resolved.name} · claim signed by this wallet ✓` : `tg:@${resolved.name} · ${TG_BADGE}`}
              <div className="mono caption">{chunked(recipient.toBase58())}</div>
            </span>
          </div>
        )}
        {recipient && (
          <Cell
            avatar
            before={<Avatar address={recipient.toBase58()} name={nameFor(recipient, local)} />}
            title={nameFor(recipient, local)}
            subtitle={
              self ? (
                "That's your own wallet"
              ) : (
                <span style={{ color: ev?.lookAlikeOf ? "var(--destructive)" : undefined }}>
                  {ev?.lookAlikeOf ? `⚠ Not the address you paid before (${short(ev.lookAlikeOf)})` : choice?.evidence}
                </span>
              )
            }
            wrap
          />
        )}
        {to && !recipient && (
          <div className="cell">
            <span className="s" style={{ color: typedName ? "var(--hint)" : "var(--destructive)" }}>
              {typedName ? (serviceOn ? "No one has that @username yet." : "Usernames aren't available in this build — paste a wallet address.") : "That isn't a valid Solana address."}
            </span>
          </div>
        )}
      </Section>

      {pinMsg && resolved && (
        <div className="banner error">
          {pinMsg}
          {pinStatus === "changed" && pinConfirmed !== resolved.owner && (
            <div className="actions">
              <button onClick={() => setPinConfirmed(resolved.owner)}>They told me — use the new wallet</button>
            </div>
          )}
        </div>
      )}
      {ev?.lookAlikeOf && recipient && lookAlikeConfirmed !== recipient.toBase58() && (
        <div className="banner warn">
          This address starts and ends like one you've paid before, but it's different. Check every character. Instant stays locked until you confirm.
          <div className="actions">
            <button onClick={() => setLookAlikeConfirmed(recipient.toBase58())}>I checked — it's the right address</button>
          </div>
        </div>
      )}

      <Section>
        <div className="amount-input">
          <input inputMode="decimal" value={amountStr} readOnly={locked} onChange={(e) => setAmountStr(e.target.value)} placeholder={asset.dollar ? "$0.00" : "0 SOL"} aria-label="Amount" />
        </div>
        <div className="field">
          <label>Pay with</label>
          <div className="chips" style={{ margin: 0 }}>
            {(locked ? [assetId] : ASSET_IDS).map((a) => (
              <button key={a} className="chip" aria-pressed={assetId === a} onClick={() => !locked && setAssetId(a)}>
                {a}
              </button>
            ))}
          </div>
          <span className="suffix num" style={{ marginLeft: "auto", fontSize: 14 }}>
            {balances ? money(balance, asset) : ""}
          </span>
        </div>
        <div className="field">
          <label htmlFor="for">For</label>
          <input id="for" value={memo} readOnly={locked} maxLength={90} onChange={(e) => setMemo(e.target.value)} placeholder={mode === "instant" ? "Optional note" : "What is this for? (shared publicly)"} />
        </div>
      </Section>

      {!locked && <Dial value={mode} onChange={onDial} instantLocked={instantLocked} />}
      <div className="dial-tag">{mode === "protected" && choice?.tag ? choice.tag : ""}</div>

      {mode === "protected" ? (
        <div className="outcome">
          <h3>{ModeIcon.protected} Protected</h3>
          <p>{COPY.heldUntil(name, days, preset === "work")}</p>
          <div className="chips" role="group" aria-label="What is this payment for?">
            {CATEGORIES.filter((c) => !locked || ("preset" in c && c.preset === preset)).map((c) =>
              "preset" in c ? (
                <button key={c.id} className="chip lg" aria-pressed={preset === c.preset} onClick={() => setPreset(c.preset)}>
                  <b>{chipLabel(PRESETS.find((p) => p.id === c.preset)!)}</b>
                  <span>{COPY.categorySummary[c.id]}</span>
                </button>
              ) : (
                <button key={c.id} className="chip lg" onClick={() => goCustom(c.builder)}>
                  <b>{c.title} · custom</b>
                  <span>{COPY.categorySummary[c.id]}</span>
                </button>
              ),
            )}
          </div>
          <p className="muted">{COPY.protectedCard(name)}</p>
          <div className="ladder" aria-hidden>
            {["You pay", `${name} accepts`, preset === "work" ? `${name} starts` : `${name} ships`, "Unlocks"].map((l, i) => (
              <div key={l} className={`step ${i === 0 ? "now" : ""}`}>
                <div className="dot" />
                <div className="lbl">{l}</div>
              </div>
            ))}
          </div>
          <p className="muted">{preset === "work" ? `Unlocks for ${name} ≈${days} days after they start the clock — not after delivery.` : `Unlocks for ${name} ≈${days} days after they mark it shipped.`}</p>
          <p className="muted">
            {COPY.pauseLine} {COPY.noLatch}
          </p>
          {!locked && <div className="chips">
            <button className="chip" onClick={() => goCustom({ rule: "TieBreaker" })}>Add a decider</button>
            <button className="chip" onClick={() => goCustom({ parts: "2" })}>Split in parts</button>
          </div>}
        </div>
      ) : (
        <div className="outcome">
          <h3>{ModeIcon.instant} Arrives now. Final.</h3>
          <p>{COPY.instantCard(name)}</p>
        </div>
      )}
      <div className="caption" style={{ padding: "8px 32px 0" }}>
        {mode === "protected" ? COPY.costProtected(String(RENT_ESTIMATE_SOL)) : COPY.costInstant}{" "}
        <button className="navbtn info-btn" aria-label="How protection works" onClick={() => setHow(true)}>
          ⓘ
        </button>
      </div>
      <div style={{ padding: "4px 16px 12px" }}>
        <button className="navbtn" style={{ fontSize: 15 }} onClick={() => setCompare(true)}>
          Compare options ›
        </button>
      </div>

      <div className="stack">
        <Button
          disabled={!valid}
          onClick={() => {
            if (mode === "protected" && !getLocal().settings.seenHowItWorks) {
              setHow(true);
              updateLocal((d) => void (d.settings.seenHowItWorks = true));
            }
            setStep("review");
          }}
        >
          Review payment
        </Button>
      </div>

      <Sheet open={pickContact} onClose={() => setPickContact(false)} title="Who are you paying?">
        {(() => {
          const pick = (address: string) => {
            setTo(address);
            setTouchedMode(false);
            setPickContact(false);
            setPickQuery("");
          };
          const s = suggestRecipients(local, deals, publicKey, pickQuery);
          const Row = ({ address, name, why }: { address: string; name?: string; why: string }) => (
            <Cell
              avatar
              before={<Avatar address={address} name={name ?? nameFor(address, local)} />}
              title={name ?? nameFor(address, local)}
              subtitle={`${short(address)}${why === "paid" ? " · you've paid them" : why === "deal" ? " · you've dealt before" : why === "typed" ? " · new address — check it with them" : ""}`}
              onClick={() => pick(address)}
            />
          );
          return (
            <>
              <Section>
                <div className="field">
                  <input value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} placeholder="Search names, or paste an address" autoComplete="off" spellCheck={false} aria-label="Search recipients" />
                </div>
              </Section>
              <Section>
                <Cell title="Scan a code" subtitle="Their pay code, a payment link, or a wallet address" link onClick={() => setScan(true)} />
              </Section>
              {s.typed && (
                <Section header="Pasted address">
                  <Row {...s.typed} />
                </Section>
              )}
              {s.contacts.length > 0 && (
                <Section header="Contacts">
                  {s.contacts.map((c) => (
                    <Row key={c.address} {...c} />
                  ))}
                </Section>
              )}
              {s.recent.length > 0 && (
                <Section header="People you've paid or dealt with">
                  {s.recent.map((c) => (
                    <Row key={c.address} {...c} />
                  ))}
                </Section>
              )}
              {!s.typed && !s.contacts.length && !s.recent.length && (
                <div className="empty">{pickQuery ? "Nothing matches. Paste a full wallet address, or add them in Contacts." : "No contacts yet. Paste an address above, or add people from the Contacts tab."}</div>
              )}
            </>
          );
        })()}
      </Sheet>
      <CompareSheet open={compare} onClose={() => setCompare(false)} />
      <ScanSheet
        open={scan}
        onClose={() => setScan(false)}
        onResult={(s) => {
          setScan(false);
          setPickContact(false);
          if (s.kind === "address") pickScan(s.address);
          else if (s.kind === "pay" && s.address && !s.query.get("amount")) pickScan(s.address);
          else go(routeFor(s));
        }}
      />
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </>
  );
}

function interstitialTitle(s: RiskSignal[]): string {
  if (s.includes("look-alike")) return "This is NOT the address you paid before";
  if (s.includes("from-link")) return "Did someone send you this link?";
  if (s.includes("large-amount")) return "This is a large payment";
  if (s.includes("purchase-memo")) return "Looks like a purchase";
  return "You've never paid this address";
}

function interstitialBody(s: RiskSignal[], name: string, days: number, work: boolean): string {
  const base = "Instant can't be undone by anyone — not you, not Latch, not your bank.";
  if (s.includes("look-alike")) return `Check every character. ${base}`;
  if (s.includes("from-link")) return `A link that sets up an instant payment is a common scam pattern. ${base} Protected has no Latch fee.`;
  if (s.includes("purchase-memo")) return `Purchases from strangers are the most common scam. ${base} With Protected: ${COPY.heldUntil(name, days, work)}`;
  if (s.includes("large-amount")) return `${base} With Protected: ${COPY.heldUntil(name, days, work)}`;
  return `${base} Did someone ask you to pick Instant? That's the most common sign of a scam. Protected has no Latch fee.`;
}

export { PublicKey };
