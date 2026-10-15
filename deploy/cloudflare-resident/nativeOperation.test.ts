import { selectedResidentMember } from "../../src/execution/residentMembers";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { readSource } from "./testing/sourceScan.js";
import { sanitizeResidentBody } from "../../src/execution/residentText.js";
import { validNativeOperationKey } from "./nativeOperation.js";
import { describe, expect, it } from "vitest";
import { NativeOperationJournal, type NativeOperationStorage, type NativeOperationRows } from "./nativeOperation.js";
import { NativeRunScopes } from "./nativeScope.js";
import { KeyedAsyncLock } from "./keyedAsyncLock.js";
import { RUN_ID_PATTERN } from "../../src/core/runIdentity.js";

function fixture() {
  const rows = new Map<string, unknown>();
  const lock = new KeyedAsyncLock();
  const access = (data: Map<string, unknown>): NativeOperationRows => ({
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
    delete: async (key) => data.delete(key),
  });
  const storage: NativeOperationStorage = {
    ...access(rows),
    list: async <T>({ prefix, limit, startAfter = "" }: { prefix: string; limit: number; startAfter?: string }) =>
      new Map(
        [...rows]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      ) as Map<string, T>,
    transaction: async (action) =>
      lock.run("storage", async () => {
        const draft = structuredClone(rows);
        const result = await action(access(draft));
        rows.clear();
        for (const [key, value] of draft) rows.set(key, value);
        return result;
      }),
  };
  return { rows, storage, journal: new NativeOperationJournal(storage) };
}
const identity = { id: "original-process", pid: 42, startedAt: "2026-10-11T00:00:00.000Z" };
const terminal = {
  ...identity,
  state: "exited",
  endedAt: "2026-10-11T00:00:01.000Z",
  exit: { code: 7, timedOut: false },
};
const key = "native-operation:op:original";
const matches = async () => true;
async function lostProcess(h: ReturnType<typeof fixture>, close = true) {
  await h.journal.open(key, { opOwner: "op:original" });
  const attempt = await h.journal.begin(key, "process");
  await h.journal.launched(key, attempt, { ...identity, command: ["secret-command"], state: "running" });
  if (close) await h.journal.close(key);
  return (await h.journal.list()).operations[0]!;
}

describe("stored original native endings", () => {
  it.each(["key", "hash", "process", "original", "retirement"])(
    "refuses %s evidence that cannot prove the stored original ending",
    async (fault) => {
      const h = fixture();
      const operation = await lostProcess(h);
      const receipt = await h.journal.recover(key, operation.recordHash, async () => terminal, matches);
      expect(receipt).toMatchObject({ outcome: "native-ended", key });
      const archived = structuredClone(h.rows.get(`native-operation-receipt:${key}`)) as {
        original: Record<string, unknown>;
        receipt: { key: string; recordHash: string; processes: (typeof terminal)[] };
      };
      if (fault === "key") archived.receipt.key += "-foreign";
      if (fault === "hash") archived.receipt.recordHash = "f".repeat(64);
      if (fault === "process") archived.receipt.processes[0].pid = 99;
      if (fault === "original") archived.original.opOwner = "op:foreign";
      h.rows.set(
        `native-operation-receipt:${key}`,
        fault === "retirement"
          ? { originalOperationOutcome: "unknown", records: { [key]: operation.recordHash } }
          : archived,
      );
      const before = structuredClone([...h.rows]);
      expect(await h.journal.readEnding(key)).toEqual({ kind: "unavailable" });
      expect([...h.rows]).toEqual(before);
    },
  );

  it("reads only the exact archived original ending without changing storage", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    expect(await h.journal.readEnding(key)).toEqual({ kind: "missing" });
    const receipt = await h.journal.recover(key, operation.recordHash, async () => terminal, matches);
    expect(receipt).toEqual({ key, recordHash: operation.recordHash, outcome: "native-ended", processes: [terminal] });
    const before = structuredClone([...h.rows]);
    expect(await h.journal.readEnding(key)).toEqual({
      kind: "ended",
      original: (before.find(([k]) => k === `native-operation-receipt:${key}`)![1] as { original: unknown }).original,
      receipt,
    });
    expect([...h.rows]).toEqual(before);
    expect(await h.journal.readEnding("native-operation:op:foreign")).toEqual({ kind: "missing" });
  });
});

