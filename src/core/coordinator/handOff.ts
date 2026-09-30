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

import { refusalOf, type Refusal, type RefusalCode } from "../refusal.js";
import { DEFAULT_GRANT, IDLE_DAYS_DEFAULT, type Grant, type GrantSource } from "../budgets.js";
import { DEFAULT_VERBOSITY, type Verbosity } from "../verbosity.js";
import { parsePlanUnit, PLAN_MAX_CHARS, unitTitleOf } from "../ship/contract.js";
import {
  DECISION_RECORD_STORE_REFUSAL,
  DecisionRecordReservationUnavailableError,
  asksForDecisionRecord,
  decisionRecordTaskKey,
} from "../decisionRecordReservation.js";
import type { ShipEntry, ShipEntryIntent } from "../ship/preflight.js";
import { shipTaskText, shipUnitText } from "../ship/preflight.js";
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
import {
  isMainTaskKey,
  isWorkBrief,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type MainTaskKey,
  type ThreadEventAttachment,
  type WorkBrief,
} from "./contract.js";
import type { CoordinatorInstanceStore, MainTaskLink } from "./instanceStore.js";
import { isMainTaskAuthority, sameMainTaskAuthority, type MainTaskAuthority } from "./requesterAuthority.js";
import type { CreateInstanceAnswer, InstanceStatusAnswer } from "./instancesRoute.js";
import { privateWorkerThreadKey, type PrivateWorkerLog } from "../privateWorkerLog.js";
import { generatedTaskAdmissionSource, generatedTaskOf, generatedTaskText } from "./generatedTask.js";

export type BeforeCoordinatorStart = () => Promise<
  | {
      ok: true;
      /** Transfer the reserved pull request to the durable attempt immediately
       * before its Workflow create. A refusal here starts no work. */
      commit: (owner: { instanceId: string; unit: string }) => Promise<void>;
      /** Mark the accepted Workflow as the owner so dispatch cleanup retains it. */
      complete: () => void;
      /** Restore the exact legacy row and release only this transition's owner. */
      abort: () => Promise<void>;
    }
  | { ok: false; refusal: Refusal }
>;

