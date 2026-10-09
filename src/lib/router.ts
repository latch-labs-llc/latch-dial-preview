/**
 * Tiny hash router. Shareable objects keep hash routes (`#/deal/<addr>?k=…`)
 * so links work from any static host and the link blob (in the fragment) is
 * never sent to a server in HTTP requests.
 */
import { useEffect, useState } from "react";

export interface Route {
  path: string[];
  query: URLSearchParams;
}

export function parse(hash = window.location.hash): Route {
  const h = hash.replace(/^#\/?/, "");
  const [p, q] = h.split("?");
  return { path: p.split("/").filter(Boolean), query: new URLSearchParams(q ?? "") };
}

export function useRoute(): Route {
  const [r, setR] = useState(parse());
  useEffect(() => {
    const on = () => {
      setR(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export function go(path: string): void {
  const next = path.startsWith("#") ? path : `#${path}`;
  const doc = document as any;
  if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    doc.startViewTransition(() => (window.location.hash = next));
  } else {
    window.location.hash = next;
  }
}

export function back(fallback = "/"): void {
  if (window.history.length > 1) window.history.back();
  else go(fallback);
}

export function appUrl(hashPath: string): string {
  return `${window.location.origin}${window.location.pathname}#${hashPath}`;
}
