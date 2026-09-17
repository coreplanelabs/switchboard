// Where a preset's harness word is set (docs/reference/specs/harness.md item
// 8), in a module with no imports of its own: the run record (`run_meta.harnessScope`)
// and the timeline fold read it, and both are compiled into the Workers' and
// the dashboard's programs, where the roster's neighbours — the harness
// objects, their Node-only process code — must not follow. The roster
// re-exports these names, so every reader inside the bot can still take them
// from there.

/** The scopes a word is set at, most specific first — the order the resolution
 *  walks the layers: the requester's own scope, the channel's, then the
 *  deployment's top-level `harness` block, which is the defaults layer under
 *  its one spelling. What `run_meta.harnessScope` and the config block name, so
 *  a reader of a run on OpenCode never guesses whose word put it there. */
export const HARNESS_SCOPES = ["user", "channel", "defaults"] as const;
export type HarnessScope = (typeof HARNESS_SCOPES)[number];

/** Whether a value is one of the scopes a word is set at: the timeline's test
 *  for the field a record carries. */
export function isHarnessScope(value: unknown): value is HarnessScope {
  return typeof value === "string" && (HARNESS_SCOPES as readonly string[]).includes(value);
}
