import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { fetchMemoryTest } from "./testFetch.ts";
import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../src/core/runRecord.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";
import { LEASE_MS } from "../../src/core/runLedger/types.ts";
import type { CoordinatorInstance, CoordinatorUnit } from "../../src/core/coordinator/contract.ts";
import {
  checkpointKey,
  type PublicationBinding,
  type PublicationSettlement,
} from "../../src/core/publicationSettlement.ts";
import { PRIVATE_WORKER_REPLY_MAX_CHARS } from "../../src/core/privateWorkerLog.ts";
import { assertNoPendingBackgroundTasks } from "./backgroundTasks.ts";
import type { RunHistoryDO, SessionLogDO } from "./worker.ts";

describe("run ledger — alarm retention of live events", () => {
  it("abandon syncs only range pins touched by the abandoned run", async () => {
    const key = storeKey();
    const runId = "abandon-pin-owner";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:abandon-pin-owner"))).toMatchObject({
      status: 200,
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO sessions (key, thread_key) VALUES (?, ?)`,
        "slack:C1:unrelated:review",
        "slack:C1:unrelated",
      );
      const touched = "slack:C1:abandon-pin-owner:review";
      const source = "slack:C1:abandon-pin-source:review";
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, session_key) VALUES (?, ?, ?)`,
        runId,
        runId,
        touched,
      );
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, session_key) VALUES (?, ?, ?)`,
        "another-holder",
        runId,
        source,
      );
      const subject = instance as unknown as { syncRangePins: (keys?: readonly string[]) => Promise<void> };
      const sync = subject.syncRangePins;
      const calls: Array<readonly string[] | undefined> = [];
      subject.syncRangePins = async (keys) => {
        calls.push(keys);
      };
      try {
        expect(await instance.abandon(runId, "g1")).toEqual({ ok: true });
      } finally {
        subject.syncRangePins = sync;
      }
      expect(calls).toEqual([[touched, source]]);
    });
  });

  it("abandon without range pins does not sweep other session logs", async () => {
    const key = storeKey();
    const runId = "abandon-without-pins";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:abandon-without-pins"))).toMatchObject({
      status: 200,
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (instance: RunHistoryDO) => {
      const subject = instance as unknown as { syncRangePins: (keys?: readonly string[]) => Promise<void> };
      const sync = subject.syncRangePins;
      subject.syncRangePins = async () => {
        throw new Error("unrelated range pins swept");
      };
      try {
        expect(await instance.abandon(runId, "wrong-generation")).toEqual({ ok: false, reason: "fenced" });
        expect(await instance.abandon(runId, "g1")).toEqual({ ok: true });
      } finally {
        subject.syncRangePins = sync;
      }
    });
  });

  it("keeps scheduled cleanup paused while the alarm serves live work", async () => {
    const key = storeKey();
    const runId = "paused-alarm-live";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:paused-alarm"))).toMatchObject({ status: 200 });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`INSERT INTO run_events (run_id, seq, json) VALUES (?, 1, '{}')`, "paused-orphan");
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id) VALUES (?, ?)`,
        "missing-holder",
        "missing-source",
      );
      state.storage.sql.exec(
        `INSERT INTO intake_receipts (key, thread_key, decided_at, prune_after, json) VALUES (?, ?, 1, 1, '{}')`,
        "expired-receipt",
        "slack:C1:paused-alarm",
      );
      state.storage.sql.exec(
        `INSERT INTO sessions (key, thread_key) VALUES (?, ?)`,
        "slack:C1:paused-alarm:coding",
        "slack:C1:paused-alarm",
      );
      const subject = instance as unknown as {
        env: { RUN_HISTORY_MAINTENANCE?: string };
        trim: () => never;
        syncRangePins: () => never;
        sweepSessions: () => never;
      };
      const prior = subject.env.RUN_HISTORY_MAINTENANCE;
      const trim = subject.trim;
      const pins = subject.syncRangePins;
      const sessions = subject.sweepSessions;
      subject.env.RUN_HISTORY_MAINTENANCE = "paused";
      subject.trim = () => {
        throw new Error("scheduled trim ran");
      };
      subject.syncRangePins = () => {
        throw new Error("scheduled pin walk ran");
      };
      subject.sweepSessions = () => {
        throw new Error("scheduled session drop ran");
      };
      try {
        await instance.alarm();
      } finally {
        subject.env.RUN_HISTORY_MAINTENANCE = prior;
        subject.trim = trim;
        subject.syncRangePins = pins;
        subject.sweepSessions = sessions;
      }
      expect(
        state.storage.sql.exec(`SELECT run_id FROM run_events WHERE run_id = 'paused-orphan'`).toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql
          .exec(`SELECT holder_run_id FROM context_refs WHERE holder_run_id = 'missing-holder'`)
          .toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql.exec(`SELECT key FROM intake_receipts WHERE key = 'expired-receipt'`).toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql.exec(`SELECT key FROM sessions WHERE key = 'slack:C1:paused-alarm:coding'`).toArray(),
      ).toHaveLength(1);
    });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId })]),
    );
    expect(await post("/runs/coordinator/get", { storeKey: key, id: "unknown-plan" })).toMatchObject({ status: 200 });
    expect(
      await post("/runs/session/append", {
        storeKey: key,
        key: "slack:C1:paused-alarm:coding",
        rowId: "after-alarm",
        rows: [{ part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "still here" } }) }],
      }),
    ).toMatchObject({ status: 200, data: { ok: true, appended: true } });
  });

  it("keeps an unfinished run's events while pruning orphaned event rows", async () => {
    const key = storeKey();
    const runId = "alarm-live";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:alarm-live"))).toMatchObject({ status: 200 });
    expect(
      await post("/runs/append", {
        storeKey: key,
        runId,
        gen: "g1",
        events: [{ type: "tool_call", tool: "bash", summary: "unsealed work", seq: 1 }],
      }),
    ).toMatchObject({ status: 200 });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO run_events (run_id, seq, json) VALUES (?, ?, ?)`,
        "alarm-orphan",
        1,
        JSON.stringify({ type: "tool_call", tool: "bash", summary: "orphan", seq: 1 }),
      );
    });

    await runInDurableObject(stub, (instance: RunHistoryDO) => instance.alarm());

    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([expect.objectContaining({ runId })]);
    expect((await post("/runs/live-events", { storeKey: key, runId })).data.events).toEqual([
      expect.objectContaining({ seq: 1, summary: "unsealed work" }),
    ]);
    const orphan = await runInDurableObject(stub, async (_instance: RunHistoryDO, state) =>
      state.storage.sql.exec(`SELECT seq FROM run_events WHERE run_id = ?`, "alarm-orphan").toArray(),
    );
    expect(orphan).toEqual([]);
  });
});

describe("exact owner evidence for resident preservation", () => {
  it("rolls back terminal history and owner removal when retained workspace versions reach capacity", async () => {
    const key = storeKey();
    const runId = "capacity-workspace";
    const threadKey = "slack:C1:capacity-workspace";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const binding = {
      backend: "resident",
      ownerGen: "g1",
      ownerFence: 7,
      ref: "codex/r1",
      workspace: "/workspace/threads/t/r1",
      user: "worker2",
      container: "vm-1",
    };
    const publication = { version: 1, repo: "owner/name", branches: [], complete: true };
    const terminal = { ...record(runId, threadKey), repo: "owner/name" };
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      for (let revision = 1; revision <= 20; revision++)
        state.storage.sql.exec(
          `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES (?, ?, ?)`,
          JSON.stringify([runId, "g1", 7]),
          revision,
          JSON.stringify({
            version: 1,
            revision,
            owner,
            binding,
            publication,
            record: { id: runId, threadKey, userId: terminal.userId, status: "interrupted", repo: "owner/name" },
          }),
        );
    });
    await post(
      "/runs/claim",
      claimBody(key, runId, threadKey, "g1", { state: { binding, branchPublication: publication } }),
    );
    await expect(
      runInDurableObject(stub, (instance: RunHistoryDO) => instance.finish(runId, "g1", terminal)),
    ).rejects.toThrow("workspace obligation capacity exhausted");
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.kind).toBe("live");
    const stored = await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => ({
      history: state.storage.sql.exec(`SELECT run_id FROM runs WHERE run_id = ?`, runId).toArray(),
      versions: state.storage.sql.exec(`SELECT revision FROM workspace_settlements ORDER BY revision`).toArray(),
    }));
    expect(stored.history).toEqual([]);
    expect(stored.versions).toHaveLength(20);
  });
  it("keeps each unverified terminal version when a later segment completes and refuses a different terminal thread", async () => {
    const key = storeKey();
    const runId = "prior-unverified";
    const threadKey = "slack:C1:prior-unverified";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const binding = {
      backend: "resident",
      ownerGen: "g1",
      ownerFence: 7,
      ref: "codex/r1",
      workspace: "/workspace/threads/t/r1",
      user: "worker2",
      container: "vm-1",
    };
    const publication = { version: 1, repo: "owner/name", branches: [], complete: true };
    const claim = claimBody(key, runId, threadKey, "g1", {
      state: { binding, branchPublication: publication, publicationSettlement: { version: 2 } },
    });
    await post("/runs/claim", claim);
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId,
          gen: "g1",
          record: { ...record(runId, "slack:OTHER:1.0"), repo: "owner/name" },
        })
      ).status,
    ).toBe(409);
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.kind).toBe("live");
    const terminal = { ...record(runId, threadKey), repo: "owner/name", startedAt: 1000, finishedAt: 2000 };
    expect(
      (await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: { ...terminal, provisional: true } }))
        .status,
    ).toBe(409);
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.kind).toBe("live");
    await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal });
    await post(
      "/runs/claim",
      claimBody(key, runId, threadKey, "g1", { state: { binding, branchPublication: publication } }),
    );
    await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 2 })).data).toEqual({ ok: true });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.settlement).toMatchObject({
      revision: 1,
      record: { publicationSettlement: null },
    });
  });
  it("never reports all versions acknowledged when a newer retained version is corrupt", async () => {
    const key = storeKey();
    const owner = { runId: "corrupt-newer", ownerGen: "g1", ownerFence: 7 };
    const ownerKey = JSON.stringify([owner.runId, owner.ownerGen, owner.ownerFence]);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES (?, 1, NULL), (?, 2, ?)`,
        ownerKey,
        ownerKey,
        "corrupt",
      );
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({ ok: true });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data).toEqual({ kind: "unknown" });
  });
  it("keeps corrupt retained evidence under acknowledgment and refuses invalid owner inputs", async () => {
    const key = storeKey();
    const owner = { runId: "corrupt", ownerGen: "g1", ownerFence: 7 };
    const ownerKey = JSON.stringify([owner.runId, owner.ownerGen, owner.ownerFence]);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_settlements (owner_key, json) VALUES (?, ?)`, ownerKey, "corrupt");
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect(
      await runInDurableObject(stub, async (_instance: RunHistoryDO, state) =>
        state.storage.sql.exec(`SELECT json FROM workspace_settlements WHERE owner_key = ?`, ownerKey).toArray(),
      ),
    ).toEqual([{ json: "corrupt" }]);
    expect((await post("/runs/preservation-owner", { storeKey: key, runId: owner.runId, ownerGen: "g1" })).status).toBe(
      400,
    );
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 0 })).status).toBe(400);
  });
  it.each(["immediate retention", "explicit deletion"] as const)(
    "retains the exact terminal workspace obligation through %s and acknowledges only its complete version",
    async (mode) => {
      const key = storeKey();
      const runId = "retained-workspace";
      const threadKey = "slack:C1:retained-workspace";
      const owner = { runId, ownerGen: "g1", ownerFence: 7 };
      const physical = {
        backend: "resident",
        ownerGen: "g1",
        ref: "codex/retained",
        workspace: "/workspace/threads/t/retained",
        user: "worker2",
        container: "vm-1",
        ownerFence: 7,
        publicationBaseSha: "a".repeat(40),
      };
      const publication = {
        version: 1,
        repo: "owner/name",
        branches: [{ ref: "codex/retained", pr: 7 }],
        complete: true,
      };
      expect(
        (
          await post(
            "/runs/claim",
            claimBody(key, runId, threadKey, "g1", { state: { binding: physical, branchPublication: publication } }),
          )
        ).status,
      ).toBe(200);
      const terminal = {
        ...record(runId, threadKey),
        repo: "owner/name",
        ...(mode === "immediate retention" ? { startedAt: 1_000, finishedAt: 2_000 } : {}),
      };
      const result = await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal });
      expect(result).toMatchObject({ status: 200, data: { ok: true, stored: mode !== "immediate retention" } });
      if (mode === "explicit deletion")
        await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (instance: RunHistoryDO) => {
          await instance.delete(runId);
        });
      const read = () => post("/runs/preservation-owner", { storeKey: key, ...owner });
      const receipt = await read();
      expect(receipt.data).toMatchObject({
        kind: "terminal",
        settlement: {
          revision: 1,
          owner,
          binding: physical,
          publication,
          record: { id: runId, threadKey, status: "completed" },
        },
      });
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 2 })).data).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect((await read()).data.settlement).toEqual(receipt.data.settlement);
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({ ok: true });
      expect((await read()).data).toEqual({ kind: "acknowledged", owner, revision: 1 });
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({ ok: true });
      expect(
        (
          await post(
            "/runs/claim",
            claimBody(key, runId, threadKey, "g1", { state: { binding: physical, branchPublication: publication } }),
          )
        ).status,
      ).toBe(200);
      expect((await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal })).status).toBe(200);
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
        ok: true,
      });
      expect((await read()).data.settlement).toMatchObject({ revision: 2, owner });
    },
  );

  it("retains invalid binding and saved proof as unverified and checks the owner stored under an acknowledgment key", async () => {
    const key = storeKey();
    const runId = "invalid-workspace";
    const threadKey = "slack:C1:invalid-workspace";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const state = {
      binding: {
        backend: "resident",
        ownerGen: "g1",
        ownerFence: 7,
        ref: "codex/r1",
        workspace: "/workspace/threads/t/r1",
        user: "worker2",
      },
      branchPublication: { version: 1, repo: "owner/name", branches: [], complete: true },
      publicationSettlement: { version: 2 },
    };
    await post("/runs/claim", claimBody(key, runId, threadKey, "g1", { state }));
    await post("/runs/finish", {
      storeKey: key,
      runId,
      gen: "g1",
      record: { ...record(runId, threadKey), repo: "owner/name", startedAt: 1000, finishedAt: 2000 },
    });
    const receipt = (await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.settlement as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({ owner, binding: null, record: { publicationSettlement: null } });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    const ownerKey = JSON.stringify([owner.runId, owner.ownerGen, owner.ownerFence]);
    await runInDurableObject(stub, async (_instance: RunHistoryDO, storage) => {
      storage.storage.sql.exec(
        `UPDATE workspace_settlements SET json = ? WHERE owner_key = ?`,
        JSON.stringify({ ...receipt, owner: { ...owner, ownerFence: 8 } }),
        ownerKey,
      );
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data).toEqual({ kind: "unknown" });
  });

  it("retains incomplete publication and refuses workspace acknowledgment under a live or mismatched owner", async () => {
    const key = storeKey();
    const runId = "unresolved-workspace";
    const threadKey = "slack:C1:unresolved-workspace";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const state = {
      binding: {
        backend: "resident",
        ownerGen: "g1",
        ref: "codex/retained",
        workspace: "/workspace/threads/t/retained",
        user: "worker2",
        container: "vm-1",
        ownerFence: 7,
        publicationBaseSha: "a".repeat(40),
      },
      branchPublication: {
        version: 1,
        repo: "owner/name",
        branches: [],
        complete: false,
        pending: { id: "unconfirmed", ref: "codex/retained", headSha: "b".repeat(40) },
      },
    };
    expect((await post("/runs/claim", claimBody(key, runId, threadKey, "g1", { state }))).status).toBe(200);
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toMatchObject({
      ok: false,
      reason: "owner-live",
    });
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId,
          gen: "g1",
          record: { ...record(runId, threadKey), repo: "owner/name", finishedAt: 2_000 },
        })
      ).status,
    ).toBe(200);
    const read = () => post("/runs/preservation-owner", { storeKey: key, ...owner });
    expect((await read()).data).toMatchObject({
      kind: "terminal",
      settlement: { publication: state.branchPublication },
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toMatchObject({
      ok: false,
      reason: "unverified",
    });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner, ownerFence: 8 })).data).toEqual({
      kind: "absent",
      owner: { ...owner, ownerFence: 8 },
    });
    expect((await read()).data).toMatchObject({ settlement: { revision: 1 } });
  });

  it("returns the live owner before a stored summary, then only a non-provisional terminal row", async () => {
    const key = storeKey();
    const runId = "resident-preservation-owner";
    const threadKey = "slack:C1:resident-preservation";
    const read = () => post("/runs/preservation-owner", { storeKey: key, runId });
    expect((await read()).data).toEqual({ kind: "unknown" });
    expect((await post("/runs/claim", claimBody(key, runId, threadKey))).status).toBe(200);
    expect((await read()).data).toMatchObject({ kind: "live", row: { runId, threadKey, ownerGen: "g1" } });
    const binding: PublicationBinding = {
      runId,
      instanceId: "instance-x",
      step: "instance-x:unit-x",
      repo: "owner/name",
      branch: "codex/preserved",
      requester: "slack:UALICE",
      threadKey,
      generation: "g1",
      baseHeadSha: "a".repeat(40),
    };
    const settlement: PublicationSettlement = {
      version: 1,
      binding,
      checkpoint: { kind: "created", head: "b".repeat(40) },
      publication: { kind: "not_attempted" },
      preservation: { kind: "saved", key: checkpointKey(binding, "b".repeat(40)), size: 128, sha256: "c".repeat(64) },
      release: { kind: "pending" },
    };
    expect(
      (
        await post("/runs/put", {
          storeKey: key,
          record: {
            ...record(runId, threadKey),
            repo: binding.repo,
            parentInstanceId: binding.instanceId,
            idempotencyKey: binding.step,
            publicationSettlement: settlement,
          },
        })
      ).status,
    ).toBe(200);
    expect((await read()).data.kind).toBe("live");
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM live_runs WHERE run_id = ?`, runId);
    });
    expect((await read()).data).toMatchObject({
      kind: "terminal",
      record: { id: runId, threadKey, status: "completed", publicationSettlement: settlement },
    });
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET summary_json = json_set(summary_json, '$.provisional', json('true')) WHERE run_id = ?`,
        runId,
      );
    });
    expect((await read()).data).toEqual({ kind: "unknown" });
    expect((await post("/runs/preservation-owner", { storeKey: key, runId: "../foreign" })).status).toBe(400);
  });
});

// Feature: docs/reference/specs/run-history.md items 28–34 — the live-run ledger on the
// RunHistoryDO: claim (one live run per thread), the fence on every owner
// write, step records, the inbox, stop, handoff, finishing, finish in one
// transaction, reclaim. Runs in workerd against the real SQLite object; a
// unique store key per test.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

let n = 0;
const storeKey = () => `runs:ledger-${Date.now()}-${n++}`;

describe("private worker log on the state Worker", () => {
  it("stores ordered private history, replays an input id once, and refuses a changed replay", async () => {
    const key = storeKey();
    const threadKey = "worker:ship_private_1:U12";
    const input = { kind: "input", id: "step-1", sender: "slack:UA", text: "Fix signup", at: 10 };
    const append = (event: unknown) => post("/runs/private-worker/append", { storeKey: key, threadKey, event });
    const first = await append(input);
    expect(first).toMatchObject({ status: 200, data: { event: { ...input, seq: 1 } } });
    expect(await append({ ...input, at: 11 })).toEqual(first);
    expect((await append({ ...input, text: "other" })).status).toBe(409);
    const reply = { kind: "reply", id: "report-1", text: "\u0000".repeat(20_000), at: 20 };
    const settled = await append(reply);
    expect(settled).toMatchObject({
      status: 200,
      data: { event: { seq: 2, id: "report-1", kind: "reply", text: reply.text } },
    });
    expect(await append({ ...reply, at: 21 })).toEqual(settled);
    expect((await append({ ...reply, text: "Changed" })).status).toBe(409);
    const boundary = { kind: "reply", id: "boundary", text: "", at: 21 };
    boundary.text = "x".repeat(PRIVATE_WORKER_REPLY_MAX_CHARS - JSON.stringify(boundary).length - 1);
    expect(JSON.stringify(boundary).length).toBe(PRIVATE_WORKER_REPLY_MAX_CHARS - 1);
    expect((await append(boundary)).status).toBe(400);
    expect(await append({ kind: "status", phase: "start", frame: { title: "testing" }, at: 21 })).toMatchObject({
      status: 200,
      data: { event: { seq: 3, statusSeq: 3, kind: "status" } },
    });
    expect(
      await append({ kind: "status", phase: "done", statusSeq: 3, frame: { title: "done" }, at: 22 }),
    ).toMatchObject({ status: 200, data: { event: { seq: 4, statusSeq: 3 } } });
    expect(await post("/runs/private-worker/list", { storeKey: key, threadKey })).toMatchObject({
      status: 200,
      data: {
        events: [
          { seq: 1, kind: "input" },
          { seq: 2, kind: "reply" },
          { seq: 3, kind: "status" },
          { seq: 4, kind: "status" },
        ],
      },
    });
    const longInput = { ...input, id: "long-input", text: "shortened", textSha256: "a".repeat(64) };
    expect((await append(longInput)).status).toBe(200);
    expect((await append({ ...longInput, textSha256: "b".repeat(64) })).status).toBe(409);
    expect((await post("/runs/private-worker/list", { storeKey: key, threadKey: "slack:C1:1.0" })).status).toBe(400);
  });

  it("pages private events after a durable cursor with a fixed bound", async () => {
    const key = storeKey();
    const threadKey = "worker:ship_private_2:task";
    for (let index = 0; index < 5; index++) {
      expect(
        await post("/runs/private-worker/append", {
          storeKey: key,
          threadKey,
          event: { kind: "reply", text: `reply ${index}`, at: index },
        }),
      ).toMatchObject({ status: 200 });
    }
    const read = (afterSeq: number, limit: number) =>
      post("/runs/private-worker/list-after", { storeKey: key, threadKey, afterSeq, limit });
    expect(await read(0, 2)).toMatchObject({
      status: 200,
      data: { events: [{ seq: 1 }, { seq: 2 }], more: true },
    });
    expect(await read(2, 2)).toMatchObject({
      status: 200,
      data: { events: [{ seq: 3 }, { seq: 4 }], more: true },
    });
    expect(await read(4, 2)).toMatchObject({ status: 200, data: { events: [{ seq: 5 }], more: false } });
    expect((await read(-1, 2)).status).toBe(400);
    expect((await read(0, 33)).status).toBe(400);
  });
});

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
  byCategory: Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, ZERO])) as RunRecord["diagnosis"]["byCategory"],
  findings: [],
  verdict: "no friction detected",
});

function record(id: string, threadKey: string): RunRecord {
  return {
    id,
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey,
    channelVisibility: "unknown",
    // Inside the retention window, or the finished record is trimmed on write.
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 1_000,
    status: "completed",
    eventCount: 1,
    storedEventCount: 1,
    truncated: false,
    events: [{ type: "tool_call", tool: "bash", summary: "ls", seq: 1 }],
    diagnosis: diagnosis(),
  };
}

const claimBody = (key: string, runId: string, threadKey: string, gen = "g1", over: Record<string, unknown> = {}) => ({
  storeKey: key,
  run: {
    runId,
    threadKey,
    gen,
    leaseMs: LEASE_MS,
    startedAt: 1_000,
    meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
    card: { channel: "C1", ts: "1.0" },
    system: "you review",
    tools: [{ name: "bash", description: "run", inputSchema: {} }],
    ...over,
  },
});

const step = (over: Record<string, unknown> = {}) => ({
  step: 1,
  seq: 10,
  turnIndex: 2,
  inFlight: [{ callId: "c1", tool: "bash" }],
  inboxConsumedSeq: 0,
  remainingMs: 600_000,
  turn: 1,
  iteration: 1,
  ...over,
});

function timeSealedRunStages(
  onTestFailed: (handler: () => void) => void,
  now = () => performance.now(),
  emit = (message: string) => console.error(message),
) {
  const completed: Array<{ stage: string; elapsedMs: number }> = [];
  let pending: { stage: string; startedAt: number } | undefined;
  onTestFailed(() => {
    const pendingStage = pending ? `${pending.stage}=${Math.round(now() - pending.startedAt)}ms` : "none";
    const completedStages = completed.map(({ stage, elapsedMs }) => `${stage}=${elapsedMs}ms`).join(", ") || "none";
    emit(`[memory diagnostics] sealed-run stages: completed=${completedStages}; pending=${pendingStage}`);
  });
  return async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    pending = { stage, startedAt };
    try {
      return await operation();
    } finally {
      completed.push({ stage, elapsedMs: Math.round(now() - startedAt) });
      pending = undefined;
    }
  };
}

describe("run ledger — claim and admission (item 29)", () => {
  it("mints resident fences only for the live owner, in ledger order", async () => {
    const key = storeKey();
    const threadKey = "slack:C1:resident-fence";
    const body = (runId: string, gen: string, keyOverride = threadKey) => ({
      storeKey: key,
      runId,
      gen,
      threadKey: keyOverride,
    });
    expect(await post("/runs/resident-claim", body("r1", "g1"))).toMatchObject({
      status: 409,
      data: { reason: "unknown-run" },
    });
    expect((await post("/runs/claim", claimBody(key, "r1", threadKey))).status).toBe(200);
    expect(await post("/runs/resident-claim", body("r1", "g1"))).toMatchObject({
      status: 200,
      data: { ok: true, fence: 1 },
    });
    expect(await post("/runs/resident-claim", body("r1", "g1", "wrong-thread"))).toMatchObject({
      status: 409,
      data: { reason: "fenced" },
    });
    expect(await post("/runs/resident-claim", body("r1", "g1"))).toMatchObject({
      status: 200,
      data: { ok: true, fence: 2 },
    });
  });
  it("claim → 200; a second run on the same thread → 409 thread-live naming the live run; the owner's re-claim is idempotent; /runs/live lists it", async () => {
    const key = storeKey();
    expect(await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    const busy = await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"));
    expect(busy.status).toBe(409);
    expect(busy.data).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r1", agent: "review", startedAt: 1_000 },
    });
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const live = await post("/runs/live", { storeKey: key });
    expect(live.status).toBe(200);
    const runs = live.data.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "r1",
      threadKey: "slack:C1:1.0",
      ownerGen: "g1",
      phase: "live",
      stop: null,
      card: { channel: "C1", ts: "1.0" },
      system: "you review",
    });
    expect(typeof runs[0].leaseUntil).toBe("number");
    // Live runs are NOT in the finished listing.
    const list = await post("/runs/list", { storeKey: key });
    expect(list.data.items).toEqual([]);
  });

  it("a claim with `phase: attaching` reserves the thread before the prompt exists (item 42): the row lists as attaching with its request and an empty prompt; the owner's later claim with the prompt promotes it to live in place; reclaim keeps an expired attaching row's phase", async () => {
    const key = storeKey();
    const request = {
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "review it",
      at: 900,
    };
    const reserve = claimBody(key, "r1", "slack:C1:1.0", "g1", {
      phase: "attaching",
      system: "",
      tools: [],
      card: null,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UA", threadKey: "slack:C1:1.0", request },
    });
    expect(await post("/runs/claim", reserve)).toMatchObject({ status: 200, data: { ok: true } });
    let runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs[0]).toMatchObject({ runId: "r1", phase: "attaching", system: "", tools: [], card: null });
    expect((runs[0].meta as Record<string, unknown>).request).toEqual(request);
    expect((await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"))).status).toBe(409);
    // The prompt lands: promoted in place, identity and start unchanged.
    expect(await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0", "g1", { state: { n: 1 } }))).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs[0]).toMatchObject({
      runId: "r1",
      phase: "live",
      system: "you review",
      card: { channel: "C1", ts: "1.0" },
      state: { n: 1 },
      startedAt: 1_000,
    });
    // A bad phase is a 400.
    expect((await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { phase: "sleeping" }))).status).toBe(
      400,
    );
    // An expired attaching row is reclaimed as attaching, request and inbox in hand.
    await post(
      "/runs/claim",
      claimBody(key, "r9", "slack:C1:9.0", "g1", { ...reserve.run, runId: "r9", threadKey: "slack:C1:9.0" }),
    );
    await post("/runs/inbox", { storeKey: key, runId: "r9", message: { text: "also this" } });
    const future = Date.now() + LEASE_MS + 1_000;
    const r = await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS });
    const taken = (r.data.runs as Array<Record<string, unknown>>).find(
      (x) => (x.row as Record<string, unknown>).runId === "r9",
    )!;
    expect(taken.reclaimedFrom).toBe("attaching");
    expect(taken.row).toMatchObject({ ownerGen: "g2", phase: "attaching" });
    expect(((taken.row as Record<string, unknown>).meta as Record<string, unknown>).request).toEqual(request);
    expect((taken.inbox as Array<{ message: { text: string } }>).map((i) => i.message.text)).toEqual(["also this"]);
    // Abandon: the live rows go with no record; fenced from any other generation; unknown afterwards.
    expect((await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g1" })).status).toBe(409);
    expect(await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g2" })).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs.map((x) => x.runId)).toEqual(["r1"]);
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r9", afterSeq: 0 })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key })).data.items).toEqual([]);
    expect((await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g2" })).status).toBe(409);
  });

  it("promotion preserves live state assigned while the run was attaching and accepts its next transition", async () => {
    const key = storeKey();
    const reserve = claimBody(key, "promoted", "slack:C1:promoted", "g1", {
      phase: "attaching",
      system: "",
      tools: [],
      card: null,
    });
    expect(await post("/runs/claim", reserve)).toMatchObject({ status: 200, data: { ok: true } });

    expect(
      await post("/runs/live-state", {
        storeKey: key,
        runId: "promoted",
        gen: "g1",
        assignment: { expectedSeq: 0, eventSeq: 1, at: 100, state: "admitted", bound: 1_000 },
      }),
    ).toMatchObject({
      status: 200,
      data: {
        ok: true,
        liveState: { state: "admitted", since: 100, bound: 1_000 },
        liveStateSeq: 1,
      },
    });

    expect(
      await post(
        "/runs/claim",
        claimBody(key, "promoted", "slack:C1:promoted", "g1", {
          state: { binding: { backend: "resident", workspace: "/workspace/promoted" } },
        }),
      ),
    ).toMatchObject({ status: 200, data: { ok: true } });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toMatchObject([
      {
        runId: "promoted",
        phase: "live",
        state: {
          binding: { backend: "resident", workspace: "/workspace/promoted" },
          liveState: { state: "admitted", since: 100, bound: 1_000 },
          liveStateSeq: 1,
        },
      },
    ]);

    expect(
      await post("/runs/live-state", {
        storeKey: key,
        runId: "promoted",
        gen: "g1",
        assignment: { expectedSeq: 1, eventSeq: 2, at: 200, state: "working", bound: 1_000 },
      }),
    ).toMatchObject({
      status: 200,
      data: {
        ok: true,
        liveState: { state: "working", since: 200, bound: 1_000 },
        liveStateSeq: 2,
      },
    });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toHaveLength(1);
  });

  it("validates: a bad run id, gen, lease, or missing fields → 400; no bearer → 401", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "bad id!", "t"))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "bad gen!"))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "g1", { leaseMs: 10 }))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "g1", { system: undefined }))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t"), { "content-type": "application/json" })).status).toBe(
      401,
    );
  });
});

describe("run ledger — the fence (item 28)", () => {
  it("heartbeat, append, step, state, finishing and finish from another generation → 409 fenced; an unknown run → 409 unknown-run", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const fenced = { status: 409, data: { ok: false, reason: "fenced" } };
    expect(await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g2", leaseMs: LEASE_MS })).toEqual(fenced);
    expect(
      await post("/runs/append", {
        storeKey: key,
        runId: "r1",
        gen: "g2",
        events: [{ type: "tool_call", tool: "bash", summary: "x", seq: 1 }],
      }),
    ).toEqual(fenced);
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g2", record: step() })).toEqual(fenced);
    expect(await post("/runs/state", { storeKey: key, runId: "r1", gen: "g2", state: {} })).toEqual(fenced);
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g2" })).toEqual(fenced);
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g2", record: record("r1", "slack:C1:1.0") }),
    ).toEqual(fenced);
    expect(await post("/runs/heartbeat", { storeKey: key, runId: "nope", gen: "g1", leaseMs: LEASE_MS })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
  });

  it("the owner's heartbeat extends the lease and reports a stop any generation requested; stop says whether the owner is live", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const before = ((await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>)[0]
      .leaseUntil;
    expect(await post("/runs/stop", { storeKey: key, runId: "r1", mode: "soft" })).toEqual({
      status: 200,
      data: { ok: true, ownerLive: true },
    });
    await new Promise((r) => setTimeout(r, 5));
    const hb = await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    expect(hb).toEqual({ status: 200, data: { ok: true, stop: "soft", phase: "live", effects: [] } });
    const after = ((await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>)[0]
      .leaseUntil;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(await post("/runs/stop", { storeKey: key, runId: "nope", mode: "hard" })).toEqual({
      status: 200,
      data: { ok: false },
    });
  });
});

describe("run ledger — steps, events, inbox, state (items 30–31)", () => {
  it("the SQLite ledger fences and sequences a resumed setup boundary after provider wait", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "resume-state", "slack:C1:resume-state"));
    for (const [expectedSeq, state] of [
      [0, "admitted"],
      [1, "working"],
      [2, "waiting_provider"],
    ] as const) {
      expect(
        await post("/runs/live-state", {
          storeKey: key,
          runId: "resume-state",
          gen: "g1",
          assignment: { expectedSeq, eventSeq: expectedSeq + 1, at: 100, state, bound: 1_000 },
        }),
      ).toMatchObject({ status: 200, data: { ok: true } });
    }
    expect(await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: ["resume-state"] })).toMatchObject({
      status: 200,
      data: { marked: ["resume-state"] },
    });
    expect(await post("/runs/reclaim", { storeKey: key, gen: "g2", now: Date.now(), leaseMs: LEASE_MS })).toMatchObject(
      {
        status: 200,
        data: { runs: [expect.objectContaining({ row: expect.objectContaining({ runId: "resume-state" }) })] },
      },
    );
    const assignment = { expectedSeq: 3, eventSeq: 4, at: 200, state: "admitted", bound: 900, resumeSegment: true };
    expect(await post("/runs/live-state", { storeKey: key, runId: "resume-state", gen: "g1", assignment })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    expect(
      await post("/runs/live-state", { storeKey: key, runId: "resume-state", gen: "g2", assignment }),
    ).toMatchObject({
      status: 200,
      data: { ok: true, liveState: { state: "admitted", since: 200 }, liveStateSeq: 4 },
    });
    expect(await post("/runs/live-state", { storeKey: key, runId: "resume-state", gen: "g2", assignment })).toEqual({
      status: 400,
      data: { ok: false, reason: "stale-sequence" },
    });
    const events = (await post("/runs/live-events", { storeKey: key, runId: "resume-state" })).data.events as Array<{
      seq: number;
      type: string;
    }>;
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "run_state"],
      [2, "run_state"],
      [3, "run_state"],
      [4, "run_state"],
    ]);
  });

  it("live-state assignment commits its boundary and projection together, while a pre-commit refusal exposes neither half", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "state-1", "slack:C1:state"));
    const admitted = await post("/runs/live-state", {
      storeKey: key,
      runId: "state-1",
      gen: "g1",
      assignment: { expectedSeq: 0, eventSeq: 1, at: 100, state: "admitted", bound: 1_000 },
    });
    expect(admitted).toMatchObject({
      status: 200,
      data: { ok: true, liveState: { state: "admitted", since: 100, bound: 1_000 }, liveStateSeq: 1 },
    });
    let live = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(live[0]).toMatchObject({
      liveState: { state: "admitted", since: 100, bound: 1_000 },
      liveStateSeq: 1,
    });
    expect((await post("/runs/live-events", { storeKey: key, runId: "state-1" })).data.events).toHaveLength(1);

    expect(
      await post("/runs/live-state", {
        storeKey: key,
        runId: "state-1",
        gen: "g1",
        assignment: {
          expectedSeq: 1,
          at: 200,
          state: "working",
          bound: 900,
          sourceEvents: [{ type: "tool_call", tool: "bash", summary: "x", seq: 1, at: 200 }],
        },
      }),
    ).toEqual({ status: 400, data: { ok: false, reason: "stale-sequence" } });
    live = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(live[0]).toMatchObject({
      liveState: { state: "admitted", since: 100, bound: 1_000 },
      liveStateSeq: 1,
    });
    expect((await post("/runs/live-events", { storeKey: key, runId: "state-1" })).data.events).toHaveLength(1);
  });
  it("append lands event rows keyed by seq while the run is live (the finished-runs routes do not see a live run — its events reach them with the finish record); an over-cap event is 400; step records replace by step number", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const events = [1, 2, 3].map((seq) => ({ type: "tool_call", tool: "bash", summary: `s${seq}`, seq }));
    expect(await post("/runs/append", { storeKey: key, runId: "r1", gen: "g1", events })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const seqs = await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_inst, state) =>
      state.storage.sql
        .exec<{ seq: number }>(`SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq`, "r1")
        .toArray()
        .map((r) => r.seq),
    );
    expect(seqs).toEqual([1, 2, 3]);
    // Live runs are not finished runs: the history routes answer as for an unknown id —
    // the ledger's own read is how a reclaim gets at them (item 36); an unknown run is empty.
    expect((await post("/runs/events", { storeKey: key, id: "r1" })).data.events).toBeNull();
    const liveEvents = (await post("/runs/live-events", { storeKey: key, runId: "r1" })).data.events as Array<{
      seq: number;
      type: string;
    }>;
    expect(liveEvents.map((e) => [e.seq, e.type])).toEqual([
      [1, "tool_call"],
      [2, "tool_call"],
      [3, "tool_call"],
    ]);
    expect((await post("/runs/live-events", { storeKey: key, runId: "nope" })).data.events).toEqual([]);
    expect((await post("/runs/live-events", { storeKey: key, runId: "bad id" })).status).toBe(400);
    const huge = { type: "tool_result", tool: "bash", summary: "x", output: "y".repeat(70_000), seq: 4 };
    expect((await post("/runs/append", { storeKey: key, runId: "r1", gen: "g1", events: [huge] })).status).toBe(400);
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step() })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step({ inFlight: [] }) })).toEqual(
      { status: 200, data: { ok: true } },
    );
    expect((await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: { step: 1 } })).status).toBe(400);
  });

  it("inbox appends with increasing seq from any generation; state replaces; both refused for an unknown run", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    expect(await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "a" } })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "b" } })).toEqual({
      status: 200,
      data: { ok: true, seq: 2 },
    });
    expect(await post("/runs/inbox", { storeKey: key, runId: "nope", message: { text: "c" } })).toEqual({
      status: 200,
      data: { ok: false },
    });
    // Read back past a seq (item 40): the resume's re-read at adopt time.
    expect(await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: 1 })).toEqual({
      status: 200,
      data: { items: [{ seq: 2, message: { text: "b" } }] },
    });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1" })).data).toEqual({
      items: [
        { seq: 1, message: { text: "a" } },
        { seq: 2, message: { text: "b" } },
      ],
    });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "nope", afterSeq: 0 })).data).toEqual({ items: [] });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: -1 })).status).toBe(400);
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: "2" })).status).toBe(400);
    expect(await post("/runs/state", { storeKey: key, runId: "r1", gen: "g1", state: { verdict: "approve" } })).toEqual(
      { status: 200, data: { ok: true } },
    );
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ state: unknown }>;
    expect(live[0].state).toEqual({ verdict: "approve" });
  });
});

describe("run ledger — finishing, finish, handoff, reclaim (items 31, 33)", () => {
  it("guards a paused same-generation hard-stop seal and removes its durable owner once", async () => {
    const key = storeKey();
    const id = "paused-child";
    const threadKey = "slack:C1:paused-child";
    await post(
      "/runs/claim",
      claimBody(key, id, threadKey, "g1", {
        state: { binding: { backend: "resident", workspace: "/workspace/kept" } },
      }),
    );
    const stopRecord = { ...record(id, threadKey), status: "stopped_hard" as const };
    const finish = (gen: string) =>
      post("/runs/finish", { storeKey: key, runId: id, gen, record: stopRecord, requireStoppedPause: true });
    expect((await finish("g1")).status).toBe(409); // live owner cannot be mistaken for a paused one
    expect(
      (await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: [id], pausedForRetry: true })).data,
    ).toMatchObject({ marked: [id] });
    expect((await finish("g2")).status).toBe(409); // different generation cannot seal it
    expect((await finish("g1")).status).toBe(409); // not stopped yet
    expect((await post("/runs/stop", { storeKey: key, runId: id, mode: "hard" })).status).toBe(200);
    expect((await finish("g1")).data).toMatchObject({ ok: true, stored: true });
    expect((await finish("g1")).status).toBe(409); // no duplicate finish/event
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    expect((await post("/runs/summary", { storeKey: key, id })).data.summary).toMatchObject({ status: "stopped_hard" });
    expect(
      (await post("/runs/reclaim", { storeKey: key, gen: "g2", now: Date.now(), leaseMs: LEASE_MS })).data.runs,
    ).toEqual([]);
  });

  it("finishing is a CAS taken once; finish writes the finished record and removes every live row in one step; the record then lists as finished", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step() });
    await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "a" } });
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g1" })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g1" })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: record("r1", "slack:C1:1.0"),
    });
    // `event: none` — a record with no coordinator sends nothing (item 47).
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    const got = await post("/runs/get", { storeKey: key, id: "r1" });
    expect((got.data.record as RunRecord).status).toBe("completed");
    const list = await post("/runs/list", { storeKey: key });
    expect((list.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual(["r1"]);
    // The thread is free again.
    expect((await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"))).status).toBe(200);
    // finish with a record whose id differs from runId is refused before any write.
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r2", gen: "g1", record: record("other", "slack:C1:1.0") }))
        .status,
    ).toBe(400);
  });

  it("handoff marks this generation's live runs; reclaim takes expired and handed-off rows with the last step, the unconsumed inbox and jobs, and re-owns them; a live lease is left alone", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "expired", "slack:C1:1.0"));
    await post("/runs/claim", claimBody(key, "handed", "slack:C1:2.0"));
    await post("/runs/claim", claimBody(key, "alive", "slack:C1:3.0", "g1", { leaseMs: 3_600_000 }));
    // g2's own row with a lapsed lease: never taken by g2's own reclaim (a heartbeat that did not land, not a dead owner).
    await post("/runs/claim", claimBody(key, "mine", "slack:C1:4.0", "g2"));
    await post("/runs/step", { storeKey: key, runId: "expired", gen: "g1", record: step({ inboxConsumedSeq: 1 }) });
    await post("/runs/inbox", { storeKey: key, runId: "expired", message: { text: "first" } });
    await post("/runs/inbox", { storeKey: key, runId: "expired", message: { text: "second" } });
    expect(await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: ["handed", "alive-not-mine"] })).toEqual({
      status: 200,
      data: { marked: ["handed"] },
    });
    const future = Date.now() + LEASE_MS + 1_000; // past `expired`'s lease, inside `alive`'s hour
    const r = await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS });
    expect(r.status).toBe(200);
    const runs = r.data.runs as Array<{
      row: { runId: string; ownerGen: string; phase: string };
      lastStep: { step: number } | null;
      inbox: Array<{ message: { text: string } }>;
    }>;
    expect(runs.map((x) => x.row.runId).sort()).toEqual(["expired", "handed"]);
    const expired = runs.find((x) => x.row.runId === "expired")!;
    expect(expired.row).toMatchObject({ ownerGen: "g2", phase: "live" });
    expect(expired.lastStep?.step).toBe(1);
    expect(expired.inbox.map((i) => i.message.text)).toEqual(["second"]);
    // The old generation is fenced; the new one writes.
    expect((await post("/runs/step", { storeKey: key, runId: "expired", gen: "g1", record: step() })).status).toBe(409);
    expect(
      (await post("/runs/step", { storeKey: key, runId: "expired", gen: "g2", record: step({ step: 2 }) })).status,
    ).toBe(200);
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ runId: string; ownerGen: string }>;
    expect(live.find((x) => x.runId === "alive")?.ownerGen).toBe("g1");
    expect(live.find((x) => x.runId === "mine")?.ownerGen).toBe("g2"); // untouched by its own generation's reclaim
  });

  it("reclaim offers the deferred rows at or below the cursor with every row past it; a malformed deferred list is refused", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "parked", "slack:C1:1.0"));
    for (const text of ["ordinary", "earlier read", "provider up", "later"])
      await post("/runs/inbox", { storeKey: key, runId: "parked", message: { text } });
    for (const inboxDeferredSeqs of [[0], [1.5], "1", [-1]])
      expect(
        (
          await post("/runs/step", {
            storeKey: key,
            runId: "parked",
            gen: "g1",
            record: { ...step({ inboxConsumedSeq: 3 }), inboxDeferredSeqs },
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await post("/runs/step", {
          storeKey: key,
          runId: "parked",
          gen: "g1",
          record: step({ inboxConsumedSeq: 3, inboxDeferredSeqs: [1] }),
        })
      ).status,
    ).toBe(200);
    const r = await post("/runs/reclaim", {
      storeKey: key,
      gen: "g2",
      now: Date.now() + LEASE_MS + 1_000,
      leaseMs: LEASE_MS,
    });
    const [taken] = r.data.runs as Array<{ inbox: Array<{ seq: number; message: { text: string } }> }>;
    expect(taken!.inbox.map((i) => [i.seq, i.message.text])).toEqual([
      [1, "ordinary"],
      [4, "later"],
    ]);
  });
});

// docs/reference/specs/run-history.md items 47–48: the coordinator's event rides
// the one handler every terminal record commits through, and the row and record
// carry the instance and the spawn's key.
describe("run ledger — the coordinator's event and the key (items 47–48)", () => {
  const TAG = { parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" };
  type Sent = { instance: string; type: string; payload: unknown };

  /** The Workflow binding as the object sees it, doubled: what `finish` sent, or
   *  an engine that refuses because the instance ended. Installed on the live
   *  object, so the send goes through the handler's own code path. */
  async function coordinatorDouble(key: string, behaviour: "ok" | "not-running" | "absent" = "ok"): Promise<Sent[]> {
    const sent: Sent[] = [];
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const holder = inst as unknown as { env: Record<string, unknown> };
      // `absent`: a state Worker deployed without the binding (the release
      // before it bound the bot's class) — the pool's own binding is the stub
      // Worker's, so absence is installed, never assumed.
      if (behaviour === "absent") {
        const { SHIP_COORDINATOR: _binding, ...without } = holder.env;
        holder.env = without;
        return;
      }
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async (id: string) => ({
            sendEvent: async (event: { type: string; payload: unknown }) => {
              if (behaviour === "not-running") throw new Error("instance is not running");
              sent.push({ instance: id, type: event.type, payload: event.payload });
            },
          }),
        },
      };
    });
    return sent;
  }

  const childRecord = (id: string, threadKey: string, status: RunRecord["status"] = "completed"): RunRecord => ({
    ...record(id, threadKey),
    status,
    ...TAG,
  });

  it("the test pool leaves the real Workflow engine unbound, so only a test's live-object double can own a workflow promise", () => {
    expect(env.SHIP_COORDINATOR).toBeUndefined();
  });

  it("a record carrying parentInstanceId committed by the owner's finish sends exactly one `run-finished-<runId>` to that instance, after the commit, and the response says so", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: childRecord("r1", "slack:C1:1.0"),
    });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "sent" } });
    expect(sent).toEqual([
      {
        instance: "ship_acme_api_1",
        type: "run-finished-r1",
        payload: expect.objectContaining({ runId: "r1", status: "completed", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // The commit stood: the row is gone and the record lists as finished, its tag on it.
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    const got = (await post("/runs/get", { storeKey: key, id: "r1" })).data.record as RunRecord;
    expect(got).toMatchObject({ status: "completed", ...TAG });
  });

  it("the reclaim's close (an expired live row taken by the next generation) and the admission's close (a reserved row it supersedes) each send exactly one event", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    const base = claimBody(key, "expired", "slack:C1:1.0").run.meta;
    await post("/runs/claim", claimBody(key, "expired", "slack:C1:1.0", "g1", { meta: { ...base, ...TAG } }));
    await post(
      "/runs/claim",
      claimBody(key, "reserved", "slack:C1:2.0", "g1", {
        phase: "attaching",
        system: "",
        tools: [],
        card: null,
        meta: { ...base, threadKey: "slack:C1:2.0", ...TAG, request: { text: "do the unit" } },
      }),
    );
    const future = Date.now() + LEASE_MS + 1_000;
    const taken = (await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS })).data
      .runs as Array<{ row: { runId: string } }>;
    expect(taken.map((t) => t.row.runId).sort()).toEqual(["expired", "reserved"]);
    expect(
      await post("/runs/finish", {
        storeKey: key,
        runId: "expired",
        gen: "g2",
        record: childRecord("expired", "slack:C1:1.0", "interrupted"),
      }),
    ).toMatchObject({ status: 200, data: { ok: true, event: "sent" } });
    expect(
      await post("/runs/finish", {
        storeKey: key,
        runId: "reserved",
        gen: "g2",
        record: childRecord("reserved", "slack:C1:2.0", "interrupted"),
      }),
    ).toMatchObject({ status: 200, data: { ok: true, event: "sent" } });
    expect(sent.map((s) => s.type)).toEqual(["run-finished-expired", "run-finished-reserved"]);
    expect(sent.map((s) => (s.payload as { status: string }).status)).toEqual(["interrupted", "interrupted"]);
  });

  it("a terminal record committed through put, outside the ledger's finish — the run loop's or a reclaim's interrupted close, the pi harness's restart — sends `run-finished-<runId>` once; the start tombstone (finishedAt = startedAt) sends nothing; a record without the tag sends nothing", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    // The tombstone a run writes at its start: not a close, so no wake.
    const started = record("p1", "slack:C1:3.0");
    await post("/runs/put", {
      storeKey: key,
      record: { ...started, finishedAt: started.startedAt, status: "interrupted", ...TAG },
    });
    expect(sent).toEqual([]);
    // The interrupted close written outside `finish`: one send, the record's status on it.
    expect(
      await post("/runs/put", {
        storeKey: key,
        record: {
          ...childRecord("p1", "slack:C1:3.0", "interrupted"),
          events: [
            {
              type: "coordinator_tag",
              parentInstanceId: "ship_acme_api_1",
              transportWorkflowId: "recovery-review-1",
              at: 1,
            },
          ],
          eventCount: 1,
        },
      }),
    ).toMatchObject({ status: 200, data: { ok: true, stored: true } });
    expect(sent).toEqual([
      {
        instance: "recovery-review-1",
        type: "run-finished-p1",
        payload: expect.objectContaining({ runId: "p1", status: "interrupted", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // A plain record — no coordinator — wakes nobody.
    await post("/runs/put", { storeKey: key, record: record("p2", "slack:C1:4.0") });
    expect(sent).toHaveLength(1);
  });

  it("a record without parentInstanceId sends nothing; a fenced finish sends nothing", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post(
      "/runs/claim",
      claimBody(key, "r2", "slack:C1:2.0", "g1", {
        meta: { ...claimBody(key, "r2", "slack:C1:2.0").run.meta, ...TAG },
      }),
    );
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:1.0") }),
    ).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r2", gen: "g9", record: childRecord("r2", "slack:C1:2.0") }))
        .status,
    ).toBe(409);
    expect(sent).toEqual([]);
  });

  it("a send the engine refuses — the instance ended — is swallowed: the finish still commits and the response names the failure", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key, "not-running");
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: childRecord("r1", "slack:C1:1.0"),
    });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "failed" } });
    expect(sent).toEqual([]);
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    expect(((await post("/runs/get", { storeKey: key, id: "r1" })).data.record as RunRecord).status).toBe("completed");
  });

  it("a Worker without the coordinator binding (the release before it bound the bot's class) commits as before and answers no-binding", async () => {
    const key = storeKey();
    await coordinatorDouble(key, "absent");
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: childRecord("r1", "slack:C1:1.0") }),
    ).toEqual({ status: 200, data: { ok: true, stored: true, event: "no-binding" } });
  });

  it("the claim stores the key on the row and a second claim on the thread is refused naming it; a malformed key or instance id in the meta is 400", async () => {
    const key = storeKey();
    const meta = { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG, costCapUsd: 50 };
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0", "g1", { meta }))).status).toBe(200);
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ meta: Record<string, unknown> }>;
    expect(live[0].meta).toMatchObject({ ...TAG, costCapUsd: 50 });
    const busy = await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"));
    expect(busy).toEqual({
      status: 409,
      data: {
        ok: false,
        reason: "thread-live",
        live: { runId: "r1", agent: "review", startedAt: 1_000, idempotencyKey: TAG.idempotencyKey },
      },
    });
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, idempotencyKey: "no-step" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, parentInstanceId: "has:colon" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, costCapUsd: 0 } })))
        .status,
    ).toBe(400);
    // The tag is both fields or neither: one alone is refused before it reaches a row.
    const { idempotencyKey: _k, ...instanceOnly } = meta;
    expect((await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: instanceOnly }))).status).toBe(
      400,
    );
  });
});

// docs/reference/specs/run-history.md item 49: the parent ship record the
// coordinator's spawn route reads the requester from lives on the state Worker.
describe("run ledger — the coordinator instance record (item 49)", () => {
  const instance: CoordinatorInstance = {
    id: "ship_acme_api_1",
    kind: "ship",
    userId: "slack:UALICE",
    userName: "alice",
    channelId: "slack:C1",
    threadKey: "slack:C1:1.0",
    repo: "acme/api",
    branch: "plan/orchestration/u12",
    base: "main",
    createdAt: 1_000,
  };

  it("put stores the record and get reads it back; an identical put is idempotent; a different record under the same id is refused as exists; an unknown id is null", async () => {
    const key = storeKey();
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).toEqual({
      status: 200,
      data: { instance },
    });
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, branch: "other" } })).toEqual({
      status: 409,
      data: { ok: false, reason: "exists" },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "ship_none" })).data).toEqual({ instance: null });
  });

  it("confirms only the exact unreconciled create and leaves its unit rows intact", async () => {
    const key = storeKey();
    const pending: CoordinatorInstance = { ...instance, admission: "unreconciled" };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u12",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance: pending })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    expect(
      await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: { ...pending, runId: "other" } }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: pending,
    });
    expect(await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: pending })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: pending })).status).toBe(200);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...pending, admission: "created" },
    });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [unit],
    });
    expect((await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: instance })).status).toBe(400);
  });

  // Record 0060 / issue 1924: the hard stop's mark on the instance row —
  // written when the hosted parent is sealed, read back by the runner's routes.
  it("stop marks the instance row and get reads the mark back; a second mark keeps the first `at`; an unknown id is 409 unknown_instance; a malformed body is 400", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect(await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 5_000 })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...instance, stop: { at: 5_000 } },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 9_000 })).status).toBe(
      200,
    );
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...instance, stop: { at: 5_000 } },
    });
    expect(await post("/runs/coordinator/stop", { storeKey: key, instanceId: "ship_none", at: 5_000 })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown_instance" },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: "has:colon", at: 5_000 })).status).toBe(
      400,
    );
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id })).status).toBe(400);
  });

  it.each([
    { pr: { number: 7, url: "https://github.com/acme/api/pull/7" } },
    { resume: { pr: 7 } },
    { lastPush: "a".repeat(40) },
    { progress: { phase: "publication-pending" } },
    {
      wakes: {
        wait: {
          kind: "segment" as const,
          index: 1,
          runId: "prior-run",
          spendUsd: 0,
          texts: [],
          senders: [],
          leaseMs: 1000,
        },
      },
    },
    { ending: { kind: "interrupted", report: "legacy ending", at: 1000 } },
  ])("replacement retains existing publication or execution evidence: %j", async (facts) => {
    const key = storeKey();
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u12",
      branch: "plan/orchestration/u12",
      dependsOn: [],
      rounds: [],
      ...facts,
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    expect(
      await post("/runs/coordinator/replace", {
        storeKey: key,
        instance: { ...instance, runId: "replacement", createdAt: 2000 },
      }),
    ).toMatchObject({ status: 409, data: { ok: false, reason: "exists" } });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data.instance).toEqual(instance);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data.units).toEqual(
      [unit],
    );
  });

  it("refuses replacement of unreadable unit bytes without deleting the original owner", async () => {
    const key = storeKey();
    await post("/runs/coordinator/put", { storeKey: key, instance });
    const unit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u12",
      branch: "plan/orchestration/u12",
      dependsOn: [],
      rounds: [],
    };
    await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE coordinator_units SET json = '{' WHERE instance_id = ?`, instance.id);
    });
    expect(
      await post("/runs/coordinator/replace", { storeKey: key, instance: { ...instance, runId: "replacement" } }),
    ).toMatchObject({ status: 409, data: { ok: false, reason: "exists" } });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data.instance).toEqual(instance);
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      expect(
        state.storage.sql
          .exec<{ json: string }>(`SELECT json FROM coordinator_units WHERE instance_id = ?`, instance.id)
          .one().json,
      ).toBe("{");
    });
  });

  it("replace writes the record over whatever the id holds — a different record, or none — drops the id's unit rows and no other instance's; a malformed record is 400", async () => {
    const key = storeKey();
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const row = (instanceId: string, unit: string): CoordinatorUnit => ({
      instanceId,
      unit,
      slug: unit.toLowerCase(),
      branch: `plan/orchestration/${unit.toLowerCase()}`,
      dependsOn: [],
      rounds: [],
    });
    await post("/runs/coordinator/units/put", {
      storeKey: key,
      units: [row(instance.id, "U12"), row(instance.id, "U13"), row("ship_other", "U12")],
    });
    const again = { ...instance, runId: "run-s2", createdAt: 2_000 };
    expect(await post("/runs/coordinator/replace", { storeKey: key, instance: again })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance: again });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [],
    });
    const others = (await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "ship_other" })).data
      .units as CoordinatorUnit[];
    expect(others.map((u) => u.unit)).toEqual(["U12"]);
    const fresh = { ...again, id: "ship_fresh" };
    expect((await post("/runs/coordinator/replace", { storeKey: key, instance: fresh })).status).toBe(200);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "ship_fresh" })).data).toEqual({
      instance: fresh,
    });
    expect(
      (await post("/runs/coordinator/replace", { storeKey: key, instance: { ...instance, kind: "review" } })).status,
    ).toBe(400);
  });

  it("validates: a malformed record or id is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect(
      (await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, kind: "review" } })).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/put", { storeKey: key })).status).toBe(400);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "has:colon" })).status).toBe(400);
    expect(
      (await post("/runs/coordinator/get", { storeKey: key, id: instance.id }, { "content-type": "application/json" }))
        .status,
    ).toBe(401);
  });
});

