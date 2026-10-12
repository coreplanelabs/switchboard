import ts from "typescript";
import { runInNewContext } from "node:vm";
import { readSource } from "./testing/sourceScan.js";
import { sanitizeResidentBody } from "../../src/execution/residentText.js";
import { validNativeOperationKey } from "./nativeOperation.js";
import { describe, expect, it } from "vitest";
import { NativeOperationJournal, type NativeOperationStorage, type NativeOperationRows } from "./nativeOperation.js";
import { KeyedAsyncLock } from "./keyedAsyncLock.js";

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

function httpFixture(h: ReturnType<typeof fixture>, running = false) {
  const source = ts.createSourceFile("worker.ts", readSource("worker.ts"), ts.ScriptTarget.Latest, true);
  const functions = [
    "bearerToken",
    "timingSafeEqual",
    "tokenScope",
    "hasScope",
    "parseResource",
    "handleDebug",
    "json",
  ].map((name) =>
    source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source),
  );
  const variables = ["ROUTES", "READ_DEBUG_OPS", "RESOURCE_RE", "REPO_ID_RE", "SUPPORTED_RESOURCE_TYPES"].map((name) =>
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
  const worker = runInNewContext(compiled + "\nworker", {
    Request,
    Response,
    URL,
    TextEncoder,
    sanitizeResidentBody,
    validNativeOperationKey,
    STREAMED_ROUTES: new Set(),
    startAdoptedRoot: () => undefined,
    tracer: {},
    traceSinks: [],
    catchAllErr: (error: Error) => ({ error: error.message }),
    withFleetAdmission: () => {
      throw new Error("recovery must not reopen fleet admission");
    },
    residentStub: () => ({
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
    }),
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
  };
}

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
