import { planContextCheckpoint } from "./references/contextCheckpoint.js";
import { contextDependenciesHash } from "./references/contextDependencies.js";
import { storeRequestWitness } from "./storeResponse.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "./references/contextDependencies.js";
import { testSessionSources } from "./testing/slackSources.js";
import { describe, expect, it } from "vitest";
import { secretsFrom } from "../secrets.js";
import type { ChatMessage } from "./chatMessage.js";
import { buildRunLedger, WorkerRunLedger, type WorkerRunLedgerOptions } from "./runLedgerWorker.js";
import { createLedgerWriteThrough } from "./runLedger/writeThrough.js";
import { pointOf } from "./runMetrics.js";
import { ATTACHMENT_REF_BYTES, LEASE_MS, type ClaimRequest, type IntakeReceipt } from "./runLedger/types.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "./runStoreWorker.js";

// The Worker client (docs/reference/specs/run-history.md item 28): routes, bodies, the
// step write's order (transcript before record), fenced answers as results,
// and the same error classes as the run store.

function stubWorker(
  answer: (path: string, body: Record<string, unknown>) => { status: number; data?: unknown } = () => ({
    status: 200,
    data: { ok: true },
  }),
  opts: Partial<WorkerRunLedgerOptions> = {},
) {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    const a = answer(url.pathname, body);
    return new Response(a.data === undefined ? "" : JSON.stringify(a.data), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  };
  const ledger = new WorkerRunLedger({
    baseUrl: "https://memory.test/",
    token: "tok",
    storeKey: "runs:default",
    fetch: fetchImpl,
    ...opts,
  });
  return { ledger, calls };
}

/** A finished record as `finish` posts one — minimal but whole enough for the
 *  point the client computes beside it (`pointOf`). */
const finishRecord = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1.0",
    startedAt: 1_000,
    finishedAt: 2_000,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: { eventCount: 0, toolCalls: 0, byCategory: {}, findings: [], verdict: "ok" },
    ...over,
  }) as unknown as import("./runRecord.js").RunRecord;

const claimReq: ClaimRequest = {
  runId: "r1",
  threadKey: "slack:C1:1.0",
  gen: "g1",
  leaseMs: LEASE_MS,
  startedAt: 1_000,
  meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1.0" },
  system: "s",
  tools: [],
};

describe("durable ledger acknowledgement continuity", () => {
  const aborted = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException("body interrupted", "AbortError"));
        },
      }),
      { status: 200 },
    );
  it("preserves a read body interruption as an availability error with its cause", async () => {
    const ledger = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "tok",
      storeKey: "runs:default",
      fetch: async () => aborted(),
    });
    await expect(ledger.listLive()).rejects.toMatchObject({
      name: "TransientStoreError",
      cause: { name: "AbortError" },
    });
  });
  it("keeps a committed inbox append with a lost body unknown without a second append", async () => {
    let commits = 0;
    const ledger = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "tok",
      storeKey: "runs:default",
      fetch: async () => {
        commits++;
        return aborted();
      },
    });
    await expect(ledger.pushInbox("r1", { text: "original" })).rejects.toMatchObject({
      name: "UncertainStoreError",
      outcome: "unknown",
    });
    expect(commits).toBe(1);
  });
  it("never acknowledges state from HTTP success with a contradictory refusal body", async () => {
    const { ledger } = stubWorker(() => ({ status: 200, data: { ok: false, reason: "fenced" } }));
    await expect(ledger.setState("r1", "g1", {})).rejects.toMatchObject({
      name: "UncertainStoreError",
      outcome: "unknown",
    });
  });
});