describe("native launch storage acknowledgements", () => {
  it.each(["terminal", "running", "kill-ack", "kill-error"])(
    "preserves retirement when an already admitted recovery returns %s",
    async (phase) => {
      const h = fixture();
      const owner = { runId: "run-old", ownerGen: "gen-old", ownerFence: 7 };
      const threadKey = "slack:C1:123";
      const ownedKey = `native-operation:${threadKey}:run-old:pending`;
      await h.journal.open(ownedKey, owner, threadKey);
      const attempt = await h.journal.begin(ownedKey, "process");
      await h.journal.launched(ownedKey, attempt, identity);
      await h.journal.close(ownedKey);
      const original = structuredClone(h.rows.get(ownedKey));
      const saved = (await h.journal.list()).operations[0]!;
      let controls: unknown;
      const retire = async () => {
        controls = structuredClone(h.rows.get(`native-operation-control:${ownedKey}:${identity.id}`));
        h.rows.set(`native-retirement:${threadKey}:run-old`, {
          version: 1,
          cancellationId: "cancel-old",
          owner,
          threadKey,
          originalBoot: "old-kernel",
          currentBoot: "new-kernel",
          originalOperationOutcome: "unknown",
          records: await h.journal.fingerprints(`native-operation:${threadKey}:run-old:`),
        });
        h.rows.set(`cancelled:${threadKey}:run-old`, {
          stopped: true,
          disposition: "runtime-retired",
          retiredBoot: "new-kernel",
          cancellation: { id: "cancel-old", runId: "run-old", ownerGen: "gen-old", threadKey },
          target: { container: "old-kernel", ownerGen: "gen-old", ownerFence: 7 },
        });
      };
      let kills = 0;
      const result = await h.journal.recover(
        ownedKey,
        saved.recordHash,
        async () => {
          if (phase === "terminal" || phase === "running") await retire();
          return phase === "terminal" ? terminal : { ...identity, state: "running" };
        },
        matches,
        phase === "terminal"
          ? undefined
          : async () => {
              kills++;
              await retire();
              if (phase === "kill-error") throw new Error("late acknowledgement lost");
            },
      );
      expect(result).toEqual({
        error: "native-operation-recovery-refused: original-runtime-retired; historical effects unknown",
        status: 409,
      });
      expect(h.rows.get(ownedKey)).toEqual(original);
      expect(h.rows.get(`native-operation-control:${ownedKey}:${identity.id}`)).toEqual(controls);
      expect(kills).toBe(phase === "kill-ack" || phase === "kill-error" ? 1 : 0);
    },
  );
  it("preserves retired journal bytes across late callbacks and refuses renewed launch or recovery", async () => {
    const h = fixture();
    const owner = { runId: "run-old", ownerGen: "gen-old", ownerFence: 7 };
    const threadKey = "slack:C1:123";
    const ownedKey = `native-operation:${threadKey}:run-old:pending`;
    await h.journal.open(ownedKey, owner, threadKey);
    const attempt = await h.journal.begin(ownedKey, "process");
    await h.journal.launched(ownedKey, attempt, identity);
    const savedNative = (h.rows.get(ownedKey) as { native: unknown }).native;
    h.rows.set(ownedKey, { native: savedNative, ownerFence: 7, ownerGen: "gen-old", runId: "run-old" });
    const original = structuredClone(h.rows.get(ownedKey));
    h.rows.set(`native-retirement:${threadKey}:run-old`, {
      version: 1,
      cancellationId: "cancel-old",
      owner,
      threadKey,
      originalBoot: "old-kernel",
      currentBoot: "new-kernel",
      originalOperationOutcome: "unknown",
      records: await h.journal.fingerprints(`native-operation:${threadKey}:run-old:`),
    });
    h.rows.set(`cancelled:${threadKey}:run-old`, {
      stopped: true,
      disposition: "runtime-retired",
      retiredBoot: "new-kernel",
      cancellation: { id: "cancel-old", runId: "run-old", ownerGen: "gen-old", threadKey },
      target: { container: "old-kernel", ownerGen: "gen-old", ownerFence: 7 },
    });
    await h.journal.settle(ownedKey, attempt);
    await h.journal.close(ownedKey);
    await expect(h.journal.begin(ownedKey, "process")).rejects.toThrow("original native runtime retired");
    await expect(h.journal.launched(ownedKey, attempt, identity)).rejects.toThrow("original native runtime retired");
    await expect(h.journal.open(`${ownedKey}-late`, owner, threadKey)).rejects.toThrow("run cancelled");
    const saved = (await h.journal.list()).operations[0]!;
    expect(saved).toMatchObject({ recoverable: false, recoveryReason: "original-runtime-retired" });
    expect(await h.journal.recover(ownedKey, saved.recordHash, async () => terminal, matches)).toEqual({
      error: "native-operation-recovery-refused: original-runtime-retired; historical effects unknown",
      status: 409,
    });
    expect(h.rows.get(ownedKey)).toEqual(original);
    expect([...(await h.journal.unresolved())]).toEqual([]);
  });
  it("keeps original retired history and finds foreign active work beyond a full retired page", async () => {
    const h = fixture();
    const owner = { runId: "run-old", ownerGen: "gen-old", ownerFence: 7 };
    const threadKey = "slack:C1:123";
    for (let i = 0; i < 30; i++)
      h.rows.set(`native-operation:${threadKey}:run-old:${String(i).padStart(2, "0")}`, { ...owner });
    const original = structuredClone([...h.rows]);
    const records = await h.journal.fingerprints(`native-operation:${threadKey}:run-old:`);
    h.rows.set(`native-retirement:${threadKey}:run-old`, {
      version: 1,
      cancellationId: "cancel-old",
      owner,
      threadKey,
      originalBoot: "old-kernel",
      currentBoot: "new-kernel",
      originalOperationOutcome: "unknown",
      records,
    });
    h.rows.set(`cancelled:${threadKey}:run-old`, {
      stopped: true,
      disposition: "runtime-retired",
      retiredBoot: "new-kernel",
      cancellation: { id: "cancel-old", runId: "run-old", ownerGen: "gen-old", threadKey },
      target: { container: "old-kernel", ownerGen: "gen-old", ownerFence: 7 },
    });
    const foreignKey = "native-operation:zz:run-live:one";
    const foreign = { runId: "run-live", ownerGen: "gen-live", ownerFence: 8 };
    h.rows.set(foreignKey, foreign);
    expect([...(await h.journal.unresolved())]).toEqual([[foreignKey, foreign]]);
    for (const [key, value] of original) expect(h.rows.get(key)).toEqual(value);
    const changedKey = `native-operation:${threadKey}:run-old:00`;
    h.rows.set(changedKey, { ...owner, altered: true });
    expect([...(await h.journal.unresolved()).keys()]).toEqual([changedKey, foreignKey]);
    h.rows.set(changedKey, { ...owner, ownerFence: 9 });
    expect([...(await h.journal.unresolved()).keys()]).toEqual([changedKey, foreignKey]);
    h.rows.set(changedKey, { ...owner, ownerGen: "other-generation" });
    expect([...(await h.journal.unresolved()).keys()]).toEqual([changedKey, foreignKey]);
  });
  function lostAck(h: ReturnType<typeof fixture>, commit: boolean, readable = true) {
    return new NativeOperationJournal({
      ...h.storage,
      get: async <T>(key: string) => {
        if (!readable) throw new Error("readback unavailable");
        return h.storage.get<T>(key);
      },
      transaction: async (action) => {
        if (commit) await h.storage.transaction(action);
        throw new Error("transaction acknowledgement lost");
      },
    });
  }

  it("returns the exact committed admission after its acknowledgement is lost", async () => {
    const h = fixture();
    await h.journal.open(key, { opOwner: "op:original" });
    const attempt = await lostAck(h, true).begin(key, "process");
    expect(await h.storage.get(key)).toEqual({
      opOwner: "op:original",
      native: { version: 1, closed: false, pending: { [attempt]: { kind: "process" } } },
    });
    // The returned admission belongs to this original journal after restart.
    await new NativeOperationJournal(h.storage).launched(key, attempt, identity);
    await h.journal.close(key);
    const saved = (await h.journal.list()).operations[0]!;
    expect(await h.journal.recover(key, saved.recordHash, async () => terminal, matches)).toEqual({
      key,
      recordHash: saved.recordHash,
      outcome: "native-ended",
      processes: [terminal],
    });
  });

  it("requires admission readback and preserves committed unknown evidence", async () => {
    const h = fixture();
    await h.journal.open(key, { opOwner: "op:original" });
    await expect(lostAck(h, false).begin(key, "process")).rejects.toThrow();
    expect(await h.storage.get(key)).toEqual({
      opOwner: "op:original",
      native: { version: 1, closed: false, pending: {} },
    });
    await expect(lostAck(h, true, false).begin(key, "process")).rejects.toThrow();
    await h.journal.close(key);
    const saved = (await h.journal.list()).operations[0]!;
    expect(saved).toMatchObject({
      key,
      owner: { opOwner: "op:original" },
      recoverable: false,
      recoveryReason: "original-native-evidence-unavailable",
      journal: { version: 1, closed: true },
    });
    expect(Object.values(saved.journal!.pending)).toEqual([{ kind: "process" }]);
    expect(await h.journal.recover(key, saved.recordHash, async () => terminal, matches)).toEqual({
      error: "native-operation-recovery-refused: original-native-evidence-unavailable",
      status: 409,
    });
  });

  it("qualifies only the original full identity after its write acknowledgement is lost", async () => {
    const h = fixture();
    await h.journal.open(key, { opOwner: "op:original" });
    const attempt = await h.journal.begin(key, "process");
    await lostAck(h, true).launched(key, attempt, identity);
    await h.journal.close(key);
    const saved = (await new NativeOperationJournal(h.storage).list()).operations[0]!;
    expect(saved.journal!.pending).toEqual({ [attempt]: { kind: "process", process: identity } });
    expect(saved.recoverable).toBe(true);
    expect(await h.journal.recover(key, saved.recordHash, async () => terminal, matches)).toEqual({
      key,
      recordHash: saved.recordHash,
      outcome: "native-ended",
      processes: [terminal],
    });
  });

  it("does not credit an absent identity or replace an original tuple", async () => {
    const h = fixture();
    await h.journal.open(key, { opOwner: "op:original" });
    const attempt = await h.journal.begin(key, "process");
    await expect(lostAck(h, false).launched(key, attempt, identity)).rejects.toThrow();
    expect((await h.journal.list()).operations[0]!.journal!.pending).toEqual({ [attempt]: { kind: "process" } });
    await h.journal.launched(key, attempt, identity);
    for (const changed of [
      { ...identity, id: "other-process" },
      { ...identity, pid: 43 },
      { ...identity, startedAt: "2026-10-11T00:00:02.000Z" },
    ]) {
      await expect(lostAck(h, true).launched(key, attempt, changed)).rejects.toThrow();
    }
    await expect(lostAck(h, false, false).launched(key, attempt, identity)).rejects.toThrow();
    await h.journal.close(key);
    const saved = (await h.journal.list()).operations[0]!;
    expect(saved.journal!.pending).toEqual({ [attempt]: { kind: "process", process: identity } });
    expect(await h.journal.recover(key, saved.recordHash, async () => terminal, matches)).toMatchObject({
      outcome: "native-ended",
      processes: [terminal],
    });
  });
  it("does not qualify process-shaped evidence on an opaque attempt", async () => {
    const h = fixture();
    await h.journal.open(key, { opOwner: "op:original" });
    const attempt = await h.journal.begin(key, "opaque");
    const record = {
      opOwner: "op:original",
      native: { version: 1, closed: true, pending: { [attempt]: { kind: "opaque", process: identity } } },
    };
    await h.storage.put(key, record);
    await expect(lostAck(h, true).launched(key, attempt, identity)).rejects.toThrow("native launch identity changed");
    expect(await h.storage.get(key)).toEqual(record);
    const saved = (await h.journal.list()).operations[0]!;
    expect(await h.journal.recover(key, saved.recordHash, async () => terminal, matches)).toEqual({
      error: "native-operation-recovery-refused: original-native-evidence-unavailable",
      status: 409,
    });
  });
});

