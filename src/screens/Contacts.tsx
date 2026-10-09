import { useState } from "react";
import { Avatar, Cell, Icon, LargeTitle, NavBar, Section } from "../components/ui";
import { short } from "../lib/format";
import { go } from "../lib/router";
import { DEMO_CONTACTS } from "../lib/demo";
import { useLocal, updateLocal } from "../lib/store";

/** K1: device-local address book. Names never replace addresses (R3 B1). */
export default function Contacts() {
  const addDemo = () =>
    updateLocal((d) => {
      for (const c of DEMO_CONTACTS) if (!d.contacts[c.address]) d.contacts[c.address] = { address: c.address, name: c.name, note: c.note, verifiedHow: "demo wallet (public key)", createdAt: Math.floor(Date.now() / 1000) };
    });
  const contacts = useLocal((d) => d.contacts);
  const [q, setQ] = useState("");
  const list = Object.values(contacts)
    .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.address.startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <NavBar
        left={
          <>
            <button className="navbtn" onClick={() => go("/paycode")} aria-label="My pay code">{Icon.qr}</button>
            <button className="navbtn" onClick={() => go("/contact/new?scan=1")} aria-label="Scan a code">{Icon.scan}</button>
          </>
        }
        right={<button className="navbtn" onClick={() => go("/contact/new")} aria-label="Add contact">{Icon.plus}</button>}
      />
      <LargeTitle>Contacts</LargeTitle>
      <Section>
        <div className="field">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names or addresses" aria-label="Search" />
        </div>
      </Section>
      {list.length === 0 ? (
        <div className="empty">
          <div className="big" style={{ width: 48, margin: "0 auto 12px", color: "var(--hint)" }}>{Icon.people}</div>
          <h3>{q ? "No matches" : "No contacts yet"}</h3>
          <p>Contacts live only on this device. Add someone by address or QR, or save people after a payment.</p>
          {!q && (
            <button className="btn secondary" style={{ maxWidth: 260, margin: "12px auto 0" }} onClick={addDemo}>
              Add demo contacts
            </button>
          )}
        </div>
      ) : (
        <Section footer={`Stored only on this device. Export them from Settings → Data & privacy.${DEMO_CONTACTS.every((c) => contacts[c.address]) ? "" : " Want someone to practise with? Add the demo contacts below."}`}>
          {list.map((c) => (
            <Cell
              key={c.address}
              avatar
              before={<Avatar address={c.address} name={c.name} />}
              title={c.name}
              subtitle={`${short(c.address)}${c.verifiedHow ? ` · ${c.verifiedHow}` : ""}${c.defaultInstant ? " · Instant by default" : ""}`}
              onClick={() => go(`/contact/${c.address}`)}
              chevron
            />
          ))}
          {!DEMO_CONTACTS.every((c) => contacts[c.address]) && <Cell title="Add demo contacts" link onClick={addDemo} />}
        </Section>
      )}
    </>
  );
}
