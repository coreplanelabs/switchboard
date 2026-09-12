// One coding child of the ship pipeline (docs/reference/specs/agent-ship.md
// items 3, 4, 6, 7): round 0 and every fix round. It attaches the resident
// worktree on the pipeline branch, runs the child clipped to the pipeline's
// remaining wall clock under the branch contract, gives a round that pushed
// without a description its one description turn, then runs the coding PR
// post-step over what the round pushed — the same gate a plain coding run
// passes. Every way the round can end is a `CodingRoundResult`; the loop in
// shipPipeline.ts decides what each one means for the pipeline.

import type { ChatMessage } from "../../providers/types.js";
import type { OpenedPullRequest, OpenPrRef, PullRequestTarget, RepoShipInfo } from "../../execution/githubPulls.js";
import type { ToolContext } from "../../tools/workspace.js";
import type { Span } from "../trace/types.js";
import { runAgent } from "../../runner.js";
import { declaredProfile } from "../../config/profile.js";
import { descriptionTurnTarget, runDescriptionTurn } from "../descriptionTurn.js";
import type { PrDescription } from "../prDescription.js";
import { formatFinding, type Finding, type FindingDisposition } from "../reviewVerdict.js";
import type { RunEvent } from "../runEvents.js";
import { observeCodingWorkspace, runCodingPrPostStep, trackPushedBranch } from "../codingPrPostStep.js";
import { attachRoundWorkspace, makeSystemComposer } from "../reviewRound.js";
import type { ChildRoundContext, ChildRoundDeps } from "./childRound.js";
import { DEFAULT_CONTRACT_MAX_CHARS, renderContract, type ChildContract } from "./contract.js";
import { renderHandoffComment, type Handoff } from "./handoff.js";

/** The GitHub seam a coding round writes through: the PR open-or-edit and
 *  the lookups the post-step and the description turn make before it. */
export interface CodingChildGithub {
  openPullRequest: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /** The open PR heading a branch (githubPulls.findOpenPrByHead) — the
   *  post-step's check before it reports a description-less push as "no PR". */
  findOpenPrByHead: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  /** The repo's default branch — the PR base of last resort (resolveBaseRefLazy,
   *  githubPulls.ts), threaded into the round's runCodingPrPostStep call. In
   *  practice `entry.base` is already resolved by shipPreflight, so this fires
   *  only on the rare resume where that lookup itself failed. */
  fetchRepoShipInfo: (repo: string) => Promise<RepoShipInfo | undefined>;
  /** The parent's post of the child's handoff to the unit's board issue
   *  (docs/reference/specs/agent-ship.md item 14): an issue comment through the
   *  bot's GitHub identity — a write the bot already makes. Called only when
   *  the round's contract names an issue and the handoff renders to something. */
  postIssueComment: (repo: string, number: number, body: string) => Promise<{ url: string }>;
}

/** What a coding round reads beyond the shared child slice. */
export interface CodingChildDeps extends ChildRoundDeps {
  /** Registry publish for the typed artifacts the round owns (pr_description,
   *  the post-step's pr_opened). */
  publish: (event: RunEvent) => void;
  github: CodingChildGithub;
  /** Deep string-leaf redaction for the published pr_description event (the
   *  dispatcher passes its own, so ship and plain coding publish ONE shape). */
  redactDescription: (d: PrDescription) => PrDescription;
}

/** The coding round's context: the shared state plus the clock the round's
 *  published events are stamped with. */
export interface CodingChildContext extends ChildRoundContext {
  now: () => number;
}

/** The ship coding rounds' branch contract, appended AFTER the composed
 *  system so it beats the coding prompt's generic "create a branch with a
 *  descriptive name" step — a ship child that leaves the pipeline branch
 *  strands the pipeline (the thread binding cannot follow it). */
export function shipBranchContract(branch: string): string {
  return (
    `SHIP PIPELINE BRANCH CONTRACT (overrides any instruction above to create or switch branches): ` +
    `this worktree is already checked out on \`${branch}\`, the pipeline's PR branch. ` +
    `Do NOT create a branch and do NOT switch branches — implement, commit, and push on \`${branch}\` ` +
    `(\`git push -u origin ${branch}\`). Switchboard opens and edits the PR from that branch only; ` +
    `work pushed anywhere else is unreachable to this pipeline.`
  );
}

