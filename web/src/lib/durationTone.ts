// Duration heat: the ONE mapping from "how long did this take" to a colour, so a
// 15-minute command cannot hide as one more grey line among 200 ms greps
// (docs/reference/specs/live-view.md item 24). Two independent signals, never mixed:
//
//   - HEAT is continuous. A duration is placed on a log scale between the
//     kind's quiet floor and its ceiling; that position (`--heat-t`, 0..1) is
//     the only thing this module hands the DOM. The `.heat` utility in
//     `main.css` turns it into OKLCH with a FIXED lightness per theme
//     (`--sb-heat-l`) so every step of the ramp keeps the same contrast
//     against the page — only hue (amber → red) and chroma (pale → saturated)
//     carry the signal. Below the floor the text inherits the surrounding
//     muted colour: most calls are quick and should stay quiet.
//   - OVER BUDGET is categorical. A command the sandbox killed at its deadline
//     is not "very slow", it is a failed budget, and it gets the status
//     palette's `bad` treatment plus a label, regardless of how long it ran.
//     The signal is exit 124 ONLY: every executor renders its own deadline kill
//     as an `exit 124:` line (`bashTimeoutNote`), and `runBash` deliberately
//     keeps a foreign SIGKILL (137 — the OOM killer, a `kill -9`) out of that
//     path, so 137 here would label an OOM as "timed out".
//
// The scale's anchors are the runtime's own numbers: the bash tool's 20-minute
// ceiling (`BASH_TIMEOUT_MAX_MS`), the friction analyzer's 30 s slow-tool and
// 60 s slow-turn thresholds, and the coding agent's 45-minute wall clock.

export type HeatKind = "tool" | "turn" | "run";

/** 0 = quiet (inherits), 1–3 = warmer, 4 = over budget. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface Heat {
  level: HeatLevel;
  /** The categorical over-budget state (a timed-out command). */
  over: boolean;
  /** Where on the ramp this landed, 0..1 (1 = at or past the ceiling). */
  t: number;
}

interface Scale {
  floorMs: number;
  ceilingMs: number;
}

const SCALES: Record<HeatKind, Scale> = {
  // A shell call under 2 s is noise; the bash tool's hard ceiling is 20 min.
  tool: { floorMs: 2_000, ceilingMs: 20 * 60_000 },
  // A model turn under 15 s is routine; five minutes of thinking is the top.
  turn: { floorMs: 15_000, ceilingMs: 5 * 60_000 },
  // A whole run under a minute is quick; the coding agent's wall clock is 45 min.
  run: { floorMs: 60_000, ceilingMs: 45 * 60_000 },
};

/** The one exit code the runtime reserves for its own deadline kill (coreutils
 *  `timeout`'s 124, which every executor mirrors). 137 is any SIGKILL and is
 *  not a timeout signal here — see the module comment. */
export function isTimedOutExit(exitCode: number | undefined): boolean {
  return exitCode === 124;
}

/** Log-scale position of `ms` between the kind's floor (0) and ceiling (1). */
export function heatT(ms: number, kind: HeatKind): number {
  const { floorMs, ceilingMs } = SCALES[kind];
  if (!(ms > floorMs)) return 0;
  const t = Math.log(ms / floorMs) / Math.log(ceilingMs / floorMs);
  return t >= 1 ? 1 : t;
}

function levelFor(t: number): HeatLevel {
  if (t <= 0) return 0;
  if (t < 0.4) return 1;
  if (t < 0.7) return 2;
  return 3;
}

/** The heat of one duration. `over` (a timed-out command) wins over any duration. */
export function durationTone(ms: number | undefined, kind: HeatKind, over = false): Heat {
  if (over) return { level: 4, over: true, t: 1 };
  if (ms === undefined) return { level: 0, over: false, t: 0 };
  const t = heatT(ms, kind);
  return { level: levelFor(t), over: false, t };
}

/** The inline style that paints a ramp colour (`.heat` reads `--heat-t`), or
 *  undefined when the text should inherit: quiet, or over budget (which is the
 *  status palette's job, not the ramp's). */
export function heatStyle(heat: Heat): Record<string, string> | undefined {
  return heat.level >= 1 && heat.level <= 3 ? { "--heat-t": heat.t.toFixed(3) } : undefined;
}
