/**
 * Guards — one Durable Object for the three checks that must be atomic
 * (v0.5 #5). KV is eventually consistent, so get-then-put on KV let two
 * requests both pass. A Durable Object processes one request at a time per
 * instance, so each operation below is a true check-and-set:
 *
 *   tgu:<hash>        Telegram login used once           useOnce
 *   li:<wallet>       last accepted signed `issued`       bumpIssued
 *   f:a:<wallet>      faucet cooldown per wallet          claimAll / releaseAll
 *   f:i:<ip>          faucet cooldown per IP              claimAll / releaseAll
 *
 * Records carry their own expiry; reads ignore expired ones and an alarm
 * deletes them (so retention matches DATA-AND-RETENTION.md). Everything else
 * stays in KV.
 */

export interface GuardStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm?(at: number): Promise<void>;
  getAlarm?(): Promise<number | null>;
}

interface Rec {
  v: string;
  exp: number; // unix seconds
}

export type GuardOp =
  | { op: "useOnce"; key: string; ttl: number; now: number }
  | { op: "bumpIssued"; owner: string; issued: number; ttl: number; now: number }
  | { op: "claimAll"; keys: string[]; value: string; ttl: number; now: number }
  | { op: "releaseAll"; keys: string[]; value: string; now: number };

export const GUARD_PREFIXES = ["tgu:", "li:", "f:a:", "f:i:"] as const;

/** The logic, independent of the Durable Object runtime (tested directly). */
export class GuardsCore {
  constructor(private s: GuardStorage) {}

  private async live(key: string, now: number): Promise<Rec | undefined> {
    const r = await this.s.get<Rec>(key);
    return r && r.exp > now ? r : undefined;
  }
  private async put(key: string, v: string, ttl: number, now: number) {
    if (!GUARD_PREFIXES.some((p) => key.startsWith(p))) throw new Error("unknown guard key");
    await this.s.put<Rec>(key, { v, exp: now + ttl });
    if (this.s.setAlarm && this.s.getAlarm && (await this.s.getAlarm()) == null) await this.s.setAlarm((now + 3600) * 1000);
  }

  async run(o: GuardOp): Promise<boolean> {
    switch (o.op) {
      case "useOnce": {
        if (await this.live(o.key, o.now)) return false;
        await this.put(o.key, "1", o.ttl, o.now);
        return true;
      }
      case "bumpIssued": {
        const key = `li:${o.owner}`;
        const last = Number((await this.live(key, o.now))?.v ?? "0");
        if (!(o.issued > last)) return false;
        await this.put(key, String(o.issued), o.ttl, o.now);
        return true;
      }
      case "claimAll": {
        for (const k of o.keys) if (await this.live(k, o.now)) return false;
        for (const k of o.keys) await this.put(k, o.value, o.ttl, o.now);
        return true;
      }
      case "releaseAll": {
        for (const k of o.keys) if ((await this.live(k, o.now))?.v === o.value) await this.s.delete(k);
        return true;
      }
    }
  }

  /** Delete expired records (the Durable Object alarm). */
  async sweep(now: number): Promise<number> {
    let n = 0;
    for (const [k, r] of await this.s.list<Rec>()) {
      if (r.exp <= now) {
        await this.s.delete(k);
        n++;
      }
    }
    return n;
  }
}

/** The Durable Object class (binding GUARDS in wrangler.toml). */
export class Guards {
  private core: GuardsCore;
  constructor(private state: { storage: GuardStorage }) {
    this.core = new GuardsCore(state.storage);
  }
  async fetch(req: Request): Promise<Response> {
    const op = (await req.json()) as GuardOp;
    return new Response(JSON.stringify({ ok: await this.core.run(op) }), { headers: { "content-type": "application/json" } });
  }
  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.core.sweep(now);
    if ((await this.state.storage.list({})).size > 0 && this.state.storage.setAlarm) await this.state.storage.setAlarm((now + 3600) * 1000);
  }
}

export interface GuardsNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

/** Client used by the Worker: one global instance, so every check is serialized. */
export function guards(ns: GuardsNamespace | undefined) {
  if (!ns) throw new Error("GUARDS Durable Object binding missing");
  const stub = ns.get(ns.idFromName("global"));
  const call = async (o: GuardOp) => {
    const r = await stub.fetch(new Request("https://guards/op", { method: "POST", body: JSON.stringify(o) }));
    if (!r.ok) throw new Error("guards unavailable");
    return ((await r.json()) as { ok: boolean }).ok;
  };
  return {
    useOnce: (key: string, ttl: number, now: number) => call({ op: "useOnce", key, ttl, now }),
    bumpIssued: (owner: string, issued: number, ttl: number, now: number) => call({ op: "bumpIssued", owner, issued, ttl, now }),
    claimAll: (keys: string[], value: string, ttl: number, now: number) => call({ op: "claimAll", keys, value, ttl, now }),
    releaseAll: (keys: string[], value: string, now: number) => call({ op: "releaseAll", keys, value, now }),
  };
}
