import { describe, expect, it, vi } from "vitest";
import { RecordedCheckOperation, type CheckOperationStorage, type CheckOperationContext } from "./checkOperation.js";
import { checkCommandHash } from "../../src/execution/checkOperation.js";

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
    async list<T>({ prefix }) {
      return new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
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
