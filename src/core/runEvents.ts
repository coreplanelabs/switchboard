import type { CompletionResult, TokenUsage } from "../providers/types.js";
// Types only, and from the zod-free module deliberately: this file is part of
// the node-free contract the memory Worker and web app compile with their own
// tsconfigs — importing prDescription.ts would drag zod into those graphs.
import type { PrDescription } from "./prDescriptionTypes.js";

// Run visibility (Area 2 / R12): a typed stream of what an agent is doing —
// tool calls and their (redacted, summarized) results — emitted by the runner.
// Today the in-channel status card consumes it live; the external live-view
// page (a follow-up) will consume the same stream. Keeping it a small typed
// seam here means neither consumer reaches into the runner's internals.

//
// Timing + lifecycle (Area 7b / #84): every event carries an optional `at`
// (epoch ms, stamped by the runner's injectable clock) so the run-friction
// analyzer (`runFriction.ts`) can attribute delay; a `tool_result` marks exec-
// INFRASTRUCTURE failures (`infra: true`, an `ExecInfraError` — the sandbox, not
// the command) so they are never confused with an ordinary nonzero exit; and
// `run_note` events carry the runner's lifecycle notices (wrap-up warning, budget
// exhaustion, dead sandbox) as typed kinds instead of only free-text progress.
// All additive: consumers that only know tool_call/tool_result keep working.

/** Typed lifecycle notices the runner emits alongside its `onProgress` text.
 *  `stop_requested` is published by the registry when an operator asks the run
 *  to stop from /runs (#101); `stopped` by the runner when it honors it. */
export type RunNoteKind =
  | "wrap_up"
  | "time_budget_exhausted"
  | "turn_budget_exhausted"
  | "sandbox_dead"
  /** The sandbox fleet had no free instance for this thread within the
   *  executor's bounded wait (features/execution.md item 14). Capacity, not a
   *  dead sandbox: the run goes on and the model is told to retry or finish. */
  | "fleet_busy"
  | "stop_requested"
  | "stopped"
  /** The PR head moved while a review ran and the same run is re-reviewing at
   *  the new head (agent-review.md item 12). Published by the dispatcher. */
  | "head_moved"
  /** An MCP server configured for this agent did not answer discovery
   *  (features/mcp-tools.md item 8); the run proceeds without its tools. One
   *  note per server, published by the dispatcher before the first turn. */
  | "mcp_unavailable"
  /** A thread follow-up steered into this run was folded into its next step
   *  (features/thread-admission.md item 2). Published by the runner as it
   *  drains the inbox, beside an `input` event carrying the follow-up itself. */
  | "follow_up";

/** How an operator asked a run to stop (#101): `soft` — take no new steps and
 *  wrap up through the normal finale; `hard` — abort the in-flight call now, no
 *  finale, tear the workspace down. */
export type StopMode = "soft" | "hard";

/** Who asked a run to stop (#157 R9): the caller's surface and its platform-
 *  namespaced identity (`slack:U…`, `access:<sub>`, `mcp:<subject>`,
 *  `cli:local`). Recorded on the `stop_requested` note so the stream itself says
 *  who stopped the run; `id` is charset-restricted to `ACTOR_ID_PATTERN` and
 *  capped by `sanitizeActor` before it is published. Absent on notes published
 *  through the token-gated HTML path (the capability, not a person, is the actor). */
export interface RunActor {
  kind: "access" | "mcp" | "cli" | "chat";
  id: string;
}

/** The character class an `actor.id` may carry (regex body, no brackets) — the
 *  ONE source both the validating pattern and the sanitizer are built from. */
const ACTOR_ID_CHARS = "A-Za-z0-9:@._-";
const ACTOR_ID_MAX = 128;
/** The characters an `actor.id` may carry; anything else is dropped. */
export const ACTOR_ID_PATTERN = new RegExp(`^[${ACTOR_ID_CHARS}]{1,${ACTOR_ID_MAX}}$`);
const ACTOR_ID_FORBIDDEN = new RegExp(`[^${ACTOR_ID_CHARS}]`, "g");

