// The bot steps a ship coordinator calls (docs/reference/specs/http-ingress.md
// item 9; docs/decisions/0029-durable-objects-store-workflows-schedule.md): the
// coordinator is a Workflow instance in the bot's shim Worker that holds no
// credential of its own, so every GitHub fact and every child run is the
// bot's to produce — `POST /admin/coordinator/spawn`, `read-record` and
// `pr-check`, plus `authorize`, the question the shim asks before it creates
// an instance. The shim forwards `/admin/*` to the container untouched and the
// Access gate does not cover it, so the bearer is the whole door, like the
// restart, the crash and the span log: the `coordinator` entry of
// `SWITCHBOARD_INGRESS_TOKENS`, whose `http:coordinator` actor the policy
// table admits on `coordinator:step` and nothing else does.
//
// The spawn never takes an actor from its caller. The body names an instance
// and a step; the requester, channel and thread come from the parent ship
// record the bot wrote at the instance's creation, and the child is an
// ordinary `dispatch()` as that user, so the agent gate, the profile gate and
// the repository gates judge it with that person's grants — a requester who
// lost `agent:run:coding` during a days-long wait ends the step with the
// gate's own name. Every step is safe to retry: the spawn carries the key
// `<parentInstanceId>:<step>`, the child's claim stores it, and a retry that
// meets the child live or finished answers `alreadySpawned` with its id; a
// thread held by a run without the key answers `busy`.
//
// The handler here is pure over a parsed request (`handleCoordinatorRequest`),
// like the ingress; `createAdminCoordinatorHandler` is the node:http adapter.

import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { AGENTS } from "../agents/registry.js";
import { authorize } from "../core/authz/authorize.js";
import { resolveActor, type GrantsLookup } from "../core/authz/actor.js";
import {
  COORDINATOR_STEP_ACTION,
  idempotencyKeyFor,
  INSTANCE_ID_PATTERN,
  STEP_NAME_PATTERN,
  type CoordinatorInstance,
  type CoordinatorTag,
} from "../core/coordinator/contract.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { DispatchOutcome } from "../core/dispatch/outcome.js";
import { childRequestText } from "../core/dispatch/spawn.js";
import type { RunEvent } from "../core/runEvents.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import type { RunsService, RunView } from "../core/runsService.js";
import { systemClock } from "../core/trace/clock.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import { authenticateIngressBearer } from "../deploy/restart.js";
import type { OpenPrRef } from "../execution/githubPulls.js";
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
  /** `dispatch()` bound over the process's deps: the child as the requesting user, tagged. */
  dispatch: (msg: IncomingMessage, io: ChannelIO, opts: { coordinator: CoordinatorTag }) => Promise<DispatchOutcome>;
  /** The channel handle for the instance's thread (the resume's `resumeSlackIO`
   *  from the row's parts); undefined for a platform no thread can be rebuilt on. */
  ioFor: (instance: CoordinatorInstance) => ChannelIO | undefined;
  /** The open pull request heading a branch (githubPulls.findOpenPrByHead). */
  findOpenPrByHead: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  clock?: () => number;
  log?: (line: string) => void;
}

