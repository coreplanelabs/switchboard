import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { fetchMemoryTest } from "./testFetch.ts";
import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES, fitRecordToBudget, utf8ByteLength, type RunRecord } from "../../src/core/runRecord.ts";
import type { RunEvent } from "../../src/core/runEvents.ts";
import type { CoordinatorUnit } from "../../src/core/coordinator/contract.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";
import { LEASE_MS } from "../../src/core/runLedger/types.ts";
import { blobOf, pointOf, reviewBlobOf, reviewDoubleOf, type RunMetricsPoint } from "../../src/core/runMetrics.ts";
import { featuresOf, RunHistoryDO } from "./worker.ts";
import { RUN_EVENT_INSERT_BATCH } from "../../src/memorySqlLimits.ts";

// Feature: docs/reference/specs/run-history.md — the RunHistoryDO: the durable
// run store behind the bot's WorkerRunStore. Runs in workerd against the real
// SQLite-backed Durable Object; a unique store key per test.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };
const DAY = 86_400_000;
const MIB = 1024 * 1024;

let n = 0;
const storeKey = () => `runs:test-${Date.now()}-${n++}`;

async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return fetchMemoryTest(
    `${BASE}${path}`,
    {
      method: "POST",
      headers: { ...headers, "content-length": String(new TextEncoder().encode(raw).byteLength) },
      body: raw,
    },
    async (res) => {
      const text = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text);
      } catch {
        // non-JSON: leave {}
      }
      return { status: res.status, data };
    },
  );
}

const ZERO = { count: 0, durationMs: 0 };
const diagnosis = () => ({
  eventCount: 0,
  toolCalls: 0,
  // Every current analyzer category, zeroed — the DO normalizes on read, so a
  // fixture pinned to a category list would drift the moment one is added.
  byCategory: Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, ZERO])) as RunRecord["diagnosis"]["byCategory"],
  findings: [],
  verdict: "no friction detected",
});

/** Events stamped 1..count like the registry stamps them (`seq` is what the store keys on). */
function events(count: number, size = 10, firstSeq = 1): RunRecord["events"] {
  return Array.from({ length: count }, (_, i) => ({
    type: "tool_call" as const,
    tool: "bash",
    summary: `step ${i} ${"x".repeat(size)}`,
    seq: firstSeq + i,
  }));
}

function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const evs = over.events ?? events(3);
  return {
    id,
    label: `review · o/r · "${id}"`,
    agent: "review",
    model: "anthropic/m",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1",
    channelVisibility: "unknown",
    startedAt: finishedAt - 5000,
    finishedAt,
    status: "completed",
    eventCount: evs.length,
    storedEventCount: evs.length,
    truncated: false,
    events: evs,
    diagnosis: diagnosis(),
    ...over,
  };
}

const stubOf = (key: string) => env.RUNS.get(env.RUNS.idFromName(key));

describe("reading diff attempt visibility", () => {
  it("retains the attempt in get while summary and both list paths omit its text", async () => {
    const key = storeKey();
    const now = Date.now();
    const attempt = {
      state: "failed" as const,
      startedAt: now - 1000,
      at: now,
      progress: ["meat: thinking (turn 1)"],
      reason: "provider failed",
    };
    const saved = await post("/runs/put", {
      storeKey: key,
      record: record("attempt", now, { readingDiffAbridge: attempt }),
    });
    expect(saved.status).toBe(200);
    const full = await post("/runs/get", { storeKey: key, id: "attempt" });
    expect(full.data.record).toMatchObject({ id: "attempt", readingDiffAbridge: attempt });
    const summary = await post("/runs/summary", { storeKey: key, id: "attempt" });
    expect(summary.data.summary).toMatchObject({ id: "attempt" });
    expect(summary.data.summary).not.toHaveProperty("readingDiffAbridge");
    for (const limit of [1, 10]) {
      const page = await post("/runs/list", { storeKey: key, limit });
      expect(page.status).toBe(200);
      expect(page.data.items).toMatchObject([{ id: "attempt" }]);
      expect((page.data.items as unknown[])[0]).not.toHaveProperty("readingDiffAbridge");
    }
  });
});
/** Record every SQL statement the DO instance runs from now on (the plan check). */
function spySql(inst: RunHistoryDO): string[] {
  const seen: string[] = [];
  const real = (inst as unknown as { sql: SqlStorage }).sql;
  Object.defineProperty(inst, "sql", {
    value: { exec: (q: string, ...p: unknown[]) => (seen.push(q), real.exec(q, ...p)) },
  });
  return seen;
}
const rowCount = (key: string, table: string) =>
  runInDurableObject(
    stubOf(key),
    async (_inst: RunHistoryDO, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n,
  );
const putDirect = (
  key: string,
  rec: RunRecord,
  proposal?: { policy: Record<string, number>; policyUpdatedAt: number },
) => runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.put(rec, proposal));
const putDirectMany = (key: string, records: RunRecord[]) =>
  runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
    for (const rec of records) await inst.put(rec);
  });

