import { describe, expect, it } from "vitest";
import type { PlaneTable } from "../core/plane/table.js";
import type { RunView } from "../core/runsService.js";
import { planeShowTool, type PlaneReadCapability } from "./plane.js";
import type { ToolContext } from "./runnableTool.js";

// Feature: docs/reference/specs/orchestration-plane.md item 12 (record 0070,
// criterion 3) — the orchestrator preset's fleet reads come from the plane's
// tables, never from the model's context: `plane_show` answers the SAME rows
// `plane show` and the /plane panels carry, so the answer can cite the row it
// read, and without the capability the tool says the tables are unavailable
// instead of letting the model recall.

const NOW = Date.parse("2026-09-19T03:00:00Z");
const MIN = 60_000;

function view(over: Partial<RunView> & { id: string }): RunView {
  return { startedAt: NOW - 12 * MIN, finished: false, eventCount: 3, agent: "coding", ...over };
}

const TABLE: PlaneTable = {
  at: NOW,
  runs: [
    {
      run: view({ id: "11111111-aaaa", userId: "slack:U_ALICE", userName: "alice" }),
      owner: { id: "slack:U_ALICE", name: "alice" },
      unit: { key: "plan-x:U12", id: "U12", title: "The table" },
      health: [],
    },
  ],
  units: [
    {
      unit: {
        unit: "plan-x:U12",
        instanceId: "plan-x",
        id: "U12",
        title: "The table",
        branch: "plan/x/u12",
        threads: {},
        sourceUrls: {},
        rounds: [],
        pr: { number: 10041, url: "u" },
      },
      instance: { id: "plan-x", repo: "acme/api", createdAt: NOW - 60 * MIN },
      health: ["live"],
    },
  ],
  pullRequests: [
    {
      pr: { repo: "acme/api", number: 10041, state: "open", checks: { total: 1, pending: ["ci / bot"], failed: [] } },
      owner: { unitKey: "plan-x:U12" },
      health: ["pending"],
    },
  ],
  windows: [],
  findings: [],
};

const ctxWith = (cap: PlaneReadCapability | undefined): ToolContext =>
  ({
    executor: {} as ToolContext["executor"],
    ...(cap ? { plane: cap } : {}),
  }) as ToolContext;

describe("plane_show — the orchestrator preset answers a fleet question from the tables (record 0070)", () => {
  it("a fleet question is answered with a cited row: the result carries the plane's own rows — the run, the unit and the pull request the answer cites", async () => {
    let asked = 0;
    const result = await planeShowTool.run(
      {},
      ctxWith({
        table: async () => {
          asked += 1;
          return TABLE;
        },
      }),
    );
    expect(asked).toBe(1);
    const text = result as string;
    // The same rows the /plane panel paints and `plane show` prints: the run's
    // short id, the unit's key and the pull request's name are all citable.
    expect(text).toContain("11111111");
    expect(text).toContain("plan-x:U12");
    expect(text).toContain("acme/api#10041");
    expect(text).toContain("Plane · 1 live");
  });

  it("without the capability the tool refuses to recall: it names the tables unavailable instead of answering from memory", async () => {
    const result = await planeShowTool.run({}, ctxWith(undefined));
    expect(result).toContain("not available");
    expect(result).toContain("instead of answering the question from memory");
  });
});
