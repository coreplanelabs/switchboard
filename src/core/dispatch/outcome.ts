// How a request ended, for whoever started it (docs/reference/specs/routing-and-config.md
// item 20): the same status the request's root records, plus — when a gate
// ended it — that gate's `dispatch.refuse` name (`agent_allowlist`,
// `profile_bounded`, `repo_not_onboarded`, …). A leaf on purpose: the spawn
// stage reads it to relay a child's refusal to its parent as a named tool
// result, and must not name the dispatcher to do so — a type import of
// `dispatcher.ts` would pull the whole pipeline into every program that types
// the stage (the dashboard's included). Every other caller may ignore it.

export interface DispatchOutcome {
  status: "completed" | "refused" | "failed" | "stopped";
  refusal?: string;
}
