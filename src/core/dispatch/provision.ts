// The provision stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// everything a run needs before its first model turn, in the order the request
// meets it. The memory read started; the ack card the thread sees while setup
// runs; the run's row on every surface before the attach (the registry row, its
// label and link, the request and context events, the ledger reservation); the
// workspace attach and its ask-once refusal; the prompt (skills, MCP discovery,
// the config and self-description blocks, the custom instructions, the memory
// block, the system composer pinned to the head under review); and the
// conversation the model is handed. Each function returns what it took hold of
// — the card, the registry row, the reservation — so `dispatch()` records it
// before the next step that can throw and its outer finally releases exactly
// what the inline code did.
import type { ConfigStore, ResolvedRequest } from "../../config.js";
import { coordinatorFields, type CoordinatorTag } from "../coordinator/contract.js";
import { AGENTS, type AgentDef } from "../../agents/registry.js";
import { chatActorOf } from "../authz/actor.js";
import { clipSourceLabel, type RunProfile } from "../../config/profile.js";
import type { RequestDirectives, ThreadDirectives } from "../../directives.js";
import {
  WorkspaceReattachLeaseSpentError,
  WorkspaceReattachRefusedError,
  type ExecutorSelection,
  type WorkspaceBinding,
} from "../../execution/factory.js";
import { isRunStopError } from "../../execution/executor.js";
import type { ResidentStep } from "../../execution/residentStepTrace.js";
import { graftResidentSteps, residentTraceOf } from "../../execution/residentTrace.js";
import { ResidentNeedsRefError } from "../../execution/resident.js";
import { memoryContextBlock, type MemoryStore } from "../memory/index.js";
import { provisionalBearerExpiresAt } from "../budgets.js";
import type { RunBearerStore } from "../modelProxy/runBearers.js";
import { parseModelRef, wireOf } from "../provider.js";
import { skillGuidanceBlock, type SkillStore } from "../../skills/index.js";
import { mcpGuidanceBlock, type McpToolSource, type McpToolsForRun } from "../../mcp/source.js";
import { configAwarenessBlock } from "../configAwareness.js";
import { selfDescriptionBlock, type BuildFacts } from "../selfDescription.js";
import { customInstructionsBlock } from "../customInstructions.js";
import type { ResidentFleetFacts } from "../residentFleet.js";
import { attachRoundWorkspace, makeSystemComposer, type RoundWorkspace } from "../reviewRound.js";
import { ownPrOf, type RepoContext } from "../repoContext.js";
import { redactSecrets, type AgentSource, type RunEvent } from "../runEvents.js";
import { oneLine } from "../redact.js";
import type { ControlDecision, ModelCard } from "../modelCard.js";
import { MAX_EVENT_BYTES, utf8ByteLength, type RunSeed } from "../runRecord.js";
import type { RunHandle, RunRegistry } from "../runRegistry.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { LiveRunRow } from "../runLedger/types.js";
import { durableInboxMessage } from "../runLedger/inboxMessage.js";
import type { Clock, Span } from "../trace/types.js";
import type { RequestTrace } from "../requestTrace.js";
import { createCardShell, type CardShell } from "../statusCardFrame.js";
import { coalesceStatus } from "../statusCoalescer.js";
import type { LiveThread } from "../threadAdmission.js";
import type { ChannelVisibility } from "../authz/types.js";
import { messageIdOf, type ChannelIO, type HistoryItem, type IncomingMessage, type StatusHandle } from "../types.js";
import type { AdmissionDeps, DispatchFollowUp, RestartContext, ResumeContext, RunHooks } from "./admission.js";
import type { AuthorizeDeps, GateCard, GateContext } from "./authorize.js";
import { channelVisibilityOf, type RecordDeps } from "./record.js";
import {
  attachmentSuffix,
  composeRunLabel,
  humanizeMessageText,
  isMrkdwnChannel,
  liveViewLink,
  REFUSAL_SENTENCES,
} from "./reply.js";
import { refusalOf } from "../refusal.js";
import { contextMessageTexts, type TextTurn } from "./messages.js";
import { routeReasonLabel, routedPartLines, type RouteDecided } from "./route.js";
import type { HarnessProcessDeps } from "./run.js";
import { harnessNamed } from "../harness/roster.js";
import type { ReferencedConversation } from "../references/types.js";

/** What the provision stage reads off the dispatcher's dependencies. A run's
 *  row is stamped with its channel's visibility (the record slice), reserved on
 *  the ledger (the admission slice's `runLedger`) and its prompt names what is
 *  on (the authorize slice's `capabilities`). `CoreDeps` extends this; a
 *  caller's shape is unchanged. */
export interface ProvisionDeps
  extends RecordDeps, Pick<AdmissionDeps, "runLedger">, Pick<AuthorizeDeps, "capabilities"> {
  config: ConfigStore;
  /** The harnesses the process drives runs with (docs/reference/specs/harness.md
   *  items 8 and 10), for the name `run_meta` carries — the one the scopes'
   *  word for the preset picks; absent in a process that starts no run (a test
   *  of the stages before the loop), and the meta names none. */
  harness?: HarnessProcessDeps;
  /** where runtime state (sandboxes.json) lives; default ./data */
  dataDir?: string;
  /** What the resident Worker last said about the fleet (its cap), read in the
   *  background so the About block names the Worker's number, never a constant
   *  (routing-and-config item 11). `NO_FLEET` without residents. */
  residentFleet: ResidentFleetFacts;
  /** The version and commit this process runs (index.ts: the package version and the image's
   *  build stamp), named in the About block so "what are you running?" is answered from fact.
   *  Absent in a process with nothing to say about itself (tests). */
  build?: BuildFacts;
  /**
   * Cross-session memory store (docs/decisions/0017-memory-off-by-default.md). When `config.memory.enabled`
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
   * Skill store backing the load-a-skill capability. When present, the
   * dispatcher appends the calling agent's scoped skill name+description list to
   * its system prompt (progressive disclosure) and passes the store to the tool
   * context so list_skills/use_skill work. Absent (as in most unit tests) →
   * no skill block and the skill tools report themselves unavailable, leaving
   * the request unchanged. Production wires a BundledSkillStore (src/index.ts,
   * src/cli.ts); the DO-backed upload store is PR2, behind this same interface.
   */
  skills?: SkillStore;
  /**
   * External MCP servers as tools (docs/reference/specs/mcp-tools.md). Asked once
   * per run, before the first model turn, for the servers scoped to the
   * resolved agent; the bridged tools ride `RunOptions.extraTools` and the
   * outcome becomes the MCP prompt block + one `mcp_unavailable` note per
   * server that did not answer. No server scoped to the agent — the
   * `NullMcpToolSource` of a process without MCP included — → the request is
   * byte-identical to before the feature. Whether the self-serve surface
   * (`mcp add …`) exists is `capabilities.mcp`, which the config awareness
   * block tells the model (docs/reference/specs/mcp-tools.md item 17).
   */
  mcp: McpToolSource;
  /** Floor between two status-card edits (default `STATUS_UPDATE_MIN_MS`).
   *  Tests that assert on an individual intermediate frame set 0. */
  statusUpdateMinMs?: number;
  /**
   * The run-scoped bearers the model proxy honours (docs/reference/specs/model-proxy.md):
   * one is minted here the moment a run's executor is provisioned, and the
   * dispatch revokes it when the run ends. Absent (the CLI, tests) → no bearer
   * is minted and the run is byte-identical to before the proxy existed.
   */
  runBearers?: RunBearerStore;
}

