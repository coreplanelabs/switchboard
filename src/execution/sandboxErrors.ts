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
  // The platform's wording since the 0.13 line ("… Try again later, or try
  // configuring a higher value for max_instances"): the 0.13 SDK's own warm
  // pool matches on this exact phrase. Seen live passing through as a plain
  // in-body error and ending two reviews in under a minute each.
  /Maximum number of running container instances exceeded/i,
  // The platform's start-rate limit: a burst of fresh threads (twenty-four
  // seeded sandboxes started within twenty seconds) had a third of its
  // container starts refused with this text, and the Worker read it as a
  // failed seed. It is capacity for a moment, like a full fleet: the
  // executor waits and re-sends the identical request.
  /too many containers per second/i,
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

/** The Worker's answer on /read and /write (sent as HTTP 503): the named
 *  reason plus an `error` that keeps the SDK's own message as the cause, so
 *  the logs and the model can still see what the platform actually said.
 *  `containerId` is the thread's Durable Object id when the Worker knows it —
 *  additive, so an older Worker's answer without it changes nothing — carried
 *  so the bot's ending log can name which object the fleet refused. */
export function fleetBusyAnswer(
  cause: string,
  containerId?: string,
): { error: string; reason: typeof FLEET_BUSY_REASON; containerId?: string } {
  return {
    error: `${FLEET_BUSY_REASON}: ${FLEET_BUSY_EXPLANATION} (${cause})`,
    reason: FLEET_BUSY_REASON,
    ...(containerId !== undefined ? { containerId } : {}),
  };
}

/** The Worker's answer on /exec, in-body under the streamed HTTP 200 like every
 *  other exec failure: the dual `error` + exit-127/stderr shape (item 3) so an
 *  executor that predates in-body errors still renders it, plus the reason. */
export function fleetBusyExecAnswer(
  cause: string,
  containerId?: string,
): {
  error: string;
  reason: typeof FLEET_BUSY_REASON;
  containerId?: string;
  stdout: "";
  stderr: string;
  exitCode: 127;
} {
  const { error, reason, containerId: id } = fleetBusyAnswer(cause, containerId);
  return { error, reason, ...(id !== undefined ? { containerId: id } : {}), stdout: "", stderr: error, exitCode: 127 };
}

// ---------------------------------------------------------------------------
// The fleet-busy ending as ONE queryable log line on each side. A run this
// condition ends used to exist only on its card and its record — the Worker's
// logs held the platform's raw refusals with no run attached, the bot's stdout
// held nothing — so a log sweep after a capacity incident could not count the
// runs it killed. The stable prefix below selects both lines in one query;
// the card and the record are unchanged.

/** The stable prefix both events share — a log query on it selects the pair. */
export const FLEET_BUSY_LOG_PREFIX = "sandbox.fleet-busy" as const;
/** The sandbox Worker's line, where the platform's refusal is named `fleet-busy`. */
export const FLEET_BUSY_REFUSED_EVENT = `${FLEET_BUSY_LOG_PREFIX}.refused` as const;
/** The bot's line, at the one site where the spent wait ends the run. */
export const FLEET_BUSY_RUN_ENDED_EVENT = `${FLEET_BUSY_LOG_PREFIX}.run-ended` as const;

/** What the executor learned from the LAST busy answer before its wait was
 *  spent — carried on `ExecCapacityError` so the bot's ending site can log
 *  these facts beside the run id, which only the bot knows. */
export interface FleetBusyEndingFacts {
  /** The Worker's error text, which keeps the platform's own refusal as the cause. */
  refusal: string;
  /** The total time the run spent waiting for an instance, in ms. */
  waitedMs: number;
  /** The sandbox Durable Object id the Worker answered with (absent from an older Worker). */
  containerId?: string;
}

/** The Worker's one JSON line where the platform's refusal is turned into the
 *  named condition, beside `sandbox.starting` and `sandbox.idle-stop`. */
export function fleetBusyRefusedLine(fields: {
  thread: string;
  container: string;
  refusal: string;
  route?: string;
}): string {
  return JSON.stringify({ event: FLEET_BUSY_REFUSED_EVENT, ...fields });
}