describe("cross-channel Review claims", () => {
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const claim = (key: string, runId: string, threadKey: string, headSha = headA, ship = false) => ({
    storeKey: key,
    run: {
      runId,
      threadKey,
      gen: "g1",
      leaseMs: LEASE_MS,
      startedAt: 1_000,
      meta: {
        agent: "review",
        repo: "acme/api",
        pr: 42,
        headSha,
        channelId: threadKey.split(":").slice(0, 2).join(":"),
        userId: "slack:UALICE",
        channelVisibility: "private" as const,
        threadKey,
        ...(ship ? { parentInstanceId: "plan-example-1", idempotencyKey: "plan-example-1:U12/0/review" } : {}),
      },
      card: null,
      system: "review",
      tools: [],
    },
  });

  it("returns one owner across threads and moves that owner's head only with a complete source receipt", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claim(key, "owner", "slack:C1:1"))).status).toBe(200);
    expect((await post("/runs/claim", claim(key, "owner", "slack:C1:1"))).status).toBe(200);
    expect((await post("/runs/claim", claim(key, "same-thread", "slack:C1:1"))).data).toMatchObject({
      ok: false,
      reason: "thread-live",
      live: { runId: "owner" },
    });
    expect(await post("/runs/claim", claim(key, "duplicate", "mcp:review:42"))).toEqual({
      status: 409,
      data: {
        ok: false,
        reason: "review-owned",
        live: {
          runId: "owner",
          agent: "review",
          startedAt: 1_000,
          channelId: "slack:C1",
          userId: "slack:UALICE",
          channelVisibility: "private",
          headSha: headA,
        },
      },
    });
    expect((await post("/runs/claim", claim(key, "moved", "slack:C2:2", headB))).data).toMatchObject({
      ok: false,
      reason: "review-owned",
      live: { runId: "owner", headSha: headA },
    });
    const source = {
      kind: "diff",
      repo: "acme/api",
      pr: 42,
      headSha: headB,
      baseSha: "c".repeat(40),
      sourceHash: "d".repeat(64),
      size: 99,
      complete: true,
    };
    const advance = { storeKey: key, request: { runId: "owner", gen: "g1", from: headA, to: headB, source } };
    expect(
      (
        await post("/runs/review-head/advance", {
          ...advance,
          request: { ...advance.request, source: { ...source, complete: false } },
        })
      ).data,
    ).toEqual({
      ok: false,
      reason: "source-unproved",
    });
    expect(await post("/runs/review-head/advance", advance)).toEqual({ status: 200, data: { ok: true } });
    expect(
      (await post("/runs/state", { storeKey: key, runId: "owner", gen: "g1", state: { notes: "later" } })).status,
    ).toBe(200);
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      expect((await inst.listLive())[0]).toMatchObject({
        meta: { headSha: headB },
        state: { reviewClaimSource: source, notes: "later" },
      });
    });
    expect((await post("/runs/claim", claim(key, "moved", "slack:C2:2", headB))).data).toMatchObject({
      ok: false,
      reason: "review-owned",
      live: { runId: "owner", headSha: headB },
    });
    expect((await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: ["owner"] })).status).toBe(200);
    expect((await post("/runs/claim", claim(key, "moved", "slack:C2:2", headB))).data).toMatchObject({
      ok: false,
      reason: "review-owned",
      live: { runId: "owner", headSha: headB },
    });
    expect((await post("/runs/reclaim", { storeKey: key, gen: "g2", leaseMs: LEASE_MS, now: Date.now() })).status).toBe(
      200,
    );
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId: "owner",
          gen: "g2",
          record: record("owner", Date.now(), {
            repo: "acme/api",
            targetPr: 42,
            reviewHead: headB,
            threadKey: "slack:C1:1",
          }),
        })
      ).data,
    ).toMatchObject({ ok: true, stored: true });
    expect((await post("/runs/claim", claim(key, "successor", "slack:C2:2", headB, true))).status).toBe(200);
    expect((await post("/runs/claim", claim(key, "outside", "mcp:review:42", headB))).data).toMatchObject({
      ok: false,
      reason: "review-owned",
      live: { runId: "successor", parentInstanceId: "plan-example-1" },
    });
  });

  it("holds a new request when older live rows already disagree on the PR owner", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claim(key, "first", "slack:C1:first"))).status).toBe(200);
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO live_runs (run_id, thread_key, owner_gen, lease_until, started_at, phase, stop, meta_json, card_json, system_text, tools_json, state_json)
         SELECT 'legacy-second', 'slack:C2:second', owner_gen, lease_until, started_at, phase, stop, meta_json, card_json, system_text, tools_json, state_json
         FROM live_runs WHERE run_id='first'`,
      );
    });
    expect(await post("/runs/claim", claim(key, "third", "mcp:review:third"))).toEqual({
      status: 409,
      data: { ok: false, reason: "review-conflict" },
    });
    expect(await rowCount(key, "live_runs")).toBe(2);
  });
});

describe("unit context retention work", () => {
  it("a near-limit terminal record saves shutdown proof without replacing its events", async () => {
    const key = storeKey();
    const events: RunEvent[] = [
      ...Array.from({ length: 31 }, (_, i) => ({ type: "context" as const, text: "x".repeat(50_000), seq: i + 1 })),
      { type: "answer", text: "x".repeat(1024), seq: 32 },
    ];
    const finishedAt = Date.now();
    const make = () =>
      fitRecordToBudget({
        ...record("full-shutdown-proof", finishedAt),
        events,
        eventCount: events.length,
        storedEventCount: events.length,
      });
    const padding = MAX_RECORD_BYTES - utf8ByteLength(JSON.stringify(make()));
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThan(64 * 1024);
    events[31] = { type: "answer", text: "x".repeat(1024 + padding), seq: 32 };
    const original = make();
    expect((await post("/runs/put", { storeKey: key, record: original })).data).toMatchObject({ stored: true });
    expect(await post("/runs/shutdown", { storeKey: key, record: original })).toEqual({
      status: 200,
      data: { ok: true, confirmed: true },
    });
    const saved = (await post("/runs/get", { storeKey: key, id: original.id })).data.record as RunRecord;
    expect(saved).toMatchObject({ id: "full-shutdown-proof", runtimeShutdownConfirmed: true });
    expect(saved.events).toEqual(original.events);
    expect(utf8ByteLength(JSON.stringify(saved))).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(
      ((await post("/runs/summary", { storeKey: key, id: original.id })).data.summary as { bytes: number }).bytes,
    ).toBeLessThanOrEqual(MAX_RECORD_BYTES);
  });

  it("shutdown acknowledgement preserves newer records and the deletion fence", async () => {
    const key = storeKey();
    const original = {
      ...record("shutdown-proof", Date.now()),
      failure: { kind: "runtime_shutdown_unconfirmed" as const },
      events: Array.from({ length: 5 }, (_, i) => ({ type: "context" as const, text: "x".repeat(40_000), seq: i + 1 })),
      eventCount: 5,
      storedEventCount: 5,
    };
    await post("/runs/put", { storeKey: key, record: { ...original, label: "newer metadata" } });
    expect(await post("/runs/shutdown", { storeKey: key, record: original })).toEqual({
      status: 200,
      data: { ok: true, confirmed: true },
    });
    expect((await post("/runs/get", { storeKey: key, id: original.id })).data.record).toMatchObject({
      label: "newer metadata",
      runtimeShutdownConfirmed: true,
    });
    expect((await post("/runs/get", { storeKey: key, id: original.id })).data.record).not.toHaveProperty("failure");
    const newer = { ...original, finishedAt: original.finishedAt + 1, status: "failed" as const };
    await post("/runs/put", { storeKey: key, record: newer });
    expect(await post("/runs/shutdown", { storeKey: key, record: original })).toEqual({
      status: 200,
      data: { ok: true, confirmed: false },
    });
    expect((await post("/runs/get", { storeKey: key, id: original.id })).data.record).toMatchObject({
      finishedAt: newer.finishedAt,
      status: "failed",
    });
    expect((await post("/runs/get", { storeKey: key, id: original.id })).data.record).not.toHaveProperty(
      "runtimeShutdownConfirmed",
    );
    await post("/runs/delete", { storeKey: key, id: original.id, destructive: true });
    expect(await post("/runs/shutdown", { storeKey: key, record: newer })).toEqual({
      status: 200,
      data: { ok: true, confirmed: false },
    });
    expect(await rowCount(key, "runs")).toBe(0);
  });

  it("shutdown acknowledgement refuses a run with a current live owner", async () => {
    const key = storeKey();
    const original = record("live-shutdown-proof", Date.now());
    expect(
      (
        await post("/runs/claim", {
          storeKey: key,
          run: {
            runId: original.id,
            threadKey: original.threadKey,
            gen: "g-original",
            leaseMs: LEASE_MS,
            startedAt: original.startedAt,
            meta: { channelId: original.channelId, userId: original.userId, threadKey: original.threadKey },
            card: null,
            system: "",
            tools: [],
            state: {},
          },
        })
      ).data,
    ).toMatchObject({ ok: true });
    await post("/runs/put", { storeKey: key, record: original });
    expect(await post("/runs/shutdown", { storeKey: key, record: original })).toEqual({
      status: 200,
      data: { ok: true, confirmed: false },
    });
    expect((await post("/runs/get", { storeKey: key, id: original.id })).data.record).toMatchObject({
      id: original.id,
      status: "completed",
    });
    expect((await post("/runs/get", { storeKey: key, id: original.id })).data.record).not.toHaveProperty(
      "runtimeShutdownConfirmed",
    );
  });

  it("force delete removes only the selected live run and fences late writers", async () => {
    const key = storeKey();
    const saved = record("force-target", Date.now());
    const sessionKey = `mcp:force-test:${saved.id}:review`;
    const session = { key: sessionKey, seedFrom: 0, request: 0, range: { from: 0 } };
    const claim = {
      runId: saved.id,
      threadKey: saved.threadKey,
      gen: "g-old",
      leaseMs: LEASE_MS,
      startedAt: saved.startedAt,
      meta: { channelId: saved.channelId, userId: saved.userId, threadKey: saved.threadKey, session },
      card: null,
      system: "",
      tools: [],
      state: {},
    };
    expect((await post("/runs/claim", { storeKey: key, run: claim })).data).toMatchObject({ ok: true });
    await post("/runs/put", { storeKey: key, record: saved });
    await post("/runs/put", { storeKey: key, record: record("force-neighbor", Date.now()) });
    const transcript = { runId: saved.id, gen: "g-old" };
    await post("/runs/session/owner", { key: sessionKey, runId: saved.id, gen: "g-old" });
    expect(
      (await post("/runs/session/owner", { key: sessionKey, runId: "force-neighbor", gen: "g-neighbor" })).status,
    ).toBe(200);
    await post("/runs/transcript/owner", transcript);
    await post("/runs/transcript/write", {
      ...transcript,
      rows: [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "private text" } }) }],
      attachments: [],
    });
    expect(await post("/runs/delete", { storeKey: key, id: saved.id, destructive: true })).toEqual({
      status: 409,
      data: { ok: false, reason: "live" },
    });
    expect(await post("/runs/delete", { storeKey: key, id: saved.id, destructive: true, force: true })).toEqual({
      status: 200,
      data: { ok: true, deleted: true, destructive: true, force: true },
    });
    expect((await post("/runs/get", { storeKey: key, id: saved.id })).data).toEqual({ record: null });
    expect((await post("/runs/get", { storeKey: key, id: "force-neighbor" })).data.record).toMatchObject({
      id: "force-neighbor",
    });
    expect(await rowCount(key, "live_runs")).toBe(0);
    expect(await rowCount(key, "run_events")).toBe(3);
    expect((await post("/runs/put", { storeKey: key, record: saved })).data).toMatchObject({ stored: false });
    expect(await post("/runs/claim", { storeKey: key, run: claim })).toEqual({
      status: 409,
      data: { error: "run_deleted" },
    });
    expect((await post("/runs/transcript/read", { runId: saved.id })).data).toEqual({ rows: [], attachments: [] });
    expect(await post("/runs/transcript/owner", transcript)).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
    expect(await post("/runs/deleted", { storeKey: key, ids: [saved.id], force: true })).toEqual({
      status: 200,
      data: { ids: [saved.id], force: true },
    });
    expect((await post("/runs/deletion-identity", { storeKey: key, id: saved.id })).data).toMatchObject({
      identity: { id: saved.id, userId: "slack:UALICE", channelId: "slack:C1" },
    });
    expect(await post("/runs/session/owner", { key: sessionKey, runId: saved.id, gen: "g-old" })).toEqual({
      status: 409,
      data: { error: "run_deleted" },
    });
    expect(
      (
        await post("/runs/session/write", {
          key: sessionKey,
          runId: "force-neighbor",
          gen: "g-neighbor",
          rows: [
            { idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "neighbor text" } }) },
          ],
          attachments: [],
        })
      ).status,
    ).toBe(200);
    expect((await post("/runs/session/read", { key: sessionKey, from: 0 })).data).toMatchObject({ rows: [{ idx: 0 }] });
    const lateAdmission = await runInDurableObject(stubOf(key), async (instance) => {
      try {
        await instance.planeAdmit(
          { runId: saved.id, requester: saved.userId, threadKey: saved.threadKey, request: {} },
          Date.now(),
        );
        return "admitted";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown refusal";
      }
    });
    expect(lateAdmission).toBe("The run was deleted.");
    expect(await rowCount(key, "plane_queue")).toBe(0);
    expect(
      await post("/runs/append", {
        storeKey: key,
        runId: saved.id,
        gen: "g-old",
        events: [{ type: "answer", text: "late", seq: 4 }],
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "unknown-run" } });
  });

  it("force deletion without destructive consent is refused", async () => {
    const key = storeKey();
    await post("/runs/put", { storeKey: key, record: record("force-consent", Date.now()) });
    expect((await post("/runs/delete", { storeKey: key, id: "force-consent", force: true })).status).toBe(400);
    expect((await post("/runs/get", { storeKey: key, id: "force-consent" })).data.record).toMatchObject({
      id: "force-consent",
    });
  });

  it.each(["saved", "queued"])(
    "force deletion retains its identity and resumes after incomplete cross-object cleanup: %s",
    async (source) => {
      const key = storeKey();
      const saved = record("force-interrupted", Date.now());
      if (source === "saved") await post("/runs/put", { storeKey: key, record: saved });
      else {
        await post("/runs/claim", {
          storeKey: key,
          run: {
            runId: "force-blocker",
            threadKey: saved.threadKey,
            gen: "g-blocker",
            leaseMs: LEASE_MS,
            startedAt: saved.startedAt,
            meta: { channelId: saved.channelId, userId: saved.userId, threadKey: saved.threadKey },
            card: null,
            system: "",
            tools: [],
            state: {},
          },
        });
        const admission = await runInDurableObject(stubOf(key), (instance) =>
          instance.planeAdmit(
            {
              runId: saved.id,
              requester: saved.userId,
              threadKey: saved.threadKey,
              request: { channelId: saved.channelId },
            },
            Date.now(),
          ),
        );
        expect(admission.kind).toBe("queued");
      }
      await runInDurableObject(stubOf(key), async (instance) => {
        const target = instance as unknown as { env: { RUN_TRANSCRIPTS: typeof env.RUN_TRANSCRIPTS } };
        const original = target.env.RUN_TRANSCRIPTS;
        let fail = true;
        target.env = {
          ...target.env,
          RUN_TRANSCRIPTS: new Proxy(original, {
            get(namespace, property) {
              if (property === "get")
                return (id: DurableObjectId) => {
                  const transcript = original.get(id);
                  return {
                    purge: async () => {
                      if (fail) {
                        fail = false;
                        throw new Error("fixture transcript unavailable");
                      }
                      return transcript.purge();
                    },
                  };
                };
              const value = Reflect.get(namespace, property);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, namespace, args)
                : value;
            },
          }),
        };
      });
      const request = { storeKey: key, id: saved.id, destructive: true, force: true };
      expect((await post("/runs/delete", request)).status).toBe(500);
      expect((await post("/runs/deletion-identity", { storeKey: key, id: saved.id })).data).toMatchObject({
        identity: { id: saved.id, userId: "slack:UALICE" },
      });
      expect((await post("/runs/deleted", { storeKey: key, ids: [saved.id], force: true })).data).toEqual({
        ids: [],
        force: true,
      });
      expect((await post("/runs/put", { storeKey: key, record: saved })).data).toMatchObject({ stored: false });
      expect((await post("/runs/delete", request)).data).toMatchObject({ ok: true, force: true });
      expect((await post("/runs/deleted", { storeKey: key, ids: [saved.id], force: true })).data).toEqual({
        ids: [saved.id],
        force: true,
      });
      expect((await post("/runs/get", { storeKey: key, id: saved.id })).data).toEqual({ record: null });
    },
  );

  it("kill deletes run history and rejects a delayed record write", async () => {
    const key = storeKey();
    const saved = record("kill-target", Date.now());
    expect((await post("/runs/put", { storeKey: key, record: saved })).data).toMatchObject({ stored: true });
    expect((await post("/runs/delete", { storeKey: key, id: saved.id, destructive: true })).data).toEqual({
      ok: true,
      deleted: true,
      destructive: true,
    });
    expect((await post("/runs/put", { storeKey: key, record: saved })).data).toMatchObject({ stored: false });
    expect((await post("/runs/get", { storeKey: key, id: saved.id })).data.record).toBeNull();
    expect(await rowCount(key, "runs")).toBe(0);
    expect(await rowCount(key, "run_events")).toBe(0);
    expect(await rowCount(key, "run_deletions")).toBe(1);
    expect(await post("/runs/deleted", { storeKey: key, ids: [saved.id, "other"] })).toEqual({
      status: 200,
      data: { ids: [saved.id] },
    });
    const claimed = await post("/runs/claim", {
      storeKey: key,
      run: {
        runId: saved.id,
        threadKey: saved.threadKey,
        gen: "g-late",
        leaseMs: LEASE_MS,
        startedAt: saved.startedAt,
        meta: { channelId: saved.channelId, userId: saved.userId, threadKey: saved.threadKey },
        card: null,
        system: "",
        tools: [],
        state: {},
      },
    });
    expect(claimed).toEqual({ status: 409, data: { error: "run_deleted" } });
    expect(await rowCount(key, "live_runs")).toBe(0);
  });

  const unit = (name: string, context = false): CoordinatorUnit => ({
    instanceId: "retention",
    unit: name,
    slug: "source",
    branch: "plan/retention/source",
    dependsOn: [],
    rounds: [],
    ...(context
      ? {
          context: {
            version: 1 as const,
            handoff: {
              version: 1 as const,
              source: {
                runId: "source",
                requester: "slack:UALICE",
                channelId: "slack:C1",
                threadKey: "slack:C1:1",
              },
              session: { key: "slack:C1:1:coding", from: 0, to: -1 },
              assets: [],
            },
          },
        }
      : {}),
  });

  async function seed(key: string, size: number) {
    await putDirectMany(
      key,
      ["source", "malformed-source", "invalid-source", "unheld-source", "latest"].map((id) => record(id, Date.now())),
    );
    await runInDurableObject(stubOf(key), (_inst: RunHistoryDO, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < size; i++) {
          const value = unit(i === 0 ? "source:part" : `u${i}`, i === 0);
          state.storage.sql.exec(
            "INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, 1)",
            value.instanceId,
            value.unit,
            JSON.stringify(value),
          );
        }
        for (const [name, json] of [
          ["malformed", "{broken"],
          ["invalid", JSON.stringify({ ...unit("invalid"), context: { version: 1 } })],
        ])
          state.storage.sql.exec(
            "INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES ('retention', ?, ?, 1)",
            name,
            json,
          );
        for (const [name, source] of [
          ["source:part", "source"],
          ["malformed", "malformed-source"],
          ["invalid", "invalid-source"],
          ["u1", "unheld-source"],
        ])
          state.storage.sql.exec(
            "INSERT INTO context_refs (holder_run_id, source_run_id) VALUES (?, ?)",
            `@unit:retention:${name}`,
            source,
          );
        state.storage.sql.exec("UPDATE runs SET finished_at = ? WHERE run_id != 'latest'", Date.now() - 40 * DAY);
      });
    });
  }

  async function countUnitReads<T>(inst: RunHistoryDO, work: () => Promise<T>) {
    const real = (inst as unknown as { sql: SqlStorage }).sql;
    const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
    Object.defineProperty(inst, "sql", {
      configurable: true,
      value: {
        exec: (q: string, ...p: unknown[]) => {
          const cursor = real.exec(q, ...p);
          if (q.includes("coordinator_units")) cursors.push(cursor);
          return cursor;
        },
      },
    });
    try {
      const result = await work();
      return { result, rows: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0) };
    } finally {
      Object.defineProperty(inst, "sql", { value: real });
    }
  }

  it.each([100, 1_000])("put, finish and sparse list read unit roots in linear work with %i units", async (size) => {
    for (const operation of ["put", "finish", "list"] as const) {
      const key = storeKey();
      await seed(key, size);
      const rec = record("latest", Date.now());
      const observed = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
        if (operation === "finish")
          await inst.claim(
            {
              runId: rec.id,
              threadKey: rec.threadKey,
              gen: "g1",
              leaseMs: LEASE_MS,
              startedAt: rec.startedAt,
              meta: { threadKey: rec.threadKey, channelId: rec.channelId, userId: rec.userId },
              card: null,
              system: "work",
              tools: [],
            },
            Date.now(),
          );
        return countUnitReads(inst, async () => {
          if (operation === "list") return (await inst.list({ agent: "missing", limit: 10 })).items;
          if (operation === "finish") return inst.finish(rec.id, "g1", rec);
          return inst.put(rec);
        });
      });
      if (operation === "list") expect(observed.result).toEqual([]);
      else expect(observed.result).toMatchObject({ ok: true, stored: true });
      // Include the reference query's unit-membership checks as well as the root pass.
      expect.soft(observed.rows, operation).toBeLessThanOrEqual(6 * size + 64);
      expect((await post("/runs/get", { storeKey: key, id: "source" })).data.record).not.toBeNull();
      for (const id of ["malformed-source", "invalid-source", "unheld-source"])
        expect((await post("/runs/get", { storeKey: key, id })).data.record).toBeNull();
    }
  });

  it("a protected point read looks up one unit by its composite key without scanning other units", async () => {
    const key = storeKey();
    await seed(key, 1_000);
    const observed = await runInDurableObject(stubOf(key), (inst: RunHistoryDO) =>
      countUnitReads(inst, () => inst.get("source")),
    );
    expect(observed.result).toMatchObject({ id: "source" });
    expect(observed.rows).toBeLessThanOrEqual(2);
  });

  it("an unchanged unit write looks up its existing context without scanning other units", async () => {
    const key = storeKey();
    await seed(key, 1_000);
    const value = unit("source:part", true);
    const observed = await runInDurableObject(stubOf(key), (inst: RunHistoryDO) =>
      countUnitReads(inst, () => inst.putUnits([value], Date.now())),
    );
    expect(observed.result).toEqual({ ok: true });
    expect(observed.rows).toBeLessThanOrEqual(10);
  });
});

// docs/reference/specs/run-history.md item 56: the record's usage is stored beside
// the row; `/runs/usage` answers one row per run with its thread, channel and
// agent, names the parents outside the batch, and fills in a record written
// before the field from its stored model.turn events as it answers.
describe("run usage", () => {
  const T = Date.now() - 7 * DAY;
  const modelTurn = (seq: number, model: string, inputTokens: number, outputTokens: number) =>
    ({
      type: "span_end",
      spanId: `m${seq}`,
      parentSpanId: "agent",
      name: "model.turn",
      startedAt: T - 5000 + seq,
      durationMs: 100,
      status: "ok",
      attrs: { model, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      seq,
    }) as unknown as RunRecord["events"][number];

  it("put stores the record's usage; /runs/usage answers one row per run with its thread, channel and agent, names a parent outside the batch, backfills a usage-less record from its events, and bounds the range to what is held", async () => {
    const key = storeKey();
    const usage = (input: number, output: number) => ({
      turns: 1,
      byModel: {
        "anthropic/claude-fable-5": {
          turns: 1,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });
    // Alice's run, with usage as every record written since carries it — finished a week before the range.
    const parentPut = await post("/runs/put", {
      storeKey: key,
      record: record("alice-1", T - DAY, { usage: usage(100, 10), userName: "alice" }),
    });
    expect(parentPut.data).toMatchObject({ ok: true, stored: true });
    // A child the coordinator started for alice, in the unit's thread on the coding agent: its own
    // user_id is the coordinator's, and its parent is outside the range asked below.
    await post("/runs/put", {
      storeKey: key,
      record: record("child-1", T + 20_000, {
        userId: "http:coordinator",
        parentRunId: "alice-1",
        parentInstanceId: "plan-example-1",
        idempotencyKey: "plan-example-1:U12/0/coding",
        costCapUsd: 50,
        threadKey: "slack:C1:9",
        agent: "coding",
        usage: usage(1, 1),
      }),
    });
    // Bob's record from before the field existed: no usage, but the turn is in its events.
    const legacy = record("bob-old", T + 120_000, {
      userId: "slack:UBOB",
      userName: "bob",
      events: [
        { type: "input", text: "go", seq: 1 } as RunRecord["events"][number],
        modelTurn(2, "anthropic/claude-haiku-4-5", 40, 4),
      ],
    });
    delete (legacy as Partial<RunRecord>).usage;
    await post("/runs/put", { storeKey: key, record: legacy });
    // Alice, the next UTC day.
    await post("/runs/put", {
      storeKey: key,
      record: record("alice-2", T + 86_400_000, { usage: usage(5, 5), userName: "alice" }),
    });

    const first = await post("/runs/usage", { storeKey: key, sinceMs: T - 1, untilMs: T + 2 * 86_400_000 });
    expect(first.status).toBe(200);
    const runs = first.data.runs as Array<Record<string, unknown>>;
    // One row per run, oldest finish first, each with its own requester, thread, channel and agent.
    expect(runs.map((r) => `${r.id} ${r.userId} ${r.threadKey} ${r.channelId} ${r.agent}`)).toEqual([
      "child-1 http:coordinator slack:C1:9 slack:C1 coding",
      "bob-old slack:UBOB slack:C1:1 slack:C1 review",
      "alice-2 slack:UALICE slack:C1:1 slack:C1 review",
    ]);
    const child = runs[0] as { parentRunId: string; usage: { turns: number }; startedAt: number; finishedAt: number };
    expect(child.parentRunId).toBe("alice-1");
    expect(child).toMatchObject({
      parentInstanceId: "plan-example-1",
      idempotencyKey: "plan-example-1:U12/0/coding",
      costCapUsd: 50,
    });
    expect(child.usage.turns).toBe(1);
    expect(child.finishedAt - child.startedAt).toBe(5000); // each fixture run is 5 s wall clock
    // The parent outside the range is named so the bot can bill the child to alice.
    expect(first.data.parents).toEqual({ "alice-1": { userId: "slack:UALICE", userName: "alice" } });
    // Bob's legacy row was priced from its events on this read: not pending, and written back.
    const bob = runs[1] as { userName: string; usage: { byModel: Record<string, { inputTokens: number }> } };
    expect(bob.userName).toBe("bob");
    expect(bob.usage.byModel["anthropic/claude-haiku-4-5"].inputTokens).toBe(40);
    expect(first.data.pending).toBe(0);
    expect(first.data.retentionDays).toBe(30);
    expect(first.data.earliestFinishedAt).toBe(T - DAY);
    const stored = await runInDurableObject(
      stubOf(key),
      async (_inst: RunHistoryDO, state) =>
        state.storage.sql
          .exec<{ usage_json: string | null }>(`SELECT usage_json FROM runs WHERE run_id = 'bob-old'`)
          .one().usage_json,
    );
    expect(JSON.parse(stored ?? "null")).toMatchObject({ turns: 1 });
    // The range is honoured: the second day alone, and no parent to name.
    const second = await post("/runs/usage", {
      storeKey: key,
      sinceMs: T + 86_000_000,
      untilMs: T + 2 * 86_400_000,
    });
    expect((second.data.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(["alice-2"]);
    expect(second.data.parents).toEqual({});
  });

  it("refuses a malformed range by name", async () => {
    const key = storeKey();
    expect((await post("/runs/usage", { storeKey: key, sinceMs: 10, untilMs: 5 })).status).toBe(400);
    expect((await post("/runs/usage", { storeKey: key, sinceMs: 0, untilMs: 400 * 86_400_000 })).status).toBe(400);
    expect((await post("/runs/usage", { storeKey: key, sinceMs: "x", untilMs: 5 })).status).toBe(400);
    const empty = await post("/runs/usage", { storeKey: key, sinceMs: 0, untilMs: 1 });
    expect(empty.status).toBe(200);
    expect(empty.data).toMatchObject({ runs: [], parents: {}, pending: 0 });
  });
});

describe("run history routes", () => {
  it("put → get round-trips the record with events in seq order; unknown id → {record: null} 200", async () => {
    const key = storeKey();
    const now = Date.now();
    const rec = record("a", now, { events: events(5) });
    const put = await post("/runs/put", { storeKey: key, record: rec });
    expect(put.status).toBe(200);
    expect(put.data).toEqual({ ok: true, retained: 1, stored: true, rewritten: false });
    const got = await post("/runs/get", { storeKey: key, id: "a" });
    expect(got.status).toBe(200);
    expect(got.data.record).toEqual(rec);
    expect(await post("/runs/get", { storeKey: key, id: "nope" })).toEqual({ status: 200, data: { record: null } });
    expect(await post("/runs/get", { storeKey: storeKey(), id: "a" })).toEqual({ status: 200, data: { record: null } });
  });

  it("inserts 5000 events inside one transaction and pages them by seq", async () => {
    const key = storeKey();
    const rec = record("big", Date.now(), { events: events(5000) });
    expect((await post("/runs/put", { storeKey: key, record: rec })).data).toMatchObject({ ok: true, stored: true });
    expect(await rowCount(key, "run_events")).toBe(5000);
    expect(RUN_EVENT_INSERT_BATCH * 3).toBeLessThanOrEqual(100); // the DO bound-parameter limit
    const page = await post("/runs/events", { storeKey: key, id: "big", afterSeq: 10, limit: 5 });
    expect((page.data.events as Array<{ seq: number; summary: string }>).map((e) => e.seq)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    expect((page.data.events as Array<{ summary: string }>)[0].summary).toMatch(/^step 10 /);
    expect(page.data.nextAfterSeq).toBe(15);
    const tail = await post("/runs/events", { storeKey: key, id: "big", afterSeq: 4995, limit: 100 });
    expect((tail.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([4996, 4997, 4998, 4999, 5000]);
    expect(tail.data.nextAfterSeq).toBeUndefined();
    expect((await post("/runs/events", { storeKey: key, id: "missing", afterSeq: 0 })).data).toEqual({ events: null });
    expect((await post("/runs/events", { storeKey: key, id: "big", afterSeq: 5000 })).data).toEqual({ events: [] });
  }, 60_000);

  it("stores each event's JSON verbatim: the run-page fields (callId, exitCode, output, input.source, the model.turn span's timing + usage) come back unchanged from get and events", async () => {
    const key = storeKey();
    const evs: RunRecord["events"] = [
      {
        type: "input",
        text: "please review",
        messageId: "1.0",
        source: { url: "https://x.slack.com/archives/C1/p1", channel: "general", user: "alice" },
        at: 1,
      },
      {
        type: "span_end",
        spanId: "m1",
        name: "model.turn",
        startedAt: 1,
        durationMs: 1,
        status: "ok",
        attrs: { stopReason: "tool_use", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 },
        at: 2,
      },
      { type: "tool_call", tool: "bash", summary: "$ npm test", callId: "toolu_01", at: 2 },
      {
        type: "tool_result",
        tool: "bash",
        ok: false,
        summary: "exit 1: 3 failed",
        callId: "toolu_01",
        exitCode: 1,
        output: "exit 1:\n--- stderr ---\n3 failed",
        at: 3,
      },
    ];
    const rec = record("rich", Date.now(), { events: evs });
    expect((await post("/runs/put", { storeKey: key, record: rec })).status).toBe(200);
    // `seq` is the store's own key (position-stamped here); every other field is the JSON as written.
    const withoutSeq = (list: unknown) =>
      (list as Array<RunRecord["events"][number] & { seq?: number }>).map(({ seq: _seq, ...e }) => e);
    expect(
      withoutSeq(((await post("/runs/get", { storeKey: key, id: "rich" })).data.record as RunRecord).events),
    ).toEqual(evs);
    expect(withoutSeq((await post("/runs/events", { storeKey: key, id: "rich" })).data.events)).toEqual(evs);
  }, 60_000);

  it("events keep the registry seq: a record whose events carry seq 2001..7000 pages from afterSeq 6500 by that seq, and get returns them stamped", async () => {
    const key = storeKey();
    const rec = record("trimmed", Date.now(), {
      events: events(5000, 10, 2001),
      eventCount: 7000,
      storedEventCount: 5000,
      truncated: true,
    });
    expect((await post("/runs/put", { storeKey: key, record: rec })).data).toMatchObject({ ok: true, stored: true });
    const page = await post("/runs/events", { storeKey: key, id: "trimmed", afterSeq: 6500, limit: 100 });
    const seqs = (page.data.events as Array<{ seq: number; summary: string }>).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => 6501 + i));
    expect((page.data.events as Array<{ summary: string }>)[0].summary).toMatch(/^step 4500 /);
    expect(page.data.nextAfterSeq).toBe(6600);
    const tail = await post("/runs/events", { storeKey: key, id: "trimmed", afterSeq: 6995 });
    expect((tail.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([6996, 6997, 6998, 6999, 7000]);
    expect(tail.data.nextAfterSeq).toBeUndefined();
    const got = (await post("/runs/get", { storeKey: key, id: "trimmed" })).data.record as RunRecord;
    expect(got.events.slice(0, 2).map((e) => e.seq)).toEqual([2001, 2002]);
    expect(got).toEqual(rec);
    // Events without a seq (a hand-built record) fall back to positions.
    const bare = record("bare", Date.now(), { events: events(3).map(({ seq: _s, ...e }) => e) });
    await post("/runs/put", { storeKey: key, record: bare });
    const bp = await post("/runs/events", { storeKey: key, id: "bare" });
    expect((bp.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2, 3]);
  }, 60_000);

  it("a stored record missing a diagnosis category still reads via get and list, normalized to every current category", async () => {
    const key = storeKey();
    const rec = record("legacy", Date.now());
    const { slow_tool: _drop, ...rest } = rec.diagnosis.byCategory;
    const put = await post("/runs/put", {
      storeKey: key,
      record: { ...rec, diagnosis: { ...rec.diagnosis, byCategory: { ...rest, retired: ZERO } } },
    });
    expect(put.status).toBe(200);
    const got = (await post("/runs/get", { storeKey: key, id: "legacy" })).data.record as RunRecord;
    expect(got.diagnosis.byCategory.slow_tool).toEqual(ZERO);
    expect(got.diagnosis.byCategory).not.toHaveProperty("retired");
    const [item] = (await post("/runs/list", { storeKey: key })).data.items as RunRecord[];
    expect(item.diagnosis.byCategory.slow_tool).toEqual(ZERO);
  });

  it("list cursor {before, beforeId}: same-finishedAt siblings across a page boundary all appear; a bad beforeId is 400", async () => {
    const key = storeKey();
    const now = Date.now();
    for (const id of ["tie-a", "tie-b", "tie-c"]) await putDirect(key, record(id, now, { events: events(1) }));
    await putDirect(key, record("older", now - 1000, { events: events(1) }));
    const page1 = await post("/runs/list", { storeKey: key, limit: 2 });
    expect((page1.data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(["tie-c", "tie-b"]);
    expect(page1.data.nextBefore).toEqual({ finishedAt: now, id: "tie-b" });
    const cursor = page1.data.nextBefore as { finishedAt: number; id: string };
    const page2 = await post("/runs/list", { storeKey: key, limit: 2, before: cursor.finishedAt, beforeId: cursor.id });
    expect((page2.data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(["tie-a", "older"]);
    expect(page2.data.nextBefore).toEqual({ finishedAt: now - 1000, id: "older" });
    expect(
      (
        (await post("/runs/list", { storeKey: key, before: cursor.finishedAt, beforeId: cursor.id })).data
          .items as unknown[]
      ).length,
    ).toBe(2);
    expect((await post("/runs/list", { storeKey: key, before: cursor.finishedAt, beforeId: "../x" })).status).toBe(400);
  });

  it("two puts for one id leave exactly one coherent event set; an identical repeat put is rewritten:false", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", { storeKey: key, record: record("a", now, { events: events(5) }) });
    const second = record("a", now, { events: events(3, 40) });
    expect((await post("/runs/put", { storeKey: key, record: second })).data).toMatchObject({
      rewritten: true,
      retained: 1,
    });
    expect((await post("/runs/get", { storeKey: key, id: "a" })).data.record).toEqual(second);
    expect(await rowCount(key, "run_events")).toBe(3);
    expect((await post("/runs/put", { storeKey: key, record: second })).data).toMatchObject({
      rewritten: false,
      retained: 1,
    });
    expect(await rowCount(key, "run_events")).toBe(3);
  });

  it("tombstone-first: the DO accepts status `interrupted` (shared validator), and the finish put replaces the provisional record whole", async () => {
    const key = storeKey();
    const now = Date.now();
    // The provisional tombstone written at run start: terminal, finishedAt = startedAt, few events.
    const tombstone = record("t1", now - 5000, { status: "interrupted", startedAt: now - 5000, events: events(2) });
    expect((await post("/runs/put", { storeKey: key, record: tombstone })).status).toBe(200);
    expect((await post("/runs/get", { storeKey: key, id: "t1" })).data.record).toMatchObject({
      status: "interrupted",
      finishedAt: now - 5000,
    });
    // The finish write: a different stored version (eventCount/finishedAt/bytes) → full rewrite.
    const final = record("t1", now, { status: "completed", startedAt: now - 5000, events: events(6) });
    expect((await post("/runs/put", { storeKey: key, record: final })).data).toMatchObject({
      rewritten: true,
      retained: 1,
    });
    expect((await post("/runs/get", { storeKey: key, id: "t1" })).data.record).toEqual(final);
    expect(await rowCount(key, "run_events")).toBe(6);
    const list = (await post("/runs/list", { storeKey: key })).data.items as Array<{ id: string; status: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "t1", status: "completed" });
  });

  it("a put that fails mid-transaction leaves no runs row and no events", async () => {
    const key = storeKey();
    const rec = record("boom", Date.now(), { events: events(3) });
    let reads = 0;
    Object.defineProperty(rec.events, "2", {
      get() {
        reads++;
        throw new Error("torn event");
      },
    });
    await expect(putDirect(key, rec)).rejects.toThrow(/torn event/);
    expect(reads).toBeGreaterThan(0);
    expect(await rowCount(key, "runs")).toBe(0);
    expect(await rowCount(key, "run_events")).toBe(0);
  });

  it("policy: the newer policyUpdatedAt wins, an older proposal is ignored, retentionDays 0 → 400, a future stamp is clamped to the DO clock", async () => {
    const key = storeKey();
    const now = Date.now();
    const policy = (retentionDays: number) => ({ retentionDays, maxRuns: 5000, maxBytes: 64 * MIB });
    await post("/runs/put", {
      storeKey: key,
      record: record("old", now - 20 * DAY),
      policy: policy(30),
      policyUpdatedAt: now - 10_000,
    });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).not.toBeNull();
    // Older proposal with a tighter window: ignored, the run stays visible.
    await post("/runs/put", {
      storeKey: key,
      record: record("x", now),
      policy: policy(5),
      policyUpdatedAt: now - 20_000,
    });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).not.toBeNull();
    // Newer proposal: accepted, the run is now hidden.
    await post("/runs/put", {
      storeKey: key,
      record: record("y", now),
      policy: policy(5),
      policyUpdatedAt: now - 5_000,
    });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).toBeNull();
    expect(
      (await post("/runs/put", { storeKey: key, record: record("z", now), policy: policy(0), policyUpdatedAt: now }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/runs/put", {
          storeKey: key,
          record: record("z", now),
          policy: { maxRuns: 0 },
          policyUpdatedAt: now,
        })
      ).status,
    ).toBe(400);

    // A proposal dated a year ahead is stored with the DO clock, so a later,
    // correctly dated proposal still wins.
    const key2 = storeKey();
    await post("/runs/put", {
      storeKey: key2,
      record: record("old", now - 20 * DAY),
      policy: policy(30),
      policyUpdatedAt: now + 365 * DAY,
    });
    const stored = await runInDurableObject(stubOf(key2), (inst: RunHistoryDO) => inst.policyState());
    expect(stored.policyUpdatedAt).toBeLessThanOrEqual(Date.now());
    await new Promise((r) => setTimeout(r, 10));
    await post("/runs/put", {
      storeKey: key2,
      record: record("y", now),
      policy: policy(5),
      policyUpdatedAt: Date.now(),
    });
    expect(
      (await runInDurableObject(stubOf(key2), (inst: RunHistoryDO) => inst.policyState())).policy.retentionDays,
    ).toBe(5);
    expect((await post("/runs/get", { storeKey: key2, id: "old" })).data.record).toBeNull();
  });

  it("get/list never accept a policy: a generous body policy cannot resurrect a hidden row", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", {
      storeKey: key,
      record: record("old", now - 20 * DAY),
      policy: { retentionDays: 5, maxRuns: 100, maxBytes: 64 * MIB },
      policyUpdatedAt: now,
    });
    expect(
      (await post("/runs/get", { storeKey: key, id: "old", policy: { retentionDays: 365 }, policyUpdatedAt: now + 1 }))
        .data,
    ).toEqual({ record: null });
    expect(
      (await post("/runs/list", { storeKey: key, policy: { retentionDays: 365 }, policyUpdatedAt: now + 1 })).data,
    ).toEqual({ items: [] });
    // and the persisted policy is unchanged
    expect(
      (await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.policyState())).policy.retentionDays,
    ).toBe(5);
  });

  it("a shrink dropping >25% deletes at most 500 rows per put while list already hides them", async () => {
    const key = storeKey();
    const now = Date.now();
    for (let i = 0; i < 620; i++)
      await putDirect(key, record(`r${String(i).padStart(4, "0")}`, now - i * 1000, { events: events(1) }));
    expect(await rowCount(key, "runs")).toBe(620);
    const res = await putDirect(key, record("new", now + 1, { events: events(1) }), {
      policy: { retentionDays: 30, maxRuns: 50, maxBytes: 64 * MIB },
      policyUpdatedAt: now,
    });
    expect(res.stored).toBe(true);
    expect(res.retained).toBe(50);
    // 621 - 50 = 571 outside policy; the fence deletes 500 of them this put.
    expect(await rowCount(key, "runs")).toBe(621 - 500);
    expect(await rowCount(key, "run_events")).toBe(621 - 500);
    const list = await post("/runs/list", { storeKey: key, limit: 200 });
    expect(list.data.items as unknown[]).toHaveLength(50);
    expect((list.data.items as Array<{ id: string }>)[0].id).toBe("new");
    // Rows still on disk behind the fence are hidden on every read path.
    expect(
      await runInDurableObject(
        stubOf(key),
        async (_i: RunHistoryDO, state) =>
          state.storage.sql.exec(`SELECT 1 FROM runs WHERE run_id = 'r0100'`).toArray().length,
      ),
    ).toBe(1);
    expect((await post("/runs/get", { storeKey: key, id: "r0100" })).data).toEqual({ record: null });
    expect((await post("/runs/events", { storeKey: key, id: "r0100" })).data).toEqual({ events: null });
    // the next put finishes the job
    await putDirect(key, record("new2", now + 2, { events: events(1) }));
    expect(await rowCount(key, "runs")).toBe(50);
    expect(await rowCount(key, "run_events")).toBe(50);
  }, 60_000);

  it("get/events hide exactly what list hides for rows still on disk: age, then newest maxRuns (id tie-break), then maxBytes drop-oldest", async () => {
    // The policy is written straight into `meta` so the rows stay ON DISK
    // (a put would trim them): every read path must then agree row by row.
    const setPolicy = (key: string, policy: Record<string, number>) =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => {
        state.storage.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          JSON.stringify({ ...policy, policyUpdatedAt: Date.now() }),
        );
      });
    const idsOnDisk = (key: string) =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) =>
        state.storage.sql.exec<{ run_id: string; bytes: number }>(`SELECT run_id, bytes FROM runs`).toArray(),
      );
    const agree = async (key: string, expected: string[]) => {
      const listed = (
        (await post("/runs/list", { storeKey: key, limit: 200 })).data.items as Array<{ id: string }>
      ).map((r) => r.id);
      expect(listed).toEqual(expected);
      for (const { run_id } of await idsOnDisk(key)) {
        const visible = listed.includes(run_id);
        expect((await post("/runs/get", { storeKey: key, id: run_id })).data.record !== null, `get ${run_id}`).toBe(
          visible,
        );
        expect(
          (await post("/runs/events", { storeKey: key, id: run_id })).data.events !== null,
          `events ${run_id}`,
        ).toBe(visible);
      }
    };
    const now = Date.now();

    // maxRuns with a finishedAt tie: t2 ranks ahead of t1 (run_id desc); age drops `old`.
    const k1 = storeKey();
    for (const [id, at] of [
      ["old", now - 20 * DAY],
      ["a", now - 1000],
      ["t1", now - 2500],
      ["t2", now - 2500],
      ["b", now - 2000],
      ["c", now - 3000],
      ["d", now - 4000],
    ] as const) {
      await putDirect(k1, record(id, at, { events: events(1) }));
    }
    expect(await rowCount(k1, "runs")).toBe(7);
    await setPolicy(k1, { retentionDays: 10, maxRuns: 4, maxBytes: 64 * MIB });
    expect(await rowCount(k1, "runs")).toBe(7); // nothing deleted — hidden only
    await agree(k1, ["a", "b", "t2", "t1"]);

    // maxBytes: four ~4.5 MiB records fill the budget exactly; the fifth-newest
    // and everything older fall off even though maxRuns would keep them.
    const k2 = storeKey();
    const big = () => events(72, 64 * 1024 - 100);
    for (const [id, at] of [
      ["a", now - 1000],
      ["b", now - 2000],
      ["t1", now - 2500],
      ["t2", now - 2500],
    ] as const)
      await putDirect(k2, record(id, at, { events: big() }));
    await putDirect(k2, record("c", now - 3000, { events: events(1) }));
    await putDirect(k2, record("d", now - 4000, { events: events(1) }));
    const bytesOf = Object.fromEntries((await idsOnDisk(k2)).map((r) => [r.run_id, r.bytes]));
    const budget = bytesOf.a + bytesOf.b + bytesOf.t2 + bytesOf.t1;
    expect(budget).toBeGreaterThanOrEqual(16 * MIB); // above the policy floor, so the clamp does not widen it
    await setPolicy(k2, { retentionDays: 30, maxRuns: 100, maxBytes: budget });
    await agree(k2, ["a", "b", "t2", "t1"]);
    await setPolicy(k2, { retentionDays: 30, maxRuns: 100, maxBytes: budget - 1 });
    await agree(k2, ["a", "b", "t2"]);
  }, 120_000);

  it("after a maxRuns trim the evicted run's events are gone; a re-put with 3 events leaves 3 rows; a record outside policy is stored:false", async () => {
    const key = storeKey();
    const now = Date.now();
    const proposal = { policy: { retentionDays: 30, maxRuns: 2, maxBytes: 64 * MIB }, policyUpdatedAt: now };
    await putDirect(key, record("a", now - 3000, { events: events(4) }), proposal);
    await putDirect(key, record("b", now - 2000, { events: events(4) }));
    await putDirect(key, record("c", now - 1000, { events: events(4) }));
    expect(await rowCount(key, "runs")).toBe(2);
    expect(await rowCount(key, "run_events")).toBe(8);
    expect((await post("/runs/get", { storeKey: key, id: "a" })).data).toEqual({ record: null });
    const again = await putDirect(key, record("c", now - 1000, { events: events(3) }));
    expect(again).toEqual({ ok: true, retained: 2, stored: true, rewritten: true, emits: false });
    expect(await rowCount(key, "run_events")).toBe(7);
    const outside = await putDirect(key, record("older", now - 40 * DAY, { events: events(2) }));
    expect(outside).toEqual({ ok: true, retained: 2, stored: false, rewritten: false, emits: true });
    expect(await rowCount(key, "runs")).toBe(2);
  });

  it("a finishedAt one year ahead is clamped to now + 24 h and stored_at is recorded", async () => {
    const key = storeKey();
    const before = Date.now();
    await post("/runs/put", { storeKey: key, record: record("future", before + 365 * DAY) });
    const row = await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) =>
      state.storage.sql
        .exec<{ finished_at: number; stored_at: number }>(
          `SELECT finished_at, stored_at FROM runs WHERE run_id = 'future'`,
        )
        .one(),
    );
    expect(row.finished_at).toBeLessThanOrEqual(Date.now() + DAY);
    expect(row.finished_at).toBeGreaterThanOrEqual(before + DAY - 1);
    expect(row.stored_at).toBeGreaterThanOrEqual(before);
    const got = (await post("/runs/get", { storeKey: key, id: "future" })).data.record as RunRecord;
    expect(got.finishedAt).toBe(row.finished_at);
  });

  it("receivedAt and sealedAt a year ahead are clamped like finishedAt (docs/reference/specs/tracing.md)", async () => {
    const key = storeKey();
    const before = Date.now();
    const far = before + 365 * DAY;
    await post("/runs/put", { storeKey: key, record: record("stamps", before, { receivedAt: far, sealedAt: far }) });
    const got = (await post("/runs/get", { storeKey: key, id: "stamps" })).data.record as RunRecord;
    expect(got.receivedAt).toBeLessThanOrEqual(Date.now() + DAY);
    expect(got.sealedAt).toBeLessThanOrEqual(Date.now() + DAY);
    expect(got.receivedAt).toBeGreaterThanOrEqual(before + DAY - 1);
  });

  it("the alarm deletes expired rows with no writes, and get is then not-found", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", {
      storeKey: key,
      record: record("old", now - 20 * DAY),
      policy: { retentionDays: 30, maxRuns: 100, maxBytes: 64 * MIB },
      policyUpdatedAt: now,
    });
    await post("/runs/put", { storeKey: key, record: record("fresh", now) });
    // Tighten the policy so `old` is outside it — via the meta table, exactly
    // what a shrink would persist — without a put that would trim it.
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.policyState());
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE meta SET value = ? WHERE key = 'policy'`,
        JSON.stringify({ retentionDays: 5, maxRuns: 100, maxBytes: 64 * MIB, policyUpdatedAt: now }),
      );
    });
    expect(await rowCount(key, "runs")).toBe(2);
    expect(await runDurableObjectAlarm(stubOf(key))).toBe(true); // an alarm was scheduled by the first put
    expect(await rowCount(key, "runs")).toBe(1);
    expect(await rowCount(key, "run_events")).toBe(3);
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data).toEqual({ record: null });
    expect((await post("/runs/get", { storeKey: key, id: "fresh" })).data.record).not.toBeNull();
    expect(
      await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => state.storage.getAlarm()),
    ).not.toBeNull(); // rescheduled
  });

  it("body fence: 2 MiB cap on /runs/put (at cap ok, +1 byte 413) measured in bytes; other routes keep 512 KB; missing Content-Length → 411", async () => {
    const key = storeKey();
    const now = Date.now();
    const envelope = (rec: RunRecord) => JSON.stringify({ storeKey: key, record: rec });
    // Grow one event's summary until the body is exactly 2 MiB.
    const base = record("cap", now, { events: [{ type: "tool_call", tool: "bash", summary: "" }] });
    const pad = 2 * MIB - new TextEncoder().encode(envelope(base)).byteLength;
    const atCap = record("cap", now, { events: [{ type: "tool_call", tool: "bash", summary: "x".repeat(pad) }] });
    expect(new TextEncoder().encode(envelope(atCap)).byteLength).toBe(2 * MIB);
    expect((await post("/runs/put", envelope(atCap))).status).toBe(200);
    const over = record("cap", now, { events: [{ type: "tool_call", tool: "bash", summary: "x".repeat(pad + 1) }] });
    expect((await post("/runs/put", envelope(over))).status).toBe(413);
    // 1.9 MB of multibyte text: fewer chars than bytes, measured in bytes.
    const multi = record("multi", now, { events: [{ type: "tool_call", tool: "bash", summary: "é".repeat(950_000) }] });
    const multiBody = envelope(multi);
    expect(multiBody.length).toBeLessThan(1_000_000);
    expect(new TextEncoder().encode(multiBody).byteLength).toBeGreaterThan(1_900_000);
    expect((await post("/runs/put", multiBody)).status).toBe(200);
    expect(((await post("/runs/get", { storeKey: key, id: "multi" })).data.record as RunRecord).events[0]).toEqual({
      ...multi.events[0],
      seq: 1,
    }); // no seq given → position
    // other routes keep the 512 KB fence
    const bigList = JSON.stringify({ storeKey: key, agent: "x".repeat(600 * 1024) });
    expect((await post("/runs/list", bigList)).status).toBe(413);
    // missing Content-Length → 411 (a streamed body)
    const res = await fetchMemoryTest(`${BASE}/runs/put`, {
      method: "POST",
      headers: AUTH,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(envelope(base)));
          c.close();
        },
      }),
      // @ts-expect-error duplex is required for streamed request bodies
      duplex: "half",
    });
    expect(res.status).toBe(411);
  });

  it("validates: bad store key, malformed record, bad id, bad limit → 400; unknown route → 404; no bearer → 401; GET → 405", async () => {
    const key = storeKey();
    expect((await post("/runs/put", { storeKey: "has space", record: record("a", 1) })).status).toBe(400);
    expect((await post("/runs/put", { storeKey: key, record: { id: "a" } })).data).toEqual({
      error: "record must be a RunRecord",
    });
    expect((await post("/runs/get", { storeKey: key, id: "../x" })).status).toBe(400);
    expect((await post("/runs/events", { storeKey: key, id: "a", limit: 0 })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, limit: "5" })).status).toBe(400);
    expect((await post("/runs/nope", { storeKey: key })).status).toBe(404);
    expect((await post("/runs/get", { storeKey: key, id: "a" }, { "content-type": "application/json" })).status).toBe(
      401,
    );
    expect((await fetchMemoryTest(`${BASE}/runs/list`, { headers: AUTH })).status).toBe(405);
  });

  it("a corrupt event row is skipped: the run still returns with the remaining events", async () => {
    const key = storeKey();
    await post("/runs/put", { storeKey: key, record: record("a", Date.now(), { events: events(3) }) });
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE run_events SET json = '{not json' WHERE run_id = 'a' AND seq = 2`);
    });
    const got = (await post("/runs/get", { storeKey: key, id: "a" })).data.record as RunRecord;
    expect(got.events.map((e) => (e as { summary: string }).summary.slice(0, 6))).toEqual(["step 0", "step 2"]);
    const page = await post("/runs/events", { storeKey: key, id: "a" });
    expect((page.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 3]);
  });

  it("/healthz lists runs", async () => {
    const health = await fetchMemoryTest(`${BASE}/healthz`, undefined, (res) => res.json());
    expect(health).toEqual({
      ok: true,
      build: { commit: "unknown" },
      features: ["memory", "schedules", "runs", "config", "delivery", "costs", "plane", "installationReset:v1"],
    });
  });

  it("recovery evidence filters before the cap and attests only a complete valid set", async () => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    const noise = Array.from({ length: 205 }, (_, i) => record(`noise-${i}`, now - i, { threadKey: "slack:C1:noise" }));
    const relevant = [
      record("parent", now - 1000, {
        parentInstanceId: "original",
        idempotencyKey: "original:U99/0/coding",
        threadKey: "slack:C1:foreign",
      }),
      record("key", now - 2000, {
        parentInstanceId: "contradiction",
        idempotencyKey: "original:U12/0/coding",
        threadKey: "slack:C1:foreign",
      }),
      record("thread", now - 3000, { threadKey: "slack:C1:original" }),
      record("bare-key", now - 4000, {
        parentInstanceId: "contradiction",
        idempotencyKey: "original:U12",
        threadKey: "slack:C1:foreign",
      }),
    ];
    await putDirectMany(key, [
      ...noise,
      ...relevant,
      record("other-unit", now - 4000, {
        parentInstanceId: "other",
        idempotencyKey: "original:U120/0/coding",
        threadKey: "slack:C1:foreign",
      }),
      record("bare-neighbor", now - 5000, {
        parentInstanceId: "other",
        idempotencyKey: "original:U120",
        threadKey: "slack:C1:foreign",
      }),
    ]);
    const result = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(true);
    expect((result.data.items as RunRecord[]).map((row) => row.id)).toEqual(["parent", "key", "thread", "bare-key"]);
    const full = await post("/runs/list", { storeKey: key, limit: 2, recoveryEvidence });
    expect(full.data.evidenceComplete).toBe(false);
    for (const extra of [{ before: now }, { threadKey: "slack:C1:original" }, { visibleTo: { kind: "all" } }])
      expect((await post("/runs/list", { storeKey: key, recoveryEvidence, ...extra })).status).toBe(400);
    expect(
      (await post("/runs/list", { storeKey: key, recoveryEvidence: { ...recoveryEvidence, threadKeys: [] } })).status,
    ).toBe(400);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET summary_json = ? WHERE run_id = ?", "{broken", "parent");
    });
    const corrupt = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(corrupt.data.evidenceComplete).toBe(false);
  });

  it.each<{ label: string; corrupt: (row: RunRecord) => unknown }>([
    { label: "null", corrupt: () => null },
    { label: "a boolean", corrupt: () => true },
    { label: "a number", corrupt: () => 42 },
    { label: "a string", corrupt: () => "corrupt" },
    { label: "an array", corrupt: () => [] },
    { label: "an empty object", corrupt: () => ({}) },
    { label: "missing a required field", corrupt: (row) => ({ ...row, id: undefined }) },
    { label: "carrying a malformed optional field", corrupt: (row) => ({ ...row, headSha: "invalid" }) },
  ])("recovery evidence refuses a retained foreign-thread summary that is $label", async ({ corrupt }) => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    await putDirect(key, record("original", now, { threadKey: "slack:C1:original" }));
    const child = record("competing", now - 1000, {
      parentInstanceId: "original",
      idempotencyKey: "original:U12/0/coding",
      threadKey: "slack:C1:foreign",
    });
    await putDirect(key, child);
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      // Leave the SQL thread foreign and erase both JSON identity matches. Even
      // a plausible object must pass the record parser, not just json_valid.
      const summary = corrupt({ ...child, parentInstanceId: "other", idempotencyKey: "other:U12/0/coding" });
      state.storage.sql.exec("UPDATE runs SET summary_json = ? WHERE run_id = ?", JSON.stringify(summary), child.id);
    });
    const result = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(false);
    // Ordinary history still skips corrupt rows instead of failing the page.
    const ordinary = await post("/runs/list", { storeKey: key });
    expect((ordinary.data.items as RunRecord[]).map((row) => row.id)).toEqual(["original"]);
    expect(ordinary.data.evidenceComplete).toBeUndefined();
  });

  it("recovery evidence refuses a malformed context-pinned row beyond a retention gap", async () => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    await putDirectMany(key, [
      record("pinned-child", now - 3000, {
        parentInstanceId: "original",
        idempotencyKey: "original:U12/0/coding",
        threadKey: "slack:C1:foreign",
      }),
      record("evicted-middle", now - 2000),
      record("original", now - 1000, { threadKey: "slack:C1:original" }),
    ]);
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, retention_pin) VALUES (?, ?, 1)`,
        "original",
        "pinned-child",
      );
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify({ retentionDays: 30, maxRuns: 1, maxBytes: 64 * MIB, policyUpdatedAt: now }),
      );
    });
    const before = await post("/runs/list", { storeKey: key, recoveryEvidence });
    expect((before.data.items as RunRecord[]).map((row) => row.id)).toEqual(["original", "pinned-child"]);
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET summary_json = 'null' WHERE run_id = 'pinned-child'");
    });
    const result = await post("/runs/list", { storeKey: key, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(false);
  });

  it("recovery evidence refuses a malformed pinned source older than the age cutoff", async () => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    await putDirectMany(key, [
      record("old-source", now - 3 * DAY, { threadKey: "slack:C1:foreign" }),
      record("original", now - 1000, { threadKey: "slack:C1:original" }),
    ]);
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, retention_pin) VALUES (?, ?, 1)`,
        "original",
        "old-source",
      );
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify({ retentionDays: 1, maxRuns: 100, maxBytes: 64 * MIB, policyUpdatedAt: now }),
      );
    });
    const before = await post("/runs/list", { storeKey: key, recoveryEvidence });
    expect((before.data.items as RunRecord[]).map((row) => row.id)).toEqual(["original"]);
    expect(before.data.evidenceComplete).toBe(true);
    expect(((await post("/runs/get", { storeKey: key, id: "old-source" })).data.record as RunRecord).id).toBe(
      "old-source",
    );
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET summary_json = 'null' WHERE run_id = 'old-source'");
    });
    const result = await post("/runs/list", { storeKey: key, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(false);
  });

  it("recovery evidence refuses unreadable protected bytes beyond ordinary retention limits", async () => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    await putDirectMany(key, [
      record("original", now, { threadKey: "slack:C1:original" }),
      ...Array.from({ length: 205 }, (_, i) => record(`noise-${i}`, now - i, { threadKey: "slack:C1:noise" })),
      record("corrupt", now - 2 * DAY, { threadKey: "slack:C1:foreign" }),
    ]);
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET summary_json = 'null', bytes = ? WHERE run_id = 'corrupt'", 32 * MIB);
    });
    const result = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(false);
    // Ordinary limits cannot prove an unreadable record has no unsettled publication.
    for (const policy of [
      { retentionDays: 1, maxRuns: 5000, maxBytes: 64 * MIB },
      { retentionDays: 30, maxRuns: 206, maxBytes: 64 * MIB },
      { retentionDays: 30, maxRuns: 5000, maxBytes: 16 * MIB },
    ]) {
      await runInDurableObject(stubOf(key), async (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          JSON.stringify({ ...policy, policyUpdatedAt: now }),
        );
      });
      const retained = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
      expect(retained.status).toBe(200);
      expect(retained.data.evidenceComplete).toBe(false);
      expect(retained.data.items).toEqual([]);
      expect(await rowCount(key, "runs")).toBe(207);
    }
  });

  it("list: newest-first, limit 1000 → at most 200 rows plus a cursor; before/sinceMs/agent/channel/threadKey/parentRunId/pr filters; no events on the wire", async () => {
    const key = storeKey();
    const now = Date.now();
    await putDirectMany(
      key,
      Array.from({ length: 230 }, (_, i) =>
        record(`r${String(i).padStart(3, "0")}`, now - i * 1000, {
          events: events(1),
          agent: i % 2 ? "review" : "coding",
          channelId: i % 5 ? "slack:C1" : "slack:C2",
          threadKey: i % 7 ? "slack:C1:t1" : "slack:C1:t2",
          ...(i % 11 === 0 ? { parentRunId: "parent-x" } : {}),
          // run-history item 58: every 13th row names pull request 42 — a coding
          // run through its `pr`, a review through its posted target; the rows
          // between carry another number, another repository, or a skipped post.
          repo: i % 13 === 5 ? "acme/web" : "acme/api",
          ...(i % 13 === 0
            ? i % 2
              ? { reviewPost: { posted: true, target: { repo: "acme/api", number: 42 }, head: "a".repeat(40) } }
              : { pr: { number: 42, url: "https://github.com/acme/api/pull/42" } }
            : i % 13 === 5
              ? { pr: { number: 42, url: "https://github.com/acme/web/pull/42" } }
              : i % 13 === 7
                ? { reviewPost: { posted: false, reason: "head moved" } }
                : { pr: { number: 43, url: "https://github.com/acme/api/pull/43" } }),
        }),
      ),
    );
    const page = await post("/runs/list", { storeKey: key, limit: 1000 });
    const items = page.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(200);
    expect(items[0].id).toBe("r000");
    expect(items[0].events).toBeUndefined();
    expect(items[0].bytes).toBeGreaterThan(100);
    expect(page.data.nextBefore).toEqual({ finishedAt: items[199].finishedAt, id: items[199].id });
    const cursor = page.data.nextBefore as { finishedAt: number; id: string };
    const rest = await post("/runs/list", {
      storeKey: key,
      limit: 200,
      before: cursor.finishedAt,
      beforeId: cursor.id,
    });
    expect((rest.data.items as unknown[]).length).toBe(30);
    expect(rest.data.nextBefore).toBeUndefined();
    expect((await post("/runs/list", { storeKey: key })).data.items as unknown[]).toHaveLength(50);
    expect((await post("/runs/list", { storeKey: key, sinceMs: now - 2500 })).data.items as unknown[]).toHaveLength(3);
    const coding = (await post("/runs/list", { storeKey: key, agent: "coding", limit: 5 })).data.items as Array<{
      agent: string;
    }>;
    expect(coding).toHaveLength(5);
    expect(coding.every((r) => r.agent === "coding")).toBe(true);
    const c2 = (await post("/runs/list", { storeKey: key, channel: "slack:C2", limit: 5 })).data.items as Array<{
      channelId: string;
    }>;
    expect(c2.every((r) => r.channelId === "slack:C2")).toBe(true);
    // agent-conductor item 10: one thread's runs, newest first — the newest is `limit: 1`.
    const thread = (await post("/runs/list", { storeKey: key, threadKey: "slack:C1:t2", limit: 5 })).data
      .items as Array<{ id: string; threadKey: string }>;
    expect(thread).toHaveLength(5);
    expect(thread.every((r) => r.threadKey === "slack:C1:t2")).toBe(true);
    expect(thread[0].id).toBe("r000");
    const newest = (await post("/runs/list", { storeKey: key, threadKey: "slack:C1:t2", limit: 1 })).data
      .items as Array<{ id: string }>;
    expect(newest.map((r) => r.id)).toEqual(["r000"]);
    expect((await post("/runs/list", { storeKey: key, threadKey: "slack:C1:none" })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key, threadKey: 7 })).status).toBe(400);
    // run-history item 57: the runs one run spawned, newest first — a conductor's children as one listing.
    const children = (await post("/runs/list", { storeKey: key, parentRunId: "parent-x" })).data.items as Array<{
      id: string;
      parentRunId?: string;
    }>;
    expect(children).toHaveLength(21);
    expect(children.every((r) => r.parentRunId === "parent-x")).toBe(true);
    expect(children[0].id).toBe("r000");
    expect((await post("/runs/list", { storeKey: key, parentRunId: "parent-none" })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key, parentRunId: "not a run id!" })).status).toBe(400);
    // run-history item 58: the runs that name one pull request on one repository, newest first.
    const named = (await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number: 42 } })).data
      .items as Array<{ id: string; pr?: { number: number }; reviewPost?: { posted: boolean } }>;
    expect(named.map((r) => r.id)).toEqual(Array.from({ length: 18 }, (_, k) => `r${String(k * 13).padStart(3, "0")}`));
    expect(named.every((r) => r.pr?.number === 42 || r.reviewPost?.posted === true)).toBe(true);
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "acme/web", number: 42 } })).data.items).toHaveLength(
      18,
    );
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number: 99 } })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number: 0 } })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "not a slug", number: 42 } })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, pr: "acme/api#42" })).status).toBe(400);
  }, 60_000);

  it("a table created before the parent column gains it, filled from each record's own `parentRunId`, so a child stored earlier still lists under its parent; a later put writes the column beside the row", async () => {
    const key = storeKey();
    const now = Date.now();
    // Recreate the pre-column schema by hand: drop the index, then the column.
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP INDEX IF EXISTS runs_parent`);
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN parent_run_id`);
      const columns = state.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name);
      expect(columns).not.toContain("parent_run_id");
    });
    // Two rows written straight into the old shape: a child whose summary names its parent, and an orphan.
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      for (const rec of [
        record("legacy-child", now - 1000, { parentRunId: "parent-1" }),
        record("legacy-orphan", now - 2000),
      ]) {
        const { events: _e, ...summary } = rec;
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, channel_visibility, repo, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          summary.id,
          summary.label ?? null,
          summary.agent ?? null,
          summary.model ?? null,
          summary.channelId,
          summary.userId,
          summary.threadKey,
          summary.channelVisibility,
          null,
          summary.startedAt,
          summary.finishedAt,
          now,
          summary.status,
          0,
          0,
          0,
          100,
          JSON.stringify(summary.diagnosis),
          JSON.stringify(summary),
        );
      }
    });
    // The migration the DO applies at every construction.
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    const columnOf = () =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) =>
        state.storage.sql
          .exec<{ run_id: string; parent: string | null }>(
            `SELECT run_id, parent_run_id AS parent FROM runs ORDER BY run_id`,
          )
          .toArray(),
      );
    expect(await columnOf()).toEqual([
      { run_id: "legacy-child", parent: "parent-1" },
      { run_id: "legacy-orphan", parent: null },
    ]);
    const idsUnder = async (parent: string) =>
      ((await post("/runs/list", { storeKey: key, parentRunId: parent })).data.items as Array<{ id: string }>).map(
        (r) => r.id,
      );
    expect(await idsUnder("parent-1")).toEqual(["legacy-child"]);
    // Idempotent: a second construction changes nothing.
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    expect(await columnOf()).toHaveLength(2);
    // A put after the migration writes the column beside the row.
    const fresh = record("new-child", now - 500, { parentRunId: "parent-1", events: events(1) });
    expect((await post("/runs/put", { storeKey: key, record: fresh })).status).toBe(200);
    expect(await idsUnder("parent-1")).toEqual(["new-child", "legacy-child"]);
  });

  // run-history item 58: the pull request a run names is a column, so a
  // findings listing is one indexed page — filled once from `summary_json` for
  // rows written before the column, by the rule `pullRequestNumberOf` states.
  it("a table created before the pull request column gains it, filled from each record's own `pr` or posted review target — a skipped post and a run naming none stay null — so a run stored earlier still lists under its pull request; a later put writes the column beside the row", async () => {
    const key = storeKey();
    const now = Date.now();
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP INDEX IF EXISTS runs_pr`);
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN pr_number`);
      const columns = state.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name);
      expect(columns).not.toContain("pr_number");
    });
    const posted = { posted: true as const, target: { repo: "acme/api", number: 42 }, head: "b".repeat(40) };
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      for (const rec of [
        record("legacy-coding", now - 1000, {
          repo: "acme/api",
          pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
        }),
        record("legacy-review", now - 2000, { repo: "acme/api", reviewPost: posted }),
        record("legacy-skipped", now - 3000, { repo: "acme/api", reviewPost: { posted: false, reason: "head moved" } }),
        record("legacy-none", now - 4000, { repo: "acme/api" }),
      ]) {
        const { events: _e, ...summary } = rec;
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, channel_visibility, repo, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          summary.id,
          summary.label ?? null,
          summary.agent ?? null,
          summary.model ?? null,
          summary.channelId,
          summary.userId,
          summary.threadKey,
          summary.channelVisibility,
          summary.repo ?? null,
          summary.startedAt,
          summary.finishedAt,
          now,
          summary.status,
          0,
          0,
          0,
          100,
          JSON.stringify(summary.diagnosis),
          JSON.stringify(summary),
        );
      }
    });
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    const columnOf = () =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) =>
        state.storage.sql
          .exec<{ run_id: string; pr: number | null }>(`SELECT run_id, pr_number AS pr FROM runs ORDER BY run_id`)
          .toArray(),
      );
    expect(await columnOf()).toEqual([
      { run_id: "legacy-coding", pr: 42 },
      { run_id: "legacy-none", pr: null },
      { run_id: "legacy-review", pr: 42 },
      { run_id: "legacy-skipped", pr: null },
    ]);
    const idsNaming = async (number: number) =>
      (
        (await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number } })).data.items as Array<{
          id: string;
        }>
      ).map((r) => r.id);
    expect(await idsNaming(42)).toEqual(["legacy-coding", "legacy-review"]);
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    expect(await columnOf()).toHaveLength(4);
    const fresh = record("new-review", now - 500, { repo: "acme/api", reviewPost: posted, events: events(1) });
    expect((await post("/runs/put", { storeKey: key, record: fresh })).status).toBe(200);
    expect(await idsNaming(42)).toEqual(["new-review", "legacy-coding", "legacy-review"]);
  });

  it("/runs/summary returns the listing row (no events, with bytes) for a kept run and {summary: null} otherwise, reading no event rows", async () => {
    const key = storeKey();
    const now = Date.now();
    await putDirect(key, record("s1", now, { events: events(300) }));
    const res = await post("/runs/summary", { storeKey: key, id: "s1" });
    expect(res.status).toBe(200);
    const summary = res.data.summary as Record<string, unknown>;
    expect(summary.id).toBe("s1");
    expect(summary.eventCount).toBe(300);
    expect(summary.events).toBeUndefined();
    expect(summary.bytes).toBeGreaterThan(1000);
    expect((await post("/runs/summary", { storeKey: key, id: "nope" })).data).toEqual({ summary: null });
    expect((await post("/runs/summary", { storeKey: key, id: "../x" })).status).toBe(400);
    const statements = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      await inst.summary("s1");
      return seen;
    });
    expect(statements.some((q) => /run_events/.test(q))).toBe(false);
  });

  it("list fast path: within maxRuns/maxBytes the page is ONE LIMITed query with no retention scan; over a bound it falls back to the kept set with identical rows and order", async () => {
    const key = storeKey();
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await putDirect(
        key,
        record(`f${String(i).padStart(2, "0")}`, now - i * 1000, {
          events: events(1),
          agent: i % 2 ? "review" : "coding",
          channelId: i % 3 ? "slack:C1" : "slack:C2",
        }),
      );
    }
    const expectIds = async (q: Record<string, unknown>, ids: string[]) => {
      expect(
        ((await post("/runs/list", { storeKey: key, ...q })).data.items as Array<{ id: string }>).map((r) => r.id),
      ).toEqual(ids);
    };
    const all = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    // Fast path: the plan is one SELECT … LIMIT, and the retention scan never runs.
    const fast = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const res = await inst.list({ limit: 5, agent: "coding" });
      return { seen, ids: res.items.map((r) => r.id), next: res.nextBefore };
    });
    expect(fast.ids).toEqual(["f00", "f02", "f04", "f06", "f08"]);
    expect(fast.next).toEqual({ finishedAt: now - 8000, id: "f08" });
    expect(fast.seen.filter((q) => /FROM runs/.test(q) && /ORDER BY finished_at ASC/.test(q))).toEqual([]);
    const page = fast.seen.filter((q) => /ORDER BY finished_at DESC/.test(q));
    expect(page).toHaveLength(1);
    expect(page[0]).toMatch(/LIMIT \?/);
    expect(page[0]).toMatch(/agent = \?/);
    await expectIds({ limit: 200 }, all);
    await expectIds({ channel: "slack:C2" }, ["f00", "f03", "f06", "f09"]);
    await expectIds({ limit: 3, before: now - 2000, beforeId: "f02" }, ["f03", "f04", "f05"]);
    await expectIds({ sinceMs: now - 2500 }, ["f00", "f01", "f02"]);

    // Slow path: a policy the rows exceed (written straight into meta so they stay on disk).
    await runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify({
          retentionDays: 30,
          maxRuns: 7,
          maxBytes: 8 * 1024 * 1024 * 1024,
          policyUpdatedAt: Date.now(),
        }),
      );
    });
    const slow = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const res = await inst.list({ limit: 200 });
      return { seen, ids: res.items.map((r) => r.id) };
    });
    expect(slow.ids).toEqual(all.slice(0, 7));
    expect(slow.seen.some((q) => /ORDER BY finished_at ASC/.test(q))).toBe(true);
    await expectIds({ agent: "review", limit: 200 }, ["f01", "f03", "f05"]);
    await expectIds({ limit: 3, before: now - 2000, beforeId: "f02" }, ["f03", "f04", "f05"]);
    await expectIds({ limit: 200, before: now - 5000, beforeId: "f05" }, ["f06"]);
    // get agrees with list on what is hidden, so the two paths hide the same rows.
    expect((await post("/runs/get", { storeKey: key, id: "f07" })).data).toEqual({ record: null });
    expect(((await post("/runs/get", { storeKey: key, id: "f06" })).data.record as { id: string }).id).toBe("f06");
  });

  it("a sparse filtered page with only unpinned context rows avoids the full retention scan", async () => {
    const key = storeKey();
    const now = Date.now();
    await putDirect(key, record("recent", now - 1000));
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, ordinary_member, retention_pin, ordinary_pin)
         VALUES (?, ?, 1, 0, 0)`,
        "recent",
        "recent",
      );
    });
    const result = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const page = await inst.list({ limit: 5, agent: "coding" });
      return { seen, page };
    });
    expect(result.page.items).toEqual([]);
    expect(result.seen.some((q) => /ORDER BY finished_at ASC/.test(q))).toBe(false);
  });

  it("a full recent page stays bounded when an older source has a retention pin, and the next page still finds that source", async () => {
    const key = storeKey();
    const now = Date.now();
    await putDirectMany(key, [
      record("old-source", now - 3 * DAY, { channelId: "slack:C2" }),
      record("recent-2", now - 2000),
      record("recent-1", now - 1000),
    ]);
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, retention_pin) VALUES (?, ?, 1)`,
        "recent-1",
        "old-source",
      );
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify({ retentionDays: 1, maxRuns: 100, maxBytes: 64 * MIB, policyUpdatedAt: now }),
      );
    });
    const first = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const page = await inst.list({ limit: 2, visibleTo: { kind: "channels-in", channelIds: ["slack:C1"] } });
      return { seen, page };
    });
    expect(first.page.items.map((row) => row.id)).toEqual(["recent-1", "recent-2"]);
    expect(first.page.nextBefore).toEqual({ finishedAt: now - 2000, id: "recent-2" });
    expect(first.seen.some((q) => /ORDER BY finished_at ASC/.test(q))).toBe(false);
    expect(first.seen.some((q) => /SELECT holder_run_id, source_run_id, session_key FROM context_refs/.test(q))).toBe(
      false,
    );
    const second = await post("/runs/list", {
      storeKey: key,
      limit: 2,
      before: first.page.nextBefore?.finishedAt,
      beforeId: first.page.nextBefore?.id,
    });
    expect((second.data.items as Array<{ id: string }>).map((row) => row.id)).toEqual(["old-source"]);
  });

  it("repo complement filters match point and wire semantics in SQLite and reject malformed complements", async () => {
    const key = storeKey();
    const now = Date.now();
    for (const [id, repo] of [
      ["open", "ACME/OPEN"],
      ["closed", "Acme/Closed"],
      ["missing", undefined],
    ] as const) {
      await putDirect(key, record(id, now - 1000, { events: events(1), ...(repo ? { repo } : {}) }));
    }
    const ids = async (visibleTo: unknown) => {
      const res = await post("/runs/list", { storeKey: key, visibleTo });
      expect(res.status).toBe(200);
      return (res.data.items as Array<{ id: string }>).map((r) => r.id).sort();
    };
    expect(await ids({ kind: "repos-not-in", repos: ["ACME/CLOSED"] })).toEqual(["open"]);
    expect(await ids({ kind: "repos-not-in", repos: [] })).toEqual(["closed", "open"]);
    expect(await ids({ kind: "repos-in", repos: ["acme/open"] })).toEqual(["open"]);
    expect(
      await ids({
        kind: "and",
        of: [
          { kind: "repos-not-in", repos: ["acme/closed"] },
          { kind: "repos-in", repos: ["ACME/OPEN", "acme/closed"] },
        ],
      }),
    ).toEqual(["open"]);
    for (const repos of ["all", [""], Array.from({ length: 95 }, (_, i) => `acme/r${i}`)]) {
      expect((await post("/runs/list", { storeKey: key, visibleTo: { kind: "repos-not-in", repos } })).status).toBe(
        400,
      );
    }
  });

  it("list with `visibleTo` (authorization.md item 6): channels-in compiles to an indexed IN filter on the ONE LIMITed page query; visibility-in / user-is / or / and follow the same truth table as the in-memory store; none is an empty page; a bad filter is 400, never `all`", async () => {
    const key = storeKey();
    const now = Date.now();
    await putDirect(
      key,
      record("pub", now - 1000, {
        events: events(1),
        channelId: "slack:C_PUB",
        userId: "slack:UALICE",
        channelVisibility: "public",
      }),
    );
    await putDirect(
      key,
      record("priv", now - 2000, {
        events: events(1),
        channelId: "slack:G1",
        userId: "slack:UBOB",
        channelVisibility: "private",
      }),
    );
    await putDirect(
      key,
      record("ops", now - 3000, {
        events: events(1),
        channelId: "http:ops",
        userId: "http:ci",
        channelVisibility: "machine",
      }),
    );
    await putDirect(
      key,
      record("dev", now - 4000, {
        events: events(1),
        channelId: "mcp:dev",
        userId: "mcp:ci",
        channelVisibility: "machine",
      }),
    );
    const ids = async (visibleTo: unknown, more: Record<string, unknown> = {}) => {
      const res = await post("/runs/list", { storeKey: key, visibleTo, ...more });
      expect(res.status).toBe(200);
      return (res.data.items as Array<{ id: string }>).map((r) => r.id);
    };
    expect(await ids({ kind: "all" })).toEqual(["pub", "priv", "ops", "dev"]);
    expect(await ids({ kind: "none" })).toEqual([]);
    expect(await ids({ kind: "channels-in", channelIds: ["http:ops", "mcp:dev"] })).toEqual(["ops", "dev"]);
    expect(await ids({ kind: "channels-in", channelIds: [] })).toEqual([]);
    expect(await ids({ kind: "visibility-in", visibilities: ["public"] })).toEqual(["pub"]);
    expect(await ids({ kind: "user-is", userId: "slack:UBOB" })).toEqual(["priv"]);
    // member-of as the compiler emits it for a token granted http:ops, plus its own runs.
    expect(
      await ids({
        kind: "or",
        of: [
          { kind: "channels-in", channelIds: ["http:ops"] },
          { kind: "visibility-in", visibilities: ["public"] },
          { kind: "user-is", userId: "http:ci" },
        ],
      }),
    ).toEqual(["pub", "ops"]);
    expect(
      await ids({
        kind: "and",
        of: [
          { kind: "channels-in", channelIds: ["slack:G1"] },
          { kind: "user-is", userId: "slack:UBOB" },
        ],
      }),
    ).toEqual(["priv"]);
    expect(
      await ids({
        kind: "and",
        of: [
          { kind: "channels-in", channelIds: ["slack:G1"] },
          { kind: "user-is", userId: "slack:UALICE" },
        ],
      }),
    ).toEqual([]);
    // ANDed with the plain filters and the cursor.
    expect(
      await ids({ kind: "channels-in", channelIds: ["http:ops", "mcp:dev", "slack:C_PUB"] }, { channel: "mcp:dev" }),
    ).toEqual(["dev"]);
    expect(
      await ids(
        { kind: "channels-in", channelIds: ["http:ops", "mcp:dev", "slack:C_PUB"] },
        { before: now - 1000, beforeId: "pub" },
      ),
    ).toEqual(["ops", "dev"]);
    // The plan: ONE indexed page query carrying the IN, no retention scan.
    const plan = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const res = await inst.list({
        limit: 5,
        visibleTo: {
          kind: "or",
          of: [
            { kind: "channels-in", channelIds: ["http:ops"] },
            { kind: "visibility-in", visibilities: ["public"] },
          ],
        },
      });
      return { seen, ids: res.items.map((r) => r.id) };
    });
    expect(plan.ids).toEqual(["pub", "ops"]);
    expect(plan.seen.filter((q) => /FROM runs/.test(q) && /ORDER BY finished_at ASC/.test(q))).toEqual([]);
    const page = plan.seen.filter((q) => /ORDER BY finished_at DESC/.test(q));
    expect(page).toHaveLength(1);
    expect(page[0]).toMatch(/channel_id IN \(\?\)/);
    expect(page[0]).toMatch(/channel_visibility IN \(\?\)/);
    expect(page[0]).toMatch(/LIMIT \?/);
    // Malformed or too wide → 400 with the field named; nothing widens to `all`.
    expect((await post("/runs/list", { storeKey: key, visibleTo: { kind: "everything" } })).status).toBe(400);
    expect(
      (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["everyone"] } }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/runs/list", {
          storeKey: key,
          visibleTo: { kind: "channels-in", channelIds: Array.from({ length: 95 }, (_, i) => `c${i}`) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/list", {
          storeKey: key,
          visibleTo: { kind: "channels-in", channelIds: Array.from({ length: 90 }, (_, i) => `c${i}`) },
        })
      ).status,
    ).toBe(200);
  });

  it("a table created before the visibility stamp gains the column with `unknown` for every existing row (the one migration), and a record put without the stamp reads back as `unknown` — never public", async () => {
    const key = storeKey();
    const now = Date.now();
    // Recreate the pre-stamp schema by hand: drop the column, then reconstruct the DO to run the migration.
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP INDEX IF EXISTS runs_visibility_finished`);
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN channel_visibility`);
      const columns = state.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name);
      expect(columns).not.toContain("channel_visibility");
    });
    // A row written straight into the old shape (as a pre-migration DO would have left it).
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const { events: _e, channelVisibility: _v, ...summary } = record("legacy", now - 1000);
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, repo, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        summary.id,
        summary.label ?? null,
        summary.agent ?? null,
        summary.model ?? null,
        summary.channelId,
        summary.userId,
        summary.threadKey,
        null,
        summary.startedAt,
        summary.finishedAt,
        now,
        summary.status,
        0,
        0,
        0,
        100,
        JSON.stringify(summary.diagnosis),
        JSON.stringify(summary),
      );
      // Simulate the next constructor run: the migration the DO applies on load.
      const cols = new Set(
        state.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(runs)`)
          .toArray()
          .map((c) => c.name),
      );
      if (!cols.has("channel_visibility"))
        state.storage.sql.exec(`ALTER TABLE runs ADD COLUMN channel_visibility TEXT NOT NULL DEFAULT 'unknown'`);
    });
    const listed = (await post("/runs/list", { storeKey: key })).data.items as Array<{
      id: string;
      channelVisibility?: string;
    }>;
    expect(listed.map((r) => r.id)).toEqual(["legacy"]);
    expect(
      await runInDurableObject(
        stubOf(key),
        async (_i: RunHistoryDO, state) =>
          state.storage.sql
            .exec<{ v: string }>(`SELECT channel_visibility AS v FROM runs WHERE run_id = 'legacy'`)
            .one().v,
      ),
    ).toBe("unknown");
    expect(
      (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["public"] } })).data
        .items,
    ).toEqual([]);
    expect(
      (
        (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["unknown"] } }))
          .data.items as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual(["legacy"]);
    // A put without the stamp (an older bot) stores `unknown` too.
    const { channelVisibility: _cv, ...unstamped } = record("unstamped", now - 500, { events: events(1) });
    expect((await post("/runs/put", { storeKey: key, record: unstamped })).status).toBe(200);
    expect(
      await runInDurableObject(
        stubOf(key),
        async (_i: RunHistoryDO, state) =>
          state.storage.sql
            .exec<{ v: string }>(`SELECT channel_visibility AS v FROM runs WHERE run_id = 'unstamped'`)
            .one().v,
      ),
    ).toBe("unknown");
    // And a stamped put is stored as stamped and filterable.
    await post("/runs/put", {
      storeKey: key,
      record: record("stamped", now - 200, { events: events(1), channelVisibility: "public" }),
    });
    expect(
      (
        (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["public"] } }))
          .data.items as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual(["stamped"]);
  });

  it("delete removes the run and all its events; deleting an unknown id is fine", async () => {
    const key = storeKey();
    await post("/runs/put", { storeKey: key, record: record("a", Date.now(), { events: events(4) }) });
    await post("/runs/put", { storeKey: key, record: record("b", Date.now(), { events: events(2) }) });
    expect((await post("/runs/delete", { storeKey: key, id: "a" })).data).toEqual({ ok: true, deleted: true });
    expect(await rowCount(key, "run_events")).toBe(2);
    expect((await post("/runs/get", { storeKey: key, id: "a" })).data).toEqual({ record: null });
    expect((await post("/runs/list", { storeKey: key })).data.items as Array<{ id: string }>).toHaveLength(1);
    expect((await post("/runs/delete", { storeKey: key, id: "a" })).data).toEqual({ ok: true, deleted: false });
  });
});

