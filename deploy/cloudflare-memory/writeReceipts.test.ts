import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../../src/core/references/contextDependencies.ts";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { fetchMemoryTest } from "./testFetch.ts";
import { sourceHash } from "../../src/core/references/receipts.ts";

const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
const requestId = "11111111-1111-4111-8111-111111111111";
async function post(operation: string, body: unknown, id?: string, extra: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return fetchMemoryTest(
    `https://memory.test${operation}`,
    {
      method: "POST",
      body: payload,
      headers: { ...headers, ...extra, ...(id ? { "x-switchboard-storage-request-id": id } : {}) },
    },
    async (response) => ({ status: response.status, data: (await response.json()) as Record<string, unknown> }),
  );
}
async function fixture() {
  const storeKey = `runs:receipt-${crypto.randomUUID()}`;
  const runId = "receipt-run",
    gen = "g1",
    key = `session:receipt-${crypto.randomUUID()}`;
  const threadKey = "mcp:fixture:receipt";
  expect(
    (
      await post("/runs/claim", {
        storeKey,
        run: {
          runId,
          gen,
          threadKey,
          startedAt: 1000,
          leaseMs: 30000,
          system: "review",
          tools: [],
          state: {},
          meta: {
            agent: "review",
            channelId: "mcp:fixture",
            userId: "mcp:alice",
            channelVisibility: "public",
            threadKey,
            session: { key, seedFrom: 0, request: 0, range: { from: 0 } },
          },
        },
      })
    ).data,
  ).toMatchObject({ ok: true });
  expect((await post("/runs/session/owner", { key, runId, gen })).status).toBe(200);
  return { storeKey, runId, gen, key };
}
async function read(f: Awaited<ReturnType<typeof fixture>>, operation: string, body: unknown, id = requestId) {
  return post("/runs/write-receipt", {
    storeKey: f.storeKey,
    selector: {
      runId: f.runId,
      gen: f.gen,
      operation,
      requestId: id,
      digest: await sourceHash({ operation, payload: JSON.stringify(body) }),
    },
  });
}
describe("original write receipts", () => {
  it("reads a committed live-state write after its original reply is discarded", async () => {
    const f = await fixture();
    const body = {
      storeKey: f.storeKey,
      runId: f.runId,
      gen: f.gen,
      assignment: {
        state: "admitted",
        expectedSeq: 0,
        at: 1000,
        bound: 30000,
        statePatch: { privateValue: "PRIVATE" },
      },
    };
    // Consume but discard the original reply. Only the passive lookup is evidence below.
    expect((await post("/runs/live-state", body, requestId)).status).toBe(200);
    const result = await read(f, "/runs/live-state", body);
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      kind: "source",
      receipt: {
        state: "recorded",
        record: {
          operation: "/runs/live-state",
          runId: "receipt-run",
          gen: "g1",
          requestId,
          result: { ok: true, liveStateSeq: 1 },
          components: { stateWritten: true, eventsWritten: 1 },
        },
      },
    });
    expect(JSON.stringify(result.data)).not.toContain("PRIVATE");
  });
  it("records row and source components together without exposing their payloads", async () => {
    const f = await fixture();
    const body = {
      key: f.key,
      runId: f.runId,
      sourceRunId: f.runId,
      gen: f.gen,
      storeKey: f.storeKey,
      rows: [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "PRIVATE" } }) }],
      attachments: [],
      sources: { version: 1, status: "unknown" },
    };
    expect((await post("/runs/session/write", body, requestId)).status).toBe(200);
    expect((await read(f, "/runs/session/write", body)).data).toMatchObject({
      kind: "source",
      receipt: {
        state: "recorded",
        record: {
          result: { ok: true, sourcesSaved: true },
          components: { rowsWritten: 1, attachmentsWritten: 0, sourcesWritten: true, sourceOwnerWritten: true },
        },
      },
    });
  });
});

