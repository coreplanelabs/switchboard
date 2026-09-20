import { PULL_SWEEP } from "./budgets.js";
import { redactSecrets } from "./redact.js";

// The sweep a person runs (record 0071, mechanism two; docs/reference/specs/agent-ship.md
// item 20): `pulls rebase` walks the open pull requests the pipeline owns — or one
// named — and rebases each DIRTY one onto its base with a two-rung resolver.
// Rung one is git alone (src/execution/gitRebase.ts): fetch the base, rebase with
// whatever merge drivers the repository itself declares in `.gitattributes` and
// with `git rerere` enabled, so a resolution made once replays on later rebases
// of the same hunks; after a clean rebase an empty `git range-diff` carries the
// existing approval to the new head with no re-review, and the sweep force-pushes
// with lease and regenerates the pull request description's anchors. Rung two,
// only for a conflict git leaves, is ONE bounded model round on the pull
// request's own branch (a short lease, a per-pull-request spend cap); a pull
// request whose round already ran ends with the conflict named in one line — no
// retry loop. A stale-but-clean pull request is skipped: it merges as it is.
// The engine never knows what a generator or a formatter is — what a model
// round may regenerate is only what the repository's own AGENTS.md names, and
// the round reads it there.

/** One open pull request as the sweep sees it — GitHub's own facts. */
export interface SweepPullRequest {
  /** `owner/name`. */
  repo: string;
  number: number;
  /** The head branch the pull request is from. */
  branch: string;
  /** The base branch it merges into. */
  base: string;
  /** The head sha before the sweep touched it. */
  headSha: string;
  /** GitHub's `mergeable_state`; only `dirty` is swept — everything else is current. */
  mergeableState: string;
  /** Whether an approval stands at the current head. */
  approved: boolean;
}

/** What rung one's rebase left: a clean new head, or the conflict git could not take. */
export type RebaseOutcome = { kind: "clean"; newHead: string } | { kind: "conflict"; file: string };

/** Rung one — git alone, per pull request. `src/execution/gitRebase.ts` is the
 *  real implementation; tests fake it. */
export interface SweepGit {
  /** Fetch the base and rebase the branch onto it (repository merge drivers, rerere on). */
  rebase(pr: SweepPullRequest): Promise<RebaseOutcome>;
  /** After a clean rebase: is the patch byte-identical (`git range-diff` empty of changes)? */
  patchUnchanged(pr: SweepPullRequest, newHead: string): Promise<boolean>;
  /** `git push --force-with-lease` — refused when the remote head moved under the sweep. */
  forcePushWithLease(pr: SweepPullRequest, newHead: string): Promise<void>;
}

/** The sweep's effects beyond git — each a seam the wiring fills. */
export interface SweepEffects {
  /** The existing approval carries to the new head; no re-review is requested. */
  carryApproval(pr: SweepPullRequest, newHead: string): Promise<void>;
  /** A changed patch gets a delta re-review at the pushed head. */
  requestDeltaReview(pr: SweepPullRequest, newHead: string): Promise<void>;
  /** The pull request description's anchors are regenerated at the new head. */
  regenerateAnchors(pr: SweepPullRequest, newHead: string): Promise<void>;
  /** Has this pull request already spent its one model round? */
  modelRoundSpent(pr: SweepPullRequest): Promise<boolean>;
  /** Rung two: start the one bounded model round on the pull request's own
   *  branch (the thread's context and the repository's AGENTS.md ride the
   *  round's own brief). Answers whether it started; a refusal names why. */
  startModelRound(
    pr: SweepPullRequest,
    bounds: { leaseMinutes: number; spendCapUsd: number },
  ): Promise<{ started: true } | { started: false; reason: string }>;
}

/** The resolver's decision table — pure and total over the facts in hand:
 *  not dirty → skip; clean rebase with the patch unchanged → carry the
 *  approval; clean but changed → delta re-review; a conflict → the one model
 *  round; a conflict whose round is already spent → the named ending. */
export type SweepDecision =
  | { action: "skip" }
  | { action: "carry" }
  | { action: "delta-review" }
  | { action: "model-round"; file: string }
  | { action: "end"; file: string };

export function decideSweep(facts: {
  dirty: boolean;
  rebase?: RebaseOutcome;
  patchUnchanged?: boolean;
  modelRoundSpent?: boolean;
}): SweepDecision {
  if (!facts.dirty) return { action: "skip" };
  if (facts.rebase?.kind === "conflict")
    return facts.modelRoundSpent === true
      ? { action: "end", file: facts.rebase.file }
      : { action: "model-round", file: facts.rebase.file };
  if (facts.patchUnchanged === true) return { action: "carry" };
  return { action: "delta-review" };
}

/** One pull request's line, in user words — what every surface prints. */
export interface SweepResult {
  repo: string;
  number: number;
  outcome: "skipped" | "carried" | "delta-review" | "fix-round" | "conflict" | "error";
  line: string;
}

export interface SweepReport {
  repo: string;
  results: SweepResult[];
}

