import { SOURCE_TASK_SNAPSHOT_MAX_BYTES } from "../budgets.js";
import { sourceSnapshot } from "../runLedger/sourceEvents.js";
import type { LiveRunMeta } from "../runLedger/types.js";
import { isOrchestratorOwner, sourceRunTask, type OrchestratorOwner } from "../dispatch/orchestratorDecisions.js";
import { orchestratorOwnerForHandoff } from "../dispatch/handoff.js";
import { githubPullSourceContextOf } from "../../execution/githubReadSource.js";

/** Original canonical task data, never current access or action authority. */
export interface SourceTaskSnapshot {
  version: 1;
  owner: OrchestratorOwner;
  task: ReturnType<typeof sourceRunTask>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512;
const keys = ["repo", "ref", "baseRef", "headSha", "pr", "operationTarget", "githubSource", "recordTaskKey"];

export function sourceTaskSnapshotOf(value: unknown): SourceTaskSnapshot | undefined {
  try {
    const v = sourceSnapshot(value);
    if (
      !object(v) ||
      !closed(v, ["version", "owner", "task"]) ||
      v.version !== 1 ||
      !isOrchestratorOwner(v.owner) ||
      !object(v.task) ||
      !closed(v.task, keys) ||
      new TextEncoder().encode(JSON.stringify(v)).byteLength > SOURCE_TASK_SNAPSHOT_MAX_BYTES
    )
      return;
    const t = v.task;
    if (
      [t.repo, t.ref, t.baseRef].some((field) => field !== null && !text(field)) ||
      (t.headSha !== null && (typeof t.headSha !== "string" || !/^[a-f0-9]{40}$/.test(t.headSha))) ||
      (t.pr !== null && (typeof t.pr !== "number" || !Number.isSafeInteger(t.pr) || t.pr < 1)) ||
      (t.operationTarget !== null && !object(t.operationTarget)) ||
      (t.githubSource !== null && !githubPullSourceContextOf(t.githubSource)) ||
      (t.recordTaskKey !== null && (typeof t.recordTaskKey !== "string" || !/^[a-f0-9]{16}$/.test(t.recordTaskKey)))
    )
      return;
    return { version: 1, owner: v.owner, task: sourceRunTask(t) };
  } catch {
    // Unsupported or unsafe task data cannot become retained proof.
    return;
  }
}

export function sameSourceTaskSnapshot(a: unknown, b: unknown): boolean {
  const first = sourceTaskSnapshotOf(a),
    second = sourceTaskSnapshotOf(b);
  return first !== undefined && second !== undefined && JSON.stringify(first) === JSON.stringify(second);
}

/** Source admission does not yet call this constructor. The caller must use
 * its original owner-fenced state write. Validation can compare a supplied
 * snapshot with the canonical row; that comparison grants no authority. */
export function captureSourceTaskSnapshot(row: { runId: string; meta: LiveRunMeta }): SourceTaskSnapshot | undefined {
  try {
    const meta = sourceSnapshot(row.meta) as LiveRunMeta;
    if (meta.childHandoff !== undefined) return;
    const owner = orchestratorOwnerForHandoff({
      runId: row.runId,
      requester: meta.userId,
      channelId: meta.channelId,
      threadKey: meta.threadKey,
      agent: meta.agent,
      parentRunId: meta.parentRunId,
      parentInstanceId: meta.parentInstanceId,
    });
    return owner ? sourceTaskSnapshotOf({ version: 1, owner, task: sourceRunTask(meta) }) : undefined;
  } catch {
    return;
  }
}
