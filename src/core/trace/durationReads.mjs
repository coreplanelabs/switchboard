// The duration ratchet's one predicate list (docs/reference/specs/tracing.md
// item 8; decision 0046): which expressions count as a minutes-scale duration
// literal — a wall clock written in a file instead of read from
// `src/core/budgets.ts`, the one table every budget derives from. ESLint's
// `duration-ban` rule (eslint.config.mjs) and the allowlist scanner
// (durationScan.mjs, run by scripts/clock-allowlist.mts) both read this file, so the two cannot drift.
// Plain JS so the lint config can import it; the types live beside it in
// durationReads.d.mts.
//
// Three shapes are a duration literal: a number multiplied by 60000 (`5 * 60_000`),
// a number multiplied by a minute constant (`5 * MIN`, `5 * MINUTE_MS`), and a
// bare literal that is one of the common minute, hour or day counts in
// milliseconds (`900_000`, `3_600_000`, `86_400_000`). Seconds-scale literals
// (`5_000`, `30_000`) are timeouts a leaf call owns and are not this class.
import { CLOCK_BAN_EXEMPT, CLOCK_BAN_FILES } from "./clockReads.mjs";

/** The bare millisecond literals the class names, as their source text may be spelled. */
export const MINUTE_SCALE_RAW =
  "^(?:60_?000|120_?000|180_?000|300_?000|600_?000|900_?000|1_?200_?000|1_?500_?000|1_?800_?000|2_?400_?000|3_?600_?000|7_?200_?000|86_?400_?000)$";

/** The identifiers a minutes multiplication names its unit with. */
export const MINUTE_UNIT_NAMES = "^(?:MIN|MINUTE_MS|MINUTES_MS|MINUTE)$";

/** @type {ReadonlyArray<{ id: string; selector: string; message: string }>} */
export const DURATION_READS = [
  {
    id: "n * 60000",
    selector: "BinaryExpression[operator='*'] > Literal[raw=/^60_?000$/]",
    message:
      "A minutes-scale duration is a row of src/core/budgets.ts (an ask, a floor or an allowance), not a literal here.",
  },
  {
    id: "n * MIN",
    selector: `BinaryExpression[operator='*'] > Identifier[name=/${MINUTE_UNIT_NAMES}/]`,
    message:
      "A minutes-scale duration is a row of src/core/budgets.ts (an ask, a floor or an allowance), not a literal here.",
  },
  {
    // A literal standing alone, or a minute-scale operand of a multiplication
    // other than the 60000 the shape above already reports (`2 * 900_000` is
    // one literal here, `5 * 60_000` one there) — the scanner counts the same way.
    id: "minute-scale literal",
    selector: `Literal[raw=/${MINUTE_SCALE_RAW}/]:not(BinaryExpression[operator='*'] > Literal[raw=/^60_?000$/])`,
    message:
      "A minutes-scale duration is a row of src/core/budgets.ts (an ask, a floor or an allowance), not a literal here.",
  },
];

/** The paths the ratchet applies to: the same tree the clock ratchet covers. */
export const DURATION_BAN_FILES = [...CLOCK_BAN_FILES];

/** Files that may hold a duration literal forever: everything the clock ratchet
 *  exempts, the one table the literals belong in, and the two ratchets' own
 *  predicate lists and scanners. */
export const DURATION_BAN_EXEMPT = [
  ...CLOCK_BAN_EXEMPT,
  "src/core/budgets.ts",
  "src/core/trace/durationReads.mjs",
  "src/core/trace/durationScan.mjs",
];
