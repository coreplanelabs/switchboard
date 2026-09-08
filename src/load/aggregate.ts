// The load harness's result math (docs/reference/specs/load-harness.md): one Sample per
// operation in, the per-operation latency table, the refusal count by named
// reason, and the plan's D10 pass/fail lines out. Pure — no clock, no I/O; the
// harness commands feed it and write what it renders.

/** One timed operation as a load command saw it. `reason` is the machine token
 *  a refusal carried (`mirror-busy`, `user-pool-exhausted`, `disk-pressure`,
 *  `fleet-busy`, …) so refusals count by name, never by message text. */
export interface Sample {
  op: string;
  /** Epoch ms when the operation started. */
  startedAt: number;
  ms: number;
  ok: boolean;
  /** HTTP status or a short outcome token, when the operation had one. */
  status?: string;
  reason?: string;
  /** Which synthetic thread produced it (0-based), when the command has threads. */
  thread?: number;
}

export interface OpStats {
  op: string;
  count: number;
  ok: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Summary {
  ops: OpStats[];
  /** Failed samples by `reason`; a failure with no reason counts under `unnamed`. */
  refusals: Record<string, number>;
  total: number;
}

/** Nearest-rank percentile over an ascending array; NaN on an empty array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(samples: readonly Sample[]): Summary {
  const byOp = new Map<string, Sample[]>();
  for (const s of samples) {
    const list = byOp.get(s.op);
    if (list) list.push(s);
    else byOp.set(s.op, [s]);
  }
  const ops: OpStats[] = [];
  for (const [op, list] of byOp) {
    // Latency is the latency of operations that WORKED: a refusal answers in
    // milliseconds and would flatter every percentile it joined. Refusals are
    // counted by name below instead.
    const sorted = list
      .filter((s) => s.ok)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    const ok = sorted.length;
    ops.push({
      op,
      count: list.length,
      ok,
      failed: list.length - ok,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? sorted[sorted.length - 1] : NaN,
    });
  }
  const refusals: Record<string, number> = {};
  for (const s of samples) {
    if (s.ok) continue;
    const key = s.reason && s.reason.length > 0 ? s.reason : "unnamed";
    refusals[key] = (refusals[key] ?? 0) + 1;
  }
  return { ops, refusals, total: samples.length };
}

export interface SloSpec {
  /** `<op> p<p> ≤ maxMs`. */
  latencyMs?: Array<{ op: string; p: 50 | 95 | 99; maxMs: number }>;
  /** Refusal reasons that must not appear at all. */
  zeroReasons?: string[];
  /** Operations that must have NO failed sample, whatever the reason — the
   *  structural check for a command whose failure reasons are open-ended (an
   *  HTTP status, a run's terminal state), so an unanticipated reason can
   *  never pass by omission. */
  zeroFailures?: string[];
}

export interface SloCheck {
  name: string;
  pass: boolean;
  actual: string;
  limit: string;
}

export function evaluateSlo(summary: Summary, spec: SloSpec): SloCheck[] {
  const checks: SloCheck[] = [];
  for (const rule of spec.latencyMs ?? []) {
    const name = `${rule.op} p${rule.p} ≤ ${rule.maxMs} ms`;
    const limit = `≤ ${rule.maxMs} ms`;
    const stats = summary.ops.find((o) => o.op === rule.op);
    if (!stats) {
      checks.push({ name, pass: false, actual: "no samples", limit });
      continue;
    }
    const actual = rule.p === 50 ? stats.p50 : rule.p === 95 ? stats.p95 : stats.p99;
    checks.push({ name, pass: actual <= rule.maxMs, actual: `${actual} ms`, limit });
  }
  for (const reason of spec.zeroReasons ?? []) {
    const n = summary.refusals[reason] ?? 0;
    checks.push({ name: `zero ${reason}`, pass: n === 0, actual: String(n), limit: "0" });
  }
  for (const op of spec.zeroFailures ?? []) {
    const stats = summary.ops.find((o) => o.op === op);
    const name = `zero failed ${op}`;
    if (!stats) {
      checks.push({ name, pass: false, actual: "no samples", limit: "0" });
      continue;
    }
    checks.push({ name, pass: stats.failed === 0, actual: `${stats.failed} of ${stats.count}`, limit: "0" });
  }
  return checks;
}

export interface Report {
  title: string;
  runId: string;
  /** ISO. */
  startedAt: string;
  params: Record<string, unknown>;
  summary: Summary;
  checks: SloCheck[];
  notes?: string[];
}

/** The markdown receipt: parameters, the per-op table, refusals, checks, verdict. */
export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# ${report.title} ${report.runId}`, "", `Started ${report.startedAt}.`, "");
  lines.push("## Parameters", "", "| Parameter | Value |", "|---|---|");
  for (const [k, v] of Object.entries(report.params)) lines.push(`| ${k} | ${formatValue(v)} |`);
  lines.push(
    "",
    "## Operations",
    "",
    "| Op | Count | OK | Failed | p50 ms | p95 ms | p99 ms | Max ms |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const o of report.summary.ops) {
    lines.push(
      `| ${o.op} | ${o.count} | ${o.ok} | ${o.failed} | ${fmt(o.p50)} | ${fmt(o.p95)} | ${fmt(o.p99)} | ${fmt(o.max)} |`,
    );
  }
  lines.push("", "## Refusals by reason", "");
  const refusals = Object.entries(report.summary.refusals);
  if (refusals.length === 0) lines.push("none");
  else {
    lines.push("| Reason | Count |", "|---|---|");
    for (const [reason, n] of refusals) lines.push(`| ${reason} | ${n} |`);
  }
  lines.push("", "## Checks", "");
  if (report.checks.length === 0) lines.push("no checks configured");
  for (const c of report.checks) lines.push(`- ${c.pass ? "✅" : "❌"} ${c.name} — ${c.actual} (limit ${c.limit})`);
  const verdict = report.checks.length === 0 ? "no checks" : report.checks.every((c) => c.pass) ? "PASS" : "FAIL";
  lines.push("", `**Verdict: ${verdict}**`);
  if (report.notes && report.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const n of report.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n)) : "—";
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "object") return "`" + JSON.stringify(v) + "`";
  return String(v);
}
