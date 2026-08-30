import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRunFriction } from "./core/runFriction.js";
import { loadFrictionRecords, parseProposeArgs } from "./frictionProposeCli.js";

// Feature: features/self-improvement.md — the CLI trigger of the proposer: run
// the cluster → propose → dedupe → file step over SAVED run material (friction
// JSON from `/runs/:id/friction`, ledger JSONL, or raw event captures) without a
// bot process. Dry-run by default; `--file` is the only way anything is opened.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "friction-propose-"));
  dirs.push(d);
  return d;
}

describe("parseProposeArgs", () => {
  it("collects sources and flags; dry-run unless --file", () => {
    expect(parseProposeArgs(["a.json", "captures/", "--repo", "o/r", "--top=2", "--min-runs", "3", "--label", "x", "--json"])).toEqual({
      sources: ["a.json", "captures/"],
      repo: "o/r",
      label: "x",
      top: 2,
      minRuns: 3,
      file: false,
      json: true,
    });
    expect(parseProposeArgs(["a.json", "--file", "--repo", "o/r"])).toMatchObject({ file: true, repo: "o/r" });
  });

  it("refuses to file without a repo, rejects unknown flags and bad numbers, needs a source", () => {
    expect(() => parseProposeArgs(["a.json", "--file"])).toThrow(/--repo/);
    expect(() => parseProposeArgs(["a.json", "--file", "--repo", "not-a-slug"])).toThrow(/owner\/name/);
    expect(() => parseProposeArgs(["a.json", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseProposeArgs(["a.json", "--top", "0"])).toThrow(/--top/);
    expect(() => parseProposeArgs([])).toThrow(/source/);
  });
});

describe("loadFrictionRecords", () => {
  const diag = analyzeRunFriction([
    { type: "tool_call", tool: "bash", summary: "$ npm test", at: 0 },
    { type: "tool_result", tool: "bash", ok: false, summary: "boom", at: 500 },
  ]);

  it("reads a `/runs/:id/friction` JSON capture (id + diagnosis), taking the finish time from the file", () => {
    const dir = tmp();
    const p = join(dir, "run-abc.json");
    writeFileSync(p, JSON.stringify({ id: "abc", finished: true, diagnosis: diag }));
    const { records, skipped } = loadFrictionRecords([p], { mtime: () => 1234 });
    expect(skipped).toEqual([]);
    expect(records).toEqual([{ runId: "abc", finishedAt: 1234, diagnosis: diag }]);
  });

  it("reads ledger JSONL (one FrictionRunRecord per line) and raw event captures (JSONL or SSE)", () => {
    const dir = tmp();
    const ledger = join(dir, "friction.jsonl");
    writeFileSync(
      ledger,
      [
        JSON.stringify({ runId: "l1", label: "coding · o/r", agent: "coding", finishedAt: 10, diagnosis: diag }),
        "garbage",
        JSON.stringify({ runId: "l2", finishedAt: 20, diagnosis: diag }),
      ].join("\n"),
    );
    const events = join(dir, "events.sse");
    writeFileSync(
      events,
      [
        'data: {"type":"tool_call","tool":"bash","summary":"$ npm test","at":0}',
        'data: {"type":"tool_result","tool":"bash","ok":false,"summary":"boom","at":500}',
        "event: end",
        "data: {}",
      ].join("\n"),
    );
    const { records, skipped } = loadFrictionRecords([ledger, events], { mtime: () => 99 });
    expect(skipped).toEqual([]);
    expect(records.map((r) => r.runId)).toEqual(["l1", "l2", "events"]);
    expect(records[0].label).toBe("coding · o/r");
    expect(records[2]).toEqual({ runId: "events", finishedAt: 99, diagnosis: diag });
  });

  it("expands a directory to its files, skips unreadable/unrecognized ones by name, and dedupes run ids", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "same", diagnosis: diag }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ id: "same", diagnosis: diag })); // the same run captured twice
    writeFileSync(join(dir, "notes.txt"), "just prose\n");
    writeFileSync(join(dir, "empty.json"), "");
    const { records, skipped } = loadFrictionRecords([dir], { mtime: () => 1 });
    expect(records.map((r) => r.runId)).toEqual(["same"]);
    expect(skipped.sort()).toEqual([join(dir, "empty.json"), join(dir, "notes.txt")]);
    expect(loadFrictionRecords([join(dir, "missing.json")]).skipped).toEqual([join(dir, "missing.json")]);
  });

  it("rejects RunRecord-shaped input (run history, field `id` + `events`) by name with a clear reason — as a document and as JSONL", () => {
    const dir = tmp();
    const runRecord = {
      id: "run1",
      channelId: "slack:C1",
      userId: "slack:U1",
      threadKey: "slack:C1:1",
      startedAt: 1,
      finishedAt: 2,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: diag,
    };
    writeFileSync(join(dir, "history.json"), JSON.stringify(runRecord));
    writeFileSync(join(dir, "history.jsonl"), `${JSON.stringify({ ...runRecord, id: "run2" })}\n${JSON.stringify(runRecord)}\n`);
    const { records, skipped, reasons } = loadFrictionRecords([dir], { mtime: () => 1 });
    expect(records).toEqual([]);
    expect(skipped.sort()).toEqual([join(dir, "history.json"), join(dir, "history.jsonl")]);
    for (const p of skipped) expect(reasons[p]).toMatch(/run-history RunRecord/);
  });
});