// docs/reference/specs/orchestration-plane.md — the decider inside the object
// (record 0064; orchestration-plane items 6–8): the tables exist, `transactionSync` commits state and
// effects together, the shadow outcome post is logged beside the decider's
// decision, every heartbeat and reclaim answer carries `effects`, and an ack
// of an unknown id is a no-op.
describe("orchestration plane — the tables, the decider, shadow and the effects", () => {
  const claimBody = (key: string, runId: string, threadKey: string, gen = "g1") => ({
    storeKey: key,
    run: {
      runId,
      threadKey,
      gen,
      leaseMs: LEASE_MS,
      startedAt: 1_000,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
      card: null,
      system: "you review",
      tools: [],
    },
  });

  const ask = (runId: string, threadKey: string) =>
    ({
      kind: "ask",
      at: 1_000,
      runId,
      requester: "slack:UBOB",
      threadKey,
      stage: "admission",
      request: { text: "next" },
    }) as const;

  it("a fresh object holds the plane's seven tables", async () => {
    const key = storeKey();
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const names = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plane_%' ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);
      expect(names).toEqual([
        "plane_effects",
        "plane_endings",
        "plane_findings",
        "plane_levels",
        "plane_queue",
        "plane_reservations",
        "plane_windows",
      ]);
    });
  });

  it("planeApply commits the queue row, then the seal's admitted state and its effect, together in transactionSync", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO, state) => {
      // The claim's live row makes the thread live: the ask queues, no effect.
      const queued = inst.planeApply(ask("q1", "slack:C1:1.0"));
      expect(queued.effects).toEqual([]);
      const rows = () =>
        state.storage.sql.exec<{ run_id: string; state: string }>(`SELECT run_id, state FROM plane_queue`).toArray();
      expect(rows()).toEqual([{ run_id: "q1", state: "waiting" }]);
      // The seal admits the oldest waiting row; its state flip and the offered
      // effect land in the same transaction, so both are visible together.
      const sealed = inst.planeApply({ kind: "sealed", at: 2_000, threadKey: "slack:C1:1.0" });
      expect(sealed.effects).toEqual([
        { id: "admit:q1", kind: "admit", runId: "q1", threadKey: "slack:C1:1.0", request: { text: "next" } },
      ]);
      expect(rows()).toEqual([{ run_id: "q1", state: "admitted" }]);
      const offered = state.storage.sql
        .exec<{ id: string; acked_at: number | null }>(`SELECT id, acked_at FROM plane_effects`)
        .toArray();
      expect(offered).toEqual([{ id: "admit:q1", acked_at: null }]);
    });
  });

  it("two child_sealed findings on one subject merge into ONE plane_findings row, the first filed_at kept", async () => {
    const key = storeKey();
    // A seal with a pushed branch, no pull request, no live runner and no known
    // repository degrades to a finding (orphaned_child) instead of guessing.
    const sealed = (at: number) =>
      ({ kind: "child_sealed", at, runId: "r1", runnerLive: false, branch: "fix/x" }) as const;
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO, state) => {
      expect(inst.planeApply(sealed(1_000)).effects).toEqual([]);
      const rows = () =>
        state.storage.sql
          .exec<{ id: string; watch: string; subject: string; timeline_json: string; filed_at: number }>(
            `SELECT id, watch, subject, timeline_json, filed_at FROM plane_findings`,
          )
          .toArray();
      const first = rows();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        id: "orphaned_child#r1",
        watch: "orphaned_child",
        subject: "r1",
        filed_at: 1_000,
      });
      // The second observation is absorbed: still one row, timeline of two,
      // the first-seen stamp kept — the DO-side merge, not a second row.
      expect(inst.planeApply(sealed(2_000)).effects).toEqual([]);
      const merged = rows();
      expect(merged).toHaveLength(1);
      expect(merged[0]!.filed_at).toBe(1_000);
      expect((JSON.parse(merged[0]!.timeline_json) as { at: number }[]).map((e) => e.at)).toEqual([1_000, 2_000]);
    });
  });

  it("shadow logs refused:thread-live beside queued for a second ask on a live thread, and persists nothing", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const r = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "refused:thread-live",
    });
    expect(r).toEqual({ status: 200, data: { ok: true, decider: "queued", agreed: true } });
    // Nothing runs — and nothing queues — from the decider under shadow (orchestration-plane item 8).
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      expect(state.storage.sql.exec(`SELECT run_id FROM plane_queue`).toArray()).toEqual([]);
    });
  });

  it("an agreeing proceeded post counts nothing; a proceeded post on a live thread bumps the per-condition disagreement count", async () => {
    const key = storeKey();
    const agreed = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C9:9.0",
      stage: "admission",
      outcome: "proceeded",
    });
    expect(agreed.data).toEqual({ ok: true, decider: "proceed", agreed: true });
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const disagreed = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "proceeded",
    });
    expect(disagreed.data).toEqual({ ok: true, decider: "queued", agreed: false });
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const row = state.storage.sql
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_disagreements'`)
        .toArray()[0]!;
      expect(JSON.parse(row.value)).toEqual({ thread_free: 1 });
    });
  });

  it("a proceeded post naming its own run id is judged with that live row excluded — no false disagreement", async () => {
    // The post is fired without an await, so it can arrive after the dispatch
    // it describes claimed the thread; the run's own claim must not read as
    // "thread live" when the post carries the run's id.
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const late = await post("/plane/outcome", {
      storeKey: key,
      runId: "r1",
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "proceeded",
    });
    expect(late.data).toEqual({ ok: true, decider: "proceed", agreed: true });
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const row = state.storage.sql
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_disagreements'`)
        .toArray();
      expect(row).toEqual([]);
    });
  });

  it("a heartbeat answer and a reclaim answer carry effects: [], present even with nothing offered", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    expect(beat.status).toBe(200);
    expect(beat.data.effects).toEqual([]);
    const swept = await post("/runs/reclaim", {
      storeKey: key,
      gen: "g2",
      leaseMs: LEASE_MS,
      now: Date.now() + 2 * LEASE_MS,
    });
    expect(swept.status).toBe(200);
    expect(swept.data.effects).toEqual([]);
  });

  it("an offered effect rides the heartbeat answer; deferred leaves it offered, done closes it, an unknown id is a no-op", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      inst.planeApply(ask("q1", "slack:C1:1.0"));
      inst.planeApply({ kind: "sealed", at: 2_000, threadKey: "slack:C1:1.0" });
    });
    const beat = () => post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    expect((await beat()).data.effects).toMatchObject([{ id: "admit:q1", kind: "admit" }]);
    // deferred: still offered on the next answer.
    expect((await post("/plane/ack", { storeKey: key, id: "admit:q1", outcome: "deferred" })).data).toEqual({
      ok: true,
    });
    expect((await beat()).data.effects).toMatchObject([{ id: "admit:q1" }]);
    // an unknown id is a no-op, never an error.
    expect((await post("/plane/ack", { storeKey: key, id: "admit:zz", outcome: "done" })).data).toEqual({ ok: true });
    expect((await beat()).data.effects).toMatchObject([{ id: "admit:q1" }]);
    // done closes it.
    expect((await post("/plane/ack", { storeKey: key, id: "admit:q1", outcome: "done" })).data).toEqual({ ok: true });
    expect((await beat()).data.effects).toEqual([]);
  });

  it("a bad stage, outcome word or ack word is 400 before any object call", async () => {
    const key = storeKey();
    const bad = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "kitchen",
      outcome: "proceeded",
    });
    expect(bad).toEqual({ status: 400, data: { error: "stage must be admission, runner or resident" } });
    const word = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "shrugged",
    });
    expect(word).toEqual({
      status: 400,
      data: { error: "outcome must be proceeded, refused:<code> or fell_cold:<token>" },
    });
    const ackWord = await post("/plane/ack", { storeKey: key, id: "admit:q1", outcome: "maybe" });
    expect(ackWord).toEqual({ status: 400, data: { error: "outcome must be done, skipped or deferred" } });
  });
});

