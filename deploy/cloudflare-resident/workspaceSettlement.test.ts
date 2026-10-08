import { registeredRunOwnsRelease } from "./runRegistration";
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

const source = ts.createSourceFile("worker.ts", readSource("worker.ts"), ts.ScriptTarget.Latest, true);
const resident = source.statements.find(
  (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === "ResidentDO",
)!;
const names = [
  "cancelRun",
  "withThreadBusy",
  "withOwnedNativeOperation",
  "assertThreadOperationAllowed",
  "execThread",
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
  "ackWorkspaceSettlement",
];
const compiled = ts.transpileModule(
  `${source.statements
    .filter(
      (s) => ts.isFunctionDeclaration(s) && ["confineThreadPath", "validateEnvNames"].includes(s.name?.text ?? ""),
    )
    .map((s) => s.getText(source).replace("export ", ""))
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
  let ackLost = options.lostAck;
  let acknowledged = 0;
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
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
    get: async (key: string) => structuredClone(rows.get(key)),
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
    RunCancelledError: class RunCancelledError extends Error {},
    createExtensionProcessSandbox: (instance: any) => instance.processSandbox,
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
    SandboxRuntimeBusyError,
    DEFAULT_EXEC_TIMEOUT_MS: 1000,
    BASH_TIMEOUT_MS: 1000,
    EXEC_OUTPUT_CAP: 10000,
    DESTROY_UNCONFIRMED_KEY: "destroy",
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
    cancellationRefusal: () => false,
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
    THREAD_USERS: ["worker2", "worker3"],
    RESOURCE_KEY: "resource",
    WORKSPACE_PREDECESSORS_MAX: 20,
    WORKSPACE_RECONCILE_BINDINGS_MAX: 20,
    WORKSPACE_SETTLEMENT_CURSOR_KEY: "settlement-cursor",
    systemClock: () => 1000,
    validRunOwner: () => true,
    threadBindingKey: (s: string) => "thread:" + s,
    runRegKey: (s: string) => "runReg:" + s,
    runFenceKey: (s: string) => "runFence:" + s,
    console: { warn: () => {}, log: () => {} },
  });
  const instance = new C();
  Object.assign(instance, {
    ctx: {
      storage,
      id: { toString: () => "fixture-container" },
      container: { running: true, exec: vi.fn(async () => ({ exitCode: Promise.resolve(0) })) },
    },
    threadOperationScope: new AsyncLocalStorage(),
    clearRuntimeUnreachable: async () => {},
    noteRuntimeUnreachable: async () => ({ count: 1 }),
    threadWrites: new KeyedAsyncLock(),
    ensureStageDir: async () => {},
    memoryGate: async () => null,
    threadPreflight: async () => ({
      binding: { ...rows.get("thread:" + threadKey), readonly: false, githubDoorHost: "door.example" },
    }),
    threadOpsInFlight: new Map(),
    workspaceExclusiveOpsInFlight: new Set(),
    withDeployAdmission: async (fn: () => Promise<unknown>) => fn(),
    poolUserOwnerMatches: async () => true,
    waitForThreadDrain: async () => instance.threadOpsInFlight.get(threadKey) ?? 0,
    execThreadImpl: async () => ({ stdout: "ran", stderr: "", exitCode: 0, truncated: false }),
    env: { STATE_WORKER_URL: "https://state.example", MEMORY_TOKEN: "test" },
    threadAttaches: { run: async (_key: string, fn: () => Promise<unknown>) => fn() },
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
  return { instance, rows, events, fetch, ackedRevision: () => acknowledged };
}

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
    expect(stopped).toEqual({ stopped: false });
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
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({ stopped: false });
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
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({ stopped: false });
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
      h.instance.processSandbox = {
        exec: async (argv: string[]) => {
          commands.push(argv);
          const publishing = argv.some((v) => v.startsWith("https://door.example/"));
          if (publishing) entered();
          if (argv.some((v) => v.includes("kill -9 -1"))) complete();
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
      expect(await h.instance.cancelRun(ticket, physical)).toEqual({ stopped: false });
      release();
      expect(await data).toMatchObject({ error: "run cancelled", status: 409 });
      expect(commands).toEqual([
        [
          "/bin/sh",
          "-c",
          'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; exec /usr/bin/su -s /bin/bash "$2" -c "kill -9 -1"',
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
    h.instance.run = async () => ({ exitCode: 137, timedOut: false, truncated: false });
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(2) });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({ stopped: false });
    h.instance.ctx.container.exec = async () => ({ exitCode: Promise.resolve(0) });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: ticket.id,
      disposition: "processes-stopped",
    });
  });
});

describe("resident run cancellation", () => {
  it("kills only the exact registered UID and keeps its files and spend ownership", async () => {
    const h = harness();
    const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const registration = { ...h.rows.get("runReg:" + threadKey), runId };
    h.rows.set("runReg:" + threadKey, registration);
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
    h.instance.run = async (command: unknown) => {
      commands.push(command);
      return { exitCode: 137, timedOut: false, truncated: false };
    };
    expect(await h.instance.cancelRun(ticket, { ...physical, ownerFence: 8 })).toEqual({ stopped: false });
    expect(h.rows.get("runReg:" + threadKey)).toEqual(registration);
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({
      stopped: true,
      cancellationId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      disposition: "processes-stopped",
    });
    expect(commands).toEqual([
      [
        "/bin/sh",
        "-c",
        'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; exec /usr/bin/su -s /bin/bash "$2" -c "kill -9 -1"',
        "--",
        "vm-a",
        "worker2",
      ],
      [
        "/bin/sh",
        "-c",
        'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; exec /usr/bin/su -s /bin/bash "$2" -c "kill -9 -1"',
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
      run: async () => ({ exitCode: 137, timedOut: true, truncated: false }),
    });
    expect(await h.instance.cancelRun(ticket, physical)).toEqual({ stopped: false });
    expect(h.rows.get("runReg:" + threadKey)).toMatchObject(owner);
    expect(h.rows.get(`cancelled:${threadKey}:${owner.runId}`)).toMatchObject({
      cancellation: { id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" },
    });
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
