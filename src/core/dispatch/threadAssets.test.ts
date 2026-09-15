import { describe, expect, it, vi } from "vitest";
import type { ListRunsOptions, ListRunsResult, RunView } from "../runsService.js";
import type { RunEvent } from "../runEvents.js";
import {
  describeAsset,
  readThreadAssets,
  THREAD_ASSETS_PAGE,
  threadAssetsOf,
  type ThreadAsset,
} from "./threadAssets.js";

// execution.md item 20 (record 0033): the thread's files — received and
// produced — read once from every run's record: the runs paged past one page,
// every page of every run (a steer's file lands wherever in the log the steer
// did), the store asked once per key whether it still holds the object.

const run = (over: Partial<RunView> & { id: string }): RunView => ({
  startedAt: 1_000,
  finished: true,
  eventCount: 0,
  ...over,
});

describe("readThreadAssets — the thread's files from its runs' records, held or not", () => {
  const artifact = (direction: "in" | "out", key: string, name: string, seq?: number): RunEvent => {
    const common = { type: "artifact" as const, key, name, size: 10, ...(seq !== undefined ? { seq } : {}) };
    return direction === "in"
      ? { ...common, direction, contentType: "video/mp4", messageId: "m1" }
      : { ...common, direction, contentType: "image/png", callId: "c1" };
  };
  const filler = (n: number): RunEvent[] =>
    Array.from({ length: n }, (_, i) => ({ type: "assistant", text: `step ${i}` }) as RunEvent);
  /** A runs service over `byRun` (oldest first): runs listed newest first in pages of `runsPerPage`
   *  by cursor, events in pages of `pageSize` with `nextAfterSeq` while more follow. */
  const paged = (byRun: Record<string, RunEvent[]>, pageSize: number, runsPerPage = THREAD_ASSETS_PAGE) => {
    const reads: Array<{ id: string; afterSeq?: number }> = [];
    const lists: ListRunsOptions[] = [];
    const ids = Object.keys(byRun).reverse();
    const listRuns = vi.fn(async (opts: ListRunsOptions): Promise<ListRunsResult> => {
      lists.push(opts);
      const from = opts.before !== undefined ? ids.indexOf(String(opts.beforeId)) + 1 : 0;
      const slice = ids.slice(from, from + runsPerPage);
      const runs = slice.map((id) => run({ id, finishedAt: 5_000 - ids.indexOf(id) }));
      const last = slice[slice.length - 1];
      return {
        runs,
        ...(from + slice.length < ids.length && last !== undefined
          ? { nextBefore: { finishedAt: 5_000 - ids.indexOf(last), id: last } }
          : {}),
      };
    });
    const getRunEvents = vi.fn(async (id: string, opts: { afterSeq?: number }) => {
      reads.push({ id, ...(opts.afterSeq !== undefined ? { afterSeq: opts.afterSeq } : {}) });
      const all = byRun[id];
      if (!all) return { ok: false as const, error: "not_found" as const };
      const from = opts.afterSeq ?? 0;
      const events = all.slice(from, from + pageSize);
      const end = from + events.length;
      return { ok: true as const, value: { events, ...(end < all.length ? { nextAfterSeq: end } : {}) } };
    });
    return { listRuns, getRunEvents, reads, lists };
  };
  /** A store holding exactly `held`; a key in `broken` throws. */
  const storeOf = (held: string[], broken: string[] = []) => ({
    head: vi.fn(async (key: string) => {
      if (broken.includes(key)) throw new Error("r2 down");
      return held.includes(key) ? { size: 10, contentType: "video/mp4" } : null;
    }),
  });

  it("pages the thread's runs past one page and every record to its end; `in` and `out` events, oldest run first, one entry per key owned by the run that first named it; the store is asked once per key", async () => {
    // Eleven runs — more than the seed's page of eight and more than one page of two here.
    const byRun: Record<string, RunEvent[]> = {};
    byRun.r01 = [artifact("in", "threads/t/in/1/1-a.mp4", "a.mp4", 3), ...filler(30)];
    for (let i = 2; i <= 9; i++) byRun[`r0${i}`] = filler(2);
    byRun.r10 = [
      ...filler(45),
      artifact("in", "threads/t/in/9/1-late.mp4", "late.mp4"),
      artifact("in", "threads/t/in/1/1-a.mp4", "a.mp4"),
    ];
    byRun.r11 = [artifact("out", "runs/r11/out/1-sheet.png", "sheet.png", 7)];
    const svc = paged(byRun, 10, 2);
    const store = storeOf(["threads/t/in/1/1-a.mp4", "runs/r11/out/1-sheet.png"]);
    const found = await readThreadAssets({ runs: svc, store }, "slack:C1:1.0");
    expect(found).toEqual<ThreadAsset[]>([
      {
        key: "threads/t/in/1/1-a.mp4",
        name: "a.mp4",
        size: 10,
        contentType: "video/mp4",
        direction: "in",
        runId: "r01",
        seq: 3,
        held: true,
      },
      {
        key: "threads/t/in/9/1-late.mp4",
        name: "late.mp4",
        size: 10,
        contentType: "video/mp4",
        direction: "in",
        runId: "r10",
        held: false,
      },
      {
        key: "runs/r11/out/1-sheet.png",
        name: "sheet.png",
        size: 10,
        contentType: "image/png",
        direction: "out",
        runId: "r11",
        seq: 7,
        held: true,
      },
    ]);
    // Eleven runs served in pages of two: six list calls, the first without a cursor, each next carrying the last row's cursor.
    expect(svc.lists).toHaveLength(6);
    expect(svc.lists[0]).toEqual({
      status: "all",
      visibleTo: { kind: "all" },
      threadKey: "slack:C1:1.0",
      limit: THREAD_ASSETS_PAGE,
    });
    expect(svc.lists[1]).toMatchObject({ before: 4_999, beforeId: "r10" });
    // r01: 31 events in 4 pages; r10: 47 events in 5 pages — every page read, none capped; oldest run read first.
    expect(svc.reads.filter((r) => r.id === "r01")).toHaveLength(4);
    expect(svc.reads.filter((r) => r.id === "r10")).toHaveLength(5);
    expect(svc.reads[0]).toEqual({ id: "r01" });
    expect(store.head).toHaveBeenCalledTimes(3);
  });

  it("a run list that fails part-way keeps the runs listed so far; a refused or thrown events page stops that run's read with what was read; a store that cannot be asked leaves `held` unknown — each with a warning naming it, and the other files still count", async () => {
    const warnings: string[] = [];
    const byRun = {
      first: [artifact("in", "threads/t/in/1/1-a.mp4", "a.mp4"), ...filler(15)],
      second: [artifact("in", "threads/t/in/2/1-b.mp4", "b.mp4")],
    };
    const svc = paged(byRun, 10);
    const store = storeOf(["threads/t/in/1/1-a.mp4"], ["threads/t/in/2/1-b.mp4"]);
    const found = await readThreadAssets({ runs: svc, store }, "slack:C1:1.0", (line) => void warnings.push(line));
    expect(found.map((a) => [a.key, a.held])).toEqual([
      ["threads/t/in/1/1-a.mp4", true],
      ["threads/t/in/2/1-b.mp4", undefined],
    ]);
    expect(warnings).toEqual([
      "[thread] threads/t/in/2/1-b.mp4: the store could not be asked whether it holds it — r2 down",
    ]);

    const refused = paged({ first: byRun.first }, 10);
    refused.listRuns.mockResolvedValueOnce({ runs: [run({ id: "gone" }), run({ id: "first" })] });
    const w2: string[] = [];
    const found2 = await readThreadAssets({ runs: refused, store }, "slack:C1:1.0", (line) => void w2.push(line));
    expect(found2.map((a) => a.key)).toEqual(["threads/t/in/1/1-a.mp4"]);
    expect(w2).toEqual(["[thread] gone: reading its files stopped after 0 event(s) — not_found"]);

    const listing = paged(byRun, 10, 1);
    listing.listRuns.mockImplementationOnce(async () => {
      throw new Error("store down");
    });
    const w3: string[] = [];
    expect(await readThreadAssets({ runs: listing, store }, "slack:C1:1.0", (line) => void w3.push(line))).toEqual([]);
    expect(w3).toEqual(["[thread] slack:C1:1.0: listing its runs for their files stopped after 0 run(s) — store down"]);
    const throwing = {
      listRuns: listing.listRuns,
      getRunEvents: vi.fn(async () => {
        throw new Error("events down");
      }),
    };
    const w4: string[] = [];
    expect(await readThreadAssets({ runs: throwing, store }, "slack:C1:1.0", (line) => void w4.push(line))).toEqual([]);
    expect(w4[0]).toBe("[thread] first: reading its files failed after 0 event(s) — events down");
  });

  it("a run list the store could not serve — live rows only, no throw — is the catalogue of those rows, with a warning naming the thread; no further page is asked for", async () => {
    const byRun = {
      finished: [artifact("in", "threads/t/in/1/1-a.mp4", "a.mp4")],
      live: [artifact("out", "runs/live/out/1-sheet.png", "sheet.png")],
    };
    const svc = paged(byRun, 10);
    svc.listRuns.mockResolvedValueOnce({
      runs: [run({ id: "live", finished: false })],
      storeUnavailable: true,
      nextBefore: { finishedAt: 1, id: "live" },
    });
    const warnings: string[] = [];
    const found = await readThreadAssets(
      { runs: svc, store: storeOf(["runs/live/out/1-sheet.png"]) },
      "slack:C1:1.0",
      (line) => void warnings.push(line),
    );
    expect(found.map((a) => a.key)).toEqual(["runs/live/out/1-sheet.png"]);
    expect(svc.listRuns).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      "[thread] slack:C1:1.0: listing its runs for their files answered live rows only after 1 run(s) — the run store was unavailable",
    ]);
  });

  it("threadAssetsOf is the pure catalogue; describeAsset says what a file is and where it is for this run, the same words the prompt and recall use", () => {
    const a: ThreadAsset = {
      key: "threads/t/in/1/1-a.mp4",
      name: "a.mp4",
      size: 312_000_000,
      contentType: "video/mp4",
      direction: "in",
      runId: "r1",
      held: true,
    };
    const o: ThreadAsset = {
      key: "runs/r2/out/1-sheet.png",
      name: "sheet.png",
      size: 5_000,
      contentType: "image/png",
      direction: "out",
      runId: "r2",
      held: true,
    };
    expect(
      threadAssetsOf([
        { id: "r1", events: [artifact("in", a.key, "a.mp4")] },
        { id: "r2", events: [artifact("in", a.key, "a.mp4"), artifact("out", o.key, "sheet.png")] },
      ]).map((x) => [x.key, x.runId]),
    ).toEqual([
      [a.key, "r1"],
      [o.key, "r2"],
    ]);
    expect(threadAssetsOf([])).toEqual([]);
    expect(describeAsset(a, "attachments/2-a.mp4")).toBe(
      "a.mp4 (312 MB, video/mp4) — received on this thread; in this workspace at ./attachments/2-a.mp4",
    );
    expect(describeAsset(a, undefined)).toBe(
      "a.mp4 (312 MB, video/mp4) — received on this thread; in the store, not in this workspace",
    );
    expect(describeAsset({ ...a, held: false }, undefined)).toBe(
      "a.mp4 (312 MB, video/mp4) — received on this thread; no longer in the store (its retention passed)",
    );
    expect(describeAsset({ ...a, held: undefined }, undefined)).toBe(
      "a.mp4 (312 MB, video/mp4) — received on this thread; the store could not be asked whether it still holds it",
    );
    expect(describeAsset(o, undefined)).toBe(
      "sheet.png (5 KB, image/png) — produced by run r2; on that run's page, not in this workspace",
    );
  });
});
