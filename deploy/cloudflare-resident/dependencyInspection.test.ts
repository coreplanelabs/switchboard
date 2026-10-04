import { isWorkspaceOwner, workspaceOwnerKey, workspaceSettlementOf } from "../../src/core/workspaceSettlement.js";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  dependencyInspectionCommand,
  dependencyInspectionInputSchema,
  collectDependencyInspection,
} from "../../src/execution/dependencyInspection.js";
import {
  collectPrivateTreeObservation,
  privateTreeObservationScript,
} from "../../src/execution/residentCleanliness.js";
import { parsePoolBindings } from "../../src/execution/residentPoolSpends.js";
import { shellQuote } from "../../src/execution/shellQuote.js";
import { validRunOwner } from "./runRegistration.js";
import { methodOf, readSource } from "./testing/sourceScan.js";

const method = methodOf(
  readSource("worker.ts").slice(readSource("worker.ts").indexOf("export class ResidentDO")),
  "inspectThreadDependencies",
)!;
const compiled = ts.transpileModule(
  `class Probe { ${method} ${methodOf(readSource("worker.ts"), "withThreadBusy")} }; Probe`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const input = { threadKey: "mcp:example", ref: "main", head: "a".repeat(40) };
type Probe = {
  inspectThreadDependencies(input: unknown): Promise<unknown>;
  ctx: { container: { running: boolean } };
  threadOpsInFlight: Map<string, number>;
  workspaceExclusiveOpsInFlight: Set<string>;
  withThreadBusy(key: string, work: () => Promise<unknown>): Promise<unknown>;
  observeRunForEviction(): Promise<unknown>;
  poolUserOwnerMatches(): Promise<boolean>;
};

function fixture() {
  const owner = { runId: "run-one", ownerGen: "gen-one", ownerFence: 1 };
  const binding = { threadKey: input.threadKey, ref: input.ref, user: "worker2", worktreePath: "/workspace/tree" };
  const rows = new Map<string, unknown>([
    ["binding", binding],
    ["registration", { threadKey: input.threadKey, ...owner }],
    ["fence", owner],
  ]);
  const output = (text = '{"kind":"ready"}') => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exitCode: Promise.resolve(0),
  });
  const execute = vi.fn<(argv: readonly string[]) => Promise<ReturnType<typeof output>>>(async () => output());
  const Constructor = runInNewContext(compiled, {
    dependencyInspectionInputSchema,
    dependencyInspectionCommand,
    collectDependencyInspection,
    validRunOwner,
    shellQuote,
    TextDecoder,
    THREAD_USERS: ["worker2"],
    DESTROY_UNCONFIRMED_KEY: "destroy",
    CREDENTIAL_INSPECTION_MAX_MS: 20_000,
    SECOND_MS: 1000,
    threadBindingKey: () => "binding",
    runRegKey: () => "registration",
    runFenceKey: () => "fence",
    threadWorktreePath: async () => "/workspace/tree",
    replacementWorktreePath: async () => "/workspace/other",
  }) as new () => Probe;
  const instance = new Constructor();
  const storage = { get: vi.fn(async (key: string) => rows.get(key)), put: vi.fn(), delete: vi.fn() };
  Object.assign(instance, {
    ctx: { storage, container: { running: true, exec: execute } },
    destroying: false,
    memoryGuard: { gate: () => null },
    recreateAdmission: { blocked: async () => false },
    threadOpsInFlight: new Map(),
    opUsersInUse: new Set(),
    workspaceExclusiveOpsInFlight: new Set(),
    threadAttaches: { run: async (_key: string, work: () => Promise<unknown>) => work() },
    withDeployAdmission: async (work: () => Promise<unknown>) => work(),
    poolUserOwnerMatches: async () => true,
    observeRunForEviction: async () => ({
      kind: "terminal",
      record: { id: owner.runId, threadKey: input.threadKey, status: "completed" },
    }),
  });
  return { instance, rows, execute, storage, owner, output };
}

