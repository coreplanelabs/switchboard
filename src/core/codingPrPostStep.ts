// The coding run's deterministic PR post-step (docs/reference/specs/pr-description.md
// item 5, agent-coding.md item 2), extracted from dispatch() as callable
// units so a ship round can run them for its coding and
// fix rounds without being the dispatch's top-level agent. Two phases with an
// explicit seam between them, because the dispatcher publishes the accepted
// `pr_description` event in between and a hard stop can land mid-observation:
//
//   1. `observeCodingWorkspace` — read the workspace's head branch, its tip,
//      the remote's head for that branch (and, when asked, origin remote)
//      BEFORE the workspace can be released.
//   2. `runCodingPrPostStep` — given that observation and the run's submitted
//      `PrDescription`, render the body at the observed head and open or edit
//      the PR (open-or-edit idempotency lives in githubPulls), publishing the
//      typed `pr_opened` event and returning the honest reply note.
//
// The head branch is the branch the run's own `git push` named — read off the
// run's bash calls + results as they stream by (`trackPushedBranch`: only a `git
// push` command's own result is read, `pushedBranchOf` parses git's `To <url>` +
// per-ref status block) — and the checked-out branch only when no push was
// observed. The checkout is NOT the record of what was pushed: anything that
// moves HEAD between the push and the post (a second run's `git
// checkout -b` in a shared sandbox; equally the agent itself checking out
// another branch after pushing) would make the post ask the remote for a
// branch nobody pushed and orphan the pushed work. When the two differ, the
// pushed branch's LOCAL tip (`refs/heads/<branch>`) is the head the body
// renders at — never HEAD, which is another branch's commit.
//
// "Pushed" is OBSERVED, never inferred: the branch counts as pushed only when
// the remote's own `refs/heads/<branch>` (git ls-remote) is that observed tip.
// The clone's tracking state (`@{u}`) is NOT the proof — a `--depth` /
// `--single-branch` clone, the cold sandbox's usual shape, never creates the
// remote-tracking ref for a pushed branch, so `@{u}` fails after a successful
// `git push -u` (a real push reported as "no pushed upstream", no PR
// opened). `@{u}` is consulted only when the remote probe itself fails.
// Failure honesty throughout: never a fabricated PR URL, and the branch
// compare URL is offered only when the remote match proved the branch exists.
// A proven push with NO description first asks GitHub whether the branch
// already heads an open PR (a follow-up on an existing PR repushes that PR's
// own branch): if so the note names that PR as updated by the push and the
// record gets `pr_opened` with `created: false`; only a branch with no open
// PR gets the compare URL and "open manually". A description from a workspace
// sitting on the base is refused ("the branch is the base") — unless the
// thread's own pull request is known (`CodingPrTarget.ownPr` — open, or merged
// or closed since): the run pushed nothing, so the description is for that PR,
// edited by number and rendered at its own head; a push of a closed one's own
// head branch past its head is new work, said so with the compare URL, never
// an edit of the old body. Only that branch can be "pushed past" it: a tree on
// the base at origin's tip reads like a pushed branch (`head === remoteHead`)
// but is a checkout — the thread returned to the default once the pull
// request's branch was gone — and edits the closed pull request like any run
// that pushed nothing; a tree on some other branch describes that branch, not
// the closed body, and takes the ordinary open-or-edit path.
//
// Base resolution (CodingPrTarget): the base the caller already knows — a
// bound PR's true base, else the base a coordinator's spawn put on its child's
// tag — else the resident binding ref, else the dispatch's resolved ref, else
// — the true last resort — the repo's own default branch fetched from GitHub
// (resolveBaseRefLazy, githubPulls.ts). That fetch closes a real gap: a bare
// issue-link coding run has no PR/explicit ref, and when the
// resident attach ALSO fails for a reason other than needs-ref (an infra
// fault, not-onboarded, a probe outage), the fresh-sandbox fallback carries no
// binding either — all three fields undefined, no PR openable, though the run
// pushed real work. agent:ship (shipPipeline.ts) hit the identical gap and
// closed it with `fetchRepoShipInfo`'s default_branch; resolveBaseRef /
// resolveBaseRefLazy in githubPulls.ts is that ONE mechanism, shared by both
// callers instead of two copies of "ask GitHub when nothing else names a
// base".

import { shellQuote } from "../execution/shellQuote.js";
import { shows, type Verbosity } from "./verbosity.js";
import {
  resolveBaseRef,
  resolveBaseRefLazy,
  type OpenedPullRequest,
  type OpenPrRef,
  type PullRequestTarget,
  type RepoShipInfo,
} from "../execution/githubPulls.js";
import {
  encodeGithubPathSegments,
  renderPrDescriptionMarkdown,
  type PrDescription,
  type RequestedBy,
} from "./prDescription.js";
import { EMPTY_START_STATE, type BranchStartState, type RewriteResult } from "../execution/identityRewrite.js";
import { submittedPrDescriptionArtifact } from "./reviewDescription.js";
import { normalizeHead, parseRevParseOutput, sameCommit } from "./reviewedHead.js";
import { parseExitPrefix, type RunEvent } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import type { Span } from "./trace/types.js";
import type { ExecTraceOptions } from "../execution/executor.js";
import { leftBehindSentence, type LeftBehind } from "../execution/residentCleanliness.js";

/** What the PR post-step observed in the run's workspace, all read BEFORE the
 *  workspace is released. Every field is undefined when its probe failed. */
export interface WorkspaceObservation {
  /** The tip of `branch`: HEAD when it is the checked-out branch, else the
   *  local `refs/heads/<branch>` — the commit the body renders at. */
  head: string | undefined;
  /** The PR's head branch: the branch the run's own `git push` named
   *  (`pushedBranch`), else the checked-out branch. Undefined when neither
   *  is known (a failed probe, a detached checkout with no push observed). */
  branch: string | undefined;
  /** The branch checked out when the workspace was observed. Equals `branch`
   *  unless HEAD moved to another branch after the push — then the
   *  post-step's notes name both. */
  checkedOut: string | undefined;
  /** The commit the remote holds for `branch`, read from the remote itself
   *  (`git ls-remote --exit-code origin refs/heads/<branch>`), so it does not
   *  depend on the clone's shape. Equal to `head`, it proves the branch is at
   *  the remote's tip — a push, for a branch the run could push; for the
   *  base it is only a checkout at origin's tip, and the post-step never
   *  calls that pushed. A remote that answers "no such branch" is final
   *  (undefined). Only when that probe itself fails (network, auth, an
   *  unreadable origin) does the local record of the last push,
   *  `<branch>@{u}`, stand in. */
  remoteHead: string | undefined;
  /** `owner/name` parsed from the origin remote, probed only when asked. */
  remoteRepo: string | undefined;
  /** What the run leaves that will not outlive it (docs/reference/specs/
   *  resident-repos.md item 17 — a run starts from a clean tree): the tracked
   *  files `git status --porcelain -uno` lists as changed, and the commits
   *  `git rev-list --count HEAD --not --remotes` finds on no remote branch.
   *  Absent when the probe failed (no repository here), and on an observation
   *  a caller assembled for the post-step alone. */
  uncommittedChanges?: number;
  unpushedCommits?: number;
}

/** The counts of an observation, as what the run leaves behind: nothing when
 *  either probe failed (never a guess) and nothing when both are zero. */
export function workLeftBehindOf(
  observed: Pick<WorkspaceObservation, "uncommittedChanges" | "unpushedCommits">,
): LeftBehind | undefined {
  const { uncommittedChanges, unpushedCommits } = observed;
  if (uncommittedChanges === undefined || unpushedCommits === undefined) return undefined;
  if (uncommittedChanges === 0 && unpushedCommits === 0) return undefined;
  return { uncommittedChanges, unpushedCommits };
}

/** The `work_left_behind` note's summary: what the run leaves, why it does not
 *  survive, what to do instead — the same sentence the release log carries. */
export function workLeftBehindSummary(left: LeftBehind): string {
  return leftBehindSentence(left);
}

/** The card's word for it, beside the binding line. */
export function workLeftBehindLabel(left: LeftBehind): string {
  return `${left.uncommittedChanges} uncommitted change(s) and ${left.unpushedCommits} unpushed commit(s) left behind — discarded at the run's end`;
}

/**
 * Probe a coding run's workspace — HEAD, the checked-out branch, the head
 * branch's upstream (and, when a push named a branch, that branch's local
 * tip; when the dispatch resolved no repo, the origin remote) — concurrently,
 * then the remote's head for the head branch, at the workspace root first.
 * `pushedBranch` is the branch the run's own `git push` named
 * (`trackPushedBranch` over the run's events); absent, the checked-out branch is
 * the head branch. Cold coding agents clone the repo into a SUBDIRECTORY of
 * the sandbox root (the coding prompt mandates at most ONE clone), so a
 * failed root HEAD probe discovers the single cloned repo and re-probes with
 * `git -C` — the directory shell-quoted AND vetted against a conservative
 * name pattern, never interpolated raw. The remote probe runs through the
 * same executor as the agent's own push did, so it authenticates the same
 * way (the sandbox's forwarded token via `gh auth git-credential`, the
 * resident tree's credential store). Best-effort throughout: a failed probe
 * leaves its field undefined and the post-step reports honestly.
 */
