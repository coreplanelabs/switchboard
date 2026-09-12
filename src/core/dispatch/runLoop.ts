// The run stage's loop (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// the model turn and everything that rides on it. The card frame the loop
// paints (checklist, activity line, the shutdown notice); the agent loop with
// the follow-up inbox; the reviewed-head settle; the workspace observation, the
// description turn and the coding PR post-step; the answer published as the
// record's source of truth; then the finish — the registry closed with the
// terminal status, the friction diagnosis, the record registered for the drain
// — and the workspace released on a failure. The stage's claim and the tools'
// capabilities are run.ts.
import type { ResolvedRequest } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import { budgetedAgent, type RunProfile } from "../../config/profile.js";
import { runAgent } from "../../runner.js";
import { fetchRepoShipInfo, findOpenPrByHead, openPullRequest } from "../../execution/githubPulls.js";
import type { ChatMessage, Provider } from "../../providers/types.js";
import type { McpToolsForRun } from "../../mcp/source.js";
import { currentPrHeadSha, prCommitsSince, type RepoContext } from "../repoContext.js";
import { PrDescriptionSchema, redactPrDescription, type PrDescription } from "../prDescription.js";
import { parseHandoff, type Handoff } from "../ship/handoff.js";
import { parseVerdictInput, type ReviewVerdict } from "../reviewVerdict.js";
import { parseDigestReport, type DigestReport } from "../diffDigest.js";
import { settleReviewedHead, type makeSystemComposer, type RoundWorkspace } from "../reviewRound.js";
import { observeCodingWorkspace, runCodingPrPostStep, trackPushedBranch } from "../codingPrPostStep.js";
import { descriptionTurnTarget, runDescriptionTurn } from "../descriptionTurn.js";
import { startReviewReadingDiff } from "../readingDiff.js";
import { startReviewDescription } from "../reviewDescription.js";
import { isSpanRecord, type RunEvent } from "../runEvents.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "../runFriction.js";
import { markdownOutput } from "../llmOutput/index.js";
import type { RunStatus } from "../runRecord.js";
import type { RunHandle, RunRegistry } from "../runRegistry.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { RunsReadCapability, SteerCapability } from "../../tools/runs.js";
import type { WaitCapability } from "./awaitChildren.js";
import type { SpawnCapability } from "./spawn.js";
import { inFlightToolAfter, quietSuffix } from "../statusCardLabel.js";
import type { CardShell } from "../statusCardFrame.js";
import type { RunEnding } from "../runEnding.js";
import type { LiveThread } from "../threadAdmission.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { Clock, Span } from "../trace/types.js";
import { publicEnv } from "../../secrets.js";
import type { ChannelIO, IncomingMessage, StatusHandle } from "../types.js";
import type { DispatchFollowUp, ResumeContext } from "./admission.js";
import type { RegisteredRun } from "./provision.js";
import { registerFinishRecord } from "./record.js";
import { activityLine } from "./reply.js";
import { githubCapabilityFor, shutdownNotice, webCapability, type RunDeps } from "./run.js";

/** What the loop hands back once the run has finished: the answer as
 *  canonicalized for every projection, the review facts the post-step and the
 *  head settle key on, the coding post-step's note, the finish-site diagnosis
 *  the done card carries, the checklist views for the closed card, and the
 *  workspace release the reply stage calls after the answer landed. */
export interface RunOutcome {
  answer: string;
  verdict: ReviewVerdict | undefined;
  /** The review's last diff digest, for the post-step's coverage guard. */
  digest: DigestReport | undefined;
  reviewHead: string | undefined;
  observedHead: string | undefined;
  carried: { reviewed: string; current: string; commits: number } | undefined;
  prNote: string | undefined;
  /** "Did real work" — the memory reflection gate. */
  toolCalls: number;
  runDiagnosis: FrictionDiagnosis | undefined;
  /** The agent's checklist exactly as it left it (○/✱ items still open) — what a failed or stopped card shows. */
  checklistAsLeft: () => string | undefined;
  /** The same checklist with every open item ticked ✓ — what a completed card shows. */
  checklistCheckedOff: () => string | undefined;
  releaseWorkspace: (span?: Span) => Promise<void>;
}

