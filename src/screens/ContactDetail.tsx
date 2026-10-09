import { Avatar, Cell, NavBar, Section, copyText, useAsync, useToast } from "../components/ui";
import { TG_BADGE, profileOf, serviceOn } from "../lib/service";
import { explorerAddr } from "../lib/config";
import { useData } from "../lib/data";
import { chunked } from "../lib/format";
import { go } from "../lib/router";
import { updateLocal, useLocal } from "../lib/store";
import { viewDeal } from "../lib/view";
import { useAllowedWallet } from "../lib/wallet";

/** K2: contact detail — chunked pubkey, history, per-contact default mode, block. */
export default function ContactDetail({ address }: { address?: string }) {
  const local = useLocal((d) => d);
  const { deals } = useData();
  const { publicKey } = useAllowedWallet();
  const toast = useToast();
  const c = address ? local.contacts[address] : undefined;
  const prof = useAsync(async () => (address ? profileOf(address) : null), [address]);
  if (!c) return <><NavBar title="Contact" backTo="/contacts" /><div className="empty">Not in your contacts.</div></>;
  const now = Math.floor(Date.now() / 1000);
  const history = deals.filter((d) => d.parties.some((p) => p.toBase58() === c.address));
  const blocked = local.blocked.includes(c.address);

  return (
    <>
      <NavBar title="" backTo="/contacts" />
      <div className="hero">
        <div style={{ display: "inline-block", transform: "scale(1.6)", margin: "10px 0 18px" }}>
          <Avatar address={c.address} name={c.name} />
        </div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>{c.name}</div>
        <div className="caption mono" style={{ marginTop: 6 }}>{chunked(c.address)}</div>
        {(prof.data?.handle || prof.data?.telegram) && (
          <div style={{ marginTop: 8, display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
            {prof.data?.handle && <span className="pill">@{prof.data.handle.handle} ✓</span>}
            {prof.data?.telegram && <span className="pill">Telegram @{prof.data.telegram.username} · {TG_BADGE}</span>}
          </div>
        )}
      </div>
      <div className="stack" style={{ flexDirection: "row" }}>
        <button className="btn secondary" onClick={() => go(`/pay?to=${c.address}`)}>Pay</button>
        <button className="btn secondary" onClick={() => go(`/request`)}>Request</button>
        {serviceOn && <button className="btn secondary" onClick={() => go(`/chat/${c.address}`)}>Message</button>}
      </div>
      <Section header="Name" footer={c.verifiedHow ? `You noted: verified by ${c.verifiedHow}.` : "Tip: note how you verified this address (met in person, QR scan)."}>
        <div className="field">
          <input value={c.name} onChange={(e) => updateLocal((d) => void (d.contacts[c.address].name = e.target.value))} aria-label="Name" />
        </div>
        <div className="field">
          <input value={c.verifiedHow ?? ""} placeholder="How you verified this address" onChange={(e) => updateLocal((d) => void (d.contacts[c.address].verifiedHow = e.target.value))} aria-label="How verified" />
        </div>
      </Section>
      <Section header="Default protection" footer="Only for people you trust. Large payments still default to Protected. You can change this any time.">
        <Cell
          title={`Default to Instant for ${c.name}`}
          after={<input type="checkbox" checked={!!c.defaultInstant} onChange={(e) => updateLocal((d) => void (d.contacts[c.address].defaultInstant = e.target.checked))} />}
        />
      </Section>
      {history.length > 0 && publicKey && (
        <Section header="Payments together">
          {history.map((d) => {
            const v = viewDeal(d, publicKey, local, now);
            return <Cell key={d.address.toBase58()} title={v.amount} subtitle={v.sentence} onClick={() => go(`/deal/${d.address.toBase58()}`)} chevron />;
          })}
        </Section>
      )}
      <Section>
        <Cell title="Copy address" link onClick={() => copyText(c.address, toast)} />
        <Cell title="View on Solana Explorer" href={explorerAddr(c.address)} chevron />
        <Cell
          title={blocked ? "Unblock" : "Block"}
          danger={!blocked}
          onClick={() =>
            updateLocal((d) => {
              d.blocked = blocked ? d.blocked.filter((b) => b !== c.address) : [...d.blocked, c.address];
            })
          }
        />
        <Cell
          title="Delete contact"
          danger
          onClick={() => {
            updateLocal((d) => void delete d.contacts[c.address]);
            go("/contacts");
          }}
        />
      </Section>
    </>
  );
}
