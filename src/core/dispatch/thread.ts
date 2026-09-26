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
import type { CoordinatorUnit } from "../coordinator/contract.js";
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

/** The facts the operator may read from the thread's newest finished run
 *  (routing-and-config items 3 and 29): the run's agent, repository and pull
 *  request exactly as the runs page already computed them. A coordinator child
 *  is deliberately eligible: its review of a PR is the newest completed work
 *  a bare "review again" continues. */
export interface NewestFinishedRun {
  agent?: string;
  repo?: string;
  pr?: RunPullRequest;
}

export function newestFinishedRunOf(
  runs: readonly Pick<RunView, "finished" | "agent" | "repo" | "pr">[],
): NewestFinishedRun | undefined {
  const run = runs.find((candidate) => candidate.finished);
  if (run === undefined) return undefined;
  return {
    ...(run.agent !== undefined ? { agent: run.agent } : {}),
    ...(run.repo !== undefined ? { repo: run.repo } : {}),
    ...(run.pr !== undefined ? { pr: run.pr } : {}),
  };
}

/** The thread's requester (routing-and-config item 27, record 0058): the
 *  person of the thread's newest run a person addressed — whether that run is
 *  live, finished or refused at a gate, since "who the bot is talking to" does
 *  not change when a run ends. A coordinator's child is skipped, never the
 *  requester; a page with no addressed run names nobody. */
export function requesterOf(runs: readonly RunView[]): string | undefined {
  return runs.find(addressed)?.userId;
}

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

/** The coordinator instance the thread's page names (record 0051's owner rule): the
 *  newest run that carries one — a ship run's own hand-off (`instanceId`) or a
 *  coordinator child's parent (`parentInstanceId`) — so the owner rule costs
 *  the page it already read plus at most one read of that instance's units. */
export function instanceOf(runs: readonly RunView[]): string | undefined {
  for (const r of runs) {
    if (r.instanceId !== undefined) return r.instanceId;
    if (r.parentInstanceId !== undefined) return r.parentInstanceId;
  }
  return undefined;
}

/** The thread's owner for its life (record 0051's owner rule), in this order: the live
 *  run while one is in flight; the unfinished unit of the page's instance
 *  whose row names this thread (however the page names the instance — the
 *  ship run's own `ship_handoff`, or a child's `parentInstanceId`); the
 *  ended generated pipeline whose same-thread unit still needs continuation;
 *  the newest continuable session a person addressed (`stickyAgentOf` — a
 *  coordinator's child is never the owner); none. `unitsOf` is the caller's one extra read,
 *  asked only when the page names an instance; a read that fails leaves the
 *  unit out rather than guessing. */
export type ThreadOwner =
  | { kind: "live"; run: RunView }
  | { kind: "unit"; instanceId: string; unit: CoordinatorUnit }
  /** A generated unit whose runner ended before completing its task: the
   *  thread still owns that pipeline's task, branch and pull request, so its
   *  next plain reply re-issues the same plan instead of becoming a new task. */
  | { kind: "pipeline"; instanceId: string; run: RunView; unit: CoordinatorUnit }
  /** More than one ended unit claims the same thread. No continuation may
   *  guess which durable task the person's words address. */
  | { kind: "pipeline_ambiguous"; instanceId: string; run: RunView; units: CoordinatorUnit[] }
  | { kind: "session"; agent: string }
  | { kind: "none" };

export async function ownerOf(
  runs: readonly RunView[],
  unitsOf: (instanceId: string) => Promise<CoordinatorUnit[]>,
  threadKey: string,
): Promise<ThreadOwner> {
  const live = runs.find((r) => !r.finished);
  if (live !== undefined) return { kind: "live", run: live };
  const instanceId = instanceOf(runs);
  if (instanceId !== undefined) {
    const units = await unitsOf(instanceId).catch(() => [] as CoordinatorUnit[]);
    const unit = units.find((u) => u.threadKey === threadKey && u.ending === undefined);
    if (unit !== undefined) return { kind: "unit", instanceId, unit };
    const ended = units.filter(
      (u) =>
        u.threadKey === threadKey &&
        u.ending !== undefined &&
        u.ending.kind !== "merged" &&
        u.ending.kind !== "already_landed" &&
        // A completed, publication-bound PR is new work on the next reply.
        // Keep older rows without that binding on the guarded recovery path.
        (u.ending.kind !== "merge_ready" || u.publication === undefined),
    );
    const ship = runs.find((r) => r.instanceId === instanceId && r.finished);
    if (ended.length === 1 && ship !== undefined) return { kind: "pipeline", instanceId, run: ship, unit: ended[0]! };
    if (ended.length > 1 && ship !== undefined)
      return { kind: "pipeline_ambiguous", instanceId, run: ship, units: ended };
  }
  const agent = stickyAgentOf(runs);
  if (agent !== undefined) return { kind: "session", agent };
  return { kind: "none" };
}

/** The original task a generated ship parent recorded as its first input.
 *  The coordinator's brief composer reads the same source: the run record,
 *  never a reconstruction from a later reply or a truncated unit title. */
export async function shipRequestOf(service: Pick<RunsService, "getRun">, runId: string): Promise<string | undefined> {
  const result = await service.getRun(runId, { include: "messages" }).catch(() => undefined);
  if (result === undefined || !result.ok) return undefined;
  const input = (result.value.events ?? []).find((event) => event.type === "input");
  return input?.type === "input" ? input.text : undefined;
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
