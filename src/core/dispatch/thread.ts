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
