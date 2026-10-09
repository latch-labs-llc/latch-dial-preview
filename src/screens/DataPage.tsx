import { Cell, NavBar, Section } from "../components/ui";
import { LEGAL_CONTACT, SERVICE_URL } from "../lib/config";
import { IN_TRANSIT, NOT_KEPT, RETENTION } from "../lib/retention";

/**
 * B4: Data & legal requests. Lists every record the optional Latch service
 * keeps, how long, and how it's deleted — from the same table the Worker is
 * tested against.
 */
export default function DataPage() {
  return (
    <>
      <NavBar title="Data & legal requests" backTo="/settings" />
      <div className="banner">
        {SERVICE_URL
          ? `This app uses the optional Latch service at ${SERVICE_URL.replace(/^https:\/\//, "")} for @usernames, Telegram linking, online backups and the TEST faucet. Everything else stays on this device or on Solana.`
          : "This build doesn't use the Latch service: nothing below is kept anywhere. Contacts, history and settings stay on this device; payments are on Solana."}
      </div>
      <Section header="What the service keeps" footer="Wallet addresses and payments on Solana are public no matter what this service does.">
        {RETENTION.map((r) => (
          <Cell key={r.prefix} title={<span className="mono" style={{ fontSize: 13 }}>{r.prefix}</span>} subtitle={`${r.holds} Kept: ${r.ttl} (${r.store}). Deleted by: ${r.deletedBy}.`} wrap />
        ))}
      </Section>
      <Section header="Passes through, not stored">
        {IN_TRANSIT.map((x) => (
          <Cell key={x} title={x} wrap />
        ))}
      </Section>
      <Section header="Never kept">
        {NOT_KEPT.map((x) => (
          <Cell key={x} title={x} wrap />
        ))}
      </Section>
      <Section
        header="Legal requests"
        footer={`Latch can only hand over what is listed above. It can't decrypt backups, can't see agreement text, and holds no key that can move, freeze or redirect money in a deal. Requests about a deal's funds concern the parties and the public Solana record. Contact for legal and data requests: ${LEGAL_CONTACT}. Include the wallet address the request concerns.`}
      >
        <Cell title="Delete your data" subtitle="Settings → Data & privacy → Clear data → also delete from the Latch service (one wallet signature)." wrap />
      </Section>
    </>
  );
}
