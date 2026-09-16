// The ship pipeline's preflight (docs/reference/specs/agent-ship.md items 1, 2,
// 9, 10): every check that must refuse BEFORE round 0, and the entry it hands
// the plan runner — the pipeline branch, the PR base, and whether the pipeline
// resumes at review on an open PR of ship's own. Pure decisions over injected
// lookups; the hand-off (coordinator/handOff.ts) carries what this decides.

import { resolveBaseRef, type PullRequestFacts, type RepoShipInfo } from "../../execution/githubPulls.js";
import type { RepoContext } from "../repoContext.js";
import { parseShipPlanRequest } from "./coordinator.js";

// ---- naming -------------------------------------------------------

/**
 * The request text with the ship scaffolding stripped — the "new task text"
 * of the entry checks (spec item 10). Removes Slack link markup, every URL
 * (the PR link included), `owner/name#N` shorthand, the resolved repo slug
 * (and an `in <slug>:` prefix around it), then leading connective punctuation.
 * Deliberately conservative: ANY non-empty remainder counts as a new task —
 * a resume must carry only the directive + the PR reference.
 */
export function shipTaskText(requestText: string, repo: string): string {
  // Mirrors repoContext.ts's unwrapSlack but deliberately case-insensitive:
  // an uppercase-scheme link (`<HTTPS://…|label>`) must still strip to nothing
  // here, while repoContext's case-sensitive unwrap feeds regexes whose
  // bindings would change if it started unwrapping those — so the two stay
  // separate rather than sharing one regex with different semantics.
  let t = requestText.replace(/<((?:https?):\/\/[^|>\s]+)(?:\|[^>]*)?>/gi, " $1 ");
  t = t.replace(/https?:\/\/\S+/gi, " ");
  const slug = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  t = t.replace(new RegExp(`\\bin\\s+${slug}\\s*:?`, "gi"), " ");
  t = t.replace(new RegExp(`\\b${slug}(#\\d+)?\\b`, "gi"), " ");
  t = t.replace(/\b[a-z0-9][\w.-]*\/[\w.-]+#\d+\b/gi, " ");
  return t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:,\-—.\s]+/, "")
    .trim();
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
  resume?: { pr: number; headSha?: string; url?: string };
  /** Adopt: the thread's open PR a generated task runs on — round 0 pushes to
   *  its head branch, the pre-check finds it (spec item 10). */
  adopt?: { pr: number; url?: string };
  /** The pull request's own auto-merge fact, named at entry (spec item 9) —
   *  never refused. */
  autoMergeEnabled?: boolean;
}

export type ShipPreflightResult =
  { ok: true; entry: ShipEntry } | { ok: false; where: string; card: string; reply: string };

export interface ShipPreflightInput {
  /** Platform-namespaced channel id (AGENTS.md invariant 4) — the prefix IS
   *  the adapter kind: only `slack:` and `cli:` may run a pipeline. */
  channelId: string;
  threadKey: string;
  /** Directive-stripped request text. */
  requestText: string;
  repoCtx: Pick<
    RepoContext,
    "repo" | "pr" | "prFromMessage" | "ref" | "refFromPr" | "baseRef" | "headSha" | "prUnpostable"
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
}

const refuse = (where: string, card: string, reply: string): ShipPreflightResult => ({ ok: false, where, card, reply });

/**
 * Every check that must refuse BEFORE round 0, in order: channel, compound
 * permission gate, repo present, the repository lookup (a failure leaves the
 * default branch undefined and refuses nothing), then the entry checks that
 * decide round 0 vs adopt vs resume-at-review. Never throws — the injected
 * lookups' failures are treated as unknown.
 */