describe("WorkerRunLedger", () => {
  it("reads and acknowledges only an exact retained workspace version and rejects ambiguous responses", async () => {
    const owner = { runId: "r1", ownerGen: "g1", ownerFence: 7 };
    const settlement = {
      version: 1,
      revision: 2,
      owner,
      binding: {
        backend: "resident",
        ref: "codex/r1",
        workspace: "/workspace/threads/t/r1",
        user: "worker2",
        container: "vm-1",
        ownerGen: "g1",
        ownerFence: 7,
      },
      record: { id: "r1", threadKey: "slack:C1:1.0", userId: "slack:UALICE", status: "completed" },
      publication: { version: 1, branches: [], complete: true },
    };
    const current = stubWorker((path) => ({
      status: 200,
      data: path === "/runs/preservation-owner" ? { kind: "terminal", settlement } : { ok: true },
    }));
    expect(await current.ledger.workspaceSettlement(owner)).toEqual(settlement);
    expect(await current.ledger.ackWorkspaceSettlement(owner, 2)).toEqual({ ok: true });
    expect(current.calls).toMatchObject([
      { path: "/runs/preservation-owner", body: { storeKey: "runs:default", ...owner }, auth: "Bearer tok" },
      { path: "/runs/workspace-ack", body: { storeKey: "runs:default", ...owner, revision: 2 }, auth: "Bearer tok" },
    ]);
    for (const kind of ["live", "unknown"])
      expect(
        await stubWorker(() => ({ status: 200, data: { kind } })).ledger.workspaceSettlement(owner),
      ).toBeUndefined();
    expect(
      await stubWorker(() => ({
        status: 200,
        data: { kind: "acknowledged", owner, revision: 2 },
      })).ledger.workspaceSettlement(owner),
    ).toBeUndefined();
    await expect(
      stubWorker(() => ({
        status: 200,
        data: { kind: "acknowledged", owner: { ...owner, ownerFence: 8 }, revision: 2 },
      })).ledger.workspaceSettlement(owner),
    ).rejects.toBeInstanceOf(PermanentStoreError);
    expect(
      await stubWorker(() => ({ status: 200, data: { kind: "absent", owner } })).ledger.workspaceSettlement(owner),
    ).toBeUndefined();
    await expect(
      stubWorker(() => ({
        status: 200,
        data: { kind: "absent", owner: { ...owner, ownerFence: 8 } },
      })).ledger.workspaceSettlement(owner),
    ).rejects.toBeInstanceOf(PermanentStoreError);
    for (const reason of ["owner-live", "stale", "unverified"])
      expect(
        await stubWorker(() => ({ status: 409, data: { ok: false, reason } })).ledger.ackWorkspaceSettlement(owner, 2),
      ).toEqual({ ok: false, reason });
    await expect(
      stubWorker(() => ({
        status: 200,
        data: { kind: "terminal", settlement: { ...settlement, owner: { ...owner, ownerFence: 8 } } },
      })).ledger.workspaceSettlement(owner),
    ).rejects.toBeInstanceOf(PermanentStoreError);
    await expect(
      stubWorker(() => ({ status: 200, data: {} })).ledger.ackWorkspaceSettlement(owner, 2),
    ).rejects.toBeInstanceOf(PermanentStoreError);
    await expect(
      stubWorker(() => ({ status: 200, data: { ok: true } })).ledger.ackWorkspaceSettlement(owner, 0),
    ).rejects.toBeInstanceOf(PermanentStoreError);
    await expect(stubWorker(() => ({ status: 503 })).ledger.workspaceSettlement(owner)).rejects.toBeInstanceOf(
      TransientStoreError,
    );
  });
  it("reads one frozen keyed entry without substituting transcript tail or malformed rows", async () => {
    const rows = [{ idx: 9, part: 0, json: '{"role":"assistant","part":{"type":"text","text":"original"}}' }];
    const current = stubWorker((_path, body) => ({
      status: 200,
      data: { rows: body.rowId === "saved" ? rows : null },
    }));
    expect(await current.ledger.readSessionEntry("slack:C1:1.0:@thread", "saved")).toEqual(rows);
    expect(current.calls[0]).toMatchObject({
      path: "/runs/session/entry",
      body: { key: "slack:C1:1.0:@thread", rowId: "saved" },
    });
    expect(await current.ledger.readSessionEntry("slack:C1:1.0:@thread", "missing")).toBeUndefined();
    const malformed = stubWorker(() => ({ status: 200, data: { rows: [{ json: "wrong" }] } }));
    expect(await malformed.ledger.readSessionEntry("slack:C1:1.0:@thread", "saved")).toBeUndefined();
  });

  it("requires the thread append's atomic context acknowledgment from the memory worker", async () => {
    const rows = [{ part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "request" } }) }];
    const old = stubWorker(() => ({ status: 200, data: { ok: true, appended: true } }));
    expect(await old.ledger.appendSession("slack:C1:1.0:@thread", "event", rows, UNKNOWN_CONTEXT_DEPENDENCIES)).toEqual(
      { ok: false, appended: true },
    );
    const current = stubWorker(() => ({ status: 200, data: { ok: true, appended: true, contextSaved: true } }));
    expect(
      await current.ledger.appendSession("slack:C1:1.0:@thread", "event", rows, UNKNOWN_CONTEXT_DEPENDENCIES),
    ).toEqual({ ok: true, appended: true });
    expect(current.calls[0].body).toMatchObject({ storeKey: "runs:default", context: UNKNOWN_CONTEXT_DEPENDENCIES });
  });
  it("requires explicit source metadata acknowledgment from the memory worker", async () => {
    const sources = testSessionSources({ channelId: "slack:D1", threadKey: "slack:D1:1.0", userId: "slack:UALICE" });
    const old = stubWorker();
    expect(await old.ledger.writeSessionSources("slack:D1:1.0:orchestrator", "r1", "g1", sources)).toEqual({
      ok: false,
      reason: "fenced",
    });
    const current = stubWorker(() => ({ status: 200, data: { ok: true, sourcesSaved: true } }));
    expect(await current.ledger.writeSessionSources("slack:D1:1.0:orchestrator", "r1", "g1", sources)).toEqual({
      ok: true,
    });
    expect(current.calls[0].body).toMatchObject({
      storeKey: "runs:default",
      key: "slack:D1:1.0:orchestrator",
      sourceRunId: "r1",
      gen: "g1",
      sources,
    });
  });
  it("requests a resident fence for the ledger owner and reports stale claims", async () => {
    const w = stubWorker((path) =>
      path === "/runs/resident-claim"
        ? { status: 200, data: { ok: true, fence: 4 } }
        : { status: 200, data: { ok: true } },
    );
    expect(await w.ledger.residentClaim("r1", "g1", "slack:C1:1.0")).toEqual({ ok: true, fence: 4 });
    expect(w.calls[0]).toMatchObject({
      path: "/runs/resident-claim",
      body: { storeKey: "runs:default", runId: "r1", gen: "g1", threadKey: "slack:C1:1.0" },
    });
    const stale = stubWorker(() => ({ status: 409, data: { ok: false, reason: "fenced" } }));
    expect(await stale.ledger.residentClaim("r1", "g0", "slack:C1:1.0")).toEqual({ ok: false, reason: "fenced" });
  });
  it("claim posts the run under the store key with the bearer and nothing else — a run's transcript object is never owned; a 409 thread-live is a result", async () => {
    const w = stubWorker();
    expect(await w.ledger.claim(claimReq)).toEqual({ ok: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/claim"]);
    expect(w.calls[0].auth).toBe("Bearer tok");
    expect(w.calls[0].body).toEqual({ storeKey: "runs:default", run: claimReq });

    const busy = stubWorker(() => ({
      status: 409,
      data: { ok: false, reason: "thread-live", live: { runId: "r0", agent: "coding", startedAt: 5 } },
    }));
    expect(await busy.ledger.claim(claimReq)).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r0", agent: "coding", startedAt: 5 },
    });
    expect(busy.calls).toHaveLength(1);
  });

  it("step writes the transcript turns FIRST (chunked rows, attachments one per request), then the step record; a fenced transcript write stops before the record", async () => {
    const w = stubWorker();
    const big: ChatMessage = {
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: "Z".repeat(ATTACHMENT_REF_BYTES + 1) }],
    };
    const assistant: ChatMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const record = {
      step: 1,
      seq: 3,
      turnIndex: 2,
      inFlight: [],
      inboxConsumedSeq: 0,
      remainingMs: 1,
      turn: 1,
      iteration: 1,
    };
    expect(
      await w.ledger.step("r1", "g1", record, [
        { idx: 0, message: big },
        { idx: 1, message: assistant },
      ]),
    ).toEqual({ ok: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/transcript/write", "/runs/transcript/write", "/runs/step"]);
    expect((w.calls[0].body.attachments as unknown[]).length).toBe(1);
    expect((w.calls[0].body.rows as unknown[]).length).toBe(0);
    expect((w.calls[1].body.rows as unknown[]).length).toBe(2);
    expect(w.calls[2].body).toEqual({ storeKey: "runs:default", runId: "r1", gen: "g1", record });

    const fenced = stubWorker((path) =>
      path === "/runs/transcript/write"
        ? { status: 409, data: { ok: false, reason: "fenced" } }
        : { status: 200, data: { ok: true } },
    );
    expect(await fenced.ledger.step("r1", "g1", record, [{ idx: 0, message: assistant }])).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(fenced.calls.map((c) => c.path)).toEqual(["/runs/transcript/write"]);
  });

  it("heartbeat returns the stop and phase the Worker answers; a 409 is fenced or unknown-run by the Worker's reason", async () => {
    const w = stubWorker(() => ({ status: 200, data: { ok: true, stop: "soft", phase: "live" } }));
    // An older Worker's answer has no effects field: read as none offered (orchestration-plane item 7).
    expect(await w.ledger.heartbeat("r1", "g1", LEASE_MS)).toEqual({
      ok: true,
      stop: "soft",
      phase: "live",
      effects: [],
    });
    const unknown = stubWorker(() => ({ status: 409, data: { ok: false, reason: "unknown-run" } }));
    expect(await unknown.ledger.heartbeat("r1", "g1", LEASE_MS)).toEqual({ ok: false, reason: "unknown-run" });
  });

  it("keeps live-state refusals precise through the Worker transport and write-through", async () => {
    const assignment = { expectedSeq: 7, at: 1_000, state: "admitted" as const, bound: 2_000, resumeSegment: true };
    for (const reason of [
      "stale-sequence",
      "invalid-transition",
      "terminal",
      "bound-required",
      "invalid-bound",
      "cause-required",
      "fenced",
      "unknown-run",
    ] as const) {
      const status = reason === "fenced" || reason === "unknown-run" ? 409 : 400;
      const w = stubWorker((path) =>
        path === "/runs/live-state" ? { status, data: { ok: false, reason } } : { status: 200, data: { ok: true } },
      );
      expect(await w.ledger.assignLiveState("r1", "g1", assignment)).toEqual({ ok: false, reason });
      const wt = createLedgerWriteThrough({
        ledger: w.ledger,
        gen: "g1",
        fallback: { put: async () => ({}), abandoned: () => {} },
        warn: () => {},
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      const reserved = await wt.reserve({
        runId: "r1",
        threadKey: "slack:C1:1.0",
        startedAt: 1_000,
        meta: claimReq.meta,
      });
      expect(reserved.kind).toBe("tracked");
      if (reserved.kind !== "tracked") continue;
      expect(await reserved.run.assignLiveState(assignment)).toEqual({ ok: false, reason });
      expect(reserved.run.tracked()).toBe(reason !== "fenced" && reason !== "unknown-run");
    }
  });

  it("accepts a complete live-state commit acknowledgement", async () => {
    const committed = {
      ok: true,
      liveState: { state: "admitted", since: 1_000, bound: 2_000 },
      liveStateSeq: 8,
      event: { type: "run_state", state: "admitted", since: 1_000, bound: 2_000, seq: 8 },
    };
    const w = stubWorker(() => ({ status: 200, data: committed }));
    expect(
      await w.ledger.assignLiveState("r1", "g1", {
        expectedSeq: 7,
        at: 1_000,
        state: "admitted",
        bound: 2_000,
        resumeSegment: true,
      }),
    ).toEqual(committed);
  });

  it("does not mistake an unverified live-state acknowledgement for an unknown run", async () => {
    const assignment = { expectedSeq: 7, at: 1_000, state: "admitted" as const, bound: 2_000, resumeSegment: true };
    for (const answer of [
      { status: 400, data: { ok: false, reason: "made-up" } },
      { status: 400, data: { ok: true, reason: "terminal" } },
      { status: 400, data: { error: "bad request" } },
      { status: 409, data: { ok: false, reason: "terminal" } },
      { status: 200, data: { ok: false, reason: "terminal" } },
      { status: 200, data: { ok: true } },
      { status: 503, data: { error: "unavailable" } },
    ]) {
      const w = stubWorker((path) => (path === "/runs/live-state" ? answer : { status: 200, data: { ok: true } }));
      const wt = createLedgerWriteThrough({
        ledger: w.ledger,
        gen: "g1",
        fallback: { put: async () => ({}), abandoned: () => {} },
        warn: () => {},
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      const reserved = await wt.reserve({
        runId: "r1",
        threadKey: "slack:C1:1.0",
        startedAt: 1_000,
        meta: claimReq.meta,
      });
      expect(reserved.kind).toBe("tracked");
      if (reserved.kind !== "tracked") continue;
      expect(await reserved.run.assignLiveState(assignment)).toEqual({ ok: false, reason: "unavailable" });
      expect(reserved.run.tracked()).toBe(true);
      expect(w.calls.filter((call) => call.path === "/runs/live-state")).toHaveLength(1);
    }
  });

  it("planeFenceSteer asks the object to atomically renew ownership before local delivery", async () => {
    const w = stubWorker(() => ({ status: 200, data: { accepted: true } }));
    await expect(w.ledger.planeFenceSteer("steer:r1:7", "r1", "g1", LEASE_MS)).resolves.toBe(true);
    expect(w.calls).toEqual([
      {
        path: "/plane/steer/fence",
        auth: "Bearer tok",
        body: {
          storeKey: "runs:default",
          id: "steer:r1:7",
          runId: "r1",
          gen: "g1",
          leaseMs: LEASE_MS,
        },
      },
    ]);
  });

  it("planeAck carries the authoritative owner fence for a steer", async () => {
    const w = stubWorker();
    await w.ledger.planeAck("steer:r1:7", "done", { runId: "r1", gen: "g1" });
    expect(w.calls).toEqual([
      {
        path: "/plane/ack",
        auth: "Bearer tok",
        body: {
          storeKey: "runs:default",
          id: "steer:r1:7",
          outcome: "done",
          owner: { runId: "r1", gen: "g1" },
        },
      },
    ]);
  });

  it("requires an exact confirmed reconciliation acknowledgement and carries only its typed durable receipts", async () => {
    const owner = {
      instanceId: "instance",
      unit: "ONE",
      attempt: 0,
      requester: "cli:user",
      channelId: "cli:main",
      threadKey: "cli:main:1",
      deliveryId: "report",
    };
    const receipt = {
      reportDelivery: { version: 1 as const, owner, proposalHash: "a".repeat(64) },
      status: { ...owner, destinationThreadKey: owner.threadKey, repo: "acme/api", snapshotHash: "b".repeat(64) },
    };
    const confirmed = stubWorker();
    await confirmed.ledger.planeAck("coordinator-reconcile:" + "c".repeat(64), "done", undefined, receipt);
    expect(confirmed.calls[0]?.body.reconciliation).toEqual(receipt);
    for (const answer of [
      { status: 409, data: { ok: false } },
      { status: 200, data: { ok: false } },
    ]) {
      const unavailable = stubWorker(() => answer);
      await expect(
        unavailable.ledger.planeAck("coordinator-reconcile:" + "c".repeat(64), "done", undefined, receipt),
      ).rejects.toBeInstanceOf(TransientStoreError);
    }
    await expect(
      confirmed.ledger.planeAck("coordinator-reconcile:" + "c".repeat(64), "skipped", undefined, receipt),
    ).rejects.toBeInstanceOf(PermanentStoreError);
  });

  it("append with no events posts nothing; finish clears nothing and releases the session's owner best-effort when the record names one; reclaim re-owns a session log for a row with a session and the transcript object for one without", async () => {
    const session = { key: "slack:C1:1.0:review", seedFrom: 0, request: 0, range: { from: 0 } };
    const w = stubWorker((path) =>
      path === "/runs/reclaim"
        ? {
            status: 200,
            data: { runs: [{ row: { runId: "a", meta: { session } } }, { row: { runId: "b", meta: {} } }] },
          }
        : path === "/runs/finish"
          ? { status: 200, data: { ok: true, stored: true } }
          : path === "/runs/session/clear-owner"
            ? { status: 500 }
            : { status: 200, data: { ok: true } },
    );
    expect(await w.ledger.append("r1", "g1", [])).toEqual({ ok: true });
    expect(w.calls).toHaveLength(0);
    const plain = finishRecord();
    expect(await w.ledger.finish("r1", "g1", plain)).toEqual({ ok: true, stored: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/finish"]);
    const withSession = finishRecord({ session: { ...session, range: { from: 0, to: 4 } } });
    expect(await w.ledger.finish("r1", "g1", withSession)).toEqual({ ok: true, stored: true });
    expect(w.calls.slice(1).map((c) => [c.path, c.body.key ?? c.body.runId])).toEqual([
      ["/runs/finish", "r1"],
      ["/runs/session/clear-owner", "slack:C1:1.0:review"],
    ]);
    expect(w.calls[2].body).toEqual({ key: "slack:C1:1.0:review", runId: "r1", gen: "g1" });
    const taken = await w.ledger.reclaim("g2", 10, LEASE_MS);
    expect(taken.map((r) => r.row.runId)).toEqual(["a", "b"]);
    expect(w.calls.slice(3).map((c) => [c.path, c.body.key ?? c.body.runId])).toEqual([
      ["/runs/reclaim", undefined],
      ["/runs/session/owner", "slack:C1:1.0:review"],
      ["/runs/transcript/owner", "b"],
    ]);
    expect(w.calls[4].body).toMatchObject({ key: "slack:C1:1.0:review", runId: "a", gen: "g2" });
  });

  it("the session routes: tail, owner with the configured byte budget, seed and step writes into the log at their indices, a range read re-based to the range, the tail read, release", async () => {
    const rows = [
      { idx: 3, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "go" } }) },
      { idx: 4, part: 0, json: JSON.stringify({ role: "assistant", part: { type: "text", text: "ok" } }) },
    ];
    const w = stubWorker((path) =>
      path === "/runs/session/tail"
        ? { status: 200, data: { next: 3 } }
        : path === "/runs/session/read"
          ? { status: 200, data: { rows, attachments: [] } }
          : path === "/runs/session/read-tail"
            ? { status: 200, data: { rows, attachments: [], from: 3 } }
            : path === "/runs/session/write"
              ? { status: 200, data: { ok: true, bytes: 120 } }
              : { status: 200, data: { ok: true } },
    );
    const key = "slack:C1:1.0:review";
    expect(await w.ledger.sessionTail(key)).toBe(3);
    expect(w.calls[0]).toMatchObject({ path: "/runs/session/tail", body: { key } });
    await w.ledger.claimSession(key, "r1", "g1");
    expect(w.calls[1]).toMatchObject({
      path: "/runs/session/owner",
      body: { key, runId: "r1", gen: "g1", maxBytes: 200 * 1024 * 1024 },
    });
    const go: ChatMessage = { role: "user", content: [{ type: "text", text: "go" }] };
    expect(await w.ledger.seed("r1", "g1", [{ idx: 3, message: go }], key)).toEqual({ ok: true });
    expect(w.calls[2]).toMatchObject({ path: "/runs/session/write", body: { key, gen: "g1", rows: [rows[0]] } });
    expect(
      await w.ledger.step(
        "r1",
        "g1",
        { step: 1, seq: 0, turnIndex: 2, inFlight: [], inboxConsumedSeq: 0, remainingMs: 1, turn: 1, iteration: 0 },
        [{ idx: 4, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }],
        key,
      ),
    ).toEqual({ ok: true });
    expect(w.calls.slice(3).map((c) => c.path)).toEqual(["/runs/session/write", "/runs/step"]);
    const read = await w.ledger.readSession(key, 3, 4);
    expect(w.calls[5]).toMatchObject({ path: "/runs/session/read", body: { key, from: 3, to: 4 } });
    expect(read).toEqual({
      complete: true,
      turns: 2,
      messages: [go, { role: "assistant", content: [{ type: "text", text: "ok" }] }],
      compactions: [],
    });
    const tail = await w.ledger.readSessionTail(key, 240_000);
    expect(w.calls[6]).toMatchObject({ path: "/runs/session/read-tail", body: { key, maxBytes: 240_000 } });
    expect(tail.from).toBe(3);
    expect(tail.transcript.messages).toHaveLength(2);
    expect(await w.ledger.releaseSession(key, "r1", "g1")).toEqual({ ok: true });
    expect(w.calls[7]).toMatchObject({ path: "/runs/session/clear-owner", body: { key, runId: "r1", gen: "g1" } });
    // Without a session the seed still goes to the run's own transcript object (an adopted older row).
    await w.ledger.seed("r1", "g1", [{ idx: 0, message: go }]);
    expect(w.calls[8].path).toBe("/runs/transcript/write");
  });

  // session-log.md item 12: the actor a turn carries rides the stored row's JSON.
  it("a seed turn's actor rides the stored row's JSON; a turn without one stores none", async () => {
    const w = stubWorker(() => ({ status: 200, data: { ok: true } }));
    const key = "slack:C1:1.0:review";
    const go: ChatMessage = { role: "user", content: [{ type: "text", text: "go" }] };
    const ok: ChatMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    expect(
      await w.ledger.seed(
        "r1",
        "g1",
        [
          { idx: 3, message: go, actor: "slack:UALICE" },
          { idx: 4, message: ok },
        ],
        key,
      ),
    ).toEqual({ ok: true });
    const write = w.calls.find((c) => c.path === "/runs/session/write")!;
    const rows = write.body.rows as { idx: number; json: string }[];
    expect(JSON.parse(rows[0].json)).toMatchObject({ role: "user", actor: "slack:UALICE" });
    expect("actor" in JSON.parse(rows[1].json)).toBe(false);
  });

  it("reads and checkpoints the actor-keyed requester target through the session store", async () => {
    const target = {
      repo: "acme/api",
      issue: "acme/api#2430",
      provenance: "Investigate https://github.com/acme/api/issues/2430",
    };
    const w = stubWorker((path) => ({
      status: 200,
      data: path.endsWith("requester-target") ? { target: null } : { target },
    }));
    const key = "slack:C1:1.0:@thread";
    expect(await w.ledger.readRequesterTarget(key, "slack:UALICE")).toBeNull();
    expect(await w.ledger.checkpointRequesterTarget(key, "slack:UALICE", target)).toEqual(target);
    expect(w.calls.map((c) => c.body)).toEqual([
      { key, actor: "slack:UALICE" },
      { key, actor: "slack:UALICE", target },
    ]);
    await expect(
      stubWorker(() => ({ status: 404, data: {} })).ledger.readRequesterTarget(key, "slack:UALICE"),
    ).rejects.toBeInstanceOf(RouteMissingError);
  });

  // session-log.md item 10: the routes `recall` and `notes` read and write through.
  it("the search and notepad routes: search posts the key, query and limit and answers the hits and gaps as sent (nothing when the Worker sends none); the notepad read answers the text and time or null; the notepad write is fenced like a row write", async () => {
    const hits = [{ idx: 4, part: 0, role: "user", kind: "text", text: "fix the lockfile" }];
    const w = stubWorker((path) =>
      path === "/runs/session/search"
        ? { status: 200, data: { hits, gaps: [2] } }
        : path === "/runs/session/notepad"
          ? { status: 200, data: { notepad: { text: "keep the helper", updatedAt: 5_000 } } }
          : path === "/runs/session/notepad/write"
            ? { status: 409, data: { ok: false, reason: "fenced" } }
            : { status: 200, data: {} },
    );
    const key = "slack:C1:1.0:coding";
    expect(await w.ledger.searchSession(key, "lockfile", 5)).toEqual({ hits, gaps: [2] });
    expect(w.calls[0]).toMatchObject({ path: "/runs/session/search", body: { key, query: "lockfile", limit: 5 } });
    expect(await w.ledger.readNotepad(key)).toEqual({ text: "keep the helper", updatedAt: 5_000 });
    expect(w.calls[1]).toMatchObject({ path: "/runs/session/notepad", body: { key } });
    expect(await w.ledger.writeNotepad(key, "g1", "keep the helper")).toEqual({ ok: false, reason: "fenced" });
    expect(w.calls[2]).toMatchObject({
      path: "/runs/session/notepad/write",
      body: { key, gen: "g1", text: "keep the helper" },
    });
    const bare = stubWorker(() => ({ status: 200, data: {} }));
    expect(await bare.ledger.searchSession(key, "lockfile", 5)).toEqual({ hits: [], gaps: [] });
    expect(await bare.ledger.readNotepad(key)).toBeNull();
    await expect(w.ledger.searchSession("has space", "x", 1)).rejects.toBeInstanceOf(PermanentStoreError);
  });

  it("listLive refuses malformed or paginated responses instead of proving an empty ledger", async () => {
    for (const data of [{}, { runs: null }, { runs: [{}] }, { runs: [], nextBefore: { id: "older" } }])
      await expect(stubWorker(() => ({ status: 200, data })).ledger.listLive()).rejects.toBeInstanceOf(
        PermanentStoreError,
      );
    expect(await stubWorker(() => ({ status: 200, data: { runs: [] } })).ledger.listLive()).toEqual([]);
  });

  it("errors: 404 is RouteMissingError, 5xx/429 TransientStoreError, other 4xx PermanentStoreError, a malformed run id never leaves the process", async () => {
    await expect(
      stubWorker(() => ({ status: 404, data: { error: "not found" } })).ledger.listLive(),
    ).rejects.toBeInstanceOf(RouteMissingError);
    await expect(stubWorker(() => ({ status: 503 })).ledger.listLive()).rejects.toBeInstanceOf(TransientStoreError);
    await expect(stubWorker(() => ({ status: 429 })).ledger.listLive()).rejects.toBeInstanceOf(TransientStoreError);
    await expect(stubWorker(() => ({ status: 400, data: { error: "bad" } })).ledger.listLive()).rejects.toBeInstanceOf(
      PermanentStoreError,
    );
    const w = stubWorker();
    await expect(w.ledger.heartbeat("bad id!", "g1", 1)).rejects.toBeInstanceOf(PermanentStoreError);
    expect(w.calls).toHaveLength(0);
  });

  it("readInbox posts the run id and the seq to read past, and returns the Worker's items (item 40)", async () => {
    const items = [{ seq: 3, message: { text: "late" } }];
    const w = stubWorker(() => ({ status: 200, data: { items } }));
    expect(await w.ledger.readInbox("r1", 2)).toEqual(items);
    expect(w.calls.at(-1)).toMatchObject({ path: "/runs/inbox/read", body: { runId: "r1", afterSeq: 2 } });
    const empty = stubWorker(() => ({ status: 200, data: {} }));
    await expect(empty.ledger.readInbox("r1", 0)).rejects.toThrow("invalid observational inbox");
  });

  it("finish posts the record's metrics point beside it, priced through the configured table, and none for a provisional record (run-metrics.md)", async () => {
    const prices = { "anthropic/m": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const w = stubWorker(
      (path) => ({ status: 200, data: path === "/runs/finish" ? { ok: true, stored: true } : { ok: true } }),
      {
        prices,
      },
    );
    const final = finishRecord({
      usage: {
        turns: 2,
        byModel: {
          "anthropic/m": { turns: 2, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    });
    expect(await w.ledger.finish("r1", "g1", final)).toEqual({ ok: true, stored: true });
    expect(w.calls[0].body.point).toEqual(pointOf(final, prices));
    const tombstone = finishRecord({ status: "interrupted", provisional: true, finishedAt: 1_000 });
    await w.ledger.finish("r1", "g1", tombstone);
    expect(w.calls[1].body.point).toBeUndefined();
  });

  it("readTranscript assembles the Worker's rows and attachments", async () => {
    const rows = [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "hi" } }) }];
    const w = stubWorker(() => ({ status: 200, data: { rows, attachments: [] } }));
    expect(await w.ledger.readTranscript("r1")).toEqual({
      complete: true,
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      compactions: [],
    });
  });
});

describe("buildRunLedger — the client for the configured history (run-history item 35)", () => {
  const worker = { baseUrl: "https://memory.example.com" };
  it("is null with history off, on a host-disk store, without a Worker URL, or without the bearer", () => {
    expect(buildRunLedger(undefined, secretsFrom({ MEMORY_TOKEN: "t" }))).toBeNull();
    expect(buildRunLedger({ store: "file", worker }, secretsFrom({ MEMORY_TOKEN: "t" }))).toBeNull();
    expect(buildRunLedger({}, secretsFrom({ MEMORY_TOKEN: "t" }))).toBeNull();
    expect(buildRunLedger({ worker }, secretsFrom({}))).toBeNull();
    expect(buildRunLedger({ worker }, secretsFrom({ MEMORY_TOKEN: "  " }))).toBeNull();
  });

  it("builds a Worker client on the configured URL and bearer env (the default MEMORY_TOKEN or the configured name)", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }) as typeof fetch;
    const byDefault = buildRunLedger({ worker }, secretsFrom({ MEMORY_TOKEN: "tok-a" }), { fetch: fetchImpl });
    expect(byDefault).toBeInstanceOf(WorkerRunLedger);
    await byDefault!.listLive();
    expect(calls.at(-1)).toEqual({ url: "https://memory.example.com/runs/live", auth: "Bearer tok-a" });
    const byName = buildRunLedger(
      { worker: { ...worker, tokenEnv: "LEDGER_TOKEN" } },
      secretsFrom({ LEDGER_TOKEN: "tok-b" }),
      { fetch: fetchImpl },
    );
    await byName!.listLive();
    expect(calls.at(-1)).toEqual({ url: "https://memory.example.com/runs/live", auth: "Bearer tok-b" });
  });

  it("carries the configured session log byte budget onto every session owner claim, clamped like the rest of the policy", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const configured = buildRunLedger(
      { worker, sessionLogMaxBytes: 64 * 1024 * 1024 },
      secretsFrom({ MEMORY_TOKEN: "t" }),
      {
        fetch: fetchImpl,
      },
    );
    await configured!.claimSession("slack:C1:1.0:review", "r1", "g1");
    expect(bodies.at(-1)).toEqual({ key: "slack:C1:1.0:review", runId: "r1", gen: "g1", maxBytes: 64 * 1024 * 1024 });
    const clamped = buildRunLedger({ worker, sessionLogMaxBytes: 1 }, secretsFrom({ MEMORY_TOKEN: "t" }), {
      fetch: fetchImpl,
    });
    await clamped!.claimSession("slack:C1:1.0:review", "r1", "g1");
    expect(bodies.at(-1)).toMatchObject({ maxBytes: 16 * 1024 * 1024 });
  });
});