/**
 * The memory read, STARTED: a promise the caller awaits when the prompt is
 * composed, so the memory Worker round trip overlaps the repo/PR resolution and
 * the workspace attach. Never before the agent gate (a refused request must not
 * touch memory); with memory off it resolves to no block and the request is
 * byte-identical to memory-off.
 */
export function startMemoryRead(
  deps: ProvisionDeps,
  ctx: { msg: IncomingMessage; directives: RequestDirectives; repoCtxP: Promise<RepoContext>; root: Span },
): ReturnType<typeof memoryContextBlock> {
  const { msg, directives, repoCtxP, root } = ctx;
  // Cross-session memory — READ path, STARTED here and awaited
  // below, so the memory Worker round trip (up to 5 s) overlaps the repo/PR
  // resolution and the executor attach instead of adding to them. Its scopes
  // are the org, this channel, this user, and — once resolution settles —
  // the bound repo; the read never depends on the repo GATE, only on
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
  return memoryBlockP;
}

/** The ack card the thread sees while setup runs: its shell (the one builder
 *  for every paint), the coalesced handle, and the heartbeat that paints the
 *  setup step in flight until the run loop takes over. */
export interface AckCard {
  shell: CardShell;
  card: StatusHandle;
  heartbeat: ReturnType<typeof setInterval>;
}

/** What `openAckCard` reads off the dispatch. */
export interface AckCardContext {
  io: ChannelIO;
  agent: AgentDef;
  resolved: ResolvedRequest;
  /** The card's clock start: a carried row's, else the request's receipt. */
  startedAt: number;
  clock: Clock;
  root: Span;
  trace: RequestTrace;
  /** The router's decision when it chose the preset (routing-and-config item
   *  21): the card's label gains a `debug` note ` · route reason: <reason>`
   *  and a compound's parts lead its detail, one line each. */
  route?: RouteDecided;
}

/**
 * Acknowledge NOW, before anything slow — the same handle becomes the run's
 * status card; a refusal or setup failure closes it with a reason. The caller
 * keeps all three: the outer catch closes a card setup left open, the outer
 * finally clears the heartbeat.
 */
export async function openAckCard(deps: ProvisionDeps, ctx: AckCardContext): Promise<AckCard> {
  const { io, agent, resolved, startedAt, clock, root, trace, route } = ctx;
  // One builder for every paint of this card (statusCardFrame.ts): the ack,
  // the spinner frames, the closes before the run starts, the done frame. The
  // card speaks at the request's verbosity (routing-and-config item 28): the
  // label is `*review* on `m`` for everyone; a routed run's reason is a `debug`
  // note on it (`· route reason: <reason>`, the collapse of a compound answer
  // named after it), and a routed compound lists its parts under the label,
  // `<preset>: <text>`, at every level — they say what was asked.
  const shell = createCardShell({
    label: `*${agent.name}* on \`${resolved.modelRef}\``,
    startedAt,
    now: clock,
    verbosity: resolved.verbosity,
    ...(route?.parts ? { lead: routedPartLines(route.parts) } : {}),
  });
  if (route) shell.note("debug", routeReasonLabel(route.reason, route.collapsed));
  // Coalesced: the run below refreshes it on every event, the channel sees at
  // most one edit per STATUS_UPDATE_MIN_MS, always the newest frame.
  const card = coalesceStatus(
    await root.span("dispatch.ack_card", () => io.status(shell.ack())),
    deps.statusUpdateMinMs ?? STATUS_UPDATE_MIN_MS,
  );
  // From here the card names the setup step in flight (the card sink's
  // display label — `attaching the workspace…`) until the agent loop starts;
  // the setup heartbeat paints it.
  trace.bindCard({ setupLabel: (label) => shell.setSetupLabel(label) });
  const heartbeat = setInterval(() => card.update(shell.live()), 5000);
  return { shell, card, heartbeat };
}

/**
 * The card's budget line (docs/reference/specs/routing-and-config.md item 4):
 * what clipped the run's budget below the preset's own — `budget 45 min
 * (channel boundary; preset asks 90)`, `budget 30 min (budget directive;
 * preset asks 120)` — and, when the request carried a `budget:` directive that
 * did not win, that it narrowed nothing: `budget:200 narrowed nothing (preset
 * asks 120)` alone, or appended to the clip of the boundary that was tighter.
 * Appended to the card's label the way a resident note is, so the clip is
 * visible where the run is watched. Undefined when the preset's own budget
 * stands and no directive was sent — the card is then exactly what it was.
 */
