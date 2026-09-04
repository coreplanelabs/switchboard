// What commit a Worker script is running (features/execution.md item 13).
//
// The bot has always known this: `npm run deploy` writes `build.json`, the
// image COPYs it, and `/healthz` serves `build: {commit, builtAt}` — which is
// how `deploy all`'s live gate tells "deployed" from "live". The three Worker
// SCRIPTS (resident, memory, sandbox) had no equivalent. The resident instead
// carried a hand-edited `const BUILD_MARKER = "perf53"` whose comment said
// "bump on every deploy-worthy change"; it was bumped three times in total and
// then went unbumped across five deploys (2026-08-30 → 2026-09-04, #434
// included). That cost twice over: a deploy could not be proven from outside
// (PR #434's receipts had to be assembled from `wrangler versions list` plus a
// container digest), and the test-override guard rail that expires an override
// when the build changes (resident-repos item 49(c), `ignored:"stale-build …"`)
// silently stopped expiring anything.
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