export async function observeCodingWorkspace(
  executor: { exec: (cmd: string, opts?: ExecTraceOptions) => Promise<string> },
  opts: { probeRemote: boolean; pushedBranch?: string },
  /** The step's span (`run.observe_workspace`, or the ship round): every probe's exec hangs under it (docs/reference/specs/tracing.md item 17). */
  span?: Span,
): Promise<WorkspaceObservation> {
  const trace = span ? { span } : undefined;
  const probe = (cmd: string) => executor.exec(cmd, trace).catch(() => "");
  const pushed = opts.pushedBranch;
  const probesAt = async (git: string): Promise<{ observation: WorkspaceObservation; isRepo: boolean }> => {
    const [headOut, branchOut, upstreamOut, remoteOut, tipOut, statusOut, unpushedOut] = await Promise.all([
      probe(`${git} rev-parse HEAD`),
      probe(`${git} rev-parse --abbrev-ref HEAD`),
      // The head branch's own upstream: `@{u}` reads the checkout's, which is
      // the wrong branch once HEAD moved after the push.
      probe(pushed === undefined ? `${git} rev-parse @{u}` : `${git} rev-parse ${shellQuote(`${pushed}@{u}`)}`),
      opts.probeRemote ? probe(`${git} remote get-url origin`) : Promise.resolve(""),
      pushed === undefined ? Promise.resolve("") : probe(`${git} rev-parse ${shellQuote(`refs/heads/${pushed}`)}`),
      // What the run leaves behind (item 17's clean-tree rule): tracked
      // changes only — untracked scratch is the run's own noise — and commits
      // no remote branch holds.
      probe(`${git} status --porcelain -uno`),
      probe(`${git} rev-list --count HEAD --not --remotes`),
    ]);
    const headSha = parseRevParseOutput(headOut);
    const checkedOut = parseBranchOutput(branchOut);
    const branch = pushed ?? checkedOut;
    let remoteHead: string | undefined = parseRevParseOutput(upstreamOut);
    if (branch !== undefined) {
      const remote = parseLsRemoteOutput(
        await probe(`${git} ls-remote --exit-code origin ${shellQuote(`refs/heads/${branch}`)}`),
        branch,
      );
      // The remote's answer is the truth when it gave one; only a probe that
      // failed outright leaves the local record standing.
      if (remote.kind !== "failed") remoteHead = remote.kind === "found" ? remote.sha : undefined;
    }
    return {
      observation: {
        head: pushed === undefined ? headSha : parseRevParseOutput(tipOut),
        branch,
        checkedOut,
        remoteHead,
        remoteRepo: parseOriginRemoteOutput(remoteOut),
        ...countsOf(parseStatusCount(statusOut), parseCountOutput(unpushedOut)),
      },
      isRepo: headSha !== undefined,
    };
  };
  const atRoot = await probesAt("git");
  if (atRoot.isRepo) return atRoot.observation;
  const dir = parseCloneDirOutput(await probe("ls -d */.git 2>/dev/null | head -1"));
  if (dir === undefined) return atRoot.observation; // no clone anywhere → the post-step reports honestly
  return (await probesAt(`git -C ${shellQuote(dir)}`)).observation;
}

/** Where a ship coding child's budget-end salvage may push (push-before-abort,
 *  docs/reference/specs/agent-ship.md item 8): the branch the run's own push
 *  named, else the checkout — and only when the plan's base is known and is
 *  another branch, since the base is the one branch a child never pushes to,
 *  and a branch that cannot be told from it may be it. Otherwise the salvage
 *  is skipped, and the word says why. */
export function salvageTargetOf(opts: {
  pushedBranch: string | undefined;
  checkedOut: string | undefined;
  base: string | undefined;
}): { branch: string } | { skipped: string } {
  const branch = opts.pushedBranch ?? opts.checkedOut;
  if (branch === undefined)
    return {
      skipped:
        "the budget-end salvage was skipped: the workspace's branch could not be read, so there is nowhere to push",
    };
  if (opts.base === undefined)
    return {
      skipped: `the budget-end salvage to \`${branch}\` was skipped: the plan's base is unknown, so the branch cannot be told from it`,
    };
  if (branch === opts.base)
    return {
      skipped: `the budget-end salvage was skipped: the checkout is the plan's base \`${branch}\`, which a child never pushes to`,
    };
  return { branch };
}

/** The salvage's word for a clean tree with nothing unpushed on `branch`. */
export const nothingToSalvageNote = (branch: string): string =>
  `the budget ended with nothing to salvage: the tree is clean and \`${branch}\` holds no unpushed commits`;

/** Whether the observation found work for the budget-end salvage to push:
 *  measured work — uncommitted changes or unpushed commits — wins whatever the
 *  other measure says; a tree measured clean on both has nothing; a measure the
 *  observation could not take (its probe failed, `undefined`) is never read as
 *  clean — the salvage is not attempted and the word says which measure is
 *  missing, so a note never claims a clean tree the run could not see. */
export function salvageWorkOf(
  observed: Pick<WorkspaceObservation, "uncommittedChanges" | "unpushedCommits">,
  branch: string,
): { work: true } | { work: false; summary: string } {
  if ((observed.uncommittedChanges ?? 0) > 0 || (observed.unpushedCommits ?? 0) > 0) return { work: true };
  if (observed.uncommittedChanges === undefined || observed.unpushedCommits === undefined) {
    const measure = (n: number | undefined) => (n === undefined ? "could not be measured" : String(n));
    return {
      work: false,
      summary: `the budget-end salvage to \`${branch}\` was not attempted: the workspace could not be measured (uncommitted changes: ${measure(observed.uncommittedChanges)}; unpushed commits: ${measure(observed.unpushedCommits)}) — work may sit unpushed there`,
    };
  }
  return { work: false, summary: nothingToSalvageNote(branch) };
}

/** Push-before-release (docs/reference/specs/agent-ship.md item 8): every
 *  ship coding child commits and pushes work its tree still holds to the unit
 *  branch (`salvageTargetOf` names it), so a re-issue starts from the partial
 *  work instead of zero. A clean abnormal ending gets an empty WIP marker too:
 *  its earlier ordinary push may still be unfinished, and only a final
 *  `by: "salvage"` head lets the coordinator tell; an ordinary clean completion
 *  leaves no marker and proceeds to the PR post-step. Mechanical,
 *  in the run loop after the model is done, and repeated after a final
 *  description turn so no later workspace tool can leave work behind.
 *  Best-effort: a failed step reports itself and never fails the run.
 *  The same push, worded for its cue, is the compaction checkpoint's
 *  (docs/reference/specs/harness-pi.md item 7): a compaction the provider
 *  refused for good may end the run at the context's overflow before any
 *  wind-down, so the tree is pushed the moment the failure is known. */
export async function salvageBudgetPush(
  executor: { exec: (cmd: string, opts?: ExecTraceOptions) => Promise<string> },
  opts: { branch: string; cue?: "budget" | "compaction" | "ending" | "completion" },
  span?: Span,
): Promise<{ pushed: boolean; summary: string; head?: string }> {
  const trace = span ? { span } : undefined;
  const run = (cmd: string) => executor.exec(cmd, trace);
  const probe = (cmd: string) => run(cmd).catch(() => "");
  const words =
    opts.cue === "compaction"
      ? {
          commit: "wip: committed at the compaction checkpoint — work in progress, not reviewed",
          nothing: `the compaction checkpoint found nothing to push: the tree is clean and \`${opts.branch}\` holds no unpushed commits`,
          pushedLead: "the failed compaction left work in the tree",
          failedLead: `the compaction checkpoint push to \`${opts.branch}\` failed`,
        }
      : opts.cue === "ending"
        ? {
            commit: "wip: preserve interrupted coding work — work in progress, not reviewed",
            nothing: `the coding child ended with nothing to preserve: the tree is clean and \`${opts.branch}\` holds no unpushed commits`,
            pushedLead: "the coding child ended with interrupted work",
            failedLead: `the interrupted-work push to \`${opts.branch}\` failed`,
          }
        : opts.cue === "completion"
          ? {
              commit: "wip: preserve unfinished coding work — work in progress, not reviewed",
              nothing: `the coding child ended with nothing to preserve: the tree is clean and \`${opts.branch}\` holds no unpushed commits`,
              pushedLead: "the coding child ended with unfinished work",
              failedLead: `the unfinished-work push to \`${opts.branch}\` failed`,
            }
          : {
              commit: "wip: committed at the budget wind-down — work in progress, not reviewed",
              nothing: nothingToSalvageNote(opts.branch),
              pushedLead: "the budget ended with work in the tree",
              failedLead: `the budget-end salvage push to \`${opts.branch}\` failed`,
            };
  try {
    // An ending checkpoint preserves every non-ignored workspace change,
    // including a new source or test file the child had not added yet. Git's
    // ignore rules still keep dependency caches, credentials and attachment
    // staging out. The measure is `run`, not `probe`: a failure is the salvage
    // failing, never a tree read as clean.
    const dirty = (await run("git status --porcelain")).trim() !== "";
    const endingCheckpoint = opts.cue !== "compaction" && opts.cue !== "completion";
    if (dirty) {
      await run("git add -A");
      await run(`git commit -m ${shellQuote(words.commit)}`);
    } else if (endingCheckpoint) {
      // A clean tree can still be unfinished: the child may have pushed an
      // ordinary intermediate commit before its abnormal ending. Give every
      // ending its own mechanical marker so the durable fold records the last
      // head as salvage and the coordinator never reviews that work as final.
      await run(`git commit --allow-empty -m ${shellQuote(words.commit)}`);
    }
    const unpushed = parseCountOutput(await run("git rev-list --count HEAD --not --remotes")) ?? 0;
    if (!dirty && !endingCheckpoint && unpushed === 0) return { pushed: false, summary: words.nothing };
    await run(`git push origin ${shellQuote(`HEAD:refs/heads/${opts.branch}`)}`);
    const head = parseRevParseOutput(await probe("git rev-parse HEAD"));
    return {
      pushed: true,
      ...(head !== undefined ? { head } : {}),
      summary: `${words.pushedLead} — ${
        dirty
          ? "committed the uncommitted work and pushed"
          : endingCheckpoint
            ? "created a WIP checkpoint commit and pushed"
            : "pushed the unpushed commits"
      } to \`${opts.branch}\`${head !== undefined ? ` (${head.slice(0, 7)})` : ""}`,
    };
  } catch (err) {
    return {
      pushed: false,
      summary: `${words.failedLead}: ${err instanceof Error ? err.message : String(err)} — partial work may sit unpushed in the workspace`,
    };
  }
}