/** The bot's one JSON line for a run the full fleet ended — or null for every
 *  other ending, so the caller logs nothing then. Matched by the error's name
 *  and its carried facts, never `instanceof`: this module is bundled into the
 *  Worker and cannot import the executor's class. */
export function fleetBusyRunEndedLine(run: string | undefined, thread: string, err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; fleetBusy?: FleetBusyEndingFacts };
  if (e.name !== "ExecCapacityError" || e.fleetBusy === undefined) return null;
  const { refusal, waitedMs, containerId } = e.fleetBusy;
  return JSON.stringify({
    event: FLEET_BUSY_RUN_ENDED_EVENT,
    ...(run !== undefined ? { run } : {}),
    thread,
    ...(containerId !== undefined ? { container: containerId } : {}),
    refusal,
    waitedMs,
  });
}

/** The message `ExecCapacityError` carries once the wait is spent: names the
 *  wait and the missing automatic queue as a bug, never delegates a retry. */
export function fleetBusyExhaustedMessage(waitedMs: number): string {
  return (
    `this is a bug: the sandbox fleet had no free per-thread sandbox after waiting ${Math.round(waitedMs / 1000)}s ` +
    "(the fleet's max_instances is reached), and no automatic queue remained"
  );
}

// ---------------------------------------------------------------------------
// A container that is still starting (docs/reference/specs/execution.md item 23).
//
// Why this exists: a thread's first request finds no running container, and
// the SDK's first exec then carries the whole start — the platform's instance
// grant (its default wait 30 s), the image pull on a machine that has not seen
// this image, the microVM boot and the runtime's port (90 s) — before the
// command runs. The executor's per-send deadline for a 60 s command is 90 s,
// so every fresh-sandbox run died with "gave no answer within 90s" while its
// container came up a minute later and sat idle. The Worker now names the
// condition instead: it starts the container in the background and answers
// `sandbox-starting` at once, the executor waits on the token exactly as it
// waits on `fleet-busy` — the identical request re-sent, nothing ran — under a
// start budget of its own, and the command runs once the container is up.

/** The machine token the executor waits on, beside `fleet-busy`. */
export const SANDBOX_STARTING_REASON = "sandbox-starting" as const;

/** What the token means, in the words the model and the operator see. */
export const SANDBOX_STARTING_EXPLANATION =
  "the thread's sandbox container is starting (image pull, boot, runtime) — nothing ran yet; the request is re-sent once it is up";

/** The executor waits at most this long for a container to start, whatever
 *  the command's own budget: the platform's own start allowances (the
 *  instance grant, 90 s for the port) plus a slow image pull fit inside it,
 *  and a 60 s command is never killed by a two-minute start it did not cause.
 *  Ten minutes, not five: under a midday burst the platform admitted about
 *  seven starts at once and granted the rest 2.5 to 5 minutes later — two
 *  threads of twenty-four died at the five-minute mark with their container
 *  a minute away. A run that waits ten minutes for its container starts; one
 *  that dies at five does not, and nothing else in the run was in progress. */
export const SANDBOX_START_WAIT_MAX_MS = 10 * 60_000;

/** Backoff between re-sends while a container starts: 5 s, 10 s, then 15 s.
 *  A start takes tens of seconds, not minutes, so the poll is denser than the
 *  fleet wait's and a ready container is used within 15 s of coming up. */
export const SANDBOX_START_BACKOFF_MS: readonly number[] = [5_000, 10_000, 15_000];

/** The reasons whose answers the executor re-sends after a wait — a full
 *  fleet, a starting container, a container that did not accept the
 *  connection (`runtime-busy`, below). Every other `reason` — or none — is an
 *  ordinary failure after one send. */
export type WaitReason = typeof FLEET_BUSY_REASON | typeof SANDBOX_STARTING_REASON | typeof RUNTIME_BUSY_REASON;

export function isWaitReason(reason: unknown): reason is WaitReason {
  return reason === FLEET_BUSY_REASON || reason === SANDBOX_STARTING_REASON || reason === RUNTIME_BUSY_REASON;
}