function liveBody(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    storeKey: f.storeKey,
    runId: f.runId,
    gen: f.gen,
    assignment: { state: "admitted", expectedSeq: 0, at: 1000, bound: 30000 },
  };
}
function sessionBody(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    storeKey: f.storeKey,
    key: f.key,
    runId: f.runId,
    sourceRunId: f.runId,
    gen: f.gen,
    rows: [],
    attachments: [],
    sources: { version: 1, status: "unknown" },
  };
}
describe("original write receipt failures", () => {
  it("derives request identity from bytes instead of diagnostic headers", async () => {
    const f = await fixture(),
      body = liveBody(f);
    expect(
      (await post("/runs/live-state", body, requestId, { "x-switchboard-storage-request-digest": "f".repeat(64) }))
        .status,
    ).toBe(200);
    expect((await read(f, "/runs/live-state", body)).data).toMatchObject({ receipt: { state: "recorded" } });
    expect((await read(f, "/runs/live-state", { ...body, extra: true })).data).toMatchObject({
      receipt: { state: "unknown" },
    });
  });
  it("fences duplicate and conflicting IDs without replacing the original receipt", async () => {
    const f = await fixture(),
      body = liveBody(f);
    expect((await post("/runs/live-state", body, requestId)).status).toBe(200);
    const before = await read(f, "/runs/live-state", body);
    expect((await post("/runs/live-state", body, requestId)).data).toEqual({ ok: false, reason: "fenced" });
    expect(
      (
        await post(
          "/runs/live-state",
          { ...body, assignment: { ...body.assignment, statePatch: { changed: true } } },
          requestId,
        )
      ).status,
    ).toBe(409);
    expect(await read(f, "/runs/live-state", body)).toEqual(before);
    expect(
      await runInDurableObject(
        env.RUNS.get(env.RUNS.idFromName(f.storeKey)),
        (_owner, state) =>
          state.storage.sql
            .exec<{ changed: null }>(
              "SELECT json_extract(state_json,'$.changed') AS changed FROM live_runs WHERE run_id=?",
              f.runId,
            )
            .one().changed,
      ),
    ).toBeNull();
  });
  it("keeps legacy writes and precommit failures unknown", async () => {
    const f = await fixture(),
      body = liveBody(f);
    expect((await read(f, "/runs/live-state", body)).data).toMatchObject({
      receipt: { state: "unknown", reason: "missing" },
    });
    expect((await post("/runs/live-state", body)).status).toBe(200);
    expect((await read(f, "/runs/live-state", body)).data).toMatchObject({ receipt: { state: "unknown" } });
    expect((await post("/runs/live-state", { ...body, assignment: null }, requestId)).status).toBe(400);
    expect((await read(f, "/runs/live-state", body)).data).toMatchObject({ receipt: { state: "unknown" } });
  });
  it("records a refused result separately from committed source metadata", async () => {
    const f = await fixture(),
      body = sessionBody(f);
    expect(
      (
        await post("/runs/session/write", {
          ...body,
          sources: { version: 1, status: "unknown", context: UNKNOWN_CONTEXT_DEPENDENCIES },
        })
      ).status,
    ).toBe(200);
    const refused = { ...body, sources: { version: 1, status: "revoked" } };
    expect((await post("/runs/session/write", refused, requestId)).data).toEqual({ ok: false, reason: "fenced" });
    expect((await read(f, "/runs/session/write", refused)).data).toMatchObject({
      receipt: {
        state: "recorded",
        record: {
          result: { ok: false, reason: "fenced" },
          components: { sourcesWritten: true, rowsWritten: 0, attachmentsWritten: 0 },
        },
      },
    });
    expect(
      await runInDurableObject(
        env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)),
        (_owner, state) =>
          JSON.parse(
            state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='sources'").one().value,
          ).status,
      ),
    ).toBe("revoked");
  });
  it.each(["insert", "prune"] as const)("rolls back source and row effects if receipt %s fails", async (failure) => {
    const f = await fixture(),
      body = {
        ...sessionBody(f),
        rows: [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "rollback" } }) }],
      };
    const log = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key));
    let restore!: () => void;
    await runInDurableObject(log, (_owner, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...args) => {
        if (
          failure === "insert"
            ? sql.startsWith("INSERT INTO original_write_receipts")
            : sql.startsWith("DELETE FROM original_write_receipts WHERE seq")
        )
          throw new Error("receipt persistence failure");
        return exec(sql, ...args);
      });
      restore = () => spy.mockRestore();
    });
    try {
      expect((await post("/runs/session/write", body, requestId)).status).toBe(500);
    } finally {
      await runInDurableObject(log, () => restore());
    }
    expect(
      await runInDurableObject(log, (_owner, state) => ({
        rows: state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM turns").one().n,
        sources: state.storage.sql.exec("SELECT value FROM meta WHERE key IN ('sources','source_owner')").toArray(),
        receipts: state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n,
      })),
    ).toEqual({ rows: 0, sources: [], receipts: 0 });
    expect((await read(f, "/runs/session/write", body)).data).toMatchObject({ receipt: { state: "unknown" } });
  });
  it.each(["history", "session"] as const)("refuses a stale %s owner changed during hashing", async (boundary) => {
    const f = await fixture();
    if (boundary === "history") {
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(f.storeKey)), async (owner, state) => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
          spy.mockRestore();
          state.storage.sql.exec("UPDATE live_runs SET owner_gen='g2' WHERE run_id=?", f.runId);
          return digest(...args);
        });
        expect(
          await owner.assignLiveState(
            f.runId,
            f.gen,
            { state: "admitted", expectedSeq: 0, at: 1000, bound: 30000 },
            undefined,
            { requestId, digest: "a".repeat(64) },
          ),
        ).toEqual({ ok: false, reason: "fenced" });
        expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n).toBe(
          0,
        );
      });
    } else {
      await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)), async (owner, state) => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
          spy.mockRestore();
          state.storage.sql.exec("UPDATE owner SET gen='g2' WHERE run_id=?", f.runId);
          return digest(...args);
        });
        expect(
          await owner.write(f.gen, [], [], undefined, f.runId, false, undefined, {
            requestId,
            digest: "a".repeat(64),
            reader: readerBinding,
          }),
        ).toEqual({ ok: false, reason: "fenced" });
        expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n).toBe(
          0,
        );
      });
    }
  });
  it("discards a session receipt when RunHistory changes during its point read", async () => {
    const f = await fixture(),
      body = sessionBody(f);
    expect((await post("/runs/session/write", body, requestId)).status).toBe(200);
    const history = env.RUNS.get(env.RUNS.idFromName(f.storeKey));
    let restore!: () => void;
    await runInDurableObject(history, (owner, state) => {
      const target = owner as unknown as { env: { SESSION_LOGS: typeof env.SESSION_LOGS } };
      const original = target.env;
      const namespace = original.SESSION_LOGS;
      target.env = {
        ...original,
        SESSION_LOGS: new Proxy(namespace, {
          get(receiver, property) {
            if (property === "get")
              return (id: DurableObjectId) =>
                new Proxy(namespace.get(id), {
                  get(stub, method) {
                    if (method === "readWriteReceipt")
                      return async (selector: Parameters<typeof stub.readWriteReceipt>[0]) => {
                        const result = await stub.readWriteReceipt(selector);
                        state.storage.sql.exec("UPDATE live_runs SET owner_gen='g2' WHERE run_id=?", f.runId);
                        return result;
                      };
                    const value = Reflect.get(stub, method);
                    return typeof value === "function" ? value.bind(stub) : value;
                  },
                });
            const value = Reflect.get(receiver, property);
            return typeof value === "function" ? value.bind(receiver) : value;
          },
        }),
      };
      restore = () => {
        target.env = original;
      };
    });
    try {
      expect((await read(f, "/runs/session/write", body)).data).toMatchObject({
        receipt: { state: "unknown", reason: "changed" },
      });
    } finally {
      await runInDurableObject(history, () => restore());
    }
  });
  it("keeps changed ordinary reader metadata from exposing a prior receipt", async () => {
    const f = await fixture(),
      body = liveBody(f);
    expect((await post("/runs/live-state", body, requestId)).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(f.storeKey)), (_owner, state) =>
      state.storage.sql
        .exec("UPDATE live_runs SET meta_json=json_set(meta_json,'$.userId','mcp:other') WHERE run_id=?", f.runId)
        .toArray(),
    );
    expect((await read(f, "/runs/live-state", body)).data).toMatchObject({
      receipt: { state: "unknown", reason: "changed" },
    });
  });
  it("keeps at most256 receipts and leaves evicted requests unknown", async () => {
    const f = await fixture(),
      body = sessionBody(f);
    expect((await post("/runs/session/write", body, requestId)).status).toBe(200);
    const log = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key));
    await runInDurableObject(log, async (owner) => {
      for (let n = 0; n < 256; n++)
        expect(
          await owner.write("g1", [], [], undefined, f.runId, false, undefined, {
            requestId: crypto.randomUUID(),
            digest: "a".repeat(64),
            reader: readerBinding,
          }),
        ).toMatchObject({ ok: true });
    });
    expect(
      await runInDurableObject(
        log,
        (_owner, state) =>
          state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n,
      ),
    ).toBe(256);
    expect((await read(f, "/runs/session/write", body)).data).toMatchObject({
      receipt: { state: "unknown", reason: "missing" },
    });
  });
  it("removes session receipts on revocation and fences a late write", async () => {
    const f = await fixture(),
      body = sessionBody(f);
    expect((await post("/runs/session/write", body, requestId)).status).toBe(200);
    await env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)).revokeRun(f.runId);
    expect((await read(f, "/runs/session/write", body)).data).toMatchObject({ receipt: { state: "unknown" } });
    expect((await post("/runs/session/write", body, crypto.randomUUID())).data).toMatchObject({ ok: false });
  });
  it("preserves a committed receipt when the trace sink fails", async () => {
    const f = await fixture(),
      body = liveBody(f);
    const sink = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("private sink failure");
    });
    try {
      expect((await post("/runs/live-state", body, requestId)).status).toBe(200);
    } finally {
      sink.mockRestore();
    }
    expect((await read(f, "/runs/live-state", body)).data).toMatchObject({
      receipt: { state: "recorded", record: { result: { ok: true } } },
    });
  });
});
const readerBinding = {
  userId: "mcp:alice",
  channelId: "mcp:fixture",
  channelVisibility: "public" as const,
  threadKey: "mcp:fixture:receipt",
};

