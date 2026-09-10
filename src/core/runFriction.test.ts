import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "./runEvents.js";
import {
  analyzeRunFriction,
  DENOMINATOR_OF,
  formatFrictionReport,
  FRICTION_CATEGORIES,
  type FrictionDiagnosis,
} from "./runFriction.js";

// Feature: docs/reference/specs/run-friction.md — the pure, deterministic analyzer that
// turns a run's RunEvent stream into a structured friction diagnosis.
// Streams below are synthetic: one per friction category, plus edges.

const T0 = 1_700_000_000_000;
// The pair key the runner stamps on both halves: `call` mints a `callId`, and
// `result` takes the oldest open one of its tool — the runner's own order — so
// a fixture reads as call/result prose while every pair is keyed like a real
// stream (a pair without a key gets no span, hence no duration).
let nextCallId = 0;
const openCallIds = new Map<string, string[]>();
beforeEach(() => {
  nextCallId = 0;
  openCallIds.clear();
});
const call = (tool: string, summary: string, at?: number): RunEvent => {
  const callId = `c${++nextCallId}`;
  openCallIds.set(tool, [...(openCallIds.get(tool) ?? []), callId]);
  return { type: "tool_call", tool, summary, callId, at };
};
const result = (tool: string, ok: boolean, summary: string, at?: number, infra?: true): RunEvent => ({
  type: "tool_result",
  tool,
  ok,
  summary,
  callId: openCallIds.get(tool)?.shift() ?? `orphan${++nextCallId}`,
  at,
  ...(infra ? { infra } : {}),
});
/** One model call as the runner records it: a `model.turn` span end. */
const turnSpan = (spanId: string, startedAt: number, durationMs: number, stopReason = "tool_use"): RunEvent => ({
  type: "span_end",
  spanId,
  name: "model.turn",
  startedAt,
  durationMs,
  status: "ok",
  attrs: { stopReason },
  at: startedAt + durationMs,
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

  it("untimed events (a hand-written capture) still classify failures/retries, with no durations", () => {
    const d = analyzeRunFriction([
      call("bash", "$ npm test"),
      result("bash", false, "1 failing"),
      call("bash", "$ npm test"),
      result("bash", true, "all passing"),
    ]);
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

describe("analyzeRunFriction — slow_model_turn (the model.turn spans)", () => {
  // A run of 1850 s wall clock with 50 s of tool time across 35 tool calls once
  // got the verdict "no friction detected" — every gap was the model thinking
  // for 2–4 min between one-line greps. The analyzer must see it: model time is
  // the `model.turn` spans the runner records, one per completion, each ending
  // right before what the completion produced.
  const input: RunEvent = { type: "input", text: "fix the thing", at: T0 };

  it("flags a model turn at or past the threshold; under it is not flagged; each turn names what it produced", () => {
    const d = analyzeRunFriction([
      input,
      turnSpan("m1", T0, 5_000), // first turn: 5 s of thinking
      ...bash("ls", T0 + 5_000, 1_000),
      turnSpan("m2", T0 + 6_000, 60_000), // flagged at the default threshold
      ...bash("cat a.ts", T0 + 66_000, 1_000),
      turnSpan("m3", T0 + 67_000, 59_999), // just under → not flagged
      ...bash("cat b.ts", T0 + 126_999, 1_000),
    ]);
    expect(categories(d)).toEqual(["slow_model_turn"]);
    const [f] = d.findings;
    expect(f.severity).toBe("medium");
    expect(f.durationMs).toBe(60_000);
    expect(f.summary).toMatch(/1m 00s/);
    expect(f.summary).toContain("$ cat a.ts"); // anchored to its own span end, naming the call it produced
    expect(f.eventIndex).toBe(4);
    expect(d.modelTimeMs).toBe(5_000 + 60_000 + 59_999);
  });

  it("≥2× the threshold is high severity; the threshold is configurable", () => {
    const d = analyzeRunFriction(
      [input, turnSpan("m1", T0, 20_000), ...bash("ls", T0 + 20_000, 1_000), turnSpan("m2", T0 + 21_000, 9_000)],
      { slowModelTurnMs: 10_000 },
    );
    expect(d.findings.map((f) => [f.category, f.severity])).toEqual([
      ["slow_model_turn", "high"], // 20 s ≥ 2 × 10 s
    ]);
  });

  it("a narrating completion is one turn: a slow think that produces `assistant` text is one finding naming the narration, not one per following tool row", () => {
    const d = analyzeRunFriction([
      input,
      ...bash("ls", T0 + 1_000, 1_000),
      turnSpan("m1", T0 + 2_000, 90_000),
      { type: "assistant", text: "Now I understand. Let me check more.", at: T0 + 92_000 },
      ...bash("cat a.ts", T0 + 92_010, 1_000), // the call rides the same completion (10 ms later)
      ...bash("cat b.ts", T0 + 93_020, 1_000),
    ]);
    expect(categories(d)).toEqual(["slow_model_turn"]);
    expect(d.findings[0].eventIndex).toBe(3);
    expect(d.findings[0].durationMs).toBe(90_000);
    expect(d.findings[0].summary).toBe("model turn took 1m 30s before: (narration)");
  });

  it("the final answer is the last model turn's product; a stream without model.turn spans has no model time and no slow turn, whatever the gaps", () => {
    const d = analyzeRunFriction([
      input,
      ...bash("ls", T0 + 1_000, 1_000),
      note("wrap_up", "3 min left", T0 + 30_000),
      turnSpan("m1", T0 + 2_000, 120_000, "end_turn"),
      { type: "answer", text: "done", at: T0 + 122_000 },
    ]);
    const slow = d.findings.filter((f) => f.category === "slow_model_turn");
    expect(slow).toHaveLength(1);
    expect(slow[0].durationMs).toBe(120_000);
    expect(slow[0].summary).toMatch(/answer/);
    // The same content with no turn spans: a two-minute silence between the
    // result and the answer is not the model's time — nothing recorded it.
    const gaps = analyzeRunFriction([
      input,
      ...bash("ls", T0 + 1_000, 1_000),
      note("wrap_up", "3 min left", T0 + 30_000),
      { type: "answer", text: "done", at: T0 + 122_000 },
    ]);
    expect(gaps.findings.filter((f) => f.category === "slow_model_turn")).toEqual([]);
    expect(gaps.modelTimeMs).toBeUndefined();
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
      turnSpan("m1", T0 + 2_000, 180_000), // 3 min think, 2 s tool
      ...bash("cat a.ts", T0 + 182_000, 2_000),
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
      turnSpan("m1", T0 + 70_000, 1_000),
      ...bash("npm test", T0 + 71_000, 3_000, false, "2 failing"),
      turnSpan("m2", T0 + 74_000, 1_000),
      ...bash("npm test", T0 + 75_000, 3_000, true, "pass"),
    ]);
    const text = formatFrictionReport(d);
    expect(text).toContain(d.verdict);
    expect(text).toMatch(/events: 6/);
    expect(text).toMatch(/tool calls: 3/);
    expect(text).toMatch(/run: 1m 18s/);
    expect(text).toMatch(/tool time: 1m 16s · model time: 2s/); // the two turn spans between the paired calls
    // The table and the finding lines print the human labels, the column sized to the longest.
    expect(text).toMatch(/slow model turns\s+0\s+-/);
    expect(text).toMatch(/the repo's setup\/install\s+1\s+1m 10s/);
    expect(text).toMatch(/\[the repo's setup\/install\].*pnpm install/);
    expect(text).toMatch(/\[failed tool calls\].*2 failing/);
    expect(text).toMatch(/\[retries\].*npm test/);
    expect(text).not.toMatch(/shape:/); // no window → no shape
  });

  it("an empty diagnosis renders without throwing and says so", () => {
    expect(formatFrictionReport(analyzeRunFriction([]))).toMatch(/no friction/i);
  });
});

// Feature: docs/reference/specs/run-visibility.md — the narrative events (`input`,
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

  it("a `model.turn` span is not a step: excluded from eventCount, and — timing, not content — its stamp never moves the stream's clock", () => {
    const events: RunEvent[] = [
      { type: "input", text: "please run the tests", at: T0 },
      turnSpan("m1", T0, 900),
      ...bash("npm test", T0 + 1000, 2000),
      turnSpan("m2", T0 + 3000, 6000, "end_turn"),
      { type: "answer", text: "done", at: T0 + 9000 },
    ];
    const d = analyzeRunFriction(events);
    expect(d.eventCount).toBe(2);
    expect(d.runMs).toBe(9000);
    expect(d.toolCalls).toBe(1);
    expect(d.modelTimeMs).toBe(900 + 6000); // the spans' own durations
    // Without the answer the clock ends at the tool result, not at the turn span.
    expect(analyzeRunFriction(events.slice(0, -1)).runMs).toBe(3000);
  });

  it("a stream of only `context` events has no timings and zero events", () => {
    const d = analyzeRunFriction([
      { type: "context", text: "user: hi", at: T0 },
      { type: "context", text: "assistant: hello", at: T0 + 100 },
    ]);
    expect(d.eventCount).toBe(0);
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

// Feature: docs/reference/specs/agent-ship.md item 12 — `ship_round` marks a pipeline's
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

// Feature: docs/reference/specs/tracing.md — reader tolerance: span records on the stream
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

  // Feature: docs/reference/specs/tracing.md — a stream timed by `model.turn` spans takes
  // model time from them, never from the result→call gap as well.
  it("model.turn span ends are the model time: summed, flagged past the threshold at the span's index, never the result→call gap", () => {
    const turn = (spanId: string, startedAt: number, durationMs: number, stopReason = "tool_use") =>
      ({
        type: "span_end",
        spanId,
        name: "model.turn",
        startedAt,
        durationMs,
        status: "ok",
        attrs: { stopReason },
        at: startedAt + durationMs,
      }) as unknown as RunEvent;
    const events: RunEvent[] = [
      { type: "input", text: "fix the thing", at: T0 },
      turn("m1", T0, 4_000), // the runner measured 4 s; the gap to the call below is 5 s
      ...bash("ls", T0 + 5_000, 1_000),
      turn("m2", T0 + 6_000, 61_000), // flagged
      ...bash("cat a.ts", T0 + 68_000, 1_000),
      turn("m3", T0 + 69_000, 2_000, "end_turn"),
      { type: "answer", text: "done", at: T0 + 71_000 },
    ];
    const d = analyzeRunFriction(events);
    expect(d.modelTimeMs).toBe(4_000 + 61_000 + 2_000);
    expect(categories(d)).toEqual(["slow_model_turn"]);
    expect(d.findings[0]).toMatchObject({ durationMs: 61_000, eventIndex: 4, severity: "medium" });
    expect(d.findings[0].summary).toBe("model turn took 1m 01s before: $ cat a.ts"); // it names the call it produced
    expect(d.eventCount).toBe(4); // the two tool pairs; spans and narrative are not steps
  });
});

// Feature: docs/reference/specs/tracing.md item 5; docs/reference/specs/run-friction.md items 3–4 — the
// analyzer on spans: one span set for every duration, the window and the shape,
// union time for the run-denominated categories, and the report's vocabulary.
describe("analyzeRunFriction — the window, the shape and the span set (docs/reference/specs/tracing.md)", () => {
  const span = (
    spanId: string,
    name: string,
    startedAt: number,
    durationMs: number,
    attrs: Record<string, string | number | boolean> = {},
    parentSpanId?: string,
  ): RunEvent[] => [
    {
      type: "span_start",
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      at: startedAt,
    } as unknown as RunEvent,
    {
      type: "span_end",
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      startedAt,
      durationMs,
      status: "ok",
      attrs,
      at: startedAt + durationMs,
    } as unknown as RunEvent,
  ];

  /** A schema-2 stream the way the dispatcher and runner emit one: the root and
   *  a setup span, the loop with two turns around one tool, the PR post step. */
  const traced = (): RunEvent[] => [
    { type: "span_start", spanId: "root", name: "request", at: T0 } as unknown as RunEvent,
    ...span("s1", "dispatch.workspace.attach", T0, 30_000),
    { type: "input", text: "fix it", at: T0 + 30_000 },
    {
      type: "span_start",
      spanId: "a",
      parentSpanId: "root",
      name: "run.agent",
      at: T0 + 32_000,
    } as unknown as RunEvent,
    ...span("m1", "model.turn", T0 + 32_000, 150_000, { stopReason: "tool_use" }, "a"),
    { type: "span_start", spanId: "t1", parentSpanId: "a", name: "tool.bash", at: T0 + 182_000 } as unknown as RunEvent,
    { type: "tool_call", tool: "bash", summary: "$ npm test", callId: "c1", spanId: "t1", at: T0 + 182_000 },
    { type: "tool_result", tool: "bash", ok: true, summary: "ok", callId: "c1", spanId: "t1", at: T0 + 237_000 },
    {
      type: "span_end",
      spanId: "t1",
      parentSpanId: "a",
      name: "tool.bash",
      startedAt: T0 + 182_000,
      durationMs: 55_000,
      status: "ok",
      attrs: { callId: "c1", ok: true },
      at: T0 + 237_000,
    } as unknown as RunEvent,
    ...span("m2", "model.turn", T0 + 237_000, 5_000, { stopReason: "end_turn" }, "a"),
    {
      type: "span_end",
      spanId: "a",
      parentSpanId: "root",
      name: "run.agent",
      startedAt: T0 + 32_000,
      durationMs: 210_000,
      status: "ok",
      at: T0 + 242_000,
    } as unknown as RunEvent,
    ...span("p1", "run.pr_post_step", T0 + 244_000, 8_000),
    { type: "answer", text: "done", at: T0 + 252_000 },
  ];
  const WINDOW = { start: T0, end: T0 + 252_000 };

  it("with a finished window: runMs is the window, model and tool time are the spans' sums, and the shape partitions the window (identity holds)", () => {
    const d = analyzeRunFriction(traced(), { finished: true, window: WINDOW });
    expect(d.runMs).toBe(252_000);
    expect(d.modelTimeMs).toBe(155_000);
    expect(d.toolTimeMs).toBe(55_000);
    expect(d.shape).toEqual({
      windowMs: 252_000,
      gettingReadyMs: 30_000,
      thinkingMs: 155_000,
      toolsMs: 55_000,
      finishingUpMs: 8_000,
      overheadMs: 4_000,
      notRecordedMs: 0,
      notLoadedMs: 0,
    });
    const sh = d.shape!;
    expect(sh.gettingReadyMs + sh.thinkingMs + sh.toolsMs + sh.finishingUpMs + sh.overheadMs).toBe(sh.windowMs);
    // The slow turn is anchored to its own span end and names the call it produced; the slow tool to its call.
    expect(d.findings.map((f) => [f.category, f.eventIndex, f.durationMs])).toEqual([
      ["slow_model_turn", 6, 150_000],
      ["slow_tool", 8, 55_000],
    ]);
    expect(d.findings[0].summary).toBe("model turn took 2m 30s before: $ npm test");
    expect(d.verdict).toBe("slow model turns dominated: 1 finding, 2m 30s (60% of run time)");
  });

  it("without a window (a stdin capture) there is no shape and runMs is first→last over the content; live (unfinished) with a window there is no shape either", () => {
    const capture = analyzeRunFriction(traced(), { finished: true });
    expect(capture.shape).toBeUndefined();
    expect(capture.runMs).toBe(252_000 - 30_000); // input → answer
    expect(capture.modelTimeMs).toBe(155_000);
    const live = analyzeRunFriction(traced(), { finished: false, window: WINDOW });
    expect(live.shape).toBeUndefined();
    expect(live.runMs).toBe(252_000);
  });

  it("a live read: an open model turn runs to the window's end and counts as thinking so far", () => {
    const events = traced().slice(0, 6); // through the first turn's start — no end yet
    const d = analyzeRunFriction(events, { finished: false, window: { start: T0, end: T0 + 92_000 } });
    expect(d.modelTimeMs).toBe(60_000); // T0+32 s → T0+92 s
    expect(d.findings.map((f) => f.category)).toEqual(["slow_model_turn"]);
  });

  it("a command run's window: `run.command` is its tools", () => {
    const events: RunEvent[] = [
      { type: "span_start", spanId: "root", name: "request", at: T0 } as unknown as RunEvent,
      { type: "input", text: "friction report", at: T0 + 1_000 },
      ...span("c", "run.command", T0 + 1_000, 20_000, { command: "friction.report" }),
      { type: "answer", text: "…", at: T0 + 21_000 },
    ];
    const asCommand = analyzeRunFriction(events, {
      finished: true,

      owner: "command",
      window: { start: T0, end: T0 + 22_000 },
    });
    expect(asCommand.shape).toMatchObject({ toolsMs: 20_000, gettingReadyMs: 0, overheadMs: 2_000 });
    const asAgent = analyzeRunFriction(events, { finished: true, window: { start: T0, end: T0 + 22_000 } });
    expect(asAgent.shape).toMatchObject({ toolsMs: 0, gettingReadyMs: 20_000 });
  });

  it("run-denominated categories take the UNION of their findings' intervals: three calls of one batch dying together are one interval, and the share never exceeds 100 %", () => {
    // Three concurrent reads under one turn; the sandbox died under all three at once.
    const events: RunEvent[] = [
      { type: "input", text: "go", at: T0 },
      call("read_file", "a.ts", T0 + 1_000),
      call("read_file", "b.ts", T0 + 1_000),
      call("read_file", "c.ts", T0 + 1_000),
      result("read_file", false, "sandbox worker /exec: 502", T0 + 31_000, true),
      result("read_file", false, "sandbox worker /exec: 502", T0 + 31_000, true),
      result("read_file", false, "sandbox worker /exec: 502", T0 + 31_000, true),
    ];
    const d = analyzeRunFriction(events, { finished: true, window: { start: T0, end: T0 + 40_000 } });
    expect(d.findings.filter((f) => f.category === "infra_failure")).toHaveLength(3);
    expect(d.findings[0].interval).toEqual({ start: T0 + 1_000, end: T0 + 31_000 });
    expect(d.byCategory.infra_failure).toEqual({ count: 3, durationMs: 30_000 }); // the union, not 90 s
    expect(d.toolTimeMs).toBe(90_000); // the sum: each call is a summand of tool time
    expect(DENOMINATOR_OF.infra_failure).toBe("run");
    expect(d.verdict).toBe("infra failures dominated: 3 findings, 30s (75% of run time)");
  });

  it("wrap-up runs from the warning to the window's end; a budget hit or a dead sandbox has no extent and prints `-`", () => {
    const events: RunEvent[] = [
      { type: "input", text: "go", at: T0 },
      ...bash("ls", T0 + 1_000, 1_000),
      note("wrap_up", "3 min left", T0 + 10_000),
      note("time_budget_exhausted", "25 min", T0 + 30_000),
      { type: "answer", text: "partial", at: T0 + 31_000 },
    ];
    const d = analyzeRunFriction(events, { finished: true, window: { start: T0, end: T0 + 35_000 } });
    const wrap = d.findings.find((f) => f.category === "wrap_up")!;
    expect(wrap.interval).toEqual({ start: T0 + 10_000, end: T0 + 35_000 });
    expect(wrap.durationMs).toBe(25_000);
    expect(d.byCategory.wrap_up.durationMs).toBe(25_000);
    const budget = d.findings.find((f) => f.category === "budget_hit")!;
    expect(budget.interval).toBeUndefined();
    expect(budget.durationMs).toBeUndefined();
    expect(formatFrictionReport(d)).toMatch(/budget hits\s+1\s+-/);
    expect(formatFrictionReport(d)).toMatch(/agent wind-down\s+1\s+25s/);
  });

  it("every category names its denominator", () => {
    for (const c of FRICTION_CATEGORIES) expect(["tool", "run"]).toContain(DENOMINATOR_OF[c]);
  });

  it("the report: the shape line under the totals; `tool calls`/`tool time` only when a tool ran; `model time` only when the model turned", () => {
    const text = formatFrictionReport(analyzeRunFriction(traced(), { finished: true, window: WINDOW }));
    expect(text).toContain("run: 4m 12s · tool time: 55s · model time: 2m 35s");
    expect(text).toContain(
      "shape: 30s getting ready · 2m 35s thinking · 55s in tools · 8s finishing up · 4s Switchboard overhead",
    );
    const command = formatFrictionReport(
      analyzeRunFriction(
        [
          { type: "input", text: "friction report", at: T0 },
          ...span("c", "run.command", T0, 2_000, { command: "friction.report" }),
          { type: "answer", text: "…", at: T0 + 2_000 },
        ],
        { finished: true, owner: "command", window: { start: T0, end: T0 + 2_000 } },
      ),
    );
    expect(command).not.toMatch(/tool calls:|tool time:|model time:/);
    expect(command).toMatch(/^verdict: no friction detected\nevents: 0 · run: 2s\nshape: 2s \(one bucket\)/);
  });

  it("differential: a record whose tool.* twins the budget dropped is timed like the full stream — the pair's own stamps give the span back; a record with no spans at all times nothing", () => {
    const full = analyzeRunFriction(traced(), { finished: true, window: WINDOW });
    const twinless = traced().filter(
      (e) => !((e.type === "span_start" || e.type === "span_end") && e.name === "tool.bash"),
    );
    const d = analyzeRunFriction(twinless, { finished: true, window: WINDOW });
    expect(d.modelTimeMs).toBe(full.modelTimeMs);
    expect(d.toolTimeMs).toBe(full.toolTimeMs);
    expect(d.shape).toEqual(full.shape);
    expect(d.findings.map((f) => [f.category, f.durationMs, f.summary])).toEqual(
      full.findings.map((f) => [f.category, f.durationMs, f.summary]),
    );
    // A stored record from before spans (no span records, `model.turn` included)
    // is a content stream: the classification, the window, no model time.
    const untimed = traced().filter((e) => e.type !== "span_start" && e.type !== "span_end");
    const u = analyzeRunFriction(untimed, { finished: true, window: WINDOW });
    expect(u.runMs).toBe(252_000);
    expect(u.modelTimeMs).toBeUndefined();
    expect(u.toolTimeMs).toBe(55_000); // the pair's own stamps
    expect(u.findings.map((f) => f.category)).toEqual(["slow_tool"]);
    expect(d.eventCount).toBe(2); // the one pair; spans and the narrative are not steps
  });
});