describe("native operation journal", () => {
  it("an audit-write failure preserves the entire unresolved record", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    const before = structuredClone(h.rows);
    const failing = new NativeOperationJournal({
      ...h.storage,
      transaction: (action) =>
        h.storage.transaction((rows) =>
          action({
            ...rows,
            put: async (key, value) => {
              if (key.startsWith("native-operation-receipt:")) throw new Error("audit write failed");
              await rows.put(key, value);
            },
          }),
        ),
    });
    await expect(failing.recover(key, operation.recordHash, async () => terminal, matches)).rejects.toThrow(
      "audit write failed",
    );
    expect(h.rows).toEqual(before);
  });

  it("metadata inventory is bounded and preserves legacy evidence", async () => {
    const h = fixture();
    for (let i = 0; i < 26; i++)
      h.rows.set(`native-operation:op:${String(i).padStart(2, "0")}`, { opOwner: `op:${i}`, secret: "private" });
    const page = await h.journal.list();
    expect(page.operations).toHaveLength(25);
    expect(page.cursor).toBe("native-operation:op:24");
    expect(page.operations[0]).toEqual({
      key: "native-operation:op:00",
      recordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      owner: { opOwner: "op:0" },
      journal: null,
      recoverable: false,
      recoveryReason: "legacy-or-invalid-record",
      controls: [],
    });
    const last = await h.journal.list(page.cursor!);
    expect(last.operations.map((row) => row.key)).toEqual(["native-operation:op:25"]);
    expect(h.rows.get("native-operation:op:00")).toEqual({ opOwner: "op:0", secret: "private" });
  });

  it("recovers the original terminal process after restart and keeps its receipt", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    const original = structuredClone(h.rows.get(key));
    h.rows.set("private-bytes", "unpublished work");
    h.rows.set("native-operation:op:other", { opOwner: "op:other" });
    const restarted = new NativeOperationJournal(h.storage);
    const receipt = await restarted.recover(key, operation.recordHash, async () => terminal, matches);
    expect(receipt).toEqual({ key, recordHash: operation.recordHash, outcome: "native-ended", processes: [terminal] });
    expect(h.rows.get("native-operation-receipt:" + key)).toEqual({ original, receipt });
    expect(h.rows.get("private-bytes")).toBe("unpublished work");
    expect(h.rows.get("native-operation:op:other")).toEqual({ opOwner: "op:other" });
    expect(h.rows.has(key)).toBe(false);
    expect(
      await restarted.recover(
        key,
        operation.recordHash,
        async () => {
          throw new Error("receipt replay must not inspect runtime");
        },
        matches,
      ),
    ).toEqual(receipt);
    await expect(restarted.begin(key, "process")).rejects.toThrow();
  });

  it("terminates only the original recorded process and preserves unrelated work", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    h.rows.set("private-bytes", "unpublished work");
    let stopped = false;
    const killed: unknown[] = [];
    expect(
      await h.journal.recover(
        key,
        operation.recordHash,
        async () => (stopped ? terminal : { ...identity, state: "running" }),
        matches,
        async (target) => {
          killed.push(target);
          stopped = true;
        },
      ),
    ).toEqual({ key, recordHash: operation.recordHash, outcome: "native-ended", processes: [terminal] });
    expect(killed).toEqual([{ id: "original-process", pid: 42, startedAt: "2026-10-11T00:00:00.000Z" }]);
    expect(h.rows.get("private-bytes")).toBe("unpublished work");
    expect(h.rows.get(`native-operation-control:${key}:${identity.id}`)).toEqual({
      process: identity,
      recordHash: operation.recordHash,
      outcome: "kill-acknowledged",
    });
  });

  it("refuses termination when the original owner or process identity changes", async () => {
    for (const ownerMatches of [true, false]) {
      const h = fixture();
      const operation = await lostProcess(h);
      const before = structuredClone(h.rows);
      const killed: unknown[] = [];
      const result = await h.journal.recover(
        key,
        operation.recordHash,
        async () => ({ ...identity, pid: ownerMatches ? 43 : 42, state: "running" }),
        async () => ownerMatches,
        async (target) => {
          killed.push(target);
        },
      );
      expect(result).toEqual({
        error: `native-operation-recovery-refused: ${ownerMatches ? "original-process-identity-changed" : "record-or-owner-changed"}`,
        status: 409,
      });
      expect(h.rows).toEqual(before);
      expect(killed).toEqual([]);
    }
  });

  it("records an unknown termination outcome durably and refuses replay after restart", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    const original = structuredClone(h.rows.get(key));
    let controls = 0;
    const terminate = async () => {
      controls++;
      throw new Error("lost reply");
    };
    const lookup = async () => ({ ...identity, state: "running" });
    expect(await h.journal.recover(key, operation.recordHash, lookup, matches, terminate)).toEqual({
      error: "native-operation-recovery-refused: termination-outcome-unverified",
      status: 503,
      details: { class: "Error" },
    });
    const restarted = new NativeOperationJournal(h.storage);
    expect((await restarted.list()).operations[0]?.controls).toEqual([
      { process: identity, recordHash: operation.recordHash, outcome: "kill-unverified", failure: { class: "Error" } },
    ]);
    expect(await restarted.recover(key, operation.recordHash, lookup, matches, terminate)).toEqual({
      error:
        "native-operation-recovery-refused: termination-already-requested; observe the original process before recovery",
      status: 409,
    });
    expect(controls).toBe(1);
    expect(h.rows.get(key)).toEqual(original);
    h.rows.delete(key);
    expect(await restarted.recover(key, operation.recordHash, lookup, matches)).toEqual({
      status: 409,
      error: "native-operation-recovery-refused: record-missing-or-changed",
      controls: [
        {
          process: identity,
          recordHash: operation.recordHash,
          outcome: "kill-unverified",
          failure: { class: "Error" },
        },
      ],
    });
    const changed = structuredClone(original) as { native: { closed: boolean } };
    changed.native.closed = false;
    h.rows.set(key, changed);
    const current = (await restarted.list()).operations[0]!;
    expect(current.controls).toEqual([
      { process: identity, recordHash: operation.recordHash, outcome: "kill-unverified", failure: { class: "Error" } },
    ]);
    expect(await restarted.recover(key, current.recordHash, lookup, matches, terminate)).toMatchObject({
      status: 409,
      error:
        "native-operation-recovery-refused: termination-already-requested; observe the original process before recovery",
    });
    expect(controls).toBe(1);
  });

  it.each([
    ["running", { ...identity, state: "running" }],
    ["missing", null],
    ["different process", { ...terminal, id: "successor" }],
    ["reused PID", { ...terminal, startedAt: "2026-10-11T00:00:00.001Z" }],
    ["different PID", { ...terminal, pid: 43 }],
    ["incomplete exit", { ...terminal, exit: { code: -1 } }],
  ])("keeps original evidence when native status is %s", async (_name, result) => {
    const h = fixture();
    const operation = await lostProcess(h);
    const before = structuredClone(h.rows);
    expect(await h.journal.recover(key, operation.recordHash, async () => result, matches)).toEqual({
      error: "native-operation-recovery-refused: original-process-not-confirmed-ended",
      status: 409,
    });
    expect(h.rows).toEqual(before);
  });

  it.each(["process", "opaque"] as const)(
    "keeps an unresolved %s admission without inventing a result",
    async (kind) => {
      const h = fixture();
      await h.journal.open(key, { opOwner: "op:original" });
      await h.journal.begin(key, kind);
      await h.journal.close(key);
      const operation = (await h.journal.list()).operations[0]!;
      const before = structuredClone(h.rows);
      expect(await h.journal.recover(key, operation.recordHash, async () => terminal, matches)).toEqual({
        error: "native-operation-recovery-refused: original-native-evidence-unavailable",
        status: 409,
      });
      expect(h.rows).toEqual(before);
    },
  );

  it("does not clear a legacy record using terminal run status", async () => {
    const h = fixture();
    h.rows.set(key, { opOwner: "op:original" });
    const operation = (await h.journal.list()).operations[0]!;
    expect(await h.journal.recover(key, operation.recordHash, async () => terminal, matches)).toEqual({
      error: "native-operation-recovery-refused: original-native-evidence-unavailable",
      status: 409,
    });
    expect(h.rows.get(key)).toEqual({ opOwner: "op:original" });
  });

  it("requires every pending process to be terminal", async () => {
    const h = fixture();
    await lostProcess(h, false);
    const id = await h.journal.begin(key, "process");
    await h.journal.launched(key, id, { ...identity, id: "second" });
    await h.journal.close(key);
    const operation = (await h.journal.list()).operations[0]!;
    const before = structuredClone(h.rows);
    expect(
      await h.journal.recover(
        key,
        operation.recordHash,
        async (process) => (process.id === "second" ? { ...identity, id: "second", state: "running" } : terminal),
        matches,
      ),
    ).toEqual({ error: "native-operation-recovery-refused: original-process-not-confirmed-ended", status: 409 });
    expect(h.rows).toEqual(before);
  });

  it("a late admission changes the record and prevents settlement", async () => {
    const h = fixture();
    const operation = await lostProcess(h, false);
    expect(
      await h.journal.recover(
        key,
        operation.recordHash,
        async () => {
          await h.journal.begin(key, "opaque");
          return terminal;
        },
        matches,
      ),
    ).toEqual({ error: "native-operation-recovery-refused: record-or-owner-changed", status: 409 });
    expect(
      Object.values((await h.journal.list()).operations[0]!.journal!.pending).map((attempt) => attempt.kind),
    ).toEqual(["process", "opaque"]);
    expect(h.rows.has("native-operation-receipt:" + key)).toBe(false);
  });

  it("changed ownership and unreadable native evidence both retain the original record", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    const before = structuredClone(h.rows);
    expect(
      await h.journal.recover(
        key,
        operation.recordHash,
        async () => terminal,
        async () => false,
      ),
    ).toEqual({ error: "native-operation-recovery-refused: record-or-owner-changed", status: 409 });
    expect(h.rows).toEqual(before);
    expect(
      await h.journal.recover(
        key,
        operation.recordHash,
        async () => {
          throw new Error("lost native response");
        },
        matches,
      ),
    ).toEqual({
      error: "native-operation-recovery-refused: native-evidence-unreadable",
      status: 503,
      details: { class: "Error" },
    });
    expect(h.rows).toEqual(before);
  });

  it("known completion settles only its admission and closed scopes cannot launch more work", async () => {
    const h = fixture();
    await h.journal.open(key, { opOwner: "op:original" });
    const known = await h.journal.begin(key, "process");
    const unknown = await h.journal.begin(key, "opaque");
    await h.journal.close(key);
    await h.journal.settle(key, known);
    expect((await h.journal.list()).operations[0]!.journal).toEqual({
      version: 1,
      closed: true,
      pending: { [unknown]: { kind: "opaque" } },
    });
    await expect(h.journal.begin(key, "process")).rejects.toThrow("native operation already closed");
  });
});

