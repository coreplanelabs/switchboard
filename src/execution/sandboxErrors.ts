// Fleet-capacity classification for the per-thread sandbox path
// (features/execution.md item 14): ONE recognizer and one answer shape, shared
// by the sandbox Worker (which names the condition) and the bot's executor
// (which waits on it). Deliberately free of node: imports so wrangler can
// bundle it into the Worker, like bashTimeout.ts and shellQuote.ts.
//
// Why this exists (2026-09-07): thirteen cold runs in 45 minutes exhausted
// the sandbox fleet's `max_instances` (then 10). The @cloudflare/sandbox 0.3.x
// client cannot parse the platform's plain-text "no instance available" 503
// and throws the bare `Failed to create session: 503`; the Worker carried it
// in-body as an ordinary failure, the executor threw ExecInfraError on it, and
// the runner's fail-fast breaker (#92) read two of them in a row as a WEDGED
// sandbox — the #525 review aborted in 33 s. A full fleet is capacity: nothing
// ran, nothing is broken, and the right move is to wait for an instance.

/** The named reason the Worker answers with, mirroring the resident's
 *  `mirror-busy` (resident-repos.md) — a machine token the executor matches
 *  on, never the SDK's message text. */
export const FLEET_BUSY_REASON = "fleet-busy" as const;

/** What a full fleet means, in the words the model and the operator see. */
export const FLEET_BUSY_EXPLANATION =
  "no free per-thread sandbox — every container instance the fleet may run (wrangler.jsonc max_instances) is awake serving another thread";

/** The executor waits at most this long for an instance — the default bash
 *  budget, so a default command never waits past its own limit. A longer
 *  command's wait is still capped here: waiting five minutes for a slot is
 *  patience; waiting twenty is a run that should have said so. */
export const FLEET_BUSY_WAIT_MAX_MS = 5 * 60_000;

/** Backoff between re-sends: 10 s, 20 s, then 30 s until the wait is spent.
 *  Slots free up when other threads' runs end (minutes), so sub-10 s polling
 *  would only burn Worker requests. */
export const FLEET_BUSY_BACKOFF_MS: readonly number[] = [10_000, 20_000, 30_000];

/** The messages a full fleet produces, across SDK generations:
 *  - `Failed to create session: 503` — the 0.3.x client's unparsed answer to
 *    the base Container's plain-text 503 (what production runs today);
 *  - "no container instance that can be provided to this durable object" /
 *    "no Container instance available" — the platform's own wording, which a
 *    Worker sees when it reaches the container outside the SDK's session path;
 *  - `CONTAINER_UNAVAILABLE` — the JSON error code the 0.12.x SDKs return.
 *  A stale session, a wedged sandbox ("Command execution failed"), a file-op
 *  failure, or a 503 from something a command itself contacted is NOT this. */
const FLEET_BUSY_PATTERNS: readonly RegExp[] = [
  /^Failed to create session: 503\b/i,
  /no container instance (?:that can be provided|available)/i,
  /\bCONTAINER_UNAVAILABLE\b/,
];

export function isFleetBusy(message: string): boolean {
  const text = message.trim();
  return text.length > 0 && FLEET_BUSY_PATTERNS.some((re) => re.test(text));
}

/** The Worker's answer on /read and /write (sent as HTTP 503): the named
 *  reason plus an `error` that keeps the SDK's own message as the cause, so
 *  the logs and the model can still see what the platform actually said. */
export function fleetBusyAnswer(cause: string): { error: string; reason: typeof FLEET_BUSY_REASON } {
  return { error: `${FLEET_BUSY_REASON}: ${FLEET_BUSY_EXPLANATION} (${cause})`, reason: FLEET_BUSY_REASON };
}

/** The Worker's answer on /exec, in-body under the streamed HTTP 200 like every
 *  other exec failure: the dual `error` + exit-127/stderr shape (item 3) so an
 *  executor that predates in-body errors still renders it, plus the reason. */
export function fleetBusyExecAnswer(cause: string): {
  error: string;
  reason: typeof FLEET_BUSY_REASON;
  stdout: "";
  stderr: string;
  exitCode: 127;
} {
  const { error, reason } = fleetBusyAnswer(cause);
  return { error, reason, stdout: "", stderr: error, exitCode: 127 };
}

/** The message `ExecCapacityError` carries once the wait is spent: names the
 *  wait and the knob, and tells the reader this is a retry-later condition. */
export function fleetBusyExhaustedMessage(waitedMs: number): string {
  return (
    `sandbox fleet busy — no free per-thread sandbox after waiting ${Math.round(waitedMs / 1000)}s ` +
    "(the fleet's max_instances is reached); try again in a few minutes"
  );
}
