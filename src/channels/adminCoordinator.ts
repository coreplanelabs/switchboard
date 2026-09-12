// The bot steps a ship coordinator calls (docs/reference/specs/http-ingress.md
// item 9; docs/decisions/0029-durable-objects-store-workflows-schedule.md,
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md): the
// coordinator is a Workflow instance in the bot's shim Worker that holds no
// credential of its own, so every GitHub fact, every Slack post and every child
// run is the bot's to produce. The steps, in the order a plan runs them: `plan`
// (the units and the caps the instance was created with), `unit-start` (the
// unit's thread, opened through the requesting thread's channel; its board
// issue), `branch`, `spawn`, `read-record` (a finished child's typed artifacts:
// the pull request it opened, the verdict and whether it stands on the pull
// request at the reviewed head, the dispositions), `pr-check`, `round` (a
// boundary the card draws), `unit-end` (the report in the unit's thread),
// `finish` (the parent's run record), plus `authorize`, the question the shim
// asks before it creates an instance. The shim forwards `/admin/*` to the
// container untouched and the Access gate does not cover it, so the bearer is
// the whole door, like the restart, the crash and the span log: the
// `coordinator` entry of `SWITCHBOARD_INGRESS_TOKENS`, whose `http:coordinator`
// actor the policy table admits on `coordinator:step` and nothing else does.
//
// The spawn never takes an actor from its caller. The body names an instance
// and a step; the requester, channel and thread come from the parent ship
// record the bot wrote at the instance's creation (a plan unit's thread from
// its own row), and the child is an ordinary `dispatch()` as that user, so the
// agent gate, the profile gate and the repository gates judge it with that
// person's grants — a requester who lost `agent:run:coding` during a days-long
// wait ends the step with the gate's own name. A spawn carries either a
// `prompt` (the conductor's free text) or a typed `brief` (ids only: the unit,
// the pull request, the review run) the bot composes into the child's turn
// itself, so no prompt text ever crosses from the Workflow. Every step is safe
// to retry: the spawn carries the key `<parentInstanceId>:<step>`, the child's
// claim stores it, and a retry that meets the child live or finished answers
// `alreadySpawned` with its id; a thread held by a run without the key answers
// `busy`. Every answer carries `at`, the bot's clock — the only time the
// machine reads.
//
// Per-unit state is one row in the state Worker's `coordinator_units` table
// (`CoordinatorUnit`): a unit's thread, branch, pull request, rounds and
// ending, readable by a person as one row; the instance row keeps identity.
//
// The handler here is pure over a parsed request (`handleCoordinatorRequest`),
// like the ingress; `createAdminCoordinatorHandler` is the node:http adapter.

import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { AGENTS } from "../agents/registry.js";
import { authorize } from "../core/authz/authorize.js";
import { resolveActor, type GrantsLookup } from "../core/authz/actor.js";
import type { ChannelVisibility } from "../core/authz/types.js";
import { composeChild, TASK_UNIT, type BriefReaders } from "../core/coordinator/briefs.js";
import {
  COORDINATOR_STEP_ACTION,
  idempotencyKeyFor,
  INSTANCE_ID_PATTERN,
  STEP_NAME_PATTERN,
  type CoordinatorInstance,
  type CoordinatorTag,
  type CoordinatorUnit,
} from "../core/coordinator/contract.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { DispatchOptions } from "../core/dispatcher.js";
import type { DispatchOutcome } from "../core/dispatch/outcome.js";
import { childRequestText } from "../core/dispatch/spawn.js";
import { CHANGES_TOKEN, LGTM_TOKEN } from "../core/reviewVerdict.js";
import { sameCommit } from "../core/reviewedHead.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent, ShipRoundOutcome } from "../core/runEvents.js";
import type { RunHistoryWriter } from "../core/runHistoryWriter.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT, type RunRecord } from "../core/runRecord.js";
import type { RunsService, RunView } from "../core/runsService.js";
import type { Brief } from "../core/ship/coordinator.js";
import { resolveShipCaps, shipRoundHeader } from "../core/shipPipeline.js";
import { createCardShell } from "../core/statusCardFrame.js";
import { systemClock } from "../core/trace/clock.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import { authenticateIngressBearer } from "../deploy/restart.js";
import type { GithubApi } from "../execution/githubApi.js";
import type { GithubIdentity } from "../execution/githubApp.js";
import type { OpenPrRef, PullRequestReview } from "../execution/githubPulls.js";
import type { Secret } from "../secrets.js";
import { readBody, type IngressResponse } from "./http.js";

export const COORDINATOR_ADMIN_PREFIX = "/admin/coordinator/";
export function isCoordinatorAdminPath(path: string): boolean {
  return path.startsWith(COORDINATOR_ADMIN_PREFIX) && path.length > COORDINATOR_ADMIN_PREFIX.length;
}

/** The child's prompt is the contract a coordinator renders: bounded, never unbounded input. */
export const MAX_SPAWN_PROMPT_CHARS = 200_000;
/** How many pages of the instance's channel a spawn reads back for a finished
 *  run carrying its key: the default retention's `maxRuns` in full pages, so a
 *  retry that lands after its child ended finds it however busy the channel. */
export const FINISHED_LOOKBACK_PAGES = 25;
const MAX_ADMIN_BODY_BYTES = 1_000_000;

