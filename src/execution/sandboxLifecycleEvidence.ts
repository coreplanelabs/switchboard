import { redactAndCap, stripAnsi } from "../core/redact.js";
import { DESTROY_GRACE_MS } from "./sandboxIdle.js";

interface MonitoredContainer {
  readonly running: boolean;
  monitor(): Promise<void>;
}

interface LifecycleEvidenceHost {
  now(): number;
  sandboxId: string;
  build: string;
  log(event: Record<string, unknown>): void;
  reportLogFailure(error: unknown): void;
  supervise(promise: Promise<void>): void;
}

function failure(err: unknown): Record<string, unknown> {
  const named = err instanceof Error ? err : null;
  const code =
    err && typeof err === "object"
      ? (err as { exitCode?: unknown }).exitCode
      : typeof err === "number"
        ? err
        : undefined;
  const reason = named?.message ?? (typeof err === "string" ? err : "non-Error failure");
  return {
    errorName: redactAndCap(stripAnsi(named?.name ?? typeof err), 80),
    reason: redactAndCap(stripAnsi(reason), 240),
    ...(typeof code === "number" && Number.isInteger(code) ? { exitCode: code } : {}),
  };
}

/** Evidence about the platform container. A monitor result is an observed stop,
 * not proof that an individual process or its work ended. */
export class SandboxLifecycleEvidence {
  private static readonly INTENT_WINDOW_MS = 2 * DESTROY_GRACE_MS;
  private watching = false;
  private lastGuardIntent: { why: "idle" | "stuck"; source: "sweep" | "sdk-expiry"; at: number } | undefined;

  constructor(private readonly host: LifecycleEvidenceHost) {}

  watch(container: MonitoredContainer | undefined, source: "wake" | "start"): void {
    if (!container || (source === "wake" && !container.running)) return;
    if (this.watching) return;
    let stopped: Promise<void>;
    try {
      stopped = container.monitor();
    } catch (err) {
      this.emit({
        event: "sandbox.container.monitor-unavailable",
        sandboxId: this.host.sandboxId,
        build: this.host.build,
        at: this.host.now(),
        source,
        ...failure(err),
      });
      return;
    }
    this.watching = true;
    const observed = stopped
      .then(
        () => this.stopObserved("clean"),
        (err: unknown) => this.stopObserved("error", err),
      )
      .finally(() => {
        this.watching = false;
      });
    try {
      this.host.supervise(observed);
    } catch (err) {
      this.emit({
        event: "sandbox.container.monitor-supervise-failed",
        sandboxId: this.host.sandboxId,
        build: this.host.build,
        at: this.host.now(),
        ...failure(err),
      });
      // Without supervision a future stop result can be lost. Refuse this
      // constructor or start instead of allowing an unobserved container.
      throw err;
    }
  }

  guardIntent(event: Record<string, unknown>): void {
    if (
      event.event === "sandbox.idle-stop" &&
      (event.why === "idle" || event.why === "stuck") &&
      (event.source === "sweep" || event.source === "sdk-expiry")
    ) {
      this.lastGuardIntent = { why: event.why, source: event.source, at: this.host.now() };
    } else if (event.event === "sandbox.idle-stop.kill-failed" || event.event === "sandbox.idle-stop.retained") {
      this.lastGuardIntent = undefined;
    }
  }

  private stopObserved(outcome: "clean" | "error", err?: unknown): void {
    const intent = this.lastGuardIntent;
    const observedAt = this.host.now();
    this.emit({
      event: "sandbox.container.stop-observed",
      sandboxId: this.host.sandboxId,
      build: this.host.build,
      outcome,
      observedAt,
      ...(intent && observedAt - intent.at >= 0 && observedAt - intent.at <= SandboxLifecycleEvidence.INTENT_WINDOW_MS
        ? { guardIntent: intent }
        : {}),
      ...(outcome === "error" ? failure(err) : {}),
    });
    this.lastGuardIntent = undefined;
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.host.log(event);
    } catch (err) {
      this.host.reportLogFailure(err);
    }
  }

  private alarmState(state: () => { inflight: number; running: boolean | undefined }): Record<string, unknown> {
    try {
      return state();
    } catch (err) {
      return { state: "unavailable", stateError: failure(err) };
    }
  }

  async alarm<T>(
    state: () => { inflight: number; running: boolean | undefined },
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.host.now();
    this.emit({
      event: "sandbox.lifecycle.alarm",
      phase: "start",
      sandboxId: this.host.sandboxId,
      build: this.host.build,
      at: startedAt,
      ...this.alarmState(state),
    });
    try {
      const result = await operation();
      const finishedAt = this.host.now();
      this.emit({
        event: "sandbox.lifecycle.alarm",
        phase: "end",
        sandboxId: this.host.sandboxId,
        build: this.host.build,
        at: finishedAt,
        elapsedMs: finishedAt - startedAt,
        outcome: "ok",
        ...this.alarmState(state),
      });
      return result;
    } catch (err) {
      const finishedAt = this.host.now();
      this.emit({
        event: "sandbox.lifecycle.alarm",
        phase: "end",
        sandboxId: this.host.sandboxId,
        build: this.host.build,
        at: finishedAt,
        elapsedMs: finishedAt - startedAt,
        outcome: "error",
        ...this.alarmState(state),
        ...failure(err),
      });
      throw err;
    }
  }
}
