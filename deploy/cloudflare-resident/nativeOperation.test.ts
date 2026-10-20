import { observeWorkerRequest } from "../../src/core/trace/workerCorrelation.js";
import { prepareStorageRequest } from "../../src/core/storeResponse.js";
import { storageTransport } from "../../src/core/storageTransport.js";
import {
  nativeRetirementTargetSchema,
  nativeRetirementPermitSchema,
  nativeRetirementTargetKey,
  type NativeRetirementPermit,
} from "../../src/execution/nativeRetirement.js";
import { isWorkspaceOwner, workspaceOwnerKey } from "../../src/core/workspaceSettlement.js";
import { selectedResidentMember } from "../../src/execution/residentMembers";
import ts from "typescript";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { readSource } from "./testing/sourceScan.js";
import { sanitizeResidentBody } from "../../src/execution/residentText.js";
import { validNativeOperationKey } from "./nativeOperation.js";
import { describe, expect, it } from "vitest";
import { NativeOperationJournal, type NativeOperationStorage, type NativeOperationRows } from "./nativeOperation.js";
import {
  NativeRunScopes,
  NativeScopeControlTimeoutError,
  type NativeScopeTransport,
  type NativeTimeoutEnding,
} from "./nativeScope.js";
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
    list: async <T>({ prefix, limit, startAfter = "" }: { prefix: string; limit: number; startAfter?: string }) =>
      new Map(
        [...data]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      ) as Map<string, T>,
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

