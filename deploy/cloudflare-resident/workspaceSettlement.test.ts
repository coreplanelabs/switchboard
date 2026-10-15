import { inspectResidentCredentials } from "./credentialInspection.js";
import {
  credentialInspectionInputSchema,
  emptyCredentialInspection,
} from "../../src/execution/credentialInspection.js";
import { RecordedCheckOperation } from "./checkOperation.js";
import { checkCommandHash, reportCheckResultFailure } from "../../src/execution/checkOperation.js";
import { NativeOperationJournal, unstartedNativeThread, unstartedNativeOperator } from "./nativeOperation.js";
import { NativeRunScopes, nativeScopeRetirementKey } from "./nativeScope.js";
import { isResidentPoolUser } from "../../src/execution/residentPoolSpends.js";
import { releasePoolBinding, claimPoolBinding } from "../../src/execution/residentPoolSpends";
import { registeredRunOwnsRelease, registeredRunAllowsClaim } from "./runRegistration";
import { runInNewContext } from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  isWorkspaceOwner,
  isAcknowledgedWorkspaceOwner,
  workspaceOwnerKey,
  workspaceBindingOf,
  workspaceSettlementOf,
} from "../../src/core/workspaceSettlement";
import { rememberOwnBranches } from "../../src/execution/residentRebind";
import { decideWorkspaceRemoval, hasRunOwnerField } from "./workspacePreservation";
import { readSource } from "./testing/sourceScan";
import { residentPublicationCommand } from "../../src/execution/residentPublication";
import {
  readCommandFor,
  statCommandFor,
  parseByteSize,
  chunkPlan,
  base64LengthOf,
  readChunkCommandFor,
  MAX_READ_BYTES,
} from "../../src/execution/binaryRead";
import { capBytesFor, capWrappedCommand } from "../../src/execution/residentExecWrap";
import { KeyedAsyncLock } from "./keyedAsyncLock";
import { isRuntimeBusySignal, SandboxRuntimeBusyError } from "../../src/execution/sandboxErrors";
import { planForceDetach } from "../../src/execution/residentDetach";
import { legacyStageReuseScrubCommand } from "./legacyCredentials";
import {
  cancellationFailure,
  cancellationOf,
  cancellationRefusalOf,
  cancellationObservationOf,
  sameCancellation,
} from "../../src/core/runLedger/cancellation";

