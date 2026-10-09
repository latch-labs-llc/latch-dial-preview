import { useState } from "react";
import { NavBar, Section, Cell, copyText, useAsync, useToast } from "../components/ui";
import { profileOf } from "../lib/service";
import { chunked } from "../lib/format";
import { appUrl } from "../lib/router";
import { profilePath } from "../lib/profileLinks";
import { useAllowedWallet } from "../lib/wallet";
import ShareSheet, { QR } from "./ShareSheet";

/**
 * K4 / M6: my pay code — QR + request link. v0.10 #7: one code on screen;
 * the raw receive address is behind "Show address" so two QR codes never
 * compete for the same glance.
 */
export default function PayCode() {
  const { publicKey } = useAllowedWallet();
  const toast = useToast();
  const [showAddress, setShowAddress] = useState(false);
  const prof = useAsync(async () => (publicKey ? profileOf(publicKey.toBase58()) : null), [publicKey?.toBase58()]);
  if (!publicKey) return null;
  const addr = publicKey.toBase58();
  const handle = prof.data?.handle?.handle;
  const link = handle ? appUrl(profilePath(handle)) : appUrl(`/pay?to=${addr}&src=link`);
  return (
    <>
      <NavBar title="Receive" backTo="/" />
      {handle && (
        <div className="hero" style={{ paddingBottom: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>@{handle}</div>
        </div>
      )}
      <div className="banner">People who scan this can pay you. They choose how protected the payment is.</div>
      <ShareSheet inline url={link} text="Pay me with Latch" />
      <Section footer={showAddress ? "Only share your address from here — never copy it from transaction history." : "For wallets and exchanges that need a plain address instead of a link."}>
        {!showAddress ? (
          <Cell title="Show my wallet address" link onClick={() => setShowAddress(true)} />
        ) : (
          <>
            <div style={{ padding: 16 }}>
              <QR value={addr} size={160} />
            </div>
            <Cell title={<span className="mono" style={{ fontSize: 13 }}>{chunked(addr)}</span>} wrap />
            <Cell title="Copy address" link onClick={() => copyText(addr, toast)} />
          </>
        )}
      </Section>
    </>
  );
}