export function budgetClipLabel(
  agent: AgentDef,
  profile: RunProfile,
  budgetDirective?: number,
  source: { coordinator?: boolean } = {},
): string | undefined {
  const idle = budgetDirective !== undefined && profile.boundedBy !== "directive";
  if (profile.boundedBy === undefined) {
    return idle ? `budget:${budgetDirective} narrowed nothing (preset asks ${agent.maxMinutes})` : undefined;
  }
  // A plan runner's child took its minutes from the runner's carve (agent-ship
  // item 8): the pipeline's remainder minus the reserve for the rounds after
  // it — the directive on its request is the runner's, not a person's.
  const clippedBy =
    profile.boundedBy === "directive" && source.coordinator
      ? "carved by the plan runner from the pipeline's remaining clock"
      : clipSourceLabel(profile.boundedBy);
  const facts = [`${clippedBy}; preset asks ${agent.maxMinutes}`];
  if (idle) facts.push(`budget:${budgetDirective} narrowed nothing`);
  return `budget ${profile.minutes} min (${facts.join("; ")})`;
}

/** The run as every surface sees it from the reservation on: its registry row,
 *  the id the row and the record share, the channel-visibility stamp, the live
 *  page link, and the two publishers the dispatch keeps for the narrative
 *  events it writes later (the answer; the run meta again when the attach
 *  adopts a moved head). */
export interface RegisteredRun {
  run: RunHandle;
  runId: string;
  channelVisibility: ChannelVisibility;
  liveUrl: string | undefined;
  publishText: (
    type: "input" | "context" | "answer",
    text: string,
    source?: { url?: string; channel?: string; user?: string },
    raw?: string,
  ) => void;
  /** Publishes the run's meta for the repo context as it stands NOW. */
  publishMeta: (repoCtx: RepoContext) => void;
}

/** What `registerRun` reads off the dispatch. */
export interface RegisterRunContext {
  msg: IncomingMessage;
  io: ChannelIO;
  agent: AgentDef;
  resolved: ResolvedRequest;
  directives: RequestDirectives;
  history: HistoryItem[];
  repoCtx: RepoContext;
  carriedRow: LiveRunRow | undefined;
  resume: ResumeContext | undefined;
  startedAt: number;
  receivedAt: number;
  clock: Clock;
  root: Span;
  trace: RequestTrace;
  registry: RunRegistry;
  shell: CardShell;
  admitted: LiveThread<DispatchFollowUp>;
  /** The run that spawned this one (run-history item 46), when it is a child. */
  parentRunId?: string;
  /** The coordinator's instance and key (item 48), when a coordinator spawned it. */
  coordinator?: CoordinatorTag;
  /** Where the run's conversation starts (run-history item 52): `parent` for
   *  a spawned child, `channel` otherwise — on the registry row's meta from
   *  the first moment, so the summary and the drain's record carry it. The
   *  dispatcher always hands it; a hand-built context has none. */
  seed?: RunSeed;
  /** A spawned child's seed (`DispatchOptions.seed`): the turns its model
   *  starts from, recorded as its `context` events in place of the thread its
   *  lead was posted in — the record shows what the model saw. */
  seedTurns?: TextTurn[];
  /** How the preset was chosen (`run_meta.agentSource`). */
  agentSource: AgentSource;
  /** The model card resolved before the first call (record 0052) and
   *  every control's decision against it (record 0052); the degraded decisions become
   *  `control_degraded` notes before the first turn. A hand-built context (a
   *  test) may carry none. */
  modelCard?: ModelCard;
  cardDecisions?: ControlDecision[];
  /** The conversations the request pointed at and the step quoted (record
   *  0037): one `reference` event each, right after `input`. Absent or empty
   *  when the request carried none or the step is off. */
  references?: { conversations: readonly ReferencedConversation[]; blocks: readonly string[] };
  /** The router's answer, when it gave one, as the record's `route` event: the
   *  preset it chose (with a compound's parts), or the default the run fell
   *  to after a rejected compound with the `compound_rejected` reason. */
  route?: RouteDecided;
}

/**
 * The run's row on every surface BEFORE the workspace attach (run-history item
 * 42): the registry row with its human label and capability link, the request
 * as the record's first content event, the run meta, the thread context. The
 * caller records `run` the moment this returns — nothing here awaits after the
 * row is created — so a later throw discards it.
 */
