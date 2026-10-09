import { createContext, useCallback, useContext, useEffect, useMemo, useId, useRef, useState, type ReactNode } from "react";
import { Drawer } from "vaul";
import { back } from "../lib/router";
import { haptic } from "../lib/haptics";

// ------------------------------------------------------------------ icons

export const Icon = {
  activity: (
    <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8.5h18M5 14h18M5 19.5h11" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="14" cy="10" r="4.5" />
      <path d="M5.5 23c1.2-4.4 4.6-6.5 8.5-6.5s7.3 2.1 8.5 6.5" />
    </svg>
  ),
  messages: (
    <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 7.5A2.5 2.5 0 0 1 7.5 5h13A2.5 2.5 0 0 1 23 7.5v9a2.5 2.5 0 0 1-2.5 2.5H12l-5 4v-4H7.5A2.5 2.5 0 0 1 5 16.5v-9z" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 28 28" fill="currentColor">
      <circle cx="7" cy="14" r="2" />
      <circle cx="14" cy="14" r="2" />
      <circle cx="21" cy="14" r="2" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="14" cy="14" r="3.5" />
      <path d="M14 3.5v3M14 21.5v3M3.5 14h3M21.5 14h3M6.6 6.6l2.1 2.1M19.3 19.3l2.1 2.1M6.6 21.4l2.1-2.1M19.3 8.7l2.1-2.1" />
    </svg>
  ),
  compose: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  ),
  back: (
    <svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2L2 10l8 8" />
    </svg>
  ),
  chev: (
    <svg className="chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 1l6 6-6 6" />
    </svg>
  ),
  qr: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
    </svg>
  ),
  plus: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  scan: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
    </svg>
  ),
  pay: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
  request: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  ),
  refresh: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
    </svg>
  ),
  doc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 3h7l5 5v13H7z M14 3v5h5 M9.5 13h5M9.5 17h5" />
    </svg>
  ),
  box: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8l9-4 9 4v9l-9 4-9-4z M3 8l9 4 9-4 M12 12v9" />
    </svg>
  ),
  work: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12h18" />
    </svg>
  ),
  bookmark: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  ),
  car: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 16l1.5-5a2 2 0 0 1 2-1.5h7a2 2 0 0 1 2 1.5L19 16M4 16h16v3H4z" /><circle cx="7.5" cy="19" r="1.5" /><circle cx="16.5" cy="19" r="1.5" />
    </svg>
  ),
  ship: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 17l2 3h14l2-3M4 17l1-5h14l1 5M8 12V8h8v4M12 5v3" />
    </svg>
  ),
  people: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="9" cy="9" r="3.5" /><circle cx="17" cy="10" r="2.5" /><path d="M3 20c.8-3.5 3.3-5.5 6-5.5s5.2 2 6 5.5M14.5 20c.4-2 1.5-3.5 3-4" />
    </svg>
  ),
};

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
/** Mode icons (SVG, not emoji: consistent across platforms, inherit colour). */
export const ModeIcon = {
  protected: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  instant: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M13 2L5 14h6l-1 8 9-13h-6l0-7z" />
    </svg>
  ),
  custom: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M12 3l9 9-9 9-9-9 9-9z" />
    </svg>
  ),
} as const;
/** Kept for callers that used the emoji map: same keys, now icons. */
export const MODE_GLYPH = ModeIcon;

// ------------------------------------------------------------------ shell

export function NavBar(props: { title?: string; backTo?: string | false; left?: ReactNode; right?: ReactNode }) {
  return (
    <header className="navbar">
      <div className="side">
        {props.left ??
          (props.backTo !== false && props.backTo !== undefined ? (
            <button className="navbtn" onClick={() => back(props.backTo as string)} aria-label="Back">
              {Icon.back}
              <span>Back</span>
            </button>
          ) : null)}
      </div>
      <div className="title">{props.title}</div>
      <div className="side right">{props.right}</div>
    </header>
  );
}

export function LargeTitle({ children }: { children: ReactNode }) {
  return <h1 className="largetitle">{children}</h1>;
}