// git's per-ref push status line — `" %c %-*s %-*s -> %s"` in git's own format:
// a flag (` ` fast-forward, `+` forced, `-` deleted, `*` new ref, `!`
// rejected, `=` up to date), the summary (`[new branch]`, `[up to date]`,
// `old..new`, `old...new`, `[rejected]`, …), then `<from> -> <to>` and an
// optional `(reason)`. The flag is optional here: the fast-forward flag is a
// space, and the output cap trims the first line's leading whitespace.
const PUSH_STATUS_LINE_RE =
  /^\s*(?:[+*=!-]\s+)?(\[[a-z ]+\]|[0-9a-f]{4,40}\.{2,3}[0-9a-f]{4,40})\s+(\S+)\s+->\s+(\S+)(?:\s+\(.*\))?\s*$/i;
/** A deletion's status line has no `->` side: ` - [deleted]         old`. It
 *  names no branch, but it IS part of the block — a mixed push (`git push
 *  origin :old new`) prints it beside the update line, which must still count. */
const PUSH_DELETION_LINE_RE = /^\s*-\s+\[deleted\]\s+\S+\s*$/i;
/** The summaries that mean the remote branch now exists at the pushed commit. */
const PUSHED_SUMMARY_RE = /^(?:\[new branch\]|\[up to date\]|[0-9a-f]+\.{2,3}[0-9a-f]+)$/i;
/** The `To <url>` header git prints above a push's status block (`From` heads a
 *  fetch's identical-looking block, whose `->` side is a remote-tracking ref). */
const PUSH_HEADER_RE = /^To\s+\S+$/;

/**
 * The remote branch a run's own `git push` landed on, or undefined when the
 * event is not a bash result carrying one — the `To <url>` header followed by
 * per-ref status lines; the block ends at the first line that is not one, so
 * a chained command's later output cannot add a branch. Rejections
 * (`[rejected]`, `[remote rejected]`), deletions and tags name no branch, and
 * `git fetch`'s look-alike block sits under `From`, never `To`. The last
 * status line of the last block wins: a run that pushed twice opens its PR
 * from the branch it pushed last. This reads one result's OUTPUT only —
 * `trackPushedBranch` is what pairs it with the command that produced it and
 * keeps the latest answer across a run's events.
 */
export function pushedBranchOf(event: RunEvent): string | undefined {
  const updates = pushedRefUpdatesOf(event);
  return updates.length > 0 ? updates[updates.length - 1].branch : undefined;
}

/** Where the run's own first push found a branch: `created` when the status
 *  line read `[new branch]` (nothing on the remote below the run's commits),
 *  `before` when it read `old..new` / `old...new` — `sha` the remote's head
 *  before the push, possibly abbreviated — the point the identity rewrite
 *  never rewrites below (record 0062). */
export type PushedStartPoint = { kind: "created" } | { kind: "before"; sha: string };

/** A push status block's ref updates in order: the branch each status line
 *  landed on, with the summary that said so. The parse `pushedBranchOf`
 *  documents, kept in one place for it and `trackPushedBranch`. */
function pushedRefUpdatesOf(event: RunEvent): Array<{ branch: string; summary: string }> {
  if (event.type !== "tool_result" || event.tool !== "bash" || event.output === undefined) return [];
  const updates: Array<{ branch: string; summary: string }> = [];
  let inBlock = false;
  for (const raw of event.output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (PUSH_HEADER_RE.test(line.trim())) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (PUSH_DELETION_LINE_RE.test(line)) continue; // part of the block, names nothing
    const m = PUSH_STATUS_LINE_RE.exec(line);
    if (!m) {
      inBlock = false;
      continue;
    }
    if (PUSHED_SUMMARY_RE.test(m[1])) updates.push({ branch: m[3], summary: m[1] });
  }
  return updates;
}

/** The start point a status summary names, or null when it names none: an
 *  `[up to date]` first push moved nothing and says nothing about who put
 *  the tip there, so the branch's pre-push head stays unknown. */
function startPointOfSummary(summary: string): PushedStartPoint | null {
  if (/^\[new branch\]$/i.test(summary)) return { kind: "created" };
  const m = /^([0-9a-f]{4,40})\.{2,3}[0-9a-f]{4,40}$/i.exec(summary);
  return m ? { kind: "before", sha: m[1].toLowerCase() } : null;
}

/** A bash `tool_call` summary (`$ <command>`, redacted and capped) whose command
 *  invokes `git … push`: `git` in command position — the start of the command
 *  or of a shell segment (`;`, `&&`, `|`, `(`, a new line) — with `push` in
 *  the same segment and no quote between them. `git push -u origin x`,
 *  `cd api && git push`, `git -C api push` count; `grep 'git push'`,
 *  `echo "git push"` do not (a `VAR=1 git push` prefix is missed: a false
 *  negative only falls back to the checkout). */
