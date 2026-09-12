// The ship request handed to the plan runner (docs/reference/specs/agent-ship.md
// item 16; docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md):
// what the bot does under `ship.coordinator: true` in place of the in-process
// round loop. The request names a plan (`plan <path>.md [units …]`) or a task;
// the bot reads the plan at the base ref and builds the runner's input — the
// instance record (the requester, channel, thread, card, caps and run id every
// step reads back; run-history item 49) and one unit row per selected unit
// (item 50; a task is a plan of one unit, `task`, on the ship branch in the
// requesting thread) — writes both to the state Worker, then asks its shim for
// the Workflow instance under the plan's id. The reply says where the plan
// runs; every refusal is a reply, and nothing is created on one. Pure over its
// seams: the file read, the instance store and the create.

import type { ShipEntry } from "../ship/preflight.js";
import { shipTaskText } from "../ship/preflight.js";
import {
  openPlanCursor,
  parsePlanGraph,
  parseShipPlanRequest,
  planIdOf,
  planInstanceId,
  type ShipCaps,
} from "../ship/coordinator.js";
import { TASK_UNIT } from "./briefs.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { CreateInstanceAnswer } from "./instancesRoute.js";

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
  log?: (line: string) => void;
}

/** The ship outcome's shape, as the ship branch closes its card and replies from it. */
export interface HandOffOutcome {
  status: "completed" | "aborted";
  reply: string;
}

interface Planned {
  instance: CoordinatorInstance;
  units: CoordinatorUnit[];
  /** The reply's account of what runs where. */
  where: string;
}

const refused = (reply: string): HandOffOutcome => ({ status: "aborted", reply });
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The runner's input from the request: the plan's units or the one task unit. */
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
  const identity = {
    kind: "ship" as const,
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
    const cursor = openPlanCursor(graph, request.units);
    selected = cursor.order;
  } catch (err) {
    return { ok: false, reply: `🚫 ${describe(err)}` };
  }
  const id = planInstanceId(planId);
  const units = graph.units
    .filter((u) => selected.includes(u.id))
    .map((u): CoordinatorUnit => ({
      instanceId: id,
      unit: u.id,
      slug: u.slug,
      title: u.title,
      branch: u.branch,
      dependsOn: u.dependsOn,
      rounds: [],
    }));
  const count = `${units.length} unit${units.length === 1 ? "" : "s"}`;
  return {
    ok: true,
    planned: {
      instance: { id, ...identity, branch: units[0]!.branch, plan: { id: planId, path: request.planPath } },
      units,
      where: `plan \`${planId}\` (\`${request.planPath}\` at \`${base}\`), ${count} in dependency order — ${selected.join(", ")}. Each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread.`,
    },
  };
}

/**
 * The hand-off: the records first (a store without a durable Worker refuses by
 * name), then the instance, then the reply. A record already under the id is
 * left standing and its rows are not touched — they may be a live runner's
 * (its threads, rounds, pull requests and endings), and only the shim knows:
 * `duplicate_instance` refuses the request, `created` means the record was an
 * earlier attempt's whose create failed, and the runner picks it up.
 */
export async function handOffToCoordinator(deps: HandOffDeps, input: HandOffInput): Promise<HandOffOutcome> {
  const log = deps.log ?? console.log;
  const planned = await plan(deps, input);
  if (!planned.ok) return refused(planned.reply);
  const { instance, units, where } = planned.planned;
  const put = await deps.instances.put(instance);
  if (!put.ok && put.reason === "unavailable")
    return refused(
      "⚠️ The plan runner needs run history on the state Worker (`runHistory.worker`): the instance record could not be written, so nothing ran.",
    );
  const fresh = put.ok;
  if (fresh) {
    const rows = await deps.instances.putUnits(units);
    if (!rows.ok)
      return refused(
        "⚠️ The plan runner needs run history on the state Worker: the unit rows could not be written, so nothing ran.",
      );
  }
  let answer: CreateInstanceAnswer;
  try {
    answer = await deps.create(instance.id);
  } catch (err) {
    answer = { kind: "unanswered", reason: describe(err) };
  }
  switch (answer.kind) {
    case "created": {
      log(`[ship] ${input.msg.threadKey}: handed to the plan runner ${instance.id} (${units.length} unit(s))`);
      const kept = fresh
        ? ""
        : " The records of an earlier attempt stand: the runner reads its rows, and its card and run id are the plan's.";
      return { status: "completed", reply: `🧭 Handed to the plan runner \`${instance.id}\`: ${where}${kept}` };
    }
    case "duplicate": {
      const what = instance.plan ? `plan \`${instance.plan.id}\`` : "this request";
      const status = answer.status !== undefined ? `, status: ${answer.status}` : "";
      return refused(
        `🚫 A runner for ${what} already exists (\`${instance.id}\`${status}): a plan runs once under its id — rename the plan file to run it again.`,
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