const source = ts.createSourceFile("worker.ts", readSource("worker.ts"), ts.ScriptTarget.Latest, true);
const resident = source.statements.find(
  (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === "ResidentDO",
)!;
const names = [
  "debugThreads",
  "cancellationPending",
  "discardAbsentBinding",
  "debugBackdateThread",
  "workspaceDiscarded",
  "cancelRun",
  "cancelNativeRunScope",
  "nativeScopeTransport",
  "detachThread",
  "killThreadUserProcesses",
  "observeRetiredThreadRuntime",
  "withThreadBusy",
  "withOwnedNativeOperation",
  "withNativeOperationScope",
  "withSharedNativeOperation",
  "withOpNativeOperation",
  "inspectThreadCredentials",
  "assertThreadOperationAllowed",
  "beginThreadNativeOperation",
  "execThread",
  "checkOperationContext",
  "inspectCheckResult",
  "execThreadBody",
  "run",
  "waitForThreadDrain",
  "publishThread",
  "readThreadFile",
  "readThreadFileImpl",
  "readThreadBytes",
  "threadRun",
  "writeThreadFile",
  "writeThreadFileImpl",
  "writeOwnedFile",
  "watchdogCheck",
  "allocateThreadUser",
  "putThreadBinding",
  "workspaceRemovalDecision",
  "registerRun",
  "retainWorkspacePredecessor",
  "reconcileWorkspaceSettlements",
  "reconcileWorkspaceBinding",
  "observeRunForEviction",
  "workloadOwnerObservation",
  "ackWorkspaceSettlement",
];
const compiled = ts.transpileModule(
  `${source.statements
    .filter(
      (s) => ts.isFunctionDeclaration(s) && ["confineThreadPath", "validateEnvNames"].includes(s.name?.text ?? ""),
    )
    .map((s) => s.getText(source).replace("export ", ""))
    .join("\n")}
${source.statements
  .filter(
    (s) =>
      ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(source) === "parentDir"),
  )
  .map((s) => s.getText(source))
  .join("\n")}
class UnderTest {
 ${resident.members
   .filter((m) => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && names.includes(m.name.text))
   .map((m) => m.getText(source))
   .join("\n")}
}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const threadKey = "slack:C1:123";
const owner = { runId: "run-old", ownerGen: "gen-old", ownerFence: 7 };
const physical = {
  backend: "resident" as const,
  ref: "main",
  workspace: "/workspace/threads/t/main",
  user: "worker2",
  container: "vm-a",
  ownerGen: owner.ownerGen,
  ownerFence: owner.ownerFence,
};
const shutdownTarget = {
  ref: "main",
  user: "worker2",
  container: "vm-a",
  workspace: "/workspace/threads/t/main",
  ownerGen: "gen-old",
  ownerFence: 7,
};
const ending = {
  version: 1 as const,
  revision: 1,
  owner,
  binding: physical,
  record: { id: owner.runId, threadKey, userId: "slack:UOWNER", repo: "owner/name", status: "completed" as const },
  publication: { version: 1 as const, repo: "owner/name", branches: [{ ref: "codex/new", pr: 8 }], complete: true },
};

function harness(
  options: {
    native?: boolean;
    lostAck?: boolean;
    refusedAck?: boolean;
    live?: boolean;
    mismatch?: boolean;
    capacity?: boolean;
    corruptLive?: boolean;
    missingPhysical?: boolean;
    versions?: number;
    liveReply?: unknown;
    successorEnded?: boolean;
    incomplete?: boolean;
    legacyReply?: unknown;
  } = {},
) {
  const rows = new Map<string, any>([
    [
      "thread:" + threadKey,
      {
        threadKey,
        ref: physical.ref,
        worktreePath: physical.workspace,
        user: physical.user,
        container: physical.container,
        lastAttachAt: "today",
        sha: "a".repeat(40),
        ownBranches: options.capacity
          ? Array.from({ length: 50 }, (_, i) => ({ ref: "old-" + i, pr: i + 1, at: "yesterday" }))
          : [],
      },
    ],
    ["runReg:" + threadKey, { threadKey, ...owner, workspace: physical }],
    ["runFence:" + threadKey, owner],
    ["resource", "repo:owner/name"],
  ]);
  const events: string[] = [];
  const warnings: string[] = [];
  let ackLost = options.lostAck;
  let acknowledged = 0;
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (options.legacyReply && url.pathname === "/runs/preservation-owner") {
      events.push("read");
      if (body.ownerGen === undefined && body.ownerFence === undefined) {
        expect(body).toEqual({ storeKey: "runs", runId: "run-old" });
        return Response.json(options.legacyReply);
      }
      expect(body).toMatchObject(owner);
      return Response.json({ kind: "absent", owner });
    }
    const requested =
      options.successorEnded && body.ownerFence === 8
        ? { runId: owner.runId, ownerGen: "gen-next", ownerFence: 8 }
        : owner;
    expect(body).toMatchObject(requested);
    if (url.pathname === "/runs/workspace-ack") {
      events.push("ack");
      expect(rows.get("thread:" + threadKey).ownBranches).toContainEqual(
        expect.objectContaining({ ref: "codex/new", pr: 8 }),
      );
      expect(
        rows.get("thread:" + threadKey).workspaceSettlement ??
          rows.get("thread:" + threadKey).workspacePredecessors?.find((p: any) => p.owner.runId === owner.runId)
            ?.applied,
      ).toMatchObject({ revision: body.revision, owner: requested });
      if (options.live || options.corruptLive)
        return Response.json({ ok: false, reason: "owner-live" }, { status: 409 });
      if (options.refusedAck) throw new Error("ACK failed before admission");
      acknowledged = Math.max(acknowledged, body.revision);
      if (ackLost) {
        ackLost = false;
        throw new Error("accepted ACK response lost");
      }
      return Response.json({ ok: true });
    }
    events.push("read");
    if (options.successorEnded && body.ownerFence === 7) return Response.json({ kind: "absent", owner });
    if (options.successorEnded && !acknowledged)
      return Response.json({
        kind: "terminal",
        settlement: {
          ...ending,
          owner: requested,
          binding: { ...physical, ownerGen: requested.ownerGen, ownerFence: requested.ownerFence },
        },
        record: ending.record,
      });
    if (options.liveReply) return Response.json(options.liveReply);
    if (options.live) return Response.json({ kind: "live", row: { runId: owner.runId } });
    if (options.corruptLive) return Response.json({ kind: "unknown" });
    if (acknowledged >= (options.versions ?? 1))
      return Response.json({ kind: "acknowledged", owner: requested, revision: acknowledged });
    return Response.json({
      kind: "terminal",
      settlement: options.mismatch
        ? { ...ending, binding: { ...physical, container: "vm-b" } }
        : options.incomplete
          ? { ...ending, publication: { ...ending.publication, complete: false } }
          : { ...ending, revision: acknowledged + 1 },
      record: ending.record,
    });
  });
  const storage: any = {
    get: async (key: string | string[]) =>
      Array.isArray(key)
        ? new Map(key.filter((k) => rows.has(k)).map((k) => [k, structuredClone(rows.get(k))]))
        : structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => {
      rows.set(key, structuredClone(value));
      events.push("put:" + key);
    },
    list: async ({ prefix, startAfter = "", limit = 1000 }: { prefix: string; startAfter?: string; limit?: number }) =>
      new Map(
        [...rows]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      ),
    delete: async (key: string) => rows.delete(key),
    transaction: async (fn: (txn: unknown) => Promise<unknown>) => fn(storage),
  };
  const C = runInNewContext(compiled + "\nUnderTest", {
    fetch,
    AsyncLocalStorage,
    crypto: webcrypto,
    NativeOperationJournal,
    unstartedNativeThread,
    NativeRunScopes,
    inspectResidentCredentials,
    credentialInspectionInputSchema,
    emptyCredentialInspection,
    nativeScopeRetirementKey,
    RecordedCheckOperation,
    reportCheckResultFailure,
    unstartedNativeOperator,
    RunCancelledError: class RunCancelledError extends Error {},
    createExtensionProcessSandbox: (instance: any) => ({
      ...instance.processSandbox,
      exec: async (...args: unknown[]) => ({
        status: async () => ({
          id: "original-process",
          pid: 42,
          startedAt: "2026-10-11T00:00:00.000Z",
          state: "running",
        }),
        ...(await instance.processSandbox.exec(...args)),
      }),
    }),
    residentPublicationCommand,
    capBytesFor,
    capWrappedCommand,
    readCommandFor,
    statCommandFor,
    parseByteSize,
    chunkPlan,
    base64LengthOf,
    readChunkCommandFor,
    MAX_READ_BYTES,
    ENV_NAME_RE: /^[A-Z_][A-Z0-9_]*$/,
    READ_CONTENT_CAP: 1000,
    ControlResetError: class ControlResetError extends Error {},
    RuntimeReplacedError: class RuntimeReplacedError extends Error {},
    StepError: class StepError extends Error {},
    SandboxRuntimeBusyError,
    DEFAULT_EXEC_TIMEOUT_MS: 1000,
    BASH_TIMEOUT_MS: 1000,
    EXEC_OUTPUT_CAP: 10000,
    DESTROY_UNCONFIRMED_KEY: "destroy",
    CLEANUP_PENDING_KEY: "cleanup",
    isControlReset: () => false,
    isRuntimeReplacement: () => false,
    isRuntimeBusy: isRuntimeBusySignal,
    isRuntimeUnreachable: (error: Error) => error.name === "FixtureRuntimeUnreachable",
    RuntimeUnreachableError: class RuntimeUnreachableError extends Error {},
    ProcessWaitTimeoutError: class ProcessWaitTimeoutError extends Error {},
    FORCE_DETACH_DRAIN_MS: 1000,
    FORCE_DETACH_DRAIN_POLL_MS: 1,
    emitStepRoot: () => {},
    refusalOutcome: () => "refused",
    URL,
    Response,
    AbortSignal,
    JSON,
    structuredClone,
    registeredRunOwnsRelease,
    planForceDetach,
    legacyStageReuseScrubCommand,
    cancellationRefusal: () => false,
    cancellationFailure,
    cancellationOf,
    cancellationRefusalOf,
    cancellationObservationOf,
    sameCancellation,
    TextDecoder,
    FORCE_DETACH_KILL_TIMEOUT_MS: 1000,
    SECOND_MS: 1000,
    setTimeout,
    clearTimeout,
    isWorkspaceOwner,
    isAcknowledgedWorkspaceOwner,
    workspaceOwnerKey,
    workspaceBindingOf,
    workspaceSettlementOf,
    hasRunOwnerField,
    decideWorkspaceRemoval,
    errMsg: (error: unknown) => String(error),
    rememberOwnBranches,
    RUN_STORE_KEY: "runs",
    RUN_STORE_TIMEOUT_MS: 1000,
    THREAD_KEY_PREFIX: "thread:",
    BUILD_USER: "worker1",
    isResidentPoolUser,
    THREAD_USERS: ["worker2", "worker3"],
    RESOURCE_KEY: "resource",
    WORKSPACE_PREDECESSORS_MAX: 20,
    WORKSPACE_RECONCILE_BINDINGS_MAX: 20,
    WORKSPACE_SETTLEMENT_CURSOR_KEY: "settlement-cursor",
    systemClock: () => 1000,
    validRunOwner: () => true,
    releasePoolBinding,
    claimPoolBinding,
    registeredRunAllowsClaim,
    poolBindingKey: (s: string) => "pool-binding:" + s,
    parseThreadKey: (s: string) => ({ threadKey: s }),
    threadBindingKey: (s: string) => "thread:" + s,
    runRegKey: (s: string) => "runReg:" + s,
    runFenceKey: (s: string) => "runFence:" + s,
    console: { warn: (message: string) => warnings.push(message), log: () => {} },
  });
  const instance = new C();
  const kernelScopes = new Map<string, boolean>();
  Object.assign(instance, {
    nativeScopeTransport: () => ({
      request: async (request: any) => {
        if (request.mode === "launch") {
          if (request.role === "write") {
            await instance.writeFile(request.path, request.content);
            return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false };
          }
          const process = await instance.processSandbox.exec(request.argv, { env: request.env });
          return process.output();
        }
        if (request.mode === "inspect")
          return {
            stdout: JSON.stringify({ version: 1, boot: "4b15c6de-2eb6-4ef1-9b6c-e36ebf389807" }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        if (request.mode === "bootstrap") kernelScopes.set(request.ref.id, false);
        if (request.mode === "close") kernelScopes.set(request.ref.id, true);
        const closed = kernelScopes.get(request.ref.id) === true;
        return {
          stdout: JSON.stringify({
            ref: request.ref,
            closed,
            ...(request.mode === "bootstrap"
              ? {}
              : { populated: false, ...(request.mode === "view" ? { present: true } : {}) }),
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    }),
    ctx: {
      storage,
      id: { toString: () => "fixture-container" },
      container: { running: true, exec: vi.fn(async () => ({ exitCode: Promise.resolve(0) })) },
    },
    threadOperationScope: new AsyncLocalStorage(),
    opOperationScope: new AsyncLocalStorage(),
    clearRuntimeUnreachable: async () => {},
    noteRuntimeUnreachable: async () => ({ count: 1 }),
    threadWrites: new KeyedAsyncLock(),
    ensureStageDir: async () => {},
    memoryGate: async () => null,
    threadPreflight: async () => ({
      binding: { ...rows.get("thread:" + threadKey), readonly: false, githubDoorHost: "door.example" },
    }),
    threadOpsInFlight: new Map(),
    opUsersInUse: new Map(),
    workspaceExclusiveOpsInFlight: new Set(),
    withDeployAdmission: async (fn: () => Promise<unknown>) => fn(),
    poolUserOwnerMatches: async () => true,
    waitForThreadDrain: async () => instance.threadOpsInFlight.get(threadKey) ?? 0,
    execThreadImpl: async () => ({ stdout: "ran", stderr: "", exitCode: 0, truncated: false }),
    env: { STATE_WORKER_URL: "https://state.example", MEMORY_TOKEN: "test" },
    threadAttaches: { run: async (_key: string, fn: () => Promise<unknown>) => fn() },
    runCancellations: new KeyedAsyncLock(),
    runNativeScopes: new Map(),
    putThreadBinding: async (next: any) => storage.put("thread:" + next.threadKey, next),
    watchdogCheckLifecycle: async () => {
      events.push("lifecycle");
      return { state: "down", reason: "runtime-unreachable", resource: "repo:owner/name", action: "none" };
    },
    diskGauge: async () => null,
    memoryGauge: async () => null,
    refreshRow: async () => ({ state: "idle" }),
    claimRetainedThreadUser: async () => null,
    reserveSafePoolUser: async () => "worker3",
    poolUsersInspecting: new Set(),
    containerIdentity: async () => "vm-a",
    observePrivateTree: async () => ({
      present: true,
      branch: physical.ref,
      head: "a".repeat(40),
      uncommittedChanges: 0,
      untrackedNonIgnored: 0,
      unpushedCommits: 0,
    }),
    run: vi.fn(() => {
      throw new Error("metadata reconciliation must not wake a VM");
    }),
  });
  const beginNative = instance.beginThreadNativeOperation.bind(instance);
  instance.beginThreadNativeOperation = async (kind: string) => {
    const scope = instance.threadOperationScope.getStore();
    if (options.native !== false && scope && !rows.has(`cancelled:${scope.threadKey}:${scope.owner.runId}`)) {
      const key = `native-scope-mode:${encodeURIComponent(scope.threadKey)}:${scope.owner.runId}`;
      if (!rows.has(key))
        rows.set(key, { threadKey: scope.threadKey, runId: scope.owner.runId, protocol: "native-v1" });
    }
    return beginNative(kind);
  };
  return { instance, rows, events, warnings, fetch, ackedRevision: () => acknowledged };
}

describe("resident cancellation inspection", () => {
  const ticket = {
    version: 1,
    id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    runId: owner.runId,
    threadKey,
    repo: "owner/name",
    ownerGen: owner.ownerGen,
    startedAt: 1,
    actor: { kind: "chat", id: "slack:operator" },
  };
  it("stops a later same-thread run without discarding a full page of retired original history", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) h.rows.set(`native-operation:${threadKey}:${owner.runId}:${i}`, { ...owner });
    const history = structuredClone([...h.rows].filter(([key]) => key.startsWith("native-operation:")));
    const commands: string[][] = [];
    h.instance.ctx.container.exec = async (argv: string[]) => {
      commands.push(argv);
      const exitCode = argv[6].startsWith("boot=") && argv[8] === "new-kernel" ? 12 : 0;
      return {
        exitCode: Promise.resolve(exitCode),
        output: async () => ({
          exitCode,
          stdout: new TextEncoder().encode("new-kernel\n").buffer,
          stderr: new ArrayBuffer(0),
        }),
      };
    };
    // Previously verified retirement is durable history; this stop must not
    // reclassify it or discard it when a later run owns the thread.
    h.rows.set(`native-retirement:${threadKey}:${owner.runId}`, {
      version: 1,
      cancellationId: ticket.id,
      owner,
      threadKey,
      originalBoot: "vm-a",
      currentBoot: "new-kernel",
      originalOperationOutcome: "unknown",
      records: await new NativeOperationJournal(h.instance.ctx.storage).fingerprints(
        `native-operation:${threadKey}:${owner.runId}:`,
      ),
    });
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, {
      cancellation: ticket,
      target: shutdownTarget,
      stopped: true,
      disposition: "runtime-retired",
      retiredBoot: "new-kernel",
    });
    const next = { runId: "run-next", ownerGen: "gen-next", ownerFence: 8 };
    const current = { ...physical, ...next, container: "new-kernel" };
    h.rows.get("thread:" + threadKey).container = current.container;
    h.rows.set("runReg:" + threadKey, { threadKey, ...next, workspace: current });
    h.rows.set("runFence:" + threadKey, next);
    const stop = { ...ticket, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", runId: next.runId, ownerGen: next.ownerGen };
    expect(await h.instance.cancelRun(stop, current)).toEqual({
      stopped: true,
      cancellationId: stop.id,
      disposition: "processes-stopped",
    });
    for (const [key, value] of history) expect(h.rows.get(key)).toEqual(value);
    expect(commands.filter((argv) => argv[6].includes("kill -9")).every((argv) => argv[8] === "new-kernel")).toBe(true);
  });
  const observation = {
    step: "initial-kill",
    phase: "exit",
    cause: "exit-unconfirmed",
    exitCode: 2,
    retirement: "native-outcome-unknown",
  };
  it("reports the saved original retirement refusal without changing state or exposing private bytes", async () => {
    const h = harness();
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, {
      cancellation: ticket,
      target: shutdownTarget,
      failure: { phase: "resident", cause: "kill-unconfirmed" },
      observation,
      private: "fixture-private-token",
    });
    h.rows.get("thread:" + threadKey).private = "fixture-private-worktree-bytes";
    const before = structuredClone([...h.rows]);
    expect(await h.instance.debugThreads({ threadKey, runId: owner.runId })).toEqual({
      cancellation: {
        runId: "run-old",
        threadKey: "slack:C1:123",
        evidence: "stored-only",
        state: "recorded",
        ticket: { id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", ownerGen: "gen-old", startedAt: 1 },
        target: { ref: "main", user: "worker2", container: "vm-a", ownerGen: "gen-old", ownerFence: 7 },
        binding: { ref: "main", user: "worker2", container: "vm-a" },
        registration: { runId: "run-old", ownerGen: "gen-old", ownerFence: 7 },
        fence: { runId: "run-old", ownerGen: "gen-old", ownerFence: 7 },
        matches: { binding: true, registration: true, fence: true },
        receipt: {
          stopped: null,
          disposition: null,
          refusal: { phase: "resident", cause: "kill-unconfirmed" },
          observation: {
            step: "initial-kill",
            phase: "exit",
            cause: "exit-unconfirmed",
            exitCode: 2,
            retirement: "native-outcome-unknown",
          },
        },
      },
    });
    expect([...h.rows]).toEqual(before);
    expect(h.events).toEqual([]);
    expect(h.instance.ctx.container.exec).not.toHaveBeenCalled();
    expect(h.instance.run).not.toHaveBeenCalled();
  });
  it("keeps absent and corrupt cancellation evidence unverified without repairing rows", async () => {
    const h = harness();
    const key = `cancelled:${threadKey}:${owner.runId}`;
    expect((await h.instance.debugThreads({ threadKey, runId: owner.runId })).cancellation).toMatchObject({
      state: "absent",
      evidence: "stored-only",
      ticket: null,
      target: null,
      receipt: null,
      matches: { binding: null, registration: null, fence: null },
    });
    for (const row of [
      { cancellation: { ...ticket, ownerGen: undefined }, target: shutdownTarget },
      { cancellation: { ...ticket, repo: "foreign/repo" }, target: shutdownTarget },
      { cancellation: ticket, target: { ...shutdownTarget, ownerFence: undefined } },
      { cancellation: ticket, target: shutdownTarget, observation: { ...observation, secret: "private-value" } },
    ]) {
      h.rows.set(key, row);
      const before = structuredClone([...h.rows]);
      const result = await h.instance.debugThreads({ threadKey, runId: owner.runId });
      expect(result.cancellation).toMatchObject({ state: "unverified", evidence: "stored-only" });
      expect(JSON.stringify(result)).not.toContain("private-value");
      expect([...h.rows]).toEqual(before);
    }
    expect(h.events).toEqual([]);
    expect(h.instance.ctx.container.exec).not.toHaveBeenCalled();
  });
  it("reports successor mismatches and labels completed receipts as stored evidence", async () => {
    const h = harness();
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, {
      cancellation: ticket,
      target: shutdownTarget,
      stopped: true,
      disposition: "runtime-retired",
    });
    expect((await h.instance.debugThreads({ threadKey, runId: owner.runId })).cancellation).toMatchObject({
      state: "recorded",
      evidence: "stored-only",
      receipt: { stopped: true, disposition: "runtime-retired", refusal: null, observation: null },
      matches: { binding: true, registration: true, fence: true },
    });
    h.rows.set("runReg:" + threadKey, { ...owner, runId: "run-successor", ownerFence: 8 });
    h.rows.set("runFence:" + threadKey, { ...owner, runId: "run-successor", ownerFence: 8 });
    h.rows.get("thread:" + threadKey).worktreePath = "/workspace/threads/successor/private";
    const before = structuredClone([...h.rows]);
    expect((await h.instance.debugThreads({ threadKey, runId: owner.runId })).cancellation).toMatchObject({
      state: "unverified",
      evidence: "stored-only",
      registration: { runId: "run-successor", ownerGen: "gen-old", ownerFence: 8 },
      fence: { runId: "run-successor", ownerGen: "gen-old", ownerFence: 8 },
      matches: { binding: false, registration: false, fence: false },
      receipt: { stopped: true, disposition: "runtime-retired" },
    });
    expect([...h.rows]).toEqual(before);
    expect(h.events).toEqual([]);
  });
  it("preserves the default thread listing and does not turn read failure into absence", async () => {
    const h = harness();
    expect(await h.instance.debugThreads()).toEqual({
      threads: [
        {
          threadKey: "slack:C1:123",
          ref: "main",
          user: "worker2",
          container: "vm-a",
          lastAttachAt: "today",
          sha: "a".repeat(40),
          ownBranches: [],
        },
      ],
    });
    h.instance.ctx.storage.get = async () => {
      throw new Error("stored witness unavailable");
    };
    await expect(h.instance.debugThreads({ threadKey, runId: owner.runId })).rejects.toThrow(
      "stored witness unavailable",
    );
  });
});

describe("resident cancellation admission", () => {
  const ticket = {
    version: 1,
    id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    runId: owner.runId,
    threadKey,
    ownerGen: owner.ownerGen,
    startedAt: 1,
    actor: { kind: "chat", id: "slack:operator" },
  };
  it.each(["process", "opaque"])(
    "does not turn an unbound submitted %s into retirement after its scope ends",
    async (kind) => {
      const h = harness();
      const key = `native-operation:${threadKey}:${owner.runId}:unbound`;
      const journal = new NativeOperationJournal(h.instance.ctx.storage);
      await journal.open(key, owner, threadKey);
      await journal.begin(key, kind as "process" | "opaque");
      await journal.close(key);
      const original = structuredClone(h.rows.get(key));
      h.instance.ctx.container.exec = async (argv: string[]) => ({
        exitCode: Promise.resolve(argv[6].includes("kill -9") ? 2 : 0),
        output: async () => ({
          exitCode: 0,
          stdout: new TextEncoder().encode("new-kernel\n").buffer,
          stderr: new ArrayBuffer(0),
        }),
      });
      expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: false, cancellationId: ticket.id });
      expect(h.rows.get(key)).toEqual(original);
      expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)?.stopped).toBeUndefined();
    },
  );
  it("recovers a missing mutable thread binding from the exact registered original runtime", async () => {
    const h = harness();
    h.rows.delete("thread:" + threadKey);
    expect(await h.instance.cancelRun(ticket, null)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject({ ...owner, workspace: physical });
    expect(h.rows.has("thread:" + threadKey)).toBe(false);
  });
  it("stops a positively registered new runtime of the same original without replacing the old target", async () => {
    const h = harness();
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: ticket, target: shutdownTarget });
    const current = { ...physical, container: "new-kernel" };
    h.rows.get("thread:" + threadKey).container = current.container;
    h.rows.set("runReg:" + threadKey, { threadKey, ...owner, workspace: current });
    const commands: string[][] = [];
    h.instance.ctx.container.exec = async (argv: string[]) => {
      commands.push(argv);
      return {
        exitCode: Promise.resolve(0),
        output: async () => ({
          exitCode: 0,
          stdout: new TextEncoder().encode("new-kernel\n").buffer,
          stderr: new ArrayBuffer(0),
        }),
      };
    };
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: true, cancellationId: ticket.id });
    expect(commands.some((argv) => argv[6].includes("kill -9") && argv[8] === "new-kernel")).toBe(true);
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`).target).toEqual(shutdownTarget);
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject({ ...owner, workspace: current });
  });
  it("keeps a changed original binding unconfirmed during the final physical observation", async () => {
    const h = harness();
    let probes = 0;
    h.instance.ctx.container.exec = async () => ({
      output: async () => {
        if (++probes === 3) h.rows.get("thread:" + threadKey).container = "new-kernel";
        return { exitCode: 0, stdout: new TextEncoder().encode("new-kernel\n").buffer, stderr: new ArrayBuffer(0) };
      },
    });
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: false,
      refusal: { cause: "target-changed" },
    });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)?.stopped).toBeUndefined();
    expect(h.rows.get("thread:" + threadKey).container).toBe("new-kernel");
  });
  it("does not commit a competing cancellation when the thread already holds another ticket", async () => {
    const h = harness();
    const held = { runId: "run-other", cancellationId: "cancel-other" };
    h.rows.set(`cancel-control:${threadKey}`, held);
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: false,
      refusal: { cause: "ticket-conflict" },
    });
    expect(h.rows.has(`cancelled:${threadKey}:${owner.runId}`)).toBe(false);
    expect(h.rows.get(`cancel-control:${threadKey}`)).toEqual(held);
  });
  it("does not retire a successor's old epoch while the original still holds a native launch scope", async () => {
    const h = harness();
    let release!: () => void;
    const active = h.instance.withOwnedNativeOperation(
      threadKey,
      owner,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const next = { runId: "run-successor", ownerGen: "gen-next", ownerFence: 8 };
    h.rows.set("runReg:" + threadKey, { threadKey, ...next });
    h.rows.set("runFence:" + threadKey, next);
    h.rows.get("thread:" + threadKey).container = "new-kernel";
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: ticket, target: shutdownTarget });
    h.instance.ctx.container.exec = async () => ({
      output: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("new-kernel\n").buffer,
        stderr: new ArrayBuffer(0),
      }),
    });
    try {
      expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
        stopped: false,
        refusal: { cause: "operations-busy" },
      });
      expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)?.stopped).toBeUndefined();
    } finally {
      release();
      await active;
    }
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
    expect(h.rows.get("runReg:" + threadKey)).toEqual({ threadKey, ...next });
  });
  it("holds a replaced original epoch with unbound opaque native history", async () => {
    const h = harness();
    const journalKey = `native-operation:${threadKey}:${owner.runId}:lost`;
    const journal = new NativeOperationJournal(h.instance.ctx.storage);
    await journal.open(journalKey, owner, threadKey);
    await journal.begin(journalKey, "opaque");
    await journal.close(journalKey);
    const before = structuredClone(h.rows.get(journalKey));
    h.instance.hydration = null;
    h.instance.getStatus = async () => ({ state: "warm" });
    h.instance.recreateAdmission = { blocked: async () => false };
    h.instance.ctx.container.exec = vi.fn(async (argv: string[]) => ({
      exitCode: Promise.resolve(argv[6].startsWith("boot=") ? 0 : 2),
      output: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("new-kernel\n").buffer,
        stderr: new ArrayBuffer(0),
      }),
    }));
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: false,
      cancellationId: ticket.id,
    });
    expect(h.rows.get(journalKey)).toEqual(before);
    expect(h.rows.has(`native-retirement:${threadKey}:${owner.runId}`)).toBe(false);
    expect(h.instance.ctx.container.exec.mock.calls.every(([argv]: [string[]]) => argv[8] === "vm-a")).toBe(true);
  });
  it("resolves only a positively owned original target when its upstream binding is missing", async () => {
    const h = harness();
    expect(await h.instance.cancelRun(ticket, null)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
    const missing = harness();
    missing.rows.delete("runReg:" + threadKey);
    expect(await missing.instance.cancelRun(ticket, null)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "custody-unverified" },
    });
    expect(missing.instance.ctx.container.exec).not.toHaveBeenCalled();
    const foreign = harness();
    foreign.rows.set("runReg:" + threadKey, { ...owner, runId: "other-run" });
    expect(await foreign.instance.cancelRun(ticket, null)).toMatchObject({
      stopped: false,
      refusal: { cause: "custody-unverified" },
    });
    expect(foreign.instance.ctx.container.exec).not.toHaveBeenCalled();
  });
  it("retires the saved original epoch without signalling a successor that reused its UID", async () => {
    const h = harness();
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: ticket, target: shutdownTarget });
    const next = { runId: "run-successor", ownerGen: "gen-next", ownerFence: 8 };
    h.rows.set("runReg:" + threadKey, { threadKey, ...next });
    h.rows.set("runFence:" + threadKey, next);
    h.rows.set("thread:" + threadKey, {
      ...h.rows.get("thread:" + threadKey),
      container: "new-kernel",
      lastRunOwner: next,
    });
    const successor = structuredClone(h.rows.get("thread:" + threadKey));
    h.instance.threadOpsInFlight.set(threadKey, 1);
    h.instance.opUsersInUse.set("worker2", "op:successor");
    h.instance.poolUserOwnerMatches = async () => false;
    h.instance.ctx.container.exec = vi.fn(async (argv: string[]) => ({
      exitCode: Promise.resolve(argv[6].includes("kill -9") ? 2 : 0),
      output: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("new-kernel\n").buffer,
        stderr: new ArrayBuffer(0),
      }),
    }));
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
    expect(h.rows.get("thread:" + threadKey)).toEqual(successor);
    expect(h.rows.get("runReg:" + threadKey)).toEqual({ threadKey, ...next });
    expect(h.rows.get("runFence:" + threadKey)).toEqual(next);
    expect(h.instance.ctx.container.exec.mock.calls.every(([argv]: [string[]]) => !argv[6].includes("kill -9"))).toBe(
      true,
    );
  });
  it("persists the cancellation fence before waiting behind a held attachment", async () => {
    const h = harness();
    const lock = new KeyedAsyncLock();
    h.instance.threadAttaches = lock;
    let release!: () => void;
    const held = lock.run(
      threadKey,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const stop = h.instance.cancelRun(ticket, physical);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toMatchObject({
        cancellation: ticket,
        target: shutdownTarget,
      });
    } finally {
      release();
      await held;
      await stop;
    }
  });
  it("does not retire an epoch while an original launch capability is still pending", async () => {
    const h = harness();
    h.instance.threadOpsInFlight.set(threadKey, 1);
    h.instance.waitForThreadDrain = async () => 1;
    h.instance.hydration = null;
    h.instance.getStatus = async () => ({ state: "warm" });
    h.instance.recreateAdmission = { blocked: async () => false };
    h.instance.ctx.container.exec = async () => ({
      exitCode: Promise.resolve(2),
      output: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("new-kernel\n").buffer,
        stderr: new ArrayBuffer(0),
      }),
    });
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: false, cancellationId: ticket.id });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)?.stopped).toBeUndefined();
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
  });
  it("does not call the whole run stopped when the same original owns work on a new epoch", async () => {
    const h = harness();
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: ticket, target: shutdownTarget });
    h.rows.get("thread:" + threadKey).container = "new-kernel";
    h.instance.ctx.container.exec = vi.fn(async () => ({
      exitCode: Promise.resolve(0),
      output: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("new-kernel\n").buffer,
        stderr: new ArrayBuffer(0),
      }),
    }));
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: false,
      refusal: { cause: "target-changed" },
    });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)?.stopped).toBeUndefined();
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
    expect(h.instance.ctx.container.exec).not.toHaveBeenCalled();
  });
  it("acknowledges a replaced original runtime without discarding retained ownership", async () => {
    const h = harness();
    h.instance.opUsersInUse = new Map();
    h.instance.hydration = null;
    h.instance.getStatus = async () => ({ state: "warm" });
    h.instance.recreateAdmission = { blocked: async () => false };
    let sdkLaunches = 0;
    h.instance.run = async () => {
      sdkLaunches++;
      throw new Error("SDK execution must not wake a replacement");
    };
    h.instance.ctx.container.exec = async () => ({
      output: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("cccccccc-cccc-4ccc-8ccc-cccccccccccc\n").buffer,
        stderr: new ArrayBuffer(0),
      }),
    });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
    expect(sdkLaunches).toBe(0);
    expect(h.rows.get("thread:" + threadKey)).toMatchObject({
      user: "worker2",
      worktreePath: "/workspace/threads/t/main",
      container: "vm-a",
    });
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
  });
  it("retires the original runtime while unrelated refresh work continues", async () => {
    const h = harness();
    h.instance.hydration = null;
    h.instance.getStatus = async () => ({ state: "refreshing" });
    h.instance.recreateAdmission = { blocked: async () => false };
    h.instance.threadOpsInFlight.set("slack:other:1", 1);
    h.instance.opUsersInUse.set("worker4", "op:other");
    const otherNative = "native-operation:slack:other:1:other-run:pending";
    h.rows.set(otherNative, { runId: "other-run", ownerGen: "other-gen", ownerFence: 9 });
    h.instance.ctx.container.exec = async (argv: string[]) => {
      const retiredObservation = argv[6].startsWith("boot=");
      const exitCode = retiredObservation ? 0 : 2;
      return {
        exitCode: Promise.resolve(exitCode),
        output: async () => ({
          exitCode,
          stdout: new TextEncoder().encode("cccccccc-cccc-4ccc-8ccc-cccccccccccc\n").buffer,
          stderr: new ArrayBuffer(0),
        }),
      };
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
    expect(h.rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2", container: "vm-a" });
    expect(h.rows.get(otherNative)).toEqual({ runId: "other-run", ownerGen: "other-gen", ownerFence: 9 });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toMatchObject({
      stopped: true,
      disposition: "runtime-retired",
    });
  });
  it.each([
    "unknown native operation",
    "busy",
    "same boot",
    "invalid boot",
    "changed boot",
    "cold",
    "foreign fence",
    "hydration",
    "recreate held",
    "original operation UID",
    "running original UID",
    "destroying",
    "onboarding",
    "restoring",
    "down",
  ])("judges physical retirement independently of historical debt and lifecycle labels: %s", async (outcome) => {
    const h = harness();
    h.instance.hydration = null;
    h.instance.getStatus = async () => ({
      state: ["onboarding", "restoring", "down"].includes(outcome) ? outcome : "warm",
    });
    h.instance.recreateAdmission = { blocked: async () => false };
    h.instance.run = async () => ({ exitCode: 2, timedOut: false, truncated: false });
    const marker = `native-operation:${threadKey}:${owner.runId}:old`;
    if (outcome === "unknown native operation") h.rows.set(marker, owner);
    if (outcome === "busy") h.instance.threadOpsInFlight.set(threadKey, 1);
    if (outcome === "cold") h.instance.ctx.container.running = false;
    if (outcome === "foreign fence") h.rows.set("runFence:" + threadKey, { ...owner, ownerFence: 8 });
    if (outcome === "hydration") h.instance.hydration = { phase: "restore" };
    if (outcome === "recreate held") h.instance.recreateAdmission = { blocked: async () => true };
    if (outcome === "original operation UID") h.instance.opUsersInUse.set("worker2", "op:original");
    if (outcome === "destroying") h.instance.destroying = true;
    let probes = 0;
    h.instance.ctx.container.exec = async (argv: string[]) => {
      const exitCode = argv[6].startsWith("boot=") ? (outcome === "running original UID" ? 3 : 0) : 2;
      return {
        exitCode: Promise.resolve(exitCode),
        output: async () => ({
          exitCode,
          stdout: new TextEncoder().encode(
            (outcome === "same boot"
              ? "vm-a"
              : outcome === "invalid boot"
                ? "invalid!"
                : outcome === "changed boot" && probes++
                  ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
                  : "cccccccc-cccc-4ccc-8ccc-cccccccccccc") + "\n",
          ).buffer,
          stderr: new ArrayBuffer(0),
        }),
      };
    };
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: ["hydration", "recreate held", "onboarding", "restoring", "down"].includes(outcome),
    });
    expect(h.rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2", container: "vm-a" });
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
    if (outcome === "unknown native operation") expect(h.rows.get(marker)).toEqual(owner);
  });
  it("counts admission before its first wait and refuses a delayed cancelled command", async () => {
    const h = harness();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const pending = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    h.instance.withDeployAdmission = async (fn: () => Promise<unknown>) => {
      if (++calls === 1) {
        enter();
        await pending;
      }
      return fn();
    };
    h.instance.run = async () => ({ exitCode: 137, timedOut: false, truncated: false });
    const command = h.instance.execThread(threadKey, "echo late", 1000, undefined, undefined, owner);
    await entered;
    const stopped = await h.instance.cancelRun(ticket, physical);
    release();
    const result = await command;
    expect(stopped).toMatchObject({ stopped: false });
    expect(result).toMatchObject({ error: "run cancelled", status: 409 });
  });
  it("rejects an original request after a successor replaces registration, including after restart", async () => {
    const h = harness();
    const next = { runId: "run-next", ownerGen: "gen-next", ownerFence: 8 };
    h.rows.set("runReg:" + threadKey, {
      threadKey,
      ...next,
      workspace: { ...physical, ownerGen: next.ownerGen, ownerFence: 8 },
    });
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: ticket, stopped: true });
    h.rows.set(`cancelled-thread:${threadKey}`, true);
    expect(await h.instance.execThread(threadKey, "echo old", 1000, undefined, undefined, owner)).toMatchObject({
      status: 409,
    });
    expect(await h.instance.execThread(threadKey, "echo legacy", 1000)).toMatchObject({ status: 409 });
    expect(await h.instance.execThread(threadKey, "echo next", 1000, undefined, undefined, next)).toEqual({
      stdout: "ran",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
  });
  it("a native submission failure can be stopped through its reserved scope", async () => {
    const h = harness();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.processSandbox = {
      exec: async () => {
        throw new Error("taking too long to accept the connection");
      },
    };
    h.instance.execThreadImpl = async () => h.instance.run(["su", "-s", "/bin/bash", "worker2", "-c", "echo work"]);
    await expect(h.instance.execThread(threadKey, "echo work", 1000, undefined, undefined, owner)).rejects.toThrow(
      "taking too long to accept the connection",
    );
    expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toHaveLength(1);
    h.instance.processSandbox = {
      exec: async () => ({
        output: async () => ({ stdout: "done", stderr: "", exitCode: 0, timedOut: false, truncated: false }),
      }),
    };
    expect(await h.instance.execThread(threadKey, "echo work", 1000, undefined, undefined, owner)).toMatchObject({
      stdout: "done",
      exitCode: 0,
    });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
  });
  it("closes execution after a lost output while retaining the original unknown journal", async () => {
    const h = harness();
    const nativeRun = Object.getPrototypeOf(h.instance).run;
    h.instance.run = nativeRun;
    h.instance.processSandbox = {
      exec: async () => ({
        output: async () => {
          throw new Error("lost native output");
        },
      }),
    };
    h.instance.execThreadImpl = async () => h.instance.run(["su", "-s", "/bin/bash", "worker2", "-c", "echo work"]);
    await expect(h.instance.execThread(threadKey, "echo work", 1000, undefined, undefined, owner)).rejects.toThrow(
      "lost native output",
    );
    expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toHaveLength(1);
    h.instance.threadOperationScope = new AsyncLocalStorage();
    h.instance.threadOpsInFlight = new Map();
    h.instance.run = async () => ({ exitCode: 137, timedOut: false, truncated: false });
    const original = structuredClone([...h.rows].filter(([key]) => key.startsWith("native-operation:")));
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: true,
      disposition: "processes-stopped",
    });
    for (const [key, value] of original) expect(h.rows.get(key)).toEqual(value);
    expect((await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).size).toBe(0);
  });
  it("settles a completed native write but retains an unknown write outcome", async () => {
    const write = async (lost: boolean) => {
      const h = harness();
      h.instance.runOk = async () => {};
      h.instance.threadRunOk = async () => {};
      h.instance.writeFile = async () => {
        if (lost) throw new Error("native write reply lost");
        return { success: true };
      };
      const result = await h.instance.writeThreadFile(threadKey, "owned.txt", "owned", owner);
      h.instance.run = async () => ({ exitCode: 137, timedOut: false, truncated: false });
      return { result, stopped: await h.instance.cancelRun(ticket, physical) };
    };
    expect(await write(false)).toEqual({
      result: { ok: true, bytes: 5 },
      stopped: { stopped: true, cancellationId: ticket.id, disposition: "processes-stopped" },
    });
    expect(await write(true)).toEqual({
      result: { error: "write-failed: Error: native write reply lost", status: 400 },
      stopped: {
        stopped: true,
        cancellationId: ticket.id,
        disposition: "processes-stopped",
      },
    });
  });
  it("refuses native work whose parent scope closes during owner validation", async () => {
    const h = harness();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = h.instance.ctx.storage.get;
    let reads = 0;
    h.instance.ctx.storage.get = async (key: string) => {
      if (key === "runReg:" + threadKey && ++reads === 2) {
        enter();
        await pending;
      }
      return get(key);
    };
    h.instance.processSandbox = {
      exec: async () => ({
        output: async () => ({ stdout: "late", stderr: "", exitCode: 0, timedOut: false, truncated: false }),
      }),
    };
    let late!: Promise<unknown>;
    h.instance.execThreadImpl = async () => {
      late = h.instance.run(["echo", "late"]).catch((error: Error) => ({ error: error.message }));
      await entered;
      return { stdout: "parent finished", stderr: "", exitCode: 0, truncated: false };
    };
    expect(await h.instance.execThread(threadKey, "echo work", 1000, undefined, undefined, owner)).toEqual({
      stdout: "parent finished",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    release();
    expect(await late).toEqual({ error: "run cancelled" });
    h.instance.execThreadImpl = async () => h.instance.run(["echo", "next"]);
    expect(await h.instance.execThread(threadKey, "echo next", 1000, undefined, undefined, owner)).toMatchObject({
      stdout: "late",
      exitCode: 0,
    });
  });
  it.each(["cancelled", "busy", "unreachable"])(
    "closes a refused publication scope without replaying it: %s",
    async (refusal) => {
      const h = harness();
      h.instance.run = Object.getPrototypeOf(h.instance).run;
      h.instance.processSandbox = {
        exec: async (argv: string[]) => {
          const push = argv.some((v) => v.startsWith("https://door.example/"));
          if (push && refusal === "busy") throw new Error("taking too long to accept the connection");
          if (push && refusal === "unreachable") {
            const error = new Error("connect refused before dispatch");
            error.name = "FixtureRuntimeUnreachable";
            throw error;
          }
          return {
            output: async () => {
              if (refusal === "cancelled" && argv[0] === "test")
                h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: ticket });
              return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
            },
          };
        },
      };
      const publication = h.instance.publishThread(
        threadKey,
        {
          repo: "owner/name",
          doorOrigin: "https://door.example",
          branch: "fix/owned",
          next: "a".repeat(40),
          bearer: "effect-test-token",
        },
        owner,
      );
      if (refusal === "cancelled") expect(await publication).toMatchObject({ status: 409, error: "run cancelled" });
      else await expect(publication).rejects.toThrow();
      expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toHaveLength(
        refusal === "cancelled" ? 0 : 1,
      );
      h.instance.run = async () => ({ exitCode: 0, timedOut: false, truncated: false });
      expect(await h.instance.cancelRun(ticket, physical)).toEqual({
        stopped: true,
        cancellationId: ticket.id,
        disposition: "processes-stopped",
      });
    },
  );
  it.each(["failed", "timeout", "lost"])(
    "closes publication execution and retains its uncertain effect: %s",
    async (outcome) => {
      const h = harness();
      h.instance.run = Object.getPrototypeOf(h.instance).run;
      h.instance.processSandbox = {
        exec: async (argv: string[]) => ({
          output: async () => {
            const push = argv.some((v) => v.startsWith("https://door.example/"));
            if (push && outcome === "lost") throw new Error("publication result lost");
            return {
              stdout: "",
              stderr: "",
              exitCode: push ? 1 : 0,
              timedOut: push && outcome === "timeout",
              truncated: false,
            };
          },
        }),
      };
      const publication = h.instance.publishThread(
        threadKey,
        {
          repo: "owner/name",
          doorOrigin: "https://door.example",
          branch: "fix/owned",
          next: "a".repeat(40),
          bearer: "effect-test-token",
        },
        owner,
      );
      if (outcome === "lost") await expect(publication).rejects.toThrow("publication result lost");
      else expect(await publication).toMatchObject({ exitCode: outcome === "timeout" ? 124 : 1 });
      h.instance.run = async () => ({ exitCode: 0, timedOut: false, truncated: false });
      const original = structuredClone([...h.rows].filter(([key]) => key.startsWith("native-operation:")));
      expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: true });
      for (const [key, value] of original) expect(h.rows.get(key)).toEqual(value);
    },
  );
  it.each([undefined, "b".repeat(40)])(
    "closes already-begun privileged publication without awaiting its output: lease=%s",
    async (old) => {
      const h = harness();
      let entered!: () => void;
      let complete!: () => void;
      const begun = new Promise<void>((r) => {
        entered = r;
      });
      const settled = new Promise<void>((r) => {
        complete = r;
      });
      const commands: string[][] = [];
      h.instance.run = Object.getPrototypeOf(h.instance).run;
      h.instance.waitForThreadDrain = Object.getPrototypeOf(h.instance).waitForThreadDrain;
      h.instance.ctx.container.exec = async (argv: string[]) => {
        if (argv.some((v) => v.includes("kill -9 -1"))) complete();
        return { exitCode: Promise.resolve(0) };
      };
      h.instance.processSandbox = {
        exec: async (argv: string[]) => {
          commands.push(argv);
          const publishing = argv.some((v) => v.startsWith("https://door.example/"));
          if (publishing) entered();
          return {
            output: async () => {
              if (publishing) await settled;
              return {
                stdout: "",
                stderr: "",
                exitCode: argv.some((v) => v.includes("kill -9 -1")) ? 137 : 0,
                timedOut: false,
                truncated: false,
              };
            },
          };
        },
      };
      const published = h.instance.publishThread(
        threadKey,
        {
          repo: "owner/name",
          doorOrigin: "https://door.example",
          branch: "fix/owned",
          next: "a".repeat(40),
          ...(old ? { old } : {}),
          bearer: "effect-test-token",
        },
        owner,
      );
      await begun;
      expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toHaveLength(1);
      const stopped = await h.instance.cancelRun(ticket, physical);
      complete();
      expect(await published).toEqual({ stdout: "", stderr: "", exitCode: 0, truncated: false });
      expect(stopped).toEqual({ stopped: true, cancellationId: ticket.id, disposition: "processes-stopped" });
      expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toHaveLength(1);
      const git = commands.find((argv) => argv.some((v) => v.startsWith("https://door.example/")))!;
      expect(git.at(-1)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/fix/owned");
      if (old)
        expect(git).toContain("--force-with-lease=refs/heads/fix/owned:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    },
  );
  it.each(["text read", "binary read", "write"])(
    "refuses a %s resumed after cancellation before native execution",
    async (kind) => {
      const h = harness();
      let entered!: () => void;
      let release!: () => void;
      const begun = new Promise<void>((r) => {
        entered = r;
      });
      const pending = new Promise<void>((r) => {
        release = r;
      });
      const preflight = h.instance.threadPreflight;
      h.instance.threadPreflight = async () => {
        entered();
        await pending;
        return preflight();
      };
      h.instance.run = Object.getPrototypeOf(h.instance).run;
      const commands: string[][] = [];
      h.instance.ctx.container.exec = async (argv: string[]) => {
        if (argv.some((v) => v.includes("kill -9 -1"))) commands.push(argv);
        return { exitCode: Promise.resolve(0) };
      };
      h.instance.processSandbox = {
        exec: async (argv: string[]) => {
          commands.push(argv);
          return {
            output: async () => ({
              stdout: "",
              stderr: "",
              exitCode: argv.some((v) => v.includes("kill -9 -1")) ? 137 : 0,
              timedOut: false,
              truncated: false,
            }),
          };
        },
      };
      const data =
        kind === "write"
          ? h.instance.writeThreadFile(threadKey, "owned.txt", "owned", owner)
          : h.instance.readThreadFile(threadKey, "owned.txt", kind === "binary read" ? "base64" : "utf8", owner);
      await begun;
      expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: false });
      release();
      expect(await data).toMatchObject({ error: "run cancelled", status: 409 });
      expect(commands).toEqual([
        [
          "/usr/bin/timeout",
          "-s",
          "KILL",
          "1",
          "/bin/sh",
          "-c",
          'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; /usr/bin/su -s /bin/bash "$2" -c "kill -9 -1"; case "$?" in 0|137) exit 0;; *) exit 1;; esac',
          "--",
          "vm-a",
          "worker2",
        ],
      ]);
      expect(await h.instance.cancelRun(ticket, physical)).toEqual({
        stopped: true,
        cancellationId: ticket.id,
        disposition: "processes-stopped",
      });
    },
  );
  it("requires an independent native UID and physical-container observation after the final kill", async () => {
    const h = harness();
    const nativeCommands: string[][] = [];
    h.instance.ctx.container.exec = async (argv: string[]) => {
      nativeCommands.push(argv);
      return { exitCode: Promise.resolve(argv.some((arg) => arg.includes("/usr/bin/pgrep")) ? 2 : 0) };
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "native-observation-unconfirmed" },
    });
    expect(nativeCommands.filter((argv) => argv[6].includes("kill -9"))).toHaveLength(2);
    expect(nativeCommands.at(-1)?.slice(-2)).toEqual(["vm-a", "worker2"]);
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(0) });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
  });
});

