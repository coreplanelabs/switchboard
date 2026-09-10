/** Which spans reach a run's stream, and how the partition counts each one
 *  (docs/reference/specs/tracing.md). Everything not named here is log-only by default.
 *
 *  Three classes:
 *  - counted: the span's interval claims one of the four buckets;
 *  - uncounted: structure only — its own time, minus its counted children, is
 *    Switchboard overhead by design;
 *  - background: concurrent, non-blocking work the claim pass ignores entirely.
 *
 *  Invariant (tested): every ancestor of a counted span that belongs to a
 *  different bucket is uncounted, so the deepest counted node can always claim
 *  an instant without a bucket fight. */

export type Bucket = "getting_ready" | "thinking" | "tools" | "finishing_up";
export type SpanClass = { kind: "counted"; bucket: Bucket } | { kind: "uncounted" } | { kind: "background" };

/** Who owns the run: an agent run (the default) or a deterministic command run,
 *  which changes where `run.command` and its grafts count. */
export type RunOwner = "agent" | "command";

/** The enumerated streamed names. Prefix families (`tool.`, `mcp.`, the two
 *  graft prefixes) are matched separately. */
export const STREAMED_SPANS = [
  "request",
  "slack.receive",
  "dispatch.history",
  "dispatch.admission",
  "dispatch.ack_card",
  "dispatch.gate.repo",
  "dispatch.gate.pr_head",
  "dispatch.workspace.attach",
  "dispatch.gate.attached_head",
  "dispatch.mcp_discovery",
  "dispatch.compose",
  "dispatch.channel_visibility",
  "dispatch.repo_context",
  "dispatch.memory_read",
  "dispatch.refuse",
  "dispatch.ship_preflight",
  "dispatch.ledger_claim",
  "run.agent",
  "run.command",
  "run.reading_diff",
  "run.reading_diff.upgrade",
  "run.settle_reviewed_head",
  "run.description_turn",
  "run.observe_workspace",
  "run.pr_post_step",
  "run.reading_diff_join",
  "run.pr_description_join",
  "model.turn",
  "ship.round",
  "post.card_close",
  "post.reply",
] as const;

export type StreamedSpanName = (typeof STREAMED_SPANS)[number];

/** Streamed prefix families and the bucket each counts toward. `run.command.`
 *  (the op-route grafts) follows `run.command`'s owner-dependent bucket. */
export const STREAMED_PREFIXES = {
  "tool.": "tools",
  "mcp.": "tools",
  "dispatch.workspace.attach.": "getting_ready",
  "run.command.": "owner",
} as const satisfies Record<string, Bucket | "owner">;

const STREAMED_SET: ReadonlySet<string> = new Set(STREAMED_SPANS);

export function isStreamed(name: string): boolean {
  if (STREAMED_SET.has(name)) return true;
  return Object.keys(STREAMED_PREFIXES).some((p) => name.startsWith(p));
}

const GETTING_READY: ReadonlySet<string> = new Set([
  "slack.receive",
  "dispatch.history",
  "dispatch.admission",
  "dispatch.ack_card",
  "dispatch.gate.repo",
  "dispatch.gate.pr_head",
  "dispatch.workspace.attach",
  "dispatch.gate.attached_head",
  "dispatch.mcp_discovery",
  "dispatch.compose",
  "dispatch.channel_visibility",
  "dispatch.repo_context",
  "dispatch.memory_read",
  "dispatch.refuse",
  "dispatch.ship_preflight",
  "dispatch.ledger_claim",
]);
const FINISHING_UP: ReadonlySet<string> = new Set([
  "run.observe_workspace",
  "run.pr_post_step",
  "run.reading_diff_join",
  "run.pr_description_join",
]);
const UNCOUNTED: ReadonlySet<string> = new Set([
  "request",
  "run.agent",
  "ship.round",
  "run.settle_reviewed_head",
  "run.description_turn",
  "post.card_close",
  "post.reply",
]);
const BACKGROUND: ReadonlySet<string> = new Set(["run.reading_diff", "run.reading_diff.upgrade"]);

/** The class of a streamed name under `owner`. A name that is not streamed has
 *  no class (log-only spans never reach the partition). */
export function classOf(name: string, owner: RunOwner): SpanClass | undefined {
  if (BACKGROUND.has(name)) return { kind: "background" };
  if (UNCOUNTED.has(name)) return { kind: "uncounted" };
  if (name === "model.turn") return { kind: "counted", bucket: "thinking" };
  if (name === "run.command" || name.startsWith("run.command.")) {
    return { kind: "counted", bucket: owner === "command" ? "tools" : "getting_ready" };
  }
  if (GETTING_READY.has(name) || name.startsWith("dispatch.workspace.attach."))
    return { kind: "counted", bucket: "getting_ready" };
  if (FINISHING_UP.has(name)) return { kind: "counted", bucket: "finishing_up" };
  if (name.startsWith("tool.") || name.startsWith("mcp.")) return { kind: "counted", bucket: "tools" };
  return undefined;
}

/** The parents each streamed name may have (docs/reference/specs/tracing.md taxonomy) —
 *  what the ancestor invariant is checked against. Prefix families are keyed by
 *  their prefix. */
export const PARENTS: Readonly<Record<string, readonly string[]>> = {
  request: [],
  "slack.receive": ["request"],
  "dispatch.history": ["request"],
  "dispatch.admission": ["request"],
  "dispatch.ack_card": ["request"],
  "dispatch.gate.repo": ["request"],
  "dispatch.gate.pr_head": ["request"],
  "dispatch.workspace.attach": ["request"],
  "dispatch.gate.attached_head": ["request"],
  "dispatch.mcp_discovery": ["request"],
  "dispatch.compose": ["request"],
  "dispatch.channel_visibility": ["request"],
  "dispatch.repo_context": ["request"],
  "dispatch.memory_read": ["request"],
  "dispatch.refuse": ["request"],
  "dispatch.ship_preflight": ["request"],
  "dispatch.ledger_claim": ["request"],
  "run.agent": ["request", "ship.round", "run.settle_reviewed_head", "run.description_turn"],
  "run.command": ["request"],
  "run.reading_diff": ["request"],
  "run.reading_diff.upgrade": ["request"],
  "run.settle_reviewed_head": ["request", "ship.round"],
  "run.description_turn": ["request", "ship.round"],
  "run.observe_workspace": ["request", "ship.round"],
  "run.pr_post_step": ["request", "ship.round"],
  "run.reading_diff_join": ["request", "ship.round"],
  "run.pr_description_join": ["request", "ship.round"],
  "model.turn": ["run.agent"],
  "ship.round": ["request"],
  "post.card_close": ["request"],
  "post.reply": ["request"],
  "tool.": ["run.agent"],
  "mcp.": ["tool."],
  "dispatch.workspace.attach.": ["dispatch.workspace.attach"],
  "run.command.": ["run.command"],
};
