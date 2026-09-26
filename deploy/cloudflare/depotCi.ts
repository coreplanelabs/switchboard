// Depot's organization token belongs to this Worker alone. The bot sends a
// repo-bound, typed operation; this adapter resolves ownership before spending
// that credential on logs or a mutation. Nothing here executes repository code.
import { z } from "zod";
import { MINUTE_MS } from "../../src/core/budgets.ts";
import {
  DEPOT_CI_AUTHORIZATION_PATH,
  DEPOT_CI_MAX_BYTES,
  DEPOT_ERRORS,
  depotCiGrantSchema,
  depotCiTicketSchema,
  depotId,
  depotJson,
} from "../../src/core/depotCi.ts";
import { redactSecrets, stripAnsi } from "../../src/core/redact.ts";
import { sameToken } from "./artifactsCopy.ts";
import { INTERNAL } from "./shared.ts";

const attemptSchema = z.object({ attemptId: depotId, attempt: z.number().int().positive(), status: z.string() });
const workflowSchema = z.object({
  orgId: depotId,
  runId: depotId,
  repo: z.string(),
  workflowId: depotId,
  headSha: z.string().default(""),
  sha: z.string().default(""),
  workflowStatus: z.string(),
  workflowName: z.string().default(""),
  workflowPath: z.string().default(""),
  workflowErrorMessage: z.string().default(""),
  jobs: z
    .array(
      z.object({
        jobId: depotId,
        jobKey: z.string(),
        jobDisplayName: z.string().default(""),
        status: z.string(),
        attempts: z.array(attemptSchema).default([]),
      }),
    )
    .default([]),
});
const logsSchema = z.object({
  lines: z.array(z.object({ body: z.string(), stepName: z.string().default("") })).default([]),
  nextPageToken: z.string().max(8192).default(""),
});
const retrySchema = z.object({
  workflowId: depotId,
  jobIds: z.array(depotId),
  jobCount: z.number().int().nonnegative(),
});
/** The callback has no caller-controlled origin or path. Worker wiring supplies
 * the singleton container binding, NOT an Internet fetch or a redirect. */
