// The coding run's deterministic PR post-step (features/pr-description.md
// item 5, agent-coding.md item 2), extracted from dispatch() as callable
// units (agent:ship plan U4) so a ship round can run them for its coding and
// fix rounds without being the dispatch's top-level agent. Two phases with an
// explicit seam between them, because the dispatcher publishes the accepted
// `pr_description` event in between and a hard stop can land mid-observation:
//
//   1. `observeCodingWorkspace` — read the workspace's HEAD, branch, upstream
//      (and, when asked, origin remote) BEFORE the workspace can be released.
//   2. `runCodingPrPostStep` — given that observation and the run's submitted
//      `PrDescription`, render the body at the observed head and open or edit
//      the PR (open-or-edit idempotency lives in githubPulls), publishing the
//      typed `pr_opened` event and returning the honest reply note.
//
// "Pushed" is OBSERVED, never inferred: the branch counts as pushed only when
// its upstream resolved and matches the observed HEAD. Failure honesty
// throughout: never a fabricated PR URL, and the branch compare URL is offered
// only when the upstream match proved the remote branch exists.

import { shellQuote } from "../execution/shellQuote.js";
import type { OpenedPullRequest, PullRequestTarget } from "../execution/githubPulls.js";
import { encodeGithubPathSegments, renderPrDescriptionMarkdown, type PrDescription } from "./prDescription.js";
import { normalizeHead, parseRevParseOutput, sameCommit } from "./reviewedHead.js";
import type { RunEvent } from "./runEvents.js";

/** What the PR post-step observed in the run's workspace, all read BEFORE the
 *  workspace is released. Every field is undefined when its probe failed. */
export interface WorkspaceObservation {
  head: string | undefined;
  branch: string | undefined;
  /** The checked-out branch's upstream commit (`@{u}`) — the proof of a push. */
  upstream: string | undefined;
  /** `owner/name` parsed from the origin remote, probed only when asked. */
  remoteRepo: string | undefined;
}

/**
 * Probe a coding run's workspace — HEAD, branch, upstream, and (when the
 * dispatch resolved no repo) the origin remote — concurrently, at the
 * workspace root first. Cold coding agents clone the repo into a SUBDIRECTORY
 * of the sandbox root (the coding prompt mandates at most ONE clone), so a
 * failed root HEAD probe discovers the single cloned repo and re-probes with
 * `git -C` — the directory shell-quoted AND vetted against a conservative
 * name pattern, never interpolated raw. Best-effort throughout: a failed
 * probe leaves its field undefined and the post-step reports honestly.
 */
export async function observeCodingWorkspace(
  executor: { exec: (cmd: string) => Promise<string> },
  opts: { probeRemote: boolean },
): Promise<WorkspaceObservation> {
  const probe = (cmd: string) => executor.exec(cmd).catch(() => "");
  const probesAt = async (git: string): Promise<WorkspaceObservation> => {
    const [headOut, branchOut, upstreamOut, remoteOut] = await Promise.all([
      probe(`${git} rev-parse HEAD`),
      probe(`${git} rev-parse --abbrev-ref HEAD`),
      probe(`${git} rev-parse @{u}`),
      opts.probeRemote ? probe(`${git} remote get-url origin`) : Promise.resolve(""),
    ]);
    return {
      head: parseRevParseOutput(headOut),
      branch: parseBranchOutput(branchOut),
      upstream: parseRevParseOutput(upstreamOut),
      remoteRepo: parseOriginRemoteOutput(remoteOut),
    };
  };
  const atRoot = await probesAt("git");
  if (atRoot.head !== undefined) return atRoot;
  const dir = parseCloneDirOutput(await probe("ls -d */.git 2>/dev/null | head -1"));
  if (dir === undefined) return atRoot; // no clone anywhere → the post-step reports honestly
  return probesAt(`git -C ${shellQuote(dir)}`);
}

/** Where the post-step's PR would open: the dispatch's resolved slug and refs.
 *  `repo` may be undefined (an agent-discovered repo — the observation's
 *  origin remote is the repo of last resort); the base is the PR's true base
 *  ref when the thread's context came from a PR, else the thread's resident
 *  binding ref, else the dispatch's resolved ref. */