export interface HandOffInput {
  entry: ShipEntry;
  /** The request's directive-stripped text (the preflight's input). */
  requestText: string;
  /** The operator's validated first stage, when this request passed its door. */
  intent?: ShipEntryIntent;
  /** Attributed context from the actor-stamped session tail, for a terse
   * generated task only; never used to resolve the target or plan identity. */
  threadEvidence?: string;
  /** An inherited write must not spawn a child from `Fix it.` alone if the
   * source tail became unavailable between binding and hand-off. */
  requiresThreadEvidence?: boolean;
  /** An opt-in main-agent decision. Its key is stable across message retries;
   * the brief is context for the existing Ship unit, not publication authority. */
  mainTask?: MainTaskKey & {
    brief: Omit<WorkBrief, "requesterId" | "mainThreadKey" | "actId" | "repo" | "base">;
    authority?: MainTaskAuthority;
  };
  /** Set by the trusted caller only when the private worker log is configured. */
  privateWorkerReady?: boolean;
  /** A generated plan this thread already owns and is re-issuing. Internal:
   *  the dispatcher read it from the coordinator row, so formatting in the
   *  stored request can never mint a nearby but different plan id. */
  reissuePlanId?: string;
  /** A legacy continuation's last atomic gate. It runs only after planning,
   * attempt selection and every refusal gate succeeded, immediately before
   * records are written. Any later refusal aborts its provisional transition. */
  beforeStart?: BeforeCoordinatorStart;
  /** A main-agent run's liveness fence. Durable claim and Workflow creation
   * both check it after awaited preflight work; absent for ordinary Ship. */
  stillLive?: () => boolean;
  /** Main-agent only: checked after async setup and immediately before each durable start effect. */
  stillPrivate?: () => Promise<boolean>;
  msg: {
    channelId: string;
    channelName?: string;
    userId: string;
    userName?: string;
    authenticatedAs?: string;
    postedBy?: string;
    threadKey: string;
    sourceUrl?: string;
    /** Inline media the channel accepted on the ship request. A generated
     *  task seeds it onto its unit after that row is durable, so the first
     *  coding spawn receives the same bytes through the thread-event fold. */
    images?: ThreadEventAttachment[];
    documents?: ThreadEventAttachment[];
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
  /** The grant, resolved by the ship branch (directive count > user > channel >
   *  org) — written on the instance beside `merge`; absent (a caller without the
   *  config layers) is the default: zero renewals, no cap, the org's. */
  grant?: { grant: Grant; source: GrantSource };
  /** The request's verbosity (routing-and-config item 28), written on the
   *  instance so the runner's own thread messages speak at it; absent reads
   *  as `quiet`. */
  verbosity?: Verbosity;
  /** The idle flag, resolved by the ship branch (user > channel > org) —
   *  written on the instance beside the grant (record 0051); absent is zero:
   *  nothing idles. */
  idleDays?: number;
  /** The status card in the requesting thread, when the channel has one. */
  card?: { channel: string; ts: string };
  now: number;
}

function mainRunLiveAtGate(input: HandOffInput): boolean {
  if (input.mainTask === undefined) return input.stillLive?.() !== false;
  try {
    return input.stillLive?.() === true;
  } catch {
    return false;
  }
}

export interface HandOffDeps {
  /** The repository's file at a ref — the App's read, with the caller's bound
   *  on its length (`ReadFileOptions`): the plan is read whole up to
   *  `PLAN_MAX_CHARS`, and an answer still `truncated` is refused, never parsed. */
  readFile: (
    repo: string,
    path: string,
    ref: string,
    opts?: { maxChars?: number },
  ) => Promise<{ content: string; truncated?: boolean }>;
  instances: CoordinatorInstanceStore;
  /** The durable private conversation store, checked before a main task claims a unit. */
  privateWorkerLog?: PrivateWorkerLog;
  /** The shim's `POST /admin/coordinator/instances` for the id. */
  create: (id: string) => Promise<CreateInstanceAnswer>;
  /** The shim's `GET /admin/coordinator/instances/<id>`: whether an earlier attempt's instance still runs, ended, or never existed. */
  status: (id: string) => Promise<InstanceStatusAnswer>;
  /** Reserve one decision-record number for a stable task key. Production uses
   * origin/main plus every open pull request; injectable for admission tests. */
  reserveDecisionRecord?: (repo: string, taskKey: string, existing?: string) => Promise<string>;
  log?: (line: string) => void;
}

/** The ship outcome's shape, as the ship branch closes its card and replies from it. */
export interface HandOffOutcome {
  status: "completed" | "aborted";
  reply: string;
  /** The instance the hand-off created — a completed outcome's alone (record
   *  0051 R2): what the ship branch publishes as the run's `ship_handoff`. */
  instanceId?: string;
  /** An aborted hand-off's refusal (record 0054): the reply's own sentence
   *  with its code and cause; the ship branch renders it through the seam. */
  refusal?: Refusal;
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
  resume?: { pr: number; headSha: string; url?: string };
  /** The thread's open pull request a generated task adopts: round 0 runs on
   *  its head branch and the pre-check finds it (agent-ship item 10). */
  adopt?: { pr: number; headSha: string; url?: string };
  /** The entry's branch (an adopted or resumed pull request's head) overrides the graph's on the one generated unit. */
  entryBranch?: string;
  /** An ambiguously bound base ref the preflight found missing on the
   *  repository (agent-ship item 10, issue 1827): the entry fell back to the
   *  default branch, and the reply's first line names the fallback. */
  baseFallback?: { requested: string };
  /** The pull request's own auto-merge fact at entry (agent-ship item 9): named in the reply, never refused. */
  autoMergeEnabled?: boolean;
  /** Stable task keys for units whose own brief asks to write a decision record. */
  recordTasks?: Readonly<Record<string, string>>;
  workBrief?: WorkBrief;
  generatedTask?: NonNullable<CoordinatorUnit["generatedTask"]>;
  threadEvidence?: string;
};

const refused = (code: RefusalCode, reply: string): HandOffOutcome => ({
  status: "aborted",
  reply,
  refusal: refusalOf(code, reply),
});
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function privateAtGate(input: HandOffInput): Promise<boolean> {
  if (!input.stillPrivate) return true;
  try {
    return await input.stillPrivate();
  } catch {
    return false;
  }
}

async function privateWorkerLogReachable(deps: HandOffDeps, instanceId: string, unit: string): Promise<boolean> {
  if (deps.privateWorkerLog === undefined) return false;
  try {
    await deps.privateWorkerLog.list(privateWorkerThreadKey({ instanceId, unit }));
    return true;
  } catch {
    return false;
  }
}

async function requesterRevisionCurrent(
  deps: HandOffDeps,
  threadKey: string,
  authority: MainTaskAuthority,
): Promise<"current" | "newer" | "unavailable"> {
  try {
    const turn = await deps.instances.latestRequesterTurn({ threadKey, requesterId: authority.requesterId });
    return turn?.messageId === authority.sourceMessageId && turn.revision === authority.revision ? "current" : "newer";
  } catch {
    return "unavailable";
  }
}

/** The Workflow platform's words for an instance that has not ended. */
const RUNNING = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
const ENDED = new Set(["complete", "errored", "terminated"]);

async function plan(
  deps: HandOffDeps,
  input: HandOffInput,
): Promise<{ ok: true; planned: Planned } | { ok: false; reply: string; code: RefusalCode }> {
  const { entry, msg } = input;
  const base = entry.base;
  if (base === undefined)
    return {
      ok: false,
      code: "plan_base_unknown",
      reply: `🚫 The plan runner needs the pull request's base branch and no base branch is known for ${entry.repo}.`,
    };
  const identity: Identity = {
    kind: "ship",
    userId: msg.userId,
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
    ...(msg.postedBy !== undefined ? { postedBy: msg.postedBy } : {}),
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
    // Absent, nothing renews: zero renewals and no cap, the org's (decision 0046).
    grant: input.grant?.grant ?? DEFAULT_GRANT,
    grantSource: input.grant?.source ?? "org",
    // Absent, the runner speaks at the default: quiet (routing-and-config item 28).
    verbosity: input.verbosity ?? DEFAULT_VERBOSITY,
    // Absent, nothing idles: zero days, today's endings (record 0051).
    idleDays: input.idleDays ?? IDLE_DAYS_DEFAULT,
    ...(input.card !== undefined ? { card: input.card } : {}),
    // The main run answers while its worker continues. Giving that run to
    // the coordinator would let the worker finish overwrite the main answer.
    ...(input.mainTask === undefined ? { runId: input.runId } : {}),
    label: input.label,
  };
  // The probe (item 10): is there a task here at all? Never the unit's text.
  const taskText =
    input.intent === "review"
      ? ""
      : input.intent === "work" || input.intent === "work_from_thread"
        ? input.requestText.trim()
        : shipTaskText(input.requestText, entry.repo);
  // A main-agent act is always one generated, person-merged task. Its plain
  // prose may happen to begin with the spelling of a seeded plan request.
  const request =
    input.mainTask === undefined && input.intent !== "review" ? parseShipPlanRequest(taskText) : undefined;
  if (request === undefined) {
    // A generated plan of one unit (agent-ship item 16): the request text AS
    // WRITTEN is the unit — its urls included, which the probe strips — the id
    // is deterministic per (thread, text), the branch the graph's
    // `plan/<id>/u1` — the instance's absent `plan.path` is the mark that keeps
    // its unit in the requesting thread. Its merge is a person's, whatever the
    // request's words say.
    // A PR-only resume has no coding round; retain its historical plan key.
    // This text never becomes a child task.
    const text = taskText
      ? shipUnitText(input.requestText, entry.repo)
      : entry.resume !== undefined
        ? "Implement the task this thread's ship request describes."
        : "";
    if (text.length === 0 && input.mainTask === undefined && entry.resume === undefined)
      return {
        ok: false,
        code: "setup_failed",
        reply: "🚫 The Ship request has no task to checkpoint; no worker started.",
      };
    if (text.length > 100_000)
      return {
        ok: false,
        code: "setup_failed",
        reply: "🚫 The Ship request is too long to checkpoint; no worker started.",
      };
    const planId =
      input.mainTask !== undefined
        ? generatedPlanId(text, `${input.mainTask.mainThreadKey}:${input.mainTask.actId}`)
        : (input.reissuePlanId ?? generatedPlanId(text, msg.threadKey));
    const workBrief =
      input.mainTask !== undefined
        ? {
            ...input.mainTask.brief,
            requesterId: msg.userId,
            mainThreadKey: input.mainTask.mainThreadKey,
            actId: input.mainTask.actId,
            repo: entry.repo,
            base,
          }
        : undefined;
    if (workBrief !== undefined && !isWorkBrief(workBrief))
      return {
        ok: false,
        code: "setup_failed",
        reply: "🚫 The main agent's work brief is invalid or too long; no worker started.",
      };
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
        ...(workBrief !== undefined ? { workBrief } : {}),
        ...(workBrief === undefined && entry.resume === undefined
          ? {
              generatedTask: generatedTaskOf(text, {
                requesterId: msg.userId,
                threadKey: msg.threadKey,
                runId: input.runId,
                repo: entry.repo,
                ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
              }),
            }
          : {}),
        ...(input.threadEvidence !== undefined && input.threadEvidence.length <= 6_000
          ? { threadEvidence: input.threadEvidence }
          : {}),
        ...(entry.resume !== undefined ? { resume: entry.resume } : {}),
        ...(entry.adopt !== undefined ? { adopt: entry.adopt } : {}),
        ...(entry.branch !== undefined ? { entryBranch: entry.branch } : {}),
        ...(entry.autoMergeEnabled !== undefined ? { autoMergeEnabled: entry.autoMergeEnabled } : {}),
        ...(entry.baseFallback !== undefined ? { baseFallback: entry.baseFallback } : {}),
        ...(asksForDecisionRecord(text)
          ? { recordTasks: { [graph.units[0]!.id]: decisionRecordTaskKey(entry.repo, msg.threadKey, text.trim()) } }
          : {}),
      },
    };
  }
  if (input.mainTask !== undefined)
    return {
      ok: false,
      code: "setup_failed",
      reply: "🚫 A main-agent work brief needs one generated task; a seeded plan cannot use this hand-off.",
    };
  // The routed guard (agent-ship item 16; routing-and-config items 21 and 29):
  // A seeded plan's units merge under the runner's grant, so only the
  // explicit `agent:ship` request may start one. The operator's plan stage
  // reaches here only after dispatch checked that request and preflight
  // validated the plan form.
  if (input.agentSource === "route" || (input.agentSource === "operator" && entry.plan !== true))
    return {
      ok: false,
      code: "plan_routed_seed",
      reply: `🚫 A routed or operator-bound request never runs a seeded plan — its units would merge under the runner's grant. Type \`agent:ship plan ${request.planPath}\` to run it.`,
    };
  let planId: string;
  try {
    planId = planIdOf(request.planPath);
  } catch (err) {
    return { ok: false, code: "plan_id_invalid", reply: `🚫 ${describe(err)}` };
  }
  let text: string;
  try {
    const file = await deps.readFile(entry.repo, request.planPath, base, { maxChars: PLAN_MAX_CHARS });
    if (file.truncated === true)
      return {
        ok: false,
        code: "plan_unreadable",
        reply: `🚫 The plan \`${request.planPath}\` is longer than ${PLAN_MAX_CHARS.toLocaleString("en-US")} characters at \`${base}\` in ${entry.repo}; its later units would be lost, so nothing was run — split the plan.`,
      };
    text = file.content;
  } catch (err) {
    return {
      ok: false,
      code: "plan_unreadable",
      reply: `🚫 The plan \`${request.planPath}\` could not be read at \`${base}\` in ${entry.repo}: ${describe(err)}`,
    };
  }
  const graph = parsePlanGraph(text, planId);
  if (graph.units.length === 0)
    return {
      ok: false,
      code: "plan_no_units",
      reply: `🚫 The plan \`${request.planPath}\` has no unit headings (\`### U<n>. <title>\`) — nothing to run.`,
    };
  let selected: string[];
  try {
    selected = openPlanCursor(graph, request.units).order;
  } catch (err) {
    return { ok: false, code: "plan_units_unknown", reply: `🚫 ${describe(err)}` };
  }
  return {
    ok: true,
    planned: {
      planId,
      path: request.planPath,
      base,
      graph,
      selected,
      identity,
      merge: "runner",
      ...(entry.baseFallback !== undefined ? { baseFallback: entry.baseFallback } : {}),
      recordTasks: Object.fromEntries(
        graph.units.flatMap((unit) => {
          const section = parsePlanUnit(text, unit.id)?.section ?? "";
          return asksForDecisionRecord(section)
            ? [[unit.id, decisionRecordTaskKey(entry.repo, msg.threadKey, section.trim())]]
            : [];
        }),
      ),
    },
  };
}

