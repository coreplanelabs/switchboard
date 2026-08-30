import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunEvent } from "./runEvents.js";
import { InMemoryFrictionLedger } from "./frictionLedger.js";
import type { FrictionRunRecord } from "./frictionProposals.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { countTruncatedInputs, formatSelfImprovementReport, runSelfImprovement } from "./selfImprovement.js";

// Feature: features/self-improvement.md — the orchestrated step: ledger →
// cluster → propose → dedupe against open proposals → file issues (or not, in
// dry-run). Human-gated by construction: the ONLY side effect is opening
// labeled issues; it never opens PRs, never merges, never touches a run.

let t = 0;
const at = (ms: number) => (t += ms);
const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary, at: at(10) });
const result = (ok: boolean, summary: string, ms: number): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary, at: at(ms) });

function lockfileRun(runId: string, finishedAt: number): FrictionRunRecord {
  t = 0;
  return {
    runId,
    label: `coding · o/r · "${runId}"`,
    agent: "coding",
    finishedAt,
    diagnosis: analyzeRunFriction([
      call("$ pnpm install --frozen-lockfile"),
      result(false, "ERR_PNPM_OUTDATED_LOCKFILE", 45_000),
      call("$ pnpm install"),
      result(true, "done", 60_000),
    ]),
  };
}
function cleanRun(runId: string, finishedAt: number): FrictionRunRecord {
  t = 0;
  return { runId, agent: "review", finishedAt, diagnosis: analyzeRunFriction([call("$ ls"), result(true, "src", 100)]) };
}

const REPO = "coreplanelabs/switchboard";

async function seeded() {
  const ledger = new InMemoryFrictionLedger();
  await ledger.record(lockfileRun("r1", 1_000));
  await ledger.record(cleanRun("r2", 2_000));
  await ledger.record(lockfileRun("r3", 3_000));
  return ledger;
}

describe("runSelfImprovement", () => {
  it("given runs with a recurring pattern, files ONE proposal per top pattern with the evidence", async () => {
    const tracker = new InMemoryIssueTracker();
    const report = await runSelfImprovement({
      records: await (await seeded()).recent(),
      tracker,
      repo: REPO,
      label: "self-improvement",
      top: 1,
      dryRun: false,
    });
    expect(report.runsAnalyzed).toBe(3);
    expect(report.patterns.length).toBeGreaterThanOrEqual(2); // the failed install + the retry
    expect(report.filed).toHaveLength(1);
    expect(report.duplicates).toEqual([]);
    const issue = tracker.issues(REPO)[0];
    expect(issue.labels).toEqual(["self-improvement"]);
    expect(issue.title).toContain("pnpm install --frozen-lockfile");
    expect(issue.body).toContain("`r1`");
    expect(issue.body).toContain("`r3`");
    expect(issue.body).toContain("## Suggested fix");
    expect(report.filed[0].issue.number).toBe(issue.number);
  });

  it("is idempotent: a second pass over the same runs files nothing and reports the open duplicate", async () => {
    const tracker = new InMemoryIssueTracker();
    const records = await (await seeded()).recent();
    const first = await runSelfImprovement({ records, tracker, repo: REPO, label: "self-improvement", top: 1, dryRun: false });
    const second = await runSelfImprovement({ records, tracker, repo: REPO, label: "self-improvement", top: 1, dryRun: false });
    expect(second.filed).toEqual([]);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0].issue.number).toBe(first.filed[0].issue.number);
    expect(tracker.issues(REPO)).toHaveLength(1);
  });

  it("dedupes only against OPEN issues carrying the label — a closed proposal can be re-proposed", async () => {
    const tracker = new InMemoryIssueTracker();
    const records = await (await seeded()).recent();
    const first = await runSelfImprovement({ records, tracker, repo: REPO, label: "self-improvement", top: 1, dryRun: false });
    tracker.close(REPO, first.filed[0].issue.number);
    const second = await runSelfImprovement({ records, tracker, repo: REPO, label: "self-improvement", top: 1, dryRun: false });
    expect(second.filed).toHaveLength(1);
    expect(tracker.issues(REPO)).toHaveLength(2);
  });

  it("dry-run computes everything but files nothing", async () => {
    const tracker = new InMemoryIssueTracker();
    const report = await runSelfImprovement({
      records: await (await seeded()).recent(),
      tracker,
      repo: REPO,
      label: "self-improvement",
      top: 3,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.proposals.length).toBeGreaterThan(0);
    expect(report.filed).toEqual([]);
    expect(tracker.issues(REPO)).toEqual([]);
    expect(tracker.calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });

  it("without a repo it is a pure dry run: patterns and proposals are computed, GitHub is never consulted", async () => {
    const tracker = new InMemoryIssueTracker();
    const report = await runSelfImprovement({ records: await (await seeded()).recent(), tracker, top: 3, dryRun: false });
    expect(report.dryRun).toBe(true);
    expect(report.proposals.length).toBeGreaterThan(0);
    expect(report.filed).toEqual([]);
    expect(tracker.calls).toEqual([]); // no listOpen, no create — the CLI's default invocation needs no credential
  });

  it("with no recurring pattern (clean or one-off runs) it files nothing", async () => {
    const tracker = new InMemoryIssueTracker();
    const report = await runSelfImprovement({
      records: [cleanRun("a", 1), cleanRun("b", 2), lockfileRun("c", 3)],
      tracker,
      repo: REPO,
      label: "self-improvement",
      top: 3,
      dryRun: false,
    });
    expect(report.patterns).toEqual([]);
    expect(report.filed).toEqual([]);
    expect(tracker.calls).toEqual([]); // no open-issue lookup when there is nothing to propose
  });

  it("a tracker failure on create is reported per proposal, never thrown, and later proposals still file", async () => {
    const tracker = new InMemoryIssueTracker({ failCreateWhen: (title) => title.includes("frozen-lockfile") });
    const report = await runSelfImprovement({
      records: await (await seeded()).recent(),
      tracker,
      repo: REPO,
      label: "self-improvement",
      top: 2,
      dryRun: false,
    });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].error).toMatch(/simulated/);
    expect(report.filed).toHaveLength(1);
  });

  it("respects minRuns", async () => {
    const tracker = new InMemoryIssueTracker();
    const report = await runSelfImprovement({
      records: await (await seeded()).recent(),
      tracker,
      repo: REPO,
      label: "self-improvement",
      top: 3,
      minRuns: 3,
      dryRun: false,
    });
    expect(report.patterns).toEqual([]);
  });
});

