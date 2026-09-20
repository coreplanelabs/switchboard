// The deploy side of the resident fleet drain (docs/reference/specs/release-and-deploy.md
// item 31; the Worker side is deploy/cloudflare-resident/drain.ts, item 69 of
// resident-repos.md). Before the resident step's first `npm run deploy` the
// runner closes the fleet to new runs with `POST /drain`, so the preflight's
// wait ends when the runs already in flight end instead of when traffic
// happens to pause; after the step — deployed, refused past the budget, or
// failed — it reopens the fleet with `POST /undrain`, whatever happened. Pure
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

/** The step's first line when the fleet was drained, or when the drain was asked for and refused. */
export function drainBeganLine(step: string, answer: PostAnswer, tag = "deploy:all"): string {
  return drainSet(answer)
    ? `[${tag}] ${step}: fleet drained — /attach refuses new runs until ${drainUntil(answer)}; the runs in flight finish, new ones wait at their attach`
    : `[${tag}] ${step}: the fleet could NOT be drained (${answerWords(answer)}) — waiting without a drain: new runs keep landing and the wait may never find a quiet minute`;
}

/** The step's first line when no admin bearer is in the env: the wait is today's, and says so. */
export function drainSkippedLine(step: string, tokenEnv: string, tag = "deploy:all"): string {
  return `[${tag}] ${step}: ${tokenEnv} is not set — waiting without a drain: new runs keep landing and the wait may never find a quiet minute (add the secret; release-and-deploy item 31)`;
}

/** The step's last line, true to what stood. A drain the runner saw land
 *  (`drained`): reopened, or NOT reopened and reopening by itself at its end.
 *  A drain the runner never saw land — the `/drain` answer refused or lost —
 *  is lifted anyway (it may have landed), and the line says so: `cleared`
 *  answers whether anything stood; a failed lift after no confirmed drain
 *  names the doubt and where to look, never a drain that "ends". */
export function drainLiftedLine(
  step: string,
  answer: PostAnswer,
  drain: { drained: boolean; until: string | undefined },
  tag = "deploy:all",
): string {
  const ok = !("error" in answer) && answer.status >= 200 && answer.status < 300;
  // The gated lift (issue 1931): the registry kept the drain because a
  // container still reports the pre-deploy image — the fleet reopens by itself
  // on the LAST container's new-image report, never on this call's return.
  const held =
    !("error" in answer) && answer.body.cleared === false && Array.isArray(answer.body.held)
      ? (answer.body.held as unknown[]).filter((h): h is string => typeof h === "string")
      : [];
  if (ok && held.length > 0)
    return `[${tag}] ${step}: fleet stays closed — ${held.join(", ")} still report${held.length === 1 ? "s" : ""} the pre-deploy image; it reopens by itself on the last container's new-image report${drain.until ? ` (backstop ${drain.until})` : ""}`;
  if (drain.drained) {
    if (ok) return `[${tag}] ${step}: fleet reopened`;
    return `[${tag}] ${step}: fleet NOT reopened (${answerWords(answer)}) — it reopens by itself${drain.until ? ` at ${drain.until}` : " when the drain ends"}; \`POST /undrain\` with the drain or admin bearer reopens it now`;
  }
  if (ok) {
    const cleared = "error" in answer ? false : answer.body.cleared === true;
    return cleared
      ? `[${tag}] ${step}: fleet reopened — the drain had landed although its answer was lost`
      : `[${tag}] ${step}: no drain stood to lift — the fleet was never closed`;
  }
  return `[${tag}] ${step}: the lift answered ${answerWords(answer)} and no drain was confirmed — the fleet should be open; \`GET /residents\` says (\`draining\`), and \`POST /undrain\` with the drain or admin bearer reopens it if not`;
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
