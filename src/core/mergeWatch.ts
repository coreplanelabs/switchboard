import { PULL_SWEEP } from "./budgets.js";
import type { SweepReport } from "./pullSweep.js";

// Watch until merge, as a setting (record 0071, mechanism three;
// docs/reference/specs/agent-ship.md item 21). Off by default; org-level with
// a per-repository override on the config surface that exists (`config set
// org|repo --pulls.watch on|off`). When on for a repository, a unit whose pull
// request reaches merge-ready stays on it with no sandbox and no child alive
// while it waits: the unit is registered in the merge-ready book beside the
// merge-wait book (src/core/coordinator/checksIntake.ts), and on each
// push-to-base webhook that leaves the pull request DIRTY — read once GitHub
// has recomputed `mergeable_state`, never on a clock — the sweep's two-rung
// resolver (src/core/pullSweep.ts) runs for that one pull request, until the
// pull request is merged or the person ends it. The caps: one rebase in
// flight per repository (a second DIRTY pull request queues behind it) and a
// per-pull-request spend limit — at the spend cap the DIRTY stands and the
// card names the sweep a person can run (`pulls rebase`). A merged fact,
// whoever merged, ends the unit `merged` by other. A stale-but-clean pull
// request is never rebased: DIRTY is the only trigger the watch answers.

/** The `pulls` block of the org scope or a repository scope: the watch and
 *  its caps, each key resolving repository over org over the default. */
export interface PullsSettings {
  /** Watch a merge-ready pull request until it merges. Default off. */
  watch?: boolean;
  /** How many watch rebases may run at once per repository. Default 1. */
  rebaseInFlight?: number;
  /** What one pull request's watch may spend on model rounds, in USD. */
  spendLimitUsd?: number;
}

export interface MergeWatchSettings {
  watch: boolean;
  rebaseInFlight: number;
  spendLimitUsd: number;
}

export const MERGE_WATCH_DEFAULTS: MergeWatchSettings = {
  watch: false,
  rebaseInFlight: 1,
  spendLimitUsd: PULL_SWEEP.spendCapUsd,
};

/** The setting's resolution: the repository's word over the org's over the
 *  default, per key — so a repository turns the watch off under an org that
 *  turned it on, and on under an org that never did. */
export function resolveMergeWatch(org?: PullsSettings, repo?: PullsSettings): MergeWatchSettings {
  return {
    watch: repo?.watch ?? org?.watch ?? MERGE_WATCH_DEFAULTS.watch,
    rebaseInFlight: repo?.rebaseInFlight ?? org?.rebaseInFlight ?? MERGE_WATCH_DEFAULTS.rebaseInFlight,
    spendLimitUsd: repo?.spendLimitUsd ?? org?.spendLimitUsd ?? MERGE_WATCH_DEFAULTS.spendLimitUsd,
  };
}

/** One waiting unit's registration: the pull request, head and base, and who
 *  waits — the pipeline instance and its unit, the thread the card lives in,
 *  and the requester the resolver's rounds run as (invariant 3: the model
 *  rung is a `dispatch()` as the requester, never the watch's own). */
export interface MergeReadyEntry {
  repo: string;
  number: number;
  base: string;
  headSha: string;
  instanceId: string;
  unit: string;
  threadKey: string;
  requester: string;
}

/** The merge-ready book beside the merge-wait book: who waits on which pull
 *  request. In-memory on purpose, like the merge-wait registry — a restart
 *  loses the waiters, and the waiting unit re-registers on its next wait
 *  chunk; the webhook is a trigger, never the correctness. */
export interface MergeReadyBook {
  note(entry: MergeReadyEntry): void;
  drop(repo: string, number: number): void;
  /** The registered pull requests of `repo` whose base is `base`. */
  onBase(repo: string, base: string): MergeReadyEntry[];
}

const keyOf = (repo: string, number: number) => `${repo}#${number}`;

export function createMergeReadyBook(): MergeReadyBook {
  const entries = new Map<string, MergeReadyEntry>();
  return {
    note(entry) {
      entries.set(keyOf(entry.repo, entry.number), entry);
    },
    drop(repo, number) {
      entries.delete(keyOf(repo, number));
    },
    onBase(repo, base) {
      return [...entries.values()].filter((e) => e.repo === repo && e.base === base);
    },
  };
}

/** A watched pull request as GitHub answers it after a base push — read once
 *  GitHub has recomputed `mergeable_state` (the deps' contract), never on a
 *  clock here. */
export interface WatchedPullFacts {
  state: "open" | "merged" | "closed";
  /** GitHub's `mergeable_state`; only `dirty` buys a resolver round. */
  mergeableState?: string;
  sha?: string;
  mergedAt?: string;
}

/** What one base push did to one registered pull request — the intake's
 *  answer names every outcome. `resolver`: a resolver round ran. `queued`:
 *  DIRTY behind the repository's in-flight cap; it runs when a slot frees.
 *  `spend-capped`: the DIRTY stands and the card names the sweep. `merged`:
 *  the merged fact ended the unit, whoever merged. `stood`: not DIRTY — a
 *  stale-but-clean pull request is never rebased — or still recomputing. */
export type WatchOutcome = "resolver" | "queued" | "spend-capped" | "merged" | "stood" | "dropped" | "off";