/** Coerce an actor into the published shape: strip every character outside the
 *  allowed set, cap at 128, and fall back to `unknown` when nothing survives —
 *  a hostile id is neutered, never a reason to refuse the stop. */
export function sanitizeActor(actor: RunActor): RunActor {
  const id = actor.id.replace(ACTOR_ID_FORBIDDEN, "").slice(0, ACTOR_ID_MAX);
  return { kind: actor.kind, id: id.length > 0 ? id : "unknown" };
}

/** How one `agent:ship` round boundary reads (features/agent-ship.md item 12).
 *  `started` marks the round's child being dispatched; the rest settle it:
 *  `pr_opened` — a coding round's post-step opened or edited the PR;
 *  `completed` — a fix round finished without a PR write (e.g. it declined
 *  everything and never resubmitted the description); `approve` /
 *  `request_changes` — a review round's verdict; `no_verdict` — the review
 *  child ended without `submit_verdict`, aborting the pipeline; `aborted` — the
 *  round ended the pipeline (a refusal, no resident worktree, a round-0
 *  terminal); `stopped` — an operator stop settled the round. A cap never
 *  settles a round: caps end the pipeline BETWEEN rounds, visible as the
 *  absence of a next `started` boundary plus the answer's cap report. */
export type ShipRoundOutcome =
  "started" | "pr_opened" | "completed" | "approve" | "request_changes" | "no_verdict" | "aborted" | "stopped";

/**
 * One event in a run's stream. `seq` is stamped by `RunRegistry.publish` — a
 * monotonic, per-run 1-based position (optional on the way in, present on every
 * event read back from the registry) so replays and history pages can resume
 * from a point without comparing payloads.
 */
