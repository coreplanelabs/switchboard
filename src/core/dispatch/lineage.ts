// The thread lineage stage of the dispatch pipeline (docs/reference/specs/agent-conductor.md
// item 10; docs/reference/specs/thread-admission.md item 6): a child is its
// thread. A person's reply in a thread that `spawnChild()` opened is that
// child's, whether the child still runs or ended: the run the reply starts
// names the spawning run as its parent (`parentRunId`, depth 1 — a run in a
// spawned thread cannot spawn) and inherits no clock, and the parent, while it
// lives, hears the reply as a follow-up FROM that child through the inbox a
// steer takes (`steerRun` — the path `send_to_run` walks the other way): the
// person's words, which child's thread they landed in, and the run now
// answering them. Nothing here starts or awaits a run: the reply's own
// dispatch proceeds as any request, and the parent reads the child's end
// through `await_runs`, whose rows follow the thread's newest run.
//
// The thread's newest run decides the lineage — the first of the one page the
// dispatcher reads of the thread's runs (dispatch/thread.ts: the same read
// yields the sticky agent and the previous run a seed continues from). A
// thread with no run, or whose newest run names no parent, has none, and the
// request runs as it always did.
import type { ConfigStore } from "../../config.js";
import type { LedgerWriteThrough } from "../runLedger/writeThrough.js";
import type { RunsService, RunView } from "../runsService.js";
import type { ThreadAdmission } from "../threadAdmission.js";
import type { Clock } from "../trace/types.js";
import type { IncomingMessage } from "../types.js";
import { steerRun, type DispatchFollowUp, type SteerOutcome } from "./admission.js";
import type { ParentRun } from "./spawn.js";

/** The depth of every run in a spawned thread: a child, which cannot spawn. */
export const LINEAGE_DEPTH = 1;

/** A spawned thread's lineage: the run that spawned it, and the thread's
 *  newest run before this request — the child as the parent knows it. */
export interface ThreadLineage {
  parentRunId: string;
  child: {
    runId: string;
    agent?: string;
    /** Still running: the reply steers it; else a new run of the child answers. */
    live: boolean;
    url?: string;
  };
}

/** How the reply was taken up in the child's thread: folded into the live
 *  child, or a new run of the child started for it (its id, once registered). */
export type LineageHeard = { kind: "steered" } | { kind: "started"; runId: string };

/** The thread's lineage, when it has one, off the thread's newest run (the
 *  first of the page `readThread` brings back, dispatch/thread.ts): a newest
 *  run that names no parent, or a thread with no run, has none. */
export function lineageOf(newest: RunView | undefined): ThreadLineage | undefined {
  if (newest === undefined || newest.parentRunId === undefined) return undefined;
  return {
    parentRunId: newest.parentRunId,
    child: {
      runId: newest.id,
      ...(newest.agent !== undefined ? { agent: newest.agent } : {}),
      live: !newest.finished,
      ...(newest.sourceUrl !== undefined ? { url: newest.sourceUrl } : {}),
    },
  };
}

/** The `parent` a run in a spawned thread dispatches with: the same parent at
 *  the child's depth, no clock — see `ParentRun`. */
export function lineageParent(lineage: ThreadLineage): ParentRun {
  return { runId: lineage.parentRunId, depth: LINEAGE_DEPTH };
}

/** What the parent reads: who said what in which child's thread, and what
 *  answers it — so the parent's next wait knows to look at that child again. */
export function lineageNote(lineage: ThreadLineage, msg: IncomingMessage, heard: LineageHeard): string {
  const who = msg.userName ?? msg.userId;
  const preset = lineage.child.agent ?? "child";
  const where = lineage.child.url !== undefined ? ` (${lineage.child.url})` : "";
  const head = `↳ Reply from ${who} in the thread of your ${preset} child run ${lineage.child.runId}${where}: ${msg.text.trim()}`;
  const tail =
    heard.kind === "steered"
      ? "The child is still running and hears it as a follow-up at its next step, so its final reply will take it into account."
      : `A new run of that child, ${heard.runId}, started there to answer it. Your await_runs and get_run_status rows for ` +
        `${lineage.child.runId} follow the thread's newest run (continuedBy names it): await it again before you compile, so ` +
        "your answer reflects what the thread settled on rather than the first reply alone.";
  return `${head}\n\n${tail}`;
}

/** How telling the parent ended: a steer's own outcome, or a parent that has
 *  already ended — nothing to tell, and the reply's run proceeds regardless. */
export type TellOutcome = SteerOutcome["kind"] | "parent_ended";

/**
 * Tell the live parent of a reply in its child's thread. The parent is read
 * through the one runs service; a parent that ended — or whose row names no
 * thread or agent to steer into — is told nothing (its answer stands; the run
 * the reply started still carries its id). Otherwise `steerRun` as the person
 * who replied, from the child: the same allowlist gate a thread reply passes
 * (being heard by the parent's agent counts as running it), the durable copy
 * first, then the parent's slot here or its durable inbox on the generation
 * that drives it. The reply's link is the item's link, so the parent's run
 * page points at the message in the child's thread.
 */
export async function tellParent(
  deps: {
    runs: Pick<RunsService, "getRun">;
    config: Pick<ConfigStore, "canRunAgent" | "grantsFor">;
    runLedger: Pick<LedgerWriteThrough, "pushInbox">;
    clock?: Clock;
    admission: ThreadAdmission<DispatchFollowUp>;
    isolateFollowUps?: boolean;
  },
  lineage: ThreadLineage,
  msg: IncomingMessage,
  heard: LineageHeard,
): Promise<TellOutcome> {
  const res = await deps.runs.getRun(lineage.parentRunId);
  if (!res.ok) return "parent_ended";
  const parent = res.value;
  if (parent.finished || parent.threadKey === undefined || parent.agent === undefined) return "parent_ended";
  // A reply in a child's conversation is still input from that person. The
  // lineage notification must not bypass the channel's requester isolation.
  if (deps.isolateFollowUps && parent.userId !== msg.userId) return "refused";
  const out = await steerRun(
    deps,
    {
      userId: msg.userId,
      ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
      ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
      ...(msg.postedBy !== undefined ? { postedBy: msg.postedBy } : {}),
      channelId: msg.channelId,
      ...(msg.channelName !== undefined ? { channelName: msg.channelName } : {}),
      ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
      from: { runId: lineage.child.runId },
    },
    { runId: parent.id, threadKey: parent.threadKey, agent: parent.agent },
    lineageNote(lineage, msg, heard),
  );
  console.log(
    `[lineage] ${msg.threadKey}: reply in the ${lineage.child.agent ?? "child"} child ${lineage.child.runId}'s thread → parent ${parent.id} (${out.kind})`,
  );
  return out.kind;
}
