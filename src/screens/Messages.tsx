import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Avatar, Cell, Icon, LargeTitle, NavBar, Section, Sheet, Button, useToast } from "../components/ui";
import { COPY } from "../lib/copy";
import { useData } from "../lib/data";
import { short } from "../lib/format";
import { enableMessaging, messagingOn, messagingUnlocked, pollMessages, unlockMessaging } from "../lib/messaging";
import { suggestRecipients } from "../lib/recipients";
import { go } from "../lib/router";
import { serviceOn } from "../lib/service";
import { useLocal, type StoredMsg } from "../lib/store";
import { nameFor } from "../lib/view";
import { explainError, useAllowedWallet } from "../lib/wallet";

/** One line for a thread row. */
export function lastLine(m: StoredMsg | undefined, me: string): string {
  if (!m) return "";
  const mine = m.from === me ? "You: " : "";
  switch (m.body.kind) {
    case "text":
      return mine + (m.body.text ?? "");
    case "proposal":
      return `${mine}Proposed terms`;
    case "accept":
      return `${mine}Accepted the terms`;
    case "decline":
      return `${mine}Declined the terms`;
    case "system":
      return m.body.text ?? "";
  }
}

export function when(unix: number): string {
  const d = new Date(unix * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** v0.13: conversations, encrypted on this device; the service relays ciphertext. */
export default function Messages() {
  const { publicKey } = useAllowedWallet();
  const { signMessage } = useWallet();
  const { deals, completedWith } = useData();
  const toast = useToast();
  const local = useLocal((d) => d);
  const owner = publicKey?.toBase58();
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  const [q, setQ] = useState("");
  const [, bump] = useState(0);
  if (!owner) return null;

  const on = messagingOn(owner);
  const unlocked = messagingUnlocked(owner);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    if (!signMessage) return toast("Your wallet can't sign messages");
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      bump((x) => x + 1);
    } catch (e) {
      toast(explainError(e));
    } finally {
      setBusy(false);
    }
  };
  const turnOn = () => act(async () => {
    await enableMessaging(owner, signMessage!);
    await pollMessages(owner);
  }, "Messages are on");
  const unlock = () => act(async () => {
    await unlockMessaging(owner, signMessage!);
    await pollMessages(owner);
  });

  const blocked = new Set(local.blocked);
  const threads = Object.entries(local.threads)
    .filter(([, t]) => !blocked.has(t.peer))
    .sort(([, a], [, b]) => b.lastAt - a.lastAt);
  const known = (peer: string) => !!local.contacts[peer] || completedWith.has(peer);
  const main = threads.filter(([, t]) => local.settings.requestsFrom === "anyone" || known(t.peer));
  const requests = threads.filter(([, t]) => local.settings.requestsFrom !== "anyone" && !known(t.peer));

  const Row = ([id, t]: (typeof threads)[number]) => {
    const last = t.messages[t.messages.length - 1];
    return (
      <Cell
        key={id}
        avatar
        before={<Avatar address={t.peer} name={local.contacts[t.peer]?.name} />}
        title={nameFor(t.peer, local)}
        subtitle={lastLine(last, owner) || short(t.peer)}
        after={
          <div className="trail">
            <span>{t.lastAt ? when(t.lastAt) : ""}</span>
            {t.unread > 0 && <span className="badge">{t.unread}</span>}
          </div>
        }
        onClick={() => go(`/chat/${t.peer}`)}
      />
    );
  };

  return (
    <>
      <NavBar right={on ? <button className="navbtn" onClick={() => setPick(true)} aria-label="New message">{Icon.compose}</button> : undefined} />
      <LargeTitle>Messages</LargeTitle>
      {!serviceOn ? (
        <Section footer="Messages need the optional Latch service, which this build doesn't use.">
          <Cell title="Messages" value="Not available" />
        </Section>
      ) : !on ? (
        <div className="empty">
          <div className="big" style={{ width: 48, margin: "0 auto 12px", color: "var(--hint)" }}>{Icon.messages}</div>
          <h3>Message the people you pay</h3>
          <p>{COPY.messagesIntro}</p>
          <div style={{ maxWidth: 280, margin: "12px auto 0" }}>
            <Button busy={busy} onClick={turnOn}>Turn on messages</Button>
          </div>
          <p className="caption" style={{ marginTop: 12 }}>{COPY.messagesSetup}</p>
        </div>
      ) : !unlocked ? (
        <div className="empty">
          <div className="big" style={{ width: 48, margin: "0 auto 12px", color: "var(--hint)" }}>{Icon.messages}</div>
          <h3>Unlock messages</h3>
          <p>One wallet signature recreates your messaging key for this visit. Nothing is stored on this device between visits.</p>
          <div style={{ maxWidth: 280, margin: "12px auto 0" }}>
            <Button busy={busy} onClick={unlock}>Unlock</Button>
          </div>
        </div>
      ) : threads.length === 0 ? (
        <div className="empty">
          <h3>No conversations yet</h3>
          <p>Start one from a contact, or with the compose button above. The other person needs to have turned on messages too.</p>
          <button className="btn secondary" style={{ maxWidth: 260, margin: "12px auto 0" }} onClick={() => setPick(true)}>New message</button>
        </div>
      ) : (
        <>
          {main.length > 0 && <Section footer={COPY.messagesFooter}>{main.map(Row)}</Section>}
          {requests.length > 0 && (
            <Section header="Not in your contacts" footer="You chose to take requests only from contacts (Settings). Open a conversation to add or block the sender.">
              {requests.map(Row)}
            </Section>
          )}
        </>
      )}
      <Sheet open={pick} onClose={() => setPick(false)} title="Message whom?">
        {(() => {
          const s = suggestRecipients(local, deals, publicKey, q);
          const R = ({ address, name }: { address: string; name?: string }) => (
            <Cell avatar before={<Avatar address={address} name={name ?? nameFor(address, local)} />} title={name ?? nameFor(address, local)} subtitle={short(address)} onClick={() => (setPick(false), setQ(""), go(`/chat/${address}`))} />
          );
          return (
            <>
              <Section>
                <div className="field">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names, or paste an address" autoComplete="off" spellCheck={false} aria-label="Search people" />
                </div>
              </Section>
              {s.typed && <Section header="Pasted address"><R {...s.typed} /></Section>}
              {s.contacts.length > 0 && <Section header="Contacts">{s.contacts.map((c) => <R key={c.address} {...c} />)}</Section>}
              {s.recent.length > 0 && <Section header="People you've paid or dealt with">{s.recent.map((c) => <R key={c.address} {...c} />)}</Section>}
              {!s.typed && !s.contacts.length && !s.recent.length && <div className="empty">{q ? "Nothing matches. Paste a full wallet address, or add them in Contacts." : "No contacts yet. Paste an address above, or add people from the Contacts tab."}</div>}
            </>
          );
        })()}
      </Sheet>
    </>
  );
}