describe("original write receipt components and limits", () => {
  it.each(["rows", "attachments", "mixed"] as const)("records the original %s components", async (mode) => {
    const f = await fixture();
    const body = {
      key: f.key,
      storeKey: f.storeKey,
      gen: f.gen,
      runId: f.runId,
      ...(mode === "mixed" ? { sourceRunId: f.runId, sources: { version: 1, status: "unknown" } } : {}),
      rows:
        mode === "attachments"
          ? []
          : [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "component" } }) }],
      attachments: mode === "rows" ? [] : [{ ref: "fixture-attachment", mediaType: "image/png", data: "YQ==" }],
    };
    expect((await post("/runs/session/write", body, requestId)).status).toBe(200);
    expect((await read(f, "/runs/session/write", body)).data).toMatchObject({
      receipt: {
        state: "recorded",
        record: {
          result: { ok: true },
          components: {
            rowsWritten: mode === "attachments" ? 0 : 1,
            attachmentsWritten: mode === "rows" ? 0 : 1,
            sourcesWritten: mode === "mixed",
          },
        },
      },
    });
    expect(
      await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)), (_owner, state) => ({
        rows: state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM turns").one().n,
        attachments: state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM attachments").one().n,
      })),
    ).toEqual({ rows: mode === "attachments" ? 0 : 1, attachments: mode === "rows" ? 0 : 1 });
  });
  it("rolls back effects when UTF-8 reader metadata exceeds the receipt byte cap", async () => {
    const f = await fixture();
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)), async (owner, state) => {
      await expect(
        owner.write(
          f.gen,
          [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "oversize" } }) }],
          [],
          undefined,
          f.runId,
          false,
          undefined,
          {
            requestId,
            digest: "a".repeat(64),
            reader: {
              ...readerBinding,
              userId: "界".repeat(500),
              channelId: "界".repeat(500),
              threadKey: "界".repeat(500),
            },
          },
        ),
      ).rejects.toThrow("byte limit");
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM turns").one().n).toBe(0);
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n).toBe(
        0,
      );
    });
  });
  it("refuses a revocation that occurs during session effect hashing", async () => {
    const f = await fixture();
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)), async (owner, state) => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
        spy.mockRestore();
        await owner.revokeRun(f.runId);
        return digest(...args);
      });
      expect(
        await owner.write(f.gen, [], [], undefined, f.runId, false, undefined, {
          requestId,
          digest: "a".repeat(64),
          reader: readerBinding,
        }),
      ).toEqual({ ok: false, reason: "fenced" });
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n).toBe(
        0,
      );
    });
  });
  it("keeps a RunHistory-only owner change separate from SessionLog commit", async () => {
    const f = await fixture();
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)), async (owner, state) => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
        spy.mockRestore();
        await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(f.storeKey)), (_owner, history) =>
          history.storage.sql.exec("UPDATE live_runs SET owner_gen='g2' WHERE run_id=?", f.runId).toArray(),
        );
        return digest(...args);
      });
      expect(
        await owner.write(f.gen, [], [], undefined, f.runId, false, undefined, {
          requestId,
          digest: "a".repeat(64),
          reader: readerBinding,
        }),
      ).toMatchObject({ ok: true });
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n).toBe(
        1,
      );
    });
    expect(
      (
        await post("/runs/write-receipt", {
          storeKey: f.storeKey,
          selector: { runId: f.runId, gen: f.gen, operation: "/runs/session/write", requestId, digest: "a".repeat(64) },
        })
      ).data,
    ).toMatchObject({ receipt: { state: "unknown", reason: "fenced" } });
  });
  it("removes RunHistory receipts with canonical run data deletion", async () => {
    const f = await fixture(),
      body = liveBody(f);
    expect((await post("/runs/live-state", body, requestId)).status).toBe(200);
    expect(
      (await post("/runs/delete", { storeKey: f.storeKey, id: f.runId, destructive: true, force: true })).status,
    ).toBe(200);
    expect(
      await runInDurableObject(
        env.RUNS.get(env.RUNS.idFromName(f.storeKey)),
        (_owner, state) =>
          state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n,
      ),
    ).toBe(0);
    expect((await read(f, "/runs/live-state", body)).data).toEqual({ kind: "unavailable" });
  });
});

