import { describe, expect, it } from "vitest";
import { RunRegistry } from "../runRegistry.js";
import { isRunRecord, type RunRecord } from "../runRecord.js";
import {
  assembleRunRecord,
  interruptedRunRecord,
  reclaimedRunRecord,
  registerFinishRecord,
  writeAbandonedRunRecords,
  writeTombstone,
  type RecordDeps,
} from "./record.js";
import type { LiveRunRow } from "../runLedger/types.js";
import type { ResolvedRequest } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { analyzeRunFriction } from "../runFriction.js";
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
      profile: declaredProfile(agent),
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
      profile: { preset: "general", machine: "none", identity: "none", minutes: 5 },
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
      profile: declaredProfile(agent),
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

// docs/reference/specs/agent-ship.md item 14, run-history.md item 2 — the handoff
// a coding child submitted rides the record, redacted by the one assembly every
// run goes through; a run that submitted none carries no key at all.
describe("assembleRunRecord — the handoff on the record", () => {
  const msg = { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0" };
  const base = () => ({
    run: { id: "run-h" },
    snap: null,
    msg,
    channelVisibility: "unknown" as const,
    finishedAt: 10,
    status: "completed" as const,
    diagnosis: analyzeRunFriction([], { finished: true, truncated: false }),
  });

  it("carries the handoff with every string leaf redacted, and the record still validates", () => {
    const token = `ghp_${"a".repeat(24)}`;
    const record = assembleRunRecord({
      ...base(),
      handoff: {
        deviations: [{ from: `used ${token}`, to: "b", why: "c" }],
        followUps: [],
        unproven: [{ criterion: "k", why: `see ${token}` }],
      },
    });
    expect(record.handoff).toEqual({
      deviations: [{ from: "used «redacted-github-token»", to: "b", why: "c" }],
      followUps: [],
      unproven: [{ criterion: "k", why: "see «redacted-github-token»" }],
    });
    expect(isRunRecord(record)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record)))).toBe(true);
  });

  it("no handoff → no key (the record's JSON is exactly what the store measures)", () => {
    const record = assembleRunRecord(base());
    expect("handoff" in record).toBe(false);
    expect("profile" in record).toBe(false);
  });

  // docs/reference/specs/run-history.md: the effective profile the run was
  // admitted with rides the record — the preset named, so a reader can tell a
  // clipped budget from a declared one.
  it("carries the run's effective profile with its preset, and the record still validates", () => {
    const record = assembleRunRecord({
      ...base(),
      profile: { preset: "coding", machine: "repo-resident", identity: "write", minutes: 10, boundedBy: "channel" },
    });
    expect(record.profile).toEqual({
      preset: "coding",
      machine: "repo-resident",
      identity: "write",
      minutes: 10,
      boundedBy: "channel",
    });
    expect(isRunRecord(record)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record)))).toBe(true);
  });

  // docs/reference/specs/run-history.md item 46: a spawned child's record names
  // the run that started it; every other record carries no key.
  it("carries parentRunId for a spawned child, and the record still validates; no parent → no key", () => {
    const child = assembleRunRecord({ ...base(), parentRunId: "run-parent" });
    expect(child.parentRunId).toBe("run-parent");
    expect(isRunRecord(child)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(child)))).toBe(true);
    expect("parentRunId" in assembleRunRecord(base())).toBe(false);
  });

  it("the drain deadline's interrupted record carries the parent the registry row names (a child abandoned mid-flight still points at its parent)", () => {
    const registry = new RunRegistry({ genId: () => "run-child", genToken: () => "tok", now: () => 1000 });
    const run = registry.create("research · child", {
      agent: "research",
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:2.0",
      parentRunId: "run-parent",
    });
    const record = interruptedRunRecord(registry.getById(run.id)!, registry.snapshotById(run.id)!, 5000);
    expect(record).toMatchObject({ id: "run-child", status: "interrupted", parentRunId: "run-parent" });
    expect(isRunRecord(record)).toBe(true);
  });

  // docs/reference/specs/run-history.md item 48: a coordinator's child names its
  // instance and its spawn's key on every record the one assembly writes — the
  // finish, the drain's interrupted record from the registry row, the reclaim's
  // close from the ledger row — and a run with no coordinator carries neither.
  it("carries the coordinator tag (parentInstanceId, idempotencyKey) for a coordinator's child, validates, and omits both keys without one", () => {
    const tag = { parentInstanceId: "ship_acme_1", idempotencyKey: "ship_acme_1:u12/0/coding" };
    const child = assembleRunRecord({ ...base(), coordinator: tag });
    expect(child).toMatchObject(tag);
    expect(isRunRecord(child)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(child)))).toBe(true);
    const plain = assembleRunRecord(base());
    expect("parentInstanceId" in plain).toBe(false);
    expect("idempotencyKey" in plain).toBe(false);
  });

  it("the drain deadline's interrupted record carries the coordinator tag the registry row names", () => {
    const registry = new RunRegistry({ genId: () => "run-child", genToken: () => "tok", now: () => 1000 });
    const run = registry.create("coding · child", {
      agent: "coding",
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:2.0",
      parentInstanceId: "ship_acme_1",
      idempotencyKey: "ship_acme_1:u12/0/coding",
    });
    const record = interruptedRunRecord(registry.getById(run.id)!, registry.snapshotById(run.id)!, 5000);
    expect(record).toMatchObject({
      status: "interrupted",
      parentInstanceId: "ship_acme_1",
      idempotencyKey: "ship_acme_1:u12/0/coding",
    });
    expect(isRunRecord(record)).toBe(true);
  });

  it("the reclaim's close carries the coordinator tag the ledger row's meta names, so the state Worker's finish still sends the parent its event", () => {
    const row: LiveRunRow = {
      runId: "run-child",
      threadKey: "slack:CX:2.0",
      ownerGen: "gen-NEW",
      leaseUntil: 9_000,
      startedAt: 1_000,
      phase: "live",
      stop: null,
      meta: {
        agent: "coding",
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:2.0",
        parentInstanceId: "ship_acme_1",
        idempotencyKey: "ship_acme_1:u12/0/coding",
      },
      card: null,
      system: "sys",
      tools: [],
      state: {},
    };
    const record = reclaimedRunRecord({ row, events: [], status: "interrupted", finishedAt: 5_000 });
    expect(record).toMatchObject({
      id: "run-child",
      status: "interrupted",
      parentInstanceId: "ship_acme_1",
      idempotencyKey: "ship_acme_1:u12/0/coding",
    });
    expect(isRunRecord(record)).toBe(true);
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
      profile: { machine: "none", identity: "none", minutes: 3, boundedBy: "channel" },
      resolved,
      msg,
      channelVisibility: "unknown",
      repoCtx: { repo: "acme/api" },
      finishedAt: snap.finishedAt!,
      status: "completed",
      diagnosis: analyzeRunFriction(snap.events, { finished: true, truncated: false }),
      root: trace.root,
      ledgerRun: undefined,
      handoff: { deviations: [], followUps: [{ what: "split the file", where: "src/x.ts" }], unproven: [] },
    });
    return { ending, writes };
  }

  it("the handoff the run loop captured rides the finish record", () => {
    const { ending, writes } = finished();
    ending.drain(true);
    expect(writes).toHaveLength(1);
    // So does the effective profile, with its preset and the clip it ran under.
    expect(writes[0].record.profile).toEqual({
      preset: "general",
      machine: "none",
      identity: "none",
      minutes: 3,
      boundedBy: "channel",
    });
    expect(writes[0].record.handoff).toEqual({
      deviations: [],
      followUps: [{ what: "split the file", where: "src/x.ts" }],
      unproven: [],
    });
  });

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
