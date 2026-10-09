import { useState } from "react";
import { ModeIcon, Button, Section } from "../components/ui";
import { COPY } from "../lib/copy";
import HowItWorks from "./HowItWorks";
import WalletSheet from "./WalletSheet";

/** O1: one screen that explains "protected payments", then connect. */
export default function Welcome({ reason }: { reason?: string }) {
  const [wallet, setWallet] = useState(false);
  const [how, setHow] = useState(false);
  return (
    <div style={{ paddingTop: 32 }}>
      <div className="hero">
        <svg width="64" height="78" viewBox="0 0 460 560" aria-hidden>
          <path d="M130 230 v-60 a100 100 0 0 1 200 0 v60" fill="none" stroke="var(--protected)" strokeWidth="44" strokeLinecap="round" />
          <rect x="70" y="230" width="320" height="260" rx="56" fill="none" stroke="var(--protected)" strokeWidth="44" />
          <circle cx="160" cy="360" r="28" fill="var(--protected)" />
          <circle cx="300" cy="360" r="28" fill="var(--protected)" />
          <rect x="196" y="346" width="68" height="26" rx="13" fill="var(--protected)" />
        </svg>
        <h1 style={{ fontSize: 30, lineHeight: "36px", margin: "16px 0 8px" }}>Latch</h1>
        <div style={{ fontSize: 20, fontWeight: 600 }}>{COPY.brandLine}</div>
        <p className="hint" style={{ maxWidth: 380, margin: "12px auto 0" }}>
          {reason ?? COPY.welcomeBody}
        </p>
      </div>

      <Section>
        <div className="cell">
          <span style={{ width: 24, color: "var(--instant)" }}>{ModeIcon.instant}</span>
          <div className="body">
            <div className="t">Instant</div>
            <div className="s wrap">For people you trust. Arrives now, final.</div>
          </div>
        </div>
        <div className="cell">
          <span style={{ width: 24, color: "var(--protected)" }}>{ModeIcon.protected}</span>
          <div className="body">
            <div className="t">Protected</div>
            <div className="s wrap">{COPY.heldUntilGeneric} If something's wrong, pause the clock; then it moves only when you both agree.</div>
          </div>
        </div>
        <div className="cell">
          <span style={{ width: 24, color: "var(--custom)" }}>{ModeIcon.custom}</span>
          <div className="body">
            <div className="t">Custom</div>
            <div className="s wrap">Pay in parts, name someone you both trust, set your own rules.</div>
          </div>
        </div>
      </Section>

      <div className="stack">
        <Button onClick={() => setWallet(true)}>Connect a wallet</Button>
        <Button kind="plain" onClick={() => setHow(true)}>
          How protection works
        </Button>
      </div>
      <p className="caption" style={{ textAlign: "center", padding: "0 32px" }}>
        Runs on the Latch open protocol (Apache-2.0). This app is a reference implementation on Solana devnet.
      </p>
      <WalletSheet open={wallet} onClose={() => setWallet(false)} />
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </div>
  );
}