export interface AdminCoordinatorDeps {
  /** The `SWITCHBOARD_INGRESS_TOKENS` secret as the process sees it. */
  tokens: Secret | undefined;
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `coordinator:step`. */
  grantsFor: GrantsLookup;
  /** The parent ship records (run-history item 49). */
  instances: CoordinatorInstanceStore;
  /** The one runs service every surface reads: the live and finished runs of the instance's thread. */
  runs: RunsService;
  /** `dispatch()` bound over the process's deps: the child as the requesting
   *  user, tagged — with the unit's contract and, for a fix round, the finding ids. */
  dispatch: (
    msg: IncomingMessage,
    io: ChannelIO,
    opts: Pick<DispatchOptions, "coordinator" | "contract" | "fixRound"> & { coordinator: CoordinatorTag },
  ) => Promise<DispatchOutcome>;
  /** The channel handle for a thread (the resume's `resumeSlackIO` from the
   *  row's parts — the card's ts when the handle must redraw it); undefined for
   *  a platform no thread can be rebuilt on. */
  ioFor: (thread: { threadKey: string; userId: string; cardTs?: string }) => ChannelIO | undefined;
  /** The open pull request heading a branch (githubPulls.findOpenPrByHead). */
  findOpenPrByHead: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  /** The target repository at the base ref (the plan, the specs, the rules) and
   *  its issues (a unit's board issue) — the App's GitHub reads. */
  github: Pick<GithubApi, "readFile" | "listIssues">;
  /** Round 0's branch create (githubPulls.createBranchRef): 422 already-exists is success inside. */
  createBranchRef: (repo: string, branch: string, fromRef: string) => Promise<void>;
  /** The reviews on a pull request (githubPulls.fetchPullRequestReviews) and the
   *  identity this bot posts as: whether the bot's verdict stands at a head. */
  fetchPrReviews: (pr: { repo: string; number: number }) => Promise<PullRequestReview[] | undefined>;
  selfIdentity: () => Promise<GithubIdentity | undefined>;
  /** Where the parent's record goes when the instance ends. */
  runHistoryWriter: RunHistoryWriter;
  /** The channel's visibility stamp for that record (dispatch/record.ts `channelVisibilityOf`). */
  channelVisibilityOf: (channelId: string) => Promise<ChannelVisibility>;
  clock?: () => number;
  log?: (line: string) => void;
}

