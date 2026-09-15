import type { ResidentStatusProbe } from "./resident.js";
import { RUNTIME_REPLACEMENT_WORDING } from "./residentRefresh.js";
import { isServiceable } from "./residentState.js";

// A resident container that vanished under a live run (docs/reference/specs/
// resident-repos.md item 65). The container rollout that follows a resident
// Worker deploy stops every resident's container and starts it again on the
// new image, three to ten minutes after the deploy; a run admitted in that
// window has its next `/exec` refused `not-serviceable: The container just
// exited` before the command starts. The resident wakes itself from its
// snapshot within about a minute (the next attach or refresh instance
// restores it), so the refusal is a pause, not a dead sandbox; read as two
// infra failures, the native loop's two-strikes rule aborted the run. The pi
// harness reads the restart as its container replaced under the run and ends
// the run for a restart from its request (harness-pi.md item 16).
// These are the pure decisions the client makes before it counts a strike;
// the wait itself is `ResidentExecutor.awaitWake`.

/** The wait's ceiling: a wake is about a minute; three covers a slow restore
 *  and leaves a run with budget to finish. The command's own budget bounds
 *  it further (`wakeWaitBudget`), so a run never waits past its wall clock. */
export const WAKE_WAIT_MAX_MS = 3 * 60_000;

/** Between `/status` polls: a wake takes tens of seconds, so anything under
 *  a few seconds would only burn Worker requests. */
export const WAKE_POLL_MS = 5_000;

/** Each `/status` poll's own bound, so a resident Worker that hangs cannot
 *  hold the wait past its budget. */
export const WAKE_PROBE_TIMEOUT_MS = 5_000;

/** The platform's own words for a container that is gone for a moment: the
 *  incident's `The container just exited`, and the SDK's answer while the
 *  replacement boots. The runtime-replacement wordings the refresh classifier
 *  and the exec path share (`RUNTIME_REPLACEMENT_WORDING`) are the same
 *  condition seen from inside the wake path. */
const CONTAINER_GONE_WORDING = /the container just exited|container is starting/i;

/** Whether a resident refusal names a container that is gone for a moment: a
 *  `not-serviceable:` answer whose detail is the platform's exited/starting
 *  wording or a runtime replacement, or attach's `image-stale:` (the
 *  container predates the current pool and is restarting). Every other
 *  refusal (`registry record or repo facts missing`, `no-snapshot`,
 *  `mirror-busy`, a `runtime-replaced` mid-command) stays with the rule that
 *  already owns it. */
export function isContainerRolling(error: unknown): boolean {
  if (typeof error !== "string") return false;
  const text = error.trim();
  if (text.startsWith("image-stale:")) return true;
  const prefix = "not-serviceable: ";
  if (!text.startsWith(prefix)) return false;
  const detail = text.slice(prefix.length);
  return CONTAINER_GONE_WORDING.test(detail) || RUNTIME_REPLACEMENT_WORDING.test(detail);
}

/** Degraded reasons that are not evidence about the repository and that the
 *  engine retries on its own (the resident's `NON_EVIDENCE_REASON`): the
 *  watchdog's `stale-mid-flight`, the wake path's `restore-interrupted`, and
 *  the unreachable ladder's `runtime-unreachable` (item 64). */
const TRANSIENT_DEGRADED_REASON = /^(?:stale-mid-flight|restore-interrupted|runtime-unreachable):/;

export type WakeDecision = { wait: true; why: string } | { wait: false; why: string };

/** Whether the engine view says the container is coming back. Wait while the
 *  engine holds a snapshot the container wakes from: `restoring` (the wake is
 *  running), any serviceable state (`warm`, `refreshing`, `degraded` with an
 *  intact checkout: `isServiceable`), or a `degraded` reason the engine
 *  retries by itself. Strike on a definite answer no wake recovers from
 *  (`down`, `onboarding`, a repo failure, not onboarded, an off-table state)
 *  and on a resident Worker that did not answer at all: nothing then says
 *  the container is coming back, and the two-strikes rule stands. */
export function wakeDecision(probe: ResidentStatusProbe): WakeDecision {
  if (probe.kind === "unreachable") {
    return {
      wait: false,
      why: `the resident Worker did not answer /status (${probe.error}), so nothing says the container is coming back`,
    };
  }
  const seen = describeState(probe.state, probe.reason);
  if (probe.state === "restoring") return { wait: true, why: `the resident is ${seen}: the wake is already running` };
  if (isServiceable(probe.state, probe.reason)) {
    return { wait: true, why: `the resident is ${seen}: the engine holds the snapshot the container wakes from` };
  }
  if (probe.state === "degraded" && TRANSIENT_DEGRADED_REASON.test(probe.reason)) {
    return { wait: true, why: `the resident is ${seen}: the engine retries that on its own` };
  }
  return { wait: false, why: `the resident is ${seen}, which no wake recovers from; not waiting` };
}

export function describeState(state: string, reason: string): string {
  return reason ? `${state} (${reason})` : state;
}

export function describeProbe(probe: ResidentStatusProbe): string {
  return probe.kind === "status" ? describeState(probe.state, probe.reason) : `unreachable (${probe.error})`;
}

/** How long the wait may take: the command's own budget (the bash tool has
 *  already clipped it to the run's remaining wall clock minus the write-up
 *  reserve) under the ceiling; never negative. No budget (`/read`, `/write`)
 *  means the ceiling. */
export function wakeWaitBudget(commandBudgetMs: number | undefined): number {
  if (commandBudgetMs === undefined || !Number.isFinite(commandBudgetMs)) return WAKE_WAIT_MAX_MS;
  return Math.max(0, Math.min(WAKE_WAIT_MAX_MS, Math.trunc(commandBudgetMs)));
}

/** What the model is told once the resident is back: how long the wait took
 *  and the tree it comes back to. The re-attach recreated the thread's
 *  worktree from the mirror at the bound ref's tip, so anything the run had
 *  not pushed is gone with the old container's disk. */
export function sandboxRestartedMessage(woke: { waitedMs: number; ref: string; sha: string }): string {
  const secs = Math.round(woke.waitedMs / 1000);
  return (
    `the resident container exited under a rollout and woke from its snapshot after ${secs}s; ` +
    `the worktree was recreated at ${woke.ref}@${woke.sha.slice(0, 7)}, ` +
    "so uncommitted changes and unpushed commits from earlier in this run are gone"
  );
}
