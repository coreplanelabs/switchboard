import { describe, expect, it } from "vitest";
import type { RunEvent } from "./runEvents.js";
import { analyzeRunFriction, formatFrictionReport, type FrictionDiagnosis } from "./runFriction.js";

// Feature: features/run-friction.md — the pure, deterministic analyzer that
// turns a run's RunEvent stream into a structured friction diagnosis (#84).
// Streams below are synthetic: one per friction category, plus edges.

const T0 = 1_700_000_000_000;
const call = (tool: string, summary: string, at?: number): RunEvent => ({ type: "tool_call", tool, summary, at });
const result = (tool: string, ok: boolean, summary: string, at?: number, infra?: true): RunEvent => ({
  type: "tool_result",
  tool,
  ok,
  summary,
  at,
  ...(infra ? { infra } : {}),
});
const note = (kind: Extract<RunEvent, { type: "run_note" }>["kind"], summary: string, at?: number): RunEvent => ({
  type: "run_note",
  kind,
  summary,
  at,
});

/** A bash call + its result, `ms` apart, starting at `at`. */
function bash(cmd: string, at: number, ms: number, ok = true, out = "ok"): RunEvent[] {
  return [call("bash", `$ ${cmd}`, at), result("bash", ok, out, at + ms)];
}

const categories = (d: FrictionDiagnosis) => d.findings.map((f) => f.category);

describe("analyzeRunFriction — empty / untimed input", () => {
  it("an empty stream yields a clean, zeroed diagnosis (no findings, no timings)", () => {
    const d = analyzeRunFriction([]);
    expect(d.eventCount).toBe(0);
    expect(d.toolCalls).toBe(0);
    expect(d.hasTimings).toBe(false);
    expect(d.runMs).toBeUndefined();
    expect(d.toolTimeMs).toBeUndefined();
    expect(d.findings).toEqual([]);
    expect(d.verdict).toMatch(/no friction/i);
  });

  it("a clean, fast run has no findings and a no-friction verdict", () => {
    const d = analyzeRunFriction([...bash("ls", T0, 200), ...bash("cat README.md", T0 + 1000, 150)]);
    expect(d.findings).toEqual([]);
    expect(d.toolCalls).toBe(2);
    expect(d.runMs).toBe(1150);
    expect(d.toolTimeMs).toBe(350);
    expect(d.verdict).toMatch(/no friction/i);
  });

  it("untimed events (legacy stream) still classify failures/retries, with no durations", () => {
    const d = analyzeRunFriction([
      call("bash", "$ npm test"),
      result("bash", false, "1 failing"),
      call("bash", "$ npm test"),
      result("bash", true, "all passing"),
    ]);
    expect(d.hasTimings).toBe(false);
    expect(d.runMs).toBeUndefined();
    expect(categories(d)).toEqual(["failed_tool", "retry"]);
    for (const f of d.findings) expect(f.durationMs).toBeUndefined();
  });

  it("ignores the timeline events (`input`, `assistant`): they are narrative, not friction or steps", () => {
    const withText: RunEvent[] = [
      { type: "input", text: "please look at the failing test", at: T0 },
      { type: "assistant", text: "Let me run it.", at: T0 + 500 },
      ...bash("npm test", T0 + 1_000, 200),
      { type: "assistant", text: "One failure; fixing.", at: T0 + 1_300 },
      { type: "answer", text: "fixed", at: T0 + 1_400 },
    ];
    const without = withText.filter((e) => e.type !== "input" && e.type !== "assistant");
    const a = analyzeRunFriction(withText);
    const b = analyzeRunFriction(without);
    expect(a.findings).toEqual(b.findings);
    expect(a.toolCalls).toBe(1);
  });

  it("is deterministic: the same stream yields a deep-equal diagnosis", () => {
    const events = [
      ...bash("npm install", T0, 95_000, false, "ERR! network"),
      ...bash("npm install", T0 + 96_000, 60_000),
    ];
    expect(analyzeRunFriction(events)).toEqual(analyzeRunFriction(events));
  });

  it("does not mutate its input", () => {
    const events = [...bash("npm install", T0, 95_000)];
    const snapshot = structuredClone(events);
    analyzeRunFriction(events);
    expect(events).toEqual(snapshot);
  });
});

