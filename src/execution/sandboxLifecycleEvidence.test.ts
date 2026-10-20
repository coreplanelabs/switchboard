import { describe, expect, it } from "vitest";
import { SandboxLifecycleEvidence } from "./sandboxLifecycleEvidence.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  let now = 1000;
  const events: Record<string, unknown>[] = [];
  const supervised: Promise<void>[] = [];
  const logFailures: unknown[] = [];
  const evidence = new SandboxLifecycleEvidence({
    now: () => now,
    sandboxId: "sandbox-123",
    build: "commit-abc",
    log: (event) => events.push(event),
    reportLogFailure: (error) => logFailures.push(error),
    supervise: (promise) => supervised.push(promise),
  });
  return { evidence, events, supervised, logFailures, advance: (ms: number) => (now += ms) };
}

describe("sandbox lifecycle evidence", () => {
  it("retains typed stale-process evidence before its message is flattened", () => {
    const f = fixture();
    const error = Object.assign(new Error("previous runtime incarnation"), {
      name: "StaleProcessHandleError",
      code: "STALE_PROCESS_HANDLE",
      processId: "a030b6eb-42de-4c30-ad2b-e692327ca813",
      pid: 188,
      operation: "output",
      context: { environment: { TOKEN: "private" } },
    });
    f.evidence.executionFailed(error);
    expect(f.events).toEqual([
      {
        event: "sandbox.execution.lifecycle-failure",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        observationId: null,
        observedAt: 1000,
        errorName: "StaleProcessHandleError",
        reason: "previous runtime incarnation",
        errorCode: "STALE_PROCESS_HANDLE",
        processId: "a030b6eb-42de-4c30-ad2b-e692327ca813",
        pid: 188,
        operation: "output",
      },
    ]);
  });
  it("joins the inspected runtime image and later stop through one observation identity", async () => {
    const events: Record<string, unknown>[] = [];
    const supervised: Promise<void>[] = [];
    const stopped = deferred();
    const evidence = new SandboxLifecycleEvidence({
      now: () => 1000,
      sandboxId: "sandbox-123",
      build: "commit-abc",
      newObservationId: () => "observation-1",
      log: (event) => events.push(event),
      reportLogFailure: () => {},
      supervise: (promise) => supervised.push(promise),
    });
    evidence.watch(
      {
        running: true,
        monitor: () => stopped.promise,
        inspect: async () => ({
          image: "registry.example/sandbox@sha256:" + "a".repeat(64),
          labels: { token: "private" },
        }),
      },
      "start",
    );
    stopped.reject(new Error("Runtime signalled the container to exit due to a new version rollout: 0"));
    await Promise.all(supervised);
    expect(events).toContainEqual({
      event: "sandbox.container.observed",
      sandboxId: "sandbox-123",
      build: "commit-abc",
      observationId: "observation-1",
      inspectionStartedAt: 1000,
      observedAt: 1000,
      source: "start",
      imageState: "observed",
      image: "registry.example/sandbox@sha256:" + "a".repeat(64),
    });
    expect(events).toContainEqual({
      event: "sandbox.container.stop-observed",
      sandboxId: "sandbox-123",
      build: "commit-abc",
      observationId: "observation-1",
      observedAt: 1000,
      outcome: "error",
      errorName: "Error",
      reason: "Runtime signalled the container to exit due to a new version rollout: 0",
    });
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it.each(["wake", "start"] as const)("names the %s phase when the monitor cannot attach", (source) => {
    const f = fixture();
    f.evidence.watch(
      {
        running: true,
        monitor: () => {
          throw new Error("monitor unavailable");
        },
      },
      source,
    );
    expect(f.events).toEqual([
      {
        event: "sandbox.container.monitor-unavailable",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        at: 1000,
        source,
        errorName: "Error",
        reason: "monitor unavailable",
      },
    ]);
    expect(f.supervised).toEqual([]);
  });

  it("records a clean platform container stop and its guard intent without claiming a run ended", async () => {
    const f = fixture();
    const stopped = deferred();
    f.evidence.guardIntent({ event: "sandbox.idle-stop", why: "idle", source: "sweep" });
    f.evidence.watch({ running: true, monitor: () => stopped.promise }, "wake");
    f.advance(300);
    stopped.resolve();
    await Promise.all(f.supervised);
    expect(f.events).toEqual([
      {
        event: "sandbox.container.stop-observed",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        outcome: "clean",
        observedAt: 1300,
        guardIntent: { why: "idle", source: "sweep", at: 1000 },
      },
    ]);
  });

  it("records a bounded, redacted platform failure and exit code", async () => {
    const f = fixture();
    const stopped = deferred();
    const error = Object.assign(new Error("container failed; Authorization: Bearer abcdefghijklmnop"), {
      exitCode: 137,
    });
    f.evidence.watch({ running: true, monitor: () => stopped.promise }, "start");
    stopped.reject(error);
    await Promise.all(f.supervised);
    expect(f.events).toEqual([
      {
        event: "sandbox.container.stop-observed",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        outcome: "error",
        observedAt: 1000,
        errorName: "Error",
        reason: "container failed; Authorization: Bearer «redacted»",
        exitCode: 137,
      },
    ]);
  });

  it("keeps a numeric monitor rejection as an exit code", async () => {
    const f = fixture();
    const stopped = deferred();
    f.evidence.watch({ running: true, monitor: () => stopped.promise }, "start");
    stopped.reject(137);
    await Promise.all(f.supervised);
    expect(f.events).toEqual([
      {
        event: "sandbox.container.stop-observed",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        outcome: "error",
        observedAt: 1000,
        errorName: "number",
        reason: "non-Error failure",
        exitCode: 137,
      },
    ]);
  });

  it("does not attach twice to one running container, then attaches after the next start", async () => {
    const f = fixture();
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const container = {
      running: true,
      monitor: () => (++calls === 1 ? first.promise : second.promise),
    };
    f.evidence.watch(container, "wake");
    f.evidence.watch(container, "start");
    expect(calls).toBe(1);
    first.resolve();
    await f.supervised[0];
    f.evidence.watch(container, "start");
    expect(calls).toBe(2);
    second.resolve();
    await f.supervised[1];
    expect(f.events.filter((event) => event.event === "sandbox.container.stop-observed")).toHaveLength(2);
  });

  it("does not treat a failed telemetry write as a second container failure", async () => {
    const stopped = deferred();
    const reported: unknown[] = [];
    const supervised: Promise<void>[] = [];
    const evidence = new SandboxLifecycleEvidence({
      now: () => 1000,
      sandboxId: "sandbox-123",
      build: "commit-abc",
      log: () => {
        throw new Error("logging unavailable");
      },
      reportLogFailure: (error) => reported.push(error),
      supervise: (promise) => supervised.push(promise),
    });
    evidence.watch({ running: true, monitor: () => stopped.promise }, "wake");
    stopped.resolve();
    await Promise.all(supervised);
    expect(reported).toEqual([new Error("logging unavailable")]);
  });

  it("reports a refused monitor supervisor and fails the caller with its original error", () => {
    const events: Record<string, unknown>[] = [];
    const refusal = new Error("waitUntil refused; Authorization: Bearer abcdefghijklmnop");
    const evidence = new SandboxLifecycleEvidence({
      now: () => 1000,
      sandboxId: "sandbox-123",
      build: "commit-abc",
      log: (event) => events.push(event),
      reportLogFailure: () => {},
      supervise: () => {
        throw refusal;
      },
    });
    expect(() => evidence.watch({ running: true, monitor: () => new Promise<void>(() => {}) }, "start")).toThrow(
      refusal,
    );
    expect(events).toEqual([
      {
        event: "sandbox.container.monitor-supervise-failed",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        at: 1000,
        errorName: "Error",
        reason: "waitUntil refused; Authorization: Bearer «redacted»",
      },
    ]);
  });

  it("does not attach a retained or stale guard intent to an unrelated later stop", async () => {
    const f = fixture();
    f.evidence.guardIntent({ event: "sandbox.idle-stop", why: "idle", source: "sweep" });
    f.evidence.guardIntent({ event: "sandbox.idle-stop.retained" });
    const first = deferred();
    f.evidence.watch({ running: true, monitor: () => first.promise }, "wake");
    first.resolve();
    await f.supervised[0];
    expect(f.events[0]).not.toHaveProperty("guardIntent");

    f.evidence.guardIntent({ event: "sandbox.idle-stop", why: "stuck", source: "sdk-expiry" });
    f.advance(120_001);
    const later = deferred();
    f.evidence.watch({ running: true, monitor: () => later.promise }, "start");
    later.resolve();
    await f.supervised[1];
    expect(f.events[1]).not.toHaveProperty("guardIntent");
  });

  it("records the delegated base container alarm failure and preserves its exception", async () => {
    const f = fixture();
    const failure = new Error("alarm storage failed");
    await expect(
      f.evidence.alarm(
        () => ({ inflight: 1, running: true }),
        async () => {
          f.advance(25);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(f.events).toEqual([
      {
        event: "sandbox.lifecycle.alarm",
        phase: "start",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        at: 1000,
        inflight: 1,
        running: true,
      },
      {
        event: "sandbox.lifecycle.alarm",
        phase: "end",
        sandboxId: "sandbox-123",
        build: "commit-abc",
        at: 1025,
        elapsedMs: 25,
        outcome: "error",
        inflight: 1,
        running: true,
        errorName: "Error",
        reason: "alarm storage failed",
      },
    ]);
  });

  it("records a successful base container alarm once", async () => {
    const f = fixture();
    const value = await f.evidence.alarm(
      () => ({ inflight: 0, running: true }),
      async () => {
        f.advance(15);
        return "done";
      },
    );
    expect(value).toBe("done");
    expect(f.events).toEqual([
      expect.objectContaining({ phase: "start", at: 1000, inflight: 0, running: true }),
      expect.objectContaining({ phase: "end", at: 1015, elapsedMs: 15, outcome: "ok" }),
    ]);
  });

  it("preserves an alarm failure if its telemetry writer also fails", async () => {
    const reported: unknown[] = [];
    const evidence = new SandboxLifecycleEvidence({
      now: () => 1000,
      sandboxId: "sandbox-123",
      build: "commit-abc",
      log: () => {
        throw new Error("logging unavailable");
      },
      reportLogFailure: (error) => reported.push(error),
      supervise: () => {},
    });
    const alarmFailure = new Error("alarm storage failed");
    await expect(
      evidence.alarm(
        () => ({ inflight: 1, running: true }),
        async () => {
          throw alarmFailure;
        },
      ),
    ).rejects.toBe(alarmFailure);
    expect(reported).toEqual([new Error("logging unavailable"), new Error("logging unavailable")]);
  });

  it("preserves an alarm failure when the platform running flag cannot be read", async () => {
    const f = fixture();
    const alarmFailure = new Error("alarm storage failed");
    await expect(
      f.evidence.alarm(
        () => {
          throw new Error("Durable Object inactive");
        },
        async () => {
          throw alarmFailure;
        },
      ),
    ).rejects.toBe(alarmFailure);
    expect(f.events).toEqual([
      expect.objectContaining({
        phase: "start",
        state: "unavailable",
        stateError: { errorName: "Error", reason: "Durable Object inactive" },
      }),
      expect.objectContaining({
        phase: "end",
        outcome: "error",
        reason: "alarm storage failed",
        stateError: { errorName: "Error", reason: "Durable Object inactive" },
      }),
    ]);
  });

  it("does not stringify an arbitrary platform rejection over the original outcome", async () => {
    const f = fixture();
    const stopped = deferred();
    f.evidence.watch({ running: true, monitor: () => stopped.promise }, "wake");
    stopped.reject({
      toString: () => {
        throw new Error("poisoned stringify");
      },
    });
    await Promise.all(f.supervised);
    expect(f.events[0]).toMatchObject({
      event: "sandbox.container.stop-observed",
      outcome: "error",
      errorName: "object",
      reason: "non-Error failure",
    });
  });
});
