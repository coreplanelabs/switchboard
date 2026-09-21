import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideExecution, type ExecutionCell, type Surface, type TurnOutcome } from "./execution.js";

// Record 0069's amended table, row by row: every turn outcome × surface pair
// answers exactly one cell, and the whole table is enumerated here so a
// changed cell is a failing row, never a drifting caller.
describe("the turn-outcome table is total and owns every outcome", () => {
  const surfaces: Surface[] = ["chat", "typed"];
  const rows: Array<{ name: string; outcome: TurnOutcome; expect: Record<Surface, ExecutionCell> }> = [
    {
      name: "run_command below the effective confirm class runs on both surfaces",
      outcome: { kind: "run_command", confirm: "below", mintable: true },
      expect: { chat: { cell: "run" }, typed: { cell: "run" } },
    },
    {
      name: "run_command below the confirm class runs even where no click could mint — the ladder never asked for one",
      outcome: { kind: "run_command", confirm: "below", mintable: false },
      expect: { chat: { cell: "run" }, typed: { cell: "run" } },
    },
    {
      name: "run_command at or above the confirm class clicks on chat and refuses naming the typed form on a typed surface",
      outcome: { kind: "run_command", confirm: "at_or_above", mintable: true },
      expect: { chat: { cell: "click" }, typed: { cell: "refuse", names: "typed_form" } },
    },
    {
      name: "run_command at or above the confirm class with no mintable click refuses naming why — never a line to retype on chat",
      outcome: { kind: "run_command", confirm: "at_or_above", mintable: false },
      expect: { chat: { cell: "refuse", names: "mint_failure" }, typed: { cell: "refuse", names: "typed_form" } },
    },
    {
      name: "bind_preset runs the person's own request through preset resolution",
      outcome: { kind: "bind_preset" },
      expect: { chat: { cell: "route" }, typed: { cell: "route" } },
    },
    {
      name: "ask is one question, parked as the thread's pending question",
      outcome: { kind: "ask" },
      expect: { chat: { cell: "question" }, typed: { cell: "question" } },
    },
    {
      name: "an unresolvable write — a write-class call the deployment cannot run as typed — is the parked question with the best guess from what exists, never a read standing in (issue 2088)",
      outcome: { kind: "unresolvable_write" },
      expect: { chat: { cell: "question" }, typed: { cell: "question" } },
    },
    {
      name: "a typed registry line runs as typed — it never enters the loop and is never re-spelled",
      outcome: { kind: "typed_line" },
      expect: { chat: { cell: "run" }, typed: { cell: "run" } },
    },
    {
      name: "a steer into an owned thread runs as admission's fold under the owner rule",
      outcome: { kind: "steer_owned" },
      expect: { chat: { cell: "run" }, typed: { cell: "run" } },
    },
    {
      name: "a refusal comes only from the policy table and names its row",
      outcome: { kind: "policy_refusal" },
      expect: { chat: { cell: "refuse", names: "policy_row" }, typed: { cell: "refuse", names: "policy_row" } },
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      for (const surface of surfaces) {
        expect(decideExecution(row.outcome, surface)).toEqual(row.expect[surface]);
      }
    });
  }

  it("every turn outcome × surface pair returns a cell — the table is total", () => {
    const outcomes: TurnOutcome[] = [
      { kind: "run_command", confirm: "below", mintable: true },
      { kind: "run_command", confirm: "below", mintable: false },
      { kind: "run_command", confirm: "at_or_above", mintable: true },
      { kind: "run_command", confirm: "at_or_above", mintable: false },
      { kind: "bind_preset" },
      { kind: "ask" },
      { kind: "unresolvable_write" },
      { kind: "typed_line" },
      { kind: "steer_owned" },
      { kind: "policy_refusal" },
    ];
    const cells = new Set<string>();
    for (const outcome of outcomes) {
      for (const surface of surfaces) {
        const cell = decideExecution(outcome, surface);
        expect(["run", "click", "route", "question", "refuse"]).toContain(cell.cell);
        cells.add(cell.cell);
      }
    }
    // The table reaches all five cells: no cell is dead vocabulary.
    expect([...cells].sort()).toEqual(["click", "question", "refuse", "route", "run"]);
  });

  it("an unknown turn outcome refuses to compile — and throws at the runtime boundary", () => {
    // The compile-time guarantee is the `never` parameter of the table's
    // unreachable arm; this run proves the runtime boundary matches it.
    expect(() => decideExecution({ kind: "unknown_tool" } as unknown as TurnOutcome, "chat")).toThrow(
      /no cell for turn outcome/,
    );
  });
});

// The retirement unit's tree assertion (record 0069's plan): the hand-back
// prefix survives only where a TYPED surface names the line to type. The scan
// walks every production module under src/core/dispatch and src/channels and
// holds the prefix's render sites to the named files — a new render site is a
// failing name here before it is a defect in a thread.
describe("no chat render emits the hand-back prefix", () => {
  const roots = ["src/core/dispatch", "src/channels"];
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".vue")) && !e.name.endsWith(".test.ts"))
      .map((e) => join(e.parentPath, e.name));
  const files = roots.flatMap(sources);

  it("the scan sees the tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("the prefix and its renderer are referenced only where typed surfaces name lines in refusals", () => {
    // handBack.ts defines both; route.ts and operator.ts render them on the
    // table's `refuse → typed_form` cell alone — never on a chat surface.
    const allowed = new Set(
      ["src/core/dispatch/handBack.ts", "src/core/dispatch/route.ts", "src/core/dispatch/operator.ts"].map((p) =>
        join(...p.split("/")),
      ),
    );
    const hits = files.filter((f) => /HAND_BACK_PREFIX|renderHandBackLine|To run this:/.test(readFileSync(f, "utf8")));
    expect(hits.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("the cut note and the paste machinery are gone", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/HAND_BACK_CUT_NOTE|pastedRoute|handBackRunId/);
      expect(text, f).not.toMatch(/"pasted"/);
    }
  });

  it("the web bundle no longer parses the prefix — the composer fills from the click row", () => {
    const web = sources(join("web", "src"));
    expect(web.length).toBeGreaterThan(5);
    for (const f of web) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/HAND_BACK_PREFIX|To run this:/);
    }
  });
});
