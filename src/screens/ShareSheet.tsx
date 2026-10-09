import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Cell, Section, copyText, useToast } from "../components/ui";

/** QR for any link (rendered locally, never fetched). */
export function QR({ value, size = 220 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(value, { type: "svg", margin: 0, errorCorrectionLevel: "M", width: size }).then(setSvg).catch(() => setSvg(""));
  }, [value, size]);
  return <div className="qr" style={{ width: size + 32 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * S6/G1: share a deal or request link — copy, QR, system share, Telegram.
 * Telegram is a plain share-out (t.me/share/url): no Mini App (TON-only
 * policy, R8 ⚠1). The link fragment is visible to whatever app carries it,
 * so the subject line is treated as public (R4 H4).
 */
export default function ShareSheet({ url, text, inline }: { url: string; text: string; inline?: boolean }) {
  const toast = useToast();
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  return (
    <>
      <div style={{ padding: "4px 0 16px" }}>
        <QR value={url} />
      </div>
      <Section footer="Anyone with this link can see the payment and its note. Only the named wallet can accept it.">
        <Cell title="Copy link" link onClick={() => copyText(url, toast, "Link copied")} />
        {canShare && <Cell title="Share…" link onClick={() => navigator.share({ url, text }).catch(() => {})} />}
        <Cell title="Share in Telegram" link href={tg} />
      </Section>
      {!inline && null}
    </>
  );
}
