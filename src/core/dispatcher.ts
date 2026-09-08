import type { ConfigStore } from "../config.js";
import type { Capabilities } from "./capabilities.js";
import { configAwarenessBlock } from "./configAwareness.js";
import { selfDescriptionBlock } from "./selfDescription.js";
import { customInstructionsBlock } from "./customInstructions.js";
import { AGENTS, getAgent, type AgentDef } from "../agents/registry.js";
import { lastThreadDirectives, parseDirectives, type RequestDirectives, type ThreadDirectives } from "../directives.js";
import { mergeTools, runAgent } from "../runner.js";
import { TOOLSETS } from "../tools/workspace.js";
import type { LedgerRun, LedgerWriteThrough } from "./runLedger/writeThrough.js";
import type { AppendableEvent, InboxItem, LiveRunRow, StepRecord } from "./runLedger/types.js";
import type { ThreadsElsewhere } from "./runLedger/threadsElsewhere.js";
import type { ResumePlan } from "./runLedger/resume.js";
import { systemClock } from "./trace/index.js";
import { COMMAND_RUN_AGENT } from "./runOwner.js";
import type { Clock, Span, SpanSink, Tracer } from "./trace/types.js";
import type { RunOwner } from "./trace/streamSpans.js";
import { channelOf, startRequestRoot, type RequestTrace } from "./requestTrace.js";
import { cardShapeLine, cardShapeLineOf, queuedCaption } from "./runShape.js";
import { graftResidentSteps, residentTraceOf, sanitizeGraftedSteps } from "../execution/residentTrace.js";
import type { ResidentStep } from "../execution/residentStepTrace.js";
import { SPAN_SCHEMA } from "./normalizeSpans.js";
import { makeWebCapability } from "../tools/web.js";
import { residentOnboardedProbe, residentSlugsLister } from "../execution/factory.js";
import { ResidentNeedsRefError } from "../execution/resident.js";
import { parseModelRef, type ChatMessage, type ContentPart } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { currentPrHeadSha, prCommitsSince, resolveRepoContext, type RepoContext } from "./repoContext.js";
import type { PrCommitList } from "./headMoved.js";
import { postReviewComment, type ReviewCommentTarget } from "../execution/githubComments.js";
import {
  createBranchRef,
  fetchPullRequestFacts,
  fetchRepoShipInfo,
  openPullRequest,
  type OpenedPullRequest,
  type PullRequestFacts,
  type PullRequestTarget,
  type RepoShipInfo,
} from "../execution/githubPulls.js";
import { resolveGithubIdentity, type GithubIdentity } from "../execution/githubApp.js";
import {
  resolveShipCaps,
  runShipPipeline,
  shipPreflight,
  shipRoundHeader,
  type ShipBlocks,
  type ShipChildSpec,
  type ShipOutcome,
} from "./shipPipeline.js";
import { PrDescriptionSchema, type PrDescription } from "./prDescription.js";
import { parseVerdictInput, type ReviewVerdict } from "./reviewVerdict.js";
import {
  attachRoundWorkspace,
  checkPrHeadPreflight,
  guardAttachedHead,
  makeSystemComposer,
  runReviewPostStep,
  settleReviewedHead,
  type RoundWorkspace,
} from "./reviewRound.js";
import { observeCodingWorkspace, runCodingPrPostStep, trackPushedBranch } from "./codingPrPostStep.js";
import { recognizeOperation } from "./operations.js";
import { memoryContextBlock, scheduleReflection, type MemoryStore } from "./memory/index.js";
import { skillGuidanceBlock, type SkillStore } from "../skills/index.js";
import { mcpGuidanceBlock, type McpToolSource } from "../mcp/source.js";
import { isSpanRecord, redactSecrets, type RunEvent, type StopMode } from "./runEvents.js";
import { oneLine, redactAndCap, stripAnsi } from "./redact.js";
import {
  decideFollowUp,
  mergeFollowUps,
  refusalReply,
  steerAck,
  ThreadAdmission,
  type FollowUpInput,
  type LiveThread,
} from "./threadAdmission.js";
import { resolveChatActor } from "./authz/actor.js";
import { STATIC_CHANNEL_DIRECTORY } from "./authz/channelDirectory.js";
import type { ChannelDirectory, ChannelVisibility } from "./authz/types.js";
import { fitRecordToBudget, MAX_EVENT_BYTES, utf8ByteLength, type RunRecord, type RunStatus } from "./runRecord.js";
import { markdownOutput } from "./llmOutput/index.js";
import type { RunHistoryWriter } from "./runHistoryWriter.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "./runFriction.js";
import { startReviewReadingDiff } from "./readingDiff.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { RestGithubApi, type GithubApi } from "../execution/githubApi.js";
import type { GithubCapability } from "../tools/github.js";
import {
  invokeChatCommand,
  parseChatCommand,
  type ChatCommandResult,
  type ChatCommands,
  type ParsedChatCommand,
} from "./commandChat.js";
import { toMarkdownDocument } from "./markdownDocument.js";
import { cliWords } from "./commandSurface.js";
import {
  activityOfEvents,
  defaultRunRegistry,
  type RunControl,
  type RunHandle,
  type RunRegistry,
  type RunSnapshot,
  type RunSummary,
  REPLAY_EVERYTHING,
  type SealResult,
} from "./runRegistry.js";
import { inFlightToolAfter, quietSuffix } from "./statusCardLabel.js";
import { createCardShell, type CardShell } from "./statusCardFrame.js";
import { createRunEnding, type RunEnding } from "./runEnding.js";
import { coalesceStatus } from "./statusCoalescer.js";
import type {
  ChannelIO,
  DocumentAttachment,
  HistoryItem,
  ImageAttachment,
  IncomingMessage,
  StatusHandle,
} from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps {
  config: ConfigStore;
  providers: ProviderRegistry;
  /** What is on in this process (src/core/capabilities.ts): computed ONCE at
   *  startup from the config and the environment, read by every surface —
   *  the prompt blocks, the status card, the command catalogue, the web seed.
   *  Nothing below re-derives a capability from `config`. */
  capabilities: Capabilities;
  /** The wall clock (features/tracing.md): `systemClock` in production, a ticking clock in tests. */
  clock?: Clock;
  /** The tracer behind every root this process starts; the no-gaps test injects one with its `SpanContext`. */
  tracer?: Tracer;
  /** The root's leading sinks (a test's recording sink); default: the one log sink at `tracing.log`. */
  sinks?: SpanSink[];
  /** where runtime state (sandboxes.json) lives; default ./data */
  dataDir?: string;
  /**
   * Resolves the target repo/ref for a message (resident environments).
   * Defaults to the production resolver in repoContext.ts (explicit repo/PR/
   * branch signals in the message, then the thread-established repo from
   * history); injectable for tests. No repo signal → {} → the per-thread
   * executor path with no resident probe (total input contract).
   */
  resolveRepoContext?: (msg: IncomingMessage, history: HistoryItem[]) => Promise<RepoContext> | RepoContext;
  /**
   * Live run-view registry (Area 2 / #43): every run is registered here and its
   * events published so the external /runs page can stream them. Optional;
   * defaults to the process-wide singleton so the dispatcher and the served
   * /runs endpoints (src/index.ts) share one instance. Injectable for tests.
   */
  runRegistry?: RunRegistry;
  /**
   * Thread admission (features/thread-admission.md): the per-process map of
   * threads with a run in flight, so a follow-up in such a thread is steered
   * into that run or refused instead of starting a rival one. Defaults to the
   * process-wide singleton; injectable for tests.
   */
  admission?: ThreadAdmission<DispatchFollowUp>;
  /**
   * Posts a review comment back to a PR (issue #69). Called after a `review`
   * run against a resolved PR, unless the request opted out. Default: the real
   * GitHub REST post with the App installation token (App `pull_requests:write`;
   * no `gh` shell-out — AGENTS.md invariant 5). Injectable so tests assert the
   * decision without a network call.
   */
  postReviewComment?: (target: ReviewCommentTarget, body: string) => Promise<void>;
  /**
   * Opens the PR for a coding run's pushed branch — or edits the one already
   * open for it (open-or-edit idempotency) — after the run submitted its typed
   * `PrDescription` (features/pr-description.md item 5). Default: the real
   * GitHub REST call with the App installation token
   * (src/execution/githubPulls.ts; no `gh` shell-out — AGENTS.md invariant 5).
   * Injectable so tests assert the typed inputs without a network call.
   */
  openPullRequest?: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /**
   * Ship round 0's pipeline-branch create (features/agent-ship.md item 3,
   * KTD12): `refs/heads/<branch>` at the base ref's tip, so the ref exists on
   * origin BEFORE the resident is asked to bind the thread to it. Default:
   * githubPulls' `createBranchRef` (App token REST, 422 already-exists is
   * success). Injectable so tests assert the call without a network call.
   */
  createBranchRef?: (repo: string, branch: string, fromRef: string) => Promise<void>;
  /**
   * The PR's head SHA as GitHub reports it right after a review was posted
   * (agent-review.md item 10): when it differs from the reviewed head — a push
   * landed mid-run — the thread gets a head-moved note. Default: one REST GET
   * via repoContext's `currentPrHeadSha`; undefined (or a throw) → no note.
   * Injectable so tests assert the note without a network call.
   */
  fetchPrHead?: (pr: { repo: string; number: number }) => Promise<string | undefined>;
  /**
   * Repo facts for the agent:ship gate (features/agent-ship.md item 9): the
   * `allow_auto_merge` flag — ship refuses when it is enabled OR unknown
   * (fail-closed: an LGTM into auto-merge would merge with no human) — and
   * the repo's default branch, the PR base of last resort. Default: one REST
   * GET via githubPulls' `fetchRepoShipInfo` (App token, never `gh`).
   * Injectable so tests assert the refusal without a network call.
   */
  fetchRepoShipInfo?: (repo: string) => Promise<RepoShipInfo | undefined>;
  /**
   * One PR's entry-check facts for agent:ship (item 10): open/closed, author
   * identity (login + immutable numeric id), same-repo head, head ref/sha —
   * the resume-at-review checks, and the merge-ready "still open" re-check.
   * Default: githubPulls' `fetchPullRequestFacts`. Injectable for tests.
   */
  fetchPrFacts?: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  /**
   * The GitHub identity this process acts as (agent-ship.md item 10): the App's
   * bot user, or the static token's user — what ship's own PRs are authored by.
   * Default: githubApp's `resolveGithubIdentity`. Injectable for tests.
   */
  fetchSelfIdentity?: () => Promise<GithubIdentity | undefined>;
  /**
   * The commits a PR head carries over its base (agent-review.md item 12):
   * asked once for the reviewed head and once for the current one when the
   * head moved during a review run, to tell a rebase of the same commits from
   * a real change. Default: one REST GET per side via repoContext's
   * `prCommitsSince`; undefined (or a throw) → the move is unclassified and
   * the post-step falls back to item 10 (pinned post + note).
   */
  fetchPrCommits?: (q: { repo: string; base: string; sha: string }) => Promise<PrCommitList | undefined>;
  /**
   * Cross-session memory store (Area 7c, #85). When `config.memory.enabled`
   * is true the dispatcher retrieves scope-relevant records from this store
   * and injects them as an advisory context block before the model turn, and
   * after the reply a background reflection pass writes distilled records back
   * to it. With memory off (the default) production wires a `NullMemoryStore`
   * (src/index.ts, src/cli.ts) — and the memory module selects one whatever
   * is wired — so model input is byte-identical to memory-off and nothing is
   * written. Injectable for tests.
   */
  memory: MemoryStore;
  /**
   * Skill store backing the load-a-skill capability (#100). When present, the
   * dispatcher appends the calling agent's scoped skill name+description list to
   * its system prompt (progressive disclosure) and passes the store to the tool
   * context so list_skills/use_skill work. Absent (as in most unit tests) →
   * no skill block and the skill tools report themselves unavailable, leaving
   * the request unchanged. Production wires a BundledSkillStore (src/index.ts,
   * src/cli.ts); the DO-backed upload store is PR2, behind this same interface.
   */
  skills?: SkillStore;
  /**
   * External MCP servers as tools (#394, features/mcp-tools.md). Asked once
   * per run, before the first model turn, for the servers scoped to the
   * resolved agent; the bridged tools ride `RunOptions.extraTools` and the
   * outcome becomes the MCP prompt block + one `mcp_unavailable` note per
   * server that did not answer. No server scoped to the agent — the
   * `NullMcpToolSource` of a process without MCP included — → the request is
   * byte-identical to before the feature. Whether the self-serve surface
   * (`mcp add …`) exists is `capabilities.mcp`, which the config awareness
   * block tells the model (features/mcp-tools.md item 17).
   */
  mcp: McpToolSource;
  /**
   * The GitHub API behind the `github_*` tools (features/github-tools.md).
   * Absent → the production REST client on the App credential; tests inject an
   * `InMemoryGithubApi`. The per-run capability adds the requesting user's
   * `canUseRepo` write gate (`githubCapabilityFor`).
   */
  githubApi?: GithubApi;
  /**
   * The write path onto `runStore` (#157 KTD4): after every run the dispatcher
   * builds the `RunRecord` at finish and hands it here AFTER the reply is sent —
   * fire-and-forget with bounded retries, drain-counted via `pending()`. With
   * history off it is the `NullRunHistoryWriter` — every write dropped —
   * so the dispatcher never asks whether there is one. Production wires
   * `createRunHistoryWriter` over the selected store (src/index.ts, src/cli.ts).
   */
  runHistoryWriter: RunHistoryWriter;
  /**
   * The run ledger's write-through (features/run-history.md item 35): every
   * agent run and ship pipeline is claimed on the state Worker's ledger when
   * its run is created, mirrors its steps/events/state while it runs, takes
   * `finishing` before the reply and finishes through the ledger's one
   * transaction (`runHistoryWriter.write(record, { via })`). Without a ledger
   * it is the `NullLedgerWriteThrough`: nothing is claimed and the run goes on
   * exactly as before the ledger existed. Production wires
   * `createLedgerWriteThrough` beside the run store (src/index.ts), so a
   * ledger always comes with a writer: without one the finish never reaches the
   * ledger and a claimed row closes only by lease expiry (a test-only pairing).
   */
  runLedger: LedgerWriteThrough;
  /** The threads whose live run is on the ledger but not in this process
   *  (thread-admission item 5), fed by the reclaim sweep: a follow-up on one
   *  is steered into that run's durable inbox instead of starting a rival.
   *  Empty in a process without a ledger. */
  threadsElsewhere: Pick<ThreadsElsewhere, "get" | "forget">;
  /**
   * Channel facts for the run record (authorization KTD4/KTD7): every run is
   * stamped with its channel's visibility at create, asked of this directory
   * once per run. Default: the static id-based directory (`http:`/`mcp:` →
   * machine, `slack:D…` → dm, `slack:G…` → private, anything else → unknown);
   * the bot wires the Slack one (`SlackChannelDirectory`, `conversations.info`
   * cached per channel per TTL) when the Slack adapter is up. A directory
   * failure — or an answer slower than `channelDirectoryTimeoutMs` — stamps
   * `unknown`, never a guess (R7), so a slow directory cannot delay a reply.
   */
  channelDirectory?: ChannelDirectory;
  /** Bound on one `channelDirectory.info` wait (default `CHANNEL_DIRECTORY_TIMEOUT_MS`).
   *  Tests that exercise the timeout set it low. */
  channelDirectoryTimeoutMs?: number;
  /**
   * Where `friction propose` files its proposals. Default: the GitHub REST
   * tracker with the App installation token (App `issues:write`; never a `gh`
   * shell-out — AGENTS.md invariant 5). Injectable so tests assert filing
   * without a network call.
   */
  issueTracker?: IssueTracker;
  /** Floor between two status-card edits (default `STATUS_UPDATE_MIN_MS`).
   *  Tests that assert on an individual intermediate frame set 0. */
  statusUpdateMinMs?: number;
  /**
   * The command registry bound to its deps (#157 U13, `bindCommands`), for the
   * chat fast path: `<group> <verb> [args…] [--option value…]` messages that
   * name a registered, chat-exposed command (and the bare word `help`) are
   * answered inline through `invoke`, never a model turn — since phase 4b this
   * is EVERY command (`help`, `config`, `memory`, `repo`, `friction`, `runs`,
   * `schedule`), there is no legacy chat parser left. Absent (most unit tests,
   * or before the surface is wired) → no message is a command and every text
   * goes to the model. Every real process binds the one core catalogue through
   * `buildCoreCommands` (src/core/commandCatalogue.ts): the bot (src/index.ts)
   * and the CLI harness (src/cli.ts).
   */
  commands?: ChatCommands;
}

/** Registry commands the dispatcher records as inline runs (#244): the ones
 *  that DO work beyond answering from local state — ledger reads and GitHub
 *  writes (`friction.*`), a durable memory mutation (`memory.forget`), a repo
 *  provisioned/torn down/reprovisioned (`repo.onboard|offboard|rebuild|
 *  reconfigure`), a deterministic op executed (`repo.test|build`). Config
 *  replies, `help`, listings, and usage/help replies are not runs. */
export function isInlineRunCommand(id: string): boolean {
  return (
    id.startsWith("friction.") ||
    id === "memory.forget" ||
    /^repo\.(onboard|offboard|rebuild|reconfigure|test|build)$/.test(id) ||
    /^mcp\.(add|connect|remove)$/.test(id)
  );
}

/** Floor between two edits of a run's status card (see `coalesceStatus`). Below
 *  the 5 s heartbeat so a heartbeat frame is never held back by it. */
const STATUS_UPDATE_MIN_MS = 3000;

/** Bounds on the thread context recorded into a run's stream as `context`
 *  events (#157 KTD8): the newest turns win, at most this many, within this
 *  many bytes of redacted text in total. */
const CONTEXT_MAX_ITEMS = 20;
const CONTEXT_MAX_BYTES = 256 * 1024;

/** The web capability (undici Agent with the SSRF-checking connector + the
 *  search adapter) is built ONCE per process, not per run: the Agent owns the
 *  connection pool, so sharing it lets every run reuse warm TLS sockets to the
 *  same hosts instead of paying a fresh DNS+TCP+TLS handshake per fetch — and a
 *  per-run Agent was never closed, so its keep-alive sockets accumulated. */
let sharedWeb: ReturnType<typeof makeWebCapability> | undefined;
const webCapability = () => (sharedWeb ??= makeWebCapability(process.env));

/** The `github_*` tools' capability for one run (features/github-tools.md):
 *  the process-wide REST client on the App credential (or the injected test
 *  double) plus the REQUESTING USER's per-repo write gate — `canUseRepo`, the
 *  same allowlist that admits a user to a repo's resident (KD7) — so an issue
 *  write from a plain mention is authorized like a coding run on that repo. */
let sharedGithubApi: GithubApi | undefined;
function githubCapabilityFor(deps: CoreDeps, userId: string): GithubCapability {
  const api = deps.githubApi ?? (sharedGithubApi ??= new RestGithubApi());
  return { api, canWrite: (repo) => deps.config.canUseRepo(userId, repo) };
}

// In-flight run tracking so the process can drain before exiting (restarts
// must not kill runs mid-flight — see index.ts signal handling).
let activeRuns = 0;

/** A follow-up as the dispatcher admits it: the runner's `FollowUpInput` plus
 *  the message and channel handle it arrived on — what a fresh turn needs if
 *  the live run ends without consuming it (features/thread-admission.md item 4). */
export type DispatchFollowUp = FollowUpInput & { msg: IncomingMessage; io: ChannelIO };

/** The process-wide admission map (one bot process = one map; the registry's
 *  singleton is the same shape of default). */
const defaultAdmission = new ThreadAdmission<DispatchFollowUp>();

/** The note a follow-up's sender gets when the run it was folded into was
 *  stopped by an operator before its next step read it. */
const FOLLOW_UP_DROPPED_BY_STOP =
  "⛔ The run this was folded into was stopped before it read this follow-up, so it was not run. Re-send it to run it fresh.";
export function activeRunCount(): number {
  return activeRuns;
}

/** A run this generation reclaimed at boot and is continuing (features/
 *  run-history.md item 38): the ledger row as it stands, the last step record,
 *  the resume plan built from the transcript, the events published before the
 *  restart (replayed into the registry under their seqs), and the repo context
 *  rebuilt from the row's meta. */
