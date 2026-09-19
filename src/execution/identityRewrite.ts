// The identity rewrite (record 0062, "The identity rewrite"): before the bot opens or edits a pull request, the commits the run
// pushed carry only the allowed identities — the requester pair, the bot pair,
// or a start-state author pair kept by fingerprint — rewritten over the Git
// Data API where they did not, with the same trees, the original author dates
// and the committer sent explicitly as the bot pair. The run's commits are
// judged against the base, less the start state (record 0062): `base...tip` keeps a
// rebase onto a newer base out of the range, subtracting the start state by
// sha keeps earlier rounds and adopted pull requests out, and the fingerprint
// (author pair, author date, message) keeps a rebase of start commits from
// re-authoring them while a start pair on new content is rewritten. Exact
// pairs throughout (record 0062): GitHub links by email and displays the name, so a
// login-only or name-only rule lets spoofs through. Fail closed: an unreadable
// range (over 300 commits, an unknown start state, a failed read, a tip that
// moved twice after two rebuilds, a ruleset refusal) opens nothing.

import {
  addAssignee,
  compareRange,
  createCommit,
  forceMoveRef,
  isAssignable,
  pullRequestHead,
  type ComparedCommit,
  type CompareResult,
} from "./githubPulls.js";
import { resolveGithubIdentity } from "./githubApp.js";
import { bindingOf, type BindingSource, type GithubBinding } from "./authorBinding.js";

/** One exact `(name, email)` pair — the whole identity the rewrite judges. */
export interface IdentityPair {
  name: string;
  email: string;
}

/** One commit of the branch's start state: what was on the branch and not on
 *  its base when the run attached, before the run pushed anything. */
export interface StartCommit {
  sha: string;
  author: IdentityPair;
  /** The author date as GitHub reports it — part of the fingerprint. */
  date: string;
  message: string;
}

/** The branch's start state as the dispatch recorded it at attach or clone:
 *  known (possibly empty — a new branch, or a branch equal to its base), or
 *  unknown, on which the rewrite answers unreadable. `reason` says why it is
 *  unknown when the reader knows more than "the read failed" — e.g. no read
 *  was ever attempted because the dispatch resolved no repository or branch
 *  at attach — so the refusal never claims a read that never ran. */
export type BranchStartState = { kind: "known"; commits: StartCommit[] } | { kind: "unknown"; reason?: string };

/** A known-empty start state — a new branch, a branch equal to its base, or
 *  the recover path's round-start branch (every earlier round's commits were
 *  themselves rewritten before their pull request opened, so they pass). */
export const EMPTY_START_STATE: BranchStartState = { kind: "known", commits: [] };

/** The author-env flag (record 0062): until the author-env unit flips it, the
 *  requester pair is not read — the allowed authors are the bot pair and start
 *  pairs by fingerprint, and a rewrite sets the bot pair. */
export const authorEnvEnabled = false;

/** The exact pair a binding authors commits as (record 0062): the login and the
 *  id-anchored noreply address. */
export function pairOfBinding(binding: GithubBinding): IdentityPair {
  return { name: binding.login, email: `${binding.id}+${binding.login}@users.noreply.github.com` };
}

/** The requester pair the rewrite may allow and set: the binding's pair when
 *  the author env is enabled, else none — the bot pair stands in. */
export function requesterPairFor(
  binding: GithubBinding | undefined,
  enabled = authorEnvEnabled,
): IdentityPair | undefined {
  if (!enabled || binding === undefined) return undefined;
  return pairOfBinding(binding);
}

/** The Git Data seam the rewrite runs over — githubPulls' compareRange,
 *  createCommit and forceMoveRef in production, stubs in tests. */
export interface RewriteApi {
  compareRange(repo: string, base: string, head: string): Promise<CompareResult | "missing" | undefined>;
  createCommit(
    repo: string,
    commit: {
      message: string;
      tree: string;
      parents: string[];
      author: { name: string; email: string; date: string };
      committer: { name: string; email: string };
    },
  ): Promise<string>;
  forceMoveRef(repo: string, branch: string, sha: string): Promise<void>;
}

