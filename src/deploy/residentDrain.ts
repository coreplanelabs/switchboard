// The deploy side of the resident fleet drain (docs/reference/specs/release-and-deploy.md
// item 31; the Worker side is deploy/cloudflare-resident/drain.ts, item 69 of
// resident-repos.md). Before the resident step's first `npm run deploy` the
// runner closes the fleet to new runs with `POST /drain`, so the preflight's
// wait ends when the runs already in flight end instead of when traffic
// happens to pause. After a Worker-only upload, authenticated application and
// registry reads can lift the drain without an image reconcile. A changed
// application still takes the guarded reconcile path. Pure
// helpers here (the request, the lines); the I/O is the runner's injected
// `postJson`, so the loop is tested without a network.

import { DRAIN, MINUTE_MS } from "../core/budgets.js";

/** The drain-only bearer — the resident's `RESIDENT_DRAIN_TOKEN` (deploy/cloudflare-resident/worker.ts
 *  `Env`): it passes `/drain` and `/undrain` and nothing else, so CI holds no
 *  more than the drain needs; the read bearer the preflight takes cannot close
 *  a fleet, and the admin bearer could offboard one. */
export const RESIDENT_DRAIN_TOKEN_ENV = "RESIDENT_DRAIN_TOKEN";

/** The resident step's wait once the fleet is drained: past a coding child's
 *  whole lease (its 45-minute ask plus its write-up), the longest a run in
 *  flight can outlive the drain's start. Undrained, the step keeps its
 *  RESIDENT_WAIT_MAX_MS: waiting longer for a quiet minute buys nothing. */
export const RESIDENT_DRAINED_WAIT_MAX_MS: number = DRAIN.deployWaitMaxMs;

/** How much longer than the wait the drain itself lasts, so the fleet stays
 *  closed through the deploy and its live check, and reopens by itself soon
 *  after if the runner died before lifting it. */
export const DRAIN_MARGIN_MINUTES: number = DRAIN.marginMinutes;

/** One POST's answer as the runner reads it: a status and a JSON body, or the
 *  transport's failure. */
export type PostAnswer = { status: number; body: Record<string, unknown> } | { error: string };

export function drainUrl(baseUrl: string): string {
  return new URL("/drain", baseUrl).toString();
}

export function undrainUrl(baseUrl: string): string {
  return new URL("/undrain", baseUrl).toString();
}

export function reconcileUrl(baseUrl: string): string {
  return new URL("/reconcile", baseUrl).toString();
}

/** The drain the step asks for: as long as its wait plus the margin, named by the commit it deploys. */
export function drainBody(waitMaxMs: number, commit: string): { minutes: number; reason: string; by: string } {
  return {
    minutes: Math.ceil(waitMaxMs / MINUTE_MS) + DRAIN_MARGIN_MINUTES,
    reason: `deploy ${commit.slice(0, 7)}`,
    by: "deploy all",
  };
}

/** The `until` a `/drain` answer carries, when it does. */
export function drainUntil(answer: PostAnswer): string | undefined {
  if ("error" in answer) return undefined;
  const d = answer.body.draining as { until?: unknown } | undefined;
  return typeof d?.until === "string" ? d.until : undefined;
}

/** Whether the drain was set: a 2xx whose body carries the record. */
export function drainSet(answer: PostAnswer): boolean {
  return !("error" in answer) && answer.status >= 200 && answer.status < 300 && drainUntil(answer) !== undefined;
}

function answerWords(answer: PostAnswer): string {
  if ("error" in answer) return answer.error;
  const err = answer.body.error;
  return `HTTP ${answer.status}${typeof err === "string" && err ? `: ${err}` : ""}`;
}

/** Closed failure classes keep credentials and arbitrary response bodies out of deploy output. */
export function drainFailureReason(answer: PostAnswer): string {
  if ("error" in answer) return "fleet drain response unavailable; drain state is unknown";
  if (answer.status === 409) return "fleet drain refused: deployment fence or staging maintenance conflict (HTTP 409)";
  return `fleet drain was not acknowledged (HTTP ${answer.status})`;
}

