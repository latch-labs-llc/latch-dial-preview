import { IDENTITY_PREVIEW } from "../lib/config";
import { useEffect, useState } from "react";
import { TG_BADGE, resolveName, serviceOn, type Resolved } from "../lib/service";
import { checkPin, nameKey, parseNameInput, pinName, pinWarning } from "../lib/namePins";
import { Avatar, Button, Cell, NavBar, Section } from "../components/ui";
import ScanSheet from "./ScanSheet";
import { parseAddress } from "../lib/evidence";
import { chunked, short } from "../lib/format";
import { findLookAlike } from "../lib/policy";
import { back } from "../lib/router";
import { knownAddresses, updateLocal, useLocal } from "../lib/store";

/** K3: add a contact by pasted address (or prefilled from a payment). */
export default function AddContact({ query }: { query: URLSearchParams }) {
  const [address, setAddress] = useState(query.get("address") ?? "");
  const [name, setName] = useState(query.get("name") ?? "");
  const [how, setHow] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [pinConfirmed, setPinConfirmed] = useState("");
  const [scan, setScan] = useState(query.get("scan") === "1");
  const pins = useLocal((d) => d.pins);
  const typedName = !!parseNameInput(address);
  useEffect(() => {
    setResolved(null);
    if (!typedName || !serviceOn) return;
    const t = window.setTimeout(() => resolveName(address).then((r) => (setResolved(r), r && !name && setName(r.name))), 350);
    return () => window.clearTimeout(t);
  }, [address]);
  const key = typedName ? (resolved ? parseAddress(resolved.owner) : null) : parseAddress(address);
  const pinKey = resolved ? nameKey(resolved.via, resolved.name) : null;
  const pinStatus = resolved && pinKey ? checkPin(pins, pinKey, resolved.owner, resolved.issued) : null;
  const pinMsg = resolved && pinKey && pinStatus ? pinWarning(pinStatus, resolved.via === "handle" ? `@${resolved.name}` : `tg:@${resolved.name}`, pins[pinKey]?.owner, resolved.owner) : null;
  const pinBlocks = pinStatus === "stale" || (pinStatus === "changed" && pinConfirmed !== resolved?.owner);
  const lookAlike = key ? findLookAlike(key.toBase58(), knownAddresses()) : undefined;
  return (
    <>
      <NavBar title="New contact" backTo="/contacts" />
      <Section header="Address" footer="Paste the full address. Check it with the person — never copy addresses from your transaction history.">
        <div className="field">
          <input value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder={serviceOn ? (IDENTITY_PREVIEW ? "Address, or @username / tg:@telegram (preview)" : "@username, tg:@telegram or address") : "Wallet address"} spellCheck={false} autoCapitalize="none" style={{ fontFamily: "var(--mono)", fontSize: 14 }} />
        </div>
        <Cell title="Scan their code" link onClick={() => setScan(true)} />
        {resolved && <Cell title={resolved.via === "handle" ? `@${resolved.name} · signed by this wallet ✓` : `tg:@${resolved.name} · ${TG_BADGE}`} />}
        {key && <Cell avatar before={<Avatar address={key.toBase58()} />} title={<span className="mono" style={{ fontSize: 13 }}>{chunked(key.toBase58())}</span>} wrap />}
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
      {lookAlike && <div className="banner warn">⚠ This looks like {short(lookAlike)}, an address you already know, but it's a different address. Check every character.</div>}
      <Section header="Name">
        <div className="field">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={40} />
        </div>
        <div className="field">
          <input value={how} onChange={(e) => setHow(e.target.value)} placeholder="How you verified it (optional)" maxLength={60} />
        </div>
      </Section>
      <div className="stack">
        <Button
          disabled={!key || !name.trim() || pinBlocks}
          onClick={() => {
            updateLocal((d) => {
              if (resolved && pinKey) pinName(d.pins, pinKey, resolved.owner, resolved.issued, Math.floor(Date.now() / 1000));
              d.contacts[key!.toBase58()] = { address: key!.toBase58(), name: name.trim(), verifiedHow: how.trim() || undefined, createdAt: Math.floor(Date.now() / 1000) };
            });
            back("/contacts");
          }}
        >
          Save contact
        </Button>
      </div>
      <ScanSheet
        open={scan}
        onClose={() => setScan(false)}
        title="Scan their pay code"
        onResult={(s) => {
          const addr = s.kind === "address" || s.kind === "deal" ? s.address : s.kind === "pay" ? s.address : null;
          if (s.kind === "user") setAddress(`@${s.name}`);
          else if (addr) setAddress(addr);
          setScan(false);
        }}
      />
    </>
  );
}