export async function shipPreflight(input: ShipPreflightInput): Promise<ShipPreflightResult> {
  const { repoCtx } = input;
  // Spec item 1: HTTP /ingress and the MCP dispatch tool are single-shot
  // request/response and cannot hold a pipeline-length connection.
  if (!input.channelId.startsWith("slack:") && !input.channelId.startsWith("cli:")) {
    const base = input.runsBase?.trim();
    const page = base ? `${base.replace(/\/+$/, "")}/runs` : "the bot's /runs page";
    return refuse(
      "channel",
      "not started (Slack/CLI only)",
      `🚫 \`agent:ship\` runs only from Slack or the CLI — this adapter is single-shot and cannot hold a pipeline-length run. ` +
        `Start it there instead, and watch pipelines on the run page (${page}).`,
    );
  }
  // Spec item 2: child rounds never re-enter dispatch(), so without the
  // compound gate a user denied `coding` would gain push+PR capability through
  // ship. The repo leg (`canUseRepo`) already ran — the fork sits after it.
  const missing = ["ship", "coding", "review"].filter((a) => !input.gates.canRunAgent(a));
  if (missing.length > 0) {
    return refuse(
      `permission (${missing.join(", ")})`,
      "not started (permissions)",
      `🚫 Running \`ship\` drives \`coding\` and \`review\` child rounds, and you're not on the allowlist for ${missing
        .map((a) => `\`${a}\``)
        .join(", ")}. Ask ${input.gates.adminsHint()} for access.`,
    );
  }
  const repo = repoCtx.repo;
  if (!repo) {
    return refuse(
      "no repo",
      "not started (no repository)",
      "🚫 `agent:ship` needs a target repository — name it in the request, e.g. `agent:ship in owner/repo: <task>`.",
    );
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
    // stays in the task text for the coding child.
    const contextCase = task !== "" && repoCtx.prFromMessage === true;
    if (!contextCase) {
      const facts = await input.prFacts({ repo, number: repoCtx.pr }).catch(() => undefined);
      // The adopt and resume cases must verify the PR first: an unfetchable
      // target is refused fail-closed.
      if (!facts) {
        return refuse(
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
            "fork-head PR",
            "not started (fork head)",
            `🚫 ${where}'s head branch lives on a fork, not on \`${repo}\` — ship cannot drive it.`,
          );
        }
        const branch = facts.headRef ?? repoCtx.ref;
        if (!branch) {
          return refuse(
            "head branch unknown",
            "not started (head branch unknown)",
            `🚫 Could not determine ${where}'s head branch, so ship cannot bind the thread's worktree to it — refusing fail-closed.`,
          );
        }
        // The PR's OWN base wins: a PR opened against a non-default base must
        // not run against the default branch. repoCtx.baseRef carries the same
        // fact when the thread context resolved the PR; the default branch is
        // the last resort — an adopt still carries the PR's base when the
        // repository lookup failed.
        const base = resolveBaseRef([facts.baseRef, repoCtx.baseRef], info?.defaultBranch);
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
              adopt: { pr: repoCtx.pr, ...(facts.htmlUrl !== undefined ? { url: facts.htmlUrl } : {}) },
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
              headSha: facts.headSha ?? repoCtx.headSha,
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
          "closed resume target",
          "not started (PR closed)",
          `🚫 ${where} is closed — there is no review loop to resume. Give ship a task to start fresh work.`,
        );
      }
    }
  }
  if (!task) {
    return refuse(
      "no task",
      "not started (no task)",
      `🚫 Nothing to ship: give ship a task (\`agent:ship in ${repo}: <task>\`), or name an open ship PR by URL to resume its review loop.`,
    );
  }
  // The round-0 base is a user-phrased "on <ref>" or the repo default — never
  // a ref that resolveRepoContext derived from a cited PR's head branch: that
  // PR did not bind as ship's target, so basing the new work on its head would
  // carry the stranger's commits and dangle when the PR merges. The resolver
  // flags such a ref (`refFromPr`) at the source, so this holds even when the
  // facts fetch failed and the head ref is otherwise unknown.
  // Belt-and-braces guard stays: a repo-shaped ref (the slug itself, or any
  // owner/name the API would 404 on as a ref) can only be a misparse —
  // createBranchRef would fail on it. Any of these → the repo's default branch.
  const ref =
    repoCtx.ref && !repoCtx.refFromPr && repoCtx.ref.toLowerCase() !== repo.toLowerCase() ? repoCtx.ref : undefined;
  return {
    ok: true,
    entry: { repo, base: resolveBaseRef([ref], info?.defaultBranch) },
  };
}