describe("retained resident dependency inspection", () => {
  it("uses one native no-wake process and returns its exact retained owner without writes", async () => {
    const h = fixture();
    expect(await h.instance.inspectThreadDependencies(input)).toEqual({ result: { kind: "ready" }, owner: h.owner });
    expect(h.execute).toHaveBeenCalledOnce();
    const argv = h.execute.mock.calls[0]![0] as unknown as string[];
    expect(argv.slice(0, 9)).toEqual([
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "/usr/bin/timeout",
      "-s",
      "KILL",
      "20",
      "/bin/sh",
      "-c",
    ]);
    expect(argv[9]).toContain("/usr/bin/pgrep");
    expect(argv[9]).toContain("--session-command");
    expect(argv[9]).not.toMatch(/\bnpm\s+(ci|install)\b|\brm\s+-/);
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it.each([
    "stopped runtime",
    "missing owner",
    "foreign fence",
    "live owner",
    "foreign ref",
    "busy thread",
    "untracked UID",
    "extra input",
  ])("refuses %s before any process", async (scenario) => {
    const h = fixture();
    if (scenario === "stopped runtime") h.instance.ctx.container.running = false;
    if (scenario === "missing owner") h.rows.delete("registration");
    if (scenario === "foreign fence") h.rows.set("fence", { ...h.owner, ownerFence: 2 });
    if (scenario === "live owner") h.instance.observeRunForEviction = async () => ({ kind: "live" });
    if (scenario === "busy thread") h.instance.threadOpsInFlight.set(input.threadKey, 1);
    if (scenario === "untracked UID") h.instance.poolUserOwnerMatches = async () => false;
    const request =
      scenario === "foreign ref"
        ? { ...input, ref: "other" }
        : scenario === "extra input"
          ? { ...input, command: "echo private" }
          : input;
    expect(await h.instance.inspectThreadDependencies(request)).toEqual({ result: { kind: "unknown" } });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it("refuses an operation admitted while asynchronous owner checks were pending", async () => {
    const h = fixture();
    h.instance.poolUserOwnerMatches = async () => {
      h.instance.threadOpsInFlight.set(input.threadKey, 1);
      return true;
    };
    expect(await h.instance.inspectThreadDependencies(input)).toEqual({ result: { kind: "unknown" } });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("excludes completed competing writes until collection and releases the guard", async () => {
    const h = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.execute.mockImplementationOnce(async () => {
      expect(h.instance.workspaceExclusiveOpsInFlight.has(input.threadKey)).toBe(true);
      const write = vi.fn(async () => "changed");
      expect(await h.instance.withThreadBusy(input.threadKey, write)).toMatchObject({ reason: "busy" });
      expect(write).not.toHaveBeenCalled();
      return { ...h.output(), exitCode: pending.then(() => 0) };
    });
    const inspection = h.instance.inspectThreadDependencies(input);
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledOnce());
    expect(h.instance.workspaceExclusiveOpsInFlight.has(input.threadKey)).toBe(true);
    release();
    expect(await inspection).toEqual({ result: { kind: "ready" }, owner: h.owner });
    expect(h.instance.workspaceExclusiveOpsInFlight.size).toBe(0);
    expect(await h.instance.withThreadBusy(input.threadKey, async () => "after")).toBe("after");
  });

  it("refuses a changed fence after native execution and withholds raw process errors", async () => {
    const h = fixture();
    h.execute.mockImplementationOnce(async () => {
      h.rows.set("fence", { ...h.owner, ownerFence: 2 });
      return h.output();
    });
    expect(await h.instance.inspectThreadDependencies(input)).toEqual({ result: { kind: "unknown" } });
    const failed = fixture();
    failed.execute.mockRejectedValueOnce(new Error("private process error"));
    expect(await failed.instance.inspectThreadDependencies(input)).toEqual({ result: { kind: "unknown" } });
    expect(failed.execute).toHaveBeenCalledOnce();
  });
});

describe("retained resident preservation inspection", () => {
  const source = readSource("worker.ts");
  const compiled = ts.transpileModule(
    `class Probe {
${methodOf(source, "inspectThreadPreservation")}
${methodOf(source, "withThreadBusy")}
}; Probe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const input = { threadKey: "mcp:original", ref: "codex/original", head: "b".repeat(40), runId: "original-run" };

  function fixture() {
    const owner = { runId: input.runId, ownerGen: "original-generation", ownerFence: 7 };
    const binding = {
      threadKey: input.threadKey,
      ref: input.ref,
      user: "worker2",
      worktreePath: "/workspace/tree",
      container: "original-vm",
      sha: "a".repeat(40),
    };
    const rows = new Map<string, unknown>([
      ["binding", binding],
      ["registration", { threadKey: input.threadKey, ...owner }],
      ["fence", owner],
      ["claimants", [input.threadKey]],
    ]);
    const output = () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `container=original-vm\npresent=yes\nbranch=${input.ref}\nhead=${input.head}\ntracked=0\nuntracked=0\nunpushed=1\n`,
            ),
          );
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exitCode: Promise.resolve(0),
    });
    const execute = vi.fn(async (_argv: readonly string[]) => output());
    const Constructor = runInNewContext(compiled, {
      dependencyInspectionInputSchema,
      collectPrivateTreeObservation,
      privateTreeObservationScript,
      shellQuote,
      parsePoolBindings,
      validRunOwner,
      isWorkspaceOwner,
      workspaceOwnerKey,
      workspaceSettlementOf,
      THREAD_USERS: ["worker2"],
      DESTROY_UNCONFIRMED_KEY: "destroy",
      CREDENTIAL_INSPECTION_MAX_MS: 20_000,
      SECOND_MS: 1000,
      threadBindingKey: () => "binding",
      runRegKey: () => "registration",
      runFenceKey: () => "fence",
      poolBindingKey: () => "claimants",
      threadWorktreePath: async () => "/workspace/tree",
      replacementWorktreePath: async () => "/workspace/replacement",
    });
    const instance = new Constructor();
    const storage = { get: vi.fn(async (key: string) => rows.get(key)), put: vi.fn(), delete: vi.fn() };
    Object.assign(instance, {
      ctx: { storage, container: { running: true, exec: execute } },
      destroying: false,
      memoryGuard: { gate: () => null },
      recreateAdmission: { blocked: async () => false },
      threadOpsInFlight: new Map(),
      workspaceExclusiveOpsInFlight: new Set(),
      opUsersInUse: new Map(),
      threadAttaches: { run: async (_key: string, fn: () => Promise<unknown>) => fn() },
      withDeployAdmission: async (fn: () => Promise<unknown>) => fn(),
      poolUserOwnerMatches: async () => true,
      containerIdentity: async () => "original-vm",
      observeRunForEviction: async () => ({
        kind: "terminal",
        record: { id: owner.runId, threadKey: input.threadKey, status: "completed" },
      }),
      workspaceRemovalDecision: vi.fn(async () => ({ removable: false, reason: "preservation-unverified" })),
    });
    return { instance, rows, binding, owner, execute, storage, output };
  }

  it("reports original physical ownership and measured stale-ref count without writing or granting release", async () => {
    const h = fixture();
    const answer = await h.instance.inspectThreadPreservation(input);
    expect(answer).toMatchObject({
      kind: "observed",
      owner: h.owner,
      fence: h.owner,
      binding: h.binding,
      soleClaimant: true,
      uidProcesses: 0,
      tree: { head: input.head, unpushedCommits: 1 },
      decision: { removable: false, reason: "preservation-unverified" },
    });
    expect(h.instance.workspaceRemovalDecision).toHaveBeenCalledWith(h.binding, true, false, {
      tree: answer.tree,
      container: "original-vm",
    });
    expect(h.execute).toHaveBeenCalledOnce();
    const command = h.execute.mock.calls[0]![0].join(" ");
    expect(command).toContain("--session-command");
    expect(command).not.toMatch(/git fetch|git push|git reset|rm -rf/);
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it.each([
    "live owner",
    "wrong run",
    "foreign fence",
    "duplicate claimant",
    "changed incarnation",
    "stopped runtime",
    "extra input",
  ])("refuses %s before native observation", async (scenario) => {
    const h = fixture();
    if (scenario === "live owner") h.instance.observeRunForEviction = async () => ({ kind: "live" });
    if (scenario === "foreign fence") h.rows.set("fence", { ...h.owner, ownerFence: 8 });
    if (scenario === "duplicate claimant") h.rows.set("claimants", [input.threadKey, "mcp:other"]);
    if (scenario === "changed incarnation") h.instance.containerIdMemo = "new-vm";
    if (scenario === "stopped runtime") h.instance.ctx.container.running = false;
    const request =
      scenario === "wrong run"
        ? { ...input, runId: "other" }
        : scenario === "extra input"
          ? { ...input, command: "private" }
          : input;
    expect(await h.instance.inspectThreadPreservation(request)).toMatchObject({ kind: "unknown" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects owner drift during the native probe and releases its operation guard", async () => {
    const h = fixture();
    h.execute.mockImplementationOnce(async () => {
      h.rows.set("fence", { ...h.owner, ownerFence: 8 });
      return h.output();
    });
    expect(await h.instance.inspectThreadPreservation(input)).toMatchObject({
      kind: "unknown",
      reason: "observation-changed",
    });
    expect(h.instance.workspaceExclusiveOpsInFlight.size).toBe(0);
    expect(h.instance.workspaceRemovalDecision).not.toHaveBeenCalled();
  });

  it("holds exclusion through final gate observation and rejects a competing write", async () => {
    const h = fixture();
    h.instance.workspaceRemovalDecision.mockImplementationOnce(async () => {
      const write = vi.fn();
      expect(await h.instance.withThreadBusy(input.threadKey, write)).toMatchObject({ reason: "busy" });
      expect(write).not.toHaveBeenCalled();
      return { removable: false, reason: "workspace-settlement-unverified" };
    });
    expect(await h.instance.inspectThreadPreservation(input)).toMatchObject({
      decision: { reason: "workspace-settlement-unverified" },
    });
    expect(h.instance.workspaceExclusiveOpsInFlight.size).toBe(0);
  });

  it("observes an exact acknowledged revision without bypassing the existing settlement guard", async () => {
    const h = fixture();
    h.rows.set("binding", {
      ...h.binding,
      workspaceSettlement: {
        version: 1,
        revision: 3,
        owner: h.owner,
        binding: null,
        publication: null,
        record: { id: input.runId, threadKey: input.threadKey, status: "completed", userId: null },
      },
    });
    h.instance.observeRunForEviction = async () => ({ kind: "acknowledged", owner: h.owner, revision: 3 });
    h.instance.workspaceRemovalDecision.mockResolvedValueOnce({
      removable: false,
      reason: "workspace-settlement-unverified",
    });
    expect(await h.instance.inspectThreadPreservation(input)).toMatchObject({
      kind: "observed",
      ownerEvidence: { kind: "acknowledged", revision: 3 },
      decision: { removable: false, reason: "workspace-settlement-unverified" },
    });
  });

  it("withholds a stale ACK before reading the private tree", async () => {
    const h = fixture();
    h.rows.set("binding", {
      ...h.binding,
      workspaceSettlement: {
        version: 1,
        revision: 3,
        owner: h.owner,
        binding: null,
        publication: null,
        record: { id: input.runId, threadKey: input.threadKey, status: "completed", userId: null },
      },
    });
    h.instance.observeRunForEviction = async () => ({ kind: "acknowledged", owner: h.owner, revision: 2 });
    expect(await h.instance.inspectThreadPreservation(input)).toMatchObject({
      kind: "unknown",
      reason: "owner-unverified",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });
});