export type RunEvent =
  /** `callId` is the provider's tool_use id — the explicit pair key between a
   *  call and its result (live-view item 13); absent only on legacy captures. */
  /** `command` rides on bash calls only: the FULL command (redacted, capped at
   *  `COMMAND_CAP`, far above the 200-char `summary`), for consumers that must
   *  judge what the command did — the pushed-branch tracker
   *  (features/pr-description.md item 5) reads it, because an agent's chained
   *  `git add … && git commit … && git push …` routinely carries its `push`
   *  past the summary cap. The status card and friction analyzer keep reading
   *  `summary`. */
  | { type: "tool_call"; tool: string; summary: string; command?: string; callId?: string; seq?: number; at?: number }
  /** `ok` is "the tool succeeded": false when it threw AND (bash) when the
   *  command exited nonzero. `exitCode` rides on bash results (parsed from the
   *  executors' shared `exit N:` prefix, 0 for a clean run; absent when the code
   *  was not numeric). `output` is the tool's text — control-stripped, redacted,
   *  capped at TOOL_OUTPUT_CAP — for the run page's expandable card; the status
   *  card and the friction analyzer keep reading `summary`. */
  | {
      type: "tool_result";
      tool: string;
      ok: boolean;
      summary: string;
      callId?: string;
      exitCode?: number;
      output?: string;
      infra?: true;
      seq?: number;
      at?: number;
    }
  /** `mode` rides only on the stop notes (`stop_requested` / `stopped`); `actor`
   *  only on a `stop_requested` published through `RunsService.stopRun`. */
  | {
      type: "run_note";
      kind: RunNoteKind;
      summary: string;
      mode?: StopMode;
      actor?: RunActor;
      seq?: number;
      at?: number;
    }
  /** The run's final answer — the same text the channel reply/PR post is
   *  projected from, redacted like every event (NOT capped: the run record is
   *  the source of truth, the summaries are). Published by the dispatcher once
   *  per run, before `finish()` and before the reply goes out; absent when an
   *  AGENT run threw (the card shows ❌). An inline command run that throws
   *  still publishes one — the `⚠️ <error>` reply — so its record explains the
   *  `failed` status. `text` is the CANONICAL Markdown (features/llm-output.md
   *  item 5); `raw` is the model's own text, present only when normalization
   *  changed it (redacted too, dropped if it would blow the per-event budget). */
  | { type: "answer"; text: string; raw?: string; seq?: number; at?: number }
  /** The request as received (directives stripped, attachments noted as a
   *  one-line count suffix — never bytes or file bodies), redacted, uncapped. Published by the dispatcher once
   *  per run, right after the run is registered — the first event of the record,
   *  so the run page can lead with what was asked (features/live-view.md item 12). */
  | {
      type: "input";
      text: string;
      /** Where the request came from, for the Request block: the channel and
       *  user display names and a link back to the triggering message —
       *  whatever the adapter supplied (all optional). */
      source?: { url?: string; channel?: string; user?: string };
      seq?: number;
      at?: number;
    }
  /** One prior thread turn fed to the model (#157, KD1), prefixed with its role
   *  (`user: …` / `assistant: …`), humanized and redacted like `input`, with
   *  attachments as metadata lines. Published by the dispatcher right after
   *  `input`, bounded (newest 20 turns / 256 KiB) and gated by
   *  `runHistory.includeContext`. */
  | { type: "context"; text: string; seq?: number; at?: number }
  /** The model's prose BETWEEN tool calls — text content that rode alongside
   *  tool_use in one completion. Emitted by the runner, redacted, uncapped. The
   *  final text-only completion is NOT one of these (that is the `answer`). */
  | { type: "assistant"; text: string; seq?: number; at?: number }
  /** One model call, as the runner saw it (live-view item 15): emitted when the
   *  provider returns, BEFORE the `assistant`/`tool_call` events that call
   *  produced — so a reader sees "thought for 5m 04s" above what the thinking
   *  led to, the way Claude Code / ChatGPT / Cursor show it. `at` is when the
   *  call returned; `startedAt` + `durationMs` are from the runner's clock, so
   *  `at - startedAt === durationMs`. `usage` rides only when the provider
   *  reported token counts. Shape follows the OTel GenAI `chat` span (duration,
   *  stop reason, input/output tokens) so it exports without translation. */
  | {
      type: "turn";
      /** The `<provider>/<model>` that took this turn — the run's model today
       *  (a run is pinned to one at start), stamped per turn so the page can
       *  name a silent model and make a switch stand out if one ever happens. */
      model?: string;
      startedAt: number;
      durationMs: number;
      stopReason: CompletionResult["stopReason"];
      usage?: TokenUsage;
      seq?: number;
      at?: number;
    }
  /** What the run is about (live-view item 19): the resolved agent and model,
   *  and — for a repo run — the repo, ref, PR number and PR head as resolved
   *  BEFORE the first model turn (`RepoContext`). Published by the dispatcher
   *  right after `input`, once per run, so the run page can head its Request
   *  block with linked `owner/repo · ref · #PR · sha`. Additive: every
   *  consumer that only knows the other types keeps working. */
  | {
      type: "run_meta";
      agent: string;
      model: string;
      effort?: string;
      repo?: string;
      ref?: string;
      pr?: number;
      headSha?: string;
      seq?: number;
      at?: number;
    }
  /** A skill was loaded into the model's context (features/skills.md). Emitted
   *  by the `use_skill` tool on a successful load — alongside, not instead of,
   *  its `tool_call`/`tool_result` pair — so skill use is a first-class fact in
   *  the run data with its own metadata: which skill, for which agent, from
   *  where (`source`, the pinned upstream URL when vendored), and how much
   *  context it cost (`bodyBytes`). Additive: consumers that only know the
   *  other types keep working; the friction analyzer ignores it. */
  | {
      type: "skill_use";
      skill: string;
      description: string;
      agent: string;
      /** The pinned upstream file URL for a vendored skill (features/skills.md item 9). */
      source?: string;
      /** Structured vendoring provenance (`Skill.upstream`, recorded by skills:sync). */
      upstream?: { repo: string; commit: string };
      bodyBytes: number;
      seq?: number;
      at?: number;
    }
  /** One call to an external MCP server's tool (features/mcp-tools.md item
   *  10). Emitted by the bridge beside the runner's generic `tool_call`/
   *  `tool_result` pair so remote time is attributable per service: which
   *  server and remote tool, whether it succeeded (`ok` = not a transport
   *  error and not `isError`), how long, and how many result bytes. Never the
   *  arguments or the body — those ride the redacted `tool_result.output`
   *  like every tool's. Additive: unknown → ignored. */
  | {
      type: "mcp_tool_use";
      server: string;
      tool: string;
      ok: boolean;
      durationMs: number;
      bytes: number;
      seq?: number;
      at?: number;
    }
  /** A review run's reading diff (features/reading-diff.md): the change as a
   *  reviewer reads it. The baseline artifact is the full `git diff`
   *  (`poweredBy: "git"`, guaranteed on every PR review); with the meat
   *  provider a SECOND artifact may follow — meat.dev's abridged reading diff
   *  (`poweredBy: "meat"`, with its one-line `summary` and the abridging
   *  call's own token usage) — iff meat finishes within the review. Published
   *  by the dispatcher straight to the registry (like `input`/`run_meta`),
   *  produced concurrently with the review by the run's own executor; readers
   *  prefer the meat artifact when both exist. Additive: unknown → ignored. */
  | {
      type: "review_artifact";
      artifact: "reading_diff";
      poweredBy: "git" | "meat";
      baseRef: string;
      diff: string;
      truncated: boolean;
      summary?: string;
      meatTokens?: { input: number; output: number };
      seq?: number;
      at?: number;
    }
  /** A coding run's accepted `PrDescription` (features/pr-description.md): the
   *  typed object the run submitted through `submit_pr_description`, as
   *  validated — the same object the dispatcher renders the GitHub body from,
   *  so the run page's review panel can render it without a second authoring
   *  path. Published by the dispatcher once per run (the last valid submission
   *  wins), string fields redacted like every event payload. Additive: unknown
   *  → ignored. */
  | { type: "pr_description"; description: PrDescription; seq?: number; at?: number }
  /** The coding PR post-step's outcome (features/pr-description.md item 5):
   *  the PR opened for the run's pushed branch — or, open-or-edit, the
   *  existing open PR that was edited (`created: false`). Published by the
   *  dispatcher straight to the registry BEFORE the stream finishes, so the
   *  run record carries the PR URL as a fact of the run rather than only the
   *  channel reply's projection of it. Additive: unknown → ignored. */
  | { type: "pr_opened"; url: string; number: number; created: boolean; seq?: number; at?: number }
  /** One `agent:ship` round boundary (features/agent-ship.md item 12): the
   *  pipeline publishes a `started` event when a round's child is dispatched
   *  and one settle event when its outcome is known (`ShipRoundOutcome`), so
   *  rounds are legible on the one stream and per-round cost is derivable by
   *  slicing `turn` events between boundaries. `index` is 0-based in the
   *  spec's round vocabulary — round 0 is the initial coding round; a review
   *  round and its fix round share an index. Published by the ship pipeline
   *  straight to the registry (like `pr_opened`), never through the runner.
   *  Additive: unknown → ignored. */
  | { type: "ship_round"; index: number; agent: string; outcome: ShipRoundOutcome; seq?: number; at?: number };

