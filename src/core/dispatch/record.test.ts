import { describe, expect, it } from "vitest";
import { RunRegistry } from "../runRegistry.js";
import { isRunRecord, type RunRecord } from "../runRecord.js";
import {
  interruptedRunRecord,
  registerFinishRecord,
  writeAbandonedRunRecords,
  writeTombstone,
  type RecordDeps,
} from "./record.js";
import type { ResolvedRequest } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { analyzeRunFriction } from "../runFriction.js";
import { SPAN_SCHEMA } from "../normalizeSpans.js";
import type { ResumeContext } from "./admission.js";

// Feature: docs/reference/specs/run-history.md — the records the drain deadline
// writes for the runs it abandons: `interruptedRunRecord` is the seam (one
// run's full snapshot as an `interrupted` record) and `writeAbandonedRunRecords`
// the pass over every unfinished registry run. The records a finished run and
// an inline command run assemble are proven through `dispatch()` in
// `src/core/dispatcher.test.ts` (`run history write path`).
describe("the drain deadline's records", () => {
  it("interruptedRunRecord (the drain deadline's seam) builds a full-snapshot interrupted record from a live run's summary + snapshot", () => {
    const registry = new RunRegistry({ genId: () => "run-d", genToken: () => "tok" });
    const run = registry.create("coding · acme/x", {
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:t",
      repo: "acme/x",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      userName: "alice",
    });
    registry.publish(run.id, { type: "input", text: "go", at: 1 });
    for (let i = 1; i <= 3; i++) registry.publish(run.id, { type: "tool_call", tool: "bash", summary: `$ step ${i}` });
    const summary = registry.getById(run.id)!;
    const snap = registry.snapshotById(run.id)!;
    const rec = interruptedRunRecord(summary, snap, 1_234_567);
    expect(rec).toMatchObject({
      id: "run-d",
      status: "interrupted",
      finishedAt: 1_234_567,
      startedAt: snap.startedAt,
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:t",
      repo: "acme/x",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      userName: "alice",
      eventCount: 4,
      storedEventCount: 4,
      truncated: false,
    });
    expect(rec.events).toEqual(snap.events); // ALL events published so far — the full-transcript upgrade
    expect(rec.label).toBe("coding · acme/x");
    expect(isRunRecord(rec)).toBe(true);
  });

  it("writeAbandonedRunRecords (the drain deadline's pass) writes one PROVISIONAL full-snapshot interrupted record per unfinished run, skips finished ones, returns the count", () => {
    const ids = ["run-live", "run-done"];
    const registry = new RunRegistry({ genId: () => ids.shift() ?? "run-x", genToken: () => "tok" });
    const live = registry.create("coding · acme/x", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:t",
    });
    registry.publish(live.id, { type: "input", text: "go", at: 1 });
    registry.publish(live.id, { type: "tool_call", tool: "bash", summary: "$ npm test" });
    const done = registry.create("review · acme/y", {
      agent: "review",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:u",
    });
    registry.finish(done.id, "completed");
    const writes: Array<{ record: RunRecord; opts: { provisional?: boolean } | undefined }> = [];
    const lines: string[] = [];
    const n = writeAbandonedRunRecords(
      registry,
      { write: (record: RunRecord, opts?: { provisional?: boolean }) => void writes.push({ record, opts }) },
      1_234_567,
      (line) => lines.push(line),
    );
    expect(n).toBe(1);
    expect(writes).toHaveLength(1);
    const only = writes[0];
    // Provisional: the persisted dot means "finished and durably stored" —
    // an abandoned run never finished — and a provisional write stands down if
    // the run's real finish record shows up inside the drain's write budget.
    expect(only.opts).toEqual({ provisional: true });
    expect(only.record).toMatchObject({ id: live.id, status: "interrupted", finishedAt: 1_234_567 });
    expect(only.record.events).toEqual(registry.snapshotById(live.id)!.events); // the FULL snapshot, not the start tombstone
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(live.id);
    expect(lines[0]).toContain("2 events");
  });
});

