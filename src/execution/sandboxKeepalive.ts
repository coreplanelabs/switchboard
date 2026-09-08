// Sandbox activity keepalive (features/execution.md item 2): one in-flight
// exec never outlives the container's activity timeout.
//
// On @cloudflare/containers 0.0.28 (production until 2026-09-07) the base
// class kept an activity clock that every proxied fetch renewed ONCE, before
// the fetch, and an alarm loop stopped the container (SIGTERM) the moment the
// clock read expired — with no notion of a request still in flight. So a
// single command running longer than `sleepAfter` had its container killed
// under it, deterministically, at exactly `sleepAfter` (2026-09-07, the #521
// review's first command: 20:00 of a 20-minute budget, `Command execution
// failed`, a fresh container with an empty /workspace). Renewing the clock on
// a timer WHILE a command runs turned `sleepAfter` into what its name says:
// idle time. The 0.3.x containers class that ships with sandbox 0.12.x counts
// in-flight requests itself and refuses to expire while one is open, so the
// keepalive is now belt-and-braces; it stays until the live long-command
// receipt on the tracker (#228) proves the SDK's own tracking on our path.
//
// Deliberately free of node: imports so wrangler can bundle it into the
// sandbox Worker.

/** How long an IDLE container stays warm before the Durable Object stops it,
 *  in the Container class's own `<n>[smh]` grammar. With the keepalive below
 *  (and the SDK's own in-flight tracking) this is pure idle time — a running
 *  command can never reach it. 5 minutes frees a finished thread's slot
 *  (`max_instances`) sooner than the SDK default (20 min on 0.3.x, 10 min on
 *  0.12.x), while a follow-up inside 5 minutes still lands on the same warm
 *  workspace; a later one re-clones, which is the documented per-thread
 *  degradation (item 1). */
export const SANDBOX_SLEEP_AFTER = "5m";

/** How often a running command renews the activity clock. Well inside
 *  SANDBOX_SLEEP_AFTER (the unit tests hold the ordering), so between two
 *  renewals the clock always has minutes to spare. */
export const EXEC_KEEPALIVE_INTERVAL_MS = 60_000;

/** The Container class's `sleepAfter` grammar (`"5m"`, `"90s"`, `"1h"`), in
 *  milliseconds — so a test can compare the interval against it. */
export function parseSleepAfterMs(expr: string): number {
  const m = /^(\d+)([smh])$/.exec(expr);
  if (!m) throw new Error(`invalid sleepAfter expression: "${expr}" (expected <n>s, <n>m or <n>h)`);
  const n = Number(m[1]);
  return n * (m[2] === "s" ? 1_000 : m[2] === "m" ? 60_000 : 3_600_000);
}

/** Run `run()` while calling `renew()` every `intervalMs` until it settles —
 *  resolve or reject alike. A renew that throws or rejects is swallowed: the
 *  keepalive exists to protect the command's result, never to replace it. A
 *  command that finishes inside one interval never triggers a renew. */
export async function withActivityKeepalive<T>(
  renew: () => void | Promise<void>,
  run: () => Promise<T>,
  intervalMs: number,
): Promise<T> {
  const timer = setInterval(() => {
    try {
      void Promise.resolve(renew()).catch(() => {});
    } catch {
      // a synchronous throw from renew — same policy as an async rejection
    }
  }, intervalMs);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

/** The texts the SDK produces when the container is torn down under a
 *  command, across generations. 0.3.x: the exec handler's generic wrapper (its
 *  real cause, "Session terminated", sat in a field the client discarded), the
 *  cause itself, and the stale-session answer the same attempt got once the
 *  sessions were cleared. 0.12.x: the typed `SessionTerminatedError` text
 *  (`Session '<id>' shell exited (exit code: <n>)`) and the
 *  `OperationInterruptedError` text for a container that stopped under a
 *  pending call, and the disconnect text for a sandbox `destroy()`ed under a
 *  pending call — which the Worker's own one-shot heal of a legacy-image
 *  container can cause for a command concurrently pending on the same
 *  Durable Object (#569). Anything else — a transport error, a file-op
 *  failure — is never recycle-shaped, whenever it arrives. */
const RECYCLE_SHAPED: readonly RegExp[] = [
  /^Command execution failed$/,
  /^Session terminated$/i,
  /^Session '[^']*' not found$/i,
  /^Session '[^']*' shell exited \(exit code: /i,
  /^The sandbox container stopped while the operation was pending\.?$/i,
  /^The sandbox was destroyed while the operation was pending\.?$/i,
];

/** The 0.12.x typed errors that MEAN the container went away under the call.
 *  Matched by name, not `instanceof`: the Worker sees them after the Durable
 *  Object RPC boundary, which keeps `name`/`message` and drops the prototype. */
export const RECYCLE_ERROR_NAMES: readonly string[] = ["SessionTerminatedError", "OperationInterruptedError"];

/** Type first, text second: a typed recycle error, or a recycle-shaped text. */
export function isRecycleError(err: { name?: string; message?: string }): boolean {
  if (err.name && RECYCLE_ERROR_NAMES.includes(err.name)) return true;
  return !!err.message && RECYCLE_SHAPED.some((re) => re.test(err.message!.trim()));
}

/** Grace inside which a recycle-shaped TEXT is taken at face value: a session
 *  that fails to start does so in seconds, not minutes. A typed recycle error
 *  needs no grace — the SDK is stating the container stopped. */
const RECYCLE_SUSPECT_AFTER_MS = 60_000;

/** The message `/exec` puts in-body when a command's failure looks like the
 *  container was recycled under it: a typed recycle error (`certain`), or a
 *  recycle-shaped text that arrived more than a minute into THIS attempt (a
 *  startup failure shows in seconds). Any other text, however late, is
 *  returned unchanged — timing alone never rewords an unrelated error. The exit
 *  code stays 127: it IS an infra failure — the workspace really is gone — and
 *  a faked exit 124 would tell the model to shorten a command that was never
 *  the problem. */
export function recycledMidCommandMessage(elapsedMs: number, msg: string, certain = false): string {
  const shaped = RECYCLE_SHAPED.some((re) => re.test(msg.trim()));
  if (!certain && (!shaped || elapsedMs <= RECYCLE_SUSPECT_AFTER_MS)) return msg;
  const secs = Math.round(elapsedMs / 1_000);
  return (
    `sandbox recycled mid-command after ${secs}s — the container was replaced and /workspace is empty; ` +
    `re-clone before continuing (${msg})`
  );
}