export async function registerRun(deps: ProvisionDeps, ctx: RegisterRunContext): Promise<RegisteredRun> {
  const {
    msg,
    io,
    agent,
    resolved,
    directives,
    history,
    repoCtx,
    carriedRow,
    resume,
    startedAt,
    receivedAt,
    clock,
    root,
    trace,
    registry,
    shell,
    admitted,
    parentRunId,
    coordinator,
    seed,
    seedTurns,
    agentSource,
    modelCard,
    cardDecisions,
    route,
  } = ctx;
  // The reservation (item 42): the run's row BEFORE the workspace attach —
  // identity, request, card, no prompt — so a kill during a slow attach (a
  // resident's mutex wait, a cold clone) leaves a row the next generation
  // restarts instead of a run that vanished. Its heartbeat holds the lease
  // through the attach; the claim after the prompt exists promotes it. A
  // resume adopted its row above; a restart reserved it above.
  // The run's id, minted here (item 42) — after the ship fork, which mints
  // its own — so the registry row, the row reserved before the attach and
  // the record all share it; a resume or a restart keeps the row's.
  const runId = carriedRow?.runId ?? registry.mintId();
  // Asked once per run (the authorization spec's channel-visibility rule):
  // the registry row, the reservation and the claim reuse it.
  const channelVisibility = await root.span("dispatch.channel_visibility", () =>
    channelVisibilityOf(deps, msg.channelId),
  );
  // The registry row, created NOW — before the reservation and the attach —
  // so the run is one row on every surface from the moment it is admitted:
  // the runs index lists it with its label and its capability link, the run
  // page serves it, a stop during the attach latches in its control. Before
  // this the row came after the attach, and the runs index showed the
  // reservation meanwhile as a labelless ledger row with a tokenless link.
  // Its stream stays empty until the run loop binds the trace below (the
  // request is the first event of the record, live-view item 12).
  // A human-first label for the Access-gated runs index (`GET /runs`): agent +
  // repo (repo runs) or channel/user (chat runs) + a snippet of the request,
  // so a row reads like `review · #general · alice · "…"` rather
  // than raw ids. Built from the directive-stripped text so directives (agent:/
  // model:) never clutter the snippet. The registry redacts and caps it;
  // `run.label` is the one the record and the friction row carry (never
  // `runLabel`, which may hold a pasted secret).
  const runLabel = composeRunLabel({
    agent: agent.name,
    repo: repoCtx.repo,
    channelId: msg.channelId,
    userId: msg.userId,
    channelName: msg.channelName,
    userName: msg.userName,
    text: directives.text,
  });
  const run = registry.create(
    runLabel,
    {
      agent: agent.name,
      model: resolved.modelRef,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
      channelVisibility,
      ...(carriedRow ? {} : { receivedAt }), // the window opens at receipt (docs/reference/specs/tracing.md); a resume or restart keeps its original stamps
      ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
      ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
      ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
      ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      ...coordinatorFields(coordinator),
      ...(seed !== undefined ? { seed } : {}),
    },
    // Under the run's id, at the card's start (the reservation's, or the
    // carried row's) — a resume replays its events, a restart starts them
    // afresh at the row's original start.
    { id: runId, startedAt, ...(resume ? { replay: resume.events } : {}) },
  );
  // With no PUBLIC_BASE_URL the link is simply omitted — the feature
  // degrades gracefully, the run is otherwise unchanged. The card carries it
  // from here, and a follow-up's ack/refusal can link the run page
  // (thread-admission item 1).
  const liveUrl = liveViewLink(run.id, run.token);
  shell.setLink(liveUrl ? { url: liveUrl, label: "Live run" } : undefined);
  if (liveUrl) admitted.runLink = liveUrl;
  io.runStarted?.({ id: run.id });
  // The run's stream is live from here (docs/reference/specs/tracing.md item 6): the
  // spans so far — the root, the ack card, the repo resolution — are
  // backfilled, and the attach and the resident's grafted steps stream as
  // they happen, so the run page and the index's event count move through a
  // long attach. Every streamed setup span is head material
  // (`isHeadMaterial`: `request`, `slack.receive`, `dispatch.*`), so the
  // protected head still runs unbroken from the first event through the
  // request published next.
  trace.bindRun(run.id, (e) => registry.publish(run.id, e));
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
    // The request names its message (live-view.md item 26): the id the files
    // received with it also carry, so the page joins them by data.
    const body = { text: redacted, ...(source ? { source } : {}), at: clock() };
    const event: RunEvent =
      type === "input" ? { type, messageId: messageIdOf(msg, run.id), ...body } : { type, ...body };
    // The model's raw answer rides on the event only when normalization
    // changed it AND the event still fits the per-event byte budget — the
    // budget already truncates `text` and must not be starved by a second
    // copy (docs/reference/specs/llm-output.md item 5).
    const withRaw = raw !== undefined ? { ...event, raw: redactSecrets(raw) } : event;
    registry.publish(run.id, utf8ByteLength(JSON.stringify(withRaw)) <= MAX_EVENT_BYTES ? withRaw : event);
    console.log(`[event] ${msg.threadKey} type=${type} bytes=${utf8ByteLength(redacted)}`);
  };
  // The request is the first content event of the run record (live-view item
  // 12), published NOW — before the attach — so the run page shows what the
  // run is about while the workspace is still being attached: the
  // directive-stripped text, humanized (Slack `<url|label>`/mention markup
  // unwrapped, entities unescaped — it is channel-authored mrkdwn, not prose)
  // + an attachment count. Every other channel's text is recorded exactly as
  // it was dispatched to the model, so the record never diverges from the input.
  const humanize = isMrkdwnChannel(msg.channelId);
  const attachments = attachmentSuffix(msg.images, msg.documents);
  const source = {
    ...(msg.sourceUrl ? { url: msg.sourceUrl } : {}),
    ...(msg.channelName ? { channel: msg.channelName } : {}),
    ...(msg.userName ? { user: msg.userName } : {}),
  };
  const requestText = humanize ? humanizeMessageText(directives.text) : directives.text;
  if (!resume)
    publishText(
      "input",
      attachments ? `${requestText} ${attachments}` : requestText,
      Object.keys(source).length > 0 ? source : undefined,
    );
  // The conversations the request pointed at (record 0037), one `reference`
  // event each, right after the request: the block as the model saw it,
  // redacted, under the per-event byte budget by the step's own caps, so the
  // page shows exactly what was quoted and the record's `references` field
  // (derived from these events at finish) says where it came from.
  if (!resume && ctx.references) {
    const { conversations, blocks } = ctx.references;
    conversations.forEach((rc, i) => {
      registry.publish(run.id, {
        type: "reference",
        url: rc.permalink,
        channelId: rc.ref.channelId,
        channelName: rc.channelName,
        messages: rc.messages.length,
        text: redactSecrets(blocks[i] ?? ""),
        at: clock(),
      });
      console.log(`[event] ${msg.threadKey} type=reference channel=${rc.ref.channelId} messages=${rc.messages.length}`);
    });
  }
  // What the run is about (live-view item 19): agent, model, and the repo
  // context as resolved NOW — so the page can head the record with linked
  // owner/repo · ref · #PR · sha. Straight after the request; published once
  // more if the attach adopts a moved PR head below (readers take the latest).
  const publishMeta = (repoCtx: RepoContext) =>
    registry.publish(run.id, {
      type: "run_meta",
      agent: agent.name,
      agentSource,
      model: resolved.modelRef,
      traceId: root.traceId,
      // The harness the run is driven by (harness.md items 8 and 10): the
      // object the scopes' word for the preset picks off the roster — the
      // requester's own scope, the channel's or the deployment's block, pi
      // when none names it — by its own name, and the scope whose word it
      // was, so a record can be told from another harness's and a reader
      // never guesses whose override put a run there; none in a process that
      // starts no run. A resumed run publishes no meta (above), and its
      // harness is its row's, not the word's.
      ...(deps.harness
        ? {
            harness: harnessNamed(deps.harness.harnesses, resolved.harness?.name).name,
            ...(resolved.harness ? { harnessScope: resolved.harness.scope } : {}),
          }
        : {}),
      ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
      ...(modelCard ? { card: modelCard } : {}),
      ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
      ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
      ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
      ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
      at: clock(),
    });
  if (!resume) publishMeta(repoCtx);
  // The card's degradations, one typed note each, before the first turn
  // (record 0052): a control the card cannot vouch for is never a silent
  // downgrade. A refusal never reaches here — the resolve stage refused it.
  if (!resume)
    for (const d of cardDecisions ?? []) {
      if (d.outcome !== "degraded") continue;
      registry.publish(run.id, {
        type: "run_note",
        kind: "control_degraded",
        summary: oneLine(
          `${d.control}${d.asked !== undefined ? ` ${d.asked}` : ""} → ${d.applied ?? "?"} (${d.vouched ? "fallback" : "unvouched"}): ${d.why}`,
        ),
        control: d.control,
        ...(d.asked !== undefined ? { asked: d.asked } : {}),
        ...(d.applied !== undefined ? { applied: d.applied } : {}),
        vouched: d.vouched,
        why: d.why,
        at: clock(),
      });
    }
  // The router's decision (routing-and-config item 21), right after the meta
  // it explains: the preset, the reason the card carries, the model that
  // decided, a compound's parts — or the rejection that left the run on the default.
  if (!resume && route) registry.publish(run.id, { type: "route", ...route, at: clock() });
  // The thread context fed to the model follows the request as `context`
  // events — text only, attachments as metadata lines, bounded to
  // the newest CONTEXT_MAX_ITEMS turns within CONTEXT_MAX_BYTES. A spawned
  // child's context is its seed — the parent's turns its model starts from —
  // not the thread its lead was posted in: the record shows what the model saw.
  if (!resume && deps.config.config.runHistory?.includeContext !== false) {
    for (const text of contextMessageTexts(seedTurns ?? history, humanize)) publishText("context", text);
  }
  return { run, runId, channelVisibility, liveUrl, publishText, publishMeta };
}

