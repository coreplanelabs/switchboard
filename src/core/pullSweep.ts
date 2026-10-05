import { PULL_SWEEP } from "./budgets.js";
import { redactSecrets } from "./redact.js";
import { isUnitEffectOutcome, type UnitEffectCompletionOutcome } from "./coordinator/unitEffect.js";

export type SweepNativeCall = (
  | { operation: "rebase_push" }
  | { operation: "review_anchor"; patch: { title: string; body: string } }
  | { operation: "approval_reset"; body: string }
  | {
      operation: "spawn";
      agent?: "coding";
      request: { channelId: string; userId: string; threadKey: string; text: string };
    }
) & { state: "unstarted" | "pending" | "accepted" | "refused" | "uncertain" };
/** Materialized immutable payloads come from the owner's existing session
 * entries on replay. Only their digest/reference belongs in currentEffect. */
export interface SweepPreparedSource {
  baseHead: string;
  committer: { name: string; email: string };
}
export interface SweepNativePlan {
  pr: SweepPullRequest;
  newHead: string;
  decision: "carry" | "delta-review" | "fix-round";
  preparedSource?: SweepPreparedSource;
  calls: SweepNativeCall[];
}
export interface SweepEffectJournal {
  read(pr: SweepPullRequest): Promise<SweepNativePlan | undefined>;
  admit(plan: SweepNativePlan): Promise<boolean>;
  begin(plan: SweepNativePlan, index: number): Promise<boolean>;
  complete(plan: SweepNativePlan, index: number, outcome: UnitEffectCompletionOutcome): Promise<boolean>;
  settle(plan: SweepNativePlan): Promise<boolean>;
}

// The sweep a person runs (record 0071, mechanism two; docs/reference/specs/agent-ship.md
// item 20): `pulls rebase` walks the open pull requests the pipeline owns — or one
// named — and rebases each DIRTY one onto its base with a two-rung resolver.
// Rung one is git alone (src/execution/gitRebase.ts): fetch the base, rebase with
// whatever merge drivers the repository itself declares in `.gitattributes` and
// with `git rerere` enabled, so a resolution made once replays on later rebases
// of the same hunks; after a clean rebase an empty `git range-diff` carries the
// existing approval to the new head with no re-review, and the sweep force-pushes
// with lease and regenerates the pull request description's anchors. Rung two,
// only for a conflict git leaves, is ONE bounded model round on an UNOWNED
// pull request's own branch (a short lease, a per-pull-request spend cap); one
// whose sweep round already ran ends with the conflict named in one line. A
// live runner instead receives every fresh conflict under its own remaining
// lease. A stale-but-clean pull request is skipped: it merges as it is.
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
export type RebaseOutcome =
  { kind: "clean"; newHead: string; preparedSource?: SweepPreparedSource } | { kind: "conflict"; file: string };

/** Rung one — git alone, per pull request. `src/execution/gitRebase.ts` is the
 *  real implementation; tests fake it. */
export interface SweepGit {
  /** Fetch the base and rebase the branch onto it (repository merge drivers, rerere on). */
  rebase(pr: SweepPullRequest): Promise<RebaseOutcome>;
  /** After a clean rebase: is the patch byte-identical (`git range-diff` empty of changes)? */
  patchUnchanged(pr: SweepPullRequest, newHead: string): Promise<boolean>;
  /** `git push --force-with-lease` — refused when the remote head moved under the sweep. */
  forcePushWithLease(pr: SweepPullRequest, newHead: string): Promise<UnitEffectCompletionOutcome | void>;
  /** Exact local source availability is checked before the owner begins. */
  canPush?(pr: SweepPullRequest, newHead: string, source?: SweepPreparedSource): Promise<boolean>;
  /** Release only the disposable local cache; the admitted recipe stays owned. */
  release?(pr: SweepPullRequest): Promise<void>;
}

/** The sweep's effects beyond git — each a seam the wiring fills. */
export interface SweepEffects {
  prepareNativeCalls?(
    pr: SweepPullRequest,
    newHead: string,
    options: { carryApproval: boolean; deltaReview: boolean },
  ): Promise<SweepNativeCall[]>;
  canPerformNativeCall?(plan: SweepNativePlan, index: number): boolean;
  performNativeCall?(plan: SweepNativePlan, index: number): Promise<UnitEffectCompletionOutcome>;
  /** Has this unowned pull request already spent its sweep model round? */
  modelRoundSpent(pr: SweepPullRequest): Promise<boolean>;
  /** Rung two: start the one bounded model round on the pull request's own
   *  branch (the thread's context and the repository's AGENTS.md ride the
   *  round's own brief). Answers whether it started; a refusal names why. */
  startModelRound(
    pr: SweepPullRequest,
    bounds: { leaseMinutes: number; spendCapUsd: number },
  ): Promise<{ started: true; runId: string } | { started: false; reason: string }>;
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
  /** The pushed head when rung one completed. The runner pins its next step to it. */
  headSha?: string;
  /** True only when rung one actually posted the approval carry at that head. */
  approvalCarried?: boolean;
}