// Redaction helpers live in ./redact.ts and are re-exported here so every
// existing import site keeps working.
export { redactAndCap, redactSecrets, stripAnsi } from "./redact.js";
import { redactSecrets, stripAnsi } from "./redact.js";

const SUMMARY_CAP = 200;

/** One-line, control-stripped, redacted, length-capped summary of a tool's output for the run
 *  stream — the first non-empty line plus a size note. */
export function summarizeToolResult(output: string): string {
  return summarizeClean(redactSecrets(stripAnsi(output)));
}

/** `summarizeToolResult` for text that is ALREADY control-stripped and redacted. */
function summarizeClean(clean: string): string {
  const trimmed = clean.trim();
  if (trimmed === "") return "(no output)";
  const firstLine =
    trimmed
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  const head = firstLine.length > SUMMARY_CAP ? `${firstLine.slice(0, SUMMARY_CAP)}…` : firstLine;
  const lineCount = trimmed.split("\n").length;
  const more =
    trimmed.length > head.length ? ` (${trimmed.length} chars${lineCount > 1 ? `, ${lineCount} lines` : ""})` : "";
  return head + more;
}

/** Every executor renders a nonzero command exit as an `exit <code>:` first line
 *  (`LocalExecutor.exec`, `ResidentExecutor.exec`, `CloudflareSandboxExecutor.exec`)
 *  so the model sees the status. This is the single reader of that contract.
 *  `failed` is true for any such prefix; `exitCode` is the code when numeric
 *  (execFile can report an errno string instead). Ordinary output — including
 *  text that merely mentions "exit 1:" later on — is a clean 0. */