/** A fresh request's reservation on the ledger: the row (undefined when the
 *  ledger refused it — the run is then untracked) and the request as the row
 *  carries it, which the claim after the prompt re-sends. */
export interface Reservation {
  reserved: LedgerRun | undefined;
  requestRow: Record<string, unknown>;
  /** Why the ledger would not take the run, when it would not (run-history item 54). */
  untrackedWhy?: string;
}

/** What `reserveRun` reads off the dispatch. */
export interface ReserveContext {
  msg: IncomingMessage;
  agent: AgentDef;
  /** The run's effective profile: the row's read-only flag reads its identity. */
  profile: RunProfile;
  resolved: ResolvedRequest;
  repoCtx: RepoContext;
  channelVisibility: ChannelVisibility;
  runId: string;
  startedAt: number;
  receivedAt: number;
  resume: ResumeContext | undefined;
  restart: RestartContext | undefined;
  card: StatusHandle;
  /** The dispatch's reservation hooks: a stop or a fence during the attach reaches the run's control. */
  hooks: RunHooks;
  admitted: LiveThread<DispatchFollowUp>;
  root: Span;
  /** The run that spawned this one (run-history item 46), when it is a child. */
  parentRunId?: string;
  /** The coordinator's instance and key (item 48), when a coordinator spawned it. */
  coordinator?: CoordinatorTag;
  /** Where the run's conversation starts (item 52), on the row so a reclaim keeps it. */
  seed?: RunSeed;
  /** The router's decision when it chose the preset, on the row (run-history item 35). */
  route?: RouteDecided;
}

/**
 * The ledger reservation (run-history item 42): a fresh request's row BEFORE
 * the attach, so a kill during a slow attach leaves a row the next generation
 * restarts. A resume adopted its row and a restart re-took its reservation at
 * admission: nothing to reserve, undefined. The slot is named with the run's id
 * only once the row exists.
 */
export async function reserveRun(deps: ProvisionDeps, ctx: ReserveContext): Promise<Reservation | undefined> {
  const {
    msg,
    agent,
    profile,
    resolved,
    repoCtx,
    channelVisibility,
    runId,
    startedAt,
    receivedAt,
    resume,
    restart,
    card,
    hooks,
    admitted,
    root,
    parentRunId,
    coordinator,
    seed,
    route,
  } = ctx;
  if (!resume && !restart) {
    const requestRow = durableInboxMessage(msg, msg.text, receivedAt);
    const reserved = await root.span("dispatch.ledger_reserve", () =>
      deps.runLedger.reserve({
        runId,
        threadKey: msg.threadKey,
        startedAt,
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
          ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
          ...(msg.postedBy !== undefined ? { postedBy: msg.postedBy } : {}),
          ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
          ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
          ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
          ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
          readonly: profile.identity === "read",
          profile,
          ...(parentRunId !== undefined ? { parentRunId } : {}),
          ...coordinatorFields(coordinator),
          ...(seed !== undefined ? { seed } : {}),
          ...(route !== undefined ? { route } : {}),
          request: requestRow,
        },
        card: card.handle ?? null,
        ...hooks,
      }),
    );
    // Named on the slot from here (the row exists now): a steer's durable
    // copy lands under it, and the boot-gap hand-off finds it. Deliberately
    // AFTER the reserve resolves, not before: a steer that lands during the
    // round trip rides in memory alone (thread-admission item 5 scopes the
    // durable window "from the reserve on"), where naming the run earlier
    // would push to a row that may not exist yet and warn for nothing.
    admitted.runId = runId;
    // The reservation's outcome as the row's fate (run-history item 54): the
    // tracked run, or why the ledger would not take it — for the run's record.
    return {
      reserved: reserved.kind === "tracked" ? reserved.run : undefined,
      requestRow,
      ...(reserved.kind === "untracked" ? { untrackedWhy: reserved.why } : {}),
    };
  }
  return undefined;
}

/** What the attach itself reads, with or without the dispatch-time gate: the
 *  thread, the round's agent and effective profile, the repository context,
 *  the span the attach hangs under and the clock that clips the resident's
 *  steps to it. */