// Feature: docs/reference/specs/agent-ship.md item 16 and run-history.md item 50 —
// decision-record reservations survive bot-process restarts in the state Worker,
// with already-persisted unit and run rows included in the claim set.
describe("run ledger — main-agent task claims", () => {
  it("commits a main task only at the latest private requester revision", async () => {
    const key = storeKey();
    const firstUnit = ["U", "1"].join("");
    const threadKey = "slack:DMAIN:1700000000.000001";
    const requesterId = "slack:UALICE";
    const record = (messageId: string, questionTarget?: string) =>
      post("/runs/coordinator/requester-turn/record", {
        storeKey: key,
        input: { threadKey, requesterId, messageId, ...(questionTarget ? { questionTarget } : {}) },
      });
    expect((await record("1700000000.000001", "acme/api")).data).toMatchObject({
      ok: true,
      turn: { revision: 1, questionTarget: "acme/api" },
    });
    expect((await record("1700000000.000002")).data).toMatchObject({
      ok: true,
      turn: { revision: 2, priorQuestionTarget: "acme/api" },
    });
    const instance: CoordinatorInstance = {
      id: "plan_main_act_1",
      kind: "ship",
      userId: requesterId,
      channelId: "slack:DMAIN",
      threadKey,
      repo: "acme/api",
      branch: "plan/main-act/u1",
      base: "main",
      plan: { id: "main-act" },
      merge: "person",
      createdAt: 1_000,
    };
    const link = { mainThreadKey: threadKey, actId: "act-fix" };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: firstUnit,
      slug: "u1",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId,
        mainThreadKey: threadKey,
        actId: link.actId,
        repo: instance.repo,
        base: "main",
        question: "Why did signup fail?",
        findings: [],
        requestedChange: "Fix signup",
      },
    };
    const authority = { requesterId, sourceMessageId: "1700000000.000002", revision: 2, repo: "acme/api" };
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance,
          unit,
          authority: { ...authority, revision: 1 },
        })
      ).status,
    ).toBe(409);
    expect((await record("1700000000.000003")).status).toBe(200);
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance,
          unit,
          authority,
        })
      ).status,
    ).toBe(409);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance: null });
    expect((await post("/runs/coordinator/main-task/get", { storeKey: key, key: link })).data).toEqual({ link: null });
  });

  it("claims the link with its instance and unit and replays it after a new request", async () => {
    const key = storeKey();
    const firstUnit = ["U", "1"].join("");
    const instance: CoordinatorInstance = {
      id: "plan_main_act_1",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:CMAIN",
      threadKey: "slack:CMAIN:1.0",
      repo: "acme/api",
      branch: "plan/main-act/u1",
      base: "main",
      plan: { id: "main-act" },
      merge: "person",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: firstUnit,
      slug: "u1",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: "slack:CMAIN:1.0",
        actId: "act-1",
        repo: instance.repo,
        base: instance.base!,
        question: "What failed?",
        findings: [],
        requestedChange: "Fix it",
      },
    };
    const link = { mainThreadKey: "slack:CMAIN:1.0", actId: "act-1" };
    const authority = { requesterId: instance.userId, sourceMessageId: "1", revision: 1, repo: instance.repo };
    expect(
      await post("/runs/coordinator/requester-turn/record", {
        storeKey: key,
        input: { threadKey: link.mainThreadKey, requesterId: instance.userId, messageId: "1" },
      }),
    ).toMatchObject({ status: 200, data: { turn: { revision: 1 } } });
    expect(
      await post("/runs/coordinator/main-task/claim", { storeKey: key, key: link, instance, unit, authority }),
    ).toEqual({
      status: 200,
      data: { ok: true, created: true, link: { instanceId: instance.id, unit: firstUnit, authority } },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [unit],
    });
    expect(
      (await post("/runs/coordinator/units/put", { storeKey: key, units: [{ ...unit, workBrief: undefined }] })).status,
    ).toBe(200);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [unit],
    });
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: unit,
          recovered: { ...unit, title: "Progressed", workBrief: undefined },
        })
      ).status,
    ).toBe(200);
    const progressed = { ...unit, title: "Progressed" };
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [progressed],
    });
    const answer = { kind: "segment", index: 1, spendUsd: null, texts: [], senders: [] } as const;
    const waitId = `${firstUnit}/idle/1`;
    expect(
      (
        await post("/runs/coordinator/wake", {
          storeKey: key,
          unit: { ...progressed, workBrief: undefined },
          waitId,
          answer,
          seqs: [],
          by: "segment:1",
        })
      ).status,
    ).toBe(200);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [{ ...progressed, wakes: { [waitId]: answer } }],
    });
    expect((await post("/runs/coordinator/main-task/get", { storeKey: key, key: link })).data).toEqual({
      link: { instanceId: instance.id, unit: firstUnit, authority },
    });
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance: { ...instance, id: "plan_other" },
          unit: { ...unit, instanceId: "plan_other" },
          authority,
        })
      ).data,
    ).toEqual({ ok: true, created: false, link: { instanceId: instance.id, unit: firstUnit, authority } });
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: { ...link, actId: "act-2" },
          instance,
          unit: { ...unit, workBrief: { ...unit.workBrief!, actId: "act-2" } },
          authority,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: { mainThreadKey: "slack:COTHER:2.0", actId: "act-3" },
          instance: { ...instance, id: "plan_other_thread" },
          authority,
          unit: {
            ...unit,
            instanceId: "plan_other_thread",
            workBrief: { ...unit.workBrief!, mainThreadKey: "slack:COTHER:2.0", actId: "act-3" },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/runs/coordinator/replace", { storeKey: key, instance: { ...instance, branch: "other" } })).status,
    ).toBe(409);
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance,
          unit: { ...unit, workBrief: { ...unit.workBrief!, question: "x".repeat(5000) } },
          authority,
        })
      ).status,
    ).toBe(400);
  });
});