export function Section(props: { header?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${props.className ?? ""}`}>
      {props.header && <div className="section-header">{props.header}</div>}
      <div className="section-body">{props.children}</div>
      {props.footer && <div className="section-footer">{props.footer}</div>}
    </section>
  );
}

export function Cell(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  before?: ReactNode;
  after?: ReactNode;
  value?: ReactNode;
  onClick?: () => void;
  href?: string;
  chevron?: boolean;
  danger?: boolean;
  link?: boolean;
  wrap?: boolean;
  avatar?: boolean;
}) {
  const cls = `cell${props.danger ? " danger" : ""}${props.link ? " link" : ""}${props.avatar ? " has-avatar" : ""}`;
  const inner = (
    <>
      {props.before}
      <div className="body">
        <div className={`t${props.wrap ? " wrap" : ""}`}>{props.title}</div>
        {props.subtitle && <div className={`s${props.wrap ? " wrap" : ""}`}>{props.subtitle}</div>}
      </div>
      {props.value != null && <div className="value">{props.value}</div>}
      {props.after}
      {props.chevron && Icon.chev}
    </>
  );
  if (props.href)
    return (
      <a className={cls} href={props.href} target={props.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
        {inner}
      </a>
    );
  if (props.onClick)
    return (
      <button className={cls} onClick={props.onClick}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

export function KV(props: { k: ReactNode; v: ReactNode; onChange?: () => void }) {
  return (
    <div className="cell kv">
      <div className="k">{props.k}</div>
      <div className="v">{props.v}</div>
      {props.onChange && (
        <button className="change" onClick={props.onChange}>
          Change
        </button>
      )}
    </div>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void | Promise<void>;
  kind?: "primary" | "secondary" | "plain" | "danger";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={`btn ${props.kind && props.kind !== "primary" ? props.kind : ""}`}
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
    >
      {props.busy && <span className="spinner" aria-hidden />}
      {props.children}
    </button>
  );
}

// ---------------------------------------------------------------- avatars

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic identicon (5×5 mirrored grid) from the full address. */
export function Identicon({ address, size = 42 }: { address: string; size?: number }) {
  const h = hashStr(address);
  const h2 = hashStr(address.split("").reverse().join(""));
  const hue = h % 360;
  const cells: ReactNode[] = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      const bit = ((x < 2 ? h2 : h) >> (y * 3 + x)) & 1;
      if (!bit) continue;
      for (const xx of x === 2 ? [2] : [x, 4 - x]) cells.push(<rect key={`${xx}-${y}`} x={xx * 6 + 3} y={y * 6 + 3} width="6" height="6" fill="#fff" fillOpacity="0.9" />);
    }
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden>
      <rect width="36" height="36" fill={`hsl(${hue} 55% 52%)`} />
      {cells}
    </svg>
  );
}

export function Avatar(props: { address: string; name?: string; mode?: "protected" | "instant" | "custom" }) {
  const named = props.name && !props.name.includes("…");
  const hue = hashStr(props.address) % 360;
  return (
    <div className="avatar" style={named ? { background: `linear-gradient(180deg, hsl(${hue} 70% 62%), hsl(${hue} 65% 50%))` } : undefined}>
      {named ? props.name!.trim().slice(0, 1).toUpperCase() : <Identicon address={props.address} />}
      {props.mode && <span className={`glyph ${props.mode}`}>{MODE_GLYPH[props.mode]}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ sheet

export function Sheet(props: { open: boolean; onClose: () => void; title?: string; children: ReactNode; dismissible?: boolean }) {
  return (
    <Drawer.Root open={props.open} onOpenChange={(o) => !o && props.onClose()} dismissible={props.dismissible ?? true}>
      <Drawer.Portal>
        <Drawer.Overlay className="sheet-overlay" />
        <Drawer.Content className="sheet" aria-describedby={undefined}>
          <div className="grab" />
          <Drawer.Title className="sheet-title">
            {props.title ?? ""}
            {(props.dismissible ?? true) && (
              <button className="navbtn sheet-close" onClick={props.onClose}>
                Done
              </button>
            )}
          </Drawer.Title>
          <div className="sheet-body">{props.children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

// ------------------------------------------------------------------ toast

const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<number>();
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------ dial control

export type DialMode = "instant" | "protected" | "custom";

/**
 * The protection dial: a W3C APG radiogroup with Telegram-style segmented
 * visuals (R8 C10 — TelegramUI's SegmentedControl uses tab semantics, so we
 * own this control). Arrow keys move and select; downgrade friction fires at
 * Review, never here.
 */
const DIAL_OPTIONS: { id: DialMode; label: ReactNode }[] = [
  { id: "instant", label: <>{ModeIcon.instant}Instant</> },
  { id: "protected", label: <>{ModeIcon.protected}Protected</> },
  { id: "custom", label: <>{ModeIcon.custom}Custom</> },
];

/**
 * A radiogroup of segment buttons: roving tabindex + arrow keys, label tied by
 * a per-instance id. The payment dial by default; pass `options` for others.
 */
export function Dial<T extends string = DialMode>(props: {
  value: T;
  onChange: (m: T) => void;
  instantLocked?: boolean;
  label?: string;
  options?: { id: T; label: ReactNode }[];
  style?: React.CSSProperties;
}) {
  const opts = props.options ?? (DIAL_OPTIONS as unknown as { id: T; label: ReactNode }[]);
  const labelId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const isLocked = (m: T) => m === "instant" && !!props.instantLocked;
  const enabled = opts.filter((o) => !isLocked(o.id));
  const pick = (m: T) => {
    if (isLocked(m)) return;
    if (m !== props.value) haptic("selection");
    props.onChange(m);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const idx = enabled.findIndex((o) => o.id === props.value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % enabled.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + enabled.length) % enabled.length;
    if (next >= 0) {
      e.preventDefault();
      const m = enabled[next].id;
      pick(m);
      refs.current[opts.findIndex((o) => o.id === m)]?.focus();
    }
  };
  return (
    <>
      <div className="dial-label" id={labelId}>
        {props.label ?? "How should this payment work?"}
      </div>
      <div className="dial" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKey} style={props.style}>
        {opts.map((o, i) => {
          const checked = props.value === o.id;
          const locked = isLocked(o.id);
          return (
            <button
              key={o.id}
              ref={(el) => (refs.current[i] = el)}
              role="radio"
              aria-checked={checked}
              aria-disabled={locked || undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => pick(o.id)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ------------------------------------------------------------ v0.10 primitives

/** Sticky stack of primary actions above the tab bar on phones. */
export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="actionbar no-print">{children}</div>;
}

/** Status pill: kind maps to the .pill modifiers in app.css. */
export function StatusPill({ kind, children }: { kind: "move" | "paused" | "done" | "ended" | "warn" | "sim" | "plain"; children: ReactNode }) {
  return <span className={`pill${kind === "plain" ? "" : ` ${kind}`}`}>{children}</span>;
}

/** n thin bars: done, current, upcoming. */
export function ProgressStrip({ step, total, label }: { step: number; total: number; label?: string }) {
  return (
    <div className="progress-strip" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step + 1} aria-label={label ?? `Step ${step + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < step ? "done" : i === step ? "now" : ""} />
      ))}
    </div>
  );
}

/** A section whose body is hidden until tapped; state-driven so the body is real content when open. */
export function Accordion(props: { title: ReactNode; summary?: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; children: ReactNode; className?: string }) {
  const [own, setOwn] = useState(props.open ?? false);
  const open = props.onToggle ? !!props.open : own;
  const toggle = () => (props.onToggle ? props.onToggle(!open) : setOwn(!own));
  return (
    <div className={`section accordion ${props.className ?? ""}`} data-open={open}>
      <button type="button" aria-expanded={open} onClick={toggle}>
        <span>
          <span style={{ display: "block" }}>{props.title}</span>
          {!open && props.summary && <span className="caption">{props.summary}</span>}
        </span>
        {Icon.chev}
      </button>
      {open && <div className="section-body">{props.children}</div>}
    </div>
  );
}

// --------------------------------------------------------------- helpers

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn()
      .then((v) => live && (setData(v), setError(null)))
      .catch((e) => live && setError(String(e?.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return useMemo(() => ({ data, error, loading, reload: () => setN((x) => x + 1) }), [data, error, loading]);
}

export function copyText(text: string, toast: (m: string) => void, label = "Copied") {
  navigator.clipboard?.writeText(text).then(() => toast(label), () => toast("Couldn't copy"));
}

export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
