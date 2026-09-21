type WaitUntilContext = Pick<DurableObjectState, "waitUntil">;

const TASKS = Symbol.for("switchboard.memory-worker.pending-background-tasks");
type PendingTasks = Map<Promise<unknown>, string>;

const pendingTasks = (): PendingTasks => {
  const root = globalThis as typeof globalThis & { [TASKS]?: PendingTasks };
  return (root[TASKS] ??= new Map());
};

/** Keep deliberately detached Worker work in the runtime's request lifetime.
 * The process-wide label set is also the test seam: a case cannot finish while
 * work it started is still able to contend with the next case. */
export function holdBackgroundTask(context: WaitUntilContext, label: string, task: Promise<unknown>): void {
  const pending = pendingTasks();
  const held = task.finally(() => pending.delete(held));
  pending.set(held, label);
  context.waitUntil(held);
}

export function assertNoPendingBackgroundTasks(): void {
  const labels = [...pendingTasks().values()];
  if (labels.length === 0) return;
  throw new Error(`test ended with ${labels.length} pending background task(s): ${labels.join(", ")}`);
}