/** The rows of a plan's selected units under an instance, as the plan states
 *  them; a generated plan's one unit takes the entry's branch when the entry
 *  resumed, and the resume rides its row. */
async function rowsFor(
  deps: HandOffDeps,
  p: Planned,
  selected: readonly string[],
  instanceId: string,
  carried?: ReadonlyMap<
    string,
    {
      lastPush?: string;
      record?: string;
      generatedTask?: CoordinatorUnit["generatedTask"];
      threadEvidence?: string;
    }
  >,
): Promise<CoordinatorUnit[]> {
  const reserve = deps.reserveDecisionRecord ?? (() => Promise.reject(new DecisionRecordReservationUnavailableError()));
  return Promise.all(
    p.graph.units
      .filter((u) => selected.includes(u.id))
      .map(async (u) => {
        const previous = carried?.get(u.id);
        const taskKey = p.recordTasks?.[u.id];
        const record =
          taskKey !== undefined ? await reserve(p.identity.repo, taskKey, previous?.record) : previous?.record;
        const branch = p.entryBranch ?? u.branch;
        const existing = p.adopt ?? p.resume;
        const publication =
          existing !== undefined && p.entryBranch !== undefined
            ? {
                repo: p.identity.repo,
                pr: existing.pr,
                headRef: p.entryBranch,
                baseRef: p.base,
                expectedHeadSha: existing.headSha,
                publicationRef: p.entryBranch,
                owner: { instanceId, unit: u.id },
              }
            : undefined;
        return {
          instanceId,
          unit: u.id,
          slug: u.slug,
          title: u.title,
          branch,
          dependsOn: u.dependsOn,
          ...(p.workBrief !== undefined ? { workBrief: p.workBrief } : {}),
          ...((previous === undefined ? p.generatedTask : previous.generatedTask) !== undefined
            ? { generatedTask: previous === undefined ? p.generatedTask : previous.generatedTask }
            : {}),
          ...((previous?.threadEvidence ?? p.threadEvidence) !== undefined
            ? { threadEvidence: previous?.threadEvidence ?? p.threadEvidence }
            : {}),
          rounds: [],
          ...(p.resume !== undefined ? { resume: p.resume } : {}),
          ...(publication !== undefined ? { publication } : {}),
          ...(previous?.lastPush !== undefined ? { lastPush: previous.lastPush } : {}),
          ...(record !== undefined ? { record } : {}),
        };
      }),
  );
}

