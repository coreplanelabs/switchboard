// The four harness routes (docs/reference/specs/harness-pi.md item 7): what a
// run's pi extension asks the bot over the run's own bearer — `GET
// /harness/tools`, `POST /harness/authorize`, `POST /harness/tool`, `POST
// /harness/compaction` (how the compaction pi is about to write is written:
// pi's own summary, or the bot's pointer after one that failed for good). The door
// is the model proxy's: the bearer names its run and verifies against the
// store, so an unknown run, a wrong secret, an expired or revoked bearer are
// refused before a byte of the body is read; past it, the run must be one this
// process is driving on pi. A relayed call that outlives one request is
// answered `202 { pending }` at the relay's window and asked again by the
// extension with the same call id, which joins the one run. One exception to
// the door's finality: during a generation's boot a bearer this process does
// not know may be the previous generation's, held by a pi that outlived it and
// whose run this generation is still bringing back — the door holds until the
// boot reclaim has listed the ledger and, for such a run, answers so the
// extension asks again rather than the 4xx it takes as final. Pure handler
// over a small request shape, then the node:http adapter: the model proxy's
// own split.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { compactionAskOf } from "../core/harness/pi/compactionFallback.js";
import {
  answerCompaction,
  authorizeToolCallWithTree,
  relayToolCall,
  relayedToolDefinitions,
  type HarnessRegistry,
  type ToolCallAsk,
} from "../core/harness/pi/relay.js";
import { HANDOFF_BUDGET_MS } from "../core/drain.js";
import type { TakeoverFacts } from "../core/runLedger/takeover.js";
import { readBody } from "./http.js";

export const HARNESS_TOOLS_PATH = "/harness/tools";
export const HARNESS_AUTHORIZE_PATH = "/harness/authorize";
export const HARNESS_TOOL_PATH = "/harness/tool";
export const HARNESS_COMPACTION_PATH = "/harness/compaction";
export const HARNESS_PATHS = [
  HARNESS_TOOLS_PATH,
  HARNESS_AUTHORIZE_PATH,
  HARNESS_TOOL_PATH,
  HARNESS_COMPACTION_PATH,
] as const;
/** A tool input can carry a whole PR description; a call never carries a file's bytes. */
export const MAX_HARNESS_BODY_BYTES = 4 * 1024 * 1024;

/** How long the door holds a request naming a run it does not know while the
 *  boot reclaim has not yet listed the ledger: the previous generation had
 *  `HANDOFF_BUDGET_MS` to mark its runs and exit, and this one gets as long
 *  again, plus a margin, to take them (one ledger round trip after `listen()`).
 *  Under the extension's own 60 s on one request, so a held request is
 *  answered, never abandoned; a reclaim slower than this answers retryable. */
export const DOOR_HOLD_MS = HANDOFF_BUDGET_MS + 4_000;
/** What a held answer's `Retry-After` says: the extension's own retry cadence (2 s). */
const HELD_RETRY_AFTER_S = 2;

export function isHarnessPath(path: string): boolean {
  return (HARNESS_PATHS as readonly string[]).includes(path);
}

/** The route as a log line names it: one of four words, never the request's own text. */
const ROUTE_WORD: Record<string, string> = {
  [HARNESS_TOOLS_PATH]: "tools",
  [HARNESS_AUTHORIZE_PATH]: "authorize",
  [HARNESS_TOOL_PATH]: "tool",
  [HARNESS_COMPACTION_PATH]: "compaction",
};