export interface ResumeContext {
  row: LiveRunRow;
  lastStep: StepRecord;
  plan: Extract<ResumePlan, { kind: "resume" }>;
  events: AppendableEvent[];
  /** The highest event seq on the ledger; appends continue past it. */
  lastSeq: number;
  repoCtx: RepoContext;
  /** The durable inbox past the last record (item 40): folded in at the run's first boundary. */
  inbox: InboxItem[];
}

/** The durable copy of a steered follow-up (run-history item 40): the message
 *  without its attachment bytes — the text is what a resume must not lose;
 *  images and documents stay with the in-memory copy. */
export function durableInboxMessage(msg: IncomingMessage, text: string, at: number): Record<string, unknown> {
  return {
    channelId: msg.channelId,
    userId: msg.userId,
    threadKey: msg.threadKey,
    text,
    at,
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(msg.channelName !== undefined ? { channelName: msg.channelName } : {}),
  };
}

/** A durable inbox item back as a follow-up for the resumed run, on the
 *  resume's channel handle; undefined when the stored shape is not one this
 *  build wrote (skipped, never fatal). */
export function followUpFromInbox(item: InboxItem, io: ChannelIO, fallbackAt: number): DispatchFollowUp | undefined {
  const m = item.message;
  const str = (k: string): string | undefined => (typeof m[k] === "string" ? (m[k] as string) : undefined);
  const text = str("text");
  const userId = str("userId");
  const threadKey = str("threadKey");
  const channelId = str("channelId");
  if (text === undefined || userId === undefined || threadKey === undefined || channelId === undefined)
    return undefined;
  const userName = str("userName");
  const sourceUrl = str("sourceUrl");
  const channelName = str("channelName");
  const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at : fallbackAt;
  const msg: IncomingMessage = {
    channelId,
    userId,
    threadKey,
    text,
    ...(userName !== undefined ? { userName } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(channelName !== undefined ? { channelName } : {}),
  };
  return {
    text,
    userId,
    ...(userName !== undefined ? { userName } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    at,
    ledgerSeq: item.seq,
    msg,
    io,
  };
}

export interface DispatchOptions {
  resume?: ResumeContext;
  /** The request's root, started by the channel adapter at receipt
   *  (features/tracing.md). Absent (tests, a caller without one) → the
   *  dispatcher starts its own at entry. Ended in the outermost finally. */
  trace?: RequestTrace;
  /** A fresh turn's wait behind the run it was parked on (the `queued …
   *  behind the previous run` caption; a `request` attr; never a duration term). */
  queuedBehindMs?: number;
}

/** Close a reclaimed row this dispatch adopted but will never finish (item
 *  38): the record is the row plus the events published before the restart,
 *  status `interrupted`, through the adopted run's sink so the ledger's finish
 *  removes the row. Best-effort: a failure is a warning, the sweep's next pass
 *  finds the row again. */
async function closeResumedRow(adopted: LedgerRun, resume: ResumeContext, why: string): Promise<void> {
  try {
    await adopted.sink.put(
      reclaimedRunRecord({ row: resume.row, events: resume.events, status: "interrupted", finishedAt: systemClock() }),
    );
  } catch (err) {
    console.warn(
      `[resume] ${resume.row.runId} could not be closed (${why}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function dispatch(
  deps: CoreDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  opts: DispatchOptions = {},
): Promise<void> {
  const resume = opts.resume;
  const clock = deps.clock ?? systemClock;
  // The request's root (features/tracing.md): the adapter's, started when our
  // process saw the message, or our own now. Every awaited step below is a
  // `span(fn)` child of it; the run-stream sink delivers the streamed ones to
  // the run once it exists; the outermost finally ends it. The window opens at
  // `receivedAt`; the queued captions are attrs on the root and lines on the
  // card, never part of a duration.
  const trace =
    opts.trace ?? startRequestRoot(deps, { channel: channelOf(msg.channelId), receivedAt: msg.receivedAt ?? clock() });
  const root = trace.root;
  const receivedAt = trace.receivedAt;
  const queuedBeforeMs = msg.originAt !== undefined ? Math.max(0, receivedAt - msg.originAt) : undefined;
  if (queuedBeforeMs !== undefined) root.setAttrs({ queuedBeforeMs });
  if (opts.queuedBehindMs !== undefined) root.setAttrs({ queuedBehindMs: opts.queuedBehindMs });
  // A fresh turn's wait is the one behind the run; a platform delay is only
  // named when no such wait exists.
  const queued = queuedCaption("behind", opts.queuedBehindMs) ?? queuedCaption("before", queuedBeforeMs);
  // A refusal — a close and a reply that end the request without a run — is
  // one `dispatch.refuse` span naming why.
  let refused = false;
  const refuse = <T>(outcome: string, fn: () => Promise<T>) => {
    refused = true;
    return root.span("dispatch.refuse", fn, { attrs: { outcome } });
  };
  // The card's shape and queued lines at a close (features/tracing.md item 5):
  // a runless close reads the root's children so far over a live window; a
  // done close the whole window to the finish.
  const closeLines = (end: number, finished: boolean, owner: RunOwner = "agent") =>
    cardLines(trace, { end, finished, owner, queued });
  // A done close reads the finish-site diagnosis (features/tracing.md item 5):
  // the same shape the record carries and the friction report prints.
  const doneLines = (diagnosis: FrictionDiagnosis | undefined) => {
    const shape = diagnosis?.shape ? cardShapeLineOf(diagnosis.shape) : undefined;
    return { ...(shape ? { shape } : {}), ...(queued ? { queued } : {}) };
  };
  let caught = false;
  // Counted in flight from the first line — before history, repo resolution,
  // the setup card and the executor attach — until the post-run steps (reply,
  // review post, memory reflection scheduling) have run; decremented in the
  // outer finally. The shutdown drain (index.ts) polls this count: a SIGTERM
  // that lands between the channel's 👀 ack and the first status card used to
  // see "0 run(s) in flight" and exit at once, abandoning an acked run
  // (#317). Config commands and refusals hold the slot for their few hundred
  // milliseconds too — cheaper than a second gap.
  activeRuns++;
  // How this dispatch's runs end (runEnding.ts; features/tracing.md): a run is
  // SEALED once its first reply attempt has completed, and its record — its
  // inputs (the registry snapshot, the diagnosis) captured synchronously at
  // finish inside the run's try/catch, so a failed run has them too — is
  // assembled, byte-budgeted (`fitRecordToBudget`) and written by the drain
  // right after the seal, so it carries the seal's stamps and the events
  // published between finish and seal, and neither persistence nor the
  // budgeting pass ever delays the user. The reply wrap drains on the success
  // path, the outer catch drains around the error reply, and the outer finally
  // drains as the backstop: every run is sealed and its record written exactly
  // once. A writer's `failedAfterFinish` flips a run whose loop completed but
  // whose card close or reply threw to `failed` — the thread never saw the
  // answer — while a stop that already ended it keeps its `stopped_*` status.
  const ending = createRunEnding({ registry: deps.runRegistry ?? defaultRunRegistry });
  // The ack card while setup is still in progress. Cleared the moment it
  // becomes the run card, so the outer catch closes ONLY a card that setup
  // left open — a run failure is closed (with its checklist) by the run loop.
  let setupCard: StatusHandle | undefined;
  let setupShell: CardShell | undefined;
  // The card ticks from the ack (features/tracing.md): a 5 s heartbeat repaints
  // it through setup — the elapsed time and the setup step in flight — until
  // the run loop's own heartbeat takes over (or the request ends without one).
  let setupHeartbeat: ReturnType<typeof setInterval> | undefined;
  // Thread admission (features/thread-admission.md): the slot this dispatch
  // holds on its thread while its run is in flight, claimed after the agent
  // gate below and released in the outer finally — where whatever follow-ups
  // the run never consumed are run as a fresh turn (or, after an operator
  // stop, answered with a note). `liveControl` is the registered run's stop
  // control, read in the finally — never cached from a return value, so a run
  // that THREW after a stop was requested still counts as stopped.
  const admission = deps.admission ?? defaultAdmission;
  let admitted: LiveThread<DispatchFollowUp> | undefined;
  let liveControl: RunControl | undefined;
  // The run's row on the ledger (item 35), once claimed; undefined for an
  // untracked run. Read by the record writer (the finish goes through it) and
  // the outer finally (its heartbeat stops with the run).
  let ledgerRun: LedgerRun | undefined;
  try {
    // Stage A — the ONE text-only fast path (#157 U13/KTD19, phase 4b): a
    // message that names a registered, chat-exposed command (`<group> <verb>
    // [args…] [--kebab-flag value…]`, or the bare word `help`) is answered
    // inline through the registry — never a model turn — BEFORE `io.history()`,
    // so a recognized command costs no history fetch and the natural-language
    // recognizer below never sees it (the two can never both claim one
    // message). ONE grammar (KTD21) for every command: config, memory, repo,
    // friction, runs, schedule, help. Prose falls through unchanged.
    //
    // Commands that DO real work — ledger reads and GitHub writes (`friction.*`),
    // a durable memory mutation, a repo provisioned or torn down, a
    // deterministic op executed — are runs (#244): a registry record with the
    // request and the reply, on /runs like any other, and a receipt to the
    // channel. The weekly cron reaches this path through /ingress as
    // `http:cron`, so a scheduled firing is a run too. The outcome comes from
    // the command's `ok`, never from the reply text. Config replies, `help`,
    // listings, and usage/help replies are answered directly, no run.
    if (deps.commands) {
      const chatCmd = parseChatCommand(msg.text, deps.commands);
      if (chatCmd) {
        const res = await runChatCommand(deps, msg, io, chatCmd, ending, trace);
        // The command run (if the command made one) seals after its reply.
        await ending.sealAfterReply(
          async () => {},
          () => root.span("post.reply", () => replyCommandOutput(io, chatCmd, res.text)),
        );
        if (res.followUp) postSettledOutcome(res.followUp, io, root);
        return;
      }
    }

    const directives = parseDirectives(msg.text);
    const history = await root.span("dispatch.history", () => io.history());

    // Natural-language deterministic ops (U6, KTD8): the few conservative forms
    // `recognizeOperation` admits ("run the tests on main in acme/api") are
    // TRANSLATED into the registry's `repo.test` / `repo.build` — the very
    // command `repo test acme/api main` is — so one handler executes, one gate
    // sequence applies (the policy table on `agent { coding }` — the right to run
    // the implicit target agent; canUseRepo inside), and zero model turns are
    // spent. Natural language is an accelerator, not a promise: when the op
    // cannot serve (`not_found` — the repo has no resident; `unavailable` — no
    // backend or a backend failure) the agent still gets the ask, while a
    // refusal or a result is the reply. An explicit agent:/model: directive
    // disables recognition — the user picked a model path.
    const opAsk = deps.commands
      ? recognizeOperation(msg.text, history, { allowNatural: !directives.agent && !directives.model })
      : null;
    if (opAsk) {
      const translated: ParsedChatCommand = {
        kind: "invoke",
        id: `repo.${opAsk.op}`,
        input: { args: [opAsk.repo, opAsk.ref], options: {} },
      };
      const res = await runChatCommand(deps, msg, io, translated, ending, trace);
      if (!(res.error === "not_found" || res.error === "unavailable")) {
        await ending.sealAfterReply(
          async () => {},
          () => root.span("post.reply", () => io.reply(res.text)),
        );
        return;
      }
      // A fall-through: the command run answered nothing the agent will not; it
      // is sealed now with no reply attempted, and the agent run below is a
      // second run in this dispatch.
      await ending.sealAfterReply(async () => {});
    }

    // Thread stickiness: a follow-up without explicit directives runs on the
    // agent/model this thread already established (last directive in the
    // thread's history), not the channel/global default — otherwise "continue"
    // in an agent:coding thread silently lands on the toolless default agent.
    // Derived from history on every message, never stored: restart-safe, and
    // consistent with how the Slack adapter re-derives thread participation.
    const sticky = lastThreadDirectives(history);
    const resolved = deps.config.resolve({
      channelId: msg.channelId,
      userId: msg.userId,
      request: {
        agent: directives.agent ?? sticky.agent,
        model: directives.model ?? sticky.model,
        effort: directives.effort ?? sticky.effort,
      },
    });

    // Authorization gate: checked against the *resolved* agent and invoking
    // user, so no config layer (directives, user or channel scope) bypasses it.
    if (!deps.config.canRunAgent(msg.userId, resolved.agentName)) {
      await refuse("agent_allowlist", () =>
        io.reply(
          `🚫 You're not on the allowlist for the \`${resolved.agentName}\` agent. Ask ${deps.config.adminsHint()} for access.`,
        ),
      );
      return;
    }

    const agent = getAgent(resolved.agentName);

    // Thread admission (features/thread-admission.md item 1): ONE live run per
    // thread. Claimed HERE — after the agent gate (a follow-up's sender must be
    // allowed to run the live agent, exactly like a first message) and before
    // anything slow (the setup card, repo resolution, the executor attach), so
    // no window exists in which two runs can attach the same per-thread
    // workspace. A thread with a run in flight either folds this message into
    // that run (its inbox; the runner reads it at the next step boundary — for
    // a ship run, the child round in flight) or refuses it with a pointer to
    // the live run when a DIFFERENT agent was asked for explicitly. Either way
    // this dispatch ends here: no card, no run, no workspace.
    // A resumed run's slot carries the row's original start (run-history item 38):
    // the steer ack's "N in" is the run's elapsed time, not the resume's.
    let claim = admission.claim(msg.threadKey, {
      agent: agent.name,
      ...(resume ? { now: resume.row.startedAt } : {}),
    });
    if (claim.kind === "live" && resume) {
      // A resume is not a follow-up (run-history item 38): its message is
      // synthetic, so it must never be steered into — or refuse against — the
      // run that now holds the thread. A live run here means the user moved on
      // after the kill (a re-mention started a fresh run); the reclaimed run
      // is closed `interrupted` on the ledger, with no reply to the thread.
      const adopted = deps.runLedger.adopt({
        runId: resume.row.runId,
        threadKey: msg.threadKey,
        state: resume.row.state,
        lastStep: resume.lastStep.step,
        lastSeq: resume.lastSeq,
      });
      await root.span(
        "dispatch.admission",
        () => closeResumedRow(adopted, resume, "the thread has a newer run in flight"),
        { attrs: { outcome: "resume_superseded" } },
      );
      console.log(
        `[resume] ${msg.threadKey} run ${resume.row.runId} not resumed: the thread has a newer run in flight — closed interrupted`,
      );
      return;
    }
    if (claim.kind === "live") {
      // The gate above ran against THIS message's resolved agent; a steered
      // follow-up is read by the LIVE agent, so its sender must be allowed to
      // run that one too (invariant 3 — no path runs an agent for a user the
      // allowlist excludes, and "run" includes "is heard by").
      if (!deps.config.canRunAgent(msg.userId, claim.live.agent)) {
        await refuse("live_agent_allowlist", () =>
          io.reply(
            `🚫 You're not on the allowlist for the \`${claim.live.agent}\` agent, whose run is in flight in this thread. Ask ${deps.config.adminsHint()} for access.`,
          ),
        );
        return;
      }
      const decision = decideFollowUp(claim.live, { agent: directives.agent });
      if (decision.kind === "refuse") {
        console.log(
          `[dispatch] ${msg.threadKey} follow-up refused (${decision.reason}): ${claim.live.agent} run in flight`,
        );
        await refuse("follow_up_refused", () => io.reply(refusalReply(claim.live, decision, clock())));
        return;
      }
      // The durable copy first (run-history item 40), so its seq rides on the
      // in-memory item and the next step record says the run consumed it. A
      // run with no row yet (still in setup) has no durable copy: it is not
      // resumable until its seed lands anyway.
      const at = clock();
      const ledgerSeq = claim.live.runId
        ? await deps.runLedger.pushInbox(claim.live.runId, durableInboxMessage(msg, directives.text, at))
        : undefined;
      if (admission.get(msg.threadKey) !== claim.live) {
        // The run finished and released the thread during the round trip: an
        // item pushed now would sit on a dead slot (and its durable copy went
        // with the finish). Nothing is dropped silently — the follow-up is a
        // request of its own now (item 4's rule, taken early).
        console.log(`[dispatch] ${msg.threadKey} the run finished during the steer — running the follow-up fresh`);
        return dispatch(deps, msg, io);
      }
      claim.live.inbox.push({
        text: directives.text,
        userId: msg.userId,
        ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
        ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
        ...(msg.images !== undefined ? { images: msg.images } : {}),
        ...(msg.documents !== undefined ? { documents: msg.documents } : {}),
        at,
        ...(ledgerSeq !== undefined ? { ledgerSeq } : {}),
        msg,
        io,
      });
      console.log(
        `[dispatch] ${msg.threadKey} follow-up steered into the ${claim.live.agent} run in flight (${claim.live.inbox.size} pending${ledgerSeq !== undefined ? `, durable seq ${ledgerSeq}` : ""})`,
      );
      await root.span("dispatch.admission", () => io.reply(steerAck(claim.live, at)), {
        attrs: { outcome: "steered" },
      });
      return;
    }
    // The thread is free here, but its live run may be on the ledger under
    // another generation, or reclaimed and not yet launched (thread-admission
    // item 5 — the boot gap). Then the follow-up is steered into that run's
    // durable inbox: the resume folds it in. The same gates as an in-process
    // steer apply (the live agent's allowlist, no agent switch). A push the
    // ledger refuses means the row is gone — the map is stale — so the message
    // runs fresh and the thread is forgotten until the next sweep.
    const elsewhere = resume ? undefined : deps.threadsElsewhere.get(msg.threadKey);
    const farAgent = elsewhere?.agent;
    if (elsewhere && farAgent === undefined) {
      // No agent on the row: the no-agent-switch gate cannot be judged, so the
      // message is not steered into it (a claim always records the agent; this
      // is a guard, not a path).
      console.log(`[dispatch] ${msg.threadKey} run ${elsewhere.runId} on the ledger names no agent — running fresh`);
    } else if (elsewhere && farAgent !== undefined) {
      // This dispatch holds the slot for nothing but a steer: release it NOW,
      // before any round trip, so the resume's own dispatch (which may launch
      // this instant) finds the thread free instead of a rival that closes its
      // row as "a newer run in flight".
      admission.release(msg.threadKey, claim.live);
      const far: LiveThread<DispatchFollowUp> = {
        agent: farAgent,
        inbox: claim.live.inbox,
        startedAt: elsewhere.startedAt,
        runId: elsewhere.runId,
      };
      if (!deps.config.canRunAgent(msg.userId, far.agent)) {
        await io.reply(
          `🚫 You're not on the allowlist for the \`${far.agent}\` agent, whose run is in flight in this thread. Ask ${deps.config.adminsHint()} for access.`,
        );
        return;
      }
      const decision = decideFollowUp(far, { agent: directives.agent });
      const now = clock();
      if (decision.kind === "refuse") {
        console.log(
          `[dispatch] ${msg.threadKey} follow-up refused (${decision.reason}): ${far.agent} run ${far.runId} live on another generation`,
        );
        await io.reply(refusalReply(far, decision, now));
        return;
      }
      const seq = await deps.runLedger.pushInbox(elsewhere.runId, durableInboxMessage(msg, directives.text, now));
      if (seq !== undefined) {
        // The run may have been launched here during the round trip (its
        // adopt-time re-read ran before this push landed, or after — either
        // way the inbox folds one seq in once): hand the item to it as well.
        const nowLive = admission.get(msg.threadKey);
        if (nowLive && nowLive.runId === elsewhere.runId) {
          nowLive.inbox.push({
            text: directives.text,
            userId: msg.userId,
            ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
            ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
            ...(msg.images !== undefined ? { images: msg.images } : {}),
            ...(msg.documents !== undefined ? { documents: msg.documents } : {}),
            at: now,
            ledgerSeq: seq,
            msg,
            io,
          });
        }
        console.log(
          `[dispatch] ${msg.threadKey} follow-up steered into run ${elsewhere.runId} live on another generation (durable seq ${seq}${nowLive ? ", now live here" : ""})`,
        );
        await io.reply(steerAck(far, now));
        return;
      }
      deps.threadsElsewhere.forget(msg.threadKey);
      console.log(`[dispatch] ${msg.threadKey} run ${elsewhere.runId} is no longer on the ledger — running fresh`);
      // Take the slot back for the fresh run below.
      const again = admission.claim(msg.threadKey, { agent: agent.name });
      if (again.kind === "live") {
        // Someone claimed it during the round trip: this message steers into them as any follow-up would.
        return dispatch(deps, msg, io);
      }
      claim = again;
    }
    admitted = claim.live;
    // A resumed run (run-history item 38): its ledger row has been this
    // generation's since the boot reclaim — take it up NOW, before the card,
    // the repo resolution and the workspace attach, so the heartbeat keeps
    // the lease through a slow resident attach. No claim, no seed.
    if (resume) {
      ledgerRun = deps.runLedger.adopt({
        runId: resume.row.runId,
        threadKey: msg.threadKey,
        state: resume.row.state,
        lastStep: resume.lastStep.step,
        lastSeq: resume.lastSeq,
        onStop: (mode) => void liveControl?.requestStop(mode),
        onFenced: () => void liveControl?.requestStop("hard"),
      });
    }
    if (resume) {
      // The follow-ups steered in after the last record (item 40): the reclaim's
      // snapshot PLUS whatever landed since — a boot-gap steer between the
      // reclaim and this claim wrote to the ledger and was acked, so the inbox
      // is re-read here, past the highest seq already known. From this point
      // the thread is claimed in-process and steers reach the run directly. The
      // runner folds them in at its first boundary and records the seq it
      // reached. Their acks were the admitting generation's — none is sent again.
      // Name the run on the slot NOW — its id is the row's — so a boot-gap steer
      // whose push lands after the re-read below finds the run it belongs to and
      // hands the item over in memory (the registry row is created seconds later,
      // after the workspace attach, which is too late for that check).
      admitted.runId = resume.row.runId;
      const known = Math.max(resume.lastStep.inboxConsumedSeq, ...resume.inbox.map((i) => i.seq));
      const late = await deps.runLedger.readInbox(resume.row.runId, known);
      const items = [...resume.inbox, ...late.filter((i) => i.seq > known)];
      const fallbackAt = clock();
      let folded = 0;
      for (const item of items) {
        const followUp = followUpFromInbox(item, io, fallbackAt);
        if (!followUp) {
          console.warn(
            `[resume] ${msg.threadKey} run ${resume.row.runId}: inbox item ${item.seq} has a shape this build cannot read — skipped`,
          );
          continue;
        }
        admitted.inbox.push(followUp);
        folded++;
      }
      if (folded > 0)
        console.log(
          `[resume] ${msg.threadKey} run ${resume.row.runId}: ${folded} follow-up(s) from the durable inbox pending (${late.length} landed after the reclaim)`,
        );
    }

    const { provider: providerName, model } = parseModelRef(resolved.modelRef);
    const provider = deps.providers.get(providerName);

    // Target repo/ref for resident environments, resolved BEFORE the model
    // turn (U7): explicit signals in the message, else the repo this thread
    // already established (from history — restart-safe, never stored). The
    // gate belongs with the resource declaration: an agent that declares no
    // repo (e.g. the toolless general default) never resolves or gates one, so
    // a toolless follow-up in a repo-mentioning thread is not wrongly refused
    // and a PR-URL never triggers a wasted GitHub REST call for it.
    // The production resolver vets bare `owner/name` tokens against the
    // resident registry (an onboarded-resource probe from the resident
    // config) so prose shaped like a slug can never bind a repo; an injected
    // resolver (tests) is called as before. STARTED here (a promise) so the
    // GitHub round trip overlaps the memory read below; awaited after the ack.
    const needsRepo = agent.resources?.repo === "required";
    const repoCtxP: Promise<RepoContext> = root.span("dispatch.repo_context", () =>
      resume
        ? Promise.resolve(resume.repoCtx)
        : needsRepo
          ? Promise.resolve(
              deps.resolveRepoContext
                ? deps.resolveRepoContext(msg, history)
                : resolveRepoContext(
                    msg,
                    history,
                    residentOnboardedProbe(deps.config.config.execution?.resident),
                    residentSlugsLister(deps.config.config.execution?.resident),
                  ),
            ).then((ctx) => ctx ?? {})
          : Promise.resolve({}),
    );
    repoCtxP.catch(() => {});

    // Cross-session memory (Area 7c, #85) — READ path, STARTED here and awaited
    // below, so the memory Worker round trip (up to 5 s) overlaps the repo/PR
    // resolution and the executor attach instead of adding to them. Its scopes
    // are the org, this channel, this user, and — once resolution settles —
    // the bound repo (#253); the read never depends on the repo GATE, only on
    // the repo NAME, and a failed resolution simply means no repo scope.
    // Started after the agent gate, never before: a refused request must not
    // touch memory (retrieval bumps usage counters). Flag-gated: with memory
    // disabled (default) this resolves to undefined via a NullMemoryStore,
    // leaving `messages` and `system` byte-identical to memory-off. The no-op
    // catch keeps an early return (repo refusal, ask-once) from leaving the
    // rejection unhandled; the real await below still surfaces a failure where
    // it did.
    const memoryBlockP = root.span("dispatch.memory_read", (span) =>
      memoryContextBlock(
        deps.config.config.organization,
        deps.config.config.memory,
        deps.memory,
        directives.text,
        msg.userId,
        { channelId: msg.channelId, repo: repoCtxP.then((ctx) => ctx.repo) },
        span,
      ),
    );
    memoryBlockP.catch(() => {});

    // Acknowledge NOW, before anything slow. Everything between here and the
    // model turn can take minutes — repo/PR resolution (GitHub REST), memory
    // retrieval, and above all executor selection (resident attach or a cold
    // sandbox clone+install) — and until this card existed the thread saw
    // nothing for that whole stretch. The same handle becomes the run's status
    // card below; a refusal or setup failure closes it with a reason instead of
    // leaving a spinner behind.
    // A resumed run's clock is the original start (its ledger row's), so the
    // card's elapsed time spans the whole run, not the resume.
    // The card's clock is the request's: it ticks from receipt (features/tracing.md).
    const startedAt = resume?.row.startedAt ?? receivedAt;
    // One builder for every paint of this card (statusCardFrame.ts): the ack,
    // the spinner frames, the closes before the run starts, the done frame.
    const shell = createCardShell({
      label: `*${agent.name}* on \`${resolved.modelRef}\``,
      startedAt,
      now: clock,
    });
    // Coalesced: the run below refreshes it on every event, the channel sees at
    // most one edit per STATUS_UPDATE_MIN_MS, always the newest frame.
    const card = coalesceStatus(
      await root.span("dispatch.ack_card", () => io.status(shell.ack())),
      deps.statusUpdateMinMs ?? STATUS_UPDATE_MIN_MS,
    );
    setupCard = card;
    setupShell = shell;
    // From here the card names the setup step in flight (the card sink's
    // display label — `attaching the workspace…`) until the agent loop starts;
    // the setup heartbeat paints it.
    trace.bindCard({ setupLabel: (label) => shell.setSetupLabel(label) });
    setupHeartbeat = setInterval(() => card.update(shell.live()), 5000);

    // The repo/ref resolution started above (before the ack) lands here; the
    // gate below runs against it exactly as before.
    // `let`: the attach-head check below may adopt the PR's current head when
    // the branch moved between resolution and attach (item 12).
    let repoCtx: RepoContext = await repoCtxP;

    // Not-onboarded gate (#316): the thread has no repo, and the only reason
    // is that its bare `owner/name` slug was refused by the resident registry
    // (item 29's probe). A repo-needing agent would otherwise start with an
    // EMPTY workspace and report `fatal: not a git repository` (live
    // 2026-08-30, `coreplanelabs/try-catch`) — say why instead, before any
    // attach or model turn. A thread that already has a repo never reaches
    // here with `rejectedRepo` (prose slugs there are never probed — #289), so
    // the silence that fix bought is untouched.
    if (needsRepo && !repoCtx.repo && repoCtx.rejectedRepo) {
      const slug = repoCtx.rejectedRepo;
      console.log(`[dispatch] ${msg.threadKey} not started: repo not onboarded (${slug})`);
      // `repo onboard` is admin-gated (canManageRepos, fail-closed): only tell
      // someone to run it if they can; everyone else is pointed at who can.
      const onboardHint = deps.config.canManageRepos(msg.userId)
        ? `Onboard it (\`repo onboard ${slug}\`)`
        : `Ask ${deps.config.adminsHint()} to onboard it (\`repo onboard ${slug}\`)`;
      await refuse("repo_not_onboarded", async () => {
        await card.done(
          shell.close({ kind: "not_started", icon: "📦", reason: "repo not onboarded", ...closeLines(clock(), false) }),
        );
        await io.reply(
          `📦 \`${slug}\` is not onboarded as a resident, so I did not start a *${agent.name}* run for it. ` +
            `${onboardHint} for a warm, deps-ready environment, or name the repository by URL ` +
            `(https://github.com/${slug}) to run in a cold per-thread sandbox.`,
        );
      });
      return;
    }

    // Unverified gate (item 29, the F2 of #445): the registry did not ANSWER
    // for the repo this message addressed (or, in a fresh thread, for its only
    // candidate). Running anyway would mean guessing a repo — in a bound
    // thread, the thread's OLD one: exactly the wrong-repo run addressing
    // exists to end. Say so and stop; the user retries in a minute or names
    // the repo by URL.
    if (needsRepo && !repoCtx.repo && repoCtx.unverifiedRepo) {
      const slug = repoCtx.unverifiedRepo;
      console.log(
        `[dispatch] ${msg.threadKey} not started: repo could not be verified (${slug}: resident registry unreachable)`,
      );
      await refuse("repo_unverified", async () => {
        await card.done(
          shell.close({
            kind: "not_started",
            icon: "📦",
            reason: "repo could not be verified",
            ...closeLines(clock(), false),
          }),
        );
        await io.reply(
          `⚠️ I couldn't verify that \`${slug}\` is an onboarded repo — the resident registry didn't answer — so I did not start a *${agent.name}* run rather than guess which repo you meant. ` +
            `Try again in a minute, or name the repository by URL (https://github.com/${slug}) to run in a cold per-thread sandbox.`,
        );
      });
      return;
    }

    // Per-repo access gate (KD7): open unless `restrict.repos` names the repo;
    // a restricted repo refuses a user without a `repos` grant BY NAME — a
    // refused user must see why, never get a silent per-thread fallback.
    if (needsRepo && repoCtx.repo && !deps.config.canUseRepo(msg.userId, repoCtx.repo)) {
      const repo = repoCtx.repo;
      await refuse("repo_access", async () => {
        await card.done(
          shell.close({ kind: "not_started", icon: "🚫", reason: "repo access", ...closeLines(clock(), false) }),
        );
        await io.reply(
          `🚫 You're not on the allowlist for the \`${repo}\` repo environment. Ask ${deps.config.adminsHint()} for access.`,
        );
      });
      return;
    }

    // agent:ship fork (features/agent-ship.md): after agent resolution and the
    // repo gates above, BEFORE the top-level attach — ship names its own
    // pipeline branch and each child round attaches its own workspace
    // (shipPipeline.ts). The branch owns everything from here: the preflight
    // refusals, the one run record, the round loop, the final report. An
    // unexpected throw propagates to the outer catch after the branch closed
    // its own card and persisted its failed record.
    if (agent.name === "ship") {
      setupCard = undefined; // the ship branch owns the card from here
      clearInterval(setupHeartbeat);
      await runShipBranch(deps, msg, io, {
        agent,
        modelRef: resolved.modelRef,
        label: shell.label,
        startedAt,
        card,
        directives,
        sticky,
        history,
        repoCtx,
        memoryBlockP,
        live: admitted,
        ending,
        trace,
        closeLines,
        refuse,
        doneLines,
      });
      return;
    }

    // A resume continues the exact conversation the ledger held (item 38);
    // the thread history was folded into it when the run started.
    const messages = resume ? resume.plan.messages : buildMessages(history, directives.text, msg.images, msg.documents);

    // Executor selection is context-aware: the agent's resource declarations
    // decide whether anything is provisioned at all (general gets nothing),
    // and repo/ref carry resident-repo inference. A resident fallback comes
    // back with a named note (KTD10) that rides on every status frame below.
    // Unknown-head check (features/agent-review.md item 11): a review whose PR
    // head could not be resolved is a guaranteed refusal downstream — not
    // started instead, before any attach, one named reply (the decision and
    // the reply live in `checkPrHeadPreflight`; live incident 2026-08-30,
    // PR #300: 75 s and a model turn spent on a Slack-only "cannot review").
    const preflight = checkPrHeadPreflight({ agent, requestText: directives.text, repoCtx });
    if (!preflight.ok) {
      console.log(`[review] ${msg.threadKey} not started: PR head unknown (${preflight.where})`);
      await refuse("pr_head_unknown", async () => {
        await card.done(
          shell.close({ kind: "not_started", icon: "🔀", reason: "PR head unknown", ...closeLines(clock(), false) }),
        );
        await io.reply(preflight.reply);
      });
      return;
    }

    // The workspace attach is paired with its release on the round's agent
    // (reviewRound.ts, KTD4): readonly toolset → readonly worktree +
    // release("always"); writable → release("if-clean").
    let round: RoundWorkspace;
    try {
      // The attach is one `dispatch.workspace.attach` span naming its backend
      // (features/tracing.md): the setup step that takes minutes on a cold clone.
      round = await root.span("dispatch.workspace.attach", async (span) => {
        // The resident's own steps (clone, install, the mutex wait…) graft under
        // this span, rebased to its start (features/tracing.md item 19) — on a
        // failed attach too, where the trace says which step blew the budget.
        const graft = (steps: readonly ResidentStep[], residentTotalMs?: number) =>
          graftResidentSteps(steps, {
            parent: span,
            prefix: "dispatch.workspace.attach",
            baseAt: span.record().startedAt,
            clipAt: clock(),
            ...(residentTotalMs !== undefined ? { residentTotalMs } : {}),
          });
        let attached: Awaited<ReturnType<typeof attachRoundWorkspace>>;
        try {
          attached = await attachRoundWorkspace({
            factory: {
              execution: deps.config.config.execution,
              workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
              dataDir: deps.dataDir ?? "./data",
            },
            round: { threadKey: msg.threadKey, agent, repo: repoCtx.repo, ref: repoCtx.ref, headSha: repoCtx.headSha },
            logKey: msg.threadKey,
            span,
          });
        } catch (err) {
          const failed = residentTraceOf(err);
          if (failed) graft(failed.steps, failed.residentMs);
          throw err;
        }
        if (attached.selection.backend) span.setAttrs({ backend: attached.selection.backend });
        if (attached.selection.trace) graft(attached.selection.trace, attached.selection.attachMs);
        return attached;
      });
    } catch (err) {
      // Ask-once (KTD6): the resident has no ref binding for this thread, the
      // message named no branch, AND the resident did not name a default to
      // bind to (the factory binds to `defaultRef` itself when the 409 carries
      // one — only a Worker predating that field reaches here). Binding is
      // explicit-or-ask-once, never a silent guess. ONE clarifying question,
      // no model turn burned (mirrors the named-refusal reply shape). The
      // user's answer in the thread (e.g. "on main") carries the ref on the
      // next message and re-attach binds it.
      if (err instanceof ResidentNeedsRefError) {
        const repo = repoCtx.repo;
        await refuse("which_branch", async () => {
          await card.done(
            shell.close({ kind: "not_started", icon: "🌿", reason: "which branch?", ...closeLines(clock(), false) }),
          );
          await io.reply(
            `🌿 Which branch of \`${repo}\` should this thread work on? ` +
              `No branch is bound yet — reply naming one (e.g. "on main" or "on branch fix/login") and I'll pick it up from there.`,
          );
        });
        return;
      }
      throw err;
    }
    const { executor, note, resident, binding } = round.selection;

    // Attach-head check (features/agent-review.md item 10, #282): for a PR
    // review on the resident path, the sha the resident ATTACHED the worktree
    // at is compared with the PR head resolved above — before any model turn
    // (the comparison, the current-head second lookup and the refusal reply
    // live in `guardAttachedHead`). "adopted" means a push raced the request
    // and the worktree sits at the PR's head NOW: RepoContext adopts it and
    // the block says it was verified. "refused" means the branch moved while
    // the worktree was being attached: not started — one named reply, the
    // pool user released, no provider call.
    let verifiedAtAttach = false;
    if (!resume && agent.name === "review" && resident && repoCtx.pr !== undefined && repoCtx.repo) {
      const pr = { repo: repoCtx.repo, number: repoCtx.pr };
      const guard = await root.span("dispatch.gate.attached_head", async (span) => {
        const g = await guardAttachedHead({
          pr,
          expectedHeadSha: repoCtx.headSha,
          attached: { sha: binding?.sha, ref: binding?.ref },
          fallbackRef: repoCtx.ref,
          fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
          logKey: msg.threadKey,
        });
        span.setAttrs({ outcome: g.outcome });
        return g;
      });
      if (guard.outcome === "verified") {
        verifiedAtAttach = true;
      } else if (guard.outcome === "adopted") {
        repoCtx = { ...repoCtx, headSha: guard.headSha };
        verifiedAtAttach = true;
      } else if (guard.outcome === "refused") {
        const reply = guard.reply;
        await refuse("branch_moved", async () => {
          if (executor.release) await executor.release("always").catch(() => {});
          await card.done(
            shell.close({ kind: "not_started", icon: "🔀", reason: "branch moved", ...closeLines(clock(), false) }),
          );
          await io.reply(reply);
        });
        return;
      }
    }

    // Whether this run reviews a resolved PR (its system prompt carries the
    // REVIEW TARGET block, item 9) — the same predicate the post-step and the
    // head-settle key on.
    const isPrReview = agent.name === "review" && repoCtx.repo !== undefined && repoCtx.pr !== undefined;
    // Coding PR post-step gate (features/pr-description.md item 5): only a
    // writable-toolset run can have pushed a branch — readonly (review) and
    // none/web toolsets never trigger the post-step. The repo is deliberately
    // NOT part of the gate: a dispatch that resolved no slug can still open
    // the PR from the workspace's observed origin remote (an agent-discovered
    // repo; the App token bounds what is writable either way).
    const isCodingPrRun = agent.toolset === "full";
    // Progressive disclosure (#100): the calling agent's scoped skill
    // name+description list trails the agent's own instructions (it is
    // guidance about the agent's tools, not advisory context like the memory
    // block). Bodies load on demand via use_skill — never dumped here. No
    // store, or an agent with no scoped skills (general/research) → undefined
    // and the prompt is untouched.
    const skillsBlock = deps.skills ? skillGuidanceBlock(deps.skills, agent.name) : undefined;
    // External MCP tools (#394, features/mcp-tools.md item 8): discovery for
    // the servers scoped to THIS agent, once, before the model turn. A server
    // that does not answer contributes no tools and is named in the MCP block
    // (and, once the run is registered, in an `mcp_unavailable` note). Nothing
    // scoped — a process without MCP has the null source — → no tools, no
    // block, request unchanged.
    const mcpForRun = await root.span("dispatch.mcp_discovery", () =>
      deps.mcp.toolsFor(agent.name, { userId: msg.userId, channelId: msg.channelId }),
    );
    const mcpBlock = mcpGuidanceBlock(mcpForRun.servers);

    // Config awareness (routing-and-config behavior 8): tell the model the
    // RESOLVED agent/model/scope of this very run and how users tune it, so no
    // agent can confabulate "I'm stateless / nothing is tunable". Built from
    // the same `resolved`/`directives`/`sticky` values that selected the run,
    // so it can never describe a different state than the one executing.
    // Universal (every agent, every turn), a few lines, names only.
    const scopes = deps.config.scopes(msg.channelId, msg.userId);
    const configBlock = configAwarenessBlock({
      agentName: agent.name,
      modelRef: resolved.modelRef,
      effort: resolved.effort,
      channel: scopes.channel,
      user: scopes.user,
      messageDirective: { agent: directives.agent, model: directives.model, effort: directives.effort },
      threadDirective: { agent: sticky.agent, model: sticky.model, effort: sticky.effort },
      canEditChannelConfig: deps.config.canEditChannelConfig(msg.userId),
      mcp: {
        registryOn: deps.capabilities.mcp,
        served: mcpForRun.servers.filter((s) => s.toolCount !== undefined).map((s) => s.server),
        unavailable: mcpForRun.servers.filter((s) => s.unavailable !== undefined).map((s) => s.server),
      },
    });

    // Self-description (routing-and-config behavior 11): what Switchboard is —
    // agents, residents, runs, where the source and specs live — built from
    // the live agent registry, on every agent's prompt, so "how does your
    // resident system work?" is answered from fact instead of a public-web
    // 404 on our private repo.
    const aboutBlock = selfDescriptionBlock(AGENTS, deps.config.config.organization);

    // Custom instructions (#107 phase 2): the requester's user text + this
    // channel's text, as ONE advisory block. Read from the same resolved
    // scopes as the config block, AFTER resolution and every gate above — so
    // by construction they cannot influence agent, model, or permissions.
    // Absent (the default) → no block, prompt unchanged.
    const instructionsBlock = customInstructionsBlock(scopes);

    // Effective system prompt, composed AFTER executor resolution (via
    // RunOptions.system, U1) by the extracted composer (reviewRound.ts): a
    // resident-path run swaps in the agent's resident variant with the
    // resolved repo named and the worktree path when the attach answered it
    // (#282); a PR review gets the REVIEW TARGET block (item 9) recomposed
    // per pinned head. Order: memory (advisory context, leads when present) →
    // config block → custom instructions → the agent's effective instructions
    // (+ skills). The memory block is absent with memory off (default),
    // keeping the memory-off request byte-identical to a NullMemoryStore run.
    // Retrieval was started before the repo resolution and executor selection
    // above; by now it has usually landed. The shared AgentDef is never
    // mutated (concurrent dispatches share it).
    // The prompt waits on the memory read here: `dispatch.compose` is that wait
    // (the composition itself is synchronous).
    const memoryBlock = await root.span("dispatch.compose", () => memoryBlockP);
    const composeSystem = makeSystemComposer({
      agent,
      resident: resident === true,
      repo: repoCtx.repo,
      workspace: binding?.workspace,
      prTarget:
        isPrReview && repoCtx.repo && repoCtx.pr !== undefined
          ? { repo: repoCtx.repo, pr: repoCtx.pr, ref: repoCtx.ref, baseRef: repoCtx.baseRef }
          : undefined,
      blocks: {
        memory: memoryBlock,
        config: configBlock,
        about: aboutBlock,
        instructions: instructionsBlock,
        skills: skillsBlock,
        mcp: mcpBlock,
      },
    });
    // The PR head this run reviews — the resolved head, or the one adopted at
    // attach; the head settle (item 12) advances it after the model turn. The
    // post-step pins to it and the reviewed-head guard checks against it.
    let reviewHead = repoCtx.headSha;
    // The first turn's system, pinned to that head; a re-review recomposes its
    // own inside settleReviewedHead.
    // A resume re-sends the prompt the run started with, verbatim (plan D3):
    // memory retrieval and MCP discovery are not reproducible, and the model's
    // cached prefix and thinking blocks are bound to it.
    const system = resume ? resume.row.system : composeSystem({ sha: reviewHead, verified: verifiedAtAttach });

    if (note) shell.setLabel(`${shell.label} · ${oneLine(note)}`);
    console.log(`[run] ${msg.threadKey} user=${msg.userId} agent=${agent.name} model=${resolved.modelRef}`);
    setupCard = undefined; // from here the run loop owns the card's close
    clearInterval(setupHeartbeat);
    card.update(shell.live()); // the ack card becomes the run card
    let lastActivityAt = clock();
    // Live run view (Area 2 / #43): register the run and mint its capability
    // link AFTER the card exists (so nothing awaits between create() and the
    // run loop's finally that finish()es it). With no PUBLIC_BASE_URL the link
    // is simply omitted — the feature degrades gracefully, the run is otherwise
    // unchanged. Events are fed to the registry in onEvent below.
    const registry = deps.runRegistry ?? defaultRunRegistry;
    // A human-first label for the Access-gated runs index (`GET /runs`): agent +
    // repo (repo runs) or channel/user (chat runs) + a snippet of the request,
    // so a row reads like `review · #switchboard-prompting · justin · "…"` rather
    // than raw ids. Built from the directive-stripped text so directives (agent:/
    // model:) never clutter the snippet.
    const runLabel = composeRunLabel({
      agent: agent.name,
      repo: repoCtx.repo,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: directives.text,
    });
    // The registry redacts and caps the label; `run.label` is the one the record
    // and the friction row carry (never `runLabel`, which may hold a pasted secret).
    const channelVisibility = await root.span("dispatch.channel_visibility", () =>
      channelVisibilityOf(deps, msg.channelId),
    );
    const run = registry.create(
      runLabel,
      {
        agent: agent.name,
        model: resolved.modelRef,
        channelId: msg.channelId,
        userId: msg.userId,
        threadKey: msg.threadKey,
        channelVisibility,
        ...(resume ? {} : { receivedAt }), // the window opens at receipt (features/tracing.md); a resume keeps its original stamps
        ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
        ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
        ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
      },
      resume ? { id: resume.row.runId, replay: resume.events, startedAt: resume.row.startedAt } : {},
    );
    // The run's stream now carries the request's spans: the setup so far is
    // backfilled, everything from here is live (features/tracing.md item 6).
    trace.bindRun(run.id, (e) => registry.publish(run.id, e));
    if (resume) {
      console.log(
        `[resume] ${msg.threadKey} run ${run.id} continues under ${deps.runLedger.gen}: from step ${resume.plan.step}, ${resume.plan.settlements.length} call(s) to settle, ${resume.events.length} event(s) replayed`,
      );
    }
    io.runStarted?.({ id: run.id });
    // The narrative events the dispatcher itself publishes — the request, the
    // thread context, the final answer — go straight to the registry: redacted
    // like every event, uncapped (the run record is the source of truth; the
    // registry's byte-bounded backlog and the record's per-event budget bound
    // persistence), never through onEvent (no card refresh, no friction input),
    // and logged as ONE line of type + byte-length — never the text, which may
    // span lines or carry what redaction missed.
    const publishText = (
      type: "input" | "context" | "answer",
      text: string,
      source?: { url?: string; channel?: string; user?: string },
      raw?: string,
    ) => {
      const redacted = redactSecrets(text);
      const event = { type, text: redacted, ...(source ? { source } : {}), at: clock() };
      // The model's raw answer rides on the event only when normalization
      // changed it AND the event still fits the per-event byte budget — the
      // budget already truncates `text` and must not be starved by a second
      // copy (features/llm-output.md item 5).
      const withRaw = raw !== undefined ? { ...event, raw: redactSecrets(raw) } : event;
      registry.publish(run.id, utf8ByteLength(JSON.stringify(withRaw)) <= MAX_EVENT_BYTES ? withRaw : event);
      console.log(`[event] ${msg.threadKey} type=${type} bytes=${utf8ByteLength(redacted)}`);
    };
    // The request is the first event of the run record (live-view item 12): the
    // directive-stripped text, humanized (Slack `<url|label>`/mention markup
    // unwrapped, entities unescaped — it is channel-authored mrkdwn, not prose)
    // + an attachment count.
    // Slack-authored text is humanized (`<url>`/mention markup unwrapped,
    // entities unescaped — it is mrkdwn, not prose); every other channel's text
    // is recorded exactly as it was dispatched to the model, so the record never
    // diverges from the input.
    const humanize = isMrkdwnChannel(msg.channelId);
    const attachments = attachmentSuffix(msg.images, msg.documents);
    const source = {
      ...(msg.sourceUrl ? { url: msg.sourceUrl } : {}),
      ...(msg.channelName ? { channel: msg.channelName } : {}),
      ...(msg.userName ? { user: msg.userName } : {}),
    };
    const request = humanize ? humanizeMessageText(directives.text) : directives.text;
    if (!resume)
      publishText(
        "input",
        attachments ? `${request} ${attachments}` : request,
        Object.keys(source).length > 0 ? source : undefined,
      );
    // What the run is about (live-view item 19): agent, model, and the repo
    // context resolved above — so the page can head the record with linked
    // owner/repo · ref · #PR · sha. Once per run, straight after the request.
    if (!resume)
      registry.publish(run.id, {
        type: "run_meta",
        agent: agent.name,
        model: resolved.modelRef,
        traceId: root.traceId,
        ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
        ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
        ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
        ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
        ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
        at: clock(),
      });
    const liveUrl = liveViewLink(run.id, run.token);
    const liveLink = liveUrl ? { url: liveUrl, label: "Live run" } : undefined;
    shell.setLink(liveLink);
    // The thread's live slot now names its run: a follow-up's ack/refusal can
    // link the run page (thread-admission item 1), and the finally reads this
    // control to tell a stopped run from one that ended by itself (item 4).
    admitted.runId = run.id;
    if (liveUrl) admitted.runLink = liveUrl;
    liveControl = run.control;
    // The thread context fed to the model follows the request as `context`
    // events (#157, KD1) — text only, attachments as metadata lines, bounded to
    // the newest CONTEXT_MAX_ITEMS turns within CONTEXT_MAX_BYTES.
    if (!resume && deps.config.config.runHistory?.includeContext !== false) {
      for (const text of contextMessageTexts(history, humanize)) publishText("context", text);
    }
    // Tombstone-first (#375): a provisional TERMINAL record — status
    // `interrupted`, `finishedAt` = `startedAt` — goes to the store now, built
    // from the events published so far (request, run_meta, context). Because it
    // is already terminal, a crash or a drain-abandonment needs NO store-side
    // fixup by the next container: the tombstone is already the truth (its
    // `finishedAt` stays the start time — nobody knows the real death time of a
    // crash). The finish write below replaces it (same-id upsert) for every run
    // that ends normally, and the drain deadline upgrades it with the full
    // transcript for a run it abandons. Fire-and-forget through the same writer
    // (retry + drain accounting), but `provisional`: `onPersisted`/
    // `markPersisted` must NOT run — the index's persisted flag means "finished
    // and durably stored". Synchronous assembly over a handful of bounded
    // events; the first model call is not delayed.
    if (!resume) {
      const startSnap = registry.snapshot(run.id, run.token);
      if (startSnap) {
        deps.runHistoryWriter.write(
          assembleRunRecord({
            run,
            snap: startSnap,
            agent: agent.name,
            model: resolved.modelRef,
            msg,
            channelVisibility,
            repo: repoCtx.repo,
            finishedAt: startSnap.startedAt,
            status: "interrupted",
            diagnosis: analyzeRunFriction(startSnap.events, {
              finished: false,
              truncated: startSnap.truncated,
              schema: SPAN_SCHEMA,
            }),
          }),
          { provisional: true },
        );
      }
    }
    // The ledger claim (features/run-history.md item 35): the run's row on the
    // state Worker, with everything a resume must hand the model again — the
    // composed system prompt and the tool definitions verbatim, the card, the
    // repo context — plus the conversation as its seed. Claimed HERE, once the
    // prompt exists, not at the in-process admission above: a row without a
    // prompt could not be resumed. Awaited (one round trip per run) so the
    // first step's record never precedes its claim. An untracked run (a stale
    // row on the thread, no routes, a claim that kept failing) runs exactly as
    // before — the write-through warned once.
    if (!resume) {
      const ledger = deps.runLedger;
      const opened = await root.span("dispatch.ledger_claim", () =>
        ledger.open({
          runId: run.id,
          threadKey: msg.threadKey,
          startedAt: registry.snapshot(run.id, run.token)?.startedAt ?? clock(),
          meta: {
            agent: agent.name,
            model: resolved.modelRef,
            channelId: msg.channelId,
            userId: msg.userId,
            threadKey: msg.threadKey,
            channelVisibility,
            ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
            ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
            ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
            ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
            ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
            ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
            ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
            readonly: agent.toolset === "readonly",
            selection: resident === true ? "resident" : "sandbox",
            ...(binding?.workspace !== undefined ? { workspace: binding.workspace } : {}),
          },
          card: card.handle ?? null,
          system,
          tools: mergeTools(TOOLSETS[agent.toolset] ?? [], mcpForRun?.tools).map(
            ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
          ),
          seed: { messages, budgetMs: agent.maxMinutes * 60_000 },
          // A stop asked of another container (`/runs/stop` there) reaches this
          // run through its heartbeat and is honored like a local one; a fence
          // (another generation took the run) is a hard stop — nothing more may
          // run or reply here (D9).
          onStop: (mode) => void run.control.requestStop(mode),
          onFenced: () => void run.control.requestStop("hard"),
        }),
      );
      if (opened) {
        ledgerRun = opened;
        // Every event published so far (the request, run_meta, context) and
        // every one to come, in `seq` order, through the batched flusher. The
        // ledger is a store: the viewer replay budget never applies to it.
        registry.subscribe(run.id, run.token, {
          onEvent: (event, seq) => opened.event(event, seq),
          ...REPLAY_EVERYTHING,
        });
      }
    }
    if (resume && ledgerRun) {
      // The events before the restart are on the ledger already (and in the
      // registry by replay); only what this generation publishes is appended.
      const adopted = ledgerRun;
      registry.subscribe(run.id, run.token, {
        onEvent: (event, seq) => adopted.event(event, seq),
        afterSeq: resume.lastSeq,
        ...REPLAY_EVERYTHING,
      });
    }
    // The card body is the agent's own checklist (via the update_status tool)
    // plus a live one-line activity trace (current tool call + redacted result
    // summary) so the card reflects progress per tool event, not only on the
    // 5s heartbeat. Full command output still goes to stdout for operators.
    // On a resume the dispatcher-local state comes back from the row (item 38):
    // the checklist the card shows, the verdict/description already submitted,
    // the branch already pushed.
    const restored = resume?.row.state ?? {};
    let checklist: string | undefined = typeof restored.checklist === "string" ? restored.checklist : undefined;
    let lastActivity: string | undefined;
    // The tool whose call has no result yet — the title says the wait is the
    // tool's (`running bash (Ns)`), not the model's (`thinking …`), #531.
    let inFlightTool: string | undefined;
    // The shutdown notice rides on the LIVE frame only: the closed card is
    // built from `shell.close` and never mentions the restart.
    const currentFrame = () =>
      shell.live({
        suffix: quietSuffix(clock() - lastActivityAt, inFlightTool),
        notice: shutdownNotice,
        detail: [checklist, lastActivity],
      });
    // The closed card keeps the run link (the run page outlives the run and
    // shows the final answer) and the agent's checklist; only the transient
    // activity trace is dropped. On a clean ✅ finish every item is marked ✓ —
    // the run completing IS the proof they happened, and the model rarely
    // re-posts the checklist after its last step; a stop/failure keeps the
    // honest partial state.
    const finalDetail = () => checklist;
    const checkedOffDetail = () => checklist?.replace(/^(\s*)[○✱](?=\s)/gm, "$1✓");
    // The runner's progress notes carry the 💭 thought line at each model turn
    // (features/tracing.md): the card shows it as activity, as it showed the
    // `turn` event before spans replaced it.
    const onProgress = (note: string) => {
      console.log(`[note] ${msg.threadKey} ${note}`);
      lastActivityAt = clock();
      lastActivity = note;
      card.update(currentFrame());
    };
    // Live run-visibility (Area 2): each tool call/result refreshes the card
    // immediately, so activity is visible without waiting for the heartbeat.
    let toolCalls = 0; // "did real work" signal for the memory reflection gate
    // The branch the run's own `git push` named, read off its bash calls and
    // results as they stream by (features/pr-description.md item 5, #458):
    // the PR post-step opens from THIS branch, and from the checkout only
    // when no push was observed — the checkout can move between the push and
    // the post. The latest push wins.
    const pushes = trackPushedBranch(typeof restored.pushedBranch === "string" ? restored.pushedBranch : undefined);
    // The registry backlog is the run's ONE event store (#157 KTD9): the live
    // page, the post-run friction diagnosis and the run record all read it back
    // via `registry.snapshot` — there is no second copy to drift from it.
    let recordedPushedBranch: string | undefined;
    const onEvent = (e: RunEvent) => {
      registry.publish(run.id, e); // feed the external live-view stream
      if (isSpanRecord(e)) return; // timing, not activity (features/tracing.md): the card and its clock ignore it
      if (e.type === "tool_call") toolCalls++;
      if (isCodingPrRun) {
        pushes.observe(e);
        const pushedBranch = pushes.branch();
        if (pushedBranch !== undefined && pushedBranch !== recordedPushedBranch) {
          recordedPushedBranch = pushedBranch;
          ledgerRun?.setState({ pushedBranch });
        }
      }
      inFlightTool = inFlightToolAfter(inFlightTool, e);
      lastActivityAt = clock();
      lastActivity = activityLine(e);
      console.log(`[tool] ${msg.threadKey} ${lastActivity}`);
      card.update(currentFrame());
    };
    // A configured MCP server that did not answer discovery is a fact of the
    // run (features/mcp-tools.md item 8): one note per server, before the
    // first tool event, so the run page explains a missing tool.
    for (const s of mcpForRun?.servers ?? []) {
      if (s.unavailable !== undefined)
        onEvent({
          type: "run_note",
          kind: "mcp_unavailable",
          summary: `MCP server ${s.server} unavailable: ${s.unavailable}`,
        });
    }
    const reportProgress = (list: string) => {
      const trimmed = list.trim();
      // An empty update never erases the checklist: the closed card is the
      // run's durable progress record, and an agent "clearing" its status as
      // it wraps up would blank it (seen live 2026-08-30 on a review card).
      if (!trimmed) return;
      checklist = trimmed;
      ledgerRun?.setState({ checklist: trimmed });
      card.update(currentFrame());
    };
    // Heartbeat: the card ticks every 5s no matter what. A ticking timer means
    // the run is alive; a stopped timer means the process died — the reader
    // can always tell the difference.
    const heartbeat = setInterval(() => card.update(currentFrame()), 5000);

    // Reading-diff artifacts (features/reading-diff.md): a PR review run gets
    // the change as a reviewer reads it, produced CONCURRENTLY with the review
    // by the run's own executor (read-only commands; the resident runs execs
    // beside the model's) and published straight to the registry like the
    // other dispatcher facts. The git BASELINE is guaranteed: the dispatcher
    // joins it before the answer publish below (a join on a seconds-long
    // command started here — never a timeout race). meat, when configured, is
    // an UPGRADE artifact under its own runtime budget, never awaited: it
    // lands iff it finishes within the review (a later publish is dropped by
    // the registry's finished-run rule, and the baseline still stands).
    let readingDiffBaseline: Promise<boolean> | undefined;
    if (agent.name === "review" && repoCtx.pr !== undefined) {
      // Two background spans (features/tracing.md): concurrent with the loop,
      // structure for the partition, never a counted term — started under the
      // root inside `startReviewReadingDiff`, so each diff's exec is a child.
      const started = startReviewReadingDiff({
        executor,
        cfg: deps.config.config.review?.readingDiff,
        env: process.env,
        baseRef: repoCtx.baseRef,
        publish: (e) => registry.publish(run.id, e),
        parent: root,
      });
      readingDiffBaseline = started.baseline.then((published) => {
        console.log(`[reading-diff] ${msg.threadKey} baseline ${published ? "published" : "none"}`);
        return published;
      });
      const upgrade = started.upgrade;
      if (upgrade)
        void upgrade.then((published) => {
          console.log(`[reading-diff] ${msg.threadKey} meat ${published ? "published" : "did not land"}`);
        });
    }

    let answer: string;
    // Review verdict, set only through the structured submit_verdict tool; the
    // post-step below turns it into the deterministic first line of the GitHub
    // body (fail-closed: no call → not approving). See reviewVerdict.ts.
    // Ledger state is a system boundary: the row's verdict and description are
    // re-validated through the same parsers the tools use, never trusted as-is.
    let verdict: ReviewVerdict | undefined =
      typeof restored.verdict === "object" && restored.verdict !== null
        ? (parseVerdictInput(restored.verdict as Record<string, unknown>) ?? undefined)
        : undefined;
    const onVerdict = (v: ReviewVerdict) => {
      verdict = v;
      ledgerRun?.setState({ verdict: v });
    };
    // Coding PR description, set only through the structured
    // submit_pr_description tool (the last valid call wins — a resubmit after
    // a fix-up push supersedes the earlier one); the post-step below renders
    // the GitHub body from it at the observed pushed head and opens/edits the
    // PR. See prDescription.ts.
    const restoredDescription = PrDescriptionSchema.safeParse(restored.prDescription);
    let prDescription: PrDescription | undefined = restoredDescription.success ? restoredDescription.data : undefined;
    const onPrDescription = (d: PrDescription) => {
      prDescription = d;
      ledgerRun?.setState({ prDescription: d });
    };
    // The commit actually checked out in the run's workspace when the model
    // finished — read by us, not reported by the model — for the reviewed-head
    // guard below. Undefined when the cwd is not a git repo (cold sandbox root).
    let observedHead: string | undefined;
    // The PR head branch (coding runs), read alongside it for the PR
    // post-step: the branch the run's push named, else the checked-out branch.
    // Undefined when unreadable or detached ("HEAD" is not a branch — nothing
    // a PR could be opened from) with no push observed.
    let observedBranch: string | undefined;
    // The branch checked out when the workspace was observed — the same as
    // observedBranch unless HEAD moved after the push (#458), in which case
    // observedHead is the PUSHED branch's tip, not HEAD.
    let observedCheckedOut: string | undefined;
    // The commit the remote holds for that branch (`git ls-remote origin
    // refs/heads/<branch>`), the post-step's proof of a push: the branch
    // counts as pushed only when this matches the observed head. Undefined
    // when the remote has no such branch or could not be asked.
    let observedRemoteHead: string | undefined;
    // `owner/name` parsed from the workspace's origin remote, probed only when
    // the dispatch resolved no repo (the agent discovered the repo itself) —
    // the PR-open repo of last resort.
    let observedRemoteRepo: string | undefined;
    // The PR post-step's reply note: assembled in the try below — the open
    // runs BEFORE the stream finishes, so its outcome is a fact of the run —
    // and appended to the channel reply at the end.
    let prNote: string | undefined;
    // Set when the head moved during the run by a rebase of the same commits
    // (item 12): the post is pinned to `current` with a footer, and the thread
    // is told the review was carried forward.
    let carried: { reviewed: string; current: string; commits: number } | undefined;
    let runFailed = false; // the runner threw → terminal status `failed`
    let runDiagnosis: FrictionDiagnosis | undefined; // the finish-site diagnosis: the done card's shape line
    // Give the workspace back now rather than at the inactivity sweep: a
    // resident's pool user is a scarce slot (features/resident-repos.md item
    // 16a). The release mode is paired to the round's agent by the attach
    // helper (reviewRound.ts): read-only agents hold nothing worth keeping; a
    // coding run keeps its worktree only while it has uncommitted/unpushed
    // work — unless an operator HARD-stopped it (#101), which means "tear it
    // down now": the abandoned command may still be running in there, and the
    // whole point of a hard stop is to free the resources. Best-effort — a
    // failed release is a log line, never a failed run. Called AFTER the
    // answer has been sent (or the failure card closed): the `/detach` round
    // trip is bounded at 10 s on a sick resident, and nothing about the reply
    // depends on it, so it must never sit between "answer ready" and the
    // thread. Hard-stop is read at CALL time — it may land during the run.
    // Under `post.workspace_release`: the release's own call is that span's child.
    const releaseWorkspace = (span?: Span) =>
      round.release({ hardStopped: run.control.requested === "hard", ...(span ? { span } : {}) });
    // One tool context for the whole run: the first turn and any re-review
    // turn (settleReviewedHead) share it, so submit_pr_description and the
    // progress checklist keep flowing to the same hooks.
    const toolContext = {
      executor,
      reportProgress,
      web: webCapability(),
      skills: deps.skills,
      github: githubCapabilityFor(deps, msg.userId),
      agentName: agent.name,
      onVerdict,
      onPrDescription,
    };
    try {
      answer = await runAgent({
        provider,
        model,
        agent,
        messages,
        system,
        effort: resolved.effort,
        toolContext,
        ...(mcpForRun && mcpForRun.tools.length > 0 ? { extraTools: mcpForRun.tools } : {}),
        onProgress,
        onEvent,
        span: root, // the loop is `run.agent` under the run's root (features/tracing.md)
        ...(round.selection.backend ? { backend: round.selection.backend } : {}),
        control: run.control, // operator stop from /runs (#101)
        inbox: admitted.inbox, // thread follow-ups steered into this run (thread-admission item 2)
        // The step record before each step's tools (run-history item 35).
        ...(ledgerRun ? { onStep: ledgerRun.step.bind(ledgerRun) } : {}),
        // A resume re-enters the loop from the plan (run-history item 37).
        ...(resume
          ? {
              resume: {
                settlements: resume.plan.settlements,
                stepRecorded: resume.plan.stepRecorded,
                inboxConsumedSeq: resume.plan.inboxConsumedSeq,
                turn: resume.plan.turn,
                iteration: resume.plan.iteration,
                remainingMs: resume.plan.remainingMs,
              },
            }
          : {}),
      });
      // Reviewed-head settle (features/agent-review.md items 8 + 12,
      // settleReviewedHead in reviewRound.ts): for a PR review, read the
      // workspace HEAD NOW — after the model is done, BEFORE the finally
      // below releases the workspace — and reconcile a PR head that moved
      // during the run: adopt the current head when the run reviewed it,
      // carry the review across a rebase of the same commits, or void the
      // verdict and re-review ONCE at the new head (worktree moved, prompt
      // recomposed, one more model turn). A hard stop observes nothing and
      // settles nothing.
      if (isPrReview && repoCtx.repo && repoCtx.pr !== undefined && run.control.requested !== "hard") {
        const settled = await settleReviewedHead({
          span: root,
          pr: { repo: repoCtx.repo, number: repoCtx.pr },
          baseRef: repoCtx.baseRef,
          reviewHead,
          verdict,
          answer,
          messages,
          composeSystem,
          executor,
          turn: {
            provider,
            model,
            agent,
            effort: resolved.effort,
            toolContext,
            extraTools: mcpForRun?.tools,
            onProgress,
            onEvent,
            control: run.control,
            ...(round.selection.backend ? { backend: round.selection.backend } : {}),
          },
          fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
          fetchPrCommits: deps.fetchPrCommits ?? prCommitsSince,
          notify: {
            reply: (text) => io.reply(text),
            headMoved: (suffix) => {
              shell.setLabel(`${shell.label} · ${suffix}`);
              card.update(currentFrame());
            },
          },
          logKey: msg.threadKey,
        });
        answer = settled.answer;
        verdict = settled.verdict;
        reviewHead = settled.reviewHead;
        observedHead = settled.observedHead;
        carried = settled.carried;
      }
      // PR post-step observation (features/pr-description.md item 5): for a
      // writable coding run, read the workspace's head branch — the one the
      // run's `git push` named, else the checkout — its tip, and the remote's
      // head for that branch NOW — after the model is done, BEFORE the
      // finally below can release the workspace (a resident re-attach would
      // show the ref's current tip, not what this run pushed). The cold path
      // clones into a SUBDIRECTORY of the workspace root, so a failed root
      // HEAD probe discovers the single clone and re-probes inside it; with
      // no dispatch-resolved repo the origin remote is read too (an
      // agent-discovered repo). Best-effort: a failed probe leaves its field
      // undefined and the post-step reports honestly instead of guessing. A
      // hard stop tore the work down mid-flight — nothing observed, nothing
      // posted.
      if (isCodingPrRun && run.control.requested !== "hard") {
        const pushedBranch = pushes.branch();
        const observed = await root.span("run.observe_workspace", () =>
          observeCodingWorkspace(executor, {
            probeRemote: repoCtx.repo === undefined,
            ...(pushedBranch !== undefined ? { pushedBranch } : {}),
          }),
        );
        observedHead = observed.head;
        observedBranch = observed.branch;
        observedCheckedOut = observed.checkedOut;
        observedRemoteHead = observed.remoteHead;
        observedRemoteRepo = observed.remoteRepo;
      }
      // The accepted PrDescription is a fact of the run: publish it as a typed
      // event BEFORE the finally below finish()es the stream, string fields
      // redacted like every payload, so the run page's review panel renders
      // the same object the GitHub body is rendered from.
      if (prDescription) {
        registry.publish(run.id, {
          type: "pr_description",
          description: redactPrDescription(prDescription),
          at: clock(),
        });
      }
      // Deterministic coding PR post-step (features/pr-description.md item 5,
      // agent-coding.md item 2, runCodingPrPostStep in codingPrPostStep.ts):
      // a writable coding run that pushed a branch and submitted its typed
      // PrDescription gets its PR opened — or edited, the open-or-edit
      // idempotency lives in githubPulls — HERE, in the bot process, BEFORE
      // the finally below finish()es the stream, so the outcome lands in the
      // run record as a typed `pr_opened` event and not only in a console
      // line. The base is the PR's true base ref when the thread's context
      // came from a PR (a fix round repushes the PR's OWN head branch, so the
      // binding ref equals the branch and is NOT the merge base), else the
      // thread's resident binding ref, else the dispatch's resolved ref —
      // binding is only ever set on the resident path (factory.ts), so no
      // resident check is needed. The note rides on the final reply below. A
      // hard stop observed nothing above and posts nothing.
      if (isCodingPrRun && run.control.requested !== "hard") {
        prNote = await root.span("run.pr_post_step", () =>
          runCodingPrPostStep({
            observed: {
              head: observedHead,
              branch: observedBranch,
              checkedOut: observedCheckedOut,
              remoteHead: observedRemoteHead,
              remoteRepo: observedRemoteRepo,
            },
            description: prDescription,
            target: {
              repo: repoCtx.repo,
              baseRef: repoCtx.baseRef,
              bindingRef: binding?.ref,
              resolvedRef: repoCtx.ref,
            },
            openPullRequest: deps.openPullRequest ?? openPullRequest,
            fetchRepoInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
            publish: (e) => registry.publish(run.id, e),
            logKey: msg.threadKey,
          }),
        );
      }
      // The run record is the source of truth and Slack/GitHub are projections
      // of it: publish the final answer into the stream FIRST (redacted like
      // every event, uncapped — a soft stop's "findings so far" included; a
      // re-review's answer supersedes the first one, which is not the run's
      // answer). It MUST precede the finally below: `finish()` runs there, and a
      // publish on a finished run is a silent no-op. Only after that is the
      // reply sent.
      // Join the reading-diff BASELINE so it is in the record before finish()
      // (which drops later publishes). This is a join on the git command fired
      // at run start, not a timeout: by now it finished minutes ago. The meat
      // upgrade is deliberately NOT awaited — see the comment at the start.
      const baseline = readingDiffBaseline;
      if (baseline) await root.span("run.reading_diff_join", () => baseline);
      // Typed-output boundary (features/llm-output.md item 5): the answer is
      // canonicalized ONCE here, so the event text, the channel reply, the
      // GitHub post, and memory all read one Markdown dialect; the model's raw
      // text rides on the event only when normalization changed it.
      const acceptedAnswer = markdownOutput.parse(answer);
      const rawAnswer = acceptedAnswer.ok && acceptedAnswer.changed ? answer : undefined;
      if (acceptedAnswer.ok) answer = acceptedAnswer.value;
      publishText("answer", answer, undefined, rawAnswer);
    } catch (err) {
      runFailed = true;
      await root.span("post.workspace_release", (span) => releaseWorkspace(span));
      throw err;
    } finally {
      clearInterval(heartbeat);
      const stopped = run.control.requested;
      const status: RunStatus = runFailed
        ? "failed"
        : stopped === "hard"
          ? "stopped_hard"
          : stopped === "soft"
            ? "stopped_soft"
            : "completed";
      // Close the live-view stream and start the TTL, handing the registry the
      // terminal status so every summary projects it (the index, `runs list`)
      // instead of re-deriving it. The one status the registry cannot know is
      // `failedAfterFinish` (a reply that throws AFTER the loop): the record
      // says `failed`, the registry row keeps `completed` for its TTL.
      registry.finish(run.id, status);
      // The registry backlog is read back ONCE here, synchronously at finish
      // (#157 KTD4/KTD9): it feeds both the friction diagnosis and the run
      // record. Reading it now, not after the reply, is what makes a slow reply
      // safe — the registry evicts a finished run after its TTL, and the record
      // must not depend on winning that race. Skipped entirely when neither
      // consumer is wired (nothing to diagnose for, nothing to persist). The
      // backlog is byte-bounded (oldest evicted), so the diagnosis is told when
      // it is looking at a head-truncated stream. Read with or without a
      // writer: the closed card's shape line comes from this diagnosis too.
      const snap = registry.snapshot(run.id, run.token);
      const events = snap?.events ?? [];
      const finishedAt = snap?.finishedAt ?? clock(); // the registry's finish clock: row and record agree
      // The diagnosis over the run's window (features/tracing.md): its shape is
      // what the closed card and the record carry.
      const diagnosis = analyzeRunFriction(events, {
        finished: true,
        truncated: snap?.truncated ?? false,
        schema: SPAN_SCHEMA,
        window: { start: snap?.receivedAt ?? startedAt, end: finishedAt },
      });
      runDiagnosis = diagnosis;
      // The channel's receipt (id + terminal status, never the token): a
      // single-shot channel hands it to its caller — the Worker shim records a
      // scheduled firing's run from it (#244).
      io.runFinished?.({ id: run.id, status });
      // The run finished: it is sealed by the next drain (after the reply), and
      // its record — everything captured now, assembled after the seal — is
      // written by that drain. The card's total stops at the finish stamp.
      ending.finished(run.id);
      shell.freeze(finishedAt);
      // A tracked run finishes through the ledger: the record replaces its
      // live rows in one transaction (a refused finish falls back to the store).
      ending.register({
        runId: run.id,
        flipOnPostFinishFailure: true,
        write: (seal, failedAfterFinish) =>
          deps.runHistoryWriter.write(
            assembleRunRecord({
              run,
              snap,
              agent: agent.name,
              model: resolved.modelRef,
              msg,
              channelVisibility,
              repo: repoCtx.repo,
              finishedAt,
              status: failedAfterFinish && status === "completed" ? "failed" : status,
              diagnosis,
              seal,
            }),
            { span: root, ...(ledgerRun ? { via: ledgerRun.sink } : {}) },
          ),
      });
      // The diagnosis rides the run record (above): the friction ledger the
      // cross-run proposer reads (#84) is run history, so nothing is written twice.
      // A run whose loop threw closes its card here, after the finish, so the
      // card's total is the run's; the outer catch replies and drains.
      if (runFailed)
        await root
          .span("post.card_close", () =>
            card.done(shell.close({ kind: "done", icon: "❌", detail: finalDetail(), ...doneLines(diagnosis) })),
          )
          .catch(() => {});
    }

    // The card's final icon tells the stop apart from a normal finish: ⏹ soft
    // (a summary was written), ⛔ hard (aborted, no summary).
    const stopped = run.control.requested;
    console.log(`[done] ${msg.threadKey} ${answer.length} chars${stopped ? ` (stopped: ${stopped})` : ""}`);

    // The coding PR post-step ran INSIDE the try above (before the stream
    // finished — its outcome is the `pr_opened` event); `prNote` carries what
    // it has to say to the thread.
    // `finally`, not sequential: a Slack failure in either call (outage, an
    // unchunkable line) must still give the pool user back, or it is held
    // until the hourly sweep — the toil 16a exists to avoid.
    try {
      // `live → finishing` on the ledger BEFORE anything reaches the thread
      // (item 35): the double-answer protection once runs resume — a
      // generation that lost the run is refused here and must not reply.
      // The status the record will carry rides on the row first, so a reclaim
      // of a `finishing` row (replied, died before `finish`) closes it
      // truthfully. A `fenced` answer means another generation reclaimed this
      // run while it ran (a handoff, or a lease that lapsed) and is driving it
      // now: nothing more reaches the thread from here — the record is theirs.
      ledgerRun?.setState({ finalStatus: stopped ? `stopped_${stopped}` : "completed" });
      if ((await root.span("post.ledger_finishing", () => ledgerRun?.finishing())) === "fenced") {
        // Nothing more from here: no reply, no card close, and no record — the
        // run is the other generation's now and its record is theirs to write
        // (a partial record from this process could race the real finish). The
        // outer finally still seals the stream here.
        console.log(`[run] ${msg.threadKey} run ${run.id}: another generation owns this run — not replying`);
        ending.drop(run.id);
        return;
      }
      // A review verdict carries its run link (as standard Markdown — each
      // adapter renders its own dialect): the verdict message is what gets
      // scanned in the review loop, and the card above scrolls away. Projection
      // only — the `answer` event published above and the GitHub post body stay
      // link-free.
      const channelAnswer = agent.name === "review" && liveUrl ? `${answer}\n\n[Live run](${liveUrl})` : answer;
      // The PR note (post-step above) is a projection too: the `answer` event
      // stays the model's own words — the PR facts live in the pr_description
      // event and the [pr-post] log line.
      // The card close, the reply, then the drain: the run is sealed with how
      // the reply went and its record (#157 KTD4) goes to the store — BEFORE the
      // workspace release below: the record does not depend on it, and on the
      // ledger the finish is what frees the thread, which must not wait ~90 s on
      // a sandbox teardown (features/run-history.md item 36). Fire-and-forget;
      // the writer's `pending()` is incremented inside the drain, before the
      // outer finally's `activeRuns--`, so the shutdown drain never observes
      // "0 runs, 0 writes". A reply that threw still seals (`replyOk: false`)
      // and writes (`failed`) here, then reaches the outer catch for the error
      // reply.
      await ending.sealAfterReply(
        () =>
          root.span("post.card_close", () =>
            card.done(
              shell.close({
                kind: "done",
                icon: stopped === "hard" ? "⛔" : stopped === "soft" ? "⏹" : "✅",
                detail: stopped ? finalDetail() : checkedOffDetail(),
                ...doneLines(runDiagnosis),
              }),
            ),
          ),
        () => root.span("post.reply", () => io.reply(prNote ? `${channelAnswer}\n\n${prNote}` : channelAnswer)),
      );
    } finally {
      await root.span("post.workspace_release", (span) => releaseWorkspace(span));
    }

    // Cross-session memory (Area 7c, #85) — WRITE path. AFTER the reply has
    // landed, distill this run into memory records: fire-and-forget (tracked
    // only for the shutdown drain), so its latency/failures never reach the
    // user; gated on memory.enabled (default off → nothing happens) and on the
    // run having done real work (tools used, or a long thread) and not being a
    // `review` run (#292: findings live on the PR; distilling them floods org
    // memory with per-PR ephemera). Fast paths above returned before this
    // point and never reflect. A HARD-stopped run has no summary to distill
    // (its answer is the abort line), so it is skipped too; a soft stop wrote
    // a real finale and reflects normally.
    if (stopped !== "hard")
      scheduleReflection({
        cfg: deps.config.config.memory,
        store: deps.memory,
        providers: deps.providers,
        runModelRef: resolved.modelRef,
        gate: { toolCalls, historyTurns: history.length, agentName: resolved.agentName },
        threadKey: msg.threadKey,
        runId: run.id,
        // The writes are the policy's decision for the run's principal under the
        // run's stamped origin (authorization.md item 8): the same actor the chat
        // commands resolve, the same stamp the record carries.
        actor: resolveChatActor(msg, (id) => deps.config.grantsFor(id)),
        originChannelVisibility: channelVisibility,
        organization: deps.config.config.organization,
        userId: msg.userId,
        channelId: msg.channelId,
        repo: repoCtx.repo,
        history,
        request: directives.text,
        answer,
      });

    // Deterministic review post-step (issue #69, runReviewPostStep in
    // reviewRound.ts): a `review` run against a resolved PR posts its findings
    // back to that PR by default — no need to ask — behind the reviewed-head
    // guard (item 8, fail-closed) and pinned to the verified head (or the
    // carried one, item 12). Best-effort: a post failure is logged and said in
    // the thread but never fails the dispatch (the review already landed in
    // Slack). A HARD-stopped review has no findings — only the abort line — so
    // nothing is posted; a soft stop's "findings so far" finale posts as
    // usual. Deliberately AFTER the workspace release and registry finish
    // above — the plain path's lifecycle position is unchanged.
    await root.span("post.review_post", () =>
      runReviewPostStep({
        agent,
        requestText: directives.text,
        repoCtx,
        heads: { reviewHead, observedHead },
        verdict,
        answer,
        carried,
        hardStopped: stopped === "hard",
        post: deps.postReviewComment ?? postReviewComment,
        fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
        reply: (text) => io.reply(text),
        logKey: msg.threadKey,
      }),
    );
  } catch (err) {
    caught = true;
    const errMsg = err instanceof Error ? err.message : String(err);
    // A card left spinning after a setup failure looks like a hang; close it.
    // Only a card still in setup — a run failure was already closed by the run
    // loop with its checklist, and must not be relabeled here.
    // Item 62: the error may carry remote text (a resident reason, a GitHub
    // body) — one redacted line on the card, a redacted reply in the thread.
    if (setupCard && setupShell) {
      const [failedCard, failedShell] = [setupCard, setupShell];
      await refuse("setup_failed", () =>
        failedCard.done(
          failedShell.close({
            kind: "setup_failed",
            reason: oneLine(redactAndCap(errMsg, 120)),
            ...closeLines(clock(), false),
          }),
        ),
      ).catch(() => {});
    }
    // The error reply seals whatever finished run is still unsealed (a run
    // whose loop threw: `replyOk` says how this reply went) and drains: the
    // `failed` record is written now. A setup failure before any run started
    // has nothing to seal or write. A run whose card close or reply threw was
    // already sealed and written by its own wrap; this is a no-op for it.
    // A run's failure reply is a `post.reply`; a setup failure's is the refusal.
    const replyName = root.record().attrs.runId !== undefined ? "post.reply" : "dispatch.refuse";
    await ending
      .sealAfterReply(
        async () => {},
        () => root.span(replyName, () => io.reply(redactSecrets(stripAnsi(errorReply(err))))),
      )
      .catch(() => {});
  } finally {
    clearInterval(setupHeartbeat); // a refusal or a setup failure ended the request before the run loop took the card
    // The backstop: a finished run no reply attempt reached (a fenced run, a
    // branch that returned early) is sealed with no `replyOk`, and any record
    // still registered is written.
    ending.drain(undefined);
    // A resumed dispatch that ended before its run was created — an unknown
    // provider, a refusal, a gate — has adopted a row it will never finish
    // (item 38). Close it `interrupted` here, or the sweep would relaunch it
    // every lease interval forever.
    if (resume && ledgerRun && !liveControl) {
      const adopted = ledgerRun;
      await root.span("post.history_write", () =>
        closeResumedRow(adopted, resume, "the resumed dispatch ended before the run started"),
      );
      console.log(
        `[resume] ${msg.threadKey} run ${resume.row.runId} closed interrupted: the resumed dispatch ended before the run started`,
      );
    }
    // Thread admission (features/thread-admission.md item 4): free the thread,
    // and settle what the run never consumed. A run that ended by itself (an
    // answer, a budget, a failure, a dead sandbox) hands its unconsumed
    // follow-ups on as ONE fresh turn — on the most recent sender's channel
    // handle, so the reply lands where they asked — never a silent drop. A run
    // an operator stopped does not: the stop meant "no more work here", and
    // each sender is told their follow-up was not run. The fresh turn is an
    // ordinary dispatch: it claims the thread itself, and a follow-up arriving
    // during it steers into it.
    const pending = admitted ? admission.release(msg.threadKey, admitted) : [];
    const stopMode: StopMode | undefined = liveControl?.requested;
    if (pending.length > 0 && stopMode) {
      console.log(`[dispatch] ${msg.threadKey} ${pending.length} follow-up(s) dropped: run stopped (${stopMode})`);
      await root.span("post.followups", async () => {
        for (const p of pending) await p.io.reply(FOLLOW_UP_DROPPED_BY_STOP).catch(() => {});
      });
    }
    // The request is over: its root ends here, after the seal and the tail,
    // with how it went — before the fresh turn below starts a root of its own.
    root.end(caught ? "error" : "ok", {
      status: caught ? "failed" : refused ? "refused" : stopMode ? "stopped" : "completed",
    });
    if (pending.length > 0 && !stopMode && admitted) {
      const merged = mergeFollowUps(pending)!;
      const last = pending[pending.length - 1];
      console.log(`[dispatch] ${msg.threadKey} ${pending.length} unconsumed follow-up(s) → fresh turn`);
      // The fresh turn is a request of its own (features/tracing.md): it was
      // received NOW, and it waited behind this run since its earliest
      // follow-up arrived — the `queued … behind the previous run` caption.
      const freshAt = clock();
      const earliestAt = Math.min(...pending.map((p) => p.at));
      const fresh = startRequestRoot(deps, { channel: channelOf(last.msg.channelId), receivedAt: freshAt });
      // Pinned to the agent the follow-ups were addressed to: they were
      // admitted as input FOR this run's agent (a different one would have
      // been refused), so the fresh turn must not fall back to whatever the
      // thread's history or the channel default resolves to.
      await dispatch(
        deps,
        // The follow-up's own platform stamp stays behind: the fresh turn's
        // wait is `queuedBehindMs`, not a `queued … before we saw it`.
        {
          ...last.msg,
          ...merged,
          text: `agent:${admitted.agent} ${merged.text}`,
          receivedAt: freshAt,
          originAt: undefined,
        },
        last.io,
        { trace: fresh, queuedBehindMs: Math.max(0, freshAt - earliestAt) },
      ).catch((err: unknown) =>
        console.error(
          `[dispatch] ${msg.threadKey} fresh turn for unconsumed follow-ups failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    // The ledger heartbeat stops with the run (the finish write, in flight
    // through the writer, closes the row itself).
    void ledgerRun?.close();
    activeRuns--;
  }
}

/** What the agent:ship fork carries out of dispatch()'s prelude — values the
 *  pipeline must not re-derive, because the gates already ran against them. */
interface ShipBranchContext {
  /** AGENTS["ship"] — labels and run meta only; never handed to runAgent. */
  agent: AgentDef;
  /** The modelRef resolved for the ship request — recorded on the run, never
   *  called; child rounds resolve their own per-agent models. */
  modelRef: string;
  label: string;
  startedAt: number;
  /** The coalesced ack card; the ship branch owns its close from here. */
  card: StatusHandle;
  directives: RequestDirectives;
  sticky: ThreadDirectives;
  history: HistoryItem[];
  repoCtx: RepoContext;
  memoryBlockP: Promise<string | undefined>;
  /** The thread's admission slot this dispatch holds (thread-admission item
   *  1): the ship branch names its run on it once registered, so a refused
   *  follow-up in a live ship thread links the run page like any other. */
  live: LiveThread<DispatchFollowUp>;
  /** The dispatch's run ending: the ship run seals after its reply like any other. */
  ending: RunEnding;
  /** The request's trace (features/tracing.md): the ship run binds to it, its steps are spans under the root. */
  trace: RequestTrace;
  /** The card's shape and queued lines at a close, from the dispatch's window. */
  closeLines: (end: number, finished: boolean, owner?: RunOwner) => { shape?: string; queued?: string };
  /** A refusal as one `dispatch.refuse` span. */
  refuse: <T>(outcome: string, fn: () => Promise<T>) => Promise<T>;
  /** The done card's shape and queued lines, from the finish-site diagnosis. */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
}

/**
 * The agent:ship branch (features/agent-ship.md): preflight refusals, then
 * the ONE run record + card shell around `runShipPipeline`'s round loop —
 * the ship counterpart of the main path's run shell, reusing the same label,
 * event, record, and friction vocabulary so /runs shows a pipeline exactly
 * like any run. Handled endings reply here; an unexpected throw closes the
 * card, persists the `failed` record, and propagates to dispatch()'s outer
 * catch for the error reply.
 */
async function runShipBranch(
  deps: CoreDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  ctx: ShipBranchContext,
): Promise<void> {
  // `closeLines` keeps its default owner (`agent`): a ship run's children are
  // agent runs, so its `run.command` grafts — none today — would count as
  // getting ready, never as a command's own tools.
  const { agent, card, directives, history, repoCtx, label, ending, trace, closeLines, refuse, doneLines } = ctx;
  const root = trace.root;
  const clock = deps.clock ?? systemClock;
  // The same one-builder card shell as the main path, on the same label and clock.
  const shell = createCardShell({ label, startedAt: ctx.startedAt, now: clock });
  const pre = await root.span("dispatch.ship_preflight", () =>
    shipPreflight({
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      requestText: directives.text,
      repoCtx,
      gates: { canRunAgent: (a) => deps.config.canRunAgent(msg.userId, a), adminsHint: () => deps.config.adminsHint() },
      repoInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
      prFacts: deps.fetchPrFacts ?? fetchPullRequestFacts,
      selfIdentity: deps.fetchSelfIdentity ?? resolveGithubIdentity,
      runsBase: process.env.PUBLIC_BASE_URL,
    }),
  );
  if (!pre.ok) {
    console.log(`[ship] ${msg.threadKey} not started: ${pre.where}`);
    await refuse("ship_preflight", async () => {
      await card.done(shell.close({ kind: "refused", icon: "🚫", reason: pre.card, ...closeLines(clock(), false) }));
      await io.reply(pre.reply);
    });
    return;
  }
  const entry = pre.entry;

  // The one run record (KTD2): registered and stamped exactly like the main
  // path — input, run_meta, bounded context, the #375 tombstone.
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const channelVisibility = await root.span("dispatch.channel_visibility", () =>
    channelVisibilityOf(deps, msg.channelId),
  );
  const run = registry.create(
    composeRunLabel({
      agent: agent.name,
      repo: repoCtx.repo,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: directives.text,
    }),
    {
      agent: agent.name,
      model: ctx.modelRef,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
      channelVisibility,
      receivedAt: trace.receivedAt,
      ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
      ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
      ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    },
  );
  io.runStarted?.({ id: run.id });
  const publishText = (
    type: "input" | "context" | "answer",
    text: string,
    source?: { url?: string; channel?: string; user?: string },
  ) => {
    const redacted = redactSecrets(text);
    registry.publish(run.id, { type, text: redacted, ...(source ? { source } : {}), at: clock() });
    console.log(`[event] ${msg.threadKey} type=${type} bytes=${utf8ByteLength(redacted)}`);
  };
  const humanize = isMrkdwnChannel(msg.channelId);
  const attachments = attachmentSuffix(msg.images, msg.documents);
  const source = {
    ...(msg.sourceUrl ? { url: msg.sourceUrl } : {}),
    ...(msg.channelName ? { channel: msg.channelName } : {}),
    ...(msg.userName ? { user: msg.userName } : {}),
  };
  const request = humanize ? humanizeMessageText(directives.text) : directives.text;
  publishText(
    "input",
    attachments ? `${request} ${attachments}` : request,
    Object.keys(source).length > 0 ? source : undefined,
  );
  registry.publish(run.id, {
    type: "run_meta",
    agent: agent.name,
    model: ctx.modelRef,
    traceId: root.traceId,
    ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
    ...(entry.resume !== undefined ? { pr: entry.resume.pr } : {}),
    at: clock(),
  });
  if (deps.config.config.runHistory?.includeContext !== false) {
    for (const text of contextMessageTexts(history, humanize)) publishText("context", text);
  }
  // Tombstone-first (#375), like the main path — a pipeline can run for
  // hours, so the provisional terminal record matters even more here.
  const startSnap = registry.snapshot(run.id, run.token);
  if (startSnap) {
    deps.runHistoryWriter.write(
      assembleRunRecord({
        run,
        snap: startSnap,
        agent: agent.name,
        model: ctx.modelRef,
        msg,
        channelVisibility,
        repo: repoCtx.repo,
        finishedAt: startSnap.startedAt,
        status: "interrupted",
        diagnosis: analyzeRunFriction(startSnap.events, {
          finished: false,
          truncated: startSnap.truncated,
          schema: SPAN_SCHEMA,
        }),
      }),
      { provisional: true },
    );
  }
  // The ledger claim (run-history item 35) for the live index and the finish.
  // A pipeline has no single model loop of its own — each child round runs
  // `runAgent` with its own prompt and conversation — so it is claimed without
  // a seed or step records and closes `interrupted` at a reclaim; resuming a
  // pipeline mid-round is not built. Untracked (a process without a ledger
  // included) → undefined, and the pipeline runs as before.
  const ledgerRun: LedgerRun | undefined = await root.span("dispatch.ledger_claim", () =>
    deps.runLedger.open({
      runId: run.id,
      threadKey: msg.threadKey,
      startedAt: registry.snapshot(run.id, run.token)?.startedAt ?? clock(),
      meta: {
        agent: agent.name,
        model: ctx.modelRef,
        channelId: msg.channelId,
        userId: msg.userId,
        threadKey: msg.threadKey,
        channelVisibility,
        ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
        ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
        ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
        ...(entry.resume !== undefined ? { pr: entry.resume.pr } : {}),
      },
      card: card.handle ?? null,
      system: "",
      tools: [],
      onStop: (mode) => void run.control.requestStop(mode),
      onFenced: () => void run.control.requestStop("hard"),
    }),
  );
  if (ledgerRun) {
    const opened = ledgerRun;
    registry.subscribe(run.id, run.token, {
      onEvent: (event, seq) => opened.event(event, seq),
      ...REPLAY_EVERYTHING,
    });
  }

  // The card's frames — the main path's vocabulary (spinner title, checklist +
  // one-line activity trace, heartbeat, shutdown notice) through `shell`.
  const liveUrl = liveViewLink(run.id, run.token);
  const liveLink = liveUrl ? { url: liveUrl, label: "Live run" } : undefined;
  ctx.live.runId = run.id;
  if (liveUrl) ctx.live.runLink = liveUrl;
  let checklist: string | undefined;
  let lastActivity: string | undefined;
  // The round header is orchestrator-owned (spec item 12): its OWN variable,
  // composed into the frame ABOVE the checklist — the same pattern as
  // `lastActivity` — so a child's update_status (which replaces the checklist
  // outright) can never erase which round the pipeline is in.
  let roundHeader: string | undefined;
  const currentFrame = () => shell.live({ notice: shutdownNotice, detail: [roundHeader, checklist, lastActivity] });
  const finalDetail = () => checklist;
  const checkedOffDetail = () => checklist?.replace(/^(\s*)[○✱](?=\s)/gm, "$1✓");
  const onEvent = (e: RunEvent) => {
    registry.publish(run.id, e);
    if (isSpanRecord(e)) return; // timing, not activity (features/tracing.md)
    lastActivity = activityLine(e);
    console.log(`[tool] ${msg.threadKey} ${lastActivity}`);
    card.update(currentFrame());
  };
  const onProgress = (note: string) => {
    console.log(`[note] ${msg.threadKey} ${note}`);
    lastActivity = note;
    card.update(currentFrame());
  };
  trace.bindRun(run.id, (e) => registry.publish(run.id, e));
  const reportProgress = (list: string) => {
    const trimmed = list.trim();
    if (!trimmed) return; // never blank the durable progress record
    checklist = trimmed;
    card.update(currentFrame());
  };

  // Child resolution: each round resolves ITS agent's model/effort through
  // the standard layers — a `model:`/`effort:` directive on the ship request
  // wins for every child, exactly like a directive wins on any request.
  const child = (name: "coding" | "review"): ShipChildSpec => {
    const r = deps.config.resolve({
      channelId: msg.channelId,
      userId: msg.userId,
      request: {
        agent: name,
        model: directives.model ?? ctx.sticky.model,
        effort: directives.effort ?? ctx.sticky.effort,
      },
    });
    const { provider: providerName, model } = parseModelRef(r.modelRef);
    return {
      agent: getAgent(name),
      provider: deps.providers.get(providerName),
      modelRef: r.modelRef,
      model,
      ...(r.effort !== undefined ? { effort: r.effort } : {}),
    };
  };
  const scopes = deps.config.scopes(msg.channelId, msg.userId);
  const instructionsBlock = customInstructionsBlock(scopes);
  const memoryBlock = await root.span("dispatch.compose", () => ctx.memoryBlockP);
  const blocks = (spec: ShipChildSpec): ShipBlocks => ({
    memory: memoryBlock,
    config: configAwarenessBlock({
      agentName: spec.agent.name,
      modelRef: spec.modelRef,
      effort: spec.effort,
      channel: scopes.channel,
      user: scopes.user,
      messageDirective: { agent: directives.agent, model: directives.model, effort: directives.effort },
      threadDirective: { agent: ctx.sticky.agent, model: ctx.sticky.model, effort: ctx.sticky.effort },
      canEditChannelConfig: deps.config.canEditChannelConfig(msg.userId),
      // No `mcp` here: ship rounds receive no MCP tools yet (features/mcp-tools.md
      // roadmap), and a line inviting `mcp add` into a run that could not use
      // the result would mislead. The line arrives with the tools.
    }),
    about: selfDescriptionBlock(AGENTS, deps.config.config.organization),
    instructions: instructionsBlock,
    skills: deps.skills ? skillGuidanceBlock(deps.skills, spec.agent.name) : undefined,
  });

  console.log(
    `[run] ${msg.threadKey} user=${msg.userId} agent=ship model=${ctx.modelRef} entry=${entry.resume ? `resume ${entry.repo}#${entry.resume.pr}` : `round0 ${entry.branch}`}`,
  );
  card.update(shell.live());
  shell.setLink(liveLink);
  const heartbeat = setInterval(() => card.update(currentFrame()), 5000);
  let outcome: ShipOutcome | undefined;
  let shipDiagnosis: FrictionDiagnosis | undefined;
  try {
    outcome = await runShipPipeline({
      span: root,
      entry,
      round0Messages: buildMessages(history, directives.text, msg.images, msg.documents),
      child,
      blocks,
      factory: {
        execution: deps.config.config.execution,
        workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
        dataDir: deps.dataDir ?? "./data",
      },
      threadKey: msg.threadKey,
      caps: resolveShipCaps(deps.config.config.ship),
      control: run.control,
      inbox: ctx.live.inbox, // thread follow-ups steered into this run reach the child round in flight (thread-admission item 2)
      onEvent,
      onProgress,
      reportProgress,
      publish: (e) => {
        registry.publish(run.id, e);
        // A round's `started` boundary retitles the card's round header (the
        // settle events stay stream-only — the next round or the close frame
        // takes over the card).
        if (e.type === "ship_round" && e.outcome === "started") {
          roundHeader = shipRoundHeader(e);
          card.update(currentFrame());
        }
      },
      reply: (text) => io.reply(text),
      web: webCapability(),
      skills: deps.skills,
      githubTools: githubCapabilityFor(deps, msg.userId),
      github: {
        createBranchRef: deps.createBranchRef ?? createBranchRef,
        openPullRequest: deps.openPullRequest ?? openPullRequest,
        postReviewComment: deps.postReviewComment ?? postReviewComment,
        fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
        fetchPrCommits: deps.fetchPrCommits ?? prCommitsSince,
        prFacts: deps.fetchPrFacts ?? fetchPullRequestFacts,
        fetchRepoShipInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
      },
      redactDescription: redactPrDescription,
      logKey: msg.threadKey,
    });
    // The run record is the source of truth: the report enters the stream
    // BEFORE finish() below (a publish on a finished run is a no-op).
    publishText("answer", outcome.reply);
  } finally {
    // A throw passes through to dispatch()'s outer catch (the error reply, the
    // drain); this block still finishes the run, registers its `failed` record
    // and closes the card.
    clearInterval(heartbeat);
    // RunStatus is the run-store contract (shared with the memory worker):
    // an aborted or capped pipeline still finished and delivered its report,
    // so record and registry say `completed` — the abort/cap distinction
    // lives in ShipOutcome, the reply, and the card close below.
    const status: RunStatus =
      outcome === undefined
        ? "failed"
        : outcome.status === "stopped_soft" || outcome.status === "stopped_hard"
          ? outcome.status
          : "completed";
    registry.finish(run.id, status);
    const snap = registry.snapshot(run.id, run.token);
    const finishedAt = snap?.finishedAt ?? clock();
    const diagnosis = analyzeRunFriction(snap?.events ?? [], {
      finished: true,
      truncated: snap?.truncated ?? false,
      schema: SPAN_SCHEMA,
      window: { start: trace.receivedAt, end: finishedAt },
    });
    shipDiagnosis = diagnosis;
    io.runFinished?.({ id: run.id, status });
    ending.finished(run.id);
    shell.freeze(finishedAt);
    // Mirrors the main path: a completed pipeline whose final reply throws is
    // recorded `failed` — the thread never saw the report — while a stopped
    // status stays what it was. Written by the drain after the seal; a throw
    // reaches dispatch()'s outer catch, which drains. A tracked run finishes
    // through the ledger sink, which also closes its row.
    ending.register({
      runId: run.id,
      flipOnPostFinishFailure: true,
      write: (seal, failedAfterFinish) =>
        deps.runHistoryWriter.write(
          assembleRunRecord({
            run,
            snap,
            agent: agent.name,
            model: ctx.modelRef,
            msg,
            channelVisibility,
            repo: repoCtx.repo,
            finishedAt,
            status: failedAfterFinish && status === "completed" ? "failed" : status,
            diagnosis,
            seal,
          }),
          { span: root, ...(ledgerRun ? { via: ledgerRun.sink } : {}) },
        ),
    });
    // A pipeline that threw closes its card here, after the finish, so the
    // card's total is the run's.
    if (outcome === undefined)
      await root
        .span("post.card_close", () =>
          card.done(shell.close({ kind: "done", icon: "❌", detail: finalDetail(), ...doneLines(diagnosis) })),
        )
        .catch(() => {});
  }
  if (!outcome) return; // unreachable: the catch above rethrew
  console.log(`[done] ${msg.threadKey} ship ${outcome.reply.length} chars (${outcome.status})`);
  // The close tells the truth about HOW the pipeline ended: only a COMPLETED
  // pipeline checks its checklist off — an abort or cap closes ⚠️ over the
  // un-rewritten checklist (✓s over an abort would claim work that never
  // finished); stops keep their ⏹/⛔.
  const icon =
    outcome.status === "stopped_hard"
      ? "⛔"
      : outcome.status === "stopped_soft"
        ? "⏹"
        : outcome.status === "completed"
          ? "✅"
          : "⚠️";
  ledgerRun?.setState({
    finalStatus: outcome.status === "stopped_soft" || outcome.status === "stopped_hard" ? outcome.status : "completed",
  });
  if ((await root.span("post.ledger_finishing", () => ledgerRun?.finishing())) === "fenced") {
    console.log(`[ship] ${msg.threadKey} run ${run.id}: another generation owns this run — not replying`);
    ending.drop(run.id); // the record is the other generation's; the outer finally still seals the stream here
    return;
  }
  // The card close, the reply, then the drain: sealed with how the reply went,
  // the record written after the seal (fire-and-forget; the writer's
  // `pending()` counts it for the shutdown drain). A report that never reached
  // the thread flips the record to `failed`, never `completed` — the main
  // path's invariant — and the throw reaches the outer catch; the registry row
  // keeps its terminal status for the TTL, exactly like the main path.
  await ending.sealAfterReply(
    () =>
      root.span("post.card_close", () =>
        card.done(
          shell.close({
            kind: "done",
            icon,
            detail: outcome.status === "completed" ? checkedOffDetail() : finalDetail(),
            ...doneLines(shipDiagnosis),
          }),
        ),
      ),
    () => root.span("post.reply", () => io.reply(outcome.reply)),
  );
}

/** The `pr_description` event's payload: every string LEAF passed through
 *  `redactSecrets` by a generic deep walk — numbers/booleans ride unchanged,
 *  structure preserved — so a field added to the schema (or a secret smuggled
 *  into an anchor path) can never dodge redaction by being missed in a
 *  hand-walk. */
function redactPrDescription(d: PrDescription): PrDescription {
  return redactStringLeaves(d) as PrDescription;
}

function redactStringLeaves(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStringLeaves);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactStringLeaves(v)]));
  }
  return value;
}

/** The agent name an inline (no-model) command run carries in its `RunMeta` and
 *  record — the one value `runs list agent=command` selects on. */
export { COMMAND_RUN_AGENT };

/**
 * Answer one parsed chat command through the registry as the message's user:
 * the caller carries the message's channel + thread as its `origin`, and a LAZY
 * repo resolver (history + the production repo resolver) for the commands that
 * ask for the thread's bound repo (`memory list` with the repo scope) — paid
 * only when asked. Commands that do work (`isInlineRunCommand`) are recorded as
 * inline runs; help/usage replies and read-only answers are not.
 */
async function runChatCommand(
  deps: CoreDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  parsed: ParsedChatCommand,
  ending: RunEnding,
  trace: RequestTrace,
): Promise<ChatCommandResult> {
  const commands = deps.commands;
  if (!commands) return { ok: false, text: "" };
  const resolveRepo = async (): Promise<string | undefined> =>
    (await resolveRepoForCommand(deps, msg, await io.history())).repo;
  const invoke = (span: Span) => invokeChatCommand({ commands, parsed, msg, config: deps.config, resolveRepo, span });
  if (parsed.kind === "invoke" && isInlineRunCommand(parsed.id))
    return runInlineCommandRun(deps, msg, cliWords(parsed.id)[0], io, invoke, ending, trace);
  // A config reply, a listing, `help`: no run — the command's own work is the
  // request's one step, log-only.
  return trace.root.span("run.command", invoke, { attrs: { command: parsed.kind === "invoke" ? parsed.id : "help" } });
}

/**
 * A command with a deferred outcome (`CommandDef.settle` — `repo onboard` /
 * `repo rebuild`, whose provisioning settles minutes after the 202) gets a
 * SECOND reply in the thread when it does: awaited off the request path, so the
 * acknowledgement is never held back. Best-effort by design — the poll lives in
 * this process, so a restart mid-provision loses the follow-up; the resident
 * state itself is never in doubt (`repo list` / the residents dash read it
 * live), and the acknowledgement says so.
 */
/** A command reply longer than one chat message can hold (a 100-tool `mcp
 *  show`) goes out as an attachment where the channel has one: the first line
 *  as the message, the whole text as a Markdown document named after the
 *  command (`toMarkdownDocument` — Slack renders a `.md` upload as CommonMark,
 *  which reads the chat dialect differently). Channels without `attach` — and
 *  an attach that fails — reply the text as before. */
export const LONG_COMMAND_REPLY_CHARS = 3_000;

export async function replyCommandOutput(io: ChannelIO, parsed: ParsedChatCommand, text: string): Promise<void> {
  if (!io.attach || text.length <= LONG_COMMAND_REPLY_CHARS) return io.reply(text);
  const nl = text.indexOf("\n");
  const lead = nl === -1 ? text : text.slice(0, nl);
  const name = parsed.kind === "invoke" ? cliWords(parsed.id).join("-") : "command";
  await io.attach({
    name: `${name}.md`,
    text: toMarkdownDocument(text),
    lead: `${lead}\n_(full output attached — ${text.length.toLocaleString("en-US")} chars)_`,
  });
}

function postSettledOutcome(followUp: () => Promise<{ text: string } | undefined>, io: ChannelIO, root: Span): void {
  // Minutes after the request ended: a late child of its root, log-only.
  void root
    .span("post.settled_outcome", () => followUp().then((outcome) => (outcome ? io.reply(outcome.text) : undefined)))
    .catch((err) => console.error("[command] settle follow-up failed:", err));
}

/**
 * Run an inline (no-model) command AS a run (#244): register it in the run
 * registry under a `<command> · #channel · user · "…"` label with the caller's
 * identity as its `RunMeta` (agent `command`), publish the request as the
 * `input` event and the reply as the `answer` event, finish it with its status,
 * hand the channel its receipt — `completed` when the command did its work,
 * `failed` when it was refused, misconfigured, or threw — and persist it through
 * the same `runHistoryWriter` path as an agent run, so a scheduled firing
 * outlives the registry TTL. The run record is the canonical trace
 * (command-registry principle, #157); the channel reply is a projection of it.
 * A thrown command still finishes its run (as `failed`, with the `⚠️ <error>`
 * reply as its `answer`) and the error propagates to the dispatcher's outer
 * handler.
 */
async function runInlineCommandRun<T extends { text: string; ok: boolean; trace?: unknown; residentMs?: number }>(
  deps: CoreDeps,
  msg: IncomingMessage,
  command: string,
  io: ChannelIO,
  execute: (span: Span) => Promise<T>,
  ending: RunEnding,
  trace: RequestTrace,
): Promise<T> {
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const root = trace.root;
  const clock = deps.clock ?? systemClock;
  const channelVisibility = await root.span("dispatch.channel_visibility", () =>
    channelVisibilityOf(deps, msg.channelId),
  );
  const run = registry.create(
    composeRunLabel({
      agent: command,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: msg.text,
    }),
    {
      agent: COMMAND_RUN_AGENT,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
      channelVisibility,
      receivedAt: trace.receivedAt,
    },
  );
  // The command run rides the request's trace like an agent run: the setup
  // spans so far backfill, then `run.command` and the reply follow live. A
  // natural-language fall-through rebinds the same root to the agent run next.
  trace.bindRun(run.id, (e) => registry.publish(run.id, e));
  io.runStarted?.({ id: run.id });
  registry.publish(run.id, { type: "input", text: redactSecrets(msg.text), at: clock() });
  // A command run's meta names no model (features/tracing.md): the agent and the trace.
  registry.publish(run.id, { type: "run_meta", agent: COMMAND_RUN_AGENT, traceId: root.traceId, at: clock() });
  let result: T | undefined;
  try {
    // The command's deterministic body is the run's one counted step (`tools`
    // for a command run); a resident op's own steps graft under it.
    result = await root.span(
      "run.command",
      async (span) => {
        const r = await execute(span);
        const steps = sanitizeGraftedSteps(r.trace);
        if (steps.length > 0)
          graftResidentSteps(steps, {
            parent: span,
            prefix: "run.command",
            baseAt: span.record().startedAt,
            clipAt: clock(),
            ...(r.residentMs !== undefined ? { residentTotalMs: r.residentMs } : {}),
          });
        return r;
      },
      { attrs: { command } },
    );
    registry.publish(run.id, { type: "answer", text: redactSecrets(result.text), at: clock() });
    return result;
  } catch (err) {
    // A thrown command still gets an `answer`: the same `⚠️ <error>` line the
    // dispatcher's outer handler replies with, so the record explains its
    // `failed` status and the channel reply stays a projection of it.
    registry.publish(run.id, { type: "answer", text: redactSecrets(errorReply(err)), at: clock() });
    throw err;
  } finally {
    const status: RunStatus = result?.ok ? "completed" : "failed";
    registry.finish(run.id, status);
    io.runFinished?.({ id: run.id, status });
    // Sealed by the caller's drain after its reply (or at once, with no reply,
    // when the command fell through to the agent); the record is written then.
    // A command's status is its own `ok` — a reply that throws never flips it.
    ending.finished(run.id);
    const snap = registry.snapshot(run.id, run.token);
    const finishedAt = snap?.finishedAt ?? clock();
    // A command run owns its window's tools: `run.command` is the work.
    const diagnosis = analyzeRunFriction(snap?.events ?? [], {
      finished: true,
      truncated: snap?.truncated ?? false,
      schema: SPAN_SCHEMA,
      owner: "command",
      window: { start: trace.receivedAt, end: finishedAt },
    });
    ending.register({
      runId: run.id,
      flipOnPostFinishFailure: false,
      write: (seal) =>
        deps.runHistoryWriter.write(
          assembleRunRecord({
            run,
            snap,
            agent: COMMAND_RUN_AGENT,
            msg,
            channelVisibility,
            finishedAt,
            status,
            diagnosis,
            seal,
          }),
          { span: root },
        ),
    });
  }
}

/** The longest a reply waits on the channel directory. The Slack directory
 *  answers from its cache after the first message per channel per TTL; a cold
 *  `conversations.info` is one round trip, and a Slack outage must cost the
 *  user at most this much — the run is then stamped `unknown` (grants-only). */
export const CHANNEL_DIRECTORY_TIMEOUT_MS = 1500;

const DIRECTORY_TIMED_OUT = Symbol("channel directory timed out");

/** The visibility stamp for a run in `channelId` (authorization KTD7): what the
 *  channel directory says, asked once per run and awaited for at most
 *  `channelDirectoryTimeoutMs`; a directory that throws, rejects, or is too slow
 *  yields `unknown` — never public, never a member (R7). */
async function channelVisibilityOf(deps: CoreDeps, channelId: string): Promise<ChannelVisibility> {
  const timeoutMs = deps.channelDirectoryTimeoutMs ?? CHANNEL_DIRECTORY_TIMEOUT_MS;
  const failed = (err: unknown): ChannelVisibility => {
    console.warn(
      `[authz] channel directory failed for ${channelId} — stamping unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unknown";
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Caught BEFORE the race, so a rejection is `unknown` by the same path
    // whether it lands before the timeout (stamped at once) or after it (the
    // run is already stamped; the late failure is logged, never left unhandled).
    const lookup = (deps.channelDirectory ?? STATIC_CHANNEL_DIRECTORY)
      .info(channelId)
      .then((info) => info.visibility, failed);
    const answer = await Promise.race([
      lookup,
      new Promise<typeof DIRECTORY_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(DIRECTORY_TIMED_OUT), timeoutMs);
      }),
    ]);
    if (answer === DIRECTORY_TIMED_OUT) {
      console.warn(`[authz] channel directory timed out after ${timeoutMs} ms for ${channelId} — stamping unknown`);
      return "unknown";
    }
    return answer;
  } catch (err) {
    // `info` threw synchronously (a non-async implementation).
    return failed(err);
  } finally {
    clearTimeout(timer);
  }
}

/** The one shape a dispatch failure is reported in — the outer handler's reply
 *  and a failed inline run's `answer` are built from it, so they cannot drift. */
function errorReply(err: unknown): string {
  return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * The `interrupted` record for a run the drain deadline abandons (#375): the
 * run's full registry snapshot (every event published so far) with
 * `finishedAt` = the drain's clock — the tombstone upgrade `src/index.ts`
 * writes for each still-active run before `process.exit`. Identity comes from
 * the run's `RunSummary` (the same `RunMeta` the dispatcher gave `create()`;
 * the channel/user/thread fields are always present on a dispatcher-created
 * run — the empty-string fallback only guards a hand-built registry entry).
 * The diagnosis is computed as unfinished: the run never reached `finish`.
 */
export function interruptedRunRecord(summary: RunSummary, snap: RunSnapshot, finishedAt: number): RunRecord {
  return assembleRunRecord({
    run: { id: summary.id, ...(summary.label !== undefined ? { label: summary.label } : {}) },
    snap,
    agent: summary.agent,
    model: summary.model,
    msg: {
      channelId: summary.channelId ?? "",
      userId: summary.userId ?? "",
      threadKey: summary.threadKey ?? "",
      sourceUrl: summary.sourceUrl,
      userName: summary.userName,
    },
    channelVisibility: summary.channelVisibility ?? "unknown",
    repo: summary.repo,
    finishedAt,
    status: "interrupted",
    diagnosis: analyzeRunFriction(snap.events, { finished: false, truncated: snap.truncated, schema: SPAN_SCHEMA }),
  });
}

/**
 * The record a booting generation closes a reclaimed run with (features/
 * run-history.md item 36): the ledger row's identity and meta, the events it
 * appended while it ran (the registry that published them died with the old
 * process, so the ledger's copy is the whole stream — `eventCount` is its
 * last `seq`), the terminal status the reclaim decided, and `finishedAt` =
 * the reclaim's clock (nobody knows when the old process died). No label: the
 * row carries none.
 */
export function reclaimedRunRecord(input: {
  row: LiveRunRow;
  events: AppendableEvent[];
  status: RunStatus;
  finishedAt: number;
}): RunRecord {
  const { row, events, status, finishedAt } = input;
  const snap: RunSnapshot = {
    events,
    finished: true,
    startedAt: row.startedAt,
    finishedAt,
    eventCount: events.reduce((max, e) => Math.max(max, e.seq), 0),
    stepCount: events.filter((e) => !isSpanRecord(e)).length,
    truncated: false,
  };
  return assembleRunRecord({
    run: { id: row.runId },
    snap,
    agent: row.meta.agent,
    model: row.meta.model,
    msg: {
      channelId: row.meta.channelId,
      userId: row.meta.userId,
      threadKey: row.threadKey,
      sourceUrl: row.meta.sourceUrl,
      userName: row.meta.userName,
    },
    channelVisibility: row.meta.channelVisibility ?? "unknown",
    repo: row.meta.repo,
    finishedAt,
    status,
    diagnosis: analyzeRunFriction(events, {
      finished: status !== "interrupted",
      truncated: false,
      schema: SPAN_SCHEMA,
      // A reclaimed run that did finish has its window: the row's start to the
      // finish the closing generation stamped.
      ...(status !== "interrupted" ? { window: { start: row.startedAt, end: finishedAt } } : {}),
    }),
  });
}

/**
 * The drain deadline's abandonment pass (#375), called by `src/index.ts` right
 * before `process.exit`: every registry run still unfinished gets its tombstone
 * upgraded to a full-transcript `interrupted` record (`interruptedRunRecord`
 * over the run's whole snapshot, `finishedAt` = the drain's clock). The writes
 * are `provisional` like the start tombstone: the persisted flag means
 * "finished and durably stored" — these runs never finished (and the registry
 * dies with the process) — and a provisional write stands down in the writer
 * if the run's real finish record shows up inside the drain's write budget, so
 * this pass can never clobber a finish that races it. Synchronous end to end
 * (the writes are fire-and-forget); returns how many were enqueued so the
 * caller knows whether to await the writer under its budget.
 */
export function writeAbandonedRunRecords(
  registry: Pick<RunRegistry, "listActive" | "snapshotById">,
  writer: Pick<RunHistoryWriter, "write">,
  now: number,
  log: (line: string) => void = console.log,
  /** Runs handed to the next generation (run-history item 39): their record is
   *  the ledger's, not a tombstone from here. */
  exclude: ReadonlySet<string> = new Set(),
): number {
  let written = 0;
  for (const summary of registry.listActive()) {
    if (summary.finished || exclude.has(summary.id)) continue;
    const snap = registry.snapshotById(summary.id);
    if (!snap) continue;
    writer.write(interruptedRunRecord(summary, snap, now), { provisional: true });
    log(`[drain] wrote interrupted record for ${summary.id} (${snap.events.length} events)`);
    written++;
  }
  return written;
}

/**
 * The persisted `RunRecord` for a finished run — the ONE assembly both an agent
 * run and an inline command run go through: the registry's redacted label and
 * finish-time snapshot, the caller's identity from the message, the terminal
 * status, and the diagnosis; then `fitRecordToBudget`. `repo`/`model` are omitted
 * (not set undefined) when absent, so the record's JSON is exactly what the
 * store measures and `isRunRecord` re-validates. The backlog is bounded (count +
 * bytes) while `eventCount` is the published total: a run that outgrew it is
 * `truncated` before the byte budget is even considered.
 */
function assembleRunRecord(input: {
  run: Pick<RunHandle, "id" | "label">;
  snap: RunSnapshot | null;
  agent?: string;
  model?: string;
  msg: Pick<IncomingMessage, "channelId" | "userId" | "threadKey" | "sourceUrl" | "userName">;
  /** The stamp taken at create (authorization KTD7) — the record carries what the run was stamped with. */
  channelVisibility: ChannelVisibility;
  repo?: string;
  finishedAt: number;
  status: RunStatus;
  diagnosis: FrictionDiagnosis;
  /** The run's seal (features/tracing.md): the events published between finish
   *  and seal are appended, the published total takes the larger count, and the
   *  two seal stamps ride the record — omitted when the seal has none. */
  seal?: SealResult;
}): RunRecord {
  const { run, snap, msg, seal } = input;
  const atFinish = snap?.events ?? [];
  const events = seal && seal.events.length > 0 ? [...atFinish, ...seal.events] : atFinish;
  const fitted = fitRecordToBudget({
    id: run.id,
    ...(run.label !== undefined ? { label: run.label } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    channelId: msg.channelId,
    userId: msg.userId,
    threadKey: msg.threadKey,
    channelVisibility: input.channelVisibility,
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    // The window's opening rides the record (features/tracing.md): every
    // duration surface and the diagnosis's window start here, not at create.
    ...(snap?.receivedAt !== undefined ? { receivedAt: snap.receivedAt } : {}),
    startedAt: snap?.startedAt ?? input.finishedAt,
    finishedAt: input.finishedAt,
    ...(seal?.sealedAt !== undefined ? { sealedAt: seal.sealedAt } : {}),
    ...(seal?.replyOk !== undefined ? { replyOk: seal.replyOk } : {}),
    ...(snap !== null ? { stepCount: snap.stepCount } : {}),
    status: input.status,
    eventCount: Math.max(snap?.eventCount ?? atFinish.length, seal?.eventCount ?? 0),
    storedEventCount: events.length,
    truncated: false,
    schema: SPAN_SCHEMA, // the stream carries spans, never `turn` events (features/tracing.md)
    events,
    diagnosis: input.diagnosis,
    // What the run was last doing / how it ended, and where it came from — so the
    // index can say what failed and link the thread without the events (item 20).
    ...(activityOfEvents(events) !== undefined ? { activity: activityOfEvents(events) } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
  });
  return fitted.eventCount !== fitted.storedEventCount ? { ...fitted, truncated: true } : fitted;
}

/** The external live-view capability URL for a run, or undefined when
 *  PUBLIC_BASE_URL is unset/blank — the feature degrades gracefully (no link,
 *  everything else works). The token is a per-run capability, unguessable and
 *  scoped to one run; it is not a logged credential. */
function liveViewLink(id: string, token: string): string | undefined {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/runs/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
}

// ---- run label (Area 2 / live-view index) -----------------------------------

/** Everything `composeRunLabel` needs to build one human-readable run label.
 *  Channel-agnostic: `channelName`/`userName` are optional display hints (Slack
 *  provides them; HTTP/MCP don't), and `channelId`/`userId` are the always-present
 *  namespaced ids the label falls back to. */
export interface RunLabelInput {
  /** Resolved agent name — the label always leads with this. */
  agent: string;
  /** Target repo (`owner/name`) for repo runs; absent for chat runs. */
  repo?: string;
  /** Namespaced channel id (`slack:C…`), used when no `channelName` resolved. */
  channelId: string;
  /** Namespaced user id (`slack:U…`), used when no `userName` resolved. */
  userId: string;
  /** Human channel/conversation name, if the adapter resolved one. */
  channelName?: string;
  /** Human user display name, if the adapter resolved one. */
  userName?: string;
  /** The request text; a short quoted snippet of it is appended to the label. */
  text: string;
}

/** Max chars in a snippet before it is cut (at a word boundary) and ellipsized —
 *  a laptop-width index row holds ~100 after the started column, chips and facts
 *  (live-view item 21; was 60, which left half the row empty). */
const SNIPPET_MAX = 100;
/** Hard cap on the whole label so one hostile/huge field can't dominate the index
 *  (the registry's own cap is 200). */
const RUN_LABEL_MAX = 160;

/** Drop the platform prefix from a namespaced id (`slack:U0123` → `U0123`) so an
 *  id fallback reads a little better when no display name is available. */
function stripPlatformPrefix(id: string): string {
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(i + 1);
}

/** Rewrite one URL into its shortest useful display form: a GitHub PR/issue
 *  becomes `owner/repo#N` (any trailing `/files`, `#discussion_…` dropped);
 *  anything else loses its scheme and `www.` so the host/path is what shows. */
function compactUrl(url: string): string {
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)/.exec(url);
  if (gh) return `${gh[1]}#${gh[2]}`;
  return url.replace(/^https?:\/\/(?:www\.)?/, "");
}

/** Make request text readable: Slack's `<url|label>` renders as its label,
 *  `<url>` as the url, mentions/channels as `@name`/`#name`. With `compact`
 *  (the run-label snippet) every URL also loses its scheme/`www.` and GitHub
 *  PR/issue URLs become `owner/repo#N` — the raw mrkdwn a Slack review request
 *  carries (`<https://github.com/…/pull/41|…>`) would otherwise be sliced
 *  mid-URL by the snippet budget. Without it (message events) URLs stay whole
 *  so the run page can render them as links. */
function humanizeLinks(text: string, compact = true): string {
  const show = (url: string) => (compact ? compactUrl(url) : url);
  // `<url|label>`: the label alone for the compact snippet. For message text the
  // url must survive so the run page can link it — Slack's auto-link form (label
  // = the url, or the url minus scheme/`www.`/trailing slash) becomes the bare
  // url; a genuine custom label becomes `label (url)`.
  const labelled = (url: string, label: string) => {
    if (!label.trim()) return show(url);
    if (compact) return label;
    return isAutoLinkLabel(url, label) ? url : `${label} (${url})`;
  };
  return (
    text
      // Slack mentions: `<@U…|name>` / `<#C…|name>` / `<!subteam^S…|@eng>` keep
      // their label; label-less ones become a readable stub rather than a raw id.
      .replace(/<@[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `@${label.replace(/^@/, "")}`)
      .replace(/<@[^<>\s]+>/g, "@user")
      .replace(/<#[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `#${label.replace(/^#/, "")}`)
      .replace(/<#[^<>\s]+>/g, "#channel")
      .replace(/<!(?:here|channel|everyone)(?:\|[^<>]*)?>/g, (m) => `@${/here|channel|everyone/.exec(m)![0]}`)
      .replace(/<!subteam\^[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `@${label.replace(/^@/, "")}`)
      .replace(/<!subteam\^[^<>\s]+>/g, "@group")
      // Slack links: `<url|label>` → label (or the compacted url when empty), `<url>` → url.
      .replace(/<([^<>|\s]+)\|([^<>]*)>/g, (_m, url: string, label: string) => labelled(url, label))
      .replace(/<([a-z][a-z0-9+.-]*:\/\/[^<>\s]+)>/gi, (_m, url: string) => show(url))
      // Bare URLs: trailing sentence punctuation (`…/pull/12,` / `…/a).`) belongs
      // to the prose, not the url, so it is left in place.
      .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
        const trail = /[)\].,;:!?'"]+$/.exec(url)?.[0] ?? "";
        return show(url.slice(0, url.length - trail.length)) + trail;
      })
  );
}

/** Slack auto-links a pasted URL as `<url|label>` where the label is the url
 *  itself, often without its scheme, `www.` or trailing slash. */
function isAutoLinkLabel(url: string, label: string): boolean {
  const strip = (s: string) =>
    s
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "");
  return strip(url) === strip(label);
}

/** Slack delivers message text with `&`, `<`, `>` as `&amp;`/`&lt;`/`&gt;` (the
 *  mrkdwn structural characters — the inverse of `escapeMrkdwn`). Undo that
 *  ONCE, after the `<…>` markup has been unwrapped so a literal `&lt;` never
 *  becomes structural. Pure string work: the core stays free of Slack imports. */
function unescapeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The human-readable form of a Slack-authored turn for the run record: link,
 *  mention and channel markup unwrapped — `<url>` and auto-link `<url|url>` →
 *  the whole url, custom `<url|label>` → `label (url)`, never compacted — and
 *  entities unescaped. Only for text that came in through a channel — model
 *  output is not mrkdwn and must not pass through here. */
export function humanizeMessageText(text: string): string {
  return markdownEmphasis(unescapeSlackEntities(humanizeLinks(text, false)));
}

/** mrkdwn's bold in Markdown terms, so the run page's markdown renderer reads a
 *  Slack-authored turn as the human saw it (live-view item 18): `*bold*` →
 *  `**bold**` when the asterisks delimit a run that starts and ends on non-space
 *  (mrkdwn's rule) and sit on word edges — a glob (`src/*.ts`) or arithmetic
 *  (`2 * 3 * 4`) is left alone. Code spans and fences are left byte-for-byte.
 *  `_italic_` already means the same in both dialects; block-level mrkdwn (`•`
 *  bullets, quotes) cannot survive here — `parseDirectives` has already collapsed
 *  the request to one line. */
function markdownEmphasis(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/(^|[\s([{"'>])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s)\]}.,!?:;"'<])/gm, "$1**$2**");
  }
  return parts.join("");
}

/** Whether a channel's text is Slack mrkdwn (AGENTS.md invariant 4: the id
 *  prefix names the platform) — the ONE gate on `humanizeMessageText` for the
 *  run record. HTTP, MCP, CLI and cron text is not mrkdwn and is recorded raw,
 *  exactly as the model received it. */
export function isMrkdwnChannel(channelId: string): boolean {
  return channelId.startsWith("slack:");
}

/** A short, quoted snippet of the request text for a run label: links
 *  humanized, whitespace collapsed, cut at the first sentence end or ~SNIPPET_MAX
 *  chars (whichever comes first, on a word boundary), ellipsized when anything
 *  was dropped. Empty/whitespace-only text → undefined (no snippet segment). */
function textSnippet(text: string): string | undefined {
  const collapsed = humanizeLinks(text).replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  // First sentence, when it ends within the budget AND there is more after it.
  // `#41` / `example.com/x` must not count as a sentence end, so a period only
  // ends a sentence when followed by whitespace. (No `$` alternative: it would
  // match the end of the SLICE, turning a dot at the budget edge inside a token
  // into a false sentence end. A dot ending the whole text needs no sentence
  // cut — the "whole thing fits" branch below covers it.)
  const end = collapsed.slice(0, SNIPPET_MAX + 1).search(/[.!?](?=\s)/);
  if (end !== -1 && end + 1 < collapsed.length) return `"${collapsed.slice(0, end)}…"`;
  // Otherwise the whole thing if it fits …
  if (collapsed.length <= SNIPPET_MAX) return `"${collapsed}"`;
  // … or a word-boundary cut with an ellipsis (fall back to a hard cut if the
  // first "word" alone already overflows the budget).
  const hard = collapsed.slice(0, SNIPPET_MAX);
  const wordCut = hard.replace(/\s+\S*$/, "").trimEnd();
  const body = wordCut.length >= SNIPPET_MAX / 2 ? wordCut : hard.trimEnd();
  return `"${body}…"`;
}

/** Longest `assistant` excerpt shown as the card's one-line activity trace. */
const ASSISTANT_TRACE_CAP = 80;

/**
 * The one-line activity trace the status card shows for a run event (the card
 * is a digest; the run page is the record). An `assistant` turn becomes a short
 * `💬` excerpt — one line, replaced by the next event, so the model's prose is
 * visible in-channel without ever growing the card. `input`, `context` and
 * `answer` are published straight to the registry and never arrive here; the
 * fallbacks only keep the switch total.
 */
function activityLine(e: RunEvent): string {
  switch (e.type) {
    case "tool_call":
      return `→ ${e.summary}`;
    case "tool_result":
      return `${e.ok ? "✓" : "✗"} ${e.tool}: ${e.summary}`;
    case "run_note":
      return `⏱ ${e.summary}`;
    case "assistant": {
      const oneLine = e.text.replace(/\s+/g, " ").trim();
      return `💬 ${oneLine.length > ASSISTANT_TRACE_CAP ? `${oneLine.slice(0, ASSISTANT_TRACE_CAP)}…` : oneLine}`;
    }
    case "input":
      return "request received";
    case "context":
      return "context recorded";
    case "answer":
      return "answer ready";
    case "turn":
      return ""; // legacy stored records only; a live run's thought line rides the runner's progress note
    case "run_meta":
      return "run context recorded"; // published straight to the registry too — never arrives here
    case "skill_use":
      return `📚 skill ${e.skill} loaded`;
    case "mcp_tool_use":
      return `🔌 ${e.server}/${e.tool} ${e.ok ? "ok" : "failed"} (${e.durationMs} ms)`;
    case "review_artifact":
      return "reading diff ready"; // published straight to the registry — never arrives here
    case "pr_description":
      return "PR description recorded"; // published straight to the registry — never arrives here
    case "pr_opened":
      return "PR opened"; // published straight to the registry — never arrives here
    case "ship_round":
      return `round ${e.index} (${e.agent}): ${e.outcome}`; // published straight to the registry — never arrives here
    case "span_start":
    case "span_end":
      return ""; // timing, not activity (features/tracing.md): the card's activity line never shows a span
  }
}

/**
 * One-line note of what rode along with the request, for the `input` event
 * (features/live-view.md item 12): `[+2 images, 1 document]`. Counts only — the
 * payloads never enter the run stream. Empty when nothing was attached.
 */
export function attachmentSuffix(
  images: ImageAttachment[] | undefined,
  documents: DocumentAttachment[] | undefined,
): string {
  const parts: string[] = [];
  if (images && images.length > 0) parts.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
  if (documents && documents.length > 0) parts.push(`${documents.length} document${documents.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? `[+${parts.join(", ")}]` : "";
}

/**
 * Build the human-first run label shown on the Access-gated `/runs` index. Rules:
 * - always lead with the agent name;
 * - a repo run is repo-identified (`coding · owner/repo · "…"`);
 * - a chat run shows channel + user (`review · #<channel> · <user> · "…"`),
 *   preferring display names and falling back to the prefix-stripped ids;
 * - a short quoted snippet of the request is appended when the text is non-empty;
 * - the whole thing is capped to RUN_LABEL_MAX chars.
 * Pure and channel-agnostic (HTTP/MCP have no names → the id fallback applies).
 */
export function composeRunLabel(input: RunLabelInput): string {
  const segments: string[] = [input.agent];
  if (input.repo) {
    segments.push(input.repo);
  } else {
    segments.push(`#${input.channelName ?? stripPlatformPrefix(input.channelId)}`);
    segments.push(input.userName ?? stripPlatformPrefix(input.userId));
  }
  const snippet = textSnippet(input.text);
  if (snippet) segments.push(snippet);
  const label = segments.join(" · ");
  return label.length > RUN_LABEL_MAX ? `${label.slice(0, RUN_LABEL_MAX - 1).trimEnd()}…` : label;
}

/** Prefixes the core stamps on status text — adapters use this to filter their
 *  own status noise out of history. */
export const STATUS_PREFIXES = ["⏳", "✅", "◐", "◓", "◑", "◒"];

/** The notice the drain (src/index.ts) sets on SIGTERM from a deploy rollout.
 *  Exported so the Slack adapter's orphan sweep can strip it from a frozen
 *  card's title (#357) — an interrupted card must not keep the stale
 *  "finishing this run" clause. Shared like LIVE_CARD_PREFIXES, so the text
 *  the drain appends and the text the sweep strips cannot drift apart. */
export const DEPLOY_RESTART_NOTICE = "⏸ deploy in progress — this run continues through the bot restart";

/** Set by the process-wide drain (SIGTERM from a deploy rollout) and appended to
 *  every live card's heartbeat frame, so a reader can tell "finishing this run
 *  before the bot restarts" from a run that is merely slow. `undefined` clears
 *  it (tests). A plain module-level value: the drain is process-wide by nature
 *  and every in-flight run must show it, not only runs started after it. */
let shutdownNotice: string | undefined;
export function setShutdownNotice(notice: string | undefined): void {
  shutdownNotice = notice;
}

function buildMessages(
  history: HistoryItem[],
  currentText: string,
  currentImages?: ImageAttachment[],
  currentDocuments?: DocumentAttachment[],
): ChatMessage[] {
  const messages: ChatMessage[] = history.map((h) => ({
    role: h.role,
    content: turnContent(h.text, h.images, h.documents),
  }));
  messages.push({ role: "user", content: turnContent(currentText, currentImages, currentDocuments) });
  return normalizeAlternation(messages);
}

/**
 * Attachments first (images, then documents), then the user's text — a turn
 * always has at least one part. PDFs become a native `document` part; text/code
 * files are inlined as a fenced text part naming the file (provider-agnostic).
 * Exported for tests.
 */
export function turnContent(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): ContentPart[] {
  const parts: ContentPart[] = (images ?? []).map((img) => ({
    type: "image" as const,
    mediaType: img.mediaType,
    data: img.data,
  }));
  for (const doc of documents ?? []) {
    if (doc.mediaType === "application/pdf") {
      parts.push({ type: "document", mediaType: doc.mediaType, data: doc.data, name: doc.name });
    } else {
      parts.push({ type: "text", text: fenceFile(doc.name, doc.data) });
    }
  }
  if (text) parts.push({ type: "text", text });
  if (parts.length === 0) parts.push({ type: "text", text: "(empty message)" });
  return parts;
}

/**
 * The text recorded for one turn in the run stream (#157 R1): the turn's text
 * plus one metadata line per attachment — name, media type, decoded size — and
 * NEVER the attachment itself (no base64, no file body). Images and PDFs carry
 * base64 (size = decoded bytes); text/code documents carry their decoded text.
 * The text is humanized (`humanizeMessageText`: Slack link/mention markup
 * unwrapped, entities unescaped) — every caller feeds channel-authored turns.
 * Redaction happens at publish, not here.
 */
function messageText(
  text: string,
  humanize: boolean,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
): string {
  const lines = [(humanize ? humanizeMessageText(text) : text).trim()];
  for (const img of images ?? [])
    lines.push(attachmentLine(img.name, img.mediaType, Buffer.byteLength(img.data, "base64")));
  for (const doc of documents ?? []) {
    const bytes = Buffer.byteLength(doc.data, doc.mediaType === "application/pdf" ? "base64" : "utf8");
    lines.push(attachmentLine(doc.name, doc.mediaType, bytes));
  }
  return lines.filter((l) => l.length > 0).join("\n");
}

function attachmentLine(name: string | undefined, mime: string, bytes: number): string {
  return `[attachment: ${name ?? "attachment"} · ${mime} · ${bytes} bytes]`;
}

/**
 * The thread-context turns to record as `context` events (#157 KTD8): the
 * NEWEST turns first, at most `CONTEXT_MAX_ITEMS`, until the redacted texts
 * together exceed `CONTEXT_MAX_BYTES` — then returned in thread order. Each turn is prefixed with its role so a context row reads as
 * the conversation did; attachments are metadata lines (see `messageText`).
 */
function contextMessageTexts(history: readonly HistoryItem[], humanize: boolean): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < CONTEXT_MAX_ITEMS; i--) {
    const h = history[i];
    const text = `${h.role}: ${messageText(h.text, humanize, h.images, h.documents)}`;
    // Budget what will actually be published (publishText redacts).
    const size = utf8ByteLength(redactSecrets(text));
    if (bytes + size > CONTEXT_MAX_BYTES) break;
    bytes += size;
    kept.push(text);
  }
  return kept.reverse();
}

/** Inline a text/code file's content, fenced and labeled with its name. */
function fenceFile(name: string | undefined, content: string): string {
  return `\n\n[file: ${name ?? "attachment"}]\n\`\`\`\n${content}\n\`\`\`\n`;
}

/** Providers require user-first and behave best with merged consecutive roles. */
function normalizeAlternation(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
    } else {
      out.push({ role: m.role, content: [...m.content] });
    }
  }
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}

/** Repo resolution for a chat command that asks for the thread's bound repo
 *  (`Caller.origin.repo`, e.g. `memory list` with the repo scope, #253): the
 *  injected resolver in tests, the production resolver (registry-vetted slugs,
 *  PR → repo) otherwise; a failure means "no repo bound", never an error reply. */
async function resolveRepoForCommand(
  deps: CoreDeps,
  msg: IncomingMessage,
  history: HistoryItem[],
): Promise<RepoContext> {
  try {
    return (
      (await (deps.resolveRepoContext
        ? deps.resolveRepoContext(msg, history)
        : resolveRepoContext(
            msg,
            history,
            residentOnboardedProbe(deps.config.config.execution?.resident),
            residentSlugsLister(deps.config.config.execution?.resident),
          ))) ?? {}
    );
  } catch {
    return {};
  }
}

/** The card's shape and queued lines at a close (features/tracing.md item 5):
 *  the root's streamed children so far, partitioned over the request's window
 *  — to the finish for a run that ran, to now for a close before any run. The
 *  card's own gate (a minute, or 15 s of getting ready) applies. */
function cardLines(
  trace: RequestTrace,
  opts: { end: number; finished: boolean; owner: RunOwner; queued: string | undefined },
): { shape?: string; queued?: string } {
  const shape = cardShapeLine(trace.spansSoFar(), {
    window: { start: trace.receivedAt, end: opts.end },
    owner: opts.owner,
    finished: opts.finished,
  });
  return { ...(shape ? { shape } : {}), ...(opts.queued ? { queued: opts.queued } : {}) };
}
