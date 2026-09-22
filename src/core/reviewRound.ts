// Per-round review + workspace machinery, extracted from dispatch() as
// callable units (zero behavior change): everything a
// review or coding round must invoke — workspace attach/release paired on the
// round's agent, the PR-head pre-flight, the attach-head guard, head-pinned
// system composition, the head-move settle + single re-review, and the
// reviewed-head post gate — parameterized on an explicit `AgentDef` instead of
// branches keyed on the dispatch's top-level resolved agent. `dispatch()`'s
// plain agent:review / agent:coding paths call these units at their existing
// lifecycle positions; a ship round invokes the same units per
// child round.
//
// Every unit takes a `logKey` for its console lines (the dispatcher passes
// the thread key) and returns explicit values; transport concerns (the status
// card, the channel reply's wording around a refusal) stay with the caller
// except where the text IS the unit's contract (refusal replies, post notes).

import type { AgentDef, Identity } from "../agents/registry.js";
import type { RunProfile } from "../config/profile.js";
import type { ChatMessage } from "./chatMessage.js";
import {
  makeExecutor,
  type ExecutorFactoryOptions,
  type ExecutorSelection,
  type WorkspaceBinding,
} from "../execution/factory.js";
import type { Executor, ReleaseMode, ReleaseOptions } from "../execution/executor.js";
import { leftBehindSentence } from "../execution/residentCleanliness.js";
import type { ToolContext } from "../tools/runnableTool.js";
import type { Span } from "../core/trace/types.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
import type { FollowUpTurn } from "./harness/contract.js";
import {
  carriedFooter,
  classifyHeadMove,
  headCarriedNote,
  headMovedNote,
  headRereviewNote,
  rereviewFollowUp,
  type HeadMove,
  type PrCommitList,
} from "./headMoved.js";
import { decideReviewPost, reviewPostIntended, reviewPostOptedOut, type ReviewPostTarget } from "./reviewPost.js";
import { buildReviewPostBody, type ReviewPost, type ReviewVerdict } from "./reviewVerdict.js";
import { checkReviewedHead, normalizeHead, parseRevParseOutput, sameCommit } from "./reviewedHead.js";
import { reviewTargetBlock } from "./reviewTarget.js";
import { checkDigestCoverage, type PrSize } from "./digestCoverage.js";
import type { DigestReport } from "./diffDigest.js";
import type { RepoContext } from "./repoContext.js";
import type { RunEvent } from "./runEvents.js";
import type { RunControl } from "./runRegistry/runControl.js";
import { systemClock } from "./trace/clock.js";
import type { PullRequestFacts } from "../execution/githubPulls.js";

/** The PR's current head as GitHub reports it; undefined (or a throw) means
 *  unknown. The dispatcher passes `deps.fetchPrHead ?? currentPrHeadSha`. */
export type FetchPrHead = (pr: { repo: string; number: number }) => Promise<string | undefined>;
/** The PR's state, head and head-ref existence from one branch-aware read.
 *  Ship transitions use this instead of the head-only reader. */
