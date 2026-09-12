import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXEC_KEEPALIVE_INTERVAL_MS,
  SANDBOX_SLEEP_AFTER,
  isRecycleError,
  parseSleepAfterMs,
  recycledMidCommandMessage,
  withActivityKeepalive,
} from "./sandboxKeepalive.js";

// Feature: docs/reference/specs/execution.md item 2 — one in-flight exec never outlives
// the container's activity timeout. The Container base class renews its
// activity clock once per proxied fetch, BEFORE the fetch; a command longer
// than sleepAfter therefore expires the clock at exactly sleepAfter and the
// alarm loop SIGTERMs the container under it. The keepalive renews the clock
// every minute while a command
// runs, which turns sleepAfter into a pure idle timeout.

const ROOT = resolve(import.meta.dirname, "../..");

describe("withActivityKeepalive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("makes zero renew calls for a command that finishes inside one interval", async () => {
    const renew = vi.fn();
    let settle!: (v: string) => void;
    const p = withActivityKeepalive(renew, () => new Promise<string>((r) => (settle = r)), 1_000);
    await vi.advanceTimersByTimeAsync(999);
    settle("done");
    await expect(p).resolves.toBe("done");
    expect(renew).not.toHaveBeenCalled();
  });

  it("renews once per interval while the command is pending", async () => {
    const renew = vi.fn();
    let settle!: (v: number) => void;
    const p = withActivityKeepalive(renew, () => new Promise<number>((r) => (settle = r)), 1_000);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(renew).toHaveBeenCalledTimes(3);
    settle(7);
    await expect(p).resolves.toBe(7);
  });

  it("stops renewing once the command resolves", async () => {
    const renew = vi.fn();
    let settle!: (v: null) => void;
    const p = withActivityKeepalive(renew, () => new Promise<null>((r) => (settle = r)), 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    settle(null);
    await p;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("stops renewing once the command rejects, and the rejection propagates untouched", async () => {
    const renew = vi.fn();
    let fail!: (e: unknown) => void;
    const p = withActivityKeepalive(renew, () => new Promise<never>((_, rej) => (fail = rej)), 1_000);
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_500);
    fail(new Error("Session terminated"));
    await expect(caught).resolves.toEqual(new Error("Session terminated"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("swallows a renew that throws or rejects — the command's own result still comes back", async () => {
    const renew = vi
      .fn<() => void | Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("sync boom");
      })
      .mockImplementationOnce(() => Promise.reject(new Error("async boom")));
    let settle!: (v: string) => void;
    const p = withActivityKeepalive(renew, () => new Promise<string>((r) => (settle = r)), 1_000);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(renew).toHaveBeenCalledTimes(2);
    settle("ok");
    await expect(p).resolves.toBe("ok");
  });
});

describe("keepalive constants", () => {
  it("parseSleepAfterMs reads the Container class's s/m/h grammar and rejects anything else", () => {
    expect(parseSleepAfterMs("5m")).toBe(300_000);
    expect(parseSleepAfterMs("90s")).toBe(90_000);
    expect(parseSleepAfterMs("1h")).toBe(3_600_000);
    expect(() => parseSleepAfterMs("5 minutes")).toThrow(/sleepAfter/);
    expect(() => parseSleepAfterMs("")).toThrow(/sleepAfter/);
  });

  it("the keepalive interval fits inside sleepAfter with room to spare, so a renew always lands before expiry", () => {
    expect(EXEC_KEEPALIVE_INTERVAL_MS).toBe(60_000);
    expect(SANDBOX_SLEEP_AFTER).toBe("5m");
    expect(EXEC_KEEPALIVE_INTERVAL_MS).toBeLessThan(parseSleepAfterMs(SANDBOX_SLEEP_AFTER));
    expect(EXEC_KEEPALIVE_INTERVAL_MS * 2).toBeLessThanOrEqual(parseSleepAfterMs(SANDBOX_SLEEP_AFTER));
  });
});

describe("recycledMidCommandMessage", () => {
  const RECYCLED = /^sandbox recycled mid-command after \d+s — the container was replaced and \/workspace is empty/;

  it("leaves an early failure with any message alone", () => {
    expect(recycledMidCommandMessage(5_000, "Session 'abc' not found")).toBe("Session 'abc' not found");
    expect(recycledMidCommandMessage(5_000, "Command execution failed")).toBe("Command execution failed");
  });

  it("leaves a recycle-shaped failure alone inside the first minute — that is a real startup failure, not a recycle", () => {
    expect(recycledMidCommandMessage(60_000, "Command execution failed")).toBe("Command execution failed");
    expect(recycledMidCommandMessage(60_000, "Session terminated")).toBe("Session terminated");
  });

  it("names the recycle when a recycle-shaped failure arrives after more than a minute", () => {
    const generic = recycledMidCommandMessage(61_000, "Command execution failed");
    expect(generic).toMatch(RECYCLED);
    expect(generic).toContain("after 61s");
    expect(generic).toContain("re-clone before continuing");
    expect(generic).toContain("(Command execution failed)");
    expect(recycledMidCommandMessage(1_200_000, "Session terminated")).toMatch(RECYCLED);
    expect(recycledMidCommandMessage(90_000, "Session 'sandbox-slack:C1:1.0' not found")).toMatch(RECYCLED);
  });

  it("never rewords an unrelated failure on timing alone — a late transport error keeps its own text", () => {
    expect(recycledMidCommandMessage(1_200_000, "fetch failed")).toBe("fetch failed");
    expect(recycledMidCommandMessage(1_200_000, "Failed to create session: 503")).toBe("Failed to create session: 503");
  });

  it("recognizes the 0.12.x recycle texts — a terminated session shell and a container stopped under a pending call", () => {
    expect(recycledMidCommandMessage(90_000, "Session 'sandbox-slack:C1:1.0' shell exited (exit code: 143)")).toMatch(
      RECYCLED,
    );
    expect(recycledMidCommandMessage(90_000, "The sandbox container stopped while the operation was pending.")).toMatch(
      RECYCLED,
    );
  });

  // A sandbox `destroy()`ed under a pending call disconnects it with this
  // text — the container really is gone.
  it("recognizes the destroy-time disconnect text as a recycle", () => {
    expect(recycledMidCommandMessage(90_000, "The sandbox was destroyed while the operation was pending.")).toMatch(
      RECYCLED,
    );
    expect(recycledMidCommandMessage(5_000, "The sandbox was destroyed while the operation was pending.")).toBe(
      "The sandbox was destroyed while the operation was pending.",
    );
  });

  it("a typed recycle error (certain) is named at any elapsed time — the SDK is stating the container stopped", () => {
    const msg = recycledMidCommandMessage(3_000, "Session 'x' shell exited (exit code: 143)", true);
    expect(msg).toMatch(RECYCLED);
    expect(msg).toContain("after 3s");
    // `certain` is the caller's typed evidence, so it rewords whatever text the
    // typed error carried; without it the shape-plus-time gate still holds
    expect(recycledMidCommandMessage(3_000, "fetch failed", false)).toBe("fetch failed");
    expect(recycledMidCommandMessage(3_000, "fetch failed", true)).toMatch(RECYCLED);
  });
});

describe("isRecycleError", () => {
  it("takes the 0.12.x typed errors by NAME (the RPC boundary drops the prototype)", () => {
    expect(isRecycleError({ name: "SessionTerminatedError", message: "whatever the text" })).toBe(true);
    expect(isRecycleError({ name: "OperationInterruptedError", message: "…" })).toBe(true);
  });

  it("falls back to the recycle-shaped texts, and rejects everything else", () => {
    expect(isRecycleError({ name: "Error", message: "Command execution failed" })).toBe(true);
    expect(
      isRecycleError({ name: "Error", message: "The sandbox container stopped while the operation was pending." }),
    ).toBe(true);
    expect(
      isRecycleError({ name: "Error", message: "The sandbox was destroyed while the operation was pending." }),
    ).toBe(true);
    expect(isRecycleError({ name: "ContainerUnavailableError", message: "no Container instance available" })).toBe(
      false,
    );
    expect(isRecycleError({ name: "Error", message: "fetch failed" })).toBe(false);
    expect(isRecycleError({})).toBe(false);
  });
});

describe("sandbox Worker wiring (static)", () => {
  // The Worker cannot run under vitest (Durable Objects + a container), so
  // this mirrors scripts/check-sandbox-pair.mjs: read the source and require
  // the seams to be wired. Drop the keepalive from the Worker and the suite
  // goes red, not a review some months later.
  const worker = readFileSync(resolve(ROOT, "deploy/cloudflare-sandbox/worker.ts"), "utf8");

  it("the Durable Object's sleepAfter is the shared constant and exec runs under the keepalive", () => {
    expect(worker).toMatch(/sleepAfter\s*=\s*SANDBOX_SLEEP_AFTER/);
    expect(worker).toContain("withActivityKeepalive(");
    expect(worker).toContain("this.renewActivityTimeout()");
    expect(worker).toContain("EXEC_KEEPALIVE_INTERVAL_MS");
  });

  // docs/reference/specs/execution.md item 2: every /exec runs under `timeout …
  // bash -c`, whose process group is reaped when the command returns, so a
  // `nohup … &` job dies with the command that started it while a `setsid -f`
  // job outlives it. The hint the model reads on an exit 124 must name the
  // tool that works and never the one that does not.
  it("the timeout hint tells the model to detach a long job with setsid -f, and never names nohup", () => {
    expect(worker).toContain("setsid -f");
    expect(worker).not.toContain("nohup");
  });

  it("the /exec failure path names a mid-command recycle, typed errors first", () => {
    expect(worker).toContain("recycledMidCommandMessage(");
    expect(worker).toContain("isRecycleError(");
    expect(worker).toContain("isFleetBusyError(");
  });

  // The credential rides in the SDK's per-exec `env` option, so it never
  // appears in the command text the SDK logs. The 0.3.x base64 export prefix
  // put the live GH_TOKEN into every "Command executed" log line.
  it("the credential goes through the exec env option, never through the command text", () => {
    expect(worker).toMatch(/env:\s*envVars/);
    expect(worker).not.toContain("base64 -d");
    expect(worker).not.toContain("btoa(");
  });

  // Workers Logs record an invocation's request headers (redacted by a name
  // heuristic only, so a header not named like a token is logged in clear),
  // not its body. The Worker reads the env map from the body alone through ONE
  // helper, and the executor sends it in the body alone — neither source names
  // the header channel.
  it("the Worker reads the env map through envFromRequest and names no x-env header channel", () => {
    expect(worker).toMatch(/const envVars\s*=\s*envFromRequest\(/);
    expect(worker).not.toMatch(/x-env-/i);
  });

  it("the executor sends the env in the body alone — no x-env-* header", () => {
    const executor = readFileSync(resolve(ROOT, "src/execution/cloudflareSandbox.ts"), "utf8");
    expect(executor).toMatch(/const envs\s*=\s*await this\.opts\.resolveEnvs\(\)/);
    expect(executor).toMatch(/env:\s*envs\b/);
    expect(executor).not.toMatch(/x-env-/i);
  });

  // docs/reference/specs/execution.md items 3 and 6: a failure text is never
  // empty, and a container on a previous image is named. Both Worker catches
  // go through `thrownText`; the bare `shape.message ?? String(err)` that
  // kept the SDK's "" is gone.
  it("every failure text goes through thrownText — the empty-string fallthrough is gone", () => {
    expect(worker).toContain("thrownText(");
    expect(worker).not.toContain(".message ?? String(err)");
  });

  it("onStart logs the container/SDK version skew; exec is super.exec under the keepalive, with no retry of its own", () => {
    expect(worker).toContain("getVersion(");
    expect(worker).toMatch(/\(\) => super\.exec\(command, options\)/);
    expect(worker).not.toMatch(/this\.destroy\(/);
  });

  // The rollout window a NEW thread can fall into is closed by replacing the
  // old-image instances in ONE wave: rollout_step_percentage 100, not the
  // platform's default [10, 100] that left minutes between the waves.
  it("wrangler.jsonc rolls the sandbox image out in one wave (rollout_step_percentage 100)", () => {
    const wrangler = readFileSync(resolve(ROOT, "deploy/cloudflare-sandbox/wrangler.jsonc"), "utf8");
    const m = /"rollout_step_percentage":\s*(\d+)/.exec(wrangler);
    expect(m?.[1]).toBe("100");
  });
});
