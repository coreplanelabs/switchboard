// What commit a Worker script is running (docs/reference/specs/execution.md item 13).
//
// The bot has always known this: `npm run deploy` writes `build.json`, the
// image COPYs it, and `/healthz` serves `build: {commit, builtAt}` — which is
// how `deploy all`'s live gate tells "deployed" from "live". The three Worker
// SCRIPTS (resident, memory, sandbox) had no equivalent. The resident instead
// carried a hand-edited `const BUILD_MARKER = "perf53"` whose comment said
// "bump on every deploy-worthy change"; a marker bumped by hand goes unbumped
// the first busy week. That costs twice over: a deploy cannot be proven from
// outside (its receipt has to be assembled from `wrangler versions list` plus a
// container digest), and the test-override guard rail that expires an override
// when the build changes (resident-repos item 49(c), `ignored:"stale-build …"`)
// silently stops expiring anything.
//
// A file cannot carry the stamp into a Worker script the way it does into the
// bot's image: it would have to be either committed (so a deploy dirties the
// tree, which `deploy all` then refuses) or gitignored (so `tsc` and a fresh
// clone fail on the missing import). So the deploy SUBSTITUTES it —
// `wrangler deploy --define` (see `deploy/bin/build-stamp.mjs`) — and this
// module is the one place that reads it.
//
// `--define` and not `--var`: a CLI `--var` may replace the `vars` block a
// Worker's wrangler.jsonc declares, and the resident's `STATE_WORKER_URL` var
// is load-bearing (the watchdog records firings through it). A bundle-time
// substitution cannot touch bindings.

/** What a Worker reports as `build` on `/healthz`. Shaped like the bot's
 *  `BuildInfo` (`src/channels/health.ts`) so both read the same to an
 *  operator and to `src/deploy/liveGate.ts`. */
export interface BuildStamp {
  commit: string;
  builtAt?: string;
}

/** The commit of a Worker nobody stamped — a bare `wrangler deploy`, `wrangler
 *  dev`, or a test process. Never silently absent: an operator must be able to
 *  tell "built without a stamp" from "built at this commit". */
export const UNKNOWN_COMMIT = "unknown";

// The identifiers `deploy/bin/build-stamp.mjs` substitutes. They are declared,
// never defined: with no `--define` they do not exist at runtime at all, which
// is why every read below goes through `typeof` first (see injectedBuildStamp).
declare const SWITCHBOARD_BUILD_COMMIT: string;
declare const SWITCHBOARD_BUILT_AT: string;

/** Pure: the stamp for whatever the deploy injected. A commit that is missing,
 *  blank, or not a string becomes `unknown`, and `builtAt` is dropped rather
 *  than guessed — a made-up build time is worse than none. */
export function resolveBuildStamp(commit: unknown, builtAt: unknown): BuildStamp {
  const trimmed = typeof commit === "string" ? commit.trim() : "";
  const at = typeof builtAt === "string" ? builtAt.trim() : "";
  return { commit: trimmed === "" ? UNKNOWN_COMMIT : trimmed, ...(at === "" ? {} : { builtAt: at }) };
}

/** The identity a stored artifact compares itself against — the commit, plus
 *  the build's own timestamp when there is one.
 *
 *  Not the commit alone: two builds of the same DIRTY tree carry the same
 *  `<sha>-dirty` commit, and a redeploy of the same clean commit is still a
 *  later build. The resident's test overrides (`gc.ts` `effectiveLimits`,
 *  resident-repos item 49(c)) are expired by "a different build wrote this",
 *  so a coarser identity leaves a forgotten admin cap alive across exactly the
 *  deploys that were meant to clear it. `builtAt` is injected once per deploy,
 *  so every isolate of one deployed version agrees — an override set through
 *  one isolate is still honored by its siblings.
 *
 *  An UN-stamped bundle (`wrangler dev`, a bare `wrangler deploy`) therefore
 *  shares one id across all of its builds, and an override does not expire
 *  between them. That is deliberate, not an oversight: with nothing injected
 *  there is no value that differs per build yet is stable per deployment —
 *  anything generated at module load would differ per ISOLATE, so overrides
 *  would vanish between siblings of one deployment, which is the worse
 *  failure. Stamped deploys are the case the guard rail exists for. */
export function buildId(stamp: BuildStamp): string {
  return stamp.builtAt === undefined ? stamp.commit : `${stamp.commit}@${stamp.builtAt}`;
}

/** The stamp this bundle was built with. Reading an undeclared identifier is a
 *  ReferenceError, and `typeof` is the one operator that tolerates one — so it
 *  gates both reads, and an un-stamped bundle answers `unknown` instead of
 *  throwing inside `/healthz`. */
export function injectedBuildStamp(): BuildStamp {
  return resolveBuildStamp(
    typeof SWITCHBOARD_BUILD_COMMIT === "string" ? SWITCHBOARD_BUILD_COMMIT : null,
    typeof SWITCHBOARD_BUILT_AT === "string" ? SWITCHBOARD_BUILT_AT : null,
  );
}