export interface HarnessRouteDeps {
  bearers: RunBearerStore;
  harnesses: HarnessRegistry;
  /** This generation's takeover of the ledger's live runs: what the door holds on. */
  takeover: TakeoverFacts;
  log?: (line: string) => void;
  /** How long one `POST /harness/tool` waits on a running tool before answering
   *  `pending` (`RELAY_POLL_WINDOW_MS` by default), and the sleep that paces it. */
  relayWindowMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HarnessRequest {
  method?: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The parsed JSON body of a POST; undefined for a GET or an unreadable body. */
  body?: unknown;
}

export interface HarnessResponse {
  status: number;
  body: Record<string, unknown>;
  /** Beyond the JSON content type: a held answer's `retry-after`. */
  headers?: Record<string, string>;
}

/** Why the door held rather than refused: the boot reclaim has not listed the
 *  ledger within the hold, or the run is one this generation is still resuming. */
export type HeldReason = "reclaim_pending" | "run_resuming";

export type HarnessDoor =
  { ok: true; runId: string } | { ok: false; response: HarnessResponse; held?: { reason: HeldReason; runId?: string } };

function bearerOf(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = value ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  return m ? m[1] : undefined;
}

type Judgement = { ok: true; runId: string } | { ok: false; status: number; reason: string; runId?: string };

/** The store's word on a bearer, then the registry's on its run. */
function judge(deps: HarnessRouteDeps, presented: string): Judgement {
  const verdict = deps.bearers.verify(presented);
  if (!verdict.ok) {
    const status =
      verdict.reason === "unknown_run"
        ? 404
        : verdict.reason === "malformed"
          ? 401
          : verdict.reason === "unknown_bearer"
            ? 401
            : 403;
    return {
      ok: false,
      status,
      reason: verdict.reason,
      ...(verdict.reason === "malformed" ? {} : { runId: verdict.runId }),
    };
  }
  const runId = verdict.grant.runId;
  if (!deps.harnesses.get(runId)) return { ok: false, status: 404, reason: "run_not_on_harness", runId };
  return { ok: true, runId };
}

/** The refusals a resume can still turn into an admission: the run's entry not
 *  minted here yet, minted but the surviving pi's secret not adopted yet, or
 *  not yet registered on the harness. A malformed token, a revoked or an
 *  expired bearer are final whatever the boot is doing. */
const RESUME_CAN_OPEN: ReadonlySet<string> = new Set(["unknown_run", "unknown_bearer", "run_not_on_harness"]);

/** The answer that makes the extension ask again: its relay treats a pending
 *  answer as a call still running and its hook a 5xx as a bot not yet
 *  answering — both re-asked on their own cadence, neither taken as final. */
function held(path: string, reason: HeldReason, runId: string | undefined): HarnessDoor {
  const response: HarnessResponse =
    path === HARNESS_TOOL_PATH
      ? { status: 202, body: { pending: true, reason } }
      : { status: 503, body: { error: reason }, headers: { "retry-after": String(HELD_RETRY_AFTER_S) } };
  return { ok: false, response, held: { reason, ...(runId !== undefined ? { runId } : {}) } };
}

const refused = (j: Extract<Judgement, { ok: false }>): HarnessDoor => ({
  ok: false,
  response: { status: j.status, body: { error: j.reason } },
});

/** The door from the headers alone: which live harness a bearer names, or the
 *  refusal — or, for a bearer this generation does not know while it is still
 *  taking over the ledger's live runs, the hold: the request waits for the
 *  boot reclaim's listing (up to `DOOR_HOLD_MS`) and is judged again; a run
 *  the listing names as live and not yet resumed here is answered retryably
 *  (`held`), as is every such bearer while the listing has not arrived. */
export async function admitHarnessRequest(
  deps: HarnessRouteDeps,
  headers: IncomingHttpHeaders,
  path: string,
): Promise<HarnessDoor> {
  const presented = bearerOf(headers);
  if (!presented) return { ok: false, response: { status: 401, body: { error: "missing_bearer" } } };
  let verdict = judge(deps, presented);
  if (verdict.ok) return verdict;
  if (!RESUME_CAN_OPEN.has(verdict.reason)) return refused(verdict);
  if (!deps.takeover.settled) {
    await deps.takeover.whenSettled(DOOR_HOLD_MS);
    verdict = judge(deps, presented);
    if (verdict.ok) return verdict;
    if (!RESUME_CAN_OPEN.has(verdict.reason)) return refused(verdict);
    if (!deps.takeover.settled) return held(path, "reclaim_pending", verdict.runId);
  }
  if (verdict.runId !== undefined && deps.takeover.pending(verdict.runId))
    return held(path, "run_resuming", verdict.runId);
  return refused(verdict);
}

function askOf(body: unknown): ToolCallAsk | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.tool !== "string" || typeof b.toolCallId !== "string") return undefined;
  return { toolCallId: b.toolCallId, tool: b.tool, input: b.input };
}

