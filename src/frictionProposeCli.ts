// Friction proposer CLI (Area 7b / #84): run the self-improvement step over
// SAVED run material, without a bot process.
//   npx tsx src/frictionProposeCli.ts captures/                 # dry run: cluster + rank + what WOULD be filed
//   npx tsx src/frictionProposeCli.ts data/friction.jsonl --repo o/r --file   # file the top proposals as issues
//   npx tsx src/frictionProposeCli.ts run-*.json --top 2 --min-runs 3 --json
// Inputs (files or directories of files), auto-detected per file:
//   • `/runs/:id/friction` JSON  — {id, finished, diagnosis} as the live view serves it
//   • ledger JSONL               — one FrictionRunRecord per line (data/friction.jsonl)
//   • raw run-event captures     — JSON lines of RunEvents or a `curl`ed SSE stream (analyzed here)
// Dry-run by default: `--file` (with `--repo`) is the only way an issue is opened,
// and even then only labeled proposals — never a PR, never a merge. GitHub calls
// (dedupe listing, filing) authenticate like the bot: the GitHub App env, else GH_TOKEN.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isFrictionRunRecord } from "./core/frictionLedger.js";
import type { FrictionRunRecord } from "./core/frictionProposals.js";
import { analyzeRunFriction } from "./core/runFriction.js";
import { formatSelfImprovementReport, runSelfImprovement } from "./core/selfImprovement.js";
import { GithubIssueTracker } from "./execution/githubIssues.js";
import { parseRunEventLines } from "./frictionCli.js";

export interface ProposeCliArgs {
  sources: string[];
  repo?: string;
  label?: string;
  top?: number;
  minRuns?: number;
  /** Actually open issues (default false = dry run). */
  file: boolean;
  json: boolean;
}

const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

export function parseProposeArgs(argv: string[]): ProposeCliArgs {
  const args: ProposeCliArgs = { sources: [], file: false, json: false };
  const intFlag = (name: string, raw: string | undefined): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} expects a positive integer, got ${JSON.stringify(raw)}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a;
    const value = () => (eq !== -1 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i]);
    switch (name) {
      case "--file":
        args.file = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--repo":
        args.repo = value();
        break;
      case "--label":
        args.label = value();
        break;
      case "--top":
        args.top = intFlag("--top", value());
        break;
      case "--min-runs":
        args.minRuns = intFlag("--min-runs", value());
        break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
        args.sources.push(a);
    }
  }
  if (args.sources.length === 0) throw new Error("at least one source (file or directory) is required");
  if (args.repo !== undefined && !SLUG_RE.test(args.repo)) throw new Error(`--repo expects an owner/name slug, got ${JSON.stringify(args.repo)}`);
  if (args.file && !args.repo) throw new Error("--file needs --repo <owner/name> to know where to open issues");
  return args;
}

export interface LoadOptions {
  /** File finish-time source for captures that carry none; default: the file's mtime. */
  mtime?: (path: string) => number;
}

/**
 * Load friction records from files/directories, detecting each file's shape.
 * Unreadable or unrecognized files are reported by path in `skipped`, never
 * thrown — one bad capture must not sink a pass over fifty good ones. Records
 * are deduped by run id (the same run captured twice is one run).
 */
export function loadFrictionRecords(sources: string[], opts: LoadOptions = {}): { records: FrictionRunRecord[]; skipped: string[] } {
  const mtime = opts.mtime ?? ((p: string) => statSync(p).mtimeMs);
  const records = new Map<string, FrictionRunRecord>();
  const skipped: string[] = [];
  for (const path of expand(sources, skipped)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      skipped.push(path);
      continue;
    }
    const loaded = recordsFromText(text, path, mtime);
    if (loaded.length === 0) skipped.push(path);
    for (const r of loaded) if (!records.has(r.runId)) records.set(r.runId, r);
  }
  return { records: [...records.values()], skipped };
}

/** Directories expand to their (non-recursive) files, sorted; files pass through. */
function expand(sources: string[], skipped: string[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    let isDir = false;
    try {
      isDir = statSync(s).isDirectory();
    } catch {
      skipped.push(s);
      continue;
    }
    if (isDir) out.push(...readdirSync(s).sort().map((f) => join(s, f)).filter((p) => statSync(p).isFile()));
    else out.push(s);
  }
  return out;
}

function recordsFromText(text: string, path: string, mtime: (p: string) => number): FrictionRunRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const fallbackId = basename(path, extname(path));

  // One JSON document: a `/runs/:id/friction` response or a single ledger record.
  const doc = tryJson(trimmed);
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const rec = recordFromObject(doc as Record<string, unknown>, fallbackId, () => mtime(path));
    return rec ? [rec] : [];
  }

  // JSON lines: ledger records, or raw run events to analyze.
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  const ledger: FrictionRunRecord[] = [];
  for (const line of lines) {
    const v = tryJson(line);
    if (isFrictionRunRecord(v)) ledger.push(v);
  }
  if (ledger.length > 0) return ledger;

  const { events } = parseRunEventLines(text);
  if (events.length === 0) return [];
  return [{ runId: fallbackId, finishedAt: mtime(path), diagnosis: analyzeRunFriction(events) }];
}

/** A ledger record verbatim, or a live-view `/friction` body (`id` + `diagnosis`)
 *  turned into one — the finish time comes from the file, since the response
 *  carries none. */
function recordFromObject(o: Record<string, unknown>, fallbackId: string, finishedAt: () => number): FrictionRunRecord | undefined {
  if (isFrictionRunRecord(o)) return o;
  const probe = {
    runId: typeof o.id === "string" ? o.id : typeof o.runId === "string" ? o.runId : fallbackId,
    finishedAt: typeof o.finishedAt === "number" ? o.finishedAt : finishedAt(),
    ...(typeof o.label === "string" ? { label: o.label } : {}),
    ...(typeof o.agent === "string" ? { agent: o.agent } : {}),
    diagnosis: o.diagnosis,
  };
  return isFrictionRunRecord(probe) ? probe : undefined;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  let args: ProposeCliArgs;
  try {
    args = parseProposeArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("usage: frictionProposeCli <file|dir>... [--repo owner/name] [--label L] [--top N] [--min-runs N] [--file] [--json]");
    process.exit(2);
  }
  const { records, skipped } = loadFrictionRecords(args.sources);
  for (const s of skipped) console.error(`(skipped ${s}: not a friction capture, ledger, or run-event stream)`);
  if (records.length === 0) {
    console.error("no runs loaded");
    process.exit(1);
  }
  // With a repo, open proposals are listed from GitHub for dedupe even in a dry
  // run (needs GH_TOKEN or the GitHub App env). Without one GitHub is never
  // consulted — a pure dry run — and we say so.
  if (!args.repo) console.error("(no --repo: dedupe against open GitHub issues skipped)");
  const report = await runSelfImprovement({
    records,
    tracker: new GithubIssueTracker(),
    repo: args.repo,
    label: args.label,
    top: args.top,
    minRuns: args.minRuns,
    dryRun: !args.file,
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(formatSelfImprovementReport(report));
    if (report.dryRun && report.proposals.length > 0) {
      console.log("\n--- proposal bodies (dry run) ---");
      for (const p of report.proposals) console.log(`\n### ${p.title}\n\n${p.body}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
