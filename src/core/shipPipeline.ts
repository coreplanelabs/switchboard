// The agent:ship pipeline (features/agent-ship.md, issue #131): the coding →
// review → fix loop to LGTM as ONE dispatch — one card, one run record, N
// strictly serial child rounds, every GitHub side effect executed by the bot
// process from typed artifacts. `dispatch()` forks in here (runShipBranch in
// dispatcher.ts) after agent resolution and the repo gates; this module owns
// the preflight decisions and the round loop, parameterized on explicit
// inputs like the reviewRound units, so the dispatcher stays legible.
//
// Boundaries this module enforces (spec items 1–2, 9, 11):
//   - Slack and the CLI only — single-shot adapters (HTTP /ingress, MCP) are
//     refused with a pointer to the runs page before anything starts.
//   - Compound permission gate: ship ∧ coding ∧ review (the repo leg already
//     ran in the dispatcher — the fork sits after `canUseRepo`).
//   - A target repo with auto-merge enabled is refused up front (the
//     approving LGTM triggers the org auto-approve workflow; with auto-merge
//     on, the PR would merge with no human). Unknown = refused (fail-closed).
//   - Resident-only v1: a round that cannot attach a resident worktree ends
//     the pipeline with a plain report — never a cold per-round clone.
//   - Ship's bot-process GitHub writes are exactly the round-0 branch create
//     (githubPulls.createBranchRef), the PR open/edit (githubPulls), and the
//     pinned review post (runReviewPostStep) — no merge endpoint is reachable
//     from any code path here.
//   - Thread follow-ups steer the pipeline like every agent (thread-admission
//     item 2): the dispatcher's one per-thread inbox is handed to EVERY child
//     round's runner, so a reply lands on whichever child is in flight at its
//     next step, and a reply between rounds is read by the next child. The
//     orchestrator itself never reads the inbox — it has no model turn.

import { createHash } from "node:crypto";
import type { AgentDef } from "../agents/registry.js";
import type { Effort } from "../effort.js";
import { runAgent } from "../runner.js";
import type { ChatMessage, Provider } from "../providers/types.js";
import type { ExecutorFactoryOptions } from "../execution/factory.js";
import {
  resolveBaseRef,
  type OpenedPullRequest,
  type PullRequestFacts,
  type PullRequestTarget,
  type RepoShipInfo,
} from "../execution/githubPulls.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
import type { ToolContext } from "../tools/workspace.js";
import type { WebCapability } from "../tools/web.js";
import type { GithubCapability } from "../tools/github.js";
import type { SkillStore } from "../skills/index.js";
import type { PrDescription } from "./prDescription.js";
import { formatFinding, type Finding, type FindingDisposition, type ReviewVerdict } from "./reviewVerdict.js";
import type { RepoContext } from "./repoContext.js";
import type { RunEvent, ShipRoundOutcome } from "./runEvents.js";
import type { RunControl } from "./runRegistry.js";
import type { FollowUpInbox } from "./threadAdmission.js";
import { normalizeHead, sameCommit } from "./reviewedHead.js";
import { observeCodingWorkspace, runCodingPrPostStep, trackPushedBranch } from "./codingPrPostStep.js";
import {
  attachRoundWorkspace,
  checkPrHeadPreflight,
  guardAttachedHead,
  makeSystemComposer,
  runReviewPostStep,
  settleReviewedHead,
  type FetchPrCommits,
  type FetchPrHead,
  type ReviewPostOutcome,
} from "./reviewRound.js";

// ---- config (`ship` block, features/agent-ship.md item 8) -------------------

/** The `ship` config block: pipeline caps, resolved at deployment level like
 *  the sibling `review` block (no per-scope layering exists for these blocks —
 *  a per-thread cap override is a follow-up if live runs want one). */
export interface ShipConfig {
  /** Review rounds per pipeline (>= 1). Default 3. */
  maxRounds?: number;
  /** Pipeline wall-clock budget in minutes (>= 1). Default 120. */
  maxMinutes?: number;
}

export interface ShipCaps {
  maxRounds: number;
  maxMinutes: number;
}

export const SHIP_DEFAULT_MAX_ROUNDS = 3;
export const SHIP_DEFAULT_MAX_MINUTES = 120;

export function resolveShipCaps(cfg: ShipConfig | undefined): ShipCaps {
  return {
    maxRounds: cfg?.maxRounds ?? SHIP_DEFAULT_MAX_ROUNDS,
    maxMinutes: cfg?.maxMinutes ?? SHIP_DEFAULT_MAX_MINUTES,
  };
}

/** A round is dispatched only when at least this much of the pipeline budget
 *  remains (the reservation check, spec item 8): a child clipped below this
 *  cannot do useful work, so the pipeline reports the cap instead of burning
 *  an attach + model turn on a doomed round. */
export const SHIP_ROUND_RESERVE_MS = 3 * 60_000;

// ---- identity + naming -------------------------------------------------------

/** The App bot user ship-driven PRs are authored by, matched by BOTH login and
 *  the immutable numeric user id — mirroring how the org auto-approve workflow
 *  (.github/workflows/auto-approve-claude-lgtm.yml) pins the same identity. A
 *  PR authored by anyone else is not ship's to drive (spec item 10). */
