// The per-thread sandbox's lifecycle facts the Worker and the bot share
// (docs/reference/specs/execution.md items 1, 2 and 9): how long an idle
// container stays warm, and how a container replaced or restarted under a
// command is recognized and named. Deliberately free of node: imports so
// wrangler can bundle it into the sandbox Worker.

/** How long an IDLE container stays warm before the Durable Object stops it,
 *  in the Container class's own `<n>[smh]` grammar. Idle means idle: the SDK
 *  renews the activity timeout every second while a command's stream is open
 *  (its control connection's busy poll), so a running command never counts
 *  toward it. 5 minutes frees a finished thread's slot (`max_instances`)
 *  sooner than the SDK default (10 min), while a follow-up inside 5 minutes
 *  still lands on the same warm workspace; a later one re-clones, which is the
 *  documented per-thread degradation (item 1). */
export const SANDBOX_SLEEP_AFTER = "5m";

/** The texts the SDK produces when the container is torn down under a
 *  command, across generations. 0.3.x: the exec handler's generic wrapper (its
 *  real cause, "Session terminated", sat in a field the client discarded), the
 *  cause itself, and the stale-session answer the same attempt got once the
 *  sessions were cleared. 0.12.x: the typed `SessionTerminatedError` text
 *  (`Session '<id>' shell exited (exit code: <n>)`) and the
 *  `OperationInterruptedError` text for a container that stopped under a
 *  pending call, and the disconnect text for a sandbox `destroy()`ed under a
 *  pending call. Anything else — a transport error, a file-op failure — is
 *  never recycle-shaped, whenever it arrives. */
const RECYCLE_SHAPED: readonly RegExp[] = [
  /^Command execution failed$/,
  /^Session terminated$/i,
  /^Session '[^']*' not found$/i,
  /^Session '[^']*' shell exited \(exit code: -?\d+\)$/i,
  /^The sandbox container stopped while the operation was pending\.?$/i,
  /^The sandbox was destroyed while the operation was pending\.?$/i,
];

/** The typed errors that MEAN the container's runtime went away under the
 *  call, across the 0.12 and 0.13 lines. Matched by name, not `instanceof`:
 *  the fetch handler sees them after the Durable Object RPC boundary, which
 *  keeps `name`/`message` and drops the prototype (inside the Durable Object,
 *  `instanceof` holds and decides first). */
export const RECYCLE_ERROR_NAMES: readonly string[] = [
  "SessionTerminatedError",
  "OperationInterruptedError",
  "StaleProcessHandleError",
  "RuntimeIdentityInactiveError",
];

/** Type first, text second: a typed recycle error, or a recycle-shaped text. */
export function isRecycleError(err: { name?: string; message?: string }): boolean {
  if (err.name && RECYCLE_ERROR_NAMES.includes(err.name)) return true;
  return !!err.message && RECYCLE_SHAPED.some((re) => re.test(err.message!.trim()));
}

/** Grace inside which a recycle-shaped TEXT is taken at face value: a session
 *  that fails to start does so in seconds, not minutes. A typed recycle error
 *  needs no grace — the SDK is stating the runtime went away. */
const RECYCLE_SUSPECT_AFTER_MS = 60_000;

/** The message `/exec` puts in-body when a command's failure looks like the
 *  container's runtime went away under it: a typed recycle error (`certain`),
 *  or a recycle-shaped text that arrived more than a minute into THIS attempt
 *  (a startup failure shows in seconds). Any other text, however late, is
 *  returned unchanged — timing alone never rewords an unrelated error. The
 *  exit code stays 127: it IS an infra failure and the command did not finish,
 *  so a faked exit 124 would tell the model to shorten a command that was
 *  never the problem. What the workspace holds afterwards depends on what
 *  went away: a replaced container has an empty `/workspace` (re-clone); a
 *  runtime the image's PID 1 started again (item 21) left it intact. The text
 *  says to look before assuming either. */
export function recycledMidCommandMessage(elapsedMs: number, msg: string, certain = false): string {
  const shaped = RECYCLE_SHAPED.some((re) => re.test(msg.trim()));
  if (!certain && (!shaped || elapsedMs <= RECYCLE_SUSPECT_AFTER_MS)) return msg;
  const secs = Math.round(elapsedMs / 1_000);
  return (
    `sandbox recycled mid-command after ${secs}s — the container's runtime was replaced or restarted under the command, which did not finish; ` +
    `check /workspace before continuing: it is empty if the container was replaced (re-clone), intact if only its runtime restarted (${msg})`
  );
}
