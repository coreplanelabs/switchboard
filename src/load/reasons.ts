// A refusal's machine token, recovered from the error a client threw. The
// resident and sandbox clients fold the Worker's `reason` into their error
// messages (`resident attach failed for repo:x: user-pool-exhausted: …`), and
// the harness counts refusals by that token, never by message text.

const KNOWN_REASONS = [
  "mirror-busy",
  "user-pool-exhausted",
  "disk-pressure",
  "fleet-busy",
  "runtime-replaced",
  "not-onboarded",
  "needs-ref",
  "not-attached",
] as const;

export type KnownReason = (typeof KNOWN_REASONS)[number] | "timeout" | "unknown";

export function reasonOf(err: unknown): KnownReason {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const r of KNOWN_REASONS) if (msg.includes(r)) return r;
  if (/sandbox fleet busy/i.test(msg)) return "fleet-busy";
  if (/is not onboarded/i.test(msg)) return "not-onboarded";
  if (/TimeoutError|timed out|timeout/i.test(msg)) return "timeout";
  return "unknown";
}

/** Time one operation into a Sample-shaped record; never throws. */
export async function timed<T>(
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<
  { ms: number; startedAt: number; ok: true; value: T } | { ms: number; startedAt: number; ok: false; error: Error }
> {
  const startedAt = now();
  try {
    const value = await fn();
    return { ms: now() - startedAt, startedAt, ok: true, value };
  } catch (err) {
    return { ms: now() - startedAt, startedAt, ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
