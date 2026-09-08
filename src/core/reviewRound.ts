// Per-round review + workspace machinery, extracted from dispatch() as
// callable units (agent:ship plan U4, zero behavior change): everything a
// review or coding round must invoke — workspace attach/release paired on the
// round's agent, the PR-head pre-flight, the attach-head guard, head-pinned
// system composition, the head-move settle + single re-review, and the
// reviewed-head post gate — parameterized on an explicit `AgentDef` instead of
// branches keyed on the dispatch's top-level resolved agent. `dispatch()`'s
// plain agent:review / agent:coding paths call these units at their existing
// lifecycle positions; a ship round (plan U7) invokes the same units per
// child round.
//
// Every unit takes a `logKey` for its console lines (the dispatcher passes
// the thread key) and returns explicit values; transport concerns (the status
// card, the channel reply's wording around a refusal) stay with the caller
// except where the text IS the unit's contract (refusal replies, post notes).

import type { AgentDef } from "../agents/registry.js";
import type { Effort } from "../effort.js";
import type { ChatMessage, Provider } from "../providers/types.js";
import { runAgent } from "../runner.js";
import { makeExecutor, type ExecutorFactoryOptions, type ExecutorSelection } from "../execution/factory.js";
import type { Executor, ReleaseMode } from "../execution/executor.js";
import type { RunnableTool, ToolContext } from "../tools/workspace.js";
import type { Span } from "../core/trace/types.js";
import type { Backend } from "../core/trace/attrs.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
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
import { buildReviewPostBody, type ReviewVerdict } from "./reviewVerdict.js";
import { checkReviewedHead, normalizeHead, parseRevParseOutput, sameCommit } from "./reviewedHead.js";
import { reviewTargetBlock } from "./reviewTarget.js";
import type { RepoContext } from "./repoContext.js";
import type { RunEvent } from "./runEvents.js";
import type { RunControl } from "./runRegistry.js";
import { systemClock } from "./trace/clock.js";

/** The PR's current head as GitHub reports it; undefined (or a throw) means
 *  unknown. The dispatcher passes `deps.fetchPrHead ?? currentPrHeadSha`. */
export type FetchPrHead = (pr: { repo: string; number: number }) => Promise<string | undefined>;
/** The commits a PR head carries over its base; undefined (or a throw) means
 *  the move is unclassifiable. `deps.fetchPrCommits ?? prCommitsSince`. */
export type FetchPrCommits = (q: { repo: string; base: string; sha: string }) => Promise<PrCommitList | undefined>;

// ---- per-agent attach/release pairing (KTD4) --------------------------------

/** Release mode paired to a round's agent: a readonly toolset holds nothing
 *  worth keeping → "always"; a writable one keeps a worktree with
 *  uncommitted/unpushed work → "if-clean". A hard stop means "tear it down
 *  now" (the abandoned command may still be running in there) → "always"
 *  regardless of the agent. */
export function releaseModeFor(agent: AgentDef, opts: { hardStopped: boolean }): ReleaseMode {
  return agent.toolset === "readonly" || opts.hardStopped ? "always" : "if-clean";
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
    /** The `post.workspace_release` span: the executor's release becomes its child. */
    span?: Span;
  }): Promise<void>;
}

/**
 * Attach a workspace for one round: executor selection driven by the round's
 * `AgentDef` (its resource declarations decide whether anything is
 * provisioned; a readonly toolset gets a read-only resident worktree), with
 * the matching release bound to the same agent. `ResidentNeedsRefError`
 * propagates to the caller (the ask-once flow).
 */