describe("analyzeRunFriction — per-category classification", () => {
  it("slow_tool: a tool call whose result arrives past the slow threshold", () => {
    const d = analyzeRunFriction([...bash("npm test", T0, 45_000)], { slowToolMs: 30_000 });
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0]).toMatchObject({
      category: "slow_tool",
      tool: "bash",
      durationMs: 45_000,
      severity: "medium",
      eventIndex: 0,
    });
    expect(d.byCategory.slow_tool).toEqual({ count: 1, durationMs: 45_000 });
    expect(d.verdict).toMatch(/slow tool/i);
  });

  it("slow_tool: ≥2× the threshold is high severity; under the threshold is not flagged", () => {
    const d = analyzeRunFriction([...bash("npm test", T0, 60_000), ...bash("ls", T0 + 70_000, 29_999)], {
      slowToolMs: 30_000,
    });
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].severity).toBe("high");
  });

  it("failed_tool: an ok:false result (including an unknown tool)", () => {
    const d = analyzeRunFriction([
      ...bash("npm test", T0, 2_000, false, "Error: 3 failing"),
      call("frobnicate", "frobnicate", T0 + 3_000),
      result("frobnicate", false, "Unknown tool: frobnicate", T0 + 3_001),
    ]);
    expect(categories(d)).toEqual(["failed_tool", "failed_tool"]);
    expect(d.findings[0]).toMatchObject({
      tool: "bash",
      summary: expect.stringContaining("3 failing"),
      durationMs: 2_000,
    });
    expect(d.findings[1]).toMatchObject({ tool: "frobnicate", eventIndex: 2 });
  });

  it("retry: the same call re-issued after it failed (counted per re-issue, not for the first attempt)", () => {
    const d = analyzeRunFriction([
      ...bash("npm test", T0, 1_000, false, "fail"),
      ...bash("npm test", T0 + 2_000, 1_000, false, "fail"),
      ...bash("npm test", T0 + 4_000, 1_000, true, "pass"),
    ]);
    expect(categories(d)).toEqual(["failed_tool", "retry", "failed_tool", "retry"]);
    expect(d.byCategory.retry.count).toBe(2);
    expect(d.findings.filter((f) => f.category === "retry").map((f) => f.eventIndex)).toEqual([2, 4]);
  });

  it("retry: a repeated call that never failed is NOT a retry", () => {
    const d = analyzeRunFriction([...bash("git status", T0, 100), ...bash("git status", T0 + 1_000, 100)]);
    expect(d.findings).toEqual([]);
  });

  it("setup_install: install/clone commands are classified with their total time, even when fast", () => {
    const d = analyzeRunFriction([
      ...bash("git clone https://github.com/o/r.git", T0, 8_000),
      ...bash("pnpm install --frozen-lockfile", T0 + 9_000, 70_000),
      ...bash("pip install -r requirements.txt", T0 + 80_000, 12_000),
      ...bash("ls", T0 + 93_000, 100),
    ]);
    const setup = d.findings.filter((f) => f.category === "setup_install");
    expect(setup).toHaveLength(3);
    expect(d.byCategory.setup_install).toEqual({ count: 3, durationMs: 90_000 });
    // The 70s install is ALSO a slow tool — but it is reported once, as setup, not twice.
    expect(categories(d).filter((c) => c === "slow_tool")).toHaveLength(0);
    expect(d.verdict).toMatch(/setup\/install/i);
  });

  it("setup_install: a FAILED install is classified as setup (high) — not diluted into failed_tool", () => {
    const d = analyzeRunFriction([...bash("npm ci", T0, 30_000, false, "npm ERR! ERESOLVE")]);
    expect(categories(d)).toEqual(["setup_install"]);
    expect(d.findings[0]).toMatchObject({ severity: "high", summary: expect.stringContaining("failed") });
  });

  it("setup_install: recognizes the common package managers, not `npm test` / `npm run build`", () => {
    const yes = [
      "npm install",
      "npm i",
      "npm ci",
      "yarn",
      "yarn install",
      "pnpm i",
      "bun install",
      "pip3 install x",
      "poetry install",
      "uv sync",
      "apt-get install -y jq",
      "brew install jq",
      "bundle install",
      "cargo fetch",
      "go mod download",
      "npx playwright install",
      "cd repo && npm install",
      "python -m pip install requests",
      "python3 -m pip install -r requirements.txt",
      "corepack yarn install",
      "corepack pnpm i",
    ];
    const no = [
      "npm test",
      "npm run build",
      "pnpm test",
      "cat package.json",
      "yarn test",
      "git status",
      "pip freeze",
      "echo npm install",
      // the subcommand word must END there — a hyphenated continuation is a different word
      "npm ci-lockfile-report",
      "yarn add-hoc-thing foo",
      // quoted text is prose, not a command segment
      'echo "run: cd repo && npm install"',
      "echo 'then; npm install'",
    ];
    for (const c of yes) expect(categories(analyzeRunFriction(bash(c, T0, 10))), c).toEqual(["setup_install"]);
    for (const c of no) expect(categories(analyzeRunFriction(bash(c, T0, 10))), c).toEqual([]);
  });

  it("wrap_up: the runner's wrap-up note, with the time spent after it", () => {
    const d = analyzeRunFriction([
      ...bash("ls", T0, 100),
      note("wrap_up", "~3 min left — signaling wrap-up", T0 + 1_000),
      ...bash("cat notes.md", T0 + 2_000, 500),
      note("turn_budget_exhausted", "turn budget exhausted — writing up findings so far", T0 + 61_000),
    ]);
    const wrap = d.findings.find((f) => f.category === "wrap_up");
    expect(wrap).toMatchObject({ severity: "medium", eventIndex: 2, durationMs: 60_000 });
  });

  it("budget_hit: time- and turn-budget exhaustion notes are high-severity budget hits", () => {
    const d = analyzeRunFriction([
      ...bash("ls", T0, 100),
      note("time_budget_exhausted", "time budget exhausted — writing up findings so far", T0 + 5_000),
    ]);
    expect(categories(d)).toEqual(["budget_hit"]);
    expect(d.findings[0]).toMatchObject({ severity: "high", summary: expect.stringContaining("time") });
    expect(d.verdict).toMatch(/budget/i);
    const t = analyzeRunFriction([note("turn_budget_exhausted", "turn budget exhausted", T0)]);
    expect(t.findings[0]).toMatchObject({ category: "budget_hit", summary: expect.stringContaining("turn") });
  });

  it("infra_failure: an infra-flagged tool result is an infra failure (not a plain failed_tool)", () => {
    const d = analyzeRunFriction([
      call("bash", "$ echo hi", T0),
      result("bash", false, "sandbox exec failed: 502", T0 + 500, true),
    ]);
    expect(categories(d)).toEqual(["infra_failure"]);
    expect(d.findings[0]).toMatchObject({ severity: "high", tool: "bash", durationMs: 500 });
    // The finding names the command that was running when the sandbox failed —
    // two infra failures during different commands must not render identically.
    expect(d.findings[0].summary).toContain("$ echo hi");
    expect(d.findings[0].summary).toContain("502");
  });

  it("failed_tool severity scales with how long the failure took: high once it is also slow", () => {
    const d = analyzeRunFriction(
      [...bash("npm test", T0, 5, false, "fail"), ...bash("npm run e2e", T0 + 10, 600_000, false, "timeout")],
      { slowToolMs: 30_000 },
    );
    expect(d.findings.map((f) => f.severity)).toEqual(["medium", "high"]);
  });

  it("tolerates malformed field types from an external capture (non-string summary/tool) without throwing", () => {
    const events = [
      { type: "tool_call", tool: "bash", summary: 42 as unknown as string, at: T0 },
      { type: "tool_result", tool: "bash", ok: false, summary: "boom", at: T0 + 10 },
    ] as RunEvent[];
    expect(() => analyzeRunFriction(events)).not.toThrow();
    expect(categories(analyzeRunFriction(events))).toEqual(["failed_tool"]);
  });

  it("infra_failure: a fleet_busy note is an infra finding too (capacity is friction), at medium severity — the run went on", () => {
    const d = analyzeRunFriction([
      call("bash", "$ npm test", T0),
      note("fleet_busy", "⏳ Sandbox fleet busy — no free per-thread sandbox after waiting 300s", T0 + 300_000),
      result("bash", false, "⏳ Sandbox fleet busy — …", T0 + 300_500),
    ]);
    const fleet = d.findings.find((f) => f.summary.startsWith("fleet busy"));
    expect(fleet).toMatchObject({ category: "infra_failure", severity: "medium" });
  });

  it("infra_failure: the sandbox_dead note is an infra failure and leads the verdict", () => {
    const d = analyzeRunFriction([
      call("bash", "$ pnpm install", T0),
      result("bash", false, "exec worker error", T0 + 120_000, true),
      call("bash", "$ echo hi", T0 + 121_000),
      result("bash", false, "exec worker error", T0 + 121_500, true),
      note("sandbox_dead", "sandbox unresponsive — aborting", T0 + 122_000),
    ]);
    expect(d.byCategory.infra_failure.count).toBe(3);
    expect(d.verdict).toMatch(/infra/i);
  });
});