export interface AttachContext {
  threadKey: string;
  agent: AgentDef;
  profile: RunProfile;
  repoCtx: RepoContext;
  /** The span the `dispatch.workspace.attach` span opens under: the request
   *  root at dispatch; the run's own span for a re-attach mid-run. */
  root: Span;
  clock: Clock;
  /** A run's recorded binding (run-history item 54): the attach reuses that
   *  workspace and never provisions again. Absent for a fresh run, and for a
   *  resumed row that recorded none. */
  reattach?: WorkspaceBinding;
  /** The run's hard stop (its control's `hardSignal`, registered before the
   *  attach): a stop during the attach's wake wait ends it at once, and a
   *  stopped run is never provisioned cold (execution.md item 9). */
  stopSignal?: AbortSignal;
  /** The run's remaining wall clock (its control's `remainingMs`, read at each
   *  attach the executor opens; undefined until the harness starts the lease):
   *  every attach the run's resident executor opens is clipped to it
   *  (execution.md item 9). Absent for a caller with no run control. */
  remainingMs?: () => number | undefined;
}

/** How a recorded workspace's re-attach ended: the round's workspace
 *  (executor, selection, release), or the factory's refusal by name (run-history
 *  item 54): nothing else was provisioned, and the caller closes the run
 *  `interrupted` saying why and runs its request again. */
export type WorkspaceReattach =
  | { kind: "attached"; round: RoundWorkspace }
  | { kind: "reattach_refused"; why: string }
  /** The run's own stop ended the re-attach (its signal rode into the attach's wait): not a refusal, nothing restarts. */
  | { kind: "stopped" };

/** How the dispatch-time attach ended: a re-attach's two answers, or the
 *  ask-once refusal (no branch is bound and none was named). */
export type WorkspaceAttach =
  | WorkspaceReattach
  | { kind: "refused"; reason: "which_branch" }
  /** The run's own stop ended the attach (its signal rode into the attach's wait): not a failure, never provisioned cold. */
  | { kind: "stopped" };

/**
 * The attach itself, under its `dispatch.workspace.attach` span naming the
 * backend (docs/reference/specs/tracing.md) — the setup step that takes minutes on
 * a cold clone — paired with its release on the round's profile
 * (reviewRound.ts): a `read` identity → readonly worktree + release("always");
 * any other → release("if-idle"). The factory is handed the EFFECTIVE profile
 * — what is provisioned and as whom is read from it, never from the preset.
 * Every failure propagates: the callers read the ones they decide by name.
 */
