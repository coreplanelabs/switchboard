import { contextDependenciesHash, mergeContextDependencies } from "../../src/core/references/contextDependencies.ts";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fetchMemoryTest } from "./testFetch.ts";
import { testSessionSources } from "../../src/core/testing/slackReceipts.ts";
import { contextThreadSessionKey, threadSessionKey } from "../../src/core/runLedger/sessionLog.ts";
import { assembleTranscript } from "../../src/core/runLedger/transcript.ts";
import { storedTurnRow } from "../../src/core/runLedger/sessionLog.ts";
import { analyzeRunFriction } from "../../src/core/runFriction.ts";
import { LEASE_MS } from "../../src/core/runLedger/types.ts";
import type { CoordinatorInstance, CoordinatorUnit } from "../../src/core/coordinator/contract.ts";
import type { ChildHandoff } from "../../src/core/dispatch/handoff.ts";
import type { RunRecord } from "../../src/core/runRecord.ts";
import type { ContextDependencies } from "../../src/core/references/contextDependencies.ts";
import { sourceHash, type SessionSources } from "../../src/core/references/receipts.ts";
import { RunHistoryDO } from "./worker.ts";
import {
  ORDINARY_CONTEXT_HISTORY_RUNS,
  type CanonicalCheckpointSource,
  type ContextCheckpointReceipt,
} from "../../src/core/references/contextCheckpoint.ts";

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;
const post = async (path: string, body: unknown) => {
  const raw = JSON.stringify(body);
  return fetchMemoryTest(
    `https://memory.test${path}`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(raw).byteLength),
      },
      body: raw,
    },
    async (res) => ({ status: res.status, data: (await res.json()) as Record<string, unknown> }),
  );
};
const sql = <T extends Record<string, SqlStorageValue>>(key: string, query: string, ...args: unknown[]) =>
  runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), (_instance, state) =>
    state.storage.sql.exec<T>(query, ...args).toArray(),
  );
const record = (id: string, threadKey: string): RunRecord => ({
  id,
  threadKey,
  channelId: "slack:C1",
  userId: "slack:UALICE",
  channelVisibility: "public",
  startedAt: Date.now() - 2_000,
  finishedAt: Date.now() - 1_000,
  status: "completed",
  eventCount: 0,
  storedEventCount: 0,
  truncated: false,
  events: [],
  diagnosis: analyzeRunFriction([]),
});
const claim = (storeKey: string, runId: string, threadKey: string, meta: Record<string, unknown> = {}) =>
  post("/runs/claim", {
    storeKey,
    run: {
      runId,
      threadKey,
      gen: "g1",
      leaseMs: LEASE_MS,
      startedAt: Date.now(),
      meta: { agent: "coding", threadKey, channelId: "slack:C1", userId: "slack:UALICE", ...meta },
      card: null,
      system: "work",
      tools: [],
    },
  });
const session = (key: string, threadKey: string) => ({
  key,
  threadSession: threadSessionKey(threadKey),
  seedFrom: 0,
  request: 0,
  range: { from: 0, to: 0 },
});
const writeOne = async (key: string, runId: string) => {
  await post("/runs/session/owner", { key, runId, gen: "g1" });
  return post("/runs/session/write", {
    key,
    runId,
    gen: "g1",
    rows: [
      { idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "retained source" } }) },
    ],
    attachments: [],
  });
};