describe("run ledger — durable decision-record reservations (agent-ship item 16)", () => {
  it("advances past reservations persisted on unit and run rows, and reuses a task key after a process restart", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "ship_record_reservations",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/records/u1",
      base: "main",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: ["U", "1"].join(""),
      slug: "u1",
      branch: "plan/records/u1",
      dependsOn: [],
      record: "0075",
      rounds: [],
    };
    await post("/runs/coordinator/put", { storeKey: key, instance });
    await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] });

    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "1111111111111111",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0076" } });
    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "1111111111111111",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0076" } });

    await post("/runs/put", {
      storeKey: key,
      record: { ...record("record-run", "slack:C1:2.0"), repo: "acme/api", record: "0077" },
    });
    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "2222222222222222",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0078" } });
  });
});

describe("run ledger — the coordinator's unit rows (item 50)", () => {
  it("commits recovery history and settlement atomically while fencing older writers", async () => {
    const storeKeyValue = storeKey();
    const call = (path: string, body: Record<string, unknown>) =>
      post(`/runs/coordinator/${path}`, { storeKey: storeKeyValue, ...body });
    const instance: CoordinatorInstance = {
      id: "ship_history",
      kind: "ship",
      userId: "slack:UA",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/u1",
      base: "main",
      plan: { id: "history" },
      merge: "person",
      createdAt: 1,
      admission: "unreconciled",
    };
    let row: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u1",
      branch: instance.branch,
      threadKey: instance.threadKey,
      dependsOn: [],
      rounds: [],
      ending: { kind: "aborted", report: "original", at: 10 },
    };
    expect((await call("put", { instance })).status).toBe(200);
    expect((await call("units/put", { units: [row] })).status).toBe(200);
    for (const number of [1, 2]) {
      const { ending, ...active } = row;
      const replacement: CoordinatorUnit = {
        ...active,
        recovery: {
          kind: "findings",
          round: number,
          expectedHeadSha: "a".repeat(40),
          remainingMs: 1000,
          claimedAt: 20 + number,
          step: `U12/recovery/${number}/findings`,
          reviewRunId: `review-${number}`,
          reviewKey: `review-key-${number}`,
          previousEnding: ending!,
          workflowId: `recovery-${number}`,
          deadlineAt: 1000,
        },
      };
      const input = {
        kind: "claim" as const,
        expected: row,
        replacement,
        request: { userId: instance.userId, threadKey: instance.threadKey, messageId: `slack:C1:${number + 1}.0` },
      };
      if (number === 1) {
        expect(await call("recovery/transition", { input })).toMatchObject({
          status: 409,
          data: { ok: false, reason: "conflict" },
        });
        expect((await call("recovery/history", { key: row, after: 0 })).data.receipts).toEqual([]);
        expect((await call("admission/confirm", { expected: { ...instance, runId: "different-create" } })).status).toBe(
          409,
        );
        expect((await call("admission/confirm", { expected: instance })).status).toBe(200);
        await runInDurableObject(
          env.RUNS.get(env.RUNS.idFromName(storeKeyValue)),
          async (store: RunHistoryDO, state) => {
            state.storage.sql.exec(
              `CREATE TRIGGER fail_recovery_action BEFORE INSERT ON coordinator_recovery_journal WHEN NEW.kind = 'action' BEGIN SELECT RAISE(ABORT, 'action write failed'); END`,
            );
            await expect(store.transitionRecovery(input, 20)).rejects.toThrow("action write failed");
            expect(state.storage.sql.exec(`SELECT * FROM coordinator_recovery_journal`).toArray()).toEqual([]);
            state.storage.sql.exec(`DROP TRIGGER fail_recovery_action`);
          },
        );
        expect((await call("units/list", { instanceId: instance.id })).data.units).toEqual([row]);
      }
      const claim = await call("recovery/transition", { input });
      expect(claim.status).toBe(200);
      row = claim.data.unit as CoordinatorUnit;
      expect(await call("recovery/transition", { input })).toMatchObject({
        status: 200,
        data: { ok: true, unit: row, replayed: true },
      });
      expect((await call("units/claim-legacy-continuation", { expected: row, recovered: active })).status).toBe(409);
      expect((await call("units/put", { units: [{ ...active, unit: "U13" }, active] })).status).toBe(409);
      expect((await call("replace", { instance })).status).toBe(409);
      const { recovery, ...settling } = row;
      const completed = await call("recovery/transition", {
        input: {
          kind: "settle",
          expected: row,
          replacement: {
            ...settling,
            ending: { kind: "aborted", report: `result ${number}`, at: 30 + number },
            recoveryReceipt: { reviewRunId: recovery!.reviewRunId, workflowId: recovery!.workflowId, at: 30 + number },
          },
        },
      });
      expect(completed.status).toBe(200);
      row = completed.data.unit as CoordinatorUnit;
      const savedHistory = await call("recovery/history", { key: row, after: 0 });
      expect((await call("admission/confirm", { expected: instance })).status).toBe(200);
      expect((await call("units/list", { instanceId: instance.id })).data.units).toEqual([row]);
      expect(await call("recovery/history", { key: row, after: 0 })).toEqual(savedHistory);
      expect((await call("get", { id: instance.id })).data.instance).toEqual({ ...instance, admission: "created" });
    }
    const history = await call("recovery/history", { key: { instanceId: row.instanceId, unit: row.unit }, after: 0 });
    expect(history).toMatchObject({
      status: 200,
      data: {
        cursor: 3,
        more: false,
        receipts: [
          { ending: { report: "original" } },
          { ending: { report: "result 1" } },
          { ending: { report: "result 2" } },
        ],
      },
    });
    expect((await call("units/list", { instanceId: instance.id })).data.units).toEqual([row]);
    const { ending: lastEnding, ...last } = row;
    const request = { userId: instance.userId, threadKey: instance.threadKey, messageId: "slack:C1:later" };
    const third = await call("recovery/transition", {
      input: {
        kind: "claim",
        expected: row,
        request,
        replacement: {
          ...last,
          recovery: {
            kind: "findings",
            round: 3,
            expectedHeadSha: "a".repeat(40),
            remainingMs: 1000,
            claimedAt: 40,
            step: "U12/recovery/3/findings",
            reviewRunId: "review-3",
            reviewKey: "review-key-3",
            previousEnding: lastEnding,
            workflowId: "recovery-3",
            deadlineAt: 1000,
          },
        },
      },
    });
    expect(third.status).toBe(200);
    const refusal = { kind: "refuse", expected: third.data.unit, replacement: row, error: "recovery_workflow_failed" };
    expect(await call("recovery/transition", { input: refusal })).toMatchObject({
      status: 200,
      data: { ok: true, unit: row },
    });
    expect(await call("recovery/transition", { input: refusal })).toMatchObject({
      status: 200,
      data: { ok: true, unit: row, replayed: true },
    });
    expect(await call("recovery/action", { key: { instanceId: instance.id, unit: row.unit }, request })).toMatchObject({
      status: 200,
      data: { action: { state: "refused", error: "recovery_workflow_failed", consumed: false } },
    });
    expect(await call("recovery/history", { key: { instanceId: instance.id, unit: row.unit }, after: 0 })).toEqual(
      history,
    );
  });
  const INSTANCE_ID = "ship_acme_api_1";
  const instance: CoordinatorInstance = {
    id: INSTANCE_ID,
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:1.0",
    repo: "acme/api",
    branch: "plan/orchestration",
    base: "main",
    merge: "person",
    createdAt: 1000,
  };
  const unit = (name: string, over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
    instanceId: INSTANCE_ID,
    unit: name,
    slug: name.toLowerCase(),
    branch: `plan/orchestration/${name.toLowerCase()}`,
    dependsOn: [],
    rounds: [],
    ...over,
  });

  it("fences stale full-row and wake writes after typed settlement without committing part of a batch", async () => {
    const key = storeKey();
    const stale = unit("U12");
    const settled: CoordinatorUnit = {
      ...stale,
      ending: {
        kind: "aborted",
        report: "Stopped",
        at: 2_000,
        outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 1 },
      },
    };
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [stale] })).status).toBe(200);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "U12",
          event: { sender: "slack:UALICE", text: "Proceed", mode: "steer", at: 1_000 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: stale,
          recovered: settled,
        })
      ).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/units/put", {
        storeKey: key,
        units: [unit("U13"), { ...stale, startedAt: 3_000 }],
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "settled" } });
    expect(
      await post("/runs/coordinator/wake", {
        storeKey: key,
        unit: stale,
        waitId: "U12/wait/1",
        answer: { kind: "answered", reply: "Proceed" },
        seqs: [1],
        by: "wake",
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "settled" } });
    expect(
      (
        await post("/runs/coordinator/events/list", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "U12",
          unconsumedOnly: true,
        })
      ).data,
    ).toMatchObject({ events: [{ seq: 1, text: "Proceed" }] });
    expect(
      await post("/runs/coordinator/replace", {
        storeKey: key,
        instance: {
          id: INSTANCE_ID,
          kind: "ship",
          userId: "slack:UALICE",
          channelId: "slack:C1",
          threadKey: "slack:C1:1.0",
          repo: "acme/api",
          branch: "plan/orchestration",
          base: "main",
          plan: { id: "orchestration" },
          merge: "person",
          createdAt: 1_000,
        },
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "exists" } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [settled],
    });
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: settled,
          recovered: stale,
        })
      ).status,
    ).toBe(200);
  });

  it("persists a typed outcome and rejects malformed or foreign pull request facts without changing the stored row", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
    const row = unit("U12", {
      pr,
      ending: {
        kind: "aborted",
        report: "Display only",
        at: 2_000,
        outcome: {
          schemaVersion: 1,
          kind: "aborted",
          reviewRounds: 2,
          terminalPr: { state: "merged", ...pr, mergeSha: "c".repeat(40), headSha: "b".repeat(40) },
          findings: {
            stop: "head_mismatch",
            observedHead: "a".repeat(40),
            remoteHead: "b".repeat(40),
            missingOutputCount: 1,
          },
        },
      },
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit("U12", { pr })] })).status).toBe(
      200,
    );
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    for (const bad of [
      { ...row, ending: { ...row.ending, kind: "merged" } },
      { ...row, pr: { ...pr, number: 8 } },
      { ...row, ending: { ...row.ending, outcome: { ...row.ending!.outcome, schemaVersion: 2 } } },
    ]) {
      expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [bad] })).status).toBe(400);
      expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
        units: [row],
      });
    }
  });

  it("put writes the rows and list reads an instance's back in first-written order; a row is replaced whole and keeps its place; another instance's rows never appear; an unknown instance lists none", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect(
      (await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, id: "ship_other" } })).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/units/put", {
        storeKey: key,
        units: [unit("U12"), unit("U13", { dependsOn: ["U12"] })],
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      (
        await post("/runs/coordinator/units/put", {
          storeKey: key,
          units: [{ ...unit("U99"), instanceId: "ship_other" }],
        })
      ).status,
    ).toBe(200);
    const listed = await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID });
    expect(listed.status).toBe(200);
    expect((listed.data.units as CoordinatorUnit[]).map((u) => u.unit)).toEqual(["U12", "U13"]);
    const reached = unit("U12", {
      threadKey: "slack:C1:2.0",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      rounds: [{ index: 0, agent: "coding", outcome: "started", at: 1_000 }],
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [reached] })).status).toBe(200);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [reached, unit("U13", { dependsOn: ["U12"] })],
    });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "ship_none" })).data).toEqual({
      units: [],
    });
  });

  it("claim-legacy-continuation atomically replaces only the exact expected row, so a concurrent or stale caller cannot erase newer state", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const legacy = unit("U12", {
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      ending: { kind: "merge_ready", report: "ready", at: 2_000 },
    });
    const recovered = {
      ...legacy,
      lastPush: "1".repeat(40),
      publication: {
        repo: "acme/api",
        pr: 7,
        headRef: legacy.branch,
        baseRef: "main",
        expectedHeadSha: "1".repeat(40),
        publicationRef: legacy.branch,
        owner: { instanceId: INSTANCE_ID, unit: "U12" },
      },
    } satisfies CoordinatorUnit;
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [legacy] })).status).toBe(200);

    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", { storeKey: key, expected: legacy, recovered }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", { storeKey: key, expected: legacy, recovered }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [recovered],
    });
  });

  it("the full-row CAS atomically binds an ordinary open pull request and rejects a stale PR-only write", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const unbound = unit("U12");
    const head = "a".repeat(40);
    const bound = {
      ...unbound,
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      publication: {
        repo: "acme/api",
        pr: 7,
        headRef: unbound.branch,
        baseRef: "main",
        expectedHeadSha: head,
        publicationRef: unbound.branch,
        owner: { instanceId: INSTANCE_ID, unit: "U12" },
      },
    } satisfies CoordinatorUnit;
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unbound] })).status).toBe(200);

    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", {
        storeKey: key,
        expected: unbound,
        recovered: bound,
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", {
        storeKey: key,
        expected: unbound,
        recovered: { ...unbound, pr: bound.pr },
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [bound],
    });
  });

  it("lists only active recovery rows in SQL, ignores terminal history, and fails closed on malformed candidate JSON", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const active = unit("U12", {
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      recovery: {
        kind: "review",
        round: 2,
        expectedHeadSha: "a".repeat(40),
        remainingMs: 60_000,
        claimedAt: 2_000,
        step: "U12/recovery/2/review",
        reviewRunId: "review-1",
        previousEnding: { kind: "aborted", report: "recoverable", at: 1_000 },
        workflowId: "recovery-review-1",
        deadlineAt: 62_000,
        reviewKey: `${INSTANCE_ID}:U12/1/review`,
      },
    });
    const terminal = unit("U13", {
      ending: { kind: "merged", report: "done", at: 3_000 },
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [active, terminal] })).status).toBe(200);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));

    await expect(runInDurableObject(stub, (inst: RunHistoryDO) => inst.listActiveRecoveries())).resolves.toEqual([
      active,
    ]);

    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(
        `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)`,
        INSTANCE_ID,
        "U14",
        `{"recovery":`,
        4_000,
      );
    });
    await expect(runInDurableObject(stub, (inst: RunHistoryDO) => inst.listActiveRecoveries())).rejects.toThrow();
  });

  it("the validating wake boundary accepts a first-segment resume without inventing a renewal segment row", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const row = unit("U12", {
      startedAt: 1_000,
      idle: { why: "stopped", at: 2_000, renewalsLeft: 2, spendUsd: null, wakes: 1 },
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "U12",
          event: { sender: "slack:UALICE", text: "resume", mode: "wake", at: 3_000 },
        })
      ).status,
    ).toBe(200);
    const answer = {
      kind: "segment",
      index: 1,
      spendUsd: null,
      texts: ["Alice: resume"],
      senders: ["Alice"],
      leaseMs: 60_000,
    } as const;
    const { idle: _idle, ...resumed } = row;
    expect(
      await post("/runs/coordinator/wake", {
        storeKey: key,
        unit: resumed,
        waitId: "U12/idle/1",
        answer,
        seqs: [1],
        by: "segment:1",
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [{ ...resumed, wakes: { "U12/idle/1": answer } }],
    });
    expect(
      (await post("/runs/coordinator/events/list", { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" })).data,
    ).toMatchObject({ events: [{ consumedBy: "segment:1" }] });
  });

  it("validates: an empty list, a malformed row or instance id is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [] })).status).toBe(400);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [{ unit: "U12" }] })).status).toBe(400);
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: unit("U12"),
          recovered: { ...unit("U12"), unit: "U13" },
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "has:colon" })).status).toBe(400);
    expect(
      (
        await post(
          "/runs/coordinator/units/list",
          { storeKey: key, instanceId: INSTANCE_ID },
          {
            "content-type": "application/json",
          },
        )
      ).status,
    ).toBe(401);
  });
});