/** What `runLoop` reads off the dispatch. */
export interface RunLoopContext {
  msg: IncomingMessage;
  io: ChannelIO;
  agent: AgentDef;
  /** The run's effective profile: the budget the runner is handed is its minutes. */
  profile: RunProfile;
  resolved: ResolvedRequest;
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  system: string;
  composeSystem: ReturnType<typeof makeSystemComposer>;
  mcpForRun: McpToolsForRun;
  run: RunHandle;
  registry: RunRegistry;
  round: RoundWorkspace;
  admitted: LiveThread<DispatchFollowUp>;
  ledgerRun: LedgerRun | undefined;
  resume: ResumeContext | undefined;
  repoCtx: RepoContext;
  isPrReview: boolean;
  isCodingPrRun: boolean;
  /** The head this run reviews at the start; the settle may advance it. */
  reviewHead: string | undefined;
  card: StatusHandle;
  shell: CardShell;
  /** The done card's shape and queued lines, from the finish-site diagnosis (the dispatch's `doneLines`). */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
  clock: Clock;
  root: Span;
  /** When the run started — the ack card's clock, before the attach and the prompt. */
  startedAt: number;
  /** When the loop took the card, after the claim: the activity clock's start (the "quiet for …" suffix counts from here, not from `startedAt`). */
  loopStartedAt: number;
  channelVisibility: ChannelVisibility;
  publishText: RegisteredRun["publishText"];
  ending: RunEnding;
  /** This run's spawn capability, the requester's run reads, the steer into a
   *  child and the wait on the children, for the run tools
   *  (docs/reference/specs/agent-conductor.md); `dispatch()` always hands all
   *  four. Absent (a loop driven outside it, in a test) → the tools answer
   *  honestly that no run is spawning here. */
  spawn?: SpawnCapability;
  runs?: RunsReadCapability;
  steer?: SteerCapability;
  wait?: WaitCapability;
  /** The run that spawned this one (run-history item 46), when it is a child. */
  parentRunId?: string;
}

/**
 * The agent loop and everything that rides on it, from the first model call to
 * the finished stream: the card frame per event, the follow-up inbox, the
 * reviewed-head settle, the workspace observation, the description turn, the
 * coding PR post-step, the answer published as the record's source of truth;
 * then the finish — the registry closed with the terminal status, the
 * diagnosis, the record registered for the drain, a failed run's card closed.
 * A throw propagates after the workspace is released, as before; the caller's
 * outer catch replies.
 */
