import { describe, expect, it } from "vitest";
import { RunRegistry } from "../runRegistry.js";
import { isRunRecord, type RunRecord } from "../runRecord.js";
import { interruptedRunRecord, writeAbandonedRunRecords } from "./record.js";

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
      { write: (record, opts) => void writes.push({ record, opts }) },
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
