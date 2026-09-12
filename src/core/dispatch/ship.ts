// The agent:ship fork of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md,
// docs/reference/specs/agent-ship.md): `dispatch()` hands a resolved, gated
// ship request here BEFORE the top-level attach, and the branch owns
// everything from there — the preflight refusals, the one run record and card,
// the round loop over `runShipPipeline`, the final report. It reads the same
// dependency slices as the stages it stands in for (the run, the reply) plus
// the three GitHub seams only ship needs.
import { configAwarenessBlock } from "../configAwareness.js";
import { selfDescriptionBlock } from "../selfDescription.js";
import { customInstructionsBlock } from "../customInstructions.js";
import { AGENTS, getAgent, type AgentDef } from "../../agents/registry.js";
import type { RunProfile } from "../../config/profile.js";
import type { RequestDirectives, ThreadDirectives } from "../../directives.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import { systemClock } from "../trace/index.js";
import type { RunOwner } from "../trace/streamSpans.js";
import type { RequestTrace } from "../requestTrace.js";
import { parseModelRef } from "../../providers/types.js";
import { currentPrHeadSha, prCommitsSince, type RepoContext } from "../repoContext.js";
import { postReviewComment } from "../../execution/githubComments.js";
import {
  createBranchRef,
  fetchPullRequestFacts,
  fetchRepoShipInfo,
  findOpenPrByHead,
  openPullRequest,
  type PullRequestFacts,
} from "../../execution/githubPulls.js";
import { resolveGithubIdentity, type GithubIdentity } from "../../execution/githubApp.js";
import { resolveShipCaps, runShipPipeline, shipRoundHeader, type ShipOutcome } from "../shipPipeline.js";
import { shipPreflight } from "../ship/preflight.js";
import type { ShipBlocks, ShipChildSpec } from "../ship/childRound.js";
import { skillGuidanceBlock } from "../../skills/index.js";
import { isSpanRecord, redactSecrets, type RunEvent } from "../runEvents.js";
import type { LiveThread } from "../threadAdmission.js";
import { utf8ByteLength, type RunStatus } from "../runRecord.js";
import { assembleRunRecord, channelVisibilityOf, profileRecordOf } from "./record.js";
import {
  activityLine,
  attachmentSuffix,
  composeRunLabel,
  humanizeMessageText,
  isMrkdwnChannel,
  liveViewLink,
} from "./reply.js";
import type { DispatchFollowUp } from "./admission.js";
import type { FastPathDeps } from "./fastPath.js";
import type { AuthorizeDeps } from "./authorize.js";
import { buildMessages, contextMessageTexts } from "./messages.js";
import type { ProvisionDeps } from "./provision.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "../runFriction.js";
import { githubCapabilityFor, shutdownNotice, webCapability, type RunDeps } from "./run.js";
import { redactPrDescription } from "../prDescription.js";
import type { ReplyDeps } from "./reply.js";
import { defaultRunRegistry, REPLAY_EVERYTHING } from "../runRegistry.js";
import { createCardShell } from "../statusCardFrame.js";
import type { RunEnding } from "../runEnding.js";
import type { ChannelIO, HistoryItem, IncomingMessage, StatusHandle } from "../types.js";

/** What the ship branch reads: the run and reply slices (it is both, for a
 *  pipeline of child rounds), the provision facts its rounds attach with, the
 *  registry and clock, the capability set — and the three seams only ship uses. */
export interface ShipDeps
  extends
    RunDeps,
    ReplyDeps,
    Pick<ProvisionDeps, "dataDir" | "residentFleet" | "build">,
    Pick<FastPathDeps, "clock" | "runRegistry">,
    Pick<AuthorizeDeps, "capabilities"> {
  /**
   * Ship round 0's pipeline-branch create (docs/reference/specs/agent-ship.md item 3):
   * `refs/heads/<branch>` at the base ref's tip, so the ref exists on
   * origin BEFORE the resident is asked to bind the thread to it. Default:
   * githubPulls' `createBranchRef` (App token REST, 422 already-exists is
   * success). Injectable so tests assert the call without a network call.
   */
  createBranchRef?: (repo: string, branch: string, fromRef: string) => Promise<void>;
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
   * The parent's post of a coding child's handoff to the unit's board issue
   * (agent-ship.md item 14): an issue comment through the bot's GitHub
   * identity — the same REST write the general agent's issue tools make.
   * Default: the shared REST client's `commentIssue`. Injectable so tests
   * assert the call without a network call.
   */
  postIssueComment?: (repo: string, number: number, body: string) => Promise<{ url: string }>;
}

/** What the agent:ship fork carries out of dispatch()'s prelude — values the
 *  pipeline must not re-derive, because the gates already ran against them. */