export async function handleHarnessRequest(deps: HarnessRouteDeps, req: HarnessRequest): Promise<HarnessResponse> {
  if (!isHarnessPath(req.path)) return { status: 404, body: { error: "not_found" } };
  const wantsGet = req.path === HARNESS_TOOLS_PATH;
  if ((req.method ?? "GET") !== (wantsGet ? "GET" : "POST"))
    return { status: 405, body: { error: "method_not_allowed" } };
  const door = await admitHarnessRequest(deps, req.headers, req.path);
  if (!door.ok) return door.response;
  const harness = deps.harnesses.get(door.runId)!;
  if (wantsGet) return { status: 200, body: { tools: relayedToolDefinitions(harness) } };
  if (req.path === HARNESS_COMPACTION_PATH) {
    const compaction = compactionAskOf(req.body);
    if (!compaction) return { status: 400, body: { error: "invalid_body" } };
    const answer = answerCompaction(harness, compaction);
    deps.log?.(
      `[harness] run=${door.runId} compaction ${compaction.reason} → ${answer.summary !== undefined ? "the bot's pointer" : "pi's own summary"}`,
    );
    return { status: 200, body: { ...answer } };
  }
  const ask = askOf(req.body);
  if (!ask) return { status: 400, body: { error: "invalid_body" } };
  if (req.path === HARNESS_AUTHORIZE_PATH) {
    const answer = await authorizeToolCallWithTree(harness, ask);
    deps.log?.(`[harness] run=${door.runId} authorize ${ask.tool} → ${answer.allow ? "allow" : "refuse"}`);
    return { status: 200, body: { ...answer } };
  }
  const progress = await relayToolCall(harness, deps.harnesses.calls(door.runId)!, ask, {
    ...(deps.relayWindowMs !== undefined ? { windowMs: deps.relayWindowMs } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (!progress.done) {
    deps.log?.(`[harness] run=${door.runId} tool ${ask.tool} → pending`);
    return { status: 202, body: { pending: true, toolCallId: ask.toolCallId } };
  }
  const { answer } = progress;
  deps.log?.(`[harness] run=${door.runId} tool ${ask.tool} → ${answer.isError ? "error" : "ok"}`);
  return { status: 200, body: { ...answer } };
}

/** The node:http adapter: the door before the body, the body capped, one JSON answer. */
export function createHarnessRoutesHandler(
  deps: HarnessRouteDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const log = deps.log ?? ((line: string) => console.log(line));
  return (req, res) => {
    const json = (r: HarnessResponse) => {
      res.writeHead(r.status, { ...r.headers, "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(r.body));
    };
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      const door = await admitHarnessRequest({ ...deps, log }, req.headers, path);
      if (!door.ok) {
        const word = ROUTE_WORD[path] ?? "other";
        log(
          door.held
            ? `[harness] ${door.response.status} ${word} — held (${door.held.reason})${door.held.runId ? ` run=${door.held.runId}` : ""}`
            : `[harness] ${door.response.status} ${word} — ${String(door.response.body.error)}`,
        );
        json(door.response);
        // The body is never read on a refusal or a hold: drain it so the answer
        // reaches the client whole — destroying the socket could drop the queued JSON.
        req.resume();
        return;
      }
      let body: unknown;
      if (req.method === "POST") {
        const read = await readBody(req, MAX_HARNESS_BODY_BYTES);
        if (!read.ok) {
          json({ status: 413, body: { error: "body_too_large" } });
          return;
        }
        try {
          body = JSON.parse(read.body);
        } catch {
          json({ status: 400, body: { error: "invalid_body" } });
          return;
        }
      }
      json(await handleHarnessRequest({ ...deps, log }, { method: req.method, path, headers: req.headers, body }));
    })().catch((err: unknown) => {
      log(`[harness] internal error: ${err instanceof Error ? err.message : String(err)}`);
      json({ status: 500, body: { error: "internal_error" } });
    });
  };
}
