/**
 * Telegram Login Widget, sandboxed (v0.4 B8). The widget page is served by
 * the optional service (its own origin, its own strict CSP); the app embeds
 * it in a sandboxed iframe and accepts exactly one message shape from
 * exactly that origin. Telegram's script never runs in the app's origin.
 */
import type { TelegramAuth } from "./claims";

/** The widget lives on its own origin (not the API's), at "/". */
export function widgetUrl(widgetOrigin: string, appOrigin: string): string {
  return `${new URL(widgetOrigin).origin}/?origin=${encodeURIComponent(appOrigin)}`;
}

const FIELDS = new Set(["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]);

/** The login carried by a widget message, or null if it isn't one from the widget origin. */
export function acceptWidgetMessage(ev: Pick<MessageEvent, "origin" | "data">, widgetOrigin: string): TelegramAuth | null {
  if (ev.origin !== new URL(widgetOrigin).origin) return null;
  const d = ev.data as { type?: unknown; user?: unknown } | null;
  if (!d || d.type !== "latch-telegram-auth" || !d.user || typeof d.user !== "object") return null;
  const u = d.user as Record<string, unknown>;
  if (Object.keys(u).some((k) => !FIELDS.has(k))) return null;
  if (typeof u.id !== "number" || typeof u.auth_date !== "number" || typeof u.hash !== "string") return null;
  return u as unknown as TelegramAuth;
}
