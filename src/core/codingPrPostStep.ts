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
// PR gets the compare URL and "open manually".
//
// Base resolution (CodingPrTarget): a bound PR's true base, else the resident
// binding ref, else the dispatch's resolved ref, else — the true last resort —
// the repo's own default branch fetched from GitHub (resolveBaseRefLazy,
// githubPulls.ts). That fetch closes a real gap: a bare issue-link coding
// run has no PR/explicit ref, and when the
// resident attach ALSO fails for a reason other than needs-ref (an infra
// fault, not-onboarded, a probe outage), the fresh-sandbox fallback carries no
// binding either — all three fields undefined, no PR openable, though the run
// pushed real work. agent:ship (shipPipeline.ts) hit the identical gap and
// closed it with `fetchRepoShipInfo`'s default_branch; resolveBaseRef /
// resolveBaseRefLazy in githubPulls.ts is that ONE mechanism, shared by both
// callers instead of two copies of "ask GitHub when nothing else names a
// base".

import { shellQuote } from "../execution/shellQuote.js";
import {
  resolveBaseRef,
  resolveBaseRefLazy,
  type OpenedPullRequest,
  type OpenPrRef,
  type PullRequestTarget,
  type RepoShipInfo,
} from "../execution/githubPulls.js";
import { encodeGithubPathSegments, renderPrDescriptionMarkdown, type PrDescription } from "./prDescription.js";
import { normalizeHead, parseRevParseOutput, sameCommit } from "./reviewedHead.js";
import { parseExitPrefix, type RunEvent } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import type { Span } from "./trace/types.js";
import type { ExecTraceOptions } from "../execution/executor.js";

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
  /** The commit the remote holds for `branch` — the proof of a push, read
   *  from the remote itself (`git ls-remote --exit-code origin
   *  refs/heads/<branch>`), so it does not depend on the clone's shape. A
   *  remote that answers "no such branch" is final (undefined). Only when
   *  that probe itself fails (network, auth, an unreadable origin) does the
   *  local record of the last push, `<branch>@{u}`, stand in. */
  remoteHead: string | undefined;
  /** `owner/name` parsed from the origin remote, probed only when asked. */
  remoteRepo: string | undefined;
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
    const [headOut, branchOut, upstreamOut, remoteOut, tipOut] = await Promise.all([
      probe(`${git} rev-parse HEAD`),
      probe(`${git} rev-parse --abbrev-ref HEAD`),
      // The head branch's own upstream: `@{u}` reads the checkout's, which is
      // the wrong branch once HEAD moved after the push.
      probe(pushed === undefined ? `${git} rev-parse @{u}` : `${git} rev-parse ${shellQuote(`${pushed}@{u}`)}`),
      opts.probeRemote ? probe(`${git} remote get-url origin`) : Promise.resolve(""),
      pushed === undefined ? Promise.resolve("") : probe(`${git} rev-parse ${shellQuote(`refs/heads/${pushed}`)}`),
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
  if (event.type !== "tool_result" || event.tool !== "bash" || event.output === undefined) return undefined;
  let branch: string | undefined;
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
    if (PUSHED_SUMMARY_RE.test(m[1])) branch = m[3];
  }
  return branch;
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
export function trackPushedBranch(initial?: string): { observe(event: RunEvent): void; branch(): string | undefined } {
  // callIds of in-flight bash calls whose command invokes git push; entries
  // leave on their result, so the set never outgrows one turn's tool calls.
  const pushCalls = new Set<string>();
  // `initial`: the branch a resumed run had already pushed before the restart
  // (docs/reference/specs/run-history.md item 38), restored from the ledger row's state.
  let branch: string | undefined = initial;
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
      if (fromPush) branch = pushedBranchOf(event) ?? branch;
    },
    branch: () => branch,
  };
}

/** Where the post-step's PR would open: the dispatch's resolved slug and refs.
 *  `repo` may be undefined (an agent-discovered repo — the observation's
 *  origin remote is the repo of last resort); the base is the PR's true base
 *  ref when the thread's context came from a PR, else the thread's resident
 *  binding ref, else the dispatch's resolved ref, else — when a description
 *  was actually submitted — the repo's own default branch fetched from
 *  GitHub (resolveBaseRefLazy, githubPulls.ts; the true base of last resort,
 *  shared with agent:ship's own resolution in shipPipeline.ts). None of these
 *  three fields alone is reliable: a resident attach that fails for a reason
 *  OTHER than needs-ref (an infra fault, not-onboarded, a probe outage) drops
 *  `bindingRef` with no equivalent fallback of its own — which is exactly the
 *  case the GitHub fetch closes. */