export interface PullSweepDeps {
  /** The open pull requests the pipeline owns in the repository, GitHub's facts fresh. */
  listOwnedPullRequests(repo: string): Promise<SweepPullRequest[]>;
  git: SweepGit;
  effects: SweepEffects;
  bounds?: { leaseMinutes: number; spendCapUsd: number };
}

/** What the sweep command calls: one sweep over a repository, or one pull request of it. */
export interface PullSweepService {
  sweep(target: { repo: string; number?: number }): Promise<SweepReport>;
}

const line = (pr: { number: number }, text: string): string => `#${pr.number} ${text}`;

async function sweepOne(pr: SweepPullRequest, deps: PullSweepDeps): Promise<SweepResult> {
  const bounds = deps.bounds ?? PULL_SWEEP;
  const at = (outcome: SweepResult["outcome"], text: string): SweepResult => ({
    repo: pr.repo,
    number: pr.number,
    outcome,
    line: line(pr, text),
  });
  const dirty = pr.mergeableState === "dirty";
  // GitHub recomputes `mergeable_state` after every base move — exactly the
  // moment the sweep exists for — so an unknown state is named, never claimed
  // current: the next sweep reads the settled answer.
  if (!dirty && (pr.mergeableState === "unknown" || pr.mergeableState === ""))
    return at("skipped", "mergeability still computing — run the sweep again in a minute");
  // A stale-but-clean pull request is never rebased: it merges as it is.
  if (!dirty) return at("skipped", "skipped, already current");
  try {
    const rebased = await deps.git.rebase(pr);
    const decision =
      rebased.kind === "conflict"
        ? decideSweep({ dirty, rebase: rebased, modelRoundSpent: await deps.effects.modelRoundSpent(pr) })
        : decideSweep({ dirty, rebase: rebased, patchUnchanged: await deps.git.patchUnchanged(pr, rebased.newHead) });
    switch (decision.action) {
      case "end":
        // A second conflict ends with the conflict named in one line — no retry loop.
        return at("conflict", `conflict in ${decision.file}, its fix round is spent — rebase it by hand`);
      case "model-round": {
        const round = await deps.effects.startModelRound(pr, bounds);
        if (!round.started) return at("conflict", `conflict in ${decision.file}, no fix round ran — ${round.reason}`);
        return at("fix-round", `conflict in ${decision.file}, a fix round is running`);
      }
      case "carry":
      case "delta-review": {
        const newHead = (rebased as { kind: "clean"; newHead: string }).newHead;
        await deps.git.forcePushWithLease(pr, newHead);
        await deps.effects.regenerateAnchors(pr, newHead);
        if (decision.action === "carry") {
          // The branch's own change is byte-identical; only its parent moved.
          if (pr.approved) await deps.effects.carryApproval(pr, newHead);
          return at("carried", pr.approved ? "rebased, patch unchanged, approval carried" : "rebased, patch unchanged");
        }
        await deps.effects.requestDeltaReview(pr, newHead);
        return at("delta-review", "rebased, patch changed, a re-review is requested");
      }
      case "skip":
        return at("skipped", "skipped, already current");
    }
  } catch (err) {
    // Git quotes remote URLs and headers verbatim in its failure messages, and
    // this line rides the command result to chat, the CLI and MCP unredacted —
    // so no credential shape may survive to it.
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    return at("error", `not rebased — ${message}`);
  }
}

/** One rebase in flight per repository: a second sweep of the same repository
 *  queues behind the first, and within one sweep the pull requests go one at a
 *  time. In-memory is enough — the sweep runs where the command registry runs,
 *  and the plane's admission serializes the model rounds it starts. */
export function createPullSweepService(deps: PullSweepDeps): PullSweepService {
  const inFlight = new Map<string, Promise<unknown>>();
  const serialize = <T>(repo: string, work: () => Promise<T>): Promise<T> => {
    const tail = inFlight.get(repo) ?? Promise.resolve();
    const next = tail.then(work, work);
    const stored = next.catch(() => {});
    inFlight.set(repo, stored);
    // The map is the bound's whole state: once the stored tail settles and
    // nothing queued behind it, the repository's entry goes.
    void stored.then(() => {
      if (inFlight.get(repo) === stored) inFlight.delete(repo);
    });
    return next;
  };
  return {
    sweep: (target) =>
      serialize(target.repo, async () => {
        const open = await deps.listOwnedPullRequests(target.repo);
        const prs = target.number === undefined ? open : open.filter((pr) => pr.number === target.number);
        if (target.number !== undefined && prs.length === 0)
          return {
            repo: target.repo,
            results: [
              {
                repo: target.repo,
                number: target.number,
                outcome: "error" as const,
                line: `#${target.number} not swept — no open pull request the pipeline owns has this number`,
              },
            ],
          };
        const results: SweepResult[] = [];
        for (const pr of prs) results.push(await sweepOne(pr, deps));
        return { repo: target.repo, results };
      }),
  };
}
