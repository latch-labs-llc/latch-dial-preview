import { useState } from "react";
import { ModeIcon, Button, Dial, NavBar, Section } from "../components/ui";
import { CATEGORIES, ASSETS, ASSET_IDS, PRESETS, type AssetId, type PresetId } from "../lib/config";
import { COPY } from "../lib/copy";
import { money, parseAmount } from "../lib/format";
import { encodeRequest } from "../lib/request";
import { appUrl, go } from "../lib/router";
import { updateLocal } from "../lib/store";
import { encodeBlob } from "../lib/template";
import { protectedBlob } from "../lib/protected";
import { useAllowedWallet } from "../lib/wallet";
import ShareSheet from "./ShareSheet";

/**
 * R1: Request money. No transaction and no cost for the requester:
 * - Protected request → a link; the PAYER creates the deal (and locks the
 *   network deposit). Your app recognises their deal by its fingerprint and
 *   asks you to accept it.
 * - Instant request → a plain pay link anyone can pay.
 */
export default function RequestMoney() {
  const { publicKey } = useAllowedWallet();
  const [kind, setKind] = useState<"protected" | "instant">("protected");
  const [amountStr, setAmountStr] = useState("");
  const [assetId, setAssetId] = useState<AssetId>("USDC");
  const [memo, setMemo] = useState("");
  const [preset, setPreset] = useState<PresetId>("shipped");
  const [result, setResult] = useState<string | null>(null);
  if (!publicKey) return null;

  const asset = ASSETS[assetId]!;
  const raw = parseAmount(amountStr, asset.decimals);
  const days = PRESETS.find((p) => p.id === preset)!.days;
  const valid = raw != null && memo.trim().length > 0;

  const create = () => {
    if (raw == null) return;
    if (kind === "instant") {
      const q = new URLSearchParams({ to: publicKey.toBase58(), amount: amountStr, for: memo.trim(), asset: assetId, src: "link" });
      setResult(appUrl(`/pay?${q.toString()}`));
      return;
    }
    const blob = protectedBlob(preset, memo);
    const k = encodeBlob(blob);
    updateLocal((d) => {
      d.requests[blob.n] = { blob: k, amount: raw.toString(), asset: assetId, createdAt: Math.floor(Date.now() / 1000) };
    });
    setResult(appUrl(`/pay?req=${encodeRequest({ to: publicKey.toBase58(), amount: raw.toString(), asset: assetId, k })}`));
  };

  if (result) {
    return (
      <>
        <NavBar title="Request ready" right={<button className="navbtn" onClick={() => go("/")}>Done</button>} />
        <div className="hero">
          <div style={{ width: 44, margin: "0 auto", color: kind === "protected" ? "var(--protected)" : "var(--instant)" }}>{kind === "protected" ? ModeIcon.protected : ModeIcon.instant}</div>
          <div className="amt">{raw != null ? money(raw, asset) : ""}</div>
          <div className="sub">“{memo.trim()}”</div>
        </div>
        <div className="banner">
          {kind === "protected"
            ? `Send this link to whoever is paying. They set up the protected payment; it shows up in your Activity for you to accept, then they come back to pay in. ${preset === "work" ? `When work begins, tap “Start the clock” on the payment page — the ${days} days run from then, not from delivery.` : `When you hand it over or ship it, mark it on the payment page — that starts the ${days}-day clock.`}`
            : "Anyone with this link can pay you instantly. It arrives now and is final."}
        </div>
        <ShareSheet inline url={result} text={`Payment request: ${memo.trim()}`} />
      </>
    );
  }

  return (
    <>
      <NavBar title="Request money" backTo="/" />
      <Dial
        label="What kind of request?"
        value={kind}
        onChange={setKind}
        options={[
          { id: "instant", label: <>{ModeIcon.instant}Instant link</> },
          { id: "protected", label: <>{ModeIcon.protected}Protected</> },
        ]}
        style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 12 }}
      />
      <Section>
        <div className="amount-input">
          <input inputMode="decimal" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} placeholder={asset.dollar ? "$0.00" : "0 SOL"} aria-label="Amount" />
        </div>
        <div className="field">
          <label>In</label>
          <div className="chips" style={{ margin: 0 }}>
            {ASSET_IDS.map((a) => (
              <button key={a} className="chip" aria-pressed={assetId === a} onClick={() => setAssetId(a)}>
                {a}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="for">For</label>
          <input id="for" value={memo} maxLength={90} onChange={(e) => setMemo(e.target.value)} placeholder="What is this for? (shared publicly)" />
        </div>
      </Section>

      {kind === "protected" ? (
        <div className="outcome">
          <h3>{ModeIcon.protected} They pay into a protected payment</h3>
          <p>{COPY.heldForYou(days, preset === "work")}</p>
          <div className="chips" role="group" aria-label="What is this payment for?">
            {CATEGORIES.filter((c) => "preset" in c).map((c) => {
              const p = PRESETS.find((x) => "preset" in c && x.id === c.preset)!;
              return (
                <button key={c.id} className="chip lg" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
                  <b>{COPY.presetChip(p)}</b>
                  <span>{COPY.categorySummary[c.id]}</span>
                </button>
              );
            })}
          </div>
          <p className="muted">{preset === "work" ? "The window starts when you start the clock." : "The window starts when you mark it shipped or handed over."} {COPY.pauseLine}</p>
          <p className="muted">Requesting costs you nothing. The payer locks the network deposit; each of you pays your own network fees.</p>
        </div>
      ) : (
        <div className="outcome">
          <h3>{ModeIcon.instant} A plain pay link</h3>
          <p>Anyone who opens it can send you money instantly. It's final when it arrives.</p>
        </div>
      )}
      <div className="stack" style={{ marginTop: 16 }}>
        <Button disabled={!valid} onClick={create}>
          Create link
        </Button>
      </div>
    </>
  );
}