describe("intake receipts — the routes and the retry (run-history item 59)", () => {
  const receipt = (over: Partial<IntakeReceipt> = {}): IntakeReceipt => ({
    verdict: "silent",
    reason: "answering a colleague",
    source: "model",
    mode: "classify",
    model: "prov/mini",
    gen: 3,
    threadKey: "slack:C1:1.0",
    decidedAt: 5_000,
    ...over,
  });

  it("recordIntake posts the key and receipt under the store key — windowMs only when the client carries one — and answers the insert", async () => {
    const stored = receipt();
    const w = stubWorker(() => ({ status: 200, data: { inserted: true, stored } }));
    expect(await w.ledger.recordIntake("slack:C1:2.0", stored)).toEqual({ inserted: true, stored });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/intake"]);
    expect(w.calls[0].body).toEqual({
      storeKey: "runs:default",
      key: "slack:C1:2.0",
      receipt: stored,
      telemetry: true,
    });

    const windowed = stubWorker(() => ({ status: 200, data: { inserted: true, stored } }), {
      catchUpWindowMs: 1_800_000,
    });
    await windowed.ledger.recordIntake("slack:C1:2.0", stored);
    expect(windowed.calls[0].body).toEqual({
      storeKey: "runs:default",
      key: "slack:C1:2.0",
      receipt: stored,
      windowMs: 1_800_000,
      telemetry: true,
    });
  });

  it("claims and finishes intake delivery through the receipt-keyed routes", async () => {
    const w = stubWorker((path) =>
      path === "/runs/intake/delivery/claim"
        ? { status: 200, data: { claimed: true } }
        : { status: 200, data: { ok: true } },
    );
    expect(await w.ledger.claimIntakeDelivery("slack:C1:2.0", "poster-a", 5_000)).toBe(true);
    await w.ledger.finishIntakeDelivery("slack:C1:2.0", "poster-a", true);
    expect(w.calls).toEqual([
      {
        path: "/runs/intake/delivery/claim",
        auth: "Bearer tok",
        body: { storeKey: "runs:default", key: "slack:C1:2.0", poster: "poster-a", claimedAt: 5_000 },
      },
      {
        path: "/runs/intake/delivery/finish",
        auth: "Bearer tok",
        body: { storeKey: "runs:default", key: "slack:C1:2.0", poster: "poster-a", delivered: true },
      },
    ]);
  });

  it("readIntake answers the row or none; listIntake passes only the filters given and answers the rows", async () => {
    const stored = receipt();
    const w = stubWorker((path) =>
      path === "/runs/intake/read"
        ? { status: 200, data: { receipt: stored } }
        : { status: 200, data: { receipts: [stored] } },
    );
    expect(await w.ledger.readIntake("slack:C1:2.0")).toEqual(stored);
    expect(w.calls[0]).toMatchObject({
      path: "/runs/intake/read",
      body: { storeKey: "runs:default", key: "slack:C1:2.0" },
    });
    expect(await w.ledger.listIntake({ threadKey: "slack:C1:1.0", since: 2_000 })).toEqual([stored]);
    expect(w.calls[1]).toMatchObject({
      path: "/runs/intake/list",
      body: { storeKey: "runs:default", threadKey: "slack:C1:1.0", since: 2_000 },
    });
    await w.ledger.listIntake({});
    expect(w.calls[2].body).toEqual({ storeKey: "runs:default" });

    const none = stubWorker(() => ({ status: 200, data: { receipt: null } }));
    expect(await none.ledger.readIntake("slack:C1:2.0")).toBeUndefined();
  });

  it("the write-through's retry after a lost response reads the same row and answers the stored insert", async () => {
    const rows = new Map<string, IntakeReceipt>();
    const w = stubWorker((path, body) => {
      if (path === "/runs/intake") {
        const key = body.key as string;
        if (!rows.has(key)) rows.set(key, body.receipt as IntakeReceipt); // the insert lands…
        return { status: 503, data: { error: "gateway" } }; // …and the response is lost
      }
      if (path === "/runs/intake/read") {
        return { status: 200, data: { receipt: rows.get(body.key as string) ?? null } };
      }
      return { status: 200, data: { ok: true } };
    });
    const wt = createLedgerWriteThrough({
      ledger: w.ledger,
      gen: "gen-A",
      fallback: { put: async () => ({}), abandoned: () => {} },
      warn: () => {},
      sleep: async () => {},
    });
    expect(await wt.recordIntake("slack:C1:2.0", receipt())).toEqual({ inserted: true, stored: receipt() });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/intake", "/runs/intake/read"]);
  });
});

