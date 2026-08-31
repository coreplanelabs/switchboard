// Per-call bash timeout policy (features/execution.md item 11): ONE clamp and
// one set of bounds, shared by the tool layer, every executor, and both deploy
// Workers (which import from src/execution like shellQuote/residentDetach).
// Deliberately free of node: imports so wrangler can bundle it into Workers.

/** Default per-command budget when the caller passes no timeoutMs. */
export const BASH_TIMEOUT_MS = 5 * 60_000;

/** Floor: anything lower is a typo or an attack, not a budget. */
export const BASH_TIMEOUT_MIN_MS = 1_000;

/** Hard ceiling a caller can raise the budget to — far inside the 45-minute
 *  run budget, so one command can never eat a whole run. */
export const BASH_TIMEOUT_MAX_MS = 20 * 60_000;

/** Margin the remote exec clients add to their HTTP wait over the command
 *  budget, so the server's own timeout answer (a streamed exit 124) wins the
 *  race against the client's transport deadline instead of both firing at the
 *  same instant. */
export const EXEC_CALL_MARGIN_MS = 30_000;

/** The documented clamp rule, applied identically bot-side and server-side
 *  (a server never trusts the client's number): a finite number is truncated
 *  to an integer and clamped into [BASH_TIMEOUT_MIN_MS, BASH_TIMEOUT_MAX_MS]
 *  — so 0/negative run at the 1s floor, a 25-minute ask runs at 20 minutes —
 *  and anything else (absent, NaN, Infinity, a string) falls back to the
 *  5-minute default. */
export function clampBashTimeout(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return BASH_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(requested), BASH_TIMEOUT_MIN_MS), BASH_TIMEOUT_MAX_MS);
}

/** The line a timed-out command shows the model: names the limit that fired
 *  and the knob that raises it, so the model can self-correct (re-run with a
 *  larger timeoutMs, split the command, or background it) instead of guessing
 *  at a generic abort. */
export function bashTimeoutNote(timeoutMs: number): string {
  return (
    `aborted at the ${Math.round(timeoutMs / 1000)}s command timeout ` +
    `(pass the bash tool's timeoutMs for longer commands, max ${BASH_TIMEOUT_MAX_MS} ms)`
  );
}
