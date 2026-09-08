// The ship pipeline's preflight (docs/reference/specs/agent-ship.md items 1, 2,
// 9, 10): every check that must refuse BEFORE round 0, and the entry it hands
// the round loop — the pipeline branch, the PR base, and whether the loop
// resumes at review on an open PR of ship's own. Pure decisions over injected
// lookups; the orchestrator in shipPipeline.ts runs what this decides.

import { createHash } from "node:crypto";
import { resolveBaseRef, type PullRequestFacts, type RepoShipInfo } from "../../execution/githubPulls.js";
import type { GithubIdentity } from "../../execution/githubApp.js";
import type { RepoContext } from "../repoContext.js";

// ---- identity + naming -------------------------------------------------------

// Ship-driven PRs are authored by the identity this process acts as — the App's
// bot user, resolved from GitHub (`ShipPreflightInput.selfIdentity`, backed by
// githubApp's `resolveGithubIdentity`), matched by BOTH login and the immutable
// numeric user id. A PR authored by anyone else is not ship's to drive (spec
// item 10); an identity that cannot be resolved refuses fail-closed. Nothing
// here names an installation's bot, so one image serves every installation.

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

/**
 * The pipeline branch ship names and binds the thread to at round 0's attach:
 * `ship/<task-slug>-<thread-hash>`. Deterministic per (task, thread)
 * — a re-issued task in the same thread lands on the same branch, so the
 * resident's one-ref-per-thread binding and the PR open-or-edit idempotency
 * both hold across restarts (recreatability, AGENTS.md invariant 6).
 */
export function shipBranchName(task: string, threadKey: string): string {
  const slug =
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "task";
  // sha256 prefix — a stable short discriminator, not a secret.
  const hash = createHash("sha256").update(threadKey).digest("hex").slice(0, 6);
  return `ship/${slug}-${hash}`;
}

// ---- preflight (spec items 1, 2, 9, 10) --------------------------------------

/** What the preflight decided the pipeline starts FROM. */
export interface ShipEntry {
  repo: string;
  /** The pipeline branch (ship-named on round 0; the PR's own head branch on
   *  a resume). Round 0 binds the thread to it at attach (refHint). */
  branch: string;
  /** The PR base branch: the dispatch-resolved ref, else the repo's default
   *  branch. Undefined → the PR post-step reports "no base" honestly. */
  base: string | undefined;
  /** Resume-at-review: the user-named, bot-authored, same-repo open PR. */
  resume?: { pr: number; headSha?: string; url?: string };
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
  /** Repo facts for the gate: auto-merge flag + default branch. Undefined =
   *  unknown → refused fail-closed. */
  repoInfo: (repo: string) => Promise<RepoShipInfo | undefined>;
  /** PR facts for the entry checks. Undefined = unknown → refused fail-closed. */
  prFacts: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  /** The GitHub identity this process acts as — what ship's own PRs are authored
   *  by. Undefined = unknown → a PR's authorship cannot be judged → refused fail-closed. */
  selfIdentity: () => Promise<GithubIdentity | undefined>;
  /** PUBLIC_BASE_URL, for the run-page pointer in the channel refusal. */
  runsBase?: string;
}

const refuse = (where: string, card: string, reply: string): ShipPreflightResult => ({ ok: false, where, card, reply });

