import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";
import { Button, Cell, NavBar, Section, download, useAsync } from "../components/ui";
import { assetForMint } from "../lib/config";
import { fetchDeal } from "../lib/chain";
import { useLocal } from "../lib/store";
import { sha256Hex } from "../lib/template";
import { C1_NOTE, UNREADABLE, agreementStatus, statusLabel } from "../lib/agreementCheck";
import { bytesToHex } from "@noble/hashes/utils.js";

/** A8: the regenerated agreement, with match status for the text and the attachment. */
export default function AgreementView({ address }: { address?: string }) {
  const { connection } = useConnection();
  const local = useLocal((d) => d);
  const key = useMemo(() => {
    try {
      return address ? new PublicKey(address) : null;
    } catch {
      return null;
    }
  }, [address]);
  const q = useAsync(async () => (key ? fetchDeal(connection, key) : null), [key?.toBase58()]);
  const d = q.data;
  if (!d) return <><NavBar title="Agreement" backTo="/" /><div className="empty">{q.loading ? <span className="spinner" /> : "Not found."}</div></>;

  const blobStr = local.links[d.address.toBase58()];
  const decimals = assetForMint(d.mint)?.decimals ?? 6;
  const status = agreementStatus(d, blobStr, decimals);
  const check = status.kind === "verified" ? status : null;
  const blob = status.kind === "verified" || status.kind === "mismatch" ? status.blob : null;
  const att = local.attachments[d.address.toBase58()];
  const attOk = blob?.a && att ? sha256Hex(att) === blob.a : null;

  return (
    <>
      <NavBar title="Agreement" backTo={`/deal/${d.address.toBase58()}`} />
      <Section>
        <Cell title="Agreement text" value={statusLabel(status)} />
        <Cell title="Private details" value={blob?.a ? (att ? (attOk ? "✓ matches" : "✗ mismatch") : "agreed — copy held by the parties") : "none"} />
        <Cell title="On-chain fingerprint" subtitle={<span className="mono">{bytesToHex(d.termsHash)}</span>} wrap />
      </Section>
      {check?.format === "c1" && <div className="banner">{C1_NOTE}</div>}
      {status.kind === "unreadable" && <div className="banner warn">{UNREADABLE}</div>}
      {status.kind === "mismatch" && <div className="banner error">The text from this link does NOT match the on-chain fingerprint. It is not the signed agreement.</div>}
      {check ? (
        <>
          <Section header={`Template ${check.blob.t} · format ${check.format}`}>
            <div className="agreement">{check.text}</div>
          </Section>
          <div className="stack">
            <Button kind="secondary" onClick={() => download(`latch-agreement-${check.hex.slice(0, 8)}.txt`, check.text)}>
              Download agreement
            </Button>
            {att && (
              <Button kind="secondary" onClick={() => download(`latch-details-${blob!.a!.slice(0, 8)}.txt`, att)}>
                Download private details
              </Button>
            )}
          </div>
        </>
      ) : status.kind === "none" ? (
        <div className="banner">The agreement can be regenerated only from the payment's link. Open the link you were sent on this device.</div>
      ) : null}
    </>
  );
}