function httpFixture(h: ReturnType<typeof fixture>, running = false, reportError?: Error, failStub = false) {
  const source = ts.createSourceFile("worker.ts", readSource("worker.ts"), ts.ScriptTarget.Latest, true);
  const functions = [
    "bearerToken",
    "timingSafeEqual",
    "tokenScope",
    "hasScope",
    "parseResource",
    "parseThreadKey",
    "handleDebug",
    "handleRecoverNativeOperation",
    "json",
  ].map((name) =>
    source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source),
  );
  const variables = [
    "ROUTES",
    "READ_DEBUG_OPS",
    "RESOURCE_RE",
    "REPO_ID_RE",
    "SUPPORTED_RESOURCE_TYPES",
    "THREAD_KEY_RE",
  ].map((name) =>
    source.statements
      .find(
        (node) =>
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((decl) => decl.name.getText(source) === name),
      )!
      .getText(source),
  );
  const exported = source.statements.find((node): node is ts.ExportAssignment => ts.isExportAssignment(node))!;
  const object = (exported.expression as ts.SatisfiesExpression).expression as ts.ObjectLiteralExpression;
  const fetch = object.properties.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "fetch",
  )!;
  const compiled = ts.transpileModule(
    [...functions, ...variables, `const worker = { ${fetch.getText(source)} };`].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  let nativeReads = 0;
  let nativeControls = 0;
  let terminated = false;
  const reports: unknown[] = [];
  const residentResources: string[] = [];
  const worker = runInNewContext(compiled + "\nworker", {
    Request,
    Response,
    URL,
    TextEncoder,
    sanitizeResidentBody,
    selectedResidentMember,
    registryStub: () => ({ getRepository: async (resource: string) => ({ resource }) }),
    validNativeOperationKey,
    RUN_ID_PATTERN,
    STREAMED_ROUTES: new Set(),
    startAdoptedRoot: () => undefined,
    tracer: {},
    traceSinks: [],
    catchAllErr: (error: Error) => ({ error: error.message }),
    withFleetAdmission: () => {
      throw new Error("recovery must not reopen fleet admission");
    },
    residentStub: (_env: unknown, resource: string) => {
      if (reportError && failStub) throw reportError;
      residentResources.push(resource);
      return {
        getWorkloadAudit: async (requestedResource: string) => ({
          schema: 1,
          resource: requestedResource,
          residentId: resource,
          used: 1,
          complete: true,
          owners: [{ key: "op:original", sources: [{ kind: "native-operation" }] }],
        }),
        debugThreads: async (selection?: { threadKey: string; runId: string }) => {
          reports.push({ resource, selection });
          if (reportError) throw reportError;
          return selection
            ? {
                cancellation: {
                  runId: selection.runId,
                  threadKey: selection.threadKey,
                  evidence: "stored-only",
                  state: "absent",
                },
              }
            : { threads: [] };
        },
        getNativeOperations: (cursor?: string) => h.journal.list(cursor),
        recoverNativeOperation: (key: string, hash: string, terminate = false) =>
          h.journal.recover(
            key,
            hash,
            async () => {
              nativeReads++;
              return running && !terminated ? { ...identity, state: "running" } : terminal;
            },
            matches,
            terminate
              ? async () => {
                  nativeControls++;
                  terminated = true;
                }
              : undefined,
          ),
      };
    },
  });
  const env = {
    RESIDENT_ADMIN_TOKEN: "admin",
    RESIDENT_READ_TOKEN: "reader",
    RESIDENT_OPERATOR_TOKEN: "operator",
    RESIDENT_DRAIN_TOKEN: "drain",
  };
  return {
    request: (path: string, token: string | null, body: unknown) =>
      worker.fetch(
        new Request("https://resident.invalid" + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
          body: JSON.stringify(body),
        }),
        env,
      ) as Promise<Response>,
    nativeReads: () => nativeReads,
    nativeControls: () => nativeControls,
    reports,
    residentResources,
  };
}

