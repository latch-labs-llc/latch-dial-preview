/** v0.4 B3: name hijack — separate namespaces, 60-day holds, pinning, per-owner lastIssued. */
import { describe, expect, it } from "vitest";
import { handleClaimMessage, handleReleaseMessage, telegramLinkMessage } from "../src/lib/claims";
import { checkPin, nameKey, parseNameInput, pinName, pinWarning, type Pin } from "../src/lib/namePins";
import { handle } from "../worker/src/index";
import { MemKV, NOW, call, env, tgAuth, wallet } from "./svc";

type W = ReturnType<typeof wallet>;
const claim = (e: any, w: W, name: string, t = NOW) => call(e, "POST", "/handles", { handle: name, owner: w.pk, issued: t, sig: w.sign(handleClaimMessage(name, w.pk, t)) });
const release = (e: any, w: W, t: number) => call(e, "DELETE", "/handles", { owner: w.pk, issued: t, sig: w.sign(handleReleaseMessage(w.pk, t)) });

describe("separate namespaces", () => {
  it("@sam is only a handle, tg:@sam only a Telegram username", () => {
    expect(parseNameInput("@Sam")).toEqual({ via: "handle", name: "sam" });
    expect(parseNameInput("tg:@Sam")).toEqual({ via: "telegram", name: "sam" });
    expect(parseNameInput("TG:sam")).toEqual({ via: "telegram", name: "sam" });
    expect(parseNameInput("sam")).toBeNull();
    expect(parseNameInput("@")).toBeNull();
    expect(nameKey("handle", "sam")).not.toBe(nameKey("telegram", "sam"));
  });
  it("a handle @sam held by one wallet and Telegram sam linked to another don't shadow each other", async () => {
    const e = env();
    const a = wallet();
    const b = wallet();
    expect((await claim(e, a, "samuel")).status).toBe(200);
    const tg = tgAuth({ id: 5, username: "samuel", auth_date: NOW });
    expect((await call(e, "POST", "/telegram", { owner: b.pk, issued: NOW, sig: b.sign(telegramLinkMessage(b.pk, 5, "samuel", NOW)), tg, findable: true })).status).toBe(200);
    expect((await call(e, "GET", "/handles/samuel")).body.owner).toBe(a.pk);
    expect((await call(e, "GET", "/telegram/samuel")).body.owner).toBe(b.pk);
  });
});

describe("released names are held for 60 days", () => {
  it("after release, another wallet can't take it for 60 days; the previous owner can", async () => {
    const e = env();
    const a = wallet();
    const b = wallet();
    await claim(e, a, "keeper");
    expect((await release(e, a, NOW + 1)).status).toBe(200);
    expect((await claim(e, b, "keeper", NOW + 2)).status).toBe(409);
    expect((e.KV as MemKV).ttl.get("hr:keeper")).toBe(60 * 86400);
    const later = await handle(
      new Request("https://svc.test/handles", { method: "POST", body: JSON.stringify({ handle: "keeper", owner: b.pk, issued: NOW + 61 * 86400, sig: b.sign(handleClaimMessage("keeper", b.pk, NOW + 61 * 86400)) }) }),
      e,
      NOW + 61 * 86400,
    );
    expect(later.status).toBe(200);
  });
  it("renaming away holds the old name too; its owner can take it back", async () => {
    const e = env();
    const a = wallet();
    const b = wallet();
    await claim(e, a, "oldname");
    await claim(e, a, "newname", NOW + 1);
    expect((await claim(e, b, "oldname", NOW + 2)).status).toBe(409);
    expect((await claim(e, a, "oldname", NOW + 3)).status).toBe(200);
  });
});

describe("per-owner lastIssued", () => {
  it("replaying the same signed claim is refused", async () => {
    const e = env();
    const a = wallet();
    const body = { handle: "replayme", owner: a.pk, issued: NOW, sig: a.sign(handleClaimMessage("replayme", a.pk, NOW)) };
    expect((await call(e, "POST", "/handles", body)).status).toBe(200);
    expect((await call(e, "POST", "/handles", body)).status).toBe(409);
  });
  it("rename-revert replay: re-posting an older, still-fresh claim can't move the name back", async () => {
    const e = env();
    const a = wallet();
    const first = { handle: "first_name", owner: a.pk, issued: NOW, sig: a.sign(handleClaimMessage("first_name", a.pk, NOW)) };
    await call(e, "POST", "/handles", first);
    await claim(e, a, "second_name", NOW + 5);
    expect((await call(e, "POST", "/handles", first)).status).toBe(409);
    expect((await call(e, "GET", `/owners/${a.pk}`)).body.handle.handle).toBe("second_name");
  });
  it("a stale release can't undo a newer claim", async () => {
    const e = env();
    const a = wallet();
    const oldRelease = { owner: a.pk, issued: NOW, sig: a.sign(handleReleaseMessage(a.pk, NOW)) };
    await claim(e, a, "stays_put", NOW + 1);
    expect((await call(e, "DELETE", "/handles", oldRelease)).status).toBe(409);
    expect((await call(e, "GET", "/handles/stays_put")).status).toBe(200);
  });
});

