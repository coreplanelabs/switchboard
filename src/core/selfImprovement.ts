import type { IssueRef, IssueTracker } from "../execution/githubIssues.js";
import {
  clusterFriction,
  dedupeProposals,
  proposeImprovements,
  DEFAULT_MIN_RUNS,
  DEFAULT_PROPOSAL_LABEL,
  DEFAULT_TOP,
  type FrictionPattern,
  type FrictionRunRecord,
  type ImprovementProposal,
} from "./frictionProposals.js";
import { formatMs } from "./runFriction.js";

// The self-improvement step (Area 7b / #84): ledger → cluster → propose →
// dedupe against open proposals → file issues. This is the orchestration
// around the pure proposer (frictionProposals.ts); its ONLY side effect is
// `tracker.create`, and `dryRun` removes even that. Human-gated by
// construction: it opens labeled issues for a person to triage and never
// opens PRs or merges anything. Reached from the `friction propose` chat
// commands (`friction report` / `friction propose`, src/core/commands/friction.ts).

/** The `selfImprovement` config section. */
export interface SelfImprovementConfig {
  /** `owner/name` the proposals are filed against (required for `friction propose`). */
  repo: string;
  /** Triage label on every proposal. Default `self-improvement`. */
  label?: string;
  /** Minimum DISTINCT runs a pattern must recur in. Default 2. */
  minRuns?: number;
  /** Proposals filed per pass (top-ranked patterns). Default 3. */
  top?: number;
  /** JSONL ledger path (the host-disk ledger, used when no `worker`). Default `<dataDir>/friction.jsonl`. */
  ledgerPath?: string;
  /** Runs retained in the ledger (file and Worker alike). Default 500. */
  ledgerMax?: number;
  /** The durable ledger: the FrictionDO on the state Worker (deploy/cloudflare-memory/).
   *  Absent → the host-disk file ledger, which an ephemeral-disk deploy loses on redeploy. */
  worker?: {
    /** Base URL, e.g. https://switchboard-memory.coreplanelabs.dev */
    baseUrl: string;
    /** Env var holding the bearer secret. Default MEMORY_TOKEN. */
    tokenEnv?: string;
  };
}

export interface RunSelfImprovementOptions {
  records: readonly FrictionRunRecord[];
  tracker: IssueTracker;
  /** `owner/name` to dedupe against and file into. Absent → a pure dry run:
   *  GitHub is never consulted, so `duplicates` is empty and nothing files. */
  repo?: string;
  label?: string;
  top?: number;
  minRuns?: number;
  /** Compute and report everything, file nothing. */
  dryRun: boolean;
}

export interface SelfImprovementReport {
  runsAnalyzed: number;
  /** Every recurring pattern, ranked (not only the ones proposed). */
  patterns: FrictionPattern[];
  /** The top patterns rendered as proposals (before dedupe). */
  proposals: ImprovementProposal[];
  filed: Array<{ proposal: ImprovementProposal; issue: IssueRef }>;
  /** Proposals an open issue already covers. */
  duplicates: Array<{ proposal: ImprovementProposal; issue: IssueRef }>;
  /** Proposals whose create call failed (reported, never thrown). */
  failed: Array<{ proposal: ImprovementProposal; error: string }>;
  dryRun: boolean;
  /** Runs whose diagnosis ran on a head-truncated event stream
   *  (`FrictionDiagnosis.truncatedInput`): their patterns may be incomplete.
   *  Optional so a report built before this field reads as 0. */
  truncatedRuns?: number;
}

/** How many records were diagnosed on a truncated stream (`countTruncatedInputs`
 *  is what every report builder stamps into `truncatedRuns`). */
export function countTruncatedInputs(records: readonly FrictionRunRecord[]): number {
  return records.filter((r) => r.diagnosis.truncatedInput === true).length;
}