/** The reply's account of where a plan runs, one bullet per fact: the plan,
 *  the units, and where each runs — this thread for a generated plan, a
 *  thread of its own for a seeded one. Short lines a person reads at a
 *  glance, never one sentence carrying every id. */
function planWhere(
  p: Planned,
  units: readonly CoordinatorUnit[],
  mergedBefore: readonly string[],
  /** A later attempt of the same plan: named on the first line (`attempt 2 of plan …`). */
  attempt?: number,
): string[] {
  const at = p.path !== undefined ? ` (\`${p.path}\` at \`${p.base}\`)` : "";
  const count = `${units.length} unit${units.length === 1 ? "" : "s"}`;
  const left = mergedBefore.length > 0 ? ` left` : "";
  // The base fallback is the FIRST line's fact (issue 1827): the person's
  // "on <token>" bound a ref the repository does not have, and the card says
  // so before anything else — the run is on the default branch, not on it.
  const fellBack =
    p.baseFallback !== undefined
      ? ` — \`${p.baseFallback.requested}\` is not a branch of the repository, so the plan runs on the default branch \`${p.base}\``
      : "";
  const lines = [`${attempt !== undefined ? `attempt ${attempt} of ` : ""}plan \`${p.planId}\`${at}${fellBack}`];
  if (p.path !== undefined) {
    lines.push(`${count}${left} in dependency order: ${units.map((u) => u.unit).join(", ")}`);
    if (mergedBefore.length > 0) lines.push(`merged before: ${mergedBefore.join(", ")}`);
    // The thread choice keys on the unit count (agent-ship item 16): a one-unit
    // plan's unit runs in the requesting thread and `finish` posts no summary
    // there, so its reply takes the task path's "in this thread" wording.
    lines.push(
      units.length === 1
        ? `the unit runs on \`${units[0]?.branch ?? ""}\` in this thread under your grants; this card follows the plan and its report lands here`
        : "each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread",
    );
    return lines;
  }
  const branch = units[0]?.branch ?? "";
  if (p.workBrief !== undefined) {
    lines.push(
      `the coding worker runs privately on \`${branch}\` under your grants; its progress and report stay in a private work log`,
    );
    return lines;
  }
  const url = (of: { pr: number; url?: string } | undefined) =>
    of?.url ?? (of !== undefined ? `https://github.com/${p.identity.repo}/pull/${of.pr}` : undefined);
  const runs =
    p.resume !== undefined
      ? `the review loop of ${url(p.resume)} resumes at its next review round on \`${branch}\` in this thread under your grants — no new coding round first`
      : p.adopt !== undefined
        ? `the unit adopts ${url(p.adopt)}: it runs on \`${branch}\` — the pull request's own head — in this thread under your grants, no new branch`
        : `the unit runs on \`${branch}\` in this thread under your grants`;
  lines.push(`${runs}; this card follows it and the report lands here`);
  // The pull request's own auto-merge fact, named at entry (agent-ship item 9).
  if (p.autoMergeEnabled) lines.push("auto-merge is on for this pull request: the approval merges it once checks pass");
  return lines;
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
  if (input.mainTask !== undefined && !isMainTaskAuthority(input.mainTask.authority))
    return refused("setup_failed", "I couldn't verify the request that started this work; no worker started.");
  if (input.mainTask !== undefined && (!input.privateWorkerReady || input.stillPrivate === undefined))
    return refused("setup_failed", "⚠️ The private worker conversation is unavailable; no worker started.");
  if (input.mainTask !== undefined && !mainRunLiveAtGate(input))
    return refused("setup_failed", "The main run stopped or could not be verified; no worker started.");
  try {
    return await handOffToCoordinatorUnchecked(deps, input);
  } catch (error) {
    if (error instanceof DecisionRecordReservationUnavailableError)
      return refused("decision_record_store_unavailable", DECISION_RECORD_STORE_REFUSAL);
    throw error;
  }
}

