// The resident lifecycle vocabulary, shared by the resident Worker
// (deploy/cloudflare-resident/worker.ts, which owns the transitions) and the
// bot's executor selection (factory.ts, which decides what to do with a probed
// state). One definition, no runtime imports, so a renamed or added state is a
// compile error on BOTH sides instead of a silently changed gate.

export type ResidentLifecycleState = "onboarding" | "warm" | "refreshing" | "restoring" | "degraded" | "down";

/** States in which the resident serves the last snapshot and its /attach route
 *  refuses nothing: the bot attaches. `degraded` is serviceable only for the
 *  reason classes that leave the checkout intact — see `degradedIsServiceable`. */
export const SERVICEABLE_STATES: ReadonlySet<ResidentLifecycleState> = new Set<ResidentLifecycleState>([
  "warm",
  "refreshing",
  "degraded",
]);

// A `degraded` reason names its cause (docs/reference/specs/resident-repos.md item 7).
// Only a reason that PROVES the previous checkout + dep cache are intact
// attaches: `github-unreachable: …` (the fetch failed before the checkout was
// touched). `stale-mid-flight: …` does NOT qualify: it is stamped when a
// `refreshing` marker was orphaned by a cycle that died mid-flight, and that
// death may have been inside the rebuild lock section (after `git clean -fdx`,
// mid-install) — exactly the torn checkout this gate exists to avoid; the next
// refresh instance rebuilds it within one bucket anyway. A failure INSIDE the rebuild —
// `checkout-update-failed`, `install-failed`, `build-failed`,
// `snapshot-failed`, `refresh-failed` — leaves the checkout at a new sha with
// absent/partial deps, and a fresh thread would hardlink that broken cache.
// `disk-full: …` (`residentDisk.ts`) is not on the list on purpose: the
// checkout may be intact, but a full disk cannot take a worktree, a credential
// file, or even `/etc/gitconfig.lock`, so the attach would fail every time
// (recorded as `github-unreachable`, every run would attach and die at
// git-setup). Everything not on the allow-list, including unknown reasons,
// stays cold.
const SERVICEABLE_DEGRADED_REASON = /^github-unreachable(?::|$)/;

export function degradedIsServiceable(reason: string | undefined): boolean {
  return SERVICEABLE_DEGRADED_REASON.test(reason ?? "");
}

/** The bot's attach decision for a probed `{state, reason}`: true only for
 *  `warm`, `refreshing`, and a `degraded` whose reason proves the checkout intact. */
export function isServiceable(state: string, reason?: string): boolean {
  if (!SERVICEABLE_STATES.has(state as ResidentLifecycleState)) return false;
  return state !== "degraded" || degradedIsServiceable(reason);
}
