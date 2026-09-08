// Shared fixtures for the run registry's tests: event builders and a registry
// with deterministic ids, tokens and clock, so every property is checkable
// exactly. Test-only; not re-exported by index.ts.

import type { RunEvent } from "../runEvents.js";
import { RunRegistry, type RunRegistryOptions } from "../runRegistry.js";

export const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });
export const result = (ok: boolean, summary: string): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary });
/** What `publish` hands back: the input event stamped with its per-run `seq`. */
export const seq = (n: number, e: RunEvent): RunEvent => ({ ...e, seq: n });
/** A span record (docs/reference/specs/tracing.md): the union gains the variant with the emitters. */
export const spanEnd = (name: string): RunEvent =>
  ({ type: "span_end", spanId: `s-${name}`, name, startedAt: 1, durationMs: 5, status: "ok" }) as unknown as RunEvent;

/** A registry with deterministic ids/tokens/clock for tests. */
export function testRegistry(over: Partial<RunRegistryOptions> = {}) {
  let n = 0;
  let clock = 1000;
  const reg = new RunRegistry({
    genId: () => `id-${++n}`,
    genToken: () => `tok-${n}`,
    now: () => clock,
    ...over,
  });
  return { reg, tick: (ms: number) => (clock += ms) };
}
