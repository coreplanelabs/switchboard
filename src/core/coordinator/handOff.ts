// The ship request handed to the plan runner (docs/reference/specs/agent-ship.md
// item 16; docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md):
// what the ship branch does with every `agent:ship` request once the preflight
// admitted it. The request names a plan (`plan <path>.md [units …]`) or a task;
// the bot reads the plan at the base ref and builds the runner's input — the
// instance record (the requester, channel, thread, card, caps and run id every
// step reads back; run-history item 49) and one unit row per selected unit
// (item 50; a task is a plan of one unit, `task`, on the ship branch in the
// requesting thread; a resume at review — the requester named an open pull
// request of ship's own — is that one unit with the pull request on its row, so
// the runner opens it at the review round) — writes both to the state Worker,
// then asks its shim for the Workflow instance under the plan's id and, from
// the second re-issue, its attempt (a re-issue reruns the units the earlier
// attempts did not merge; a live attempt refuses it). The reply says where the
// plan runs; every refusal is a reply, and nothing is created on one. Pure over
// its seams: the file read, the instance store, the create and the status read.

import { unitTitleOf } from "../ship/contract.js";
import type { ShipEntry } from "../ship/preflight.js";
import { shipTaskText } from "../ship/preflight.js";
import {
  generatedPlanId,
  openPlanCursor,
  parsePlanGraph,
  parseShipPlanRequest,
  planIdOf,
  planInstanceId,
  unitBranch,
  type AddressSeverity,
  type AddressSeveritySource,
  type PlanGraph,
  type ShipCaps,
} from "../ship/coordinator.js";
import type { AgentSource } from "../runEvents.js";
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
    authenticatedAs?: string;
    threadKey: string;
    sourceUrl?: string;
  };
  /** How the ship preset was chosen (`run_meta.agentSource`): a routed ship
   *  (`route`) runs generated plans alone — the seeded form is refused naming
   *  the directive, so the router can never start a runner-merged plan. */
  agentSource?: AgentSource;
  /** The ship request's run: the record the coordinator's finish writes the plan's story under. */
  runId: string;
  label: string;
  /** The pipeline's caps as the profile gate clipped them. */
  caps: ShipCaps;
  /** The severity to address, resolved by the ship branch
   *  (directive > user > channel > org) — written on the instance beside `merge`;
   *  absent (a caller without the config layers) is the default: `minor`, the org's. */
  addressSeverity?: { level: AddressSeverity; source: AddressSeveritySource };
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

/** The runner's input from the request, before the attempt is decided: always
 *  a plan — seeded (a file read at the base ref, with a `path`) or generated (a
 *  one-unit graph from the request text, no `path`: the instance's mark). */
type Planned = {
  planId: string;
  /** The plan file's path — a seeded plan only. */
  path?: string;
  base: string;
  graph: PlanGraph;
  selected: string[];
  identity: Identity;
  /** Who merges: `runner` for a seeded plan, `person` for a generated one. */
  merge: "runner" | "person";
  /** A resume at review rides the generated unit's row, on the pull request's own head branch. */
  resume?: { pr: number; headSha?: string; url?: string };
  /** The thread's open pull request a generated task adopts: round 0 runs on
   *  its head branch and the pre-check finds it (agent-ship item 10). */
  adopt?: { pr: number; url?: string };
  /** The entry's branch (an adopted or resumed pull request's head) overrides the graph's on the one generated unit. */
  entryBranch?: string;
  /** The pull request's own auto-merge fact at entry (agent-ship item 9): named in the reply, never refused. */
  autoMergeEnabled?: boolean;
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
    ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
    channelId: msg.channelId,
    ...(msg.channelName !== undefined ? { channelName: msg.channelName } : {}),
    threadKey: msg.threadKey,
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    repo: entry.repo,
    base,
    createdAt: input.now,
    caps: input.caps,
    // Absent, the default is the org's `minor` (agent-ship item 9).
    addressSeverity: input.addressSeverity?.level ?? "minor",
    addressSeveritySource: input.addressSeverity?.source ?? "org",
    ...(input.card !== undefined ? { card: input.card } : {}),
    runId: input.runId,
    label: input.label,
  };
  const taskText = shipTaskText(input.requestText, entry.repo);
  const request = parseShipPlanRequest(taskText);
  if (request === undefined) {
    // A generated plan of one unit (agent-ship item 16): the request text is
    // the unit, the id is deterministic per (thread, text), the branch the
    // graph's `plan/<id>/u1` — the instance's absent `plan.path` is the mark
    // that keeps its unit in the requesting thread. Its merge is a person's,
    // whatever the request's words say.
    const text = taskText || "Implement the task this thread's ship request describes.";
    const planId = generatedPlanId(text, msg.threadKey);
    const graph: PlanGraph = {
      planId,
      units: [{ id: "U1", title: unitTitleOf(text), slug: "u1", branch: unitBranch(planId, "u1"), dependsOn: [] }],
    };
    return {
      ok: true,
      planned: {
        planId,
        base,
        graph,
        selected: ["U1"],
        identity,
        merge: "person",
        ...(entry.resume !== undefined ? { resume: entry.resume } : {}),
        ...(entry.adopt !== undefined ? { adopt: entry.adopt } : {}),
        ...(entry.branch !== undefined ? { entryBranch: entry.branch } : {}),
        ...(entry.autoMergeEnabled !== undefined ? { autoMergeEnabled: entry.autoMergeEnabled } : {}),
      },
    };
  }
  // The routed guard (agent-ship item 16; routing-and-config item 21): a
  // seeded plan's units merge under the runner's grant, so only a typed
  // `agent:ship` may start one — a routed ship runs generated plans alone.
  if (input.agentSource === "route")
    return {
      ok: false,
      reply: `🚫 A routed request never runs a seeded plan — its units would merge under the runner's grant. Type \`agent:ship plan ${request.planPath}\` to run it.`,
    };
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
  return {
    ok: true,
    planned: { planId, path: request.planPath, base, graph, selected, identity, merge: "runner" },
  };
}

