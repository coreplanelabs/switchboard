// The thread's runs, read once (records 0034 and 0035; docs/reference/specs/
// agent-conductor.md item 10, routing-and-config.md item 3, session-log.md
// item 9): one page of the thread's newest runs through the one runs service,
// under no visibility predicate — what a thread has run is a fact about the
// thread, not a view the requester holds. From that page the dispatcher
// derives everything it knows about the thread before the request runs: the
// lineage (a reply in a spawned thread is that child's), the sticky agent (a
// follow-up continues the agent whose transcript the thread holds), the
// previous run of the agent the request resolved to (when it ended, and
// whether its log ends short) and the requests of that agent the provider
// refused under its usage policy (the rows the seed leaves out). Read only for
// a reply in an existing thread: a message that starts a thread has no runs.
import type { RunPullRequest } from "../runRecord.js";
import type { RunView, RunsService } from "../runsService.js";
import type { PreviousRun } from "./seed.js";

/** How many of the thread's newest runs one read brings back: enough to find
 *  the previous run of the resolved agent behind a few runs of another. */
export const THREAD_READ_LIMIT = 8;

/** The thread's newest runs, newest first (a live one ahead of the finished);
 *  undefined when the read failed — the request runs as if the thread were
 *  new, and the log says so. */
export async function readThread(
  service: Pick<RunsService, "listRuns">,
  threadKey: string,
): Promise<RunView[] | undefined> {
  try {
    const page = await service.listRuns({
      status: "all",
      visibleTo: { kind: "all" },
      threadKey,
      limit: THREAD_READ_LIMIT,
    });
    return page.runs;
  } catch (err) {
    console.warn(`[thread] ${threadKey}: thread read failed — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** A finished run whose transcript can be continued: its record names its
 *  session log. A run refused at a gate wrote none; a run from before the log
 *  existed has none to read; a live run is steered, not continued. */
export function continuable(run: RunView): run is RunView & { agent: string } {
  return run.finished && run.session !== undefined && run.agent !== undefined;
}

/** A run a person addressed to the thread — not one a coordinator spawned
 *  into it (`parentInstanceId`, run-history item 48). A generated plan's unit
 *  runs in the requesting thread (agent-ship item 16), so its coding and
 *  review children sit newest on the page; they are the runner's turns, and a
 *  person's follow-up is not a continuation of them. */
const addressed = (run: RunView): boolean => run.parentInstanceId === undefined;

/** The thread's sticky agent by transcript (routing-and-config item 3): the
 *  agent of the thread's newest run a person addressed, when that run can be
 *  continued. A newest run that cannot be — live, refused at a gate, from
 *  before the log — leaves no sticky agent: the request resolves through the
 *  config scopes (and the router, for a plain message) as a fresh thread's
 *  would. A coordinator's child is skipped, never the sticky agent: a
 *  plain-words re-review typed into a ship thread routes to review instead of
 *  continuing the coding child's session. */
export function stickyAgentOf(runs: readonly RunView[]): string | undefined {
  const newest = runs.find(addressed);
  if (newest === undefined || !continuable(newest)) return undefined;
  return newest.agent;
}

/** The route a sticky-by-transcript follow-up carries (routing-and-config
 *  item 21): the decision the thread's newest run ran under, off its record
 *  (`RunRecord.route` — the run's own route, or one it carried in turn, so the
 *  receipt survives a chain of follow-ups). Read only for the run
 *  `stickyAgentOf` picked, and only its preset, reason and model: a compound's
 *  parts and a collapse were that run's alone — the follow-up spawns nothing
 *  and collapsed nothing. Undefined when the newest run was not routed, so an
 *  unrouted thread's card is exactly what it was. */
export function threadRouteOf(
  runs: readonly RunView[],
  agent: string,
): { preset: string; reason: string; model: string } | undefined {
  const newest = runs.find(addressed);
  if (newest === undefined || !continuable(newest) || newest.agent !== agent || newest.route === undefined)
    return undefined;
  const { preset, reason, model } = newest.route;
  return { preset, reason, model };
}

/** The thread's previous run of `agent` a seed continues from (session-log
 *  item 9): its end, so the lines written after it can be told apart, and
 *  whether its record says the log ends short of what it saw. */
export function previousRunOf(runs: readonly RunView[], agent: string): PreviousRun | undefined {
  const run = runs.find((r) => r.agent === agent && continuable(r));
  if (run === undefined) return undefined;
  return {
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    broken: run.session!.range === "broken",
  };
}

/** The thread's finished runs newer than the agent's previous run — every
 *  finished run when the agent has none to continue there — oldest first: the
 *  runs whose typed artifacts a seed is handed (session-log item 9). The page
 *  is newest first, so "newer" is "before it on the page"; a live run has no
 *  record yet and is left out; another agent's run and a coordinator's child
 *  count alike, since both are runs of the thread. The previous run itself is
 *  the session the seed continues, not an artifact of it. */
export function runsSince(runs: readonly RunView[], agent: string): RunView[] {
  const previous = runs.findIndex((r) => r.agent === agent && continuable(r));
  return (previous < 0 ? runs : runs.slice(0, previous)).filter((r) => r.finished).reverse();
}

/** The log rows of the requests the provider refused under its usage policy
 *  (session-log item 9): the request row of every finished run of `agent`
 *  in the page whose record names its session and says
 *  `failure: policy_refusal` (run-history.md item 57) — the rows the next
 *  seed leaves out of the tail, since the words in them are refused again on
 *  every request that carries them. A run that failed for another reason,
 *  another agent's run, a live run and a run without a session name none. */
export function refusedRequestsOf(runs: readonly RunView[], agent: string): number[] {
  return runs
    .filter((r) => r.agent === agent && continuable(r) && r.failure?.kind === "policy_refusal")
    .map((r) => r.session!.request);
}

/** The pull request the thread's work lives on (docs/reference/specs/
 *  resident-repos.md item 29): the one the thread's newest finished run
 *  opened or edited, as its record says (`RunRecord.pr`), with the repo the
 *  record names and when the run ended — so the resolver can weigh it against
 *  a pull request a person named later in the thread. */
export interface ThreadPullRequest {
  repo: string;
  number: number;
  /** When the run that opened it ended (its start when the record has no end). */
  at: number;
}

/** The newest finished run in the page whose record carries a pull request
 *  and names its repository. A live run has no record yet; a run that opened
 *  none lends nothing, whatever it did otherwise. */
export function threadPrOf(runs: readonly RunView[]): ThreadPullRequest | undefined {
  const run = runs.find(
    (r): r is RunView & { repo: string; pr: RunPullRequest } =>
      r.finished && r.pr !== undefined && r.repo !== undefined,
  );
  if (run === undefined) return undefined;
  return { repo: run.repo, number: run.pr.number, at: run.finishedAt ?? run.startedAt };
}