export interface SweepReport {
  repo: string;
  results: SweepResult[];
}

export interface PullSweepDeps {
  /** Shared across callers; limits throughput without granting write authority. */
  throughput?: PullSweepThroughput;
  /** The open pull requests the pipeline owns in the repository, GitHub's facts fresh. */
  listOwnedPullRequests(repo: string): Promise<SweepPullRequest[]>;
  /** One runner-owned pull request by number, including an adopted branch that
   *  does not use the pipeline's branch naming convention. */
  findPullRequest?(repo: string, number: number): Promise<SweepPullRequest | undefined>;
  /** A live ship runner is the sole owner of its pull request's rebase loop. */
  runnerOwns?(pr: SweepPullRequest): Promise<boolean>;
  git: SweepGit;
  effects: SweepEffects;
  effect?: SweepEffectJournal;
  bounds?: { leaseMinutes: number; spendCapUsd: number };
}

/** What the sweep command calls: one sweep over a repository, or one pull request of it. */
export interface PullSweepService {
  sweep(target: { repo: string; number?: number; owner?: "runner" }): Promise<SweepReport>;
}

const line = (pr: { number: number }, text: string): string => `#${pr.number} ${text}`;

const fullHead = (head: string): boolean => /^[a-f0-9]{40}$/i.test(head);
function validNativePlan(plan: SweepNativePlan, requested: SweepPullRequest): boolean {
  if (
    !plan ||
    !plan.pr ||
    !Array.isArray(plan.calls) ||
    plan.pr.repo.toLowerCase() !== requested.repo.toLowerCase() ||
    plan.pr.number !== requested.number ||
    plan.pr.branch !== requested.branch ||
    plan.pr.base !== requested.base ||
    !fullHead(plan.pr.headSha) ||
    !fullHead(plan.newHead) ||
    !["carry", "delta-review", "fix-round"].includes(plan.decision) ||
    plan.calls.length < 1 ||
    plan.calls.length > 4 ||
    (plan.decision === "fix-round"
      ? plan.calls.length !== 1 ||
        plan.calls[0]?.operation !== "spawn" ||
        plan.calls[0].agent !== "coding" ||
        plan.newHead !== plan.pr.headSha ||
        plan.preparedSource !== undefined
      : plan.calls[0]?.operation !== "rebase_push")
  )
    return false;
  if (
    plan.preparedSource &&
    (!fullHead(plan.preparedSource.baseHead) ||
      !plan.preparedSource.committer?.name ||
      !plan.preparedSource.committer.email)
  )
    return false;
  if (plan.decision === "carry" && plan.pr.approved && !plan.calls.some((call) => call.operation === "approval_reset"))
    return false;
  const seen = new Set<string>();
  return plan.calls.every((call, index) => {
    if (
      !call ||
      !["unstarted", "pending", "accepted", "refused", "uncertain"].includes(call.state) ||
      seen.has(call.operation)
    )
      return false;
    seen.add(call.operation);
    switch (call.operation) {
      case "rebase_push":
        return index === 0;
      case "review_anchor":
        return typeof call.patch?.title === "string" && typeof call.patch.body === "string";
      case "approval_reset":
        return plan.decision === "carry" && plan.pr.approved && typeof call.body === "string" && call.body.length > 0;
      case "spawn":
        return (
          (plan.decision === "delta-review"
            ? call.agent === undefined
            : plan.decision === "fix-round" && call.agent === "coding") &&
          !!call.request &&
          [call.request.userId, call.request.channelId, call.request.threadKey, call.request.text].every(
            (value) => typeof value === "string" && value.length > 0,
          )
        );
      default:
        return false;
    }
  });
}
function nativeOutcome(call: SweepNativeCall, value: unknown, newHead: string): UnitEffectCompletionOutcome {
  if (!isUnitEffectOutcome(value) || (value.state === "refused" && value.cause !== "external_refused"))
    return { state: "uncertain" };
  if (
    value.state === "accepted" &&
    (call.operation === "spawn"
      ? value.runId === undefined || value.commitSha !== undefined
      : call.operation === "rebase_push"
        ? value.commitSha?.toLowerCase() !== newHead.toLowerCase() || value.runId !== undefined
        : value.runId !== undefined || value.commitSha !== undefined)
  )
    return { state: "uncertain" };
  return value as UnitEffectCompletionOutcome;
}