export async function attachRoundWorkspace(input: {
  factory: ExecutorFactoryOptions;
  round: { threadKey: string; agent: AgentDef; repo?: string; ref?: string; headSha?: string };
  logKey: string;
  /** The caller's `dispatch.workspace.attach` span: the probe and the attach
   *  become its `http.client` children (features/tracing.md item 21). */
  span?: Span;
}): Promise<RoundWorkspace> {
  const { agent } = input.round;
  const selection = await makeExecutor(
    input.factory,
    {
      threadKey: input.round.threadKey,
      agent,
      repo: input.round.repo,
      ref: input.round.ref,
      headSha: input.round.headSha,
    },
    input.span,
  );
  const release = async (opts: { hardStopped: boolean; span?: Span }): Promise<void> => {
    const { executor } = selection;
    if (!executor.release) return;
    const mode = releaseModeFor(agent, opts);
    try {
      const r = await executor.release(mode, opts.span ? { span: opts.span } : undefined);
      console.log(`[release] ${input.logKey} ${r.released ? "released" : "kept"}${r.reason ? ` (${r.reason})` : ""}`);
    } catch (err) {
      console.warn(`[release] ${input.logKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return { selection, release };
}

// ---- PR-head pre-flight (agent-review.md item 11) ---------------------------

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
      `so I cannot pin a review to it. Re-send the request in a moment; if it keeps failing, look at the PR on GitHub and at the bot's GitHub App credentials.`,
  };
}

// ---- attach-head guard (agent-review.md items 10 + 12, #282) ----------------

export type AttachHeadGuard =
  | { outcome: "verified" }
  | { outcome: "adopted"; headSha: string }
  | { outcome: "unverified" }
  | { outcome: "refused"; reply: string };

/**
 * Compare the sha the resident ATTACHED the worktree at with the PR head the
 * round resolved, BEFORE any model call. Equal → "verified" (told to the
 * model as fact). Different well-formed shas → one current-head lookup
 * decides: attached = the PR's head NOW (a push raced the request and the
 * attach landed on it) → "adopted" with the head the round should review;
 * otherwise → "refused" with the not-started reply verbatim — the caller
 * releases the workspace and sends it, burning no model turn. A
 * malformed/absent sha on either side proves nothing → "unverified" (the
 * round proceeds exactly as before).
 */
export async function guardAttachedHead(input: {
  pr: { repo: string; number: number };
  /** The PR head resolved for the round (`RepoContext.headSha`). */
  expectedHeadSha: string | undefined;
  /** What the resident answered at attach: the worktree's sha and ref. */
  attached: { sha: string | undefined; ref: string | undefined };
  /** Named in the refusal when the attach answered no ref. */
  fallbackRef: string | undefined;
  fetchPrHead: FetchPrHead;
  logKey: string;
}): Promise<AttachHeadGuard> {
  const expected = normalizeHead(input.expectedHeadSha);
  const attached = normalizeHead(input.attached.sha);
  if (expected && attached && sameCommit(expected, attached)) return { outcome: "verified" };
  if (expected && attached) {
    const where = `${input.pr.repo}#${input.pr.number}`;
    const current = normalizeHead(await input.fetchPrHead(input.pr).catch(() => undefined));
    if (current && sameCommit(attached, current)) {
      console.log(
        `[review] ${input.logKey} PR head moved since resolution: ${expected.slice(0, 7)} → ${current.slice(0, 7)}; the worktree is attached at the current head — reviewing it (${where})`,
      );
      return { outcome: "adopted", headSha: current };
    }
    console.log(
      `[review] ${input.logKey} not started: worktree attached at ${attached.slice(0, 7)}, PR head ${expected.slice(0, 7)} (${where})`,
    );
    return {
      outcome: "refused",
      reply:
        `🔀 Review of ${where} not started: the resident attached \`${input.attached.ref ?? input.fallbackRef ?? "the branch"}\` at \`${attached.slice(0, 7)}\`, ` +
        `but the PR head is \`${expected.slice(0, 7)}\` — the branch moved while the worktree was being attached (a push or force-push). Re-send the request to review the new head.`,
    };
  }
  return { outcome: "unverified" };
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
  /** Set for a PR review round: the REVIEW TARGET block's coordinates. */
  prTarget: { repo: string; pr: number; ref: string | undefined; baseRef: string | undefined } | undefined;
  /** Pre-built advisory/context blocks; absent blocks leave the prompt untouched.
   *  `about` is the self-description (routing-and-config behavior 11), right
   *  after the config block — the same category of fact-about-yourself. */
  blocks: {
    memory: string | undefined;
    config: string | undefined;
    about?: string | undefined;
    instructions: string | undefined;
    skills: string | undefined;
    mcp?: string | undefined;
  };
}): (head: HeadPin) => string {
  const { agent, resident, workspace, prTarget, blocks } = input;
  const residentSystem =
    resident && agent.residentSystem
      ? `${agent.residentSystem}\n\nTarget repository: ${input.repo}. ` +
        (workspace
          ? `Your shell starts in the worktree \`${workspace}\` on every bash call; it is already on this thread's bound branch (confirm with \`git branch --show-current\` from there — no \`cd\`).`
          : "The worktree is already on this thread's bound branch (confirm with `git branch --show-current`).")
      : undefined;
  const targetBlock = (head: HeadPin): string | undefined =>
    prTarget
      ? reviewTargetBlock({
          repo: prTarget.repo,
          pr: prTarget.pr,
          ref: prTarget.ref,
          headSha: head.sha,
          baseRef: prTarget.baseRef,
          resident,
          ...(workspace ? { workspace } : {}),
          ...(head.verified ? { verifiedAtAttach: true } : {}),
        })
      : undefined;
  const agentSystem = (head: HeadPin): string | undefined => {
    const target = targetBlock(head);
    const baseSystem = target ? `${residentSystem ?? agent.system}\n\n${target}` : residentSystem;
    // Tool guidance trails the agent's own instructions: skills, then the
    // external MCP servers (features/mcp-tools.md item 9) — both are about the
    // agent's tools, not advisory context like the memory block up front.
    const trailing = [blocks.skills, blocks.mcp].filter((b): b is string => Boolean(b));
    return trailing.length > 0 ? [baseSystem ?? agent.system, ...trailing].join("\n\n") : baseSystem;
  };
  return (head) =>
    [blocks.memory, blocks.config, blocks.about, blocks.instructions, agentSystem(head) ?? agent.system]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
}

// ---- reviewed-head settle: probe + head-move void + single re-review --------
// (agent-review.md items 8 + 12)

/** Everything one more model turn needs, grouped: the round's agent and model
 *  coordinates plus the run wiring the first turn already used. The settle
 *  reuses `toolContext` for its re-review turn with its own verdict capture
 *  (the voided verdict must not leak back through the first turn's hook). */
export interface ReviewTurnSpec {
  /** Where the re-review's commands execute (features/tracing.md). */
  backend?: Backend;
  provider: Provider;
  model: string;
  agent: AgentDef;
  effort?: Effort;
  toolContext: ToolContext;
  /** This run's per-run tools (bridged MCP tools) — the re-review turn must
   *  see exactly what the first turn saw (features/mcp-tools.md item 12). */
  extraTools?: RunnableTool[];
  onProgress: (note: string) => void;
  onEvent: (event: RunEvent) => void;
  control: RunControl;
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
 *     voids the verdict and re-reviews at the new head — worktree moved,
 *     prompt recomposed via `composeSystem`, ONE more model turn (`messages`
 *     is appended in place) — before returning. Unclassifiable → item 10
 *     (the post gate pins to the reviewed head; the note follows the post).
 *     Once: a head that moves again after the re-review is item 10's problem,
 *     never a third turn.
 *   reviewed ≠ both → returned as-is; the post gate refuses (item 8).
 *
 * The caller decides whether to invoke this at all (a hard-stopped round
 * observes nothing and posts nothing).
 */
export async function settleReviewedHead(input: SettleReviewedHeadInput): Promise<SettledReviewHead> {
  // The whole settle is one uncounted `run.settle_reviewed_head` span
  // (features/tracing.md): its git and GitHub awaits are overhead by design,
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
  composeSystem: (head: HeadPin) => string;
  executor: Executor;
  turn: ReviewTurnSpec;
  fetchPrHead: FetchPrHead;
  fetchPrCommits: FetchPrCommits;
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
  // under `run.settle_reviewed_head` (features/tracing.md item 17).
  const trace = span ? { span } : undefined;
  const probeHead = async () => parseRevParseOutput(await executor.exec("git rev-parse HEAD", trace).catch(() => ""));
  let answer = input.answer;
  let verdict = input.verdict;
  let reviewHead = input.reviewHead;
  let carried: { reviewed: string; current: string; commits: number } | undefined;
  let observedHead = await probeHead();
  const where = `${pr.repo}#${pr.number}`;
  const currentHead = async () => normalizeHead(await input.fetchPrHead(pr).catch(() => undefined));
  const expected = normalizeHead(reviewHead);
  const reviewed = normalizeHead(observedHead) ?? normalizeHead(verdict?.head);
  if (expected && reviewed) {
    const current = await currentHead();
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
      const move = classified?.move;
      if (move?.kind === "rebase") {
        console.log(
          `[review] ${logKey} head moved during run: ${expected.slice(0, 7)} → ${current.slice(0, 7)} — rebase of the same ${move.commits} commit(s); review carried to ${current.slice(0, 7)} (${where})`,
        );
        carried = { reviewed: expected, current, commits: move.commits };
      } else if (classified && move?.kind === "substantive") {
        const summary = `head moved ${expected.slice(0, 7)} → ${current.slice(0, 7)} — re-reviewing at ${current.slice(0, 7)}`;
        console.log(`[review] ${logKey} ${summary} (${where})`);
        turn.onEvent({ type: "run_note", kind: "head_moved", summary, at: systemClock() });
        input.notify.headMoved(`head moved → ${current.slice(0, 7)}`);
        await input.notify.reply(headRereviewNote({ where, reviewed: expected, current, move })).catch(() => {});
        // Resident: move the worktree ourselves (one re-attach at the new
        // head). Anything else — no moveTo, a refusal, a tip that moved
        // again under the re-attach — leaves the model to check it out.
        let worktreeMoved = false;
        if (executor.moveTo) {
          try {
            const at = normalizeHead((await executor.moveTo(current, trace)).sha);
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
        verdict = undefined; // the earlier verdict is void; the re-review must submit its own
        reviewHead = current;
        const system = input.composeSystem({ sha: current, verified: worktreeMoved });
        input.messages.push(
          { role: "assistant", content: [{ type: "text", text: answer }] },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: rereviewFollowUp({
                  where,
                  reviewed: expected,
                  current,
                  move,
                  before: classified.before,
                  after: classified.after,
                  worktreeMoved,
                }),
              },
            ],
          },
        );
        answer = await runAgent({
          provider: turn.provider,
          model: turn.model,
          agent: turn.agent,
          messages: input.messages,
          system,
          effort: turn.effort,
          ...(span ? { span } : {}),
          ...(turn.backend ? { backend: turn.backend } : {}),
          toolContext: {
            ...turn.toolContext,
            onVerdict: (v) => {
              verdict = v;
            },
          },
          ...(turn.extraTools && turn.extraTools.length > 0 ? { extraTools: turn.extraTools } : {}),
          onProgress: turn.onProgress,
          onEvent: turn.onEvent,
          control: turn.control,
        });
        // Re-read, not narrowed: the stop may have been requested during the turn.
        if (!turn.control.hardSignal.aborted) observedHead = await probeHead();
      }
    }
  }
  return { answer, verdict, reviewHead, observedHead, carried };
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

// ---- reviewed-head post gate + review post (issue #69, item 8) --------------

/** How the post step ended: `posted: true` only when the GitHub post call
 *  succeeded; every skip, guard refusal, and failure is `posted: false` with
 *  the reason (already said in the thread where the contract wants it said).
 *  The plain dispatch path may ignore the value — its behavior is unchanged —
 *  while ship's merge-ready gate consumes it: an approve whose LGTM never
 *  landed on the PR must not be reported merge-ready. */
export type ReviewPostOutcome = { posted: true } | { posted: false; reason: string };

/**
 * The deterministic review post-step: a round on the review agent against a
 * resolved PR posts its verdict back to that PR by default — unless the
 * request opted out, the round was hard-stopped (no findings, only the abort
 * line), or the reviewed-head guard refuses (fail-closed: the commit the
 * round actually reviewed must BE the pinned head — the #182 shape). Every
 * skip and failure is said out loud through `reply` (best-effort, never a
 * failed run): the Slack-only notes, the carried-forward note, and the
 * head-moved-after-post note (one best-effort GET; unknown → no note, never a
 * false alarm). Safe to call at any lifecycle position — it touches only its
 * inputs, so the plain dispatch path keeps calling it AFTER workspace release
 * and registry finish, while a ship round may invoke it inside its loop.
 * Never throws; the returned `ReviewPostOutcome` says whether a post landed.
 */
export async function runReviewPostStep(input: {
  agent: AgentDef;
  requestText: string;
  repoCtx: Pick<RepoContext, "repo" | "pr" | "prUnpostable">;
  /** The pinned head and the workspace HEAD observed after the turn. */
  heads: { reviewHead: string | undefined; observedHead: string | undefined };
  verdict: ReviewVerdict | undefined;
  answer: string;
  carried: { reviewed: string; current: string; commits: number } | undefined;
  hardStopped: boolean;
  /** The GitHub post; the dispatcher passes `deps.postReviewComment ?? postReviewComment`. */
  post: (target: ReviewCommentTarget, body: string) => Promise<void>;
  fetchPrHead: FetchPrHead;
  reply: (text: string) => Promise<void>;
  logKey: string;
}): Promise<ReviewPostOutcome> {
  const { agent, repoCtx, verdict, carried, logKey } = input;
  const { reviewHead, observedHead } = input.heads;
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
    // fallback; unknown either way → no post (fail-closed). Found live on
    // PR #182 (2026-08-29): the agent reviewed another PR's branch and its
    // LGTM was posted — and auto-approved — on the wrong PR.
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
    const body = carried
      ? `${buildReviewPostBody(input.answer, verdict)}\n\n${carriedFooter(carried)}`
      : buildReviewPostBody(input.answer, verdict);
    const where = `${postTarget.repo}#${postTarget.number}`;
    try {
      await input.post(target, body);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[review-post] ${logKey} failed for ${where}: ${reason}`);
      await input.reply(`ℹ️ Review not posted to ${where}: ${reason} — this verdict is Slack-only.`).catch(() => {});
      return { posted: false, reason };
    }
    console.log(
      `[review-post] ${logKey} → ${where} (${verdict?.verdict ?? "no verdict"})${carried ? ` carried ${carried.reviewed.slice(0, 7)} → ${pinned.slice(0, 7)}` : ""}`,
    );
    if (carried) await input.reply(headCarriedNote({ where, ...carried })).catch(() => {});
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
    return { posted: true };
  }
  return { posted: false, reason: skipReason };
}