async function attachRound(
  deps: Pick<ProvisionDeps, "config" | "dataDir">,
  ctx: AttachContext,
): Promise<RoundWorkspace> {
  const { threadKey, agent, profile, repoCtx, root, clock, reattach, stopSignal, remainingMs } = ctx;
  const ownPr = ownPrOf(repoCtx);
  return root.span("dispatch.workspace.attach", async (span) => {
    // The resident's own steps (clone, install, the mutex wait…) graft under
    // this span, rebased to its start (docs/reference/specs/tracing.md item 19) — on a
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
        round: {
          threadKey,
          agent,
          profile,
          repo: repoCtx.repo,
          ref: repoCtx.ref,
          headSha: repoCtx.headSha,
          // The thread's own pull request, when the ref is its head (resident-
          // repos item 16): the one reason the resident may move a binding.
          ...(ownPr !== undefined ? { ownPr } : {}),
          ...(reattach !== undefined ? { reattach } : {}),
          ...(stopSignal !== undefined ? { stopSignal } : {}),
          ...(remainingMs !== undefined ? { remainingMs } : {}),
        },
        logKey: threadKey,
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
}

/**
 * A run's recorded workspace, re-attached where its row says it ran
 * (run-history item 54) with no gate: the factory reuses that workspace and
 * provisions nothing else, and its refusal is answered by name for the caller
 * to close the run saying why. Callable mid-run — a process relaunched in a
 * replacement container re-attaches the run's binding before it starts — as
 * well as from the dispatch-time attach below, which adds the gate. Every
 * other failure propagates.
 */
export async function reattachWorkspace(
  deps: Pick<ProvisionDeps, "config" | "dataDir">,
  ctx: AttachContext & { reattach: WorkspaceBinding },
): Promise<WorkspaceReattach | { kind: "lease_spent"; leftMs: number; note: string }> {
  try {
    return { kind: "attached", round: await attachRound(deps, ctx) };
  } catch (err) {
    // The run's lease is inside its write-up reserve, or ran into it under the
    // re-attach's waits (execution.md item 9): the factory asked for nothing
    // more, and the caller ends the run on its budget — never a refusal that
    // restarts it from its request. `leftMs` is the run's clock at the decision
    // and `note` the bound's own sentence for it, carried on to the record.
    if (err instanceof WorkspaceReattachLeaseSpentError)
      return { kind: "lease_spent", leftMs: err.leftMs, note: err.note };
    // The run's workspace is where its row says or nowhere (item 54): the
    // factory tried that backend alone and refused by name.
    if (err instanceof WorkspaceReattachRefusedError) return { kind: "reattach_refused", why: err.why };
    // The run's own stop ended the re-attach's wait — the executor's typed
    // `aborted` error, read by its shape as `attachWorkspace` reads it: the
    // caller ends the run stopped, and nothing restarts from its request.
    if (isRunStopError(err)) return { kind: "stopped" };
    throw err;
  }
}

/**
 * The dispatch-time workspace attach: the attach itself (`attachRound`), and
 * the one refusal the stage decides — ask-once: a resident with no ref binding
 * for this thread, no branch named, no default to bind to → one clarifying
 * question on the card and in the thread, no model turn. A resumed run's
 * recorded binding is re-attached as `reattachWorkspace` does, its refusal
 * answered the same way. Every other failure propagates.
 */
export async function attachWorkspace(
  deps: ProvisionDeps,
  ctx: GateContext & GateCard & Omit<AttachContext, "threadKey">,
): Promise<WorkspaceAttach> {
  const { msg, refuse, card, shell, closeLines, clock, agent, profile, repoCtx, root, reattach, stopSignal } = ctx;
  const { remainingMs } = ctx;
  let round: RoundWorkspace;
  try {
    round = await attachRound(deps, {
      threadKey: msg.threadKey,
      agent,
      profile,
      repoCtx,
      root,
      clock,
      ...(reattach !== undefined ? { reattach } : {}),
      ...(stopSignal !== undefined ? { stopSignal } : {}),
      ...(remainingMs !== undefined ? { remainingMs } : {}),
    });
  } catch (err) {
    // Ask-once: the resident has no ref binding for this thread, the
    // message named no branch, AND the resident did not name a default to
    // bind to (the factory binds to `defaultRef` itself when the 409 carries
    // one — only a Worker predating that field reaches here). Binding is
    // explicit-or-ask-once, never a silent guess. ONE clarifying question,
    // no model turn burned (mirrors the named-refusal reply shape). The
    // user's answer in the thread (e.g. "on main") carries the ref on the
    // next message and re-attach binds it.
    if (err instanceof ResidentNeedsRefError) {
      const repo = repoCtx.repo;
      await refuse(refusalOf("which_branch", REFUSAL_SENTENCES.which_branch({ repo })), () =>
        card.done(
          shell.close({ kind: "not_started", icon: "🌿", reason: "which branch?", ...closeLines(clock(), false) }),
        ),
      );
      return { kind: "refused", reason: "which_branch" };
    }
    // A resumed run's workspace is where its row says or nowhere (item 54):
    // the factory tried that backend alone and refused by name. The caller
    // closes this run saying why and dispatches its request again.
    if (err instanceof WorkspaceReattachRefusedError) return { kind: "reattach_refused", why: err.why };
    // The run's own stop ended the attach — its signal rode into the attach's
    // wait, and the executor's typed `aborted` error is that stop, not a setup
    // failure. The dispatcher ends the request `stopped`; nothing is replied.
    // Read by the error's typed shape, never by the signal's state: a
    // provisioning failure that merely coincided with a pending stop stays the
    // failure it is (`setup_failed`, the error replied).
    if (isRunStopError(err)) return { kind: "stopped" };
    throw err;
  }
  return { kind: "attached", round };
}

/** What `mintRunBearer` reads off the dispatch. */
export interface MintBearerContext {
  runId: string;
  agent: AgentDef;
  /** The run's effective profile: its minutes are the lease the provisional expiry allows for. */
  profile: RunProfile;
  resolved: ResolvedRequest;
  registry: RunRegistry;
  /** The request root: the span the proxied `model.turn` spans hang under. */
  root: Span;
  clock: Clock;
}

/**
 * The run's model-proxy bearer (docs/reference/specs/model-proxy.md), minted the
 * moment its executor is provisioned: bound to the run id, pinned to the
 * preset's model and caps, expiring provisionally at the provisioning allowance
 * plus the run's lease plus the grace (`provisionalBearerExpiresAt`) — the harness
 * resets it to the lease's end plus the grace when the lease starts,
 * its turns hung under the request root and its refusals published on the
 * run's stream. The token is returned to the caller alone — never logged, never
 * on the record. Nothing is minted without a store (the CLI, tests) or for a
 * provider the config does not name (the resolve stage refused that earlier).
 */
export function mintRunBearer(deps: ProvisionDeps, ctx: MintBearerContext): string | undefined {
  const store = deps.runBearers;
  if (!store) return undefined;
  const { runId, agent, profile, resolved, registry, root, clock } = ctx;
  const { provider: providerName, model } = parseModelRef(resolved.modelRef);
  const providerCfg = deps.config.config.providers[providerName];
  if (!providerCfg) return undefined;
  return store.mint({
    runId,
    modelRef: resolved.modelRef,
    providerName,
    providerWire: wireOf(providerCfg),
    model,
    maxTokens: agent.maxTokens,
    maxTurns: agent.maxTurns,
    expiresAt: provisionalBearerExpiresAt(clock(), profile.minutes),
    span: root,
    publish: (event) => registry.publish(runId, event),
  });
}

/** The prompt as composed for the first turn: the MCP tools discovered for this
 *  run, the composer a re-review recomposes with (pinned to a head), the head
 *  this run reviews, and the system prompt itself. */
/** The block a follow-up seeded from its session starts with (session-log item
 *  10): the agent's own notes for this thread, then the summary its newest
 *  compaction wrote — each only when there is one; undefined when neither. */
export function sessionNotesBlock(session: {
  notepad?: string;
  summary?: string;
  /** The thread's files (record 0033), one line each as `describeAsset` writes them. */
  files?: readonly string[];
}): string | undefined {
  const parts: string[] = [];
  const notepad = session.notepad?.trim();
  const summary = session.summary?.trim();
  if (notepad)
    parts.push(
      "YOUR NOTES FOR THIS THREAD (kept with the `notes` tool — the one thing sure to survive a compaction and reach the next run here; replace them whole when they change):\n" +
        notepad,
    );
  if (summary)
    parts.push(
      "SUMMARY OF THE EARLIER CONVERSATION (written when the context was compacted; every earlier turn is still reachable with `recall`):\n" +
        summary,
    );
  if (session.files && session.files.length > 0)
    parts.push(
      "FILES OF THIS THREAD (received on its messages or produced by its runs, as their records name them; `recall {assets: true}` lists them with their keys):\n" +
        session.files.map((line) => `- ${line}`).join("\n"),
    );
  return parts.length ? parts.join("\n\n") : undefined;
}

export interface ComposedPrompt {
  mcpForRun: McpToolsForRun;
  composeSystem: ReturnType<typeof makeSystemComposer>;
  reviewHead: string | undefined;
  system: string;
}

/** What `composePrompt` reads off the dispatch. */
export interface PromptContext {
  msg: IncomingMessage;
  agent: AgentDef;
  /** The run's effective profile: the config block names its budget and what clipped it. */
  profile: RunProfile;
  resolved: ResolvedRequest;
  directives: RequestDirectives;
  sticky: ThreadDirectives;
  repoCtx: RepoContext;
  /** The attach's answer: the resident flag and the binding's worktree path. */
  selection: ExecutorSelection;
  isPrReview: boolean;
  memoryBlockP: ReturnType<typeof memoryContextBlock>;
  verifiedAtAttach: boolean;
  resume: ResumeContext | undefined;
  root: Span;
  /** What this session already knows (docs/reference/specs/session-log.md item
   *  10), for a follow-up seeded from its session log: the agent's notepad as
   *  the `notes` tool last wrote it, and the summary its newest compaction
   *  wrote — and, for any run in a thread with files (record 0033), the
   *  thread's files one line each. Rendered as one block right after memory;
   *  absent when there is none of the three. */
  session?: { notepad?: string; summary?: string; files?: readonly string[] };
  /** The thread's artifacts since the agent's previous run (docs/reference/specs/session-log.md
   *  item 9), rendered by `threadArtifactsBlock` (dispatch/threadArtifacts.ts):
   *  what other runs of the thread recorded — a pull request, a verdict with
   *  its findings, dispositions, a handoff, a description's TL;DR, a review
   *  post — as data, right after the notes block and before the agent's
   *  prompt and its REVIEW TARGET. Absent when no run since carried one. */
  threadArtifacts?: string;
  /** A plan unit's rendered contract for a review child (agent-ship item 13):
   *  placed right after the REVIEW TARGET block, as the ship pipeline's review
   *  round places it. Absent on every other request. */
  contract?: string;
}

/**
 * The effective system prompt, composed AFTER executor resolution: skills
 * (progressive disclosure), MCP discovery for the agent's servers, the config
 * awareness block, the self-description, the custom instructions, the memory
 * block (awaited here — `dispatch.compose` is that wait), and the composer that
 * pins a PR review to its head. A resume re-sends the prompt the run started
 * with, verbatim.
 */
export async function composePrompt(deps: ProvisionDeps, ctx: PromptContext): Promise<ComposedPrompt> {
  const {
    msg,
    agent,
    profile,
    resolved,
    directives,
    sticky,
    repoCtx,
    selection,
    isPrReview,
    memoryBlockP,
    verifiedAtAttach,
    resume,
    root,
  } = ctx;
  const { resident, binding, seeded } = selection;
  // Progressive disclosure: the calling agent's scoped skill
  // name+description list trails the agent's own instructions (it is
  // guidance about the agent's tools, not advisory context like the memory
  // block). Bodies load on demand via use_skill — never dumped here. No
  // store, or an agent with no scoped skills (general/research) → undefined
  // and the prompt is untouched.
  const skillsBlock = deps.skills ? skillGuidanceBlock(deps.skills, agent.name) : undefined;
  // External MCP tools (docs/reference/specs/mcp-tools.md item 8): discovery for
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
    messageDirective: {
      agent: directives.agent,
      model: directives.model,
      effort: directives.effort,
      budget: directives.budget,
    },
    threadDirective: { agent: sticky.agent, model: sticky.model, effort: sticky.effort },
    canEditChannelConfig: deps.config.canEditChannelConfig(chatActorOf(deps.config, msg)),
    // The boundary in force and the budget this run actually has — the same
    // values the gate judged, so "how long do you have?" is answered from fact.
    ...(resolved.boundary ? { boundary: resolved.boundary } : {}),
    // The harness and whose word picked it — the same word the loop opens the
    // run on, so "why am I on OpenCode?" is answered from the scope.
    ...(resolved.harness ? { harness: resolved.harness } : {}),
    budget: {
      minutes: profile.minutes,
      presetMinutes: agent.maxMinutes,
      ...(profile.boundedBy !== undefined ? { boundedBy: profile.boundedBy } : {}),
      ...(directives.budget !== undefined ? { directive: directives.budget } : {}),
    },
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
  const aboutBlock = selfDescriptionBlock(
    AGENTS,
    deps.config.config.organization,
    deps.capabilities,
    deps.residentFleet.cap(),
    deps.build,
  );

  // Custom instructions: the requester's user text + this
  // channel's text, as ONE advisory block. Read from the same resolved
  // scopes as the config block, AFTER resolution and every gate above — so
  // by construction they cannot influence agent, model, or permissions.
  // Absent (the default) → no block, prompt unchanged.
  const instructionsBlock = customInstructionsBlock(scopes);

  // Effective system prompt, composed AFTER executor resolution (via
  // RunOptions.system) by the extracted composer (reviewRound.ts): a
  // resident-path run swaps in the agent's resident variant with the
  // resolved repo named and the worktree path when the attach answered it;
  // a PR review gets the REVIEW TARGET block (item 9) recomposed
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
  const notesBlock = ctx.session ? sessionNotesBlock(ctx.session) : undefined;
  const composeSystem = makeSystemComposer({
    agent,
    resident: resident === true,
    repo: repoCtx.repo,
    workspace: binding?.workspace,
    ...(seeded ? { seeded: { workspace: seeded.workspace } } : {}),
    prTarget:
      isPrReview && repoCtx.repo && repoCtx.pr !== undefined
        ? {
            repo: repoCtx.repo,
            pr: repoCtx.pr,
            ref: repoCtx.ref,
            baseRef: repoCtx.baseRef,
            ...(repoCtx.prSize ? { size: repoCtx.prSize } : {}),
          }
        : undefined,
    ...(ctx.contract !== undefined ? { contract: ctx.contract } : {}),
    blocks: {
      memory: memoryBlock,
      notes: notesBlock,
      artifacts: ctx.threadArtifacts,
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
  const reviewHead = repoCtx.headSha;
  // The first turn's system, pinned to that head; a re-review recomposes its
  // own inside settleReviewedHead.
  // A resume re-sends the prompt the run started with, verbatim (plan D3):
  // memory retrieval and MCP discovery are not reproducible, and the model's
  // cached prefix and thinking blocks are bound to it.
  const system = resume ? resume.row.system : composeSystem({ sha: reviewHead, verified: verifiedAtAttach });
  return { mcpForRun, composeSystem, reviewHead, system };
}

/** Floor between two edits of a run's status card (see `coalesceStatus`). Below
 *  the 5 s heartbeat so a heartbeat frame is never held back by it. */
export const STATUS_UPDATE_MIN_MS = 3000;
