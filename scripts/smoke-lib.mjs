// Helpers for scripts/smoke.mjs, kept separate so they're unit-tested.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Which Chromium to launch: $CHROMIUM if set; else the sandbox's
 * /opt/pw-browsers/chromium if it exists; else undefined, which makes
 * Playwright use its own installed browser (npx playwright install chromium).
 */
export function chromiumPath(env = process.env, exists = existsSync) {
  if (env.CHROMIUM) return env.CHROMIUM;
  if (exists("/opt/pw-browsers/chromium")) return "/opt/pw-browsers/chromium";
  return undefined;
}

/** Start `vite preview` in its OWN process group, so stop() also kills the vite child behind npx. */
export function startPreview(port, cwd = process.cwd()) {
  const child = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd, stdio: "inherit", detached: true });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  };
  return { child, stop };
}

export async function waitForHttp(url, { tries = 60, delayMs = 500, fetchFn = fetch } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetchFn(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`server at ${url} did not start`);
}

/**
 * Run `fn` with cleanup that always happens: on success, on error, on
 * SIGINT/SIGTERM, and on a global timeout (so a failed launch can't leave
 * node hanging on a live child process).
 */
export async function withCleanup(cleanup, fn, { timeoutMs = 10 * 60 * 1000, onSignal = (sig, h) => process.once(sig, h) } = {}) {
  let timer;
  const signal = () => {
    cleanup();
    process.exit(130);
  };
  onSignal("SIGINT", signal);
  onSignal("SIGTERM", signal);
  try {
    return await Promise.race([
      fn(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`smoke timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await cleanup();
  }
}