export interface CoordinatorRouteRequest {
  method?: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The parsed spawn body: the instance, the step, the child's preset and prompt, an optional narrower budget. */
export interface SpawnStepRequest {
  parentInstanceId: string;
  step: string;
  preset: string;
  prompt: string;
  budget?: number;
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
  if (typeof body.prompt !== "string" || body.prompt.trim() === "" || body.prompt.length > MAX_SPAWN_PROMPT_CHARS)
    return invalid(`prompt must be a non-empty string of at most ${MAX_SPAWN_PROMPT_CHARS} characters`);
  if (
    body.budget !== undefined &&
    (typeof body.budget !== "number" || !Number.isInteger(body.budget) || body.budget < 2)
  )
    return invalid("budget must be a whole number of minutes, at least 2");
  return {
    ok: true,
    value: {
      parentInstanceId: id.value,
      step: body.step,
      preset: body.preset,
      prompt: body.prompt,
      ...(body.budget !== undefined ? { budget: body.budget as number } : {}),
    },
  };
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

/** The run holding the instance's thread right now: here, or on another generation's ledger row. */
async function liveOnThread(runs: RunsService, instance: CoordinatorInstance): Promise<RunView | undefined> {
  const active = await runs.listRuns({
    status: "active",
    visibleTo: EVERY_RUN,
    channel: instance.channelId,
    limit: RUN_LIST_MAX_LIMIT,
  });
  return active.runs.find((r) => r.threadKey === instance.threadKey && !r.finished);
}

/** A finished run in the instance's thread carrying the key, since the instance was created. */
async function finishedWithKey(
  runs: RunsService,
  instance: CoordinatorInstance,
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
    const hit = result.runs.find((r) => r.threadKey === instance.threadKey && r.idempotencyKey === key);
    if (hit) return hit;
    if (!result.nextBefore) return undefined;
    cursor = { before: result.nextBefore.finishedAt, beforeId: result.nextBefore.id };
  }
  return undefined;
}

/** The spawn's answer for a run already holding the step or the thread. */
function answerForLive(live: RunView, key: string, instance: CoordinatorInstance): IngressResponse {
  if (live.idempotencyKey === key)
    return json(200, { ok: true, runId: live.id, threadKey: instance.threadKey, alreadySpawned: true });
  return json(409, {
    ok: false,
    error: "busy",
    runId: live.id,
    ...(live.agent !== undefined ? { agent: live.agent } : {}),
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
  const key = idempotencyKeyFor(instance.id, req.step);
  // Retry-safe before anything starts: the step's child, live or finished, or
  // another run holding the unit's thread.
  const live = await liveOnThread(deps.runs, instance);
  if (live) return answerForLive(live, key, instance);
  const done = await finishedWithKey(deps.runs, instance, key);
  if (done) return json(200, { ok: true, runId: done.id, threadKey: instance.threadKey, alreadySpawned: true });
  const io = deps.ioFor(instance);
  if (!io) return json(503, { ok: false, error: "no_channel" });
  // The child's message is the one the requester would have typed, in the
  // unit's thread, as the requester the parent record names.
  const msg: IncomingMessage = {
    channelId: instance.channelId,
    userId: instance.userId,
    ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
    ...(instance.channelName !== undefined ? { channelName: instance.channelName } : {}),
    threadKey: instance.threadKey,
    ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
    text: childRequestText({
      preset: req.preset,
      prompt: req.prompt,
      repo: instance.repo,
      ...(req.budget !== undefined ? { budget: req.budget } : {}),
    }),
    receivedAt: (deps.clock ?? systemClock)(),
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
  const settled = deps.dispatch(msg, child, { coordinator: tag }).then(
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
    log(`[coordinator] ${instance.id} ${req.step}: spawned ${req.preset} run ${runId} in ${instance.threadKey}`);
    return json(200, { ok: true, runId, threadKey: instance.threadKey });
  }
  if (first.kind === "threw") return json(502, { ok: false, error: "spawn_failed", message: describe(first.err) });
  const refusal = first.outcome.refusal;
  if (refusal === "coordinator_thread_live") {
    // A run took the thread between the read above and the claim: answer from it.
    const now = await liveOnThread(deps.runs, instance);
    if (now) return answerForLive(now, key, instance);
    return json(409, { ok: false, error: "busy" });
  }
  log(`[coordinator] ${instance.id} ${req.step}: ${req.preset} child not started (${refusal ?? first.outcome.status})`);
  if (refusal !== undefined)
    return json(403, { ok: false, error: refusal, ...(lastReply !== undefined ? { message: lastReply } : {}) });
  return json(502, {
    ok: false,
    error: "spawn_failed",
    message: lastReply ?? `the child ended (${first.outcome.status}) before it started`,
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

async function readRecord(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.runId !== "string" || !RUN_ID_PATTERN.test(body.runId))
    return json(400, { ok: false, error: "runId must be a run id" });
  // A run outside the instance is `not_found`, byte-identical to a missing one
  // (authorization.md: a denied read reveals nothing).
  const res = await deps.runs.getRun(body.runId);
  if (!res.ok || res.value.parentInstanceId !== id.value) return json(404, { ok: false, error: "not_found" });
  const view = res.value;
  let finalReply: string | undefined;
  if (view.finished) {
    const full = await deps.runs.getRun(body.runId, { include: "messages" });
    finalReply = full.ok ? finalReplyOf(full.value.events) : undefined;
  }
  return json(200, { ok: true, run: coordinatorRunView(view, id.value, finalReply) });
}

async function prCheck(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  try {
    const pr = await deps.findOpenPrByHead(instance.repo, instance.branch);
    if (!pr) return json(200, { ok: true, state: "none" });
    return json(200, {
      ok: true,
      state: "open",
      prNumber: pr.number,
      url: pr.htmlUrl,
      ...(pr.headSha !== undefined ? { headSha: pr.headSha } : {}),
    });
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err) });
  }
}

type Step = "authorize" | "spawn" | "read-record" | "pr-check";
const STEPS: readonly Step[] = ["authorize", "spawn", "read-record", "pr-check"];

/** The step a path names — one of the four literals above, never the path's
 *  own text, so what reaches a log line is a constant of this module. */
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
    case "spawn":
      return spawn(parsed.value, deps);
    case "read-record":
      return readRecord(parsed.value, deps);
    default:
      return prCheck(parsed.value, deps);
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