export function parseExitPrefix(output: string): { failed: boolean; exitCode?: number } {
  const m = /^\s*exit (\S+?):/.exec(stripAnsi(output));
  if (!m) return { failed: false, exitCode: 0 };
  return /^\d+$/.test(m[1]) ? { failed: true, exitCode: Number(m[1]) } : { failed: true };
}

/** Upper bound on a `tool_result.output` — large enough for a test run or a
 *  diff to read in full on the run page, small enough that a run of ordinary
 *  length fits the registry's backlog whole (the backlog is bounded by count AND
 *  bytes — `RunRegistry`, 5000 events / 4 MiB — so an output-heavy run trims its
 *  oldest events rather than growing without bound). */
export const TOOL_OUTPUT_CAP = 8_000;

/** Cap on a bash `tool_call.command` (the full command beside the 200-char
 *  `summary`). Generous — an agent's chained `checkout && add && commit && push`
 *  is a few hundred chars; a heredoc-fed script can be a few thousand — and
 *  still a small fraction of `MAX_EVENT_BYTES`. */
export const COMMAND_CAP = 4_000;

/** The full tool output as it may leave the process: control-stripped, then
 *  redacted, then capped (that order — see redactAndCap). Empty output → "". */
export function prepareToolOutput(output: string): string {
  return capClean(redactSecrets(stripAnsi(output)));
}

/** `prepareToolOutput` for text that is ALREADY control-stripped and redacted. */
function capClean(clean: string): string {
  const text = clean.trim();
  if (text.length <= TOOL_OUTPUT_CAP) return text;
  return `${text.slice(0, TOOL_OUTPUT_CAP)}…[${text.length - TOOL_OUTPUT_CAP} more chars]`;
}

/** Both `tool_result` display fields from ONE strip+redact pass. The redaction
 *  battery is ~20 regexes over up to 120k chars of raw tool output; paying it
 *  once per result instead of twice (summary, then output) halves the
 *  synchronous CPU the runner spends per tool call. Byte-identical to calling
 *  `summarizeToolResult` and `prepareToolOutput` separately. */
export function prepareToolResult(output: string): { summary: string; output: string } {
  const clean = redactSecrets(stripAnsi(output));
  return { summary: summarizeClean(clean), output: capClean(clean) };
}

/** `5m 04s` / `1.3s` / `800ms` — the one duration format every surface that
 *  names a model turn uses (status card, CLI; the page's inlined timeline has
 *  its own copy because it cannot import). */
export function formatTurnDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms - m * 60_000) / 1000);
  return `${m}m ${s < 10 ? "0" : ""}${s}s`;
}

/** `JSON.stringify(event)`, computed once per event object however many readers
 *  it has: the registry measures each event's byte size at publish, then hands
 *  the SAME object to every subscriber (and replays the same backlog entries),
 *  so with k open tabs on one run each tool_result (up to 8 KB of output) would
 *  otherwise be serialized k+1 times. */
const serialized = new WeakMap<object, string>();
export function serializedOnce(event: object): string {
  let s = serialized.get(event);
  if (s === undefined) {
    s = JSON.stringify(event);
    serialized.set(event, s);
  }
  return s;
}
