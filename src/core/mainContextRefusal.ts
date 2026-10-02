/** Closed, text-free capture outcomes shared by live notes and finished records. */
const checkpointFailures = [
  "detached",
  "finished",
  "unseeded",
  "session-missing",
  "session-broken",
  "cursor-missing",
  "state-unavailable",
  "state-permanent",
  "state-route-missing",
  "state-unknown",
  "state-fenced",
] as const;

export type SessionCheckpointFailure = (typeof checkpointFailures)[number];

export const MAIN_CONTEXT_REFUSAL_CODES = [
  "precondition_untracked",
  "precondition_capture_unavailable",
  ...checkpointFailures.map((failure) => `checkpoint_${failure}` as const),
  "checkpoint_unknown",
  "checkpoint_mismatch",
  "snapshot_failed",
  "dependencies_failed",
  "validation_failed",
  "capsule_invalid",
  "capture_unknown",
] as const;

export type MainContextRefusalCode = (typeof MAIN_CONTEXT_REFUSAL_CODES)[number];

export function isMainContextRefusalCode(value: unknown): value is MainContextRefusalCode {
  return typeof value === "string" && (MAIN_CONTEXT_REFUSAL_CODES as readonly string[]).includes(value);
}

/** Only closed, distinct refusal codes from an owned live row may enter a finished record. */
export function contextRefusalsOf(value: unknown): MainContextRefusalCode[] {
  if (!Array.isArray(value) || value.length > MAIN_CONTEXT_REFUSAL_CODES.length) return [];
  const result: MainContextRefusalCode[] = [];
  for (const code of value) {
    if (!isMainContextRefusalCode(code)) return [];
    if (!result.includes(code)) result.push(code);
  }
  return result;
}
