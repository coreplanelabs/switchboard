import { describe, expect, it } from "vitest";
import { StartGate, type StartGateHost } from "./sandboxStart.js";

// Feature: docs/reference/specs/execution.md item 23 — a thread's first
// request never carries the container's start. The gate starts the container
// in the background, answers `sandbox-starting` until it is up, and hands a
// failed start's error to the next request so it keeps its own name.

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeHost(opts: { running?: boolean | undefined } = {}) {
  let now = 1_000_000;
  let running = opts.running;
  const log: Record<string, unknown>[] = [];
  let warmUps = 0;
  let settle: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  const host: StartGateHost = {
    containerRunning: () => running,
    warmUp: () =>
      new Promise<void>((resolve, reject) => {
        warmUps++;
        settle = { resolve, reject };
      }),
    now: () => now,
    log: (e) => {
      log.push(e);
    },
  };
  return {
    host,
    log,
    warmUps: () => warmUps,
    advance: (ms: number) => {
      now += ms;
    },
    cameUp: () => {
      running = true;
      settle!.resolve();
    },
    failed: (e: unknown) => {
      settle!.reject(e);
    },
    setRunning: (r: boolean | undefined) => {
      running = r;
    },
  };
}

const starting = (cause: string) => ({ starting: cause });

describe("StartGate", () => {
  it("a request to a container that is not running begins one warm-up and answers starting at once, without running the operation", async () => {
    const f = fakeHost({ running: false });
    const g = new StartGate(f.host);
    let ran = 0;
    const out = await g.through(async () => {
      ran++;
      return { ok: true };
    }, starting);
    expect(out).toEqual({ starting: "container not running; starting it" });
    expect(ran).toBe(0);
    expect(f.warmUps()).toBe(1);
    expect(g.isStarting).toBe(true);
    expect(f.log).toEqual([{ event: "sandbox.starting" }]);
  });

  it("while the warm-up is in flight every request answers starting and no second warm-up begins", async () => {
    const f = fakeHost({ running: false });
    const g = new StartGate(f.host);
    await g.through(async () => "op", starting);
    f.setRunning(true); // the platform runs it, the runtime is not up yet
    const out = await g.through(async () => "op", starting);
    expect(out).toEqual({ starting: "container starting" });
    expect(f.warmUps()).toBe(1);
  });

  it("once the container is up the operation runs, and the start's duration is logged", async () => {
    const f = fakeHost({ running: false });
    const g = new StartGate(f.host);
    await g.through(async () => "op", starting);
    f.advance(75_000);
    f.cameUp();
    await flush();
    expect(g.isStarting).toBe(false);
    expect(await g.through(async () => "op", starting)).toBe("op");
    expect(f.log[1]).toEqual({ event: "sandbox.started", durationMs: 75_000 });
  });

  it("a running container passes the operation through without any warm-up", async () => {
    const f = fakeHost({ running: true });
    const g = new StartGate(f.host);
    expect(await g.through(async () => "op", starting)).toBe("op");
    expect(f.warmUps()).toBe(0);
    expect(f.log).toEqual([]);
  });

  it("a failed warm-up is thrown once, on the next request, with the SDK's own error — a full fleet keeps its name", async () => {
    const f = fakeHost({ running: false });
    const g = new StartGate(f.host);
    await g.through(async () => "op", starting);
    const err = Object.assign(new Error("no container instance available"), { name: "ContainerUnavailableError" });
    f.failed(err);
    await flush();
    await expect(g.through(async () => "op", starting)).rejects.toBe(err);
    expect(f.log[1]).toMatchObject({
      event: "sandbox.start-failed",
      error: expect.stringContaining("no container instance"),
    });
    // the request after that begins a fresh warm-up, since the container is still not running
    expect(await g.through(async () => "op", starting)).toEqual({ starting: "container not running; starting it" });
    expect(f.warmUps()).toBe(2);
  });

  it("a container that stopped (the idle guard destroyed it) is started again by the next request", async () => {
    const f = fakeHost({ running: true });
    const g = new StartGate(f.host);
    expect(await g.through(async () => "op", starting)).toBe("op");
    f.setRunning(false);
    expect(await g.through(async () => "op", starting)).toEqual({ starting: "container not running; starting it" });
    expect(f.warmUps()).toBe(1);
  });

  it("no container binding at all is treated as not running: the warm-up is what says what is wrong", async () => {
    const f = fakeHost({ running: undefined });
    const g = new StartGate(f.host);
    expect(await g.through(async () => "op", starting)).toEqual({ starting: "container not running; starting it" });
    expect(f.warmUps()).toBe(1);
  });
});

