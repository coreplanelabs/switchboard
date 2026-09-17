// What a tool is to the loop that runs it — the native runner today, the pi
// harness's relay (`src/core/harness/pi/relay.ts`) for every tool pi does not
// run itself: the context a call runs with (`ToolContext`: the Executor seam
// and the capabilities the dispatcher binds per run) and a definition with its
// `run` (`RunnableTool`). The definition itself (`ToolDef`) lives with the
// completion request in src/core/provider.ts, so the run ledger's Node-free
// contract records it without reaching in here. Tools are thin declarations
// over the Executor seam. Where
// the command actually runs (local host vs per-thread sandbox) is the
// Executor's concern — see src/execution/. Web tools are the exception: they do
// network I/O in the bot process via the injected `web` capability, not through
// the Executor, so a no-repo agent can use them with no workspace. Moved here
// from `src/tools/workspace.ts`, which keeps the native tool table until
// record 0032's series deletes it with the native loop.

import type { ChatMessage, ToolResultContent } from "../core/chatMessage.js";
import type { DigestReport } from "../core/diffDigest.js";
import type { WaitCapability } from "../core/dispatch/awaitChildren.js";
import type { SpawnCapability } from "../core/dispatch/spawn.js";
import type { PrDescription } from "../core/prDescription.js";
import type { ToolDef } from "../core/provider.js";
import type { AddressSeverity, FindingDisposition, ReviewVerdict } from "../core/reviewVerdict.js";
import type { RunEvent } from "../core/runEvents.js";
import type { Handoff } from "../core/ship/handoff.js";
import type { Span } from "../core/trace/types.js";
import type { Executor } from "../execution/executor.js";
import type { SkillStore } from "../skills/index.js";
import type { ArtifactsCapability, AttachCapability, UploadTicketCapability } from "./attach.js";
import type { GithubCapability } from "./github.js";
import type { RunsReadCapability, SteerCapability } from "./runs.js";
import type { SessionCapability } from "./session.js";
import type { WebCapability } from "./web.js";
import type { WorkItems } from "../core/workItems.js";