async function performNativePlan(plan: SweepNativePlan, deps: PullSweepDeps): Promise<void> {
  if (!deps.effect || !deps.effects.performNativeCall) throw new Error("durable sweep effect adapter unavailable");
  if (plan.calls.some((call) => call.state === "pending" || call.state === "uncertain" || call.state === "refused"))
    throw new Error("previous sweep mutation remains unresolved");
  for (let index = 0; index < plan.calls.length; index++) {
    const call = plan.calls[index]!;
    if (call.state === "accepted") continue;
    if (call.state !== "unstarted") throw new Error("previous sweep mutation remains unresolved");
    if (
      call.operation === "rebase_push" &&
      (await deps.git.canPush?.(plan.pr, plan.newHead, plan.preparedSource)) !== true
    )
      throw new Error("the exact prepared rebase source is unavailable");
    if (call.operation !== "rebase_push" && deps.effects.canPerformNativeCall?.(plan, index) !== true)
      throw new Error("sweep native capability unavailable");
    if (!(await deps.effect.begin(plan, index))) throw new Error("sweep mutation admission unconfirmed");
    let outcome: UnitEffectCompletionOutcome = { state: "uncertain" };
    try {
      if (call.operation === "rebase_push") {
        outcome = nativeOutcome(call, await deps.git.forcePushWithLease(plan.pr, plan.newHead), plan.newHead);
      } else outcome = nativeOutcome(call, await deps.effects.performNativeCall(plan, index), plan.newHead);
    } catch {
      /* A failed native response does not prove the call was refused. */
    }
    if (!(await deps.effect.complete(plan, index, outcome))) throw new Error("sweep mutation result unconfirmed");
    plan.calls[index] = { ...call, state: outcome.state };
    if (outcome.state !== "accepted")
      throw new Error(outcome.state === "refused" ? "sweep mutation refused" : "sweep mutation outcome unconfirmed");
    if (call.operation === "spawn" && (typeof outcome.runId !== "string" || outcome.runId.length === 0))
      throw new Error("sweep review child admission unconfirmed");
  }
  if (!(await deps.effect.settle(plan))) throw new Error("sweep settlement unconfirmed");
}

