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
// request at the reviewed head — from the child's own record of its post, and
// from GitHub only when that record is silent — the dispositions), `pr-check` (what heads the
// unit's branch: an open pull request, or — with none open — one already
// merged, which makes the unit done), `round` (a boundary the card draws),
// `unit-end` (the report in the unit's thread),
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

import { DEFAULT_GRANT } from "../core/budgets.js";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { AGENTS } from "../agents/registry.js";
import { authorize } from "../core/authz/authorize.js";
import { resolveActor, type GrantsLookup } from "../core/authz/actor.js";
import type { ChannelVisibility } from "../core/authz/types.js";
import { composeChild, type BriefReaders } from "../core/coordinator/briefs.js";
import {
  COORDINATOR_STEP_ACTION,
  COORDINATOR_STEP_PATH_PREFIX,
  PLAN_MERGE_ACTION,
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
import { CHANGES_TOKEN, LGTM_TOKEN, type ReviewVerdictKind } from "../core/reviewVerdict.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent, ShipRoundOutcome } from "../core/runEvents.js";
import type { RunHistoryWriter } from "../core/runHistoryWriter.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT, type RunRecord } from "../core/runRecord.js";
import type { RunsService, RunView } from "../core/runsService.js";
import { parsePlanBranch, type Brief } from "../core/ship/coordinator.js";
import { isHandoffShape, renderHandoffComment, type Handoff } from "../core/ship/handoff.js";
import { normalizeHead, sameCommit } from "../core/reviewedHead.js";
import {
  DEFAULT_ADDRESS_SEVERITY,
  resolveShipCaps,
  shipRoundHeader,
  type AddressSeverity,
  type AddressSeveritySource,
} from "../core/shipPipeline.js";
import { createCardShell } from "../core/statusCardFrame.js";
import { systemClock } from "../core/trace/clock.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import { authenticateIngressBearer } from "../deploy/restart.js";
import type { GithubApi } from "../execution/githubApi.js";
import type { GithubIdentity } from "../execution/githubApp.js";
import type {
  CommitChecks,
  MergedPrRef,
  MergeResult,
  OpenedPullRequest,
  OpenPrRef,
  PullRequestFacts,
  PullRequestReview,
  PullRequestTarget,
} from "../execution/githubPulls.js";
import type { Secret } from "../secrets.js";
import { readBody, type IngressResponse } from "./http.js";

export const COORDINATOR_ADMIN_PREFIX = COORDINATOR_STEP_PATH_PREFIX;
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
   *  user, tagged, with the unit's contract for a round-0 child. */
  dispatch: (
    msg: IncomingMessage,
    io: ChannelIO,
    opts: Pick<DispatchOptions, "coordinator" | "contract"> & { coordinator: CoordinatorTag },
  ) => Promise<DispatchOutcome>;
  /** The channel handle for a thread (the resume's `resumeSlackIO` from the
   *  row's parts — the card's ts when the handle must redraw it); undefined for
   *  a platform no thread can be rebuilt on. */
  ioFor: (thread: { threadKey: string; userId: string; cardTs?: string }) => ChannelIO | undefined;
  /** The open pull request heading a branch (githubPulls.findOpenPrByHead), and
   *  — asked only when there is none — the merged one (githubPulls.findMergedPrByHead):
   *  a unit whose pull request merged before the runner reached it is done, not aborted. */
  findOpenPrByHead: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  findMergedPrByHead: (repo: string, branch: string) => Promise<MergedPrRef | null>;
  /** The recover path's one write (githubPulls.openPullRequest, open-or-edit by
   *  head branch): a coding child that pushed and then died leaves its work on
   *  the branch — the pr-check opens the pull request from the branch itself
   *  instead of answering `none` over stranded work (agent-ship item 15). */
  openPullRequest: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /** The target repository at the base ref (the plan, the specs, the rules), its
   *  issues (a unit's board issue) and the comment a unit's ending leaves there
   *  — the App's GitHub reads and the one write beside the merge. */
  github: Pick<GithubApi, "readFile" | "listIssues" | "commentIssue">;
  /** Round 0's branch create (githubPulls.createBranchRef): 422 already-exists is success inside. */
  createBranchRef: (repo: string, branch: string, fromRef: string) => Promise<void>;
  /** The reviews on a pull request (githubPulls.fetchPullRequestReviews) and the
   *  identity this bot posts as: whether the bot's verdict stands at a head. */
  fetchPrReviews: (pr: { repo: string; number: number }) => Promise<PullRequestReview[] | undefined>;
  selfIdentity: () => Promise<GithubIdentity | undefined>;
  /** The pause between `read-record`'s looks at GitHub's review list when the
   *  child's record carries no post of its own (`REVIEW_POSTED_RECHECK_MS`
   *  apart); tests pass one that records instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** The merge step's facts and its one write (githubPulls): the pull request
   *  as GitHub has it, the checks at a head, the squash at exactly that head. */
  fetchPrFacts: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  fetchCommitChecks: (repo: string, sha: string) => Promise<CommitChecks | undefined>;
  mergePullRequest: (
    pr: { repo: string; number: number },
    opts: { sha: string; title: string },
  ) => Promise<MergeResult>;
  /** Records "this instance's merge step waits at this head" on every `pending`
   *  answer — the check-run intake's address book (checksIntake.ts,
   *  http-ingress.md item 12). Optional: without it the bounded wait stands alone. */
  noteMergeWait?: (headSha: string, instanceId: string, at: number) => void;
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
  findings: "coding",
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
        if (p.codingRunId !== undefined && (typeof p.codingRunId !== "string" || !RUN_ID_PATTERN.test(p.codingRunId)))
          return invalid("brief.prior.codingRunId must be a run id");
        prior = {
          reviewRunId: p.reviewRunId,
          ...(p.codingRunId !== undefined ? { codingRunId: p.codingRunId as string } : {}),
        };
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
    case "findings": {
      const n = pr();
      if (!n.ok) return n;
      const review = runId("reviewRunId");
      if (!review.ok) return review;
      return { ok: true, value: { kind: "findings", unit: b.unit, pr: n.value, reviewRunId: review.value } };
    }
    default:
      return invalid("brief.kind must be contract, review or findings");
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

/** A generated plan's instance: `plan` without a `path` — the mark the hand-off
 *  writes for a task request, which keeps its one unit in the requesting
 *  thread (agent-ship item 16). */
const isGenerated = (instance: CoordinatorInstance): boolean => instance.plan?.path === undefined;

/** The thread a unit's coding children run in, and where its findings are
 *  dispatched: the unit's own once opened, the requesting thread for a
 *  generated plan's unit. The review child's thread is `ensureReviewThread`. */
function unitThread(instance: CoordinatorInstance, row: CoordinatorUnit | undefined) {
  const threadKey = row?.threadKey ?? (row === undefined || isGenerated(instance) ? instance.threadKey : undefined);
  const sourceUrl = row?.sourceUrl ?? (threadKey === instance.threadKey ? instance.sourceUrl : undefined);
  return { threadKey, sourceUrl };
}

type OpenedThreadRef = { threadKey: string; sourceUrl?: string };

/** A thread opened top-level in the requesting thread's channel with `lead`
 *  (`ChannelIO.openThread`): `503 no_channel` without a channel that can,
 *  `502 thread_failed` on a failed open, both passing conditions the runner
 *  asks again on. */
async function openThreadFromRequester(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  lead: string,
  at: number,
): Promise<{ ok: true; thread: OpenedThreadRef } | { ok: false; response: IngressResponse }> {
  const parent = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
  if (!parent?.openThread) return { ok: false, response: json(503, { ok: false, error: "no_channel", at }) };
  try {
    const opened = await parent.openThread(lead);
    return {
      ok: true,
      thread: {
        threadKey: opened.thread.threadKey,
        ...(opened.thread.sourceUrl !== undefined ? { sourceUrl: opened.thread.sourceUrl } : {}),
      },
    };
  } catch (err) {
    return { ok: false, response: json(502, { ok: false, error: "thread_failed", message: describe(err), at }) };
  }
}

/** The unit's review thread (run-history item 50's `reviewThread`), opened once
 *  beside the unit's thread and written on the row: by `unit-start`, or by the
 *  first review spawn of a row written before the field existed. Every review
 *  round runs there, so the review child's worktree is its own and readonly
 *  and no round wipes the coding thread's (record 0034). */
async function ensureReviewThread(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  at: number,
): Promise<{ ok: true; row: CoordinatorUnit; thread: OpenedThreadRef } | { ok: false; response: IngressResponse }> {
  if (row.reviewThread !== undefined) return { ok: true, row, thread: row.reviewThread };
  const opened = await openThreadFromRequester(deps, instance, reviewLead(instance, row), at);
  if (!opened.ok) return opened;
  const updated: CoordinatorUnit = { ...row, reviewThread: opened.thread };
  await deps.instances.putUnits([updated]);
  return { ok: true, row: updated, thread: opened.thread };
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
  if (io.attachFile) out.attachFile = (file) => io.attachFile!(file);
  if (io.uploadTicket) out.uploadTicket = (file) => io.uploadTicket!(file);
  if (io.workItems) out.workItems = (actor) => io.workItems!(actor);
  if (io.checkAccess) out.checkAccess = (userId) => io.checkAccess!(userId);
  if (io.isolateFollowUps) out.isolateFollowUps = true;
  if (io.acknowledge) out.acknowledge = (text) => io.acknowledge!(text);
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
  const own = unitThread(instance, unit.row);
  // A plan unit's thread is opened by `unit-start`; a spawn before it has no
  // thread to run in — a passing condition (the runner asks again), stamped
  // like every answer.
  if (own.threadKey === undefined) return json(409, { ok: false, error: "unit_not_started", unit: req.unit, at });
  // The thread the child runs in: a review child's is the unit's review thread,
  // opened here for a row written before the field existed; a coding child and
  // the findings step's run share the unit's own thread, whose coding session
  // the findings continue.
  let row = unit.row;
  let thread: OpenedThreadRef = {
    threadKey: own.threadKey,
    ...(own.sourceUrl !== undefined ? { sourceUrl: own.sourceUrl } : {}),
  };
  if (req.preset === "review" && row !== undefined) {
    const review = await ensureReviewThread(deps, instance, row, at);
    if (!review.ok) return review.response;
    row = review.row;
    thread = review.thread;
  }
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
  let turn: { prompt: string; ref?: string; contract?: DispatchOptions["contract"] };
  if (req.brief !== undefined) {
    if (row === undefined) return json(400, { ok: false, error: "a brief needs the unit it runs for" });
    try {
      turn = await composeChild(req.brief, instance, row, briefReaders(deps, instance));
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
  // child's thread, as the requester the parent record names. The directive is
  // the message's own (`childRequestText`), so the findings step's `agent:coding`
  // resolves the coding preset whatever a person's detour in the thread or a
  // lost store would have made sticky.
  const msg: IncomingMessage = {
    channelId: instance.channelId,
    userId: instance.userId,
    ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
    ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
    ...(instance.postedBy !== undefined ? { postedBy: instance.postedBy } : {}),
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
  // The child is dispatched at its unit branch (the resident attaches there),
  // so the thread cannot tell the post-step which branch the pull request
  // targets: the tag says it — the plan's base — when the instance knows one.
  const tag: CoordinatorTag = {
    parentInstanceId: instance.id,
    idempotencyKey: key,
    ...(instance.base !== undefined ? { base: instance.base } : {}),
  };
  const settled = deps
    .dispatch(msg, child, {
      coordinator: tag,
      ...(turn.contract !== undefined ? { contract: turn.contract } : {}),
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

/** How many times `read-record` looks at GitHub's review list for a review
 *  child whose record carries no post of its own, and the pause between looks:
 *  the list can lag a post it accepted a second ago, and the finish event that
 *  wakes the runner arrives within that second. Three looks over a few
 *  seconds cover the lag seen live; the merge step re-verifies the approval at
 *  the head regardless, so this pre-check can afford patience and the guard
 *  stays strict. */
export const REVIEW_POSTED_CHECKS = 3;
export const REVIEW_POSTED_RECHECK_MS = 2_000;

/** Whether the bot's own verdict stands on the pull request at the head the
 *  child reviewed: a review by this bot's identity, pinned to that head, whose
 *  body starts with the verdict's token. Unknown (no identity, GitHub silent)
 *  → undefined, never a guess either way. */
async function reviewPostedAt(
  deps: AdminCoordinatorDeps,
  pr: { repo: string; number: number },
  verdict: ReviewVerdictKind,
  head: string,
): Promise<boolean | undefined> {
  const [reviews, self] = await Promise.all([
    deps.fetchPrReviews(pr).catch(() => undefined),
    deps.selfIdentity().catch(() => undefined),
  ]);
  if (reviews === undefined || self === undefined) return undefined;
  const token = verdict === "approve" ? LGTM_TOKEN : CHANGES_TOKEN;
  return reviews.some(
    (r) =>
      r.author?.login === self.login &&
      (r.author.id === undefined || r.author.id === self.id) &&
      r.commitId !== undefined &&
      sameCommit(r.commitId.toLowerCase(), head) &&
      r.body.startsWith(token),
  );
}

/** `reviewPostedAt`, asked up to `REVIEW_POSTED_CHECKS` times a pause apart
 *  until it answers true: a review posted a second ago may not be in GitHub's
 *  list yet, and a silent GitHub may answer on the next look. The last look's
 *  answer stands — false when every look found nothing, undefined when every
 *  look was silent. */
async function reviewPostedAtPatiently(
  deps: AdminCoordinatorDeps,
  pr: { repo: string; number: number },
  verdict: ReviewVerdictKind,
  head: string,
): Promise<boolean | undefined> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let answer: boolean | undefined;
  for (let look = 1; look <= REVIEW_POSTED_CHECKS; look++) {
    answer = await reviewPostedAt(deps, pr, verdict, head);
    if (answer === true || look === REVIEW_POSTED_CHECKS) break;
    await sleep(REVIEW_POSTED_RECHECK_MS);
  }
  return answer;
}

/** What the child's own record says about its post (agent-review.md item 18),
 *  for the unit's pull request: `true` when it posted this verdict at the
 *  reviewed head to that pull request, `false` with the reason when it recorded
 *  a skip or a failure, and nothing when the record is silent (a child from
 *  before the fact existed) or names another head, verdict or pull request —
 *  then GitHub decides. */
function reviewPostedByRecord(
  record: Pick<RunView, "reviewPost" | "reviewHead" | "verdict">,
  pr: { repo: string; number: number },
): { reviewPosted: boolean; reviewPostReason?: string } | undefined {
  const post = record.reviewPost;
  if (post === undefined || record.reviewHead === undefined || record.verdict === undefined) return undefined;
  if (!post.posted) return { reviewPosted: false, reviewPostReason: post.reason };
  const same =
    post.target.repo === pr.repo &&
    post.target.number === pr.number &&
    sameCommit(post.head.toLowerCase(), record.reviewHead) &&
    post.verdict === record.verdict.verdict;
  return same ? { reviewPosted: true } : undefined;
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
  // stands on the pull request, the coding run's dispositions.
  const full = await deps.runs.getRun(body.runId, { include: "messages" });
  const record = full.ok ? full.value : view;
  const finalReply = finalReplyOf(record.events);
  const pr = prOpenedOf(record.events);
  // Whether the verdict stands on the unit's pull request: the child's own
  // record of its post first (item 18) — it posted, or it recorded why not —
  // and GitHub only when the record is silent, looked at patiently: the
  // finish event wakes the runner within a second of the post, and GitHub's
  // review list can lag it. The merge step re-verifies the approval at the
  // head regardless, so the pre-check may be patient while the guard stays strict.
  let posted: { reviewPosted: boolean; reviewPostReason?: string } | undefined;
  if (record.verdict !== undefined && record.reviewHead !== undefined && typeof body.unit === "string") {
    const instance = await deps.instances.get(id.value);
    const row = instance ? (await deps.instances.listUnits(instance.id)).find((u) => u.unit === body.unit) : undefined;
    if (instance && row?.pr !== undefined) {
      const unitPr = { repo: instance.repo, number: row.pr.number };
      posted = reviewPostedByRecord(record, unitPr);
      if (posted === undefined) {
        const seen = await reviewPostedAtPatiently(deps, unitPr, record.verdict.verdict, record.reviewHead);
        if (seen !== undefined) posted = { reviewPosted: seen };
      }
    }
  }
  return json(200, {
    ok: true,
    run: {
      ...coordinatorRunView(view, id.value, finalReply),
      ...(pr !== undefined ? { pr } : {}),
      ...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
      ...(record.reviewHead !== undefined ? { reviewHead: record.reviewHead } : {}),
      ...(posted !== undefined ? { reviewPosted: posted.reviewPosted } : {}),
      ...(posted?.reviewPostReason !== undefined ? { reviewPostReason: posted.reviewPostReason } : {}),
      ...(record.dispositions !== undefined ? { dispositions: record.dispositions } : {}),
      ...(record.handoff !== undefined ? { handoff: true } : {}),
      // The renewal's facts (decision 0046): progress is read off these.
      ...(record.pushed !== undefined ? { pushed: record.pushed } : {}),
      ...(record.lease !== undefined ? { leaseStartedAt: record.lease.startedAt } : {}),
      // What the child cost, as the runs service prices it (costs.md item 4c):
      // null when unknown — no usage on the record, or a model without a price
      // — so a capped grant never renews on an understated total.
      costUsd: record.cost?.usd ?? null,
      ...(record.handoff !== undefined ? { handoffLists: record.handoff } : {}),
    },
    at,
  });
}

/** Why a recover pr-check opened nothing: GitHub refused the create because
 *  nothing sits between the base and the head (`no_commits`), or the instance
 *  names no base to open against and no create was tried (`no_base`). Any
 *  other GitHub failure is not a reason but an outage: it propagates, the
 *  check answers `github_unavailable`, and the step is asked again. */
type Unrecovered = "no_commits" | "no_base";
type Recovered = { kind: "opened"; pr: OpenedPullRequest } | { kind: "none"; why: Unrecovered };

/** GitHub's refusal of a pull request over an empty branch: HTTP 422 with
 *  "No commits between <base> and <head>". Everything else that fails the
 *  create is treated as GitHub being unavailable. */
function isEmptyBranchRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP 422\b/.test(message) && /no commits between/i.test(message);
}

/** The recover path's pull request (agent-ship items 10 and 15): a coding
 *  child pushed its branch and then died — the pull request is opened from the
 *  branch itself, title from the unit, body from the child's submitted
 *  description when the record holds one, else a minimal body naming the unit.
 *  `none` names why when nothing could be opened; a GitHub failure that is
 *  neither reason is thrown for the caller's `github_unavailable`. */
async function recoverPushedBranch(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit | undefined,
  branch: string,
  runId: string,
): Promise<Recovered> {
  if (instance.base === undefined) return { kind: "none", why: "no_base" };
  const unitName = row?.unit ?? "the unit";
  let title = row?.title !== undefined ? `${row.unit}: ${row.title}` : `${unitName} — ${branch}`;
  let prBody = `Opened by the plan runner from the pushed branch \`${branch}\`: the coding run ${runId} of ${unitName} ended before it could open the pull request or submit its description. The review round asks for the description.`;
  try {
    const full = await deps.runs.getRun(runId, { include: "messages" });
    if (full.ok && full.value.parentInstanceId === instance.id) {
      const events = full.value.events ?? [];
      const descEvent = [...events].reverse().find((e) => e.type === "pr_description");
      const desc = descEvent?.type === "pr_description" ? descEvent.description : undefined;
      if (desc !== undefined) {
        title = desc.title;
        // A record written under the previous contract carries the why as
        // `whatWhy`; a body with neither gets no second paragraph, never "undefined".
        const why = desc.why ?? (desc as { whatWhy?: string }).whatWhy;
        prBody = [
          desc.tldr,
          why,
          "_Rendered by the plan runner from the coding run's submitted description; the run ended before it could open the pull request itself._",
        ]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n");
      }
    }
  } catch {
    // the minimal body stands
  }
  try {
    const pr = await deps.openPullRequest({
      repo: instance.repo,
      headBranch: branch,
      base: instance.base,
      title,
      body: prBody,
    });
    return { kind: "opened", pr };
  } catch (err) {
    // Nothing to recover only when GitHub says the branch is empty; any other
    // failure is an outage the caller reports, never a claim that nothing was pushed.
    if (isEmptyBranchRefusal(err)) return { kind: "none", why: "no_commits" };
    throw err;
  }
}

async function prCheck(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const recover =
    typeof body.recover === "object" &&
    body.recover !== null &&
    typeof (body.recover as Record<string, unknown>).runId === "string" &&
    RUN_ID_PATTERN.test((body.recover as Record<string, unknown>).runId as string)
      ? { runId: (body.recover as Record<string, unknown>).runId as string }
      : undefined;
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit as string | undefined);
  if (!unit.ok) return unit.response;
  const branch = unit.row?.branch ?? instance.branch;
  // The unit's row remembers its pull request, so a person reads it there.
  const remember = async (pr: { number: number; url: string }) => {
    if (unit.row && (unit.row.pr?.number !== pr.number || unit.row.pr.url !== pr.url))
      await deps.instances.putUnits([{ ...unit.row, pr }]);
  };
  try {
    const open = await deps.findOpenPrByHead(instance.repo, branch);
    if (open) {
      await remember({ number: open.number, url: open.htmlUrl });
      return json(200, {
        ok: true,
        state: "open",
        prNumber: open.number,
        url: open.htmlUrl,
        ...(open.headSha !== undefined ? { headSha: open.headSha } : {}),
        // The pull request's own auto-merge fact (agent-ship item 9), so a
        // merge_ready ending can name it at the approved head.
        ...(open.autoMergeEnabled !== undefined ? { autoMergeEnabled: open.autoMergeEnabled } : {}),
        at,
      });
    }
    // No open pull request heads the branch: one already merged — by a person,
    // or by an earlier attempt that died after its merge — makes the unit done
    // rather than aborted (record 0031's `merged` ending, reached without the
    // runner's merge). Asked only now: an open pull request is the round's.
    const merged = await deps.findMergedPrByHead(instance.repo, branch);
    if (!merged) {
      // A dead coding child's pushed work is recovered here: the pull request
      // is opened from the branch itself rather than the round ending aborted
      // with the work stranded (agent-ship items 10 and 15).
      if (recover === undefined) return json(200, { ok: true, state: "none", at });
      const recovered = await recoverPushedBranch(deps, instance, unit.row, branch, recover.runId);
      if (recovered.kind === "opened") {
        await remember({ number: recovered.pr.number, url: recovered.pr.htmlUrl });
        return json(200, { ok: true, state: "open", prNumber: recovered.pr.number, url: recovered.pr.htmlUrl, at });
      }
      return json(200, { ok: true, state: "none", unrecovered: recovered.why, at });
    }
    await remember({ number: merged.number, url: merged.htmlUrl });
    return json(200, {
      ok: true,
      state: "merged",
      prNumber: merged.number,
      url: merged.htmlUrl,
      sha: merged.sha,
      mergedAt: merged.mergedAt,
      at,
    });
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
}

// ---- the plan runner's own steps: the plan, a unit's start and end, the branch, the card, the record ----

/** What the coordinator reads first: the instance's units with where each
 *  stands and the caps — the numbers its machine runs on, none of them in the
 *  instance's params; the children's asks and floors it reads from the budgets
 *  module itself. */
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
    // Who merges: the instance's field; a record written before it existed is a person's merge.
    merge: instance.merge ?? "person",
    // The severity to address, beside `merge`: one value the machine reads.
    addressSeverity: instance.addressSeverity ?? "minor",
    addressSeveritySource: instance.addressSeveritySource ?? "org",
    // The grant beside it (decision 0046): absent on the record, nothing renews.
    grant: instance.grant ?? DEFAULT_GRANT,
    grantSource: instance.grantSource ?? "org",
    // The mark (item 16): the machine's report keys its re-issue line on it.
    generated: isGenerated(instance),
    repo: instance.repo,
    base: instance.base ?? "main",
    caps: instance.caps ?? resolveShipCaps(undefined),
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
 *  task's is the requesting thread itself), its review thread beside it, its
 *  board issue looked up, and the row says so. Idempotent: a unit with its
 *  threads answers them again. A review thread whose open fails leaves the
 *  unit thread on the row, so the retry opens the review thread alone. */
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
    if (isGenerated(instance)) {
      row = {
        ...row,
        threadKey: instance.threadKey,
        ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
      };
    } else {
      const opened = await openThreadFromRequester(deps, instance, unitLead(instance, row), at);
      if (!opened.ok) return opened.response;
      row = { ...row, ...opened.thread };
    }
  }
  if (row.reviewThread === undefined) {
    const review = await ensureReviewThread(deps, instance, row, at);
    if (!review.ok) {
      // The unit thread stands: written, so the retry does not open a second one.
      if (row !== unit.row) await deps.instances.putUnits([row]);
      return review.response;
    }
    row = review.row;
  }
  if (row.issue === undefined && !isGenerated(instance)) {
    const issue = await unitIssueOf(deps, instance.repo, row.unit);
    if (issue !== undefined) row = { ...row, issue };
  }
  row = { ...row, startedAt: row.startedAt ?? at };
  await deps.instances.putUnits([row]);
  (deps.log ?? console.log)(
    `[coordinator] ${instance.id} ${row.unit}: started in ${row.threadKey}, review in ${row.reviewThread?.threadKey}`,
  );
  return json(200, {
    ok: true,
    threadKey: row.threadKey,
    reviewThreadKey: row.reviewThread?.threadKey,
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

/** The lead of a unit's review thread: the same reader, told this thread holds the unit's review rounds. */
function reviewLead(instance: CoordinatorInstance, row: CoordinatorUnit): string {
  const who = instance.userName ?? instance.userId;
  const from = instance.sourceUrl !== undefined ? `[the *ship* run](${instance.sourceUrl})` : "the *ship* run";
  const what = isGenerated(instance) ? "the task" : `unit ${row.unit}${row.title ? ` — ${row.title}` : ""}`;
  return `↳ *ship* review of ${what} for ${who}, from ${from}: \`${row.branch}\` in ${instance.repo}`;
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

/** One line per unit on the parent's card: the round in flight or how the unit
 *  ended — the task wording (no unit id) for a generated plan's one unit. The
 *  round header names the severity in force and its source (agent-ship item
 *  6), the instance's value beside `merge`. */
function unitLines(
  units: readonly CoordinatorUnit[],
  generated: boolean,
  severity: { level: AddressSeverity; source: AddressSeveritySource },
): string[] {
  return units.map((u) => {
    const last = u.rounds.at(-1);
    const state = u.ending
      ? u.ending.kind
      : last
        ? `${shipRoundHeader({ index: last.index, agent: last.agent }, severity)} · ${last.outcome}`
        : u.threadKey
          ? "starting"
          : "waiting";
    // A renewed unit names its segment (decision 0046): `segment 2 · …`.
    const seg =
      u.ending === undefined && u.segments !== undefined && u.segments.length > 0
        ? `segment ${u.segments[u.segments.length - 1]!.index} · `
        : "";
    return generated ? `${seg}${state}` : `${u.unit} · ${seg}${state}`;
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
  const detail = unitLines(units, isGenerated(instance), {
    level: instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY,
    source: instance.addressSeveritySource ?? "org",
  });
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

/** The segment a continued ending opens, as the driver names it: its index (two up), the sha it continues from, the run whose write-up briefs it. */
function parseSegment(raw: unknown): { index: number; from?: string; runId?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.index !== "number" || !Number.isInteger(s.index) || s.index < 2) return undefined;
  const from = normalizeHead(s.from);
  return {
    index: s.index,
    ...(from !== undefined ? { from } : {}),
    ...(typeof s.runId === "string" && RUN_ID_PATTERN.test(s.runId) ? { runId: s.runId } : {}),
  };
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
  // A review_pending ending names the coding child's own last push (the
  // driver's `headSha`): persisted on the row as `lastPush`, so the next
  // attempt's rows carry it and its pre-check starts at the review round.
  const lastPush = normalizeHead(body.headSha);
  // A continued ending is a segment's end, not the unit's (decision 0046):
  // the renewal is written as a row keyed by the segment it opens — once; a
  // runner reclaimed between the segment's end and its renewal finds the row
  // and does not renew twice — and the unit keeps no ending.
  const segment = ending.kind === "continued" ? parseSegment(body.segment) : undefined;
  if (ending.kind === "continued" && segment === undefined)
    return json(400, { ok: false, error: "a continued ending must carry the segment it opens" });
  const segments = row.segments ?? [];
  const updated: CoordinatorUnit = {
    ...row,
    ...(pr && typeof pr.number === "number" && typeof pr.url === "string"
      ? { pr: { number: pr.number, url: pr.url } }
      : {}),
    ...(lastPush !== undefined ? { lastPush } : {}),
    ...(segment !== undefined
      ? { segments: segments.some((s) => s.index === segment.index) ? segments : [...segments, { ...segment, at }] }
      : { ending: { kind: ending.kind, report: ending.report, at } }),
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
  // The unit's ending reaches the board (agent-ship item 14's destination):
  // when the row names an issue, the report lands there too — a merge GitHub
  // refused, a cap, a stop — and under it the last coding child's typed handoff
  // as the parent renders it, so a deviation the child recorded reaches the
  // board without a person copying it over. Best effort, like the thread's.
  if (row.issue !== undefined) {
    const handoff = await codingHandoffOf(deps, instance, body.codingRunId);
    const rendered =
      handoff !== undefined
        ? renderHandoffComment(handoff, { unitId: row.unit, ...(updated.pr !== undefined ? { pr: updated.pr } : {}) })
        : undefined;
    const comment =
      `**Plan runner — ${row.unit} ended \`${ending.kind}\`**${updated.pr ? ` · ${updated.pr.url}` : ""}\n\n${ending.report}` +
      (rendered !== undefined ? `\n\n${rendered}` : "");
    await deps.github
      .commentIssue(instance.repo, row.issue, comment)
      .catch((err) =>
        (deps.log ?? console.warn)(
          `[coordinator] ${instance.id} ${row.unit}: the board comment could not be posted: ${describe(err)}`,
        ),
      );
  }
  await drawCard(
    deps,
    instance,
    units.map((u) => (u.unit === updated.unit ? updated : u)),
  ).catch(() => {});
  (deps.log ?? console.log)(`[coordinator] ${instance.id} ${row.unit}: ended ${ending.kind}`);
  return json(200, { ok: true, told, at });
}

/** The typed handoff the unit's last coding child submitted (agent-ship item
 *  14), read from its record — a run of this instance and no other, as
 *  `read-record` reads; none for a run the history lacks, a run outside the
 *  instance, a record without one, or an id that is not a run id. Never a
 *  refusal: the ending is recorded whatever became of the handoff. */
async function codingHandoffOf(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  runId: unknown,
): Promise<Handoff | undefined> {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return undefined;
  const res = await deps.runs.getRun(runId).catch(() => undefined);
  if (res === undefined || !res.ok || res.value.parentInstanceId !== instance.id) return undefined;
  return isHandoffShape(res.value.handoff) ? res.value.handoff : undefined;
}

// ---- the merge (docs/reference/specs/http-ingress.md item 9; record 0031's merge grant) ------------

/** The release pull request — release-please's, which deploys — is always a person's merge. */
function isReleasePullRequest(facts: PullRequestFacts): boolean {
  return (
    (facts.headRef?.startsWith("release-please--") ?? false) || /^chore\(main\): release\b/.test(facts.title ?? "")
  );
}

/**
 * `POST /admin/coordinator/merge {parentInstanceId, unit, prNumber, headSha}`:
 * the runner's squash of a unit's pull request, executed only when every guard
 * holds — the bearer holds `plan:merge`, the unit's branch is a plan branch of
 * THIS instance's plan, the pull request is open, heads that branch and stands
 * at exactly the approved head, the bot's own approving review is pinned to it
 * and every check at it is green — and refused by reason otherwise, so a person
 * decides: the release pull request by name, any other branch as "waits for a
 * person", GitHub's own refusal (a conflict, a branch protection, a moved head)
 * in GitHub's words. Checks still running answer `pending` for the machine's
 * poll. GitHub unreachable is a passing condition (502), never a verdict.
 */
async function merge(
  body: Record<string, unknown>,
  deps: AdminCoordinatorDeps,
  subject: string,
): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  if (typeof body.prNumber !== "number" || !Number.isInteger(body.prNumber) || body.prNumber < 1)
    return json(400, { ok: false, error: "prNumber must be a pull request number" });
  const headSha = normalizeHead(body.headSha);
  if (headSha === undefined) return json(400, { ok: false, error: "headSha must be the approved head (7 to 40 hex)" });
  const at = (deps.clock ?? systemClock)();
  const refused = (reason: string) => json(200, { ok: true, outcome: "refused", reason, at });
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit);
  if (!unit.ok) return unit.response;
  const row = unit.row!;
  const log = deps.log ?? console.log;
  // The grant: the bearer's actor on `plan:merge`, decided here beside the
  // door's `coordinator:step`. Withdrawn, every merge is a person's.
  const actor = resolveActor({ surface: "http", subjectId: subject }, deps.grantsFor);
  if (!authorize(actor, PLAN_MERGE_ACTION, { type: "command", id: "coordinator.merge" }).allow)
    return refused(
      `the runner holds no ${PLAN_MERGE_ACTION} grant (grants["http:${subject}"] in config.yaml) — a person merges`,
    );
  // The instance's field decides, never the requester or the branch's name:
  // the hand-off wrote `merge: runner` only on a seeded plan.
  if (instance.merge !== "runner")
    return refused(`the instance's \`merge\` field says ${instance.merge ?? "person"} — waits for a person's merge`);
  // Defense in depth: the field only ever rides a plan instance, so the unit's
  // branch must still be a branch of THIS instance's plan.
  const planBranch = parsePlanBranch(row.branch);
  if (instance.plan === undefined || planBranch === undefined || planBranch.planId !== instance.plan.id)
    return refused(
      `the instance's \`merge\` field says runner but \`${row.branch}\` is not a branch of plan \`${instance.plan?.id ?? "(none)"}\` — waits for a person's merge`,
    );
  const pr = { repo: instance.repo, number: body.prNumber };
  const where = `${instance.repo}#${pr.number}`;
  let facts: PullRequestFacts | undefined;
  try {
    facts = await deps.fetchPrFacts(pr);
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
  if (facts === undefined)
    return json(502, { ok: false, error: "github_unavailable", message: `${where} could not be read`, at });
  if (isReleasePullRequest(facts))
    return refused(`${where} is the release pull request — always a person's merge, never the runner's`);
  if (facts.state !== "open") {
    // Already merged — auto-merge fired, or a person merged after the approval:
    // the unit is done, not refused. The door merged nothing, so the outcome
    // says `by: other` with the merge commit and the time (spec item 9).
    if (facts.mergedAt !== undefined && facts.mergeCommitSha !== undefined)
      return json(200, {
        ok: true,
        outcome: "merged",
        by: "other",
        sha: facts.mergeCommitSha,
        mergedAt: facts.mergedAt,
        at,
      });
    return refused(`${where} is ${facts.state}`);
  }
  if (facts.headRef !== row.branch)
    return refused(`${where} heads \`${facts.headRef ?? "?"}\`, not the unit's branch \`${row.branch}\``);
  if (facts.headSha === undefined || !sameCommit(facts.headSha, headSha))
    return refused(
      `the head of ${where} moved: \`${facts.headSha?.slice(0, 7) ?? "?"}\` is not the approved \`${headSha.slice(0, 7)}\``,
    );
  // A conflicting pull request is refused at once, BEFORE the checks are read
  // (spec item 9): zero checks stays pending only on a mergeable pull request.
  // The refusal names the pull request's own base — a stacked unit rebases
  // onto its parent, not onto the default branch.
  if (facts.mergeableState === "dirty")
    return refused(
      `${where} conflicts with \`${facts.baseRef ?? "its base"}\` at \`${headSha.slice(0, 7)}\`, rebase and re-issue`,
    );
  const approved = await reviewPostedAt(deps, pr, "approve", headSha);
  if (approved === undefined)
    return json(502, {
      ok: false,
      error: "github_unavailable",
      message: `the reviews of ${where} could not be read`,
      at,
    });
  if (!approved) return refused(`no approving review by the bot stands on ${where} at \`${headSha.slice(0, 7)}\``);
  const checks = await deps.fetchCommitChecks(instance.repo, headSha).catch(() => undefined);
  if (checks === undefined)
    return json(502, {
      ok: false,
      error: "github_unavailable",
      message: `the checks at ${headSha.slice(0, 7)} could not be read`,
      at,
    });
  if (checks.failed.length > 0) return refused(`CI is red at \`${headSha.slice(0, 7)}\`: ${checks.failed.join(", ")}`);
  // A `pending` answer is what the machine's merge wait rides: the intake
  // (checksIntake.ts) reads this registry to know whom the checks-settled
  // event at this head wakes (http-ingress.md item 12).
  if (checks.total === 0) {
    deps.noteMergeWait?.(headSha, id.value, at);
    return json(200, {
      ok: true,
      outcome: "pending",
      reason: `no check has reported at \`${headSha.slice(0, 7)}\` yet`,
      at,
    });
  }
  if (checks.pending.length > 0) {
    deps.noteMergeWait?.(headSha, id.value, at);
    return json(200, {
      ok: true,
      outcome: "pending",
      reason: `${checks.pending.length} check(s) still running at \`${headSha.slice(0, 7)}\`: ${checks.pending.join(", ")}`,
      at,
    });
  }
  let merged: MergeResult;
  try {
    merged = await deps.mergePullRequest(pr, {
      sha: headSha,
      title: facts.title ?? `Merge pull request #${pr.number}`,
    });
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
  if (!merged.ok) {
    log(
      `[coordinator] ${instance.id} ${row.unit}: GitHub refused the merge of ${where} (HTTP ${merged.status}): ${merged.reason}`,
    );
    return refused(`GitHub refused the merge of ${where} (HTTP ${merged.status}): ${merged.reason}`);
  }
  log(
    `[coordinator] ${instance.id} ${row.unit}: merged ${where} at ${headSha.slice(0, 7)} → ${merged.sha.slice(0, 7)}`,
  );
  return json(200, { ok: true, outcome: "merged", sha: merged.sha, at });
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
    // The instance the record is the story of (agent-ship item 17): the run
    // page reads it to list the instance's units.
    {
      type: "run_meta",
      agent: "ship",
      repo: instance.repo,
      instanceId: instance.id,
      // The grant the request carried (decision 0046): what a renewal could spend.
      grant: instance.grant ?? DEFAULT_GRANT,
      at: instance.createdAt,
    },
    ...units.flatMap((u) =>
      u.rounds.map((r): RunEvent => ({
        type: "ship_round",
        index: r.index,
        agent: r.agent,
        outcome: r.outcome as ShipRoundOutcome,
        at: r.at,
      })),
    ),
    { type: "answer", text: planSummary(units, isGenerated(instance)), at: finishedAt },
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
    ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
    ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
  };
}

/** The plan's summary — one line per unit with how it ended and its pull
 *  request; the task wording (no unit id) for a generated plan's one unit. */
export function planSummary(units: readonly CoordinatorUnit[], generated = false): string {
  const lines = units.map((u) => {
    const how = u.ending ? u.ending.kind : u.threadKey ? "unfinished" : "not started";
    const pr = u.pr ? ` — ${u.pr.url}` : "";
    return generated ? `${ENDING_ICON[how] ?? "•"} ${how}${pr}` : `${ENDING_ICON[how] ?? "•"} ${u.unit} — ${how}${pr}`;
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
  // A generated plan's one unit ran in the requesting thread, so its report is
  // already there — only a seeded plan's summary is posted back.
  if (!isGenerated(instance)) {
    const io = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
    await io?.reply(`Plan ${instance.plan?.id ?? ""} ended (${body.outcome}):\n${planSummary(units)}`).catch(() => {});
  }
  (deps.log ?? console.log)(`[coordinator] ${instance.id}: finished ${body.outcome} — record ${record.id}`);
  return json(200, { ok: true, runId: record.id, at });
}

/** What the brief composer reads through the bot: the target repository at the
 *  base ref, a child's record, and the ship request the run's record carried. */
function briefReaders(deps: AdminCoordinatorDeps, instance: CoordinatorInstance): BriefReaders {
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
        ...(r.handoff !== undefined ? { handoff: r.handoff } : {}),
      };
    },
    // The generated plan's request text: the ship run's own record
    // (`instance.runId`, its `input` event) — never a scan of the thread, so a
    // routed request with no `agent:ship` turn anywhere still reads back the
    // words the person typed (agent-ship item 13).
    readShipRequest: async () => {
      if (instance.runId === undefined) return undefined;
      const res = await deps.runs.getRun(instance.runId, { include: "messages" }).catch(() => undefined);
      if (res === undefined || !res.ok) return undefined;
      const input = (res.value.events ?? []).find((e) => e.type === "input");
      return input?.type === "input" ? input.text : undefined;
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
  | "merge"
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
  "merge",
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
    case "merge":
      return merge(parsed.value, deps, door.subject);
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
