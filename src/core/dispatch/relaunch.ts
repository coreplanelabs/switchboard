// The relaunch ceiling (docs/reference/specs/harness.md item 6; record 0038's
// survival clause): what the run loop does when the harness reports the run's
// container replaced under a living bot — the steps a live run could not
// reach before the seam, in this order: the bound on relaunches, read off the
// row's facts so it survives a bot generation; the workspace re-attached
// where the row says it is or refused by name (run-history item 54, the one
// step the dispatch-time attach and a run in flight share); the bearer
// rotated on the run's own meter with the row's write issued inside the
// rotation (model-proxy item 2); and the resume the harness rebuilds from —
// the record the harness held at the interruption, its facts and its budget
// filled in here. Harness-neutral: the rebuild itself is the harness's `open`
// with that resume, and every refusal is the seam's `HarnessInterruptedError`,
// so the loop closes the run `interrupted` for the dispatcher's restart
// exactly as the floor does (harness-pi item 16).

import type { AgentDef } from "../../agents/registry.js";
import type { RunProfile } from "../../config/profile.js";
import type { WorkspaceBinding } from "../../execution/factory.js";
import {
  HarnessInterruptedError,
  RELAUNCH_CEILING,
  type Harness,
  type HarnessContainerReplacedError,
  type HarnessFacts,
  type HarnessResume,
} from "../harness/contract.js";
import type { RepoContext } from "../repoContext.js";
import type { RoundWorkspace } from "../reviewRound.js";
import type { Clock, Span } from "../trace/types.js";
import { reattachWorkspace, type ProvisionDeps } from "./provision.js";

/** A relaunch refused by name — the ceiling reached, the workspace lost, the
 *  bearer not rotatable, a harness with its own store, a row without facts:
 *  the run closes `interrupted` and its request runs again as a new run, the
 *  floor's outcome. `message` starts at the why — the harness's own
 *  `sandbox_restarted` note already carries the verdict, and the loop's note
 *  of the same kind carries this — and `reason` is the card's line. */
export class RelaunchRefusedError extends HarnessInterruptedError {
  constructor(message: string, reason: string, refusal: string) {
    super(message, reason, refusal);
    this.name = "RelaunchRefusedError";
  }
}

/** What the relaunch reads off the run. */
export interface RelaunchContext {
  runId: string;
  threadKey: string;
  agent: AgentDef;
  profile: RunProfile;
  repoCtx: RepoContext;
  /** The run's own span: the re-attach's `dispatch.workspace.attach` hangs under it. */
  root: Span;
  clock: Clock;
  harness: Pick<Harness, "name" | "history">;
  /** The harness's verdict: the container replaced, the record it holds. */
  replaced: HarnessContainerReplacedError;
  /** The row's harness facts as this run last saved them; none when no process ever left any. */
  facts: HarnessFacts | undefined;
  /** The run's recorded workspace, re-attached before the process starts; none for a run without one. */
  binding: WorkspaceBinding | undefined;
  /** The run's hard stop (`run.control.hardSignal`): it rides into the re-attach's
   *  wake wait, so a stop while the replacement is being re-attached ends it at
   *  once and the run ends stopped, never relaunched (execution.md item 9). */
  stopSignal?: AbortSignal;
  /** The run's remaining wall clock (`run.control.remainingMs`, the lease the
   *  relaunch continues): every attach the re-attached executor opens is
   *  clipped to it (execution.md item 9). */
  remainingMs?: () => number | undefined;
  /** The row's write for the harness facts — issued inside the rotation, as its contract requires. */
  saveFacts: (facts: HarnessFacts) => void;
  /** The run's requester (the platform-namespaced user id), whose stored
   *  GitHub binding names the commits' author pair in the re-attached
   *  workspace's env (record 0062). */
  requester?: string;
}

export type RelaunchDecision =
  | {
      kind: "relaunch";
      /** What the harness opens the run on: the record, the rotated facts, the budget left, the relaunch's word. */
      resume: HarnessResume;
      /** The rotated bearer for the new process; none without a bearer store (the CLI, a test). */
      bearer?: string;
      /** The re-attached round, whose executor the run holds from here; none for a run without a workspace. */
      round?: RoundWorkspace;
    }
  | { kind: "refused"; interruption: HarnessInterruptedError }
  /** The run's own stop ended the re-attach: nothing is written or rotated, and the run ends stopped. */
  | { kind: "stopped" }
  /** The run is inside its write-up reserve, or ran into it under the
   *  re-attach's waits (execution.md item 9): its workspace was not asked for,
   *  nothing is written or rotated, and the run ends on its budget — never
   *  `workspace_lost`, never a new run from the request. `why` is the budget
   *  note's line: what happened, and why there was no write-up. */
  | { kind: "lease_spent"; why: string };