/** Readback explains an existing fence; it never authorizes clearing or replacing it. */
export function drainConflictLine(step: string, body: unknown): string {
  const drain =
    body && typeof body === "object" && "draining" in body && body.draining && typeof body.draining === "object"
      ? body.draining
      : undefined;
  const validTime = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 32 &&
    /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  const commit =
    drain && "reason" in drain && typeof drain.reason === "string"
      ? /^deploy ([a-f0-9]{7,40})$/.exec(drain.reason)?.[1]
      : undefined;
  return drain &&
    "swapFence" in drain &&
    drain.swapFence === true &&
    commit &&
    "since" in drain &&
    "until" in drain &&
    validTime(drain.since) &&
    validTime(drain.until) &&
    Date.parse(drain.until) > Date.parse(drain.since)
    ? `[deploy:all] ${step}: existing deployment fence — commit ${commit}; since ${drain.since}; expires ${drain.until}; upload outcome remains unverified`
    : `[deploy:all] ${step}: existing deployment fence details unavailable; no recovery attempted`;
}

/** The step's first line when the fleet was drained, or when the drain was asked for and refused. */
export function drainBeganLine(step: string, answer: PostAnswer, tag = "deploy:all"): string {
  return drainSet(answer)
    ? `[${tag}] ${step}: fleet drained — /attach refuses new runs until ${drainUntil(answer)}; the runs in flight finish, new ones wait at their attach`
    : `[${tag}] ${step}: ${drainFailureReason(answer)}; deployment stopped; any existing drain remains in place`;
}

/** The step's first line when no admin bearer is in the env: the wait is today's, and says so. */
export function drainSkippedLine(step: string, tokenEnv: string, tag = "deploy:all"): string {
  return `[${tag}] ${step}: ${tokenEnv} is not set — waiting without a drain: new runs keep landing and the wait may never find a quiet minute (add the secret; release-and-deploy item 31)`;
}

export type DrainReopenOutcome = "open" | "held" | "post-upload-unproven" | "refused" | "unknown";

/** A missing reply is not a refusal. Only the source-backed conflict can be reconsidered. */
export function drainReopenOutcome(answer: PostAnswer): DrainReopenOutcome {
  if ("error" in answer) return "unknown";
  if (
    answer.status === 409 &&
    Object.keys(answer.body).length === 1 &&
    answer.body.error === "deploy-fence: the pre-upload Worker cannot reopen the fleet"
  )
    return "post-upload-unproven";
  if (
    answer.status === 409 &&
    !["staging maintenance requires explicit release", "deploy-fence: admitted work has not settled"].includes(
      String(answer.body.error),
    )
  )
    return "unknown";
  if (answer.status >= 500) return "unknown";
  if (Number.isSafeInteger(answer.status) && answer.status >= 400 && answer.status <= 599) return "refused";
  if (answer.status !== 200 || answer.body.error !== undefined || typeof answer.body.cleared !== "boolean")
    return "unknown";
  const held = answer.body.held;
  if (held !== undefined && (!Array.isArray(held) || held.some((v) => typeof v !== "string"))) return "unknown";
  if (answer.body.draining === null && (!held || held.length === 0)) return "open";
  return answer.body.cleared === false && Array.isArray(held) && held.length > 0 ? "held" : "unknown";
}

/** Window matching is only the first check; the caller retains and compares the whole fence. */
export function sameDrainWindow(
  value: unknown,
  window: { since?: string; until: string | undefined },
): value is Record<string, unknown> & { since: string; until: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof window.since === "string" &&
    typeof window.until === "string" &&
    Number.isFinite(Date.parse(window.since)) &&
    Date.parse(window.until) > Date.parse(window.since) &&
    row.since === window.since &&
    row.until === window.until
  );
}