export async function runSelfImprovement(opts: RunSelfImprovementOptions): Promise<SelfImprovementReport> {
  const label = opts.label ?? DEFAULT_PROPOSAL_LABEL;
  const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
  const top = opts.top ?? DEFAULT_TOP;
  const report: SelfImprovementReport = {
    runsAnalyzed: opts.records.length,
    patterns: clusterFriction(opts.records, { minRuns }),
    proposals: [],
    filed: [],
    duplicates: [],
    failed: [],
    dryRun: opts.dryRun,
    truncatedRuns: countTruncatedInputs(opts.records),
  };
  if (report.patterns.length === 0) return report; // nothing to propose → GitHub is never consulted

  report.proposals = proposeImprovements(report.patterns, { top, runsAnalyzed: opts.records.length, label });
  // No repo → nothing to dedupe against and nowhere to file: a pure dry run
  // that never touches GitHub (the CLI's default invocation).
  if (!opts.repo) {
    report.dryRun = true;
    return report;
  }
  const open = await opts.tracker.listOpen(opts.repo, label);
  const { fresh, duplicates } = dedupeProposals(report.proposals, open);
  report.duplicates = duplicates;
  if (opts.dryRun) return report;

  for (const proposal of fresh) {
    try {
      const issue = await opts.tracker.create(opts.repo, { title: proposal.title, body: proposal.body, labels: proposal.labels });
      report.filed.push({ proposal, issue });
    } catch (err) {
      report.failed.push({ proposal, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/** Channel-neutral text for the chat reply / CLI: what was analyzed, the
 *  ranked patterns, and exactly what was filed, already open, or failed. */
export function formatSelfImprovementReport(r: SelfImprovementReport): string {
  const runs = `${r.runsAnalyzed} run${r.runsAnalyzed === 1 ? "" : "s"} analyzed`;
  const truncated = r.truncatedRuns ?? 0;
  const truncatedNote = truncated > 0 ? ` (${truncated} run${truncated === 1 ? "" : "s"} diagnosed on a truncated event stream — patterns may be incomplete)` : "";
  if (r.patterns.length === 0) {
    return `🔍 ${runs}${truncatedNote} — no recurring friction pattern found (a pattern must recur across ≥2 distinct runs).`;
  }
  const head = `🔍 *Friction proposals* — ${runs}${truncatedNote} · ${r.patterns.length} recurring pattern${r.patterns.length === 1 ? "" : "s"}${r.dryRun ? " · dry run (nothing filed)" : ""}`;
  const lines = [head, ""];
  r.patterns.forEach((p, i) => {
    const time = p.durationMs > 0 ? ` · ${formatMs(p.durationMs)}` : "";
    lines.push(`${i + 1}. \`${p.key}\` — ${p.runIds.length} runs · ${p.occurrences}×${time} · ${p.severity}`);
  });
  const filedKeys = new Set(r.filed.map((f) => f.proposal.key));
  const dupKeys = new Set(r.duplicates.map((d) => d.proposal.key));
  const failedKeys = new Set(r.failed.map((f) => f.proposal.key));
  if (r.filed.length > 0) {
    lines.push("", "*Filed:*", ...r.filed.map((f) => `• ${f.issue.url} — ${f.proposal.title}`));
  }
  if (r.duplicates.length > 0) {
    lines.push("", "*Already open (not refiled):*", ...r.duplicates.map((d) => `• ${d.issue.url} — \`${d.proposal.key}\``));
  }
  if (r.failed.length > 0) {
    lines.push("", "*Failed to file:*", ...r.failed.map((f) => `• ${f.proposal.title} — ${f.error}`));
  }
  if (r.dryRun) {
    const would = r.proposals.filter((p) => !dupKeys.has(p.key));
    if (would.length > 0) lines.push("", "*Would file (dry run):*", ...would.map((p) => `• ${p.title}`));
  } else {
    const unproposed = r.proposals.filter((p) => !filedKeys.has(p.key) && !dupKeys.has(p.key) && !failedKeys.has(p.key));
    if (unproposed.length > 0) lines.push("", "*Not filed:*", ...unproposed.map((p) => `• ${p.title}`));
  }
  return lines.join("\n");
}