// Feature: docs/reference/specs/run-history.md item 50 and record 0051's reply-as-event rule —
// the thread events of a unit-owned thread: a sibling table of the unit rows,
// appended in arrival order under the per-event cap, consumed once.
describe("run ledger — the coordinator's unit events (record 0051's reply-as-event rule)", () => {
  const INSTANCE_ID = "ship_acme_api_1";
  const event = (text: string, over: Record<string, unknown> = {}) => ({
    sender: "slack:UALICE",
    text,
    mode: "steer",
    at: 5_000,
    ...over,
  });

  it("guards a main-task steer against a stop in the same append transaction", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: INSTANCE_ID,
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/steer/u12",
      base: "main",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: INSTANCE_ID,
      unit: "U12",
      slug: "u12",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
    };
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12", requireActive: true };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    expect(
      await post("/runs/coordinator/events/append", { ...body, event: event("first", { id: "steer-1" }) }),
    ).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: INSTANCE_ID, at: 6_000 })).status).toBe(
      200,
    );
    expect(
      await post("/runs/coordinator/events/append", { ...body, event: event("later", { id: "steer-2" }) }),
    ).toEqual({
      status: 409,
      data: { ok: false, reason: "ended" },
    });
    expect((await post("/runs/coordinator/events/list", body)).data).toMatchObject({ events: [{ text: "first" }] });
  });

  it("atomically refuses main-task steer and stop after the claimed branch changes", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: INSTANCE_ID,
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/steer/u12",
      base: "main",
      plan: { id: "main-steer" },
      merge: "person",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: INSTANCE_ID,
      unit: "U12",
      slug: "u12",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: instance.threadKey,
        actId: "act-steer",
        repo: instance.repo,
        base: instance.base!,
        question: "What failed?",
        findings: [],
        requestedChange: "Fix it",
      },
    };
    const binding = {
      key: { mainThreadKey: instance.threadKey, actId: "act-steer" },
      instanceId: instance.id,
      unit: unit.unit,
      branch: instance.branch,
      channelId: instance.channelId,
      requesterId: instance.userId,
    };
    const authority = { requesterId: instance.userId, sourceMessageId: "1", revision: 1, repo: instance.repo };
    expect(
      (
        await post("/runs/coordinator/requester-turn/record", {
          storeKey: key,
          input: { threadKey: instance.threadKey, requesterId: instance.userId, messageId: "1" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await post("/runs/coordinator/main-task/claim", { storeKey: key, key: binding.key, instance, unit, authority }))
        .status,
    ).toBe(200);
    const first = event("first steer", { id: "steer-first" });
    const firstAppend = {
      storeKey: key,
      instanceId: instance.id,
      unit: unit.unit,
      requireActive: true,
      binding,
    };
    expect(await post("/runs/coordinator/events/append", { ...firstAppend, event: first })).toEqual({
      status: 200,
      data: { ok: true, seq: 1, event: { ...first, seq: 1 } },
    });
    expect(
      await post("/runs/coordinator/events/append", {
        ...firstAppend,
        event: event("changed words", { id: "steer-first" }),
      }),
    ).toEqual({ status: 200, data: { ok: true, seq: 1, event: { ...first, seq: 1 } } });
    expect(
      (await post("/runs/coordinator/units/put", { storeKey: key, units: [{ ...unit, branch: "plan/other" }] })).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/events/append", {
        storeKey: key,
        instanceId: instance.id,
        unit: unit.unit,
        event: event("stale steer", { id: "steer-stale" }),
        requireActive: true,
        binding,
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect(
      await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 6_000, binding }),
    ).toEqual({
      status: 409,
      data: { ok: false, reason: "stale" },
    });
    expect(
      (await post("/runs/coordinator/events/list", { storeKey: key, instanceId: instance.id, unit: unit.unit })).data,
    ).toEqual({ events: [{ ...first, seq: 1 }] });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance });
  });

  it("append assigns sequences in order and caps per event; list filters unconsumed; mark-consumed is idempotent; a put of the unit row leaves the events untouched", async () => {
    const key = storeKey();
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" };
    const seeded = event("first", { id: `${INSTANCE_ID}:U12:ship-request` });
    expect(await post("/runs/coordinator/events/append", { ...body, event: seeded })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/coordinator/events/append", { ...body, event: seeded })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/coordinator/events/append", { ...body, event: event("second") })).toEqual({
      status: 200,
      data: { ok: true, seq: 2 },
    });
    // Over the durable cap (400 KiB): the attachments are dropped whole and the row says how many.
    const heavy = event("third", { attachments: [{ mediaType: "image/png", data: "x".repeat(500 * 1024) }] });
    expect((await post("/runs/coordinator/events/append", { ...body, event: heavy })).data).toEqual({
      ok: true,
      seq: 3,
    });
    const all = await post("/runs/coordinator/events/list", body);
    const rows = all.data.events as Array<Record<string, unknown>>;
    expect(rows.map((e) => [e.seq, e.text])).toEqual([
      [1, "first"],
      [2, "second"],
      [3, "third"],
    ]);
    expect(rows[2]!.attachments).toBeUndefined();
    expect(rows[2]!.attachmentsDropped).toBe(1);
    // Consumed once: a second mark keeps the first consumer; list filters unconsumed.
    expect(
      (await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1, 2], by: "spawn:U12/1/fix" })).data,
    ).toEqual({ ok: true });
    expect(
      (await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1], by: "spawn:U12/2/fix" })).data,
    ).toEqual({ ok: true });
    const unconsumed = await post("/runs/coordinator/events/list", { ...body, unconsumedOnly: true });
    expect((unconsumed.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3]);
    const after = await post("/runs/coordinator/events/list", body);
    expect((after.data.events as Array<{ consumedBy?: string }>).map((e) => e.consumedBy)).toEqual([
      "spawn:U12/1/fix",
      "spawn:U12/1/fix",
      undefined,
    ]);
    // A put of the unit row — the whole-row upsert — leaves the events untouched (record 0051).
    const row: CoordinatorUnit = {
      instanceId: INSTANCE_ID,
      unit: "U12",
      slug: "u12",
      branch: "plan/orchestration/u12",
      dependsOn: [],
      rounds: [],
      threadKey: "slack:C1:2.0",
    };
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    const kept = await post("/runs/coordinator/events/list", body);
    expect((kept.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2, 3]);
    // Another unit's list is its own.
    expect((await post("/runs/coordinator/events/list", { ...body, unit: "U13" })).data).toEqual({ events: [] });
    // A text alone over the cap is cut to fit and the row says how many characters went.
    const wordy = event("w".repeat(500 * 1024));
    expect((await post("/runs/coordinator/events/append", { ...body, event: wordy })).data).toEqual({
      ok: true,
      seq: 4,
    });
    const events = async () =>
      (await post("/runs/coordinator/events/list", body)).data.events as Array<Record<string, unknown>>;
    const fourth = (await events())[3]!;
    expect((fourth.text as string).length).toBeLessThan(500 * 1024);
    expect(fourth.textDropped).toBe(500 * 1024 - (fourth.text as string).length);
    // A caller's `consumedBy` never rides the append: the row is born unconsumed in its JSON as in its column.
    const presumptuous = event("fifth", { consumedBy: "spawn:U12/9/fix" });
    expect((await post("/runs/coordinator/events/append", { ...body, event: presumptuous })).data).toEqual({
      ok: true,
      seq: 5,
    });
    expect((await events())[4]!.consumedBy).toBeUndefined();
    const stillOpen = await post("/runs/coordinator/events/list", { ...body, unconsumedOnly: true });
    expect((stillOpen.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("validates: a malformed event, unit, instance id, seqs or consumer is 400", async () => {
    const key = storeKey();
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" };
    expect((await post("/runs/coordinator/events/append", { ...body, event: { text: "x" } })).status).toBe(400);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: "has:colon",
          unit: "U12",
          event: event("x"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "u/12",
          event: event("x"),
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [0], by: "r" })).status).toBe(400);
    expect((await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1], by: "" })).status).toBe(400);
  });
});