/** Receiver version facts were not returned by this contract. Never infer them from a later read. */
export function drainReopenDiagnostic(answer: PostAnswer, phase: "initial" | "retry", uploadVersion?: string): string {
  const knownVersion =
    typeof uploadVersion === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uploadVersion);
  return (
    "[resident-reopen-diagnostic] " +
    JSON.stringify({
      schema: 1,
      phase,
      outcome: drainReopenOutcome(answer),
      httpStatus: !("error" in answer) && Number.isSafeInteger(answer.status) ? answer.status : null,
      uploadedVersion: knownVersion ? { state: "reported", id: uploadVersion } : { state: "unavailable" },
      receiverVersion: { state: "unreported" },
      nativeOutcome: "unverified",
    })
  );
}

/** Report acknowledgement or doubt without echoing bodies or promising a guarded lift will succeed. */
export function drainLiftedLine(
  step: string,
  answer: PostAnswer,
  _drain: { drained: boolean; until: string | undefined },
  tag = "deploy:all",
): string {
  const outcome = drainReopenOutcome(answer);
  if (outcome === "open") return `[${tag}] ${step}: fleet reopen acknowledged; registry readback is still required`;
  if (outcome === "held")
    return `[${tag}] ${step}: fleet stays closed with image-report holds; awaiting registry readback`;
  if (outcome === "unknown")
    return `[${tag}] ${step}: fleet reopen outcome is unknown; settling through registry reads only`;
  const status = "error" in answer ? "unavailable" : answer.status;
  return `[${tag}] ${step}: fleet NOT reopened (HTTP ${status}; ${outcome}); the guarded request was refused`;
}

/** One resident's word in a `/reconcile` answer, as the line prints it. */
type ReconcileRow = { resource?: unknown; result?: unknown; verified?: unknown };

const reconcileWords = (rows: ReconcileRow[]): string =>
  rows
    .map(
      (r) =>
        `${typeof r.resource === "string" ? r.resource : "?"} ${String(r.result ?? "?")}${r.verified === true ? "" : " (unverified)"}`,
    )
    .join(", ");

/** The line after the deploy landed and `/reconcile` answered: every touched
 *  resident's container cycled AND VERIFIED on the new image inside the drain
 *  window (resident-repos item 69's order; issue 1931: "reconciled" is not
 *  "swapped", so each row also says whether the fresh container was verified),
 *  or which resident is not yet verified — the registry holds the drain for
 *  those, and the fleet reopens on their reports — or the request's own
 *  failure; the lift is asked right after, and the registry decides. */
export function reconcileLine(step: string, answer: PostAnswer, tag = "deploy:all"): string {
  const ok = !("error" in answer) && answer.status >= 200 && answer.status < 300;
  if (!ok)
    return `[${tag}] ${step}: the fleet could NOT be reconciled onto the new image (${answerWords(answer)}) — a stale container restarts on its next quiet attach or refresh instead`;
  const rows: ReconcileRow[] = Array.isArray(answer.body.reconciled) ? (answer.body.reconciled as ReconcileRow[]) : [];
  const unverified = rows.filter((r) => r.verified !== true);
  if (unverified.length > 0)
    return `[${tag}] ${step}: fleet reconciled, but not every container is verified on the new image yet (${reconcileWords(rows)}) — the drain holds for the unverified until each reports`;
  return `[${tag}] ${step}: fleet reconciled and every container verified on the new image (${reconcileWords(rows) || "no residents"})`;
}

/** Appended to the gave-up line when the fleet was drained for the whole wait:
 *  what refused was in flight before the drain began and outlived the budget. */
export const DRAINED_GAVE_UP_SUFFIX =
  " — the fleet was drained for the whole wait, so what refused was already in flight when the drain began and outlived the budget; the drain is lifted";

/** The real POST: a bearer, a JSON body, a bounded wait; never throws. */
export async function postJson(url: string, bearer: string, body: Record<string, unknown>): Promise<PostAnswer> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v === "object" && v !== null) parsed = v as Record<string, unknown>;
    } catch {
      /* a non-JSON body reads as {} — the status carries the answer */
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { error: `POST ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
