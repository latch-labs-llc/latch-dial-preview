/** v0.5 #14: the smoke script finds a browser off-sandbox and never hangs. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper module
import { chromiumPath, withCleanup } from "../scripts/smoke-lib.mjs";

describe("chromium resolution", () => {
  it("$CHROMIUM wins; else the sandbox path if present; else Playwright's own (undefined)", () => {
    expect(chromiumPath({ CHROMIUM: "/x/chrome" }, () => true)).toBe("/x/chrome");
    expect(chromiumPath({}, () => true)).toBe("/opt/pw-browsers/chromium");
    expect(chromiumPath({}, () => false)).toBeUndefined(); // e.g. a Mac without the sandbox path
  });
});

describe("cleanup always runs", () => {
  const noSignals = { onSignal: () => {} };
  it("on error", async () => {
    let cleaned = 0;
    await expect(withCleanup(() => void cleaned++, async () => { throw new Error("launch failed"); }, noSignals)).rejects.toThrow("launch failed");
    expect(cleaned).toBe(1);
  });
  it("on a hang (global timeout)", async () => {
    let cleaned = 0;
    await expect(withCleanup(() => void cleaned++, () => new Promise(() => {}), { ...noSignals, timeoutMs: 50 })).rejects.toThrow(/timed out/);
    expect(cleaned).toBe(1);
  });
  it("on success", async () => {
    let cleaned = 0;
    expect(await withCleanup(() => void cleaned++, async () => 7, noSignals)).toBe(7);
    expect(cleaned).toBe(1);
  });
});

describe("end to end: a browser that can't launch", () => {
  it.skipIf(!existsSync(new URL("../dist/index.html", import.meta.url)))(
    "exits non-zero promptly and leaves no preview server behind",
    async () => {
      const port = 4193;
      const started = Date.now();
      const r = await new Promise<{ code: number | null; out: string }>((res) => {
        execFile("node", ["scripts/smoke.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, CHROMIUM: "/nonexistent/chromium", SMOKE_PORT: String(port) }, timeout: 90_000 }, (err, stdout, stderr) =>
          res({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr }),
        );
      });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/SMOKE FAILED[\s\S]*smoke aborted/);
      expect(Date.now() - started).toBeLessThan(60_000);
      await new Promise((x) => setTimeout(x, 500));
      await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow(); // nothing listening any more
    },
    100_000,
  );
});
