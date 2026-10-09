import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Button, Section, Sheet } from "../components/ui";
import { parseScan, type Scanned } from "../lib/scan";

/**
 * v0.16: scan a QR code with the camera (BarcodeDetector where the browser has
 * it, jsQR otherwise), or paste what the code says. Frames never leave the
 * device; the sheet only hands back what the code meant.
 */
export default function ScanSheet({ open, onClose, onResult, title = "Scan a code" }: { open: boolean; onClose: () => void; onResult: (s: Scanned, raw: string) => void; title?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let stop = false;
    let raf = 0;
    setError(null);
    setLive(false);
    const finish = (text: string) => {
      const s = parseScan(text);
      if (!s) {
        setError("That code isn't a Latch link, a Solana payment code or a wallet address.");
        return false;
      }
      onResult(s, text);
      return true;
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser can't use the camera here. Paste the code's text below instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        setError("Camera not available (permission refused or no camera). Paste the code's text below instead.");
        return;
      }
      const video = videoRef.current;
      if (!video || stop) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setLive(true);
      const Detector = (window as any).BarcodeDetector;
      const detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let last = 0;
      const tick = async (t: number) => {
        if (stop) return;
        if (t - last > 150 && video.readyState >= 2) {
          last = t;
          try {
            let text: string | null = null;
            if (detector) {
              const codes = await detector.detect(video);
              text = codes[0]?.rawValue ?? null;
            } else if (ctx) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              ctx.drawImage(video, 0, 0);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
            }
            if (text && finish(text)) {
              stop = true;
              return;
            }
          } catch {
            /* a frame that couldn't be read: try the next */
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [open]);

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="scanbox">
        <video ref={videoRef} playsInline muted aria-label="Camera" />
        {!live && !error && <div className="scan-hint">Starting the camera…</div>}
        {live && <div className="scan-frame" aria-hidden />}
      </div>
      {error && <div className="banner warn">{error}</div>}
      <Section header="Or paste" footer="A Latch pay link, a @username link, a deal link, a solana: payment code or a wallet address.">
        <div className="field">
          <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the code's text" autoComplete="off" spellCheck={false} aria-label="Pasted code" />
        </div>
      </Section>
      <div className="stack">
        <Button
          disabled={!pasted.trim()}
          onClick={() => {
            const s = parseScan(pasted);
            if (!s) setError("That isn't a Latch link, a Solana payment code or a wallet address.");
            else onResult(s, pasted);
          }}
        >
          Use pasted text
        </Button>
      </div>
    </Sheet>
  );
}
