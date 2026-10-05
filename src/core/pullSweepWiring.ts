import type {
  PullSweepDeps,
  SweepGit,
  SweepPullRequest,
  SweepEffectJournal,
  SweepNativeCall,
  SweepEffects,
} from "./pullSweep.js";
import { isUnitEffectOutcome, type UnitEffectCompletionOutcome } from "./coordinator/unitEffect.js";
import type { SweepOrigin } from "./commands/pulls.js";
import { parsePlanBranch } from "./ship/coordinator.js";
import { LGTM_TOKEN } from "./reviewVerdict.js";
import { sameCommit } from "./reviewedHead.js";
import type {
  GithubWriteResult,
  OpenPullRequestRow,
  PullRequestFacts,
  PullRequestReview,
} from "../execution/githubPulls.js";

// The pull sweep's production wiring (record 0071, mechanism two; issue 2067;
// docs/reference/specs/agent-ship.md item 20): fills `PullSweepDeps` for
// `CoreCommandWiring.pulls` in src/index.ts. The listing is the pipeline's
// open pull requests — the ones whose head branch is a plan branch
// (`parsePlanBranch`), on the base repository — with each one's
// `mergeable_state` read fresh off its own facts and the approval read off the
// posted reviews at the head. The effects: the approval carry is the bot's
// `LGTM:` review pinned to the new head (exactly what the merge door and the
// auto-approve workflow read); the delta re-review and the one bounded model
// round both go through `dispatch()` as the requester — the command handler
// never starts a run itself (AGENTS.md invariant 3); the anchor regeneration
// rewrites the description's blob permalinks to the pushed head. GitHub and
// git ride seams so the tests hold the wiring's joints without the network.

/** The GitHub reads and writes the wiring needs — production binds them to
 *  src/execution/githubPulls.ts and githubComments.ts. */
export interface SweepGithub {
  /** Every open pull request of the repository (`listOpenPullRequests`). */
  listOpen(repo: string): Promise<OpenPullRequestRow[]>;
  /** One pull request's facts, fresh — `mergeable_state` is never taken from
   *  the listing (`fetchPullRequestFacts`). */
  facts(pr: { repo: string; number: number }): Promise<PullRequestFacts | undefined>;
  /** The posted reviews (`fetchPullRequestReviews`) — the approval read. */
  reviews(pr: { repo: string; number: number }): Promise<PullRequestReview[] | undefined>;
  /** The identity this process posts reviews as (`resolveGithubIdentity`) —
   *  the pipeline's own approval is a `COMMENTED` review whose body starts
   *  with the LGTM token, so the approval read must know who "the bot" is. */
  selfIdentity(): Promise<{ login: string; id?: number } | undefined>;
  /** Post a review pinned to a commit (`postReviewComment`) — the carry. */
  postReview(
    target: { repo: string; number: number; commitId?: string },
    body: string,
  ): Promise<GithubWriteResult | void>;
  /** The description as GitHub has it (`fetchPullRequestTitleBody`). */
  titleBody(pr: { repo: string; number: number }): Promise<{ title: string; body: string } | undefined>;
  /** Replace the description (`updatePullRequest`) — the anchor regeneration. */
  update(
    pr: { repo: string; number: number },
    patch: { title: string; body: string },
    target: { headSha: string; headRef: string; baseRef: string },
  ): Promise<GithubWriteResult | void>;
}

/** One request handed to `dispatch()` — the model rung's and the delta
 *  re-review's whole reach into the run machinery. */
export interface SweepDispatchRequest {
  channelId: string;
  userId: string;
  threadKey: string;
  text: string;
}

export interface PullSweepWiringDeps {
  github: SweepGithub;
  git: SweepGit;
  /** Original child admission receipt, never a void send acknowledgment. */
  dispatchEffect?(request: SweepDispatchRequest): Promise<UnitEffectCompletionOutcome>;
  effect?: SweepEffectJournal;
  /** The existing durable maintenance owner supplies spend and child admission. */
  maintenance?: Pick<SweepEffects, "modelRoundSpent" | "startModelRound">;
  /** Who asked for the sweep — the model round runs as this requester, on the
   *  sweep's own thread key so it never folds into an unrelated conversation. */
  origin: SweepOrigin;
  /** Which head branches the pipeline owns; default: the plan branches. */
  owns?(branch: string): boolean;
  /** Whether a live ship runner currently owns this pull request. A command
   *  sweep defers; the runner invokes the same resolver in runner mode. */
  runnerOwns?: (pr: SweepPullRequest) => Promise<boolean>;
}

const prUrl = (pr: SweepPullRequest): string => `https://github.com/${pr.repo}/pull/${pr.number}`;

/** The sweep's thread key for one pull request: an `http:`-platform key (the
 *  bot answers it with the null channel — the run's page is the surface), one
 *  per pull request so a second round on the same pull request lands in the
 *  same conversation. */
export const sweepThreadKey = (pr: { repo: string; number: number }): string => `http:pulls:${pr.repo}#${pr.number}`;

/** A blob permalink of this repository pinned to a 40-hex sha — what the
 *  description's anchors render as (`anchorUrl` in prDescription.ts). */
const blobLink = (repo: string): RegExp =>
  new RegExp(`(github\\.com/${repo.replace(/[.\\/]/g, "\\$&")}/blob/)[0-9a-f]{40}(/)`, "g");

