import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { Button, Cell, Section, download, useAsync, useToast } from "../components/ui";
import {
  backupUnlocked,
  enableServiceBackups,
  ensureWriter,
  exportBackupFile,
  importBackupFile,
  restoreFromService,
  syncBackups,
  unlockBackups,
} from "../lib/backup";
import { handleProblem, normalizeHandle, type TelegramAuth } from "../lib/claims";
import { IDENTITY_PREVIEW, TELEGRAM_BOT, TELEGRAM_OIDC_CLIENT_ID, TELEGRAM_WIDGET_URL } from "../lib/config";
import { COPY } from "../lib/copy";
import { acceptWidgetMessage, widgetUrl } from "../lib/telegramWidget";
import { takeCallback } from "../lib/telegramOidc";
import { TG_BADGE, claimHandle, completeTelegramOidc, linkTelegram, profileOf, releaseHandle, serviceOn, startTelegramOidc, unlinkTelegram } from "../lib/service";
import { useLocal } from "../lib/store";
import { disableMessaging, enableMessaging, messagingOn, messagingUnlocked } from "../lib/messaging";
import { go } from "../lib/router";
import { explainError, useAllowedWallet } from "../lib/wallet";

/** Said wherever a name gets linked to a wallet. */
export const PUBLIC_NAME = "A linked name is public next to your wallet: anyone who looks it up can see this wallet's payments on Solana.";

