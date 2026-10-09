import { useEffect, useState } from "react";
import { Icon } from "./components/ui";
import { COPY } from "./lib/copy";
import { useData } from "./lib/data";
import { go, useRoute } from "./lib/router";
import { getLocal, useLocal } from "./lib/store";
import { useAllowedWallet } from "./lib/wallet";
import { isUnsolicited, viewDeal } from "./lib/view";
import { unreadTotal } from "./lib/messaging";
import Activity from "./screens/Activity";
import AddContact from "./screens/AddContact";
import AddMoney from "./screens/AddMoney";
import AgreementView from "./screens/AgreementView";
import Builder from "./screens/Builder";
import ContactDetail from "./screens/ContactDetail";
import Contacts from "./screens/Contacts";
import Messages from "./screens/Messages";
import Thread from "./screens/Thread";
import DealPage from "./screens/DealPage";
import Evidence from "./screens/Evidence";
import Pay from "./screens/Pay";
import PayCode from "./screens/PayCode";
import RequestMoney from "./screens/RequestMoney";
import Requests from "./screens/Requests";
import Settings from "./screens/Settings";
import Welcome from "./screens/Welcome";
import DataPage from "./screens/DataPage";
import UserPage from "./screens/UserPage";

export default function App() {
  const route = useRoute();
  const { publicKey, wallet, connected, allowed, disconnect } = useAllowedWallet();
  const theme = useLocal((d) => d.settings.theme);
  const { deals } = useData();
  const [, force] = useState(0);

  // v0.10 #1: one dark-mode block in CSS; "System" is resolved here and written to data-theme.
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => root.setAttribute("data-theme", theme === "system" ? (mq?.matches ? "dark" : "light") : theme);
    apply();
    if (theme !== "system" || !mq) return;
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, [theme]);

  // A connected wallet outside the allowlist is disconnected (R8 D6).
  useEffect(() => {
    if (connected && wallet && !allowed) disconnect().catch(() => {});
  }, [connected, wallet, allowed, disconnect]);

  // Returning from Telegram sign-in (?code&state): finish it on Settings → Profile.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("code") && q.get("state") && !window.location.hash.startsWith("#/settings")) go("/settings");
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => force((x) => x + 1), 30000);
    return () => window.clearInterval(t);
  }, []);

  const [p0, p1] = route.path;
  const tab = p0 === "contacts" || p0 === "contact" ? "contacts" : p0 === "messages" || p0 === "chat" ? "messages" : p0 === "settings" ? "settings" : "activity";
  const unread = useLocal((d) => unreadTotal(d.threads));

  // Badge: only "needs you" items from known counterparties (Requests never badge the tab).
  const now = Math.floor(Date.now() / 1000);
  const local = getLocal();
  const badge = publicKey
    ? deals.filter((d) => !isUnsolicited(d, publicKey, local, new Set()) && viewDeal(d, publicKey, local, now).needsYou).length
    : 0;

  // Shareable links work without a wallet (read-only), everything else needs one.
  const publicRoutes = ["deal", "agreement", "evidence", "settings", "u", "data"];
  let screen: JSX.Element;
  if (!publicKey && !publicRoutes.includes(p0 ?? "") && p0 !== "pay") {
    screen = <Welcome />;
  } else {
    switch (p0) {
      case undefined:
      case "":
        screen = <Activity />;
        break;
      case "requests":
        screen = <Requests />;
        break;
      case "deal":
        screen = <DealPage address={p1} blobParam={route.query.get("k")} legacySubject={route.query.get("s")} />;
        break;
      case "agreement":
        screen = <AgreementView address={p1} />;
        break;
      case "evidence":
        screen = <Evidence address={p1} />;
        break;
      case "pay":
        screen = publicKey ? <Pay query={route.query} /> : <Welcome reason="Connect a wallet to pay." />;
        break;
      case "request":
        screen = <RequestMoney />;
        break;
      case "new-agreement":
        screen = <Builder query={route.query} />;
        break;
      case "contacts":
        screen = <Contacts />;
        break;
      case "messages":
        screen = <Messages />;
        break;
      case "chat":
        screen = <Thread address={p1} />;
        break;
      case "contact":
        screen = p1 === "new" ? <AddContact query={route.query} /> : <ContactDetail address={p1} />;
        break;
      case "paycode":
        screen = <PayCode />;
        break;
      case "u":
        screen = <UserPage name={p1} />;
        break;
      case "add-money":
        screen = <AddMoney />;
        break;
      case "settings":
        screen = <Settings />;
        break;
      case "data":
        screen = <DataPage />;
        break;
      default:
        screen = <Activity />;
    }
  }

  return (
    <div className="app">
      <div className="testbar" role="note">
        {COPY.testBanner}
      </div>
      <div key={route.path.join("/")} className="screen-enter">
        {screen}
      </div>
      {(publicKey || p0 === "settings") && (
        <div className="tabbar no-print">
          <nav aria-label="Main">
            <button className="tab" aria-current={tab === "activity" ? "page" : undefined} onClick={() => go("/")}>
              {Icon.activity}
              Activity
              {badge > 0 && <span className="badge">{badge}</span>}
            </button>
            <button className="tab" aria-current={tab === "messages" ? "page" : undefined} onClick={() => go("/messages")}>
              {Icon.messages}
              Messages
              {unread > 0 && <span className="badge">{unread}</span>}
            </button>
            <button className="tab" aria-current={tab === "contacts" ? "page" : undefined} onClick={() => go("/contacts")}>
              {Icon.contacts}
              Contacts
            </button>
            <button className="tab" aria-current={tab === "settings" ? "page" : undefined} onClick={() => go("/settings")}>
              {Icon.settings}
              Settings
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}