describe("original write receipt corrupt proof", () => {
  it("reports corrupt saved proof as unknown without exposing stored fields", async () => {
    const f = await fixture(),
      body = liveBody(f);
    expect((await post("/runs/live-state", body, requestId)).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(f.storeKey)), (_owner, state) =>
      state.storage.sql
        .exec("UPDATE original_write_receipts SET json=? WHERE request_id=?", '{"private":"PRIVATE"}', requestId)
        .toArray(),
    );
    const result = await read(f, "/runs/live-state", body);
    expect(result.data).toMatchObject({ receipt: { state: "unknown", reason: "corrupt" } });
    expect(JSON.stringify(result.data)).not.toContain("PRIVATE");
  });
});

describe("original receipt owner lookup trace", () => {
  it.each([false, true])("names the RunHistory wait when its lookup fails, throwing sink=%s", async (throwingSink) => {
    const f = await fixture();
    const body = { key: f.key, storeKey: f.storeKey, runId: f.runId, gen: f.gen, rows: [], attachments: [] };
    const history = env.RUNS.get(env.RUNS.idFromName(f.storeKey));
    let restore!: () => void;
    await runInDurableObject(history, (_owner, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query, ...args) => {
        if (query.startsWith("SELECT * FROM live_runs")) throw new Error("PRIVATE_RECEIPT_OWNER_FAILURE");
        return exec(query, ...args);
      });
      restore = () => spy.mockRestore();
    });
    const lines: string[] = [];
    const sink = vi.spyOn(console, "log").mockImplementation((line) => {
      const text = String(line);
      lines.push(text);
      if (throwingSink && text.includes("storage.write.progress")) throw new Error("PRIVATE_SINK_FAILURE");
    });
    try {
      expect((await post("/runs/session/write", body, requestId)).status).toBe(500);
    } finally {
      sink.mockRestore();
      await runInDurableObject(history, () => restore());
    }
    const events = lines
      .filter((line) => line.includes('"event":"storage.write.progress"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        side: "worker",
        stage: "receipt-owner-read",
        outcome: "started",
        targetObjectId: env.RUNS.idFromName(f.storeKey).toString(),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ side: "worker", stage: "receipt-owner-read", outcome: "failed" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ side: "object", operation: "write-receipt-owner", stage: "entry", outcome: "started" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ side: "object", operation: "write-receipt-owner", stage: "result", outcome: "failed" }),
    );
    expect(events.filter((event) => event.stage === "session-write-rpc" && event.outcome === "started")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(f.key);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
    expect(
      await runInDurableObject(
        env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(f.key)),
        (_owner, state) =>
          state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM original_write_receipts").one().n,
      ),
    ).toBe(0);
  });
});
describe("original receipt context pin processing", () => {
  it("distinguishes empty-context processing from pin writes", async () => {
    const f = await fixture();
    const body = {
      ...liveBody(f),
      assignment: { ...liveBody(f).assignment, statePatch: { contextDependencies: UNKNOWN_CONTEXT_DEPENDENCIES } },
    };
    expect((await post("/runs/live-state", body, requestId)).status).toBe(200);
    const result = await read(f, "/runs/live-state", body);
    expect(result.data).toMatchObject({
      receipt: { state: "recorded", record: { components: { contextPinningApplied: true } } },
    });
    expect(JSON.stringify(result.data)).not.toContain("contextPinsWritten");
    expect(
      await runInDurableObject(
        env.RUNS.get(env.RUNS.idFromName(f.storeKey)),
        (_owner, state) =>
          state.storage.sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM context_refs WHERE holder_run_id=?", f.runId)
            .one().n,
      ),
    ).toBe(0);
  });
});