export interface CoordinatorRouteRequest {
  method?: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The parsed spawn body: the instance, the step, the child's preset, an
 *  optional narrower budget, and the child's turn — the caller's own `prompt`,
 *  or a `brief` (ids) the bot composes the turn from, with the unit it runs for. */
export interface SpawnStepRequest {
  parentInstanceId: string;
  step: string;
  preset: string;
  budget?: number;
  prompt?: string;
  brief?: Brief;
  unit?: string;
}

const UNIT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const PRESETS_OF_KIND: Readonly<Record<Brief["kind"], string>> = {
  contract: "coding",
  review: "review",
  fix: "coding",
};

/** A brief as the coordinator sends it (`Brief`, ship/coordinator.ts): ids only, each shaped. */
function parseBrief(v: unknown): Parsed<Brief> {
  if (typeof v !== "object" || v === null) return invalid("brief must be an object");
  const b = v as Record<string, unknown>;
  if (typeof b.unit !== "string" || !UNIT_ID.test(b.unit)) return invalid("brief.unit must be a unit id");
  const pr = (): Parsed<number> =>
    typeof b.pr === "number" && Number.isInteger(b.pr) && b.pr > 0
      ? { ok: true, value: b.pr }
      : invalid("brief.pr must be a pull request number");
  const runId = (key: string): Parsed<string> =>
    typeof b[key] === "string" && RUN_ID_PATTERN.test(b[key] as string)
      ? { ok: true, value: b[key] as string }
      : invalid(`brief.${key} must be a run id`);
  switch (b.kind) {
    case "contract": {
      const r = b.rebase as Record<string, unknown> | undefined;
      if (typeof r !== "object" || r === null || typeof r.branch !== "string" || typeof r.onto !== "string")
        return invalid("brief.rebase must name the branch and what it is rebased onto");
      return { ok: true, value: { kind: "contract", unit: b.unit, rebase: { branch: r.branch, onto: r.onto } } };
    }
    case "review": {
      const n = pr();
      if (!n.ok) return n;
      if (typeof b.round !== "number" || !Number.isInteger(b.round) || b.round < 1)
        return invalid("brief.round must be a whole number, at least 1");
      if (b.headSha !== undefined && typeof b.headSha !== "string") return invalid("brief.headSha must be a string");
      let prior: Extract<Brief, { kind: "review" }>["prior"];
      if (b.prior !== undefined) {
        const p = b.prior as Record<string, unknown>;
        if (
          typeof p !== "object" ||
          p === null ||
          typeof p.reviewRunId !== "string" ||
          !RUN_ID_PATTERN.test(p.reviewRunId)
        )
          return invalid("brief.prior.reviewRunId must be a run id");
        if (p.fixRunId !== undefined && (typeof p.fixRunId !== "string" || !RUN_ID_PATTERN.test(p.fixRunId)))
          return invalid("brief.prior.fixRunId must be a run id");
        prior = { reviewRunId: p.reviewRunId, ...(p.fixRunId !== undefined ? { fixRunId: p.fixRunId as string } : {}) };
      }
      return {
        ok: true,
        value: {
          kind: "review",
          unit: b.unit,
          pr: n.value,
          ...(b.headSha !== undefined ? { headSha: b.headSha as string } : {}),
          round: b.round,
          ...(prior ? { prior } : {}),
        },
      };
    }
    case "fix": {
      const n = pr();
      if (!n.ok) return n;
      const review = runId("reviewRunId");
      if (!review.ok) return review;
      return { ok: true, value: { kind: "fix", unit: b.unit, pr: n.value, reviewRunId: review.value } };
    }
    default:
      return invalid("brief.kind must be contract, review or fix");
  }
}

/** What `read-record` answers: the run's own facts and nothing of its stream
 *  but the final reply — the coordinator confirms an event and reads the
 *  child's handoff from it. */
export interface CoordinatorRunView {
  id: string;
  finished: boolean;
  status?: string;
  agent?: string;
  startedAt: number;
  finishedAt?: number;
  activity?: string;
  parentInstanceId: string;
  idempotencyKey?: string;
  /** The generation driving a live run elsewhere (run-history item 41). */
  ownerGen?: string;
  finalReply?: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const invalid = <T>(error: string): Parsed<T> => ({ ok: false, error });
const json = (status: number, body: Record<string, unknown>): IngressResponse => ({ status, body });
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function parseObject(text: string): Parsed<Record<string, unknown>> {
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return invalid("body must be a JSON object");
  return { ok: true, value: parsed as Record<string, unknown> };
}

function parseInstanceId(v: unknown): Parsed<string> {
  if (typeof v !== "string" || !INSTANCE_ID_PATTERN.test(v))
    return invalid("parentInstanceId must be a Workflow instance id");
  return { ok: true, value: v };
}

/** The spawn body: every field shaped before any store is read. The `ship`
 *  preset is refused — a coordinator's child is a round of a pipeline, never
 *  another pipeline — and the body's `userId`/`channelId`, if any, are ignored:
 *  the requester is the parent record's. */
export function parseSpawnStep(body: Record<string, unknown>): Parsed<SpawnStepRequest> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return id;
  if (typeof body.step !== "string" || !STEP_NAME_PATTERN.test(body.step))
    return invalid("step must be a step name (letters, digits, `_ . / -`, no colon)");
  if (typeof body.preset !== "string" || !Object.hasOwn(AGENTS, body.preset))
    return invalid(`preset must be a registered preset (${Object.keys(AGENTS).join(", ")})`);
  if (body.preset === "ship")
    return invalid("preset must not be ship: a coordinator's child is a round, not a pipeline");
  if (
    body.budget !== undefined &&
    (typeof body.budget !== "number" || !Number.isInteger(body.budget) || body.budget < 2)
  )
    return invalid("budget must be a whole number of minutes, at least 2");
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return invalid("unit must be a unit id");
  const value: SpawnStepRequest = {
    parentInstanceId: id.value,
    step: body.step,
    preset: body.preset,
    ...(body.budget !== undefined ? { budget: body.budget as number } : {}),
    ...(body.unit !== undefined ? { unit: body.unit as string } : {}),
  };
  // The child's turn: the caller's own prompt, or a brief the bot composes it
  // from — one of the two, and a brief's kind fixes the preset.
  if (body.brief !== undefined) {
    if (body.prompt !== undefined) return invalid("prompt and brief are one or the other");
    const brief = parseBrief(body.brief);
    if (!brief.ok) return brief;
    if (PRESETS_OF_KIND[brief.value.kind] !== body.preset)
      return invalid(`preset must be ${PRESETS_OF_KIND[brief.value.kind]} for a ${brief.value.kind} brief`);
    return { ok: true, value: { ...value, brief: brief.value, unit: brief.value.unit } };
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "" || body.prompt.length > MAX_SPAWN_PROMPT_CHARS)
    return invalid(`prompt must be a non-empty string of at most ${MAX_SPAWN_PROMPT_CHARS} characters`);
  return { ok: true, value: { ...value, prompt: body.prompt } };
}

/** The unit row a body names, when it names one: `unit_not_found` when the
 *  instance has no such unit. Absent `unit` → undefined (the instance's own thread). */
async function unitRowOf(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  unit: string | undefined,
): Promise<{ ok: true; row: CoordinatorUnit | undefined } | { ok: false; response: IngressResponse }> {
  if (unit === undefined) return { ok: true, row: undefined };
  const row = (await deps.instances.listUnits(instance.id)).find((u) => u.unit === unit);
  if (!row) return { ok: false, response: json(404, { ok: false, error: "unit_not_found", unit }) };
  return { ok: true, row };
}

/** The thread a unit's children run in: the unit's own once opened, the
 *  requesting thread for a task-string unit. */
function unitThread(instance: CoordinatorInstance, row: CoordinatorUnit | undefined) {
  const threadKey = row?.threadKey ?? (row === undefined || row.unit === TASK_UNIT ? instance.threadKey : undefined);
  const sourceUrl = row?.sourceUrl ?? (threadKey === instance.threadKey ? instance.sourceUrl : undefined);
  return { threadKey, sourceUrl };
}

/** The whole door: WHO (the bearer in the token map — 401/503) and WHETHER (the
 *  actor `http:<subject>` on `coordinator:step` against the policy table —
 *  403). The deny reason stays in the log; the reply names the grant. */
function authorizeStep(
  headers: IncomingHttpHeaders,
  step: string,
  deps: AdminCoordinatorDeps,
): { ok: true; subject: string } | { ok: false; response: IngressResponse; reason: string } {
  const raw = headers.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  const authn = authenticateIngressBearer(authorization, deps.tokens?.reveal(), "coordinator");
  if (!authn.ok)
    return { ok: false, response: json(authn.status, { ok: false, error: authn.reason }), reason: authn.reason };
  const subject = authn.identity.subject;
  const actor = resolveActor({ surface: "http", subjectId: subject }, deps.grantsFor);
  const decision = authorize(actor, COORDINATOR_STEP_ACTION, { type: "command", id: `coordinator.${step}` });
  if (!decision.allow) {
    return {
      ok: false,
      reason: decision.reason,
      response: json(403, {
        ok: false,
        error: `forbidden: identity "${subject}" holds no ${COORDINATOR_STEP_ACTION} grant (grants["http:${subject}"] in config.yaml)`,
      }),
    };
  }
  return { ok: true, subject };
}

/** Every run — the bot's own bookkeeping over the instance's thread, not a
 *  person's read: the requester was authorized at the child's dispatch. */
const EVERY_RUN = { kind: "all" } as const;

/** The run holding the unit's thread right now: here, or on another generation's ledger row. */
async function liveOnThread(
  runs: RunsService,
  instance: CoordinatorInstance,
  threadKey: string,
): Promise<RunView | undefined> {
  const active = await runs.listRuns({
    status: "active",
    visibleTo: EVERY_RUN,
    channel: instance.channelId,
    limit: RUN_LIST_MAX_LIMIT,
  });
  return active.runs.find((r) => r.threadKey === threadKey && !r.finished);
}

/** A finished run in the unit's thread carrying the key, since the instance was created. */
async function finishedWithKey(
  runs: RunsService,
  instance: CoordinatorInstance,
  threadKey: string,
  key: string,
): Promise<RunView | undefined> {
  let cursor: { before: number; beforeId: string } | undefined;
  for (let page = 0; page < FINISHED_LOOKBACK_PAGES; page++) {
    const result = await runs.listRuns({
      status: "finished",
      visibleTo: EVERY_RUN,
      channel: instance.channelId,
      sinceMs: instance.createdAt,
      limit: RUN_LIST_MAX_LIMIT,
      ...(cursor ?? {}),
    });
    const hit = result.runs.find((r) => r.threadKey === threadKey && r.idempotencyKey === key);
    if (hit) return hit;
    if (!result.nextBefore) return undefined;
    cursor = { before: result.nextBefore.finishedAt, beforeId: result.nextBefore.id };
  }
  return undefined;
}

/** The spawn's answer for a run already holding the step or the thread. */
function answerForLive(live: RunView, key: string, threadKey: string, at: number): IngressResponse {
  if (live.idempotencyKey === key) return json(200, { ok: true, runId: live.id, threadKey, alreadySpawned: true, at });
  return json(409, {
    ok: false,
    error: "busy",
    runId: live.id,
    ...(live.agent !== undefined ? { agent: live.agent } : {}),
    at,
  });
}

/** The child's channel with two ears on it: the registration and every reply
 *  (a gate's refusal is the last one before the dispatch ends). By method,
 *  never a spread — the adapter's IO is a class instance. */
function watched(io: ChannelIO, on: { started: (id: string) => void; replied: (text: string) => void }): ChannelIO {
  const out: ChannelIO = {
    reply: async (text) => {
      on.replied(text);
      await io.reply(text);
    },
    status: (initial) => io.status(initial),
    history: () => io.history(),
    runStarted: (started) => {
      io.runStarted?.(started);
      on.started(started.id);
    },
  };
  if (io.attach) out.attach = (file) => io.attach!(file);
  if (io.runFinished) out.runFinished = (receipt) => io.runFinished!(receipt);
  if (io.openThread) out.openThread = (lead) => io.openThread!(lead);
  return out;
}

async function spawn(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const parsed = parseSpawnStep(body);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });
  const req = parsed.value;
  const log = deps.log ?? console.log;
  const instance = await deps.instances.get(req.parentInstanceId);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const at = (deps.clock ?? systemClock)();
  const unit = await unitRowOf(deps, instance, req.unit);
  if (!unit.ok) return unit.response;
  const thread = unitThread(instance, unit.row);
  // A plan unit's thread is opened by `unit-start`; a spawn before it has no
  // thread to run in — a passing condition (the runner asks again), stamped
  // like every answer.
  if (thread.threadKey === undefined) return json(409, { ok: false, error: "unit_not_started", unit: req.unit, at });
  const threadKey = thread.threadKey;
  const key = idempotencyKeyFor(instance.id, req.step);
  // Retry-safe before anything starts: the step's child, live or finished, or
  // another run holding the unit's thread.
  const live = await liveOnThread(deps.runs, instance, threadKey);
  if (live) return answerForLive(live, key, threadKey, at);
  const done = await finishedWithKey(deps.runs, instance, threadKey, key);
  if (done) return json(200, { ok: true, runId: done.id, threadKey, alreadySpawned: true, at });
  const io = deps.ioFor({ threadKey, userId: instance.userId });
  if (!io) return json(503, { ok: false, error: "no_channel", at });
  // The child's turn: the caller's prompt, or the brief composed from what the
  // bot holds — the plan at the base ref, the prior rounds' records.
  let turn: {
    prompt: string;
    ref?: string;
    contract?: DispatchOptions["contract"];
    fixRound?: DispatchOptions["fixRound"];
  };
  if (req.brief !== undefined) {
    if (unit.row === undefined) return json(400, { ok: false, error: "a brief needs the unit it runs for" });
    try {
      const composed = await composeChild(req.brief, instance, unit.row, briefReaders(deps, instance, io));
      turn = composed;
    } catch (err) {
      // A brief the bot cannot compose — the plan missing at the base, a run
      // the history lacks — is a failed spawn: the machine ends the unit as an
      // abort naming the reason, never a child half-briefed and never a retry
      // of a read that cannot change.
      log(`[coordinator] ${instance.id} ${req.step}: the brief could not be composed: ${describe(err)}`);
      return json(502, { ok: false, error: "brief_failed", message: describe(err), at });
    }
  } else {
    turn = { prompt: req.prompt! };
  }
  // The child's message is the one the requester would have typed, in the
  // unit's thread, as the requester the parent record names.
  const msg: IncomingMessage = {
    channelId: instance.channelId,
    userId: instance.userId,
    ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
    ...(instance.channelName !== undefined ? { channelName: instance.channelName } : {}),
    threadKey,
    ...(thread.sourceUrl !== undefined ? { sourceUrl: thread.sourceUrl } : {}),
    text: childRequestText({
      preset: req.preset,
      prompt: turn.prompt,
      repo: instance.repo,
      ...(turn.ref !== undefined ? { ref: turn.ref } : {}),
      ...(req.budget !== undefined ? { budget: req.budget } : {}),
    }),
    receivedAt: at,
  };
  let startedId: string | undefined;
  let lastReply: string | undefined;
  let resolveStarted!: (id: string) => void;
  const started = new Promise<string>((resolve) => {
    resolveStarted = resolve;
  });
  const child = watched(io, {
    started: (id) => {
      startedId = id;
      resolveStarted(id);
    },
    replied: (text) => {
      lastReply = text;
    },
  });
  const tag: CoordinatorTag = { parentInstanceId: instance.id, idempotencyKey: key };
  const settled = deps
    .dispatch(msg, child, {
      coordinator: tag,
      ...(turn.contract !== undefined ? { contract: turn.contract } : {}),
      ...(turn.fixRound !== undefined ? { fixRound: turn.fixRound } : {}),
    })
    .then(
      (outcome) => ({ kind: "ended" as const, outcome }),
      (err: unknown) => ({ kind: "threw" as const, err }),
    );
  // The dispatch runs on in the process (counted in flight like any run); the
  // route answers at registration, and a throw after that is a log line.
  void settled.then((end) => {
    if (end.kind === "threw")
      log(`[coordinator] ${instance.id} ${req.step}: the child's dispatch threw: ${describe(end.err)}`);
  });
  const first = await Promise.race([started.then((id) => ({ kind: "started" as const, id })), settled]);
  if (first.kind === "started" || startedId !== undefined) {
    const runId = first.kind === "started" ? first.id : startedId!;
    log(`[coordinator] ${instance.id} ${req.step}: spawned ${req.preset} run ${runId} in ${threadKey}`);
    return json(200, { ok: true, runId, threadKey, at });
  }
  if (first.kind === "threw") return json(502, { ok: false, error: "spawn_failed", message: describe(first.err), at });
  const refusal = first.outcome.refusal;
  if (refusal === "coordinator_thread_live") {
    // A run took the thread between the read above and the claim: answer from it.
    const now = await liveOnThread(deps.runs, instance, threadKey);
    if (now) return answerForLive(now, key, threadKey, at);
    return json(409, { ok: false, error: "busy", at });
  }
  log(`[coordinator] ${instance.id} ${req.step}: ${req.preset} child not started (${refusal ?? first.outcome.status})`);
  if (refusal !== undefined)
    return json(403, { ok: false, error: refusal, ...(lastReply !== undefined ? { message: lastReply } : {}), at });
  return json(502, {
    ok: false,
    error: "spawn_failed",
    message: lastReply ?? `the child ended (${first.outcome.status}) before it started`,
    at,
  });
}

