import { useState } from "react";
import { Avatar, Cell, Icon, LargeTitle, ModeIcon, NavBar, Section, Sheet, StatusPill, useNow } from "../components/ui";
import { ASSETS, explorerTx } from "../lib/config";
import { useData } from "../lib/data";
import type { Deal } from "../lib/deal";
import { money, relTime } from "../lib/format";
import { go } from "../lib/router";
import { useLocal } from "../lib/store";
import { isKnownMint, isUnsolicited, nameFor, pinPayIn, viewDeal } from "../lib/view";
import { useAllowedWallet } from "../lib/wallet";

/**
 * A1: Activity — Needs you → In progress → Done; pinned Requests row; balance
 * strip. v0.10 #2: a primary action row (Pay · Request · My code) under the
 * balance, one-line rows with a status pill; the long state sentence moved to
 * the deal page.
 */
export default function Activity() {
  const { publicKey } = useAllowedWallet();
  const { deals, loading, error, balances, completedWith, refresh } = useData();
  const local = useLocal((d) => d);
  const now = useNow(30000);
  const [compose, setCompose] = useState(false);
  if (!publicKey) return null;

  const blocked = new Set(local.blocked);
  const hidden = new Set(local.hidden);
  const requests = deals.filter(
    (d) => isUnsolicited(d, publicKey, local, completedWith) && !hidden.has(d.address.toBase58()) && !blocked.has(d.creator.toBase58()) && isKnownMint(d),
  );
  const mine = deals.filter((d) => !isUnsolicited(d, publicKey, local, completedWith) && !hidden.has(d.address.toBase58()));
  const views = mine.map((d) => ({ d, v: viewDeal(d, publicKey, local, now) }));
  const needs = pinPayIn(views.filter((x) => x.v.needsYou && !x.v.done));
  const progress = views.filter((x) => !x.v.needsYou && !x.v.done);
  const done = views.filter((x) => x.v.done);
  const instants = local.payments.filter((p) => p.mode === "instant").slice(0, 20);

  const row = ({ d, v }: { d: Deal; v: ReturnType<typeof viewDeal> }) => {
    const other = v.role === "payer" ? d.parties[d.payeeIdx] : d.parties[d.payerIdx];
    return (
      <Cell
        key={d.address.toBase58()}
        avatar
        before={<Avatar address={other.toBase58()} name={nameFor(other, local)} mode={v.mode} />}
        title={nameFor(other, local)}
        subtitle={v.short}
        after={
          <div className="trail">
            <span className="amt num">{v.amount}</span>
            {v.pill ? <StatusPill kind={v.pill.cls}>{v.pill.text}</StatusPill> : <span>{relTime(d.createdAt, now)}</span>}
          </div>
        }
        onClick={() => go(`/deal/${d.address.toBase58()}`)}
      />
    );
  };

  return (
    <>
      <NavBar
        left={
          <button className="navbtn" onClick={refresh} aria-label="Refresh">
            {loading ? <span className="spinner" /> : Icon.refresh}
          </button>
        }
        right={
          <button className="navbtn" onClick={() => setCompose(true)} aria-label="New payment">
            {Icon.compose}
          </button>
        }
      />
      <LargeTitle>Activity</LargeTitle>

      {balances && (
        <Section footer={<a href="#/add-money">Add test money</a>}>
          <div className="cell">
            <div className="body">
              <div className="t num" style={{ fontSize: 28, fontWeight: 700, lineHeight: "34px" }}>
                {money(balances.usdc, ASSETS.USDC)}
              </div>
              <div className="s">
                USDC · {money(balances.sol, ASSETS.SOL)}
                {balances.wsol > 0n ? ` · ${money(balances.wsol, ASSETS.SOL)} wrapped` : ""}
                {ASSETS.TEST && balances.test > 0n ? ` · ${money(balances.test, ASSETS.TEST)} TEST` : ""}
              </div>
            </div>
          </div>
        </Section>
      )}

      <div className="actionrow">
        <button className="btn" onClick={() => go("/pay")}>
          {Icon.pay}Pay
        </button>
        <button className="btn secondary" onClick={() => go("/request")}>
          {Icon.request}Request
        </button>
        <button className="btn secondary" onClick={() => go("/paycode")} aria-label="Receive: my pay code">
          {Icon.qr}Receive
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {Object.values(local.requests).some((r) => r.conflict) && (
        <div className="banner warn">
          More than one payment claims to answer one of your requests, so none of them is marked as yours. Check with the person paying before you accept any — they're in Requests.
        </div>
      )}

      {requests.length > 0 && (
        <Section>
          <Cell
            title="Requests"
            subtitle="From people you don't know · no notifications"
            before={<span className="badge muted">{requests.length}</span>}
            onClick={() => go("/requests")}
            chevron
          />
        </Section>
      )}

      {needs.length > 0 && <Section header="Needs you">{needs.map(row)}</Section>}
      {progress.length > 0 && <Section header="In progress">{progress.map(row)}</Section>}
      {(done.length > 0 || instants.length > 0) && (
        <Section header="Done">
          {done.map(row)}
          {instants.map((p) => (
            <Cell
              key={p.sig ?? `${p.address}-${p.at}`}
              avatar
              before={<Avatar address={p.address} name={nameFor(p.address, local)} mode="instant" />}
              title={nameFor(p.address, local)}
              subtitle={`Sent instantly${p.memo ? ` · ${p.memo}` : ""}`}
              after={
                <div className="trail">
                  <span className="amt num">{p.amount}</span>
                  <span>{relTime(p.at, now)}</span>
                </div>
              }
              href={p.sig ? explorerTx(p.sig) : undefined}
            />
          ))}
        </Section>
      )}

      {!loading && deals.length === 0 && instants.length === 0 && (
        <div className="empty">
          <div className="big" style={{ color: "var(--protected)", width: 48, margin: "0 auto 12px" }}>{ModeIcon.protected}</div>
          <h3>No payments yet</h3>
          <p>Pay someone, request money, or make an agreement. Protected payments show their unlock date right here.</p>
          <button className="btn" style={{ maxWidth: 240, margin: "16px auto 0" }} onClick={() => setCompose(true)}>
            New payment
          </button>
        </div>
      )}

      <Sheet open={compose} onClose={() => setCompose(false)} title="New">
        <Section>
          <Cell title="Pay someone" subtitle="Instant, protected, or your own rules" before={<span style={{ width: 24, color: "var(--protected)" }}>{Icon.pay}</span>} onClick={() => (setCompose(false), go("/pay"))} chevron />
          <Cell title="Request money" subtitle="Share a link — they pay into a protected payment" before={<span style={{ width: 24, color: "var(--protected)" }}>{Icon.request}</span>} onClick={() => (setCompose(false), go("/request"))} chevron />
          <Cell title="Make an agreement" subtitle="A real contract, clause by clause, with rules you all sign" before={<span style={{ width: 24, color: "var(--custom)" }}>{Icon.doc}</span>} onClick={() => (setCompose(false), go("/new-agreement"))} chevron />
        </Section>
      </Sheet>
    </>
  );
}