/** How the rewrite ended: every run commit already allowed (`clean`); the
 *  chain rebuilt with the count of commits whose identities were replaced and
 *  the identities that were (`rewritten`, `tip` the rebuilt tip the pull
 *  request must pin); or the range could not be judged and nothing may open
 *  (`unreadable`, the reason named). */
export type RewriteResult =
  | { kind: "clean"; tip?: string }
  | { kind: "rewritten"; count: number; replaced: string[]; tip: string }
  | { kind: "unreadable"; reason: string };

export interface RewriteInput {
  repo: string;
  base: string;
  branch: string;
  startState: BranchStartState;
  /** The bot pair — resolveGithubIdentity()'s pair; undefined fails closed. */
  bot: IdentityPair | undefined;
  /** The requester pair (`requesterPairFor`): allowed and set only when the
   *  author env is enabled and the requester has a binding. */
  requester?: IdentityPair;
  api: RewriteApi;
}

/** How many commits the compare may carry before the range is unreadable. */
const MAX_RUN_COMMITS = 300;
/** The initial read plus the re-read after each of two rebuilds. */
const MAX_READS = 3;

const samePair = (a: IdentityPair, b: IdentityPair): boolean => a.name === b.name && a.email === b.email;

const CO_AUTHOR_RE = /^co-authored-by:\s*(.*?)\s*<([^>]*)>\s*$/i;

/** The Co-Authored-By pairs of a message's trailer lines, each with its line
 *  index so a rewrite can drop the foreign ones and keep everything else. */
function coAuthorLines(message: string): Array<{ index: number; pair: IdentityPair }> {
  const lines = message.split("\n");
  const found: Array<{ index: number; pair: IdentityPair }> = [];
  lines.forEach((line, index) => {
    const m = CO_AUTHOR_RE.exec(line.trim());
    if (m) found.push({ index, pair: { name: m[1], email: m[2] } });
  });
  return found;
}

/** Why one commit fails the identity rule, or undefined when it passes:
 *  the author is the requester pair, the bot pair, or a start-state author
 *  pair on a commit whose fingerprint equals that start commit's; the
 *  committer is the bot pair; every Co-Authored-By trailer parses to the
 *  requester pair or the bot pair. */
function offenceOf(
  commit: ComparedCommit,
  allowed: { bot: IdentityPair; requester?: IdentityPair; start: StartCommit[] },
): string | undefined {
  if (!authorKeepable(commit, allowed)) return `author ${commit.author.name} <${commit.author.email}>`;
  if (!samePair(commit.committer, allowed.bot)) return `committer ${commit.committer.name} <${commit.committer.email}>`;
  const foreign = coAuthorLines(commit.message).find(
    ({ pair }) =>
      !samePair(pair, allowed.bot) && !(allowed.requester !== undefined && samePair(pair, allowed.requester)),
  );
  if (foreign) return `co-author ${foreign.pair.name} <${foreign.pair.email}>`;
  return undefined;
}

/** Whether the author pair may be KEPT on a rebuilt commit: it passes
 *  the author half of the identity rule — including a start pair by fingerprint, which a
 *  rebuild preserves (the parent changes, the fingerprint does not). */
function authorKeepable(
  commit: ComparedCommit,
  allowed: { bot: IdentityPair; requester?: IdentityPair; start: StartCommit[] },
): boolean {
  const authorPair = { name: commit.author.name, email: commit.author.email };
  return (
    samePair(authorPair, allowed.bot) ||
    (allowed.requester !== undefined && samePair(authorPair, allowed.requester)) ||
    allowed.start.some(
      (s) => samePair(authorPair, s.author) && s.date === commit.author.date && s.message === commit.message,
    )
  );
}

/** The message with foreign Co-Authored-By lines removed (the bot's and the
 *  requester's kept as written). */