function finalReplyOf(events: readonly RunEvent[] | undefined): string | undefined {
  const last = [...(events ?? [])].reverse().find((e) => e.type === "answer");
  return last && last.type === "answer" ? last.text : undefined;
}

function coordinatorRunView(
  view: RunView,
  parentInstanceId: string,
  finalReply: string | undefined,
): CoordinatorRunView {
  return {
    id: view.id,
    finished: view.finished,
    ...(view.status !== undefined ? { status: view.status } : {}),
    ...(view.agent !== undefined ? { agent: view.agent } : {}),
    startedAt: view.startedAt,
    ...(view.finishedAt !== undefined ? { finishedAt: view.finishedAt } : {}),
    ...(view.activity !== undefined ? { activity: view.activity } : {}),
    parentInstanceId,
    ...(view.idempotencyKey !== undefined ? { idempotencyKey: view.idempotencyKey } : {}),
    ...(view.ownerGen !== undefined ? { ownerGen: view.ownerGen } : {}),
    ...(finalReply !== undefined ? { finalReply } : {}),
  };
}

/** The pull request a finished coding child opened or edited (`pr_opened`), from its events. */
function prOpenedOf(
  events: readonly RunEvent[] | undefined,
): { number: number; url: string; created: boolean } | undefined {
  const last = [...(events ?? [])].reverse().find((e) => e.type === "pr_opened");
  return last && last.type === "pr_opened" ? { number: last.number, url: last.url, created: last.created } : undefined;
}