// docs/reference/specs/run-metrics.md items 2–5: the state Worker writes one
// metrics point per run, after the commit, only when the row turned final —
// and behaves byte-identically without the binding, with no point, and when
// the sink throws. The pool's env has no RUN_METRICS binding, so the default
// sink is the NullSink; the recording and throwing sinks are installed on the
// live object, the coordinatorDouble pattern.
describe("run metrics — the point, the guard and the emission rule", () => {
  const claimBody = (key: string, runId: string, threadKey: string, gen = "g1") => ({
    storeKey: key,
    run: {
      runId,
      threadKey,
      gen,
      leaseMs: LEASE_MS,
      startedAt: 1_000,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
      card: null,
      system: "you review",
      tools: [],
    },
  });

  /** A RunMetricsSink double on the live object: records, or throws. */
  async function metricsDouble(key: string, behaviour: "record" | "throw" = "record"): Promise<RunMetricsPoint[]> {
    const written: RunMetricsPoint[] = [];
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      Object.defineProperty(inst, "metrics", {
        value: {
          write(p: RunMetricsPoint) {
            if (behaviour === "throw") throw new TypeError("dataset refused");
            written.push(p);
          },
        },
      });
    });
    return written;
  }

  const putDirectWithPoint = (key: string, rec: RunRecord, point?: RunMetricsPoint) =>
    runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.put(rec, undefined, point));

  it("a tombstone then the finish writes one point; a review-artifact rewrite and an identical retry write none more", async () => {
    const key = storeKey();
    const written = await metricsDouble(key);
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    // The start tombstone: provisional, no point beside it (pointOf answers undefined).
    const started = Date.now() - 60_000;
    const tombstone = record("r1", started, {
      status: "interrupted",
      provisional: true,
      startedAt: started,
      events: events(1),
      eventCount: 1,
      storedEventCount: 1,
    });
    expect(pointOf(tombstone)).toBeUndefined();
    await post("/runs/put", { storeKey: key, record: tombstone });
    expect(written).toHaveLength(0);
    // The finish replaces the tombstone: the row turns final, one point.
    const final = record("r1", Date.now() - 1_000);
    const point = pointOf(final)!;
    const fin = await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: final, point });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect(written).toHaveLength(1);
    expect(blobOf(written[0], "run id")).toBe("r1");
    expect(written[0].indexes).toEqual(["review"]);
    // The review artifact's whole-record rewrite (run-history item 44): rewritten, not turned final.
    const grown = { ...final, events: events(5), eventCount: 5, storedEventCount: 5 };
    expect(await putDirectWithPoint(key, grown, pointOf(grown))).toMatchObject({
      stored: true,
      rewritten: true,
      emits: false,
    });
    // The retry's landing: the same record again, still no second point.
    expect(await putDirectWithPoint(key, grown, pointOf(grown))).toMatchObject({
      stored: true,
      rewritten: false,
      emits: false,
    });
    expect(written).toHaveLength(1);
  });

  it("a plain put of an interrupted record over no row writes one point; one outside retention (stored: false) writes none", async () => {
    const key = storeKey();
    const written = await metricsDouble(key);
    const interrupted = record("lost", Date.now() - 1_000, { status: "interrupted" });
    expect(await putDirectWithPoint(key, interrupted, pointOf(interrupted))).toMatchObject({
      stored: true,
      emits: true,
    });
    expect(written).toHaveLength(1);
    // A record outside the 30-day window is written and trimmed in its own put: no point.
    const expired = record("expired", Date.now() - 40 * DAY);
    expect(await putDirectWithPoint(key, expired, pointOf(expired))).toMatchObject({
      stored: false,
      emits: true,
    });
    expect(written).toHaveLength(1);
  });

  it("a provisional put over a final row writes nothing: the row, its events and the sessions table stay, and no point lands", async () => {
    const key = storeKey();
    const written = await metricsDouble(key);
    const final = record("r1", Date.now() - 1_000, {
      session: { key: "slack:C1:1:review", seedFrom: 0, request: 0, range: { from: 1, to: 3 } },
    });
    expect(await putDirectWithPoint(key, final, pointOf(final))).toMatchObject({ stored: true, emits: true });
    expect(written).toHaveLength(1);
    const before = (await post("/runs/get", { storeKey: key, id: "r1" })).data.record;
    const sessionsBefore = await rowCount(key, "sessions");
    // A late provisional write (a drain upgrade racing the finish) is answered
    // stored and writes nothing (run-history item 27's store-side guard).
    const late = record("r1", final.startedAt, {
      status: "interrupted",
      provisional: true,
      startedAt: final.startedAt,
      events: events(6),
      eventCount: 6,
      storedEventCount: 6,
      session: { key: "slack:C1:9:review", seedFrom: 0, request: 0, range: "broken" },
    });
    expect(await putDirectWithPoint(key, late, pointOf(late))).toEqual({
      ok: true,
      retained: 1,
      stored: true,
      rewritten: false,
      emits: false,
    });
    expect((await post("/runs/get", { storeKey: key, id: "r1" })).data.record).toEqual(before);
    expect(await rowCount(key, "run_events")).toBe(final.events.length);
    expect(await rowCount(key, "sessions")).toBe(sessionsBefore);
    expect(written).toHaveLength(1);
  });

  it("a throwing sink leaves the JSON answers deep-equal to a recording run's and to a bindingless Worker's, and warns once with the run id", async () => {
    const recording = storeKey();
    const throwing = storeKey();
    const bare = storeKey(); // no double installed: the pool has no binding, so this is the NullSink
    const written = await metricsDouble(recording);
    await metricsDouble(throwing, "throw");
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
    try {
      const rec = record("r1", Date.now() - 1_000);
      const answers = await Promise.all(
        [recording, throwing, bare].map((key) =>
          post("/runs/put", { storeKey: key, record: rec, point: pointOf(rec) }),
        ),
      );
      expect(answers[0]).toEqual(answers[1]);
      expect(answers[0]).toEqual(answers[2]);
      // The wire answer is exactly today's put shape — turnedFinal stays internal.
      expect(answers[0].data).toEqual({ ok: true, retained: 1, stored: true, rewritten: false });
    } finally {
      console.warn = realWarn;
    }
    expect(written).toHaveLength(1);
    const metricWarns = warns.filter((w) => w.includes("[runs/metrics]"));
    expect(metricWarns).toHaveLength(1);
    expect(metricWarns[0]).toContain("r1");
    expect(metricWarns[0]).toContain("TypeError");
  });

  it("a twenty-column point is stored and written beside a sixteen-column one from an older writer", async () => {
    const key = storeKey();
    const written = await metricsDouble(key);
    const narrowRecord = record("r1", Date.now() - 2_000);
    const narrow = { ...pointOf(narrowRecord)!, blobs: pointOf(narrowRecord)!.blobs.slice(0, 16) };
    const wideRecord = record("r2", Date.now() - 1_000);
    const wide = pointOf(wideRecord)!;
    expect(wide.blobs).toHaveLength(20);
    expect((await post("/runs/put", { storeKey: key, record: narrowRecord, point: narrow })).status).toBe(200);
    expect((await post("/runs/put", { storeKey: key, record: wideRecord, point: wide })).status).toBe(200);
    expect(written.map((p) => p.blobs.length)).toEqual([16, 20]);
    expect(written.map((p) => blobOf(p, "run id"))).toEqual(["r1", "r2"]);
  });

  it("a malformed point is refused by name on put and finish, before any write", async () => {
    const key = storeKey();
    const bad = await post("/runs/put", {
      storeKey: key,
      record: record("r1", Date.now() - 1_000),
      point: { junk: 1 },
    });
    expect(bad).toEqual({ status: 400, data: { error: "point must be a RunMetricsPoint" } });
    expect((await post("/runs/get", { storeKey: key, id: "r1" })).data).toEqual({ record: null });
    await post("/runs/claim", claimBody(key, "r2", "slack:C1:2.0"));
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r2",
      gen: "g1",
      record: record("r2", Date.now() - 1_000),
      point: { junk: 1 },
    });
    expect(fin).toEqual({ status: 400, data: { error: "point must be a RunMetricsPoint" } });
  });

  it("features names the dataset only when the binding is present", () => {
    expect(featuresOf({}).filter((feature) => feature.startsWith("runMetrics:"))).toEqual([]);
    expect(
      featuresOf({
        RUN_METRICS: { writeDataPoint() {} } as AnalyticsEngineDataset,
        RUN_METRICS_DATASET: "swb_runs",
      }).filter((feature) => feature.startsWith("runMetrics:")),
    ).toEqual(["runMetrics:swb_runs"]);
  });

  // Record 0097, "Rows and columns": the review row, written by the store from
  // the record it committed, under the run row's emission decision.
  describe("the review row (record 0097)", () => {
    const reviewRecord = (id: string, finishedAt: number, over: Partial<RunRecord> = {}) =>
      record(id, finishedAt, {
        agent: "review",
        repo: "o/r",
        targetPr: 42,
        reviewHead: "a".repeat(40),
        verdict: {
          verdict: "request_changes",
          summary: "s",
          findings: [{ id: "F1", severity: "major", file: "a.ts", title: "t" }],
        },
        ...over,
      });

    it("a review run's terminal close writes its run row and its review row; a later write writes neither again", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const rec = reviewRecord("v1", Date.now() - 1_000);
      await putDirectWithPoint(key, rec, pointOf(rec));
      expect(written).toHaveLength(2);
      const [run, review] = written;
      expect(blobOf(run, "run id")).toBe("v1");
      expect(reviewBlobOf(review, "schema")).toBe("review-1");
      expect(reviewBlobOf(review, "pull request number")).toBe("42");
      expect(reviewBlobOf(review, "verdict")).toBe("changes_requested");
      expect(reviewDoubleOf(review, "major")).toBe(1);
      await putDirectWithPoint(key, rec, pointOf(rec));
      expect(written).toHaveLength(2);
    });

    it("a review row is written even when the client sent no run point, and not for a run without a verdict", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      await putDirectWithPoint(key, reviewRecord("v2", Date.now() - 1_000));
      expect(written.map((p) => p.blobs[0])).toEqual(["review-1"]);
      const plain = reviewRecord("v3", Date.now() - 1_000, { verdict: undefined });
      await putDirectWithPoint(key, plain, pointOf(plain));
      expect(written.map((p) => p.blobs[0])).toEqual(["review-1", "1"]);
    });

    it("the review row is the committed record's: a finish dated past the skew limit is written at the clamped time", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const future = Date.now() + 3 * DAY;
      const rec = reviewRecord("v5", future, { startedAt: future - 60_000, receivedAt: future - 61_000 });
      await putDirectWithPoint(key, rec);
      const stored = (await post("/runs/get", { storeKey: key, id: "v5" })).data.record as RunRecord;
      expect(stored.finishedAt).toBeLessThan(future);
      expect(reviewDoubleOf(written[0], "finished at")).toBe(stored.finishedAt);
      expect(reviewDoubleOf(written[0], "duration")).toBe(stored.finishedAt - stored.receivedAt!);
    });

    it("a throwing sink is counted by row kind and served on /runs/metrics-health", async () => {
      const key = storeKey();
      await metricsDouble(key, "throw");
      expect(await post("/runs/metrics-health", { storeKey: key })).toEqual({
        status: 200,
        data: { failedWrites: { run: 0, review: 0 } },
      });
      const rec = reviewRecord("v4", Date.now() - 1_000);
      await putDirectWithPoint(key, rec, pointOf(rec));
      expect(await post("/runs/metrics-health", { storeKey: key })).toEqual({
        status: 200,
        data: { failedWrites: { run: 1, review: 1 } },
      });
    });
  });

  // Record 0097, "The terminal close": a run's rows describe its terminal
  // close, written at most once, guarded by the emission latch.
  describe("the terminal close (record 0097)", () => {
    const restartingAt = (id: string, finishedAt: number, restartUntil: number) =>
      record(id, finishedAt, { status: "interrupted", restarting: true, restartUntil });

    it("a restarting close writes no point; the successor's terminal close under the same id writes the run's only one", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const closedAt = Date.now() - 60_000;
      const restarting = restartingAt("r1", closedAt, closedAt + 30_000);
      expect(await putDirectWithPoint(key, restarting, pointOf(restarting))).toMatchObject({
        stored: true,
        emits: false,
      });
      expect(written).toHaveLength(0);
      const terminal = record("r1", Date.now() - 1_000);
      expect(await putDirectWithPoint(key, terminal, pointOf(terminal))).toMatchObject({ stored: true, emits: true });
      expect(written).toHaveLength(1);
      expect(blobOf(written[0], "status")).toBe("completed");
      // A terminal retry, or a re-put after the latch, writes nothing more.
      expect(await putDirectWithPoint(key, terminal, pointOf(terminal))).toMatchObject({ emits: false });
      expect(written).toHaveLength(1);
    });

    it("a late restarting write never replaces a terminal row, and writes no point", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const terminal = record("r2", Date.now() - 1_000);
      await putDirectWithPoint(key, terminal, pointOf(terminal));
      const late = restartingAt("r2", Date.now() - 2_000, Date.now() + 60_000);
      expect(await putDirectWithPoint(key, late, pointOf(late))).toMatchObject({
        stored: true,
        rewritten: false,
        emits: false,
      });
      const got = (await post("/runs/get", { storeKey: key, id: "r2" })).data.record as RunRecord;
      expect(got.status).toBe("completed");
      expect(got.restarting).toBeUndefined();
      expect(written).toHaveLength(1);
    });

    it("a later stop never replaces a failed run's terminal close, and writes no point", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const failedAt = Date.now() - 60_000;
      const failed = record("r9", failedAt, {
        status: "failed",
        setup: { version: 1, requested: "resident", reason: "lost_other" },
      });
      await putDirectWithPoint(key, failed, pointOf(failed));
      expect(written).toHaveLength(1);
      for (const status of ["stopped_hard", "stopped_soft"] as const) {
        const stop = record("r9", Date.now() - 1_000, { status });
        expect(await putDirectWithPoint(key, stop, pointOf(stop))).toMatchObject({
          stored: true,
          rewritten: false,
          emits: false,
        });
      }
      const got = (await post("/runs/get", { storeKey: key, id: "r9" })).data.record as RunRecord;
      expect(got).toMatchObject({
        status: "failed",
        finishedAt: failedAt,
        setup: { version: 1, requested: "resident", reason: "lost_other" },
      });
      expect(written).toHaveLength(1);
      // A rewrite that keeps the terminal status (an identical retry, the
      // review artifact) still lands.
      const kept = record("r9", failedAt, {
        status: "failed",
        setup: { version: 1, requested: "resident", reason: "lost_other" },
        title: "rewritten",
      });
      await putDirectWithPoint(key, kept, pointOf(kept));
      expect(((await post("/runs/get", { storeKey: key, id: "r9" })).data.record as RunRecord).title).toBe("rewritten");
      expect(written).toHaveLength(1);
    });

    it("a stop still replaces an interrupted close, as when a same-id restart's successor is stopped", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const interrupted = record("r10", Date.now() - 60_000, { status: "interrupted" });
      await putDirectWithPoint(key, interrupted, pointOf(interrupted));
      const stoppedAt = Date.now() - 1_000;
      const stop = record("r10", stoppedAt, { status: "stopped_hard" });
      expect(await putDirectWithPoint(key, stop, pointOf(stop))).toMatchObject({ stored: true, rewritten: true });
      const got = (await post("/runs/get", { storeKey: key, id: "r10" })).data.record as RunRecord;
      expect(got).toMatchObject({ status: "stopped_hard", finishedAt: stoppedAt });
      // The run is counted once, at its first terminal close.
      expect(written).toHaveLength(1);
    });

    it("the sweep closes an unclaimed restart past its deadline as interrupted with restart_unclaimed, writing the run's one point", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const closedAt = Date.now() - 120_000;
      const restarting = restartingAt("r3", closedAt, closedAt + 60_000);
      await putDirectWithPoint(key, restarting, pointOf(restarting));
      expect(written).toHaveLength(0);
      expect(await runDurableObjectAlarm(stubOf(key))).toBe(true);
      expect(written).toHaveLength(1);
      expect(blobOf(written[0], "run id")).toBe("r3");
      expect(blobOf(written[0], "status")).toBe("interrupted");
      expect(blobOf(written[0], "error type")).toBe("restart_unclaimed");
      expect(blobOf(written[0], "outcome")).toBe("error");
      const got = (await post("/runs/get", { storeKey: key, id: "r3" })).data.record as RunRecord;
      expect(got).toMatchObject({ status: "interrupted", failure: { kind: "restart_unclaimed" } });
      expect(got.restarting).toBeUndefined();
      expect(got.restartUntil).toBeUndefined();
      // The latch holds: a later sweep or a terminal re-put writes nothing more.
      await runDurableObjectAlarm(stubOf(key));
      await putDirectWithPoint(key, got, pointOf(got));
      expect(written).toHaveLength(1);
    });

    it("a late tombstone over a restarting row writes nothing, so the sweep still closes the orphaned restart", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const closedAt = Date.now() - 120_000;
      const restarting = restartingAt("r8", closedAt, closedAt + 60_000);
      await putDirectWithPoint(key, restarting, pointOf(restarting));
      const started = closedAt - 60_000;
      const late = record("r8", started, { status: "interrupted", provisional: true, startedAt: started });
      expect(await putDirectWithPoint(key, late)).toMatchObject({ stored: true, rewritten: false, emits: false });
      const kept = (await post("/runs/get", { storeKey: key, id: "r8" })).data.record as RunRecord;
      expect(kept).toMatchObject({ restarting: true, restartUntil: closedAt + 60_000 });
      await runDurableObjectAlarm(stubOf(key));
      expect(written).toHaveLength(1);
      expect(blobOf(written[0], "error type")).toBe("restart_unclaimed");
      expect(blobOf(written[0], "outcome")).toBe("error");
    });

    it("the sweep leaves a restart alone before its deadline, and while a successor's live row holds the id", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const recent = restartingAt("r4", Date.now() - 1_000, Date.now() + 60_000);
      await putDirectWithPoint(key, recent, pointOf(recent));
      const closedAt = Date.now() - 120_000;
      const claimed = restartingAt("r5", closedAt, closedAt + 60_000);
      await putDirectWithPoint(key, claimed, pointOf(claimed));
      expect((await post("/runs/claim", claimBody(key, "r5", "slack:C1:5.0", "g2"))).status).toBe(200);
      await runDurableObjectAlarm(stubOf(key));
      expect(written).toHaveLength(0);
      for (const id of ["r4", "r5"])
        expect(((await post("/runs/get", { storeKey: key, id })).data.record as RunRecord).restarting).toBe(true);
    });

    it("rows a store wrote before the latch existed count as emitted unless provisional, so a later terminal rewrite writes no second point", async () => {
      const key = storeKey();
      const written = await metricsDouble(key);
      const terminal = record("r6", Date.now() - 1_000);
      await putDirectWithPoint(key, terminal, pointOf(terminal));
      expect(written).toHaveLength(1);
      const started = Date.now() - 60_000;
      await putDirectWithPoint(
        key,
        record("r7", started, { status: "interrupted", provisional: true, startedAt: started }),
      );
      await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => {
        const sql = (inst as unknown as { sql: SqlStorage }).sql;
        sql.exec(`ALTER TABLE runs DROP COLUMN metrics_emitted`);
        sql.exec(`ALTER TABLE runs DROP COLUMN restart_point_json`);
        inst.migrateRunsTable();
      });
      const grown = { ...terminal, events: events(3), eventCount: 3, storedEventCount: 3 };
      expect(await putDirectWithPoint(key, grown, pointOf(grown))).toMatchObject({ stored: true, emits: false });
      expect(written).toHaveLength(1);
      // A tombstone kept before the latch was never counted: its finish still is.
      const finished = record("r7", Date.now() - 500);
      expect(await putDirectWithPoint(key, finished, pointOf(finished))).toMatchObject({ emits: true });
      expect(written).toHaveLength(2);
    });
  });
});

