// Classifies "the sandbox runtime was replaced under a live call" errors on
// Cloudflare Sandbox 1.0 (@cloudflare/sandbox@next) — the resident Worker's
// failure mode when a `wrangler deploy` (or a container restart) recycles the
// Durable Object isolate while a thread command is running.
//
// Shipped to the resident Worker by relative import (like shellQuote) so the
// bot's unit tests exercise the exact classifier the Worker runs.
//
// Why this is NOT the 0.3.x stale-session recovery the thread-sandbox Worker
// does: there, "Session '<id>' not found" is raised by the session LOOKUP,
// before the command ever runs, so a reset-and-retry cannot double-execute.
// On 1.0 there is no cached default session; the errors below are raised
// MID-OPERATION by the platform or the SDK's runtime-identity fences, and the
// SDK itself marks them `admitted: "unknown", retryable: false` — the command
// may have completed (the 2026-08-29 incident's `npm test` did, exit 0). So an
// /exec that hits one is reported legibly and never re-run; only the pure
// (/read) and idempotent (/write, same content) ops are retried once.
const RUNTIME_INTERRUPTION_PATTERNS: readonly RegExp[] = [
  // Cloudflare platform: the DO isolate was superseded by a code update.
  /reset because its code was updated|this script has been upgraded/i,
  /network connection lost/i,
  // @cloudflare/sandbox 1.0 fences (errors.ts / sandbox.ts, exact texts).
  /runtime identity is no longer active/i,
  /sandbox lifetime is no longer current/i,
  /was interrupted while the platform was updating the sandbox runtime/i,
  /process handle .* no longer identifies pid/i,
];

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : "";
}

/** Walk `err` and its `cause` chain (the SDK wraps platform errors; bounded
 *  like the SDK's own walker) — any link matching a runtime-interruption text
 *  classifies the whole error. */
export function isRuntimeInterruption(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    const msg = messageOf(current);
    if (RUNTIME_INTERRUPTION_PATTERNS.some((re) => re.test(msg))) return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** The in-body /exec error for an interrupted command: named like the other
 *  thread errors (`not-attached:` / `evicted:` / …), states the cause the
 *  Worker can actually see, warns that the command may have completed, and
 *  carries the SDK/platform text so the runner's fail-fast diagnostic shows
 *  the real reason on the card. Deliberately carries NO `needs:"attach"` —
 *  the client re-runs the command on that signal. */
export function describeInterruptedExec(err: unknown): string {
  return (
    "interrupted: the sandbox runtime was replaced mid-command (a deploy or container restart recycled it) — " +
    "the command may have completed but its result was lost, so it has NOT been re-run; " +
    `re-check its effects before re-running (${messageOf(err) || String(err)})`
  );
}
