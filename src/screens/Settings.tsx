import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Accordion, Cell, LargeTitle, NavBar, Section, download, useAsync, useToast } from "../components/ui";
import { programGuard } from "../lib/programGuard";
import { CLUSTER, PROGRAM_ID, RPC_URL, VERIFIED_BUILD_HASH, explorerAddr } from "../lib/config";
import { short } from "../lib/format";
import { clearLocal, exportLocal, importLocal, updateLocal, useLocal, type Theme } from "../lib/store";
import { explainError, useAllowedWallet } from "../lib/wallet";
import { eraseServiceData, serviceOn } from "../lib/service";
import { go } from "../lib/router";
import { useWallet } from "@solana/wallet-adapter-react";
import HowItWorks from "./HowItWorks";
import WalletSheet from "./WalletSheet";
import { BackupSection, ProfileSection } from "./ProfileSections";

/** T1/T3: Settings — wallet & network, appearance, requests, threshold, verify Latch, data. */
export default function Settings() {
  const { publicKey, wallet, disconnect } = useAllowedWallet();
  const { signMessage } = useWallet();
  const s = useLocal((d) => d.settings);
  const toast = useToast();
  const [walletSheet, setWalletSheet] = useState(false);
  const [how, setHow] = useState(false);
  const set = (fn: (x: typeof s) => void) => updateLocal((d) => fn(d.settings));
  const { connection } = useConnection();
  const guard = useAsync(() => programGuard(connection).check(), [connection]);
  const g = guard.data;

  return (
    <>
      <NavBar />
      <LargeTitle>Settings</LargeTitle>
      <Section header="Wallet & network">
        {publicKey ? (
          <>
            <Cell title={wallet?.adapter.name ?? "Wallet"} value={short(publicKey.toBase58())} />
            <Cell title="Disconnect" danger onClick={() => disconnect()} />
          </>
        ) : (
          <Cell title="Connect a wallet" link onClick={() => setWalletSheet(true)} />
        )}
        <Cell title="Network" value={`Solana ${CLUSTER} (test)`} />
      </Section>

      {publicKey && <ProfileSection />}
      {publicKey && <BackupSection />}

      <Section header="Appearance">
        {(["system", "light", "dark"] as Theme[]).map((t) => (
          <Cell key={t} title={t[0].toUpperCase() + t.slice(1)} after={s.theme === t ? <span style={{ color: "var(--link)" }}>✓</span> : null} onClick={() => set((x) => void (x.theme = t))} />
        ))}
        <Cell title="Haptics" subtitle="Android only — iPhone browsers don't support vibration" wrap after={<input type="checkbox" checked={s.haptics} onChange={(e) => set((x) => void (x.haptics = e.target.checked))} />} />
      </Section>

      <Section header="Requests from" footer="Requests from people you don't know never notify you. They wait in Requests until you look.">
        <Cell title="Anyone (in Requests)" after={s.requestsFrom === "anyone" ? <span style={{ color: "var(--link)" }}>✓</span> : null} onClick={() => set((x) => void (x.requestsFrom = "anyone"))} />
        <Cell title="Contacts only" after={s.requestsFrom === "contacts" ? <span style={{ color: "var(--link)" }}>✓</span> : null} onClick={() => set((x) => void (x.requestsFrom = "contacts"))} />
      </Section>

      <Section header="Large payment" footer="At or above this amount, payments default to Protected and Instant asks you to confirm.">
        <div className="field">
          <label>USD</label>
          <input inputMode="numeric" value={s.largePaymentUsd} onChange={(e) => set((x) => void (x.largePaymentUsd = Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1)))} />
        </div>
      </Section>

      <Accordion title="Advanced" summary={!g ? "Verify Latch · checking the deployed program…" : g.ok ? "Verify Latch ✓ deployed code matches · RPC" : "Verify Latch ✗ deployed code differs — signing is blocked"}>
        <Cell title="Program" subtitle={<span className="mono">{PROGRAM_ID.toBase58()}</span>} wrap href={explorerAddr(PROGRAM_ID.toBase58())} />
        <Cell title="Expected (this app was checked with)" subtitle={<span className="mono" style={{ fontSize: 12 }}>{VERIFIED_BUILD_HASH}</span>} wrap />
        <Cell
          title={!g ? "Deployed now — checking…" : g.ok ? "Deployed now ✓ matches" : g.reason === "mismatch" ? "Deployed now ✗ DIFFERENT — signing is blocked" : "Deployed now — couldn't check; signing is blocked"}
          subtitle={<span className="mono" style={{ fontSize: 12 }}>{g?.observed ?? "—"}</span>}
          wrap
          onClick={guard.reload}
        />
        <Cell title="Source" href="https://github.com/latch-labs-llc/latch" chevron />
        <Cell title="RPC" value={<span className="mono" style={{ fontSize: 12 }}>{RPC_URL.replace(/^https?:\/\//, "")}</span>} />
        <div className="caption" style={{ padding: "8px 16px 12px" }}>
          The devnet program is upgradeable: its maintainer can replace its code, which could change the rules. Each time you create, accept, pay into or mark shipped a payment, this app re-checks the deployed code against the hash it was checked with, and refuses if they differ. Anyone can rebuild the program from the open-source repository and compare.
        </div>
      </Accordion>

      <Section
        header="Data & privacy"
        footer={
          serviceOn
            ? "Contacts, history and settings live only on this device. This app also uses the optional Latch service for @usernames, Telegram linking, online backups and the TEST faucet — see Data & legal requests for exactly what it keeps."
            : "Contacts, history and settings live only on this device. This build doesn't use the Latch service."
        }
      >
        <Cell title="Data & legal requests" onClick={() => go("/data")} chevron />
        <Cell title="Export contacts" link onClick={() => download("latch-contacts.json", exportLocal(), "application/json")} />
        <Cell
          title="Import contacts"
          link
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "application/json";
            input.onchange = async () => {
              try {
                const n = importLocal(await input.files![0].text());
                toast(`Imported ${n} contact${n === 1 ? "" : "s"}`);
              } catch (e: any) {
                toast(e.message);
              }
            };
            input.click();
          }}
        />
        <Cell
          title="Clear data on this device"
          danger
          onClick={async () => {
            if (!confirm("Delete contacts, history and settings from this device? Payments on Solana are not affected.")) return;
            const owner = publicKey?.toBase58();
            if (serviceOn && owner && signMessage && confirm("Also delete your data from the Latch service (username, Telegram link, online backups, messaging keys and messages)? Your wallet will ask for one signature. Your @username becomes available to others.")) {
              try {
                const r = await eraseServiceData(owner, signMessage);
                toast(`Deleted ${r.deleted} record${r.deleted === 1 ? "" : "s"} from the Latch service`);
              } catch (e) {
                toast(explainError(e));
                return;
              }
            }
            clearLocal();
          }}
        />
      </Section>

      <Section header="About">
        <Cell title="How protection works" onClick={() => setHow(true)} chevron />
        <Cell title="Latch dial" value="v0.7.1 · reference implementation" />
        <Cell title="License" value="Apache-2.0" />
      </Section>
      <p className="caption" style={{ textAlign: "center", padding: "0 32px 24px" }}>
        Unaudited, experimental software on Solana devnet. Test tokens only.
      </p>
      <WalletSheet open={walletSheet} onClose={() => setWalletSheet(false)} />
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </>
  );
}
