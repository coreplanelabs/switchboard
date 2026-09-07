import { describe, expect, it } from "vitest";
import { evaluateSlo, percentile, renderMarkdown, summarize, type Sample } from "./aggregate.js";

// The load harness's result math (features/load-harness.md items 1–3): every
// command records one Sample per operation and this module turns them into the
// per-operation latency table, the refusal count by named reason, and the D10
// pass/fail lines a receipt carries. Pure — the harness commands only feed it.

const s = (op: string, ms: number, extra: Partial<Sample> = {}): Sample => ({
  op,
  startedAt: 1_000,
  ms,
  ok: true,
  ...extra,
});

describe("percentile — nearest-rank over a sorted array", () => {
  it("p50 of 1..10 is 5, p95 is 10, p99 is 10, p0 is the minimum", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 99)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
  });

  it("a single sample is every percentile; an empty array is NaN, never a throw", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe("summarize — per-operation latency and refusals by reason", () => {
  it("groups samples by op, counts ok/failed, and reports p50/p95/p99/max over the SUCCESSFUL samples only", () => {
    const samples: Sample[] = [
      ...[100, 200, 300, 400, 500].map((ms) => s("attach", ms)),
      s("exec", 50),
      // A refusal answers fast; it must not flatter the op's latency.
      s("exec", 1, { ok: false, status: "429", reason: "user-pool-exhausted" }),
    ];
    const summary = summarize(samples);
    expect(summary.total).toBe(7);
    const attach = summary.ops.find((o) => o.op === "attach");
    expect(attach).toMatchObject({ count: 5, ok: 5, failed: 0, p50: 300, p95: 500, p99: 500, max: 500 });
    const exec = summary.ops.find((o) => o.op === "exec");
    expect(exec).toMatchObject({ count: 2, ok: 1, failed: 1, p50: 50, max: 50 });
  });

  it("an op with only failures has NaN latency, never 0 or the refusal's speed", () => {
    const only = summarize([s("attach", 1, { ok: false, reason: "mirror-busy" })]).ops[0];
    expect(only).toMatchObject({ count: 1, ok: 0, failed: 1 });
    expect(Number.isNaN(only.p95)).toBe(true);
    expect(Number.isNaN(only.max)).toBe(true);
  });

  it("counts every failed sample's reason; a failure without a reason counts under `unnamed`", () => {
    const summary = summarize([
      s("attach", 1, { ok: false, reason: "mirror-busy" }),
      s("attach", 1, { ok: false, reason: "mirror-busy" }),
      s("attach", 1, { ok: false, reason: "disk-pressure" }),
      s("exec", 1, { ok: false }),
    ]);
    expect(summary.refusals).toEqual({ "mirror-busy": 2, "disk-pressure": 1, unnamed: 1 });
  });

  it("ops are listed in first-seen order so a report reads in the profile's order", () => {
    const summary = summarize([s("attach", 1), s("read", 1), s("exec", 1), s("attach", 2)]);
    expect(summary.ops.map((o) => o.op)).toEqual(["attach", "read", "exec"]);
  });
});

describe("evaluateSlo — the D10 lines", () => {
  const summary = summarize([
    ...[1_000, 2_000, 3_000, 4_000, 70_000].map((ms) => s("attach", ms)),
    s("exec", 500),
    s("attach", 1, { ok: false, reason: "mirror-busy" }),
  ]);

  it("a latency check passes when the op's percentile is within the limit and fails with the actual number", () => {
    const checks = evaluateSlo(summary, {
      latencyMs: [
        { op: "attach", p: 50, maxMs: 15_000 },
        { op: "attach", p: 95, maxMs: 60_000 },
        { op: "exec", p: 95, maxMs: 3_000 },
      ],
    });
    expect(checks).toEqual([
      { name: "attach p50 ≤ 15000 ms", pass: true, actual: "3000 ms", limit: "≤ 15000 ms" },
      { name: "attach p95 ≤ 60000 ms", pass: false, actual: "70000 ms", limit: "≤ 60000 ms" },
      { name: "exec p95 ≤ 3000 ms", pass: true, actual: "500 ms", limit: "≤ 3000 ms" },
    ]);
  });

  it("a zero-reason check fails when that refusal was seen and passes when it was not", () => {
    const checks = evaluateSlo(summary, { zeroReasons: ["mirror-busy", "user-pool-exhausted"] });
    expect(checks).toEqual([
      { name: "zero mirror-busy", pass: false, actual: "1", limit: "0" },
      { name: "zero user-pool-exhausted", pass: true, actual: "0", limit: "0" },
    ]);
  });

  it("a zero-failures check fails on ANY failed sample of the op, whatever its reason, and on no samples", () => {
    const checks = evaluateSlo(summary, { zeroFailures: ["attach", "exec", "write"] });
    expect(checks).toEqual([
      { name: "zero failed attach", pass: false, actual: "1 of 6", limit: "0" },
      { name: "zero failed exec", pass: true, actual: "0 of 1", limit: "0" },
      { name: "zero failed write", pass: false, actual: "no samples", limit: "0" },
    ]);
    // The reason is not in any enumerated list — the structural check still catches it.
    const odd = summarize([s("run", 1, { ok: false, reason: "http-401" })]);
    expect(evaluateSlo(odd, { zeroFailures: ["run"] })[0]).toMatchObject({ pass: false, actual: "1 of 1" });
  });

  it("a latency check on an op with no samples fails with `no samples` instead of passing vacuously", () => {
    const checks = evaluateSlo(summary, { latencyMs: [{ op: "write", p: 95, maxMs: 1 }] });
    expect(checks[0]).toMatchObject({ pass: false, actual: "no samples" });
  });
});

describe("renderMarkdown — the receipt", () => {
  it("carries the title, the parameters, the per-op table, refusals, and each check as a pass/fail line", () => {
    const summary = summarize([s("attach", 1_000), s("attach", 1, { ok: false, reason: "mirror-busy" })]);
    const md = renderMarkdown({
      title: "load:resident",
      runId: "r1",
      startedAt: "2026-09-07T00:00:00.000Z",
      params: { resource: "repo:x/y", threads: 16 },
      summary,
      checks: [{ name: "zero mirror-busy", pass: false, actual: "1", limit: "0" }],
      notes: ["quiet window confirmed"],
    });
    expect(md).toContain("# load:resident r1");
    expect(md).toContain("| resource | repo:x/y |");
    expect(md).toContain("| threads | 16 |");
    expect(md).toContain("| attach | 2 | 1 | 1 |");
    expect(md).toContain("mirror-busy | 1");
    expect(md).toContain("❌ zero mirror-busy — 1 (limit 0)");
    expect(md).toContain("quiet window confirmed");
  });

  it("with every check passing the verdict line reads PASS, otherwise FAIL", () => {
    const summary = summarize([s("attach", 1)]);
    const base = { title: "t", runId: "r", startedAt: "x", params: {}, summary };
    expect(renderMarkdown({ ...base, checks: [{ name: "a", pass: true, actual: "1", limit: "1" }] })).toContain(
      "**Verdict: PASS**",
    );
    expect(renderMarkdown({ ...base, checks: [{ name: "a", pass: false, actual: "2", limit: "1" }] })).toContain(
      "**Verdict: FAIL**",
    );
    expect(renderMarkdown({ ...base, checks: [] })).toContain("**Verdict: no checks**");
  });
});
