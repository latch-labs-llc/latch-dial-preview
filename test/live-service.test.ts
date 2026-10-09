/**
 * Live check of the deployed identity service (skipped unless LIVE_SERVICE is
 * set to its URL). A throwaway key claims a random @handle through the same
 * client the app uses, resolves it, then releases it; the TEST faucet is only
 * probed for its shape (one grant per address per day, so it is not called).
 *
 *   LIVE_SERVICE=https://latch-dial-service.latchlabs.workers.dev npx vitest run test/live-service.test.ts
 */
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { eraseMessage, messagingKeyClaimMessage, msgPostMessage, msgReadMessage, sha256Hex, toB64 } from "../src/lib/claims";
import { threadId } from "../src/lib/msgCrypto";
import { claimHandle, releaseHandle, resolveName, setServiceUrlForTesting } from "../src/lib/service";
import { msgKeys, msgSized, wallet } from "./svc";

describe.skipIf(!process.env.LIVE_SERVICE)("deployed identity service", () => {
  it("claims, resolves and releases a handle", async () => {
    setServiceUrlForTesting(process.env.LIVE_SERVICE);
    const w = wallet();
    const name = `probe_${Math.random().toString(36).slice(2, 8)}`;
    const claim = await claimHandle(w.pk, name, w.signBytes);
    expect(claim.owner).toBe(w.pk);
    expect(claim.handle).toBe(name);
    const r = await resolveName(`@${name}`);
    expect(r?.owner).toBe(w.pk);
    await releaseHandle(w.pk, w.signBytes);
    expect(await resolveName(`@${name}`)).toBeNull();
  }, 60_000);

  it("two throwaway wallets publish messaging keys, exchange a sealed record, and erase it", async () => {
    // Raw requests to the live Worker (the svc helpers route through handle() instead).
    const base = process.env.LIVE_SERVICE!;
    const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const now = () => Math.floor(Date.now() / 1000);
    const sgn = (sk: Uint8Array, m: string) => toB64(ed25519.sign(new TextEncoder().encode(m), sk));
    const a = wallet();
    const b = wallet();
    const ka = msgKeys(a, "dial.latchlabs.org");
    const kb = msgKeys(b, "dial.latchlabs.org");
    for (const [w, k] of [[a, ka], [b, kb]] as const) {
      const t = now();
      expect((await send("PUT", "/keys", { owner: w.pk, enc: k.encPk, signer: k.signPk, issued: t, sig: w.sign(messagingKeyClaimMessage(w.pk, k.encPk, k.signPk, t)) })).status).toBe(200);
    }
    const ct = msgSized(3);
    const thread = threadId(a.pk, b.pk);
    const t1 = now() + 1;
    const posted = await send("POST", "/msg", { from: a.pk, to: b.pk, thread, seq: 0, ct: toB64(ct), issued: t1, sig: sgn(ka.signSk, msgPostMessage(a.pk, b.pk, thread, 0, sha256Hex(ct), t1)) });
    expect(posted.status).toBe(200);
    const t2 = now() + 2;
    const got = await send("GET", `/msg/${b.pk}?since=0`, undefined, { "x-latch-issued": String(t2), "x-latch-sig": sgn(kb.signSk, msgReadMessage(b.pk, 0, t2)) });
    expect(got.status).toBe(200);
    expect(got.body.messages.map((m: any) => m.from)).toEqual([a.pk]);
    for (const w of [a, b]) {
      const t = now() + 3;
      expect((await send("DELETE", "/me", { owner: w.pk, issued: t, sig: w.sign(eraseMessage(w.pk, t)) })).status).toBe(200);
    }
  }, 60_000);
});
