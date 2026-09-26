// The ship pipeline's preflight (docs/reference/specs/agent-ship.md items 1, 2,
// 9, 10): every check that must refuse BEFORE round 0, and the entry it hands
// the plan runner — the pipeline branch, the PR base, and whether the pipeline
// resumes at review on an open PR of ship's own. Pure decisions over injected
// lookups; the hand-off (coordinator/handOff.ts) carries what this decides.

import { refusalOf, type Refusal, type RefusalCode } from "../refusal.js";
import { nearMatch } from "../nearMatch.js";
import { resolveBaseRef, type PullRequestFacts, type RepoShipInfo } from "../../execution/githubPulls.js";
import type { RepoContext } from "../repoContext.js";
import { parseShipPlanRequest, isUnitBranch } from "./coordinator.js";

// ---- naming -------------------------------------------------------

// Slack link markup `<url>` / `<url|label>` → the bare url. Mirrors
// repoContext.ts's unwrapSlack but deliberately case-insensitive: an
// uppercase-scheme link (`<HTTPS://…|label>`) must unwrap here, while
// repoContext's case-sensitive unwrap feeds regexes whose bindings would change
// if it started unwrapping those — so the two stay separate rather than sharing
// one regex with different semantics.
const SLACK_LINK = /<((?:https?):\/\/[^|>\s]+)(?:\|[^>]*)?>/gi;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A PROBE, never the task: the request text with the ship scaffolding
 * stripped — the "new task text" of the entry checks (spec item 10), asked
 * only "is there a task here at all, or just a pull request reference?".
 * Removes Slack link markup, every URL (the PR link included), `owner/name#N`
 * shorthand, the resolved repo slug (and an `in <slug>:` prefix around it),
 * then leading connective punctuation. Deliberately conservative: ANY
 * non-empty remainder counts as a new task — a resume must carry only the
 * directive + the PR reference. The unit a child implements is shipUnitText's,
 * which keeps every URL — a probe that once doubled as the unit lost a task
 * whose whole point was the address it named.
 */
export function shipTaskText(requestText: string, repo: string): string {
  let t = requestText.replace(SLACK_LINK, " $1 ");
  t = t.replace(/https?:\/\/\S+/gi, " ");
  const slug = escapeRegExp(repo);
  t = t.replace(new RegExp(`\\bin\\s+${slug}\\s*:?`, "gi"), " ");
  t = t.replace(new RegExp(`\\b${slug}(#\\d+)?\\b`, "gi"), " ");
  t = t.replace(/\b[a-z0-9][\w.-]*\/[\w.-]+#\d+\b/gi, " ");
  t = t.replace(/\b(?:pr|pull request)\s*#\d+(?:['’]s)?\b/gi, " ");
  return t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:,\-—.\s]+/, "")
    .trim();
}

/**
 * The generated unit's text (spec item 16): the request as the person wrote
 * it, minus only what addresses the bot rather than describes the task — a
 * mention (`<@U…>`, `<@U…|name>`) and a leading `in <repo>:` — with Slack link
 * markup unwrapped to the bare url so the child reads the address, not Slack's
 * display label (`<https://…/TrrMBAg7|calendar.app.google/…>` shows an
 * ellipsis where the path was). Nothing else goes: a url, an issue reference
 * or the slug in prose is the task's own content. Directives are the caller's
 * to strip (parseDirectives), as they are for shipTaskText.
 */
export function shipUnitText(requestText: string, repo: string): string {
  let t = requestText.replace(SLACK_LINK, " $1 ");
  t = t.replace(/<@[^>\s]+>/g, " ");
  t = t.replace(new RegExp(`^\\s*in\\s+${escapeRegExp(repo)}\\s*:?`, "i"), " ");
  return t.replace(/\s+/g, " ").trim();
}

// ---- preflight (spec items 1, 2, 9, 10) --------------------------------------