describe("resident cancellation inspection HTTP", () => {
  const selection = { op: "threads", resource: "repo:acme/app", threadKey: "slack:C1:123", runId: "run-old" };
  it.each(["report", "stub"])("returns a closed unavailable response when the selected %s fails", async (boundary) => {
    const api = httpFixture(
      fixture(),
      false,
      new Error("fixture-private-token /workspace/private-file"),
      boundary === "stub",
    );
    const response = await api.request("/debug", "reader", selection);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The saved shutdown report is unavailable." });
    expect(api.reports).toEqual(
      boundary === "stub"
        ? []
        : [{ resource: "repo:acme/app", selection: { threadKey: "slack:C1:123", runId: "run-old" } }],
    );
    expect(api.nativeControls()).toBe(0);
  });
  it("keeps the existing Read scope and resource while returning selected stored evidence", async () => {
    const api = httpFixture(fixture());
    for (const token of ["reader", "admin"]) {
      const response = await api.request("/debug", token, selection);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        cancellation: {
          runId: "run-old",
          threadKey: "slack:C1:123",
          evidence: "stored-only",
          state: "absent",
        },
      });
    }
    expect(api.reports).toEqual([
      { resource: "repo:acme/app", selection: { threadKey: "slack:C1:123", runId: "run-old" } },
      { resource: "repo:acme/app", selection: { threadKey: "slack:C1:123", runId: "run-old" } },
    ]);
    for (const token of ["operator", "drain", null])
      expect((await api.request("/debug", token, selection)).status).toBe(401);
    expect(api.reports).toHaveLength(2);
    expect(api.nativeReads()).toBe(0);
    expect(api.nativeControls()).toBe(0);
  });
  it("refuses invalid or incomplete selectors before creating a Resident stub", async () => {
    const api = httpFixture(fixture());
    for (const body of [
      { ...selection, runId: undefined },
      { ...selection, threadKey: undefined },
      { ...selection, runId: "run:foreign" },
      { ...selection, threadKey: "not-namespaced" },
      { ...selection, runId: "x".repeat(65) },
      { ...selection, resource: "not-a-repository" },
    ])
      expect((await api.request("/debug", "reader", body)).status).toBe(400);
    expect(api.reports).toEqual([]);
    expect(api.residentResources).toEqual([]);
    const response = await api.request("/debug", "reader", { op: "threads", resource: "repo:acme/app" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threads: [] });
  });
});

