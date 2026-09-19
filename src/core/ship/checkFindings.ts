// The round's checks read, classified (record 0055, "The round verdict";
// docs/reference/specs/agent-ship.md item 9): the bot's `checks` step reads the
// check runs at the reviewed head with the merge door's own reading and hands
// the machine each failure with its conclusion, its URL and one judgement —
// whether it is a suspected flake. The flake rule as the record states it: a
// test timeout or runner stall on a shard whose test files the pull request's
// changed paths never touch is re-run once before it becomes a finding; a
// second failure is the finding. The judgement here is conservative and
// provable: a failure is a suspect only when its output names the timeout or
// stall AND names test files, none of which the changed paths touch — anything
// less provable is a real failure, which errs toward the finding, never toward
// a silent re-run. Pure and node-free: the classification is testable without
// GitHub, and the machine (src/core/ship/coordinator.ts) decides what a
// suspect is worth.

import type { CheckFailure, RoundChecks } from "./coordinator.js";

/** One check run at a commit as GitHub reports it, flattened for the classifier:
 *  the name, the run's status/conclusion, its html URL and its output's words. */
export interface CheckRunDetail {
  name: string;
  /** GitHub's `status`: anything but `completed` is still pending. */
  status: string;
  conclusion?: string;
  url?: string;
  /** The run's output title, summary and text joined — where a timeout names
   *  the shard's test files. */
  output?: string;
}

const GREEN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
/** A test timeout or a runner stall, in the words CI runners use. */
const FLAKE_MARK = /\btimed?[\s-]?out\b|\btimeout\b|\bstall(?:ed)?\b|no output (?:has been )?received/i;
/** A test file the output names — the shard's reach, as far as it is provable. */
const TEST_FILE = /[\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/g;

/** Whether one failed check is a suspected flake (record 0055's flake rule):
 *  a timeout/stall whose output names test files that the pull request's
 *  changed paths never touch. Unprovable — no marker, no named test files, or
 *  unknown changed paths — reads as a real failure. */
export function suspectedFlake(run: Pick<CheckRunDetail, "conclusion" | "output">, changedPaths?: string[]): boolean {
  if (changedPaths === undefined) return false;
  const text = run.output ?? "";
  const marked = run.conclusion === "timed_out" || FLAKE_MARK.test(text);
  if (!marked) return false;
  const shardFiles = [...new Set(text.match(TEST_FILE) ?? [])];
  if (shardFiles.length === 0) return false;
  // Paths in a runner's output may be repo-relative or deeper; a touch is a
  // suffix match either way.
  const touched = (file: string) => changedPaths.some((p) => p === file || p.endsWith(file) || file.endsWith(p));
  return !shardFiles.some(touched);
}

/** The check runs at the reviewed head as the machine's `checks` step return
 *  carries them: total, the pending names, and each failure with its
 *  conclusion, URL and flake judgement — the merge door's reading (a run not
 *  `completed` is pending; success, skipped and neutral are green) joined with
 *  the classifier's. */
export function classifyRoundChecks(runs: CheckRunDetail[], changedPaths?: string[]): RoundChecks {
  const out: RoundChecks = { total: 0, pending: [], failed: [] };
  for (const run of runs) {
    out.total++;
    if (run.status !== "completed") {
      out.pending.push(run.name);
      continue;
    }
    const conclusion = run.conclusion ?? "unknown";
    if (GREEN_CONCLUSIONS.has(conclusion)) continue;
    const failure: CheckFailure = {
      name: run.name,
      conclusion,
      ...(run.url !== undefined ? { url: run.url } : {}),
      ...(suspectedFlake(run, changedPaths) ? { flakeSuspect: true } : {}),
    };
    out.failed.push(failure);
  }
  return out;
}
