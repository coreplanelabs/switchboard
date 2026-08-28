import type { RunEvent } from "./runEvents.js";

// Run-friction analyzer (Area 7b / #84, first piece): a PURE, deterministic
// function from a run's RunEvent stream to a structured diagnosis of what cost
// the run time or made it stumble — slow/failed tool calls, retries, setup/
// install time, wrap-up, budget hits, exec-infrastructure failures. It is the
// observe→diagnose half of the self-improvement loop; proposing fix PRs from a
// diagnosis is a later piece and deliberately NOT here. No clock, no I/O: the
// same events always yield the same diagnosis, so it runs identically over a
// live backlog (`/runs/:id/friction`), a saved JSONL stream (`frictionCli.ts`),
// or a test fixture.

export type FrictionCategory =
  | "slow_tool"
  | "failed_tool"
  | "retry"
  | "setup_install"
  | "wrap_up"
  | "budget_hit"
  | "infra_failure";

export const FRICTION_CATEGORIES: readonly FrictionCategory[] = [
  "slow_tool",
  "failed_tool",
  "retry",
  "setup_install",
  "wrap_up",
  "budget_hit",
  "infra_failure",
];

/** Human labels for the verdict line. */
const CATEGORY_LABEL: Record<FrictionCategory, string> = {
  slow_tool: "slow tool calls",
  failed_tool: "failed tool calls",
  retry: "retries",
  setup_install: "setup/install",
  wrap_up: "wrap-up",
  budget_hit: "budget hits",
  infra_failure: "infra failures",
};

export type FrictionSeverity = "low" | "medium" | "high";

export interface FrictionFinding {
  category: FrictionCategory;
  severity: FrictionSeverity;
  /** One line: what happened. Derived from event summaries, which are already redacted upstream. */
  summary: string;
  /** Tool involved, for tool-anchored findings. */
  tool?: string;
  /** Wall time attributed to this finding, when the events carried timestamps. */
  durationMs?: number;
  /** Index into the input stream of the event the finding anchors to: the
   *  tool_call for tool findings, the note for note findings. */
  eventIndex: number;
}

export interface CategoryTotals {
  count: number;
  /** Sum of `durationMs` across the category's findings (0 without timings). */
  durationMs: number;
}

export interface FrictionDiagnosis {
  eventCount: number;
  toolCalls: number;
  /** True iff at least one event carried a timestamp (durations are meaningful). */
  hasTimings: boolean;
  /** First→last timestamp, when timed. */
  runMs?: number;
  /** Sum of paired tool_call→tool_result durations, when timed. */
  toolTimeMs?: number;
  /** Every category present, zeroed when absent. */
  byCategory: Record<FrictionCategory, CategoryTotals>;
  /** In detection order (stream order). */
  findings: FrictionFinding[];
  /** One-line headline: the dominant cause, or "no friction detected". */
  verdict: string;
}

export interface FrictionOptions {
  /** A paired tool call taking at least this long is a `slow_tool`. Default 30s. */
  slowToolMs?: number;
  /** Whether the stream is complete (default true). For an in-flight run a
   *  trailing tool_call without a result is simply still running — only in a
   *  finished stream is it evidence the run died mid-tool. */
  finished?: boolean;
}

const DEFAULT_SLOW_TOOL_MS = 30_000;

// Setup/install commands, matched at the START of a shell segment (after `$ `,
// `&&`, `;`, `|`), so `echo npm install` and `npm test` don't match while
// `cd repo && npm install` does. `(?=\s|$)` (not `\b`) ends each subcommand
// word, so `npm ci-lockfile-report` is not `npm ci`. Optional wrappers: `sudo`,
// `corepack`, `python -m` (for pip).
const INSTALL_SEGMENT =
  /(?:^|&&|;|\|\|?)\s*(?:sudo\s+)?(?:corepack\s+)?(?:(?:npm|pnpm|bun)\s+(?:install|i|ci|add)(?=\s|$)|yarn(?:\s+(?:install|add)(?=\s|$)|\s*$)|npx\s+playwright\s+install(?=\s|$)|(?:python3?\s+-m\s+)?pip3?\s+install(?=\s|$)|poetry\s+install(?=\s|$)|uv\s+(?:sync|pip\s+install)(?=\s|$)|apt(?:-get)?\s+install(?=\s|$)|apk\s+add(?=\s|$)|brew\s+install(?=\s|$)|bundle\s+install(?=\s|$)|gem\s+install(?=\s|$)|cargo\s+(?:fetch|build)(?=\s|$)|go\s+mod\s+download(?=\s|$)|git\s+clone(?=\s|$)|make\s+(?:deps|install|setup)(?=\s|$))/;

// Quoted string literals ("…" / '…'): prose to the shell, not command segments.
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

