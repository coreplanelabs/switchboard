// The ship request handed to the plan runner (docs/reference/specs/agent-ship.md
// item 16; docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md):
// what the bot does under `ship.coordinator: true` in place of the in-process
// round loop. The request names a plan (`plan <path>.md [units …]`) or a task;
// the bot reads the plan at the base ref and builds the runner's input — the
// instance record (the requester, channel, thread, card, caps and run id every
// step reads back; run-history item 49) and one unit row per selected unit
// (item 50; a task is a plan of one unit, `task`, on the ship branch in the
// requesting thread) — writes both to the state Worker, then asks its shim for
// the Workflow instance under the plan's id and, from the second re-issue, its
// attempt (a re-issue reruns the units the earlier attempts did not merge; a
// live attempt refuses it). The reply says where the plan runs; every refusal
// is a reply, and nothing is created on one. Pure over its seams: the file
// read, the instance store, the create and the status read.

import type { ShipEntry } from "../ship/preflight.js";
import { shipTaskText } from "../ship/preflight.js";
import {
  openPlanCursor,
  parsePlanGraph,
  parseShipPlanRequest,
  planIdOf,
  planInstanceId,
  type PlanGraph,
  type ShipCaps,
} from "../ship/coordinator.js";
import { TASK_UNIT } from "./briefs.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { CreateInstanceAnswer, InstanceStatusAnswer } from "./instancesRoute.js";

export interface HandOffInput {
  entry: ShipEntry;
  /** The request's directive-stripped text (the preflight's input). */
  requestText: string;
  msg: {
    channelId: string;
    channelName?: string;
    userId: string;
    userName?: string;
    threadKey: string;
    sourceUrl?: string;
  };
  /** The ship request's run: the record the coordinator's finish writes the plan's story under. */
  runId: string;
  label: string;
  /** The pipeline's caps as the profile gate clipped them. */
  caps: ShipCaps;
  /** The status card in the requesting thread, when the channel has one. */
  card?: { channel: string; ts: string };
  now: number;
}

export interface HandOffDeps {
  /** The repository's file at a ref — the App's read. */
  readFile: (repo: string, path: string, ref: string) => Promise<{ content: string }>;
  instances: CoordinatorInstanceStore;
  /** The shim's `POST /admin/coordinator/instances` for the id. */
  create: (id: string) => Promise<CreateInstanceAnswer>;
  /** The shim's `GET /admin/coordinator/instances/<id>`: whether an earlier attempt's instance still runs, ended, or never existed. */
  status: (id: string) => Promise<InstanceStatusAnswer>;
  log?: (line: string) => void;
}

/** The ship outcome's shape, as the ship branch closes its card and replies from it. */
export interface HandOffOutcome {
  status: "completed" | "aborted";
  reply: string;
}

/** Everything an instance record carries but its id, branch, plan and attempt — the same for every attempt of a plan. */
type Identity = Omit<CoordinatorInstance, "id" | "branch" | "plan" | "attempt">;

/** The runner's input from the request, before the id is decided: a task
 *  string is one unit under an instance named by the run; a plan is its graph
 *  and the selected units, named by the plan and the attempt. */
type Planned =
  | { kind: "task"; instance: CoordinatorInstance; units: CoordinatorUnit[]; where: string }
  | {
      kind: "plan";
      planId: string;
      path: string;
      base: string;
      graph: PlanGraph;
      selected: string[];
      identity: Identity;
    };

const refused = (reply: string): HandOffOutcome => ({ status: "aborted", reply });
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The Workflow platform's words for an instance that has not ended. */
const RUNNING = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
const ENDED = new Set(["complete", "errored", "terminated"]);