export async function depotCiAuthorization(
  ticket: string,
  signal: AbortSignal,
  botFetch: (request: Request) => Promise<Response>,
): Promise<unknown> {
  const res = await botFetch(
    new Request(`${INTERNAL}${DEPOT_CI_AUTHORIZATION_PATH}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { authorization: `Bearer ${ticket}` },
    }),
  );
  if (res.status !== 200) {
    await res.body?.cancel();
    return undefined;
  }
  return depotJson(res, 16 * 1024);
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function handleDepotCi(
  request: Request,
  deps: {
    depotToken?: string;
    bridgeToken?: string;
    authorize?: (ticket: string, signal: AbortSignal) => Promise<unknown>;
    fetch: typeof fetch;
  },
): Promise<Response> {
  const bearer = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!deps.bridgeToken || !bearer || !sameToken(bearer, deps.bridgeToken))
    return json(401, { error: "Depot CI bridge bearer refused." });
  if (request.method !== "POST") return json(405, { error: "Depot CI requires POST." });
  let raw: unknown;
  try {
    raw = await depotJson(new Response(request.body), 16 * 1024);
  } catch {
    return json(400, { error: DEPOT_ERRORS.invalid });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(400, { error: DEPOT_ERRORS.invalid });
  const parsed = depotCiTicketSchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: DEPOT_ERRORS.invalid });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(MINUTE_MS)]);
  let grant;
  try {
    signal.throwIfAborted();
    grant = depotCiGrantSchema.safeParse(await deps.authorize?.(parsed.data.ticket, signal));
  } catch {
    return json(403, { error: DEPOT_ERRORS.unauthorized });
  }
  if (!grant.success) return json(403, { error: DEPOT_ERRORS.unauthorized });
  if (!deps.depotToken) return json(503, { error: DEPOT_ERRORS.unavailable });
  // Both repo and operation came from a one-use permit the authenticated run's
  // tool call registered in the bot. Possessing the bridge bearer cannot mint
  // one, choose another repo, change its head, or replay it.
  const { repo, operation: op } = grant.data;
  // Credentials are redacted as exact values too: not every vendor token has a
  // recognizable prefix. Strip control sequences before either redaction pass.
  const sanitize = (text: string) =>
    redactSecrets(
      stripAnsi(text)
        .split(deps.depotToken!)
        .join("[redacted]")
        .split(deps.bridgeToken!)
        .join("[redacted]")
        .split(parsed.data.ticket)
        .join("[redacted]"),
    );
  const safeJson = (value: unknown): unknown => {
    if (typeof value === "string") return sanitize(value);
    if (Array.isArray(value)) return value.map(safeJson);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeJson(entry)]));
    return value;
  };
  let mutationStarted = false;
  let upstreamStatus: number | undefined;
  const rpc = async (method: "GetWorkflow" | "GetJobAttemptLogs" | "RetryFailedJobs", body: object) => {
    signal.throwIfAborted();
    if (method === "RetryFailedJobs") mutationStarted = true;
    const res = await deps.fetch(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${deps.depotToken}`,
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      upstreamStatus = res.status;
      await res.body?.cancel();
      throw new Error("upstream refused");
    }
    return depotJson(res);
  };
  try {
    const workflow = workflowSchema.parse(await rpc("GetWorkflow", { workflowId: op.workflowId }));
    if (workflow.repo.toLowerCase() !== repo.toLowerCase() || workflow.workflowId !== op.workflowId)
      return json(404, { error: DEPOT_ERRORS.notFound });
    if (op.operation === "inspect") return json(200, safeJson(workflow));
    if (op.operation === "retry_failed") {
      const head = workflow.headSha || workflow.sha;
      if (
        head.toLowerCase() !== op.expectedHead.toLowerCase() ||
        !["failed", "cancelled"].includes(workflow.workflowStatus)
      )
        return json(409, { error: DEPOT_ERRORS.stale });
      const answer = retrySchema.parse(await rpc("RetryFailedJobs", { workflowId: op.workflowId }));
      if (answer.workflowId !== op.workflowId || answer.jobCount !== answer.jobIds.length)
        throw new Error("inconsistent retry response");
      return json(200, safeJson(answer));
    }
    const jobs = workflow.jobs.filter((j) => j.jobId === op.jobId);
    if (jobs.length !== 1) return json(404, { error: DEPOT_ERRORS.notFound });
    const attempts = jobs[0].attempts;
    const latest = Math.max(...attempts.map((a) => a.attempt));
    const selected = attempts.filter((a) => (op.attemptId ? a.attemptId === op.attemptId : a.attempt === latest));
    if (selected.length !== 1) return json(404, { error: DEPOT_ERRORS.notFound });
    const attemptId = selected[0].attemptId;
    let pageToken: string | undefined;
    const seen = new Set<string>();
    const records: string[] = [];
    let capturedChars = 0;
    let complete = false;
    let truncated = false;
    const lineLimit = op.lines ?? 200;
    for (let page = 0; page < 20; page++) {
      const result = logsSchema.parse(
        await rpc("GetJobAttemptLogs", { attemptId, ...(pageToken ? { pageToken } : {}) }),
      );
      // Keep the finite raw capture until all boundaries can be sanitized.
      // A separate aggregate ceiling bounds Worker memory, not just each page.
      const chars = result.lines.reduce((sum, line) => sum + line.body.length + 1, 0);
      if (capturedChars + chars > 2 * DEPOT_CI_MAX_BYTES) break;
      for (const line of result.lines) records.push(line.body);
      capturedChars += chars;
      if (!result.nextPageToken) {
        complete = true;
        break;
      }
      if (seen.has(result.nextPageToken)) break;
      seen.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }
    // Depot records/pages may split a credential. Compare both interpretations
    // of their separators BEFORE clipping: if removing newlines changes what is
    // secret, withhold the capture rather than guessing which fragment is safe.
    // Partial captures are withheld too: a later page could finish a credential
    // or a PEM block. This fails closed without retaining unbounded raw logs.
    const rawText = complete ? records.join("\n") : "";
    const sanitized = sanitize(rawText);
    const withheld = !complete
      ? "incomplete capture"
      : sanitized.replace(/\n/g, "") !== sanitize(rawText.replace(/\n/g, ""))
        ? "credential spans log records"
        : undefined;
    let text = "";
    if (!withheld) {
      const lines = sanitized.split("\n");
      truncated = lines.length > lineLimit;
      text = lines.slice(-lineLimit).join("\n");
      if (text.length > 50_000) {
        text = text.slice(-50_000);
        truncated = true;
      }
    }
    return json(200, {
      workflowId: op.workflowId,
      jobId: op.jobId,
      attemptId,
      complete,
      truncated: truncated || !!withheld,
      ...(withheld ? { withheld } : {}),
      text,
    });
  } catch {
    return json(502, {
      error: mutationStarted
        ? DEPOT_ERRORS.unknown
        : upstreamStatus
          ? `Depot CI upstream refused (HTTP ${upstreamStatus}).`
          : DEPOT_ERRORS.failed,
    });
  }
}
