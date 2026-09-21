type WaitUntilContext = Pick<DurableObjectState, "waitUntil">;

const TASKS = Symbol.for("switchboard.memory-worker.pending-background-tasks");
const REGISTRATIONS = Symbol.for("switchboard.memory-worker.background-task-registrations");
type PendingTasks = Map<Promise<unknown>, string>;
type Registrations = string[];

type DiagnosticRoot = typeof globalThis & {
  [TASKS]?: PendingTasks;
  [REGISTRATIONS]?: Registrations;
};

const root = (): DiagnosticRoot => globalThis as DiagnosticRoot;
const pendingTasks = (): PendingTasks => (root()[TASKS] ??= new Map());

export function beginBackgroundTaskDiagnostics(): void {
  root()[REGISTRATIONS] = [];
}

export function endBackgroundTaskDiagnostics(): void {
  delete root()[REGISTRATIONS];
}

export function backgroundTaskDiagnostics(): {
  registeredBackgroundTasks: string[];
  pendingPromises: string[];
} {
  return {
    registeredBackgroundTasks: [...(root()[REGISTRATIONS] ?? [])],
    pendingPromises: [...pendingTasks().values()],
  };
}

/** Keep deliberately detached Worker work in the runtime's request lifetime.
 * The process-wide label set is also the test seam: a case cannot finish while
 * work it started is still able to contend with the next case. */
export function holdBackgroundTask(context: WaitUntilContext, label: string, task: Promise<unknown>): void {
  const pending = pendingTasks();
  root()[REGISTRATIONS]?.push(label);
  const held = task.finally(() => pending.delete(held));
  pending.set(held, label);
  context.waitUntil(held);
}

export function assertNoPendingBackgroundTasks(): void {
  const labels = [...pendingTasks().values()];
  if (labels.length === 0) return;
  throw new Error(`test ended with ${labels.length} pending background task(s): ${labels.join(", ")}`);
}