// The tombstone and the finish record (docs/reference/specs/run-history.md items 20–22,
// 42): what the run stage hands the record stage at the loop's start and end.
describe("writeTombstone — the provisional interrupted record at the loop's start", () => {
  const agent = getAgent("general");
  const resolved = { agentName: "general", modelRef: "anthropic/general-model" } as ResolvedRequest;
  const msg = { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0", text: "hello" };

  it("a fresh run writes one provisional record: interrupted, finishedAt = startedAt, the events so far", () => {
    const registry = new RunRegistry({ genId: () => "run-t", genToken: () => "tok" });
    const run = registry.create("general · #CX · UX", {
      agent: "general",
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
    });
    registry.publish(run.id, { type: "input", text: "hello", at: 1 });
    const writes: Array<{ record: RunRecord; opts: { provisional?: boolean } | undefined }> = [];
    const deps: RecordDeps = {
      runHistoryWriter: {
        write: (record: RunRecord, opts?: { provisional?: boolean }) => void writes.push({ record, opts }),
      } as never,
    };
    writeTombstone(deps, {
      msg,
      agent,
      resolved,
      repoCtx: {},
      channelVisibility: "unknown",
      run,
      registry,
      resume: undefined,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].opts).toEqual({ provisional: true });
    expect(writes[0].record).toMatchObject({
      id: "run-t",
      status: "interrupted",
      agent: "general",
      model: "anthropic/general-model",
    });
    expect(writes[0].record.finishedAt).toBe(writes[0].record.startedAt);
    expect(writes[0].record.events.map((e) => e.type)).toEqual(["input"]);
  });

  it("a resume writes nothing: its record is the ledger's", () => {
    const registry = new RunRegistry({ genId: () => "run-t", genToken: () => "tok" });
    const run = registry.create("general", {
      agent: "general",
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
    });
    const writes: unknown[] = [];
    const deps: RecordDeps = { runHistoryWriter: { write: (r: unknown) => void writes.push(r) } as never };
    writeTombstone(deps, {
      msg,
      agent,
      resolved,
      repoCtx: {},
      channelVisibility: "unknown",
      run,
      registry,
      resume: {} as ResumeContext,
    });
    expect(writes).toEqual([]);
  });
});

describe("registerFinishRecord — the finish record, written by the drain after the reply", () => {
  const agent = getAgent("general");
  const resolved = { agentName: "general", modelRef: "anthropic/general-model" } as ResolvedRequest;
  const msg = { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0", text: "hello" };

  function finished() {
    const registry = new RunRegistry({ genId: () => "run-f", genToken: () => "tok" });
    const run = registry.create("general", {
      agent: "general",
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
    });
    registry.publish(run.id, { type: "answer", text: "done", at: 2 });
    registry.finish(run.id, "completed");
    const snap = registry.snapshot(run.id, run.token)!;
    const ending = createRunEnding({ registry });
    ending.finished(run.id);
    const writes: Array<{ record: RunRecord; opts: unknown }> = [];
    const deps: RecordDeps = {
      runHistoryWriter: {
        write: (record: RunRecord, opts?: { provisional?: boolean }) => void writes.push({ record, opts }),
      } as never,
    };
    const trace = startRequestRoot({ clock: () => 5 }, { channel: channelOf("slack:CX"), receivedAt: 1 });
    registerFinishRecord(deps, {
      ending,
      run,
      snap,
      agent,
      resolved,
      msg,
      channelVisibility: "unknown",
      repoCtx: { repo: "acme/api" },
      finishedAt: snap.finishedAt!,
      status: "completed",
      diagnosis: analyzeRunFriction(snap.events, { finished: true, truncated: false, schema: SPAN_SCHEMA }),
      root: trace.root,
      ledgerRun: undefined,
    });
    return { ending, writes };
  }

  it("nothing is written until the drain; then the record carries the seal's stamps and the terminal status", () => {
    const { ending, writes } = finished();
    expect(writes).toEqual([]);
    ending.drain(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].record).toMatchObject({ id: "run-f", status: "completed", repo: "acme/api", replyOk: true });
    expect(isRunRecord(writes[0].record)).toBe(true);
  });

  it("a reply that threw after the loop completed flips the record to failed: the thread never saw the answer", async () => {
    const { ending, writes } = finished();
    await expect(
      ending.sealAfterReply(
        async () => {},
        async () => {
          throw new Error("channel down");
        },
      ),
    ).rejects.toThrow("channel down");
    expect(writes).toHaveLength(1);
    expect(writes[0].record).toMatchObject({ status: "failed", replyOk: false });
  });
});