/** @username + Telegram username linked via the Latch service (Settings → Profile). */
export function ProfileSection() {
  const { publicKey } = useAllowedWallet();
  const { signMessage } = useWallet();
  const toast = useToast();
  const owner = publicKey?.toBase58();
  const prof = useAsync(async () => (owner ? profileOf(owner) : null), [owner]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const myTg = useLocal((d) => (owner ? d.myTelegram[owner] : undefined));
  if (!owner) return null;
  if (!serviceOn)
    return (
      <Section header="Profile" footer="Usernames need the optional Latch service, which this build doesn't use. Share your pay code instead.">
        <Cell title="Username" value="Not available" />
      </Section>
    );
  const p = prof.data;
  const h = normalizeHandle(name);
  const problem = h ? handleProblem(h) : null;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (!signMessage) return toast("Your wallet can't sign messages");
    setBusy(true);
    try {
      await fn();
      toast(ok);
      prof.reload();
    } catch (e) {
      toast(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        header={<PreviewHeader title="Profile" />}
        footer={`${IDENTITY_PREVIEW ? COPY.previewNote + " " : ""}People can pay @username instead of pasting an address. Your wallet signs the claim, so no one — including Latch — can point your name at another wallet. Names never replace addresses: payers always see both. ${PUBLIC_NAME}`}
      >
        {p?.handle ? (
          <>
            <Cell title={`@${p.handle.handle}`} subtitle="Signed by this wallet ✓" />
            <Cell title="Release username" danger onClick={() => act(() => releaseHandle(owner, signMessage!), "Username released")} />
          </>
        ) : (
          <>
            <div className="field">
              <label>@</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="choose a username" autoCapitalize="none" spellCheck={false} maxLength={21} />
            </div>
            {problem && <Cell title={<span className="s" style={{ color: "var(--destructive)" }}>{problem}</span>} wrap />}
            <div style={{ padding: "8px 16px 12px" }}>
              <Button disabled={!h || !!problem} busy={busy} onClick={() => act(() => claimHandle(owner, h, signMessage!), `You're @${h}`)}>
                Claim @{h || "username"}
              </Button>
            </div>
          </>
        )}
      </Section>
      <TelegramSection owner={owner} linked={myTg && myTg.expiresAt > Date.now() / 1000 ? myTg : null} onChange={prof.reload} />
      <MessagesSection owner={owner} />
    </>
  );
}

/** v0.13: messaging keys on the service, on or off. Conversations live on the Messages tab. */
function MessagesSection({ owner }: { owner: string }) {
  const { signMessage } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const on = useLocal((d) => d.msgEnabled.includes(owner));
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (!signMessage) return toast("Your wallet can't sign messages");
    setBusy(true);
    try {
      await fn();
      toast(ok);
      bump((x) => x + 1);
    } catch (e) {
      toast(explainError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section header="Messages" footer={on ? "Turning messages off removes your messaging keys from the service, so nobody can send to this wallet. Conversations stay on this device." : COPY.messagesSetup}>
      <Cell title="Messages" value={on ? (messagingUnlocked(owner) ? "On" : "On · locked") : "Off"} />
      {on ? (
        <>
          <Cell title="Open Messages" link onClick={() => go("/messages")} />
          <Cell title="Turn off messages" danger onClick={() => act(() => disableMessaging(owner, signMessage!), "Messages are off")} />
        </>
      ) : (
        <div style={{ padding: "8px 16px 12px" }}>
          <Button busy={busy} onClick={() => act(() => enableMessaging(owner, signMessage!), "Messages are on")}>Turn on messages</Button>
        </div>
      )}
    </Section>
  );
}


/**
 * Telegram integration: link your Telegram username to your wallet via the
 * official Telegram Login Widget. Then friends can find you by your Telegram
 * @username, and your profile shows a verified Telegram badge. Stored: your
 * username and a hash of your Telegram id — no name, photo or phone number.
 */
function TelegramSection({ owner, linked, onChange }: { owner: string; linked: { username: string; expiresAt: number } | null; onChange: () => void }) {
  const { signMessage } = useWallet();
  const toast = useToast();
  const [findable, setFindable] = useState(false);
  const [busy, setBusy] = useState(false);

  // OIDC flag: finish a sign-in that just returned from Telegram (?code&state).
  useEffect(() => {
    if (!TELEGRAM_OIDC_CLIENT_ID) return;
    const cb = takeCallback(window.location.search);
    if (!cb) return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    if (cb.pending.owner !== owner) return toast("That Telegram sign-in was for a different wallet.");
    setBusy(true);
    completeTelegramOidc(cb.code, cb.pending)
      .then((r) => {
        toast(`Telegram @${r.username} linked`);
        onChange();
      })
      .catch((e) => toast(explainError(e)))
      .finally(() => setBusy(false));
  }, [owner]);

  // Widget path (B8): Telegram's script runs in the SERVICE's origin inside a
  // sandboxed iframe; we only accept its postMessage from that exact origin.
  useEffect(() => {
    if (TELEGRAM_OIDC_CLIENT_ID || !TELEGRAM_BOT || linked || !TELEGRAM_WIDGET_URL) return;
    const onMsg = async (ev: MessageEvent) => {
      const u = acceptWidgetMessage(ev, TELEGRAM_WIDGET_URL!);
      if (!u) return;
      if (!signMessage) return toast("Your wallet can't sign messages");
      setBusy(true);
      try {
        await linkTelegram(owner, u, findable, signMessage);
        toast(`Telegram @${u.username} linked`);
        onChange();
      } catch (e) {
        toast(explainError(e));
      } finally {
        setBusy(false);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [linked, findable, owner, signMessage]);

  if (!(TELEGRAM_BOT && TELEGRAM_WIDGET_URL) && !TELEGRAM_OIDC_CLIENT_ID) return null;
  return (
    <Section
      header={<PreviewHeader title="Telegram" />}
      footer={`${IDENTITY_PREVIEW ? COPY.previewNote + " " : ""}Uses Telegram's official login. Latch stores your Telegram username only — never your Telegram id, name, photo or phone number. Links expire after 60 days; unlink any time. If you make it findable: ${PUBLIC_NAME}`}
    >
      {linked ? (
        <>
          <Cell title={`@${linked.username}`} subtitle={`${TG_BADGE} · re-link by ${new Date(linked.expiresAt * 1000).toLocaleDateString()}`} />
          <Cell
            title="Unlink Telegram"
            danger
            onClick={async () => {
              if (!signMessage) return;
              try {
                await unlinkTelegram(owner, signMessage);
                toast("Telegram unlinked");
                onChange();
              } catch (e) {
                toast(explainError(e));
              }
            }}
          />
        </>
      ) : (
        <>
          <Cell
            title="Let people find me by my Telegram username"
            subtitle="Off by default. When on, anyone can look up which wallet is yours — and see its payments on Solana."
            after={<input type="checkbox" checked={findable} onChange={(e) => setFindable(e.target.checked)} />}
            wrap
          />
          {TELEGRAM_OIDC_CLIENT_ID ? (
            <Cell
              title={busy ? "Linking…" : "Link with Telegram"}
              link
              onClick={() => {
                if (!signMessage) return toast("Your wallet can't sign messages");
                startTelegramOidc(owner, findable, signMessage).catch((e) => toast(explainError(e)));
              }}
            />
          ) : (
            <div style={{ padding: "8px 16px 12px", minHeight: 52 }}>
              {busy ? (
                <span className="spinner" />
              ) : (
                <iframe
                  title="Log in with Telegram"
                  src={widgetUrl(TELEGRAM_WIDGET_URL!, window.location.origin)}
                  sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                  referrerPolicy="no-referrer"
                  style={{ border: 0, width: "100%", height: 48, colorScheme: "normal" }}
                />
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** Agreement copies: encrypted backup file (always) + service backup (optional). */
export function BackupSection() {
  const { publicKey } = useAllowedWallet();
  const { signMessage } = useWallet();
  const toast = useToast();
  const owner = publicKey?.toBase58();
  const backupsFor = useLocal((d) => d.backupsFor);
  const count = useLocal((d) => Object.keys(d.links).length);
  const [, force] = useState(0);
  const [busy, setBusy] = useState("");
  if (!owner) return null;
  const unlocked = backupUnlocked(owner);
  const serviceEnabled = backupsFor.includes(owner);

  const act = async (k: string, fn: () => Promise<unknown> | unknown) => {
    if (!signMessage) return toast("Your wallet can't sign messages");
    setBusy(k);
    try {
      if (!backupUnlocked(owner)) await unlockBackups(owner, signMessage);
      await fn();
    } catch (e) {
      toast(explainError(e));
    } finally {
      setBusy("");
      force((x) => x + 1);
    }
  };

  return (
    <Section
      header="Agreement copies"
      footer="Backups are encrypted on this device with a key only your wallet can recreate (a signature that can't move money; the first time on a device, your wallet is asked twice to check it signs the same way every time). Online backup uses a second, separate signature to upload — also twice the first time on a device, then once. Stored encrypted; the service only receives ciphertext, under scrambled ids rather than deal addresses."
    >
      <Cell title="Agreements on this device" value={String(count)} />
      <Cell
        title="Download encrypted backup file"
        link
        onClick={() => act("file", () => download(`latch-agreements-${owner.slice(0, 6)}.json`, exportBackupFile(owner), "application/json"))}
        after={busy === "file" ? <span className="spinner" /> : null}
      />
      <Cell
        title="Restore from backup file"
        link
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "application/json";
          input.onchange = () => act("import", async () => toast(`Restored ${importBackupFile(owner, await input.files![0].text())} agreement(s)`));
          input.click();
        }}
      />
      {serviceOn &&
        (serviceEnabled ? (
          <>
            <Cell title="Online backup" value={unlocked ? "On" : "On · unlock to sync"} />
            <Cell
              title={unlocked ? "Back up now" : "Unlock and back up"}
              link
              onClick={() => act("sync", async () => (await ensureWriter(owner, signMessage!), toast(`Backed up ${await syncBackups(owner)} new agreement(s)`)))}
              after={busy === "sync" ? <span className="spinner" /> : null}
            />
            <Cell title="Restore from online backup" link onClick={() => act("restore", async () => toast(`Restored ${await restoreFromService(owner, signMessage!)} agreement(s)`))} />
          </>
        ) : (
          <Cell
            title="Turn on online backup"
            subtitle="Two wallet signatures, once. After that, new agreements back up automatically."
            wrap
            link
            onClick={() => act("enable", async () => (await enableServiceBackups(owner, signMessage!), toast("Online backup on")))}
            after={busy === "enable" ? <span className="spinner" /> : null}
          />
        ))}
    </Section>
  );
}

/** Section header with the "Preview" tag while identity features are in preview (v0.6 #7). */
export function PreviewHeader({ title }: { title: string }) {
  return (
    <>
      {title}
      {IDENTITY_PREVIEW && (
        <>
          {" "}
          <span className="pill">{COPY.previewTag}</span>
        </>
      )}
    </>
  );
}
