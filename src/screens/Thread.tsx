import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Avatar, Cell, Icon, NavBar, Section, Sheet, Button, download, useAsync, useToast } from "../components/ui";
import { COPY } from "../lib/copy";
import { customSpec } from "../lib/customTerms";
import { useData } from "../lib/data";
import * as F from "../lib/flows";
import { chunked, short } from "../lib/format";
import { deleteThread, messagingOn, messagingUnlocked, peerKeysFor, pollMessages, sendText, setOpenThread, trustPeerKeys, unlockMessaging } from "../lib/messaging";
import { MSG_TEXT_MAX, threadId } from "../lib/msgCrypto";
import { acceptTerms, announceDeal, declineTerms, exportNegotiation, negotiationState, proposalOf, type Proposal } from "../lib/negotiation";
import { appUrl, go } from "../lib/router";
import { updateLocal, useLocal, type StoredMsg } from "../lib/store";
import { encodeBlob, termsHash } from "../lib/template";
import { draftSummary, draftText, toCustomTerms, type TermsDraft } from "../lib/termsDraft";
import { nameFor } from "../lib/view";
import { explainError, useAgreementSend, useAllowedWallet } from "../lib/wallet";
import ShareSheet from "./ShareSheet";
import { when } from "./Messages";

/**
 * v0.13: one conversation. Bubbles are decrypted on this device; the composer
 * seals before sending. v0.14: proposal cards — the other party's signed
 * terms with Accept / Counter / Decline, and "Create the deal" for the
 * accepted version's creator; the created deal's link arrives as a system
 * message so the counterparty needs no URL.
 */
