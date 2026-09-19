import type { Predicate } from "./authz/types.js";
import type { CoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import { buildPlaneTable, type PlanePullRequestFacts, type PlaneTable } from "./plane/table.js";
import { checkPrTitle } from "./prTitle.mjs";
import PR_TITLE_VOCABULARY from "./prTitleVocabulary.json" with { type: "json" };
import { RUN_LIST_MAX_LIMIT } from "./runRecord.js";
import type { RunsService, RunView } from "./runsService.js";
import { instanceFactsOf, type InstanceFacts, type UnitFacts } from "./unitRuns.js";
import { minutesToMs, PLANE } from "./budgets.js";
import { systemClock } from "./trace/clock.js";

// The plane service (docs/reference/specs/orchestration-plane.md items 1-3;
// docs/decisions/0064, "The table"): the one read behind `plane show` and the
// `/plane` panel. It reads the stores that exist — the runs service for the
// live rows (this process's and the ledger's foreign ones) and the runs
// finished within the recent window, each under the viewer's predicate; the
// runs service again for an instance's units, so a reader who may see none of
// the instance sees none of it here either; the instance store for the
// instance's facts; the merge door's GitHub reads for the pull requests the
// units and the runs name — and hands them to the pure table. It decides
// nothing and writes nothing; the plane's later units add the queue, the
// windows and the findings beside these rows.

/** The merge door's three GitHub reads (src/execution/githubPulls.ts), as the
 *  service needs them: each answers undefined when GitHub cannot be read. */
export interface PlaneGithubReads {
  facts(pr: { repo: string; number: number }): Promise<
    | {
        state: "open" | "closed";
        headSha?: string;
        htmlUrl?: string;
        title?: string;
        mergeableState?: string;
        mergedAt?: string;
      }
    | undefined
  >;
  checks(repo: string, sha: string): Promise<{ total: number; pending: string[]; failed: string[] } | undefined>;
  reviews(pr: { repo: string; number: number }): Promise<Array<{ state: string; commitId?: string }> | undefined>;
}

export interface PlaneServiceDeps {
  runs: Pick<RunsService, "listRuns" | "listInstanceUnits">;
  instances: Pick<CoordinatorInstanceStore, "get">;
  /** Absent (no GitHub credential in this process): every pull request is `unknown`. */
  github?: PlaneGithubReads;
  /** The repository's title rule (`check:pr-title`); default: the checked-in vocabulary. */
  titleOk?: (title: string) => boolean;
  clock?: () => number;
  /** How far back a finished run stays on the table; default one hour. */
  recentMs?: number;
  /** How many pull requests one table reads from GitHub; default 20, the units' first. */
  maxPullRequests?: number;
  /** How many finished runs the recent window lists; default 50. */
  recentLimit?: number;
}

export interface PlaneService {
  /** The table for a viewer: every row under `visibleTo`. Never throws for a
   *  GitHub that cannot be read; a store that throws propagates, as the runs
   *  service's own reads do. */
  table(visibleTo: Predicate): Promise<PlaneTable>;
}

export const DEFAULT_RECENT_MS = minutesToMs(PLANE.recentMinutes);
export const DEFAULT_MAX_PULL_REQUESTS = 20;
const DEFAULT_RECENT_LIMIT = 50;

const defaultTitleOk = (title: string): boolean => checkPrTitle(title, PR_TITLE_VOCABULARY).ok;

const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

export function createPlaneService(deps: PlaneServiceDeps): PlaneService {
  const clock = deps.clock ?? systemClock;
  const recentMs = deps.recentMs ?? DEFAULT_RECENT_MS;
  const maxPullRequests = deps.maxPullRequests ?? DEFAULT_MAX_PULL_REQUESTS;
  const recentLimit = deps.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const titleOk = deps.titleOk ?? defaultTitleOk;

  const readPullRequest = async (target: {
    repo: string;
    number: number;
    url?: string;
  }): Promise<PlanePullRequestFacts> => {
    const base: PlanePullRequestFacts = {
      repo: target.repo,
      number: target.number,
      ...(target.url ? { url: target.url } : {}),
    };
    if (!deps.github) return { ...base, unknown: true };
    const facts = await deps.github.facts(target);
    if (!facts) return { ...base, unknown: true };
    const [checks, reviews] = await Promise.all([
      facts.headSha !== undefined && facts.state === "open"
        ? deps.github.checks(target.repo, facts.headSha)
        : undefined,
      facts.state === "open" ? deps.github.reviews(target) : undefined,
    ]);
    const approvedAtHead =
      reviews !== undefined && facts.headSha !== undefined
        ? reviews.some((r) => r.state === "APPROVED" && r.commitId === facts.headSha)
        : undefined;
    return {
      ...base,
      ...(facts.htmlUrl !== undefined ? { url: facts.htmlUrl } : {}),
      state: facts.state,
      ...(facts.headSha !== undefined ? { headSha: facts.headSha } : {}),
      ...(facts.title !== undefined ? { title: facts.title, titleOk: titleOk(facts.title) } : {}),
      ...(facts.mergeableState !== undefined ? { mergeableState: facts.mergeableState } : {}),
      ...(facts.mergedAt !== undefined ? { mergedAt: facts.mergedAt } : {}),
      ...(checks !== undefined ? { checks } : {}),
      ...(approvedAtHead !== undefined ? { approvedAtHead } : {}),
    };
  };

  return {
    async table(visibleTo) {
      const now = clock();
      const [active, recent] = await Promise.all([
        deps.runs.listRuns({ status: "active", visibleTo, limit: RUN_LIST_MAX_LIMIT }),
        deps.runs.listRuns({ status: "finished", visibleTo, sinceMs: now - recentMs, limit: recentLimit }),
      ]);
      const seen = new Set<string>();
      const runs: RunView[] = [];
      for (const run of [...active.runs, ...recent.runs]) {
        if (seen.has(run.id)) continue;
        seen.add(run.id);
        runs.push(run);
      }

      const instanceIds = new Set<string>();
      for (const run of runs) {
        if (run.parentInstanceId !== undefined) instanceIds.add(run.parentInstanceId);
        if (run.instanceId !== undefined) instanceIds.add(run.instanceId);
      }
      const instances: Array<{ instance: InstanceFacts; units: UnitFacts[] }> = [];
      for (const id of instanceIds) {
        const units = await deps.runs.listInstanceUnits(id, visibleTo);
        if (units.length === 0) continue;
        const instance = await deps.instances.get(id);
        if (!instance) continue;
        instances.push({ instance: instanceFactsOf(instance), units });
      }

      const targets = new Map<string, { repo: string; number: number; url?: string }>();
      for (const { instance, units } of instances) {
        for (const unit of units) {
          if (unit.pr) {
            const target = { repo: instance.repo, number: unit.pr.number, url: unit.pr.url };
            targets.set(prKey(target), target);
          }
        }
      }
      for (const run of runs) {
        if (run.pr && run.repo !== undefined) {
          const target = { repo: run.repo, number: run.pr.number, url: run.pr.url };
          if (!targets.has(prKey(target))) targets.set(prKey(target), target);
        }
      }
      const pullRequests = await Promise.all([...targets.values()].slice(0, maxPullRequests).map(readPullRequest));

      return buildPlaneTable({ now, runs, instances, pullRequests });
    },
  };
}
