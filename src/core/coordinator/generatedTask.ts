import { createHash } from "node:crypto";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";

type GeneratedTask = NonNullable<CoordinatorUnit["generatedTask"]>;

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Older first-attempt records already retain their admission run and link.
 * Later attempts use the explicit source copied from that first record. */
export function generatedTaskAdmissionSource(
  instance: CoordinatorInstance,
): CoordinatorInstance["generatedTaskSource"] {
  return (
    instance.generatedTaskSource ??
    (instance.attempt === undefined && instance.runId !== undefined
      ? { runId: instance.runId, ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}) }
      : undefined)
  );
}

/** Freeze the request at admission, before the first child can outlive the
 * host run or its bounded conversation transcript. */
export function generatedTaskOf(text: string, source: GeneratedTask["source"]): GeneratedTask {
  if (text.trim().length === 0 || text.length > 100_000) throw new Error("the generated task is empty or too long");
  return { version: 1, text, sha256: digestOf(text), source };
}

/** A durable row is still untrusted input when a later process reads it. */
export function generatedTaskText(task: GeneratedTask | undefined, instance: CoordinatorInstance): string {
  const source = generatedTaskAdmissionSource(instance);
  if (
    task === undefined ||
    task.version !== 1 ||
    task.text.trim().length === 0 ||
    task.text.length > 100_000 ||
    task.sha256 !== digestOf(task.text) ||
    task.source.requesterId !== instance.userId ||
    task.source.threadKey !== instance.threadKey ||
    task.source.repo !== instance.repo ||
    source === undefined ||
    task.source.runId !== source.runId ||
    task.source.sourceUrl !== source.sourceUrl ||
    (instance.attempt === undefined &&
      instance.runId !== undefined &&
      (source.runId !== instance.runId || source.sourceUrl !== instance.sourceUrl))
  ) {
    throw new Error("the generated task checkpoint is missing or does not match its requester and target");
  }
  return task.text;
}
