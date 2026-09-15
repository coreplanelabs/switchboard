// The three harness routes (docs/reference/specs/harness-pi.md item 7): what a
// run's pi extension asks the bot over the run's own bearer — `GET
// /harness/tools`, `POST /harness/authorize`, `POST /harness/tool`. The door
// is the model proxy's: the bearer names its run and verifies against the
// store, so an unknown run, a wrong secret, an expired or revoked bearer are
// refused before a byte of the body is read; past it, the run must be one this
// process is driving on pi. A relayed call that outlives one request is
// answered `202 { pending }` at the relay's window and asked again by the
// extension with the same call id, which joins the one run. Pure handler over
// a small request shape, then the node:http adapter: the model proxy's own
// split.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { RunBearerStore } from "../core/modelProxy/runBearers.js";
import {
  authorizeToolCall,
  relayToolCall,
  relayedToolDefinitions,
  type HarnessRegistry,
  type ToolCallAsk,
} from "../core/harness/pi/relay.js";
import { readBody } from "./http.js";

export const HARNESS_TOOLS_PATH = "/harness/tools";
export const HARNESS_AUTHORIZE_PATH = "/harness/authorize";
export const HARNESS_TOOL_PATH = "/harness/tool";
export const HARNESS_PATHS = [HARNESS_TOOLS_PATH, HARNESS_AUTHORIZE_PATH, HARNESS_TOOL_PATH] as const;
/** A tool input can carry a whole PR description; a call never carries a file's bytes. */
export const MAX_HARNESS_BODY_BYTES = 4 * 1024 * 1024;

export function isHarnessPath(path: string): boolean {
  return (HARNESS_PATHS as readonly string[]).includes(path);
}

/** The route as a log line names it: one of three words, never the request's own text. */
const ROUTE_WORD: Record<string, string> = {
  [HARNESS_TOOLS_PATH]: "tools",
  [HARNESS_AUTHORIZE_PATH]: "authorize",
  [HARNESS_TOOL_PATH]: "tool",
};

export interface HarnessRouteDeps {
  bearers: RunBearerStore;
  harnesses: HarnessRegistry;
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
}

function bearerOf(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = value ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  return m ? m[1] : undefined;
}

/** The door from the headers alone: which live harness a bearer names, or the refusal. */
export function admitHarnessRequest(
  deps: HarnessRouteDeps,
  headers: IncomingHttpHeaders,
): { ok: true; runId: string } | { ok: false; response: HarnessResponse } {
  const presented = bearerOf(headers);
  if (!presented) return { ok: false, response: { status: 401, body: { error: "missing_bearer" } } };
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
    return { ok: false, response: { status, body: { error: verdict.reason } } };
  }
  const runId = verdict.grant.runId;
  if (!deps.harnesses.get(runId))
    return { ok: false, response: { status: 404, body: { error: "run_not_on_harness" } } };
  return { ok: true, runId };
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
  const door = admitHarnessRequest(deps, req.headers);
  if (!door.ok) return door.response;
  const harness = deps.harnesses.get(door.runId)!;
  if (wantsGet) return { status: 200, body: { tools: relayedToolDefinitions(harness) } };
  const ask = askOf(req.body);
  if (!ask) return { status: 400, body: { error: "invalid_body" } };
  if (req.path === HARNESS_AUTHORIZE_PATH) {
    const answer = authorizeToolCall(harness, ask);
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
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(r.body));
    };
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      const door = admitHarnessRequest({ ...deps, log }, req.headers);
      if (!door.ok) {
        log(`[harness] ${door.response.status} ${ROUTE_WORD[path] ?? "other"} — ${String(door.response.body.error)}`);
        json(door.response);
        // The body is never read on a refusal: drain it so the answer reaches
        // the client whole — destroying the socket could drop the queued JSON.
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
