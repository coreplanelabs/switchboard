import { afterEach, beforeEach, type TestContext } from "vitest";
import {
  assertNoPendingBackgroundTasks,
  backgroundTaskDiagnostics,
  beginBackgroundTaskDiagnostics,
  endBackgroundTaskDiagnostics,
} from "./backgroundTasks.ts";
import { MEMORY_DIAGNOSTICS_ANNOTATION, type MemoryTestAnnotation } from "./testDiagnosticsProtocol.ts";

type TimerKind = "timeout" | "interval";
type TimerHandler = (...args: unknown[]) => unknown;
type TimerSetter = (
  handler: TimerHandler,
  delay?: number,
  ...args: unknown[]
) => ReturnType<typeof globalThis.setTimeout>;
interface PendingTimer {
  id: ReturnType<typeof setTimeout>;
  kind: TimerKind;
  label: string;
  owner: string;
}
interface RunningTest {
  name: string;
  trackTimers: boolean;
  timers: Map<ReturnType<typeof setTimeout>, PendingTimer>;
}
interface TimerOriginals {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

const RUNNING = Symbol.for("switchboard.memory-worker.running-test");
const TIMER_ORIGINALS = Symbol.for("switchboard.memory-worker.timer-originals");
const REJECTION_TRAP = Symbol.for("switchboard.memory-worker.rejection-trap");

type DiagnosticGlobal = typeof globalThis & {
  [RUNNING]?: RunningTest;
  [TIMER_ORIGINALS]?: TimerOriginals;
  [REJECTION_TRAP]?: boolean;
  __vitest_worker__?: { ctx?: { poolId?: number; workerId?: number } };
  process?: {
    env?: Record<string, string | undefined>;
    prependListener?: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  };
};

const diagnosticGlobal = (): DiagnosticGlobal => globalThis as DiagnosticGlobal;

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function runningTestName(): string {
  return diagnosticGlobal()[RUNNING]?.name ?? "<no test>";
}

function unhandledRejection(reason: unknown): never {
  throw new Error(`unhandled rejection while "${runningTestName()}" was running: ${reasonText(reason)}`);
}

function installUnhandledRejectionTrap(): void {
  const root = diagnosticGlobal();
  if (root[REJECTION_TRAP]) return;
  root[REJECTION_TRAP] = true;

  if (typeof root.addEventListener === "function") {
    root.addEventListener("unhandledrejection", (event) => {
      const rejection = event as PromiseRejectionEvent;
      rejection.preventDefault();
      unhandledRejection(rejection.reason);
    });
    return;
  }

  root.process?.prependListener?.("unhandledRejection", unhandledRejection);
}

function timerLabel(kind: TimerKind, handler: TimerHandler, delay?: number): string {
  const callback = typeof handler === "function" && handler.name ? handler.name : "anonymous";
  return `${kind} ${callback} (${delay ?? 0}ms)`;
}

function strayTimerError(timer: PendingTimer): Error {
  return new Error(`stray ${timer.label} from "${timer.owner}" fired while "${runningTestName()}" was running`);
}

function installTimerTrap(): void {
  const root = diagnosticGlobal();
  if (root[TIMER_ORIGINALS]) return;

  const originals: TimerOriginals = {
    setTimeout: root.setTimeout.bind(root),
    clearTimeout: root.clearTimeout.bind(root),
    setInterval: root.setInterval.bind(root),
    clearInterval: root.clearInterval.bind(root),
  };
  root[TIMER_ORIGINALS] = originals;

  root.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const running = root[RUNNING];
    if (!running?.trackTimers || typeof handler !== "function") {
      return (originals.setTimeout as unknown as TimerSetter)(handler, delay, ...args);
    }

    const pending: PendingTimer = {
      id: undefined as unknown as ReturnType<typeof setTimeout>,
      kind: "timeout",
      label: timerLabel("timeout", handler, delay),
      owner: running.name,
    };
    const id = (originals.setTimeout as unknown as TimerSetter)(
      (...callbackArgs: unknown[]) => {
        running.timers.delete(id);
        if (root[RUNNING]?.name !== pending.owner) throw strayTimerError(pending);
        handler(...callbackArgs);
      },
      delay,
      ...args,
    );
    pending.id = id;
    running.timers.set(id, pending);
    return id;
  }) as typeof globalThis.setTimeout;

  root.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const running = root[RUNNING];
    if (!running?.trackTimers || typeof handler !== "function") {
      return (originals.setInterval as unknown as TimerSetter)(handler, delay, ...args);
    }

    const pending: PendingTimer = {
      id: undefined as unknown as ReturnType<typeof setTimeout>,
      kind: "interval",
      label: timerLabel("interval", handler, delay),
      owner: running.name,
    };
    const id = (originals.setInterval as unknown as TimerSetter)(
      (...callbackArgs: unknown[]) => {
        if (root[RUNNING]?.name !== pending.owner) throw strayTimerError(pending);
        handler(...callbackArgs);
      },
      delay,
      ...args,
    );
    pending.id = id;
    running.timers.set(id, pending);
    return id;
  }) as typeof globalThis.setInterval;

  root.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    root[RUNNING]?.timers.delete(id as ReturnType<typeof setTimeout>);
    return originals.clearTimeout(id);
  }) as typeof globalThis.clearTimeout;
  root.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    root[RUNNING]?.timers.delete(id as ReturnType<typeof setTimeout>);
    return originals.clearInterval(id);
  }) as typeof globalThis.clearInterval;
}

