import { Cell, Section, Sheet } from "../components/ui";
import { isMobileWeb, openInWalletLinks, useWalletPicker } from "../lib/wallet";

/** O2: allowlisted wallets only; "Open in…" links on mobile web; "Get a wallet". */
export default function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const entries = useWalletPicker();
  const installed = entries.filter((e) => e.installed);
  const mobile = isMobileWeb();
  return (
    <Sheet open={open} onClose={onClose} title="Connect a wallet">
      <p className="lead">
        Latch works with wallets you already trust. Latch never creates, holds or sees your keys.
      </p>
      {installed.length > 0 && (
        <Section header="On this device">
          {installed.map((e) => (
            <Cell
              key={e.name}
              title={e.name}
              subtitle={e.outsideAllowlist ? "Outside Latch's wallet list — whichever wallet answers on your phone" : undefined}
              wrap
              before={e.icon ? <img src={e.icon} width={30} height={30} alt="" style={{ borderRadius: 8 }} /> : <span style={{ width: 30 }} />}
              onClick={() => {
                e.select();
                onClose();
              }}
              chevron
            />
          ))}
        </Section>
      )}
      {mobile && (
        <Section header="Open Latch inside your wallet app" footer="Phone browsers can't reach wallet apps directly. These links open this page in the wallet's own browser.">
          {openInWalletLinks().map((l) => (
            <Cell key={l.name} title={`Open in ${l.name}`} href={l.url} chevron link />
          ))}
        </Section>
      )}
      <Section header="Get a wallet" footer="Set the wallet to Devnet (test network) in its developer settings.">
        {entries
          .filter((e) => !e.outsideAllowlist)
          .map((e) => (
            <Cell key={e.name} title={e.name} subtitle={e.installed ? "Installed" : "Not installed"} href={e.getUrl} chevron />
          ))}
      </Section>
    </Sheet>
  );
}