async function plan(
  deps: HandOffDeps,
  input: HandOffInput,
): Promise<{ ok: true; planned: Planned } | { ok: false; reply: string }> {
  const { entry, msg } = input;
  const base = entry.base;
  if (base === undefined)
    return {
      ok: false,
      reply: `🚫 The plan runner needs the pull request's base branch and no base branch is known for ${entry.repo}.`,
    };
  const identity: Identity = {
    kind: "ship",
    userId: msg.userId,
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    channelId: msg.channelId,
    ...(msg.channelName !== undefined ? { channelName: msg.channelName } : {}),
    threadKey: msg.threadKey,
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    repo: entry.repo,
    base,
    createdAt: input.now,
    caps: input.caps,
    ...(input.card !== undefined ? { card: input.card } : {}),
    runId: input.runId,
    label: input.label,
  };
  const request = parseShipPlanRequest(shipTaskText(input.requestText, entry.repo));
  if (request === undefined) {
    const id = `ship-${input.runId}`;
    return {
      ok: true,
      planned: {
        kind: "task",
        instance: { id, ...identity, branch: entry.branch },
        units: [{ instanceId: id, unit: TASK_UNIT, slug: TASK_UNIT, branch: entry.branch, dependsOn: [], rounds: [] }],
        where: `the task runs on \`${entry.branch}\` in this thread under your grants; this card follows it and the report lands here.`,
      },
    };
  }
  let planId: string;
  try {
    planId = planIdOf(request.planPath);
  } catch (err) {
    return { ok: false, reply: `🚫 ${describe(err)}` };
  }
  let text: string;
  try {
    text = (await deps.readFile(entry.repo, request.planPath, base)).content;
  } catch (err) {
    return {
      ok: false,
      reply: `🚫 The plan \`${request.planPath}\` could not be read at \`${base}\` in ${entry.repo}: ${describe(err)}`,
    };
  }
  const graph = parsePlanGraph(text, planId);
  if (graph.units.length === 0)
    return {
      ok: false,
      reply: `🚫 The plan \`${request.planPath}\` has no unit headings (\`### U<n>. <title>\`) — nothing to run.`,
    };
  let selected: string[];
  try {
    selected = openPlanCursor(graph, request.units).order;
  } catch (err) {
    return { ok: false, reply: `🚫 ${describe(err)}` };
  }
  return { ok: true, planned: { kind: "plan", planId, path: request.planPath, base, graph, selected, identity } };
}

/** The rows of a plan's selected units under an instance, as the plan states them. */
function rowsFor(graph: PlanGraph, selected: readonly string[], instanceId: string): CoordinatorUnit[] {
  return graph.units
    .filter((u) => selected.includes(u.id))
    .map((u) => ({
      instanceId,
      unit: u.id,
      slug: u.slug,
      title: u.title,
      branch: u.branch,
      dependsOn: u.dependsOn,
      rounds: [],
    }));
}

/** The reply's account of where a plan runs. */
function planWhere(
  p: Extract<Planned, { kind: "plan" }>,
  units: readonly CoordinatorUnit[],
  mergedBefore: readonly string[],
): string {
  const count = `${units.length} unit${units.length === 1 ? "" : "s"}`;
  const left = mergedBefore.length > 0 ? ` left` : "";
  const merged = mergedBefore.length > 0 ? `; merged before: ${mergedBefore.join(", ")}` : "";
  return `plan \`${p.planId}\` (\`${p.path}\` at \`${p.base}\`), ${count}${left} in dependency order — ${units.map((u) => u.unit).join(", ")}${merged}. Each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread.`;
}

/**
 * The hand-off: the records first (a store without a durable Worker refuses by
 * name), then the instance, then the reply. For a plan, the id is the plan's
 * and the attempt's: no record under `plan-<plan-id>` is a first attempt; a
 * record there is an earlier attempt's, and the shim's status of the latest
 * attempt decides — still running refuses the request (its rows are a live
 * runner's and are never touched), never created (the leftover of a failed
 * create) is replaced and created under the same id, ended is resumed as the
 * next attempt under `plan-<plan-id>-<n>`, rerunning only the units the earlier
 * attempts did not merge.
 */
