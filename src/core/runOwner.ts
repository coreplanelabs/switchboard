import type { RunOwner } from "./trace/streamSpans.js";

// Who owns a run's window (docs/reference/specs/tracing.md): the partition classes
// `run.command` and its resident grafts as the run's own tools when the run IS
// the command (a chat command's deterministic body, no model) and as setup
// when an agent run merely fell through one. The agent name a command run's
// `run_meta` carries is the discriminator every reader — the analyzer, the
// card, the web timeline — keys on, so it lives here, importable from the web
// without the dispatcher.

/** The agent name a command run's `run_meta` carries: no model, no prompt. */
export const COMMAND_RUN_AGENT = "command";

/** The partition owner a run's agent name implies. */
export function runOwnerOf(agent: string | null | undefined): RunOwner {
  return agent === COMMAND_RUN_AGENT ? "command" : "agent";
}