/** `PullSweepDeps` over the seams — what `createPullSweepService` runs on. */
export function buildPullSweepDeps(deps: PullSweepWiringDeps): PullSweepDeps {
  const owns = deps.owns ?? ((branch: string) => parsePlanBranch(branch) !== undefined);
  // The bot's identity, looked up once per process and shared across sweeps —
  // the underlying resolver caches too, this just avoids a call per pull request.
  let self: Promise<{ login: string; id?: number } | undefined> | undefined;
  const readPullRequest = async (repo: string, row: OpenPullRequestRow): Promise<SweepPullRequest | undefined> => {
    // The facts fresh, never the listing's: `mergeable_state` is absent from
    // the list endpoint and stale the moment a sibling merges.
    const facts = await deps.github.facts({ repo, number: row.number });
    if (!facts || facts.state !== "open") return undefined;
    const branch = facts.headRef ?? row.headRef;
    const base = facts.baseRef ?? row.baseRef;
    const headSha = facts.headSha ?? row.headSha;
    if (branch === undefined || base === undefined || headSha === undefined) return undefined;
    const reviews = (await deps.github.reviews({ repo, number: row.number })) ?? [];
    self ??= deps.github.selfIdentity().catch(() => undefined);
    const identity = await self;
    const pinned = reviews.filter((r) => r.commitId !== undefined && sameCommit(r.commitId.toLowerCase(), headSha));
    const approved = pinned.some(
      (r) =>
        r.state === "APPROVED" ||
        (identity !== undefined &&
          r.author?.login === identity.login &&
          (r.author.id === undefined || identity.id === undefined || r.author.id === identity.id) &&
          r.body.startsWith(LGTM_TOKEN)),
    );
    return {
      repo,
      number: row.number,
      branch,
      base,
      headSha,
      mergeableState: facts.mergeableState ?? "unknown",
      approved,
    };
  };
  return {
    async listOwnedPullRequests(repo) {
      const open = await deps.github.listOpen(repo);
      const owned = open.filter((row) => row.sameRepoHead && row.headRef !== undefined && owns(row.headRef));
      const prs = await Promise.all(owned.map((row) => readPullRequest(repo, row)));
      return prs.filter((pr): pr is SweepPullRequest => pr !== undefined);
    },
    async findPullRequest(repo, number) {
      const row = (await deps.github.listOpen(repo)).find((candidate) => candidate.number === number);
      if (row === undefined || !row.sameRepoHead) return undefined;
      return readPullRequest(repo, row);
    },
    ...(deps.runnerOwns ? { runnerOwns: deps.runnerOwns } : {}),
    git: deps.git,
    ...(deps.effect ? { effect: deps.effect } : {}),
    effects: {
      async prepareNativeCalls(pr, newHead, options) {
        const current = await deps.github.titleBody({ repo: pr.repo, number: pr.number });
        if (!current) throw new Error("pull request description unavailable");
        const calls: SweepNativeCall[] = [];
        const body = current.body.replace(blobLink(pr.repo), `$1${newHead}$2`);
        if (body !== current.body)
          calls.push({ operation: "review_anchor", state: "unstarted", patch: { title: current.title, body } });
        if (options.carryApproval)
          calls.push({
            operation: "approval_reset",
            state: "unstarted",
            body: `${LGTM_TOKEN} approval carried across a rebase onto \`${pr.base}\` — \`git range-diff\` read the patch byte-identical (every commit pair \`=\`); only the base moved. Carried by \`pulls rebase\` (the sweep of record 0071).`,
          });
        if (options.deltaReview) {
          if (!deps.dispatchEffect) throw new Error("sweep child admission receipt unavailable");
          calls.push({
            operation: "spawn",
            state: "unstarted",
            request: {
              channelId: deps.origin.channelId ?? "http:pulls",
              userId: deps.origin.userId,
              threadKey: sweepThreadKey(pr),
              text: `agent:review ${prUrl(pr)} — delta re-review after \`pulls rebase\`: the rebase onto \`${pr.base}\` changed the patch, so the prior approval does not carry. Review the pull request at head ${newHead}.`,
            },
          });
        }
        return calls;
      },
      canPerformNativeCall(plan, index) {
        const op = plan.calls[index]?.operation;
        return op === "review_anchor"
          ? typeof deps.github.update === "function"
          : op === "approval_reset"
            ? typeof deps.github.postReview === "function"
            : op === "spawn"
              ? typeof deps.dispatchEffect === "function"
              : false;
      },
      async performNativeCall(plan, index) {
        const call = plan.calls[index];
        if (!call) return { state: "uncertain" };
        let native: GithubWriteResult | void;
        if (call.operation === "review_anchor")
          native = await deps.github.update({ repo: plan.pr.repo, number: plan.pr.number }, call.patch, {
            headSha: plan.newHead,
            headRef: plan.pr.branch,
            baseRef: plan.pr.base,
          });
        else if (call.operation === "approval_reset")
          native = await deps.github.postReview(
            { repo: plan.pr.repo, number: plan.pr.number, commitId: plan.newHead },
            call.body,
          );
        else if (call.operation === "spawn") {
          const result = await deps.dispatchEffect?.(call.request);
          return isUnitEffectOutcome(result) &&
            (result.state === "refused"
              ? result.cause === "external_refused"
              : result.state !== "accepted" || (result.runId !== undefined && result.commitSha === undefined))
            ? (result as UnitEffectCompletionOutcome)
            : { state: "uncertain" };
        } else return { state: "uncertain" };
        return native?.state === "accepted"
          ? { state: "accepted" }
          : native?.state === "refused"
            ? { state: "refused", cause: "external_refused" }
            : { state: "uncertain" };
      },
      async modelRoundSpent(pr) {
        if (!deps.maintenance) throw new Error("durable sweep maintenance adapter unavailable");
        return deps.maintenance.modelRoundSpent(pr);
      },
      async startModelRound(pr, bounds) {
        if (!deps.maintenance) return { started: false, reason: "durable sweep maintenance adapter unavailable" };
        return deps.maintenance.startModelRound(pr, bounds);
      },
    },
  };
}