/** Whether the bot's own verdict stands on the pull request at the head the
 *  child reviewed: a review by this bot's identity, pinned to that head, whose
 *  body starts with the verdict's token. Unknown (no identity, GitHub silent)
 *  → undefined, never a guess either way. */
async function reviewPostedAt(
  deps: AdminCoordinatorDeps,
  pr: { repo: string; number: number },
  verdict: NonNullable<RunView["verdict"]>,
  head: string,
): Promise<boolean | undefined> {
  const [reviews, self] = await Promise.all([
    deps.fetchPrReviews(pr).catch(() => undefined),
    deps.selfIdentity().catch(() => undefined),
  ]);
  if (reviews === undefined || self === undefined) return undefined;
  const token = verdict.verdict === "approve" ? LGTM_TOKEN : CHANGES_TOKEN;
  return reviews.some(
    (r) =>
      r.author?.login === self.login &&
      (r.author.id === undefined || r.author.id === self.id) &&
      r.commitId !== undefined &&
      sameCommit(r.commitId.toLowerCase(), head) &&
      r.body.startsWith(token),
  );
}

async function readRecord(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.runId !== "string" || !RUN_ID_PATTERN.test(body.runId))
    return json(400, { ok: false, error: "runId must be a run id" });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  // A run outside the instance is `not_found`, byte-identical to a missing one
  // (authorization.md: a denied read reveals nothing).
  const res = await deps.runs.getRun(body.runId);
  if (!res.ok || res.value.parentInstanceId !== id.value) return json(404, { ok: false, error: "not_found" });
  const view = res.value;
  if (!view.finished) return json(200, { ok: true, run: coordinatorRunView(view, id.value, undefined), at });
  // Finished: the final reply and the typed artifacts the record carries — the
  // coding child's pull request, the review child's verdict and whether it
  // stands on the pull request, the fix child's dispositions.
  const full = await deps.runs.getRun(body.runId, { include: "messages" });
  const record = full.ok ? full.value : view;
  const finalReply = finalReplyOf(record.events);
  const pr = prOpenedOf(record.events);
  let reviewPosted: boolean | undefined;
  if (record.verdict !== undefined && record.reviewHead !== undefined && typeof body.unit === "string") {
    const instance = await deps.instances.get(id.value);
    const row = instance ? (await deps.instances.listUnits(instance.id)).find((u) => u.unit === body.unit) : undefined;
    if (instance && row?.pr !== undefined)
      reviewPosted = await reviewPostedAt(
        deps,
        { repo: instance.repo, number: row.pr.number },
        record.verdict,
        record.reviewHead,
      );
  }
  return json(200, {
    ok: true,
    run: {
      ...coordinatorRunView(view, id.value, finalReply),
      ...(pr !== undefined ? { pr } : {}),
      ...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
      ...(record.reviewHead !== undefined ? { reviewHead: record.reviewHead } : {}),
      ...(reviewPosted !== undefined ? { reviewPosted } : {}),
      ...(record.dispositions !== undefined ? { dispositions: record.dispositions } : {}),
      ...(record.handoff !== undefined ? { handoff: true } : {}),
    },
    at,
  });
}