function scrubMessage(message: string, allowed: { bot: IdentityPair; requester?: IdentityPair }): string {
  const foreign = new Set(
    coAuthorLines(message)
      .filter(
        ({ pair }) =>
          !samePair(pair, allowed.bot) && !(allowed.requester !== undefined && samePair(pair, allowed.requester)),
      )
      .map(({ index }) => index),
  );
  if (foreign.size === 0) return message;
  return message
    .split("\n")
    .filter((_, index) => !foreign.has(index))
    .join("\n");
}

/** A ruleset's refusal of the rebuild or the ref move (force pushes blocked,
 *  signed commits required): HTTP 422 or 409 — unreadable with the rule named. */
function rulesetRefusal(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP (?:422|409)\b/.test(message) ? message : undefined;
}

/**
 * The rewrite : read the paginated compare `base...branch`, take
 * as the run's commits every listed commit whose sha is not in the start
 * state, judge each against the allowed identities, and — from the first
 * commit that fails through the tip — rebuild the chain over the Git Data API
 * with the same trees and the committer as the bot pair, force-move the ref,
 * then re-read and require every run commit to pass. A tip that moved
 * meanwhile is rebuilt once more; a third disagreement is unreadable.
 */
export async function rewriteRunCommits(input: RewriteInput): Promise<RewriteResult> {
  if (input.startState.kind === "unknown")
    return {
      kind: "unreadable",
      reason: `the branch's start state is unknown (${input.startState.reason ?? "the read at attach failed"})`,
    };
  if (input.bot === undefined)
    return { kind: "unreadable", reason: "the bot's own GitHub identity could not be resolved" };
  const allowed = {
    bot: input.bot,
    ...(input.requester !== undefined ? { requester: input.requester } : {}),
    start: input.startState.commits,
  };
  const startShas = new Set(input.startState.commits.map((c) => c.sha));
  let totalRewritten = 0;
  const replaced: string[] = [];
  let rebuilds = 0;
  for (let read = 1; read <= MAX_READS; read += 1) {
    const compare = await input.api.compareRange(input.repo, input.base, input.branch);
    if (compare === "missing")
      return { kind: "unreadable", reason: `the compare ${input.base}...${input.branch} answered 404` };
    if (compare === undefined)
      return { kind: "unreadable", reason: `the compare ${input.base}...${input.branch} could not be read` };
    if (compare.totalCommits > MAX_RUN_COMMITS)
      return {
        kind: "unreadable",
        reason: `the range carries ${compare.totalCommits} commits (over ${MAX_RUN_COMMITS})`,
      };
    const runCommits = compare.commits.filter((c) => !startShas.has(c.sha));
    const tip = compare.commits[compare.commits.length - 1]?.sha;
    const firstOffender = runCommits.findIndex((c) => offenceOf(c, allowed) !== undefined);
    if (firstOffender === -1) {
      if (totalRewritten === 0) return { kind: "clean", ...(tip !== undefined ? { tip } : {}) };
      return { kind: "rewritten", count: totalRewritten, replaced, tip: tip ?? input.branch };
    }
    if (rebuilds >= 2)
      return { kind: "unreadable", reason: "the branch tip moved twice while the rewrite ran; giving up" };
    // Rebuild from the first offender through the tip: the listed order
    // is chronological, and every descendant of a rebuilt commit is rebuilt
    // too (its parent changed), its own author kept when it already passes.
    const rebuilt = new Map<string, string>();
    for (let i = firstOffender; i < runCommits.length; i += 1) {
      const commit = runCommits[i];
      const offence = offenceOf(commit, allowed);
      if (offence !== undefined) {
        totalRewritten += 1;
        if (!replaced.includes(offence)) replaced.push(offence);
      }
      const keepAuthor = authorKeepable(commit, allowed);
      const correctedAuthor = allowed.requester ?? allowed.bot;
      let newSha: string;
      try {
        newSha = await input.api.createCommit(input.repo, {
          message: scrubMessage(commit.message, allowed),
          tree: commit.treeSha,
          parents: commit.parents.map((p) => rebuilt.get(p) ?? p),
          author: keepAuthor
            ? { ...commit.author }
            : { name: correctedAuthor.name, email: correctedAuthor.email, date: commit.author.date },
          committer: { name: allowed.bot.name, email: allowed.bot.email },
        });
      } catch (err) {
        const rule = rulesetRefusal(err);
        return {
          kind: "unreadable",
          reason: rule ?? `the commit rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      rebuilt.set(commit.sha, newSha);
    }
    const newTip = rebuilt.get(runCommits[runCommits.length - 1].sha);
    if (newTip === undefined) return { kind: "unreadable", reason: "the rebuild produced no tip" };
    try {
      await input.api.forceMoveRef(input.repo, input.branch, newTip);
    } catch (err) {
      const rule = rulesetRefusal(err);
      return {
        kind: "unreadable",
        reason: rule ?? `the ref move failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    rebuilds += 1;
    // The re-read: the loop reads the compare again and requires every
    // run commit to pass; a tip that moved meanwhile fails the judge and is
    // rebuilt once more, and the third disagreement returns unreadable above.
  }
  return { kind: "unreadable", reason: "the rewrite could not settle the branch" };
}

/** The seam the dispatch and the recover path run the rewrite over — the
 *  production wiring below in the bot process, stubs in tests. `requester` is
 *  the run's requester (the platform-namespaced user id) whose binding the
 *  rewrite reads; the flag decides whether the pair is used. */
export interface DispatchIdentityRewrite {
  readStartState(repo: string, base: string, branch: string): Promise<BranchStartState>;
  rewrite(args: {
    repo: string;
    base: string;
    branch: string;
    startState: BranchStartState;
    requester: string;
  }): Promise<RewriteResult>;
  pullRequestHead(repo: string, number: number): Promise<string | undefined>;
  isAssignable(repo: string, login: string): Promise<boolean | undefined>;
  addAssignee(repo: string, number: number, login: string): Promise<void>;
  /** The requester's bound login, for the assignee and the requested-by line
   *  — read whatever the author-env flag says: the binding names the
   *  person, the flag only gates the author pair. */
  requestedLogin(userId: string): Promise<string | undefined>;
}

/** The production wiring: githubPulls' Git Data calls over the App token, the
 *  bot pair from `resolveGithubIdentity`, the requester pair from the stored
 *  binding (authorBinding.ts) under the author-env flag. */
export function dispatchIdentityRewrite(store: BindingSource): DispatchIdentityRewrite {
  return {
    readStartState: (repo, base, branch) => readBranchStartState(repo, base, branch, compareRange),
    rewrite: async ({ repo, base, branch, startState, requester }) => {
      const bot = await resolveGithubIdentity();
      const binding = await bindingOf(requester, store).catch(() => undefined);
      const requesterPair = requesterPairFor(binding);
      return rewriteRunCommits({
        repo,
        base,
        branch,
        startState,
        bot: bot !== undefined ? pairOfBinding(bot) : undefined,
        ...(requesterPair !== undefined ? { requester: requesterPair } : {}),
        api: { compareRange, createCommit, forceMoveRef },
      });
    },
    pullRequestHead,
    isAssignable,
    addAssignee,
    requestedLogin: async (userId) => (await bindingOf(userId, store).catch(() => undefined))?.login,
  };
}

/**
 * The start state of the run's branch, read at attach or clone before
 * the run pushes: the `(sha, author pair, author date, message)` of the
 * commits on the branch and not on its base — empty for a new branch (the
 * compare 404s) or a branch equal to its base, unknown when the read fails.
 */
export async function readBranchStartState(
  repo: string,
  base: string,
  branch: string,
  compare: RewriteApi["compareRange"],
): Promise<BranchStartState> {
  if (branch === base) return EMPTY_START_STATE;
  const result = await compare(repo, base, branch).catch(() => undefined);
  if (result === "missing") return EMPTY_START_STATE;
  if (result === undefined || result.totalCommits > MAX_RUN_COMMITS) return { kind: "unknown" };
  return {
    kind: "known",
    commits: result.commits.map((c) => ({
      sha: c.sha,
      author: { name: c.author.name, email: c.author.email },
      date: c.author.date,
      message: c.message,
    })),
  };
}