async function handOffToCoordinatorUnchecked(deps: HandOffDeps, input: HandOffInput): Promise<HandOffOutcome> {
  const log = deps.log ?? console.log;
  if (input.requiresThreadEvidence && !input.threadEvidence)
    return refused(
      "plan_history_unavailable",
      "⚠️ The earlier thread context could not be verified; no fix worker started.",
    );
  if (input.mainTask !== undefined) {
    if (!isMainTaskKey(input.mainTask))
      return refused("setup_failed", "🚫 The main agent's act id or thread key is invalid; no worker started.");
    if (input.mainTask.mainThreadKey !== input.msg.threadKey)
      return refused("setup_failed", "🚫 The main task must come from its own conversation; no worker started.");
    if (
      input.beforeStart !== undefined ||
      input.entry.resume !== undefined ||
      input.entry.adopt !== undefined ||
      input.entry.branch !== undefined ||
      (input.msg.images?.length ?? 0) > 0 ||
      (input.msg.documents?.length ?? 0) > 0
    )
      return refused(
        "setup_failed",
        "🚫 This main-agent hand-off accepts a fresh task and linked text evidence only; no worker started.",
      );
    let link;
    try {
      link = await deps.instances.getMainTask(input.mainTask);
    } catch (err) {
      return refused(
        "plan_history_unavailable",
        `⚠️ The main task link could not be read (${describe(err)}); no worker started.`,
      );
    }
    if (link !== null) return linkedTask(deps, input, link);
  }
  const planned = await plan(deps, input);
  if (!planned.ok) return refused(planned.code, planned.reply);
  let p = planned.planned;
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
    const units = await rowsFor(deps, p, p.selected, firstId);
    const instance: CoordinatorInstance = {
      id: firstId,
      ...p.identity,
      ...(p.generatedTask !== undefined ? { generatedTask: p.generatedTask } : {}),
      ...(p.generatedTask !== undefined
        ? {
            generatedTaskSource: {
              runId: p.generatedTask.source.runId,
              ...(p.generatedTask.source.sourceUrl !== undefined
                ? { sourceUrl: p.generatedTask.source.sourceUrl }
                : {}),
            },
          }
        : {}),
      branch: units[0]!.branch,
      plan: planOf(),
      merge: p.merge,
    };
    return start(deps, input, instance, units, planWhere(p, units, []), "put");
  }
  if (input.mainTask !== undefined)
    return refused(
      "plan_runner_conflict",
      `🚫 The main task's instance id is already taken without its act link; no new attempt started.`,
    );
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
      "plan_runner_state_unknown",
      `⚠️ This is a bug: the plan runner could not tell whether \`${latest.id}\` still runs (${status.reason}), so nothing ran and no automatic state retry was scheduled.`,
    );
  if (status.kind === "status" && RUNNING.has(status.status))
    return refused(
      "plan_runner_live",
      `🚫 A runner for ${where} is still running (\`${latest.id}\`, status: ${status.status}), so this request started no second runner.`,
    );
  if (status.kind === "status" && !ENDED.has(status.status))
    return refused(
      "plan_runner_state_unread",
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
  const carried = new Map<
    string,
    {
      lastPush?: string;
      record?: string;
      generatedTask?: CoordinatorUnit["generatedTask"];
      threadEvidence?: string;
    }
  >();
  const priorRows: CoordinatorUnit[] = [];
  for (let n = 1; n <= attempt; n++)
    for (const row of await deps.instances.listUnits(planInstanceId(p.planId, n))) {
      priorRows.push(row);
      if (row.ending?.kind === "merged") merged.add(row.unit);
      const prior = carried.get(row.unit) ?? {};
      carried.set(row.unit, {
        ...prior,
        ...(row.lastPush !== undefined ? { lastPush: row.lastPush } : {}),
        ...(row.record !== undefined ? { record: row.record } : {}),
        ...(row.generatedTask !== undefined ? { generatedTask: row.generatedTask } : {}),
        ...(row.threadEvidence !== undefined ? { threadEvidence: row.threadEvidence } : {}),
      });
    }
  // An earlier generated unit is the branch authority for the same plan. A
  // later request can inherit a PR merely because it was mentioned in this
  // thread; that PR cannot move a re-issued unit onto another branch. If a
  // prior attempt actually worked on another branch, stop for inspection
  // even when this request carries no PR branch.
  const originalUnit = p.graph.units[0];
  const firstRows = priorRows.filter((row) => row.instanceId === firstId);
  // Older one-unit records may use a different unit id; the recovered row is
  // still the authority when it is the first instance's only unit.
  const original =
    firstRows.find((row) => row.unit === originalUnit?.id) ?? (firstRows.length === 1 ? firstRows[0] : undefined);
  const originalTaskSource = generatedTaskAdmissionSource(first);
  const originalTask = original?.generatedTask ?? (firstRows.length === 0 ? first.generatedTask : undefined);
  const legacyBoundPr =
    original?.generatedTask === undefined &&
    first.generatedTask === undefined &&
    original?.pr !== undefined &&
    (original.publication !== undefined || original.ending?.kind === "merge_ready") &&
    (p.adopt?.pr === original.pr.number || p.resume?.pr === original.pr.number);
  if (
    !legacyBoundPr &&
    (p.generatedTask !== undefined ||
      original?.generatedTask !== undefined ||
      first.generatedTask !== undefined ||
      first.generatedTaskSource !== undefined)
  ) {
    let taskValid = originalTaskSource !== undefined;
    try {
      if (taskValid) {
        const text = generatedTaskText(originalTask, first);
        taskValid = first.generatedTask === undefined || generatedTaskText(first.generatedTask, first) === text;
      }
    } catch {
      taskValid = false;
    }
    if (!taskValid)
      return refused(
        "plan_history_unavailable",
        `🚫 The original task checkpoint of ${where} cannot be verified, so no runner started.`,
      );
  }
  if (firstRows.length === 0 && originalTask !== undefined && originalUnit !== undefined)
    carried.set(originalUnit.id, { ...carried.get(originalUnit.id), generatedTask: originalTask });
  if (
    p.path === undefined &&
    original !== undefined &&
    originalUnit !== undefined &&
    original.unit !== originalUnit.id
  ) {
    carried.set(originalUnit.id, { ...carried.get(original.unit), ...carried.get(originalUnit.id) });
    if (merged.has(original.unit)) merged.add(originalUnit.id);
  }
  const replacingMissingFirst =
    p.path === undefined &&
    original === undefined &&
    firstRows.length === 0 &&
    priorRows.length === 0 &&
    attempt === 1 &&
    status.kind === "absent" &&
    first.branch === originalUnit?.branch;
  if (
    p.path === undefined &&
    (first.plan?.id !== p.planId ||
      first.plan.path !== undefined ||
      first.repo !== p.identity.repo ||
      first.threadKey !== input.msg.threadKey ||
      first.base === undefined ||
      (original?.branch !== first.branch && !replacingMissingFirst))
  )
    return refused(
      "plan_runner_conflict",
      `🚫 The earlier unit of ${where} does not match this request's repository, conversation, or branch; no runner started.`,
    );
  const unitRows = priorRows.filter((row) => row.unit === original?.unit || row.unit === originalUnit?.id);
  if (
    p.path === undefined &&
    unitRows.some(
      (row) =>
        row.branch !== first.branch && (row.lastPush !== undefined || row.pr !== undefined || row.rounds.length > 0),
    )
  )
    return refused(
      "plan_runner_conflict",
      `🚫 The earlier unit of ${where} owns \`${first.branch}\`, but a prior attempt recorded work on another branch; the branch history cannot be reconciled, so no runner started.`,
    );
  // A PR can first appear in any attempt. Keep its identity when a later
  // request loses the entry PR or picks another one; older rows with only a
  // PR number are recovered by the caller after the hand-off.
  const priorPrs = new Set<number>();
  for (const row of unitRows) {
    if (row.pr !== undefined) priorPrs.add(row.pr.number);
    if (row.publication !== undefined) priorPrs.add(row.publication.pr);
    if (row.resume !== undefined) priorPrs.add(row.resume.pr);
  }
  const priorPr = [...priorPrs][0];
  const badPublication = unitRows.some(
    (row) =>
      row.publication !== undefined &&
      (row.publication.repo !== first.repo ||
        row.publication.headRef !== first.branch ||
        row.publication.baseRef !== first.base ||
        row.publication.owner.instanceId !== row.instanceId ||
        row.publication.owner.unit !== row.unit),
  );
  if (
    p.path === undefined &&
    (priorPrs.size > 1 ||
      badPublication ||
      (priorPr !== undefined &&
        (p.entryBranch !== first.branch || p.base !== first.base || (p.adopt ?? p.resume)?.pr !== priorPr)) ||
      (priorPr === undefined && first.branch !== originalUnit?.branch))
  )
    return refused(
      "plan_runner_conflict",
      `🚫 The earlier unit of ${where} owns a pull request on \`${first.branch}\`, but this retry cannot preserve that publication binding; no runner started.`,
    );
  if (p.path === undefined && p.entryBranch !== undefined && p.entryBranch !== first.branch) {
    const originalBranch = originalUnit?.branch;
    if (
      first.plan?.id !== p.planId ||
      first.plan.path !== undefined ||
      first.repo !== p.identity.repo ||
      first.threadKey !== input.msg.threadKey ||
      first.branch !== originalBranch ||
      (original?.branch !== first.branch && !replacingMissingFirst) ||
      original?.pr !== undefined ||
      original?.publication !== undefined ||
      original?.resume !== undefined ||
      first.base === undefined
    )
      return refused(
        "plan_runner_conflict",
        `🚫 The earlier unit of ${where} owns \`${first.branch}\`, but this retry selected \`${p.entryBranch}\`; the branch history cannot be reconciled, so no runner started.`,
      );
    const {
      entryBranch: _entryBranch,
      adopt: _adopt,
      resume: _resume,
      autoMergeEnabled: _autoMergeEnabled,
      baseFallback: _baseFallback,
      ...originalPlan
    } = p;
    p = { ...originalPlan, base: first.base, identity: { ...originalPlan.identity, base: first.base } };
  }
  if (p.path === undefined && p.base !== first.base) {
    if (first.base === undefined)
      return refused(
        "plan_runner_conflict",
        `🚫 The earlier unit of ${where} has no recorded base; no runner started.`,
      );
    if (p.entryBranch !== undefined && (p.adopt !== undefined || p.resume !== undefined))
      return refused(
        "plan_runner_conflict",
        `🚫 The earlier unit of ${where} owns base \`${first.base}\`, but this pull request now targets \`${p.base}\`; no runner started.`,
      );
    p = { ...p, base: first.base, identity: { ...p.identity, base: first.base } };
  }
  const remaining = p.selected.filter((u) => !merged.has(u));
  if (remaining.length === 0)
    return refused(
      "plan_units_merged",
      `🚫 Every unit of ${where} this request names is merged already (${p.selected.join(", ")}) — nothing left to run.`,
    );
  const mergedBefore = p.selected.filter((u) => merged.has(u));
  if (status.kind === "absent") {
    // The latest attempt's create failed after its records were written: the
    // records are this request's to replace, under the same id and attempt.
    const units = await rowsFor(deps, p, remaining, latest.id, carried);
    const instance: CoordinatorInstance = {
      id: latest.id,
      ...p.identity,
      ...(p.path === undefined &&
      latest.id === first.id &&
      originalTask !== undefined &&
      originalTaskSource !== undefined
        ? { runId: originalTaskSource.runId, sourceUrl: originalTaskSource.sourceUrl }
        : {}),
      ...(first.generatedTask !== undefined ? { generatedTask: first.generatedTask } : {}),
      ...(originalTaskSource !== undefined ? { generatedTaskSource: originalTaskSource } : {}),
      branch: units[0]!.branch,
      plan: planOf(),
      merge: p.merge,
      ...(attempt > 1 ? { attempt } : {}),
    };
    log(`[ship] ${input.msg.threadKey}: ${latest.id} has records but no instance — replacing the earlier attempt's`);
    return start(
      deps,
      input,
      instance,
      units,
      planWhere(p, units, mergedBefore, attempt > 1 ? attempt : undefined),
      "replace",
    );
  }
  // Ended: the next attempt reruns what the earlier attempts did not merge.
  const nextId = planInstanceId(p.planId, attempt + 1);
  const units = await rowsFor(deps, p, remaining, nextId, carried);
  const instance: CoordinatorInstance = {
    id: nextId,
    ...p.identity,
    ...(originalTaskSource !== undefined ? { generatedTaskSource: originalTaskSource } : {}),
    branch: units[0]!.branch,
    plan: planOf(),
    merge: p.merge,
    attempt: attempt + 1,
  };
  return start(deps, input, instance, units, planWhere(p, units, mergedBefore, attempt + 1), "put");
}