function poolWorker(): string {
  const root = diagnosticGlobal();
  const poolId = root.__vitest_worker__?.ctx?.poolId ?? root.process?.env?.VITEST_POOL_ID;
  const workerId = root.__vitest_worker__?.ctx?.workerId ?? root.process?.env?.VITEST_WORKER_ID;
  return `pool ${poolId ?? "unknown"} / worker ${workerId ?? "unknown"}`;
}

function pendingTimerLabels(running: RunningTest): string[] {
  running.trackTimers = false;
  return [...running.timers.values()].map((timer) => timer.label);
}

function clearPendingTimers(running: RunningTest): void {
  const originals = diagnosticGlobal()[TIMER_ORIGINALS];
  if (!originals) return;
  for (const timer of running.timers.values()) {
    if (timer.kind === "interval") originals.clearInterval(timer.id);
    else originals.clearTimeout(timer.id);
  }
  running.timers.clear();
}

function testName(context: TestContext): string {
  return context.task.fullTestName || context.task.name;
}

export function installMemoryTestDiagnostics(): void {
  installUnhandledRejectionTrap();
  installTimerTrap();

  beforeEach((context) => {
    diagnosticGlobal()[RUNNING] = { name: testName(context), trackTimers: true, timers: new Map() };
    beginBackgroundTaskDiagnostics();
  });

  afterEach((context) => {
    const root = diagnosticGlobal();
    const running = root[RUNNING] ?? { name: testName(context), trackTimers: false, timers: new Map() };
    const background = backgroundTaskDiagnostics();
    const timers = pendingTimerLabels(running);
    const annotation: MemoryTestAnnotation = {
      poolWorker: poolWorker(),
      ...background,
      pendingTimers: timers,
    };

    const problems: Error[] = [];
    try {
      assertNoPendingBackgroundTasks();
    } catch (error) {
      problems.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (timers.length > 0) {
      problems.push(new Error(`test ended with ${timers.length} pending timer(s): ${timers.join(", ")}`));
    }

    (context.task.meta as Record<string, unknown>)[MEMORY_DIAGNOSTICS_ANNOTATION] = annotation;
    clearPendingTimers(running);
    endBackgroundTaskDiagnostics();
    delete root[RUNNING];

    if (problems.length === 1) throw problems[0];
    if (problems.length > 1) throw new AggregateError(problems, "test ended with pending asynchronous work");
  });
}