export async function handOffToCoordinator(deps: HandOffDeps, input: HandOffInput): Promise<HandOffOutcome> {
  const log = deps.log ?? console.log;
  const planned = await plan(deps, input);
  if (!planned.ok) return refused(planned.reply);
  const p = planned.planned;
  if (p.kind === "task") return start(deps, input, p.instance, p.units, p.where, "put");
  const firstId = planInstanceId(p.planId);
  const first = await deps.instances.get(firstId);
  if (first === null) {
    const units = rowsFor(p.graph, p.selected, firstId);
    const instance: CoordinatorInstance = {
      id: firstId,
      ...p.identity,
      branch: units[0]!.branch,
      plan: { id: p.planId, path: p.path },
    };
    return start(deps, input, instance, units, planWhere(p, units, []), "put");
  }
  // The latest attempt: the highest suffix with a record.
  let latest = first;
  let attempt = 1;
  for (;;) {
    const next = await deps.instances.get(planInstanceId(p.planId, attempt + 1));
    if (next === null) break;
    latest = next;
    attempt++;
  }
  const status = await deps.status(latest.id);
  const where = `plan \`${p.planId}\``;
  if (status.kind === "unanswered")
    return refused(
      `⚠️ The plan runner could not tell whether \`${latest.id}\` still runs: ${status.reason}. Nothing ran; re-issue the request to try again.`,
    );
  if (status.kind === "status" && RUNNING.has(status.status))
    return refused(
      `🚫 A runner for ${where} is still running (\`${latest.id}\`, status: ${status.status}): wait for it to end — or terminate it in the Workflows dashboard — before re-issuing.`,
    );
  if (status.kind === "status" && !ENDED.has(status.status))
    return refused(
      `🚫 A runner for ${where} (\`${latest.id}\`) is in a state the bot does not read as ended (${status.status}) — a person decides.`,
    );
  // What the earlier attempts merged is done for good, whichever attempt runs
  // next — a leftover's replacement included, so a resume whose create failed
  // never reruns a unit the base already carries.
  const merged = new Set<string>();
  for (let n = 1; n <= attempt; n++)
    for (const row of await deps.instances.listUnits(planInstanceId(p.planId, n)))
      if (row.ending?.kind === "merged") merged.add(row.unit);
  const remaining = p.selected.filter((u) => !merged.has(u));
  if (remaining.length === 0)
    return refused(
      `🚫 Every unit of ${where} this request names is merged already (${p.selected.join(", ")}) — nothing left to run.`,
    );
  const mergedBefore = p.selected.filter((u) => merged.has(u));
  if (status.kind === "absent") {
    // The latest attempt's create failed after its records were written: the
    // records are this request's to replace, under the same id and attempt.
    const units = rowsFor(p.graph, remaining, latest.id);
    const instance: CoordinatorInstance = {
      id: latest.id,
      ...p.identity,
      branch: units[0]!.branch,
      plan: { id: p.planId, path: p.path },
      ...(attempt > 1 ? { attempt } : {}),
    };
    log(`[ship] ${input.msg.threadKey}: ${latest.id} has records but no instance — replacing the earlier attempt's`);
    const prefix = attempt > 1 ? `attempt ${attempt} of ` : "";
    return start(deps, input, instance, units, `${prefix}${planWhere(p, units, mergedBefore)}`, "replace");
  }
  // Ended: the next attempt reruns what the earlier attempts did not merge.
  const nextId = planInstanceId(p.planId, attempt + 1);
  const units = rowsFor(p.graph, remaining, nextId);
  const instance: CoordinatorInstance = {
    id: nextId,
    ...p.identity,
    branch: units[0]!.branch,
    plan: { id: p.planId, path: p.path },
    attempt: attempt + 1,
  };
  return start(deps, input, instance, units, `attempt ${attempt + 1} of ${planWhere(p, units, mergedBefore)}`, "put");
}

/** The records, then the instance, then the reply. */
async function start(
  deps: HandOffDeps,
  input: HandOffInput,
  instance: CoordinatorInstance,
  units: CoordinatorUnit[],
  where: string,
  write: "put" | "replace",
): Promise<HandOffOutcome> {
  const log = deps.log ?? console.log;
  const put = write === "replace" ? await deps.instances.replace(instance) : await deps.instances.put(instance);
  if (!put.ok) {
    if (put.reason === "unavailable")
      return refused(
        "⚠️ The plan runner needs run history on the state Worker (`runHistory.worker`): the instance record could not be written, so nothing ran.",
      );
    // Another record took the id between the read and the write: a race two
    // requesters lose together — neither touches what is there.
    return refused(
      `🚫 A runner for \`${instance.id}\` was just recorded by another request — re-issue in a minute if it did not start.`,
    );
  }
  const rows = await deps.instances.putUnits(units);
  if (!rows.ok)
    return refused(
      "⚠️ The plan runner needs run history on the state Worker: the unit rows could not be written, so nothing ran.",
    );
  let answer: CreateInstanceAnswer;
  try {
    answer = await deps.create(instance.id);
  } catch (err) {
    answer = { kind: "unanswered", reason: describe(err) };
  }
  switch (answer.kind) {
    case "created": {
      log(`[ship] ${input.msg.threadKey}: handed to the plan runner ${instance.id} (${units.length} unit(s))`);
      const replaced =
        write === "replace" ? " The records of an earlier attempt that never started were replaced." : "";
      return { status: "completed", reply: `🧭 Handed to the plan runner \`${instance.id}\`: ${where}${replaced}` };
    }
    case "duplicate": {
      // The platform holds an instance the state Worker has no record of — a
      // store wiped or restored — so neither side can be trusted to resume.
      const status = answer.status !== undefined ? `, status: ${answer.status}` : "";
      return refused(
        `🚫 A Workflow instance \`${instance.id}\` already exists on the platform${status} but the state Worker knew nothing of it — a person decides; re-issuing will not resume it.`,
      );
    }
    case "failed":
    case "unanswered":
      log(`[ship] ${input.msg.threadKey}: the plan runner ${instance.id} could not be started — ${answer.reason}`);
      return refused(
        `⚠️ The plan runner could not be started: ${answer.reason}. Nothing ran; re-issue the request to try again.`,
      );
  }
}
