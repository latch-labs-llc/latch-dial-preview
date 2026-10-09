import { Avatar, Cell, NavBar, Section, useNow, useToast } from "../components/ui";
import { assetForMint } from "../lib/config";
import { useData } from "../lib/data";
import { chunked, money, relTime } from "../lib/format";
import { go } from "../lib/router";
import { updateLocal, useLocal } from "../lib/store";
import { isKnownMint, isUnsolicited } from "../lib/view";
import { useAllowedWallet } from "../lib/wallet";

/**
 * A2: Requests quarantine (R3 §3.3). Unknown-sender Drafts naming me: full
 * chunked address, no free text, allowlisted mints only, no notifications.
 * Hide / Block are local. Declining on-chain is offered on the deal page
 * (it costs a fee and shows the wallet is active), so Hide is the default.
 */
export default function Requests() {
  const { publicKey } = useAllowedWallet();
  const { deals, completedWith } = useData();
  const local = useLocal((d) => d);
  const toast = useToast();
  const now = useNow(60000);
  if (!publicKey) return null;
  const blocked = new Set(local.blocked);
  const hidden = new Set(local.hidden);
  const all = deals.filter((d) => isUnsolicited(d, publicKey, local, completedWith));
  const shown = all.filter((d) => !hidden.has(d.address.toBase58()) && !blocked.has(d.creator.toBase58()) && isKnownMint(d));
  const unknownMints = all.filter((d) => !isKnownMint(d)).length;

  return (
    <>
      <NavBar title="Requests" backTo="/" />
      <div className="banner">
        Payment requests and deals from people you don't know. Nothing here can take money from you. You only pay if you open one and approve it in your wallet.
      </div>
      {shown.length === 0 && <div className="empty">Nothing here.</div>}
      {shown.length > 0 && (
        <Section header="From people you don't know">
          {shown.map((d) => {
            const creator = d.creator.toBase58();
            const role = d.parties[d.payerIdx].equals(publicKey) ? "asks you to pay" : d.parties[d.payeeIdx].equals(publicKey) ? "wants to pay you" : "named you in a deal";
            return (
              <div key={d.address.toBase58()}>
                <Cell
                  avatar
                  before={<Avatar address={creator} />}
                  title={<span className="mono">{chunked(creator)}</span>}
                  subtitle={`${role} · ${money(d.totalAmount, assetForMint(d.mint))} · ${relTime(d.createdAt, now)}`}
                  wrap
                  onClick={() => go(`/deal/${d.address.toBase58()}`)}
                  chevron
                />
                <div className="btn-row" style={{ padding: "0 16px 12px 70px" }}>
                  <button
                    className="btn secondary"
                    style={{ minHeight: 34, fontSize: 15 }}
                    onClick={() => {
                      updateLocal((x) => void x.hidden.push(d.address.toBase58()));
                      toast("Hidden");
                    }}
                  >
                    Hide
                  </button>
                  <button
                    className="btn danger"
                    style={{ minHeight: 34, fontSize: 15 }}
                    onClick={() => {
                      updateLocal((x) => void x.blocked.push(creator));
                      toast("Blocked on this device");
                    }}
                  >
                    Block sender
                  </button>
                </div>
              </div>
            );
          })}
        </Section>
      )}
      {unknownMints > 0 && (
        <Section footer="Requests in tokens Latch doesn't recognise are hidden automatically.">
          <Cell title="Unknown tokens hidden" value={String(unknownMints)} />
        </Section>
      )}
      {hidden.size + blocked.size > 0 && (
        <Section>
          <Cell
            title="Show hidden requests again"
            link
            onClick={() => {
              updateLocal((x) => {
                x.hidden = [];
              });
              toast("Hidden requests restored");
            }}
          />
        </Section>
      )}
    </>
  );
}
