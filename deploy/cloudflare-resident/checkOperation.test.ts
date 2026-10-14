import { describe, expect, it, vi } from "vitest";
import { RecordedCheckOperation, type CheckOperationStorage, type CheckOperationContext } from "./checkOperation.js";
import { checkCommandHash } from "../../src/execution/checkOperation.js";
import { residentRouteOf, sameResidentRoute } from "../../src/execution/residentRoute.js";
import {
  checkSelectorSchema,
  checkSourceReadOf,
  checkSourceIdentityHash,
  type CheckSource,
} from "../../src/core/checkInspection.js";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readSource } from "./testing/sourceScan.js";
import { sanitizeResidentBody } from "../../src/execution/residentText.js";
import { RUN_STORE_KEY, RUN_STORE_TIMEOUT_MS } from "../../src/core/runStoreConstants.js";

const context: CheckOperationContext = {
  threadKey: "t1",
  runId: "r1",
  ownerGen: "g1",
  ownerFence: 1,
  incarnation: "kernel-1",
};
const request = { command: "printf done", timeoutMs: 1000 };
const result = { stdout: "done", stderr: "", exitCode: 0, truncated: false };
function fixture() {
  const data = new Map<string, unknown>();
  let lose: "admission" | "result" | undefined;
  let failRead = false;
  const storage: CheckOperationStorage = {
    async get<T>(key: string) {
      if (failRead) throw new Error("unavailable");
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      return data.delete(key);
    },
    async list<T>({ prefix, limit }) {
      return new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
    async transaction(action) {
      const before = JSON.stringify([...data]);
      const answer = await action(storage);
      if (
        lose &&
        JSON.stringify([...data]) !== before &&
        [...data.values()].some((row) => Boolean((row as { result?: unknown }).result) === (lose === "result"))
      ) {
        lose = undefined;
        throw new Error("ACK lost");
      }
      return answer;
    },
  };
  return {
    data,
    storage,
    service: new RecordedCheckOperation(storage),
    lose: (phase: typeof lose) => {
      lose = phase;
    },
    unreadable: () => {
      failRead = true;
    },
  };
}
async function operation() {
  return { key: "a".repeat(64), commandHash: await checkCommandHash(request.command) };
}

describe("recorded Resident check operations", () => {
  it("reports result-write uncertainty with bounded identity and no raw failure data", async () => {
    const f = fixture();
    const op = await operation();
    const put = f.storage.put.bind(f.storage);
    f.storage.put = async (key, value) => {
      if ((value as { result?: unknown }).result) throw new Error("Cookie: secret-session; command=private");
      return put(key, value);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await f.service.execute(
          context,
          op,
          request,
          async () => true,
          async () => result,
        ),
      ).toEqual({ kind: "unknown" });
      expect(warn.mock.calls.map((args) => [args[0], JSON.parse(String(args[1]))])).toEqual([
        [
          "[check-result]",
          {
            version: 1,
            code: "result_write_unconfirmed",
            threadKey: "t1",
            runId: "r1",
            ownerFence: 1,
            operationKey: "a".repeat(64),
          },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves a pending alias when result persistence fails before commit", async () => {
    const f = fixture();
    const put = f.storage.put.bind(f.storage);
    f.storage.put = async (key, value) => {
      if ((value as { result?: unknown }).result) throw new Error("not committed");
      return put(key, value);
    };
    let effects = 0;
    const op = await operation();
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    expect(effects).toBe(1);
  });

  it("reads the original completed operation after a lost result ACK without repeating effects", async () => {
    const f = fixture();
    let effects = 0;
    let original = "";
    f.lose("result");
    const op = await operation();
    const answer = await f.service.execute(
      context,
      op,
      request,
      async () => true,
      async (key) => {
        original = key;
        effects++;
        return result;
      },
    );
    expect(answer).toEqual({ kind: "completed", checkOperation: op, nativeKey: original, result });
    expect(await f.service.inspect(context, op, async () => true)).toEqual(answer);
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual(answer);
    expect(effects).toBe(1);
  });

  it("keeps a lost admission ACK held without starting or repeating the native operation", async () => {
    const f = fixture();
    let effects = 0;
    const op = await operation();
    f.lose("admission");
    await expect(
      f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).rejects.toThrow("ACK lost");
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    expect(await f.service.inspect(context, op, async () => true)).toEqual({ kind: "unknown" });
    expect(effects).toBe(0);
  });

  it("holds a pending operation and permits a later read of only its original completion", async () => {
    const f = fixture();
    const op = await operation();
    let done!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      done = resolve;
    });
    let effects = 0;
    const executing = f.service.execute(
      context,
      op,
      request,
      async () => true,
      async () => {
        effects++;
        started();
        await wait;
        return result;
      },
    );
    await ready;
    expect(await f.service.inspect(context, op, async () => true)).toEqual({ kind: "unknown" });
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    done();
    expect(await executing).toMatchObject({ kind: "completed", result });
    expect(await f.service.inspect(context, op, async () => true)).toMatchObject({ kind: "completed", result });
    expect(effects).toBe(1);
  });

  it("refuses foreign owners, threads, incarnations, changed requests and stale authority", async () => {
    const f = fixture();
    const op = await operation();
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => result,
      ),
    ).toMatchObject({ kind: "completed", result });
    for (const patch of [
      { runId: "r2" },
      { ownerGen: "g2" },
      { ownerFence: 2 },
      { threadKey: "t2" },
      { incarnation: "kernel-2" },
    ]) {
      expect(await f.service.inspect({ ...context, ...patch }, op, async () => true)).toEqual({ kind: "unknown" });
    }
    expect(await f.service.inspect(context, { ...op, commandHash: "b".repeat(64) }, async () => true)).toEqual({
      kind: "unknown",
    });
    expect(await f.service.inspect(context, op, async () => false)).toEqual({ kind: "unknown" });
    expect(
      await f.service.execute(
        context,
        op,
        { ...request, timeoutMs: 2000 },
        async () => true,
        async () => result,
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("does not certify a returned result while the original native operation remains unresolved", async () => {
    const f = fixture();
    const op = await operation();
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async (key) => {
          await f.storage.put(key, { held: true });
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    expect(await f.service.inspect(context, op, async () => true)).toEqual({ kind: "unknown" });
  });
});

describe("original recorded check inspection", () => {
  const source = async (patch: Partial<CheckSource> = {}): Promise<CheckSource> => ({
    version: 1,
    state: "terminal",
    selector: { runId: "r1", callId: "call1", phase: "command" },
    resource: { type: "run", id: "r1", userId: "u1", channelId: "c1", channelVisibility: "private", repo: "acme/app" },
    threadKey: "t1",
    operation: await operation(),
    ...patch,
  });
  async function pending() {
    const f = fixture();
    let nativeKey = "";
    await expect(
      f.service.execute(
        context,
        await operation(),
        request,
        async () => true,
        async (key) => {
          nativeKey = key;
          throw new Error("response lost");
        },
      ),
    ).rejects.toThrow("response lost");
    const aliasKey = [...f.data.keys()][0]!;
    return { ...f, nativeKey, aliasKey };
  }
  function ending(f: Awaited<ReturnType<typeof pending>>) {
    const process = { id: "process-1", pid: 123, startedAt: "2026-01-01T00:00:00Z" };
    const original = {
      runId: "r1",
      ownerGen: "g1",
      ownerFence: 1,
      native: { version: 1, closed: true, threadKey: "t1", pending: { attempt: { kind: "process", process } } },
    };
    const receipt = {
      key: f.nativeKey,
      recordHash: createHash("sha256").update(JSON.stringify(original)).digest("hex"),
      outcome: "native-ended",
      processes: [{ ...process, state: "exited", endedAt: "2026-01-01T00:00:01Z", exit: { code: 0, timedOut: false } }],
    };
    f.data.set(`native-operation-receipt:${f.nativeKey}`, { original, receipt });
    return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  }

  it("reads exact native ending without writing and settles one alias without permitting a repeat", async () => {
    const f = await pending();
    const proofHash = ending(f);
    const selected = await source();
    await expect(
      f.service.execute(
        context,
        { ...selected.operation!, key: "b".repeat(64) },
        request,
        async () => true,
        async () => {
          throw new Error("other operation unknown");
        },
      ),
    ).rejects.toThrow("other operation unknown");
    const before = structuredClone([...f.data]);
    expect(await f.service.inspectRecorded(selected)).toEqual({ kind: "retired", reason: "native_ended", proofHash });
    expect([...f.data]).toEqual(before);
    expect(await f.service.inspectRecorded(selected, true)).toEqual({
      kind: "retired",
      reason: "native_ended",
      proofHash,
    });
    expect(f.data.get(f.aliasKey)).toEqual({ ...(before[0]![1] as object), retired: true, endingHash: proofHash });
    expect([...f.data].slice(1)).toEqual(before.slice(1));
    expect(await f.service.inspectRecorded(selected, true)).toEqual({
      kind: "retired",
      reason: "native_ended",
      proofHash,
    });
    let effects = 0;
    expect(
      await f.service.execute(
        context,
        await operation(),
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    expect(effects).toBe(0);
  });

  it("returns canonical output after alias pruning but cannot settle live or legacy evidence", async () => {
    const f = fixture();
    expect(await f.service.inspectRecorded(await source({ result }))).toEqual({
      kind: "known",
      source: "canonical",
      result,
    });
    expect(await f.service.inspectRecorded(await source({ operation: undefined, result }))).toEqual({
      kind: "known",
      source: "canonical",
      result,
    });
    expect(await f.service.inspectRecorded(await source({ state: "live", result }), true)).toEqual({
      kind: "unavailable",
      reason: "live",
    });
    expect(await f.service.inspectRecorded(await source({ operation: undefined }))).toEqual({
      kind: "unavailable",
      reason: "identity",
    });
  });

  it("keeps completed output retirement idempotent without requiring a native ending", async () => {
    const f = fixture();
    await f.service.execute(
      context,
      await operation(),
      request,
      async () => true,
      async () => result,
    );
    expect(await f.service.inspectRecorded(await source())).toEqual({ kind: "known", source: "resident", result });
    await f.service.retire("t1", async () => true);
    const before = structuredClone([...f.data]);
    expect(await f.service.inspectRecorded(await source(), true)).toEqual({
      kind: "retired",
      reason: "output_retired",
    });
    expect([...f.data]).toEqual(before);
  });

  it("preserves known Resident output on settlement and prefers native proof over retired output", async () => {
    const f = fixture();
    const answer = await f.service.execute(
      context,
      await operation(),
      request,
      async () => true,
      async () => result,
    );
    if (answer.kind !== "completed") throw new Error("completion required");
    const held = { ...f, nativeKey: answer.nativeKey, aliasKey: [...f.data.keys()][0]! };
    const before = structuredClone([...f.data]);
    expect(await f.service.inspectRecorded(await source(), true)).toEqual({
      kind: "known",
      source: "resident",
      result,
    });
    expect([...f.data]).toEqual(before);
    await f.service.retire("t1", async () => true);
    const proofHash = ending(held);
    expect(await f.service.inspectRecorded(await source())).toEqual({
      kind: "retired",
      reason: "native_ended",
      proofHash,
    });
    expect(await f.service.inspectRecorded(await source(), true)).toEqual({
      kind: "retired",
      reason: "native_ended",
      proofHash,
    });
    expect(f.data.get(held.aliasKey)).toMatchObject({ retired: true, endingHash: proofHash });
  });

  it.each([124, 137, 143])(
    "keeps exit %i uncertain and retains partial output when native ending is proven",
    async (exitCode) => {
      const f = fixture();
      const partial = { stdout: "partial output", stderr: "interrupted", exitCode, truncated: false };
      const answer = await f.service.execute(
        context,
        await operation(),
        request,
        async () => true,
        async () => partial,
      );
      if (answer.kind !== "completed") throw new Error("saved result required");
      const held = { ...f, nativeKey: answer.nativeKey, aliasKey: [...f.data.keys()][0]! };
      const selected = await source();
      const before = structuredClone(f.data.get(held.aliasKey));
      expect(await f.service.inspectRecorded(selected)).toEqual({ kind: "pending", reason: "native_ending_unproven" });
      expect(await f.service.inspectRecorded(selected, true)).toEqual({
        kind: "pending",
        reason: "native_ending_unproven",
      });
      await f.service.retire("t1", async () => true);
      expect(f.data.get(held.aliasKey)).toEqual(before);
      await f.service.execute(
        { ...context, runId: "r2", ownerFence: 2 },
        await operation(),
        request,
        async () => true,
        async () => result,
      );
      expect(f.data.get(held.aliasKey)).toEqual(before);
      expect(await f.service.inspectRecorded(selected)).toEqual({ kind: "pending", reason: "native_ending_unproven" });
      const proofHash = ending(held);
      expect(await f.service.inspectRecorded(selected)).toEqual({ kind: "retired", reason: "native_ended", proofHash });
      expect(f.data.get(held.aliasKey)).toEqual(before);
      expect(await f.service.inspectRecorded(selected, true)).toEqual({
        kind: "retired",
        reason: "native_ended",
        proofHash,
      });
      expect(f.data.get(held.aliasKey)).toEqual({ ...(before as object), retired: true, endingHash: proofHash });
      expect(await f.service.inspectRecorded(selected)).toEqual({ kind: "retired", reason: "native_ended", proofHash });
      await f.service.retire("t1", async () => true);
      expect(f.data.get(held.aliasKey)).toMatchObject({ result: partial, retired: true, endingHash: proofHash });
    },
  );

  it.each(["runId", "ownerGen", "ownerFence", "threadKey"])(
    "refuses a valid native ending for a different %s",
    async (field) => {
      const f = await pending();
      ending(f);
      const saved = f.data.get(`native-operation-receipt:${f.nativeKey}`) as {
        original: Record<string, unknown> & { native: { threadKey: string } };
        receipt: { recordHash: string };
      };
      if (field === "threadKey") saved.original.native.threadKey = "other";
      else saved.original[field] = field === "ownerFence" ? 2 : "other";
      saved.receipt.recordHash = createHash("sha256").update(JSON.stringify(saved.original)).digest("hex");
      expect(await f.service.inspectRecorded(await source(), true)).toEqual({ kind: "unavailable", reason: "proof" });
      expect(f.data.get(f.aliasKey)).not.toHaveProperty("retired");
    },
  );

  it("refuses an overfull census and a previously settled alias whose proof disappeared", async () => {
    const f = await pending();
    const proofHash = ending(f);
    const selected = await source();
    const original = f.data.get(f.aliasKey);
    for (let i = 0; i < 64; i++) f.data.set(`${f.aliasKey}-${i}`, original);
    expect(await f.service.inspectRecorded(selected, true)).toEqual({ kind: "unavailable", reason: "identity" });
    for (let i = 0; i < 64; i++) f.data.delete(`${f.aliasKey}-${i}`);
    expect(await f.service.inspectRecorded(selected, true)).toEqual({
      kind: "retired",
      reason: "native_ended",
      proofHash,
    });
    f.data.delete(`native-operation-receipt:${f.nativeKey}`);
    expect(await f.service.inspectRecorded(selected)).toEqual({ kind: "unavailable", reason: "proof" });
  });

  it("keeps missing and physical-retirement-only endings pending and rejects damaged proof", async () => {
    const f = await pending();
    const selected = await source();
    expect(await f.service.inspectRecorded(selected, true)).toEqual({
      kind: "pending",
      reason: "native_ending_unproven",
    });
    f.data.set("native-retirement:t1:r1", { originalOperationOutcome: "unknown" });
    expect(await f.service.inspectRecorded(selected, true)).toEqual({
      kind: "pending",
      reason: "native_ending_unproven",
    });
    ending(f);
    const key = `native-operation-receipt:${f.nativeKey}`;
    const saved = f.data.get(key) as { receipt: { recordHash: string } };
    saved.receipt.recordHash = "0".repeat(64);
    expect(await f.service.inspectRecorded(selected, true)).toEqual({ kind: "unavailable", reason: "proof" });
    expect(f.data.get(f.aliasKey)).not.toHaveProperty("retired");
  });

  it("refuses conflicting owner, phase hash, ambiguous and malformed alias inventories", async () => {
    const f = await pending();
    ending(f);
    const selected = await source();
    expect(
      await f.service.inspectRecorded(
        { ...selected, operation: { ...selected.operation!, commandHash: "b".repeat(64) } },
        true,
      ),
    ).toEqual({ kind: "unavailable", reason: "identity" });
    const original = structuredClone(f.data.get(f.aliasKey)) as { context: CheckOperationContext };
    f.data.set(f.aliasKey, { ...original, context: { ...original.context, ownerGen: "other" } });
    expect(await f.service.inspectRecorded(selected, true)).toEqual({ kind: "unavailable", reason: "identity" });
    f.data.set(f.aliasKey, original);
    const second = { ...original, context: { ...original.context, ownerGen: "g2", ownerFence: 2 } };
    const duplicateKey = `check-result:${await checkCommandHash("t1")}:${await checkCommandHash(JSON.stringify(["r1", "g2", 2, selected.operation!.key]))}`;
    f.data.set(duplicateKey, second);
    expect(await f.service.inspectRecorded(selected, true)).toEqual({ kind: "unavailable", reason: "identity" });
    f.data.set(duplicateKey, { malformed: true });
    expect(await f.service.inspectRecorded(selected, true)).toEqual({ kind: "unavailable", reason: "identity" });
  });

  it("reads back a committed tombstone after a lost settlement acknowledgment", async () => {
    const f = await pending();
    const proofHash = ending(f);
    const transaction = f.storage.transaction.bind(f.storage);
    let lost = false;
    f.storage.transaction = async (action) => {
      const answer = await transaction(action);
      if (!lost && (f.data.get(f.aliasKey) as { endingHash?: string }).endingHash) {
        lost = true;
        throw new Error("ACK lost");
      }
      return answer;
    };
    expect(await f.service.inspectRecorded(await source(), true)).toEqual({
      kind: "retired",
      reason: "native_ended",
      proofHash,
    });
    expect(await f.service.inspectRecorded(await source(), true)).toEqual({
      kind: "retired",
      reason: "native_ended",
      proofHash,
    });
  });
});

describe("recorded check retention", () => {
  it.each(["stdout", "stderr"] as const)(
    "marks %s truncation caused by redaction expansion on immediate and saved results",
    async (stream) => {
      const f = fixture();
      const op = await operation();
      const source = "TOKEN=abcd\n".repeat(300);
      const answer = await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => ({ ...result, [stream]: source }),
      );
      expect(answer).toMatchObject({ kind: "completed", result: { truncated: true, exitCode: 0 } });
      if (answer.kind !== "completed") throw new Error("expected completed");
      expect(answer.result[stream].length).toBe(4000);
      expect(answer.result[stream]).not.toContain("abcd");
      expect(await f.service.inspect(context, op, async () => true)).toEqual(answer);
    },
  );

  it("removes completed output on retirement but preserves no-repeat and pending evidence", async () => {
    const f = fixture();
    const op = await operation();
    let effects = 0;
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toMatchObject({ kind: "completed", result });
    const pending = { ...op, key: "b".repeat(64) };
    await expect(
      f.service.execute(
        context,
        pending,
        request,
        async () => true,
        async () => {
          throw new Error("unknown native outcome");
        },
      ),
    ).rejects.toThrow("unknown native outcome");
    await f.service.retire(context.threadKey, async () => false);
    expect(await f.service.inspect(context, op, async () => true)).toMatchObject({ kind: "completed", result });
    await f.service.retire(context.threadKey, async () => true);
    expect(await f.service.inspect(context, op, async () => true)).toEqual({ kind: "unknown" });
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    expect(effects).toBe(1);
    const next = { ...context, runId: "next", ownerFence: 2 };
    expect(
      await f.service.execute(
        next,
        op,
        request,
        async () => true,
        async () => result,
      ),
    ).toMatchObject({ kind: "completed", result });
    const aliases = [...f.data.values()] as Array<{
      context: CheckOperationContext;
      checkOperation: { key: string };
      result?: unknown;
    }>;
    expect(aliases.map((row) => [row.context.runId, row.checkOperation.key, Boolean(row.result)])).toEqual([
      ["r1", "b".repeat(64), false],
      ["next", "a".repeat(64), true],
    ]);
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => false,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "unknown" });
    expect(effects).toBe(1);
  });

  it("bounds per-thread evidence and refuses capacity before command execution", async () => {
    const f = fixture();
    const op = await operation();
    let effects = 0;
    for (let i = 0; i < 64; i++) {
      expect(
        await f.service.execute(
          context,
          { ...op, key: i.toString(16).padStart(64, "0") },
          request,
          async () => true,
          async () => result,
        ),
      ).toMatchObject({ kind: "completed", result });
    }
    expect(
      await f.service.execute(
        context,
        op,
        request,
        async () => true,
        async () => {
          effects++;
          return result;
        },
      ),
    ).toEqual({ kind: "not_started", reason: "capacity" });
    expect(effects).toBe(0);
    expect(f.data.size).toBe(64);
  });

  it("caps and redacts persisted output before readback", async () => {
    const f = fixture();
    const op = await operation();
    const answer = await f.service.execute(
      context,
      op,
      request,
      async () => true,
      async () => ({ ...result, stdout: "x".repeat(5000), stderr: "Cookie: session=private-value" }),
    );
    expect(answer).toMatchObject({
      kind: "completed",
      result: { stdout: expect.any(String), stderr: "Cookie: «redacted»", truncated: true },
    });
    expect(JSON.stringify([...f.data])).not.toContain("private-value");
    if (answer.kind !== "completed") throw new Error("expected completed");
    expect(answer.result.stdout.length).toBe(4000);
  });
});

function inspectionHttpFixture(reads: unknown[], data = fixture()) {
  const source = ts.createSourceFile("worker.ts", readSource("worker.ts"), ts.ScriptTarget.Latest, true);
  const functions = [
    "bearerToken",
    "timingSafeEqual",
    "tokenScope",
    "hasScope",
    "parseResource",
    "parseThreadKey",
    "readRecordedCheckSource",
    "handleRecordedCheck",
    "residentRouteFor",
    "resolveThreadRoute",
    "json",
  ].map((name) => {
    const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`missing receiver function: ${name}`);
    return node.getText(source);
  });
  const variables = ["ROUTES", "RESOURCE_RE", "REPO_ID_RE", "SUPPORTED_RESOURCE_TYPES", "THREAD_KEY_RE"].map((name) =>
    source.statements
      .find(
        (node) =>
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((decl) => decl.name.getText(source) === name),
      )!
      .getText(source),
  );
  const resident = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ResidentDO",
  )!;
  const method = resident.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "inspectRecordedCheck",
  );
  if (!method) throw new Error("missing receiver method: inspectRecordedCheck");
  const exported = source.statements.find((node): node is ts.ExportAssignment => ts.isExportAssignment(node))!;
  const object = (exported.expression as ts.SatisfiesExpression).expression as ts.ObjectLiteralExpression;
  const fetchMethod = object.properties.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "fetch",
  )!;
  const code = ts.transpileModule(
    [
      ...functions,
      ...variables,
      `class Resident { ${method.getText(source)} }`,
      `const worker = { ${fetchMethod.getText(source)} };`,
    ].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const env = {
    STATE_WORKER_URL: "https://memory.invalid",
    MEMORY_TOKEN: "memory-secret",
    RESIDENT_OPERATOR_TOKEN: "operator",
    RESIDENT_ADMIN_TOKEN: "admin",
    RESIDENT_READ_TOKEN: "reader",
  };
  const requests: Array<{ url: string; token: string | null; body: unknown }> = [];
  const resources: string[] = [];
  const api = runInNewContext(code + "\n({worker, Resident})", {
    Request,
    Response,
    URL,
    TextEncoder,
    AbortSignal,
    checkSelectorSchema,
    checkSourceReadOf,
    checkSourceIdentityHash,
    residentRouteOf,
    sameResidentRoute,
    RecordedCheckOperation,
    RUN_STORE_KEY,
    RUN_STORE_TIMEOUT_MS,
    RESOURCE_KEY: "resident:resource",
    sanitizeResidentBody,
    STREAMED_ROUTES: new Set(),
    startAdoptedRoot: () => undefined,
    tracer: {},
    traceSinks: [],
    catchAllErr: (error: Error) => ({ error: error.message }),
    fetch: async (url: URL, init: RequestInit) => {
      requests.push({
        url: String(url),
        token: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)),
      });
      const value = reads.shift();
      if (value instanceof Error) throw value;
      return Response.json(value);
    },
    residentStub: (_env: unknown, resource: string) => {
      resources.push(resource);
      return Object.assign(new api.Resident(), { env, ctx: { storage: data.storage } });
    },
  });
  data.data.set("resident:resource", "repo:acme/app");
  return {
    requests,
    resources,
    data,
    request: (path: string, body: unknown, token = "operator") =>
      api.worker.fetch(
        new Request(`https://resident.invalid${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      ) as Promise<Response>,
  };
}

describe("recorded check receiver", () => {
  const selector = { runId: "r1", callId: "call1", phase: "command" };
  async function saved(patch: Partial<CheckSource> = {}) {
    return {
      kind: "source",
      source: {
        version: 1,
        state: "terminal",
        selector,
        resource: {
          type: "run",
          id: "r1",
          userId: "u1",
          channelId: "c1",
          channelVisibility: "private",
          repo: "acme/app",
        },
        threadKey: "slack:C1:123",
        operation: await operation(),
        ...patch,
      },
    };
  }
  it("authorizes the operator endpoint and reads canonical output without a Resident alias", async () => {
    const api = inspectionHttpFixture([await saved({ result })]);
    expect((await api.request("/inspect-check", selector, "reader")).status).toBe(401);
    const response = await api.request("/inspect-check", selector);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sourceHash: "e2e0e9a504d5475b3029a9124cb8ac3b70f0ecae4fadc3328f4169cca300e48a",
      inspection: { kind: "known", source: "canonical", result },
    });
    expect(api.requests).toEqual([
      {
        url: "https://memory.invalid/runs/check-source",
        token: "Bearer memory-secret",
        body: { storeKey: RUN_STORE_KEY, selector },
      },
    ]);
    expect(api.resources).toEqual([]);
  });
  it("refuses caller authority fields and independently rereads canonical identity inside the selected object", async () => {
    const api = inspectionHttpFixture([await saved(), await saved({ threadKey: "other-thread" })]);
    for (const patch of [
      { ownerGen: "forged" },
      { operation: await operation() },
      { resource: "repo:other/repo" },
      { source: await saved() },
    ]) {
      const response = await api.request("/settle-check", { ...selector, ...patch });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ kind: "unavailable", reason: "identity" });
    }
    const response = await api.request("/settle-check", selector);
    expect(await response.json()).toEqual({ kind: "unavailable", reason: "source" });
    expect(api.requests.map((value) => value.body)).toEqual([
      { storeKey: RUN_STORE_KEY, selector },
      { storeKey: RUN_STORE_KEY, selector },
    ]);
    expect(api.resources).toEqual(["repo:acme/app"]);
  });
  it("fails closed on unavailable Memory and refuses settlement while the canonical source is live", async () => {
    const api = inspectionHttpFixture([new Error("private failure"), await saved({ state: "live" })]);
    expect(await (await api.request("/inspect-check", selector)).json()).toEqual({
      kind: "unavailable",
      reason: "source",
    });
    expect(await (await api.request("/settle-check", selector)).json()).toEqual({
      kind: "unavailable",
      reason: "live",
    });
    expect(api.resources).toEqual([]);
  });

  it("binds displayed evidence to the final object read when the live authorization source changes", async () => {
    const final = await saved({ state: "live", result });
    final.source.resource.channelId = "changed";
    const api = inspectionHttpFixture([await saved({ state: "live" }), final]);
    expect(await (await api.request("/inspect-check", selector)).json()).toEqual({
      sourceHash: "71f9bb0bb5c5c2b6da31d17f0fff4660f2b084154f8e036912c520d57d785c24",
      inspection: { kind: "known", source: "canonical", result },
    });
    expect(api.resources).toEqual(["repo:acme/app"]);
  });

  it("settles only the original alias through the selector-only HTTP endpoint", async () => {
    const f = fixture();
    let nativeKey = "";
    await expect(
      f.service.execute(
        { ...context, threadKey: "slack:C1:123" },
        await operation(),
        request,
        async () => true,
        async (key) => {
          nativeKey = key;
          throw new Error("response lost");
        },
      ),
    ).rejects.toThrow("response lost");
    const aliasKey = [...f.data.keys()][0]!;
    const original = {
      runId: "r1",
      ownerGen: "g1",
      ownerFence: 1,
      native: { version: 1, closed: true, threadKey: "slack:C1:123", pending: {} },
    };
    const receipt = {
      key: nativeKey,
      recordHash: createHash("sha256").update(JSON.stringify(original)).digest("hex"),
      outcome: "native-ended",
      processes: [],
    };
    const proofHash = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    f.data.set(`native-operation-receipt:${nativeKey}`, { original, receipt });
    const api = inspectionHttpFixture([await saved(), await saved()], f);
    expect(await (await api.request("/settle-check", selector)).json()).toEqual({
      sourceHash: "e2e0e9a504d5475b3029a9124cb8ac3b70f0ecae4fadc3328f4169cca300e48a",
      inspection: { kind: "retired", reason: "native_ended", proofHash },
    });
    expect(f.data.get(aliasKey)).toMatchObject({
      context: { threadKey: "slack:C1:123", runId: "r1", ownerGen: "g1", ownerFence: 1 },
      nativeKey,
      retired: true,
      endingHash: proofHash,
    });
  });
});