async function prCheck(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit as string | undefined);
  if (!unit.ok) return unit.response;
  const branch = unit.row?.branch ?? instance.branch;
  try {
    const pr = await deps.findOpenPrByHead(instance.repo, branch);
    if (!pr) return json(200, { ok: true, state: "none", at });
    // The unit's row remembers its pull request, so a person reads it there.
    if (unit.row && (unit.row.pr?.number !== pr.number || unit.row.pr.url !== pr.htmlUrl))
      await deps.instances.putUnits([{ ...unit.row, pr: { number: pr.number, url: pr.htmlUrl } }]);
    return json(200, {
      ok: true,
      state: "open",
      prNumber: pr.number,
      url: pr.htmlUrl,
      ...(pr.headSha !== undefined ? { headSha: pr.headSha } : {}),
      at,
    });
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
}

// ---- the plan runner's own steps: the plan, a unit's start and end, the branch, the card, the record ----

/** What the coordinator reads first: the instance's units with where each
 *  stands, the caps and the children's own budgets — the numbers its machine
 *  runs on, none of them in the instance's params. */
async function plan(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const units = await deps.instances.listUnits(instance.id);
  return json(200, {
    ok: true,
    ...(instance.plan !== undefined ? { planId: instance.plan.id } : {}),
    base: instance.base ?? "main",
    caps: instance.caps ?? resolveShipCaps(undefined),
    childMinutes: { coding: AGENTS.coding.maxMinutes, review: AGENTS.review.maxMinutes },
    units,
    at,
  });
}

/** The board issue titled by the unit id (`U<n>: …`), when the repository has one open. */
async function unitIssueOf(deps: AdminCoordinatorDeps, repo: string, unit: string): Promise<number | undefined> {
  try {
    const issues = await deps.github.listIssues(repo, { state: "open", limit: 100 });
    const pattern = new RegExp(`^${unit}\\b`);
    return issues.find((i) => pattern.test(i.title))?.number;
  } catch {
    return undefined;
  }
}

/** A unit starts: its thread is opened by the requesting thread's channel (a
 *  task's is the requesting thread itself), its board issue looked up, and the
 *  row says so. Idempotent: a unit with a thread answers it again. */
async function unitStart(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit);
  if (!unit.ok) return unit.response;
  let row = unit.row!;
  if (row.threadKey === undefined) {
    if (row.unit === TASK_UNIT) {
      row = {
        ...row,
        threadKey: instance.threadKey,
        ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
      };
    } else {
      const parent = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
      if (!parent?.openThread) return json(503, { ok: false, error: "no_channel", at });
      try {
        const opened = await parent.openThread(unitLead(instance, row));
        row = {
          ...row,
          threadKey: opened.thread.threadKey,
          ...(opened.thread.sourceUrl !== undefined ? { sourceUrl: opened.thread.sourceUrl } : {}),
        };
      } catch (err) {
        return json(502, { ok: false, error: "thread_failed", message: describe(err), at });
      }
    }
  }
  if (row.issue === undefined && row.unit !== TASK_UNIT) {
    const issue = await unitIssueOf(deps, instance.repo, row.unit);
    if (issue !== undefined) row = { ...row, issue };
  }
  row = { ...row, startedAt: row.startedAt ?? at };
  await deps.instances.putUnits([row]);
  (deps.log ?? console.log)(`[coordinator] ${instance.id} ${row.unit}: started in ${row.threadKey}`);
  return json(200, {
    ok: true,
    threadKey: row.threadKey,
    branch: row.branch,
    base: instance.base ?? "main",
    ...(row.issue !== undefined ? { issue: row.issue } : {}),
    at,
  });
}

/** The lead of a unit's thread — what a reader in the channel needs to know why a new thread appeared. */
function unitLead(instance: CoordinatorInstance, row: CoordinatorUnit): string {
  const who = instance.userName ?? instance.userId;
  const from = instance.sourceUrl !== undefined ? `[the *ship* run](${instance.sourceUrl})` : "the *ship* run";
  return `↳ *ship* unit ${row.unit}${row.title ? ` — ${row.title}` : ""} for ${who}, from ${from}: \`${row.branch}\` in ${instance.repo}`;
}

/** Round 0's pipeline branch: `refs/heads/<branch>` at the base's tip, on
 *  origin before any attach; a branch already there is success inside. */
async function branch(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit as string | undefined);
  if (!unit.ok) return unit.response;
  const name = unit.row?.branch ?? instance.branch;
  const base = instance.base;
  if (base === undefined) return json(200, { ok: false, reason: `no base branch is known for ${instance.repo}`, at });
  try {
    await deps.createBranchRef(instance.repo, name, base);
    return json(200, { ok: true, branch: name, base, at });
  } catch (err) {
    return json(200, { ok: false, reason: describe(err), at });
  }
}

const ROUND_OUTCOMES: readonly ShipRoundOutcome[] = [
  "started",
  "pr_opened",
  "completed",
  "approve",
  "request_changes",
  "no_verdict",
  "aborted",
  "stopped",
];

/** One line per unit on the parent's card: the round in flight or how the unit ended. */
function unitLines(units: readonly CoordinatorUnit[]): string[] {
  return units.map((u) => {
    const last = u.rounds.at(-1);
    const state = u.ending
      ? u.ending.kind
      : last
        ? `${shipRoundHeader({ index: last.index, agent: last.agent })} · ${last.outcome}`
        : u.threadKey
          ? "starting"
          : "waiting";
    return u.unit === TASK_UNIT ? state : `${u.unit} · ${state}`;
  });
}

/** Redraw the parent's card from the unit rows (`StatusHandle.handle` on the
 *  instance record): the same shell frames every run draws, the round header
 *  per unit. No card (a channel without one) → nothing. */
