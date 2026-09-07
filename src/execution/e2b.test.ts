import { describe, expect, it, vi } from "vitest";
import { E2BExecutor } from "./e2b.js";

// Feature: features/execution.md item 11 — per-call bash timeout on the E2B
// path: ExecOptions.timeoutMs (already clamped by the tool layer, re-clamped
// here defensively) is passed to the SDK's commands.run, and the SDK's
// TimeoutError renders as exit 124 naming the limit and the timeoutMs knob.
// The SDK constructor is private and network-bound, so the executor is built
// on its prototype with a stubbed `sbx` — the same seam the class itself uses.

type RunFn = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

function e2bWith(run: RunFn): { ex: E2BExecutor; run: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(run);
  const ex = Object.create(E2BExecutor.prototype) as E2BExecutor;
  (ex as unknown as { sbx: unknown }).sbx = { commands: { run: spy } };
  return { ex, run: spy };
}

const OK = { stdout: "ok", stderr: "", exitCode: 0 };

describe("E2BExecutor per-call timeout", () => {
  it("runs under the 5-min default when no timeoutMs is passed (today's behavior)", async () => {
    const { ex, run } = e2bWith(async () => OK);
    await expect(ex.exec("ls")).resolves.toBe("ok");
    expect(run.mock.calls[0][1]).toMatchObject({ timeoutMs: 5 * 60_000 });
  });

  it("passes a requested timeoutMs through, clamped to the 20-min ceiling", async () => {
    const { ex, run } = e2bWith(async () => OK);
    await ex.exec("npm test", { timeoutMs: 25 * 60_000 });
    expect(run.mock.calls[0][1]).toMatchObject({ timeoutMs: 20 * 60_000 });
  });

  it("renders the SDK's TimeoutError as exit 124 naming the limit and the timeoutMs knob", async () => {
    const { ex } = e2bWith(async () => {
      throw Object.assign(new Error("command timed out"), { name: "TimeoutError" });
    });
    const text = await ex.exec("sleep 9999", { timeoutMs: 60_000 });
    expect(text).toMatch(/^exit 124:/);
    expect(text).toContain("60s command timeout");
    expect(text).toContain("timeoutMs");
    expect(text).toContain("1200000");
  });

  it("a nonzero exit is still surfaced as output, never the timeout wording", async () => {
    const { ex } = e2bWith(async () => {
      throw Object.assign(new Error("exit 2"), { exitCode: 2, stdout: "", stderr: "boom" });
    });
    const text = await ex.exec("false");
    expect(text).toMatch(/^exit 2:/);
    expect(text).not.toContain("command timeout");
  });
});
