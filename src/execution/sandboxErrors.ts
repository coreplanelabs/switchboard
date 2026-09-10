// Fleet-capacity classification for the per-thread sandbox path
// (docs/reference/specs/execution.md item 14): ONE recognizer and one answer shape, shared
// by the sandbox Worker (which names the condition) and the bot's executor
// (which waits on it). Deliberately free of node: imports so wrangler can
// bundle it into the Worker, like bashTimeout.ts and shellQuote.ts.
//
// Why this exists: enough concurrent cold runs exhaust the sandbox fleet's
// `max_instances`. The @cloudflare/sandbox 0.3.x client could not parse the
// platform's plain-text "no instance available" 503 and threw the bare
// `Failed to create session: 503`; carried in-body as an ordinary failure, the
// executor threw ExecInfraError on it, and the runner's fail-fast breaker read
// two of them in a row as a WEDGED sandbox and aborted the run within seconds.
// A full fleet is capacity: nothing ran, nothing is broken, and the right
// move is to wait for an instance. On 0.12.x the SDK throws a typed
// `ContainerUnavailableError` (code `CONTAINER_UNAVAILABLE`) for the same
// condition; the recognizer below takes the type first and the text second.

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
 *    the base Container's plain-text 503;
 *  - "no container instance that can be provided to this durable object" /
 *    "no Container instance available" — the platform's own wording, which the
 *    0.12.x SDK keeps as the message of its `ContainerUnavailableError`;
 *  - `CONTAINER_UNAVAILABLE` — that error's JSON code, when a client prints it.
 *  A stale session, a wedged sandbox, a file-op failure, or a 503 from
 *  something a command itself contacted is NOT this. */
const FLEET_BUSY_PATTERNS: readonly RegExp[] = [
  /^Failed to create session: 503\b/i,
  /no container instance (?:that can be provided|available)/i,
  /\bCONTAINER_UNAVAILABLE\b/,
];

export function isFleetBusy(message: string): boolean {
  const text = message.trim();
  return text.length > 0 && FLEET_BUSY_PATTERNS.some((re) => re.test(text));
}

/** The 0.12.x SDK's typed class for a full fleet. Matched by NAME and by its
 *  `code`, not `instanceof`: the Worker sees the error after it crossed the
 *  Durable Object RPC boundary, which keeps `name`/`message` and drops the
 *  prototype. Text stays as the second layer for older SDKs and for causes
 *  the SDK wraps in a plain Error. */
export const FLEET_BUSY_ERROR_NAME = "ContainerUnavailableError";

/** The shape of anything thrown at the Worker — a typed SDK error, a plain
 *  Error, or a string — reduced to what classification can read. */
export interface ThrownShape {
  name?: string;
  code?: unknown;
  message?: string;
}

export function thrownShape(err: unknown): ThrownShape {
  if (err instanceof Error) {
    return { name: err.name, code: (err as { code?: unknown }).code, message: err.message };
  }
  if (typeof err === "object" && err !== null) {
    const o = err as ThrownShape;
    return { name: o.name, code: o.code, message: typeof o.message === "string" ? o.message : String(err) };
  }
  return { message: String(err) };
}

/** Type first, text second: a `ContainerUnavailableError` (by name or code) or
 *  any message `isFleetBusy` recognizes. */
export function isFleetBusyError(err: unknown): boolean {
  const s = thrownShape(err);
  return (
    s.name === FLEET_BUSY_ERROR_NAME || s.code === "CONTAINER_UNAVAILABLE" || (!!s.message && isFleetBusy(s.message))
  );
}

/** The 0.12.x Durable Object's answer while its container is still booting:
 *  no session exists yet and nothing ran, so the SAME request can be re-sent
 *  after a short pause — the one retry the Worker still does itself. */
export const CONTAINER_STARTING_PATTERN = /^Container is starting\. Please retry in a moment\.?$/i;

export function isContainerStarting(err: unknown): boolean {
  const { message } = thrownShape(err);
  return !!message && CONTAINER_STARTING_PATTERN.test(message.trim());
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

/** The text the Worker carries in-body for a thrown value: the SDK's own
 *  message when it has one, else a sentence that says the SDK gave none —
 *  naming the error's name and code, and the one condition known to produce
 *  it. Never the empty string (docs/reference/specs/execution.md items 3 and 6).
 *
 *  Why: during a Worker+image rollout a new thread's Durable Object can land
 *  on a container still running the previous (0.3.x) image. The 0.12.x
 *  client posts `{command, sessionId}`, the old server
 *  answered 400 `{"error": "Session ID and command are required"}`, and the
 *  client built a `SandboxError` from a body with no `message` — so
 *  `err.message` was `""`. The Worker's `shape.message ?? String(err)` kept
 *  the empty string (`??` only fires on null/undefined), every classifier
 *  fell through, and seven commands reached the model as silent `exit 127`s
 *  that read as a dead shell. Classifiers (`isFleetBusyError`,
 *  `isRecycleError`, `recycledMidCommandMessage`) keep reading the raw shape;
 *  this is only the text that leaves the Worker. */
export function thrownText(shape: ThrownShape): string {
  const text = shape.message?.trim() ?? "";
  if (text) return text;
  const who = shape.name
    ? `${shape.name}${shape.code !== undefined ? `, code ${String(shape.code)}` : ""}`
    : "no error name";
  return (
    `sandbox exec failed with no message from the SDK (${who}); the container may still be running a previous image ` +
    "while a Worker/image rollout is in progress — retry in a minute"
  );
}