describe("durable branch identity baseline", () => {
  it("restores private archived baseline before same-ID reservation and promotion and refuses replacement at claim or finish", async () => {
    const key = storeKey();
    const rec = record("same-baseline", Date.now(), { repo: "o/r", events: [] });
    const baseline = {
      version: 1 as const,
      binding: {
        runId: rec.id,
        requester: rec.userId,
        threadKey: rec.threadKey,
        repo: "o/r",
        branch: "plan/p/u1",
        base: "main",
        head: "a".repeat(40),
      },
      state: { kind: "known" as const, commits: [] },
    };
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO, state) => {
      const req = {
        runId: rec.id,
        threadKey: rec.threadKey,
        gen: "g1",
        leaseMs: LEASE_MS,
        startedAt: rec.startedAt,
        meta: { threadKey: rec.threadKey, channelId: rec.channelId, userId: rec.userId, repo: rec.repo },
        card: null,
        system: "coding",
        tools: [],
      };
      await inst.claim({ ...req, state: { branchIdentityBaseline: baseline } }, Date.now());
      await inst.finish(rec.id, "g1", rec);
      expect(await inst.claim({ ...req, gen: "g2", phase: "attaching", system: "" }, Date.now())).toMatchObject({
        ok: true,
        allocationAck: {
          version: 1,
          runId: rec.id,
          threadKey: rec.threadKey,
          gen: "g2",
          startedAt: rec.startedAt,
          allocation: null,
        },
      });
      expect((await inst.listLive())[0]!.state.branchIdentityBaseline).toEqual(baseline);
      state.storage.sql.exec("UPDATE live_runs SET state_json = '{}' WHERE run_id = ?", rec.id);
      expect(await inst.claim({ ...req, gen: "g2", phase: "attaching", system: "" }, Date.now())).toMatchObject({
        ok: true,
        allocationAck: {
          version: 1,
          runId: rec.id,
          threadKey: rec.threadKey,
          gen: "g2",
          startedAt: rec.startedAt,
          allocation: null,
        },
      });
      expect((await inst.listLive())[0]!.state.branchIdentityBaseline).toEqual(baseline);
      expect(
        await inst.claim({ ...req, gen: "g2", state: { binding: { backend: "sandbox" } } }, Date.now()),
      ).toMatchObject({
        ok: true,
        allocationAck: {
          version: 1,
          runId: rec.id,
          threadKey: rec.threadKey,
          gen: "g2",
          startedAt: rec.startedAt,
          allocation: null,
        },
      });
      expect((await inst.listLive())[0]!.state.branchIdentityBaseline).toEqual(baseline);
      const changed = { ...baseline, binding: { ...baseline.binding, head: "b".repeat(40) } };
      expect(await inst.setState(rec.id, "g2", { branchIdentityBaseline: changed })).toEqual({
        ok: false,
        reason: "fenced",
      });
      state.storage.sql.exec("UPDATE live_runs SET state_json = '{}' WHERE run_id = ?", rec.id);
      expect(await inst.setState(rec.id, "g2", { checklist: [] })).toEqual({ ok: true });
      expect((await inst.listLive())[0]!.state.branchIdentityBaseline).toEqual(baseline);
      state.storage.sql.exec(
        "UPDATE live_runs SET state_json = ? WHERE run_id = ?",
        JSON.stringify({ branchIdentityBaseline: changed }),
        rec.id,
      );
      await expect(inst.finish(rec.id, "g2", rec)).rejects.toThrow();
      expect((await inst.get(rec.id))!.branchIdentityBaseline).toEqual(baseline);
      state.storage.sql.exec(
        "UPDATE live_runs SET state_json = ? WHERE run_id = ?",
        JSON.stringify({ branchIdentityBaseline: baseline }),
        rec.id,
      );
      expect(await inst.finish(rec.id, "g2", rec)).toMatchObject({ ok: true });
      await expect(
        inst.claim({ ...req, gen: "g3", state: { branchIdentityBaseline: changed } }, Date.now()),
      ).rejects.toThrow();
      expect(await inst.listLive()).toEqual([]);
      for (const meta of [
        { ...req.meta, ref: "foreign" },
        { ...req.meta, baseRef: "foreign" },
      ])
        await expect(inst.claim({ ...req, gen: "g3", meta }, Date.now())).rejects.toThrow();
    });
  });

  it("fails closed on corrupt or foreign archived baseline before a same-ID claim", async () => {
    const key = storeKey();
    const rec = record("foreign-baseline", Date.now(), { repo: "o/r", events: [] });
    const baseline = {
      version: 1 as const,
      binding: {
        runId: rec.id,
        requester: rec.userId,
        threadKey: rec.threadKey,
        repo: "o/r",
        branch: "plan/p/u1",
        base: "main",
        head: "a".repeat(40),
      },
      state: { kind: "unknown" as const },
    };
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO, state) => {
      const req = {
        runId: rec.id,
        threadKey: rec.threadKey,
        gen: "g1",
        leaseMs: LEASE_MS,
        startedAt: rec.startedAt,
        meta: { threadKey: rec.threadKey, channelId: rec.channelId, userId: rec.userId, repo: rec.repo },
        card: null,
        system: "coding",
        tools: [],
      };
      await inst.claim({ ...req, state: { branchIdentityBaseline: baseline } }, Date.now());
      await inst.finish(rec.id, "g1", rec);
      await expect(
        inst.claim({ ...req, gen: "g2", meta: { ...req.meta, userId: "foreign" } }, Date.now()),
      ).rejects.toThrow();
      expect(await inst.listLive()).toEqual([]);
      state.storage.sql.exec(
        "UPDATE runs SET work_evidence_json = ? WHERE run_id = ?",
        JSON.stringify({ version: 1, branchIdentityBaseline: { version: 1 } }),
        rec.id,
      );
      await expect(inst.claim({ ...req, gen: "g2" }, Date.now())).rejects.toThrow();
      expect(await inst.listLive()).toEqual([]);
    });
  });

  it("keeps another live run's baseline out of a conflicting new claim", async () => {
    const key = storeKey();
    const rec = record("original-baseline", Date.now(), { repo: "o/r", events: [] });
    const baseline = {
      version: 1 as const,
      binding: {
        runId: rec.id,
        requester: rec.userId,
        threadKey: rec.threadKey,
        repo: "o/r",
        branch: "plan/p/u1",
        base: "main",
        head: "a".repeat(40),
      },
      state: { kind: "unknown" as const },
    };
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const req = {
        runId: rec.id,
        threadKey: rec.threadKey,
        gen: "g1",
        leaseMs: LEASE_MS,
        startedAt: rec.startedAt,
        meta: { threadKey: rec.threadKey, channelId: rec.channelId, userId: rec.userId, repo: rec.repo },
        card: null,
        system: "coding",
        tools: [],
      };
      await inst.claim({ ...req, state: { branchIdentityBaseline: baseline } }, Date.now());
      expect(await inst.claim({ ...req, runId: "other-run" }, Date.now())).toMatchObject({
        ok: false,
        reason: "thread-live",
      });
      expect((await inst.listLive())[0]!.state.branchIdentityBaseline).toEqual(baseline);
    });
  });

  it("keeps the acknowledged baseline through SQLite owner handoff and terminal storage without exposing commit bytes in summaries", async () => {
    const key = storeKey();
    const rec = record("baseline-run", Date.now(), { repo: "o/r", events: [] });
    const baseline = {
      version: 1 as const,
      binding: {
        runId: rec.id,
        requester: rec.userId,
        threadKey: rec.threadKey,
        repo: "o/r",
        branch: "plan/p/u1",
        base: "main",
        head: "a".repeat(40),
      },
      state: {
        kind: "known" as const,
        commits: [
          {
            sha: "b".repeat(40),
            author: { name: "inherited", email: "prior@example.test" },
            date: "2026-01-01T00:00:00Z",
            message: "private inherited commit",
          },
        ],
      },
    };
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      await inst.claim(
        {
          runId: rec.id,
          threadKey: rec.threadKey,
          gen: "g1",
          leaseMs: LEASE_MS,
          startedAt: rec.startedAt,
          meta: { threadKey: rec.threadKey, channelId: rec.channelId, userId: rec.userId, repo: rec.repo },
          card: null,
          system: "coding",
          tools: [],
        },
        Date.now(),
      );
      expect(
        await inst.setState(rec.id, "g1", {
          branchIdentityBaseline: { ...baseline, binding: { ...baseline.binding, runId: "foreign" } },
        }),
      ).toEqual({ ok: false, reason: "fenced" });
      expect(await inst.setState(rec.id, "g1", { branchIdentityBaseline: baseline })).toEqual({ ok: true });
      expect(
        await inst.setState(rec.id, "g1", {
          branchIdentityBaseline: { ...baseline, state: { kind: "known", commits: [] } },
        }),
      ).toEqual({ ok: false, reason: "fenced" });
      expect(await inst.setState(rec.id, "g1", { pushedBranch: "plan/p/u1" })).toEqual({ ok: true });
      await inst.handoff("g1", [rec.id]);
      const taken = await inst.reclaim("g2", Date.now(), LEASE_MS);
      expect(taken[0]!.row.state.branchIdentityBaseline).toEqual(baseline);
      expect(await inst.setState(rec.id, "g1", { branchIdentityBaseline: baseline })).toEqual({
        ok: false,
        reason: "fenced",
      });
      expect(await inst.setState(rec.id, "g2", { pushedBranch: "plan/p/u1" })).toEqual({ ok: true });
      expect(await inst.finish(rec.id, "g2", rec)).toMatchObject({ ok: true, stored: true });
      expect((await inst.get(rec.id))!.branchIdentityBaseline).toEqual(baseline);
    });
    for (const result of [
      await post("/runs/summary", { storeKey: key, id: rec.id }),
      await post("/runs/list", { storeKey: key }),
    ])
      expect(JSON.stringify(result.data)).not.toContain("private inherited commit");
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const row = state.storage.sql
        .exec<{ summary_json: string; work_evidence_json: string }>(
          "SELECT summary_json, work_evidence_json FROM runs WHERE run_id = ?",
          rec.id,
        )
        .one();
      expect(row.summary_json).not.toContain("branchIdentityBaseline");
      expect(JSON.parse(row.work_evidence_json)).toEqual({ version: 1, branchIdentityBaseline: baseline });
      state.storage.sql.exec(
        "UPDATE runs SET work_evidence_json = ? WHERE run_id = ?",
        JSON.stringify({
          version: 1,
          branchIdentityBaseline: { ...baseline, binding: { ...baseline.binding, requester: "foreign" } },
        }),
        rec.id,
      );
    });
    expect((await post("/runs/get", { storeKey: key, id: rec.id })).data.record).toBeNull();
  });
});

