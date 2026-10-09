import { IDENTITY_PREVIEW } from "../lib/config";
import { Avatar, Button, Cell, NavBar, Section, useAsync } from "../components/ui";
import { chunked } from "../lib/format";
import { go } from "../lib/router";
import { TG_BADGE, profileOf, resolveName, serviceOn } from "../lib/service";
import { useLocal } from "../lib/store";
import { contactHrefForName, nameFromProfilePath, payHrefForName } from "../lib/profileLinks";

/** #/u/<username>: a shareable profile — pay, request, or save as a contact. */
export default function UserPage({ name }: { name?: string }) {
  const contacts = useLocal((d) => d.contacts);
  const q = useAsync(async () => {
    if (!name || !serviceOn) return null;
    const r = await resolveName(nameFromProfilePath(name));
    if (!r) return null;
    return { ...r, profile: await profileOf(r.owner) };
  }, [name]);
  const u = q.data;
  if (q.loading) return <><NavBar title="" backTo="/" /><div className="empty"><span className="spinner" /></div></>;
  if (!u) return <><NavBar title="" backTo="/" /><div className="empty">{serviceOn ? `No one is @${name} yet.` : "Usernames aren't available in this build."}</div></>;
  const handle = u.profile.handle?.handle;
  const tg = u.profile.telegram?.username;
  return (
    <>
      <NavBar title="" backTo="/" />
      <div className="hero">
        <div style={{ display: "inline-block", transform: "scale(1.6)", margin: "10px 0 18px" }}>
          <Avatar address={u.owner} name={contacts[u.owner]?.name ?? handle ?? tg} />
        </div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>{contacts[u.owner]?.name ?? (handle ? `@${handle}` : `@${tg}`)}</div>
        <div className="caption mono" style={{ marginTop: 6 }}>{chunked(u.owner)}</div>
      </div>
      <Section footer="Names are signed by the wallet that owns them. Always check the address before paying someone new.">
        {handle && <Cell title={`@${handle}`} subtitle={`Latch username${IDENTITY_PREVIEW ? " · Preview" : ""} · signed by this wallet ✓`} />}
        {tg && <Cell title={`Telegram @${tg}`} subtitle={TG_BADGE} href={`https://t.me/${tg}`} chevron />}
      </Section>
      <div className="stack">
        {/* Through the name, not the raw address, so Pay / Add contact run the pin check. */}
        <Button onClick={() => go(payHrefForName(`@${u.name}`))}>Pay</Button>
        {!contacts[u.owner] && (
          <Button kind="secondary" onClick={() => go(contactHrefForName(`@${u.name}`))}>
            Save as contact
          </Button>
        )}
      </div>
    </>
  );
}
