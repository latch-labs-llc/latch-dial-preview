import { Section, Sheet } from "../components/ui";
import { COPY } from "../lib/copy";

/** O3: freeze semantics, unlock date, costs, "not insurance", issuer note (R1 §7.10). */
export default function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="How protection works">
      <Section>
        {COPY.howItWorks.map((x) => (
          <div className="qa" key={x.q}>
            <b>{x.q}</b>
            <span>{x.a}</span>
          </div>
        ))}
      </Section>
    </Sheet>
  );
}

/** S3: Compare options (R1 §7.7). */
export function CompareSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: [string, string, string, string][] = [
    ["Arrives", "Now", "When you say it's OK, or when the window ends", "Per your rules"],
    ["Undo?", "No", "Pause, then agree", "Per your rules"],
    ["If there's a problem", "You're on your own", "Paused until you both agree", "Your decider decides, a timer, or you agree"],
    ["Who can move the money", "Nobody — it's sent", "Neither of you alone", "Per your rules"],
    ["Latch fee", "$0", "$0", "$0"],
    ["Network cost", "< 0.001 SOL, +≈0.002 SOL if a new token account", "≈ 0.01 SOL deposit, not returned in this version", "≈ 0.01 SOL"],
    ["Record", "A transaction", "Signed agreement + record", "Signed agreement + record"],
  ];
  return (
    <Sheet open={open} onClose={onClose} title="Compare options">
      <Section>
        <div style={{ padding: "4px 8px", overflowX: "auto" }}>
          <table className="compare">
            <thead>
              <tr>
                <th></th>
                <th>Instant</th>
                <th>Protected</th>
                <th>Custom</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r[0]}>
                  <th>{r[0]}</th>
                  <td>{r[1]}</td>
                  <td>{r[2]}</td>
                  <td>{r[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Sheet>
  );
}