/** A replay reads the original authority and, only when the Workflow is
 * absent, retries create under its original id. It never plans a new attempt. */
async function linkedTask(deps: HandOffDeps, input: HandOffInput, link: MainTaskLink): Promise<HandOffOutcome> {
  let instance: CoordinatorInstance | null;
  let unit: CoordinatorUnit | undefined;
  try {
    instance = await deps.instances.get(link.instanceId);
    unit = (await deps.instances.listUnits(link.instanceId)).find((row) => row.unit === link.unit);
  } catch (err) {
    return refused(
      "plan_history_unavailable",
      `⚠️ The linked unit could not be read (${describe(err)}); no worker started.`,
    );
  }
  const brief = unit?.workBrief;
  const key = input.mainTask;
  if (
    instance === null ||
    unit === undefined ||
    brief === undefined ||
    key === undefined ||
    brief.mainThreadKey !== key.mainThreadKey ||
    brief.actId !== key.actId ||
    brief.requesterId !== input.msg.userId ||
    instance.threadKey !== key.mainThreadKey ||
    brief.repo !== instance.repo ||
    brief.base !== instance.base ||
    key.authority === undefined ||
    !sameMainTaskAuthority(link.authority, key.authority) ||
    instance.repo !== input.entry.repo ||
    instance.base !== input.entry.base
  )
    return refused(
      "plan_runner_conflict",
      "🚫 The main task link does not match its original unit, requester or target; no worker started.",
    );
  let answer: InstanceStatusAnswer;
  try {
    answer = await deps.status(instance.id);
  } catch (err) {
    answer = { kind: "unanswered", reason: describe(err) };
  }
  if (answer.kind === "unanswered")
    return refused(
      "plan_runner_state_unknown",
      `⚠️ The linked worker's state could not be read (${answer.reason}); no new worker started.`,
    );
  if (answer.kind === "absent") {
    const revision = await requesterRevisionCurrent(deps, key.mainThreadKey, key.authority!);
    if (revision === "unavailable")
      return refused(
        "plan_history_unavailable",
        "I couldn't verify the request for this saved worker; no worker started.",
      );
    if (revision === "newer")
      return refused("setup_failed", "A newer request arrived before this worker started; no worker started.");
    if (!mainRunLiveAtGate(input))
      return refused("setup_failed", "The main run stopped; its linked worker was not started.");
    if (!(await privateAtGate(input)))
      return refused("setup_failed", "This is no longer a private conversation; no worker started.");
    if (!(await privateWorkerLogReachable(deps, instance.id, unit.unit)))
      return refused("setup_failed", "The private worker conversation could not be verified; no worker started.");
    if (!(await privateAtGate(input)))
      return refused("setup_failed", "This is no longer a private conversation; no worker started.");
    if (!mainRunLiveAtGate(input))
      return refused("setup_failed", "The main run stopped; its linked worker was not started.");
    const finalRevision = await requesterRevisionCurrent(deps, key.mainThreadKey, key.authority!);
    if (finalRevision === "unavailable")
      return refused(
        "plan_history_unavailable",
        "I couldn't verify the request for this saved worker; no worker started.",
      );
    if (finalRevision === "newer")
      return refused("setup_failed", "A newer request arrived before this worker started; no worker started.");
    if (!mainRunLiveAtGate(input))
      return refused("setup_failed", "The main run stopped; its linked worker was not started.");
    let created: CreateInstanceAnswer;
    try {
      created = await deps.create(instance.id);
    } catch (err) {
      created = { kind: "unanswered", reason: describe(err) };
    }
    if (created.kind === "created" || created.kind === "duplicate")
      return {
        status: "completed",
        instanceId: instance.id,
        reply: `🧭 This main-agent act keeps its original unit ${instance.id}:${unit.unit}; the runner was retried under the same id.`,
      };
    return refused(
      "plan_start_failed",
      `⚠️ The linked worker could not be started (${created.reason}); its original unit is preserved for recovery.`,
    );
  }
  if (!RUNNING.has(answer.status) && !ENDED.has(answer.status))
    return refused(
      "plan_runner_state_unread",
      `🚫 The linked runner is in an unread state (${answer.status}); no worker started.`,
    );
  return {
    status: "completed",
    instanceId: instance.id,
    reply: `🧭 This main-agent act already owns unit ${instance.id}:${unit.unit} (runner: ${answer.status}).`,
  };
}