describe("status and checkpoint mutation acknowledgement custody", () => {
  const statusRequest = { expectedSeq: 0, eventSeq: 1, at: 1000, state: "admitted" as const, bound: 10000 };
  const contextRequest = {
    key: "slack:C1:1.0:review",
    runId: "r1",
    gen: "g1",
    expected: {
      beforeHash: "a".repeat(64),
      revision: 0,
      inputs: { transcriptHash: "b".repeat(64), systemHash: "c".repeat(64), notepadHash: "d".repeat(64) },
    },
  };
  it.each(["status", "context"] as const)(
    "retains original %s bytes for malformed possibly-committed acknowledgements",
    async (kind) => {
      for (const body of [{ ok: true }, { ok: false, reason: "made-up" }, { ok: true, receipt: {} }]) {
        let payload = "",
          path = "",
          writes = 0;
        const ledger = new WorkerRunLedger({
          baseUrl: "https://memory.test",
          token: "tok",
          storeKey: "runs:default",
          fetch: async (url, init) => {
            writes++;
            path = new URL(String(url)).pathname;
            payload = String(init?.body);
            return Response.json(body);
          },
        });
        let caught: unknown;
        try {
          if (kind === "status") await ledger.assignLiveState("r1", "g1", statusRequest);
          else await ledger.normalizeContextOrigins(contextRequest);
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({
          name: "UncertainStoreError",
          outcome: "unknown",
          request: { operation: path, payload },
        });
        expect((caught as { request: { digest: string } }).request.digest).toBe(
          (await storeRequestWitness(path, payload)).digest,
        );
        expect(writes).toBe(1);
      }
    },
  );
  it.each(["status", "context"] as const)("keeps original %s request on a non-JSON successful reply", async (kind) => {
    let payload = "",
      path = "",
      writes = 0;
    const ledger = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "tok",
      storeKey: "runs:default",
      fetch: async (url, init) => {
        writes++;
        path = new URL(String(url)).pathname;
        payload = String(init?.body);
        return new Response("reply interrupted", { status: 200 });
      },
    });
    const mutation =
      kind === "status"
        ? ledger.assignLiveState("r1", "g1", statusRequest)
        : ledger.normalizeContextOrigins(contextRequest);
    let caught: unknown;
    try {
      await mutation;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "UncertainStoreError",
      outcome: "unknown",
      request: { operation: path, payload },
    });
    expect(writes).toBe(1);
    expect(JSON.parse(payload)).toHaveProperty("gen", "g1");
  });
  it.each(["fenced", "unknown-run", "checkpoint-unavailable"] as const)(
    "preserves a known checkpoint refusal: %s",
    async (reason) => {
      const w = stubWorker(() => ({ status: 409, data: { ok: false, reason } }));
      expect(await w.ledger.normalizeContextOrigins(contextRequest)).toEqual({ ok: false, reason });
      expect(w.calls).toHaveLength(1);
    },
  );
});