describe("analyzeRunFriction — slow_model_turn (the time between a result and the model's next move)", () => {
  // Live run 2026-08-30 (30dc0210): 1850 s wall clock, 50 s of tool time, 35
  // tool calls, verdict "no friction detected" — every gap was the model
  // thinking for 2–4 min between one-line greps. The analyzer must see it.
  const input: RunEvent = { type: "input", text: "fix the thing", at: T0 };

  it("flags a model turn (tool_result → next tool_call) at or past the threshold; under it is not flagged", () => {
    const d = analyzeRunFriction([
      input,
      ...bash("ls", T0 + 5_000, 1_000), // first turn: 5 s of thinking
      ...bash("cat a.ts", T0 + 6_000 + 60_000, 1_000), // 60 s gap → flagged at the default threshold
      ...bash("cat b.ts", T0 + 67_000 + 59_999, 1_000), // just under → not flagged
    ]);
    expect(categories(d)).toEqual(["slow_model_turn"]);
    const [f] = d.findings;
    expect(f.severity).toBe("medium");
    expect(f.durationMs).toBe(60_000);
    expect(f.summary).toMatch(/1m 00s/);
    expect(f.summary).toContain("$ cat a.ts"); // anchored to the call the turn produced
    expect(f.eventIndex).toBe(3);
    expect(d.modelTimeMs).toBe(5_000 + 60_000 + 59_999);
  });

  it("≥2× the threshold is high severity; the threshold is configurable", () => {
    const d = analyzeRunFriction(
      [input, ...bash("ls", T0 + 20_000, 1_000), ...bash("pwd", T0 + 21_000 + 9_000, 1_000)],
      { slowModelTurnMs: 10_000 },
    );
    expect(d.findings.map((f) => [f.category, f.severity])).toEqual([
      ["slow_model_turn", "high"], // 20 s ≥ 2 × 10 s
    ]);
  });

  it("narration ends the turn: a slow think that produces `assistant` text is one finding, not one per following tool row", () => {
    const d = analyzeRunFriction([
      input,
      ...bash("ls", T0 + 1_000, 1_000),
      { type: "assistant", text: "Now I understand. Let me check more.", at: T0 + 2_000 + 90_000 },
      ...bash("cat a.ts", T0 + 92_000 + 10, 1_000), // the call rides the same completion (10 ms later)
      ...bash("cat b.ts", T0 + 93_010 + 10, 1_000),
    ]);
    expect(categories(d)).toEqual(["slow_model_turn"]);
    expect(d.findings[0].eventIndex).toBe(3);
    expect(d.findings[0].durationMs).toBe(90_000);
  });

  it("the final answer is the last model turn; runner notes between a result and the next call do not split the turn", () => {
    const d = analyzeRunFriction([
      input,
      ...bash("ls", T0 + 1_000, 1_000),
      note("wrap_up", "3 min left", T0 + 30_000),
      { type: "answer", text: "done", at: T0 + 2_000 + 120_000 },
    ]);
    const slow = d.findings.filter((f) => f.category === "slow_model_turn");
    expect(slow).toHaveLength(1);
    expect(slow[0].durationMs).toBe(120_000);
    expect(slow[0].summary).toMatch(/answer/);
  });

  it("untimed streams never produce slow_model_turn and carry no modelTimeMs", () => {
    const d = analyzeRunFriction([
      call("bash", "$ ls"),
      result("bash", true, "ok"),
      call("bash", "$ pwd"),
      result("bash", true, "ok"),
    ]);
    expect(categories(d)).toEqual([]);
    expect(d.modelTimeMs).toBeUndefined();
  });

  it("the verdict for dominant model time is a share of RUN time (tool time would exceed 100%)", () => {
    const d = analyzeRunFriction([
      input,
      ...bash("ls", T0 + 1_000, 1_000),
      ...bash("cat a.ts", T0 + 2_000 + 180_000, 2_000), // 3 min think, 2 s tool
    ]);
    expect(d.verdict).toMatch(/slow model turns dominated: 1 finding, 3m 00s/);
    expect(d.verdict).toMatch(/of run time/);
    expect(d.verdict).not.toMatch(/tool time/);
  });
});