describe("unified sessions — durable owner and retention lifecycle", () => {
  it("acknowledges only exact committed unit input and keeps its private receipt immutable through adoption and finish", async () => {
    const id = unique(),
      storeKey = `runs:unit-seed-${id}`,
      threadKey = `slack:C1:${id}`,
      key = `${threadKey}:coding`;
    const coordinator = {
      parentInstanceId: "instance",
      coordinatorUnit: "U11",
      coordinatorAttempt: 0,
      idempotencyKey: "instance:U11/coding",
    };
    expect(
      (await claim(storeKey, "unit-child", threadKey, { ...coordinator, session: session(key, threadKey) })).data.ok,
    ).toBe(true);
    await writeOne(key, "unit-child");
    const data = (await post("/runs/session/read", { key, from: 0, to: 0 })).data;
    const receipt: NonNullable<RunRecord["unitSeedReceipt"]> = {
      version: 1,
      binding: { instanceId: "instance", unit: "U11", instanceAttempt: 0, idempotencyKey: coordinator.idempotencyKey },
      child: { runId: "unit-child", requester: "slack:UALICE", channelId: "slack:C1", threadKey },
      ownerGen: "g1",
      workBriefHash: "a".repeat(64),
      capsuleHash: "b".repeat(64),
      contractHash: "c".repeat(64),
      seed: {
        key,
        from: 0,
        through: 0,
        messagesHash: await sourceHash(
          assembleTranscript(data.rows as Parameters<typeof assembleTranscript>[0], [], 0),
        ),
        systemHash: await sourceHash("work"),
      },
      acknowledgedAt: Date.now(),
    };
    const save = (unitSeedReceipt: unknown, gen = "g1") =>
      post("/runs/state", {
        storeKey,
        runId: "unit-child",
        gen,
        state: { contextCheckpoint: { key, through: 0 }, unitSeedReceipt },
      });
    expect((await save(receipt)).data.ok).toBe(false);
    await post("/runs/step", {
      storeKey,
      runId: "unit-child",
      gen: "g1",
      record: {
        step: 0,
        seq: 0,
        turnIndex: 1,
        inFlight: [],
        inboxConsumedSeq: 0,
        remainingMs: 1000,
        turn: 0,
        iteration: 0,
      },
    });
    await post("/runs/state", {
      storeKey,
      runId: "unit-child",
      gen: "g1",
      state: { contextCheckpoint: { key, through: 0 } },
    });
    for (const invalid of [
      { ...receipt, ownerGen: "stale" },
      { ...receipt, child: { ...receipt.child, requester: "foreign" } },
      { ...receipt, seed: { ...receipt.seed, messagesHash: "f".repeat(64) } },
      { ...receipt, seed: { ...receipt.seed, systemHash: "f".repeat(64) } },
    ])
      expect((await save(invalid)).data.ok).toBe(false);
    expect((await save(receipt)).data.ok).toBe(true);
    expect((await save({ ...receipt, capsuleHash: "f".repeat(64) })).data.ok).toBe(false);
    expect(
      (
        await post("/runs/session/write", {
          key,
          gen: "g1",
          runId: "unit-child",
          rows: [
            { idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "rewritten" } }) },
          ],
          attachments: [],
        })
      ).data.ok,
    ).toBe(false);
    await sql(storeKey, "UPDATE live_runs SET owner_gen = 'g2' WHERE run_id = 'unit-child'");
    await post("/runs/session/owner", { key, runId: "unit-child", gen: "g2" });
    expect((await post("/runs/state", { storeKey, runId: "unit-child", gen: "g2", state: {} })).data.ok).toBe(true);
    expect(
      (
        await post("/runs/finish", {
          storeKey,
          runId: "unit-child",
          gen: "g2",
          record: { ...record("unit-child", threadKey), ...coordinator, session: session(key, threadKey) },
        })
      ).data.ok,
    ).toBe(true);
    expect(
      ((await post("/runs/get", { storeKey, id: "unit-child" })).data.record as RunRecord).unitSeedReceipt,
    ).toEqual(receipt);
    expect(JSON.stringify((await post("/runs/summary", { storeKey, id: "unit-child" })).data)).not.toContain(
      "unitSeedReceipt",
    );
  });

  it.each([false, true])(
    "explicit deletion keeps a live owner's events and context pins with a provisional record: %s",
    async (provisional) => {
      const id = unique();
      const storeKey = `runs:live-delete-${id}`;
      const threadKey = `slack:C1:${id}`;
      await claim(storeKey, "live", threadKey);
      await sql(
        storeKey,
        "INSERT INTO run_events (run_id, seq, json) VALUES (?, ?, ?)",
        "live",
        1,
        JSON.stringify({ type: "input", seq: 1, text: "private retained bytes" }),
      );
      await sql(
        storeKey,
        "INSERT INTO context_refs (holder_run_id, source_run_id, session_key, retention_pin) VALUES (?, ?, ?, ?)",
        "live",
        "source",
        `${threadKey}:coding`,
        1,
      );
      if (provisional)
        await post("/runs/put", { storeKey, record: { ...record("live", threadKey), provisional: true } });
      const before = await sql(storeKey, "SELECT * FROM run_events WHERE run_id = ?", "live");
      await post("/runs/delete", { storeKey, id: "live" });
      expect(await sql(storeKey, "SELECT * FROM run_events WHERE run_id = ?", "live")).toEqual(before);
      expect(await sql(storeKey, "SELECT retention_pin FROM context_refs WHERE holder_run_id = ?", "live")).toEqual([
        { retention_pin: 1 },
      ]);
      expect(await sql(storeKey, "SELECT owner_gen FROM live_runs WHERE run_id = ?", "live")).toEqual([
        { owner_gen: "g1" },
      ]);
    },
  );

  it("bounds 384 ordinary continuations across retention and reconstruction while frozen units keep their originals", async () => {
    const id = unique();
    const storeKey = `runs:bounded-${id}`,
      threadKey = `slack:C1:${id}`;
    const key = `${threadKey}:coding`,
      sharedKey = contextThreadSessionKey(threadKey);
    const stub = env.RUNS.get(env.RUNS.idFromName(storeKey));
    const started = Date.now() - 10_000,
      maxRuns = 4;
    const clean: ContextDependencies = { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] };
    let previous: ContextCheckpointReceipt | undefined;
    await post("/runs/put", { storeKey, record: record("external-reader", "slack:C1:external") });
    for (let turn = 0; turn < ORDINARY_CONTEXT_HISTORY_RUNS * 3; turn++) {
      const runId = `ordinary-${turn}`;
      const binding = { key, threadSession: sharedKey, seedFrom: turn, request: turn, range: { from: turn, to: turn } };
      expect((await claim(storeKey, runId, threadKey, { channelVisibility: "public", session: binding })).data.ok).toBe(
        true,
      );
      expect((await post("/runs/session/owner", { key, runId, gen: "g1" })).data.ok).toBe(true);
      const context = mergeContextDependencies(
        previous?.normalized ?? {
          ...clean,
          mcp: [{ runId: "external-reader", actionId: "read", callIds: ["call"], responseHash: "a".repeat(64) }],
        },
        { ...clean, origins: [{ runId, requester: "slack:UALICE", channelId: "slack:C1", threadKey }] },
      );
      const rows = [
        {
          idx: turn,
          part: 0,
          json: JSON.stringify({
            role: "user",
            part: { type: "text", text: `Summary of turn ${turn - 1}; preserve the original requirement.` },
          }),
        },
      ];
      expect(
        (
          await post("/runs/session/write", {
            storeKey,
            key,
            gen: "g1",
            sourceRunId: runId,
            sources: {
              ...testSessionSources({ channelId: "slack:C1", threadKey, userId: "slack:UALICE" }, []),
              context,
            },
            rows,
            attachments: [],
          })
        ).data.ok,
      ).toBe(true);
      expect(
        (
          await post("/runs/state", {
            storeKey,
            runId,
            gen: "g1",
            state: { contextDependencies: context, contextCheckpoint: { key, through: turn } },
          })
        ).data.ok,
      ).toBe(true);
      expect(
        (
          await post("/runs/step", {
            storeKey,
            runId,
            gen: "g1",
            record: {
              step: 0,
              seq: 0,
              turnIndex: 1,
              inFlight: [],
              inboxConsumedSeq: 0,
              remainingMs: 1000,
              turn: 0,
              iteration: 0,
            },
          })
        ).data.ok,
      ).toBe(true);
      const result = await post("/runs/session/checkpoint", {
        storeKey,
        key,
        runId,
        gen: "g1",
        expected: {
          beforeHash: await contextDependenciesHash(context),
          revision: context.revision,
          inputs: {
            transcriptHash: await sourceHash(assembleTranscript(rows, [], turn)),
            systemHash: await sourceHash("work"),
            notepadHash: await sourceHash(""),
          },
        },
      });
      expect(result.data.ok, `checkpoint ${turn}`).toBe(true);
      previous = result.data.receipt as ContextCheckpointReceipt;
      expect(previous.membershipCount).toBe(Math.min(turn + 1, ORDINARY_CONTEXT_HISTORY_RUNS));
      // Missing intermediate reports cannot keep an old ordinary root pinned forever.
      if (turn % 3 === 0 || turn === ORDINARY_CONTEXT_HISTORY_RUNS * 3 - 1)
        expect(
          (
            await post("/runs/session/append", {
              storeKey,
              key: sharedKey,
              rowId: runId,
              context: previous.normalized,
              rows: [
                {
                  part: 0,
                  json: JSON.stringify({
                    role: "assistant",
                    part: { type: "text", text: `answer ${turn}` },
                    context: previous.normalized,
                  }),
                },
              ],
            })
          ).data.ok,
        ).toBe(true);
      if (turn === 0) {
        const unit: CoordinatorUnit = {
          instanceId: `unit-${id}`,
          unit: "U11",
          slug: "frozen",
          branch: "plan/frozen",
          dependsOn: [],
          rounds: [],
          context: {
            version: 1,
            handoff: {
              version: 1,
              source: { runId, requester: "slack:UALICE", channelId: "slack:C1", threadKey },
              session: { key, from: 0, to: 0 },
              assets: [],
            },
          },
        };
        expect((await post("/runs/coordinator/units/put", { storeKey, units: [unit] })).data.ok).toBe(true);
      }
      expect(
        (
          await post("/runs/finish", {
            storeKey,
            runId,
            gen: "g1",
            policy: { maxRuns },
            policyUpdatedAt: Date.now(),
            record: {
              ...record(runId, threadKey),
              startedAt: started + turn,
              finishedAt: started + turn + 1,
              session: binding,
              contextDependencies: previous.normalized,
            },
          })
        ).data.stored,
      ).toBe(true);
      if (turn % 64 === 63) {
        expect((await post("/runs/session/read-tail", { key: sharedKey, maxBytes: 1 })).data.sources).toMatchObject({
          context: { status: "known", origins: [expect.anything()] },
        });
        await runDurableObjectAlarm(stub);
        const restored = await runInDurableObject(stub, async (_instance, state) =>
          new RunHistoryDO(state, env).readContextCheckpoint(runId),
        );
        expect(restored?.members).toHaveLength(Math.min(turn + 1, ORDINARY_CONTEXT_HISTORY_RUNS));
        expect(restored?.members?.[0]).toBe(runId);
        expect((await sql<{ n: number }>(storeKey, "SELECT COUNT(*) AS n FROM runs"))[0].n).toBeLessThanOrEqual(
          maxRuns + 2,
        );
        expect((await sql<{ n: number }>(storeKey, "SELECT COUNT(*) AS n FROM context_refs"))[0].n).toBeLessThanOrEqual(
          (maxRuns + 2) * (ORDINARY_CONTEXT_HISTORY_RUNS + 4),
        );
      }
    }
    expect((await post("/runs/get", { storeKey, id: "ordinary-1" })).data.record).toBeNull();
    expect((await post("/runs/get", { storeKey, id: "ordinary-0" })).data.record).not.toBeNull();
    expect((await post("/runs/get", { storeKey, id: "external-reader" })).data.record).not.toBeNull();
    const source = (await post("/runs/context-checkpoint", { storeKey, runId: "ordinary-383" })).data
      .source as CanonicalCheckpointSource;
    expect(source.members).toHaveLength(ORDINARY_CONTEXT_HISTORY_RUNS);
    expect(source.members).not.toContain("ordinary-0");
    expect(source.receipt?.normalized.mcp).toHaveLength(1);
    expect(JSON.stringify((await post("/runs/session/read", { key, from: 383, to: 383 })).data)).toContain(
      "Summary of turn 382",
    );
    expect(JSON.stringify((await post("/runs/session/read", { key, from: 0, to: 0 })).data)).toContain(
      "original requirement",
    );
    // Expiry preserves aliases; explicit deletion revokes them even after the archive expires.
    await post("/runs/delete", { storeKey, id: "ordinary-300" });
    expect((await post("/runs/context-checkpoint", { storeKey, runId: "ordinary-383" })).data.source).toBeNull();
  }, 60_000);

  it("commits an exact ordinary checkpoint, archives it after a broken tail, and rejects stale input seals", async () => {
    const id = unique();
    const storeKey = `runs:checkpoint-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = `${threadKey}:coding`;
    await claim(storeKey, "current", threadKey, { channelVisibility: "public", session: session(key, threadKey) });
    await writeOne(key, "current");
    const context: ContextDependencies = {
      version: 1,
      status: "known",
      revision: 0,
      origins: [{ runId: "current", requester: "slack:UALICE", channelId: "slack:C1", threadKey }],
      slack: [],
      mcp: [],
    };
    await post("/runs/session/write", {
      storeKey,
      key,
      gen: "g1",
      sourceRunId: "current",
      sources: { ...testSessionSources({ channelId: "slack:C1", threadKey, userId: "slack:UALICE" }, []), context },
      rows: [],
      attachments: [],
    });
    await post("/runs/state", {
      storeKey,
      runId: "current",
      gen: "g1",
      state: { contextDependencies: context, contextCheckpoint: { key, through: 0 } },
    });
    await post("/runs/step", {
      storeKey,
      runId: "current",
      gen: "g1",
      record: {
        step: 0,
        seq: 0,
        turnIndex: 1,
        inFlight: [],
        inboxConsumedSeq: 0,
        remainingMs: 1000,
        turn: 0,
        iteration: 0,
      },
    });
    await post("/runs/session/notepad/write", { key, gen: "g1", runId: "current", text: "seed note" });
    const data = (await post("/runs/session/read", { key, from: 0, to: 0 })).data;
    const expected = {
      beforeHash: await contextDependenciesHash(context),
      revision: 0,
      inputs: {
        transcriptHash: await sourceHash(
          assembleTranscript(data.rows as Parameters<typeof assembleTranscript>[0], [], 0),
        ),
        systemHash: await sourceHash("work"),
        notepadHash: await sourceHash("seed note"),
      },
    };
    const request = { storeKey, key, runId: "current", gen: "g1", expected };
    for (const field of ["transcriptHash", "systemHash", "notepadHash"] as const)
      expect(
        (
          await post("/runs/session/checkpoint", {
            ...request,
            expected: { ...expected, inputs: { ...expected.inputs, [field]: "f".repeat(64) } },
          })
        ).data.ok,
      ).toBe(false);
    const result = await post("/runs/session/checkpoint", request);
    expect(result.data).toMatchObject({ ok: true, receipt: { runId: "current", membershipCount: 1 } });
    const receipt = result.data
      .receipt as import("../../src/core/references/contextCheckpoint.ts").ContextCheckpointReceipt;
    expect((await post("/runs/session/checkpoint", request)).data.receipt).toEqual(receipt);
    // Durable state immediately after source installation but before the run commit.
    await sql(
      storeKey,
      "UPDATE live_runs SET state_json = ?, owner_gen = ? WHERE run_id = ?",
      JSON.stringify({
        contextDependencies: context,
        contextCheckpoint: { key, through: 0 },
        pendingContextCheckpoint: receipt,
      }),
      "g2",
      "current",
    );
    await post("/runs/session/owner", { key, runId: "current", gen: "g2" });
    expect((await post("/runs/context-checkpoint", { storeKey, runId: "current" })).data.source).toMatchObject({
      receipt,
      members: ["current"],
    });
    expect(
      (
        await post("/runs/state", {
          storeKey,
          runId: "current",
          gen: "g2",
          state: { contextCheckpointReceipt: { ...receipt, hash: "f".repeat(64) } },
        })
      ).data.ok,
    ).toBe(false);

    await sql(
      storeKey,
      "UPDATE live_runs SET state_json = ? WHERE run_id = ?",
      JSON.stringify({
        contextDependencies: context,
        contextCheckpoint: { key, through: 0 },
        pendingContextCheckpoint: receipt,
      }),
      "current",
    );
    await post("/runs/session/notepad/write", { key, gen: "g2", runId: "current", text: "seed note" });
    expect(
      await post("/runs/finish", {
        storeKey,
        runId: "current",
        gen: "g2",
        record: {
          ...record("current", threadKey),
          session: { ...session(key, threadKey), range: "broken" },
          contextDependencies: context,
        },
      }),
    ).toMatchObject({ status: 200, data: { ok: true } });
    expect((await post("/runs/context-checkpoint", { storeKey, runId: "current" })).data.source).toMatchObject({
      runId: "current",
      receipt,
      members: ["current"],
    });
    const listed = await post("/runs/list", { storeKey });
    expect(JSON.stringify(listed.data)).not.toContain("contextCheckpointReceipt");
    expect((await post("/runs/get", { storeKey, id: "current" })).data.record).toMatchObject({
      contextCheckpointReceipt: receipt,
    });
    await post("/runs/delete", { storeKey, id: "current" });
    expect((await post("/runs/context-checkpoint", { storeKey, runId: "current" })).data.source).toBeNull();
  });

  it.each([1, 2] as const)(
    "hash-verifies repository results before committing their source coverage (v%s)",
    async (version) => {
      const id = unique();
      const storeKey = `runs:unified-${id}`;
      const threadKey = `slack:C1:${id}`;
      const key = `${threadKey}:coding`;
      await claim(storeKey, "writer", threadKey, { session: session(key, threadKey) });
      await post("/runs/session/owner", { key, runId: "writer", gen: "g1" });
      const sources = {
        ...testSessionSources({ channelId: "slack:C1", userId: "slack:UALICE", threadKey }, []),
        context: {
          version,
          status: "known" as const,
          revision: 0,
          origins: [],
          slack: [],
          mcp: [],
          ...(version === 1
            ? { githubRepos: ["acme/api"] }
            : {
                executionGithub: [
                  {
                    runId: "writer",
                    callId: "read",
                    resultHash: await sourceHash("actual source"),
                    admissionHash: "a".repeat(64),
                  },
                ],
              }),
        },
      };
      await post("/runs/session/write", {
        storeKey,
        key,
        gen: "g1",
        sourceRunId: "writer",
        sources,
        rows: [],
        attachments: [],
      });
      const receipt = {
        version,
        runId: "writer",
        callId: "read",
        tool: "github_file",
        repos: ["acme/api"],
        resultHash: await sourceHash("actual source"),
        ...(version === 2 ? { admissionHash: "a".repeat(64), inputHash: await sourceHash({}) } : {}),
      };
      const rows = (idx: number, callId: string, content: string) => [
        {
          idx,
          part: 0,
          json: JSON.stringify({
            role: "assistant",
            part: { type: "tool_use", id: callId, name: "github_file", input: {} },
          }),
        },
        {
          idx: idx + 1,
          part: 0,
          json: JSON.stringify({
            role: "user",
            part: { type: "tool_result", toolUseId: callId, content },
            sourceResult: { ...receipt, callId },
          }),
        },
      ];
      await post("/runs/session/write", {
        key,
        gen: "g1",
        runId: "writer",
        rows: rows(0, "read", "actual source"),
        attachments: [],
      });
      expect((await post("/runs/session/read-tail", { key, maxBytes: 100_000 })).data).toMatchObject({
        sources: { context: { status: "known" } },
      });
      await post("/runs/session/write", {
        key,
        gen: "g1",
        runId: "writer",
        rows: rows(2, "changed", "different private bytes"),
        attachments: [],
      });
      expect((await post("/runs/session/read-tail", { key, maxBytes: 100_000 })).data).toMatchObject({
        sources: { context: { status: "unknown" } },
      });
    },
  );

  it("reads the exact keyed report after later appends and returns no bytes for a missing or trimmed entry", async () => {
    const key = contextThreadSessionKey(`slack:C1:${unique()}`);
    const json = storedTurnRow({ role: "assistant", text: "original report" });
    await post("/runs/session/append", { key, rowId: "report", rows: [{ part: 0, json }] });
    await post("/runs/session/append", {
      key,
      rowId: "later",
      rows: [{ part: 0, json: json.replace("original", "later") }],
    });
    expect((await post("/runs/session/entry", { key, rowId: "report" })).data.rows).toEqual([
      { idx: 0, part: 0, json },
    ]);
    expect((await post("/runs/session/entry", { key, rowId: "missing" })).data.rows).toBeNull();
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(key)), (_instance, state) => {
      state.storage.sql.exec(`UPDATE turns SET trimmed = 1 WHERE row_id = 'report'`);
    });
    expect((await post("/runs/session/entry", { key, rowId: "report" })).data.rows).toBeNull();
  });

  it("refuses a source-bearing shared append without the canonical source index", async () => {
    const key = contextThreadSessionKey(`slack:C1:${unique()}`);
    const context: ContextDependencies = {
      version: 1,
      status: "known",
      revision: 0,
      origins: [],
      slack: [],
      mcp: [{ runId: "source", actionId: "read", callIds: ["call"], responseHash: "a".repeat(64) }],
    };
    const result = await post("/runs/session/append", {
      key,
      rowId: "source",
      context,
      rows: [{ part: 0, json: storedTurnRow({ role: "assistant", text: "derived source", context }) }],
    });
    expect(result.data).toMatchObject({ ok: false, reason: "context-index-unavailable" });
    expect(result.data.contextSaved).toBeUndefined();
    expect((await post("/runs/session/tail", { key })).data.next).toBe(0);
  });

  it("pins a pending unit's live source through finish, a legacy ending and refused owner replacement", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const sourceKey = `${threadKey}:coding`;
    await claim(storeKey, "source", threadKey, { session: session(sourceKey, threadKey) });
    await writeOne(sourceKey, "source");
    const instance: CoordinatorInstance = {
      id: `ship-${id}`,
      kind: "ship",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey,
      repo: "acme/api",
      branch: "plan/context/unit",
      base: "main",
      plan: { id: "context" },
      merge: "person",
      createdAt: Date.now(),
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U11",
      slug: "context",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      context: {
        version: 1,
        handoff: {
          version: 1,
          source: { runId: "source", requester: "slack:UALICE", channelId: "slack:C1", threadKey },
          session: { key: sourceKey, from: 0, to: 0 },
          assets: [],
        },
      },
    };
    expect((await post("/runs/coordinator/units/put", { storeKey, units: [unit] })).data.ok).toBe(true);
    await post("/runs/finish", {
      storeKey,
      runId: "source",
      gen: "g1",
      record: { ...record("source", threadKey), session: session(sourceKey, threadKey) },
    });
    await sql(storeKey, "UPDATE runs SET finished_at = ? WHERE run_id = 'source'", Date.now() - 40 * 86_400_000);
    await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(storeKey)));
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).not.toBeNull();
    const { context: _context, ...rest } = unit;
    expect(
      (
        await post("/runs/coordinator/units/put", {
          storeKey,
          units: [{ ...rest, ending: { kind: "aborted", report: "stopped", at: Date.now() } }],
        })
      ).data.ok,
    ).toBe(true);
    await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(storeKey)));
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).not.toBeNull();
    expect(await post("/runs/coordinator/replace", { storeKey, instance })).toMatchObject({
      status: 409,
      data: { ok: false, reason: "exists" },
    });
    await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(storeKey)));
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).not.toBeNull();
    expect((await post("/runs/session/tail", { key: sourceKey })).data.next).toBeGreaterThan(0);
  });

  it("keeps a queued unit's frozen tool results until its canonical unit is removed", async () => {
    const id = unique();
    const storeKey = `runs:frozen-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = `${threadKey}:coding`;
    await claim(storeKey, "source", threadKey, { session: session(key, threadKey) });
    await post("/runs/session/owner", { key, runId: "source", gen: "g1", maxBytes: 100_000 });
    const content = "original evidence ".repeat(500);
    const write = (idx: number, text: string) =>
      post("/runs/session/write", {
        key,
        runId: "source",
        gen: "g1",
        attachments: [],
        rows: [
          {
            idx,
            part: 0,
            json: JSON.stringify({
              role: "user",
              part: { type: "tool_result", toolUseId: `tool-${idx}`, content: text },
            }),
          },
        ],
      });
    await write(0, content);
    const instance: CoordinatorInstance = {
      id: `ship-${id}`,
      kind: "ship",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey,
      repo: "acme/api",
      branch: "plan/context/unit",
      base: "main",
      plan: { id: "context" },
      merge: "person",
      createdAt: Date.now(),
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U11",
      slug: "context",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      context: {
        version: 1,
        handoff: {
          version: 1,
          source: { runId: "source", requester: "slack:UALICE", channelId: "slack:C1", threadKey },
          session: { key, from: 0, to: 0 },
          assets: [],
        },
      },
    };
    expect((await post("/runs/coordinator/units/put", { storeKey, units: [unit] })).data.ok).toBe(true);
    await post("/runs/session/owner", { key, runId: "source", gen: "g1", maxBytes: 1_000 });
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(key)), (_session, state) => {
      state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'max_bytes'`, "1000");
    });
    await write(1, "later result ".repeat(500));
    const read = async () =>
      (await post("/runs/session/read", { key, from: 0, to: 0 })).data.rows as { json: string }[];
    expect(JSON.parse((await read())[0]!.json).part.content).toBe(content);
    expect((await write(0, "changed original")).data.ok).toBe(false);
    expect((await post("/runs/coordinator/replace", { storeKey, instance })).data.ok).toBe(true);
    await write(2, "later result ".repeat(500));
    expect(JSON.parse((await read())[0]!.json).part.content).not.toBe(content);
    await expect(
      runInDurableObject(env.RUNS.get(env.RUNS.idFromName(storeKey)), (history: RunHistoryDO) =>
        history.putUnits([unit], Date.now()),
      ),
    ).rejects.toThrow("context source range is unavailable");
  });

  it("refuses a missing unit source atomically before storing its capsule", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const unit: CoordinatorUnit = {
      instanceId: `ship-${id}`,
      unit: "U11",
      slug: "context",
      branch: "plan/context/unit",
      dependsOn: [],
      rounds: [],
      context: {
        version: 1,
        handoff: {
          version: 1,
          source: { runId: "missing", requester: "slack:UALICE", channelId: "slack:C1", threadKey },
          session: { key: `${threadKey}:coding`, from: 0, to: -1 },
          assets: [],
        },
      },
    };
    const stub = env.RUNS.get(env.RUNS.idFromName(storeKey));
    await expect(
      runInDurableObject(stub, (instance: RunHistoryDO) => instance.putUnits([unit], Date.now())),
    ).rejects.toThrow("unit context source is unavailable");
    expect((await post("/runs/coordinator/units/list", { storeKey, instanceId: unit.instanceId })).data.units).toEqual(
      [],
    );
    await claim(storeKey, "missing", threadKey, { session: session(`${threadKey}:different`, threadKey) });
    await expect(
      runInDurableObject(stub, (instance: RunHistoryDO) => instance.putUnits([unit], Date.now())),
    ).rejects.toThrow("unit context source is unavailable");
    expect((await post("/runs/coordinator/units/list", { storeKey, instanceId: unit.instanceId })).data.units).toEqual(
      [],
    );
  });

  it("rejects a row context that diverges from the append metadata before storing either", async () => {
    const id = unique();
    const key = contextThreadSessionKey(`slack:C1:${id}`);
    const known: ContextDependencies = { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] };
    const unknown: ContextDependencies = { ...known, status: "unknown" };
    for (const context of [unknown, undefined]) {
      const result = await post("/runs/session/append", {
        key,
        rowId: "forged",
        context,
        rows: [{ part: 0, json: storedTurnRow({ role: "assistant", text: "unproved report", context: known }) }],
      });
      expect(result.data.ok).toBe(false);
      expect((await post("/runs/session/tail", { key })).data.next).toBe(0);
    }
  });

  it("pins shared conversation source archives until the conversation expires without recursive roots", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = contextThreadSessionKey(threadKey);
    await post("/runs/put", { storeKey, record: record("ancestor", threadKey) });
    const context = (runId: string): ContextDependencies => ({
      version: 1,
      status: "known",
      revision: 0,
      origins: [{ runId, requester: "slack:UALICE", channelId: "slack:C1", threadKey }],
      slack: [],
      mcp: [],
    });
    await post("/runs/put", {
      storeKey,
      record: { ...record("source", threadKey), contextDependencies: context("ancestor") },
    });
    const append = (rowId: string, dependencies = context("source")) =>
      post("/runs/session/append", {
        storeKey,
        key,
        rowId,
        context: dependencies,
        rows: [{ part: 0, json: storedTurnRow({ role: "assistant", text: "report", context: dependencies }) }],
      });
    expect((await append("report")).data.ok).toBe(true);
    await sql(storeKey, "UPDATE runs SET finished_at = ?", Date.now() - 40 * 86_400_000);
    await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(storeKey)));
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).not.toBeNull();
    expect((await post("/runs/get", { storeKey, id: "ancestor" })).data.record).toBeNull();
    await sql(storeKey, "UPDATE sessions SET last_finished_at = ? WHERE key = ?", Date.now() - 40 * 86_400_000, key);
    await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(storeKey)));
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).toBeNull();
    expect((await post("/runs/session/tail", { key })).data.next).toBe(0);
  });

  it("never recreates explicitly deleted sources when a shared report is replayed", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = contextThreadSessionKey(threadKey);
    await post("/runs/put", { storeKey, record: record("source", threadKey) });
    const context: ContextDependencies = {
      version: 1,
      status: "known",
      revision: 0,
      origins: [{ runId: "source", requester: "slack:UALICE", channelId: "slack:C1", threadKey }],
      slack: [],
      mcp: [],
    };
    const body = {
      storeKey,
      key,
      rowId: "report",
      context,
      rows: [{ part: 0, json: storedTurnRow({ role: "assistant", text: "report", context }) }],
    };
    await post("/runs/session/append", body);
    await post("/runs/delete", { storeKey, id: "source" });
    expect((await post("/runs/session/append", body)).data).toMatchObject({
      ok: false,
      appended: false,
      reason: "context-source-unavailable",
    });
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).toBeNull();
  });

  it("pins dependencies acquired after admission while the consuming run is live", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    await post("/runs/put", { storeKey, record: record("source", threadKey) });
    await claim(storeKey, "consumer", `${threadKey}:consumer`);
    const context: ContextDependencies = {
      version: 1,
      status: "known",
      revision: 1,
      origins: [{ runId: "source", requester: "slack:UALICE", channelId: "slack:C1", threadKey }],
      slack: [],
      mcp: [],
    };
    expect(
      (await post("/runs/state", { storeKey, runId: "consumer", gen: "g1", state: { contextDependencies: context } }))
        .status,
    ).toBe(200);
    await sql(storeKey, "UPDATE runs SET finished_at = ? WHERE run_id = 'source'", Date.now() - 40 * 86_400_000);
    await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(storeKey)));
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).not.toBeNull();
    await post("/runs/finish", {
      storeKey,
      runId: "consumer",
      gen: "g1",
      record: { ...record("consumer", `${threadKey}:consumer`), contextDependencies: context },
    });
    await post("/runs/delete", { storeKey, id: "consumer" });
    await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(storeKey)));
    expect((await post("/runs/get", { storeKey, id: "source" })).data.record).toBeNull();
  });
  it("preserves each explicit row context through replay with an unknown row between known rows", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const key = contextThreadSessionKey(`slack:C1:${id}`);
    const clean: ContextDependencies = { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] };
    const unknown: ContextDependencies = { ...clean, status: "unknown" };
    const append = (rowId: string, text: string, context: ContextDependencies) =>
      post("/runs/session/append", {
        storeKey,
        key,
        rowId,
        context,
        rows: [{ part: 0, json: storedTurnRow({ role: "assistant", text, context }) }],
      });
    expect((await append("first", "verified question", clean)).data.appended).toBe(true);
    await append("command", "complete command output", unknown);
    await append("last", "verified reply", clean);
    expect((await append("first", "verified question", clean)).data.appended).toBe(false);
    expect((await append("first", "verified question", unknown)).data.ok).toBe(false);
    const read = (await post("/runs/session/read-tail", { key, maxBytes: 100_000 })).data;
    expect(read).toMatchObject({ sources: { context: { status: "unknown" } } });
    const transcript = assembleTranscript(read.rows as Parameters<typeof assembleTranscript>[0], []);
    expect(transcript.messages.map((message) => message.content)).toEqual([
      [{ type: "text", text: "verified question" }],
      [{ type: "text", text: "complete command output" }],
      [{ type: "text", text: "verified reply" }],
    ]);
    expect(transcript.contexts).toEqual([clean, unknown, clean]);
  });

  it("starts a durable context epoch without rewriting unproved legacy rows", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const oldKey = threadSessionKey(threadKey);
    const key = contextThreadSessionKey(threadKey);
    const context: ContextDependencies = { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] };
    const append = (key: string, rowId: string, text: string, envelope?: ContextDependencies) =>
      post("/runs/session/append", {
        storeKey,
        key,
        rowId,
        rows: [
          { part: 0, json: JSON.stringify({ role: "user", actor: "slack:UALICE", part: { type: "text", text } }) },
        ],
        context: envelope,
      });
    await append(oldKey, "old", "unproved old text");
    await append(key, "fresh", "fresh request", context);
    // A new API call resolves the same durable key; no process-local epoch state.
    expect((await append(key, "fresh", "fresh request", context)).data.appended).toBe(false);
    expect((await post("/runs/session/read-tail", { key, maxBytes: 100_000 })).data).toMatchObject({
      sources: { context: { status: "known" } },
      rows: [{ idx: 0, part: 0 }],
    });
    expect((await post("/runs/session/read-tail", { key: oldKey, maxBytes: 100_000 })).data).toMatchObject({
      sources: { context: { status: "unknown" } },
      rows: [
        {
          idx: 0,
          part: 0,
          json: JSON.stringify({
            role: "user",
            actor: "slack:UALICE",
            part: { type: "text", text: "unproved old text" },
          }),
        },
      ],
    });
    expect(await sql(storeKey, "SELECT key, thread_key FROM sessions ORDER BY key")).toEqual([
      { key: oldKey, thread_key: threadKey },
      { key, thread_key: threadKey },
    ]);
  });

  it("keeps covered source results known and taints an uncovered result before exposure", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = `${threadKey}:coding:@context-v1`;
    await claim(storeKey, "writer", threadKey, { session: session(key, threadKey) });
    await post("/runs/session/owner", { key, runId: "writer", gen: "g1" });
    const sources = testSessionSources({ channelId: "slack:C1", threadKey, userId: "slack:UALICE" });
    sources.context = {
      version: 1,
      status: "known",
      revision: 0,
      origins: [],
      slack: [],
      mcp: [{ runId: "writer", actionId: "read", callIds: ["covered"], responseHash: "a".repeat(64) }],
    };
    expect(
      (
        await post("/runs/session/write", {
          storeKey,
          key,
          gen: "g1",
          sourceRunId: "writer",
          sources,
          rows: [],
          attachments: [],
        })
      ).data.ok,
    ).toBe(true);
    const rows = (callId: string, idx: number) => [
      {
        idx,
        part: 0,
        json: JSON.stringify({
          role: "assistant",
          part: { type: "tool_use", id: callId, name: "mcp__github__read", input: {} },
        }),
      },
      {
        idx: idx + 1,
        part: 0,
        json: JSON.stringify({
          role: "user",
          part: { type: "tool_result", toolUseId: callId, content: "external bytes" },
        }),
      },
    ];
    await post("/runs/session/write", { key, gen: "g1", runId: "writer", rows: rows("covered", 0), attachments: [] });
    expect((await post("/runs/session/read-tail", { key, maxBytes: 100_000 })).data).toMatchObject({
      sources: { context: { status: "known" } },
    });
    await post("/runs/session/write", { key, gen: "g1", runId: "writer", rows: rows("uncovered", 2), attachments: [] });
    expect((await post("/runs/session/read-tail", { key, maxBytes: 100_000 })).data).toMatchObject({
      sources: { context: { status: "unknown" } },
    });
  });

  it("accepts canonical lane sources only from its exact claimed requester and logical thread", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = `plan-${id}:unit:coding`;
    expect((await claim(storeKey, "child", threadKey, { session: session(key, threadKey) })).status).toBe(200);
    await post("/runs/session/owner", { key, runId: "child", gen: "g1" });
    const sources = testSessionSources({ channelId: "slack:C1", threadKey, userId: "slack:UALICE" });
    const write = (more: Record<string, unknown>) =>
      post("/runs/session/write", {
        storeKey,
        key,
        sourceRunId: "child",
        gen: "g1",
        sources,
        rows: [],
        attachments: [],
        ...more,
      });
    expect(await write({})).toMatchObject({ status: 200, data: { ok: true, sourcesSaved: true } });
    expect((await write({ sourceRunId: "other" })).status).toBe(409);
    expect((await write({ gen: "old" })).status).toBe(409);
    expect(
      (await write({ sources: testSessionSources({ channelId: "slack:C1", threadKey, userId: "slack:OTHER" }) }))
        .status,
    ).toBe(409);
    expect((await write({ storeKey: "runs:missing" })).status).toBe(409);
  });

  it("commits whole-context metadata with the row and never heals a missing append dependency", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = threadSessionKey(threadKey);
    await post("/runs/put", { storeKey, record: record("source", threadKey) });
    const context: ContextDependencies = {
      version: 1,
      status: "known",
      revision: 0,
      origins: [{ runId: "source", requester: "slack:UALICE", channelId: "slack:C1", threadKey }],
      slack: [],
      mcp: [],
    };
    const rows = [
      { part: 0, json: JSON.stringify({ role: "assistant", part: { type: "text", text: "derived report" } }) },
    ];
    const append = (rowId: string, input?: ContextDependencies) =>
      post("/runs/session/append", { storeKey, key, rowId, rows, context: input });
    expect((await append("report", context)).data).toMatchObject({ ok: true, appended: true });
    const read = async () =>
      (await post("/runs/session/read-tail", { key, maxBytes: 100_000 })).data.sources as SessionSources;
    expect((await read()).context).toMatchObject({ status: "known", origins: context.origins });
    expect((await append("report")).data).toMatchObject({ ok: false, appended: false });
    expect((await append("report", context)).data).toMatchObject({ ok: true, appended: false });
    expect((await read()).context?.status).toBe("known");
    expect(
      (
        await post("/runs/session/append", {
          storeKey,
          key,
          rowId: "report",
          rows: [{ part: 0, json: "changed" }],
          context,
        })
      ).data,
    ).toMatchObject({ ok: false, appended: false });
    await append("legacy");
    await append("next", context);
    expect((await read()).context).toMatchObject({ status: "unknown", origins: context.origins });
  });

  it("registers append-only thread logs and expires them after their last context holder retires", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = threadSessionKey(threadKey);
    expect(
      (
        await post("/runs/session/append", {
          storeKey,
          key,
          rowId: "connector",
          rows: [
            {
              part: 0,
              json: JSON.stringify({ role: "user", actor: "slack:UALICE", part: { type: "text", text: "question" } }),
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(await sql(storeKey, "SELECT key, thread_key FROM sessions")).toEqual([{ key, thread_key: threadKey }]);
    const stub = env.RUNS.get(env.RUNS.idFromName(storeKey));
    const candidates = [{ key, threadKey }];
    expect(await runInDurableObject(stub, (instance: RunHistoryDO) => instance.sweepSessions(candidates))).toBe(0);
    await sql(storeKey, "UPDATE sessions SET last_finished_at = ?", Date.now() - 40 * 86_400_000);
    expect(await runInDurableObject(stub, (instance: RunHistoryDO) => instance.sweepSessions(candidates))).toBe(1);
    expect((await post("/runs/session/tail", { key })).data).toEqual({ next: 0 });
  });

  it("registers working sessions under the logical conversation rather than a hosted occupancy key", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const threadKey = `slack:C1:${id}`;
    const key = `plan-${id}:unit:coding`;
    expect(
      (await claim(storeKey, "hosted", `host:${id}`, { threadKey, hosted: true, session: session(key, threadKey) }))
        .status,
    ).toBe(200);
    expect(await sql(storeKey, "SELECT key, thread_key FROM sessions WHERE key = ?", key)).toEqual([
      { key, thread_key: threadKey },
    ]);
  });

  it("pins existing source records and logs while a child is live or retained, then releases them", async () => {
    const id = unique();
    const storeKey = `runs:unified-${id}`;
    const parentThread = `slack:C1:parent-${id}`;
    const childThread = `slack:C1:child-${id}`;
    const parentKey = `${parentThread}:coding`;
    await writeOne(parentKey, "parent");
    expect(
      (
        await post("/runs/put", {
          storeKey,
          record: { ...record("parent", parentThread), session: session(parentKey, parentThread) },
        })
      ).status,
    ).toBe(200);
    const handoff: ChildHandoff = {
      version: 1,
      source: { runId: "parent", threadKey: parentThread, channelId: "slack:C1", requester: "slack:UALICE" },
      session: { key: parentKey, from: 0, to: 0 },
      assets: [],
    };
    expect((await claim(storeKey, "child", childThread, { childHandoff: handoff })).status).toBe(200);
    await sql(storeKey, "UPDATE runs SET finished_at = ? WHERE run_id = 'parent'", Date.now() - 40 * 86_400_000);
    const stub = env.RUNS.get(env.RUNS.idFromName(storeKey));
    await runDurableObjectAlarm(stub);
    expect((await post("/runs/get", { storeKey, id: "parent" })).data.record).not.toBeNull();
    expect((await post("/runs/session/tail", { key: parentKey })).data).toEqual({ next: 1 });
    expect(
      (
        await post("/runs/finish", {
          storeKey,
          runId: "child",
          gen: "g1",
          record: { ...record("child", childThread), childHandoff: handoff },
        })
      ).status,
    ).toBe(200);
    await runDurableObjectAlarm(stub);
    expect((await post("/runs/get", { storeKey, id: "parent" })).data.record).not.toBeNull();
    await post("/runs/delete", { storeKey, id: "child" });
    await runDurableObjectAlarm(stub);
    expect((await post("/runs/get", { storeKey, id: "parent" })).data.record).toBeNull();
    expect((await post("/runs/session/tail", { key: parentKey })).data).toEqual({ next: 0 });
  });
});