describe("resident run cancellation", () => {
  it("binds an unfinished legacy stop only after the original target is verified", async () => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    const key = `cancelled:${threadKey}:${owner.runId}`;
    h.rows.set(key, { cancellation: ticket, failure: { phase: "resident", cause: "kill-unconfirmed" } });
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(0) });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
    expect(h.rows.get(key)).toEqual({
      cancellation: ticket,
      target: shutdownTarget,
      failure: { phase: "resident", cause: "kill-unconfirmed" },
      stopped: true,
      disposition: "processes-stopped",
    });
    h.rows.delete(`thread:${threadKey}`);
    h.rows.delete(`runReg:${threadKey}`);
    h.instance.ctx.container.exec = async () => {
      throw new Error("confirmed original stop must not signal again");
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
  });
  it("does not bind an old stop to ownership that changes during admission", async () => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    const key = `cancelled:${threadKey}:${owner.runId}`;
    const intent = { cancellation: ticket };
    h.rows.set(key, intent);
    h.instance.poolUserOwnerMatches = async () => {
      h.rows.set(`runFence:${threadKey}`, { ...owner, ownerFence: 8 });
      return true;
    };
    h.instance.ctx.container.exec = async () => {
      throw new Error("changed ownership must not reach native control");
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "target-changed" },
    });
    expect(h.rows.get(key)).toEqual(intent);
    expect(h.rows.get(`runFence:${threadKey}`)).toEqual({ runId: "run-old", ownerGen: "gen-old", ownerFence: 8 });
  });
  it.each([
    { ref: "another-ref" },
    { user: "worker3" },
    { container: "another-machine" },
    { workspace: "/workspace/another-target" },
    { ownerGen: "another-generation" },
    { ownerFence: 8 },
  ])("does not reuse a saved shutdown for a different physical target: %j", async (changed) => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    const key = `cancelled:${threadKey}:${owner.runId}`;
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(0) });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
    const receipt = structuredClone(h.rows.get(key));
    h.instance.ctx.container.exec = async () => {
      throw new Error("a changed target must not reach native control");
    };
    expect(await h.instance.cancelRun(ticket, { ...physical, ...changed })).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "target-changed" },
    });
    expect(h.rows.get(key)).toEqual(receipt);
  });
  it("keeps a runtime observation fault under the fenced ticket without leaking its error", async () => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    h.instance.hydration = null;
    h.instance.waitForThreadDrain = async () => {
      throw new Error("Bearer fixture-private-token");
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "runtime-unconfirmed" },
    });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toEqual({
      cancellation: ticket,
      target: shutdownTarget,
      failure: { phase: "resident", cause: "runtime-unconfirmed" },
    });
    expect(h.rows.get(`cancelled-thread:${threadKey}`)).toBe(true);
  });
  it("keeps the stop pending when saving its runtime failure also fails", async () => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    h.instance.hydration = null;
    h.instance.waitForThreadDrain = async () => {
      h.instance.ctx.storage.transaction = async () => {
        throw new Error("Bearer fixture-storage-token");
      };
      throw new Error("Bearer fixture-runtime-token");
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "runtime-unconfirmed" },
    });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toEqual({
      cancellation: ticket,
      target: shutdownTarget,
    });
    expect(h.rows.get(`cancelled-thread:${threadKey}`)).toBe(true);
    expect(h.rows.get(`thread:${threadKey}`).user).toBe("worker2");
  });
  it("does not downgrade a committed shutdown receipt while recording a runtime fault", async () => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    const receipt = { cancellation: ticket, target: shutdownTarget, stopped: true, disposition: "runtime-retired" };
    h.instance.hydration = null;
    h.instance.waitForThreadDrain = async () => {
      h.rows.set(`cancelled:${threadKey}:${owner.runId}`, receipt);
      throw new Error("runtime reply lost after shutdown committed");
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toEqual(receipt);
  });
  it("does not accept corrupt or foreign cached shutdown state", async () => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    const key = `cancelled:${threadKey}:${owner.runId}`;
    h.rows.set(key, { cancellation: ticket, stopped: 42, disposition: "processes-stopped" });
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(2) });
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: false,
      refusal: { phase: "resident", cause: "kill-unconfirmed" },
    });
    const foreign = { cancellation: { ...ticket, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, stopped: true };
    h.rows.set(key, foreign);
    h.instance.ctx.container.exec = async () => {
      throw new Error("foreign ticket must not reach native control");
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "ticket-conflict" },
    });
    expect(h.rows.get(key)).toEqual(foreign);
    h.rows.set(key, { cancellation: ticket, stopped: true, disposition: "runtime-retired" });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "custody-unverified" },
    });
    h.rows.set(key, { cancellation: ticket, target: shutdownTarget, stopped: true, disposition: "runtime-retired" });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
  });
  it.each(["boot guard", "native exception"])(
    "retains the exact failed kill observation under its original ticket: %s",
    async (failure) => {
      const h = harness();
      const ticket = {
        version: 1 as const,
        id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        runId: owner.runId,
        threadKey,
        ownerGen: owner.ownerGen,
        startedAt: 1,
        actor: { kind: "chat" as const, id: "slack:operator" },
      };
      h.instance.ctx.container.exec = async () => {
        if (failure === "native exception") throw new Error("Bearer fixture-private-token");
        return { exitCode: Promise.resolve(2) };
      };
      const observation =
        failure === "boot guard"
          ? {
              step: "initial-kill",
              phase: "exit",
              cause: "exit-unconfirmed",
              exitCode: 2,
              retirement: "native-exec-failed",
            }
          : { step: "initial-kill", phase: "launch", cause: "native-exec-failed", retirement: "native-exec-failed" };
      const result = await h.instance.cancelRun(ticket, physical);
      expect(result).toEqual({
        stopped: false,
        cancellationId: ticket.id,
        refusal: { phase: "resident", cause: "kill-unconfirmed" },
        observation,
      });
      const durable = JSON.parse(JSON.stringify(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)));
      expect(durable).toEqual({
        cancellation: ticket,
        target: shutdownTarget,
        failure: { phase: "resident", cause: "kill-unconfirmed" },
        observation,
      });
      expect(JSON.stringify([result, durable])).not.toContain("fixture-private-token");
      expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
    },
  );
  it("stops the original UID through native control when SDK execution is unavailable", async () => {
    const h = harness();
    const ticket = {
      version: 1,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat", id: "slack:operator" },
    };
    const before = structuredClone(h.rows.get("thread:" + threadKey));
    h.instance.waitForThreadDrain = async () => 0;
    h.instance.run = async () => {
      throw new Error("SDK control is unavailable");
    };
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(0) });

    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      disposition: "processes-stopped",
    });
    expect(h.rows.get("thread:" + threadKey)).toEqual({ ...before, lastRunOwner: h.rows.get("runReg:" + threadKey) });
    expect(h.rows.get("runFence:" + threadKey)).toEqual({ runId: "run-old", ownerGen: "gen-old", ownerFence: 7 });
    expect(h.warnings).toEqual([]);
  });
  it("reconciles the same failed ticket after restart from verified runtime retirement", async () => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(2) });
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({
      stopped: false,
      observation: { step: "initial-kill", phase: "exit", exitCode: 2 },
    });
    const restored = harness();
    restored.rows.clear();
    for (const [key, value] of JSON.parse(JSON.stringify([...h.rows]))) restored.rows.set(key, value);
    restored.instance.hydration = null;
    restored.instance.getStatus = async () => ({ state: "warm" });
    restored.instance.recreateAdmission = { blocked: async () => false };
    restored.instance.ctx.container.exec = async () => ({
      exitCode: Promise.resolve(0),
      output: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("cccccccc-cccc-4ccc-8ccc-cccccccccccc\n").buffer,
        stderr: new ArrayBuffer(0),
      }),
    });
    expect(await restored.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
    expect(restored.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toMatchObject({
      cancellation: ticket,
      stopped: true,
      disposition: "runtime-retired",
      observation: { step: "initial-kill", phase: "exit", cause: "exit-unconfirmed", exitCode: 2 },
    });
    restored.instance.ctx.container.exec = async () => {
      throw new Error("closed receipt must not signal again");
    };
    expect(await restored.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "runtime-retired",
    });
    expect(restored.rows.get("runReg:" + threadKey)).toMatchObject(owner);
  });
  it.each([
    { exitCode: 10, retirement: "boot-read-unconfirmed" },
    { exitCode: 12, retirement: "original-runtime-present" },
    { exitCode: 3, retirement: "uid-presence-unconfirmed" },
  ])("records why retirement was unconfirmed without inventing a native ending: %j", async (failure) => {
    const h = harness();
    const ticket = {
      version: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: owner.ownerGen,
      startedAt: 1,
      actor: { kind: "chat" as const, id: "slack:operator" },
    };
    h.instance.hydration = null;
    h.instance.getStatus = async () => ({ state: "warm" });
    h.instance.recreateAdmission = { blocked: async () => false };
    h.instance.ctx.container.exec = async (argv: string[]) => {
      const exitCode = argv[6].startsWith("boot=") ? failure.exitCode : 2;
      return {
        exitCode: Promise.resolve(exitCode),
        output: async () => ({ exitCode, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }),
      };
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: false,
      cancellationId: ticket.id,
      refusal: { phase: "resident", cause: "kill-unconfirmed" },
      observation: {
        step: "initial-kill",
        phase: "exit",
        cause: "exit-unconfirmed",
        exitCode: 2,
        retirement: failure.retirement,
      },
    });
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toMatchObject({
      cancellation: ticket,
      failure: { phase: "resident", cause: "kill-unconfirmed" },
      observation: { retirement: failure.retirement },
    });
  });
  it("kills only the exact registered UID and keeps its files and spend ownership", async () => {
    const h = harness();
    const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const registration = { ...h.rows.get("runReg:" + threadKey), runId };
    h.rows.set("runReg:" + threadKey, registration);
    h.rows.set("runFence:" + threadKey, { ...owner, runId });
    const ticket = {
      version: 1,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId,
      threadKey,
      ownerGen: "gen-old",
      startedAt: 1,
      actor: { kind: "chat", id: "slack:operator" },
    };
    Object.assign(h.instance, {
      withDeployAdmission: async (fn: () => Promise<unknown>) => fn(),
      poolUserOwnerMatches: async (user: string, claimant: string) =>
        user === "worker2" && claimant === "thread:" + threadKey,
      workspaceExclusiveOpsInFlight: new Set(),
      waitForThreadDrain: async () => 0,
    });
    const commands: unknown[] = [];
    h.instance.ctx.container.exec = async (command: string[]) => {
      const kill = command.some((v) => v.includes("kill -9 -1"));
      if (kill) commands.push(command);
      return { exitCode: Promise.resolve(0) };
    };
    expect(await h.instance.cancelRun(ticket, { ...physical, ownerFence: 8 })).toMatchObject({ stopped: false });
    expect(h.rows.get("runReg:" + threadKey)).toEqual(registration);
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      disposition: "processes-stopped",
    });
    expect(commands).toEqual([
      [
        "/usr/bin/timeout",
        "-s",
        "KILL",
        "1",
        "/bin/sh",
        "-c",
        'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; /usr/bin/su -s /bin/bash "$2" -c "kill -9 -1"; case "$?" in 0|137) exit 0;; *) exit 1;; esac',
        "--",
        "vm-a",
        "worker2",
      ],
      [
        "/usr/bin/timeout",
        "-s",
        "KILL",
        "1",
        "/bin/sh",
        "-c",
        'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; /usr/bin/su -s /bin/bash "$2" -c "kill -9 -1"; case "$?" in 0|137) exit 0;; *) exit 1;; esac',
        "--",
        "vm-a",
        "worker2",
      ],
    ]);
    expect(h.rows.get("thread:" + threadKey)).toMatchObject({
      user: "worker2",
      worktreePath: "/workspace/threads/t/main",
      lastRunOwner: { runId },
    });
    expect(h.rows.get(`cancelled:${threadKey}:${runId}`)).toMatchObject({
      stopped: true,
      cancellation: { id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" },
    });
  });
  it("an uncertain native kill keeps registration and the persistent cancellation fence", async () => {
    const h = harness();
    const ticket = {
      version: 1,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      threadKey,
      ownerGen: "gen-old",
      startedAt: 1,
      actor: { kind: "chat", id: "slack:operator" },
    };
    Object.assign(h.instance, {
      withDeployAdmission: async (fn: () => Promise<unknown>) => fn(),
      poolUserOwnerMatches: async () => true,
      workspaceExclusiveOpsInFlight: new Set(),
      waitForThreadDrain: async () => 0,
    });
    h.instance.ctx.container.exec = async () => {
      const exitCode = Promise.reject(new Error("native result lost"));
      return {
        exitCode,
        output: async () => {
          await exitCode;
          return { exitCode: 0, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) };
        },
      };
    };
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: false });
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toMatchObject({
      cancellation: { id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" },
    });
    expect(h.warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: "resident.uid-kill.unconfirmed",
        cause: "native-exec-failed",
        phase: "exit",
        user: "worker2",
        threadKey: "slack:C1:123",
      },
    ]);
  });
});