/** The fix round's one user turn: the findings payload verbatim (ids, severity,
 *  file:line, title) plus the review prose, and the loop contract — every
 *  severity gets a disposition, description resubmitted, branch repushed. */
export function buildShipFixTurn(input: { where: string; findings: Finding[]; review: string }): string {
  const findings =
    input.findings.map(formatFinding).join("\n") || "(the review listed no structured findings — address its prose)";
  return (
    `The review of ${input.where} requested changes. Load the \`address-review-findings\` skill and address EVERY finding below, nits included: ` +
    `record one disposition per finding with submit_dispositions (fixed|declined, with a note), squash to coherent commits, ` +
    `resubmit the PR description with submit_pr_description, and push the branch. Never merge and never approve.\n\n` +
    `Findings:\n${findings}\n\nReview:\n${input.review}`
  );
}

/** The unit contract enters the child's FIRST user turn (docs/reference/specs/agent-ship.md
 *  item 13): appended as its own text part after the request's text, so the
 *  human's words stay first and the block is the same bytes the review child
 *  reads after its REVIEW TARGET block. A transcript with no user turn gets one. */
export function withContractInFirstUserTurn(messages: ChatMessage[], block: string): ChatMessage[] {
  const at = messages.findIndex((m) => m.role === "user");
  if (at < 0) return [...messages, { role: "user", content: [{ type: "text", text: block }] }];
  return messages.map((m, i) => (i === at ? { ...m, content: [...m.content, { type: "text", text: block }] } : m));
}

export interface CodingRoundResult {
  answer: string;
  /** Attach-time refusal (the thread's worktree is bound to another ref) —
   *  the pipeline aborts with it; no model turn ran. */
  refusal?: string;
  prNote?: string;
  opened?: { number: number; url: string; created: boolean };
  headSha?: string;
  description?: PrDescription;
  /** The round's LAST submit_dispositions set (a later call replaces the
   *  earlier one). The loop keys it by the review round it answers — finding
   *  ids are only unique within one round. */
  dispositions?: FindingDisposition[];
  /** The round's LAST submit_handoff object (docs/reference/specs/agent-ship.md
   *  item 14) — typed, as the tool accepted it; the pipeline carries it onto
   *  the run record. An affirmed empty handoff is three empty lists. */
  handoff?: Handoff;
  /** What became of the handoff's board post, when the round's contract named
   *  an issue and the handoff rendered to something: where it landed, or why
   *  it did not — a fact of the round the thread sees, like `prNote`. */
  handoffNote?: string;
  residentUnavailable?: string;
}

/**
 * One coding child (round 0, and every fix round). Never throws for a
 * refused attach or a missing resident — those are results; a failure inside
 * the child's run propagates after the workspace is released.
 */