export async function runLoop(deps: RunDeps, ctx: RunLoopContext): Promise<RunOutcome> {
  const {
    msg,
    io,
    profile,
    resolved,
    provider,
    model,
    messages,
    system,
    composeSystem,
    mcpForRun,
    run,
    registry,
    round,
    admitted,
    ledgerRun,
    resume,
    repoCtx,
    isPrReview,
    isCodingPrRun,
    card,
    shell,
    doneLines,
    clock,
    root,
    startedAt,
    channelVisibility,
    publishText,
    ending,
    spawn,
    runs,
    steer,
    wait,
    parentRunId,
  } = ctx;
  // The def the runner and the post-run turns read: the preset with the
  // EFFECTIVE budget (its deadline, wrap-up warning and budget label read
  // `maxMinutes`) — a copy, never the shared registry entry.
  const agent = budgetedAgent(ctx.agent, profile);
  const { executor, binding } = round.selection;
  let reviewHead = ctx.reviewHead;
  let lastActivityAt = ctx.loopStartedAt;
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
  // tool's (`running bash (Ns)`), not the model's (`thinking …`).
  let inFlightTool: string | undefined;
  // The shutdown notice rides on the LIVE frame only: the closed card is
  // built from `shell.close` and never mentions the restart.
  const currentFrame = () =>
    shell.live({
      suffix: quietSuffix(clock() - lastActivityAt, inFlightTool),
      notice: shutdownNotice(),
      detail: [checklist, lastActivity],
    });
  // The closed card keeps the run link (the run page outlives the run and
  // shows the final answer) and the agent's checklist; only the transient
  // activity trace is dropped. On a clean ✅ finish every item is marked ✓ —
  // the run completing IS the proof they happened, and the model rarely
  // re-posts the checklist after its last step; a stop/failure keeps the
  // honest partial state.
  const checklistAsLeft = () => checklist;
  const checklistCheckedOff = () => checklist?.replace(/^(\s*)[○✱](?=\s)/gm, "$1✓");
  // The runner's progress notes carry the 💭 thought line at each model turn
  // (docs/reference/specs/tracing.md): the card shows it as activity, as it showed the
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
  // results as they stream by (docs/reference/specs/pr-description.md item 5):
  // the PR post-step opens from THIS branch, and from the checkout only
  // when no push was observed — the checkout can move between the push and
  // the post. The latest push wins.
  const pushes = trackPushedBranch(typeof restored.pushedBranch === "string" ? restored.pushedBranch : undefined);
  // The registry backlog is the run's ONE event store: the live
  // page, the post-run friction diagnosis and the run record all read it back
  // via `registry.snapshot` — there is no second copy to drift from it.
  let recordedPushedBranch: string | undefined;
  const onEvent = (e: RunEvent) => {
    registry.publish(run.id, e); // feed the external live-view stream
    if (isSpanRecord(e)) return; // timing, not activity (docs/reference/specs/tracing.md): the card and its clock ignore it
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
  // run (docs/reference/specs/mcp-tools.md item 8): one note per server, before the
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
    // it wraps up would blank it (review agents do exactly that).
    if (!trimmed) return;
    checklist = trimmed;
    ledgerRun?.setState({ checklist: trimmed });
    card.update(currentFrame());
  };
  // Heartbeat: the card ticks every 5s no matter what. A ticking timer means
  // the run is alive; a stopped timer means the process died — the reader
  // can always tell the difference.
  const heartbeat = setInterval(() => card.update(currentFrame()), 5000);

  // The reading-diff baseline (docs/reference/specs/reading-diff.md item 4): a PR review
  // run gets the change as a reviewer reads it — the full git diff, produced
  // CONCURRENTLY with the review by the run's own executor (a read-only
  // command; the resident runs it beside the model's) and published straight
  // to the registry like the other dispatcher facts. Guaranteed: the
  // dispatcher joins it before the answer publish below (a join on a
  // seconds-long command started here — never a timeout race). The ABRIDGED
  // diff is not this run's business: it is produced on the bot host after the
  // record is durable (reviewAbridge.ts — on demand, or automatically with
  // `provider: meat` through the run-history writer's persist hook).
  let readingDiffBaseline: Promise<boolean> | undefined;
  let descriptionArtifact: Promise<boolean> | undefined;
  if (agent.name === "review" && repoCtx.pr !== undefined) {
    // The PR's description as data (docs/reference/specs/reading-diff.md item 7): the
    // object a coding run submitted for this head when the run store has one,
    // else the body GitHub holds parsed back. A store read, so it is joined
    // before the answer like the baseline below — never awaited here.
    descriptionArtifact = startReviewDescription({
      store: deps.runStore,
      repoCtx,
      publish: (e) => registry.publish(run.id, e),
    });
    // One background span (docs/reference/specs/tracing.md): concurrent with the loop,
    // structure for the partition, never a counted term — started under the
    // root inside `startReviewReadingDiff`, so the diff's exec is its child.
    readingDiffBaseline = startReviewReadingDiff({
      executor,
      cfg: deps.config.config.review?.readingDiff,
      env: publicEnv(),
      baseRef: repoCtx.baseRef,
      publish: (e) => registry.publish(run.id, e),
      parent: root,
    }).baseline.then((published) => {
      console.log(`[reading-diff] ${msg.threadKey} baseline ${published ? "published" : "none"}`);
      return published;
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
  // The review's diff digest, set only through the diff_digest tool (the last
  // call wins); the post-step holds its totals against the PR's size and
  // refuses a verdict whose digest covered less. Restored like the verdict, so
  // a resumed run keeps what its earlier generation digested.
  let digest: DigestReport | undefined = parseDigestReport(restored.digest);
  const onDigest = (d: DigestReport) => {
    digest = d;
    ledgerRun?.setState({ digest: d });
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
  // The unit handoff (docs/reference/specs/agent-coding.md item 9), set only
  // through submit_handoff — the last valid call wins — and restored like the
  // description so a resumed run keeps what its earlier generation submitted.
  // A plain coding run has no board issue to post it to: the finish record
  // (redacted there) is where it lands.
  const restoredHandoff = parseHandoff(restored.handoff);
  let handoff: Handoff | undefined = restoredHandoff.ok ? restoredHandoff.handoff : undefined;
  const onHandoff = (h: Handoff) => {
    handoff = h;
    ledgerRun?.setState({ handoff: h });
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
  // observedBranch unless HEAD moved after the push, in which case
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
  // resident's pool user is a scarce slot (docs/reference/specs/resident-repos.md item
  // 16a). The release mode is paired to the round's agent by the attach
  // helper (reviewRound.ts): read-only agents hold nothing worth keeping; a
  // coding run keeps its worktree only while it has uncommitted/unpushed
  // work — unless an operator HARD-stopped it, which means "tear it
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
    ...(spawn ? { spawn } : {}),
    ...(runs ? { runs } : {}),
    ...(steer ? { steer } : {}),
    ...(wait ? { wait } : {}),
    onVerdict,
    onDigest,
    onPrDescription,
    onHandoff,
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
      span: root, // the loop is `run.agent` under the run's root (docs/reference/specs/tracing.md)
      ...(round.selection.backend ? { backend: round.selection.backend } : {}),
      control: run.control, // operator stop from /runs
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
    // Reviewed-head settle (docs/reference/specs/agent-review.md items 8 + 12,
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
    // PR post-step observation (docs/reference/specs/pr-description.md item 5): for a
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
    const observeWorkspaceNow = async () => {
      const pushedBranch = pushes.branch();
      const observed = await root.span("run.observe_workspace", (span) =>
        observeCodingWorkspace(
          executor,
          {
            probeRemote: repoCtx.repo === undefined,
            ...(pushedBranch !== undefined ? { pushedBranch } : {}),
          },
          span,
        ),
      );
      observedHead = observed.head;
      observedBranch = observed.branch;
      observedCheckedOut = observed.checkedOut;
      observedRemoteHead = observed.remoteHead;
      observedRemoteRepo = observed.remoteRepo;
    };
    // Where the post-step's PR would open (CodingPrTarget): the PR's true
    // base ref when the thread's context came from a PR, else the resident
    // binding ref, else the dispatch's resolved ref. Shared by the
    // description turn's decision and the post-step below.
    const prTarget = {
      repo: repoCtx.repo,
      baseRef: repoCtx.baseRef,
      bindingRef: binding?.ref,
      resolvedRef: repoCtx.ref,
    };
    if (isCodingPrRun && run.control.requested !== "hard") await observeWorkspaceNow();
    // The description turn (docs/reference/specs/pr-description.md item 5,
    // descriptionTurn.ts): the coding prompt requires a resubmitted
    // description after EVERY push to a PR that already exists (agent-coding.md
    // item 3), and a prompt rule alone can be rationalized away. So a run
    // whose loop ended with a proven push onto a branch that already heads
    // an open PR and NO submit_pr_description call gets ONE bounded extra
    // model turn asking for it — here, after the model is done and BEFORE
    // the answer lands or the workspace is released. The description arrives
    // through the same onPrDescription hook the first turn fed (so
    // `prDescription` and the ledger row see it); the workspace is observed
    // again afterwards in case the turn pushed. A hard stop asks nothing.
    let descriptionTurnRan = false;
    if (isCodingPrRun && run.control.requested !== "hard" && prDescription === undefined) {
      const turnTarget = await descriptionTurnTarget({
        observed: {
          head: observedHead,
          branch: observedBranch,
          checkedOut: observedCheckedOut,
          remoteHead: observedRemoteHead,
          remoteRepo: observedRemoteRepo,
        },
        description: prDescription,
        target: prTarget,
        findOpenPr: deps.findOpenPrByHead ?? findOpenPrByHead,
        logKey: msg.threadKey,
      });
      if (turnTarget) {
        descriptionTurnRan = true;
        await root.span("run.description_turn", (span) =>
          runDescriptionTurn({
            span,
            target: turnTarget,
            answer,
            messages,
            system,
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
            logKey: msg.threadKey,
          }),
        );
        // Re-read, not narrowed: a hard stop may have landed during the turn.
        if (!run.control.hardSignal.aborted) await observeWorkspaceNow();
      }
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
    // Deterministic coding PR post-step (docs/reference/specs/pr-description.md item 5,
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
          target: prTarget,
          openPullRequest: deps.openPullRequest ?? openPullRequest,
          findOpenPr: deps.findOpenPrByHead ?? findOpenPrByHead,
          fetchRepoInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
          descriptionTurnRan,
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
    // at run start, not a timeout: by now it finished minutes ago.
    const baseline = readingDiffBaseline;
    if (baseline) await root.span("run.reading_diff_join", () => baseline);
    const description = descriptionArtifact;
    if (description) await root.span("run.pr_description_join", () => description);
    // Typed-output boundary (docs/reference/specs/llm-output.md item 5): the answer is
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
    // (docs/decisions/0006-runs-have-two-lives.md): it feeds both the friction diagnosis and the run
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
    // The diagnosis over the run's window (docs/reference/specs/tracing.md): its shape is
    // what the closed card and the record carry.
    const diagnosis = analyzeRunFriction(events, {
      finished: true,
      truncated: snap?.truncated ?? false,
      window: { start: snap?.receivedAt ?? startedAt, end: finishedAt },
    });
    runDiagnosis = diagnosis;
    // The channel's receipt (id + terminal status, never the token): a
    // single-shot channel hands it to its caller — the Worker shim records a
    // scheduled firing's run from it.
    io.runFinished?.({ id: run.id, status });
    // The run finished: it is sealed by the next drain (after the reply), and
    // its record — everything captured now, assembled after the seal — is
    // written by that drain. The card's total stops at the finish stamp.
    ending.finished(run.id);
    shell.freeze(finishedAt);
    registerFinishRecord(deps, {
      ending,
      run,
      snap,
      agent,
      profile,
      resolved,
      msg,
      channelVisibility,
      repoCtx,
      finishedAt,
      status,
      diagnosis,
      root,
      ledgerRun,
      ...(handoff !== undefined ? { handoff } : {}),
      ...(parentRunId !== undefined ? { parentRunId } : {}),
    });
    // The diagnosis rides the run record (above): the friction ledger the
    // cross-run proposer reads is run history, so nothing is written twice.
    // A run whose loop threw closes its card here, after the finish, so the
    // card's total is the run's; the outer catch replies and drains.
    if (runFailed)
      await root
        .span("post.card_close", () =>
          card.done(shell.close({ kind: "done", icon: "❌", detail: checklistAsLeft(), ...doneLines(diagnosis) })),
        )
        .catch(() => {});
  }
  return {
    answer,
    verdict,
    digest,
    reviewHead,
    observedHead,
    carried,
    prNote,
    toolCalls,
    runDiagnosis,
    checklistAsLeft,
    checklistCheckedOff,
    releaseWorkspace,
  };
}