export type FetchPrFacts = (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
/** The commits a PR head carries over its base; undefined (or a throw) means
 *  the move is unclassifiable. `deps.fetchPrCommits ?? prCommitsSince`. */
export type FetchPrCommits = (q: { repo: string; base: string; sha: string }) => Promise<PrCommitList | undefined>;

// ---- per-agent attach/release pairing ---------------------------------------

/** Release mode paired to a round's identity: a `read` identity attached a
 *  read-only worktree that holds nothing and can be torn down at once →
 *  "always"; any other ends its run in an orderly way → "if-idle": the
 *  workspace is released unless a command is still in flight in it, and what
 *  the run left uncommitted or unpushed is named — a run starts from a clean
 *  tree, so nothing in it survives the run (resident-repos item 16a). A hard
 *  stop means "tear it down now" (the abandoned command may still be running
 *  in there) → "always" regardless of the identity; so does a command the
 *  run's ending may have left running (`callsInFlight` on the record: a call
 *  the ending's abort or interrupt cut, a call open when the run failed, was
 *  interrupted or hard-stopped — never a call a completed or softly stopped
 *  run left unpaired, which ran in the bot or lost its result to a gap) — a
 *  release that waits for idle would be
 *  refused by the command and hold the workspace past the run — and so does
 *  the gate's bypass, whatever is in flight: what ran in the workspace was
 *  never vetted (harness.md item 13). */
export function releaseModeFor(
  identity: Identity,
  opts: { hardStopped: boolean; commandInFlight?: boolean; gateBypassed?: boolean },
): ReleaseMode {
  return identity === "read" || opts.hardStopped || opts.commandInFlight === true || opts.gateBypassed === true
    ? "always"
    : "if-idle";
}

/** One round's workspace: the executor selection made for the round's agent,
 *  paired with the release that matches that same agent. */
export interface RoundWorkspace {
  selection: ExecutorSelection;
  /**
   * Give the workspace back with the mode paired to the round's agent
   * (`releaseModeFor`). Best-effort: a failed release is a log line, never a
   * failed run. No-op when the executor holds nothing releasable.
   */
  release(opts: {
    hardStopped: boolean;
    /** The run's ending may have left a command running in the workspace (`callsInFlight` on the record). */
    commandInFlight?: boolean;
    /** The run failed on the gate's bypass (`HarnessGateBypassedError`): what ran in the workspace was never vetted. */
    gateBypassed?: boolean;
    /** The `post.workspace_release` span: the executor's release becomes its child. */
    span?: Span;
    /** The branches the run pushed and the pull requests they head (resident-repos
     *  item 16a): handed to the workspace's owner so the thread remembers them
     *  past the tree. Absent when the run pushed nothing. */
    pushed?: ReleaseOptions["pushed"];
  }): Promise<void>;
}

/**
 * Attach a workspace for one round: executor selection driven by the round's
 * effective profile (its machine class decides whether anything is
 * provisioned; a `read` identity gets a read-only resident worktree), with
 * the matching release bound to the same identity. `ResidentNeedsRefError`
 * propagates to the caller (the ask-once flow).
 */
export async function attachRoundWorkspace(input: {
  factory: ExecutorFactoryOptions;
  round: {
    threadKey: string;
    agent: AgentDef;
    /** The round's effective profile — what is provisioned, and as whom. */
    profile: RunProfile;
    repo?: string;
    ref?: string;
    headSha?: string;
    /** The pull request the thread's own run opened, whose head `ref` is
     *  (resident-repos item 16): the resident may move a default-bound thread onto it. */
    ownPr?: { number: number; ref: string };
    /** A resumed run's recorded binding (run-history item 54): the factory
     *  re-attaches there and never provisions again. */
    reattach?: WorkspaceBinding;
    /** The run's hard stop, where the caller holds a run control: the first
     *  attach's wake wait ends on it at once (execution.md item 9). */
    stopSignal?: AbortSignal;
    /** The run's remaining wall clock, where the caller holds a run control
     *  (`RunControl.remainingMs`; undefined until the lease starts): every
     *  attach the resident executor opens is clipped to it (execution.md item 9). */
    remainingMs?: () => number | undefined;
    /** The run's requester (the platform-namespaced user id), whose stored
     *  GitHub binding names the commits' author pair (record 0062). */
    requester?: string;
    /** The card's setup-note sink (issue 2044): the resident drain wait paints
     *  `waiting for the deploy to finish · N min` through it. */
    onSetupNote?: (note: string | undefined) => void;
  };
  logKey: string;
  /** The caller's `dispatch.workspace.attach` span: the probe and the attach
   *  become its `http.client` children (docs/reference/specs/tracing.md item 21). */
  span?: Span;
}): Promise<RoundWorkspace> {
  const { agent, profile } = input.round;
  const selection = await makeExecutor(
    input.factory,
    {
      threadKey: input.round.threadKey,
      agent,
      profile,
      repo: input.round.repo,
      ref: input.round.ref,
      headSha: input.round.headSha,
      ...(input.round.ownPr !== undefined ? { ownPr: input.round.ownPr } : {}),
      ...(input.round.reattach !== undefined ? { reattach: input.round.reattach } : {}),
      ...(input.round.stopSignal !== undefined ? { stopSignal: input.round.stopSignal } : {}),
      ...(input.round.remainingMs !== undefined ? { remainingMs: input.round.remainingMs } : {}),
      ...(input.round.requester !== undefined ? { requester: input.round.requester } : {}),
      ...(input.round.onSetupNote !== undefined ? { onSetupNote: input.round.onSetupNote } : {}),
    },
    input.span,
  );
  const release = async (opts: {
    hardStopped: boolean;
    commandInFlight?: boolean;
    gateBypassed?: boolean;
    span?: Span;
    pushed?: ReleaseOptions["pushed"];
  }): Promise<void> => {
    const { executor } = selection;
    if (!executor.release) return;
    const mode = releaseModeFor(profile.identity, opts);
    try {
      const releaseOpts: ReleaseOptions = {
        ...(opts.span ? { span: opts.span } : {}),
        ...(opts.pushed !== undefined && opts.pushed.length > 0 ? { pushed: opts.pushed } : {}),
      };
      const r = await executor.release(mode, Object.keys(releaseOpts).length > 0 ? releaseOpts : undefined);
      // What the release discarded is said here too (resident-repos item 16a):
      // the run's own record carries the note, published before its stream
      // closed; this line is the operator's copy.
      const left = r.leftBehind ? ` — ${leftBehindSentence(r.leftBehind)}` : "";
      console.log(
        `[release] ${input.logKey} ${r.released ? "released" : "kept"}${r.reason ? ` (${r.reason})` : ""}${left}`,
      );
    } catch (err) {
      console.warn(`[release] ${input.logKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return { selection, release };
}

// ---- review state + PR-head pre-flight (agent-review.md item 11) ------------

export type ClosedReviewPreflight = { ok: true } | { ok: false; reply: string };

/**
 * A resolved closed pull request is terminal before review admission. The
 * repository resolver owns the state fact; this pure projection owns its one
 * user-facing line, so no caller can start a workspace or run merely to repeat
 * GitHub's answer.
 */
export function closedReviewPreflight(input: {
  agent: AgentDef;
  repoCtx: Pick<RepoContext, "repo" | "closedPr">;
}): ClosedReviewPreflight {
  const { repo, closedPr } = input.repoCtx;
  if (input.agent.name !== "review" || repo === undefined || closedPr === undefined) return { ok: true };
  const where = `${repo}#${closedPr.number}`;
  return closedPr.merged
    ? {
        ok: false,
        reply: `${where} merged${closedPr.mergedAt !== undefined ? ` at ${closedPr.mergedAt}` : ""}; nothing to review. Say which pull request you meant.`,
      }
    : { ok: false, reply: `${where} is closed; nothing to review. Say which pull request you meant.` };
}

export type PrHeadPreflight = { ok: true } | { ok: false; where: string; reply: string };

/**
 * Unknown-head refusal BEFORE any attach or model call: a review whose PR
 * head could not be resolved — the message named a PR but the GitHub fetch
 * failed, or the thread's inherited PR was unreachable — is a guaranteed
 * refusal downstream (the reviewed-head guard refuses the post), so it is not
 * started at all. Only for a round whose verdict is MEANT to be posted
 * (`reviewPostIntended` on the round's agent): an explicit "slack only"
 * opt-out wants no post anyway, so an unpinned review is exactly what was
 * asked for. `ok: false` carries the refusal reply verbatim; the caller
 * closes its card and sends it.
 */
export function checkPrHeadPreflight(input: {
  agent: AgentDef;
  requestText: string;
  repoCtx: Pick<RepoContext, "repo" | "pr" | "headSha" | "prUnpostable">;
}): PrHeadPreflight {
  const { repoCtx } = input;
  if (!repoCtx.repo || !reviewPostIntended({ agentName: input.agent.name, requestText: input.requestText }))
    return { ok: true };
  const unknownHead =
    repoCtx.pr !== undefined && !repoCtx.headSha
      ? repoCtx.pr
      : repoCtx.prUnpostable?.reason === "unreachable"
        ? repoCtx.prUnpostable.number
        : undefined;
  if (unknownHead === undefined) return { ok: true };
  const where = `${repoCtx.repo}#${unknownHead}`;
  return {
    ok: false,
    where,
    reply:
      `🔀 Review of ${where} not started: GitHub did not give me a usable head commit for the PR (the lookup failed, or answered without a well-formed SHA), ` +
      `so I cannot pin a review to it. This is a bug: no automatic head lookup retry was scheduled, and nothing was posted to GitHub.`,
  };
}

// ---- attach-head guard (agent-review.md items 10 + 12) ----------------------

export type AttachHeadGuard =
  | { outcome: "verified" }
  | { outcome: "adopted"; headSha: string }
  | { outcome: "unverified" }
  | { outcome: "refused"; reply: string };

/**
 * Compare the workspace head with the PR head the round resolved, BEFORE any
 * model call, on every backend. Equal → verified. Different well-formed shas
 * get one current-head lookup so an attach that raced a push may adopt the
 * current head; otherwise the run is refused and its workspace released. An
 * unreadable workspace head is refused too: without proof that the checkout is
 * the PR head, an infrastructure failure must never become a review finding or
 * a GitHub post. Only an invalid expected head remains `unverified`; the
 * earlier PR-head gate owns that refusal.
 */
export async function guardAttachedHead(input: {
  pr: { repo: string; number: number };
  /** The PR head resolved for the round (`RepoContext.headSha`). */
  expectedHeadSha: string | undefined;
  /** What the backend proved before the model: the head, ref and source. */
  attached: {
    sha: string | undefined;
    ref: string | undefined;
    source?: "resident binding" | "workspace-observed";
  };
  /** Named in the refusal when the attach answered no ref. */
  fallbackRef: string | undefined;
  fetchPrHead: FetchPrHead;
  logKey: string;
}): Promise<AttachHeadGuard> {
  const expected = normalizeHead(input.expectedHeadSha);
  if (!expected) return { outcome: "unverified" };
  const attached = normalizeHead(input.attached.sha);
  const source = input.attached.source ?? "workspace-observed";
  const where = `${input.pr.repo}#${input.pr.number}`;
  const branch = input.attached.ref ?? input.fallbackRef;
  const namedSource =
    source === "resident binding"
      ? branch
        ? `${source} for ${branch}`
        : source
      : branch
        ? `${source} HEAD for ${branch}`
        : `${source} HEAD`;
  if (!attached) {
    console.log(`[review] ${input.logKey} not started: ${namedSource} unreadable, PR head ${expected} (${where})`);
    return {
      outcome: "refused",
      reply:
        `🔀 Review of ${where} not started: ${namedSource} could not be read, so the workspace cannot be verified against PR head ${expected}. ` +
        `This is a bug: the infrastructure failure was not retried automatically. It is not a finding, and nothing was posted to GitHub.`,
    };
  }
  if (sameCommit(expected, attached)) return { outcome: "verified" };
  const current = normalizeHead(await input.fetchPrHead(input.pr).catch(() => undefined));
  if (current && sameCommit(attached, current)) {
    console.log(
      `[review] ${input.logKey} PR head moved since resolution: ${expected} → ${current}; the ${namedSource} is at the current head — reviewing it (${where})`,
    );
    return { outcome: "adopted", headSha: current };
  }
  console.log(`[review] ${input.logKey} not started: ${namedSource} ${attached}, PR head ${expected} (${where})`);
  return {
    outcome: "refused",
    reply:
      `🔀 Review of ${where} not started: the ${namedSource} is at ${attached}, but the PR head is ${expected} — the branch moved while the workspace was being prepared (a push or force-push). ` +
      `This is a bug: the workspace was not reprovisioned automatically at the new head. It is not a finding, and nothing was posted to GitHub.`,
  };
}

// ---- head pin + system composition ------------------------------------------

/** The commit a composed system prompt is pinned to, and whether the attach
 *  verified the worktree is at it (told to the model as fact, so it has no
 *  reason to go and look). */
export interface HeadPin {
  sha: string | undefined;
  verified: boolean;
}

/**
 * Build the round's system composer: a function of the pinned head, so a
 * re-review at a moved head recomposes the prompt with the new commit instead
 * of contradicting the old one. Composition order (unchanged from dispatch):
 * memory (advisory context, leads when present) → config awareness → custom
 * instructions → the agent's effective instructions — the resident variant
 * when on a resident worktree, the REVIEW TARGET block appended for a PR
 * review (`prTarget` set — the caller decides, from the round's agent and its
 * resolved PR), the skills list trailing. With no blocks and no resident/PR
 * context the result is the agent's own prompt, byte-identical.
 */
export function makeSystemComposer(input: {
  agent: AgentDef;
  /** True on the resident path: swaps in the agent's resident system variant. */
  resident: boolean;
  /** The resolved target repo, named by the resident variant. */
  repo: string | undefined;
  /** The attached worktree path, when the attach answered one. */
  workspace: string | undefined;
  /** The sandbox was seeded from the resident's snapshot (execution.md item 26):
   *  swaps in the agent's seeded variant, naming the checkout. Never with `resident`. */
  seeded?: { workspace: string } | undefined;
  /** Set for a PR review round: the REVIEW TARGET block's coordinates. */
  prTarget:
    { repo: string; pr: number; ref: string | undefined; baseRef: string | undefined; size?: PrSize } | undefined;
  /** The unit contract block of a plan-unit review round (docs/reference/specs/agent-ship.md
   *  item 13), rendered by the pipeline: placed right after the REVIEW TARGET
   *  block (after the agent's prompt when there is none), so the review child
   *  reads exactly what the coding child was handed. */
  contract?: string;
  /** Pre-built advisory/context blocks; absent blocks leave the prompt untouched.
   *  `about` is the self-description (routing-and-config behavior 11), right
   *  after the config block — the same category of fact-about-yourself. */
  blocks: {
    memory: string | undefined;
    /** The agent's own notes for this thread and the summary its last
     *  compaction wrote (docs/reference/specs/session-log.md item 10): advisory
     *  context like memory, right after it — what this session already knows. */
    notes?: string | undefined;
    /** The thread's artifacts since the agent's previous run (docs/reference/specs/session-log.md
     *  item 9): what other runs of the thread recorded, as data — right after
     *  the notes, since both are what the run knows before it reads anything. */
    artifacts?: string | undefined;
    config: string | undefined;
    about?: string | undefined;
    instructions: string | undefined;
    skills: string | undefined;
    mcp?: string | undefined;
  };
}): (head: HeadPin) => string {
  const { agent, resident, workspace, prTarget, blocks, seeded } = input;
  const residentSystem =
    resident && agent.residentSystem
      ? `${agent.residentSystem}\n\nTarget repository: ${input.repo}. ` +
        (workspace
          ? `Your shell starts in the worktree \`${workspace}\` on every bash call; it is already on this thread's bound branch (confirm with \`git branch --show-current\` from there — no \`cd\`).`
          : "The worktree is already on this thread's bound branch (confirm with `git branch --show-current`).")
      : undefined;
  // The seeded variant names the checkout the seed left, the way the resident
  // variant names its worktree; a run that is both is impossible (a seed
  // happens only when no resident took the run), and resident wins if it were.
  const seededSystem =
    !resident && seeded && agent.seededSystem
      ? `${agent.seededSystem}\n\nTarget repository: ${input.repo}. The repository is checked out at \`${seeded.workspace}\`; your shell starts in \`/workspace\`, so \`cd ${seeded.workspace}\` first (confirm the branch with \`git branch --show-current\` there).`
      : undefined;
  const targetBlock = (head: HeadPin): string | undefined =>
    prTarget
      ? reviewTargetBlock({
          repo: prTarget.repo,
          pr: prTarget.pr,
          ref: prTarget.ref,
          headSha: head.sha,
          baseRef: prTarget.baseRef,
          ...(prTarget.size ? { size: prTarget.size } : {}),
          resident,
          ...(workspace ? { workspace } : {}),
          ...(!resident && seeded ? { seeded: { workspace: seeded.workspace } } : {}),
          ...(head.verified ? { verifiedAtAttach: true } : {}),
        })
      : undefined;
  const agentSystem = (head: HeadPin): string => {
    // The agent's prompt, then the REVIEW TARGET block, then the unit contract
    // it is judged against; tool guidance trails the agent's own instructions:
    // skills, then the external MCP servers (docs/reference/specs/mcp-tools.md item 9)
    // — both are about the agent's tools, not advisory context like the
    // memory block up front.
    return [
      residentSystem ?? seededSystem ?? agent.system,
      targetBlock(head),
      input.contract,
      blocks.skills,
      blocks.mcp,
    ]
      .filter((b): b is string => Boolean(b))
      .join("\n\n");
  };
  return (head) =>
    [blocks.memory, blocks.notes, blocks.artifacts, blocks.config, blocks.about, blocks.instructions, agentSystem(head)]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
}

// ---- reviewed-head settle: probe + head-move void + single re-review --------
// (agent-review.md items 8 + 12)

/** Everything one more model turn needs, grouped: the round's preset and the
 *  run wiring the first turn already used. The settle reuses `toolContext` for
 *  its re-review turn with its own verdict capture (the voided verdict must
 *  not leak back through the first turn's hook). The turn is one more `prompt`
 *  on the run's own pi session, through `followUp` (harness-pi item 14). */
export interface ReviewTurnSpec {
  /** The preset with its effective budget: the re-review's own budget. */
  agent: AgentDef;
  toolContext: ToolContext;
  onEvent: (event: RunEvent) => void;
  control: RunControl;
  /** One more turn on the run's own pi session (harness-pi item 14). Absent —
   *  a `finish` plan, whose session ended with the previous generation — a
   *  substantive move is not re-reviewed: the verdict stands for the head it
   *  reviewed and the post gate pins it there (agent-review item 10). */
  followUp?: FollowUpTurn;
}

/** What the settle decided the round actually reviewed — the values the post
 *  gate then checks. `carried` is set when the head moved by a rebase of the
 *  same commits (the post is pinned to `current` with a footer). */
export interface SettledReviewHead {
  answer: string;
  verdict: ReviewVerdict | undefined;
  reviewHead: string | undefined;
  observedHead: string | undefined;
  carried: { reviewed: string; current: string; commits: number } | undefined;
}

/**
 * After a review round's model turn, read the workspace HEAD (BEFORE the
 * workspace can be released — post-release a resident would re-attach at the
 * ref's CURRENT tip, which is not evidence of what was reviewed) and fetch
 * the PR head NOW, before anything is posted:
 *
 *   reviewed = current ≠ resolved → the round reviewed the PR's current head
 *     (a mid-run re-attach landed on a newer tip): adopt it.
 *   reviewed = resolved ≠ current → the PR moved under the review: classify
 *     the move from GitHub's compare lists. A rebase of the same commits
 *     carries the review to the new head (`carried`); a substantive move
 *     voids the verdict and re-reviews at the new head — worktree moved, ONE
 *     more prompt on the run's pi session (`messages` is appended in place) —
 *     before returning; a round with no session left to prompt (a `finish`
 *     plan) keeps the verdict for the head it reviewed and says so.
 *     Unclassifiable → item 10 (the post gate pins to the reviewed head; the
 *     note follows the post). Once: a head that moves again after the
 *     re-review is item 10's problem, never a third turn.
 *   reviewed ≠ both → returned as-is; the post gate refuses (item 8).
 *
 * The caller decides whether to invoke this at all (a hard-stopped round
 * observes nothing and posts nothing).
 */
export async function settleReviewedHead(input: SettleReviewedHeadInput): Promise<SettledReviewHead> {
  // The whole settle is one uncounted `run.settle_reviewed_head` span
  // (docs/reference/specs/tracing.md): its git and GitHub awaits are overhead by design,
  // and the re-review's `run.agent` is its child.
  return input.span
    ? input.span.span("run.settle_reviewed_head", (span) => settle(input, span))
    : settle(input, undefined);
}

export interface SettleReviewedHeadInput {
  /** The parent span, when the run is traced. */
  span?: Span;
  pr: { repo: string; number: number };
  /** The PR's base ref — required to classify a head move; unknown → item 10. */
  baseRef: string | undefined;
  /** The head pinned for this round (resolved, or adopted at attach). */
  reviewHead: string | undefined;
  /** The verdict the round's turn submitted (voided on a substantive move). */
  verdict: ReviewVerdict | undefined;
  answer: string;
  /** The round's message list — the re-review appends its turns IN PLACE. */
  messages: ChatMessage[];
  executor: Executor;
  turn: ReviewTurnSpec;
  fetchPrHead: FetchPrHead;
  fetchPrCommits: FetchPrCommits;
  /** Re-evaluated after every awaited settlement boundary. True only when a
   *  stop preceded substantive review work; the caller owns latching and
   *  clearing the review outcome. */
  preReviewStopped: () => boolean;
  notify: {
    /** Thread note before a re-review; best-effort (failures swallowed). */
    reply: (text: string) => Promise<void>;
    /** Mark the round's visible label with the head-move suffix. */
    headMoved: (labelSuffix: string) => void;
  };
  logKey: string;
}

async function settle(input: SettleReviewedHeadInput, span: Span | undefined): Promise<SettledReviewHead> {
  const { pr, executor, turn, logKey } = input;
  // The probe and the move are the settle's own work: their `exec.*` spans hang
  // under `run.settle_reviewed_head` (docs/reference/specs/tracing.md item 17).
  const trace = span ? { span } : undefined;
  const probeHead = async () => parseRevParseOutput(await executor.exec("git rev-parse HEAD", trace).catch(() => ""));
  let answer = input.answer;
  let verdict = input.verdict;
  let reviewHead = input.reviewHead;
  let carried: { reviewed: string; current: string; commits: number } | undefined;
  let observedHead = await probeHead();
  const outcome = (): SettledReviewHead => ({ answer, verdict, reviewHead, observedHead, carried });
  if (input.preReviewStopped()) return outcome();
  const where = `${pr.repo}#${pr.number}`;
  const currentHead = async () => normalizeHead(await input.fetchPrHead(pr).catch(() => undefined));
  const expected = normalizeHead(reviewHead);
  const reviewed = normalizeHead(observedHead) ?? normalizeHead(verdict?.head);
  if (expected && reviewed) {
    const current = await currentHead();
    if (input.preReviewStopped()) return outcome();
    if (current && !sameCommit(current, expected) && sameCommit(reviewed, current)) {
      console.log(
        `[review] ${logKey} reviewed the PR's current head ${current.slice(0, 7)} (resolved ${expected.slice(0, 7)} was superseded mid-run) (${where})`,
      );
      reviewHead = current;
    } else if (current && !sameCommit(current, expected) && sameCommit(reviewed, expected)) {
      const classified = await classifyMove(input.fetchPrCommits, {
        repo: pr.repo,
        base: input.baseRef,
        from: expected,
        to: current,
      });
      if (input.preReviewStopped()) return outcome();
      const move = classified?.move;
      const followUp = turn.followUp;
      if (move?.kind === "rebase") {
        console.log(
          `[review] ${logKey} head moved during run: ${expected.slice(0, 7)} → ${current.slice(0, 7)} — rebase of the same ${move.commits} commit(s); review carried to ${current.slice(0, 7)} (${where})`,
        );
        carried = { reviewed: expected, current, commits: move.commits };
      } else if (classified && move?.kind === "substantive" && !followUp) {
        // No session to re-review on (a `finish` plan): the review stands for
        // the head it read, said on the record, and the post gate pins it there.
        const summary = `head moved ${expected.slice(0, 7)} → ${current.slice(0, 7)} — not re-reviewed: the loop answered before a restart and its session is gone; the verdict stands for ${expected.slice(0, 7)}`;
        console.log(`[review] ${logKey} ${summary} (${where})`);
        turn.onEvent({ type: "run_note", kind: "head_moved", summary, at: systemClock() });
      } else if (classified && move?.kind === "substantive" && followUp) {
        const summary = `head moved ${expected.slice(0, 7)} → ${current.slice(0, 7)} — re-reviewing at ${current.slice(0, 7)}`;
        console.log(`[review] ${logKey} ${summary} (${where})`);
        turn.onEvent({ type: "run_note", kind: "head_moved", summary, at: systemClock() });
        input.notify.headMoved(`head moved → ${current.slice(0, 7)}`);
        await input.notify.reply(headRereviewNote({ where, reviewed: expected, current, move })).catch(() => {});
        if (input.preReviewStopped()) return outcome();
        // Resident: move the worktree ourselves (one re-attach at the new
        // head), the round's hard stop riding in so a move that waits on the
        // resident ends with the stop. Anything else — no moveTo, a refusal,
        // a tip that moved again under the re-attach — leaves the model to
        // check it out.
        let worktreeMoved = false;
        if (executor.moveTo) {
          try {
            const moved = await executor.moveTo(current, { ...trace, signal: turn.control.hardSignal });
            const at = normalizeHead(moved.sha);
            worktreeMoved = at !== undefined && sameCommit(at, current);
            console.log(
              `[review] ${logKey} worktree moved to ${at?.slice(0, 7) ?? "?"}${worktreeMoved ? "" : " (not the expected head)"}`,
            );
          } catch (err) {
            console.warn(
              `[review] ${logKey} worktree move failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (input.preReviewStopped()) return outcome();
        verdict = undefined; // the earlier verdict is void; the re-review must submit its own
        reviewHead = current;
        const followUpText = rereviewFollowUp({
          where,
          reviewed: expected,
          current,
          move,
          before: classified.before,
          after: classified.after,
          worktreeMoved,
        });
        input.messages.push(
          { role: "assistant", content: [{ type: "text", text: answer }] },
          { role: "user", content: [{ type: "text", text: followUpText }] },
        );
        const toolContext: ToolContext = {
          ...turn.toolContext,
          onVerdict: (v) => {
            verdict = v;
          },
        };
        // One more turn on the run's own pi session. The follow-up alone
        // carries the new head: pi reads its system prompt once, at load, so
        // the REVIEW TARGET block stays the session's (harness-pi item 14).
        answer = await followUp({
          text: followUpText,
          maxTurns: turn.agent.maxTurns,
          maxMinutes: turn.agent.maxMinutes,
          toolContext,
          ...(span ? { span } : {}),
        });
        if (input.preReviewStopped()) return outcome();
        // Re-read, not narrowed: the stop may have been requested during the turn.
        if (!turn.control.hardSignal.aborted) observedHead = await probeHead();
        if (input.preReviewStopped()) return outcome();
      }
    }
  }
  return outcome();
}

/** Item 12: the PR's commits over its base at the reviewed head and at the
 *  current one (two compare GETs, in parallel), classified. Undefined — no
 *  verdict — when the base branch is unknown or either list could not be
 *  fetched; the caller then falls back to item 10. */
async function classifyMove(
  fetchPrCommits: FetchPrCommits,
  q: { repo: string; base: string | undefined; from: string; to: string },
): Promise<{ move: HeadMove; before: PrCommitList; after: PrCommitList } | undefined> {
  if (!q.base) return undefined;
  const [before, after] = await Promise.all([
    fetchPrCommits({ repo: q.repo, base: q.base, sha: q.from }).catch(() => undefined),
    fetchPrCommits({ repo: q.repo, base: q.base, sha: q.to }).catch(() => undefined),
  ]);
  if (!before || !after) return undefined;
  return { move: classifyHeadMove(before, after), before, after };
}

// ---- reviewed-head post gate + review post (agent-review.md item 8) ---------

/** How the post step ended — the `ReviewPost` the run's record carries
 *  (agent-review.md item 18): `posted: true` only when the GitHub post call
 *  succeeded, with the pull request, the pinned head and the verdict kind;
 *  every skip, guard refusal, and failure is `posted: false` with the reason
 *  (already said in the thread where the contract wants it said). The run loop
 *  writes it onto the record, and a coordinator's `read-record` answers
 *  `reviewPosted` from it: an approve whose LGTM never landed on the PR must
 *  not be reported merge-ready, and one that landed a second ago must not
 *  read as unposted because GitHub's review list lags. */
export type ReviewPostOutcome = ReviewPost;

/**
 * The deterministic review post-step: a round on the review agent against a
 * resolved PR posts its verdict back to that PR by default — unless the
 * request opted out, the round was hard-stopped (no findings, only the abort
 * line), or the reviewed-head guard refuses (fail-closed: the commit the
 * round actually reviewed must BE the pinned head). Every
 * skip and failure is said out loud through `reply` (best-effort, never a
 * failed run): the Slack-only notes, the carried-forward note, and the
 * head-moved-after-post note (one best-effort GET; unknown → no note, never a
 * false alarm). Safe to call at any lifecycle position — it touches only its
 * inputs, so the plain dispatch path keeps calling it AFTER workspace release
 * and registry finish, while a ship round may invoke it inside its loop.
 * Never throws; the returned `ReviewPostOutcome` says whether a post landed.
 */
export async function runReviewPostStep(
  input: {
    agent: AgentDef;
    requestText: string;
    repoCtx: Pick<RepoContext, "repo" | "pr" | "prUnpostable" | "prSize">;
    /** The pinned head and the workspace HEAD observed after the turn. */
    heads: { reviewHead: string | undefined; observedHead: string | undefined };
    verdict: ReviewVerdict | undefined;
    /** The last diff digest the round's agent computed (`diff_digest` →
     *  `onDigest`), or undefined when it never called the tool. */
    digest: DigestReport | undefined;
    answer: string;
    carried: { reviewed: string; current: string; commits: number } | undefined;
    hardStopped: boolean;
    /** The GitHub post; the dispatcher passes `deps.postReviewComment ?? postReviewComment`. */
    post: (target: ReviewCommentTarget, body: string) => Promise<void>;
    fetchPrHead: FetchPrHead;
    reply: (text: string) => Promise<void>;
    /** An acknowledgement's reply (routing-and-config item 28) — the carried-
     *  review note goes out through it, so the request's verbosity decides;
     *  absent, `reply`. The notes that need the person (a review not posted, a
     *  head that moved after the pin) stay on `reply`. */
    ack?: (text: string) => Promise<void>;
    /** The run's stream (`registry.publish` bound to the run): the outcome is
     *  published as a `review_posted` event or a `review_not_posted` note for a
     *  review round that was asked to post (item 18). Absent → the outcome is
     *  only returned (a caller outside a run). */
    publish?: (event: RunEvent) => void;
    logKey: string;
  } & (
    | {
        /** Ship children re-read state, head and head-ref existence immediately
         *  before posting because their parent can revoke the transition. */
        guardTransition: true;
        fetchPrFacts: FetchPrFacts;
      }
    | {
        /** Standalone reviews keep their established post-publication head read. */
        guardTransition?: false;
        fetchPrFacts?: FetchPrFacts;
      }
  ),
): Promise<ReviewPostOutcome> {
  const { agent, repoCtx, verdict, carried, logKey } = input;
  const { reviewHead, observedHead } = input.heads;
  // The record's fact (item 18): what a review round leaves behind about its
  // post. A non-review round posts nothing and records nothing; a hard-stopped
  // round records nothing either — the abort is the record's story.
  const record = (outcome: ReviewPostOutcome): ReviewPostOutcome => {
    if (input.publish && agent.name === "review" && !input.hardStopped) {
      const where = outcome.posted
        ? undefined
        : repoCtx.repo && repoCtx.pr
          ? `${repoCtx.repo}#${repoCtx.pr}`
          : undefined;
      input.publish(
        outcome.posted
          ? {
              type: "review_posted",
              repo: outcome.target.repo,
              number: outcome.target.number,
              head: outcome.head,
              ...(outcome.verdict !== undefined ? { verdict: outcome.verdict } : {}),
              at: systemClock(),
            }
          : {
              type: "run_note",
              kind: "review_not_posted",
              summary: `review not posted${where ? ` to ${where}` : ""}: ${outcome.reason}`,
              at: systemClock(),
            },
      );
    }
    return outcome;
  };
  let postTarget: ReviewPostTarget | null = null;
  // Why nothing was posted, carried into the typed outcome — every path that
  // leaves `postTarget` null fills it (the hard-stop skip is the default).
  let skipReason = "the round was hard-stopped — nothing is posted after an abort";
  if (!input.hardStopped) {
    postTarget = decideReviewPost({
      agentName: agent.name,
      repo: repoCtx.repo,
      pr: repoCtx.pr,
      requestText: input.requestText,
    });
    if (!postTarget) {
      skipReason = "no PR post was intended for this round";
      if (agent.name === "review") {
        // Never a silent skip: a review that lands only in Slack says why, so a
        // re-review that failed to resolve its PR is visible in the logs — and,
        // when the thread HAD a bound PR that turned out closed, in the thread
        // itself: a Slack-only verdict must never be mistaken for a posted one.
        // (An UNREACHABLE bound PR never gets this far — the unknown-head check
        // refuses the run before any model turn.) An explicit opt-out is
        // the one case where the user already knows: log it, no note.
        const optedOut = reviewPostOptedOut(input.requestText);
        const unpostable = optedOut ? undefined : repoCtx.prUnpostable;
        const why = optedOut ? "opted out" : unpostable ? `bound PR ${unpostable.reason}` : "no PR resolved";
        skipReason = why;
        console.log(`[review-post] ${logKey} skipped: ${why} (repo ${repoCtx.repo ?? "none"})`);
        if (unpostable && repoCtx.repo) {
          const detail =
            unpostable.reason === "closed" ? "the PR is closed" : "the PR's head could not be verified on GitHub";
          await input
            .reply(
              `ℹ️ Review not posted to ${repoCtx.repo}#${unpostable.number}: ${detail} — this verdict is Slack-only.`,
            )
            .catch(() => {});
        }
      }
    }
  }
  if (postTarget) {
    const where = `${postTarget.repo}#${postTarget.number}`;
    // Reviewed-head guard (item 8): the review is posted to this PR only if
    // the commit the agent reviewed IS the PR head resolved for this run.
    // Observed HEAD is authoritative; the verdict's reported head is the
    // fallback; unknown either way → no post (fail-closed). Otherwise an agent
    // that reviewed another PR's branch gets its LGTM posted — and
    // auto-approved — on the wrong PR.
    const head = checkReviewedHead({ expected: reviewHead, observed: observedHead, reported: verdict?.head });
    if (!head.ok) {
      console.log(`[review-post] ${logKey} skipped: ${head.reason} (${where})`);
      await input
        .reply(`ℹ️ Review not posted to ${where}: ${head.reason} — this verdict is Slack-only.`)
        .catch(() => {});
      skipReason = head.reason;
      postTarget = null;
    }
  }
  if (postTarget) {
    // Digest-coverage guard (item 15): the head guard proved WHICH commit was
    // reviewed; this one asks how much of its change the agent's digest
    // covered. A digest that covered less than GitHub says the PR carries —
    // or one that could not state its totals — means the review may not have
    // read the whole change, and its verdict is not posted. Nothing to compare
    // (no digest, no PR size) passes: the guard catches a digest that lied,
    // it does not require one.
    const where = `${postTarget.repo}#${postTarget.number}`;
    const coverage = checkDigestCoverage({ digest: input.digest, pr: repoCtx.prSize });
    if (!coverage.ok) {
      console.log(`[review-post] ${logKey} skipped: ${coverage.reason} (${where})`);
      await input
        .reply(`ℹ️ Review not posted to ${where}: ${coverage.reason} — this verdict is Slack-only.`)
        .catch(() => {});
      skipReason = coverage.reason;
      postTarget = null;
    }
  }
  if (input.guardTransition === true && postTarget && reviewHead) {
    // Final transition guard immediately before the write: one fresh facts
    // read must prove the pull request is open, its head ref still exists and
    // that ref is at the commit this verdict covers. A head-only read can keep
    // reporting the last commit after a same-repository branch is deleted.
    const where = `${postTarget.repo}#${postTarget.number}`;
    const pinned = carried?.current ?? reviewHead;
    const facts = await input.fetchPrFacts({ repo: postTarget.repo, number: postTarget.number }).catch(() => undefined);
    const current =
      facts?.state === "open" && facts.headBranchExists === true ? normalizeHead(facts.headSha) : undefined;
    if (current === undefined || !sameCommit(current, pinned)) {
      const reason =
        current === undefined
          ? "the pull request is no longer open at a readable head"
          : `the PR head moved to ${current.slice(0, 7)} after the review of ${pinned.slice(0, 7)}`;
      console.log(`[review-post] ${logKey} skipped: ${reason} (${where})`);
      await input.reply(`ℹ️ Review not posted to ${where}: ${reason} — this verdict is Slack-only.`).catch(() => {});
      skipReason = reason;
      postTarget = null;
    }
  }
  if (postTarget && reviewHead) {
    // narrowing only — the guard above already required it
    // Pinned to the PR head the guard just verified was reviewed — or, for a
    // review carried across a rebase (item 12), to the new head it applies
    // to — so the org's auto-approve stale-review check bites on a later push
    // and not on this one.
    const pinned = carried?.current ?? reviewHead;
    const target: ReviewCommentTarget = { ...postTarget, commitId: pinned };
    // The verdict line is built here, by code — the model's prose never
    // decides whether the body starts with "LGTM:" (auto-approve contract).
    const rendered = buildReviewPostBody(input.answer, verdict, { repo: postTarget.repo, head: pinned });
    const body = carried ? `${rendered}\n\n${carriedFooter(carried)}` : rendered;
    const where = `${postTarget.repo}#${postTarget.number}`;
    try {
      await input.post(target, body);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[review-post] ${logKey} failed for ${where}: ${reason}`);
      await input.reply(`ℹ️ Review not posted to ${where}: ${reason} — this verdict is Slack-only.`).catch(() => {});
      return record({ posted: false, reason });
    }
    console.log(
      `[review-post] ${logKey} → ${where} (${verdict?.verdict ?? "no verdict"})${carried ? ` carried ${carried.reviewed.slice(0, 7)} → ${pinned.slice(0, 7)}` : ""}`,
    );
    if (carried) await (input.ack ?? input.reply)(headCarriedNote({ where, ...carried })).catch(() => {});
    // Head-moved note (item 10): a push that landed after the head was last
    // checked makes this a review of an outdated commit — pinned, so it
    // will not auto-approve (correct) but silent in the thread (not). One
    // best-effort GET after the post; unknown current head → no note, never
    // a false alarm. The default `currentPrHeadSha` never throws; the
    // `.catch` guards an injected `fetchPrHead` (the seam's contract is
    // "undefined or a throw both mean unknown"). The post already landed, so
    // these notes never demote the outcome.
    const current = await input
      .fetchPrHead({ repo: postTarget.repo, number: postTarget.number })
      .catch(() => undefined);
    const moved = headMovedNote({ where, reviewed: pinned, current });
    if (moved) {
      console.log(
        `[review-post] ${logKey} head moved after review: ${pinned.slice(0, 7)} → ${current?.slice(0, 7)} (${where})`,
      );
      await input.reply(moved).catch(() => {});
    }
    return record({
      posted: true,
      target: { repo: postTarget.repo, number: postTarget.number },
      head: pinned,
      ...(verdict !== undefined ? { verdict: verdict.verdict } : {}),
    });
  }
  return record({ posted: false, reason: skipReason });
}
