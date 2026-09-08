// The clock ratchet's one predicate list (features/tracing.md): which
// expressions count as a direct wall-clock read. ESLint's `clock-ban` rule
// (eslint.config.mjs) and the allowlist scanner (scripts/clock-allowlist.mts)
// both read this file, so the two cannot drift. Plain JS so the lint config can
// import it; the types live beside it in clockReads.d.mts.
//
// `Date.parse` and `Date.UTC` are not reads (they interpret a stored stamp);
// `new Date(x)` with an argument is not a read.

/** @type {ReadonlyArray<{ id: string; selector: string; message: string }>} */
export const CLOCK_READS = [
  {
    id: "Date.now",
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='now'][callee.object.name='Date']",
    message: "Read the clock through the injected `clock()` (src/core/trace), never Date.now().",
  },
  {
    id: "globalThis.Date.now",
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='now'][callee.object.type='MemberExpression'][callee.object.property.name='Date']",
    message: "Read the clock through the injected `clock()` (src/core/trace), never globalThis.Date.now().",
  },
  {
    id: "Date['now']",
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.computed=true][callee.property.value='now'][callee.object.name='Date']",
    message: "Read the clock through the injected `clock()` (src/core/trace), never Date['now']().",
  },
  {
    id: "new Date()",
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "A zero-argument `new Date()` reads the clock: use `new Date(clock())`.",
  },
  {
    id: "performance.now",
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='now'][callee.object.name='performance']",
    message: "Read the clock through the injected `clock()`, never performance.now().",
  },
  {
    id: "process.hrtime",
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='process'][callee.property.name='hrtime']",
    message: "Read the clock through the injected `clock()`, never process.hrtime().",
  },
  {
    id: "process.hrtime.bigint",
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='bigint'][callee.object.type='MemberExpression'][callee.object.object.name='process'][callee.object.property.name='hrtime']",
    message: "Read the clock through the injected `clock()`, never process.hrtime.bigint().",
  },
  {
    id: "process.uptime",
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='process'][callee.property.name='uptime']",
    message: "Read the clock through the injected `clock()`, never process.uptime().",
  },
];

/** The paths the ratchet applies to (ESLint flat-config globs). */
export const CLOCK_BAN_FILES = [
  "src/**/*.ts",
  "deploy/**/*.ts",
  "deploy/**/*.mjs",
  "web/**/*.ts",
  "web/**/*.vue",
  "scripts/**/*.ts",
  "scripts/**/*.mts",
  "scripts/**/*.mjs",
];

/** Files that may read the clock forever: every test and test helper, the one
 *  production clock, the browser's wall clock (created with its first
 *  importer), and the deploy tooling that runs outside the process. */
export const CLOCK_BAN_EXEMPT = [
  "**/*.test.ts",
  "**/*.test.mjs",
  "**/*.test.mts",
  "src/core/testing/**",
  "web/src/testing/**",
  "src/core/trace/clock.ts",
  "web/src/lib/wallClock.ts",
  "deploy/bin/**",
  "deploy/cloudflare/write-build.mjs",
];