describe("retained native timeout ending", () => {
  async function pending() {
    const h = fixture();
    const owner = { runId: "run-timeout", ownerGen: "gen-timeout", ownerFence: 7 };
    const threadKey = "slack:C1:timeout-proof";
    const key = `native-operation:${threadKey}:${owner.runId}:original`;
    const ref = {
      version: 1 as const,
      id: "22222222-2222-4222-8222-222222222222",
      boot: "11111111-1111-4111-8111-111111111111",
      threadKey,
      owner,
    };
    await h.journal.open(key, owner, threadKey);
    await h.journal.bindScope(key, ref);
    const attempt = await h.journal.begin(key, "process");
    const ending: NativeTimeoutEnding = {
      version: 1,
      ref,
      attempt,
      closed: false,
      populated: false,
      launcherExitCode: 137,
    };
    h.rows.set("private-bytes", "uncommitted work");
    h.rows.set("native-operation:op:neighbor", {
      opOwner: "op:neighbor",
      native: { version: 1, closed: false, pending: { other: { kind: "opaque" } } },
    });
    return {
      ...h,
      key,
      owner,
      threadKey,
      ending,
      attempt,
      receiptKey: `native-operation-receipt:${key}`,
      original: structuredClone(h.rows.get(key)),
    };
  }

  it.each(["write", "before-commit"])("keeps the original admission after receipt %s failure", async (fault) => {
    const h = await pending();
    const before = structuredClone([...h.rows]);
    const transaction = h.storage.transaction.bind(h.storage);
    h.storage.transaction = (action) =>
      transaction(async (rows) => {
        let wrote = false;
        const result = await action({
          ...rows,
          put: async (key, value) => {
            if (key === h.receiptKey) {
              if (fault === "write") throw new Error("receipt write failed");
              wrote = true;
            }
            await rows.put(key, value);
          },
        });
        if (wrote) throw new Error("receipt commit failed");
        return result;
      });
    await expect(h.journal.settle(h.key, h.attempt, h.ending)).rejects.toThrow();
    expect([...h.rows]).toEqual(before);
    expect(await h.journal.readEnding(h.key)).toEqual({ kind: "missing" });
  });

  it.each(["readable", "unreadable"])(
    "uses only original %s readback after a lost receipt commit acknowledgment",
    async (fault) => {
      const h = await pending();
      const transaction = h.storage.transaction.bind(h.storage);
      const get = h.storage.get.bind(h.storage);
      let lost = false;
      h.storage.transaction = async (action) => {
        const result = await transaction(action);
        if (!lost && h.rows.has(h.receiptKey)) {
          lost = true;
          throw new Error("receipt commit acknowledgment lost");
        }
        return result;
      };
      h.storage.get = async (key) => {
        if (lost && fault === "unreadable") throw new Error("readback unavailable");
        return get(key);
      };
      const settling = h.journal.settle(h.key, h.attempt, h.ending);
      if (fault === "readable") await settling;
      else await expect(settling).rejects.toThrow("acknowledgment lost");
      expect(h.rows.get(h.key)).toMatchObject({ native: { closed: false, pending: {} } });
      expect(h.rows.get(h.receiptKey)).toMatchObject({
        original: h.original,
        receipt: { outcome: "native-ended", originalOperationOutcome: "unknown", nativeEnding: h.ending },
      });
      expect(h.rows.get("private-bytes")).toBe("uncommitted work");
      expect(h.rows.get("native-operation:op:neighbor")).toMatchObject({
        native: { pending: { other: { kind: "opaque" } } },
      });
    },
  );

  it.each(["boot", "attempt", "owner", "launcher"])(
    "refuses changed %s proof before removing admission",
    async (fault) => {
      const h = await pending();
      const proof = structuredClone(h.ending);
      if (fault === "boot") proof.ref.boot = "33333333-3333-4333-8333-333333333333";
      if (fault === "attempt") proof.attempt = "33333333-3333-4333-8333-333333333333";
      if (fault === "owner") proof.ref.owner.ownerFence++;
      if (fault === "launcher") proof.launcherExitCode = 125;
      const before = structuredClone([...h.rows]);
      await expect(h.journal.settle(h.key, h.attempt, proof)).rejects.toThrow();
      expect([...h.rows]).toEqual(before);
    },
  );

  it("does not replace original timeout evidence with empty-journal recovery", async () => {
    const h = await pending();
    await h.journal.settle(h.key, h.attempt, h.ending);
    const before = structuredClone([...h.rows]);
    const currentHash = createHash("sha256")
      .update(JSON.stringify(h.rows.get(h.key)))
      .digest("hex");
    let nativeReads = 0;
    expect(
      await h.journal.recover(
        h.key,
        currentHash,
        async () => {
          nativeReads++;
          return terminal;
        },
        matches,
      ),
    ).toEqual({ error: "native-operation-recovery-refused: native-ending-receipt-exists", status: 409 });
    expect(nativeReads).toBe(0);
    expect([...h.rows]).toEqual(before);
    await h.journal.close(h.key);
    expect(await h.journal.readEnding(h.key)).toMatchObject({
      kind: "ended",
      receipt: { nativeEnding: h.ending, originalOperationOutcome: "unknown" },
    });
  });

  it("keeps partial admissions and a second timeout held without overwriting the original receipt", async () => {
    const partial = await pending();
    const other = await partial.journal.begin(partial.key, "opaque");
    await expect(partial.journal.settle(partial.key, partial.attempt, partial.ending)).rejects.toThrow(
      "admission changed",
    );
    expect((await partial.journal.list()).operations.find((op) => op.key === partial.key)?.journal?.pending).toEqual({
      [partial.attempt]: { kind: "process" },
      [other]: { kind: "opaque" },
    });
    const h = await pending();
    await h.journal.settle(h.key, h.attempt, h.ending);
    const originalReceipt = structuredClone(h.rows.get(h.receiptKey));
    const second = await h.journal.begin(h.key, "process");
    await expect(h.journal.settle(h.key, second, { ...h.ending, attempt: second })).rejects.toThrow(
      "receipt already exists",
    );
    expect(h.rows.get(h.key)).toMatchObject({ native: { pending: { [second]: { kind: "process" } } } });
    expect(h.rows.get(h.receiptKey)).toEqual(originalReceipt);
  });

  it("preserves an exact receipt across close-before-settle, late callbacks and reopen", async () => {
    const h = await pending();
    await h.journal.close(h.key);
    await h.journal.settle(h.key, h.attempt, h.ending);
    expect(h.rows.has(h.key)).toBe(false);
    const before = structuredClone([...h.rows]);
    await h.journal.settle(h.key, h.attempt, h.ending);
    await expect(h.journal.open(h.key, h.owner, h.threadKey)).rejects.toThrow("identity already used");
    expect([...h.rows]).toEqual(before);
    expect(await h.journal.readEnding(h.key)).toMatchObject({
      kind: "ended",
      receipt: { outcome: "native-ended", nativeEnding: h.ending },
    });
  });

  it("reports whole-operation ending only after subsequent salvage settles and the journal closes", async () => {
    const h = await pending();
    await h.journal.settle(h.key, h.attempt, h.ending);
    expect(await h.journal.readEnding(h.key)).toEqual({ kind: "unavailable" });
    const salvage = await h.journal.begin(h.key, "opaque");
    await h.journal.close(h.key);
    expect(await h.journal.readEnding(h.key)).toEqual({ kind: "unavailable" });
    await h.journal.settle(h.key, salvage);
    expect(await h.journal.readEnding(h.key)).toMatchObject({
      kind: "ended",
      receipt: { originalOperationOutcome: "unknown" },
    });
    expect(h.rows.get("private-bytes")).toBe("uncommitted work");
  });

  it.each(["hash", "boot", "attempt", "key"])("rejects a saved receipt with changed %s", async (fault) => {
    const h = await pending();
    await h.journal.settle(h.key, h.attempt, h.ending);
    await h.journal.close(h.key);
    expect(await h.journal.readEnding(h.key)).toMatchObject({ kind: "ended" });
    const archive = structuredClone(h.rows.get(h.receiptKey)) as any;
    if (fault === "hash") archive.receipt.recordHash = "f".repeat(64);
    if (fault === "boot") archive.receipt.nativeEnding.ref.boot = "33333333-3333-4333-8333-333333333333";
    if (fault === "attempt") archive.receipt.nativeEnding.attempt = "33333333-3333-4333-8333-333333333333";
    if (fault === "key") archive.receipt.key += "-foreign";
    h.rows.set(h.receiptKey, archive);
    expect(await h.journal.readEnding(h.key)).toEqual({ kind: "unavailable" });
  });

  it("refuses oversized receipt authority before changing the original admission", async () => {
    const h = await pending();
    const oversized = structuredClone(h.rows.get(h.key)) as any;
    oversized.native.scope.owner.retainedMetadata = "x".repeat(70_000);
    h.rows.set(h.key, oversized);
    const before = structuredClone([...h.rows]);
    await expect(h.journal.settle(h.key, h.attempt, h.ending)).rejects.toThrow("too large");
    expect([...h.rows]).toEqual(before);
  });

  it("validates a cached timeout receipt before reporting recovery completed", async () => {
    const h = await pending();
    await h.journal.settle(h.key, h.attempt, h.ending);
    await h.journal.close(h.key);
    const archive = structuredClone(h.rows.get(h.receiptKey)) as any;
    expect(await h.journal.recover(h.key, archive.receipt.recordHash, async () => terminal, matches)).toEqual(
      archive.receipt,
    );
    archive.receipt.nativeEnding.ref.boot = "33333333-3333-4333-8333-333333333333";
    h.rows.set(h.receiptKey, archive);
    let reads = 0;
    expect(
      await h.journal.recover(
        h.key,
        archive.receipt.recordHash,
        async () => {
          reads++;
          return terminal;
        },
        matches,
      ),
    ).toEqual({ error: "native-operation-recovery-refused: record-missing-or-changed", status: 409 });
    expect(reads).toBe(0);
    expect(h.rows.get(h.receiptKey)).toEqual(archive);
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
  async function ownedOperator(kind: "process" | "opaque" = "process", close = true) {
    const h = fixture();
    const owner = { opOwner: "op:original" };
    await h.journal.open(key, owner, undefined, {
      producer: "deps-backup",
      resource: "repo:acme/api",
      callId: "11111111-1111-4111-8111-111111111111",
      sourceId: "cache-a",
      actor: "system",
      traceId: null,
      parentSourceId: null,
      build: "a".repeat(40),
      workerVersion: null,
      startedAt: 1000,
    });
    const calls: string[] = [];
    const native = {
      request: async (value) => ({
        stdout:
          (calls.push(String(value.mode)),
          JSON.stringify(
            value.mode === "inspect"
              ? {
                  version: 1,
                  boot: "22222222-2222-4222-8222-222222222222",
                  ...(value.operator === true ? { operatorScopes: 1 } : {}),
                }
              : {
                  ref: value.ref,
                  closed: value.mode === "close",
                  ...(value.mode === "bootstrap" ? {} : { populated: false }),
                },
          )),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    };
    const scopes = new NativeRunScopes(h.storage, native);
    const ref = await scopes.ensureOperator(owner, async () => {});
    await h.journal.bindScope(key, ref);
    const attempt = await h.journal.begin(key, kind);
    if (close) await scopes.closeOperator(owner, ref);
    return { ...h, owner, ref, attempt, native, calls };
  }

  function archiveIdentity(h: Awaited<ReturnType<typeof ownedOperator>>) {
    return {
      version: 1 as const,
      ref: h.ref,
      attempt: h.attempt,
      backupId: "44444444-4444-4444-8444-444444444444",
      target: "/workspace/mirror",
      sizeBytes: 3,
      etag: "a".repeat(32),
    };
  }

  async function admittedOperator() {
    const h = fixture();
    const owner = { opOwner: "op:original" };
    const origin = {
      producer: "refresh-step" as const,
      resource: "repo:acme/api",
      sourceId: "build",
      callId: "11111111-1111-4111-8111-111111111111",
      actor: "system" as const,
      traceId: null,
      parentSourceId: "refresh-original",
      build: "a".repeat(40),
      workerVersion: null,
      startedAt: 1000,
    };
    const permit = { id: "22222222-2222-4222-8222-222222222222", requestHash: "a".repeat(64) };
    await h.journal.enrollOperatorAdmission(owner.opOwner, origin, permit);
    await h.journal.open(key, owner, undefined, origin);
    return { ...h, owner, origin, permit };
  }

  it("enrolls the original permit before effects and refuses historical linkage", async () => {
    const h = await admittedOperator();
    expect(await h.journal.endOperatorCallback(h.owner.opOwner, h.origin.callId, h.permit)).toBe(false);
    await h.journal.close(key);
    expect(await h.journal.endOperatorCallback(h.owner.opOwner, "33333333-3333-4333-8333-333333333333", h.permit)).toBe(
      false,
    );
    expect(
      await h.journal.endOperatorCallback(h.owner.opOwner, h.origin.callId, {
        ...h.permit,
        requestHash: "b".repeat(64),
      }),
    ).toBe(false);
    expect(await h.journal.endOperatorCallback(h.owner.opOwner, h.origin.callId, h.permit)).toBe(true);
    await expect(h.journal.enrollOperatorAdmission(h.owner.opOwner, h.origin, h.permit)).rejects.toThrow(
      "operator admission identity already used",
    );
    h.rows.delete("native-operation-admission:" + h.owner.opOwner);
    await expect(h.journal.enrollOperatorAdmission(h.owner.opOwner, h.origin, h.permit)).rejects.toThrow(
      "operator admission identity already used",
    );
    expect(await h.journal.producerAdmissions(h.origin, () => true)).toEqual([]);
  });

  it.each(["callback-marker", "call", "permit", "origin", "native-ending", "new-native-record"])(
    "retains an enrolled permit with missing or changed %s proof",
    async (fault) => {
      const h = await admittedOperator();
      await h.journal.close(key);
      expect(await h.journal.endOperatorCallback(h.owner.opOwner, h.origin.callId, h.permit)).toBe(true);
      await new NativeRunScopes(h.storage, {
        request: async () => {
          throw new Error("unstarted scope must not launch");
        },
      }).closeOperator(h.owner);
      expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(true);
      const restarted = new NativeOperationJournal(h.storage);
      const [saved] = await restarted.producerAdmissions(h.origin, () => true);
      expect(saved).toMatchObject({ opOwner: "op:original", permit: h.permit, callbackMetadataEnded: true });
      expect(await restarted.operatorAdmissionReady(saved!)).toBe(true);
      if (fault === "callback-marker")
        h.rows.set("native-operation-admission:" + h.owner.opOwner, { ...saved, callbackMetadataEnded: false });
      if (fault === "call")
        h.rows.set("native-operation-admission:" + h.owner.opOwner, {
          ...saved,
          origin: { ...saved!.origin, callId: "33333333-3333-4333-8333-333333333333" },
        });
      if (fault === "permit")
        h.rows.set("native-operation-admission:" + h.owner.opOwner, {
          ...saved,
          permit: { ...h.permit, requestHash: "b".repeat(64) },
        });
      if (fault === "origin")
        h.rows.set("native-operation-admission:" + h.owner.opOwner, {
          ...saved,
          origin: { ...saved!.origin, sourceId: "different-step" },
        });
      if (fault === "native-ending") h.rows.delete("native-operation-ending:" + key);
      if (fault === "new-native-record") h.rows.set(key, { unknown: true });
      expect(await restarted.operatorAdmissionReady(saved!)).toBe(false);
      await expect(restarted.completeOperatorAdmission(saved!)).rejects.toThrow("operator admission ending changed");
      expect(await restarted.producerAdmissions(h.origin, () => true)).toHaveLength(1);
    },
  );

  it("resumes only original producer finalization after a controller restart", async () => {
    const h = await ownedOperator("process", false);
    await h.journal.settle(key, h.attempt);
    await h.journal.close(key);
    const scopes = new NativeRunScopes(h.storage, h.native);
    await scopes.closeOperator(h.owner, h.ref);
    const origin = (h.rows.get(key) as any).origin;
    const restarted = new NativeOperationJournal(h.storage);
    expect(await restarted.resumeProducerFinalization(origin, h.native, matches)).toEqual({
      key,
      opOwner: "op:original",
      outcome: "ended",
    });
    expect(await restarted.operatorEnded(key, h.owner)).toBe(true);
    expect(h.rows.get(`native-operation-ending:${key}`)).toMatchObject({
      receipt: { callback: "unknown", originalOperationOutcome: "unknown" },
    });
    expect(await restarted.resumeProducerFinalization(origin, h.native, matches)).toBeUndefined();
    expect(h.calls.filter((mode) => mode === "bootstrap")).toEqual(["bootstrap"]);
  });

  it("retires saved unstarted producer cleanup without waking native execution", async () => {
    const h = fixture();
    const owner = { opOwner: "op:original" };
    const origin = {
      producer: "refresh-step" as const,
      resource: "repo:acme/api",
      sourceId: "complete",
      callId: "11111111-1111-4111-8111-111111111111",
      actor: "system" as const,
      traceId: null,
      parentSourceId: "refresh-original",
      build: "a".repeat(40),
      workerVersion: null,
      startedAt: 1000,
    };
    await h.journal.open(key, owner, undefined, origin);
    await h.journal.close(key);
    const native: NativeScopeTransport = {
      request: async () => {
        throw new Error("native must stay asleep");
      },
    };
    expect(await new NativeRunScopes(h.storage, native).closeOperator(owner)).toBe("unstarted");
    expect(await h.journal.resumeProducerFinalization({ ...origin, sourceId: "fetch" }, native, matches)).toEqual({
      key,
      opOwner: "op:original",
      outcome: "ended",
    });
    expect(await h.journal.operatorEnded(key, owner)).toBe(true);
    expect(h.rows.get(`native-operation-ending:${key}`)).toMatchObject({
      receipt: { scope: null, callback: "unknown" },
    });
  });

  it.each([
    "active",
    "journal-open",
    "pending",
    "not-closing",
    "foreign-scope",
    "foreign-boot",
    "foreign-owner",
    "foreign-claim",
  ])("holds producer finalization when %s evidence is present", async (fault) => {
    const h = await ownedOperator("process", false);
    if (fault !== "pending") await h.journal.settle(key, h.attempt);
    if (fault !== "journal-open") await h.journal.close(key);
    const scopeKey = [...h.rows.keys()].find((name) => name.startsWith("native-operator-scope:"))!;
    if (fault !== "not-closing") {
      const scope = h.rows.get(scopeKey) as any;
      h.rows.set(scopeKey, { ...scope, closing: true });
    }
    if (fault === "foreign-scope") {
      const record = h.rows.get(key) as any;
      record.native.scope.id = "33333333-3333-4333-8333-333333333333";
    }
    if (fault === "foreign-boot" || fault === "foreign-owner") {
      const scope = h.rows.get(scopeKey) as any;
      if (fault === "foreign-boot") scope.boot = "33333333-3333-4333-8333-333333333333";
      else scope.owner = { opOwner: "op:foreign" };
    }
    if (fault === "foreign-claim") {
      const claimKey = [...h.rows.keys()].find((name) => name.startsWith("native-operation-producer:"))!;
      h.rows.set(claimKey, { key, opOwner: "op:original", callId: crypto.randomUUID() });
    }
    const before = structuredClone([...h.rows]);
    const calls = h.calls.length;
    expect(
      await h.journal.resumeProducerFinalization(
        (h.rows.get(key) as any).origin,
        h.native,
        async () => fault !== "active",
      ),
    ).toMatchObject({ outcome: "held" });
    expect([...h.rows]).toEqual(before);
    expect(h.calls.length).toBe(calls);
    expect(h.rows.get(key)).toMatchObject({ opOwner: "op:original" });
  });

  it.each(["inspect", "readback", "retirement"])(
    "resumes original producer finalization after unavailable %s evidence",
    async (fault) => {
      const h = await ownedOperator("process", false);
      await h.journal.settle(key, h.attempt);
      await h.journal.close(key);
      const scopeKey = [...h.rows.keys()].find((name) => name.startsWith("native-operator-scope:"))!;
      h.rows.set(scopeKey, { ...(h.rows.get(scopeKey) as object), closing: true });
      const origin = (h.rows.get(key) as any).origin;
      let unavailable = true;
      let closed = false;
      const requests: Record<string, unknown>[] = [];
      const native: NativeScopeTransport = {
        request: async (request, timeout) => {
          requests.push(request);
          if (request.mode === "close") closed = true;
          if (
            unavailable &&
            ((fault === "inspect" && ["inspect", "view"].includes(String(request.mode))) ||
              (fault === "readback" && ["close", "view"].includes(String(request.mode))))
          )
            throw new NativeScopeControlTimeoutError(String(request.mode), timeout);
          return request.mode === "inspect"
            ? h.native.request(request, timeout)
            : {
                stdout: JSON.stringify({ ref: request.ref, closed, populated: false }),
                stderr: "",
                exitCode: 0,
                timedOut: false,
              };
        },
      };
      const storage: NativeOperationStorage = {
        ...h.storage,
        transaction: (action) =>
          h.storage.transaction((rows) =>
            action({
              ...rows,
              put: async (name, value) => {
                if (fault === "retirement" && unavailable && name.startsWith("native-operation-ending:"))
                  throw new Error("retirement storage unavailable");
                await rows.put(name, value);
              },
            }),
          ),
      };
      const interrupted = new NativeOperationJournal(storage).resumeProducerFinalization(origin, native, matches);
      if (fault === "retirement") expect(await interrupted).toMatchObject({ outcome: "held" });
      else await expect(interrupted).rejects.toThrow("native-scope outcome is unknown");
      expect(h.rows.get(key)).toMatchObject({ opOwner: "op:original", native: { closed: true, pending: {} } });
      unavailable = false;
      const restarted = new NativeOperationJournal(storage);
      expect(await restarted.resumeProducerFinalization(origin, native, matches)).toMatchObject({ outcome: "ended" });
      expect(await restarted.operatorEnded(key, h.owner)).toBe(true);
      expect(
        requests
          .filter((request) => request.mode !== "inspect")
          .every((request) => JSON.stringify(request.ref) === JSON.stringify(h.ref)),
      ).toBe(true);
      expect([...h.rows.keys()].filter((name) => name.startsWith("native-operation-ending:"))).toEqual([
        `native-operation-ending:${key}`,
      ]);
    },
  );

  it("retires one original producer once under concurrent finalization", async () => {
    const h = await ownedOperator("process");
    await h.journal.settle(key, h.attempt);
    await h.journal.close(key);
    const origin = (h.rows.get(key) as any).origin;
    const outcomes = await Promise.all(
      Array.from({ length: 2 }, () =>
        new NativeOperationJournal(h.storage).resumeProducerFinalization(origin, h.native, matches),
      ),
    );
    expect(outcomes.some((result) => result?.outcome === "ended")).toBe(true);
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(true);
    expect([...h.rows.keys()].filter((name) => name.startsWith("native-operation-ending:"))).toEqual([
      `native-operation-ending:${key}`,
    ]);
    expect(h.rows.get(`native-operation-ending:${key}`)).toMatchObject({
      original: { opOwner: "op:original" },
      receipt: { originalOperationOutcome: "unknown" },
    });
  });

  it("reserves a restore descriptor before effects and blocks overlapping cleanup after restart", async () => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    expect(h.rows.get(key)).toMatchObject({
      native: { pending: { [h.attempt]: { kind: "opaque", restore: identity } } },
    });
    const cleanup = "native-operation:op:cleanup";
    await h.journal.open(cleanup, { opOwner: "op:cleanup" }, undefined, {
      ...(h.rows.get(key) as any).origin,
      producer: "resident-call",
      sourceId: "cleanup",
      callId: "55555555-5555-4555-8555-555555555555",
    });
    const scopes = new NativeRunScopes(h.storage, h.native);
    await h.journal.bindScope(cleanup, await scopes.ensureOperator({ opOwner: "op:cleanup" }, async () => {}));
    const restarted = new NativeOperationJournal(h.storage);
    await expect(restarted.begin(cleanup, "process", ["/workspace"])).rejects.toThrow(
      "workspace path has an unresolved restore",
    );
    expect(await restarted.begin(cleanup, "process", ["/workspace/mirror-neighbor"])).toEqual(expect.any(String));
    expect(h.rows.get(key)).toMatchObject({ native: { pending: { [h.attempt]: { restore: identity } } } });
  });

  it("refuses restore admission while a matching mutation remains unresolved", async () => {
    const h = await ownedOperator("process", false);
    await h.journal.settle(key, h.attempt);
    const mutation = await h.journal.begin(key, "process", ["/workspace/deps"]);
    const restore = await h.journal.begin(key, "opaque");
    const identity = {
      ...archiveIdentity(h),
      attempt: restore,
      target: "/workspace/deps/.scratch-55555555-5555-4555-8555-555555555555",
    };
    await expect(h.journal.reserveArchive(key, restore, identity)).rejects.toThrow(
      "workspace path has an unresolved mutation",
    );
    expect(h.rows.get(key)).toMatchObject({
      native: {
        pending: { [mutation]: { kind: "process", mutationPaths: ["/workspace/deps"] }, [restore]: { kind: "opaque" } },
      },
    });
    await h.journal.settle(key, mutation);
    await h.journal.reserveArchive(key, restore, identity);
    expect(h.rows.get(key)).toMatchObject({ native: { pending: { [restore]: { restore: identity } } } });
  });

  it("protects a completed restore target until its original operator ends", async () => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    await h.journal.finishArchive(key, h.attempt, { identity, outcome: "committed", cleanup: "complete" });
    const other = "native-operation:op:cleanup";
    await h.journal.open(other, { opOwner: "op:cleanup" }, undefined, {
      ...(h.rows.get(key) as any).origin,
      producer: "resident-call",
      sourceId: "cleanup",
      callId: "55555555-5555-4555-8555-555555555555",
    });
    const scopes = new NativeRunScopes(h.storage, h.native);
    await h.journal.bindScope(other, await scopes.ensureOperator({ opOwner: "op:cleanup" }, async () => {}));
    await expect(h.journal.begin(other, "process", ["/workspace/mirror"])).rejects.toThrow(
      "workspace path has an unresolved restore",
    );
    const continuation = await h.journal.begin(key, "process", ["/workspace/mirror"]);
    await h.journal.settle(key, continuation);
    await scopes.closeOperator(h.owner, h.ref);
    expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(true);
    expect(await h.journal.begin(other, "process", ["/workspace/mirror"])).toEqual(expect.any(String));
  });

  it("keeps unattributed opaque work as a veto on destructive workspace mutation", async () => {
    const h = await ownedOperator("opaque", false);
    await expect(h.journal.begin(key, "process", ["/workspace/checkout"])).rejects.toThrow(
      "workspace outcome is unknown",
    );
    expect(h.rows.get(key)).toMatchObject({ native: { pending: { [h.attempt]: { kind: "opaque" } } } });
  });

  it("cannot settle a reserved restore through the generic native result path", async () => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    await expect(h.journal.settle(key, h.attempt)).rejects.toThrow("restore cleanup receipt is required");
    expect(h.rows.get(key)).toMatchObject({ native: { pending: { [h.attempt]: { restore: identity } } } });
  });

  it("retains the exact cleanup receipt before the original restore attempt settles", async () => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    const receipt = { identity, outcome: "committed" as const, cleanup: "complete" as const };
    await h.journal.finishArchive(key, h.attempt, receipt);
    expect(h.rows.get(key)).toMatchObject({
      native: {
        pending: {},
        restoreReceipts: { [h.attempt]: { receipt, hash: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      },
    });
    await new NativeRunScopes(h.storage, h.native).closeOperator(h.owner, h.ref);
    expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(true);
    expect(h.rows.get(`native-operation-ending:${key}`)).toMatchObject({
      original: { native: { restoreReceipts: { [h.attempt]: { receipt } } } },
    });
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(true);
  });

  it.each(["target", "etag", "owner", "attempt"] as const)("refuses a changed restore receipt %s", async (field) => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    const changed =
      field === "owner"
        ? { ...identity, ref: { ...h.ref, owner: { opOwner: "op:foreign" } } }
        : field === "target"
          ? { ...identity, target: "/workspace/checkout" }
          : field === "etag"
            ? { ...identity, etag: "b".repeat(32) }
            : { ...identity, attempt: "55555555-5555-4555-8555-555555555555" };
    await expect(
      h.journal.finishArchive(key, h.attempt, { identity: changed, outcome: "committed", cleanup: "complete" }),
    ).rejects.toThrow("original restore receipt changed");
    expect(h.rows.get(key)).toMatchObject({ native: { pending: { [h.attempt]: { restore: identity } } } });
  });

  it("qualifies the full retained receipt after a lost settlement acknowledgement", async () => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    const lost = new NativeOperationJournal({
      ...h.storage,
      transaction: async (action) => {
        await h.storage.transaction(action);
        throw new Error("transaction acknowledgement lost");
      },
    });
    await lost.finishArchive(key, h.attempt, { identity, outcome: "committed", cleanup: "complete" });
    expect(h.rows.get(key)).toMatchObject({
      native: { pending: {}, restoreReceipts: { [h.attempt]: { receipt: { identity, outcome: "committed" } } } },
    });
  });

  it("rejects changed retained receipt bytes before operator ending", async () => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    await h.journal.finishArchive(key, h.attempt, { identity, outcome: "committed", cleanup: "complete" });
    const saved = h.rows.get(key) as any;
    saved.native.restoreReceipts[h.attempt].receipt.identity.etag = "b".repeat(32);
    await h.storage.put(key, saved);
    await new NativeRunScopes(h.storage, h.native).closeOperator(h.owner, h.ref);
    expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(false);
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(false);
  });

  it.each([false, true])(
    "recovers only the original archive receipt after scope closure: cleanup=%s",
    async (cleanup) => {
      const h = await ownedOperator("opaque", false);
      const identity = archiveIdentity(h);
      await h.journal.reserveArchive(key, h.attempt, identity);
      const hash = (await h.journal.list()).operations[0]!.recordHash;
      const modes: unknown[] = [];
      let receipt = cleanup ? undefined : { identity, outcome: "committed", cleanup: "complete" };
      const native = {
        request: async (value: Record<string, any>, timeout: number) => {
          modes.push(value.mode);
          if (!String(value.mode).startsWith("archive-")) return h.native.request(value, timeout);
          expect(value.identity).toEqual(identity);
          if (value.mode === "archive-clean")
            receipt = { identity, outcome: "aborted", cleanup: "complete", reason: "cancelled" } as any;
          return {
            stdout: JSON.stringify({
              identity,
              phase: receipt ? "done" : "receiving",
              receivedBytes: 0,
              ...(receipt ? { receipt } : {}),
            }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        },
      };
      const result = await h.journal.recoverOperator(key, hash, native, matches, true);
      expect(result).toMatchObject({
        outcome: "operator-scope-ended",
        recordHash: hash,
        originalOperationOutcome: "unknown",
      });
      expect(modes.filter((mode) => String(mode).startsWith("archive-"))).toEqual(
        cleanup ? ["archive-read", "archive-clean"] : ["archive-read"],
      );
      expect(await h.journal.operatorEnded(key, h.owner)).toBe(true);
      const calls = modes.length;
      expect(await h.journal.recoverOperator(key, hash, native, matches, true)).toEqual(result);
      expect(modes).toHaveLength(calls);
      expect(h.rows.get(`native-operation-ending:${key}`)).toMatchObject({
        original: { native: { pending: {}, restoreReceipts: { [h.attempt]: { receipt } } } },
        receipt: { requestRecordHash: hash },
      });
    },
  );

  it("requires explicit cleanup authority when an ended archive has no receipt", async () => {
    const h = await ownedOperator("opaque", false);
    const identity = archiveIdentity(h);
    await h.journal.reserveArchive(key, h.attempt, identity);
    await new NativeRunScopes(h.storage, h.native).closeOperator(h.owner, h.ref);
    const hash = (await h.journal.list()).operations[0]!.recordHash;
    const calls: unknown[] = [];
    const native = {
      request: async (value: Record<string, any>) => {
        calls.push(value.mode);
        return {
          stdout: JSON.stringify({ identity, phase: "receiving", receivedBytes: 0 }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    };
    expect(await h.journal.recoverOperator(key, hash, native, matches, false)).toMatchObject({
      error: "native-operation-recovery-refused: explicit-original-archive-cleanup-required",
    });
    expect(calls).toEqual(["archive-read"]);
    expect(h.rows.has(key)).toBe(true);
  });

  it("reserves cumulative receipt capacity before another restore can start", async () => {
    const h = await ownedOperator("opaque", false);
    let admitted = 0;
    let id = h.attempt;
    for (let count = 0; count < 200; count++) {
      const identity = { ...archiveIdentity(h), attempt: id };
      try {
        await h.journal.reserveArchive(key, id, identity);
      } catch (error) {
        expect(String(error)).toContain("evidence capacity");
        break;
      }
      admitted++;
      await h.journal.finishArchive(key, id, { identity, outcome: "committed", cleanup: "complete" });
      try {
        id = await h.journal.begin(key, "opaque");
      } catch (error) {
        expect(String(error)).toContain("evidence capacity");
        break;
      }
    }
    expect(admitted).toBeGreaterThan(1);
    expect(admitted).toBeLessThan(200);
    const saved = h.rows.get(key) as any;
    expect(Object.keys(saved.native.restoreReceipts)).toHaveLength(admitted);
    expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThan(65536);
  });

  it("reconciles a crashed operator only through its original owned scope and ending receipt", async () => {
    const h = await ownedOperator("process", false);
    const hash = (await h.journal.list()).operations[0]!.recordHash;
    expect(await h.journal.recoverOperator(key, hash, h.native, matches, false)).toMatchObject({
      error: "native-operation-recovery-refused: explicit-operator-scope-closure-required",
    });
    expect(await h.journal.recoverOperator(key, hash, h.native, matches, true)).toEqual({
      key,
      recordHash: hash,
      outcome: "operator-scope-ended",
      originalOperationOutcome: "unknown",
      requestEnd: "unobserved",
    });
    expect(await h.journal.recoverOperator(key, hash, h.native, matches, true)).toEqual({
      key,
      recordHash: hash,
      outcome: "operator-scope-ended",
      originalOperationOutcome: "unknown",
      requestEnd: "unobserved",
    });
    expect(h.calls.filter((mode) => mode === "close")).toEqual(["close"]);
  });

  it("settles an operator timeout only for the original scope owner and attempt", async () => {
    const h = await ownedOperator("process", false);
    const ending = {
      version: 1 as const,
      ref: h.ref,
      attempt: h.attempt,
      closed: false as const,
      populated: false as const,
      launcherExitCode: 137 as const,
    };
    const before = structuredClone(h.rows);
    await expect(
      h.journal.settle(key, h.attempt, { ...ending, ref: { ...h.ref, owner: { opOwner: "op:foreign" } } }),
    ).rejects.toThrow("native timeout admission changed");
    expect(h.rows).toEqual(before);
    await h.journal.settle(key, h.attempt, ending);
    expect(h.rows.get(`native-operation-receipt:${key}`)).toMatchObject({
      receipt: { purpose: "native-timeout-ending", nativeEnding: ending, originalOperationOutcome: "unknown" },
    });
    await h.journal.close(key);
    await new NativeRunScopes(h.storage, h.native).closeOperator(h.owner, h.ref);
    expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(true);
  });

  it("does not adopt an old identityless operator record into the new scope protocol", async () => {
    const h = fixture();
    await h.journal.open(key, { opOwner: "op:original" });
    await h.journal.begin(key, "process");
    const before = structuredClone(h.rows);
    const hash = (await h.journal.list()).operations[0]!.recordHash;
    expect(
      await h.journal.recoverOperator(
        key,
        hash,
        {
          request: async () => {
            throw new Error("must not control native state");
          },
        },
        matches,
        true,
      ),
    ).toBeUndefined();
    expect(h.rows).toEqual(before);
    expect((await h.journal.list()).operations).toMatchObject([
      { recoverable: false, recoveryReason: "original-native-evidence-unavailable" },
    ]);
  });

  it("refuses changed or active operator custody before native control", async () => {
    const h = await ownedOperator("process", false);
    const hash = (await h.journal.list()).operations[0]!.recordHash;
    expect(await h.journal.recoverOperator(key, "a".repeat(64), h.native, matches, true)).toMatchObject({
      error: "native-operation-recovery-refused: record-or-owner-changed",
    });
    expect(await h.journal.recoverOperator(key, hash, h.native, async () => false, true)).toMatchObject({
      error: "native-operation-recovery-refused: record-or-owner-changed",
    });
    expect(h.calls).toEqual(["inspect", "bootstrap"]);
    expect((await h.journal.unresolved()).size).toBe(1);
  });

  it("archives only the exact closed operator scope and keeps its lost payload result unknown", async () => {
    const h = await ownedOperator();
    const original = structuredClone(h.rows.get(key));
    expect(await h.journal.endOperator(key, h.owner, "threw")).toBe(true);
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(true);
    expect(h.rows.get(`native-operation-ending:${key}`)).toMatchObject({
      original,
      receipt: {
        purpose: "operator-scope-ending",
        owner: { opOwner: "op:original" },
        scope: h.ref,
        callback: "threw",
        originalOperationOutcome: "unknown",
      },
    });
    expect(await h.journal.unresolved()).toEqual(new Map());
    await expect(h.journal.open(key, h.owner)).rejects.toThrow("native operation identity already used");
  });

  it("keeps opaque effects held after their operator process scope has ended", async () => {
    const h = await ownedOperator("opaque");
    expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(false);
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(false);
    expect((await h.journal.list()).operations).toMatchObject([
      { owner: { opOwner: "op:original" }, journal: { closed: true, pending: { [h.attempt]: { kind: "opaque" } } } },
    ]);
    await h.journal.settle(key, h.attempt);
    expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(true);
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(true);
  });

  it.each([true, false])(
    "qualifies a lost operator ending acknowledgement only from readable exact evidence: %s",
    async (readable) => {
      const h = await ownedOperator();
      const transaction = h.storage.transaction.bind(h.storage);
      h.storage.transaction = async (action) => {
        await transaction(action);
        throw new Error("lost-ending-ack");
      };
      const get = h.storage.get.bind(h.storage);
      if (!readable)
        h.storage.get = async (at) => {
          if (at.startsWith("native-operation-ending:")) throw new Error("unavailable");
          return get(at);
        };
      expect(await h.journal.endOperator(key, h.owner, "threw")).toBe(readable);
      expect(h.rows.get(`native-operation-ending:${key}`)).toMatchObject({
        receipt: { callback: "threw", originalOperationOutcome: "unknown" },
      });
    },
  );

  it("keeps the original operator hold when its ending receipt cannot commit", async () => {
    const h = await ownedOperator();
    const original = structuredClone(h.rows.get(key));
    h.storage.transaction = async () => {
      throw new Error("not committed");
    };
    expect(await h.journal.endOperator(key, h.owner, "threw")).toBe(false);
    expect(h.rows.get(key)).toEqual(original);
  });

  it.each(["owner", "scope", "recordHash"])("rejects changed operator ending evidence: %s", async (field) => {
    const h = await ownedOperator();
    expect(await h.journal.endOperator(key, h.owner, "threw")).toBe(true);
    const archive = h.rows.get(`native-operation-ending:${key}`) as { receipt: Record<string, unknown> };
    archive.receipt[field] =
      field === "owner"
        ? { opOwner: "op:foreign" }
        : field === "scope"
          ? { ...h.ref, boot: "33333333-3333-4333-8333-333333333333" }
          : "a".repeat(64);
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(false);
  });

  it("retains the original background producer before any effect starts", async () => {
    const h = fixture();
    const origin = {
      producer: "deps-backup",
      resource: "repo:acme/api",
      callId: "11111111-1111-4111-8111-111111111111",
      sourceId: "cache-a",
      actor: "system",
      traceId: null,
      parentSourceId: null,
      build: "a".repeat(40),
      workerVersion: null,
      startedAt: 1000,
    };
    await h.journal.open(key, { opOwner: "op:original" }, undefined, origin);
    expect(h.rows.get(key)).toMatchObject({ opOwner: "op:original", origin, native: { closed: false, pending: {} } });
  });

  it("does not repeat a background source whose closed scope still has an unknown payload result", async () => {
    const h = await ownedOperator();
    const origin = (h.rows.get(key) as any).origin;
    expect(await h.journal.endOperator(key, h.owner, "threw")).toBe(true);
    expect(
      await h.journal.open("native-operation:op:next", { opOwner: "op:next" }, undefined, {
        ...origin,
        callId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBe("producer-held");
    expect(await h.journal.operatorEnded(key, h.owner)).toBe(true);
  });

  it("allows a fresh background call after every original payload has a known result", async () => {
    const h = await ownedOperator();
    const origin = (h.rows.get(key) as any).origin;
    await h.journal.settle(key, h.attempt);
    expect(await h.journal.endOperator(key, h.owner, "returned")).toBe(true);
    expect(
      await h.journal.open("native-operation:op:next", { opOwner: "op:next" }, undefined, {
        ...origin,
        callId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBe("admitted");
  });

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

function httpFixture(
  h: ReturnType<typeof fixture>,
  running = false,
  reportError?: Error,
  failStub = false,
  retirement?: {
    native: NativeScopeTransport;
    permit?: NativeRetirementPermit;
  },
) {
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
    "handleRetireNativeOperation",
    "json",
  ].map(
    (name) =>
      source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(source) ??
      "",
  );
  const variables = [
    "ROUTES",
    "READ_DEBUG_OPS",
    "RESOURCE_RE",
    "REPO_ID_RE",
    "SUPPORTED_RESOURCE_TYPES",
    "THREAD_KEY_RE",
    "RESOURCE_KEY",
    "THREAD_KEY_PREFIX",
    "RUN_REG_KEY_PREFIX",
    "RUN_FENCE_KEY_PREFIX",
    "threadBindingKey",
    "runRegKey",
    "runFenceKey",
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
  const residentClass = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ResidentDO",
  )!;
  const retireMethod = residentClass.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "retireNativeOperation",
  );
  const receiverSource = `class UnderTest { ${retireMethod?.getText(source) ?? ""} }; const receiver = new UnderTest();`;
  const compiled = ts.transpileModule(
    [...functions, ...variables, receiverSource, `const worker = { ${fetch.getText(source)} };`].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  let nativeReads = 0;
  let nativeControls = 0;
  let terminated = false;
  const reports: unknown[] = [];
  const residentResources: string[] = [];
  const memoryRequests: unknown[] = [];
  let receiver: { retireNativeOperation(target: unknown): Promise<unknown> };
  const loaded = runInNewContext(compiled + "\n({worker,receiver})", {
    Request,
    Response,
    URL,
    TextEncoder,
    AbortSignal,
    NativeOperationJournal,
    KeyedAsyncLock,
    nativeRetirementTargetSchema,
    nativeRetirementPermitSchema,
    nativeRetirementTargetKey,
    isWorkspaceOwner,
    workspaceOwnerKey,
    RUN_STORE_KEY: "runs:default",
    RUN_STORE_TIMEOUT_MS: 10000,
    prepareStorageRequest,
    storageTransport,
    fetch: async (_input: unknown, init: RequestInit) => {
      memoryRequests.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify(
          retirement?.permit
            ? { kind: "prepared", permit: retirement.permit }
            : { kind: "held", reason: "terminal-source-unavailable" },
        ),
      );
    },
    sanitizeResidentBody,
    selectedResidentMember,
    registryStub: () => ({ getRepository: async (resource: string) => ({ resource }) }),
    validNativeOperationKey,
    RUN_ID_PATTERN,
    STREAMED_ROUTES: new Set(),
    observeWorkerRequest,
    BUILD: { commit: "unknown" },
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
        retireNativeOperation: (target: unknown) => receiver.retireNativeOperation(target),
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
  const worker = loaded.worker;
  receiver = loaded.receiver;
  Object.assign(receiver, {
    ctx: { storage: h.storage },
    env: { STATE_WORKER_URL: "https://memory.invalid", MEMORY_TOKEN: "fixture" },
    runCancellations: new KeyedAsyncLock(),
    nativeScopeTransport: () => retirement?.native,
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
    memoryRequests,
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

describe("terminal native scope retirement", () => {
  async function pendingScope(loseClose = false) {
    const h = fixture();
    const calls: Record<string, unknown>[] = [],
      closed = new Set<string>();
    let lose = loseClose,
      authorities = 0;
    const native = {
      request: async (value: Record<string, unknown>) => {
        calls.push(structuredClone(value));
        const ref = value.ref as { id: string };
        if (value.mode === "close") {
          closed.add(ref.id);
          if (lose) {
            lose = false;
            throw new Error("reply lost");
          }
        }
        const result =
          value.mode === "inspect"
            ? { version: 1, boot: "11111111-1111-4111-8111-111111111111" }
            : { ref, closed: closed.has(ref.id), ...(value.mode === "bootstrap" ? {} : { populated: false }) };
        return { stdout: JSON.stringify(result), stderr: "", exitCode: 0, timedOut: false };
      },
    };
    const scopes = new NativeRunScopes(h.storage, native);
    const owner = { runId: "run-a", ownerGen: "gen-a", ownerFence: 3 },
      thread = "thread-a";
    await scopes.birth(thread, owner, true, async () => {});
    const scope = await scopes.ensure(thread, owner, async () => {});
    const key = `native-operation:${thread}:run-a:original`;
    await h.journal.open(key, owner, thread);
    await h.journal.bindScope(key, scope);
    const attempt = await h.journal.begin(key, "process");
    const original = structuredClone(h.rows.get(key));
    const hash = (await h.journal.list()).operations.find((r) => r.key === key)!.recordHash;
    const target = { resource: "repo:acme/app", key, recordHash: hash, scope };
    const permit = {
      version: 1 as const,
      purpose: "terminal-native-scope" as const,
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      target,
      source: {
        id: "run-a",
        threadKey: thread,
        repo: "acme/app",
        status: "failed" as const,
        startedAt: 1,
        finishedAt: 2,
        sealedAt: 3,
      },
    };
    const prepare = async () => {
      authorities++;
      return permit;
    };
    const retire = (allowed = true) => h.journal.retireScope(target, native, async () => allowed, prepare);
    return {
      ...h,
      calls,
      native,
      scopes,
      scope,
      owner,
      thread,
      key,
      attempt,
      original,
      target,
      permit,
      prepare,
      retire,
      authorities: () => authorities,
    };
  }
  it("authorizes the real terminal HTTP receiver and freezes its exact Memory permit", async () => {
    const h = await pendingScope();
    h.rows.set("resident:resource", "repo:acme/app");
    const api = httpFixture(h, false, undefined, false, { native: h.native, permit: h.permit });
    expect((await api.request("/retire-native-operation", "reader", h.target)).status).toBe(401);
    expect(api.memoryRequests).toEqual([]);
    const response = await api.request("/retire-native-operation", "admin", h.target);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "closed", originalOperationOutcome: "unknown" });
    expect(api.memoryRequests).toEqual([{ storeKey: "runs:default", target: h.target }]);
    expect(h.calls.filter((v) => v.mode === "close").map((v) => v.ref)).toEqual([h.scope]);
    expect((await api.request("/retire-native-operation", "admin", h.target)).status).toBe(200);
    expect(api.memoryRequests).toHaveLength(1);
    expect(h.rows.get(h.key)).toEqual(h.original);
  });
  it("rejects malformed terminal HTTP selectors before Memory or native control", async () => {
    const h = await pendingScope();
    h.rows.set("resident:resource", "repo:acme/app");
    const api = httpFixture(h, false, undefined, false, { native: h.native, permit: h.permit });
    for (const extra of [
      { terminate: true },
      { resident: 0 },
      { recordHash: "foreign" },
      { scope: { ...h.scope, boot: "unknown" } },
    ])
      expect((await api.request("/retire-native-operation", "admin", { ...h.target, ...extra })).status).toBe(400);
    expect(api.memoryRequests).toEqual([]);
    expect((await h.journal.unresolved()).has(h.key)).toBe(true);
    expect(h.calls.map((v) => v.mode)).toEqual(["inspect", "bootstrap"]);
  });
  it("closes only the selected terminal scope and retains its original unknown bytes", async () => {
    const h = await pendingScope();
    const other = { runId: "run-b", ownerGen: "gen-b", ownerFence: 4 };
    await h.scopes.birth("thread-b", other, true, async () => {});
    const neighbor = await h.scopes.ensure("thread-b", other, async () => {});
    const foreign = "native-operation:thread-b:run-b:active";
    await h.journal.open(foreign, other, "thread-b");
    await h.journal.bindScope(foreign, neighbor);
    await h.journal.begin(foreign, "process");
    const foreignBytes = structuredClone(h.rows.get(foreign));
    expect(await h.retire()).toMatchObject({
      purpose: "terminal-native-scope",
      state: "closed",
      originalOperationOutcome: "unknown",
      records: { [h.key]: h.target.recordHash },
    });
    expect([...(await h.journal.unresolved()).keys()]).toEqual([foreign]);
    expect(h.rows.get(h.key)).toEqual(h.original);
    expect(h.rows.get(foreign)).toEqual(foreignBytes);
    expect(await h.scopes.ensure("thread-b", other, async () => {})).toEqual(neighbor);
    expect(await h.journal.readEnding(h.key)).toEqual({ kind: "missing" });
    const calls = h.calls.length;
    expect(await h.retire()).toMatchObject({ state: "closed" });
    expect(h.calls.length).toBe(calls);
    expect(h.authorities()).toBe(1);
  });
  it("keeps lost closure held, freezes callbacks and continues the original close without a second signal", async () => {
    const h = await pendingScope(true);
    expect(await h.retire()).toMatchObject({
      error: "native-operation-recovery-refused: terminal-scope-retirement-unconfirmed",
    });
    expect((await h.journal.unresolved()).has(h.key)).toBe(true);
    await h.journal.settle(h.key, h.attempt);
    await h.journal.close(h.key);
    expect(h.rows.get(h.key)).toEqual(h.original);
    await expect(h.journal.begin(h.key, "process")).rejects.toThrow("terminal retirement is prepared");
    await expect(h.journal.bindScope(h.key, h.scope)).rejects.toThrow("terminal retirement is prepared");
    await expect(h.journal.launched(h.key, h.attempt, identity)).rejects.toThrow("terminal retirement is prepared");
    await expect(h.journal.open(`native-operation:${h.thread}:run-a:late`, h.owner, h.thread)).rejects.toThrow(
      "run cancelled",
    );
    await expect(h.scopes.birth(h.thread, { ...h.owner, ownerFence: 99 }, true, async () => {})).rejects.toThrow(
      "run cancelled",
    );
    expect(await h.retire()).toMatchObject({ state: "closed", originalOperationOutcome: "unknown" });
    expect(h.calls.filter((c) => c.mode === "close").map((c) => c.ref)).toEqual([h.scope]);
    expect(h.authorities()).toBe(1);
  });
  it.each(["owner", "hash", "scope", "authority"] as const)(
    "refuses %s mismatch before native control",
    async (fault) => {
      const h = await pendingScope();
      const before = structuredClone(h.rows);
      if (fault === "hash") h.target.recordHash = "f".repeat(64);
      if (fault === "scope") h.target.scope = { ...h.scope, id: "cccccccc-cccc-4ccc-cccc-cccccccccccc" };
      const result = await h.journal.retireScope(
        h.target,
        h.native,
        async () => fault !== "owner",
        async () => (fault === "authority" ? undefined : h.permit),
      );
      expect(result).toMatchObject({ status: 409 });
      expect(h.calls.filter((c) => c.mode === "close")).toEqual([]);
      expect(h.rows).toEqual(before);
      expect((await h.journal.unresolved()).has(h.key)).toBe(true);
    },
  );
  it("refuses an oversized scope inventory without a partial close", async () => {
    const h = await pendingScope();
    for (let n = 0; n < 64; n++) {
      const key = `native-operation:${h.thread}:run-a:extra-${n}`;
      await h.journal.open(key, h.owner, h.thread);
      await h.journal.bindScope(key, h.scope);
    }
    expect(await h.retire()).toMatchObject({ status: 409 });
    expect(h.calls.map((v) => v.mode)).toEqual(["inspect", "bootstrap"]);
    expect((await h.journal.unresolved()).size).toBe(65);
  });
  it.each(["prepared", "closed"] as const)(
    "reads back a lost %s commit reply without a duplicate close",
    async (lostState) => {
      const h = await pendingScope();
      let lost = false;
      const journal = new NativeOperationJournal({
        ...h.storage,
        transaction: async (action) => {
          const result = await h.storage.transaction(action);
          const saved = h.rows.get("native-scope-retirement:thread-a:run-a:gen-a:3") as { state?: string } | undefined;
          if (!lost && saved?.state === lostState) {
            lost = true;
            throw new Error("commit reply lost");
          }
          return result;
        },
      });
      const invoke = () => journal.retireScope(h.target, h.native, matches, h.prepare);
      expect(await invoke()).toMatchObject({ status: 409, purpose: "terminal-native-scope" });
      expect(await invoke()).toMatchObject({ state: "closed", originalOperationOutcome: "unknown" });
      expect(h.calls.filter((v) => v.mode === "close").map((v) => v.ref)).toEqual([h.scope]);
      expect(h.rows.get(h.key)).toEqual(h.original);
    },
  );
  it("refuses a mismatched native close receipt without releasing execution debt", async () => {
    const h = await pendingScope();
    const original = h.native.request;
    h.native.request = async (value) => {
      const answer = await original(value);
      if (value.mode === "close")
        answer.stdout = JSON.stringify({
          ref: { ...h.scope, id: "dddddddd-dddd-4ddd-dddd-dddddddddddd" },
          closed: true,
          populated: false,
        });
      return answer;
    };
    expect(await h.retire()).toMatchObject({ status: 409, phase: "scope-close" });
    expect((await h.journal.unresolved()).has(h.key)).toBe(true);
    expect(h.rows.get(h.key)).toEqual(h.original);
  });
  it("refuses an older Memory reply without falling back to cancellation or SDK process control", async () => {
    const h = await pendingScope();
    h.rows.set("resident:resource", "repo:acme/app");
    const api = httpFixture(h, false, undefined, false, { native: h.native });
    expect((await api.request("/retire-native-operation", "admin", h.target)).status).toBe(409);
    expect(api.memoryRequests).toEqual([{ storeKey: "runs:default", target: h.target }]);
    expect(h.calls.map((v) => v.mode)).toEqual(["inspect", "bootstrap"]);
    expect(api.nativeReads()).toBe(0);
    expect(api.nativeControls()).toBe(0);
    expect((await h.journal.unresolved()).has(h.key)).toBe(true);
  });
  it("freezes an already-started legacy recovery before its final journal mutation", async () => {
    const h = await pendingScope(true);
    const sibling = `native-operation:${h.thread}:run-a:sibling`;
    await h.journal.open(sibling, h.owner, h.thread);
    await h.journal.bindScope(sibling, h.scope);
    const attempt = await h.journal.begin(sibling, "process");
    await h.journal.launched(sibling, attempt, identity);
    const item = (await h.journal.list()).operations.find((v) => v.key === sibling)!;
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recovery = h.journal.recover(
      sibling,
      item.recordHash,
      async () => {
        started();
        await wait;
        return terminal;
      },
      matches,
    );
    await ready;
    const original = structuredClone(h.rows.get(sibling));
    expect(await h.retire()).toMatchObject({ status: 409 });
    release();
    expect(await recovery).toMatchObject({ error: "native-operation-recovery-refused: terminal-retirement-prepared" });
    expect(h.rows.get(sibling)).toEqual(original);
    expect((await h.journal.unresolved()).has(sibling)).toBe(true);
  });
});