describe("resident force detach shutdown", () => {
  it.each([
    "wrong boot",
    "timeout",
    "lost response",
    "launch timeout",
    "native timeout exit",
    "missing boot",
    "stopped runtime",
    "runtime stopped after exit",
  ])("keeps the workspace when shutdown is unconfirmed: %s", async (outcome) => {
    const h = harness();
    if (outcome === "missing boot") delete h.rows.get("thread:" + threadKey).container;
    if (outcome === "stopped runtime") h.instance.ctx.container.running = false;
    h.instance.threadOpsInFlight.set(threadKey, 1);
    h.instance.waitForThreadDrain = async () => {
      h.instance.threadOpsInFlight.delete(threadKey);
      return 0;
    };
    h.instance.isRuntimeActive = async () => true;
    h.instance.evictBinding = async () => {
      h.rows.delete("thread:" + threadKey);
      return "removed";
    };
    h.instance.ctx.container.exec = async () => {
      if (outcome === "lost response") throw new Error("native reply lost: Bearer fixture-private-token");
      if (outcome === "launch timeout") return new Promise(() => {});
      if (outcome === "runtime stopped after exit")
        return {
          exitCode: Promise.resolve().then(() => {
            h.instance.ctx.container.running = false;
            return 0;
          }),
        };
      return {
        exitCode:
          outcome === "timeout" ? new Promise(() => {}) : Promise.resolve(outcome === "native timeout exit" ? 137 : 2),
      };
    };
    expect(
      await h.instance.detachThread(threadKey, true, [], owner.runId, owner.ownerGen, owner.ownerFence),
    ).toMatchObject({ status: 503, error: "runtime-stop-unconfirmed: force detach kept the workspace" });
    expect(h.rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2", worktreePath: physical.workspace });
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
    expect(h.warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: "resident.uid-kill.unconfirmed",
        user: "worker2",
        threadKey: "slack:C1:123",
        ...(outcome === "runtime stopped after exit"
          ? { phase: "exit", cause: "runtime-unavailable", exitCode: 0 }
          : outcome === "missing boot"
            ? { phase: "guard", cause: "target-unverified" }
            : outcome === "stopped runtime"
              ? { phase: "guard", cause: "runtime-unavailable" }
              : outcome === "launch timeout"
                ? { phase: "launch", cause: "timeout" }
                : outcome === "timeout"
                  ? { phase: "exit", cause: "timeout" }
                  : outcome === "lost response"
                    ? { phase: "launch", cause: "native-exec-failed" }
                    : {
                        phase: "exit",
                        cause: "exit-unconfirmed",
                        exitCode: outcome === "native timeout exit" ? 137 : 2,
                      }),
      },
    ]);
  });
  it("continues to the workspace preservation decision after a confirmed kill and drain", async () => {
    const h = harness();
    h.instance.threadOpsInFlight.set(threadKey, 1);
    h.instance.waitForThreadDrain = async () => {
      h.instance.threadOpsInFlight.delete(threadKey);
      return 0;
    };
    h.instance.isRuntimeActive = async () => true;
    h.instance.run = async () => ({ exitCode: 137, timedOut: false, truncated: false });
    h.instance.evictBinding = async () => "preserved";
    expect(await h.instance.detachThread(threadKey, true, [], owner.runId, owner.ownerGen, owner.ownerFence)).toEqual({
      released: false,
      reason: "workspace-preservation: owner or saved work is not verified",
      user: "worker2",
    });
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
  });
});

