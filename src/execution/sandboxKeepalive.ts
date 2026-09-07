// Sandbox activity keepalive (features/execution.md item 2): one in-flight
// exec never outlives the container's activity timeout.
//
// The @cloudflare/containers base class keeps an activity clock: every
// proxied fetch renews it ONCE, before the fetch, and an alarm loop stops the
// container (SIGTERM) the moment the clock reads expired — with no notion of
// a request still in flight. So a single command running longer than
// `sleepAfter` had its container killed under it, deterministically, at
// exactly `sleepAfter` (2026-09-07, the #521 review's first command: 20:00 of
// a 20-minute budget, `Command execution failed`, a fresh container with an
// empty /workspace). The fix is to renew the clock on a timer WHILE a command
// runs, which turns `sleepAfter` into what its name says: idle time.
//
// Deliberately free of node: imports so wrangler can bundle it into the
// sandbox Worker.

/** How long an IDLE container stays warm before the Durable Object stops it,
 *  in the Container class's own `<n>[smh]` grammar. With the keepalive below,
 *  this is pure idle time — a running command can never reach it. 5 minutes
 *  frees a finished thread's slot (`max_instances`) four times sooner than
 *  the SDK's 20-minute default, while a follow-up inside 5 minutes still
 *  lands on the same warm workspace; a later one re-clones, which is the
 *  documented per-thread degradation (item 1). */
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
 *  command: the exec handler's generic wrapper (its real cause, "Session
 *  terminated", sits in a field the client discards), the cause itself when a
 *  client does surface it, and the stale-session answer the same attempt gets
 *  once the sessions are cleared. Anything else — a transport error, a file-op
 *  failure — is never recycle-shaped, whenever it arrives. */
const RECYCLE_SHAPED: readonly RegExp[] = [
  /^Command execution failed$/,
  /^Session terminated$/i,
  /^Session '[^']*' not found$/i,
];

/** Grace inside which a recycle-shaped failure is taken at face value: a
 *  session that fails to start does so in seconds, not minutes. */
const RECYCLE_SUSPECT_AFTER_MS = 60_000;

/** The message `/exec` puts in-body when a command's failure looks like the
 *  container was recycled under it: a recycle-shaped failure that arrived more
 *  than a minute into THIS attempt (a startup failure shows in seconds). Any
 *  other text, however late, is returned unchanged — timing alone never
 *  rewords an unrelated error. The exit code stays 127: it IS an infra failure
 *  — the workspace really is gone — and a faked exit 124 would tell the model
 *  to shorten a command that was never the problem. */
export function recycledMidCommandMessage(elapsedMs: number, msg: string): string {
  const shaped = RECYCLE_SHAPED.some((re) => re.test(msg.trim()));
  if (!shaped || elapsedMs <= RECYCLE_SUSPECT_AFTER_MS) return msg;
  const secs = Math.round(elapsedMs / 1_000);
  return (
    `sandbox recycled mid-command after ${secs}s — the container was replaced and /workspace is empty; ` +
    `re-clone before continuing (${msg})`
  );
}