describe("analyzeRunFriction — aggregation and verdict", () => {
  it("runMs spans first→last timestamp; toolTimeMs sums paired call→result durations", () => {
    const d = analyzeRunFriction([
      ...bash("a", T0, 1_000),
      ...bash("b", T0 + 5_000, 2_000),
      note("wrap_up", "w", T0 + 10_000),
    ]);
    expect(d.runMs).toBe(10_000);
    expect(d.toolTimeMs).toBe(3_000);
    expect(d.hasTimings).toBe(true);
  });

  it("an unpaired trailing tool_call (run died mid-tool) is reported as an infra failure, not ignored", () => {
    const d = analyzeRunFriction([...bash("ls", T0, 100), call("bash", "$ npm install", T0 + 1_000)]);
    expect(categories(d)).toEqual(["infra_failure"]);
    expect(d.findings[0]).toMatchObject({ eventIndex: 2, summary: expect.stringContaining("no result") });
    expect(d.toolCalls).toBe(2);
  });

  it("an unpaired trailing tool_call in an UNFINISHED stream (finished:false) is not flagged — it is still running", () => {
    const d = analyzeRunFriction([...bash("ls", T0, 100), call("bash", "$ npm install", T0 + 1_000)], {
      finished: false,
    });
    expect(d.findings).toEqual([]);
    expect(d.toolCalls).toBe(2);
  });

  it("the verdict names the category that cost the most time, with its share of tool time", () => {
    const d = analyzeRunFriction([
      ...bash("npm install", T0, 60_000),
      ...bash("npm test", T0 + 61_000, 40_000, false, "fail"), // failed AND slow → failed_tool
    ]);
    expect(d.verdict).toMatch(/setup\/install/i);
    expect(d.verdict).toMatch(/1m 00s/);
    expect(d.verdict).toMatch(/60%/);
  });

  it("with no timings the verdict falls back to the category with the most findings", () => {
    const d = analyzeRunFriction([
      call("bash", "$ x"),
      result("bash", false, "e"),
      call("bash", "$ y"),
      result("bash", false, "e"),
      call("bash", "$ x"),
      result("bash", true, "ok"),
    ]);
    expect(d.verdict).toMatch(/failed tool/i);
  });

  it("byCategory always lists every category (zeroed when absent), so consumers need no undefined checks", () => {
    const d = analyzeRunFriction([]);
    expect(Object.keys(d.byCategory).sort()).toEqual([
      "budget_hit",
      "failed_tool",
      "infra_failure",
      "retry",
      "setup_install",
      "slow_model_turn",
      "slow_tool",
      "wrap_up",
    ]);
    for (const v of Object.values(d.byCategory)) expect(v).toEqual({ count: 0, durationMs: 0 });
  });
});