const PUSH_COMMAND_RE = /(?:^\$?|[\n;&|(])\s*git\b[^\n;&|'"]*\bpush\b/;

/**
 * The branch a run's own `git push` named, tracked across the run's events:
 * feed every event to `observe`, read `branch()` when the run is done. A
 * push block counts only when it is the OUTPUT of a bash call whose COMMAND
 * invoked `git push` — the `tool_call`/`tool_result` pair is matched by
 * `callId` — so a command that merely reproduces a push block (an `echo`, a
 * `cat` of a transcript, a test that prints one) names nothing. The latest
 * push wins; a later non-push result never erases it. Even a candidate that
 * slipped through is never a fact: the post-step still requires the remote's
 * own `refs/heads/<branch>` to equal that branch's observed local tip, so a
 * phantom degrades to the honest "not found on the remote" note.
 */
export function trackPushedBranch(initial?: string): {
  observe(event: RunEvent): void;
  branch(): string | undefined;
  /** Where the run's own FIRST push found `branch()`: `created`, `before`
   *  with the remote's pre-push head, or undefined when no push of the run's
   *  said (the restored `initial`, an up-to-date first push) — the identity
   *  rewrite then has no boundary and fails closed for a branch other than
   *  the one whose start state was recorded at attach (record 0062). */
  startPoint(): PushedStartPoint | undefined;
} {
  // callIds of in-flight bash calls whose command invokes git push; entries
  // leave on their result, so the set never outgrows one turn's tool calls.
  const pushCalls = new Set<string>();
  // `initial`: the branch a resumed run had already pushed before the restart
  // (docs/reference/specs/run-history.md item 38), restored from the ledger row's state.
  let branch: string | undefined = initial;
  // Per branch, where the run's FIRST push found it — null when that push's
  // summary named no start (`[up to date]`), kept so a later `old..new` push
  // of the same branch never masquerades as the first.
  const firstPush = new Map<string, PushedStartPoint | null>();
  return {
    observe(event) {
      if (event.type === "tool_call") {
        // The full command when the event carries it (runner ≥ this fix); the
        // 200-char summary otherwise (older records) — where a chained command's
        // push past the cap is a known false negative (falls back to the checkout).
        if (event.tool === "bash" && event.callId !== undefined && PUSH_COMMAND_RE.test(event.command ?? event.summary))
          pushCalls.add(event.callId);
        return;
      }
      if (event.type !== "tool_result" || event.tool !== "bash" || event.callId === undefined) return;
      const fromPush = pushCalls.delete(event.callId);
      if (!fromPush) return;
      const updates = pushedRefUpdatesOf(event);
      for (const update of updates)
        if (!firstPush.has(update.branch)) firstPush.set(update.branch, startPointOfSummary(update.summary));
      if (updates.length > 0) branch = updates[updates.length - 1].branch;
    },
    branch: () => branch,
    startPoint: () => (branch !== undefined ? (firstPush.get(branch) ?? undefined) : undefined),
  };
}

/** Where the post-step's PR would open: the dispatch's resolved slug and refs.
 *  `repo` may be undefined (an agent-discovered repo — the observation's
 *  origin remote is the repo of last resort); the base is the one the caller
 *  already knows (`baseRef`: the PR's true base ref when the thread's context
 *  came from a PR, else the base a coordinator's spawn put on its child's
 *  tag), else the thread's resident binding ref, else the dispatch's
 *  resolved ref, else — when a description was actually submitted — the
 *  repo's own default branch fetched from GitHub (resolveBaseRefLazy,
 *  githubPulls.ts; the true base of last resort, shared with agent:ship's own
 *  resolution in shipPipeline.ts). None of these three fields alone is
 *  reliable: a resident attach that fails for a reason OTHER than needs-ref
 *  (an infra fault, not-onboarded, a probe outage) drops `bindingRef` with no
 *  equivalent fallback of its own — which is exactly the case the GitHub
 *  fetch closes. */
export interface CodingPrTarget {
  /** `owner/name` the dispatch resolved, or undefined (agent-discovered repo). */
  repo: string | undefined;
  /** The base the caller knows outright: the bound PR's true base ref (a fix
   *  round repushes the PR's OWN head branch, so the binding ref equals the
   *  branch and is NOT the merge base), else a coordinator child's plan base
   *  (the child is dispatched AT its unit branch, so its binding ref is the
   *  branch itself — `CoordinatorTag.base`). */
  baseRef: string | undefined;
  /** The thread's resident binding ref, when the round ran on a resident. */
  bindingRef: string | undefined;
  /** The dispatch's resolved ref — the base of last resort before a GitHub fetch. */
  resolvedRef: string | undefined;
  /** The pull request the thread's OWN run opened, inherited off the run
   *  record (`RepoContext.prFromRecord` / `closedRecordPr`, `recordPrOf` in
   *  repoContext.ts), with its head commit as the resolver fetched it, its
   *  head branch when the resolver learned it, and whether it is still open.
   *  Where a description resubmitted by a run that pushed nothing lands — the
   *  workspace on the base, the binding still the repo default, or the thread
   *  bound to the pull request's own head branch — instead of the base-branch
   *  refusal. A `merged` or `closed` one takes no more pushes, so a
   *  description for it can only edit its body, and does; a push of
   *  `headBranch` past `headSha` is new work, which needs a new pull request.
   *  Only that branch can be pushed past it: a workspace on the base, or on
   *  any other branch, holds no commit of this pull request's, whatever its
   *  head — and with `headBranch` unknown no branch is taken for it. Never a
   *  pull request a person named. */
  ownPr?: { number: number; headSha: string; headBranch?: string; state: "open" | "merged" | "closed" };
  /** The start state of the run's branch as the dispatch recorded it at
   *  attach or clone (record 0062; identityRewrite.ts): what the identity
   *  rewrite subtracts before judging the run's commits. Absent on a caller
   *  that recorded none — the rewrite then treats it as unknown. */
  startState?: BranchStartState;
  /** The branch `startState` was read for — the branch the dispatch knew at
   *  attach. A run that pushed a DIFFERENT branch is judged from where its
   *  own first push found that branch (`pushedStart`), never the recorded
   *  state and never an assumed-empty one: a branch that pre-existed on the
   *  remote carries history the run did not create. */
  startBranch?: string;
  /** Where the run's own FIRST push found the pushed branch, read off the
   *  push's own status line (`trackPushedBranch().startPoint()`): `created`
   *  — `[new branch]`, nothing was on the remote below the run's commits, so
   *  the start state is empty; `before` — the remote held the branch at
   *  `sha` (possibly abbreviated) before the push moved it, the boundary the
   *  identity rewrite never rewrites below. Absent when no push of the run's
   *  named it (an up-to-date first push, a branch restored across a restart
   *  without its push output) — a branch other than `startBranch` then has
   *  an UNKNOWN start state and the rewrite fails closed. */
  pushedStart?: PushedStartPoint;
  /** True for a coordinator's child whose plan base is unknown even after the
   *  second guard — the tag's `coordinator_tag` event lost across a roll and
   *  the coordinator store's instance record without a `base`. The child is
   *  dispatched AT its unit branch, so the binding ref is the branch itself
   *  and the repo's default branch is not the plan's base: neither may stand
   *  in, and a submitted description is refused with a `pr_not_opened` note
   *  saying the base was lost, never opened against a guessed branch. */
  planBaseLost?: boolean;
}

/**
 * The PR open/edit decision + call, from typed values only: the body rendered
 * at the observed head, the title from the validated description, the head
 * from the observed branch. Publishes the `pr_opened` event on success and
 * returns the note the round's reply should carry (undefined when there is
 * nothing to report on — e.g. no description was submitted and no push was
 * proven). Never throws: an open/edit failure is reported in the note with
 * the compare URL. `logKey` prefixes the `[pr-post]` console lines (the
 * dispatcher passes the thread key).
 */
export async function runCodingPrPostStep(input: {
  /** The request's verbosity (routing-and-config item 28): the note's link
   *  and state are for everyone; the head it was rendered at is `verbose`. */
  verbosity: Verbosity;
  observed: WorkspaceObservation;
  description: PrDescription | undefined;
  target: CodingPrTarget;
  openPullRequest: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /** The open PR whose head is the branch, or null (githubPulls.ts'
   *  findOpenPrByHead — the lookup open-or-edit itself starts with). Asked
   *  when a proven-pushed branch comes with no description — the push may
   *  have updated a PR that already exists — and when a description comes
   *  with a push the observation cannot prove (unpushed commits over a
   *  remote branch that exists, or an unobservable head): the budget
   *  wind-down ends runs exactly there, and "no PR was opened" for a branch
   *  an open PR heads would send the reader to open a duplicate. Never asked
   *  for a branch the remote said is absent (no same-repo open PR can head
   *  it). A lookup failure degrades to the "no PR was opened" note (logged,
   *  never thrown). */
  findOpenPr: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  /** Edit a pull request the caller knows by number (githubPulls.ts'
   *  updatePullRequest). Asked when a description arrives from a workspace
   *  sitting on the base — or on the pull request's own head branch once it
   *  is merged or closed, with nothing pushed past its head — while the
   *  thread's own pull request is known (`target.ownPr`): the run pushed
   *  nothing for it, and the description is for that pull request. Also asked
   *  when a description comes with an unproven push whose branch the lookup
   *  above found heading an open PR — the body rendered at THAT pull
   *  request's head. A failure is reported in the note, never thrown. */
  updatePullRequest: (repo: string, number: number, patch: { title: string; body: string }) => Promise<void>;
  /** The repo's default branch — the PR base of last resort, fetched via
   *  GitHub (githubPulls.ts' fetchRepoShipInfo; shared with agent:ship's own
   *  base resolution) ONLY when a description was submitted AND none of
   *  `target`'s three fields already name a base. Never called otherwise. */
  fetchRepoInfo: (repo: string) => Promise<RepoShipInfo | undefined>;
  /** The branch's commits over the base (githubPulls.ts' commitsOverBase).
   *  Asked ONLY when a proven-pushed branch comes with no description and no
   *  open pull request heads it — before the note offers a compare link: a
   *  branch with none has nothing to open (a unit whose scope already landed,
   *  agent-ship.md item 12), so the note says so and offers no link over an
   *  empty diff. Absent, unread or failed, the compare link stands. */
  commitsOverBase?: (repo: string, base: string, branch: string) => Promise<number | undefined>;
  /** The identity rewrite and its follow-ups (record 0062): absent,
   *  the post-step opens as before (a caller predating the rewrite, or a test
   *  of the other paths). Present, the rewrite runs before the open or edit of
   *  the pushed branch, the pull request's head is pinned to the rebuilt tip,
   *  the requester's bound login is assigned after the pre-check answers 204,
   *  independently of the body's requester attribution. */
  identity?: {
    /** rewriteRunCommits over the target's start state (identityRewrite.ts). */
    rewrite: (args: {
      repo: string;
      base: string;
      branch: string;
      startState: BranchStartState;
    }) => Promise<RewriteResult>;
    /** The pull request's `head.sha` after the open (githubPulls.pullRequestHead). */
    pullRequestHead: (repo: string, number: number) => Promise<string | undefined>;
    /** GET /assignees/<login>: true on 204, false on 404 (githubPulls.isAssignable). */
    isAssignable: (repo: string, login: string) => Promise<boolean | undefined>;
    /** POST the assignee (githubPulls.addAssignee); a failure is logged, never thrown. */
    addAssignee: (repo: string, number: number, login: string) => Promise<void>;
    /** Verified binding for assignment only; display names confer no authority. */
    requestedLogin?: string;
  };
  /** Request provenance is available even without a GitHub binding. */
  requestedBy?: RequestedBy;
  /** True when the dispatcher already ran the description turn
   *  (descriptionTurn.ts) for this push and it still submitted nothing — the
   *  warning then says so, so the reader knows the system asked and the model
   *  declined, rather than that nothing tried. */
  descriptionTurnRan?: boolean;
  /** Publish hook into the run's event stream (the registry). */
  publish: (event: RunEvent) => void;
  logKey: string;
}): Promise<string | undefined> {
  const { observed, description: prDescription, target, logKey } = input;
  const repo = target.repo ?? observed.remoteRepo;
  const headSha = normalizeHead(observed.head);
  const branch = observed.branch;
  const remoteHead = normalizeHead(observed.remoteHead);
  const pushed = headSha !== undefined && remoteHead !== undefined && sameCommit(remoteHead, headSha);
  const compareUrl =
    repo && branch && pushed ? `https://github.com/${repo}/compare/${encodeGithubPathSegments(branch)}` : undefined;
  // HEAD moved after the push: the head branch is the one the run's
  // push named, the checkout another. Every note and log line about the
  // branch names both, so a reader can tell which branch was asked about.
  const moved = branch !== undefined && observed.checkedOut !== undefined && observed.checkedOut !== branch;
  const branchNote = moved
    ? ` (the branch the run's push named; the workspace was checked out on \`${observed.checkedOut}\`)`
    : "";
  const branchLog = moved ? `${branch} (pushed; checkout on ${observed.checkedOut})` : (branch ?? "unknown");
  if (repo === undefined) {
    // Neither the dispatch nor the workspace names a repository — nowhere a
    // PR could be opened. Said plainly when a description was submitted;
    // otherwise there is nothing to report on.
    if (prDescription) {
      console.log(
        `[pr-post] ${logKey} skipped: no repo resolvable (none at dispatch, no GitHub origin remote observed; branch ${branchLog})`,
      );
      return `⚠️ A PR description was submitted but no repository is known for this thread (none resolved at dispatch, and no GitHub origin remote was observed in the workspace), so no PR was opened.`;
    }
    return undefined;
  }
  if (target.planBaseLost) {
    // A coordinator's child whose plan base survived nowhere (CodingPrTarget's
    // `planBaseLost`): no branch here is the plan's base, so nothing is opened
    // and nothing stands in — said as a typed note when a description was
    // submitted, so a plan runner's `pr-check` sees why no pull request
    // followed; silence otherwise, as for every round with nothing to report.
    if (prDescription) {
      console.log(
        `[pr-post] ${logKey} skipped: the plan's base was lost across a roll (repo ${repo}, branch ${branchLog}) — no PR opened`,
      );
      input.publish({
        type: "run_note",
        kind: "pr_not_opened",
        summary: "no PR opened: the plan's base was lost across a roll",
        at: systemClock(),
      });
      return `⚠️ A PR description was submitted but the plan's base was lost across a roll, so no PR was opened${compareUrl ? ` — compare & open manually: ${compareUrl}` : "."}`;
    }
    return undefined;
  }
  // Base resolution (CodingPrTarget's doc comment): the GitHub fetch is the
  // true last resort, tried ONLY when a description was submitted — every
  // branch below that skips silently or reports without opening a PR never
  // needed a base in the first place, so a repo with no PR/resident/explicit
  // ref never pays for a network call it won't use.
  const candidates = [target.baseRef, target.bindingRef, target.resolvedRef];
  const base = prDescription
    ? await resolveBaseRefLazy(candidates, repo, input.fetchRepoInfo)
    : resolveBaseRef(candidates, undefined);
  // `pushed` above is the BRANCH's state, not the run's act: the remote holds
  // the branch at the observed head, which a checkout at the remote's tip
  // reads exactly like a push — a resident tree provisioned on the default
  // sits at origin's tip before the run types a thing. So "pushed" is said
  // only of a branch the run could have pushed: one other than the base
  // (`pushedBranch` — the gate's `protectedBranches`, src/core/harness/pi/
  // toolRules.ts, refuse a run's push to the base its pull request would
  // target and to the repository's default), or the thread's own pull
  // request's head branch (`pushedPastOwnPr`), never the base by the base's
  // name. Telling a run's push from a checkout for certain would take a
  // record of the remote before the run; nothing observes one today.
  const pushedBranch = branch !== undefined && branch !== base && pushed;
  // The pushed head is a fact of the run before anything a pull request adds
  // (run-history item 2; decision 0046): the branch the run pushed and the sha
  // the remote holds — never a checkout sitting at the base's own tip —
  // published whether or not a description or a pull request follows.
  if (pushedBranch && branch !== undefined && headSha !== undefined) {
    // The `clean` fact (record 0064): no uncommitted or unpushed work at the
    // push, from the same observation — absent when either measure is missing.
    const clean =
      observed.uncommittedChanges !== undefined && observed.unpushedCommits !== undefined
        ? observed.uncommittedChanges === 0 && observed.unpushedCommits === 0
        : undefined;
    input.publish({
      type: "pushed_head",
      ref: branch,
      sha: headSha,
      by: "push",
      ...(clean !== undefined ? { clean } : {}),
      at: systemClock(),
    });
  }
  const ownPr = target.ownPr;
  // Every open and edit renders the same request provenance.
  const requestedBy = input.requestedBy;
  // The workspace branch IS the thread's own pull request's head branch, as
  // GitHub named it. A workspace on the base — the thread returned to the
  // default once that branch was gone (resident-repos.md item 16's second
  // movement) — or on any other branch is not, whatever commit it sits at;
  // and a pull request whose head branch the resolver never learned has no
  // branch to be pushed past.
  const onOwnPrBranch = ownPr?.headBranch !== undefined && branch === ownPr.headBranch;
  // That branch's head when the remote holds it at a commit other than the
  // pull request's own: new work, beyond what that pull request describes.
  const pushedPastOwnPr =
    ownPr !== undefined && onOwnPrBranch && pushed && headSha !== undefined && !sameCommit(headSha, ownPr.headSha)
      ? headSha
      : undefined;
  if (
    prDescription &&
    ownPr !== undefined &&
    ownPr.state !== "open" &&
    pushedPastOwnPr !== undefined &&
    branch !== undefined
  ) {
    // The thread's own pull request is merged or closed and the run pushed
    // its head branch past that pull request's head: the commits are new work,
    // and a closed pull request takes none — a new one is needed, from a base
    // the workspace cannot name (the binding sits on the old head branch, the
    // resolver binds nothing to a closed pull request). Said plainly, with the
    // compare URL, never as an edit of the old body at its old head.
    const url = `https://github.com/${repo}/pull/${ownPr.number}`;
    console.log(
      `[pr-post] ${logKey} skipped: ${branchLog} was pushed past the thread's ${ownPr.state} ${repo}#${ownPr.number} (its head ${ownPr.headSha.slice(0, 7)}, the workspace at ${pushedPastOwnPr.slice(0, 7)}) — a new PR is needed`,
    );
    input.publish({
      type: "run_note",
      kind: "pr_not_opened",
      summary: `no PR opened: ${branch} was pushed past the thread's ${ownPr.state} pull request #${ownPr.number}; the new commits need a new pull request`,
      at: systemClock(),
    });
    return `⚠️ A PR description was submitted and \`${branch}\`${branchNote} was pushed to \`${pushedPastOwnPr.slice(0, 7)}\`, but this thread's pull request ${url} is ${ownPr.state} and that branch is its head — the new commits need a new pull request, so nothing was edited: compare & open manually: ${compareUrl}`;
  }
  if (prDescription && ownPr !== undefined && (branch === base || (ownPr.state !== "open" && onOwnPrBranch))) {
    // The description is for the thread's own pull request, edited by number
    // with the body rendered at its head as the resolver fetched it — never at
    // the tip the workspace shows, which is not the pull request's code.
    // Either the workspace sits on the base and the run pushed nothing (a
    // push the run made would have named its branch, and the base is not a
    // branch the gate lets it push) — the binding still the repo default, or
    // returned to it once the pull request's branch was gone, or moved onto
    // the pull request's own head branch, which a base resolved off it then
    // equals — or the pull request is merged or closed since and the workspace
    // is on its head branch with nothing pushed past its head: it takes no
    // more pushes, its body is still the record of the change, and the
    // description is for it. A closed pull request with the workspace on some
    // OTHER branch is not here: that branch's description is not this body's,
    // and it takes the ordinary path below — opened or edited from that branch
    // when the remote holds it, refused as unpushed when it does not.
    // `pr_opened` carries no `head`: nothing was pushed, so the release has no
    // branch to remember. The identity rewrite does NOT run here (agent-coding.md
    // item 2): the run pushed nothing — this path's premise — so there are no
    // run commits to judge, and a rewrite over the pull request's branch could
    // only re-author commits the run did not create.
    const { number, headSha: prHead, state } = ownPr;
    const url = `https://github.com/${repo}/pull/${number}`;
    const standing = state === "open" ? "" : ` (${state})`;
    try {
      const body = renderPrDescriptionMarkdown(prDescription, {
        repo,
        headSha: prHead,
        ...(requestedBy ? { requestedBy } : {}),
      });
      await input.updatePullRequest(repo, number, { title: prDescription.title, body });
      console.log(
        `[pr-post] ${logKey} updated ${repo}#${number} — the thread's own pull request${standing}, nothing pushed past its head (workspace on ${branchLog}; rendered at its head ${prHead.slice(0, 7)})`,
      );
      input.publish({ type: "pr_opened", url, number, created: false, at: systemClock() });
      input.publish({
        type: "review_artifact",
        ...submittedPrDescriptionArtifact(prDescription, { repo, pr: number, headSha: prHead, body }),
        at: systemClock(),
      });
      return state === "open"
        ? `🔀 PR updated: ${url}${renderedAt(input.verbosity, prHead)}`
        : `🔀 PR updated: ${url}${renderedAt(input.verbosity, prHead)} (the pull request is ${state}; its description was edited in place)`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[pr-post] ${logKey} update failed for ${repo}#${number}: ${reason}`);
      return `⚠️ A PR description was submitted for this thread's pull request ${url} but it could not be updated: ${reason}`;
    }
  }
  if (prDescription && branch !== undefined && branch === base) {
    // The branch IS the base the pull request would target — a workspace that
    // never left the default branch, or a run dispatched at a branch the
    // thread's binding names as its base too — so there is no head to open a
    // PR from, and a compare URL would mislead. Never silently: the run
    // submitted a description, and a reader of the card or the record
    // (a plan runner's `pr-check` among them) must see why no pull request
    // followed, as a typed note and in the reply.
    console.log(
      `[pr-post] ${logKey} skipped: the branch ${branchLog} is the base branch ${base} (repo ${repo}) — no PR opened`,
    );
    input.publish({
      type: "run_note",
      kind: "pr_not_opened",
      summary: `no PR opened: the branch ${branch} is the base branch the pull request would target`,
      at: systemClock(),
    });
    return `⚠️ A PR description was submitted but the branch \`${branch}\`${branchNote} is the base branch the pull request would target, so no PR was opened — a pull request needs a head branch other than its base.`;
  }
  /** Issue 1807 — the budget wind-down's honest endings, made honest about an
   *  existing pull request too: a run cut mid-work leaves its push unproven
   *  (a rebase in flight rewrote the tree past the pushed head; a probe the
   *  cut broke left the head unobservable), yet the branch may already head
   *  an open pull request the run pushed minutes earlier — and "no PR was
   *  opened" would send the reader to open a duplicate. So before either of
   *  those notes, ask GitHub whether an open PR heads the branch (the same
   *  lookup the description-less path uses below) and, found, render the
   *  description at ITS head — as GitHub reports it, never the workspace's
   *  unproven tip — and edit it by number; without that head, or on a failed
   *  edit, the note still names the PR and says the description was not
   *  re-rendered. Null or a failed lookup → undefined: the honest "no PR was
   *  opened" note stands. `pr_opened` carries no `head`, like the ownPr edit
   *  above: nothing proves this run pushed, so the release has no branch to
   *  remember. `caveat`: the workspace state the note must not lose. */
  // The start state the identity rewrite subtracts (record 0062): the
  // recorded one when it was read for this very branch; for a branch the run
  // pushed but the dispatch did not know at attach, where the run's own first
  // push found it (`target.pushedStart`) — empty when that push created the
  // branch, its pre-push head as a boundary when it moved an existing one
  // (history the run did not create is never rewritten below it), and
  // UNKNOWN when neither is on record, on which the rewrite fails closed. No
  // recorded state at all means the dispatch never fired the read — it
  // resolved no repository or branch at attach (the repo here may be the
  // workspace's own origin, discovered after the run) — so the refusal's
  // reason says no read was attempted, never that one failed.
  const startStateFor = (headBranch: string): BranchStartState =>
    target.startState === undefined
      ? {
          kind: "unknown",
          reason:
            "none was recorded — the dispatch resolved no repository or branch at attach, so no read was attempted",
        }
      : target.startBranch === undefined || target.startBranch === headBranch
        ? target.startState
        : target.pushedStart === undefined
          ? {
              kind: "unknown",
              reason: `the run pushed ${headBranch}, not the branch whose start state was read at attach, and no push of the run's names the head it moved that branch from`,
            }
          : target.pushedStart.kind === "created"
            ? EMPTY_START_STATE
            : { kind: "boundary", sha: target.pushedStart.sha };
  const editOpenPrHeadedBy = async (headBranch: string, caveat: string): Promise<string | undefined> => {
    if (!prDescription) return undefined;
    const existing = await input.findOpenPr(repo, headBranch).catch((err: unknown) => {
      console.error(
        `[pr-post] ${logKey} open-PR lookup failed for ${repo} ${headBranch}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    if (!existing) return undefined;
    const url = existing.htmlUrl;
    const prHead = existing.headSha;
    if (prHead === undefined) {
      console.log(
        `[pr-post] ${logKey} ${repo}#${existing.number} heads ${headBranch}, but GitHub named no head commit to render at — description not re-rendered`,
      );
      return `⚠️ A PR description was submitted and the open pull request ${url} heads \`${headBranch}\`${branchNote}, but its description was not re-rendered (GitHub named no head commit to render at); ${caveat}.`;
    }
    // The identity rewrite before the edit (record 0062; agent-coding.md item
    // 2): the run's push — proven or not — put commits on the branch this
    // pull request heads, so the same rewrite the open path runs settles them
    // before the bot's rendering goes on. On `unreadable` the body is not
    // edited and the note says why; a tip the rewrite settled is where the
    // body renders, never a head the rewrite just moved.
    let renderHead = prHead;
    let reauthored = "";
    if (input.identity !== undefined) {
      if (base === undefined)
        return `⚠️ A PR description was submitted and the open pull request ${url} heads \`${headBranch}\`${branchNote}, but no base branch is known to judge its commits against, so it was not edited; ${caveat}.`;
      const result = await input.identity
        .rewrite({ repo, base, branch: headBranch, startState: startStateFor(headBranch) })
        .catch((err: unknown): RewriteResult => ({
          kind: "unreadable",
          reason: err instanceof Error ? err.message : String(err),
        }));
      if (result.kind === "unreadable") {
        console.log(
          `[pr-post] ${logKey} not edited: the identity rewrite found ${repo} ${headBranch} unreadable (${result.reason})`,
        );
        input.publish({
          type: "run_note",
          kind: "pr_not_opened",
          summary: `pull request #${existing.number} not edited: the commits' identities could not be verified (${result.reason})`,
          at: systemClock(),
        });
        return `⚠️ A PR description was submitted and the open pull request ${url} heads \`${headBranch}\`${branchNote}, but the identities of its commits could not be verified or rewritten (${result.reason}), so it was not edited; ${caveat}.`;
      }
      if (result.kind === "rewritten") {
        console.log(
          `[identity] ${logKey} re-authored ${result.count} commit(s) on ${repo} ${headBranch}: ${result.replaced.join("; ")}`,
        );
        reauthored = ` — ${result.count} commit(s) re-authored`;
      }
      if (result.tip !== undefined && /^[0-9a-f]{40}$/.test(result.tip)) renderHead = result.tip;
    }
    try {
      const body = renderPrDescriptionMarkdown(prDescription, {
        repo,
        headSha: renderHead,
        ...(requestedBy ? { requestedBy } : {}),
      });
      await input.updatePullRequest(repo, existing.number, { title: prDescription.title, body });
      console.log(
        `[pr-post] ${logKey} updated ${repo}#${existing.number} — the open PR heading ${headBranch} (rendered at ${renderHead.slice(0, 7)}; the run's own push unproven)`,
      );
      input.publish({ type: "pr_opened", url, number: existing.number, created: false, at: systemClock() });
      input.publish({
        type: "review_artifact",
        ...submittedPrDescriptionArtifact(prDescription, { repo, pr: existing.number, headSha: renderHead, body }),
        at: systemClock(),
      });
      // A dash, never a bare `;` on the URL: autolinkers fold trailing punctuation into the link.
      return `🔀 PR updated: ${url}${renderedAt(input.verbosity, renderHead, "its head ")}${reauthored} — ${caveat}`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[pr-post] ${logKey} update failed for ${repo}#${existing.number}: ${reason}`);
      return `⚠️ A PR description was submitted and the open pull request ${url} heads \`${headBranch}\`${branchNote}, but its description was not re-rendered (${reason}); ${caveat}.`;
    }
  };
  if (prDescription && branch !== undefined && headSha !== undefined && !pushed) {
    // A commit sits on a non-base branch, but nothing proves it reached the
    // remote: the remote has no such branch, or holds it at an older commit.
    // The note must not claim a push — and offers no compare URL, which
    // would imply a remote branch nothing observed.
    const why =
      remoteHead === undefined
        ? "was not found on the remote"
        : `has unpushed commits (the remote branch is at ${remoteHead.slice(0, 7)}, the workspace at ${headSha.slice(0, 7)})`;
    if (remoteHead !== undefined) {
      // The remote holds the branch, so an open PR may head it (issue 1807);
      // a branch the remote said is absent heads nothing and is never asked.
      const note = await editOpenPrHeadedBy(
        branch,
        `the branch \`${branch}\`${branchNote} has unpushed commits the pull request does not carry (the remote is at ${remoteHead.slice(0, 7)}, the workspace at ${headSha.slice(0, 7)})`,
      );
      if (note !== undefined) return note;
    }
    console.log(
      `[pr-post] ${logKey} skipped: push not observed (repo ${repo}, branch ${branchLog}, head ${headSha.slice(0, 7)}, remote ${remoteHead?.slice(0, 7) ?? "none"})`,
    );
    return `⚠️ A PR description was submitted but the branch \`${branch}\`${branchNote} ${why}, so no PR was opened.`;
  }
  if (prDescription && pushedBranch && branch !== undefined && headSha?.length === 40 && base) {
    // The identity rewrite before the open or edit (record 0062;
    // agent-coding.md item 2): the run's commits must carry only the allowed
    // identities before the bot's name goes on a pull request over them. On
    // `unreadable` nothing is opened or edited and the reply says why; on
    // `rewritten` the pull request is opened at the rebuilt tip, the note and
    // the `pr_opened` event carry the count, and an `[identity]` line carries
    // the identities replaced.
    let renderHead = headSha;
    let rewrittenCount = 0;
    // The start state the rewrite subtracts: `startStateFor` above — the
    // recorded one for the branch the dispatch knew, the run's own first
    // push's start point for any other, unknown (fail closed) without either.
    const startState = startStateFor(branch);
    const rewriteOnce = async (): Promise<RewriteResult | undefined> => {
      if (!input.identity) return undefined;
      const result = await input.identity
        .rewrite({ repo, base, branch, startState })
        .catch((err: unknown): RewriteResult => ({
          kind: "unreadable",
          reason: err instanceof Error ? err.message : String(err),
        }));
      if (result.kind === "rewritten") {
        rewrittenCount += result.count;
        console.log(
          `[identity] ${logKey} re-authored ${result.count} commit(s) on ${repo} ${branch}: ${result.replaced.join("; ")}`,
        );
      }
      if (result.kind !== "unreadable" && result.tip !== undefined && /^[0-9a-f]{40}$/.test(result.tip))
        renderHead = result.tip;
      return result;
    };
    const rewrite = await rewriteOnce();
    if (rewrite?.kind === "unreadable") {
      console.log(
        `[pr-post] ${logKey} skipped: the identity rewrite found ${repo} ${branchLog} unreadable (${rewrite.reason})`,
      );
      input.publish({
        type: "run_note",
        kind: "pr_not_opened",
        summary: `no PR opened: the commits' identities could not be verified (${rewrite.reason})`,
        at: systemClock(),
      });
      return `⚠️ A PR description was submitted but the identities of the commits on \`${branch}\`${branchNote} could not be verified or rewritten (${rewrite.reason}), so no PR was opened or edited.`;
    }
    try {
      const renderCtx = { repo, headSha: renderHead, ...(requestedBy ? { requestedBy } : {}) };
      let body = renderPrDescriptionMarkdown(prDescription, renderCtx);
      const opened = await input.openPullRequest({ repo, headBranch: branch, base, title: prDescription.title, body });
      // The head pin: after the open or edit, the pull request's head
      // must be the tip the rewrite settled; a mismatch (the model pushed once
      // more between the rewrite and the open) runs the rewrite once more and
      // re-renders at the tip it settles. A second rewrite that answers
      // `unreadable` cannot un-open the pull request, so the reply and the
      // record carry a warning instead of claiming a verified head.
      let pinWarning = "";
      if (input.identity) {
        const prHead = await input.identity.pullRequestHead(repo, opened.number).catch(() => undefined);
        if (prHead !== undefined && !sameCommit(prHead, renderHead)) {
          console.log(
            `[pr-post] ${logKey} head mismatch after open on ${repo}#${opened.number} (pr at ${prHead.slice(0, 7)}, rewrite settled ${renderHead.slice(0, 7)}) — running the rewrite once more`,
          );
          const again = await rewriteOnce();
          if (again?.kind === "unreadable") {
            console.error(
              `[pr-post] ${logKey} the head pin on ${repo}#${opened.number} could not be verified (${again.reason})`,
            );
            input.publish({
              type: "run_note",
              kind: "pr_head_unverified",
              summary: `the pull request's head moved after the open and the identities at its new tip could not be verified (${again.reason})`,
              at: systemClock(),
            });
            pinWarning = ` — ⚠️ the head moved after the open and the identities at its new tip could not be verified (${again.reason})`;
          }
          if (again !== undefined && again.kind !== "unreadable") {
            body = renderPrDescriptionMarkdown(prDescription, { ...renderCtx, headSha: renderHead });
            await input
              .updatePullRequest(repo, opened.number, { title: prDescription.title, body })
              .catch((err: unknown) =>
                console.error(
                  `[pr-post] ${logKey} re-render after the head pin failed for ${repo}#${opened.number}: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
          }
        }
        // The assignee: the requester's bound login, added after the
        // pre-check answers 204 and skipped with one log line after a 404.
        const requestedLogin = input.identity.requestedLogin;
        if (requestedLogin !== undefined) {
          const assignable = await input.identity.isAssignable(repo, requestedLogin).catch(() => undefined);
          if (assignable === true)
            await input.identity
              .addAssignee(repo, opened.number, requestedLogin)
              .catch((err: unknown) =>
                console.error(
                  `[pr-post] ${logKey} assignee add failed for ${requestedLogin} on ${repo}#${opened.number}: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
          else if (assignable === false)
            console.log(`[identity] ${logKey} ${requestedLogin} is not assignable on ${repo}; skipped`);
        }
      }
      console.log(
        `[pr-post] ${logKey} ${opened.created ? "opened" : "updated"} ${repo}#${opened.number} (${branchLog} → ${base} @ ${renderHead.slice(0, 7)})`,
      );
      input.publish({
        type: "pr_opened",
        url: opened.htmlUrl,
        number: opened.number,
        created: opened.created,
        head: branch,
        ...(rewrittenCount > 0 ? { rewritten: rewrittenCount } : {}),
        at: systemClock(),
      });
      // The description as data, persisted at its source (reading-diff.md item
      // 7): the same object the body was rendered from, with the head it was
      // rendered at, so a review of this head can carry the exact pointers instead
      // of parsing the body back.
      input.publish({
        type: "review_artifact",
        ...submittedPrDescriptionArtifact(prDescription, { repo, pr: opened.number, headSha: renderHead, body }),
        at: systemClock(),
      });
      const reauthored = rewrittenCount > 0 ? ` — ${rewrittenCount} commit(s) re-authored` : "";
      return opened.created
        ? `🔀 PR opened: ${opened.htmlUrl} (\`${branch}\` → \`${base}\`)${reauthored}${pinWarning}`
        : `🔀 PR updated: ${opened.htmlUrl}${renderedAt(input.verbosity, renderHead)}${reauthored}${pinWarning}`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[pr-post] ${logKey} open/edit failed for ${repo} ${branch}: ${reason}`);
      return `⚠️ The branch \`${branch}\` is pushed but the PR could not be opened: ${reason} — compare & open manually: ${compareUrl}`;
    }
  }
  if (prDescription && pushedBranch && !base) {
    // Every explicit signal AND the GitHub default-branch fetch came back
    // empty (githubPulls.ts' fetchRepoShipInfo — no App credential, the repo
    // lookup failed, or it answered with no default_branch). Genuinely rare:
    // this is the last resort's own failure mode, not the common case.
    console.log(
      `[pr-post] ${logKey} skipped: no base branch resolvable, even after a GitHub default-branch lookup (repo ${repo}, branch ${branchLog})`,
    );
    return `⚠️ A PR description was submitted but no base branch is known for this thread, so no PR was opened — compare & open manually: ${compareUrl}`;
  }
  if (prDescription) {
    // A description was submitted but the pushed head — or the branch itself
    // (a failed probe, a detached checkout) — could not be observed: the
    // checkout is not a repo, or HEAD moved off the pushed branch and its
    // local ref is gone too. Never render anchors at a guessed commit — but
    // when the branch is known, ask whether an open PR heads it first (issue
    // 1807: the wind-down ends runs here with the PR's own head to render
    // at) — and never leave the submission dangling silently: say plainly
    // that no PR was opened.
    if (branch !== undefined) {
      const note = await editOpenPrHeadedBy(
        branch,
        `the pushed head of \`${branch}\`${branchNote} could not be observed in the workspace`,
      );
      if (note !== undefined) return note;
    }
    console.log(
      `[pr-post] ${logKey} skipped: push unobservable (repo ${repo}, branch ${branchLog}, head ${headSha ?? "unknown"})`,
    );
    const what = branch === undefined ? "pushed branch" : `pushed head of \`${branch}\`${branchNote}`;
    return `⚠️ A PR description was submitted but the ${what} could not be observed in the workspace, so no PR was opened${compareUrl ? ` — compare & open manually: ${compareUrl}` : "."}`;
  }
  if (pushedBranch && compareUrl) {
    // No description, but the push is proven. Before telling the reader to
    // open a PR by hand, ask GitHub whether the pushed branch ALREADY heads an
    // open PR — a follow-up on an existing PR (a dependabot branch, a PR the
    // thread was bound to) repushes that PR's own branch, and the push itself
    // updated the PR; "no PR was opened, compare & open manually" would send
    // the reader to duplicate it. The lookup is the same one open-or-edit
    // uses (githubPulls.findOpenPrByHead); the PR body is NOT touched — there
    // is no description to render — so the note says the push updated it and
    // the record carries the fact as `pr_opened` with `created: false`. The
    // note is a warning, not an info line: the coding prompt requires a
    // resubmitted description after EVERY push to an existing PR
    // (docs/reference/specs/agent-coding.md item 3), so a push without one left the PR
    // possibly describing an earlier state of its branch — a defect of the
    // run the reader should know about, never an accepted outcome.
    const existing = await input.findOpenPr(repo, branch).catch((err: unknown) => {
      console.error(
        `[pr-post] ${logKey} open-PR lookup failed for ${repo} ${branch}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    if (existing) {
      console.log(
        `[pr-post] ${logKey} no description submitted; the push updated the open ${repo}#${existing.number} (${branchLog} @ ${headSha.slice(0, 7)})`,
      );
      input.publish({
        type: "pr_opened",
        url: existing.htmlUrl,
        number: existing.number,
        created: false,
        head: branch,
        at: systemClock(),
      });
      const asked = input.descriptionTurnRan
        ? "submit_pr_description was never called, even in the dedicated description turn this run was given"
        : "submit_pr_description was never called";
      return `⚠️ PR updated by the push: ${existing.htmlUrl} — \`${branch}\`${branchNote} is at \`${headSha.slice(0, 7)}\`, but its description was not resubmitted (${asked}): the PR may now describe an earlier state of its branch — the coding agent must re-evaluate and resubmit the description after every push`;
    }
    // A pushed branch with no commits over the base has nothing to open: the
    // run found its scope already there (agent-ship.md item 12). Say so, and
    // never send the reader to a compare over an empty diff. The fact is read
    // only here, and a read that fails leaves the link as it was.
    const ahead =
      base !== undefined && input.commitsOverBase !== undefined
        ? await input.commitsOverBase(repo, base, branch).catch((err: unknown) => {
            console.error(
              `[pr-post] ${logKey} compare of ${branch} over ${base} failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          })
        : undefined;
    if (ahead === 0) {
      console.log(
        `[pr-post] ${logKey} skipped: no description submitted, and ${branch} has no commits over ${base} (repo ${repo})`,
      );
      return `ℹ️ No PR was opened: the run pushed \`${branch}\` with no commits over \`${base}\`, so there is nothing to open.`;
    }
    console.log(`[pr-post] ${logKey} skipped: no description submitted (repo ${repo}, branch ${branch})`);
    return `ℹ️ No PR was opened: the run pushed \`${branch}\` but submitted no PR description (submit_pr_description was never called) — compare & open manually: ${compareUrl}`;
  }
  return undefined;
}

/** The executors' word for a command that failed: an `exit N:` prefix, or
 *  git's own `fatal:`/`error:` first line — output that carries no count. */
function isCommandNoise(first: string | undefined): boolean {
  return first === undefined || /^(exit \d+|fatal:|error:)/i.test(first);
}

/** The number of entries `git status --porcelain -uno` listed — one per line
 *  in git's `XY path` form — or undefined when the command failed. An empty
 *  output is a clean tree: zero. */
function parseStatusCount(output: string): number | undefined {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return 0;
  if (isCommandNoise(lines[0]!.trim())) return undefined;
  return lines.filter((line) => /^[ MTADRCU?!]{2} /.test(line)).length;
}

/** The two counts as observation fields: each present only when measured. */
function countsOf(
  uncommittedChanges: number | undefined,
  unpushedCommits: number | undefined,
): Pick<WorkspaceObservation, "uncommittedChanges" | "unpushedCommits"> {
  return {
    ...(uncommittedChanges !== undefined ? { uncommittedChanges } : {}),
    ...(unpushedCommits !== undefined ? { unpushedCommits } : {}),
  };
}

/** The one integer `git rev-list --count …` prints, or undefined when the
 *  command failed or printed anything else. */
function parseCountOutput(output: string): number | undefined {
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined || !/^\d+$/.test(first)) return undefined;
  return Number(first);
}

/** The branch name from `git rev-parse --abbrev-ref HEAD` output, or undefined
 *  when the command failed (the executors' `exit N:`/`fatal:` noise), printed
 *  nothing usable, or the checkout is detached (`HEAD` is not a branch —
 *  nothing a PR could be opened from). A branch name is one whitespace-free
 *  token; anything else on the first non-empty line is command noise. */
function parseBranchOutput(output: string): string | undefined {
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first || first === "HEAD") return undefined;
  if (/\s/.test(first) || /^(exit \d+:|fatal:|error:)/i.test(first)) return undefined;
  return first;
}

/** One `<sha>\t<ref>` line of `git ls-remote` output. */
const LS_REMOTE_LINE_RE = /^([0-9a-f]{40})\s+(\S+)$/i;

/** What `git ls-remote --exit-code origin refs/heads/<branch>` said about the
 *  branch: `found` with the remote's sha when a line names EXACTLY
 *  `refs/heads/<branch>`; `absent` when the remote answered and the branch is
 *  not in the answer — git exited 2 (its documented "no matching refs"
 *  status) OR it listed refs, none of them ours (ls-remote patterns match a
 *  ref's tail, so a differently-named ref that merely ends with the pattern
 *  can be the whole exit-0 answer; it never stands in for the branch, and
 *  its presence is still the remote saying the branch is not there); `failed`
 *  for anything else — a nonzero exit other than 2 (network, auth, an origin
 *  the thread user cannot read) or output with no ref line at all — which the
 *  caller treats as "the remote could not be asked". `found`/`absent` are
 *  final; only `failed` lets the local `@{u}` stand in. */
export function parseLsRemoteOutput(
  output: string,
  branch: string,
): { kind: "found"; sha: string } | { kind: "absent" } | { kind: "failed" } {
  const exit = parseExitPrefix(output);
  if (exit.failed) return exit.exitCode === 2 ? { kind: "absent" } : { kind: "failed" };
  const want = `refs/heads/${branch}`;
  let answered = false;
  for (const line of output.split(/\r?\n/)) {
    const m = LS_REMOTE_LINE_RE.exec(line.trim());
    if (!m) continue;
    if (m[2] === want) return { kind: "found", sha: m[1].toLowerCase() };
    answered = true;
  }
  return answered ? { kind: "absent" } : { kind: "failed" };
}

/** The single cloned repo directory from `ls -d *\/.git` output, or undefined.
 *  Conservative on purpose: the name is interpolated into a `git -C` command
 *  (shell-quoted as well), so anything but a plain repo-name-shaped directory
 *  — spaces, a leading dash an option parser could eat, dot traversal — is
 *  refused rather than probed. */
function parseCloneDirOutput(output: string): string | undefined {
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const dir = first?.match(/^(.+)\/\.git\/?$/)?.[1];
  if (!dir || !/^[A-Za-z0-9._-]{1,100}$/.test(dir) || /^\.+$/.test(dir) || dir.startsWith("-")) return undefined;
  return dir;
}

// The clone-URL forms a GitHub origin remote takes: https, scp-style ssh, and
// URL-style ssh; owner/name held to the same conservative charsets
// repoContext.ts binds slugs with (the trailing `.git` is stripped after).
const ORIGIN_REMOTE_RE =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,104})$/;

/** The `owner/name` slug from `git remote get-url origin` output, or undefined
 *  for anything that is not a well-formed GitHub remote (another host, a local
 *  path, the executors' command noise). Lowercased like every resolved slug. */
function parseOriginRemoteOutput(output: string): string | undefined {
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first || /\s/.test(first)) return undefined;
  const m = ORIGIN_REMOTE_RE.exec(first);
  if (!m) return undefined;
  const name = m[2].replace(/\.git$/i, "");
  if (name.length === 0 || name.length > 100 || /^\.+$/.test(name)) return undefined;
  return `${m[1]}/${name}`.toLowerCase();
}

/** The note's tail naming the head the body was rendered at — `verbose`
 *  material (routing-and-config item 28); empty at quiet, where the link and
 *  the pull request's state are the whole note. */
function renderedAt(verbosity: Verbosity, sha: string, where = ""): string {
  return shows(verbosity, "verbose") ? ` — body re-rendered at ${where}\`${sha.slice(0, 7)}\`` : "";
}
