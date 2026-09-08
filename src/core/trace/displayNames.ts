import { STREAMED_SPANS, type StreamedSpanName } from "./streamSpans.js";
import { residentStepLabel } from "../../execution/residentSteps.js";

// What a reader sees for a span (docs/reference/specs/tracing.md): one table over the
// enumerated streamed names — total by type, unique by test — plus one rule per
// prefix family. No user surface prints a raw span name; the card's setup label
// and the timeline's rows and ranked list all come through here.

/** The display name of every enumerated streamed span. */
export const DISPLAY_NAMES = {
  request: "the request",
  "slack.receive": "receiving",
  "dispatch.history": "reading the thread",
  "dispatch.admission": "checking the thread",
  "dispatch.ack_card": "posting the status card",
  "dispatch.gate.repo": "checking the repo",
  "dispatch.gate.pr_head": "checking the PR",
  "dispatch.workspace.attach": "attaching the workspace",
  "dispatch.gate.attached_head": "checking out the branch",
  "dispatch.mcp_discovery": "loading tools",
  "dispatch.compose": "preparing the prompt",
  "dispatch.channel_visibility": "checking the channel",
  "dispatch.repo_context": "reading the repo's context",
  "dispatch.memory_read": "recalling memory",
  "dispatch.refuse": "refusing",
  "dispatch.ship_preflight": "checking the ship request",
  "dispatch.ledger_claim": "claiming the run's row",
  "run.agent": "the agent loop",
  "run.command": "the command",
  "run.reading_diff": "reading the diff (in parallel)",
  "run.reading_diff.upgrade": "upgrading the diff (in parallel)",
  "run.settle_reviewed_head": "re-checking the moved branch",
  "run.description_turn": "asking for the PR description",
  "run.observe_workspace": "checking the workspace",
  "run.pr_post_step": "posting the PR",
  "run.reading_diff_join": "waiting for the diff",
  "model.turn": "a model turn",
  "ship.round": "a ship round",
  "post.card_close": "closing the card",
  "post.reply": "posting the reply",
} as const satisfies Record<StreamedSpanName, string>;

/** The fallback for a prefixed span whose leaf we cannot name. */
export const GENERIC_STEP_NAME = "a Switchboard step";

/** The display name for any span name: the table for an enumerated name; for a
 *  prefix family the tool's own name (`tool.bash` → `bash`), the MCP tool's own
 *  name (`mcp.<server>.<tool>` → `<tool>`), or the resident step's label, with
 *  `GENERIC_STEP_NAME` when a prefixed leaf is unknown or empty. A name that is
 *  neither enumerated nor prefixed is not streamed and also reads generic. */
export function displayNameOf(name: string): string {
  if (name in DISPLAY_NAMES) return DISPLAY_NAMES[name as StreamedSpanName];
  if (name.startsWith("tool.")) return name.slice("tool.".length) || GENERIC_STEP_NAME;
  if (name.startsWith("mcp.")) {
    const leaf = name.slice(name.lastIndexOf(".") + 1);
    return leaf && leaf !== "mcp" ? leaf : GENERIC_STEP_NAME;
  }
  for (const prefix of ["dispatch.workspace.attach.", "run.command."]) {
    if (name.startsWith(prefix)) return residentStepLabel(name.slice(prefix.length)) ?? GENERIC_STEP_NAME;
  }
  return GENERIC_STEP_NAME;
}

/** Every enumerated name, for the totality test. */
export const ENUMERATED_SPAN_NAMES: readonly StreamedSpanName[] = STREAMED_SPANS;