describe("formatFrictionReport", () => {
  it("renders the verdict, totals, a per-category table, and each finding on one line", () => {
    const d = analyzeRunFriction([
      ...bash("pnpm install", T0, 70_000),
      ...bash("npm test", T0 + 71_000, 3_000, false, "2 failing"),
      ...bash("npm test", T0 + 75_000, 3_000, true, "pass"),
    ]);
    const text = formatFrictionReport(d);
    expect(text).toContain(d.verdict);
    expect(text).toMatch(/events: 6/);
    expect(text).toMatch(/tool calls: 3/);
    expect(text).toMatch(/run: 1m 18s/);
    expect(text).toMatch(/tool time: 1m 16s · model time: 2s/); // 1 s + 1 s between the paired calls
    expect(text).toMatch(/slow_model_turn\s+0\s+-/);
    expect(text).toMatch(/setup_install\s+1\s+1m 10s/);
    expect(text).toMatch(/\[setup_install\].*pnpm install/);
    expect(text).toMatch(/\[failed_tool\].*2 failing/);
    expect(text).toMatch(/\[retry\].*npm test/);
  });

  it("an empty diagnosis renders without throwing and says so", () => {
    expect(formatFrictionReport(analyzeRunFriction([]))).toMatch(/no friction/i);
  });
});