// Feature: docs/reference/specs/session-log.md item 7 — the sessions registry
// on RunHistoryDO and the sweep's drop: a session object goes only when every
// kept run of the session is gone and no live run holds its thread, owner row
// first, then the rows.
describe("the sessions registry and the sweep's drop of a session log", () => {
  const sql = <T extends Record<string, unknown>>(key: string, query: string, ...params: unknown[]) =>
    runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_inst, state) =>
      state.storage.sql.exec<T>(query, ...params).toArray(),
    );
  const sessionOf = (threadKey: string, agent: string) => `${threadKey}:${agent}`;
  const sessionStub = (skey: string) => env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(skey));
  const withSession = (threadKey: string, agent: string, seedFrom: number) => ({
    session: { key: sessionOf(threadKey, agent), seedFrom, request: seedFrom, range: { from: seedFrom } },
  });
  const seedRows = async (skey: string, gen: string, runId: string, count: number) => {
    await post("/runs/session/owner", { key: skey, runId, gen });
    await post("/runs/session/write", {
      key: skey,
      gen,
      rows: Array.from({ length: count }, (_, i) => ({
        idx: i,
        part: 0,
        json: JSON.stringify({ role: "user", part: { type: "text", text: `turn ${i}` } }),
      })),
      attachments: [],
    });
  };

  it("a claim with a session registers it under its thread and agent; the finish stamps the run's row with the session key, refreshes the registry's finish time and the object's bytes", async () => {
    const key = storeKey();
    const thread = "slack:C1:1.0";
    const skey = sessionOf(thread, "review");
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r1", thread, "g1", {
            meta: {
              agent: "review",
              channelId: "slack:C1",
              userId: "u",
              threadKey: thread,
              ...withSession(thread, "review", 0),
            },
          }),
        )
      ).status,
    ).toBe(200);
    expect(await sql(key, `SELECT key, thread_key, agent, last_finished_at, bytes FROM sessions`)).toEqual([
      { key: skey, thread_key: thread, agent: "review", last_finished_at: 0, bytes: 0 },
    ]);
    await seedRows(skey, "g1", "r1", 3);
    const rec = { ...record("r1", thread), session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 2 } } };
    expect((await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: rec })).status).toBe(200);
    expect(await sql(key, `SELECT run_id, session_key FROM runs`)).toEqual([{ run_id: "r1", session_key: skey }]);
    const [row] = await sql<{ last_finished_at: number; bytes: number }>(
      key,
      `SELECT last_finished_at, bytes FROM sessions WHERE key = ?`,
      skey,
    );
    expect(row.last_finished_at).toBe(rec.finishedAt);
    expect(row.bytes).toBeGreaterThan(0);
    // The finish cleared nothing: the log's rows stay for the next run.
    expect((await post("/runs/session/tail", { key: skey })).data).toEqual({ next: 3 });
    // A record without a session leaves the column null.
    await post("/runs/put", { storeKey: key, record: record("plain", "slack:C1:9.0") });
    expect(await sql(key, `SELECT session_key FROM runs WHERE run_id = 'plain'`)).toEqual([{ session_key: null }]);
  });

  it("the sweep drops a session object only once every kept run of it is gone and no live run holds the thread — owner cleared, rows gone, registry row deleted; a session with a kept run or a live thread stays", async () => {
    const key = storeKey();
    const now = Date.now();
    const DAY = 86_400_000;
    const gone = "slack:C1:1.0";
    const kept = "slack:C1:2.0";
    const live = "slack:C1:3.0";
    const sGone = sessionOf(gone, "review");
    const sKept = sessionOf(kept, "review");
    const sLive = sessionOf(live, "review");
    const sLiveOther = sessionOf(live, "coding");
    // Three finished sessions: one whose only run is old, one whose run is fresh,
    // one whose old run finished but whose thread has a live run of another agent.
    for (const [runId, thread, skey, finishedAt] of [
      ["r-gone", gone, sGone, now - 40 * DAY],
      ["r-kept", kept, sKept, now - 1000],
      ["r-live", live, sLive, now - 40 * DAY],
    ] as const) {
      await seedRows(skey, "g1", runId, 2);
      await post(
        "/runs/claim",
        claimBody(key, runId, thread, "g1", {
          meta: {
            agent: "review",
            channelId: "slack:C1",
            userId: "u",
            threadKey: thread,
            ...withSession(thread, "review", 0),
          },
        }),
      );
      const rec = {
        ...record(runId, thread),
        startedAt: finishedAt - 5000,
        finishedAt,
        session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
      };
      await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: rec });
    }
    // The live run on the third thread, a coding session with no record yet.
    await seedRows(sLiveOther, "g1", "r-live-2", 1);
    await post(
      "/runs/claim",
      claimBody(key, "r-live-2", live, "g1", {
        meta: {
          agent: "coding",
          channelId: "slack:C1",
          userId: "u",
          threadKey: live,
          ...withSession(live, "coding", 0),
        },
      }),
    );
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual(
      [sGone, sKept, sLive, sLiveOther].sort(),
    );
    // Retention keeps 30 days: the two old records fall out at the sweep.
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), (inst: RunHistoryDO) => inst.alarm());
    expect((await sql(key, `SELECT run_id FROM runs ORDER BY run_id`)).map((r) => r.run_id)).toEqual(["r-kept"]);
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual(
      [sKept, sLive, sLiveOther].sort(),
    );
    // The dropped object: owner gone (a late write is unknown-run), rows gone.
    expect((await post("/runs/session/write", { key: sGone, gen: "g1", rows: [], attachments: [] })).data).toEqual({
      ok: false,
      reason: "unknown-run",
    });
    expect((await post("/runs/session/tail", { key: sGone })).data).toEqual({ next: 0 });
    // The kept session and both sessions of the live thread are untouched.
    expect((await post("/runs/session/tail", { key: sKept })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sLive })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sLiveOther })).data).toEqual({ next: 1 });
    expect(await runInDurableObject(sessionStub(sLive), (inst: SessionLogDO) => inst.rowCount())).toBe(2);
  });

  it("the drop decides on what it re-reads at each drop, not on the candidate list: a run that went live on the thread, or a record that named the session, between the list and the drop keeps the session and its registry row", async () => {
    const key = storeKey();
    const now = Date.now();
    const DAY = 86_400_000;
    const threadA = "slack:C1:11.0";
    const threadB = "slack:C1:12.0";
    const sA = sessionOf(threadA, "review");
    const sB = sessionOf(threadB, "review");
    for (const [runId, thread, skey] of [
      ["r-a", threadA, sA],
      ["r-b", threadB, sB],
    ] as const) {
      await seedRows(skey, "g1", runId, 2);
      await post(
        "/runs/claim",
        claimBody(key, runId, thread, "g1", {
          meta: {
            agent: "review",
            channelId: "slack:C1",
            userId: "u",
            threadKey: thread,
            ...withSession(thread, "review", 0),
          },
        }),
      );
      await post("/runs/finish", {
        storeKey: key,
        runId,
        gen: "g1",
        record: {
          ...record(runId, thread),
          startedAt: now - 40 * DAY - 5000,
          finishedAt: now - 40 * DAY,
          session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
        },
      });
    }
    // The list the sweep's transaction would produce once retention drops both old records.
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(`DELETE FROM run_events WHERE run_id IN ('r-a', 'r-b')`);
      state.storage.sql.exec(`DELETE FROM runs WHERE run_id IN ('r-a', 'r-b')`);
    });
    const candidates = [
      { key: sA, threadKey: threadA },
      { key: sB, threadKey: threadB },
    ];
    // Between the list and the drop: a new run goes live on thread A, and a
    // fresh record names session B.
    await post(
      "/runs/claim",
      claimBody(key, "r-a2", threadA, "g1", {
        meta: { agent: "coding", channelId: "slack:C1", userId: "u", threadKey: threadA },
      }),
    );
    await post("/runs/put", {
      storeKey: key,
      record: { ...record("r-b2", threadB), session: { key: sB, seedFrom: 2, request: 2, range: { from: 2, to: 3 } } },
    });
    const dropped = await runInDurableObject(stub, (inst: RunHistoryDO) => inst.sweepSessions(candidates));
    expect(dropped).toBe(0);
    expect((await post("/runs/session/tail", { key: sA })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sB })).data).toEqual({ next: 2 });
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual([sA, sB].sort());
    // Once thread A's run finishes with no record and session B's record is gone, the same list drops both.
    await post("/runs/abandon", { storeKey: key, runId: "r-a2", gen: "g1" });
    await post("/runs/delete", { storeKey: key, id: "r-b2" });
    expect(await runInDurableObject(stub, (inst: RunHistoryDO) => inst.sweepSessions(candidates))).toBe(2);
    expect((await post("/runs/session/tail", { key: sA })).data).toEqual({ next: 0 });
    expect(await sql(key, `SELECT key FROM sessions`)).toEqual([]);
  });
});