export const SHIP_PR_AUTHOR = { login: "coreplane-switchboard[bot]", id: 318072483 } as const;

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
 * The pipeline branch ship names and binds the thread to at round 0's attach
 * (KTD12): `ship/<task-slug>-<thread-hash>`. Deterministic per (task, thread)
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
  repoCtx: Pick<RepoContext, "repo" | "pr" | "ref" | "baseRef" | "headSha" | "prUnpostable">;
  gates: { canRunAgent: (agent: string) => boolean; adminsHint: () => string };
  /** Repo facts for the gate: auto-merge flag + default branch. Undefined =
   *  unknown → refused fail-closed. */
  repoInfo: (repo: string) => Promise<RepoShipInfo | undefined>;
  /** PR facts for the entry checks. Undefined = unknown → refused fail-closed. */
  prFacts: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
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
  // Spec item 2 (KTD6): child rounds never re-enter dispatch(), so without the
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
  // Spec item 9 (R15): the approving verdict's LGTM line triggers the org
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
    if (!facts) {
      return refuse(
        "PR facts unavailable",
        "not started (PR unverifiable)",
        `🚫 Could not fetch ${where} to run ship's entry checks (open? bot-authored? same-repo head?) — refusing fail-closed. Retry in a moment.`,
      );
    }
    if (facts.state === "open") {
      // Authorship first: a human-authored PR is never ship's to drive, so
      // the refusal must say THAT — refusing on "new task over open PR" first
      // would advise a PR-URL resume that the author check then rejects.
      const author = facts.author;
      if (!(author?.login === SHIP_PR_AUTHOR.login && author?.id === SHIP_PR_AUTHOR.id)) {
        return refuse(
          "human-authored PR",
          "not started (not ship's PR)",
          `🚫 ${where} was not authored by \`${SHIP_PR_AUTHOR.login}\` — it is not ship's to drive. Use \`agent:review\` for a one-off review, or drive the loop manually.`,
        );
      }
      if (task) {
        return refuse(
          "new task over open PR",
          "not started (open PR)",
          `🚫 This thread's PR ${where} is still open — a new task over it is refused. Re-issue \`agent:ship\` with only the PR URL to resume its review loop, or finish/close ${where} and start the new task in a fresh thread.`,
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
  if (!task) {
    return refuse(
      "no task",
      "not started (no task)",
      `🚫 Nothing to ship: give ship a task (\`agent:ship in ${repo}: <task>\`), or name an open ship PR by URL to resume its review loop.`,
    );
  }
  // Belt-and-braces under the repoContext fix: a base that is repo-shaped
  // (the slug itself, or any owner/name the API would 404 on as a ref) can
  // only be a misparse — createBranchRef would fail on it. Fall back to the
  // repo's default branch rather than aborting round 0 on bad prose.
  const ref = repoCtx.ref && repoCtx.ref.toLowerCase() !== repo.toLowerCase() ? repoCtx.ref : undefined;
  return {
    ok: true,
    entry: { repo, branch: shipBranchName(task, input.threadKey), base: resolveBaseRef([ref], info.defaultBranch) },
  };
}

// ---- round visibility (spec item 12) ------------------------------------------

/** The card's orchestrator-owned round header for a `ship_round` boundary:
 *  `Round 0 — coding` / `Round 1 — review` / `Round 1 — fix` (a fix round
 *  shares its review round's index; a coding round above index 0 IS a fix
 *  round). Lives here so the phase derivation sits next to the round
 *  vocabulary that produces the indexes. */
export function shipRoundHeader(round: { index: number; agent: string }): string {
  const phase = round.agent === "review" ? "review" : round.index === 0 ? "coding" : "fix";
  return `Round ${round.index} — ${phase}`;
}

// ---- synthesized child turns (spec items 5, 7) --------------------------------

/** The review child's one user turn. Re-review rounds carry the prior findings
 *  and the fix round's dispositions; the `re-review-delta` skill (scoped to the
 *  review agent) narrows READING only — the verdict still covers the full diff. */
export function buildShipReviewTurn(input: {
  where: string;
  round: number;
  headSha?: string;
  prior?: { findings: Finding[]; dispositions: FindingDisposition[] };
}): string {
  const at = input.headSha ? ` at head \`${input.headSha}\`` : "";
  if (input.round <= 1 || !input.prior) {
    return `Review pull request ${input.where}${at}. Submit your verdict with findings via submit_verdict before your final message.`;
  }
  const findings = input.prior.findings.map(formatFinding).join("\n") || "(none recorded)";
  const dispositions =
    input.prior.dispositions.map((d) => `${d.findingId}: ${d.disposition}${d.note ? ` — ${d.note}` : ""}`).join("\n") ||
    "(none recorded)";
  return (
    `Re-review pull request ${input.where}${at} — review round ${input.round} of this ship pipeline. ` +
    `Load the \`re-review-delta\` skill: narrow your READING to the delta since the previously reviewed head and verify each prior finding's disposition, ` +
    `but your verdict still covers the full diff against base. Carry every unresolved prior finding forward under its existing id.\n\n` +
    `Previous round's findings:\n${findings}\n\nFix round's dispositions:\n${dispositions}`
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

// ---- the round loop (spec items 3–8) ------------------------------------------

/** One child round's resolved coordinates: the child agent's def and the
 *  model/effort the config layers resolved FOR THAT AGENT (a `model:` or
 *  `effort:` directive on the ship request wins, like any request). */
export interface ShipChildSpec {
  agent: AgentDef;
  provider: Provider;
  /** `<provider>/<model>` as resolved — for the child's config-awareness block. */
  modelRef: string;
  model: string;
  effort?: Effort;
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

/** The advisory/system blocks composed into one child's prompt (the same seam
 *  the dispatcher uses: memory → config awareness → instructions → agent). */
export interface ShipBlocks {
  memory: string | undefined;
  config: string | undefined;
  /** The self-description block (routing-and-config behavior 11). */
  about?: string | undefined;
  instructions: string | undefined;
  skills: string | undefined;
}

export interface ShipGithub {
  /** Round 0's pipeline-branch create (`refs/heads/<branch>` at the base
   *  tip): the ref must exist on origin BEFORE the first attach, or the
   *  resident refuses the binding. Idempotent — 422 already-exists is
   *  success inside the implementation. Throws on any real failure. */
  createBranchRef: (repo: string, branch: string, fromRef: string) => Promise<void>;
  openPullRequest: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  postReviewComment: (target: ReviewCommentTarget, body: string) => Promise<void>;
  fetchPrHead: FetchPrHead;
  fetchPrCommits: FetchPrCommits;
  prFacts: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  /** The repo's default branch — the PR base of last resort (resolveBaseRefLazy,
   *  githubPulls.ts), threaded into the pipeline's own runCodingPrPostStep call
   *  below. In practice `entry.base` is already resolved by shipPreflight, so
   *  this fires only on the rare resume where that lookup itself failed. */
  fetchRepoShipInfo: (repo: string) => Promise<RepoShipInfo | undefined>;
}

export interface ShipPipelineInput {
  entry: ShipEntry;
  /** Round 0's message list (thread history + the task turn), built by the
   *  dispatcher; unused on a resume. Review/fix rounds synthesize their own. */
  round0Messages: ChatMessage[];
  /** Resolve one child round's agent/provider/model/effort. */
  child: (name: "coding" | "review") => ShipChildSpec;
  /** The prompt blocks for one child (skills are scoped per child agent). */
  blocks: (spec: ShipChildSpec) => ShipBlocks;
  factory: ExecutorFactoryOptions;
  threadKey: string;
  caps: ShipCaps;
  control: RunControl;
  /** The thread's follow-up inbox (features/thread-admission.md): handed to
   *  every child round's runner so a reply during the pipeline is read by the
   *  child in flight at its next step. Absent (tests) → children run as
   *  without follow-ups. */
  inbox?: FollowUpInbox;
  /** Run-visibility event sink (registry + card refresh). */
  onEvent: (event: RunEvent) => void;
  onProgress: (note: string) => void;
  /** The card checklist hook children drive through update_status. */
  reportProgress: (checklist: string) => void;
  /** Registry publish for events the pipeline owns (typed artifacts:
   *  pr_description, pr_opened; the ship_round boundaries) — the dispatcher's
   *  hook also feeds the card's round header off the `ship_round` events. */
  publish: (event: RunEvent) => void;
  /** Thread reply for mid-pipeline notes (review-post notes, the PR link). */
  reply: (text: string) => Promise<void>;
  web?: WebCapability;
  skills?: SkillStore;
  /** The `github_*` tools' capability for the child runs (features/github-tools.md). */
  githubTools?: GithubCapability;
  github: ShipGithub;
  /** Deep string-leaf redaction for the published pr_description event (the
   *  dispatcher passes its own, so ship and plain coding publish ONE shape). */
  redactDescription: (d: PrDescription) => PrDescription;
  logKey: string;
  now?: () => number;
}

/** How the pipeline ended, as the dispatcher's shell consumes it: the truthful
 *  ending kind and the one reply the thread gets. Refusals never get here —
 *  they are preflight results. An unexpected throw propagates instead.
 *  `completed` means the pipeline delivered its outcome (merge-ready, or a
 *  report it chose to end on); `aborted` names an early ending with a reason;
 *  `capped` a round/wall-clock ceiling; `stopped_*` an operator stop. The
 *  dispatcher maps these onto the run-record vocabulary and the card close —
 *  only `completed` closes ✅ with a checked-off checklist. */
export interface ShipOutcome {
  status: "completed" | "aborted" | "capped" | "stopped_soft" | "stopped_hard";
  reply: string;
}

interface CodingRoundResult {
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
  residentUnavailable?: string;
}

interface ReviewRoundResult {
  refusal?: string;
  residentUnavailable?: string;
  verdict?: ReviewVerdict;
  answer?: string;
  reviewHead?: string;
  /** Whether the round's verdict actually landed on the PR — the merge-ready
   *  gate consumes it (an approve whose post failed approves nothing). */
  reviewPost?: ReviewPostOutcome;
}

/**
 * The strictly serial round loop (KTD2/KTD8/KTD12): round 0 opens the PR
 * through the coding PR gate, then review → fix repeats until an approve
 * verdict, a cap, an abort terminal, or an operator stop. Each child runs on
 * its own agent's budgets CLIPPED to the remaining pipeline wall clock; the
 * run's `RunControl` is checked between rounds so a stop never starts one.
 */
export async function runShipPipeline(input: ShipPipelineInput): Promise<ShipOutcome> {
  const now = input.now ?? Date.now;
  const { entry, caps, control, github, logKey } = input;
  // Read at CALL time behind a function boundary: a stop can land during any
  // await, and TS's property narrowing must not freeze an earlier read.
  const hardStopped = () => control.requested === "hard";
  const deadlineAt = now() + caps.maxMinutes * 60_000;
  const remainingMs = () => deadlineAt - now();
  /** Never mutate the shared AgentDef — children run a clipped COPY. */
  const clip = (def: AgentDef): AgentDef => ({
    ...def,
    maxMinutes: Math.min(def.maxMinutes, Math.max(remainingMs(), 0) / 60_000),
  });

  /** Findings per review round and dispositions per fix round, both keyed by
   *  the REVIEW round they belong to. Finding ids are only unique WITHIN one
   *  round — a later review may reuse an id for a brand-new finding — so one
   *  flat map would let a stale disposition claim a finding it never
   *  addressed. Earlier rounds' records stay for lookback (and any history
   *  line a report wants). */
  const findingsByRound = new Map<number, Finding[]>();
  const dispositionsByRound = new Map<number, Map<string, FindingDisposition>>();
  /** The same finding across rounds: matching id plus the content that
   *  identifies it (severity/file/title — line excluded, fixes shift lines).
   *  A reused id over different content is a different finding. */
  const sameFinding = (a: Finding, b: Finding) => a.severity === b.severity && a.file === b.file && a.title === b.title;
  /** The disposition that answers `finding` as review round `round` listed
   *  it: that round's own fix-round record when one exists, else walk earlier
   *  rounds while the finding was carried forward unchanged — never across a
   *  reused id, which inherits nothing. */
  const dispositionFor = (finding: Finding, round: number): FindingDisposition | undefined => {
    let cur = finding;
    for (let r = round; r >= 1; r--) {
      const d = dispositionsByRound.get(r)?.get(cur.id);
      if (d) return d;
      const carriedFrom = findingsByRound.get(r - 1)?.find((p) => p.id === cur.id && sameFinding(p, cur));
      if (!carriedFrom) return undefined;
      cur = carriedFrom;
    }
    return undefined;
  };
  let lastFindings: Finding[] = [];
  let reviewRounds = 0;
  let prNumber = entry.resume?.pr;
  let prUrl =
    entry.resume?.url ?? (prNumber !== undefined ? `https://github.com/${entry.repo}/pull/${prNumber}` : undefined);
  let lastReviewHead: string | undefined = entry.resume?.headSha;

  const roundsLine = () => `${reviewRounds} review round${reviewRounds === 1 ? "" : "s"}`;
  const reissue = () =>
    `To continue, re-issue \`agent:ship\` in this thread${prUrl ? ` and include the PR URL (${prUrl})` : " — include the PR URL if a PR exists"}.`;
  // The round boundary (spec item 12): one `started` event when a round's
  // child is dispatched, one settle event when its outcome is known —
  // published on the one stream, so per-round cost is derivable by slicing
  // `turn` events between boundaries (the dispatcher's publish hook also
  // drives the card's round header off these).
  const emitRound = (index: number, agentName: "coding" | "review", outcome: ShipRoundOutcome) => {
    console.log(`[ship] ${logKey} round ${index} (${agentName}) ${outcome}`);
    input.publish({ type: "ship_round", index, agent: agentName, outcome, at: now() });
  };

  const stoppedOutcome = (tail?: string): ShipOutcome => {
    const mode = control.requested === "hard" ? "hard" : "soft";
    return {
      status: mode === "hard" ? "stopped_hard" : "stopped_soft",
      reply: [
        `${mode === "hard" ? "⛔" : "⏹"} Ship stopped by operator (${mode} stop) after ${roundsLine()}.${prUrl ? ` PR: ${prUrl}` : ""}`,
        tail,
        reissue(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  };

  const residentOutcome = (note: string): ShipOutcome => ({
    status: "aborted",
    reply:
      `📦 Ship needs a warm resident worktree for \`${entry.repo}\` and none is available (${note}). ` +
      `Ship v1 never falls back to cold per-round clones — onboard the repo as a resident (\`repo onboard ${entry.repo}\`) and re-issue ship.\n\n${reissue()}`,
  });

  const abortOutcome = (reason: string, tail?: string): ShipOutcome => ({
    status: "aborted",
    reply: [reason, tail, `⚠️ Ship aborted after ${roundsLine()}.`, reissue()].filter(Boolean).join("\n\n"),
  });

  /** The cap report's declined-vs-unaddressed split over the LAST review
   *  round's open findings (spec item 8), each answered only by a disposition
   *  recorded FOR it — its own round's, or one carried forward unchanged
   *  (`dispositionFor`): declined = a `declined` disposition; unaddressed =
   *  none; a finding claimed fixed but still flagged is named as such. */
  const splitReport = (): string => {
    // No review round ran → there are no findings to split; three "none"
    // lists under "Open findings from the last review (0)" would read as a
    // review that found nothing rather than a review that never happened.
    if (reviewRounds === 0) return "No review round ran before the cap — there are no findings to report.";
    const withDisposition = (f: Finding) => dispositionFor(f, reviewRounds);
    const declined = lastFindings.filter((f) => withDisposition(f)?.disposition === "declined");
    const unaddressed = lastFindings.filter((f) => !withDisposition(f));
    const claimedFixed = lastFindings.filter((f) => withDisposition(f)?.disposition === "fixed");
    const list = (items: Finding[], note?: (f: Finding) => string) =>
      items.length > 0
        ? items.map((f) => `  - ${formatFinding(f)}${note ? ` — ${note(f)}` : ""}`).join("\n")
        : "  - none";
    const lines = [
      `Open findings from the last review (${lastFindings.length}):`,
      `Declined (disposition recorded):\n${list(declined, (f) => withDisposition(f)?.note || "no note")}`,
      `Unaddressed (no disposition):\n${list(unaddressed)}`,
    ];
    if (claimedFixed.length > 0)
      lines.push(
        `Claimed fixed but still flagged:\n${list(claimedFixed, (f) => withDisposition(f)?.note || "no note")}`,
      );
    return lines.join("\n");
  };

  const capOutcome = (reason: string): ShipOutcome => ({
    status: "capped",
    reply: [
      `🧢 Ship stopped at a cap: ${reason} — no approval after ${roundsLine()}.${prUrl ? ` PR: ${prUrl}` : ""}`,
      splitReport(),
      reissue(),
    ].join("\n\n"),
  });
  const wallClockCap = () =>
    capOutcome(
      `the remaining pipeline time (~${Math.max(0, Math.round(remainingMs() / 60_000))} min of the ${caps.maxMinutes}-minute budget) cannot hold another round`,
    );

  // ---- one coding child (round 0, and every fix round) ----------------------
  const runCodingChild = async (opts: {
    messages: ChatMessage[];
    knownFindingIds?: string[];
    attachHeadSha?: string;
  }): Promise<CodingRoundResult> => {
    const spec = input.child("coding");
    const ws = await attachRoundWorkspace({
      factory: input.factory,
      round: {
        threadKey: input.threadKey,
        agent: spec.agent,
        repo: entry.repo,
        ref: entry.branch,
        headSha: opts.attachHeadSha,
      },
      logKey,
    });
    const { executor, resident, binding, note } = ws.selection;
    if (resident !== true) {
      await ws.release({ hardStopped: false });
      return { answer: "", residentUnavailable: note ?? "no resident worktree attached" };
    }
    // KTD12 honesty (mirrors guardAttachedHead): the resident binds ONE ref
    // per thread at first attach and ignores later hints — a thread already
    // bound to another branch would code, push, and open-or-edit somewhere
    // the pipeline never looks. Refuse BEFORE any model call, naming both
    // refs; an attach that answered no ref proves nothing and proceeds.
    if (binding?.ref !== undefined && binding.ref !== entry.branch) {
      await ws.release({ hardStopped: false });
      return {
        answer: "",
        refusal:
          `🔀 Ship round not started: this thread's worktree is bound to \`${binding.ref}\`, but the pipeline branch is \`${entry.branch}\` — ` +
          `the resident binds one ref per thread at its first attach, so this thread cannot drive the ship branch. Start ship in a fresh thread.`,
      };
    }
    let description: PrDescription | undefined;
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
    // The branch the child's own `git push` named (pr-description item 5,
    // #458): the post-step opens from it, and from the checkout only when no
    // push was observed. The latest push wins.
    const pushes = trackPushedBranch();
    try {
      answer = await runAgent({
        provider: spec.provider,
        model: spec.model,
        agent: clip(spec.agent),
        messages: opts.messages,
        // The branch contract OVERRIDES the coding prompt's generic "create a
        // branch" step — the first live run (2026-09-03) followed that step,
        // pushed its own branch, and stranded the pipeline: the thread's
        // binding stays on the ship branch, so the review round can never see
        // a PR opened from anywhere else.
        system: `${composeSystem({ sha: undefined, verified: false })}\n\n${shipBranchContract(entry.branch)}`,
        effort: spec.effort,
        toolContext,
        onProgress: input.onProgress,
        onEvent: (e) => {
          pushes.observe(e);
          input.onEvent(e);
        },
        control,
        inbox: input.inbox,
      });
      // A hard stop tore the work down mid-flight — observe nothing, post nothing.
      const pushedBranch = pushes.branch();
      if (control.requested !== "hard")
        observed = await observeCodingWorkspace(executor, {
          probeRemote: false,
          ...(pushedBranch !== undefined ? { pushedBranch } : {}),
        });
    } finally {
      await ws.release({ hardStopped: control.requested === "hard" });
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
        // The base is the PR's true base (entry.base) — NEVER the thread's
        // resident binding ref, which ship bound to the HEAD branch itself.
        target: { repo: entry.repo, baseRef: entry.base, bindingRef: undefined, resolvedRef: undefined },
        openPullRequest: github.openPullRequest,
        fetchRepoInfo: github.fetchRepoShipInfo,
        publish: (e) => {
          if (e.type === "pr_opened") opened = { number: e.number, url: e.url, created: e.created };
          input.publish(e);
        },
        logKey,
      });
    }
    return {
      answer,
      ...(prNote !== undefined ? { prNote } : {}),
      ...(opened !== undefined ? { opened } : {}),
      ...(observed?.head !== undefined ? { headSha: observed.head } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(roundDispositions !== undefined ? { dispositions: roundDispositions } : {}),
    };
  };

  // ---- one review child (pinned head, extracted units) ----------------------
  const runReviewChild = async (round: number): Promise<ReviewRoundResult> => {
    const spec = input.child("review");
    const pr = { repo: entry.repo, number: prNumber! };
    let pinned = normalizeHead(await github.fetchPrHead(pr).catch(() => undefined));
    // Unknown head is a guaranteed downstream refusal — reuse the extracted
    // pre-flight so the refusal reply has ONE wording.
    const pf = checkPrHeadPreflight({
      agent: spec.agent,
      requestText: "",
      repoCtx: { repo: entry.repo, pr: prNumber, headSha: pinned },
    });
    if (!pf.ok) return { refusal: pf.reply };
    const ws = await attachRoundWorkspace({
      factory: input.factory,
      round: { threadKey: input.threadKey, agent: spec.agent, repo: entry.repo, ref: entry.branch, headSha: pinned },
      logKey,
    });
    const { executor, resident, binding, note } = ws.selection;
    if (resident !== true) {
      await ws.release({ hardStopped: false });
      return { residentUnavailable: note ?? "no resident worktree attached" };
    }
    let settled: Awaited<ReturnType<typeof settleReviewedHead>> | undefined;
    let verdict: ReviewVerdict | undefined;
    try {
      let verified = false;
      const guard = await guardAttachedHead({
        pr,
        expectedHeadSha: pinned,
        attached: { sha: binding?.sha, ref: binding?.ref },
        fallbackRef: entry.branch,
        fetchPrHead: github.fetchPrHead,
        logKey,
      });
      if (guard.outcome === "refused") return { refusal: guard.reply };
      if (guard.outcome === "adopted") {
        pinned = guard.headSha;
        verified = true;
      } else if (guard.outcome === "verified") {
        verified = true;
      }
      const toolContext: ToolContext = {
        executor,
        reportProgress: input.reportProgress,
        web: input.web,
        skills: input.skills,
        github: input.githubTools,
        agentName: spec.agent.name,
        onVerdict: (v) => {
          verdict = v;
        },
      };
      const composeSystem = makeSystemComposer({
        agent: spec.agent,
        resident: true,
        repo: entry.repo,
        workspace: binding?.workspace,
        prTarget: { repo: entry.repo, pr: pr.number, ref: entry.branch, baseRef: entry.base },
        blocks: input.blocks(spec),
      });
      const clipped = clip(spec.agent);
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildShipReviewTurn({
                where: `${entry.repo}#${pr.number}`,
                round,
                headSha: pinned,
                // The PREVIOUS review round's findings with THAT round's
                // dispositions — never an accumulated flat set, where a
                // reused finding id would drag an old disposition along.
                prior:
                  round > 1
                    ? {
                        findings: findingsByRound.get(round - 1) ?? [],
                        dispositions: [...(dispositionsByRound.get(round - 1)?.values() ?? [])],
                      }
                    : undefined,
              }),
            },
          ],
        },
      ];
      const answer = await runAgent({
        provider: spec.provider,
        model: spec.model,
        agent: clipped,
        messages,
        system: composeSystem({ sha: pinned, verified }),
        effort: spec.effort,
        toolContext,
        onProgress: input.onProgress,
        onEvent: input.onEvent,
        control,
        inbox: input.inbox,
      });
      if (control.requested === "hard") return { answer };
      settled = await settleReviewedHead({
        pr,
        baseRef: entry.base,
        reviewHead: pinned,
        verdict,
        answer,
        messages,
        composeSystem,
        executor,
        turn: {
          provider: spec.provider,
          model: spec.model,
          agent: clipped,
          effort: spec.effort,
          toolContext,
          onProgress: input.onProgress,
          onEvent: input.onEvent,
          control,
        },
        fetchPrHead: github.fetchPrHead,
        fetchPrCommits: github.fetchPrCommits,
        notify: { reply: input.reply, headMoved: (suffix) => input.onProgress(`head moved: ${suffix}`) },
        logKey,
      });
    } finally {
      await ws.release({ hardStopped: control.requested === "hard" });
    }
    // Unreachable: every path that leaves `settled` unassigned returned above
    // (guard refusal, hard stop) — this narrows the type for what follows.
    if (!settled) return {};
    // The pinned review post (extracted unit): posts only when the reviewed
    // head IS the pinned head, says every skip out loud, never throws. Its
    // typed outcome rides back to the loop — the merge-ready gate stands on
    // a POSTED approval, not on a verdict that never reached the PR.
    const reviewPost = await runReviewPostStep({
      agent: spec.agent,
      requestText: "",
      repoCtx: { repo: entry.repo, pr: prNumber },
      heads: { reviewHead: settled.reviewHead, observedHead: settled.observedHead },
      verdict: settled.verdict,
      answer: settled.answer,
      carried: settled.carried,
      hardStopped: hardStopped(),
      post: github.postReviewComment,
      fetchPrHead: github.fetchPrHead,
      reply: input.reply,
      logKey,
    });
    return { verdict: settled.verdict, answer: settled.answer, reviewHead: settled.reviewHead, reviewPost };
  };

  const mergeReady = async (verdict: ReviewVerdict): Promise<ShipOutcome> => {
    // Re-check the PR (spec item 9) — the LGTM already triggered the org
    // auto-approve workflow, so the report must say what is left. Three
    // honest answers: still open (a human merge remains), no longer open
    // (nothing left), and UNKNOWN — a failed lookup is reported as
    // unverified, never as a closed PR (they mean opposite things to the
    // person holding the merge button).
    const facts = await github.prFacts({ repo: entry.repo, number: prNumber! }).catch(() => undefined);
    const where = prUrl ?? `${entry.repo}#${prNumber}`;
    // The declined findings this approval ratified: the fix round BEFORE the
    // approving review recorded them (an approve with no fix round — round 1,
    // or a resume straight to LGTM — has none). Never the flat all-rounds
    // set, where a reused finding id would resurrect a stale decline.
    const declined = [...(dispositionsByRound.get(reviewRounds - 1)?.values() ?? [])].filter(
      (d) => d.disposition === "declined",
    );
    return {
      status: "completed",
      reply: [
        `✅ Merge-ready after ${roundsLine()}: ${where}`,
        `Verdict: LGTM${verdict.summary ? ` — ${verdict.summary}` : ""}`,
        `Declined findings: ${declined.length > 0 ? declined.map((d) => `${d.findingId}${d.note ? ` — ${d.note}` : ""}`).join("; ") : "none"}`,
        facts === undefined
          ? `Note: approved and posted, but the PR's current state could not be re-verified — check ${where}.`
          : facts.state === "open"
            ? "Remaining gate: a human merge — ship never merges and never approves."
            : "Note: the PR is no longer open (merged or closed since the approval) — nothing is left to merge.",
      ].join("\n"),
    };
  };

  // ---- round 0 ---------------------------------------------------------------
  if (!entry.resume) {
    if (control.requested) return stoppedOutcome();
    if (remainingMs() < SHIP_ROUND_RESERVE_MS) return wallClockCap();
    // The pipeline branch must exist on origin BEFORE the first attach
    // (KTD12): the resident refuses to bind a thread to a ref GitHub does not
    // have, and the executor factory's sandbox fallback would then misreport
    // "onboard the repo" on every fresh pipeline. The BOT creates the ref
    // from the PR base (422 already-exists is success inside createBranchRef
    // — a restarted pipeline reuses its own deterministic branch).
    if (entry.base === undefined) {
      return abortOutcome(
        `⚠️ No base branch is known for \`${entry.repo}\` (none resolved at dispatch, and the repository lookup answered no default), ` +
          `so the pipeline branch \`${entry.branch}\` could not be created and round 0 never started.`,
      );
    }
    try {
      await github.createBranchRef(entry.repo, entry.branch, entry.base);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return abortOutcome(
        `⚠️ Could not create the pipeline branch \`${entry.branch}\` from \`${entry.base}\` on \`${entry.repo}\`: ${reason} — round 0 never started.`,
      );
    }
    emitRound(0, "coding", "started");
    const r0 = await runCodingChild({ messages: input.round0Messages });
    if (r0.residentUnavailable) {
      emitRound(0, "coding", "aborted");
      return residentOutcome(r0.residentUnavailable);
    }
    if (r0.refusal) {
      emitRound(0, "coding", "aborted");
      return abortOutcome(r0.refusal);
    }
    if (r0.opened) {
      // Record the PR FIRST so a stop or terminal below reports its URL.
      prNumber = r0.opened.number;
      prUrl = r0.opened.url;
      lastReviewHead = r0.headSha;
    }
    if (control.requested) {
      emitRound(0, "coding", "stopped");
      return stoppedOutcome(r0.answer);
    }
    if (!r0.opened) {
      // Round-0 terminal other than "PR opened" (spec item 4): the child's
      // final text leads the reply — a clarifying question keeps the thread
      // alive (the user answers and re-enters) — and the terminal is named.
      emitRound(0, "coding", "aborted");
      const terminal = r0.description
        ? "a PR description was submitted but no PR could be opened (the note above says why)"
        : "the coding round ended without submitting a PR description (a clarifying question, a budget write-up, or an unproven push ends the pipeline here)";
      return {
        status: "aborted",
        reply: [r0.answer, r0.prNote, `⚠️ Ship ended at round 0: ${terminal}. No review round ran.`, reissue()]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    emitRound(0, "coding", "pr_opened");
    if (r0.prNote) await input.reply(r0.prNote).catch(() => {});
  }

  // ---- review → fix loop ------------------------------------------------------
  for (;;) {
    if (control.requested) return stoppedOutcome();
    if (reviewRounds >= caps.maxRounds) return capOutcome(`the ${caps.maxRounds}-round cap`);
    if (remainingMs() < SHIP_ROUND_RESERVE_MS) return wallClockCap();
    reviewRounds += 1;
    emitRound(reviewRounds, "review", "started");
    const rv = await runReviewChild(reviewRounds);
    // A stop short-circuits here only when the round settled NO verdict: a
    // verdict that was already posted to the PR is a fact no stop can
    // un-post, so it settles first below and the stop is honored around it.
    if (control.requested && !rv.verdict) {
      emitRound(reviewRounds, "review", "stopped");
      return stoppedOutcome(rv.answer);
    }
    if (rv.residentUnavailable) {
      emitRound(reviewRounds, "review", "aborted");
      return residentOutcome(rv.residentUnavailable);
    }
    if (rv.refusal) {
      emitRound(reviewRounds, "review", "aborted");
      return abortOutcome(rv.refusal);
    }
    if (!rv.verdict) {
      // Spec item 5: a review child that ends without submit_verdict aborts the
      // pipeline — never converted into a request_changes it did not make.
      emitRound(reviewRounds, "review", "no_verdict");
      return abortOutcome(
        `⚠️ Review round ${reviewRounds} ended without a submitted verdict (budget, refusal, or stop) — ship never converts that into a request for changes, so no fix round ran.`,
        rv.answer ? `Review round's final message:\n\n${rv.answer}` : undefined,
      );
    }
    lastFindings = rv.verdict.findings ?? [];
    findingsByRound.set(reviewRounds, lastFindings);
    lastReviewHead = rv.reviewHead ?? lastReviewHead;
    emitRound(reviewRounds, "review", rv.verdict.verdict);
    if (rv.verdict.verdict === "approve") {
      // Merge-ready stands on the POSTED LGTM (spec item 9): an approval
      // whose post failed or was refused left no approving review on the PR,
      // so the pipeline must not report merge-ready over it.
      if (rv.reviewPost !== undefined && !rv.reviewPost.posted) {
        return abortOutcome(
          `⚠️ The review approved, but the approval could not be posted: ${rv.reviewPost.reason} — the PR carries no approving review. ` +
            `Re-run ship in this thread with the PR URL to retry the approval.`,
        );
      }
      return await mergeReady(rv.verdict);
    }
    // request_changes with a stop flagged during the round: the verdict above
    // settled (and posted) — now the stop short-circuits the fix round, and
    // the stopped report says a review is standing on the PR.
    if (control.requested) {
      return stoppedOutcome(
        [
          rv.answer,
          rv.reviewPost?.posted
            ? "ℹ️ A changes-requested review was posted this round before the stop — its findings stand on the PR."
            : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    // request_changes → a fix round, only if its re-review could still run.
    if (reviewRounds >= caps.maxRounds) return capOutcome(`the ${caps.maxRounds}-round cap`);
    if (remainingMs() < SHIP_ROUND_RESERVE_MS) return wallClockCap();
    emitRound(reviewRounds, "coding", "started");
    const fx = await runCodingChild({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildShipFixTurn({
                where: `${entry.repo}#${prNumber}`,
                findings: lastFindings,
                review: rv.answer ?? "",
              }),
            },
          ],
        },
      ],
      knownFindingIds: lastFindings.map((f) => f.id),
      attachHeadSha: lastReviewHead,
    });
    if (fx.residentUnavailable) {
      emitRound(reviewRounds, "coding", "aborted");
      return residentOutcome(fx.residentUnavailable);
    }
    if (fx.refusal) {
      emitRound(reviewRounds, "coding", "aborted");
      return abortOutcome(fx.refusal);
    }
    // The round's dispositions answer THIS review round's findings — keyed by
    // the round, replace semantics (the tool's contract: a later call within
    // the round replaces the earlier one). Recorded before the stop check:
    // they were submitted, a fact a stop does not erase.
    if (fx.dispositions) dispositionsByRound.set(reviewRounds, new Map(fx.dispositions.map((d) => [d.findingId, d])));
    if (control.requested) {
      emitRound(reviewRounds, "coding", "stopped");
      return stoppedOutcome(fx.answer);
    }
    // A fix round that opened a NEW PR (the old one was closed out from under
    // the pipeline) is the pipeline's PR from here on: later review rounds
    // and every report target it.
    if (fx.opened?.created) {
      prNumber = fx.opened.number;
      prUrl = fx.opened.url;
    }
    // The post-step's note is a fact of the round the thread must see,
    // exactly like round 0's — a failed repush or PR edit must not vanish
    // into the log while the pipeline sails on.
    if (fx.prNote) await input.reply(fx.prNote).catch(() => {});
    // Nothing repushed → usually nothing to re-review: a branch still at the
    // head the review already read would burn a review round on the very same
    // diff. ONE exception, by contract (spec item 7): a round that DECLINED
    // every finding of the last review changes no code on purpose — the
    // re-review exists to verify those arguments and may concede, so it still
    // runs (over the same head; the re-review-delta skill covers exactly
    // this). Anything else that moved no head — fixes claimed, findings left
    // unanswered — aborts, carrying the post-step's reason for why nothing
    // landed. (An unobservable fix-round head proves nothing and proceeds as
    // before.)
    const fixHead = normalizeHead(fx.headSha);
    const reviewedAt = normalizeHead(lastReviewHead);
    if (fixHead !== undefined && reviewedAt !== undefined && sameCommit(fixHead, reviewedAt)) {
      const roundDispositions = dispositionsByRound.get(reviewRounds);
      const allDeclined =
        lastFindings.length > 0 && lastFindings.every((f) => roundDispositions?.get(f.id)?.disposition === "declined");
      if (!allDeclined) {
        emitRound(reviewRounds, "coding", "aborted");
        return abortOutcome(
          `⚠️ Fix round ${reviewRounds} produced no new head — the branch still sits at \`${fixHead.slice(0, 7)}\`, the commit the review already read, and not every finding was declined on the record, so there is nothing new to re-review.`,
          fx.prNote,
        );
      }
    }
    emitRound(reviewRounds, "coding", fx.opened ? "pr_opened" : "completed");
  }
}
