import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isWorkspaceOwner, workspaceBindingOf, workspaceOwnerKey } from "../../src/core/workspaceSettlement";
import { decideWorktree } from "../../src/execution/residentReuse";
import { shellQuote } from "../../src/execution/shellQuote";
import { createStepTrace } from "../../src/execution/residentStepTrace";
import { sanitizeGraftedSteps } from "../../src/execution/residentTrace";
import { readSource } from "./testing/sourceScan";

const source = ts.createSourceFile("worker.ts", readSource("worker.ts"), ts.ScriptTarget.Latest, true);
const resident = source.statements.find(
  (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === "ResidentDO",
)!;
const names = ["ensureThreadWorktree", "guardWorkspaceAdvance"];
const compiled = ts.transpileModule(
  `class UnderTest { ${resident.members
    .filter((m) => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && names.includes(m.name.text))
    .map((m) => m.getText(source))
    .join("\n")} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const owner = { runId: "run-review", ownerGen: "gen-review", ownerFence: 7 };
const oldHead = "a".repeat(40),
  newHead = "b".repeat(40);
const binding = {
  threadKey: "slack:CREVIEW:123",
  user: "worker2",
  ref: "feature",
  worktreePath: "/workspace/threads/review/feature",
  container: "vm-review",
  sha: oldHead,
  readonly: true,
};
const physical = {
  backend: "resident",
  workspace: binding.worktreePath,
  ref: binding.ref,
  user: binding.user,
  container: binding.container,
  ownerGen: owner.ownerGen,
  ownerFence: owner.ownerFence,
};
class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}
function harness(
  options: {
    live?: boolean;
    dirty?: boolean;
    untracked?: boolean;
    head?: string;
    container?: string;
    fence?: number;
    busy?: boolean;
    processes?: boolean;
    physicalMissing?: boolean;
    ownerChangedDuringProbe?: boolean;
    traceMissing?: boolean;
    processesEnding?: boolean;
    changedDuringWait?: "tree" | "fence";
    processResults?: Array<{
      exitCode: number;
      stdout: string;
      stderr?: string;
      timedOut?: boolean;
      truncated?: boolean;
    }>;
  } = {},
) {
  const calls: string[] = [];
  const waits: number[] = [];
  let processChecks = 0;
  const C = runInNewContext(compiled + "\nUnderTest", {
    decideWorktree,
    shellQuote,
    isWorkspaceOwner,
    workspaceBindingOf,
    workspaceOwnerKey,
    StepError,
    ReuseRefusedError: Error,
    parentDir: (s: string) => s.slice(0, s.lastIndexOf("/")),
    THREADS_DIR: "/workspace/threads",
    MIRROR_DIR: "/workspace/mirror",
    DEFAULT_EXEC_TIMEOUT_MS: 1000,
    GIT_NETWORK_TIMEOUT_MS: 1000,
    threadBindingKey: (s: string) => "thread:" + s,
    runRegKey: (s: string) => "reg:" + s,
    runFenceKey: (s: string) => "fence:" + s,
    systemClock: () => 1000,
    SECOND_MS: 1000,
    sleep: async (ms: number) => {
      waits.push(ms);
      if (options.changedDuringWait === "tree") options.dirty = true;
      if (options.changedDuringWait === "fence") rows.set("fence:" + binding.threadKey, { ...owner, ownerFence: 8 });
    },
  });
  const rows = new Map<string, unknown>([
    ["thread:" + binding.threadKey, binding],
    ["reg:" + binding.threadKey, { ...owner, threadKey: binding.threadKey, workspace: physical }],
    ["fence:" + binding.threadKey, { ...owner, ownerFence: options.fence ?? owner.ownerFence }],
  ]);
  const instance = new C();
  const trace = createStepTrace(0);
  Object.assign(instance, {
    stepTrace: { getStore: () => (options.traceMissing ? undefined : trace) },
    ctx: { storage: { get: async (key: string) => rows.get(key) } },
    threadOpsInFlight: new Map(options.busy ? [[binding.threadKey, 1]] : []),
    opUsersInUse: new Map(),
    poolUserOwnerMatches: async () => true,
    containerIdentity: async () => options.container ?? binding.container,
    observeRunForEviction: async () =>
      options.live === false
        ? { kind: "terminal" }
        : {
            kind: "live",
            row: {
              runId: owner.runId,
              ownerGen: owner.ownerGen,
              workspaceThreadKey: binding.threadKey,
              binding: options.physicalMissing ? {} : physical,
            },
          },
    observePrivateTree: async () => {
      if (options.ownerChangedDuringProbe) options.live = false;
      return {
        present: true,
        branch: binding.ref,
        head: options.head ?? oldHead,
        uncommittedChanges: options.dirty ? 1 : 0,
        untrackedNonIgnored: options.untracked ? 1 : 0,
        unpushedCommits: 0,
      };
    },
    guardWorkspaceReplacement: async () => ({ error: "workspace-preserved: owner-live" }),
    runOk: async (argv: string[], step: string) => {
      calls.push(step + ":" + argv.join(" "));
      return "";
    },
    run: async (argv: string[]) => {
      const sample = argv[0] === "pgrep" ? options.processResults?.shift() : undefined;
      return {
        exitCode:
          argv[0] === "pgrep" ? (options.processes || (options.processesEnding && processChecks++ === 0) ? 0 : 1) : 0,
        stdout: argv[0] === "pgrep" && options.processesEnding && processChecks === 1 ? "123\n" : "",
        stderr: "",
        timedOut: false,
        truncated: false,
        ...sample,
      };
    },
    threadRun: async (_user: string, _path: string, command: string) => ({
      exitCode: command.includes("merge-base") ? 1 : 0,
      stdout: command.includes("rev-parse") ? (options.head ?? oldHead) : options.dirty ? "M changed" : "",
      stderr: "",
    }),
    threadRunOk: async () => "",
  });
  return {
    calls,
    waits,
    trace: () => sanitizeGraftedSteps(trace.steps()),
    refusal: () => instance.guardWorkspaceAdvance(binding, owner),
    advance: () =>
      instance.ensureThreadWorktree(binding, newHead, "/workspace/mirror", false, {
        detached: false,
        reuse: false,
        refChanged: false,
        priorBinding: binding,
        advanceOwner: owner,
      }),
  };
}
describe("exact-owner review workspace advance", () => {
  it("continues the same review after a process exits and all workspace evidence is checked again", async () => {
    const h = harness({ processesEnding: true });
    await expect(h.advance()).resolves.toBe(true);
    expect(h.waits).toEqual([1000]);
    expect(h.calls.some((call) => call.startsWith("worktree-clone:"))).toBe(true);
  });

  it.each(["tree", "fence"] as const)(
    "preserves the workspace when %s evidence changes during process exit grace",
    async (changedDuringWait) => {
      const h = harness({ processesEnding: true, changedDuringWait });
      await expect(h.advance()).rejects.toThrow("workspace-preserved: live owner advance unverified");
      expect(h.waits).toEqual([1000]);
      expect(h.calls.some((call) => call.startsWith("worktree-clean:"))).toBe(false);
    },
  );

  it("preserves the workspace after the bounded grace when a process still runs", async () => {
    const h = harness({
      processResults: [
        { exitCode: 0, stdout: "123\n" },
        { exitCode: 0, stdout: "123\n" },
      ],
    });
    await expect(h.advance()).rejects.toThrow("workspace-preserved: live owner advance unverified");
    expect(h.waits).toEqual([1000]);
    expect(h.trace()).toEqual([{ name: "advance-process-check", startMs: 1000, durationMs: 0, status: "error" }]);
    expect(h.calls.some((call) => call.startsWith("worktree-clean:"))).toBe(false);
  });

  it.each([
    { exitCode: 0, stdout: "123\n", timedOut: true },
    { exitCode: 0, stdout: "123\n", truncated: true },
    { exitCode: 0, stdout: "123\n", stderr: "unverified" },
    { exitCode: 0, stdout: "unknown\n" },
  ])("refuses incomplete process evidence without retry: %j", async (processResult) => {
    const h = harness({ processResults: [processResult] });
    await expect(h.refusal()).resolves.toEqual({
      error: "workspace-preserved: live owner advance unverified",
      status: 409,
      reason: "workspace-preserved",
    });
    expect(h.waits).toEqual([]);
  });
  it.each([
    [{ fence: 8 }, "advance-owner-check"],
    [{ physicalMissing: true }, "advance-live-binding"],
    [{ dirty: true }, "advance-tree-check"],
    [{ processes: true }, "advance-process-check"],
    [{ ownerChangedDuringProbe: true }, "advance-owner-recheck"],
  ] as const)("records the refused advance check without releasing bytes: %j", async (options, stage) => {
    const h = harness({ ...options });
    await expect(h.advance()).rejects.toThrow("workspace-preserved: live owner advance unverified");
    expect(h.trace()).toEqual([{ name: stage, startMs: 1000, durationMs: 0, status: "error" }]);
    expect(h.calls.some((call) => /^(worktree-clean|worktree-clone|checkout-retire):/.test(call))).toBe(false);
  });

  it("keeps the original refusal shape when a trace collector is unavailable", async () => {
    const h = harness({ fence: 8, traceMissing: true });
    await expect(h.refusal()).resolves.toEqual({
      error: "workspace-preserved: live owner advance unverified",
      status: 409,
      reason: "workspace-preserved",
    });
    expect(h.trace()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("advances a clean live owner's same physical binding to the requested head", async () => {
    const h = harness();
    await expect(h.advance()).resolves.toBe(true);
    expect(h.calls.some((s) => s.startsWith("worktree-clone:"))).toBe(true);
    expect(h.trace()).toEqual([]);
  });
  it.each([
    { live: false },
    { dirty: true },
    { untracked: true },
    { head: "c".repeat(40) },
    { container: "vm-other" },
    { fence: 8 },
    { busy: true },
    { processes: true },
    { physicalMissing: true },
    { ownerChangedDuringProbe: true },
  ])("keeps bytes when exact live advance evidence refuses: %j", async (options) => {
    const h = harness(options);
    await expect(h.advance()).rejects.toThrow();
    expect(h.calls.some((s) => s.startsWith("worktree-clean:"))).toBe(false);
  });
});