describe("resident terminal metadata reconciliation", () => {
  it("advances a durable bounded watchdog cursor so later bindings are not starved", async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      const key = "slack:A" + String(i).padStart(2, "0");
      h.rows.set("thread:" + key, { ...h.rows.get("thread:" + threadKey), threadKey: key });
    }
    await h.instance.watchdogCheck();
    expect(h.events).not.toContain("ack");
    expect(h.rows.get("settlement-cursor")).toBe("thread:slack:A19");
    await h.instance.watchdogCheck();
    expect(h.ackedRevision()).toBe(1);
    expect(h.rows.has("settlement-cursor")).toBe(false);
  });
  it("a delayed activity write cannot erase newly applied workspace facts", async () => {
    const h = harness();
    const stale = structuredClone(h.rows.get("thread:" + threadKey));
    await h.instance.watchdogCheck();
    const actualPut = Object.getPrototypeOf(h.instance).putThreadBinding;
    await actualPut.call(h.instance, { ...stale, lastAttachAt: "later" });
    expect(h.rows.get("thread:" + threadKey).workspaceSettlement).toMatchObject({ owner, revision: 1 });
    expect(h.rows.get("thread:" + threadKey).ownBranches).toHaveLength(1);
  });
  it("keeps predecessor references and compact proof through evicted reallocation", async () => {
    const h = harness();
    const before = h.rows.get("thread:" + threadKey);
    const refs = [{ owner, binding: physical }];
    h.rows.set("thread:" + threadKey, {
      ...before,
      evicted: true,
      user: "",
      workspacePredecessors: refs,
      workspaceSettlement: ending,
      lastRunOwner: owner,
    });
    await h.instance.allocateThreadUser(threadKey, "main", physical.workspace, "default");
    expect(h.rows.get("thread:" + threadKey)).toMatchObject({
      workspacePredecessors: refs,
      workspaceSettlement: ending,
      lastRunOwner: owner,
    });
  });
  it("never removes a clean tree while its publication projection is incomplete", async () => {
    const h = harness({ incomplete: true });
    const decision = await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey));
    expect(decision.removable).toBe(false);
  });
  it("keeps a current-owner tree until readback proves every terminal revision was acknowledged", async () => {
    const options = { refusedAck: true, versions: 1 };
    const h = harness(options);
    await h.instance.watchdogCheck();
    expect(h.rows.get("thread:" + threadKey).workspaceSettlement).toMatchObject({ revision: 1 });
    options.versions = 2;
    expect((await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey))).removable).toBe(false);
    options.refusedAck = false;
    await h.instance.watchdogCheck();
    expect(h.ackedRevision()).toBe(1);
    expect((await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey))).removable).toBe(false);
    await h.instance.watchdogCheck();
    expect(h.ackedRevision()).toBe(2);
    expect((await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey))).removable).toBe(true);
  });
  it("uses retained exact proof after ACK retires the ledger obligation, but a fresh live owner wins", async () => {
    const options = { live: false };
    const h = harness(options);
    await h.instance.watchdogCheck();
    expect((await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey))).removable).toBe(true);
    options.live = true;
    expect((await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey))).removable).toBe(false);
  });

  it("retains branch facts and exact proof before ACK and before down-runtime lifecycle gates", async () => {
    const h = harness();
    await h.instance.watchdogCheck();
    expect(h.events).toContain("ack");
    expect(h.events.indexOf("ack")).toBeLessThan(h.events.indexOf("lifecycle"));
    expect(h.instance.run).not.toHaveBeenCalled();
  });
  it("reconciles an accepted but lost ACK from durable proof without duplicating branch facts", async () => {
    const h = harness({ lostAck: true });
    await h.instance.watchdogCheck();
    await h.instance.watchdogCheck();
    expect(h.events.filter((e) => e === "ack")).toHaveLength(1);
    expect(h.ackedRevision()).toBe(1);
    expect(h.rows.get("thread:" + threadKey).ownBranches).toHaveLength(1);
    expect(h.rows.get("thread:" + threadKey).workspaceSettlement).toMatchObject({ owner, revision: 1 });
  });
  it.each([{ live: true }, { mismatch: true }, { capacity: true }])(
    "keeps facts and withholds ACK when evidence refuses: %j",
    async (options) => {
      const h = harness(options);
      const before = structuredClone(h.rows.get("thread:" + threadKey));
      await h.instance.watchdogCheck();
      expect(h.events).not.toContain("ack");
      expect(h.rows.get("thread:" + threadKey)).toEqual(before);
    },
  );
  it("withholds cleanup when malformed live state returns unknown despite cached terminal proof", async () => {
    const options = { corruptLive: false };
    const h = harness(options);
    await h.instance.watchdogCheck();
    options.corruptLive = true;
    expect((await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey))).removable).toBe(false);
  });
  it("does not treat a successful attach with unknown incarnation as a legacy binding", async () => {
    const h = harness();
    h.rows.set("runReg:" + threadKey, { threadKey, ...owner, workspace: null });
    expect((await h.instance.workspaceRemovalDecision(h.rows.get("thread:" + threadKey))).removable).toBe(false);
  });
  it("keeps discovery until every terminal revision of a predecessor is acknowledged", async () => {
    const h = harness({ versions: 2 });
    const binding = h.rows.get("thread:" + threadKey);
    h.rows.set("thread:" + threadKey, { ...binding, workspacePredecessors: [{ owner, binding: physical }] });
    h.rows.set("runReg:" + threadKey, {
      threadKey,
      runId: "run-next",
      ownerGen: "gen-next",
      ownerFence: 8,
      workspace: { ...physical, ownerGen: "gen-next", ownerFence: 8 },
    });
    await h.instance.watchdogCheck();
    expect(h.rows.get("thread:" + threadKey).workspacePredecessors).toHaveLength(1);
    await h.instance.watchdogCheck();
    expect(h.rows.get("thread:" + threadKey).workspacePredecessors).toEqual([]);
    expect(h.events.filter((event) => event === "ack")).toHaveLength(2);
  });
  it.each([true, false])("coalesces a same-run fence only with exact live ledger succession: %s", async (proven) => {
    const next = { runId: owner.runId, ownerGen: "gen-next", ownerFence: 8 };
    const nextPhysical = { ...physical, ownerGen: next.ownerGen, ownerFence: next.ownerFence };
    const h = harness({
      liveReply: {
        kind: "live",
        row: {
          workspaceThreadKey: threadKey,
          runId: next.runId,
          ownerGen: next.ownerGen,
          binding: { ...nextPhysical, container: proven ? "vm-a" : "vm-other" },
        },
      },
    });
    h.rows.set("thread:" + threadKey, {
      ...h.rows.get("thread:" + threadKey),
      workspacePredecessors: [{ owner, binding: physical }],
    });
    h.rows.set("runReg:" + threadKey, { threadKey, ...next, workspace: nextPhysical });
    await h.instance.watchdogCheck();
    expect(h.rows.get("thread:" + threadKey).workspacePredecessors).toHaveLength(proven ? 0 : 1);
    expect(h.events).not.toContain("ack");
  });
  it("coalesces exact same-run succession even when the successor ended before the watchdog", async () => {
    const h = harness({ successorEnded: true });
    const next = { runId: owner.runId, ownerGen: "gen-next", ownerFence: 8 };
    h.rows.set("thread:" + threadKey, {
      ...h.rows.get("thread:" + threadKey),
      workspacePredecessors: [{ owner, binding: physical }],
    });
    h.rows.set("runReg:" + threadKey, {
      threadKey,
      ...next,
      workspace: { ...physical, ownerGen: next.ownerGen, ownerFence: next.ownerFence },
    });
    await h.instance.watchdogCheck();
    expect(h.rows.get("thread:" + threadKey).workspacePredecessors).toEqual([]);
    expect(h.rows.get("thread:" + threadKey).workspaceSettlement).toMatchObject({ owner: next });
    expect(h.events).toContain("ack");
    expect(h.ackedRevision()).toBe(1);
  });
  it("keeps malformed physical predecessor evidence instead of matching missing fields", async () => {
    const next = { runId: owner.runId, ownerGen: "gen-next", ownerFence: 8 };
    const h = harness({
      liveReply: {
        kind: "live",
        row: {
          runId: owner.runId,
          workspaceThreadKey: threadKey,
          ownerGen: next.ownerGen,
          binding: { backend: "resident", ownerGen: next.ownerGen, ownerFence: 8 },
        },
      },
    });
    h.rows.set("thread:" + threadKey, {
      ...h.rows.get("thread:" + threadKey),
      workspacePredecessors: [{ owner, binding: {} }],
    });
    h.rows.set("runReg:" + threadKey, { threadKey, ...next, workspace: { ownerGen: next.ownerGen, ownerFence: 8 } });
    await h.instance.watchdogCheck();
    expect(h.rows.get("thread:" + threadKey).workspacePredecessors).toHaveLength(1);
  });
  it("refuses owner transfer at predecessor capacity without changing registration or facts", async () => {
    const h = harness();
    h.rows.set("thread:" + threadKey, {
      ...h.rows.get("thread:" + threadKey),
      workspacePredecessors: Array.from({ length: 20 }, (_, i) => ({
        owner: { runId: "pending-" + i, ownerGen: "g1", ownerFence: i + 100 },
        binding: null,
      })),
    });
    const before = structuredClone([...h.rows]);
    await expect(h.instance.registerRun(threadKey, 1000, "run-next", "gen-next", 8)).rejects.toThrow(
      "workspace-settlement-capacity",
    );
    expect([...h.rows]).toEqual(before);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("carries the predecessor before a later registration overwrites its physical owner", async () => {
    const h = harness();
    await h.instance.registerRun(threadKey, 1000, "run-new", "gen-new", 8);
    expect(h.rows.get("thread:" + threadKey).workspacePredecessors).toEqual([{ owner, binding: physical }]);
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject({ runId: "run-new", ownerFence: 8 });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("explicit absent-workspace discard", () => {
  const input = {
    confirmDiscard: true,
    threadKey,
    runId: owner.runId,
    ownerGen: owner.ownerGen,
    ownerFence: owner.ownerFence,
    ref: physical.ref,
    user: physical.user,
    container: physical.container,
    lastAttachAt: "today",
  };
  function setup(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options);
    h.rows.set("pool-binding:worker2", [threadKey]);
    h.rows.set("pool-users-spent", [{ user: "worker2", owner: "thread:" + threadKey }]);
    h.rows.get("thread:" + threadKey).workspaceSettlement = {
      ...ending,
      publication: { ...ending.publication, complete: false },
    };
    Object.assign(h.instance, {
      opUsersInUse: new Map(),
      hydration: null,
      destroying: null,
      getStatus: async () => ({ state: "warm" }),
      recreateAdmission: { blocked: async () => false },
      isRuntimeActive: async () => true,
      containerIdentity: async () => "vm-new",
      run: async () => ({ stdout: "vm-new\n", stderr: "", exitCode: 0 }),
      observeAbsentPrivateTree: async () => true,
      withMirrorLock: async (fn: () => Promise<unknown>) => ({ value: await fn(), waitedMs: 0 }),
    });
    return h;
  }
  it("rejects extra caller data before storing a loss receipt", async () => {
    const { instance, rows } = setup();
    expect(await instance.discardAbsentBinding({ ...input, extra: "private caller data" })).toEqual({
      discarded: false,
      reason: "invalid-input",
    });
    expect(rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2" });
    expect(rows.get("discarded:" + threadKey + ":" + owner.runId)).toBeUndefined();
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true });
  });
  it("reports exact terminal owner for confirmation before writing a loss fence", async () => {
    const { instance, rows } = setup();
    const { ownerGen: _gen, ownerFence: _fence, ...request } = input;
    expect(await instance.discardAbsentBinding(request)).toEqual({
      discarded: false,
      reason: "owner-confirmation-required",
      owner,
    });
    expect(rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2" });
    expect(rows.get("discarding:" + threadKey)).toBeUndefined();
  });
  it("retires an exact terminal absent binding without claiming publication or resetting UID ownership", async () => {
    const { instance, rows } = setup({ incomplete: true });
    expect(await instance.discardAbsentBinding(input)).toMatchObject({
      discarded: true,
      runId: "run-old",
      user: "worker2",
      disposition: "absent-workspace-retired",
    });
    expect(rows.get("thread:" + threadKey)).toMatchObject({
      evicted: true,
      user: "",
      evictedWhy: "operator-discard",
      workspaceSettlement: { publication: { complete: false } },
    });
    expect(rows.get("runReg:" + threadKey)).toBeUndefined();
    expect(rows.get("runFence:" + threadKey)).toEqual(owner);
    expect(rows.get("pool-users-spent")).toEqual([{ user: "worker2", owner: "thread:" + threadKey }]);
    expect(rows.get("pool-binding:worker2")).toEqual([]);
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true, runId: "run-old" });
    expect(await instance.workspaceDiscarded(threadKey, owner.runId)).toBe(true);
    expect(await instance.workspaceDiscarded(threadKey, "run-next")).toBe(false);
  });
  it("retires a confirmed legacy terminal owner without inventing an exact settlement", async () => {
    const { instance, rows, events } = setup({ legacyReply: { kind: "terminal", record: ending.record } });
    delete rows.get("thread:" + threadKey).workspaceSettlement;
    expect(await instance.workspaceRemovalDecision(rows.get("thread:" + threadKey))).toEqual({
      removable: false,
      reason: "workspace-settlement-unverified",
    });
    const { ownerGen: _gen, ownerFence: _fence, ...preview } = input;
    expect(await instance.discardAbsentBinding(preview)).toEqual({
      discarded: false,
      reason: "owner-confirmation-required",
      owner,
    });
    expect(rows.get("discarding:" + threadKey)).toBeUndefined();
    expect(await instance.discardAbsentBinding(input)).toMatchObject({
      discarded: true,
      runId: "run-old",
      disposition: "absent-workspace-retired",
    });
    expect(rows.get("runReg:" + threadKey)).toBeUndefined();
    expect(rows.get("runFence:" + threadKey)).toEqual(owner);
    expect(rows.get("thread:" + threadKey).workspaceSettlement).toBeUndefined();
    expect(rows.get("pool-users-spent")).toEqual([{ user: "worker2", owner: "thread:" + threadKey }]);
    expect(events).not.toContain("ack");
    expect(rows.get("discarded:" + threadKey + ":run-old")).toMatchObject({ completed: true, owner });
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true, owner, currentBoot: null });
  });
  it("keeps legacy files and ownership when full absence is unverified", async () => {
    const { instance, rows } = setup({ legacyReply: { kind: "terminal", record: ending.record } });
    instance.observeAbsentPrivateTree = async () => false;
    expect(await instance.discardAbsentBinding(input)).toEqual({
      discarded: false,
      reason: "private-tree-absence-unverified",
    });
    expect(rows.get("runReg:" + threadKey)).toMatchObject(owner);
    expect(rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2" });
    expect(rows.get("discarded:" + threadKey + ":run-old")).toMatchObject({ completed: false });
  });
  it.each([
    { kind: "absent", owner: { ...owner, ownerFence: 8 } },
    { kind: "absent" },
    { kind: "live", row: { runId: "run-old" } },
    { kind: "unknown" },
    { kind: "acknowledged", owner, revision: 2 },
  ])("does not read legacy history without matching exact absence: %j", async (liveReply) => {
    const { instance, rows, fetch } = setup({ liveReply });
    expect(await instance.discardAbsentBinding(input)).toEqual({ discarded: false, reason: "owner-not-terminal" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows.get("runReg:" + threadKey)).toMatchObject(owner);
    expect(rows.get("discarded:" + threadKey + ":run-old")).toBeUndefined();
  });
  it.each([
    { kind: "live", row: { runId: "run-old" } },
    { kind: "unknown" },
    { kind: "terminal", record: { ...ending.record, provisional: true } },
    { kind: "terminal", record: { ...ending.record, repo: "other/repo" } },
    { kind: "terminal", record: { ...ending.record, threadKey: "slack:OTHER:456" } },
    { kind: "terminal", record: { ...ending.record, id: "run-other" } },
    { kind: "terminal", record: { ...ending.record, status: "working" } },
  ])("keeps a legacy binding when canonical final history is unsafe: %j", async (legacyReply) => {
    const { instance, rows } = setup({ legacyReply });
    expect(await instance.discardAbsentBinding(input)).toEqual({ discarded: false, reason: "owner-not-terminal" });
    expect(rows.get("runReg:" + threadKey)).toMatchObject(owner);
    expect(rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2" });
    expect(rows.get("discarded:" + threadKey + ":run-old")).toBeUndefined();
  });
  it.each([
    "confirmation",
    "target",
    "workspace",
    "live",
    "unknown",
    "fence",
    "busy",
    "native",
    "claimant",
    "cold",
    "present",
    "boot-change",
  ])("keeps registration and ownership when %s proof fails", async (failure) => {
    const { instance, rows } = setup(
      failure === "live" ? { live: true } : failure === "unknown" ? { corruptLive: true } : {},
    );
    const request = { ...input };
    if (failure === "confirmation") request.confirmDiscard = false;
    if (failure === "target") request.lastAttachAt = "newer";
    if (failure === "workspace") rows.get("runReg:" + threadKey).workspace = { ...physical, container: "vm-other" };
    if (failure === "fence") rows.set("runFence:" + threadKey, { ...owner, ownerFence: 8 });
    if (failure === "busy") instance.threadOpsInFlight.set(threadKey, 1);
    if (failure === "native") rows.set("native-operation:" + threadKey + ":run-old:pending", owner);
    if (failure === "claimant") rows.set("pool-binding:worker2", [threadKey, "slack:OTHER:456"]);
    if (failure === "cold") instance.isRuntimeActive = async () => false;
    if (failure === "present") instance.observeAbsentPrivateTree = async () => false;
    if (failure === "boot-change") {
      let n = 0;
      instance.run = async () => ({ stdout: ++n === 1 ? "vm-new\n" : "vm-other\n", stderr: "", exitCode: 0 });
    }
    expect(await instance.discardAbsentBinding(request)).toMatchObject({
      discarded: false,
      reason: expect.any(String),
    });
    expect(rows.get("thread:" + threadKey)).toMatchObject({ user: "worker2", container: "vm-a" });
    expect(rows.get("runReg:" + threadKey)).toMatchObject(owner);
  });
  it.each(["earlier-review", "missing-owner"])(
    "rejects a delayed %s binding callback after retirement without restoring its claimant",
    async (kind) => {
      const { instance, rows } = setup();
      const stale = {
        ...structuredClone(rows.get("thread:" + threadKey)),
        ...(kind === "earlier-review"
          ? { lastRunOwner: { runId: "earlier-review", ownerGen: "gen-review", ownerFence: 6 } }
          : {}),
      };
      expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true });
      await expect(Object.getPrototypeOf(instance).putThreadBinding.call(instance, stale)).rejects.toThrow(
        "workspace discarded",
      );
      expect(rows.get("thread:" + threadKey)).toMatchObject({ evicted: true, user: "" });
      expect(rows.get("pool-binding:worker2")).toEqual([]);
    },
  );
  it("admits only a higher-fence active attachment as the successor", async () => {
    const { instance, rows } = setup();
    const unrelated = { owner: { runId: "other-private", ownerGen: "gen-other", ownerFence: 6 }, binding: null };
    rows.get("thread:" + threadKey).workspacePredecessors = [unrelated];
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true });
    const retired = structuredClone(rows.get("thread:" + threadKey));
    rows.set("pool-binding:worker3", []);
    const next = {
      ...rows.get("thread:" + threadKey),
      evicted: false,
      user: "worker3",
      lastAttachAt: "tomorrow",
      container: "vm-new",
      readonly: true,
    };
    const write = () => Object.getPrototypeOf(instance).putThreadBinding.call(instance, next);
    const scope = {
      threadKey,
      owner: { runId: "run-next", ownerGen: "gen-next", ownerFence: 8 },
      active: true,
      attachment: true,
    };
    await instance.threadOperationScope.run(scope, write);
    expect(rows.get("thread:" + threadKey)).toMatchObject({
      evicted: false,
      user: "worker3",
      lastAttachAt: "tomorrow",
    });
    expect(rows.get("pool-binding:worker3")).toEqual([threadKey]);
    expect(rows.get("thread:" + threadKey).workspaceSettlement).toBeUndefined();
    expect(rows.get("discarded:" + threadKey + ":run-old").binding.workspaceSettlement).toMatchObject({
      publication: { complete: false },
    });
    await instance.threadOperationScope.run(scope, () =>
      instance.registerRun(threadKey, undefined, "run-next", "gen-next", 8, {
        ref: "main",
        workspace: physical.workspace,
        user: "worker3",
        container: "vm-new",
      }),
    );
    expect(rows.get("runReg:" + threadKey)).toMatchObject({ runId: "run-next", ownerFence: 8 });
    expect(rows.get("thread:" + threadKey).workspacePredecessors).toEqual([unrelated]);
    instance.putThreadBinding = Object.getPrototypeOf(instance).putThreadBinding;
    instance.execThreadImpl = Object.getPrototypeOf(instance).execThreadBody;
    instance.threadPreflight = async () => ({ binding: rows.get("thread:" + threadKey) });
    instance.threadRunCapped = async () => ({ stdout: "successor-ran", stderr: "", exitCode: 0, truncated: false });
    expect(await instance.execThread(threadKey, "work", 1000, undefined, undefined, scope.owner)).toEqual({
      stdout: "successor-ran",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    expect(await instance.execThread(threadKey, "legacy work", 1000)).toEqual({
      stdout: "successor-ran",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const ticket = {
      version: 1,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: "run-next",
      threadKey,
      ownerGen: "gen-next",
      startedAt: 1,
      actor: { kind: "chat", id: "slack:operator" },
    };
    expect(
      await instance.cancelRun(ticket, {
        ref: physical.ref,
        user: "worker3",
        workspace: physical.workspace,
        container: "vm-new",
        ownerGen: "gen-next",
        ownerFence: 8,
      }),
    ).toMatchObject({ stopped: true, cancellationId: ticket.id });
    expect(rows.get("thread:" + threadKey).lastRunOwner).toMatchObject({ runId: "run-next", ownerFence: 8 });

    await Object.getPrototypeOf(instance).putThreadBinding.call(
      instance,
      { ...rows.get("thread:" + threadKey), ownBranches: [{ ref: "codex/next", pr: 9, at: "today" }] },
      true,
    );
    expect(rows.get("thread:" + threadKey).ownBranches).toEqual([{ ref: "codex/next", pr: 9, at: "today" }]);
    await expect(Object.getPrototypeOf(instance).putThreadBinding.call(instance, retired, true)).rejects.toThrow(
      "workspace discarded",
    );
    expect(rows.get("thread:" + threadKey)).toMatchObject({ user: "worker3", evicted: false });
    await expect(instance.threadOperationScope.run({ ...scope, active: false }, write)).rejects.toThrow(
      "workspace discarded",
    );
    await expect(instance.threadOperationScope.run({ ...scope, owner }, write)).rejects.toThrow("workspace discarded");
    expect(await instance.debugBackdateThread(threadKey, 1)).toEqual({
      ok: true,
      lastAttachAt: "1969-12-31T00:00:01.000Z",
    });
    expect(rows.get("thread:" + threadKey)).toMatchObject({ user: "worker3", evicted: false });
    expect(rows.get("pool-binding:worker3")).toEqual([threadKey]);
    expect(rows.get("discarded-thread:" + threadKey)).toEqual(owner);
    rows.set("discarding:" + threadKey, owner);
    expect(await instance.debugBackdateThread(threadKey, 1)).toEqual({ ok: false });
    rows.delete("discarding:" + threadKey);
    expect(rows.get("runFence:" + threadKey)).toEqual({ runId: "run-next", ownerGen: "gen-next", ownerFence: 8 });
  });
  it("reads back the durable retirement and high-water fence instead of trusting a receipt alone", async () => {
    const { instance, rows } = setup();
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true, currentBoot: "vm-new" });
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true, owner, fence: owner });
    instance.run = async () => {
      instance.ctx.container.running = true;
      return { stdout: "vm-manufactured\n", stderr: "", exitCode: 0 };
    };
    expect(await instance.discardAbsentBinding(input)).toMatchObject({
      discarded: true,
      owner,
      fence: owner,
      currentBoot: null,
    });
    const get = instance.ctx.storage.get;
    instance.ctx.storage.get = async (key: string) => {
      if (key === "runFence:" + threadKey) instance.ctx.container.running = false;
      return get(key);
    };
    expect(await instance.discardAbsentBinding(input)).toMatchObject({
      discarded: true,
      owner,
      fence: owner,
      currentBoot: null,
    });
    expect(instance.ctx.container.running).toBe(false);
    rows.delete("discarded-thread:" + threadKey);
    expect(await instance.discardAbsentBinding(input)).toEqual({
      discarded: false,
      reason: "discard-receipt-unverified",
    });
    rows.set("discarded-thread:" + threadKey, owner);
    rows.delete("runFence:" + threadKey);
    expect(await instance.discardAbsentBinding(input)).toEqual({
      discarded: false,
      reason: "discard-receipt-unverified",
    });
  });
  it("blocks old data requests and publication without touching a successor on an idempotent retry", async () => {
    const { instance, rows } = setup();
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true });
    rows.set("thread:" + threadKey, {
      ...rows.get("thread:" + threadKey),
      evicted: false,
      user: "worker3",
      lastAttachAt: "tomorrow",
    });
    rows.set("runReg:" + threadKey, { threadKey, runId: "run-next", ownerGen: "gen-next", ownerFence: 8 });
    rows.set("runFence:" + threadKey, { runId: "run-next", ownerGen: "gen-next", ownerFence: 8 });
    expect(await instance.execThread(threadKey, "touch private", 1000, undefined, undefined, owner)).toMatchObject({
      error: "run cancelled",
      status: 409,
    });
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true, runId: "run-old" });
    expect(rows.get("thread:" + threadKey)).toMatchObject({
      user: "worker3",
      evicted: false,
      lastAttachAt: "tomorrow",
    });
    expect(rows.get("runFence:" + threadKey)).toEqual({ runId: "run-next", ownerGen: "gen-next", ownerFence: 8 });
  });
  it("keeps a durable fence across a lost observation and permits only the same target retry", async () => {
    const { instance, rows } = setup();
    instance.observeAbsentPrivateTree = async () => {
      throw new Error("lost response");
    };
    expect(await instance.discardAbsentBinding(input)).toMatchObject({
      discarded: false,
      reason: "observation-unconfirmed",
    });
    expect(await instance.workspaceDiscarded(threadKey, "run-next")).toBe(true);
    await expect(
      instance.registerRun(threadKey, undefined, owner.runId, owner.ownerGen, owner.ownerFence),
    ).rejects.toThrow("workspace discarded");
    instance.observeAbsentPrivateTree = async () => true;
    expect(await instance.discardAbsentBinding(input)).toMatchObject({ discarded: true });
    expect(rows.get("runFence:" + threadKey)).toEqual(owner);
  });
});