/** The rows of a plan's selected units under an instance, as the plan states
 *  them; a generated plan's one unit takes the entry's branch when the entry
 *  resumed, and the resume rides its row. */
function rowsFor(
  p: Planned,
  selected: readonly string[],
  instanceId: string,
  lastPushOf?: ReadonlyMap<string, string>,
): CoordinatorUnit[] {
  return p.graph.units
    .filter((u) => selected.includes(u.id))
    .map((u) => ({
      instanceId,
      unit: u.id,
      slug: u.slug,
      title: u.title,
      branch: p.entryBranch ?? u.branch,
      dependsOn: u.dependsOn,
      rounds: [],
      ...(p.resume !== undefined ? { resume: p.resume } : {}),
      ...(lastPushOf?.has(u.id) ? { lastPush: lastPushOf.get(u.id)! } : {}),
    }));
}

/** The reply's account of where a plan runs: the plan id, the units, and where
 *  each runs — this thread for a generated plan, a thread of its own for a
 *  seeded one. */
function planWhere(p: Planned, units: readonly CoordinatorUnit[], mergedBefore: readonly string[]): string {
  const at = p.path !== undefined ? ` (\`${p.path}\` at \`${p.base}\`)` : "";
  const count = `${units.length} unit${units.length === 1 ? "" : "s"}`;
  const left = mergedBefore.length > 0 ? ` left` : "";
  const merged = mergedBefore.length > 0 ? `; merged before: ${mergedBefore.join(", ")}` : "";
  const head = `plan \`${p.planId}\`${at}, ${count}${left} in dependency order — ${units.map((u) => u.unit).join(", ")}${merged}.`;
  if (p.path !== undefined)
    return `${head} Each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread.`;
  const branch = units[0]?.branch ?? "";
  const url = (of: { pr: number; url?: string } | undefined) =>
    of?.url ?? (of !== undefined ? `https://github.com/${p.identity.repo}/pull/${of.pr}` : undefined);
  const runs =
    p.resume !== undefined
      ? `the review loop of ${url(p.resume)} resumes at its next review round on \`${branch}\` in this thread under your grants — no new coding round first`
      : p.adopt !== undefined
        ? `the unit adopts ${url(p.adopt)}: it runs on \`${branch}\` — the pull request's own head — in this thread under your grants, no new branch`
        : `the unit runs on \`${branch}\` in this thread under your grants`;
  // The pull request's own auto-merge fact, named at entry (agent-ship item 9).
  const autoMerge = p.autoMergeEnabled
    ? " Auto-merge is on for this pull request: the approval merges it once checks pass."
    : "";
  return `${head} ${runs}; this card follows it and the report lands here.${autoMerge}`;
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
  // The instance's plan: a seeded one names its path; a generated one carries
  // only the id — the mark every reader keys on. A seeded plan's units are the
  // runner's to merge (record 0031's merge grant); a generated one's a person's.
  const planOf = (): CoordinatorInstance["plan"] => ({
    id: p.planId,
    ...(p.path !== undefined ? { path: p.path } : {}),
  });
  const firstId = planInstanceId(p.planId);
  const first = await deps.instances.get(firstId);
  if (first === null) {
    const units = rowsFor(p, p.selected, firstId);
    const instance: CoordinatorInstance = {
      id: firstId,
      ...p.identity,
      branch: units[0]!.branch,
      plan: planOf(),
      merge: p.merge,
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
  // A `review_pending` ending's recorded head (the coding child's own last
  // push): carried onto the next attempt's row, so its pre-check starts at the
  // review round when the open pull request still heads exactly there. The
  // latest attempt's word wins.
  const lastPushOf = new Map<string, string>();
  for (let n = 1; n <= attempt; n++)
    for (const row of await deps.instances.listUnits(planInstanceId(p.planId, n))) {
      if (row.ending?.kind === "merged") merged.add(row.unit);
      if (row.lastPush !== undefined) lastPushOf.set(row.unit, row.lastPush);
    }
  const remaining = p.selected.filter((u) => !merged.has(u));
  if (remaining.length === 0)
    return refused(
      `🚫 Every unit of ${where} this request names is merged already (${p.selected.join(", ")}) — nothing left to run.`,
    );
  const mergedBefore = p.selected.filter((u) => merged.has(u));
  if (status.kind === "absent") {
    // The latest attempt's create failed after its records were written: the
    // records are this request's to replace, under the same id and attempt.
    const units = rowsFor(p, remaining, latest.id, lastPushOf);
    const instance: CoordinatorInstance = {
      id: latest.id,
      ...p.identity,
      branch: units[0]!.branch,
      plan: planOf(),
      merge: p.merge,
      ...(attempt > 1 ? { attempt } : {}),
    };
    log(`[ship] ${input.msg.threadKey}: ${latest.id} has records but no instance — replacing the earlier attempt's`);
    const prefix = attempt > 1 ? `attempt ${attempt} of ` : "";
    return start(deps, input, instance, units, `${prefix}${planWhere(p, units, mergedBefore)}`, "replace");
  }
  // Ended: the next attempt reruns what the earlier attempts did not merge.
  const nextId = planInstanceId(p.planId, attempt + 1);
  const units = rowsFor(p, remaining, nextId, lastPushOf);
  const instance: CoordinatorInstance = {
    id: nextId,
    ...p.identity,
    branch: units[0]!.branch,
    plan: planOf(),
    merge: p.merge,
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