/** The Worker's answer on /read and /write (sent as HTTP 503) while the
 *  container starts: the token, and the start's own phase as the cause. */
export function sandboxStartingAnswer(cause: string): { error: string; reason: typeof SANDBOX_STARTING_REASON } {
  return {
    error: `${SANDBOX_STARTING_REASON}: ${SANDBOX_STARTING_EXPLANATION} (${cause})`,
    reason: SANDBOX_STARTING_REASON,
  };
}

/** The Worker's answer on /exec, in-body under the streamed HTTP 200 in the
 *  item-3 dual shape, like `fleetBusyExecAnswer`. */
export function sandboxStartingExecAnswer(cause: string): {
  error: string;
  reason: typeof SANDBOX_STARTING_REASON;
  stdout: "";
  stderr: string;
  exitCode: 127;
} {
  const { error, reason } = sandboxStartingAnswer(cause);
  return { error, reason, stdout: "", stderr: error, exitCode: 127 };
}

/** The message `ExecCapacityError` carries when a container did not start
 *  inside the start budget: the wait and the missing automatic recovery. */
export function startWaitExhaustedMessage(waitedMs: number): string {
  return (
    `this is a bug: the thread's sandbox did not finish starting within ${Math.round(waitedMs / 1000)}s, ` +
    "and no automatic start wait remained"
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

// ---- A runtime that did not answer (docs/reference/specs/execution.md item 9) ----
//
// Every command and file operation reaches the container through the SDK's
// control connection to the container's port. When nothing answers there —
// the SDK's server exited, or the image's PID 1 is starting it again — the
// SDK's connect aborts after 30 s with a bare `The operation was aborted`:
// no container, no cause, nothing a card can act on. The Durable Object
// names the condition instead, with the facts a reader needs.

/** The named reason the Worker answers with, like `fleet-busy`: a machine
 *  token the executor matches on, never the SDK's text. */
export const RUNTIME_UNREACHABLE_REASON = "runtime-unreachable" as const;

/** The name the Worker's typed error carries across the Durable Object RPC
 *  boundary (which keeps `name`/`message` and drops the prototype). */
export const RUNTIME_UNREACHABLE_ERROR_NAME = "SandboxRuntimeUnreachableError";

export interface RuntimeUnreachableFacts {
  /** The Durable Object's id — the same word the `containers` log dataset carries as the container id. */
  containerId: string;
  /** The platform's view at the moment of the failure (`ctx.container.running`). */
  running: boolean | undefined;
  /** The Worker's `@cloudflare/sandbox` pin, which is also the image tag. */
  sdkVersion: string;
  /** The SDK's own text, verbatim: what it saw. */
  cause: string;
}

/** The text that names the condition: the token first (the executor and the
 *  harness read it), then the facts a reader needs to find the container in
 *  the logs and to judge the command — it may not have run, and the workspace
 *  is still there because the container is. */
export function runtimeUnreachableMessage(f: RuntimeUnreachableFacts): string {
  const platform = f.running === true ? "running" : f.running === false ? "stopped" : "in a state it did not report";
  return (
    `${RUNTIME_UNREACHABLE_REASON}: the sandbox container's runtime did not answer ` +
    `(container ${f.containerId}, sandbox SDK ${f.sdkVersion}; the platform reports the container ${platform}) — ` +
    "nothing ran; if the container still runs, /workspace is intact and its runtime is being started again: " +
    `wait a moment, then retry (${f.cause.trim() || "no detail from the SDK"})`
  );
}

/** The Worker's typed error for a silent control port: built inside the
 *  Durable Object with its facts, read by the fetch handler on the other side
 *  of the RPC boundary, so it is matched by name and by its message token,
 *  never by `instanceof`. */
export class SandboxRuntimeUnreachableError extends Error {
  readonly reason = RUNTIME_UNREACHABLE_REASON;
  constructor(readonly facts: RuntimeUnreachableFacts) {
    super(runtimeUnreachableMessage(facts));
    this.name = RUNTIME_UNREACHABLE_ERROR_NAME;
  }
}

/** Name first, token second: the typed error after the RPC boundary, or any
 *  message that starts with the token (an executor reading a Worker's text). */
export function isRuntimeUnreachableError(err: unknown): boolean {
  const s = thrownShape(err);
  return s.name === RUNTIME_UNREACHABLE_ERROR_NAME || !!s.message?.startsWith(`${RUNTIME_UNREACHABLE_REASON}:`);
}

/** The `/read` and `/write` answer (sent as HTTP 503): the named reason and the
 *  text as the error — a 503 the executor's transport retry re-sends, which is
 *  safe: a file op that never reached a server did nothing. */
export function runtimeUnreachableAnswer(message: string): {
  error: string;
  reason: typeof RUNTIME_UNREACHABLE_REASON;
} {
  return { error: message, reason: RUNTIME_UNREACHABLE_REASON };
}

/** The `/exec` answer, in-body under the streamed HTTP 200 like every other exec
 *  failure: the dual `error` + exit-127/stderr shape (item 3) plus the reason.
 *  Never re-sent by anyone: the executor re-sends nothing in-body, and the
 *  text tells the model to wait, then retry. */
export function runtimeUnreachableExecAnswer(message: string): {
  error: string;
  reason: typeof RUNTIME_UNREACHABLE_REASON;
  stdout: "";
  stderr: string;
  exitCode: 127;
} {
  return { error: message, reason: RUNTIME_UNREACHABLE_REASON, stdout: "", stderr: message, exitCode: 127 };
}

// ---- A container that did not accept the connection (docs/reference/specs/execution.md item 28) ----
//
// The container's runtime accepts one control connection per SDK call. When
// the platform's fetch to the container's port is not accepted inside the
// platform's own allowance — a few seconds, not the SDK's 30 s connect timeout
// — it throws a plain `Error` reading `Container is taking too long to accept
// the connection; the application could be overwhelmed with load`. Nothing
// ran: the SDK was still connecting, before any process was started. The
// platform's words name a cause it never measured: seen live under a command
// saturating every core (a whole repository's verify, three minutes in) AND
// on an idle container (a review thread running `sed` and `grep`, the
// connection accepted 0.9 s before and 0.8 s after the refused one). Both
// times the harness's one-second poll of its transcript log met it, the
// failure reached the bot as an ordinary in-body error, and the run was torn
// down while its container answered the next command a second later. The
// Worker names the refusal instead — never its cause — with a machine token
// the executor re-sends on: the identical request, once the container accepts.

/** The named reason the Worker answers with, beside `fleet-busy` and `sandbox-starting`. */
export const RUNTIME_BUSY_REASON = "runtime-busy" as const;

/** The resident's own word for a container near its cgroup memory cap
 *  (resident-repos.md item 70): a new attach above the soft threshold and a
 *  new exec above the hard one are refused with this token — the same 503
 *  shape as `mirror-busy`, so the bot falls back or waits legibly while the
 *  commands already running finish. Defined here, beside the other machine
 *  tokens both sides read, so the Worker and the bot cannot drift. */
export const MEMORY_PRESSURE_REASON = "memory-pressure" as const;

/** What the token means, in the words the model and the operator see. */
export const RUNTIME_BUSY_EXPLANATION =
  "the thread's sandbox container is running but did not accept the connection inside the platform's allowance — nothing ran, the request is re-sent once it accepts";

/** The platform's wording for a container port that did not accept the SDK's
 *  connect inside the platform's own allowance. A wording, not a type: the
 *  platform throws a plain `Error`, and the SDK hands it on unwrapped. */
export const RUNTIME_BUSY_WORDING = /taking too long to accept the connection/i;

/** The executor waits at most this long for the container to accept, capped
 *  by the operation's own budget: when a command of the thread's own is what
 *  holds the container, it is bounded like every command, and a poll that
 *  waits past its own budget has nothing left to run. */
export const RUNTIME_BUSY_WAIT_MAX_MS = 5 * 60_000;

/** Backoff between re-sends: 3 s, 5 s, then 10 s. Each refusal already cost
 *  the platform's allowance (about six seconds live), and the container has
 *  accepted again within a second of every refusal seen, so the poll stays
 *  dense. */
export const RUNTIME_BUSY_BACKOFF_MS: readonly number[] = [3_000, 5_000, 10_000];

/** The name the Worker's typed error carries across the Durable Object RPC boundary. */
export const RUNTIME_BUSY_ERROR_NAME = "SandboxRuntimeBusyError";

/** Is this one link of an error's cause chain the platform's accept refusal?
 *  By the wording alone — the platform gives no type. Applied by the Worker
 *  to a failure met BEFORE a process was started (the spawn, the warm-up, a
 *  file operation), never to a failure of a running command's output. */
export function isRuntimeBusySignal(link: unknown): boolean {
  if (link === null || typeof link !== "object") return false;
  const { message } = link as { message?: unknown };
  return typeof message === "string" && RUNTIME_BUSY_WORDING.test(message);
}

/** The text that names the condition: the token first (the executor reads
 *  it), the container so a reader finds it in the logs, the platform's words. */
export function runtimeBusyMessage(f: { containerId: string; cause: string }): string {
  return `${RUNTIME_BUSY_REASON}: ${RUNTIME_BUSY_EXPLANATION} (container ${f.containerId}; ${f.cause.trim() || "no detail from the platform"})`;
}

/** The Worker's typed error for a container that did not accept the
 *  connection, built inside the Durable Object and read by the fetch handler
 *  across the RPC boundary — matched by name and by its message token, never
 *  by `instanceof`. */
export class SandboxRuntimeBusyError extends Error {
  readonly reason = RUNTIME_BUSY_REASON;
  constructor(readonly facts: { containerId: string; cause: string }) {
    super(runtimeBusyMessage(facts));
    this.name = RUNTIME_BUSY_ERROR_NAME;
  }
}

/** Name first, token second: the typed error after the RPC boundary, or any
 *  message that starts with the token. */
export function isRuntimeBusyError(err: unknown): boolean {
  const s = thrownShape(err);
  return s.name === RUNTIME_BUSY_ERROR_NAME || !!s.message?.startsWith(`${RUNTIME_BUSY_REASON}:`);
}

/** Does a failure's text carry the token anywhere — the typed error's own
 *  message, or that message behind a wrapper's prefix (a `StepError` built
 *  from it, the fetch step's mint prefix)? The refresh cycle's classifier
 *  reads this: the token decides, never the platform's words. */
export function carriesRuntimeBusyToken(message: string): boolean {
  return new RegExp(`(?:^|[\\s;(])${RUNTIME_BUSY_REASON}: `).test(message);
}

/** The `/read` and `/write` answer (sent as HTTP 503): the token and the text. */
export function runtimeBusyAnswer(message: string): { error: string; reason: typeof RUNTIME_BUSY_REASON } {
  return { error: message, reason: RUNTIME_BUSY_REASON };
}

/** The `/exec` answer, in-body under the streamed HTTP 200 in the item-3 dual
 *  shape, like `fleetBusyExecAnswer`: the executor re-sends on the token. */
export function runtimeBusyExecAnswer(message: string): {
  error: string;
  reason: typeof RUNTIME_BUSY_REASON;
  stdout: "";
  stderr: string;
  exitCode: 127;
} {
  return { error: message, reason: RUNTIME_BUSY_REASON, stdout: "", stderr: message, exitCode: 127 };
}

/** The message `ExecCapacityError` carries when the container never accepted
 *  inside the wait: the wait, what was met, the one cause known and the one
 *  ruled out, and what to do. It never tells the reader to wait for a command
 *  that may not be running. */
export function runtimeBusyExhaustedMessage(waitedMs: number): string {
  return (
    `sandbox busy — the thread's container did not accept a connection within ${Math.round(waitedMs / 1000)}s ` +
    "(the platform refused every connect of the wait; a command saturating its cores is one cause, an idle container has met it too); retry"
  );
}
