// The thread's runs, read once (records 0034 and 0035; docs/reference/specs/
// agent-conductor.md item 10, routing-and-config.md item 3, session-log.md
// item 9): one page of the thread's newest runs through the one runs service,
// under no visibility predicate — what a thread has run is a fact about the
// thread, not a view the requester holds. From that page the dispatcher
// derives everything it knows about the thread before the request runs: the
// lineage (a reply in a spawned thread is that child's), the sticky agent (a
// follow-up continues the agent whose transcript the thread holds, when that
// agent runs on the pi harness) and the previous run of the agent the request
// resolved to (when it ended, and whether its log ends short). Read only for a
// reply in an existing thread: a message that starts a thread has no runs.
import type { RunPullRequest } from "../runRecord.js";
import type { RunView, RunsService } from "../runsService.js";
import type { RunEvent } from "../runEvents.js";
import type { PreviousRun } from "./seed.js";
import { threadInboundArtifacts, type ThreadArtifact } from "./staging.js";

/** The files the thread received before this run (record 0033), from the
 *  prior runs' records — the `artifact` events with `direction: "in"`, oldest
 *  run first, one entry per key. Each run's record is paged to its end: a
 *  file dropped on a steer lands wherever in the log the steer did, so no
 *  page cap could keep the catalogue complete. A run whose read fails or is
 *  refused part-way contributes what was read and the log says so, so a store
 *  hiccup costs a re-pull, never the request. */
export async function readThreadArtifacts(
  service: Pick<RunsService, "getRunEvents">,
  thread: readonly RunView[],
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<ThreadArtifact[]> {
  const perRun: RunEvent[][] = [];
  for (const run of [...thread].reverse()) {
    const events: RunEvent[] = [];
    let afterSeq: number | undefined;
    try {
      for (;;) {
        const r = await service.getRunEvents(run.id, afterSeq === undefined ? {} : { afterSeq });
        if (!r.ok) {
          warn(`[thread] ${run.id}: reading its received files stopped after ${events.length} event(s) — ${r.error}`);
          break;
        }
        events.push(...r.value.events);
        if (r.value.nextAfterSeq === undefined) break;
        afterSeq = r.value.nextAfterSeq;
      }
    } catch (err) {
      warn(
        `[thread] ${run.id}: reading its received files failed after ${events.length} event(s) — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    perRun.push(events);
  }
  return threadInboundArtifacts(perRun);
}

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

/** The thread's sticky agent by transcript (routing-and-config item 3): the
 *  agent of the thread's newest run when that run can be continued and runs on
 *  the pi harness. A newest run on the native loop, or one that cannot be
 *  continued, leaves the derivation from the thread's user turns to stand. */
export function stickyAgentOf(runs: readonly RunView[], onPi: (agent: string) => boolean): string | undefined {
  const newest = runs[0];
  if (newest === undefined || !continuable(newest) || !onPi(newest.agent)) return undefined;
  return newest.agent;
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
