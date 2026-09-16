import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { harnessDrivers } from "./testing/drivers.js";
import {
  assertReadsRecord,
  buildHarnessConformanceMatrix,
  renderHarnessConformanceMatrix,
  runRow,
  SCENARIOS,
  type DrivenRun,
  type HarnessDriver,
  type ScenarioRow,
} from "./testing/scenarios.js";

// Feature: docs/reference/specs/harness.md item 11 — the conformance table.
// Record 0038's six clauses and the parity rows as one table of scenarios, each
// a function of a `HarnessDriver`, run against every harness the tree has
// through `describe.each`; a row that asserts nothing on the run events or the
// ledger steps is refused by the lint; the matrix the PR body carries is the
// suite's own. pi's driver runs the real bridge, mirror, relay and gate over
// the fake container and the scripted double.

const drivers = harnessDrivers();

describe.each(drivers.map((d) => [d.harness, d] as const))("conformance — %s", (_name, driver) => {
  for (const row of SCENARIOS) {
    it(`${row.clause}: ${row.title}`, async () => {
      await runRow(driver, row);
    });
  }
});

describe("the table", () => {
  it("holds the six clauses, each with at least one row, and the parity rows; every id is unique", () => {
    const clauses = new Set(SCENARIOS.map((r) => r.clause));
    for (const c of ["credential", "gate", "relay", "record", "conversation", "survival", "parity"])
      expect(clauses.has(c as ScenarioRow["clause"]), c).toBe(true);
    expect(new Set(SCENARIOS.map((r) => r.id)).size).toBe(SCENARIOS.length);
  });

  it("the lint: a row whose check reads neither the run events nor the ledger steps is refused by name, and one that reads either passes it", async () => {
    // A driver that answers a run of nothing, so only the check's reads decide.
    const empty: DrivenRun = {
      harness: "pi",
      outcome: { kind: "answered", answer: "ok" },
      events: [],
      steps: [],
      facts: [],
      progress: [],
      starts: [],
      killed: [],
      requests: [],
      modelCalls: [],
      statusReports: [],
    };
    const driver: HarnessDriver = { ...drivers[0], run: async () => empty };
    const blind: ScenarioRow = {
      id: "blind-row",
      clause: "gate",
      title: "asserts on the answer alone",
      script: { turns: [] },
      check: (run) => assert.equal(run.outcome.kind, "answered"),
    };
    await expect(runRow(driver, blind)).rejects.toThrow(/row blind-row asserts nothing on the record/);
    const sighted: ScenarioRow = { ...blind, id: "sighted-row", check: (run) => assert.deepEqual(run.events, []) };
    await expect(runRow(driver, sighted)).resolves.toEqual({ reads: new Set(["events"]) });
    expect(() => assertReadsRecord({ id: "x" }, new Set(["steps"]))).not.toThrow();
    expect(() => assertReadsRecord({ id: "x" }, new Set(["facts", "outcome"]))).toThrow(/neither events nor steps/);
  });

  it("the matrix prints every harness × row, pi green on every row, and a harness without a driver as absent", async () => {
    const columns = await buildHarnessConformanceMatrix(drivers);
    expect(columns.map((c) => c.harness)).toEqual(["pi"]);
    expect(Object.values(columns[0].rows).every((o) => o === "pass")).toBe(true);
    expect(Object.keys(columns[0].rows)).toEqual(SCENARIOS.map((r) => r.id));
    const rendered = renderHarnessConformanceMatrix(columns, ["pi", "opencode"]);
    const lines = rendered.split("\n");
    expect(lines[0]).toContain(`${SCENARIOS.length} rows × 2 harness(es)`);
    expect(lines[2]).toBe("| Clause | Row | pi | opencode |");
    const body = lines.slice(4).filter((l) => l.startsWith("|"));
    expect(body).toHaveLength(SCENARIOS.length);
    for (const line of body) expect(line.endsWith("| ✅ | — |")).toBe(true);
  });
});
