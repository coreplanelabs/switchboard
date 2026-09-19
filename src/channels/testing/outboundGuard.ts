// The suite-wide outbound guard (docs/reference/specs/slack-channel.md item
// 16): no text the Slack adapter sends may carry `<@slack:` — a pre-wrapped
// mention Slack cannot resolve — or a bare `slack:U…` id standing alone as a
// word. Slack tests construct their fake Web API clients through
// `guardOutbound`, so every payload of every method call (`chat.postMessage`,
// `chat.update`, `files.uploadV2`, …) is scanned — including a send site added
// tomorrow that bypasses `mdToMrkdwn`'s funnel (the status card renders through
// `escapeMrkdwn`; `SlackIO.offer` posts `escapeMrkdwn(renderOffer(…))`
// directly). A hit throws at the call AND is kept on a violations list that
// `installOutboundGuard`'s afterEach drains, so a best-effort send path that
// swallows the throw still fails the test.
import { afterEach } from "vitest";

/** The guard's pattern: `<@slack:` anywhere, or a bare `slack:U…` id not part
 *  of a longer token (`user:slack:U…` scope keys), not inside a code span
 *  (backtick), and not inside a URL's path or query (`=`, `/`, `?`, `#`, `&` —
 *  mirroring the renderer's own exclusions in `src/channels/mrkdwn.ts`, which
 *  deliberately leaves an id inside a bare URL untouched). */
export const RAW_ACTOR_ID = /<@slack:|(?<![\w:@`=/?#&])slack:U[A-Z0-9]+/;

const violations: string[] = [];

function scan(args: unknown[]): void {
  const s = JSON.stringify(args) ?? "";
  const hit = RAW_ACTOR_ID.exec(s);
  if (!hit) return;
  const from = Math.max(0, hit.index - 40);
  const line = `raw actor id in an outbound Slack payload: …${s.slice(from, hit.index + hit[0].length + 40)}…`;
  violations.push(line);
  throw new Error(`[outbound guard] ${line}`);
}

/** A function wrapped so each call's arguments are scanned before it runs.
 *  A Proxy with only an `apply` trap: property reads (`.mock`, vitest's mock
 *  markers) forward to the target, so assertions on the original vi.fn and on
 *  the wrapped reference both keep working. */
function guardFn(fn: object): object {
  return new Proxy(fn, {
    apply(target, thisArg, args: unknown[]) {
      scan(args);
      return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
    },
  });
}

function deepGuard(value: unknown): unknown {
  if (typeof value === "function") return guardFn(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepGuard(v);
    return out;
  }
  return value;
}

/** The wrapper the slack tests construct fake Web API clients through: every
 *  function found on the client (at any depth) scans its call's arguments for
 *  a raw actor id before forwarding. Shape-preserving; leaves non-objects and
 *  arrays alone. */
export function guardOutbound<T>(client: T): T {
  return deepGuard(client) as T;
}

/** Drains and returns the violations recorded so far — for the guard's own
 *  tests, which trip it on purpose. */
export function flushOutboundViolations(): string[] {
  return violations.splice(0);
}

/** Registers the file-level afterEach that fails a test whose swallowed guard
 *  throw would otherwise pass. Call once at the top of each test file that
 *  builds clients through `guardOutbound`. */
export function installOutboundGuard(): void {
  afterEach(() => {
    if (violations.length === 0) return;
    const lines = violations.splice(0);
    throw new Error(`[outbound guard] ${lines.length} violation(s):\n${lines.join("\n")}`);
  });
}
