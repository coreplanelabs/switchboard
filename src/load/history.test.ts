import { describe, expect, it } from "vitest";
import { durationStats, pageAll, peakConcurrency, realRuns } from "./history.js";

// `load:history` (docs/reference/specs/load-harness.md item 4): the production baseline the
// plan quotes (peak 8 concurrent runs) must be reproducible from the run
// store. The math is a sweep-line over [startedAt, finishedAt) intervals.

const run = (id: string, startedAt: number, finishedAt: number) => ({ id, startedAt, finishedAt });

describe("realRuns — provisional tombstones are not runs", () => {
  it("drops rows whose finishedAt equals startedAt (the start-of-run tombstone) and keeps the rest", () => {
    expect(realRuns([run("a", 10, 10), run("b", 10, 20)]).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("peakConcurrency — sweep-line", () => {
  it("three overlapping runs peak at 3, at the moment the third starts", () => {
    const { peak, at } = peakConcurrency([run("a", 0, 100), run("b", 10, 90), run("c", 20, 30)]);
    expect(peak).toBe(3);
    expect(at).toBe(20);
  });

  it("a run finishing exactly when another starts does not overlap it (half-open intervals)", () => {
    expect(peakConcurrency([run("a", 0, 10), run("b", 10, 20)]).peak).toBe(1);
  });

  it("reports the per-day peak keyed by UTC date", () => {
    const day1 = Date.UTC(2026, 8, 4, 0, 50);
    const day2 = Date.UTC(2026, 8, 7, 12, 0);
    const { perDay } = peakConcurrency([
      run("a", day1, day1 + 60_000),
      run("b", day1 + 1_000, day1 + 30_000),
      run("c", day2, day2 + 1_000),
    ]);
    expect(perDay).toEqual({ "2026-09-04": 2, "2026-09-07": 1 });
  });

  it("no runs → peak 0 and no timestamp", () => {
    expect(peakConcurrency([])).toEqual({ peak: 0, at: undefined, perDay: {} });
  });
});

describe("durationStats", () => {
  it("reports count, mean and percentiles in seconds", () => {
    const stats = durationStats([run("a", 0, 100_000), run("b", 0, 200_000), run("c", 0, 300_000)]);
    expect(stats).toEqual({ count: 3, meanS: 200, p50S: 200, p90S: 300, p99S: 300, maxS: 300 });
  });
});

describe("pageAll — cursor paging over the run store's list route", () => {
  it("follows the (finishedAt, id) cursor until a short page, and never fetches past maxPages", async () => {
    const calls: Array<{ before?: number; beforeId?: string } | undefined> = [];
    const pages = [[run("c", 0, 30), run("b", 0, 20)], [run("a", 0, 10)]];
    const items = await pageAll(
      async (cursor) => {
        calls.push(cursor);
        return pages.shift() ?? [];
      },
      { pageSize: 2, maxPages: 10 },
    );
    expect(items.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(calls).toEqual([undefined, { before: 20, beforeId: "b" }]);
  });

  it("stops at maxPages even when every page is full", async () => {
    let n = 0;
    const items = await pageAll(
      async () => {
        n++;
        return [run(`x${n}`, 0, 100 - n), run(`y${n}`, 0, 100 - n)];
      },
      { pageSize: 2, maxPages: 3 },
    );
    expect(n).toBe(3);
    expect(items).toHaveLength(6);
  });

  it("stops paging once maxItems rows have been accumulated and trims to exactly that count", async () => {
    let fetchCount = 0;
    // Each page returns 3 items; with maxItems=4, the second fetch completes
    // the limit (3+3=6 ≥ 4) and paging stops — no third fetch.
    const items = await pageAll(
      async () => {
        fetchCount++;
        const base = (fetchCount - 1) * 3;
        return [run(`r${base}`, 0, 100 - base), run(`r${base + 1}`, 0, 99 - base), run(`r${base + 2}`, 0, 98 - base)];
      },
      { pageSize: 3, maxPages: 10, maxItems: 4 },
    );
    expect(items).toHaveLength(4);
    expect(fetchCount).toBe(2);
  });

  it("with maxItems=0 (default unlimited), reads all pages as before", async () => {
    let n = 0;
    const items = await pageAll(
      async () => {
        n++;
        if (n <= 3) return [run(`r${n}`, 0, 100 - n)];
        return []; // short page — stops naturally
      },
      { pageSize: 1, maxPages: 10, maxItems: 0 },
    );
    // pageAll stops on an empty page; 3 pages of 1 item each = 3 items
    expect(items).toHaveLength(3);
    expect(n).toBe(4); // 4th call returned [] (short page), triggered break
  });
});