describe("checkpoint acknowledgment original binding", () => {
  async function original() {
    const context = {
      version: 1 as const,
      status: "known" as const,
      revision: 0,
      origins: [{ runId: "r1", requester: "slack:UA", channelId: "slack:C1", threadKey: "slack:C1:1.0" }],
      slack: [],
      mcp: [],
    };
    const inputs = { transcriptHash: "a".repeat(64), systemHash: "b".repeat(64), notepadHash: "c".repeat(64) };
    const expected = { beforeHash: await contextDependenciesHash(context), revision: 0, inputs };
    const key = "slack:C1:1.0:review";
    const receipt = await planContextCheckpoint({
      run: {
        runId: "r1",
        meta: {
          userId: "slack:UA",
          channelId: "slack:C1",
          threadKey: "slack:C1:1.0",
          channelVisibility: "public",
          session: { key, threadSession: "slack:C1:1.0:@thread", seedFrom: 0, request: 0, range: { from: 0 } },
        },
        context,
      },
      ownerGen: "g1",
      through: 0,
      inputs,
      expected,
      sources: [],
    });
    if (!receipt) throw new Error("actual planned receipt unavailable");
    return { request: { key, runId: "r1", gen: "g1", expected }, receipt };
  }
  it("accepts a matching planned canonical checkpoint receipt", async () => {
    const { request, receipt } = await original();
    const w = stubWorker(() => ({ status: 200, data: { ok: true, receipt } }));
    expect(await w.ledger.normalizeContextOrigins(request)).toEqual({ ok: true, receipt });
    expect(w.calls).toHaveLength(1);
  });
  it("checks a provided local original session without changing the wire request", async () => {
    const { request, receipt } = await original();
    const w = stubWorker(() => ({ status: 200, data: { ok: true, receipt } }));
    expect(await w.ledger.normalizeContextOrigins(request, receipt.session)).toEqual({ ok: true, receipt });
    expect(w.calls[0].body).toEqual({ storeKey: "runs:default", ...request });
  });
  it.each(["key", "seedFrom", "request", "from", "through"] as const)(
    "keeps a receipt outside the captured local %s boundary uncertain",
    async (key) => {
      const { request, receipt } = await original();
      const expected = { ...receipt.session };
      if (key === "key") expected.key = "slack:C1:2.0:review";
      else expected[key]++;
      const w = stubWorker(() => ({ status: 200, data: { ok: true, receipt } }));
      await expect(w.ledger.normalizeContextOrigins(request, expected)).rejects.toMatchObject({
        name: "UncertainStoreError",
        request: { operation: "/runs/session/checkpoint" },
      });
      expect(w.calls[0].body).toEqual({ storeKey: "runs:default", ...request });
    },
  );
  it.each(["run", "generation", "key", "before", "revision", "inputs", "nonboolean-ok"])(
    "retains the request when a successful checkpoint reply is bound to foreign %s",
    async (mode) => {
      const { request, receipt } = await original(),
        reply = structuredClone(receipt);
      if (mode === "run") reply.runId = "r2";
      if (mode === "generation") reply.ownerGen = "g2";
      if (mode === "key") reply.session.key = "slack:C1:2.0:review";
      if (mode === "before") reply.beforeHash = "d".repeat(64);
      if (mode === "revision") reply.beforeRevision++;
      if (mode === "inputs") reply.inputs.systemHash = "d".repeat(64);
      const w = stubWorker(() => ({
        status: 200,
        data: { ok: mode === "nonboolean-ok" ? "true" : true, receipt: reply },
      }));
      await expect(w.ledger.normalizeContextOrigins(request)).rejects.toMatchObject({
        name: "UncertainStoreError",
        request: { operation: "/runs/session/checkpoint" },
      });
      expect(w.calls).toHaveLength(1);
    },
  );
});