/** The records, then the instance, then the reply. */
async function start(
  deps: HandOffDeps,
  input: HandOffInput,
  instance: CoordinatorInstance,
  units: CoordinatorUnit[],
  where: readonly string[],
  write: "put" | "replace",
): Promise<HandOffOutcome> {
  const log = deps.log ?? console.log;
  const reservation = await input.beforeStart?.();
  if (reservation?.ok === false)
    return { status: "aborted", reply: reservation.refusal.text, refusal: reservation.refusal };
  let started = false;
  try {
    let mainClaim;
    if (!mainRunLiveAtGate(input)) return refused("setup_failed", "The main run stopped; no worker started.");
    if (!(await privateAtGate(input)))
      return refused("setup_failed", "This is no longer a private conversation; no worker started.");
    if (!mainRunLiveAtGate(input)) return refused("setup_failed", "The main run stopped; no worker started.");
    if (input.mainTask !== undefined) {
      const unit = units[0];
      if (unit === undefined || !(await privateWorkerLogReachable(deps, instance.id, unit.unit)))
        return refused("setup_failed", "The private worker conversation could not be verified; no worker started.");
      if (!mainRunLiveAtGate(input)) return refused("setup_failed", "The main run stopped; no worker started.");
      if (!(await privateAtGate(input)))
        return refused("setup_failed", "This is no longer a private conversation; no worker started.");
    }
    try {
      mainClaim =
        input.mainTask !== undefined
          ? await deps.instances.claimMainTask(input.mainTask, instance, units[0]!, input.mainTask.authority!)
          : undefined;
    } catch (err) {
      return refused(
        "plan_history_unavailable",
        `⚠️ The main task could not be recorded on the state Worker (${describe(err)}); no worker started.`,
      );
    }
    if (mainClaim?.ok === true && !mainClaim.created) return linkedTask(deps, input, mainClaim.link);
    if (mainClaim?.ok === false)
      return refused(
        mainClaim.reason === "unavailable" ? "plan_history_unavailable" : "plan_runner_conflict",
        mainClaim.reason === "unavailable"
          ? "⚠️ The main task could not be recorded on the state Worker; no worker started."
          : "🚫 This main task's instance id is already owned by another unit; no worker started.",
      );
    const put =
      mainClaim !== undefined
        ? { ok: true as const }
        : write === "replace"
          ? await deps.instances.replace(instance)
          : await deps.instances.put(instance);
    if (!put.ok) {
      if (put.reason === "unavailable")
        return refused(
          "plan_history_unavailable",
          "⚠️ The plan runner needs run history on the state Worker (`runHistory.worker`): the instance record could not be written, so nothing ran.",
        );
      // Another record took the id between the read and the write: a race two
      // requesters lose together — neither touches what is there.
      return refused(
        "plan_runner_conflict",
        `🚫 A runner for \`${instance.id}\` was just recorded by another request, so this request started nothing; the recorded runner owns the pipeline.`,
      );
    }
    const rows = mainClaim !== undefined ? { ok: true as const } : await deps.instances.putUnits(units);
    if (!rows.ok)
      return refused(
        "plan_history_unavailable",
        "⚠️ The plan runner needs run history on the state Worker: the unit rows could not be written, so nothing ran.",
      );
    // A generated task's accepted inline media enters the same durable event
    // list as a later thread reply. The unit row exists first, and the Workflow
    // starts only after the append, so its first coding spawn can fold the bytes.
    // `appendEvent` deduplicates the stable id: a re-issue after create failed
    // cannot make the retry stage the same file twice. Seeded plans do not copy
    // one request's media onto several independent units.
    const accepted = [...(input.msg.images ?? []), ...(input.msg.documents ?? [])];
    if (instance.plan?.path === undefined && accepted.length > 0) {
      const unit = units[0]!;
      const seeded = await deps.instances.appendEvent(
        { instanceId: instance.id, unit: unit.unit },
        {
          id: `${instance.id}:${unit.unit}:ship-request`,
          sender: input.msg.userId,
          ...(input.msg.userName !== undefined ? { senderName: input.msg.userName } : {}),
          text: "Attachments from the ship request.",
          attachments: accepted,
          mode: "steer",
          at: input.now,
        },
      );
      if (!seeded.ok)
        return refused(
          "plan_history_unavailable",
          "⚠️ The plan runner needs run history on the state Worker: the ship request's attachments could not be written, so nothing ran.",
        );
    }
    if (reservation?.ok === true) {
      const unit = units[0];
      if (unit === undefined)
        return refused(
          "setup_failed",
          "⚠️ The plan runner had no durable unit to own at its final start gate, so nothing ran.",
        );
      try {
        // Commit process-local ownership only after every durable row and
        // attachment gate passed, but before Workflow create can start work.
        await reservation.commit({ instanceId: instance.id, unit: unit.unit });
      } catch (err) {
        return refused(
          "setup_failed",
          `⚠️ The plan runner could not transfer existing-pull-request ownership to its new attempt (${describe(err)}), so nothing ran.`,
        );
      }
    }
    let answer: CreateInstanceAnswer;
    if (!mainRunLiveAtGate(input))
      return refused("setup_failed", "The main run stopped; its task is saved for a safe retry.");
    if (!(await privateAtGate(input)))
      return refused("setup_failed", "This is no longer a private conversation; its task is saved for a safe retry.");
    if (input.mainTask !== undefined && !(await privateWorkerLogReachable(deps, instance.id, units[0]!.unit)))
      return refused("setup_failed", "The private worker conversation could not be verified; no worker started.");
    if (!(await privateAtGate(input)))
      return refused("setup_failed", "This is no longer a private conversation; its task is saved for a safe retry.");
    if (!mainRunLiveAtGate(input))
      return refused("setup_failed", "The main run stopped; its task is saved for a safe retry.");
    if (input.mainTask !== undefined) {
      const revision = await requesterRevisionCurrent(deps, input.mainTask.mainThreadKey, input.mainTask.authority!);
      if (revision === "unavailable")
        return refused(
          "plan_history_unavailable",
          "I couldn't verify this request; its task is saved for a safe retry.",
        );
      if (revision === "newer")
        return refused("setup_failed", "A newer request arrived before this worker started; no worker started.");
    }
    if (!mainRunLiveAtGate(input))
      return refused("setup_failed", "The main run stopped; its task is saved for a safe retry.");
    try {
      answer = await deps.create(instance.id);
    } catch (err) {
      answer = { kind: "unanswered", reason: describe(err) };
    }
    switch (answer.kind) {
      case "created": {
        // The Workflow and its durable attempt now agree on the same owner.
        // Cleanup must retain that owner across any later reply/card failure.
        if (reservation?.ok === true) reservation.complete();
        started = true;
        log(`[ship] ${input.msg.threadKey}: handed to the plan runner ${instance.id} (${units.length} unit(s))`);
        const replaced =
          write === "replace" ? ["the records of an earlier attempt that never started were replaced"] : [];
        return {
          status: "completed",
          reply: handedOff([...where, ...replaced]),
          instanceId: instance.id,
        };
      }
      case "duplicate": {
        // The platform holds an instance the state Worker has no record of — a
        // store wiped or restored — so neither side can be trusted to resume.
        const status = answer.status !== undefined ? `, status: ${answer.status}` : "";
        return refused(
          "plan_instance_orphaned",
          `🚫 A Workflow instance \`${instance.id}\` already exists on the platform${status} but the state Worker knew nothing of it — a person decides; re-issuing will not resume it.`,
        );
      }
      case "failed":
      case "unanswered":
        log(`[ship] ${input.msg.threadKey}: the plan runner ${instance.id} could not be started — ${answer.reason}`);
        return refused(
          "plan_start_failed",
          `⚠️ This is a bug: the plan runner could not be started (${answer.reason}), nothing ran, and no automatic start retry was scheduled.`,
        );
    }
    const unreachable: never = answer;
    return unreachable;
  } finally {
    if (!started && reservation?.ok === true) await reservation.abort();
  }
}

/** The accepted hand-off's reply (routing-and-config item 28, `verbose`
 *  material): the headline, then one bullet per fact of `planWhere`. */
export function handedOff(facts: readonly string[]): string {
  return ["🧭 Handed to the plan runner.", ...facts.map((f) => `• ${f}`)].join("\n");
}