export interface ToolContext {
  /** Work tracking bound to this run's resolved actor by its channel. */
  workItems?: WorkItems;
  executor: Executor;
  /** The tool call's id (the provider's `tool_use` id; pi's `toolCallId`),
   *  the same id the call's `tool_call`/`tool_result` events carry: what a tool
   *  records about its own work (`attach_file`'s `artifact` event) names it,
   *  so the run page puts the record on this call's card by data (live-view.md
   *  item 26). Both loops set it for every call; absent only in unit tests. */
  callId?: string;
  /** The tool call's own span (docs/reference/specs/tracing.md): what a tool measures
   *  itself (an MCP round trip, an executor op) is a child of it. Absent (CLI,
   *  most unit tests) → the tool measures nothing. */
  span?: Span;
  /** Aborted on a hard run stop. Tools that run something cancellable
   *  (bash → `executor.exec`) pass it through; the runner stops waiting on the
   *  tool regardless, so a tool that ignores it degrades safely. */
  signal?: AbortSignal;
  /** Wall clock left in the run, on the runner's own clock. The bash tool
   *  clips a command's budget to it (minus the write-up reserve), so one
   *  command can never outlive the run. Absent → no clipping (a tool used
   *  outside a run). */
  remainingMs?: () => number;
  /** The run's conversation so far (the seed and every turn the model has
   *  seen, this step's assistant turn included), read at the call: the native
   *  runner's own array, or the pi harness's read of the run's session log
   *  (docs/reference/specs/agent-conductor.md item 3), which is why it may be
   *  a promise. `spawn_run` seeds a child from its text turns
   *  (docs/reference/specs/routing-and-config.md item 20). Absent (a tool used
   *  outside a run, a run without a session), or a read that answers nothing
   *  (a log the bot could not reach) → a child starts from its own thread's
   *  history. */
  conversation?: () => readonly ChatMessage[] | undefined | Promise<readonly ChatMessage[] | undefined>;
  /** Replace the user-facing progress checklist on the status card. */
  reportProgress?: (checklist: string) => void;
  /** The requesting thread's file upload behind `attach_file`
   *  (docs/reference/specs/agent-coding.md item 10): the channel's
   *  `attachFile`, bound by the dispatcher. Absent (a channel without uploads,
   *  a unit context) → the tool says the conversation takes no files. */
  attach?: AttachCapability;
  /** The artifact store as this run may use it (execution.md item 20, record
   *  0033): the store, the run's id for its keys, the per-run sequence, the
   *  run page's URL and the channel's `reply` for the store-only lead. Bound by
   *  the dispatcher when `artifacts:` is configured; absent → `attach_file`
   *  takes the inline path through `readBytes`, exactly as before the store. */
  artifacts?: ArtifactsCapability;
  /** The channel's one-shot upload ticket (`ChannelIO.uploadTicket`), bound by
   *  the dispatcher when the channel has one. With a store and no ticket, the
   *  tool keeps the file on the run page and posts its link. */
  uploadTicket?: UploadTicketCapability;
  /** Web fetch + search capability. Injected by the dispatcher;
   *  absent → web tools report themselves unavailable. */
  web?: WebCapability;
  /** Skill store backing list_skills/use_skill. Injected by the
   *  dispatcher; absent → the skill tools report themselves unavailable. */
  skills?: SkillStore;
  /** GitHub capability behind the `github_*` tools (docs/reference/specs/github-tools.md):
   *  the REST client on the bot's App credential plus the requesting user's
   *  per-repo write gate. Injected by the dispatcher; absent → the tools
   *  report themselves unavailable. */
  github?: GithubCapability;
  /** The calling agent's name — scopes list_skills/use_skill so an agent only
   *  sees and loads skills declared for it. */
  agentName?: string;
  /** The run's spawn capability behind `spawn_run` (docs/reference/specs/agent-conductor.md
   *  item 3): built by the dispatcher once the run is registered — the run's id
   *  and depth fixed, the remaining wall clock read at every call. Absent
   *  (a unit context, a round outside `dispatch()`) → the null capability,
   *  which refuses honestly. */
  spawn?: SpawnCapability;
  /** The reads behind `list_runs` / `get_run_status`: the runs service and the
   *  REQUESTER's actor, so a run sees exactly what the person who asked may
   *  see. Absent → the tools report themselves unavailable. */
  runs?: RunsReadCapability;
  /** The run's reach into its own session log (docs/reference/specs/session-log.md
   *  item 10): what `recall` searches and reads and `notes` writes. Built by
   *  the dispatcher for a run with a session; absent, the tools say so. */
  session?: SessionCapability;
  /** The steer behind `send_to_run` (docs/reference/specs/agent-conductor.md
   *  item 8): into a live child's inbox as the requester, through the path a
   *  thread reply takes. Built by the dispatcher beside `runs`; absent → the
   *  tool reports itself unavailable. */
  steer?: SteerCapability;
  /** What `await_runs` watches while it waits (agent-conductor item 8): this
   *  run's own stop control and inbox, the registry's end frames, the clock
   *  and sleep the wait is paced by. Built by the dispatcher; absent → the
   *  tool reports itself unavailable. */
  wait?: WaitCapability;
  /** Publish a typed event into the run's visibility stream (the same stream
   *  the runner's `tool_call`/`tool_result` go to). For facts a tool knows
   *  that the runner cannot see — which skill was loaded, later which artifact
   *  was produced. Wired by the runner to its `onEvent`; absent (CLI, most
   *  unit tests) → the tool simply does not publish. */
  publish?: (event: RunEvent) => void;
  /** Receives the review agent's structured verdict from `submit_verdict`.
   *  Injected by the dispatcher for review runs; the last call wins. The
   *  dispatcher turns it into the deterministic first line of the GitHub post
   *  (src/core/reviewVerdict.ts). Absent → the tool still accepts the call. */
  onVerdict?: (verdict: ReviewVerdict) => void;
  /** The severity to address in force for this run (docs/reference/specs/agent-review.md
   *  item 5a), resolved by the dispatcher — directive > user > channel > org —
   *  and handed to `submit_verdict`'s parser, which downgrades an approve
   *  carrying a finding at or above it. Absent (CLI, unit tests) → the
   *  parser's default, `minor`. */
  addressSeverity?: AddressSeverity;
  /** Receives the diff digest's totals (or the reason it has none) from
   *  `diff_digest`, once per call — the last call wins. Injected by the
   *  dispatcher for review runs; the post-step holds the totals against the
   *  PR's own size and refuses to post a verdict whose digest covered less
   *  (docs/reference/specs/agent-review.md item 15). Absent → the tool still answers. */
  onDigest?: (report: DigestReport) => void;
  /** Receives the coding agent's typed PR description from
   *  `submit_pr_description` (docs/reference/specs/pr-description.md). Injected by the
   *  dispatcher for coding runs; the last valid call wins. The dispatcher
   *  renders the GitHub body from it at the pushed head and opens/edits the
   *  PR. Absent → the tool still accepts the call. */
  onPrDescription?: (desc: PrDescription) => void;
  /** Receives a coding child's typed handoff from `submit_handoff`
   *  (docs/reference/specs/agent-coding.md item 9): where it departed from its plan
   *  unit, what it found and did not do, what it could not prove. Injected by
   *  the dispatcher and the ship coding round; the last valid call wins. The
   *  run record carries it; a ship round posts it to the unit's board issue.
   *  Absent → the tool says nothing is recording it. */
  onHandoff?: (handoff: Handoff) => void;
  /** Receives a coding run's per-finding dispositions from
   *  `submit_dispositions` (docs/reference/specs/agent-ship.md item 6). Injected by
   *  the run loop for every run; the last valid call wins and the set rides the
   *  run record, where the plan runner matches it to its round's findings.
   *  Absent → the tool still accepts the call. */
  onDispositions?: (dispositions: FindingDisposition[]) => void;
}

export interface RunnableTool extends ToolDef {
  /** Text for most tools; a parts list when the result should reach the model
   *  as something it can see (image/PDF) — see `ToolResultContent`. */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultContent>;
  /** True for a tool that only READS (workspace files, the web, skills): when
   *  one assistant turn asks for several of these, the runner executes them
   *  concurrently — on a resident/sandbox each is a network round trip, and
   *  they cannot observe each other. Anything that mutates the workspace
   *  (`bash`, `write_file`) or the run's own state (`update_status`,
   *  `submit_verdict`, `submit_pr_description`, `submit_handoff`,
   *  `submit_dispositions`) leaves this unset and runs strictly in order. */
  sideEffectFree?: true;
  /** True for a tool that reports its own failure to the model as a text
   *  opening `error:` instead of throwing (`attach_file`, the `submit_*`
   *  tools, the run tools): the record marks such a result `ok:false`
   *  (`toolTextFailed`, run-visibility.md item 5). A tool that relays content
   *  it did not write (`read_file`, `web_fetch`, `use_skill`) leaves this
   *  unset — a file whose first line happens to say `error:` was still read. */
  failsInText?: true;
}
