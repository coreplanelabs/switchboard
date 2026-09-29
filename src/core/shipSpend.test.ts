import { describe, expect, it } from "vitest";
import { buildShipSpendReport } from "./shipSpend.js";
import type { ShipRunUsage } from "./runUsage.js";

const range = { from: "1999-09-28", to: "1999-09-29", days: 2, partialLastDay: true };
const usage = (usd: number | null) => ({
  turns: 1,
  byModel: {
    "openai/gpt-6-sol": {
      turns: 1,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd,
    },
  },
});
const run = (id: string, at: string, dollars: number | null, cap = 50): ShipRunUsage => ({
  id,
  unitKey: "plan-demo-1:U12",
  finishedAt: Date.parse(at),
  costCapUsd: cap,
  usage: usage(dollars),
});

describe("buildShipSpendReport", () => {
  it("orders individual run dollars by finish and adds them against the admitted unit cap", () => {
    const report = buildShipSpendReport(
      [
        run("second", "1999-09-29T03:00:00Z", 17),
        run("first", "1999-09-28T22:00:00Z", 12),
        run("outside", "1999-09-27T22:00:00Z", 9),
      ],
      range,
    );
    expect(report.units).toEqual([
      {
        key: "plan-demo-1:U12",
        capUsd: 50,
        totalUsd: 29,
        runs: [
          { id: "first", finishedAt: Date.parse("1999-09-28T22:00:00Z"), usd: 12, cumulativeUsd: 12 },
          { id: "second", finishedAt: Date.parse("1999-09-29T03:00:00Z"), usd: 17, cumulativeUsd: 29 },
        ],
      },
    ]);
  });

  it("keeps unknown spend unknown and never invents a cap for older or inconsistent children", () => {
    const unpriced = buildShipSpendReport(
      [
        run("first", "1999-09-28T22:00:00Z", 12),
        run("unknown", "1999-09-29T01:00:00Z", null),
        run("last", "1999-09-29T03:00:00Z", 2),
      ],
      range,
    ).units[0]!;
    expect(unpriced.runs.map((r) => [r.usd, r.cumulativeUsd])).toEqual([
      [12, 12],
      [null, null],
      [2, null],
    ]);
    expect(unpriced.totalUsd).toBeNull();
    expect(
      buildShipSpendReport([run("a", "1999-09-28T22:00:00Z", 1, 50), run("b", "1999-09-29T03:00:00Z", 1, 25)], range)
        .units[0]?.capUsd,
    ).toBeNull();
  });

  it("counts a zero-turn child as known zero without poisoning later totals", () => {
    const zero = run("zero", "1999-09-28T22:00:00Z", 0);
    zero.usage = { turns: 0, byModel: {} };
    const report = buildShipSpendReport([zero, run("later", "1999-09-29T03:00:00Z", 2)], range);
    expect(report.units[0]).toMatchObject({
      totalUsd: 2,
      runs: [
        { id: "zero", usd: 0, cumulativeUsd: 0 },
        { id: "later", usd: 2, cumulativeUsd: 2 },
      ],
    });
  });

  it("does not reprice a child whose recorded model dollars are missing", () => {
    const old = run("old", "1999-09-29T03:00:00Z", 2);
    delete old.usage!.byModel["openai/gpt-6-sol"]!.usd;
    expect(buildShipSpendReport([old], range).units[0]).toMatchObject({
      capUsd: 50,
      totalUsd: null,
      runs: [{ id: "old", usd: null, cumulativeUsd: null }],
    });
  });
});
