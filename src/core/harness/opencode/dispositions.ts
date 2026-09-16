// Where each event kind OpenCode's server streams lands on the run's record —
// OpenCode's table for the contract's record clause (`Disposition`,
// docs/reference/specs/harness.md item 4): `mapped` (a RunEvent, a span or a
// progress note the bridge writes for it), `structure` (the run's own shape,
// already recorded by the harness — the step and execution boundaries, the
// session's own lifecycle, the server's global catalogues), `folded` (a
// partial the final record carries — every `*.delta`, the streamed boundaries,
// the tool's input as it arrives), `note` (a `run_note` — the asks, the
// retries, the failures), `impossible` (a kind this run's configuration turns
// off or never causes — the persistent shells and ptys, the reverts and
// forks, the agent and model switches; a `harness_error` if it arrives all the
// same). A kind the table does not name is a `harness_error` note naming it,
// so an OpenCode bump shows in the first run's record — the same rule pi's
// `PI_EVENT_DISPOSITION` follows.
//
// The catalogue is the pinned protocol's server manifest
// (`@opencode/schema`'s `EventManifest.ServerDefinitions`, plus the stream's
// own `server.connected`): the tailer subscribes to `GET /api/event`, which
// streams exactly those kinds, so the table covers each one and the test binds
// the two together. `rpc.<name>` events (the plugin RPC channel) carry no
// fixed type and are folded by prefix, not by a key here.

import type { Disposition } from "../contract.js";
import { openCodeToolWord } from "../pi/toolRules.js";

export { openCodeToolWord };

/** The plugin RPC channel's events (`rpc.<name>`): the relay's own traffic, folded into the record it produces. */
export const OPENCODE_RPC_EVENT_PREFIX = "rpc.";

/** Where every event kind the server streams lands (the record clause's table).
 *  Keyed by the exact `type` the event carries; `server.connected` (the
 *  stream's first record, not in the durable manifest) is here too. */
export const OPENCODE_EVENT_DISPOSITION: Readonly<Record<string, Disposition>> = {
  // The stream's own marker.
  "server.connected": "structure",

  // ── Session: the assistant's turn as the record speaks it ────────────────
  // The tool call and its result, in pi's tool words (the per-call mirror).
  "session.tool.called": "mapped",
  "session.tool.success": "mapped",
  "session.tool.failed": "mapped",
  // The model's prose as it lands: the narration beside a call (the `assistant`
  // event) or, for a text-only turn, the answer.
  "session.text.ended": "mapped",
  // The context OpenCode compacted, with the summary it wrote (the compaction row).
  "session.compaction.ended": "mapped",

  // ── Session: partial output the final record carries (folded) ────────────
  "session.text.delta": "folded",
  "session.reasoning.delta": "folded",
  "session.compaction.delta": "folded",
  "session.step.streamed": "folded",
  "session.tool.progress": "folded",
  "session.tool.input.started": "folded",
  "session.tool.input.delta": "folded",
  "session.tool.input.ended": "folded",

  // ── Session: the notes (a `run_note`) ────────────────────────────────────
  // The gate's ask and its answer; the bridge acts on these, and on the record
  // they are the `tool_refused` note a refusal writes (never a second line).
  "permission.asked": "note",
  "permission.replied": "note",
  "session.retry.scheduled": "note",
  "session.compaction.failed": "note",
  "session.execution.failed": "note",
  "session.step.failed": "note",

  // ── Session: the run's own shape, already recorded (structure) ───────────
  // A narration's start writes nothing (its end does); the reasoning is
  // dropped whole, as pi's mirror drops thinking blocks — the record carries
  // what the model said and was told, never its private replay material.
  "session.text.started": "structure",
  "session.reasoning.started": "structure",
  "session.reasoning.ended": "structure",
  "session.step.started": "structure",
  "session.step.ended": "structure",
  "session.usage.updated": "structure",
  "session.compaction.started": "structure",
  "session.created": "structure",
  "session.execution.started": "structure",
  "session.execution.succeeded": "structure",
  "session.execution.interrupted": "structure",
  "session.idle": "structure",
  "session.status": "structure",
  "session.inbox.delivered": "structure",
  "session.inbox.enqueued": "structure",
  "session.inbox.cancelled": "structure",
  "session.inbox.delivery.changed": "structure",
  "session.instructions.updated": "structure",
  "session.permissions.updated": "structure",
  "session.synthetic": "structure",
  "session.viewed": "structure",

  // ── Session: the kinds this run never causes (impossible) ────────────────
  // The custom agent is the one agent and the proxy the one model, chosen at
  // create; a switch mid-run would be someone else driving the session.
  "session.agent.selected": "impossible",
  "session.model.selected": "impossible",
  // The session is never moved, forked, renamed or deleted under the run.
  "session.moved": "impossible",
  "session.forked": "impossible",
  "session.renamed": "impossible",
  "session.deleted": "impossible",
  // The checkout is Switchboard's; OpenCode never reverts it (`snapshots: false`).
  "session.revert.staged": "impossible",
  "session.revert.cleared": "impossible",
  "session.revert.committed": "impossible",
  // The persistent shell and the skill activation are features this config leaves off.
  "session.shell.started": "impossible",
  "session.shell.ended": "impossible",
  "session.skill.activated": "impossible",

  // ── The server's global catalogues and status (structure) ────────────────
  "agent.updated": "structure",
  "catalog.updated": "structure",
  "command.updated": "structure",
  "config.updated": "structure",
  "filesystem.changed": "structure",
  "integration.updated": "structure",
  "mcp.resources.changed": "structure",
  "mcp.status.changed": "structure",
  "plugin.updated": "structure",
  "project.updated": "structure",
  "reference.updated": "structure",
  "skill.updated": "structure",
  "vcs.branch.updated": "structure",
  "worktree.resolved": "structure",
  "worktree.updated": "structure",

  // ── The server's features this run turns off (impossible) ────────────────
  "credential.switched": "impossible",
  "credential.updated": "impossible",
  "form.created": "impossible",
  "form.cancelled": "impossible",
  "form.replied": "impossible",
  "installation.update-available": "impossible",
  "installation.updated": "impossible",
  "models-dev.refreshed": "impossible",
  "persistent-pty.added": "impossible",
  "persistent-pty.removed": "impossible",
  "pty.created": "impossible",
  "pty.deleted": "impossible",
  "pty.exited": "impossible",
  "pty.updated": "impossible",
  "shell.created": "impossible",
  "shell.deleted": "impossible",
  "shell.exited": "impossible",
  "tui.command.execute": "impossible",
  "tui.prompt.append": "impossible",
  "tui.session.select": "impossible",
  "tui.toast.show": "impossible",
  "websearch.updated": "impossible",
};

/** Where one event kind lands, or `undefined` for a kind the table does not
 *  name (a `harness_error` naming it). An `rpc.<name>` event is folded by
 *  prefix — the plugin RPC channel carries no fixed type. */
export function openCodeDispositionOf(type: string): Disposition | undefined {
  if (type.startsWith(OPENCODE_RPC_EVENT_PREFIX)) return "folded";
  return OPENCODE_EVENT_DISPOSITION[type];
}

/** The count of event kinds in each disposition class — the record clause's
 *  table at a glance, for the PR body and a bump's diff. */
export function openCodeDispositionCounts(): Record<Disposition, number> {
  const counts: Record<Disposition, number> = { mapped: 0, structure: 0, folded: 0, impossible: 0, note: 0 };
  for (const disposition of Object.values(OPENCODE_EVENT_DISPOSITION)) counts[disposition]++;
  return counts;
}