/** What the preflight decided the pipeline starts FROM. */
export interface ShipEntry {
  repo: string;
  /** The pipeline branch, set only when the entry resumes or adopts (the PR's
   *  own head branch). A fresh entry names none: the hand-off is the one branch
   *  namer — the generated plan's `plan/<id>/u1` (agent-ship item 3). */
  branch?: string;
  /** The PR base branch: the dispatch-resolved ref, else the repo's default
   *  branch. Undefined → the hand-off reports "no base" honestly. */
  base: string | undefined;
  /** Resume-at-review: the user-named, same-repo open PR (any author). */
  resume?: { pr: number; headSha: string; url?: string };
  /** Adopt: the thread's open PR a generated task runs on — round 0 pushes to
   *  its head branch, the pre-check finds it (spec item 10). */
  adopt?: { pr: number; headSha: string; url?: string };
  /** The pull request's own auto-merge fact, named at entry (spec item 9) —
   *  never refused. */
  autoMergeEnabled?: boolean;
  /** Set when a bound base ref did not exist on the repository and the entry
   *  fell back to the default branch: the ref as bound, for the hand-off's
   *  first line to name what the door read and what it will do. */
  baseFallback?: { requested: string };
}

export type ShipPreflightResult =
  | { ok: true; entry: ShipEntry }
  | {
      ok: false;
      where: string;
      card: string;
      reply: string;
      refusal: Refusal;
      /** A runnable redispatch line for record 0054's Yes/No question. */
      guess?: { line: string; evidence: string };
    };

export interface ShipPreflightInput {
  /** Platform-namespaced channel id (AGENTS.md invariant 4) — names the
   *  adapter in the channel refusal; the capability below decides it. */
  channelId: string;
  threadKey: string;
  /** Whether the request's channel handle can open a thread of its own
   *  (`ChannelIO.openThread`, thread-admission item 6; record 0060): the
   *  runner posts its card and opens each unit's thread through the requesting
   *  thread's channel, so the capability — never a prefix list — decides who
   *  may run a pipeline. The ship branch passes `io.openThread !== undefined`. */
  canOpenThread: boolean;
  /** Directive-stripped request text. */
  requestText: string;
  repoCtx: Pick<
    RepoContext,
    | "repo"
    | "pr"
    | "prFromMessage"
    | "prIsThreadOwn"
    | "prTargeted"
    | "ref"
    | "refFromPr"
    | "baseRef"
    | "headSha"
    | "prUnpostable"
  >;
  gates: { canRunAgent: (agent: string) => boolean; adminsHint: () => string };
  /** Repo facts: the default branch, the PR base of last resort. Undefined =
   *  the lookup failed → the entry proceeds with no default branch. */
  repoInfo: (repo: string) => Promise<RepoShipInfo | undefined>;
  /** PR facts for the entry checks. Undefined = unknown → refused fail-closed
   *  on the adopt and resume cases; a cited PR beside task text stays context. */
  prFacts: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  /** PUBLIC_BASE_URL, for the run-page pointer in the channel refusal. */
  runsBase?: string;
  /** The onboarded repositories (record 0054): the list the no-repo refusal
   *  guesses against when the request named a repository that is not one.
   *  Undefined or empty → the sentence stands without a guess. */
  repoCandidates?: readonly string[];
  /** Whether a branch exists on the repository — one GET refs call, spent only
   *  when a base candidate is bound (issue 1827). `false` is GitHub's own 404;
   *  `undefined` (or a throw, or no seam) is "could not ask" and proceeds
   *  unchanged — advisory like `repoInfo`, so a transient failure never
   *  silently rebases explicitly named work. */
  refExists?: (repo: string, ref: string) => Promise<boolean | undefined>;
}

const refuse = (
  code: RefusalCode,
  where: string,
  card: string,
  reply: string,
): Extract<ShipPreflightResult, { ok: false }> => ({
  ok: false,
  where,
  card,
  reply,
  refusal: refusalOf(code, reply),
});

/** An `owner/name` token in the request text — the shape a person names a
 *  repository in. Deliberately the same shape repoContext binds. */