describe("run ledger — intake receipts (item 59)", () => {
  const HOUR = 3_600_000;
  const intakeReceipt = (threadKey: string, over: Record<string, unknown> = {}) => ({
    verdict: "silent",
    reason: "answering a colleague",
    source: "model",
    mode: "classify",
    model: "prov/mini",
    gen: 3,
    threadKey,
    decidedAt: 5_000,
    ...over,
  });

  it("the insert is if-absent inside the transaction: the first write answers inserted with the row, a second on the key answers the first stored row; read answers the row or null", async () => {
    const key = storeKey();
    expect((await post("/runs/intake/read", { storeKey: key, key: "slack:C1:2.0" })).data).toEqual({ receipt: null });
    const first = intakeReceipt("slack:C1:1.0", {
      source: "error",
      providerFailure: "credit-or-quota-exhausted",
      reason: "The model provider's credit or quota is exhausted; this request did not start.",
    });
    expect(await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: first })).toMatchObject({
      status: 200,
      data: { inserted: true, stored: first },
    });
    const second = intakeReceipt("slack:C1:1.0", { verdict: "addressed", decidedAt: 6_000, gen: 9 });
    expect((await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: second })).data).toEqual({
      inserted: false,
      stored: first,
    });
    expect((await post("/runs/intake/read", { storeKey: key, key: "slack:C1:2.0" })).data).toEqual({
      receipt: first,
    });
  });

  it("claims one failure delivery atomically, releases a rejected post, and closes a successful post", async () => {
    const key = storeKey();
    const receiptKey = "slack:C1:2.0";
    await post("/runs/intake", {
      storeKey: key,
      key: receiptKey,
      receipt: intakeReceipt("slack:C1:1.0", { source: "error", providerFailure: "transient" }),
    });
    const claim = (poster: string, claimedAt = 5_000) =>
      post("/runs/intake/delivery/claim", { storeKey: key, key: receiptKey, poster, claimedAt });
    const [a, b] = await Promise.all([claim("poster-a"), claim("poster-b")]);
    expect([a.data.claimed, b.data.claimed].sort()).toEqual([false, true]);
    const owner = a.data.claimed === true ? "poster-a" : "poster-b";
    const loser = owner === "poster-a" ? "poster-b" : "poster-a";

    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: loser,
      delivered: false,
    });
    expect((await claim("poster-c")).data).toEqual({ claimed: false });
    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: owner,
      delivered: false,
    });
    expect((await claim("poster-c")).data).toEqual({ claimed: true });
    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: "poster-c",
      delivered: true,
    });
    expect((await claim("poster-d", Number.MAX_SAFE_INTEGER)).data).toEqual({ claimed: false });
  });

  it("list answers a thread's rows and rows since an instant, oldest first", async () => {
    const key = storeKey();
    const a = intakeReceipt("slack:C1:1.0", { decidedAt: 1_000 });
    const b = intakeReceipt("slack:C1:1.0", { decidedAt: 3_000, verdict: "addressed" });
    const other = intakeReceipt("slack:C2:9.0", { decidedAt: 2_000 });
    await post("/runs/intake", { storeKey: key, key: "slack:C1:3.0", receipt: b });
    await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: a });
    await post("/runs/intake", { storeKey: key, key: "slack:C2:9.5", receipt: other });
    expect((await post("/runs/intake/list", { storeKey: key, threadKey: "slack:C1:1.0" })).data).toEqual({
      receipts: [a, b],
    });
    expect((await post("/runs/intake/list", { storeKey: key, since: 2_000 })).data).toEqual({
      receipts: [other, b],
    });
    expect((await post("/runs/intake/list", { storeKey: key, threadKey: "slack:C1:1.0", since: 2_000 })).data).toEqual({
      receipts: [b],
    });
    expect((await post("/runs/intake/list", { storeKey: key })).data).toEqual({ receipts: [a, other, b] });
  });

  it("the alarm prunes by both arms of the bound: a 30 minute window keeps a row 24 hours, a two day window keeps it the window plus the drain deadline", async () => {
    const key = storeKey();
    const now = Date.now();
    const min30 = 30 * 60_000;
    const twoDays = 48 * HOUR;
    const at = (hoursAgo: number) => intakeReceipt("slack:C1:1.0", { decidedAt: now - hoursAgo * HOUR });
    // The 24-hour arm: a 30 minute window keeps rows 24 hours, no more.
    await post("/runs/intake", { storeKey: key, key: "k:24h-out", receipt: at(25), windowMs: min30 });
    await post("/runs/intake", { storeKey: key, key: "k:24h-kept", receipt: at(23), windowMs: min30 });
    // The window arm: a two-day window keeps rows the window plus the drain (90 min).
    await post("/runs/intake", { storeKey: key, key: "k:win-out", receipt: at(50), windowMs: twoDays });
    await post("/runs/intake", { storeKey: key, key: "k:win-kept", receipt: at(49), windowMs: twoDays });
    expect(await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(key)))).toBe(true); // armed by the first insert
    const read = async (k: string) =>
      (await post("/runs/intake/read", { storeKey: key, key: k })).data.receipt as unknown;
    expect(await read("k:24h-out")).toBeNull();
    expect(await read("k:24h-kept")).not.toBeNull();
    expect(await read("k:win-out")).toBeNull();
    expect(await read("k:win-kept")).not.toBeNull();
  });

  it("validates: a missing or overlong key, a malformed receipt or windowMs is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect((await post("/runs/intake", { storeKey: key, receipt: intakeReceipt("slack:C1:1.0") })).status).toBe(400);
    expect(
      (await post("/runs/intake", { storeKey: key, key: "k".repeat(300), receipt: intakeReceipt("slack:C1:1.0") }))
        .status,
    ).toBe(400);
    expect(
      (await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: { verdict: "maybe" } })).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/intake", {
          storeKey: key,
          key: "slack:C1:2.0",
          receipt: intakeReceipt("slack:C1:1.0"),
          windowMs: -5,
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/intake/read", { storeKey: key })).status).toBe(400);
    expect((await post("/runs/intake/list", { storeKey: key, since: "yesterday" })).status).toBe(400);
    expect(
      (
        await post(
          "/runs/intake",
          { storeKey: key, key: "k", receipt: intakeReceipt("slack:C1:1.0") },
          { "content-type": "application/json" },
        )
      ).status,
    ).toBe(401);
  });
});

describe("the plane's admission stage — /plane/admit, reservations, the seal's walk (orchestration-plane; record 0064)", () => {
  const requester = "slack:UALICE";
  const admit = (key: string, threadKey: string, text: string) =>
    post("/plane/admit", { storeKey: key, threadKey, requester, request: { text } });

  it("two asks a second apart on one thread: the first is admitted with a reservation, the second queued at position 1; the first's claim promotes the reservation; the seal admits the queued run with its attaching row", async () => {
    const key = storeKey();
    const t = "slack:C1:1.0";
    const one = await admit(key, t, "one");
    expect(one.status).toBe(200);
    expect(one.data.kind).toBe("admitted");
    expect(typeof one.data.reservation).toBe("string");
    const two = await admit(key, t, "two");
    expect(two.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "thread_free", threadKey: t, met: false }],
    });
    const queuedId = two.data.id as string;
    const queued = await post("/plane/queued", { storeKey: key, runId: queuedId });
    expect(queued.data.row).toMatchObject({ runId: queuedId, state: "waiting" });
    expect(queued.data.row).not.toHaveProperty("liveState");
    // The ledger claim promotes the reservation: the row retires in the claim's
    // transaction and the live row holds the thread from there.
    expect((await post("/runs/claim", claimBody(key, "r1", t))).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT * FROM plane_reservations`).toArray()).toEqual([]);
    });
    // A third ask still queues — the thread is live, position ranks it behind the second.
    expect((await admit(key, t, "three")).data).toMatchObject({ kind: "queued", position: 2 });
    // The seal flips thread_free: the queued run is admitted, its admit effect
    // is offered carrying the stored request, and its attaching row exists
    // under the plane's id (the restart-from-request path's shape).
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) })).status,
    ).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const effects = inst.openPlaneEffects();
      expect(effects.map((e) => e.id)).toEqual([`admit:${queuedId}`]);
      expect(effects[0]).toMatchObject({ kind: "admit", runId: queuedId, threadKey: t, request: { text: "two" } });
      const live = await inst.listLive();
      const row = live.find((r) => r.runId === queuedId)!;
      expect(row).toMatchObject({ threadKey: t, ownerGen: "plane", phase: "attaching" });
      expect(row.meta.request).toEqual({ text: "two" });
      expect(await inst.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: true, owners: [] });
    });
  });

  it("a duplicate admit decision after a roll keeps the effect's first offer and the attaching row (INSERT OR IGNORE)", async () => {
    const key = storeKey();
    const t = "slack:C2:2.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
  });

  it("runs stop on a queued id withdraws it: the row goes withdrawn, a second withdraw answers false, and the seal admits nothing", async () => {
    const key = storeKey();
    const t = "slack:C3:3.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    expect((await post("/plane/withdraw", { storeKey: key, runId: q })).data).toEqual({ withdrawn: true });
    expect((await post("/plane/withdraw", { storeKey: key, runId: q })).data).toEqual({ withdrawn: false });
    expect((await post("/plane/queued", { storeKey: key, runId: q })).data.row).toMatchObject({ state: "withdrawn" });
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects()).toEqual([]);
    });
  });

  it("a pending deploy queues an ask on deploy_settled and deploy.landed flips it, admitting the queued run", async () => {
    const key = storeKey();
    const t = "slack:C4:4.0";
    expect((await post("/plane/deploy", { storeKey: key, phase: "pending" })).status).toBe(200);
    const asked = await admit(key, t, "hi");
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "deploy_settled", met: false }],
    });
    const landed = await post("/plane/deploy", { storeKey: key, phase: "landed", version: "1.0.0" });
    expect(landed.data).toEqual({ ok: true, admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.kind)).toEqual(["admit"]);
    });
  });

  const sealedRunFailureOutput: string[] = [];

  it.fails("the real onTestFailed lifecycle emits completed and pending sealed-run stages", async (context) => {
    let now = 10;
    const timed = timeSealedRunStages(
      (handler) => context.onTestFailed(handler),
      () => now,
      (message) => sealedRunFailureOutput.push(message),
    );
    await timed("admit", async () => {
      now = 15;
    });
    void timed("claim", () => new Promise(() => {}));
    now = 24;

    expect("forced failure").toBe("success");
  });

  it("preserves completed and pending stage diagnostics from the genuine failure", () => {
    expect(sealedRunFailureOutput).toEqual([
      "[memory diagnostics] sealed-run stages: completed=admit=5ms; pending=claim=9ms",
    ]);
  });

  it("effects for a sealed run are dropped at the seal: an admitted-then-finished run's open admit goes with its finish", async (context) => {
    const timed = timeSealedRunStages((handler) => context.onTestFailed(handler));
    const key = storeKey();
    const t = "slack:C5:5.0";
    await timed("admit", () => admit(key, t, "one"));
    await timed("claim", () => post("/runs/claim", claimBody(key, "r1", t)));
    const q = (await timed("queued admit", () => admit(key, t, "two"))).data.id as string;
    await timed("first finish", () =>
      post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) }),
    );
    // The plane's attaching row is another generation's with an expired lease:
    // the reclaim takes it (the restart-from-request path) and its finish seals it.
    const reclaimed = await timed("reclaim", () =>
      post("/runs/reclaim", { storeKey: key, gen: "g2", now: Date.now(), leaseMs: LEASE_MS }),
    );
    expect((reclaimed.data.runs as Array<{ row: { runId: string } }>).map((r) => r.row.runId)).toContain(q);
    expect(
      (
        await timed("second finish", () =>
          post("/runs/finish", { storeKey: key, runId: q, gen: "g2", record: record(q, t) }),
        )
      ).status,
    ).toBe(200);
    await timed("final inspection", () =>
      runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
        expect(inst.openPlaneEffects()).toEqual([]);
      }),
    );
  });

  it("a push that fails leaves the effect on the next heartbeat answer: the bot answered 404, nothing was acked, and the offer rides the heartbeat", async () => {
    const key = storeKey();
    const t = "slack:C6:6.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    const pushes: { url: string; auth: string | null }[] = [];
    let startedPush!: () => void;
    let finishPush!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      startedPush = resolve;
    });
    const pushCanFinish = new Promise<void>((resolve) => {
      finishPush = resolve;
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      // A BOT binding whose push dead-ends (the container down, an older bot
      // without the route): the fetch answers 404 and delivers nothing.
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async (url: string, init: { headers: Record<string, string> }) => {
            pushes.push({ url: String(url), auth: init.headers.authorization ?? null });
            startedPush();
            await pushCanFinish;
            return new Response("not found", { status: 404 });
          },
        },
      };
    });
    // The seal walks the queue and pushes the admit. Its response stays
    // independent, while waitUntil and the test guard own the unfinished I/O.
    const finishing = post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await pushStarted;
    expect(() => assertNoPendingBackgroundTasks()).toThrow(/plane effect push \(admit:/);
    finishPush();
    await finishing;
    await vi.waitFor(() => expect(() => assertNoPendingBackgroundTasks()).not.toThrow());
    expect(pushes).toEqual([{ url: "https://bot/plane/effects", auth: "Bearer test-token" }]);
    // Nothing was acked: the offer stands and rides the next heartbeat answer.
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
    const t2 = "slack:C6:6.1";
    await post("/runs/claim", claimBody(key, "r2", t2));
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r2", gen: "g1", leaseMs: LEASE_MS });
    expect((beat.data.effects as Array<{ id: string }>).map((e) => e.id)).toEqual([`admit:${q}`]);
  });

  it("validates: a missing threadKey, requester or request is 400; a malformed withdraw run id is 400", async () => {
    const key = storeKey();
    expect((await post("/plane/admit", { storeKey: key, requester, request: {} })).status).toBe(400);
    expect((await post("/plane/admit", { storeKey: key, threadKey: "slack:C1:1.0", request: {} })).status).toBe(400);
    expect(
      (await post("/plane/admit", { storeKey: key, threadKey: "slack:C1:1.0", requester, request: [] })).status,
    ).toBe(400);
    expect((await post("/plane/withdraw", { storeKey: key, runId: "" })).status).toBe(400);
    expect((await post("/plane/deploy", { storeKey: key, phase: "later" })).status).toBe(400);
  });
});

describe("the plane's resident stage — /plane/level, /plane/observe, the re-ask alarm (orchestration-plane item 9; record 0064)", () => {
  const requester = "slack:UALICE";
  const level = (key: string, resident: string, name: string, side: string, generation = "gen-1") =>
    post("/plane/level", { storeKey: key, resident, name, side, generation });
  const residentAsk = (key: string, threadKey: string, resident: string, over: Record<string, unknown> = {}) =>
    post("/plane/admit", {
      storeKey: key,
      threadKey,
      requester,
      request: { text: "code" },
      stage: "resident",
      resident,
      ...over,
    });

  it("a queued admission awaits its alarm scheduling before the RPC response returns", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    let awaited = false;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () =>
        ({
          then(resolve: () => void) {
            awaited = true;
            resolve();
          },
        }) as Promise<void>;
    });

    expect((await residentAsk(key, "slack:C10:0.0", "owner/repo")).data.kind).toBe("queued");
    expect(awaited).toBe(true);
  });

  it("a queued admission returns its committed answer when alarm scheduling fails", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () => Promise.reject(new Error("alarm unavailable"));
    });

    const asked = await residentAsk(key, "slack:C10:0.1", "owner/repo");
    expect(asked).toMatchObject({ status: 200, data: { kind: "queued", position: 1 } });
    expect((await post("/plane/queued", { storeKey: key, runId: asked.data.id })).data.row).toMatchObject({
      state: "waiting",
    });
  });

  it("a level report lands in plane_levels; an above seat queues a resident ask holding no reservation; the below report admits it with its attaching row", async () => {
    const key = storeKey();
    const t = "slack:C10:1.0";
    expect((await level(key, "owner/repo", "seat", "above")).data).toEqual({ admitted: 0 });
    const asked = await residentAsk(key, t, "owner/repo");
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "seat", resident: "owner/repo", met: false }],
    });
    const q = asked.data.id as string;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT resident, name, side FROM plane_levels`).toArray()).toEqual([
        { resident: "owner/repo", name: "seat", side: "above" },
      ]);
      // A resident-stage ask holds nothing: its thread was reserved at admission.
      expect(sql.exec(`SELECT * FROM plane_reservations WHERE run_id = ?`, q).toArray()).toEqual([]);
      expect((await inst.listLive()).find((r) => r.runId === q)).toBeUndefined();
    });
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
      expect((await inst.listLive()).find((r) => r.runId === q)).toMatchObject({
        ownerGen: "plane",
        phase: "attaching",
      });
    });
  });

  it("an observation after the admit's ack re-enters the row and the next below report re-offers the SAME admit — the acked row never swallows it", async () => {
    const key = storeKey();
    const t = "slack:C11:1.0";
    await level(key, "owner/repo", "seat", "above");
    const q = (await residentAsk(key, t, "owner/repo")).data.id as string;
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    // The bot took the offer and acked it done; then the attach met the pool refusal.
    await post("/plane/ack", { storeKey: key, id: `admit:${q}`, outcome: "done" });
    let alarmAwaited = false;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () =>
        ({
          then(resolve: () => void) {
            alarmAwaited = true;
            resolve();
          },
        }) as Promise<void>;
    });
    const observed = await post("/plane/observe", {
      storeKey: key,
      runId: q,
      resident: "owner/repo",
      refusal: "user-pool-exhausted: no free worker user",
    });
    expect(observed.data).toEqual({ reentered: true });
    expect(alarmAwaited).toBe(true);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      // The refusal is evidence: the seat level is written back above.
      expect(sql.exec(`SELECT side FROM plane_levels WHERE resident = 'owner/repo' AND name = 'seat'`).one()).toEqual({
        side: "above",
      });
      expect(sql.exec(`SELECT state FROM plane_queue WHERE run_id = ?`, q).one()).toEqual({ state: "waiting" });
      expect(inst.openPlaneEffects()).toEqual([]);
    });
    // The next below report walks the re-entered row: the admit is offered
    // again despite the acked row under the same id (the pre-insert delete).
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
    // An observation for a run the queue holds waiting (not admitted) is a no-op.
    expect(
      (
        await post("/plane/observe", {
          storeKey: key,
          runId: "unknown-run",
          resident: "owner/repo",
          refusal: "draining",
        })
      ).data,
    ).toEqual({ reentered: false });
  });

  it("an observation returns its committed re-entry when alarm scheduling fails", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    const q = (await residentAsk(key, "slack:C11:1.1", "owner/repo")).data.id as string;
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await post("/plane/ack", { storeKey: key, id: `admit:${q}`, outcome: "done" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () => Promise.reject(new Error("alarm unavailable"));
    });

    expect(
      await post("/plane/observe", {
        storeKey: key,
        runId: q,
        resident: "owner/repo",
        refusal: "draining",
      }),
    ).toMatchObject({ status: 200, data: { reentered: true } });
    expect((await post("/plane/queued", { storeKey: key, runId: q })).data.row).toMatchObject({ state: "waiting" });
  });

  it("a drain post opens the resident-drain window — an ask queues on it, a restartOf passes — and the below post lifts it, admitting the queued run", async () => {
    const key = storeKey();
    const t = "slack:C12:1.0";
    expect((await level(key, "registry", "drain", "above")).data).toEqual({ admitted: 0 });
    const asked = await post("/plane/admit", { storeKey: key, threadKey: t, requester, request: { text: "hi" } });
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "window_open", window: "resident-drain", met: false }],
    });
    // A restart of a run the resident already holds passes the window.
    expect(
      (
        await post("/plane/admit", {
          storeKey: key,
          threadKey: "slack:C12:2.0",
          requester,
          request: {},
          restartOf: true,
        })
      ).data.kind,
    ).toBe("admitted");
    expect((await level(key, "registry", "drain", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${asked.data.id as string}`]);
    });
  });

  it("the re-ask alarm probes a silent resident within the cadence, pulls the sweep alarm forward, and re-offers the probe after its ack", async () => {
    const key = storeKey();
    const cadence = 60_000;
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await level(key, "owner/repo", "memory", "above");
    const asked = await residentAsk(key, "slack:C13:1.0", "owner/repo", { reaskMs: cadence });
    expect(asked.data).toMatchObject({
      kind: "queued",
      waiting: [{ kind: "memory", resident: "owner/repo", met: false }],
    });
    // The cadence's pull-forward, judged directly on the private ensure (the
    // pool's alarm helper deletes the scheduled alarm around a trigger, so its
    // stored time cannot be read back after one): a far sweep alarm is pulled
    // to the cadence; an earlier alarm is never pushed back.
    type WithAlarm = {
      ctx: DurableObjectState;
      sql: SqlStorage;
      ensurePlaneReaskAlarm(now: number): Promise<void>;
    };
    await runInDurableObject(stub, async (inst: RunHistoryDO) => {
      const priv = inst as unknown as WithAlarm;
      const now = Date.now();
      await priv.ctx.storage.setAlarm(now + 6 * 3_600_000);
      await priv.ensurePlaneReaskAlarm(now);
      expect(((await priv.ctx.storage.getAlarm()) as number) - now).toBeLessThanOrEqual(cadence);

      const sooner = now + cadence / 2;
      await priv.ctx.storage.setAlarm(sooner);
      await priv.ensurePlaneReaskAlarm(now);
      expect(await priv.ctx.storage.getAlarm()).toBe(sooner);

      // Make the report old enough for a probe without installing a native,
      // one-millisecond alarm that can still be in flight after this case.
      priv.sql.exec(`UPDATE plane_levels SET reported_at = ? WHERE resident = ?`, now - cadence - 1, "owner/repo");
    });
    const openIds = () =>
      runInDurableObject(stub, async (inst: RunHistoryDO) => inst.openPlaneEffects().map((e) => e.id));

    // The helper consumes and awaits the alarm handler. Its re-armed future
    // slot is then consumed the same way, so no handler crosses the test edge.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await openIds()).toEqual(["probe:owner/repo"]);
    await post("/plane/ack", { storeKey: key, id: "probe:owner/repo", outcome: "done" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await openIds()).toEqual(["probe:owner/repo"]);

    await post("/plane/ack", { storeKey: key, id: "probe:owner/repo", outcome: "done" });
    expect((await level(key, "owner/repo", "memory", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(stub, async (inst: RunHistoryDO) => {
      await (inst as unknown as WithAlarm).ctx.storage.deleteAlarm();
    });
  });

  it("a paused-maintenance alarm still probes a waiting resident and offers an expired lease", async () => {
    const key = storeKey();
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await level(key, "owner/repo", "memory", "above");
    await residentAsk(key, "slack:C13:paused", "owner/repo", { reaskMs: 60_000 });
    expect(await post("/runs/claim", claimBody(key, "lease-paused", "slack:C13:lease-paused"))).toMatchObject({
      status: 200,
    });
    await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE plane_levels SET reported_at = ? WHERE resident = ?`,
        Date.now() - 61_000,
        "owner/repo",
      );
      state.storage.sql.exec(`UPDATE live_runs SET lease_until = 1 WHERE run_id = ?`, "lease-paused");
      const subject = instance as unknown as { env: { RUN_HISTORY_MAINTENANCE?: string } };
      const prior = subject.env.RUN_HISTORY_MAINTENANCE;
      subject.env.RUN_HISTORY_MAINTENANCE = "paused";
      try {
        await instance.alarm();
      } finally {
        subject.env.RUN_HISTORY_MAINTENANCE = prior;
      }
      expect(instance.openPlaneEffects().map((effect) => effect.id)).toContain("probe:owner/repo");
      expect(
        state.storage.sql.exec(`SELECT run_id FROM live_runs WHERE run_id = 'lease-paused'`).toArray(),
      ).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("validates: a level with a missing resident, a bad name or side, or a non-string generation is 400; an observation with a bad run id, missing resident or empty refusal is 400", async () => {
    const key = storeKey();
    expect((await post("/plane/level", { storeKey: key, name: "seat", side: "below", generation: "g" })).status).toBe(
      400,
    );
    expect(
      (await post("/plane/level", { storeKey: key, resident: "r", name: "cpu", side: "below", generation: "g" }))
        .status,
    ).toBe(400);
    expect(
      (await post("/plane/level", { storeKey: key, resident: "r", name: "seat", side: "over", generation: "g" }))
        .status,
    ).toBe(400);
    expect((await post("/plane/level", { storeKey: key, resident: "r", name: "seat", side: "below" })).status).toBe(
      400,
    );
    expect(
      (await post("/plane/observe", { storeKey: key, runId: "no spaces!", resident: "r", refusal: "draining" })).status,
    ).toBe(400);
    expect((await post("/plane/observe", { storeKey: key, runId: "r1", refusal: "draining" })).status).toBe(400);
    expect((await post("/plane/observe", { storeKey: key, runId: "r1", resident: "r", refusal: "" })).status).toBe(400);
  });
});