describe("Resident recorded check result lookup", () => {
  it("reports the held check identity when substituting an unavailable result", async () => {
    const h = harness();
    const operation = { key: "c".repeat(64), commandHash: await checkCommandHash("echo private") };
    h.instance.execThreadImpl = async () => {
      throw new Error("Cookie: private-failure");
    };
    await expect(
      h.instance.execThread(threadKey, "echo private", 1000, undefined, undefined, owner, operation),
    ).rejects.toThrow("private-failure");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await h.instance.execThread(threadKey, "echo private", 1000, undefined, undefined, owner, operation),
      ).toMatchObject({ status: 409, error: "check operation outcome unavailable" });
      expect(warn.mock.calls.map((args) => [args[0], JSON.parse(String(args[1]))])).toEqual([
        [
          "[check-result]",
          {
            version: 1,
            code: "operation_result_unavailable",
            threadKey,
            runId: owner.runId,
            ownerFence: owner.ownerFence,
            operationKey: "c".repeat(64),
          },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves the original execution refusal while holding its operation alias", async () => {
    const h = harness();
    const operation = { key: "b".repeat(64), commandHash: await checkCommandHash("echo held") };
    const refusal = { error: "original runtime unavailable", status: 503, reason: "runtime-replaced", cause: "system" };
    h.instance.execThreadImpl = async () => refusal;
    expect(await h.instance.execThread(threadKey, "echo held", 1000, undefined, undefined, owner, operation)).toEqual(
      refusal,
    );
    expect(await h.instance.inspectCheckResult(threadKey, operation, owner)).toEqual({ kind: "unknown" });
  });

  it("settles the saved command by original identity and refuses changed owner or workspace evidence", async () => {
    const h = harness();
    const operation = { key: "a".repeat(64), commandHash: await checkCommandHash("echo once") };
    const result = await h.instance.execThread(threadKey, "echo once", 1000, undefined, undefined, owner, operation);
    expect(result).toEqual({ stdout: "ran", stderr: "", exitCode: 0, truncated: false });
    expect(await h.instance.inspectCheckResult(threadKey, operation, owner)).toMatchObject({
      kind: "completed",
      checkOperation: operation,
      result,
    });
    const nativeKeys = [...h.rows.entries()].filter(([key]) => key.startsWith("check-result:"));
    expect(nativeKeys[0][1].nativeKey).toMatch(/^native-operation:/);
    expect(h.rows.has(nativeKeys[0][1].nativeKey)).toBe(false);
    for (const key of ["runReg:" + threadKey, "runFence:" + threadKey, "thread:" + threadKey]) {
      const saved = structuredClone(h.rows.get(key));
      h.rows.set(key, {
        ...saved,
        ...(key.startsWith("thread:") ? { container: "other-runtime" } : { ownerFence: 99 }),
      });
      expect(await h.instance.inspectCheckResult(threadKey, operation, owner)).toEqual({ kind: "unknown" });
      h.rows.set(key, saved);
    }
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, true);
    expect(await h.instance.inspectCheckResult(threadKey, operation, owner)).toEqual({ kind: "unknown" });
  });
});

describe("shared maintenance ownership", () => {
  it("keeps shared native work outside its cancelled consumer's gate and retains its own unknown result", async () => {
    const h = harness();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    h.instance.processSandbox = {
      exec: async () => ({
        status: async () => ({ id: "shared-original", pid: 42, startedAt: "2026-10-14T00:00:00.000Z" }),
        output: async () => {
          entered = true;
          await wait;
          throw new Error("shared output lost");
        },
      }),
    };
    const shared = h.instance.withOwnedNativeOperation(threadKey, owner, () =>
      h.instance.withSharedNativeOperation(() => h.instance.run(["echo", "shared"])),
    );
    const rejected = expect(shared).rejects.toThrow("shared output lost");
    for (let n = 0; n < 80 && !entered; n++) await Promise.resolve();
    expect(entered).toBe(true);
    const active = await new NativeOperationJournal(h.instance.ctx.storage).unresolved();
    expect([...active.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...owner }),
        expect.objectContaining({ opOwner: expect.stringMatching(/^op:/) }),
      ]),
    );
    h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: { runId: owner.runId } });
    release();
    await rejected;
    const remaining = await new NativeOperationJournal(h.instance.ctx.storage).unresolved();
    expect([...remaining.values()]).toMatchObject([
      { opOwner: expect.stringMatching(/^op:/), native: { closed: true } },
    ]);
  });
});

