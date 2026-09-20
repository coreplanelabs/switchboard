import type { PullSweepDeps, SweepGit, SweepPullRequest } from "./pullSweep.js";
import type { SweepOrigin } from "./commands/pulls.js";
import { parsePlanBranch } from "./ship/coordinator.js";
import { LGTM_TOKEN } from "./reviewVerdict.js";
import { sameCommit } from "./reviewedHead.js";
import type { OpenPullRequestRow, PullRequestFacts, PullRequestReview } from "../execution/githubPulls.js";

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
  postReview(target: { repo: string; number: number; commitId?: string }, body: string): Promise<void>;
  /** The description as GitHub has it (`fetchPullRequestTitleBody`). */
  titleBody(pr: { repo: string; number: number }): Promise<{ title: string; body: string } | undefined>;
  /** Replace the description (`updatePullRequest`) — the anchor regeneration. */
  update(pr: { repo: string; number: number }, patch: { title: string; body: string }): Promise<void>;
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
  /** `dispatch()` bound by src/index.ts (invariant 3): starts the run and
   *  returns; the sweep never waits on the round's outcome. */
  dispatch(request: SweepDispatchRequest): Promise<void>;
  /** Who asked for the sweep — the model round runs as this requester, on the
   *  sweep's own thread key so it never folds into an unrelated conversation. */
  origin: SweepOrigin;
  /** Which head branches the pipeline owns; default: the plan branches. */
  owns?(branch: string): boolean;
  /** Shared across the process's per-requester services, so one pull request
   *  buys its one model round once no matter who sweeps. */
  state?: SweepSharedState;
}

/** What outlives one requester's service: the spent-round flags. */
export interface SweepSharedState {
  roundSpent: Set<string>;
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
  const roundSpent = deps.state?.roundSpent ?? new Set<string>();
  const key = (pr: SweepPullRequest): string => `${pr.repo}#${pr.number}`;
  const send = async (pr: SweepPullRequest, text: string): Promise<void> => {
    await deps.dispatch({
      channelId: deps.origin.channelId ?? "http:pulls",
      userId: deps.origin.userId,
      threadKey: sweepThreadKey(pr),
      text,
    });
  };
  // The bot's identity, looked up once per process and shared across sweeps —
  // the underlying resolver caches too, this just avoids a call per pull request.
  let self: Promise<{ login: string; id?: number } | undefined> | undefined;
  return {
    async listOwnedPullRequests(repo) {
      const open = await deps.github.listOpen(repo);
      const owned = open.filter((row) => row.sameRepoHead && row.headRef !== undefined && owns(row.headRef));
      const prs: SweepPullRequest[] = [];
      for (const row of owned) {
        // The facts fresh, never the listing's: `mergeable_state` is absent
        // from the list endpoint and stale the moment a sibling merges.
        const facts = await deps.github.facts({ repo, number: row.number });
        if (!facts || facts.state !== "open") continue;
        const branch = facts.headRef ?? row.headRef;
        const base = facts.baseRef ?? row.baseRef;
        const headSha = facts.headSha ?? row.headSha;
        if (branch === undefined || base === undefined || headSha === undefined) continue;
        const reviews = (await deps.github.reviews({ repo, number: row.number })) ?? [];
        // An approval at the head is either a genuine APPROVED review (a
        // person's, or the auto-approve workflow's on a repository that opted
        // in) or the bot's own review pinned there whose body starts with the
        // LGTM token — the pipeline posts its approvals with event COMMENT, so
        // that is what the merge door itself reads (`reviewPostedAt` in
        // src/channels/adminCoordinator.ts), identity-checked the same way.
        // An unknown identity counts only genuine APPROVED states.
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
        prs.push({
          repo,
          number: row.number,
          branch,
          base,
          headSha,
          mergeableState: facts.mergeableState ?? "unknown",
          approved,
        });
      }
      return prs;
    },
    git: deps.git,
    effects: {
      async carryApproval(pr, newHead) {
        // The merge door and the auto-approve workflow both read a review by
        // the bot pinned to the head whose body starts with the LGTM token —
        // this post is the carry, nothing else is.
        await deps.github.postReview(
          { repo: pr.repo, number: pr.number, commitId: newHead },
          `${LGTM_TOKEN} approval carried across a rebase onto \`${pr.base}\` — \`git range-diff\` read the patch byte-identical (every commit pair \`=\`); only the base moved. Carried by \`pulls rebase\` (the sweep of record 0071).`,
        );
      },
      async requestDeltaReview(pr, newHead) {
        await send(
          pr,
          `agent:review ${prUrl(pr)} — delta re-review after \`pulls rebase\`: the rebase onto \`${pr.base}\` changed the patch, so the prior approval does not carry. Review the pull request at head ${newHead}.`,
        );
      },
      async regenerateAnchors(pr, newHead) {
        const current = await deps.github.titleBody({ repo: pr.repo, number: pr.number });
        if (!current) return;
        const body = current.body.replace(blobLink(pr.repo), `$1${newHead}$2`);
        if (body === current.body) return;
        await deps.github.update({ repo: pr.repo, number: pr.number }, { title: current.title, body });
      },
      // In-memory, like the sweep's own per-repository bound: the sweep runs
      // where the command registry runs, and every round is bounded by its own
      // lease regardless — a bot restart forgets the flag, never the bound.
      async modelRoundSpent(pr) {
        return roundSpent.has(key(pr));
      },
      async startModelRound(pr, bounds) {
        try {
          await send(
            pr,
            `agent:coding budget:${bounds.leaseMinutes} — \`pulls rebase\` fix round for ${prUrl(pr)}: rebase branch \`${pr.branch}\` of ${pr.repo} onto \`${pr.base}\` and resolve the conflicts git could not take. Work on the pull request's own branch, follow the repository's AGENTS.md (regenerate only what it names as generated), run the fast gates, and force-push with lease. Never merge and never approve.`,
          );
        } catch (err) {
          return { started: false, reason: err instanceof Error ? err.message : String(err) };
        }
        roundSpent.add(key(pr));
        return { started: true };
      },
    },
  };
}