export interface CodingPrTarget {
  /** `owner/name` the dispatch resolved, or undefined (agent-discovered repo). */
  repo: string | undefined;
  /** The bound PR's true base ref (a fix round repushes the PR's OWN head
   *  branch, so the binding ref equals the branch and is NOT the merge base). */
  baseRef: string | undefined;
  /** The thread's resident binding ref, when the round ran on a resident. */
  bindingRef: string | undefined;
  /** The dispatch's resolved ref — the base of last resort. */
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
  /** Publish hook into the run's event stream (the registry). */
  publish: (event: RunEvent) => void;
  logKey: string;
}): Promise<string | undefined> {
  const { observed, description: prDescription, target, logKey } = input;
  const repo = target.repo ?? observed.remoteRepo;
  const headSha = normalizeHead(observed.head);
  const branch = observed.branch;
  const upstream = normalizeHead(observed.upstream);
  const base = target.baseRef ?? target.bindingRef ?? target.resolvedRef;
  const pushed = headSha !== undefined && upstream !== undefined && sameCommit(upstream, headSha);
  const compareUrl = repo && branch && pushed ? `https://github.com/${repo}/compare/${encodeGithubPathSegments(branch)}` : undefined;
  const pushedBranch = branch !== undefined && branch !== base && pushed;
  if (repo === undefined) {
    // Neither the dispatch nor the workspace names a repository — nowhere a
    // PR could be opened. Said plainly when a description was submitted;
    // otherwise there is nothing to report on.
    if (prDescription) {
      console.log(`[pr-post] ${logKey} skipped: no repo resolvable (none at dispatch, no GitHub origin remote observed; branch ${branch ?? "unknown"})`);
      return `⚠️ A PR description was submitted but no repository is known for this thread (none resolved at dispatch, and no GitHub origin remote was observed in the workspace), so no PR was opened.`;
    }
    return undefined;
  }
  if (prDescription && branch !== undefined && branch === base) {
    // The workspace sat on the base branch: nothing was pushed to open a PR
    // from, and a compare-URL note would mislead — the agent's own report
    // stands.
    console.log(`[pr-post] ${logKey} skipped: workspace on the base branch ${base} (repo ${repo}) — nothing pushed`);
    return undefined;
  }
  if (prDescription && branch !== undefined && headSha !== undefined && !pushed) {
    // A commit sits on a non-base branch, but nothing proves it reached the
    // remote: no upstream, or an upstream behind the workspace. The note must
    // not claim a push — and offers no compare URL, which would imply a
    // remote branch nothing observed.
    const why =
      upstream === undefined
        ? "has no pushed upstream"
        : `has unpushed commits (its upstream is at ${upstream.slice(0, 7)}, the workspace at ${headSha.slice(0, 7)})`;
    console.log(`[pr-post] ${logKey} skipped: push not observed (repo ${repo}, branch ${branch}, head ${headSha.slice(0, 7)}, upstream ${upstream?.slice(0, 7) ?? "none"})`);
    return `⚠️ A PR description was submitted but the branch \`${branch}\` ${why}, so no PR was opened.`;
  }
  if (prDescription && pushedBranch && headSha?.length === 40 && base) {
    try {
      const body = renderPrDescriptionMarkdown(prDescription, { repo, headSha });
      const opened = await input.openPullRequest({ repo, headBranch: branch, base, title: prDescription.title, body });
      console.log(`[pr-post] ${logKey} ${opened.created ? "opened" : "updated"} ${repo}#${opened.number} (${branch} → ${base} @ ${headSha.slice(0, 7)})`);
      input.publish({ type: "pr_opened", url: opened.htmlUrl, number: opened.number, created: opened.created, at: Date.now() });
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
    console.log(`[pr-post] ${logKey} skipped: no base branch resolvable (repo ${repo}, branch ${branch})`);
    return `⚠️ A PR description was submitted but no base branch is known for this thread, so no PR was opened — compare & open manually: ${compareUrl}`;
  }
  if (prDescription) {
    // A description was submitted but the pushed head — or the branch itself
    // (a failed probe, a detached checkout) — could not be observed. Never
    // render anchors at a guessed commit, and never leave the submission
    // dangling silently: say plainly that no PR was opened.
    console.log(`[pr-post] ${logKey} skipped: push unobservable (repo ${repo}, branch ${branch ?? "unknown"}, head ${headSha ?? "unknown"})`);
    return `⚠️ A PR description was submitted but the pushed ${branch === undefined ? "branch" : "head"} could not be observed in the workspace, so no PR was opened${compareUrl ? ` — compare & open manually: ${compareUrl}` : "."}`;
  }
  if (pushedBranch && compareUrl) {
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