export async function runShipCodingChild(
  input: CodingChildDeps,
  ctx: CodingChildContext,
  opts: {
    messages: ChatMessage[];
    knownFindingIds?: string[];
    attachHeadSha?: string;
    /** The plan unit's contract, when the round runs for one (a plan runner's
     *  child; the by-hand receipt): rendered into the first user turn. Absent
     *  on a task-string pipeline, whose messages are used as given. */
    contract?: ChildContract;
  },
  roundSpan: Span | undefined,
): Promise<CodingRoundResult> {
  const { entry, clip, now } = ctx;
  const { control, github, logKey } = input;
  const messages = opts.contract
    ? withContractInFirstUserTurn(
        opts.messages,
        renderContract(opts.contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text,
      )
    : opts.messages;
  const spec = input.child("coding");
  // The round attaches on the child preset's own class and identity: both
  // within the parent ship run's, which the profile gate judged before the
  // fork (the same class; `write` at the parent's own rung), so a boundary that
  // admitted the pipeline admits every round. Its budget is the parent's
  // effective wall clock, reaching the child through `clip` below
  // (agent-ship.md item 8).
  const ws = await attachRoundWorkspace({
    factory: input.factory,
    round: {
      threadKey: input.threadKey,
      agent: spec.agent,
      profile: declaredProfile(spec.agent),
      repo: entry.repo,
      ref: entry.branch,
      headSha: opts.attachHeadSha,
    },
    logKey,
  });
  const { executor, resident, binding, note } = ws.selection;
  if (resident !== true) {
    await ws.release({ hardStopped: false, ...(roundSpan ? { span: roundSpan } : {}) });
    return { answer: "", residentUnavailable: note ?? "no resident worktree attached" };
  }
  // Binding honesty (mirrors guardAttachedHead): the resident binds ONE ref
  // per thread at first attach and ignores later hints — a thread already
  // bound to another branch would code, push, and open-or-edit somewhere
  // the pipeline never looks. Refuse BEFORE any model call, naming both
  // refs; an attach that answered no ref proves nothing and proceeds.
  if (binding?.ref !== undefined && binding.ref !== entry.branch) {
    await ws.release({ hardStopped: false, ...(roundSpan ? { span: roundSpan } : {}) });
    return {
      answer: "",
      refusal:
        `🔀 Ship round not started: this thread's worktree is bound to \`${binding.ref}\`, but the pipeline branch is \`${entry.branch}\` — ` +
        `the resident binds one ref per thread at its first attach, so this thread cannot drive the ship branch. Start ship in a fresh thread.`,
    };
  }
  let description: PrDescription | undefined;
  let handoff: Handoff | undefined;
  let roundDispositions: FindingDisposition[] | undefined;
  const toolContext: ToolContext = {
    executor,
    reportProgress: input.reportProgress,
    web: input.web,
    skills: input.skills,
    github: input.githubTools,
    agentName: spec.agent.name,
    onPrDescription: (d) => {
      description = d;
    },
    onHandoff: (h) => {
      handoff = h;
    },
    ...(opts.knownFindingIds
      ? {
          knownFindingIds: opts.knownFindingIds,
          onDispositions: (d: FindingDisposition[]) => {
            roundDispositions = d;
          },
        }
      : {}),
  };
  const composeSystem = makeSystemComposer({
    agent: spec.agent,
    resident: true,
    repo: entry.repo,
    workspace: binding?.workspace,
    prTarget: undefined,
    blocks: input.blocks(spec),
  });
  let answer: string;
  let observed: Awaited<ReturnType<typeof observeCodingWorkspace>> | undefined;
  // The branch the child's own `git push` named (pr-description item 5):
  // the post-step opens from it, and from the checkout only when no
  // push was observed. The latest push wins.
  const pushes = trackPushedBranch();
  // The branch contract OVERRIDES the coding prompt's generic "create a
  // branch" step — a child that follows that step pushes its own branch
  // and strands the pipeline: the thread's
  // binding stays on the ship branch, so the review round can never see
  // a PR opened from anywhere else.
  const system = `${composeSystem({ sha: undefined, verified: false })}\n\n${shipBranchContract(entry.branch)}`;
  const onEvent = (e: RunEvent) => {
    pushes.observe(e);
    input.onEvent(e);
  };
  // Where the post-step's PR would open: the PR's true base (entry.base) —
  // NEVER the thread's resident binding ref, which ship bound to the HEAD
  // branch itself. Shared by the description turn's decision and the post-step.
  const prTarget = { repo: entry.repo, baseRef: entry.base, bindingRef: undefined, resolvedRef: undefined };
  const observeNow = async () => {
    const pushedBranch = pushes.branch();
    return observeCodingWorkspace(
      executor,
      {
        probeRemote: false,
        ...(pushedBranch !== undefined ? { pushedBranch } : {}),
      },
      roundSpan,
    );
  };
  // True when the round was given the description turn and it still
  // submitted nothing — the post-step's warning then says so.
  let descriptionTurnRan = false;
  try {
    answer = await runAgent({
      provider: spec.provider,
      model: spec.model,
      agent: clip(spec.agent),
      messages,
      ...(roundSpan ? { span: roundSpan } : {}),
      backend: ws.selection.backend,
      system,
      effort: spec.effort,
      toolContext,
      onProgress: input.onProgress,
      onEvent,
      control,
      inbox: input.inbox,
    });
    // A hard stop tore the work down mid-flight — observe nothing, post nothing.
    if (control.requested !== "hard") observed = await observeNow();
    // The description turn (docs/reference/specs/pr-description.md item 5,
    // descriptionTurn.ts) — the same enforcement dispatch() applies to a
    // plain coding run: a round that pushed onto the pipeline's own open PR
    // without resubmitting the description gets ONE bounded extra turn
    // asking for it, while the workspace is still attached. The turn runs
    // on a COPY of the round's messages (the pipeline's transcript is its
    // own); the description arrives through this round's onPrDescription
    // hook, so `description` below sees it.
    if (observed && description === undefined && control.requested !== "hard") {
      const turnTarget = await descriptionTurnTarget({
        observed,
        description,
        target: prTarget,
        findOpenPr: github.findOpenPrByHead,
        logKey,
      });
      if (turnTarget) {
        descriptionTurnRan = true;
        const turnMessages = [...messages];
        const run = (span?: Span) =>
          runDescriptionTurn({
            ...(span ? { span } : {}),
            target: turnTarget,
            answer,
            messages: turnMessages,
            system,
            turn: {
              provider: spec.provider,
              model: spec.model,
              agent: clip(spec.agent),
              ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
              toolContext,
              onProgress: input.onProgress,
              onEvent,
              control,
              ...(ws.selection.backend ? { backend: ws.selection.backend } : {}),
            },
            logKey,
          });
        await (roundSpan ? roundSpan.span("run.description_turn", run) : run());
        // Re-read, not narrowed: a hard stop may have landed during the turn.
        if (!control.hardSignal.aborted) observed = await observeNow();
      }
    }
  } finally {
    await ws.release({ hardStopped: control.requested === "hard", ...(roundSpan ? { span: roundSpan } : {}) });
  }
  if (description)
    input.publish({ type: "pr_description", description: input.redactDescription(description), at: now() });
  // Branch contract enforced structurally, before any PR write: a child
  // whose head branch (the one it pushed, else the one it ended on) is not
  // the pipeline branch pushed work this pipeline cannot reach (the thread
  // binding stays on the ship branch) — opening or editing a PR from it
  // would strand the loop, as the first live run proved.
  if (observed?.branch !== undefined && observed.branch !== entry.branch) {
    return {
      answer,
      refusal:
        `⚠️ The coding round left the pipeline branch: its work is on \`${observed.branch}\` instead of \`${entry.branch}\`, ` +
        `so no PR was opened or edited from it — work pushed there is unreachable to this pipeline.`,
    };
  }
  let opened: { number: number; url: string; created: boolean } | undefined;
  let prNote: string | undefined;
  if (observed && control.requested !== "hard") {
    prNote = await runCodingPrPostStep({
      observed,
      description,
      target: prTarget,
      openPullRequest: github.openPullRequest,
      findOpenPr: github.findOpenPrByHead,
      fetchRepoInfo: github.fetchRepoShipInfo,
      descriptionTurnRan,
      publish: (e) => {
        if (e.type === "pr_opened") opened = { number: e.number, url: e.url, created: e.created };
        input.publish(e);
      },
      logKey,
    });
  }
  // The handoff's board post (docs/reference/specs/agent-ship.md item 14): a
  // contract naming the unit's board issue gets the rendered comment there,
  // through the bot's GitHub identity, AFTER the PR post-step so the comment
  // names the PR. The handoff rides the result regardless (the pipeline puts
  // it on the run record); an empty one renders nothing and posts nothing; a
  // failed post is a note the thread sees, never a failed round — the record
  // still has the handoff. Nothing is posted after a hard stop.
  let handoffNote: string | undefined;
  const contract = opts.contract;
  if (handoff !== undefined && contract?.issue !== undefined && control.requested !== "hard") {
    const issue = contract.issue;
    const body = renderHandoffComment(handoff, {
      unitId: contract.unit.id,
      ...(opened !== undefined ? { pr: { number: opened.number, url: opened.url } } : {}),
    });
    if (body !== undefined) {
      const where = `${issue.repo}#${issue.number}`;
      try {
        const posted = await github.postIssueComment(issue.repo, issue.number, body);
        handoffNote = `📋 Handoff posted to ${where}: ${posted.url}`;
        console.log(`[ship] ${logKey} handoff posted to ${where}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        handoffNote = `⚠️ The handoff could not be posted to ${where}: ${reason} — it is recorded on this run.`;
        console.warn(`[ship] ${logKey} handoff post to ${where} failed: ${reason}`);
      }
    }
  }
  return {
    answer,
    ...(prNote !== undefined ? { prNote } : {}),
    ...(opened !== undefined ? { opened } : {}),
    ...(observed?.head !== undefined ? { headSha: observed.head } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(roundDispositions !== undefined ? { dispositions: roundDispositions } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    ...(handoffNote !== undefined ? { handoffNote } : {}),
  };
}
