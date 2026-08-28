// Read-only run-friction CLI (Area 7b / #84): analyze a saved run-event stream.
//   npx tsx src/frictionCli.ts run.jsonl            # JSON lines of RunEvents
//   curl -s "$LIVE_LINK_EVENTS" | npx tsx src/frictionCli.ts   # a raw SSE capture works too
//   npx tsx src/frictionCli.ts run.jsonl --json     # the structured diagnosis
//   npx tsx src/frictionCli.ts run.jsonl --slow-ms 10000
//   curl -s "$LIVE_LINK_EVENTS" | npx tsx src/frictionCli.ts --in-progress   # mid-run capture: a trailing call is still running
// Analysis only — it never touches a run, a sandbox, or GitHub.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { RunEvent, RunNoteKind } from "./core/runEvents.js";
import { analyzeRunFriction, formatFrictionReport, type FrictionDiagnosis } from "./core/runFriction.js";

const NOTE_KINDS = new Set<RunNoteKind>(["wrap_up", "time_budget_exhausted", "turn_budget_exhausted", "sandbox_dead"]);

/**
 * Parse run events from text: one JSON object per line, OR a raw SSE capture of
 * `/runs/:id/events` (only `data:` lines carry events; `retry:`/`event:`/
 * comment/blank lines are transport; the `{}` payload of the terminal `end`
 * frame is ignored). Malformed lines and non-event payloads are skipped and
 * counted, never thrown — a partially garbled capture still yields a diagnosis.
 */
export function parseRunEventLines(text: string): { events: RunEvent[]; skipped: number } {
  const events: RunEvent[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith(":") || /^(retry|event|id):/.test(line)) continue;
    const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      skipped++;
      continue;
    }
    if (isRunEvent(parsed)) events.push(parsed);
    else if (!isEmptyObject(parsed)) skipped++; // `{}` is the terminal `end` frame's payload, not garbage
  }
  return { events, skipped };
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
}

/** Structural check of the fields the analyzer actually relies on — a recognized
 *  `type` alone is not enough, since this input is external (a hand-edited or
 *  corrupted capture must be skipped, never crash the analysis). */
function isRunEvent(v: unknown): v is RunEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.at !== undefined && typeof o.at !== "number") return false;
  if (typeof o.summary !== "string") return false;
  switch (o.type) {
    case "tool_call":
      return typeof o.tool === "string";
    case "tool_result":
      return typeof o.tool === "string" && typeof o.ok === "boolean";
    case "run_note":
      return typeof o.kind === "string" && NOTE_KINDS.has(o.kind as RunNoteKind);
    default:
      return false;
  }
}

export interface FrictionCliArgs {
  /** File path, or `-` for stdin. */
  source: string;
  json: boolean;
  slowToolMs: number | undefined;
  /** False with `--in-progress`: the capture was taken mid-run, so a trailing
   *  tool_call without a result is still executing, not a dead run. */
  finished: boolean;
}

export function parseFrictionArgs(argv: string[]): FrictionCliArgs {
  const args: FrictionCliArgs = { source: "-", json: false, slowToolMs: undefined, finished: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--in-progress") args.finished = false;
    else if (a === "--slow-ms" || a.startsWith("--slow-ms=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`--slow-ms expects a non-negative number of milliseconds, got ${JSON.stringify(v)}`);
      args.slowToolMs = n;
    } else if (a.startsWith("-") && a !== "-") throw new Error(`unknown flag: ${a}`);
    else args.source = a;
  }
  return args;
}

/** The stderr hint for the most likely misuse: a live `curl` capture analyzed
 *  with the default `finished:true`, so its trailing in-flight call is blamed
 *  as a dead run. Only when that specific finding is present and the flag was
 *  not given; `undefined` otherwise. */
export function inProgressHint(diagnosis: FrictionDiagnosis, finished: boolean): string | undefined {
  if (!finished) return undefined;
  const midTool = diagnosis.findings.some((f) => f.category === "infra_failure" && f.summary.includes("run ended mid-tool"));
  return midTool
    ? "(hint: the stream ends on a tool call with no result — if this capture was taken mid-run, pass --in-progress)"
    : undefined;
}

async function main(): Promise<void> {
  let args: FrictionCliArgs;
  try {
    args = parseFrictionArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("usage: frictionCli [file.jsonl|-] [--json] [--slow-ms <ms>] [--in-progress]");
    process.exit(2);
  }
  const text = args.source === "-" ? readFileSync(0, "utf8") : readFileSync(args.source, "utf8");
  const { events, skipped } = parseRunEventLines(text);
  if (events.length === 0) {
    console.error(`no run events found in ${args.source === "-" ? "stdin" : args.source}${skipped ? ` (${skipped} unparseable lines)` : ""}`);
    process.exit(1);
  }
  const diagnosis = analyzeRunFriction(events, { slowToolMs: args.slowToolMs, finished: args.finished });
  if (args.json) console.log(JSON.stringify(diagnosis, null, 2));
  else {
    console.log(formatFrictionReport(diagnosis));
    if (skipped) console.error(`(skipped ${skipped} unparseable line${skipped === 1 ? "" : "s"})`);
  }
  const hint = inProgressHint(diagnosis, args.finished);
  if (hint) console.error(hint);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