const REPO_TOKEN = /(?:^|[^\w./-])([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)(?![\w./-])/;

/** The no-repo refusal's best guess (record 0054): a single available
 * repository is a yes/no proposal even when the request named none; otherwise
 * a uniquely near typed slug is corrected. The line is a complete runnable
 * bind because preflight receives directive-stripped task text. */
function noRepoGuess(
  input: ShipPreflightInput,
): { line: string; evidence: string; source: "single" | "near" } | undefined {
  const candidates = input.repoCandidates ?? [];
  if (candidates.length === 0) return undefined;
  const typed = REPO_TOKEN.exec(input.requestText)?.[1];
  if (typed) {
    const near = nearMatch(typed, candidates);
    if (near.guess)
      return {
        line: `agent:ship ${input.requestText.replace(typed, near.guess)}`,
        evidence: `${near.reason ?? `\`${near.guess}\``}, which is onboarded`,
        source: "near",
      };
  }
  if (candidates.length !== 1) return undefined;
  const repo = candidates[0]!;
  return {
    line: `agent:ship in ${repo}: ${input.requestText}`,
    evidence: `\`${repo}\` is the one available repository`,
    source: "single",
  };
}

/**
 * Every check that must refuse BEFORE round 0, in order: channel, compound
 * permission gate, repo present, the repository lookup (a failure leaves the
 * default branch undefined and refuses nothing), then the entry checks that
 * decide round 0 vs adopt vs resume-at-review. Never throws — the injected
 * lookups' failures are treated as unknown.
 */
export async function shipPreflight(input: ShipPreflightInput): Promise<ShipPreflightResult> {
  const { repoCtx } = input;
  // Spec item 1 (record 0060): the runner posts its card and opens each unit's
  // thread through the requesting thread's channel, so the request handle's
  // own capability decides — a handle without `openThread` (HTTP /ingress, the
  // MCP dispatch tool) is refused with the spawn's reason.
  if (!input.canOpenThread) {
    const base = input.runsBase?.trim();
    const page = base ? `${base.replace(/\/+$/, "")}/runs` : "the bot's /runs page";
    const platform = input.channelId.split(":")[0] || input.channelId;
    return refuse(
      "ship_preflight_channel",
      "channel",
      "not started (channel cannot open a thread)",
      `🚫 The ${platform} channel cannot open a thread of its own, so \`agent:ship\` cannot run a pipeline from it — the runner posts its card and opens each unit's thread through the requesting thread's channel. ` +
        `Start it from a channel that can (Slack, the CLI or the web chat), and watch pipelines on the run page (${page}).`,
    );
  }
  // Spec item 2: child rounds never re-enter dispatch(), so without the
  // compound gate a user denied `coding` would gain push+PR capability through
  // ship. The repo leg (`canUseRepo`) already ran — the fork sits after it.
  const missing = ["ship", "coding", "review"].filter((a) => !input.gates.canRunAgent(a));
  if (missing.length > 0) {
    return refuse(
      "ship_preflight_permission",
      `permission (${missing.join(", ")})`,
      "not started (permissions)",
      `🚫 Running \`ship\` drives \`coding\` and \`review\` child rounds, and you're not on the allowlist for ${missing
        .map((a) => `\`${a}\``)
        .join(", ")}. Ask ${input.gates.adminsHint()} for access.`,
    );
  }
  const repo = repoCtx.repo;
  if (!repo) {
    const guess = noRepoGuess(input);
    const reply =
      guess?.source === "single"
        ? `🚫 \`agent:ship\` needs a target repository. Is \`${input.repoCandidates![0]}\` the target?`
        : guess !== undefined
          ? "🚫 `agent:ship` needs a target repository; the named repository is not available."
          : "🚫 `agent:ship` needs a target repository — name it in the request, e.g. `agent:ship in owner/repo: <task>`.";
    const result = refuse("ship_preflight_no_repo", "no repo", "not started (no repository)", reply);
    return guess === undefined ? result : { ...result, guess: { line: guess.line, evidence: guess.evidence } };
  }
  // The repository lookup is advisory: it names the default branch, the PR
  // base of last resort. A failed lookup leaves it undefined and refuses
  // nothing — auto-merge is the pull request's own fact (spec item 9), read
  // with the PR facts below and named, never refused.
  const info = await input.repoInfo(repo).catch(() => undefined);
  // Entry checks (spec item 10). The thread→PR inference reads USER turns only
  // (repoContext.ts), so `repoCtx.pr` set means a user turn named the PR.
  const task = shipTaskText(input.requestText, repo);
  // A seeded plan request keeps the plan graph's own `plan/<id>/u<n>` branches:
  // a pull request in its thread is context, never adopted — so its facts are
  // never needed, and a thread pull request that could not be fetched refuses
  // nothing on the seeded path.
  const seeded = parseShipPlanRequest(task) !== undefined;
  if (!seeded && repoCtx.prUnpostable?.reason === "unreachable") {
    return refuse(
      "ship_preflight_pr_unreachable",
      "thread PR unreachable",
      "not started (PR unverifiable)",
      `🚫 This thread names PR ${repo}#${repoCtx.prUnpostable.number} but it could not be fetched to run ship's entry checks — refusing fail-closed. Retry in a moment, or check the PR on GitHub.`,
    );
  }
  if (repoCtx.pr !== undefined && !seeded) {
    const where = `${repo}#${repoCtx.pr}`;
    // A PR named in THIS message beside NEW task text is quoted as evidence:
    // context, not the target. It never binds — not even when its facts cannot
    // be fetched or its head is a fork — so execution falls through to round 0
    // below, which drops the PR-derived ref (repoCtx.refFromPr) and starts a
    // fresh deterministic plan branch off the default branch; the reference
    // stays in the task text for the coding child. A direct action on `PR #N`
    // targets that PR. The thread's OWN pull request (repoCtx.prIsThreadOwn:
    // the run record's `pr` names it too) is also a target when cited by URL,
    // so it adopts (with task text) or resumes (without) like an inherited
    // thread PR — issue 1799's "CI is red on <own PR URL>" shape.
    const contextCase =
      task !== "" && repoCtx.prFromMessage === true && repoCtx.prIsThreadOwn !== true && repoCtx.prTargeted !== true;
    if (!contextCase) {
      const facts = await input.prFacts({ repo, number: repoCtx.pr }).catch(() => undefined);
      // The adopt and resume cases must verify the PR first: an unfetchable
      // target is refused fail-closed.
      if (!facts) {
        return refuse(
          "ship_preflight_pr_facts",
          "PR facts unavailable",
          "not started (PR unverifiable)",
          `🚫 Could not fetch ${where} to run ship's entry checks (open? same-repo head?) — refusing fail-closed. Retry in a moment.`,
        );
      }
      if (facts.state === "open") {
        // The fork check runs on adopt and resume: a head that lives on a fork
        // is not a branch ship can push to or resume on.
        if (!facts.sameRepoHead) {
          return refuse(
            "ship_preflight_fork_head",
            "fork-head PR",
            "not started (fork head)",
            `🚫 ${where}'s head branch lives on a fork, not on \`${repo}\` — ship cannot drive it.`,
          );
        }
        const branch = facts.headRef;
        if (!branch) {
          return refuse(
            "ship_preflight_head_unknown",
            "head branch unknown",
            "not started (head branch unknown)",
            `🚫 Could not determine ${where}'s head branch, so ship cannot bind the thread's worktree to it — refusing fail-closed.`,
          );
        }
        const headSha = facts.headSha;
        if (headSha === undefined || !/^[0-9a-f]{40}$/i.test(headSha)) {
          return refuse(
            "ship_preflight_head_unknown",
            "full head commit unknown",
            "not started (head commit unknown)",
            `🚫 Could not determine ${where}'s full head commit, so ship cannot fence publication to it — refusing fail-closed.`,
          );
        }
        if (facts.baseRef === undefined) {
          return refuse(
            "ship_preflight_head_unknown",
            "base branch unknown",
            "not started (base branch unknown)",
            `🚫 Could not determine ${where}'s base branch, so ship cannot bind publication to it — refusing fail-closed.`,
          );
        }
        // The PR's OWN base wins: a PR opened against a non-default base must
        // not run against the default branch. repoCtx.baseRef carries the same
        // fact when the thread context resolved the PR; the default branch is
        // the last resort — an adopt still carries the PR's base when the
        // repository lookup failed.
        const ownBase = facts.baseRef;
        // Existing-PR publication is exact: a positive 404 for its recorded
        // base refuses instead of silently retargeting the pull request. An
        // unanswerable lookup proceeds unchanged; the publication fence's
        // fresh PR read and atomic head lease still fail closed at push time.
        const ownBaseExists =
          ownBase !== undefined && input.refExists
            ? await input.refExists(repo, ownBase).catch(() => undefined)
            : undefined;
        if (ownBaseExists === false) {
          return refuse(
            "ship_preflight_head_unknown",
            "pull request base branch missing",
            "not started (base branch missing)",
            `🚫 ${where}'s base branch \`${ownBase}\` is not present in \`${repo}\`, so ship cannot establish an exact publication binding — refusing fail-closed.`,
          );
        }
        const base = resolveBaseRef([ownBase], info?.defaultBranch);
        const autoMerge = facts.autoMergeEnabled !== undefined ? { autoMergeEnabled: facts.autoMergeEnabled } : {};
        if (task) {
          // Adopt (spec item 10): a generated task in the thread of an open
          // pull request — any author's — runs ON that pull request: its head
          // branch is the unit's, its base the base, and round 0 pushes to it.
          return {
            ok: true,
            entry: {
              repo,
              branch,
              base,
              adopt: { pr: repoCtx.pr, headSha, ...(facts.htmlUrl !== undefined ? { url: facts.htmlUrl } : {}) },
              ...autoMerge,
            },
          };
        }
        // A bare PR reference (no task text) IS a resume request, for any
        // author (spec item 10): the review loop resumes on the PR's own head.
        return {
          ok: true,
          entry: {
            repo,
            branch,
            base,
            resume: {
              pr: repoCtx.pr,
              headSha,
              ...(facts.htmlUrl !== undefined ? { url: facts.htmlUrl } : {}),
            },
            ...autoMerge,
          },
        };
      }
      // A closed/merged PR is done: a bare reference to it has nothing to
      // resume; with task text the thread may start a fresh task below.
      if (!task) {
        return refuse(
          "ship_preflight_closed_resume",
          "closed resume target",
          "not started (PR closed)",
          `🚫 ${where} is closed — there is no review loop to resume. Give ship a task to start fresh work.`,
        );
      }
    }
  }
  if (!task) {
    return refuse(
      "ship_preflight_no_task",
      "no task",
      "not started (no task)",
      `🚫 Nothing to ship: give ship a task (\`agent:ship in ${repo}: <task>\`), or name an open ship PR by URL to resume its review loop.`,
    );
  }
  // The round-0 base is a typed ref token or the repo default — never
  // a ref that resolveRepoContext derived from a cited PR's head branch: that
  // PR did not bind as ship's target, so basing the new work on its head would
  // carry the stranger's commits and dangle when the PR merges. The resolver
  // flags such a ref (`refFromPr`) at the source, so this holds even when the
  // facts fetch failed and the head ref is otherwise unknown.
  // Nor a unit branch of ship's own: a thread stays bound at the branch its
  // last run opened a pull request on, so after a plan's unit it sits at
  // `plan/<id>/<slug>`, and a fresh task re-issued there would base the next
  // generated plan on the earlier unit — its pull request targeting that
  // branch instead of the repository's.
  // Belt-and-braces guard stays: a repo-shaped ref (the slug itself, or any
  // owner/name the API would 404 on as a ref) can only be a misparse —
  // createBranchRef would fail on it. Any of these → the repo's default branch.
  const ref =
    repoCtx.ref && !repoCtx.refFromPr && !isUnitBranch(repoCtx.ref) && repoCtx.ref.toLowerCase() !== repo.toLowerCase()
      ? repoCtx.ref
      : undefined;
  // One GET refs call, spent only when a typed ref survived the guards above.
  // A positive 404 falls back to the default branch and the hand-off narrates
  // what the door read and what it will do; it is never a refusal or a command
  // for the person. "Could not ask" (undefined, a throw, no seam) proceeds.
  if (ref !== undefined && input.refExists) {
    const exists = await input.refExists(repo, ref).catch(() => undefined);
    if (exists === false)
      return {
        ok: true,
        entry: { repo, base: info?.defaultBranch, baseFallback: { requested: ref } },
      };
  }
  return {
    ok: true,
    entry: { repo, base: resolveBaseRef([ref], info?.defaultBranch) },
  };
}
