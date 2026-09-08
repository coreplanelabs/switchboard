/** The one place resident-supplied text is made safe to show.
 *
 *  A resident's `reason`, `error` and `summary` strings are built from remote
 *  output (git, npm, the container's shell) and from other threads' identifiers
 *  (the disk-pressure refusal once listed them). They reach card titles, Slack
 *  replies, `repo list` and stored records, so every one of them crosses this
 *  module — on the resident at the write and the exit, and on the bot at the
 *  parse, permanently: a reason stored by an older resident survives that
 *  resident's deploy and its rollbacks.
 *
 *  Node-free and import-light so the resident Worker imports it by relative
 *  path exactly like the bot does. */
import { redactAndCap, stripAnsi } from "../core/redact.js";
import type { ResidentLifecycleState } from "./residentState.js";

/** Cap for one displayed resident string. Long enough for the longest reason
 *  the resident legitimately builds — the disk-pressure refusal with its math,
 *  eviction count and keep tokens (~230 chars), which item 55 shows whole — and
 *  for the runtime-replaced guidance (~120); short enough for a card note. */
export const RESIDENT_TEXT_CAP = 300;

/** Strip terminal control sequences, redact credential shapes, cap. The identity
 *  on the discriminator literals the bot compares (`runtime-replaced`,
 *  `op-refused…`, `disk-pressure:`), pinned by test. */
export function residentText(text: string): string {
  return redactAndCap(stripAnsi(text), RESIDENT_TEXT_CAP);
}

const SANITIZED_FIELDS = ["error", "reason", "summary"] as const;

/** How deep the sanitizer descends. The deepest resident shape today is
 *  `/residents` → `residents[]` → `live` → `reason` (depth 3); the bound exists
 *  so a hostile body cannot make the walk unbounded. */
const SANITIZE_DEPTH = 4;

/** A parsed resident body with its free-text fields made safe, at every level:
 *  `/residents` nests each resident's `state`/`reason` (or an `error`) under
 *  `residents[].live`, and `repo list` renders those. In each plain object only
 *  `error`, `reason` and `summary` are touched (when strings); `stderr` is
 *  rewritten only when it mirrors `error` (the thread routes' failure shape
 *  copies the error into stderr). Every other field — `needs`, `state`,
 *  `stdout`, `status`, bindings, numbers — passes through untouched. Arrays are
 *  walked; scalars pass through; the input is never mutated. */
export function sanitizeResidentBody<T>(data: T): T {
  return walk(data, SANITIZE_DEPTH) as T;
}

function walk(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object" || depth < 0) return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth - 1));
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(src)) {
    out[key] =
      (SANITIZED_FIELDS as readonly string[]).includes(key) && typeof v === "string"
        ? residentText(v)
        : walk(v, depth - 1);
  }
  if (typeof src.stderr === "string" && src.stderr === src.error && typeof out.error === "string") {
    out.stderr = out.error;
  }
  return out;
}

/** The states a probe may report: the resident's own lifecycle union plus the
 *  two the bot mints locally. Anything else — a future state, or free text from
 *  a hostile body — reads as `unknown`, which `isServiceable` refuses. */
export type ProbeState = ResidentLifecycleState | "not-onboarded" | "unknown";

const PROBE_STATES: ReadonlySet<string> = new Set<ProbeState>([
  "onboarding",
  "warm",
  "refreshing",
  "restoring",
  "degraded",
  "down",
  "not-onboarded",
  "unknown",
]);

export function residentState(value: unknown): ProbeState {
  return typeof value === "string" && PROBE_STATES.has(value) ? (value as ProbeState) : "unknown";
}