async function drawCard(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  units: readonly CoordinatorUnit[],
  close?: { icon: string },
): Promise<void> {
  if (!instance.card) return;
  const io = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId, cardTs: instance.card.ts });
  if (!io) return;
  const clock = deps.clock ?? systemClock;
  const shell = createCardShell({ label: instance.label ?? "*ship*", startedAt: instance.createdAt, now: clock });
  const detail = unitLines(units);
  if (!close) {
    await io.status(shell.live({ detail }));
    return;
  }
  shell.freeze(clock());
  const handle = await io.status(shell.live({ detail }));
  await handle.done(shell.close({ kind: "done", icon: close.icon, detail: detail.join("\n") }));
}

/** A round boundary: appended to the unit's row and drawn on the card. */
async function round(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  if (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0)
    return json(400, { ok: false, error: "index must be a whole number" });
  if (body.agent !== "coding" && body.agent !== "review")
    return json(400, { ok: false, error: "agent must be coding or review" });
  if (!ROUND_OUTCOMES.includes(body.outcome as ShipRoundOutcome))
    return json(400, { ok: false, error: `outcome must be one of ${ROUND_OUTCOMES.join(", ")}` });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const units = await deps.instances.listUnits(instance.id);
  const row = units.find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unit_not_found", unit: body.unit });
  const updated: CoordinatorUnit = {
    ...row,
    rounds: [...row.rounds, { index: body.index, agent: body.agent, outcome: body.outcome as string, at }],
  };
  await deps.instances.putUnits([updated]);
  await drawCard(
    deps,
    instance,
    units.map((u) => (u.unit === updated.unit ? updated : u)),
  ).catch((err) =>
    (deps.log ?? console.warn)(`[coordinator] ${instance.id}: the card could not be redrawn: ${describe(err)}`),
  );
  return json(200, { ok: true, at });
}

