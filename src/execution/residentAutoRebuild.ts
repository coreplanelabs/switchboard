// A resident `down` on a reason only a rebuild can escape is rebuilt on that
// transition, under a budget (docs/reference/specs/resident-repos.md item 36).
// Pure: the Worker's `goDown` and the watchdog's backstop both call
// `autoRebuildDecision` over the history row they persist
// (`resident:autoRebuilds`, ISO instants of the auto-rebuilds this resident
// has had), so the transition and the backstop cannot disagree.

/** The `down` reasons a rebuild is the only exit from: a down resident runs no
 *  cycle, and these say the snapshot (or the container that would restore it)
 *  cannot be used — never a provision failure, which would loop against the
 *  same broken build. `runtime-unreachable` is item 64's last rung: a recreated
 *  container that did not answer either; `infra-streak` is item 67's: a
 *  recreated container whose cycles kept failing in the resident's own steps. */
export const REHYDRATION_FAILURE_RE =
  /^(r2-restore-failed|snapshot-stamp-mismatch|no-snapshot|runtime-unreachable|infra-streak)/;

/** How many auto-rebuilds one resident gets inside one window. A rebuild is a
 *  clone, an install and a build (minutes to half an hour) that holds the cap
 *  slot and writes a fresh snapshot; a resident that comes back `warm` and
 *  goes `down` again on the same class of reason is flapping on something a
 *  rebuild does not fix, and the third time it stays down where a person can
 *  see it. */
export const AUTO_REBUILD_BUDGET = 2;
export const AUTO_REBUILD_WINDOW_MS = 24 * 60 * 60_000;

/** The stamp a spent budget leaves on the reason — the one mark the decision
 *  reads back so the watchdog's passes never judge the same down twice. */
const SPENT_MARK = " — auto-rebuild budget spent (";

export type AutoRebuildDecision =
  /** Rebuild now; `history` is what to persist (pruned, this instant appended); `reason` is the rebuild's. */
  | { action: "rebuild"; history: string[]; reason: string }
  /** Stay down; `reason` is the down reason stamped with the budget; `history` is pruned. */
  | { action: "budget-spent"; history: string[]; reason: string }
  | { action: "not-eligible"; why: "reason" | "already-spent" };

/** A `down` reason the transition (or the watchdog) may rebuild from: a
 *  rehydration failure that no spent budget has stamped yet. */
export function isAutoRebuildEligible(reason: string): boolean {
  return REHYDRATION_FAILURE_RE.test(reason) && !reason.includes(SPENT_MARK);
}

/** Judge one `down`. `history` are the ISO instants of this resident's past
 *  auto-rebuilds; entries outside the window (or unparseable) are dropped
 *  before counting and before writing back. */
export function autoRebuildDecision(input: {
  reason: string;
  history: readonly string[];
  now: number;
}): AutoRebuildDecision {
  if (!REHYDRATION_FAILURE_RE.test(input.reason)) return { action: "not-eligible", why: "reason" };
  if (input.reason.includes(SPENT_MARK)) return { action: "not-eligible", why: "already-spent" };
  const windowStart = input.now - AUTO_REBUILD_WINDOW_MS;
  const kept = input.history
    .map((iso) => ({ iso, at: Date.parse(iso) }))
    .filter((e) => Number.isFinite(e.at) && e.at > windowStart)
    .sort((a, b) => a.at - b.at);
  const hours = Math.round(AUTO_REBUILD_WINDOW_MS / 3_600_000);
  if (kept.length >= AUTO_REBUILD_BUDGET) {
    // No reopen instant on the stamp: a stamped row is never judged again and
    // a down resident runs no cycle, so nothing resumes when the window
    // passes — only a person's rebuild recovers it, and the stamp says so.
    return {
      action: "budget-spent",
      history: kept.map((e) => e.iso),
      reason: `${input.reason}${SPENT_MARK}${AUTO_REBUILD_BUDGET} in ${hours} h) — repo rebuild resets it`,
    };
  }
  const history = [...kept.map((e) => e.iso), new Date(input.now).toISOString()];
  return {
    action: "rebuild",
    history,
    reason: `auto-rebuild (${history.length} of ${AUTO_REBUILD_BUDGET} in ${hours} h): ${input.reason}`,
  };
}