export interface ShipContext {
  /** The ship preset as this deployment declares it (`shipPresetFor`: its
   *  budget is the `ship.maxMinutes` knob) — labels and run meta only; never
   *  handed to runAgent. */
  agent: AgentDef;
  /** The run's effective profile (docs/reference/specs/agent-ship.md item 8):
   *  the preset's declared budget as the profile gate clipped it, the
   *  identity and class it admitted. Its minutes are the pipeline's wall
   *  clock; the ledger row and the record carry it like every run's. */
  profile: RunProfile;
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
  /** The request's trace (docs/reference/specs/tracing.md): the ship run binds to it, its steps are spans under the root. */
  trace: RequestTrace;
  /** The card's shape and queued lines at a close, from the dispatch's window. */
  closeLines: (end: number, finished: boolean, owner?: RunOwner) => { shape?: string; queued?: string };
  /** A refusal as one `dispatch.refuse` span. */
  refuse: <T>(outcome: string, fn: () => Promise<T>) => Promise<T>;
  /** The done card's shape and queued lines, from the finish-site diagnosis. */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
}

/**
 * The agent:ship branch (docs/reference/specs/agent-ship.md): preflight refusals, then
 * the ONE run record + card shell around `runShipPipeline`'s round loop —
 * the ship counterpart of the main path's run shell, reusing the same label,
 * event, record, and friction vocabulary so /runs shows a pipeline exactly
 * like any run. Handled endings reply here; an unexpected throw closes the
 * card, persists the `failed` record, and propagates to dispatch()'s outer
 * catch for the error reply.
 */
export async function runShipBranch(
  deps: ShipDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  ctx: ShipContext,
): Promise<void> {
  // `closeLines` keeps its default owner (`agent`): a ship run's children are
  // agent runs, so its `run.command` grafts — none today — would count as
  // getting ready, never as a command's own tools.
  const { agent, profile, card, directives, history, repoCtx, label, ending, trace, closeLines, refuse, doneLines } =
    ctx;
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

  // The one run record: registered and stamped exactly like the main
  // path — input, run_meta, bounded context, the tombstone.
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
  // Tombstone-first, like the main path — a pipeline can run for
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
        }),
        profile: profileRecordOf(agent, profile),
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
        profile,
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
  const currentFrame = () => shell.live({ notice: shutdownNotice(), detail: [roundHeader, checklist, lastActivity] });
  const checklistAsLeft = () => checklist;
  const checklistCheckedOff = () => checklist?.replace(/^(\s*)[○✱](?=\s)/gm, "$1✓");
  const onEvent = (e: RunEvent) => {
    registry.publish(run.id, e);
    if (isSpanRecord(e)) return; // timing, not activity (docs/reference/specs/tracing.md)
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
      messageDirective: {
        agent: directives.agent,
        model: directives.model,
        effort: directives.effort,
        budget: directives.budget,
      },
      threadDirective: { agent: ctx.sticky.agent, model: ctx.sticky.model, effort: ctx.sticky.effort },
      canEditChannelConfig: deps.config.canEditChannelConfig(msg.userId),
      // No `mcp` here: ship rounds receive no MCP tools yet (docs/reference/specs/mcp-tools.md
      // roadmap), and a line inviting `mcp add` into a run that could not use
      // the result would mislead. The line arrives with the tools.
    }),
    about: selfDescriptionBlock(
      AGENTS,
      deps.config.config.organization,
      deps.capabilities,
      deps.residentFleet.cap(),
      deps.build,
    ),
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
  // One GitHub capability for the children's `github_*` tools and for the
  // parent's own issue-comment write (the handoff post, agent-ship.md item 14).
  const githubCap = githubCapabilityFor(deps, msg.userId);
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
      // The rounds cap is the config block's; the wall clock is the parent's
      // effective budget — the preset's declared `ship.maxMinutes` as a
      // boundary or a `budget:` directive clipped it (agent-ship.md item 8) —
      // so every child round is clipped to what remains of THAT.
      caps: { ...resolveShipCaps(deps.config.config.ship), maxMinutes: profile.minutes },
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
      githubTools: githubCap,
      github: {
        createBranchRef: deps.createBranchRef ?? createBranchRef,
        openPullRequest: deps.openPullRequest ?? openPullRequest,
        findOpenPrByHead: deps.findOpenPrByHead ?? findOpenPrByHead,
        postReviewComment: deps.postReviewComment ?? postReviewComment,
        postIssueComment:
          deps.postIssueComment ?? ((repo, number, body) => githubCap.api.commentIssue(repo, number, body)),
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
            // The last coding round's handoff (agent-ship.md item 14) — the
            // pipeline's, so the ship record carries what its child handed back.
            ...(outcome?.handoff !== undefined ? { handoff: outcome.handoff } : {}),
            profile: profileRecordOf(agent, profile),
          }),
          { span: root, ...(ledgerRun ? { via: ledgerRun.sink } : {}) },
        ),
    });
    // A pipeline that threw closes its card here, after the finish, so the
    // card's total is the run's.
    if (outcome === undefined)
      await root
        .span("post.card_close", () =>
          card.done(shell.close({ kind: "done", icon: "❌", detail: checklistAsLeft(), ...doneLines(diagnosis) })),
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
            detail: outcome.status === "completed" ? checklistCheckedOff() : checklistAsLeft(),
            ...doneLines(shipDiagnosis),
          }),
        ),
      ),
    () => root.span("post.reply", () => io.reply(outcome.reply)),
  );
}