describe("resident workload audit HTTP", () => {
  it("read and admin bearers inspect the named primary without native controls", async () => {
    const api = httpFixture(fixture());
    for (const token of ["reader", "admin"]) {
      const response = await api.request("/debug", token, { op: "workload-audit", resource: "repo:acme/app" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        schema: 1,
        resource: "repo:acme/app",
        residentId: "repo:acme/app",
        used: 1,
        owners: [{ key: "op:original" }],
      });
    }
    for (const token of ["operator", "drain", null])
      expect((await api.request("/debug", token, { op: "workload-audit", resource: "repo:acme/app" })).status).toBe(
        401,
      );
    expect(api.nativeControls()).toBe(0);
  });

  it("refuses replica and malformed resource selectors before reading another resident", async () => {
    const api = httpFixture(fixture());
    for (const body of [
      { op: "workload-audit", resource: "invalid" },
      { op: "workload-audit", resource: "repo:acme/app", residentId: "replica-other" },
      { op: "workload-audit", resource: "repo:acme/app", placementId: "unverified" },
    ])
      expect((await api.request("/debug", "reader", body)).status).toBe(400);
    const response = await api.request("/debug", "reader", { op: "workload-audit", resource: "repo:acme/app" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: "repo:acme/app", used: 1 });
    expect(api.residentResources).toEqual(["repo:acme/app"]);
  });
});