describe("the plane's checkpoint steers and the provider condition — the heartbeat body, /plane/park, /plane/level provider (record 0064)", () => {
  const SENTENCE =
    "finish the step you are on, push a checkpoint and end the round; start no new command; the resident takes your push";
  const beat = (key: string, runId: string, facts?: Record<string, unknown>) =>
    post("/runs/heartbeat", { storeKey: key, runId, gen: "g1", leaseMs: 30_000, ...(facts ? { facts } : {}) });
  const facts = (round: number, over: Record<string, unknown> = {}) => ({
    round,
    coding: true,
    startedAt: 1,
    inFlight: { callId: "c1", tool: "bash", sinceAt: 1, boundMs: 1 },
    ...over,
  });
  const inbox = async (key: string, runId: string) =>
    (await post("/runs/inbox/read", { storeKey: key, runId, afterSeq: 0 })).data.items as Array<{
      seq: number;
      message: Record<string, unknown>;
    }>;

  it("a heartbeat whose facts cross a bound writes ONE inbox row — the fixed sentence, sender plane — in the heartbeat's own transaction; a second beat in the round writes none, a new round writes one, a second cause repeats no sentence", async () => {
    const key = storeKey();
    const t = "slack:C20:1.0";
    await post("/runs/claim", claimBody(key, "r1", t));
    expect((await beat(key, "r1", facts(1))).status).toBe(200);
    let items = await inbox(key, "r1");
    expect(items).toHaveLength(1);
    expect(items[0].message).toMatchObject({ text: SENTENCE, userId: "plane" });
    // Same round, same cause: nothing more; a second cause (no_push, far past the window) records its row but repeats no sentence.
    await beat(key, "r1", facts(1));
    await beat(key, "r1", facts(1, { inFlight: undefined, startedAt: 1, pushedHead: undefined }));
    expect(await inbox(key, "r1")).toHaveLength(1);
    // A new round steers once more.
    await beat(key, "r1", facts(2));
    items = await inbox(key, "r1");
    expect(items).toHaveLength(2);
    expect(items[1].message).toMatchObject({ text: SENTENCE, userId: "plane" });
  });

  it("a facts-less heartbeat and healthy facts steer nothing", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r2", "slack:C20:2.0"));
    await beat(key, "r2");
    await beat(key, "r2", {
      round: 1,
      coding: true,
      startedAt: Date.now(),
      inFlight: { callId: "c", tool: "bash", sinceAt: Date.now(), boundMs: 600_000 },
    });
    expect(await inbox(key, "r2")).toEqual([]);
  });

  it("a provider down and parked live run recover atomically as one durable row and one pushed offered steer; repeat up writes nothing", async () => {
    const key = storeKey();
    const pushed: Array<Record<string, unknown>> = [];
    await post("/runs/claim", claimBody(key, "r3", "slack:C20:3.0"));
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async (_url: string, init: { body: string }) => {
            pushed.push(JSON.parse(init.body) as Record<string, unknown>);
            return new Response("ok");
          },
        },
      };
    });
    expect(
      (
        await post("/plane/level", {
          storeKey: key,
          name: "provider",
          provider: "anthropic",
          side: "down",
          cause: "credit-or-quota-exhausted",
        })
      ).data,
    ).toEqual({ admitted: 0 });
    expect((await post("/plane/park", { storeKey: key, runId: "r3", provider: "anthropic" })).data).toEqual({
      parked: true,
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT resident, name, side, cause FROM plane_levels`).toArray()).toEqual([
        {
          resident: "anthropic",
          name: "provider",
          side: "above",
          cause: "credit-or-quota-exhausted",
        },
      ]);
      expect(sql.exec(`SELECT kind, key FROM plane_reservations`).toArray()).toEqual([
        { kind: "park", key: "anthropic#r3" },
      ]);
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    const items = await inbox(key, "r3");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      seq: 1,
      message: { userId: "plane", plane: { steer: "reissue", provider: "anthropic" } },
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const effect = (pushed[0]!.effects as Array<Record<string, unknown>>)[0];
    expect(effect).toMatchObject({
      id: "steer:r3:1",
      kind: "steer",
      runId: "r3",
      seq: 1,
      message: items[0]!.message,
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT * FROM plane_reservations WHERE kind = 'park'`).toArray()).toEqual([]);
      expect(inst.openPlaneEffects()).toEqual([effect]);
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    expect(await inbox(key, "r3")).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it("fences a pushed steer and renews its owner's lease atomically before registry delivery", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r-fenced", "slack:C20:3.1", "gen-stale"));
    await post("/plane/park", { storeKey: key, runId: "r-fenced", provider: "anthropic" });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });

    expect(
      (
        await post("/plane/steer/fence", {
          storeKey: key,
          id: "steer:r-fenced:1",
          runId: "r-fenced",
          gen: "gen-stale",
          leaseMs: LEASE_MS,
        })
      ).data,
    ).toEqual({ accepted: true });
    const [row] = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>;
    expect(
      (
        await post("/runs/reclaim", {
          storeKey: key,
          gen: "gen-owner",
          now: row!.leaseUntil - 1,
          leaseMs: LEASE_MS,
        })
      ).data.runs,
    ).toEqual([]);
    expect(
      (
        await post("/runs/reclaim", {
          storeKey: key,
          gen: "gen-owner",
          now: row!.leaseUntil,
          leaseMs: LEASE_MS,
        })
      ).data.runs,
    ).toMatchObject([{ row: { runId: "r-fenced", ownerGen: "gen-owner" } }]);
    expect(
      (
        await post("/plane/steer/fence", {
          storeKey: key,
          id: "steer:r-fenced:1",
          runId: "r-fenced",
          gen: "gen-stale",
          leaseMs: LEASE_MS,
        })
      ).data,
    ).toEqual({ accepted: false });
  });

  it("a stale generation cannot close a steer offer after reclaim; the durable owner heartbeat receives and closes it", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r-owner", "slack:C20:3.1", "gen-stale"));
    await post("/plane/park", { storeKey: key, runId: "r-owner", provider: "anthropic" });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    const reclaimed = await post("/runs/reclaim", {
      storeKey: key,
      gen: "gen-owner",
      now: Date.now() + 2 * LEASE_MS,
      leaseMs: LEASE_MS,
    });
    expect(reclaimed.data.runs).toMatchObject([{ row: { runId: "r-owner", ownerGen: "gen-owner" } }]);

    await post("/plane/ack", {
      storeKey: key,
      id: "steer:r-owner:1",
      outcome: "done",
      owner: { runId: "r-owner", gen: "gen-stale" },
    });
    const ownerBeat = () =>
      post("/runs/heartbeat", { storeKey: key, runId: "r-owner", gen: "gen-owner", leaseMs: LEASE_MS });
    expect((await ownerBeat()).data.effects).toMatchObject([{ id: "steer:r-owner:1", kind: "steer", seq: 1 }]);

    await post("/plane/ack", {
      storeKey: key,
      id: "steer:r-owner:1",
      outcome: "done",
      owner: { runId: "r-owner", gen: "gen-owner" },
    });
    expect((await ownerBeat()).data.effects).toEqual([]);
  });

  it("a failed provider-up transaction writes neither the durable row nor its steer effect", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r4", "slack:C20:4.0"));
    await post("/plane/park", { storeKey: key, runId: "r4", provider: "anthropic" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      for (let i = 0; i < 256; i++)
        sql.exec(
          `INSERT INTO plane_effects (id, body_json, offered_at, acked_at) VALUES (?, ?, ?, NULL)`,
          `probe:cap-${i}`,
          JSON.stringify({ id: `probe:cap-${i}`, kind: "probe", resident: `r-${i}` }),
          i,
        );
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(() => inst.planeLevel({ name: "provider", provider: "anthropic", side: "up" }, Date.now())).toThrow(
        /plane_effects total cap/,
      );
    });
    expect(await inbox(key, "r4")).toEqual([]);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT COUNT(*) AS n FROM plane_effects`).one().n).toBe(256);
      expect(sql.exec(`SELECT key FROM plane_reservations WHERE kind = 'park'`).toArray()).toEqual([
        { key: "anthropic#r4" },
      ]);
    });
  });

  it("a failed live push leaves both the durable row and steer offer for an owner heartbeat; sealing first removes the park and produces no steer", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r5", "slack:C20:5.0"));
    await post("/plane/park", { storeKey: key, runId: "r5", provider: "anthropic" });
    let pushed!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      pushed = resolve;
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async () => {
            pushed();
            return new Response("down", { status: 503 });
          },
        },
      };
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    await pushStarted;
    expect(await inbox(key, "r5")).toHaveLength(1);
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r5", gen: "g1", leaseMs: LEASE_MS });
    expect(beat.data.effects).toMatchObject([{ id: "steer:r5:1", kind: "steer", seq: 1 }]);

    const sealedKey = storeKey();
    const thread = "slack:C20:5.1";
    await post("/runs/claim", claimBody(sealedKey, "r6", thread));
    await post("/plane/park", { storeKey: sealedKey, runId: "r6", provider: "anthropic" });
    await post("/runs/finish", { storeKey: sealedKey, runId: "r6", gen: "g1", record: record("r6", thread) });
    await post("/plane/level", { storeKey: sealedKey, name: "provider", provider: "anthropic", side: "up" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sealedKey)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects()).toEqual([]);
    });
  });
});

describe("the plane's endings and the alarm — the cause on close, /plane/reclaimed, the lease-end offer (record 0064)", () => {
  const TAG = { parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" };
  type Sent = { instance: string; type: string; payload: unknown };

  /** The Workflow binding doubled on the live object (item 47's pattern). */
  async function coordinatorDouble(key: string): Promise<Sent[]> {
    const sent: Sent[] = [];
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const holder = inst as unknown as { env: Record<string, unknown> };
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async (id: string) => ({
            sendEvent: async (event: { type: string; payload: unknown }) => {
              sent.push({ instance: id, type: event.type, payload: event.payload });
            },
          }),
        },
      };
    });
    return sent;
  }

  async function endingOf(key: string, runId: string): Promise<unknown> {
    let ending: unknown;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      ending = inst.planeEndingOf(runId);
    });
    return ending;
  }

  it("the owner's finish records ended {kind, cause} exactly when the row closes — completed maps to completed, an interrupted record with `restarting` to resident_replaced, a bare interrupted to lease_lapsed — and the first cause stands", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:1.0") });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "completed", cause: "completed" });
    await post("/runs/claim", claimBody(key, "r2", "slack:C1:2.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r2",
      gen: "g1",
      record: { ...record("r2", "slack:C1:2.0"), status: "interrupted", restarting: true },
    });
    expect(await endingOf(key, "r2")).toMatchObject({ kind: "interrupted", cause: "resident_replaced" });
    await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r3",
      gen: "g1",
      record: { ...record("r3", "slack:C1:3.0"), status: "interrupted" },
    });
    expect(await endingOf(key, "r3")).toMatchObject({ kind: "interrupted", cause: "lease_lapsed" });
    // First cause stands: a later report cannot rewrite r2's ending.
    const again = await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "r2", outcome: "closed" }] });
    expect(again.data).toEqual({ recorded: [{ runId: "r2", cause: "resident_replaced" }] });
    expect(await endingOf(key, "r2")).toMatchObject({ cause: "resident_replaced" });
  });

  it("a same-id successor's finish replaces a standing resident_replaced — a restarting close is the run continuing, not its end, so a restarted run that completes reads completed as its record does", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:9.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: { ...record("r1", "slack:C1:9.0"), status: "interrupted", restarting: true },
    });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "interrupted", cause: "resident_replaced" });
    // The restart reuses the run's id (run-history item 42) and completes.
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:9.0"));
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:9.0") });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "completed", cause: "completed" });
    // A completed ending is final: a later report cannot rewrite it.
    await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "r1", outcome: "closed" }] });
    expect(await endingOf(key, "r1")).toMatchObject({ cause: "completed" });
  });

  it("/plane/reclaimed records lease_lapsed for a closed row and nothing for resume, restart or rehost — a roll that resumes every row assigns nothing", async () => {
    const key = storeKey();
    const r = await post("/plane/reclaimed", {
      storeKey: key,
      outcomes: [
        { runId: "a", outcome: "resume" },
        { runId: "b", outcome: "restart" },
        { runId: "c", outcome: "rehost" },
        { runId: "d", outcome: "closed" },
      ],
    });
    expect(r).toEqual({ status: 200, data: { recorded: [{ runId: "d", cause: "lease_lapsed" }] } });
    expect(await endingOf(key, "a")).toBeNull();
    expect(await endingOf(key, "b")).toBeNull();
    expect(await endingOf(key, "c")).toBeNull();
    expect(await endingOf(key, "d")).toMatchObject({ kind: "interrupted", cause: "lease_lapsed" });
    // A malformed word is refused by name.
    expect(
      (await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "x", outcome: "ended" }] })).status,
    ).toBe(400);
  });

  it("a claim whose meta carries restartOf under a coordinator sends the parent one child-resumed-<runId>; a claim without restartOf sends nothing; a Worker without the binding claims as before", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    const meta = { ...claimBody(key, "r1", "slack:C2:1.0").run.meta, ...TAG, restartOf: "r1" };
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C2:1.0", "g1", { meta }))).data).toEqual({
      ok: true,
    });
    expect(sent).toEqual([
      {
        instance: "ship_acme_api_1",
        type: "child-resumed-r1",
        payload: expect.objectContaining({ runId: "r1", kind: "resumed", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // Without restartOf: a plain claim under the same coordinator says nothing.
    await post(
      "/runs/claim",
      claimBody(key, "r2", "slack:C2:2.0", "g1", {
        meta: { ...claimBody(key, "r2", "slack:C2:2.0").run.meta, ...TAG },
      }),
    );
    expect(sent).toHaveLength(1);
    // A Worker without the binding: the claim still lands (no throw, no send).
    const bare = storeKey();
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(bare, "r9", "slack:C2:9.0", "g1", {
            meta: { ...claimBody(bare, "r9", "slack:C2:9.0").run.meta, ...TAG, restartOf: "r9" },
          }),
        )
      ).data,
    ).toEqual({ ok: true });
  });

  it("the alarm at a lease end offers the row and never ends a run — the row stays live and unclosed, and the owner's heartbeat re-arms the alarm to the new earliest", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C3:1.0"));
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    const armed = await runInDurableObject(stub, async (inst: RunHistoryDO) =>
      (inst as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm(),
    );
    expect(armed).not.toBeNull();
    // The claim armed the alarm at the lease end (within the lease, not the 6 h sweep).
    expect(armed! - Date.now()).toBeLessThanOrEqual(LEASE_MS);
    // Fire it as if the lease end passed: the row is offered, never closed.
    expect(await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(key)))).toBe(true);
    const live = await post("/runs/live", { storeKey: key });
    expect((live.data.runs as { runId: string }[]).map((r) => r.runId)).toEqual(["r1"]);
    expect(await endingOf(key, "r1")).toBeNull();
    // The owner's heartbeat extends the lease and moves the plane's alarm on.
    await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    const rearmed = await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) =>
      (inst as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm(),
    );
    expect(rearmed).not.toBeNull();
    expect(rearmed!).toBeGreaterThanOrEqual(armed!);
  });

  it("a consumed alarm never strands a static due — ensurePlaneAlarm judges the armed slot, not the meta row, and an earlier foreign alarm is left to fire first", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C3:2.0"));
    type WithAlarm = {
      ctx: { storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> } };
      ensurePlaneAlarm(now: number): Promise<void>;
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const priv = inst as unknown as WithAlarm;
      const now = Date.now();
      // An earlier alarm (the re-ask's) fired and was consumed; the handler
      // re-armed the sweep far out. The earliest due (the lease end) did not
      // move, so the meta row still equals it — the wake must be re-armed.
      await priv.ctx.storage.setAlarm(now + 6 * 3_600_000);
      await priv.ensurePlaneAlarm(now);
      expect(((await priv.ctx.storage.getAlarm()) as number) - now).toBeLessThanOrEqual(LEASE_MS);
      // An earlier alarm someone else armed is left to fire first.
      const sooner = now + 1;
      await priv.ctx.storage.setAlarm(sooner);
      await priv.ensurePlaneAlarm(now);
      expect(await priv.ctx.storage.getAlarm()).toBe(sooner);
    });
  });
});

describe("run ledger — durable branch publication", () => {
  it.each(["", "[]", "null", '{"version":2}', "{"])(
    "preserves unreadable private publication evidence and refuses replacement: %s",
    async (raw) => {
      const key = storeKey();
      const id = "unreadable-publication";
      const terminal = record(id, "slack:C1:unreadable-publication");
      expect((await post("/runs/put", { storeKey: key, record: terminal })).status).toBe(200);
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
        state.storage.sql.exec(`UPDATE runs SET work_evidence_json = ?, finished_at = 1 WHERE run_id = ?`, raw, id);
        await expect(instance.put(terminal)).rejects.toThrow();
        (instance as unknown as { trim(policy: Record<string, number>, now: number, fence: undefined): unknown }).trim(
          { retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024 },
          Date.now(),
          undefined,
        );
        expect(
          state.storage.sql
            .exec<{ work_evidence_json: string }>(`SELECT work_evidence_json FROM runs WHERE run_id = ?`, id)
            .one().work_evidence_json,
        ).toBe(raw);
      });
      expect((await post("/runs/get", { storeKey: key, id })).data.record).toBeNull();
    },
  );

  it("advances listing past unreadable protected bytes to an older unresolved producer", async () => {
    const key = storeKey();
    const id = "older-intent";
    const thread = "slack:C1:older-intent";
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    await post("/runs/state", {
      storeKey: key,
      runId: id,
      gen: "g1",
      state: {
        branchPublication: { version: 1, repo: "private/repo", branches: [], complete: false },
      },
    });
    await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) });
    await post("/runs/put", { storeKey: key, record: record("newer-unreadable", "slack:C1:newer-unreadable") });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET summary_json = '{}', finished_at = ? WHERE run_id = 'newer-unreadable'`,
        Date.now(),
      );
    });
    const first = (await post("/runs/list", { storeKey: key, limit: 1 })).data;
    expect(first.items).toEqual([]);
    expect(first.nextBefore).toMatchObject({ id: "newer-unreadable" });
    const next = (
      await post("/runs/list", {
        storeKey: key,
        limit: 1,
        before: first.nextBefore.finishedAt,
        beforeId: first.nextBefore.id,
      })
    ).data;
    expect(next.items.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it.each(["missing", "malformed", "different"])(
    "retains the terminal outcome using only saved producer publication: %s",
    async (mode) => {
      const key = storeKey();
      const id = `publication-${mode}`;
      const thread = `slack:C1:${id}`;
      const projection = { version: 1 as const, repo: "private/repo", branches: [], complete: true };
      expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
      if (mode !== "missing")
        expect(
          (
            await post("/runs/state", {
              storeKey: key,
              runId: id,
              gen: "g1",
              state: { branchPublication: mode === "malformed" ? { ...projection, version: 2 } : projection },
            })
          ).status,
        ).toBe(200);
      const terminal = record(id, thread);
      if (mode !== "malformed")
        terminal.branchPublication = mode === "different" ? { ...projection, complete: false } : projection;
      expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: terminal })).status).toBe(200);
      const stored = (await post("/runs/get", { storeKey: key, id })).data.record;
      expect(stored).toMatchObject({ id, status: "completed" });
      expect(stored.branchPublication).toEqual(mode === "different" ? projection : undefined);
      if (mode === "malformed") {
        const stub = env.RUNS.get(env.RUNS.idFromName(key));
        await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
          const row = state.storage.sql
            .exec<{ work_evidence_json: string }>(`SELECT work_evidence_json FROM runs WHERE run_id = ?`, id)
            .one();
          expect(JSON.parse(row.work_evidence_json).branchPublication).toEqual({ ...projection, version: 2 });
          state.storage.sql.exec(`UPDATE runs SET finished_at = 1 WHERE run_id = ?`, id);
          (
            instance as unknown as { trim(policy: Record<string, number>, now: number, fence: undefined): unknown }
          ).trim({ retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024 }, Date.now(), undefined);
          expect(state.storage.sql.exec(`SELECT run_id FROM runs WHERE run_id = ?`, id).toArray()).toHaveLength(1);
        });
      }
      expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    },
  );

  it("retains unresolved direct publication through finish and physical history trimming", async () => {
    const key = storeKey();
    const id = "unresolved-publication";
    const thread = "slack:C1:unresolved-publication";
    const branchPublication = {
      version: 1,
      repo: "private/repo",
      complete: false,
      branches: [],
      pending: { id: "intent-a", ref: "private/branch", headSha: "a".repeat(40), pr: 7 },
    };
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    expect(
      (await post("/runs/state", { storeKey: key, runId: id, gen: "g1", state: { branchPublication } })).status,
    ).toBe(200);
    const terminal = record(id, thread);
    terminal.startedAt = Date.now() - 3 * 86_400_000;
    terminal.finishedAt = Date.now() - 2 * 86_400_000;
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify({ retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024, policyUpdatedAt: Date.now() }),
      );
    });
    expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: terminal })).status).toBe(200);
    await post("/runs/put", { storeKey: key, record: record("ordinary-publication", "slack:C1:ordinary") });
    const newer = record("newer-publication", "slack:C1:newer");
    newer.finishedAt = Date.now();
    await post("/runs/put", { storeKey: key, record: newer });
    expect((await post("/runs/get", { storeKey: key, id })).data.record?.branchPublication).toEqual(branchPublication);
    expect((await post("/runs/events", { storeKey: key, id })).data.events).not.toBeNull();
    const summaries = (await post("/runs/list", { storeKey: key })).data.items;
    expect(summaries.map((item: { id: string }) => item.id)).toEqual(["newer-publication", id]);
    for (const summary of [(await post("/runs/summary", { storeKey: key, id })).data.summary, ...summaries]) {
      expect(summary).not.toHaveProperty("branchPublication");
      expect(JSON.stringify(summary)).not.toContain("private/branch");
    }
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      expect(state.storage.sql.exec(`SELECT run_id FROM runs ORDER BY run_id`).toArray()).toEqual([
        { run_id: "newer-publication" },
        { run_id: id },
      ]);
      expect(state.storage.sql.exec(`SELECT run_id FROM live_runs`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT unit FROM coordinator_units`).toArray()).toEqual([]);
    });
  });

  it("folds the fenced producer projection at finish independently of events and hides it on summaries", async () => {
    const key = storeKey();
    const id = "publication-owner";
    const thread = "slack:C1:publication-owner";
    const branchPublication = {
      version: 1,
      repo: "private/repo",
      complete: false,
      branches: [{ ref: "accepted/branch", pr: 7 }],
      pending: { id: "intent-a", ref: "uncertain/branch", headSha: "a".repeat(40) },
    };
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    expect(
      await post("/runs/state", { storeKey: key, runId: id, gen: "foreign", state: { branchPublication } }),
    ).toMatchObject({ status: 409, data: { reason: "fenced" } });
    expect(
      (await post("/runs/state", { storeKey: key, runId: id, gen: "g1", state: { branchPublication } })).status,
    ).toBe(200);
    expect(
      (await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) })).status,
    ).toBe(200);
    const stored = (await post("/runs/get", { storeKey: key, id })).data.record as RunRecord;
    expect(stored.branchPublication).toEqual(branchPublication);
    expect(stored.events.some((event) => event.type === "pr_opened")).toBe(false);
    for (const summary of [
      (await post("/runs/summary", { storeKey: key, id })).data.summary,
      ...(await post("/runs/list", { storeKey: key })).data.items,
    ]) {
      expect(summary).not.toHaveProperty("branchPublication");
      expect(JSON.stringify(summary)).not.toContain("uncertain/branch");
    }
  });
});

describe("complete canonical pull ownership", () => {
  it("refuses competing PR reservations inside the unit compare-and-replace transaction", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "atomic_owner",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:atomic-owner",
      repo: "acme/api",
      branch: "fix/atomic",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    const draft: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "FIRST",
      slug: "first",
      branch: "fix/first",
      dependsOn: [],
      rounds: [],
    };
    const held = {
      ...draft,
      unit: "HELD",
      branch: "fix/held",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [draft, held] })).status).toBe(200);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      expect(await owner.compareAndReplaceUnit(draft, { ...draft, pr: held.pr }, 3)).toEqual({
        ok: false,
        reason: "owned",
      });
      const fresh = { ...draft, unit: "FRESH", branch: "fix/fresh" };
      const bindingsBefore = state.storage.sql.exec(`SELECT * FROM context_refs`).toArray();
      expect(await owner.putUnits([fresh, { ...draft, pr: held.pr }], 4)).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnits(instance.id)).toEqual([draft, held]);
      expect(state.storage.sql.exec(`SELECT * FROM context_refs`).toArray()).toEqual(bindingsBefore);
      expect(
        await owner.appendUnitEvent(instance.id, draft.unit, {
          sender: instance.userId,
          text: "keep me",
          mode: "wake",
          at: 2,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await owner.answerUnitWake(
          { ...draft, pr: held.pr },
          "wait/1",
          { kind: "answered", reply: "go" },
          [1],
          "wake",
          5,
        ),
      ).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnitEvents(instance.id, draft.unit, true)).toEqual([
        expect.objectContaining({ text: "keep me" }),
      ]);
      expect(
        JSON.parse(
          state.storage.sql
            .exec<{ json: string }>(
              `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
              instance.id,
              draft.unit,
            )
            .one().json,
        ),
      ).toEqual(draft);
      const started = { ...draft, startedAt: 6 };
      expect(await owner.putUnits([started], 6)).toEqual({ ok: true });
      expect(await owner.putUnits([draft], 7)).toEqual({ ok: false, reason: "settled" });
      expect(await owner.answerUnitWake(draft, "wait/2", { kind: "answered", reply: "go" }, [1], "wake", 7)).toEqual({
        ok: false,
        reason: "settled",
      });
      expect(await owner.compareAndReplaceUnit(started, draft, 7)).toEqual({ ok: false, reason: "stale" });
      const rival = { ...draft, unit: "RIVAL" };
      expect(await owner.putUnits([rival], 8)).toEqual({ ok: true });
      expect(await owner.putUnits([{ ...rival, startedAt: 9 }], 9)).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnits(instance.id)).toEqual([started, held, rival]);
    });
  });
  it("preserves live events and pins when history deletion names no terminal row", async () => {
    const key = storeKey(),
      id = "live_delete",
      thread = "slack:C1:live-delete";
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, session_key) VALUES (?, ?, '')`,
        id,
        id,
      );
      const before = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`, id)
        .one().n;
      expect(await _owner.delete(id)).toBe(false);
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`, id).one().n,
      ).toBe(before);
      expect(
        state.storage.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM context_refs WHERE holder_run_id = ?`, id)
          .one().n,
      ).toBe(1);
    });
  });
  it("folds canonical Door intent at finish and refuses mismatched settlement bindings", async () => {
    const key = storeKey(),
      id = "reclaimed_door",
      thread = "slack:C1:reclaimed-door";
    const door = {
      id: "call",
      repo: "acme/api",
      update: { ref: "refs/heads/fix/door", old: "a".repeat(40), next: "b".repeat(40) },
    };
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, id, thread, "g1", {
            meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: thread, repo: "acme/api" },
            state: { doorPublicationPending: door },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId: id,
          gen: "g1",
          record: { ...record(id, thread), repo: "acme/api" },
        })
      ).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/pull-owners", { storeKey: key, target: { repo: "acme/api", ref: "fix/door" } }),
    ).toMatchObject({ data: { ok: true, owners: [{ kind: "run", runId: id }] } });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      const settlement = {
        version: 1,
        revision: 1,
        owner: { runId: "settlement", ownerGen: "g1", ownerFence: 1 },
        binding: null,
        record: { id: "settlement", threadKey: thread, status: "completed", userId: "slack:UALICE", repo: "acme/api" },
        publication: {
          version: 1,
          repo: "acme/api",
          branches: [],
          complete: false,
          pending: { id: "call", pr: 7, headSha: "a".repeat(40) },
        },
      };
      state.storage.sql.exec(
        `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES ('wrong-owner', 1, ?)`,
        JSON.stringify(settlement),
      );
      expect(await _owner.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
    });
  });
  it("reads unhosted units, direct private intent and unsettled effects without public listing authority", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "unhosted_pull_owner",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:owner",
      repo: "acme/api",
      branch: "fix/task",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "UOWNER",
      slug: "task",
      branch: "fix/task",
      dependsOn: [],
      rounds: [],
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    const lookup = (target: unknown) => post("/runs/coordinator/pull-owners", { storeKey: key, target });
    expect(await lookup({ repo: "ACME/API", pr: 7 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "unit", instanceId: instance.id, unit: "UOWNER" }] },
    });
    const runId = "direct_pull_owner";
    const threadKey = "slack:C1:direct-pull";
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, runId, threadKey, "g1", {
            state: {
              binding: {
                backend: "resident",
                ownerGen: "g1",
                ownerFence: 7,
                ref: "fix/direct",
                workspace: "/workspace/threads/t/direct",
                user: "worker2",
                container: "vm-1",
              },
              branchPublication: {
                version: 1,
                repo: "acme/api",
                branches: [],
                complete: false,
                pending: { id: "call", pr: 8, headSha: "a".repeat(40) },
              },
            },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId,
          gen: "g1",
          record: { ...record(runId, threadKey), repo: "acme/api" },
        })
      ).status,
    ).toBe(200);
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId }] },
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO plane_effects (id, body_json, offered_at) VALUES (?, ?, 1)`,
        "rebase:acme/api#9",
        JSON.stringify({
          id: "rebase:acme/api#9",
          kind: "rebase_round",
          repo: "acme/api",
          number: 9,
          headSha: "a".repeat(40),
          brief: "rebase",
        }),
      );
    });
    expect(await lookup({ repo: "acme/api", pr: 9 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "effect", id: "rebase:acme/api#9" }] },
    });
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET work_evidence_json = ? WHERE run_id = ?`,
        JSON.stringify({ version: 1, branchPublication: null }),
        runId,
      );
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: false, reason: "incomplete" },
    });
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET work_evidence_json = ? WHERE run_id = ?`,
        JSON.stringify({
          version: 1,
          branchPublication: {
            version: 1,
            repo: "acme/api",
            complete: false,
            branches: [],
            pending: { id: "call", pr: 8, headSha: "a".repeat(40) },
          },
        }),
        runId,
      );
    });
    expect(await lookup({ repo: "other/repo", pr: 7 })).toMatchObject({ status: 200, data: { ok: true, owners: [] } });
    expect((await lookup({ repo: "acme/api" })).status).toBe(400);
    const doorId = "terminal_door_owner";
    expect(
      (
        await post("/runs/put", {
          storeKey: key,
          record: {
            ...record(doorId, "slack:C1:door-owner"),
            startedAt: 0,
            finishedAt: 1,
            repo: "acme/api",
            doorPublicationPending: {
              id: "door-call",
              repo: "acme/api",
              update: { ref: "refs/heads/fix/door", old: "a".repeat(40), next: "b".repeat(40) },
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(await lookup({ repo: "acme/api", ref: "fix/door" })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId: doorId }] },
    });
    expect(await post("/runs/delete", { storeKey: key, id: runId })).toMatchObject({
      status: 409,
      data: { ok: false, reason: "publication_pending" },
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId }] },
    });
    expect((await post("/runs/claim", claimBody(key, "corrupt_live", "slack:C1:corrupt-live"))).status).toBe(200);
    expect(await lookup({ repo: "other/repo", pr: 7 })).toMatchObject({ status: 200, data: { ok: true, owners: [] } });
    for (const meta of [[], 7, {}]) {
      await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
        state.storage.sql.exec(
          `UPDATE live_runs SET meta_json = ? WHERE run_id = 'corrupt_live'`,
          JSON.stringify(meta),
        );
      });
      expect(await lookup({ repo: "other/repo", pr: 7 })).toMatchObject({
        status: 200,
        data: { ok: false, reason: "incomplete" },
      });
    }
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM live_runs WHERE run_id = 'corrupt_live'`);
    });

    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE runs SET work_evidence_json = '{' WHERE run_id = ?`, runId);
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: false, reason: "incomplete" },
    });
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM runs WHERE run_id = ?`, runId);
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId }] },
    });
  });

  it("bounds source bytes before parsing or retaining an entire permitted history", async () => {
    const key = storeKey(),
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const label = "x".repeat(Math.floor(1.4 * 1024 * 1024));
      for (let i = 0; i < 4; i++) {
        const row = { ...record(`large_${i}`, `slack:C1:large-${i}`), label };
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json) VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
          row.id,
          row.threadKey,
          label.length,
          JSON.stringify(row),
        );
        expect(await owner.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual(
          i === 3 ? { ok: false, reason: "incomplete" } : { ok: true, owners: [] },
        );
      }
    });
  });
});