/** A unit ended: the row says how, the unit's thread gets the report, the card is redrawn. */
async function unitEnd(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const ending = body.ending as Record<string, unknown> | undefined;
  if (
    typeof ending !== "object" ||
    ending === null ||
    typeof ending.kind !== "string" ||
    typeof ending.report !== "string"
  )
    return json(400, { ok: false, error: "ending must carry a kind and a report" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const units = await deps.instances.listUnits(instance.id);
  const row = units.find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unit_not_found", unit: body.unit });
  const pr = body.pr as { number?: unknown; url?: unknown } | undefined;
  const updated: CoordinatorUnit = {
    ...row,
    ...(pr && typeof pr.number === "number" && typeof pr.url === "string"
      ? { pr: { number: pr.number, url: pr.url } }
      : {}),
    ending: { kind: ending.kind, report: ending.report, at },
  };
  await deps.instances.putUnits([updated]);
  const thread = unitThread(instance, updated);
  const io =
    thread.threadKey !== undefined ? deps.ioFor({ threadKey: thread.threadKey, userId: instance.userId }) : undefined;
  let told = false;
  if (io) {
    try {
      await io.reply(ending.report);
      told = true;
    } catch (err) {
      (deps.log ?? console.warn)(
        `[coordinator] ${instance.id} ${row.unit}: the report could not be posted: ${describe(err)}`,
      );
    }
  }
  await drawCard(
    deps,
    instance,
    units.map((u) => (u.unit === updated.unit ? updated : u)),
  ).catch(() => {});
  (deps.log ?? console.log)(`[coordinator] ${instance.id} ${row.unit}: ended ${ending.kind}`);
  return json(200, { ok: true, told, at });
}

const ENDING_ICON: Readonly<Record<string, string>> = { merged: "✅", merge_ready: "✅", done: "✅" };

/** The parent's one record, assembled from the instance and its unit rows
 *  when the instance ends: the round boundaries every unit drew, in order, and
 *  the summary as the answer — the pipeline's record without a process. */
export function parentRunRecord(
  instance: CoordinatorInstance,
  units: readonly CoordinatorUnit[],
  outcome: "completed" | "failed",
  channelVisibility: ChannelVisibility,
  finishedAt: number,
): RunRecord {
  const events: RunEvent[] = [
    { type: "run_meta", agent: "ship", repo: instance.repo, at: instance.createdAt },
    ...units.flatMap((u) =>
      u.rounds.map((r): RunEvent => ({
        type: "ship_round",
        index: r.index,
        agent: r.agent,
        outcome: r.outcome as ShipRoundOutcome,
        at: r.at,
      })),
    ),
    { type: "answer", text: planSummary(units), at: finishedAt },
  ];
  events.forEach((e, i) => {
    e.seq = i + 1;
  });
  return {
    id: instance.runId ?? instance.id.slice(0, 64),
    ...(instance.label !== undefined ? { label: instance.label } : {}),
    agent: "ship",
    channelId: instance.channelId,
    userId: instance.userId,
    threadKey: instance.threadKey,
    channelVisibility,
    repo: instance.repo,
    startedAt: instance.createdAt,
    finishedAt,
    status: outcome,
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events, { finished: true, truncated: false }),
    ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
    ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
  };
}

/** The plan's summary — one line per unit with how it ended and its pull request. */
export function planSummary(units: readonly CoordinatorUnit[]): string {
  const lines = units.map((u) => {
    const how = u.ending ? u.ending.kind : u.threadKey ? "unfinished" : "not started";
    const pr = u.pr ? ` — ${u.pr.url}` : "";
    return u.unit === TASK_UNIT
      ? `${ENDING_ICON[how] ?? "•"} ${how}${pr}`
      : `${ENDING_ICON[how] ?? "•"} ${u.unit} — ${how}${pr}`;
  });
  return lines.join("\n");
}

/** The instance ended: the parent's record is written, the card closes, and a
 *  plan's requesting thread gets the summary (a task's thread already has its
 *  unit's report). */
async function finish(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (body.outcome !== "completed" && body.outcome !== "failed")
    return json(400, { ok: false, error: "outcome must be completed or failed" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const units = await deps.instances.listUnits(instance.id);
  const visibility = await deps.channelVisibilityOf(instance.channelId);
  const record = parentRunRecord(instance, units, body.outcome, visibility, at);
  deps.runHistoryWriter.write(record);
  await drawCard(deps, instance, units, { icon: body.outcome === "completed" ? "✅" : "⚠️" }).catch(() => {});
  const isPlan = units.some((u) => u.unit !== TASK_UNIT);
  if (isPlan) {
    const io = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
    await io?.reply(`Plan ${instance.plan?.id ?? ""} ended (${body.outcome}):\n${planSummary(units)}`).catch(() => {});
  }
  (deps.log ?? console.log)(`[coordinator] ${instance.id}: finished ${body.outcome} — record ${record.id}`);
  return json(200, { ok: true, runId: record.id, at });
}

/** What the brief composer reads through the bot: the target repository at the
 *  base ref, a child's record, and the ship request the thread carried. */
function briefReaders(deps: AdminCoordinatorDeps, instance: CoordinatorInstance, io: ChannelIO): BriefReaders {
  const ref = instance.base ?? "main";
  return {
    readRepoFile: async (path) => {
      try {
        return (await deps.github.readFile(instance.repo, path, ref)).content;
      } catch {
        return undefined;
      }
    },
    readRunFacts: async (runId) => {
      const res = await deps.runs.getRun(runId, { include: "messages" });
      if (!res.ok || res.value.parentInstanceId !== instance.id) return undefined;
      const r = res.value;
      return {
        ...(r.verdict?.findings !== undefined ? { findings: r.verdict.findings } : {}),
        ...(r.dispositions !== undefined ? { dispositions: r.dispositions } : {}),
        ...(finalReplyOf(r.events) !== undefined ? { finalReply: finalReplyOf(r.events) } : {}),
      };
    },
    readShipRequest: async () => {
      const history = await io.history().catch(() => []);
      return [...history].reverse().find((h) => h.role === "user" && /\bagent:ship\b/.test(h.text))?.text;
    },
  };
}

type Step =
  | "authorize"
  | "plan"
  | "unit-start"
  | "branch"
  | "spawn"
  | "read-record"
  | "pr-check"
  | "round"
  | "unit-end"
  | "finish";
const STEPS: readonly Step[] = [
  "authorize",
  "plan",
  "unit-start",
  "branch",
  "spawn",
  "read-record",
  "pr-check",
  "round",
  "unit-end",
  "finish",
];

/** The step a path names — one of the literals above, never the path's own
 *  text, so what reaches a log line is a constant of this module. */
function stepOf(path: string): Step | undefined {
  const tail = path.slice(COORDINATOR_ADMIN_PREFIX.length);
  return STEPS.find((s) => s === tail);
}

/** What the headers alone decide, in this order: the step (404), the method
 *  (405), the bearer and its grant (401/403/503). Everything a refused caller
 *  is told, before a body is buffered — the ingress's own rule (http-ingress
 *  item 6) — and the one place the bearer is looked at per request. */
export function decideCoordinatorDoor(
  req: Pick<CoordinatorRouteRequest, "method" | "path" | "headers">,
  deps: AdminCoordinatorDeps,
): { kind: "refused"; response: IngressResponse } | { kind: "admitted"; step: Step; subject: string } {
  const step = stepOf(req.path);
  if (step === undefined) return { kind: "refused", response: json(404, { ok: false, error: "not found" }) };
  if ((req.method ?? "GET").toUpperCase() !== "POST")
    return { kind: "refused", response: json(405, { ok: false, error: `method not allowed: POST ${req.path}` }) };
  const auth = authorizeStep(req.headers, step, deps);
  if (!auth.ok) {
    (deps.log ?? console.warn)(`[coordinator] ${step} ${auth.response.status} — ${auth.reason}`);
    return { kind: "refused", response: auth.response };
  }
  return { kind: "admitted", step, subject: auth.subject };
}

/** The admitted step's own answer over its body. */
export async function answerCoordinatorStep(
  door: { step: Step; subject: string },
  body: string,
  deps: AdminCoordinatorDeps,
): Promise<IngressResponse> {
  if (door.step === "authorize") return json(200, { ok: true, subject: door.subject });
  const parsed = parseObject(body);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });
  switch (door.step) {
    case "plan":
      return plan(parsed.value, deps);
    case "unit-start":
      return unitStart(parsed.value, deps);
    case "branch":
      return branch(parsed.value, deps);
    case "spawn":
      return spawn(parsed.value, deps);
    case "read-record":
      return readRecord(parsed.value, deps);
    case "pr-check":
      return prCheck(parsed.value, deps);
    case "round":
      return round(parsed.value, deps);
    case "unit-end":
      return unitEnd(parsed.value, deps);
    default:
      return finish(parsed.value, deps);
  }
}

/** The routes, pure over a parsed request: the door, then the step. */
export async function handleCoordinatorRequest(
  req: CoordinatorRouteRequest,
  deps: AdminCoordinatorDeps,
): Promise<IngressResponse> {
  const door = decideCoordinatorDoor(req, deps);
  if (door.kind === "refused") return door.response;
  return answerCoordinatorStep(door, req.body, deps);
}

/** The node:http adapter: the door from the headers first — a refused caller,
 *  an unknown step or a wrong method never buffers a body — then the body, then
 *  the step's answer. */
export function createAdminCoordinatorHandler(
  deps: AdminCoordinatorDeps,
): (req: HttpRequest, res: ServerResponse) => void {
  const write = (res: ServerResponse, out: IngressResponse) => {
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  };
  return (req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? "/").split("?")[0]!;
        const door = decideCoordinatorDoor({ method: req.method, path, headers: req.headers }, deps);
        if (door.kind === "refused") {
          write(res, door.response);
          req.destroy();
          return;
        }
        const read = await readBody(req, MAX_ADMIN_BODY_BYTES);
        if (!read.ok) {
          write(res, json(413, { ok: false, error: "request body too large" }));
          req.destroy();
          return;
        }
        write(res, await answerCoordinatorStep(door, read.body, deps));
      } catch (err) {
        (deps.log ?? console.error)(`[coordinator] ${describe(err)}`);
        write(res, json(500, { ok: false, error: "internal error" }));
      }
    })();
  };
}
