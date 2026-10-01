// The main conversation's current-thread work link is read from durable run
// and unit rows. A session log is per agent; recent plane rows are fleet-wide.
// Neither can answer whether this requester's earlier turn started work here.
import { authorize } from "../core/authz/authorize.js";
import { predicateFor } from "../core/authz/predicate.js";
import { RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import { runResource } from "../core/runsService.js";
import type { RunsReadCapability } from "./runs.js";
import type { RunnableTool } from "./runnableTool.js";

const UNAVAILABLE = "error: This thread's saved work is unavailable. Do not infer that no work was started.";

/** The same requester-bound read serves the tool and the publication fence. */
export async function readThreadWork(
  cap: RunsReadCapability | undefined,
  agentName: string | undefined,
): Promise<string> {
  if (agentName !== "orchestrator" || !cap?.runId || cap.actor.kind !== "user") return UNAVAILABLE;
  try {
    const self = await cap.service.getRun(cap.runId);
    if (!self.ok) return UNAVAILABLE;
    const current = self.value;
    if (
      current.agent !== "orchestrator" ||
      current.userId !== cap.actor.id ||
      !current.threadKey ||
      !authorize(cap.actor, "runs:read", runResource(current)).allow
    )
      return UNAVAILABLE;
    const visibleTo = predicateFor(cap.actor, "runs:read", "run");
    const page = await cap.service.listRuns({
      status: "all",
      visibleTo,
      threadKey: current.threadKey,
      limit: RUN_LIST_MAX_LIMIT,
      includeDurableHistory: true,
    });
    // A live-only fallback or a cursor is not the thread's full history.
    if (!page.durableHistory || page.storeUnavailable || page.ledgerUnavailable || page.nextBefore) return UNAVAILABLE;
    // The speaking run changes from live to finished before the publication
    // fence. It is not earlier work and must not make an unchanged read stale.
    const owned = page.runs.filter(
      (row) => row.id !== current.id && row.userId === cap.actor.id && row.threadKey === current.threadKey,
    );
    const instanceIds = [...new Set(owned.flatMap((row) => (row.instanceId ? [row.instanceId] : [])))];
    const units = [];
    for (const instanceId of instanceIds) {
      const found = await cap.service.listInstanceUnits(instanceId, visibleTo);
      if (found.length === 0) return UNAVAILABLE;
      units.push(
        ...found.map((unit) => ({
          unit: unit.unit,
          branch: unit.branch,
          ...(unit.pr ? { pr: unit.pr } : {}),
          ...(unit.ending ? { ending: unit.ending } : {}),
          ...(unit.idle ? { idle: unit.idle } : {}),
        })),
      );
    }
    return JSON.stringify({
      thread: current.threadKey,
      requester: cap.actor.id,
      runs: owned.map((row) => ({
        id: row.id,
        agent: row.agent,
        status: row.finished ? (row.status ?? "finished") : "running",
        ...(row.repo ? { repo: row.repo } : {}),
        ...(row.instanceId ? { instanceId: row.instanceId } : {}),
        ...(row.pr ? { pr: row.pr } : {}),
        ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
      })),
      units,
    });
  } catch {
    return UNAVAILABLE;
  }
}

/** No model-supplied requester or thread: both come from the current run. */
export const threadWorkTool: RunnableTool = {
  name: "thread_work",
  description:
    "Read durable runs and Ship units started by this requester in this exact conversation, including original run, unit and PR links. " +
    "Use before answering what work this conversation started or what happened to it. This is not a transcript or a fresh source read; " +
    "recall covers only this agent's own log. An unavailable result means unknown, not no work.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  sideEffectFree: true,
  failsInText: true,
  async run(_input, ctx) {
    const result = await readThreadWork(ctx.runs, ctx.agentName);
    if (result !== UNAVAILABLE) ctx.runs?.recordThreadWorkRead?.(result);
    return result;
  },
};
