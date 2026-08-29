import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { CoreDeps } from "../core/dispatcher.js";
import { formatSelfImprovementReport, runSelfImprovement } from "../core/selfImprovement.js";
import { GithubIssueTracker } from "../execution/githubIssues.js";
import { readBody } from "./http.js";

// The scheduled trigger of the self-improvement step (Area 7b / #84):
// `POST /friction/propose` on the bot's HTTP server. The Worker shim's weekly
// cron (deploy/cloudflare/worker.ts) presents a dedicated bearer
// (FRICTION_TRIGGER_TOKEN) and the bot runs exactly the step `friction propose`
// runs from chat — ledger → cluster → propose → dedupe → file labeled issues —
// and answers with the report. Fail-closed: no token configured → the route
// answers 503 and nothing runs; wrong bearer → 401 before any body is read.
// Channel-agnostic like the chat command: the issues ARE the notification.

/** Env var holding the trigger bearer. Blank/absent → the route is disabled. */
export const FRICTION_TRIGGER_TOKEN_ENV = "FRICTION_TRIGGER_TOKEN";
/** A trigger body is `{dryRun?: boolean}` at most — anything bigger is not ours. */
const MAX_TRIGGER_BODY_BYTES = 4096;

export function parseFrictionTriggerToken(env: Record<string, string | undefined>): string | undefined {
  const raw = env[FRICTION_TRIGGER_TOKEN_ENV]?.trim();
  return raw ? raw : undefined;
}

export interface FrictionTriggerOptions {
  /** The bearer the caller must present; undefined disables the route (503). */
  token: string | undefined;
}

export interface FrictionTriggerRequest {
  method: string | undefined;
  headers: IncomingHttpHeaders;
  /** Raw body text (already size-capped by the adapter). */
  body: string;
}

export interface FrictionTriggerResponse {
  status: number;
  body: unknown;
}

/** Equal-length constant-time compare (mirrors channels/http.ts); never logs. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function presentedBearer(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

/** Transport gate: method, then token presence, then the bearer. Pure. */
export function authorizeFrictionTrigger(
  method: string | undefined,
  headers: IncomingHttpHeaders,
  opts: FrictionTriggerOptions,
): FrictionTriggerResponse | { ok: true } {
  if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  if (!opts.token) return { status: 503, body: { error: `friction trigger disabled — ${FRICTION_TRIGGER_TOKEN_ENV} is not set` } };
  const presented = presentedBearer(headers);
  if (!presented || !safeEqual(presented, opts.token)) return { status: 401, body: { error: "unauthorized" } };
  return { ok: true };
}

/** The whole request, headers→result, for tests and the node adapter alike. */
export async function handleFrictionTrigger(
  req: FrictionTriggerRequest,
  deps: CoreDeps,
  opts: FrictionTriggerOptions,
): Promise<FrictionTriggerResponse> {
  const gate = authorizeFrictionTrigger(req.method, req.headers, opts);
  if ("status" in gate) return gate;

  let dryRun = false;
  if (req.body.trim()) {
    try {
      const parsed: unknown = JSON.parse(req.body);
      if (typeof parsed !== "object" || parsed === null) return { status: 400, body: { error: "body must be a JSON object" } };
      dryRun = (parsed as { dryRun?: unknown }).dryRun === true;
    } catch {
      return { status: 400, body: { error: "body must be valid JSON" } };
    }
  }

  const cfg = deps.config.config.selfImprovement;
  if (!cfg?.repo) return { status: 503, body: { error: "selfImprovement.repo is not configured — nowhere to file proposals" } };
  if (!deps.frictionLedger) return { status: 503, body: { error: "no friction ledger is wired in this process" } };

  try {
    const report = await runSelfImprovement({
      records: await deps.frictionLedger.recent(),
      tracker: deps.issueTracker ?? new GithubIssueTracker(),
      repo: cfg.repo,
      label: cfg.label,
      top: cfg.top,
      minRuns: cfg.minRuns,
      dryRun,
    });
    const text = formatSelfImprovementReport(report);
    console.log(`[friction] scheduled propose: ${text.split("\n")[0]}`);
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: report.dryRun,
        runsAnalyzed: report.runsAnalyzed,
        patterns: report.patterns.map((p) => p.key),
        filed: report.filed.map((f) => f.issue.url),
        duplicates: report.duplicates.map((d) => d.issue.url),
        failed: report.failed.map((f) => `${f.proposal.key}: ${f.error}`),
        text,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[friction] scheduled propose failed: ${message}`);
    return { status: 500, body: { ok: false, error: message } };
  }
}

/** node:http adapter: authorizes from headers BEFORE reading the body (an
 *  unauthorized caller never gets a body buffered), then runs the handler and
 *  writes JSON. Wire at POST /friction/propose in src/index.ts. */
export function createFrictionTriggerHandler(
  deps: CoreDeps,
  opts: FrictionTriggerOptions,
): (req: AsyncIterable<Buffer | Uint8Array> & { method?: string; headers: IncomingHttpHeaders; destroy(): void }, res: ServerResponse) => void {
  const write = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    void (async () => {
      try {
        const gate = authorizeFrictionTrigger(req.method, req.headers, opts);
        if ("status" in gate) {
          write(res, gate.status, gate.body);
          req.destroy();
          return;
        }
        const read = await readBody(req, MAX_TRIGGER_BODY_BYTES);
        if (!read.ok) {
          write(res, 413, { error: "request body too large" });
          req.destroy();
          return;
        }
        const result = await handleFrictionTrigger({ method: req.method, headers: req.headers, body: read.body }, deps, opts);
        write(res, result.status, result.body);
      } catch (err) {
        console.error(`[friction] trigger transport error: ${err instanceof Error ? err.message : String(err)}`);
        write(res, 500, { error: "internal error" });
      }
    })();
  };
}