describe("native operation HTTP permissions", () => {
  it("admin termination must be explicit and strictly typed, while readers cannot signal a process", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    const api = httpFixture(h, true);
    const target = { resource: "repo:acme/app", key, recordHash: operation.recordHash };
    expect((await api.request("/recover-native-operation", "reader", { ...target, terminate: true })).status).toBe(401);
    expect((await api.request("/recover-native-operation", "admin", { ...target, terminate: "yes" })).status).toBe(400);
    expect((await api.request("/recover-native-operation", "admin", target)).status).toBe(409);
    expect(api.nativeControls()).toBe(0);
    const stopped = await api.request("/recover-native-operation", "admin", { ...target, terminate: true });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({
      key,
      recordHash: operation.recordHash,
      outcome: "native-ended",
      processes: [terminal],
    });
    expect(api.nativeControls()).toBe(1);
  });

  it("a read bearer inventories metadata but cannot recover an operation", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    const api = httpFixture(h);
    const before = structuredClone(h.rows);
    const listing = await api.request("/debug", "reader", { op: "native-operations", resource: "repo:acme/app" });
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual({ operations: [operation], cursor: null });
    const denied = await api.request("/recover-native-operation", "reader", {
      resource: "repo:acme/app",
      key,
      recordHash: operation.recordHash,
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    expect(api.nativeReads()).toBe(0);
    expect(h.rows).toEqual(before);
  });

  it.each([null, "operator", "drain"])("refuses recovery by %s without touching native state", async (token) => {
    const h = fixture();
    const operation = await lostProcess(h);
    const api = httpFixture(h);
    const denied = await api.request("/recover-native-operation", token, {
      resource: "repo:acme/app",
      key,
      recordHash: operation.recordHash,
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    expect(h.rows.has(key)).toBe(true);
    expect(api.nativeReads()).toBe(0);
  });

  it("admin recovers one exact record while fleet admission stays closed", async () => {
    const h = fixture();
    const operation = await lostProcess(h);
    const api = httpFixture(h);
    const response = await api.request("/recover-native-operation", "admin", {
      resource: "repo:acme/app",
      key,
      recordHash: operation.recordHash,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      key,
      recordHash: operation.recordHash,
      outcome: "native-ended",
      processes: [terminal],
    });
    expect(api.nativeReads()).toBe(1);
    expect(h.rows.has(key)).toBe(false);
    const invalid = await api.request("/recover-native-operation", "admin", {
      resource: "repo:acme/app",
      key: "run:other",
      recordHash: operation.recordHash,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "exact native operation key and recordHash are required" });
    expect(api.nativeReads()).toBe(1);
  });
});

describe("native scope execution retirement", () => {
  async function retained() {
    const h = fixture();
    const owner = { runId: "run-a", ownerGen: "gen-a", ownerFence: 3 };
    const thread = "thread-a";
    const key = `native-operation:${thread}:run-a:unknown`;
    const scopes = new NativeRunScopes(h.storage, {
      request: async (value) => ({
        stdout: JSON.stringify(
          value.mode === "inspect"
            ? { version: 1, boot: "11111111-1111-4111-8111-111111111111" }
            : {
                ref: value.ref,
                closed: value.mode === "close",
                ...(value.mode === "close" ? { populated: false } : {}),
              },
        ),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    });
    await scopes.birth(thread, owner, true, async () => {});
    const scope = await scopes.ensure(thread, owner, async () => {});
    await h.journal.open(key, owner, thread);
    await h.journal.bindScope(key, scope);
    const attempt = await h.journal.begin(key, "opaque");
    await h.journal.close(key);
    const original = structuredClone(h.rows.get(key));
    await scopes.close(thread, owner);
    h.rows.set(`cancelled:${thread}:run-a`, {
      stopped: true,
      cancellation: { id: "stop-a", runId: "run-a", ownerGen: "gen-a", threadKey: thread },
    });
    h.rows.set(`native-scope-retirement:${thread}:run-a:gen-a:3`, {
      scope,
      cancellationId: "stop-a",
      controllerOwnerGen: "gen-a",
      originalOperationOutcome: "unknown",
      records: await h.journal.fingerprints("native-operation:"),
    });
    return { ...h, key, attempt, original, owner, scope };
  }
  it("releases only execution debt and retains the original unknown journal bytes", async () => {
    const h = await retained();
    expect((await h.journal.unresolved()).size).toBe(0);
    await h.journal.settle(h.key, h.attempt);
    await h.journal.close(h.key);
    expect(h.rows.get(h.key)).toEqual(h.original);
    expect(await h.journal.readEnding(h.key)).toEqual({ kind: "missing" });
    expect((await h.journal.list()).operations[0]).toMatchObject({
      retirement: { originalOperationOutcome: "unknown" },
    });
  });
  it.each(["gate", "hash", "ticket", "owner"])(
    "retains execution debt when %s closure evidence changes",
    async (fault) => {
      const h = await retained();
      if (fault === "gate") h.rows.delete("native-scope:thread-a:run-a:gen-a:3");
      if (fault === "ticket")
        h.rows.set("cancelled:thread-a:run-a", { stopped: true, cancellation: { id: "foreign" } });
      if (fault === "hash") h.rows.set(h.key, { ...(h.original as object), ownerFence: 4 });
      if (fault === "owner")
        h.rows.set("native-scope-retirement:thread-a:run-a:gen-a:3", {
          scope: { ...h.scope, owner: { ...h.owner, runId: "foreign" } },
        });
      expect((await h.journal.unresolved()).has(h.key)).toBe(true);
      expect(await h.journal.readEnding(h.key)).toEqual({ kind: "missing" });
    },
  );
});