export interface CodingPrTarget {
  /** `owner/name` the dispatch resolved, or undefined (agent-discovered repo). */
  repo: string | undefined;
  /** The bound PR's true base ref (a fix round repushes the PR's OWN head
   *  branch, so the binding ref equals the branch and is NOT the merge base). */
  baseRef: string | undefined;
  /** The thread's resident binding ref, when the round ran on a resident. */
  bindingRef: string | undefined;
  /** The dispatch's resolved ref — the base of last resort before a GitHub fetch. */
  resolvedRef: string | undefined;
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
  observed: WorkspaceObservation;
  description: PrDescription | undefined;
  target: CodingPrTarget;
  openPullRequest: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /** The open PR whose head is the branch, or null (githubPulls.ts'
   *  findOpenPrByHead — the lookup open-or-edit itself starts with). Asked
   *  ONLY when a proven-pushed branch comes with no description: the push may
   *  have updated a PR that already exists, and the note must say so instead
   *  of sending the reader to open a duplicate. A lookup failure degrades to
   *  the "no PR was opened" note (logged, never thrown). */
  findOpenPr: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  /** The repo's default branch — the PR base of last resort, fetched via
   *  GitHub (githubPulls.ts' fetchRepoShipInfo; shared with agent:ship's own
   *  base resolution) ONLY when a description was submitted AND none of
   *  `target`'s three fields already name a base. Never called otherwise. */
  fetchRepoInfo: (repo: string) => Promise<RepoShipInfo | undefined>;
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
  // Base resolution (CodingPrTarget's doc comment): the GitHub fetch is the
  // true last resort, tried ONLY when a description was submitted — every
  // branch below that skips silently or reports without opening a PR never
  // needed a base in the first place, so a repo with no PR/resident/explicit
  // ref never pays for a network call it won't use.
  const candidates = [target.baseRef, target.bindingRef, target.resolvedRef];
  const base = prDescription
    ? await resolveBaseRefLazy(candidates, repo, input.fetchRepoInfo)
    : resolveBaseRef(candidates, undefined);
  const pushedBranch = branch !== undefined && branch !== base && pushed;
  if (prDescription && branch !== undefined && branch === base) {
    // The workspace sat on the base branch: nothing was pushed to open a PR
    // from, and a compare-URL note would mislead — the agent's own report
    // stands.
    console.log(`[pr-post] ${logKey} skipped: workspace on the base branch ${base} (repo ${repo}) — nothing pushed`);
    return undefined;
  }
  if (prDescription && branch !== undefined && headSha !== undefined && !pushed) {
    // A commit sits on a non-base branch, but nothing proves it reached the
    // remote: the remote has no such branch, or holds it at an older commit.
    // The note must not claim a push — and offers no compare URL, which
    // would imply a remote branch nothing observed.
    const why =
      remoteHead === undefined
        ? "was not found on the remote"
        : `has unpushed commits (the remote branch is at ${remoteHead.slice(0, 7)}, the workspace at ${headSha.slice(0, 7)})`;
    console.log(
      `[pr-post] ${logKey} skipped: push not observed (repo ${repo}, branch ${branchLog}, head ${headSha.slice(0, 7)}, remote ${remoteHead?.slice(0, 7) ?? "none"})`,
    );
    return `⚠️ A PR description was submitted but the branch \`${branch}\`${branchNote} ${why}, so no PR was opened.`;
  }
  if (prDescription && pushedBranch && headSha?.length === 40 && base) {
    try {
      const body = renderPrDescriptionMarkdown(prDescription, { repo, headSha });
      const opened = await input.openPullRequest({ repo, headBranch: branch, base, title: prDescription.title, body });
      console.log(
        `[pr-post] ${logKey} ${opened.created ? "opened" : "updated"} ${repo}#${opened.number} (${branchLog} → ${base} @ ${headSha.slice(0, 7)})`,
      );
      input.publish({
        type: "pr_opened",
        url: opened.htmlUrl,
        number: opened.number,
        created: opened.created,
        at: systemClock(),
      });
      return opened.created
        ? `🔀 PR opened: ${opened.htmlUrl} (\`${branch}\` → \`${base}\`)`
        : `🔀 PR updated: ${opened.htmlUrl} — body re-rendered at \`${headSha.slice(0, 7)}\``;
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
    // local ref is gone too. Never render anchors at a guessed commit, and
    // never leave the submission dangling silently: say plainly that no PR
    // was opened.
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
        at: systemClock(),
      });
      return `⚠️ PR updated by the push: ${existing.htmlUrl} — \`${branch}\`${branchNote} is at \`${headSha.slice(0, 7)}\`, but its description was not resubmitted (submit_pr_description was never called): the PR may now describe an earlier state of its branch — the coding agent must re-evaluate and resubmit the description after every push`;
    }
    console.log(`[pr-post] ${logKey} skipped: no description submitted (repo ${repo}, branch ${branch})`);
    return `ℹ️ No PR was opened: the run pushed \`${branch}\` but submitted no PR description (submit_pr_description was never called) — compare & open manually: ${compareUrl}`;
  }
  return undefined;
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
