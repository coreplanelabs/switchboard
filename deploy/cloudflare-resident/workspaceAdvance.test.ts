import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isWorkspaceOwner, workspaceBindingOf, workspaceOwnerKey } from "../../src/core/workspaceSettlement";
import { decideWorktree } from "../../src/execution/residentReuse";
import { shellQuote } from "../../src/execution/shellQuote";
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
  } = {},
) {
  const calls: string[] = [];
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
  });
  const rows = new Map<string, unknown>([
    ["thread:" + binding.threadKey, binding],
    ["reg:" + binding.threadKey, { ...owner, threadKey: binding.threadKey, workspace: physical }],
    ["fence:" + binding.threadKey, { ...owner, ownerFence: options.fence ?? owner.ownerFence }],
  ]);
  const instance = new C();
  Object.assign(instance, {
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
    run: async (argv: string[]) => ({
      exitCode: argv[0] === "pgrep" ? (options.processes ? 0 : 1) : 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
    }),
    threadRun: async (_user: string, _path: string, command: string) => ({
      exitCode: command.includes("merge-base") ? 1 : 0,
      stdout: command.includes("rev-parse") ? (options.head ?? oldHead) : options.dirty ? "M changed" : "",
      stderr: "",
    }),
    threadRunOk: async () => "",
  });
  return {
    calls,
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
  it("advances a clean live owner's same physical binding to the requested head", async () => {
    const h = harness();
    await expect(h.advance()).resolves.toBe(true);
    expect(h.calls.some((s) => s.startsWith("worktree-clone:"))).toBe(true);
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