/**
 * The relaunch, decided and prepared: refused by name, or the resume the
 * harness rebuilds from with the workspace re-attached and the bearer rotated.
 * The row's facts are written exactly once here, inside `rotate`'s callback
 * (or directly without a store): the new hash, the count one higher, nothing
 * else changed — so the row names the relaunch's secret before the old ones
 * stop verifying, and a bot that dies between the two steps resumes a pi it
 * can honour. A `saveFacts` that throws propagates as the run's failure:
 * nothing is relaunched, and the store keeps both secrets verifying.
 */
export async function prepareRelaunch(
  deps: Pick<ProvisionDeps, "config" | "dataDir" | "runBearers" | "githubCredentials">,
  ctx: RelaunchContext,
): Promise<RelaunchDecision> {
  const { replaced, facts, harness } = ctx;
  const refuse = (why: string, reason: string, refusal = "container_replaced"): RelaunchDecision => ({
    kind: "refused",
    interruption: new RelaunchRefusedError(why, reason, refusal),
  });
  // An own-store harness has only the store that went with the container (harness.md item 6).
  if (harness.history !== "authored-session")
    return refuse(
      `the ${harness.name} harness keeps its own store, which went with the container, so nothing here can rebuild its process; the run restarts from its request`,
      "container replaced under the run; the harness keeps its own store; restarting from the request",
    );
  // The bound lives on the row's facts; a row that never got any cannot keep it.
  if (facts === undefined)
    return refuse(
      "the row carries no harness facts to count a relaunch on; the run restarts from its request",
      "container replaced under the run before its process left facts; restarting from the request",
    );
  const relaunches = facts.relaunches;
  if (relaunches >= RELAUNCH_CEILING)
    return refuse(
      `the container was replaced under the run again and the relaunch ceiling is ${RELAUNCH_CEILING} (${relaunches} relaunches already), so pi is not started a ${ordinal(relaunches + 2)} time; the run restarts from its request`,
      `relaunch ceiling: ${relaunches} relaunches already; restarting from the request`,
    );
  // The workspace, where the row says it is or nowhere (run-history item 54).
  let round: RoundWorkspace | undefined;
  if (ctx.binding !== undefined) {
    const reattached = await reattachWorkspace(deps, {
      threadKey: ctx.threadKey,
      agent: ctx.agent,
      profile: ctx.profile,
      repoCtx: ctx.repoCtx,
      root: ctx.root,
      clock: ctx.clock,
      reattach: ctx.binding,
      ...(ctx.requester !== undefined ? { requester: ctx.requester } : {}),
      ...(ctx.stopSignal !== undefined ? { stopSignal: ctx.stopSignal } : {}),
      ...(ctx.remainingMs !== undefined ? { remainingMs: ctx.remainingMs } : {}),
    });
    // The stop that ended the re-attach's wait is the run's end, decided before
    // the rotation: nothing is written, the bearers stand, nothing relaunches.
    if (reattached.kind === "stopped") return { kind: "stopped" };
    // The lease inside its write-up reserve is the run's end, decided before
    // any request and before the rotation: a re-dispatch with a fresh lease
    // would be the run restarted from scratch seconds from its deadline.
    if (reattached.kind === "lease_spent")
      return {
        kind: "lease_spent",
        // The bound's own sentence (`attachBoundWithinRun`'s note, the one
        // source, worded by the bound that refused), with what it meant here.
        why: `the container was replaced under the run: ${reattached.note}; no write-up ran`,
      };
    if (reattached.kind === "reattach_refused")
      return refuse(
        `the run's workspace could not be re-attached in the replacement container (${reattached.why}); the run restarts from its request under the same run id`,
        "workspace lost with the replaced container; restarting from the request",
        "workspace_lost",
      );
    round = reattached.round;
  }
  // The rotation (model-proxy item 2): the row's write inside it, the count one higher.
  const counted: HarnessFacts = { ...facts, relaunches: relaunches + 1 };
  let written: HarnessFacts = counted;
  let bearer: string | undefined;
  if (deps.runBearers) {
    const rotated = deps.runBearers.rotate(ctx.runId, (secretHash) => {
      written = { ...counted, bearerHash: secretHash };
      ctx.saveFacts(written);
    });
    if (!rotated.ok)
      return refuse(
        `the run's bearer could not be rotated for the relaunch (${rotated.reason}); the run restarts from its request`,
        `the run's bearer could not be rotated (${rotated.reason}); restarting from the request`,
      );
    bearer = rotated.token;
  } else {
    ctx.saveFacts(written);
  }
  const { deadline, ...record } = replaced.record;
  return {
    kind: "relaunch",
    resume: {
      ...record,
      remainingMs: Math.max(0, deadline - ctx.clock()),
      facts: written,
      relaunch: {
        ...(replaced.was !== undefined ? { from: replaced.was } : {}),
        ...(replaced.now !== undefined ? { to: replaced.now } : {}),
      },
    },
    ...(bearer !== undefined ? { bearer } : {}),
    ...(round !== undefined ? { round } : {}),
  };
}

function ordinal(n: number): string {
  return n === 2 ? "second" : n === 3 ? "third" : n === 4 ? "fourth" : `${n}th`;
}