describe("formatSelfImprovementReport", () => {
  it("renders runs analyzed, the ranked patterns, and what was filed / deduped / skipped", async () => {
    const tracker = new InMemoryIssueTracker();
    const records = await (await seeded()).recent();
    await runSelfImprovement({ records, tracker, repo: REPO, label: "self-improvement", top: 1, dryRun: false });
    const report = await runSelfImprovement({ records, tracker, repo: REPO, label: "self-improvement", top: 2, dryRun: false });
    const text = formatSelfImprovementReport(report);
    expect(text).toContain("3 runs analyzed");
    expect(text).toContain("setup_install:pnpm install --frozen-lockfile");
    expect(text).toMatch(/already open/i);
    expect(text).toMatch(/filed/);
    expect(text).toContain(tracker.issues(REPO)[0].url);
  });

  it("counts runs diagnosed on a truncated event stream and says so", async () => {
    const records = await (await seeded()).recent();
    records[0] = { ...records[0], diagnosis: { ...records[0].diagnosis, truncatedInput: true } };
    const report = await runSelfImprovement({ records, tracker: new InMemoryIssueTracker(), dryRun: true });
    expect(report.truncatedRuns).toBe(1);
    expect(countTruncatedInputs(records)).toBe(1);
    expect(formatSelfImprovementReport(report)).toMatch(/1 run diagnosed on a truncated event stream/);
    const clean = await runSelfImprovement({ records: await (await seeded()).recent(), tracker: new InMemoryIssueTracker(), dryRun: true });
    expect(clean.truncatedRuns).toBe(0);
    expect(formatSelfImprovementReport(clean)).not.toMatch(/truncated/);
  });

  it("says so plainly when nothing recurs", () => {
    const text = formatSelfImprovementReport({
      runsAnalyzed: 2,
      patterns: [],
      proposals: [],
      filed: [],
      duplicates: [],
      failed: [],
      dryRun: false,
    });
    expect(text).toContain("2 runs analyzed");
    expect(text).toMatch(/no recurring friction/i);
  });

  it("labels a dry run as such", async () => {
    const report = await runSelfImprovement({
      records: await (await seeded()).recent(),
      tracker: new InMemoryIssueTracker(),
      repo: REPO,
      label: "self-improvement",
      top: 1,
      dryRun: true,
    });
    expect(formatSelfImprovementReport(report)).toMatch(/dry run/i);
  });
});