describe("owned credential native scope", () => {
  it("returns only validated counts from the confined original inspection", async () => {
    const h = harness();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.isRuntimeActive = async () => true;
    const counts = {
      ...emptyCredentialInspection(),
      completed: true,
      bindingMatched: true,
      filesChecked: 4,
      commandEnvironments: 1,
      harnessEnvironments: 1,
      helperEntries: 2,
      unknownCount: 0,
    };
    h.rows.get("thread:" + threadKey).githubDoorHost = "door.example";
    const status = vi.fn(() => {
      throw new Error("SDK identity lookup must not run");
    });
    h.instance.processSandbox = {
      exec: async () => ({
        status,
        output: async () => ({
          stdout: JSON.stringify(counts),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
        }),
      }),
    };
    const actual = await h.instance.inspectThreadCredentials(
      threadKey,
      {
        runId: owner.runId,
        pid: 42,
        processBirth: "11111111-1111-4111-8111-111111111111:123",
        repo: "owner/name",
        ref: physical.ref,
        head: "a".repeat(40),
      },
      { GH_ENTERPRISE_TOKEN: "sbr_run-old.abcdefghijklmnopqrstuv", GH_HOST: "door.example" },
      owner,
    );
    expect(actual).toEqual(counts);
    expect(status).not.toHaveBeenCalled();
    expect((await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).size).toBe(0);
    expect([...h.rows.keys()].some((key) => key.startsWith("native-scope:"))).toBe(true);
  });
});