// Feature: features/run-visibility.md — the narrative events (#157 U1: `input`,
// `context`, `assistant`, `answer`) are the run's story, not its steps: none of
// them counts toward `eventCount`. `input`/`assistant`/`answer` still drive the
// model-turn clock (run-friction.md, slow_model_turn); `context` — replayed
// thread history published at run start, with timestamps of its own — is
// invisible to timing as well, so `runMs` never stretches back to an old turn.
describe("analyzeRunFriction — narrative events are not steps; `context` is invisible to timing", () => {
  it("eventCount excludes every narrative event; steps, categories and findings are unchanged", () => {
    const steps: RunEvent[] = [...bash("npm test", T0 + 1000, 2000), note("wrap_up", "wrapping up", T0 + 5000)];
    const withMessages: RunEvent[] = [
      { type: "input", text: "please run the tests", at: T0, seq: 1 },
      { type: "context", text: "earlier thread turn", at: T0 - 60_000, seq: 2 },
      ...steps,
      { type: "assistant", text: "one more check", at: T0 + 4000, seq: 6 },
      { type: "answer", text: "done", at: T0 + 9000, seq: 7 },
    ];
    const plain = analyzeRunFriction(steps);
    const mixed = analyzeRunFriction(withMessages);
    expect(mixed.eventCount).toBe(plain.eventCount);
    expect(mixed.toolCalls).toBe(plain.toolCalls);
    // Counts match; durations may not — the `answer` legitimately extends the
    // stream's end (a wrap-up that took until the answer took that long).
    const counts = (d: FrictionDiagnosis) =>
      Object.fromEntries(Object.entries(d.byCategory).map(([c, t]) => [c, t.count]));
    expect(counts(mixed)).toEqual(counts(plain));
    expect(mixed.findings.map((f) => f.category)).toEqual(plain.findings.map((f) => f.category));
  });

  it("`context` timestamps never move firstAt/lastAt: runMs spans the request → the answer, not the replayed history", () => {
    const events: RunEvent[] = [
      { type: "input", text: "please run the tests", at: T0 },
      { type: "context", text: "user: an hour-old turn", at: T0 - 3_600_000 },
      { type: "context", text: "assistant: its reply", at: T0 - 3_500_000 },
      ...bash("npm test", T0 + 1000, 2000),
      { type: "answer", text: "done", at: T0 + 9000 },
    ];
    const d = analyzeRunFriction(events);
    expect(d.runMs).toBe(9000);
    expect(d.eventCount).toBe(2);
    expect(analyzeRunFriction(events.filter((e) => e.type !== "context"))).toEqual(d);
  });

  it("a `turn` (the model call's receipt) is not a step: excluded from eventCount, but its timestamp still bounds the run like `answer` does", () => {
    const events: RunEvent[] = [
      { type: "input", text: "please run the tests", at: T0 },
      { type: "turn", startedAt: T0, durationMs: 900, stopReason: "tool_use", at: T0 + 900 },
      ...bash("npm test", T0 + 1000, 2000),
      {
        type: "turn",
        startedAt: T0 + 3000,
        durationMs: 6000,
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 2 },
        at: T0 + 9000,
      },
    ];
    const d = analyzeRunFriction(events);
    expect(d.eventCount).toBe(2);
    expect(d.runMs).toBe(9000);
    expect(d.toolCalls).toBe(1);
  });

  it("a stream of only `context` events has no timings and zero events", () => {
    const d = analyzeRunFriction([
      { type: "context", text: "user: hi", at: T0 },
      { type: "context", text: "assistant: hello", at: T0 + 100 },
    ]);
    expect(d.eventCount).toBe(0);
    expect(d.hasTimings).toBe(false);
    expect(d.runMs).toBeUndefined();
  });
});