async function sweepOne(pr: SweepPullRequest, deps: PullSweepDeps, owner: "runner" | undefined): Promise<SweepResult> {
  const bounds = deps.bounds ?? PULL_SWEEP;
  const at = (outcome: SweepResult["outcome"], text: string): SweepResult => ({
    repo: pr.repo,
    number: pr.number,
    outcome,
    line: line(pr, text),
  });
  try {
    if (owner !== "runner" && (await deps.runnerOwns?.(pr)) === true)
      return at("skipped", "deferred — its pipeline runner owns the rebase");
    const saved = await deps.effect?.read(pr);
    if (saved) {
      if (!validNativePlan(saved, pr)) throw new Error("saved sweep target or payload invalid");
      await performNativePlan(saved, deps);
      const result = at(
        saved.decision === "fix-round" ? "fix-round" : saved.decision === "carry" ? "carried" : "delta-review",
        saved.decision === "fix-round"
          ? "a fix round is running"
          : saved.decision === "carry"
            ? saved.calls.some((call) => call.operation === "approval_reset")
              ? "rebased, patch unchanged, approval carried"
              : "rebased, patch unchanged"
            : owner === "runner"
              ? "rebased, patch changed, the pipeline runner will re-review"
              : "rebased, patch changed, a re-review is requested",
      );
      return owner === "runner"
        ? {
            ...result,
            headSha: saved.newHead,
            ...(saved.decision === "carry"
              ? { approvalCarried: saved.calls.some((call) => call.operation === "approval_reset") }
              : {}),
          }
        : result;
    }
    const dirty = pr.mergeableState === "dirty";
    // GitHub recomputes `mergeable_state` after every base move — exactly the
    // moment the sweep exists for — so an unknown state is named, never claimed
    // current: the next sweep reads the settled answer.
    if (!dirty && (pr.mergeableState === "unknown" || pr.mergeableState === ""))
      return at("skipped", "mergeability still computing — no rebase was attempted");
    // A stale-but-clean pull request is never rebased: it merges as it is.
    if (!dirty) return at("skipped", "skipped, already current");
    if (!deps.effect || !deps.effects.prepareNativeCalls || !deps.effects.performNativeCall)
      throw new Error("durable sweep effect adapter unavailable");
    const rebased = await deps.git.rebase(pr);
    const decision =
      rebased.kind === "conflict"
        ? owner === "runner"
          ? { action: "model-round" as const, file: rebased.file }
          : decideSweep({ dirty, rebase: rebased, modelRoundSpent: await deps.effects.modelRoundSpent(pr) })
        : decideSweep({ dirty, rebase: rebased, patchUnchanged: await deps.git.patchUnchanged(pr, rebased.newHead) });
    switch (decision.action) {
      case "skip":
        return at("skipped", "skipped, already current");
      case "end":
        // An unowned second conflict ends with the conflict named in one line.
        return at(
          "conflict",
          `this is a bug: the conflict in ${decision.file} remained after the sweep's fix round, and no automatic recovery remains`,
        );
      case "model-round": {
        if (owner === "runner")
          return at("conflict", `conflict in ${decision.file}, the pipeline runner's fix round will resolve it`);
        const round = await deps.effects.startModelRound(pr, bounds);
        if (!round.started) return at("conflict", `conflict in ${decision.file}, no fix round ran — ${round.reason}`);
        if (!isUnitEffectOutcome({ state: "accepted", runId: round.runId }))
          throw new Error("sweep fix child admission unconfirmed");
        return at("fix-round", `conflict in ${decision.file}, a fix round is running`);
      }
      case "carry":
      case "delta-review": {
        const newHead = (rebased as { kind: "clean"; newHead: string }).newHead;
        const calls = await deps.effects.prepareNativeCalls(pr, newHead, {
          carryApproval: decision.action === "carry" && pr.approved,
          deltaReview: decision.action === "delta-review" && owner !== "runner",
        });
        const plan: SweepNativePlan = {
          pr: { ...pr },
          newHead,
          decision: decision.action,
          calls: [{ operation: "rebase_push", state: "unstarted" }, ...calls],
          ...(rebased.kind === "clean" && rebased.preparedSource ? { preparedSource: rebased.preparedSource } : {}),
        };
        if (!validNativePlan(plan, pr)) throw new Error("sweep target or payload invalid");
        if (
          plan.calls.some(
            (call, index) =>
              call.operation !== "rebase_push" && deps.effects.canPerformNativeCall?.(plan, index) !== true,
          )
        )
          throw new Error("sweep native capability unavailable");
        if ((await deps.git.canPush?.(plan.pr, plan.newHead, plan.preparedSource)) !== true)
          throw new Error("the exact prepared rebase source is unavailable");
        if (!(await deps.effect.admit(plan))) throw new Error("sweep admission unconfirmed");
        await performNativePlan(plan, deps);
        if (decision.action === "carry") {
          // The branch's own change is byte-identical; only its parent moved.
          const result = at(
            "carried",
            pr.approved ? "rebased, patch unchanged, approval carried" : "rebased, patch unchanged",
          );
          return owner === "runner" ? { ...result, headSha: newHead, approvalCarried: pr.approved } : result;
        }
        const result = at(
          "delta-review",
          owner === "runner"
            ? "rebased, patch changed, the pipeline runner will re-review"
            : "rebased, patch changed, a re-review is requested",
        );
        return owner === "runner" ? { ...result, headSha: newHead } : result;
      }
    }
    throw new Error("sweep decision unavailable");
  } catch (err) {
    // Git quotes remote URLs and headers verbatim in its failure messages, and
    // this line rides the command result to chat, the CLI and MCP unredacted —
    // so no credential shape may survive to it.
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    return at("error", `not rebased — ${message}`);
  } finally {
    await deps.git.release?.(pr).catch(() => {});
  }
}

export interface PullSweepThroughput {
  serialize<T>(repo: string, work: () => Promise<T>): Promise<T>;
}

/** One process-wide dependency can serve request-scoped sweep services. */
export function createPullSweepThroughput(): PullSweepThroughput {
  const inFlight = new Map<string, Promise<unknown>>();
  const serialize = <T>(repo: string, work: () => Promise<T>): Promise<T> => {
    const key = repo.toLowerCase();
    const tail = inFlight.get(key) ?? Promise.resolve();
    const next = tail.then(work, work);
    const stored = next.catch(() => {});
    inFlight.set(key, stored);
    // The map is the bound's whole state: once the stored tail settles and
    // nothing queued behind it, the repository's entry goes.
    void stored.then(() => {
      if (inFlight.get(key) === stored) inFlight.delete(key);
    });
    return next;
  };
  return { serialize };
}

/** One rebase in flight per repository: a second sweep of the same repository
 *  queues behind the first, and within one sweep the pull requests go one at a
 *  time. This queue only limits throughput; the durable owner admits every write. */
export function createPullSweepService(deps: PullSweepDeps): PullSweepService {
  const throughput = deps.throughput ?? createPullSweepThroughput();
  return {
    sweep: (target) =>
      throughput.serialize(target.repo, async () => {
        const open =
          target.owner === "runner" && target.number !== undefined && deps.findPullRequest !== undefined
            ? [await deps.findPullRequest(target.repo, target.number)].filter(
                (pr): pr is SweepPullRequest => pr !== undefined,
              )
            : await deps.listOwnedPullRequests(target.repo);
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
        for (const pr of prs) results.push(await sweepOne(pr, deps, target.owner));
        return { repo: target.repo, results };
      }),
  };
}