describe("native startup cancellation", () => {
  it("closes the reserved run while VM start is hung and refuses the released continuation", async () => {
    const h = harness();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.ctx.container.running = false;
    h.instance.execThreadImpl = () => h.instance.run(["/bin/bash", "-c", "echo late"], { nativeUser: "worker2" });
    let started = false,
      release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.instance.start = async () => {
      started = true;
      await wait;
      h.instance.ctx.container.running = true;
    };
    h.instance.processSandbox = {
      exec: vi.fn(() => {
        throw new Error("late payload must not run");
      }),
    };
    const command = h.instance.execThread(threadKey, "echo late", 1000, undefined, undefined, owner);
    for (let n = 0; n < 150 && !started; n++) await Promise.resolve();
    expect(started).toBe(true);
    const ticket = {
      version: 1,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      ...owner,
      threadKey,
      startedAt: 1,
      actor: { kind: "chat", id: "slack:operator" },
    };
    const stopped = await h.instance.cancelRun(ticket, physical);
    expect(stopped).toEqual({ stopped: true, cancellationId: ticket.id, disposition: "processes-stopped" });
    expect(h.instance.ctx.container.exec).not.toHaveBeenCalled();
    release();
    expect(await command).toMatchObject({ error: "run cancelled", status: 409 });
    expect(h.instance.processSandbox.exec).not.toHaveBeenCalled();
  });
  it("keeps an old run on its legacy stop path after its settled journal disappeared", async () => {
    const h = harness();
    h.rows.set(`native-scope-mode:${encodeURIComponent(threadKey)}:${owner.runId}`, {
      threadKey,
      runId: owner.runId,
      protocol: "legacy",
    });
    expect(
      await h.instance.cancelNativeRunScope({
        version: 1,
        id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        ...owner,
        threadKey,
        startedAt: 1,
        actor: { kind: "chat", id: "slack:operator" },
      }),
    ).toBeNull();
    expect(h.instance.ctx.container.exec).not.toHaveBeenCalled();
    expect([...h.rows.keys()].filter((key) => key.startsWith("native-scope:"))).toEqual([]);
  });
});

describe("native run generations", () => {
  it("closes every original generation of the selected run while preserving a different run", async () => {
    const h = harness();
    const scopes = new NativeRunScopes(h.instance.ctx.storage, h.instance.nativeScopeTransport());
    const old = { ...owner, ownerGen: "gen-before-reset", ownerFence: 6 };
    await scopes.birth(threadKey, old, true, async () => {});
    const oldRef = await scopes.ensure(threadKey, old, async () => {});
    const currentRef = await scopes.ensure(threadKey, owner, async () => {});
    const neighbour = { runId: "run-neighbour", ownerGen: "gen-neighbour", ownerFence: 8 };
    await scopes.birth("thread-neighbour", neighbour, true, async () => {});
    const neighbourRef = await scopes.ensure("thread-neighbour", neighbour, async () => {});
    const journal = new NativeOperationJournal(h.instance.ctx.storage);
    const oldKey = `native-operation:${threadKey}:${owner.runId}:old-unknown`;
    await journal.open(oldKey, old, threadKey);
    await journal.bindScope(oldKey, oldRef);
    await journal.begin(oldKey, "process");
    await journal.close(oldKey);
    const original = structuredClone(h.rows.get(oldKey));
    const ticket = {
      version: 1,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      ownerGen: owner.ownerGen,
      threadKey,
      startedAt: 1,
      actor: { kind: "chat", id: "slack:operator" },
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
    expect(await scopes.close(threadKey, old)).toEqual(oldRef);
    expect(await scopes.close(threadKey, owner)).toEqual(currentRef);
    expect(await scopes.ensure("thread-neighbour", neighbour, async () => {})).toEqual(neighbourRef);
    expect((await journal.unresolved()).size).toBe(0);
    expect(h.rows.get(oldKey)).toEqual(original);
    expect(await journal.readEnding(oldKey)).toEqual({ kind: "missing" });
  });
});

describe("native cancellation inventory", () => {
  it("persists stop intent before inventory can admit a new generation", async () => {
    const h = harness();
    const scopes = new NativeRunScopes(h.instance.ctx.storage, h.instance.nativeScopeTransport());
    await scopes.birth(threadKey, owner, true, async () => {});
    const originalRef = await scopes.ensure(threadKey, owner, async () => {});
    const list = h.instance.ctx.storage.list.bind(h.instance.ctx.storage);
    let checked = false,
      barred = false;
    h.instance.ctx.storage.list = async (options: any) => {
      const page = await list(options);
      if (options.prefix.startsWith("native-scope:") && !checked) {
        checked = true;
        try {
          await scopes.birth(threadKey, { ...owner, ownerGen: "gen-late", ownerFence: 8 }, true, async () => {});
        } catch (error) {
          barred = error instanceof Error && error.message === "run cancelled";
        }
      }
      return page;
    };
    const ticket = {
      version: 1,
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      runId: owner.runId,
      ownerGen: owner.ownerGen,
      threadKey,
      startedAt: 1,
      actor: { kind: "chat", id: "slack:operator" },
    };
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
    expect({ checked, barred }).toEqual({ checked: true, barred: true });
    expect(await scopes.close(threadKey, owner)).toEqual(originalRef);
    expect((await scopes.matching(threadKey, owner.runId)).length).toBe(1);
  });
});

const legacyHarness = (options: Parameters<typeof harness>[0] = {}) => harness({ ...options, native: false });

describe("legacy cancellation admission", () => {
  const ticket = {
    version: 1,
    id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    runId: owner.runId,
    threadKey,
    ownerGen: owner.ownerGen,
    startedAt: 1,
    actor: { kind: "chat", id: "slack:operator" },
  };
  const harness = legacyHarness;
  it("a known never-started refusal clears admission so a later hard stop can finish", async () => {
    const h = harness();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.processSandbox = {
      exec: async () => {
        throw new Error("taking too long to accept the connection");
      },
    };
    h.instance.execThreadImpl = async () => h.instance.run(["su", "-s", "/bin/bash", "worker2", "-c", "echo work"]);
    await expect(
      h.instance.execThread(threadKey, "echo work", 1000, undefined, undefined, owner),
    ).rejects.toMatchObject({ name: "SandboxRuntimeBusyError" });
    expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toEqual([]);
    h.instance.processSandbox = {
      exec: async () => ({
        output: async () => ({ stdout: "done", stderr: "", exitCode: 0, timedOut: false, truncated: false }),
      }),
    };
    expect(await h.instance.execThread(threadKey, "echo work", 1000, undefined, undefined, owner)).toMatchObject({
      stdout: "done",
      exitCode: 0,
    });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
  });

  it("keeps a durable hold when an actual native output is lost, even after isolate restart", async () => {
    const h = harness();
    const nativeRun = Object.getPrototypeOf(h.instance).run;
    h.instance.run = nativeRun;
    h.instance.processSandbox = {
      exec: async () => ({
        output: async () => {
          throw new Error("lost native output");
        },
      }),
    };
    h.instance.execThreadImpl = async () => h.instance.run(["su", "-s", "/bin/bash", "worker2", "-c", "echo work"]);
    await expect(h.instance.execThread(threadKey, "echo work", 1000, undefined, undefined, owner)).rejects.toThrow(
      "lost native output",
    );
    expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toHaveLength(1);
    h.instance.threadOperationScope = new AsyncLocalStorage();
    h.instance.threadOpsInFlight = new Map();
    h.instance.run = async () => ({ exitCode: 137, timedOut: false, truncated: false });
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: false });
  });

  it("settles a completed native write but retains an unknown write outcome", async () => {
    const write = async (lost: boolean) => {
      const h = harness();
      h.instance.runOk = async () => {};
      h.instance.threadRunOk = async () => {};
      h.instance.writeFile = async () => {
        if (lost) throw new Error("native write reply lost");
        return { success: true };
      };
      const result = await h.instance.writeThreadFile(threadKey, "owned.txt", "owned", owner);
      h.instance.run = async () => ({ exitCode: 137, timedOut: false, truncated: false });
      return { result, stopped: await h.instance.cancelRun(ticket, physical) };
    };
    expect(await write(false)).toEqual({
      result: { ok: true, bytes: 5 },
      stopped: { stopped: true, cancellationId: ticket.id, disposition: "processes-stopped" },
    });
    expect(await write(true)).toEqual({
      result: { error: "write-failed: Error: native write reply lost", status: 400 },
      stopped: {
        stopped: false,
        cancellationId: ticket.id,
        refusal: { phase: "resident", cause: "native-outcome-unknown" },
      },
    });
  });

  it.each(["cancelled", "busy", "unreachable"])(
    "a publication proven never started clears its hold: %s",
    async (refusal) => {
      const h = harness();
      h.instance.run = Object.getPrototypeOf(h.instance).run;
      h.instance.processSandbox = {
        exec: async (argv: string[]) => {
          const push = argv.some((v) => v.startsWith("https://door.example/"));
          if (push && refusal === "busy") throw new Error("taking too long to accept the connection");
          if (push && refusal === "unreachable") {
            const error = new Error("connect refused before dispatch");
            error.name = "FixtureRuntimeUnreachable";
            throw error;
          }
          return {
            output: async () => {
              if (refusal === "cancelled" && argv[0] === "test")
                h.rows.set(`cancelled:${threadKey}:${owner.runId}`, { cancellation: ticket });
              return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
            },
          };
        },
      };
      const publication = h.instance.publishThread(
        threadKey,
        {
          repo: "owner/name",
          doorOrigin: "https://door.example",
          branch: "fix/owned",
          next: "a".repeat(40),
          bearer: "effect-test-token",
        },
        owner,
      );
      if (refusal === "cancelled") expect(await publication).toMatchObject({ status: 409, error: "run cancelled" });
      else await expect(publication).rejects.toThrow();
      expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toEqual([]);
      h.instance.run = async () => ({ exitCode: 0, timedOut: false, truncated: false });
      expect(await h.instance.cancelRun(ticket, physical)).toEqual({
        stopped: true,
        cancellationId: ticket.id,
        disposition: "processes-stopped",
      });
    },
  );

  it.each(["failed", "timeout", "lost"])("an actual unresolved publication retains its hold: %s", async (outcome) => {
    const h = harness();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.processSandbox = {
      exec: async (argv: string[]) => ({
        output: async () => {
          const push = argv.some((v) => v.startsWith("https://door.example/"));
          if (push && outcome === "lost") throw new Error("publication result lost");
          return {
            stdout: "",
            stderr: "",
            exitCode: push ? 1 : 0,
            timedOut: push && outcome === "timeout",
            truncated: false,
          };
        },
      }),
    };
    const publication = h.instance.publishThread(
      threadKey,
      {
        repo: "owner/name",
        doorOrigin: "https://door.example",
        branch: "fix/owned",
        next: "a".repeat(40),
        bearer: "effect-test-token",
      },
      owner,
    );
    if (outcome === "lost") await expect(publication).rejects.toThrow("publication result lost");
    else expect(await publication).toMatchObject({ exitCode: outcome === "timeout" ? 124 : 1 });
    h.instance.run = async () => ({ exitCode: 0, timedOut: false, truncated: false });
    expect(await h.instance.cancelRun(ticket, physical)).toMatchObject({ stopped: false });
  });

  it.each([undefined, "b".repeat(40)])(
    "awaits already-begun privileged publication before shutdown: lease=%s",
    async (old) => {
      const h = harness();
      let entered!: () => void;
      let complete!: () => void;
      const begun = new Promise<void>((r) => {
        entered = r;
      });
      const settled = new Promise<void>((r) => {
        complete = r;
      });
      const commands: string[][] = [];
      h.instance.run = Object.getPrototypeOf(h.instance).run;
      h.instance.waitForThreadDrain = Object.getPrototypeOf(h.instance).waitForThreadDrain;
      h.instance.ctx.container.exec = async (argv: string[]) => {
        if (argv.some((v) => v.includes("kill -9 -1"))) complete();
        return { exitCode: Promise.resolve(0) };
      };
      h.instance.processSandbox = {
        exec: async (argv: string[]) => {
          commands.push(argv);
          const publishing = argv.some((v) => v.startsWith("https://door.example/"));
          if (publishing) entered();
          return {
            output: async () => {
              if (publishing) await settled;
              return {
                stdout: "",
                stderr: "",
                exitCode: argv.some((v) => v.includes("kill -9 -1")) ? 137 : 0,
                timedOut: false,
                truncated: false,
              };
            },
          };
        },
      };
      const published = h.instance.publishThread(
        threadKey,
        {
          repo: "owner/name",
          doorOrigin: "https://door.example",
          branch: "fix/owned",
          next: "a".repeat(40),
          ...(old ? { old } : {}),
          bearer: "effect-test-token",
        },
        owner,
      );
      await begun;
      expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toHaveLength(1);
      const stopped = await h.instance.cancelRun(ticket, physical);
      expect(await published).toEqual({ stdout: "", stderr: "", exitCode: 0, truncated: false });
      expect(stopped).toEqual({ stopped: true, cancellationId: ticket.id, disposition: "processes-stopped" });
      expect([...h.rows.keys()].filter((k) => k.startsWith("native-operation:"))).toEqual([]);
      const git = commands.find((argv) => argv.some((v) => v.startsWith("https://door.example/")))!;
      expect(git.at(-1)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/fix/owned");
      if (old)
        expect(git).toContain("--force-with-lease=refs/heads/fix/owned:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    },
  );
});