describe("retained source archive storage", () => {
  it("retains native GitHub task identity only in full records and refuses corrupt identity", async () => {
    const key = storeKey(),
      base = record("github-source-history", Date.now());
    const githubSource = {
      version: 1,
      source: { host: "github.com", appId: 11, installationId: 22 },
      repositoryId: 33,
      pullRequestId: 44,
      number: 42,
      head: { repositoryId: 33, ref: "private/source-branch", sha: "a".repeat(40) },
      baseRef: "main",
    };
    expect((await post("/runs/put", { storeKey: key, record: { ...base, targetPr: 42, githubSource } })).status).toBe(
      200,
    );
    expect(((await post("/runs/get", { storeKey: key, id: base.id })).data.record as RunRecord).githubSource).toEqual(
      githubSource,
    );
    for (const result of [
      await post("/runs/summary", { storeKey: key, id: base.id }),
      await post("/runs/list", { storeKey: key }),
    ]) {
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.data)).not.toContain("githubSource");
      expect(JSON.stringify(result.data)).not.toContain("private/source-branch");
    }
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(
        "UPDATE runs SET summary_json=json_set(summary_json, '$.githubSource.number', 43) WHERE run_id=?",
        base.id,
      );
    });
    expect((await post("/runs/get", { storeKey: key, id: base.id })).data.record).toBeNull();
  });
  it("retains orchestrator decisions in full records without exposing them in summaries", async () => {
    const key = storeKey(),
      base = record("orchestrator-history", Date.now());
    const orchestratorDecisions: NonNullable<RunRecord["orchestratorDecisions"]> = [
      {
        version: 1,
        id: JSON.stringify([base.id, "private-decision-call"]),
        owner: { runId: base.id, requesterId: base.userId, channelId: base.channelId, threadKey: base.threadKey },
        source: { kind: "request", messageId: "1.0", textHash: "a".repeat(64) },
        tool: "work_stop",
        targetHash: "b".repeat(64),
        inputHash: "c".repeat(64),
        contextHash: "d".repeat(64),
      },
    ];
    expect((await post("/runs/put", { storeKey: key, record: { ...base, orchestratorDecisions } })).status).toBe(200);
    expect(
      ((await post("/runs/get", { storeKey: key, id: base.id })).data.record as RunRecord).orchestratorDecisions,
    ).toEqual(orchestratorDecisions);
    for (const result of [
      await post("/runs/summary", { storeKey: key, id: base.id }),
      await post("/runs/list", { storeKey: key }),
    ]) {
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.data)).not.toContain("private-decision-call");
    }
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(
        "UPDATE runs SET summary_json = json_set(summary_json, '$.orchestratorDecisions[0].owner.requesterId', 'foreign') WHERE run_id = ?",
        base.id,
      );
    });
    expect((await post("/runs/get", { storeKey: key, id: base.id })).data.record).toBeNull();
  });

  it("keeps exact work-read evidence out of summaries and rejects corrupt private evidence", async () => {
    const key = storeKey(),
      base = record("work-evidence", Date.now());
    const workReads: NonNullable<RunRecord["workReads"]> = [
      {
        tool: "work_status",
        callId: "status-call",
        input: { actId: "private-work-act" },
        resultHash: "a".repeat(64),
        observation: {
          version: 1,
          actId: "private-work-act",
          instanceId: "instance",
          unit: "U11",
          attempt: 0,
          requesterId: base.userId,
          channelId: base.channelId,
          mainThreadKey: base.threadKey,
          snapshotHash: "b".repeat(64),
          observedAt: 1000,
        },
      },
    ];
    expect((await post("/runs/put", { storeKey: key, record: { ...base, workReads } })).status).toBe(200);
    expect(((await post("/runs/get", { storeKey: key, id: base.id })).data.record as RunRecord).workReads).toEqual(
      workReads,
    );
    for (const result of [
      await post("/runs/summary", { storeKey: key, id: base.id }),
      await post("/runs/list", { storeKey: key }),
    ])
      expect(JSON.stringify(result.data)).not.toContain("private-work-act");
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const row = state.storage.sql
        .exec<{ summary_json: string; work_evidence_json: string }>(
          "SELECT summary_json, work_evidence_json FROM runs WHERE run_id = ?",
          base.id,
        )
        .one();
      expect(row.summary_json).not.toContain("workReads");
      expect(JSON.parse(row.work_evidence_json)).toEqual({ version: 1, workReads });
      state.storage.sql.exec(
        "UPDATE runs SET work_evidence_json = ? WHERE run_id = ?",
        JSON.stringify({
          version: 1,
          workReads: [{ ...workReads[0], observation: { ...workReads[0].observation, requesterId: "foreign" } }],
        }),
        base.id,
      );
    });
    expect((await post("/runs/get", { storeKey: key, id: base.id })).data.record).toBeNull();
  });

  function archived(base: RunRecord): NonNullable<RunRecord["sourceReads"]> {
    const query = { resource: { repository: "acme/private" }, input: { query: "private archive query" } };
    return {
      version: 1,
      owner: {
        runId: base.id,
        requester: base.userId,
        agent: base.agent!,
        channelId: base.channelId,
        threadKey: base.threadKey,
      },
      recoverable: false,
      records: [
        {
          actionId: "action",
          callIds: ["call"],
          toolName: "reader",
          serverId: "server",
          connectionRevision: "v1",
          sessionId: "session",
          operationId: "read",
          operationRevision: "v1",
          query,
          phase: "settled",
          exposed: true,
          response: {
            version: 1,
            status: "succeeded",
            actionId: "action",
            operationId: "read",
            operationRevision: "v1",
            binding: {
              id: "binding",
              revision: "v1",
              subjectId: base.userId,
              sessionId: "session",
              ...query,
              expiresAt: "2030-01-01T00:00:00Z",
            },
            attempt: "completed",
            observedAt: "2026-01-01T00:00:00Z",
            truncation: "none",
            result: { body: "private archive body" },
          },
        },
      ],
    };
  }
  it("stores original bodies separately from summaries and validates them on full reads", async () => {
    const key = storeKey();
    const base = record("archive", Date.now());
    const sourceReads = archived(base);
    expect((await post("/runs/put", { storeKey: key, record: { ...base, sourceReads } })).status).toBe(200);
    expect(((await post("/runs/get", { storeKey: key, id: base.id })).data.record as RunRecord).sourceReads).toEqual(
      sourceReads,
    );
    for (const result of [
      await post("/runs/summary", { storeKey: key, id: base.id }),
      await post("/runs/list", { storeKey: key }),
    ]) {
      expect(JSON.stringify(result.data)).not.toContain("sourceReads");
      expect(JSON.stringify(result.data)).not.toContain("private archive");
    }
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const row = state.storage.sql
        .exec<{ summary_json: string; source_reads_json: string }>(
          `SELECT summary_json, source_reads_json FROM runs WHERE run_id = ?`,
          base.id,
        )
        .one();
      expect(row.summary_json).not.toContain("private archive");
      expect(JSON.parse(row.source_reads_json)).toEqual(sourceReads);
      state.storage.sql.exec(
        `UPDATE runs SET source_reads_json = ? WHERE run_id = ?`,
        JSON.stringify({ ...sourceReads, owner: { ...sourceReads.owner, runId: "foreign" } }),
        base.id,
      );
    });
    expect((await post("/runs/get", { storeKey: key, id: base.id })).data.record).toBeNull();
  });
  it("migrates legacy inline archives into the internal column without changing evidence", async () => {
    const key = storeKey();
    const base = record("legacy-archive", Date.now());
    const sourceReads = archived(base);
    await post("/runs/put", { storeKey: key, record: { ...base, sourceReads } });
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET summary_json = json_set(summary_json, '$.sourceReads', json(?)) WHERE run_id = ?`,
        JSON.stringify(sourceReads),
        base.id,
      );
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN source_reads_json`);
      inst.migrateRunsTable();
      inst.migrateRunsTable();
    });
    expect(((await post("/runs/get", { storeKey: key, id: base.id })).data.record as RunRecord).sourceReads).toEqual(
      sourceReads,
    );
    expect(JSON.stringify((await post("/runs/summary", { storeKey: key, id: base.id })).data)).not.toContain(
      "private archive",
    );
  });
});