describe("analyzeRunFriction — truncated input (the registry backlog dropped events)", () => {
  it("`truncated: true` marks the diagnosis `truncatedInput: true`; the report says so; absent otherwise", () => {
    const events = [...bash("npm test", T0, 3_000)];
    const full = analyzeRunFriction(events, { finished: true });
    expect("truncatedInput" in full).toBe(false);
    const cut = analyzeRunFriction(events, { finished: true, truncated: true });
    expect(cut.truncatedInput).toBe(true);
    expect(formatFrictionReport(cut)).toMatch(/input truncated/i);
    expect(formatFrictionReport(full)).not.toMatch(/truncated/i);
  });
});

// Feature: features/agent-ship.md item 12 — `ship_round` marks a pipeline's
// round boundaries: a fact about the run, not a step. Like the other side
// facts (skill_use, review_artifact, pr_description, pr_opened) it must not
// count as an event, a tool call, or a model-turn boundary.
describe("analyzeRunFriction — ship_round is a side fact, invisible to friction", () => {
  const base: RunEvent[] = [
    { type: "input", text: "agent:ship in acme/api: fix it", at: T0 },
    ...bash("npm test", T0 + 1000, 2000),
    { type: "answer", text: "Merge-ready", at: T0 + 9000 },
  ];
  const withRounds: RunEvent[] = [
    base[0],
    { type: "ship_round", index: 0, agent: "coding", outcome: "started", at: T0 + 500 },
    ...base.slice(1, 3),
    { type: "ship_round", index: 0, agent: "coding", outcome: "pr_opened", at: T0 + 3500 },
    base[3],
  ];

  it("the diagnosis is identical with or without the ship_round boundaries", () => {
    const a = analyzeRunFriction(base, { finished: true });
    const b = analyzeRunFriction(withRounds, { finished: true });
    expect(b.eventCount).toBe(a.eventCount);
    expect(b.toolCalls).toBe(a.toolCalls);
    expect(b.findings).toEqual(a.findings);
    expect(b.runMs).toBe(a.runMs);
  });
});

// Feature: features/tracing.md — reader tolerance: span records on the stream
// (emitted from PR 4 on) are timing, not steps; they never count as events nor
// move the stream's first/last stamps.
describe("analyzeRunFriction — span records are invisible to counts and to the stream clock", () => {
  it("excludes span_start/span_end from eventCount and from firstAt/lastAt", () => {
    const spanStart = {
      type: "span_start",
      spanId: "s1",
      name: "dispatch.history",
      at: T0 - 50_000,
    } as unknown as RunEvent;
    const spanEnd = {
      type: "span_end",
      spanId: "s1",
      name: "dispatch.history",
      startedAt: T0 - 50_000,
      durationMs: 200_000,
      status: "ok",
      at: T0 + 150_000,
    } as unknown as RunEvent;
    const d = analyzeRunFriction([spanStart, ...bash("npm test", T0, 5_000), spanEnd]);
    expect(d.eventCount).toBe(2);
    expect(d.runMs).toBe(5_000);
  });
});