describe("StartGate warm-up settlement", () => {
  it("a new gate has no observed warm-up even when the container is running", async () => {
    const f = fakeHost({ running: true });
    const gate = new StartGate(f.host);
    expect(await gate.joinWarmUp()).toEqual({ kind: "unobserved" });
    expect(f.warmUps()).toBe(0);
  });

  it("the join stays pending after the starting response until the original warm-up succeeds", async () => {
    const f = fakeHost({ running: false });
    const gate = new StartGate(f.host);
    expect(await gate.through(async () => "op", starting)).toEqual(starting("container not running; starting it"));
    let joined = false;
    const join = gate.joinWarmUp().then((outcome) => {
      joined = true;
      return outcome;
    });
    f.setRunning(true);
    await flush();
    expect(joined).toBe(false);
    f.cameUp();
    expect(await join).toEqual({ kind: "succeeded" });
    await flush();
    expect(gate.isStarting).toBe(false);
    expect(await gate.joinWarmUp()).toEqual({ kind: "succeeded" });
    expect(f.warmUps()).toBe(1);
  });

  it("the original rejection remains distinct after the request consumes its one-shot failure", async () => {
    const f = fakeHost({ running: false });
    const gate = new StartGate(f.host);
    await gate.through(async () => "op", starting);
    const error = new Error("original SDK warm-up failure");
    f.failed(error);
    await flush();
    await expect(gate.through(async () => "op", starting)).rejects.toBe(error);
    expect(await gate.joinWarmUp()).toEqual({ kind: "failed", error });
    expect(await gate.joinWarmUp()).toEqual({ kind: "failed", error });
    expect(gate.isStarting).toBe(false);
    expect(f.warmUps()).toBe(1);
  });

  it("a caller timeout leaves the original join pending for its late failure", async () => {
    const f = fakeHost({ running: false });
    const gate = new StartGate(f.host);
    await gate.through(async () => "op", starting);
    const join = gate.joinWarmUp();
    expect(await Promise.race([join, Promise.resolve("caller-timeout")])).toBe("caller-timeout");
    expect(gate.isStarting).toBe(true);
    const error = new Error("late SDK timeout");
    f.failed(error);
    expect(await join).toEqual({ kind: "failed", error });
  });

  it("a caller abort leaves the original join pending for its late success", async () => {
    const f = fakeHost({ running: false });
    const gate = new StartGate(f.host);
    await gate.through(async () => "op", starting);
    const join = gate.joinWarmUp();
    const controller = new AbortController();
    const aborted = new Promise<string>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve("caller-aborted")),
    );
    controller.abort();
    expect(await Promise.race([join, aborted])).toBe("caller-aborted");
    expect(gate.isStarting).toBe(true);
    f.cameUp();
    expect(await join).toEqual({ kind: "succeeded" });
  });

  it("an SDK abort is the original failed outcome rather than a successful drain", async () => {
    const f = fakeHost({ running: false });
    const gate = new StartGate(f.host);
    await gate.through(async () => "op", starting);
    const error = new DOMException("warm-up aborted", "AbortError");
    f.failed(error);
    expect(await gate.joinWarmUp()).toEqual({ kind: "failed", error });
  });

  it("a captured join stays with the original attempt when a later warm-up begins", async () => {
    const f = fakeHost({ running: false });
    const gate = new StartGate(f.host);
    await gate.through(async () => "op", starting);
    const original = gate.joinWarmUp();
    f.cameUp();
    expect(await original).toEqual({ kind: "succeeded" });
    await flush();
    f.setRunning(false);
    await gate.through(async () => "op", starting);
    const later = gate.joinWarmUp();
    const error = new Error("second warm-up failed");
    f.failed(error);
    expect(await later).toEqual({ kind: "failed", error });
    expect(await original).toEqual({ kind: "succeeded" });
    expect(f.warmUps()).toBe(2);
  });

  it("a replacement gate cannot claim settlement of an earlier gate's pending attempt", async () => {
    const f = fakeHost({ running: false });
    const original = new StartGate(f.host);
    await original.through(async () => "op", starting);
    const replacement = new StartGate(f.host);
    expect(await replacement.joinWarmUp()).toEqual({ kind: "unobserved" });
    f.cameUp();
    expect(await original.joinWarmUp()).toEqual({ kind: "succeeded" });
    expect(await replacement.joinWarmUp()).toEqual({ kind: "unobserved" });
  });
});
