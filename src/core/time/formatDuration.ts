/** The one duration formatter (features/tracing.md). Three styles, one place:
 *
 *  - `precise` — a single measured step: `800ms`, `1.3s`, `5m 04s`.
 *  - `clock`   — a stopwatch reading that ticks: `0s`, `38s`, `4m 12s`, `1h 03m`;
 *                two parts above a minute so a column keeps its width; negative,
 *                non-finite or missing input reads `0s` (missing → `""`).
 *  - `report`  — a compact total in prose: `850ms`, `45s`, `1m 18s`, `1h 05m`.
 *
 *  Pure leaf module: no imports, so the dashboard bundle and the Workers share
 *  it byte for byte with the bot. */

export type DurationStyle = "precise" | "clock" | "report";

export function formatDuration(ms: number | undefined, style: DurationStyle): string {
  if (ms === undefined) return "";
  switch (style) {
    case "precise":
      return precise(ms);
    case "clock":
      return clock(ms);
    case "report":
      return report(ms);
  }
}

function precise(ms: number): string {
  if (!(ms >= 0)) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // Round to the unit the branch prints BEFORE choosing the branch, so a value
  // that rounds up to the next unit carries (59.95 s → `1m 00s`, never `60.0s`;
  // 119.5 s → `2m 00s`, never `1m 60s`).
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
}

function clock(ms: number): string {
  if (!(ms > 0)) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${pad(m % 60)}m`;
}

function report(ms: number): string {
  if (!(ms >= 0)) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${pad(m % 60)}m`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