describe("pin on first use", () => {
  const A = "A".repeat(43);
  const B = "B".repeat(43);
  it("new → same → changed; an older claim than pinned is stale", () => {
    const pins: Record<string, Pin> = {};
    expect(checkPin(pins, "@sam", A, 100)).toBe("new");
    pinName(pins, "@sam", A, 100, NOW);
    expect(checkPin(pins, "@sam", A, 100)).toBe("same");
    expect(checkPin(pins, "@sam", A, 150)).toBe("same");
    expect(checkPin(pins, "@sam", A, 50)).toBe("stale");
    expect(checkPin(pins, "@sam", B, 200)).toBe("changed");
    expect(checkPin(pins, "tg:sam", B)).toBe("new"); // separate namespace
  });
  it("pins keep the newest claim time and move only when re-pinned", () => {
    const pins: Record<string, Pin> = {};
    pinName(pins, "@sam", A, 100, NOW);
    pinName(pins, "@sam", A, 90, NOW);
    expect(pins["@sam"].issued).toBe(100);
    pinName(pins, "@sam", B, 200, NOW);
    expect(pins["@sam"]).toMatchObject({ owner: B, issued: 200 });
  });
  it("warnings are loud and specific", () => {
    expect(pinWarning("changed", "@sam", A, B)).toMatch(/DIFFERENT wallet .*was AAAA…AAAA, now BBBB…BBBB/);
    expect(pinWarning("stale", "@sam", A, A)).toMatch(/older claim/);
    expect(pinWarning("same", "@sam", A, A)).toBeNull();
    expect(pinWarning("new", "@sam", undefined, A)).toBeNull();
  });
});

describe("v0.5 #3: PayCode → /u/<handle> → Pay round trip", () => {
  it("the share link resolves, and Pay receives the NAME so the pin check runs", async () => {
    const { vi } = await import("vitest");
    const { profilePath, nameFromProfilePath, payHrefForName, contactHrefForName } = await import("../src/lib/profileLinks");
    const s = await import("../src/lib/service");
    const alice = wallet();
    const mallory = wallet();
    let owner = alice;
    s.setServiceUrlForTesting("https://svc.example");
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/handles/sam_92") return new Response(JSON.stringify({ handle: "sam_92", owner: owner.pk, issued: NOW, sig: owner.sign(handleClaimMessage("sam_92", owner.pk, NOW)) }));
      if (path.startsWith("/owners/")) return new Response(JSON.stringify({ handle: null, telegram: null }));
      return new Response("{}", { status: 404 });
    });
    try {
      // PayCode builds the link; the router hands UserPage the segment after /u/.
      const link = profilePath("@Sam_92");
      expect(link).toBe("/u/sam_92");
      const segment = link.split("/")[2];
      // Before v0.5 UserPage passed the bare segment, which never resolves:
      expect(await s.resolveName(segment)).toBeNull();
      const r = await s.resolveName(nameFromProfilePath(segment));
      expect(r).toMatchObject({ owner: alice.pk, via: "handle", name: "sam_92" });
      // Pay button → Pay's "to" is the name, not the address.
      const to = new URLSearchParams(payHrefForName(`@${r!.name}`).split("?")[1]).get("to")!;
      expect(to).toBe("@sam_92");
      expect(parseNameInput(to)).toEqual({ via: "handle", name: "sam_92" });
      expect(new URLSearchParams(contactHrefForName("@sam_92").split("?")[1]).get("address")).toBe("@sam_92");
      // Pay resolves it and runs the pin check: first use pins, a later swap is "changed".
      const pins: Record<string, Pin> = {};
      const first = (await s.resolveName(to))!;
      expect(checkPin(pins, nameKey(first.via, first.name), first.owner, first.issued)).toBe("new");
      pinName(pins, nameKey(first.via, first.name), first.owner, first.issued, NOW);
      owner = mallory;
      const later = (await s.resolveName(to))!;
      expect(checkPin(pins, nameKey(later.via, later.name), later.owner, later.issued)).toBe("changed");
    } finally {
      vi.unstubAllGlobals();
      s.setServiceUrlForTesting(undefined);
    }
  });
  it("UserPage and PayCode use these helpers", async () => {
    const { readFileSync } = await import("node:fs");
    const up = readFileSync(new URL("../src/screens/UserPage.tsx", import.meta.url), "utf8");
    expect(up).toContain("resolveName(nameFromProfilePath(name))");
    expect(up).toContain("go(payHrefForName(");
    expect(up).not.toMatch(/\/pay\?to=\$\{u\.owner\}/);
    expect(readFileSync(new URL("../src/screens/PayCode.tsx", import.meta.url), "utf8")).toContain("appUrl(profilePath(handle))");
  });
});