export default function Thread({ address }: { address?: string }) {
  const { publicKey } = useAllowedWallet();
  const { signMessage } = useWallet();
  const send = useAgreementSend();
  const { refresh } = useData();
  const toast = useToast();
  const local = useLocal((d) => d);
  const owner = publicKey?.toBase58();
  const peer = address ?? "";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [invite, setInvite] = useState(false);
  const [fullText, setFullText] = useState<TermsDraft | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineText, setDeclineText] = useState("");
  const [, bump] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const unlocked = messagingUnlocked(owner);
  const peerState = useAsync(async () => (owner && unlocked ? peerKeysFor(peer) : null), [peer, owner, unlocked]);
  const id = owner ? threadId(owner, peer) : "";
  const thread = local.threads[id];
  const msgs = thread?.messages ?? [];
  const st = owner ? negotiationState(thread, owner) : null;

  useEffect(() => {
    setOpenThread(id);
    if (owner && unlocked) pollMessages(owner).catch(() => {});
    return () => setOpenThread(null);
  }, [id, owner, unlocked]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs.length]);
  // A peer who turns messages on while this screen is open shows up within a minute (the service's lookups cache a miss briefly).
  useEffect(() => {
    if (peerState.data?.status !== "none") return;
    const t = window.setInterval(() => document.visibilityState === "visible" && peerState.reload(), 20000);
    return () => window.clearInterval(t);
  }, [peerState.data?.status]);

  if (!owner || !peer) return null;
  const name = nameFor(peer, local);
  const blocked = local.blocked.includes(peer);
  const isContact = !!local.contacts[peer];

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    if (!signMessage) return toast("Your wallet can't sign messages");
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      bump((x) => x + 1);
      pollMessages(owner).catch(() => {});
    } catch (e) {
      toast(explainError(e));
    } finally {
      setBusy(false);
    }
  };
  const sendNow = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await sendText(peer, t);
      setText("");
      pollMessages(owner).catch(() => {});
    } catch (e) {
      toast(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  /** The accepted version's creator creates the deal with that exact text, then hands over the link in chat. */
  const createDeal = (p: Proposal) =>
    act(async () => {
      const t = toCustomTerms(p.draft);
      const agreement = draftText(p.draft);
      const spec = { ...customSpec(t), termsHash: termsHash(agreement) };
      await send(await F.createAndSign(spec, t.rule === "TrueDeadlock" && t.consentTrueDeadlock));
      const k = encodeBlob(p.draft.blob);
      const addr = F.dealAddress(t.creator, t.dealId).toBase58();
      updateLocal((d) => {
        d.links[addr] = k;
        if (p.draft.attachment) d.attachments[addr] = p.draft.attachment;
      });
      await announceDeal(peer, p.hash, addr, k);
      refresh();
    }, "Deal created and shared in chat");
  /** The other party: keep the link and the private details on this device, then open the deal. */
  const openDeal = (deal: string, k: string, p: Proposal | null) => {
    updateLocal((d) => {
      d.links[deal] = k;
      if (p?.draft.attachment) d.attachments[deal] = p.draft.attachment;
    });
    go(`/deal/${deal}`);
  };

  const ProposalCard = ({ m }: { m: StoredMsg }) => {
    const p = proposalOf(m, id);
    const me = m.from === owner;
    if (!p) return <div className={`bubble ${me ? "me" : "them"}`}>A proposal this version of the app can't read.</div>;
    const latest = st?.latest?.hash === p.hash;
    const other = me ? name : "you";
    let status: string;
    if (!latest) status = "Superseded by a later version";
    else if (st?.deal) status = "Deal created";
    else if (st?.agreed) status = `Accepted by both · ${p.draft.terms.creator === owner ? "you create the deal" : `${name} creates the deal`}`;
    else if (st?.declinedBy.has(me ? peer : owner)) status = `Declined by ${me ? name : "you"}`;
    else status = p.signed ? `Signed by ${me ? "you" : name} · waiting for ${other}` : "Not signed by the proposer";
    return (
      <div className={`bubble card ${me ? "me" : "them"}`}>
        <div className="bubble-card">
          <div className="bubble-kicker">{p.draft.version === 1 ? "Proposed terms" : `Counter-proposal · v${p.draft.version}`}</div>
          <div className="bubble-title">{p.draft.blob.s}</div>
          <div className="caption">{draftSummary(p.draft)}</div>
          {p.draft.attachment && <div className="caption">Private details included</div>}
          <div className="caption">{status}</div>
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn plain small" onClick={() => setFullText(p.draft)}>Full text</button>
          {latest && !me && !st?.deal && !st?.agreed && !st?.acceptedBy.has(owner) && !st?.declinedBy.has(owner) && p.signed && (
            <>
              <button className="btn small" disabled={busy} onClick={() => act(() => acceptTerms(owner, peer, p.hash, signMessage!), "Terms accepted")}>Accept</button>
              <button className="btn secondary small" disabled={busy} onClick={() => go(`/new-agreement?draft=${id}:${p.hash}`)}>Counter</button>
              <button className="btn secondary small" disabled={busy} onClick={() => (setDeclining(p.hash), setDeclineText(""))}>Decline</button>
            </>
          )}
          {latest && st?.agreed && !st.deal && p.draft.terms.creator === owner && (
            <button className="btn small" disabled={busy} onClick={() => createDeal(p)}>Create the deal</button>
          )}
        </div>
        <div className="bubble-time">{when(m.at)}</div>
      </div>
    );
  };

  const Bubble = ({ m }: { m: StoredMsg }) => {
    const me = m.from === owner;
    if (m.body.kind === "proposal") return <ProposalCard m={m} />;
    if (m.body.kind === "system") {
      const p = m.body.ref ? (st?.proposals.find((x) => x.hash === m.body.ref) ?? null) : null;
      return (
        <div className="bubble-sys">
          {m.body.text}
          {m.body.deal && m.body.k && (
            <div style={{ marginTop: 6 }}>
              <button className="btn secondary small" onClick={() => openDeal(m.body.deal!, m.body.k!, p)}>Open the deal</button>
            </div>
          )}
        </div>
      );
    }
    const label = m.body.kind === "accept" ? "Accepted the terms ✓" : m.body.kind === "decline" ? "Declined the terms" : null;
    return (
      <div className={`bubble ${me ? "me" : "them"}`}>
        {label ? (
          <div className="bubble-card">
            {label}
            {m.body.text ? <div className="caption">{m.body.text}</div> : null}
          </div>
        ) : (
          m.body.text
        )}
        <div className="bubble-time">{when(m.at)}</div>
      </div>
    );
  };

  return (
    <>
      <NavBar title={name} backTo="/messages" right={<button className="navbtn" onClick={() => setMenu(true)} aria-label="Conversation options">{Icon.more}</button>} />
      {!messagingOn(owner) ? (
        <div className="empty">
          <h3>Turn on messages first</h3>
          <p>Messages are set up from the Messages tab.</p>
          <button className="btn secondary" style={{ maxWidth: 240, margin: "12px auto 0" }} onClick={() => go("/messages")}>Go to Messages</button>
        </div>
      ) : !unlocked ? (
        <div className="empty">
          <h3>Unlock messages</h3>
          <p>One wallet signature recreates your messaging key for this visit.</p>
          <div style={{ maxWidth: 240, margin: "12px auto 0" }}>
            <Button busy={busy} onClick={() => act(() => unlockMessaging(owner, signMessage!))}>Unlock</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="hero" style={{ paddingBottom: 4 }}>
            <Avatar address={peer} name={local.contacts[peer]?.name} />
            <div className="caption mono" style={{ marginTop: 6 }}>{chunked(peer)}</div>
            {!isContact && !blocked && (
              <div className="btn-row" style={{ marginTop: 10, justifyContent: "center" }}>
                <button className="btn secondary" style={{ flex: "0 1 180px" }} onClick={() => go(`/contact/new?address=${peer}`)}>Add to contacts</button>
                <button className="btn secondary" style={{ flex: "0 1 120px" }} onClick={() => (updateLocal((d) => void d.blocked.push(peer)), toast("Blocked on this device"))}>Block</button>
              </div>
            )}
          </div>
          {peerState.data?.status === "none" && (
            <Section footer="Messages only reach wallets that turned them on in this app. Share your pay code so they can find you once they have.">
              <Cell title={`${name} hasn't turned on messages yet`} subtitle="Nothing is queued. If they just did, this updates within a minute." wrap />
              <Cell title="Share my pay code" link onClick={() => setInvite(true)} />
            </Section>
          )}
          {peerState.data?.status === "changed" && (
            <Section footer="Their published messaging key is not the one this device saw before. That happens when they set messages up again on another device, or if something between you is tampering. Check with them before trusting it.">
              <Cell title={`${name}'s messaging key changed`} subtitle={`New key ${short(peerState.data.keys.enc)} · before ${short(peerState.data.pinned.enc)}`} wrap />
              <Cell title="Trust the new key" link onClick={() => (trustPeerKeys(peer, (peerState.data as any).keys), peerState.reload(), pollMessages(owner).catch(() => {}))} />
            </Section>
          )}
          <div className="bubbles" aria-live="polite">
            {msgs.length === 0 && peerState.data?.status === "ok" && <div className="bubble-sys">{COPY.messagesFooter}</div>}
            {msgs.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
            <div ref={endRef} />
          </div>
          {blocked ? (
            <Section footer="You blocked this wallet on this device. Unblock it in Settings → Data & privacy.">
              <Cell title="Blocked" />
            </Section>
          ) : (
            peerState.data?.status === "ok" && (
              <div className="composer no-print">
                <button className="navbtn" onClick={() => go(`/new-agreement?to=${peer}`)} aria-label="Propose terms" title="Propose terms">{Icon.doc}</button>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, MSG_TEXT_MAX))}
                  placeholder={`Message ${name}`}
                  rows={1}
                  aria-label="Message"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendNow();
                  }}
                />
                <button className="btn" disabled={busy || !text.trim()} onClick={sendNow} aria-label="Send">
                  Send
                </button>
              </div>
            )
          )}
        </>
      )}
      <Sheet open={menu} onClose={() => setMenu(false)} title={name}>
        <Section>
          {isContact && <Cell title="View contact" onClick={() => (setMenu(false), go(`/contact/${peer}`))} chevron />}
          <Cell title="Pay" onClick={() => (setMenu(false), go(`/pay?to=${peer}`))} chevron />
          <Cell title="Propose terms" subtitle="Draft an agreement in the Builder and send it here for them to accept, counter or decline." wrap onClick={() => (setMenu(false), go(`/new-agreement?to=${peer}`))} chevron />
          {thread && (
            <Cell
              title="Export conversation"
              subtitle="A JSON file with every message, the service's records and every signature: your copy of how the terms were formed."
              wrap
              onClick={() => (download(`latch-negotiation-${id.slice(0, 8)}.json`, exportNegotiation(thread, owner), "application/json"), setMenu(false))}
            />
          )}
          <Cell
            title="Delete conversation"
            subtitle="Removes it from this device and your records of it from the service (one wallet signature). Their copy stays theirs."
            wrap
            danger
            onClick={() =>
              act(async () => {
                await deleteThread(owner, peer, signMessage!);
                setMenu(false);
                go("/messages");
              }, "Conversation deleted")
            }
          />
        </Section>
      </Sheet>
      <Sheet open={invite} onClose={() => setInvite(false)} title="Share my pay code">
        <ShareSheet inline url={appUrl(`/pay?to=${owner}&src=link`)} text="Find me on Latch" />
      </Sheet>
      <Sheet open={!!fullText} onClose={() => setFullText(null)} title="The agreement as proposed">
        {fullText && (
          <>
            <p className="lead">The exact text the deal will carry if these terms are accepted and created. Its fingerprint goes on-chain; the text does not.</p>
            <div className="agreement" style={{ maxHeight: "60vh", overflow: "auto", whiteSpace: "pre-wrap" }}>{draftText(fullText)}</div>
            {fullText.attachment && (
              <>
                <p className="lead" style={{ marginTop: 12 }}>Private details (only in this conversation; the agreement carries their hash):</p>
                <div className="agreement" style={{ maxHeight: "30vh", overflow: "auto", whiteSpace: "pre-wrap" }}>{fullText.attachment}</div>
              </>
            )}
          </>
        )}
      </Sheet>
      <Sheet open={!!declining} onClose={() => setDeclining(null)} title="Decline these terms">
        <Section footer="They'll see your note. You can still counter with your own terms afterwards.">
          <div className="field">
            <input value={declineText} onChange={(e) => setDeclineText(e.target.value.slice(0, 300))} placeholder="Why (optional)" aria-label="Reason" />
          </div>
        </Section>
        <div className="stack">
          <Button kind="danger" busy={busy} onClick={() => act(async () => (await declineTerms(peer, declining!, declineText), setDeclining(null)), "Declined")}>
            Decline
          </Button>
        </div>
      </Sheet>
    </>
  );
}