/**
 * Every check that must refuse BEFORE round 0, in order: channel, compound
 * permission gate, repo present, auto-merge (fail-closed on unknown), then
 * the entry checks that decide round 0 vs resume-at-review. Never throws —
 * the injected lookups' failures are treated as unknown (fail-closed).
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
  // Spec item 9: the approving verdict's LGTM line triggers the org
  // auto-approve workflow; with auto-merge on, the PR would merge with no
  // human having read it. Unknown (lookup failed, field absent) = refused.
  const info = await input.repoInfo(repo).catch(() => undefined);
  if (info?.allowAutoMerge !== false) {
    const reason =
      info?.allowAutoMerge === true
        ? `auto-merge is enabled on \`${repo}\` — ship's approving LGTM triggers the org auto-approve workflow, and with auto-merge on the PR would merge with no human. Disable auto-merge on the repo to use ship.`
        : `could not verify that auto-merge is disabled on \`${repo}\` (the repository lookup failed or answered without the setting) — refusing fail-closed.`;
    return refuse("auto-merge", "not started (auto-merge)", `🚫 ${reason}`);
  }
  // Entry checks (spec item 10). The thread→PR inference reads USER turns only
  // (repoContext.ts), so `repoCtx.pr` set means a user turn named the PR.
  const task = shipTaskText(input.requestText, repo);
  if (repoCtx.prUnpostable?.reason === "unreachable") {
    return refuse(
      "thread PR unreachable",
      "not started (PR unverifiable)",
      `🚫 This thread names PR ${repo}#${repoCtx.prUnpostable.number} but it could not be fetched to run ship's entry checks — refusing fail-closed. Retry in a moment, or check the PR on GitHub.`,
    );
  }
  if (repoCtx.pr !== undefined) {
    const where = `${repo}#${repoCtx.pr}`;
    const facts = await input.prFacts({ repo, number: repoCtx.pr }).catch(() => undefined);
    // A cited PR whose facts we cannot fetch is fail-closed — EXCEPT the
    // fall-through case: a PR named in THIS message and quoted as
    // evidence inside NEW task text is context, not the target, so a transient
    // fetch failure must not block the task. It falls through to round 0 below,
    // which drops the PR-derived ref (repoCtx.refFromPr) and starts a fresh
    // deterministic ship branch off the default branch — the cited PR's commits
    // are never touched. Kept fail-closed: an INHERITED PR (prFromMessage
    // unset — the thread's own in-flight PR), or a BARE in-message reference
    // (no task = a resume attempt, which must verify the PR before resuming).
    const fallThrough = !facts && task !== "" && repoCtx.prFromMessage === true;
    if (!facts && !fallThrough) {
      return refuse(
        "PR facts unavailable",
        "not started (PR unverifiable)",
        `🚫 Could not fetch ${where} to run ship's entry checks (open? bot-authored? same-repo head?) — refusing fail-closed. Retry in a moment.`,
      );
    }
    if (facts) {
      // Whose PR is it? Judged against the identity this process acts as (the App's
      // bot user, or a static token's user) — resolved from GitHub, never named here. Unknown
      // identity = the question cannot be answered = refused fail-closed, on
      // every path that needs the answer (an open PR).
      const self = facts.state === "open" ? await input.selfIdentity().catch(() => undefined) : undefined;
      if (facts.state === "open" && !self) {
        return refuse(
          "own identity unavailable",
          "not started (identity unverifiable)",
          `🚫 Could not resolve the GitHub identity this bot acts as, so whether ${where} is ship's to drive cannot be judged — refusing fail-closed. Retry in a moment.`,
        );
      }
      const author = facts.author;
      const shipAuthored = self !== undefined && author?.login === self.login && author?.id === self.id;
      if (facts.state === "open" && !(task && !shipAuthored)) {
        // Binding rule: a PR quoted as evidence inside a NEW task is not
        // the PR to drive — with task text present, someone ELSE's PR mention
        // does not bind; execution falls through to round 0 below and the
        // reference stays in the task text as context for the coding child.
        if (task) {
          // Ship's OWN open PR + new task text: the refusal protecting the
          // thread's in-flight PR is still correct.
          return refuse(
            "new task over open PR",
            "not started (open PR)",
            `🚫 This thread's PR ${where} is still open — a new task over it is refused. Re-issue \`agent:ship\` with only the PR URL to resume its review loop, or finish/close ${where} and start the new task in a fresh thread.`,
          );
        }
        // A bare PR reference (no task text) IS a resume request — authorship
        // decides whether it is ship's to drive (spec item 10).
        if (!shipAuthored) {
          return refuse(
            "human-authored PR",
            "not started (not ship's PR)",
            `🚫 ${where} was not authored by \`${self!.login}\` (this bot) — it is not ship's to drive. Use \`agent:review\` for a one-off review, or drive the loop manually.`,
          );
        }
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
        return {
          ok: true,
          entry: {
            repo,
            branch,
            // The PR's OWN base wins on resume: a ship PR opened against a
            // non-default base must not run its re-reviews (or re-open a closed
            // PR) against the default branch. repoCtx.baseRef carries the same
            // fact when the thread context resolved the PR; the default branch
            // is the last resort.
            base: resolveBaseRef([facts.baseRef, repoCtx.baseRef], info.defaultBranch),
            resume: {
              pr: repoCtx.pr,
              headSha: facts.headSha ?? repoCtx.headSha,
              ...(facts.htmlUrl !== undefined ? { url: facts.htmlUrl } : {}),
            },
          },
        };
      }
      // A closed/merged PR is done — the thread may start a fresh task below.
    }
    // Otherwise `facts` is undefined and this is the fall-through (an
    // in-message PR cited as evidence in new task text): execution drops to the
    // round-0 return below, which starts a fresh ship branch off the default
    // branch and leaves the reference in the task text for the coding child.
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
    entry: { repo, branch: shipBranchName(task, input.threadKey), base: resolveBaseRef([ref], info.defaultBranch) },
  };
}
