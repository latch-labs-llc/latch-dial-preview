/**
 * Inbox — one Durable Object per wallet holding that wallet's messages (sent
 * and received), strongly consistent, with live notification (v0.17).
 *
 * KV is eventually consistent: a record written at one edge could take up to
 * a minute to appear at another, which the two-wallet E2E measured as a
 * delivery lag. A Durable Object has one home and one order of events, so a
 * recipient's read right after a send sees it. Each wallet's Inbox keeps its
 * own copy of every message (`msg:<at>:<id>` → record); the sender's copy and
 * the recipient's copy are the same bytes. Open WebSockets on an Inbox get a
 * one-word nudge ("new") when a record lands, and the app then fetches as it
 * always did; the sockets carry no content.
 *
 * Records carry their own expiry (90 days) and an alarm deletes them.
 */
import type { GuardStorage } from "./guards";

export interface InboxRecord {
  thread: string;
  from: string;
  to: string;
  seq: number;
  ct: string;
  at: number;
  issued: number;
  sig: string;
}
interface Stored {
  r: InboxRecord;
  exp: number;
}

export const INBOX_PREFIXES = ["msg:"] as const;
const atKey = (unix: number) => String(unix).padStart(10, "0");
export const recordKey = (r: InboxRecord, id: string) => `msg:${atKey(r.at)}:${id}`;

export type RemoveTarget = "all" | { thread: string } | { ids: string[] };
export type InboxOp =
  | { op: "append"; id: string; rec: InboxRecord; ttl: number; now: number }
  | { op: "list"; since: number; limit: number; now: number }
  | { op: "remove"; target: RemoveTarget; owner: string; now: number };

export interface ListResult {
  messages: InboxRecord[];
  more: boolean;
}
export interface RemoveResult {
  deleted: number;
  /** Records the owner SENT that were removed: the other party's copies to drop too. */
  sent: { to: string; id: string }[];
}

/** The logic, independent of the runtime (tested directly). */
export class InboxCore {
  constructor(private s: GuardStorage) {}

  private async live(now: number): Promise<[string, Stored][]> {
    const out: [string, Stored][] = [];
    for (const [k, v] of await this.s.list<Stored>({ prefix: "msg:" })) if (v.exp > now) out.push([k, v]);
    return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async append(id: string, rec: InboxRecord, ttl: number, now: number): Promise<boolean> {
    const key = recordKey(rec, id);
    if (await this.s.get<Stored>(key)) return false;
    await this.s.put<Stored>(key, { r: rec, exp: now + ttl });
    if (this.s.setAlarm && this.s.getAlarm && (await this.s.getAlarm()) == null) await this.s.setAlarm((now + 3600) * 1000);
    return true;
  }

  async list(since: number, limit: number, now: number): Promise<ListResult> {
    const rows = (await this.live(now)).filter(([, v]) => v.r.at >= since);
    return { messages: rows.slice(0, limit).map(([, v]) => v.r), more: rows.length > limit };
  }

  async remove(target: RemoveTarget, owner: string, now: number): Promise<RemoveResult> {
    const out: RemoveResult = { deleted: 0, sent: [] };
    for (const [k, v] of await this.live(now)) {
      const id = k.slice(k.lastIndexOf(":") + 1);
      const hit = target === "all" || ("thread" in target && v.r.thread === target.thread) || ("ids" in target && target.ids.includes(id));
      if (!hit) continue;
      await this.s.delete(k);
      out.deleted++;
      if (v.r.from === owner) out.sent.push({ to: v.r.to, id });
    }
    return out;
  }

  /** Delete expired records (the Durable Object alarm). */
  async sweep(now: number): Promise<number> {
    let n = 0;
    for (const [k, v] of await this.s.list<Stored>({ prefix: "msg:" })) {
      if (v.exp <= now) {
        await this.s.delete(k);
        n++;
      }
    }
    return n;
  }

  async run(o: InboxOp): Promise<unknown> {
    switch (o.op) {
      case "append":
        return { ok: await this.append(o.id, o.rec, o.ttl, o.now) };
      case "list":
        return this.list(o.since, o.limit, o.now);
      case "remove":
        return this.remove(o.target, o.owner, o.now);
    }
  }
}

/** The Durable Object class (binding INBOX in wrangler.toml), with hibernating WebSockets. */
export class Inbox {
  private core: InboxCore;
  constructor(private state: { storage: GuardStorage; acceptWebSocket?(ws: WebSocket): void; getWebSockets?(): WebSocket[] }) {
    this.core = new InboxCore(state.storage);
  }
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") === "websocket" && this.state.acceptWebSocket) {
      const pair = new (globalThis as any).WebSocketPair();
      const [client, server] = [pair[0], pair[1]] as [WebSocket, WebSocket];
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client } as any);
    }
    const op = (await req.json()) as InboxOp;
    const result = await this.core.run(op);
    if (op.op === "append" && (result as { ok: boolean }).ok) this.nudge();
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }
  /** Tell every open socket something arrived; they fetch over HTTP as usual. */
  private nudge() {
    for (const ws of this.state.getWebSockets?.() ?? []) {
      try {
        ws.send("new");
      } catch {
        /* closing */
      }
    }
  }
  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (msg === "ping") ws.send("pong");
  }
  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.core.sweep(now);
    if ((await this.state.storage.list({ prefix: "msg:" })).size > 0 && this.state.storage.setAlarm) await this.state.storage.setAlarm((now + 3600) * 1000);
  }
}

export interface InboxNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

/** Client used by the Worker: one instance per wallet. */
export function inbox(ns: InboxNamespace | undefined, wallet: string) {
  if (!ns) throw new Error("INBOX Durable Object binding missing");
  const stub = ns.get(ns.idFromName(wallet));
  const call = async <T>(o: InboxOp): Promise<T> => {
    const r = await stub.fetch(new Request("https://inbox/op", { method: "POST", body: JSON.stringify(o) }));
    if (!r.ok) throw new Error("inbox unavailable");
    return (await r.json()) as T;
  };
  return {
    append: (id: string, rec: InboxRecord, ttl: number, now: number) => call<{ ok: boolean }>({ op: "append", id, rec, ttl, now }),
    list: (since: number, limit: number, now: number) => call<ListResult>({ op: "list", since, limit, now }),
    remove: (target: RemoveTarget, owner: string, now: number) => call<RemoveResult>({ op: "remove", target, owner, now }),
    /** Hand a browser's upgrade request to the wallet's Inbox. */
    socket: (req: Request) => stub.fetch(req),
  };
}