export interface WatchResult {
  repo: string;
  number: number;
  outcome: WatchOutcome;
}

/** The line a spend-capped watch puts on the unit's card: the DIRTY stands
 *  and the remedy named is the one that exists — the sweep a person runs. */
export const spendCapLine = (entry: Pick<MergeReadyEntry, "repo" | "number">, limitUsd: number): string =>
  `#${entry.number} is behind \`${entry.repo}\`'s base and its watch has spent its $${limitUsd} limit — ` +
  `\`pulls rebase ${entry.repo}#${entry.number}\` rebases it.`;

export interface MergeWatchDeps {
  /** The resolved setting for the repository (org + its override). */
  settings(repo: string): MergeWatchSettings;
  book: MergeReadyBook;
  /** The pull request's facts once GitHub has recomputed `mergeable_state`. */
  facts(entry: MergeReadyEntry): Promise<WatchedPullFacts>;
  /** One resolver pass for the one pull request: the sweep's two rungs. */
  resolve(entry: MergeReadyEntry): Promise<SweepReport>;
  /** What the pull request's watch has spent on model rounds so far, USD. */
  spendOf(entry: MergeReadyEntry): Promise<number>;
  /** One line on the unit's card (the spend cap names the sweep). */
  card(entry: MergeReadyEntry, line: string): Promise<void>;
  /** The merged fact to the waiting unit: it ends `merged` by other. */
  merged(entry: MergeReadyEntry, facts: { sha: string; mergedAt: string }): Promise<void>;
}

export interface MergeWatch {
  /** One push-to-base webhook: every registered pull request of the repo on
   *  that base is read and answered. */
  pushToBase(repo: string, base: string): Promise<WatchResult[]>;
}

/** The watch's reaction to base pushes, under the caps. One rebase in flight
 *  per repository (configurable): a DIRTY pull request past the cap queues
 *  and runs when a slot frees, in arrival order. The spend limit is per pull
 *  request: at it the DIRTY stands, the card names `pulls rebase`, and the
 *  book keeps the entry — a person's sweep or merge still ends it. */
export function createMergeWatch(deps: MergeWatchDeps): MergeWatch {
  const inFlight = new Map<string, number>();
  const queues = new Map<string, MergeReadyEntry[]>();

  const runResolver = async (entry: MergeReadyEntry): Promise<void> => {
    inFlight.set(entry.repo, (inFlight.get(entry.repo) ?? 0) + 1);
    try {
      // The card carries the model round's own words in its thread; a rung-one
      // git failure or a conflict would otherwise vanish, so it is logged here.
      const report = await deps.resolve(entry);
      for (const r of report.results)
        if (r.outcome === "conflict" || r.outcome === "error")
          console.error(`[merge-watch] ${r.repo}#${r.number} ${r.outcome}: ${r.line}`);
    } catch (err) {
      // Caught here, not on the caller's promise: a queued entry runs inside
      // its predecessor's chain, so only this frame knows whose resolve threw.
      console.error(
        `[merge-watch] resolver failed for ${entry.repo}#${entry.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      const left = (inFlight.get(entry.repo) ?? 1) - 1;
      if (left <= 0) inFlight.delete(entry.repo);
      else inFlight.set(entry.repo, left);
      const queue = queues.get(entry.repo);
      const next = queue?.shift();
      if (queue !== undefined && queue.length === 0) queues.delete(entry.repo);
      if (next !== undefined) await runResolver(next);
    }
  };

  const one = async (entry: MergeReadyEntry): Promise<WatchResult> => {
    const at = (outcome: WatchOutcome): WatchResult => ({ repo: entry.repo, number: entry.number, outcome });
    const settings = deps.settings(entry.repo);
    // The setting turned off while a unit waited: the entry stands (the unit
    // still owns its wait) but no round is bought — a person's sweep or merge
    // ends it.
    if (!settings.watch) return at("off");
    const facts = await deps.facts(entry);
    if (facts.state === "merged") {
      // A merged fact, whoever merged, ends the unit `merged` by other.
      await deps.merged(entry, { sha: facts.sha ?? entry.headSha, mergedAt: facts.mergedAt ?? "" });
      deps.book.drop(entry.repo, entry.number);
      return at("merged");
    }
    if (facts.state === "closed") {
      deps.book.drop(entry.repo, entry.number);
      return at("dropped");
    }
    // A stale-but-clean pull request is never rebased: DIRTY is the only
    // trigger. A still-recomputing answer stands too — the next base push
    // reads the settled answer; nothing here retries on a clock.
    if (facts.mergeableState !== "dirty") return at("stood");
    if ((await deps.spendOf(entry)) >= settings.spendLimitUsd) {
      await deps.card(entry, spendCapLine(entry, settings.spendLimitUsd));
      return at("spend-capped");
    }
    if ((inFlight.get(entry.repo) ?? 0) >= settings.rebaseInFlight) {
      const queue = queues.get(entry.repo) ?? [];
      queue.push(entry);
      queues.set(entry.repo, queue);
      return at("queued");
    }
    void runResolver(entry); // never throws: each entry's failure is logged in its own frame
    return at("resolver");
  };

  return {
    async pushToBase(repo, base) {
      const results: WatchResult[] = [];
      for (const entry of deps.book.onBase(repo, base)) results.push(await one(entry));
      return results;
    },
  };
}