/** True for a bash tool_call summary (`$ <command>`) that is a setup/install
 *  step. Quoted text is blanked first so `echo "cd x && npm install"` is not
 *  an install. Tolerates a non-string (a corrupted external capture) → false. */
export function isSetupInstallCommand(summary: unknown): boolean {
  if (typeof summary !== "string") return false;
  const cmd = summary.startsWith("$ ") ? summary.slice(2) : summary;
  return INSTALL_SEGMENT.test(cmd.replace(QUOTED, '""'));
}

interface PendingCall {
  index: number;
  event: Extract<RunEvent, { type: "tool_call" }>;
}

/** Analyze a run's event stream. Pure and deterministic; never mutates `events`. */
export function analyzeRunFriction(events: readonly RunEvent[], opts: FrictionOptions = {}): FrictionDiagnosis {
  const slowToolMs = opts.slowToolMs ?? DEFAULT_SLOW_TOOL_MS;
  const finished = opts.finished ?? true;
  const findings: FrictionFinding[] = [];
  // Pending calls awaiting their result, FIFO per tool name (the runner emits
  // call→result sequentially; pairing per tool is robust to interleaving).
  const pending = new Map<string, PendingCall[]>();
  // `tool summary` keys that have failed at least once → a later identical call is a retry.
  const failedCalls = new Set<string>();
  let toolCalls = 0;
  let toolTimeMs = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  let wrapUp: { index: number; at?: number } | undefined;

  const durationOf = (start?: number, end?: number) =>
    start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;

  events.forEach((ev, index) => {
    if (ev.at !== undefined) {
      firstAt ??= ev.at;
      lastAt = ev.at;
    }

    if (ev.type === "tool_call") {
      toolCalls++;
      if (failedCalls.has(`${ev.tool} ${ev.summary}`)) {
        findings.push({ category: "retry", severity: "low", summary: `retried after failure: ${ev.summary}`, tool: ev.tool, eventIndex: index });
      }
      const queue = pending.get(ev.tool) ?? [];
      queue.push({ index, event: ev });
      pending.set(ev.tool, queue);
      return;
    }

    if (ev.type === "tool_result") {
      const callEntry = pending.get(ev.tool)?.shift();
      const anchor = callEntry?.index ?? index;
      const callSummary = callEntry?.event.summary ?? ev.tool;
      const durationMs = durationOf(callEntry?.event.at, ev.at);
      if (durationMs !== undefined) toolTimeMs += durationMs;
      const timed = (f: FrictionFinding): FrictionFinding => (durationMs !== undefined ? { ...f, durationMs } : f);

      if (!ev.ok) failedCalls.add(`${ev.tool} ${callSummary}`);

      if (ev.infra) {
        // An infra-level failure is the sandbox, not the command: classify once,
        // as infra — but name the command that was running, so "the sandbox died
        // during installs" is readable from the findings alone.
        findings.push(timed({ category: "infra_failure", severity: "high", summary: `exec infrastructure failed during ${callSummary} → ${ev.summary}`, tool: ev.tool, eventIndex: anchor }));
        return;
      }
      if (ev.tool === "bash" && isSetupInstallCommand(callSummary)) {
        // Setup/install is reported once, as setup — a slow or failed install is
        // still setup cost — so the category total is the true install bill.
        const slow = durationMs !== undefined && durationMs >= slowToolMs;
        const label = !ev.ok ? "install failed" : slow ? "slow install" : "install";
        findings.push(timed({
          category: "setup_install",
          severity: !ev.ok ? "high" : slow ? "medium" : "low",
          summary: `${label}: ${callSummary}${!ev.ok ? ` → ${ev.summary}` : ""}`,
          tool: ev.tool,
          eventIndex: anchor,
        }));
        return;
      }
      if (!ev.ok) {
        // A failure that was ALSO slow cost more than a fast one: high once it
        // crosses the slow threshold (the same bar slow_tool uses).
        const slowFailure = durationMs !== undefined && durationMs >= slowToolMs;
        findings.push(timed({ category: "failed_tool", severity: slowFailure ? "high" : "medium", summary: `${callSummary} → ${ev.summary}`, tool: ev.tool, eventIndex: anchor }));
        return;
      }
      if (durationMs !== undefined && durationMs >= slowToolMs) {
        findings.push(timed({
          category: "slow_tool",
          severity: durationMs >= 2 * slowToolMs ? "high" : "medium",
          summary: `took ${formatMs(durationMs)}: ${callSummary}`,
          tool: ev.tool,
          eventIndex: anchor,
        }));
      }
      return;
    }

    switch (ev.kind) {
      case "wrap_up":
        // Its duration is the time from the warning to the end of the stream
        // (how long the wind-down actually took); filled in after the loop.
        wrapUp = { index, at: ev.at };
        findings.push({ category: "wrap_up", severity: "medium", summary: ev.summary, eventIndex: index });
        return;
      case "time_budget_exhausted":
        findings.push({ category: "budget_hit", severity: "high", summary: `budget hit (time): ${ev.summary}`, eventIndex: index });
        return;
      case "turn_budget_exhausted":
        findings.push({ category: "budget_hit", severity: "high", summary: `budget hit (turns): ${ev.summary}`, eventIndex: index });
        return;
      case "sandbox_dead":
        findings.push({ category: "infra_failure", severity: "high", summary: `sandbox dead: ${ev.summary}`, eventIndex: index });
        return;
    }
  });

  // In a FINISHED stream, a call with no result means the run ended mid-tool
  // (process died, stream cut) — infrastructure friction that must not vanish
  // silently. Mid-run it is just the tool still executing.
  for (const queue of finished ? pending.values() : []) {
    for (const { index, event } of queue) {
      const durationMs = durationOf(event.at, lastAt);
      findings.push({
        category: "infra_failure",
        severity: "high",
        summary: `no result for tool call (run ended mid-tool): ${event.summary}`,
        tool: event.tool,
        eventIndex: index,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  }
  if (wrapUp !== undefined) {
    const { index, at } = wrapUp;
    const ms = durationOf(at, lastAt);
    const f = findings.find((x) => x.category === "wrap_up" && x.eventIndex === index);
    if (ms !== undefined && f) f.durationMs = ms;
  }

  const hasTimings = firstAt !== undefined;
  const byCategory = Object.fromEntries(
    FRICTION_CATEGORIES.map((c) => [c, { count: 0, durationMs: 0 } satisfies CategoryTotals]),
  ) as Record<FrictionCategory, CategoryTotals>;
  for (const f of findings) {
    byCategory[f.category].count++;
    byCategory[f.category].durationMs += f.durationMs ?? 0;
  }

  const diagnosis: FrictionDiagnosis = {
    eventCount: events.length,
    toolCalls,
    hasTimings,
    ...(firstAt !== undefined && lastAt !== undefined ? { runMs: lastAt - firstAt, toolTimeMs } : {}),
    byCategory,
    findings,
    verdict: "",
  };
  diagnosis.verdict = verdictOf(diagnosis);
  return diagnosis;
}

/** The dominant cause: most attributed time when timed (ties → most findings →
 *  category order), else most findings. Names the share of tool time so the
 *  reader knows whether the cause is the whole story. */
function verdictOf(d: FrictionDiagnosis): string {
  if (d.findings.length === 0) return "no friction detected";
  const ranked = FRICTION_CATEGORIES.filter((c) => d.byCategory[c].count > 0).sort(
    (a, b) =>
      d.byCategory[b].durationMs - d.byCategory[a].durationMs || d.byCategory[b].count - d.byCategory[a].count,
  );
  const top = ranked[0];
  const t = d.byCategory[top];
  const what = `${CATEGORY_LABEL[top]} dominated: ${t.count} finding${t.count === 1 ? "" : "s"}`;
  if (!d.hasTimings || t.durationMs === 0) return what;
  const share = d.toolTimeMs ? ` (${Math.round((t.durationMs / d.toolTimeMs) * 100)}% of tool time)` : "";
  return `${what}, ${formatMs(t.durationMs)}${share}`;
}

/** Compact duration: `850ms`, `45s`, `1m 18s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Plain-text report for the CLI / terminal. */
export function formatFrictionReport(d: FrictionDiagnosis): string {
  const lines: string[] = [`verdict: ${d.verdict}`];
  const totals = [`events: ${d.eventCount}`, `tool calls: ${d.toolCalls}`];
  if (d.runMs !== undefined) totals.push(`run: ${formatMs(d.runMs)}`);
  if (d.toolTimeMs !== undefined) totals.push(`tool time: ${formatMs(d.toolTimeMs)}`);
  if (!d.hasTimings) totals.push("(no timestamps — durations unavailable)");
  lines.push(totals.join(" · "), "", "category         count  time");
  for (const c of FRICTION_CATEGORIES) {
    const t = d.byCategory[c];
    lines.push(`${c.padEnd(16)} ${String(t.count).padStart(5)}  ${t.count && d.hasTimings ? formatMs(t.durationMs) : "-"}`);
  }
  if (d.findings.length > 0) {
    lines.push("", "findings (stream order):");
    for (const f of d.findings) {
      const dur = f.durationMs !== undefined ? ` (${formatMs(f.durationMs)})` : "";
      lines.push(`  #${f.eventIndex} [${f.category}] ${f.severity}${dur} ${f.summary}`);
    }
  }
  return lines.join("\n");
}
