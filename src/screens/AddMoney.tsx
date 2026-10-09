import { Cell, NavBar, Section, copyText, useToast } from "../components/ui";
import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { DEMO_LDD, TAP_SOL, demoLdd, demoSol } from "../lib/demo";
import { ASSETS, FAUCETS, explorerTx } from "../lib/config";
import { useData } from "../lib/data";
import { requestTestTokens, serviceOn } from "../lib/service";
import { explainError } from "../lib/wallet";
import { COPY } from "../lib/copy";
import { go } from "../lib/router";
import { useAllowedWallet } from "../lib/wallet";

/**
 * M1: Add money. Card/bank is partner-gated (R2/R8 D13) and shown as
 * unavailable — not faked. Devnet test funds come from public faucets.
 */
export default function AddMoney() {
  const { publicKey } = useAllowedWallet();
  const toast = useToast();
  const { refresh } = useData();
  const [busy, setBusy] = useState(false);
  const [sig, setSig] = useState("");
  const [demoBusy, setDemoBusy] = useState<"sol" | "ldd" | null>(null);
  const { connection } = useConnection();
  const testOn = !!ASSETS.TEST && serviceOn;
  return (
    <>
      <NavBar title="Add money" backTo="/" />
      <Section header="Card or bank" footer={COPY.rampsBody}>
        <Cell title="Card or bank transfer" subtitle={COPY.partnerGated} after={<span className="pill">Later</span>} wrap />
      </Section>
      {testOn && (
        <Section header="TEST dollars" footer="A Latch devnet test token with no issuer freeze. 100 per day, worthless by design.">
          <Cell
            title={busy ? "Sending…" : "Get 100 TEST"}
            link
            onClick={async () => {
              if (!publicKey || busy) return;
              setBusy(true);
              try {
                const r = await requestTestTokens(publicKey.toBase58());
                setSig(r.signature);
                toast(`${r.amount} TEST on the way`);
                refresh();
              } catch (e) {
                toast(explainError(e));
              } finally {
                setBusy(false);
              }
            }}
          />
          {sig && <Cell title="View transaction" href={explorerTx(sig)} chevron />}
        </Section>
      )}
      <Section header="Demo money (instant)" footer="Devnet play money, worth nothing by construction: a small tap for network fees and a test-dollar mint anyone can use. Same as latchlabs.org.">
        <Cell
          title={demoBusy === "sol" ? "Sending…" : `Get ${TAP_SOL} SOL for fees`}
          link
          onClick={async () => {
            if (!publicKey || demoBusy) return;
            setDemoBusy("sol");
            try {
              setSig(await demoSol(connection, publicKey));
              toast(`${TAP_SOL} SOL on the way`);
              refresh();
            } catch (e) {
              toast(explainError(e));
            } finally {
              setDemoBusy(null);
            }
          }}
        />
        {ASSETS.TEST && (
          <Cell
            title={demoBusy === "ldd" ? "Minting…" : `Get $${DEMO_LDD.toLocaleString("en-US")} test dollars`}
            link
            onClick={async () => {
              if (!publicKey || demoBusy) return;
              setDemoBusy("ldd");
              try {
                setSig(await demoLdd(connection, publicKey));
                toast(`$${DEMO_LDD.toLocaleString("en-US")} test dollars minted`);
                refresh();
              } catch (e) {
                toast(explainError(e));
              } finally {
                setDemoBusy(null);
              }
            }}
          />
        )}
        {sig && <Cell title="View transaction" href={explorerTx(sig)} chevron />}
      </Section>
      <Section header="Public faucets" footer="Test tokens have no value. Circle's faucet sends devnet USDC; the Solana faucet sends devnet SOL for network fees.">
        <Cell title="Get test USDC (Circle faucet)" subtitle="Choose Solana Devnet, paste your address" href={FAUCETS.usdc} chevron />
        <Cell title="Get test SOL (Solana faucet)" href={FAUCETS.sol} chevron />
        {publicKey && <Cell title="Copy my address" link onClick={() => copyText(publicKey.toBase58(), toast)} />}
      </Section>
      <Section header="Already have USDC or SOL?">
        <Cell title="Receive from another wallet" onClick={() => go("/paycode")} chevron />
      </Section>
    </>
  );
}
