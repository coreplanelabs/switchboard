import {
  isWorkspaceOwner,
  workspaceOwnerKey,
  workspaceBindingOf,
  workspaceSettlementOf,
} from "../../src/core/workspaceSettlement";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  checkpointKey,
  type PublicationBinding,
  type PublicationSettlement,
} from "../../src/core/publicationSettlement";
import { decideWorkspaceRemoval } from "./workspacePreservation";
import { parsePrivateTreeObservation, privateTreeObservationScript } from "../../src/execution/residentCleanliness";
import { planForceDetach } from "../../src/execution/residentDetach";
import { registeredRunOwnsRelease } from "./runRegistration";
import { parsePoolBindings } from "../../src/execution/residentPoolSpends";
import { shellQuote } from "../../src/execution/shellQuote";
import { coordinatorFields, idempotencyKeyFor } from "../../src/core/coordinator/contract";
import { methodOf, readSource } from "./testing/sourceScan";

// Compile the shipped methods, not a replica of their control flow. The fake
// runtime supplies storage, locks and container operations at their seams.
const workerText = readSource("worker.ts");
const source = ts.createSourceFile("worker.ts", workerText, ts.ScriptTarget.Latest, true);
const resident = source.statements.find(
  (statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === "ResidentDO",
);
const methods = [
  "sweepWorktrees",
  "evictBinding",
  "workspaceRemovalDecision",
  "reportBlockedWorkspace",
  "automaticContainerLoss",
  "detachThread",
  "retainWorkspacePredecessor",
  "reconcileWorkspaceSettlements",
  "reconcileWorkspaceBinding",
  "ackWorkspaceSettlement",
];
const bodies = methods.map((name) => {
  const method = resident?.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name,
  );
  if (!method) throw new Error(`ResidentDO.${name} is missing`);
  return method.getText(source);
});
const compiled = ts.transpileModule(
  `class PreservationUnderTest {
  async withDeployAdmission(fn: () => Promise<unknown>) { return fn(); }
  ${bodies.join("\n")}
}`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;

const NOW = Date.parse("2026-10-02T03:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const threadKey = "slack:C1:paused-work";
const original = {
  threadKey,
  ref: "codex/owner-work",
  user: "worker2",
  lastAttachAt: new Date(NOW - 90 * MINUTE).toISOString(),
  evicted: false,
  worktreePath: "/workspace/threads/original/ref",
  boundAt: new Date(NOW - DAY).toISOString(),
};
const registration = {
  threadKey,
  registeredAt: new Date(NOW - DAY).toISOString(),
  runId: "original-run",
  ownerGen: "gen-next",
  ownerFence: 7,
  deadlineAt: NOW - 2 * MINUTE,
};
const runFence = { runId: registration.runId, ownerGen: registration.ownerGen, ownerFence: registration.ownerFence };
const liveOwner = { kind: "live", row: { runId: registration.runId, threadKey, ownerGen: registration.ownerGen } };
const publicationBinding: PublicationBinding = {
  runId: registration.runId,
  instanceId: "instance-x",
  step: "instance-x:unit-x",
  repo: "owner/name",
  branch: original.ref,
  requester: "slack:U123",
  threadKey,
  generation: registration.ownerGen,
  baseHeadSha: "a".repeat(40),
};
const savedSettlement: PublicationSettlement = {
  version: 1,
  binding: publicationBinding,
  checkpoint: { kind: "created", head: "b".repeat(40) },
  publication: { kind: "not_attempted" },
  preservation: {
    kind: "saved",
    key: checkpointKey(publicationBinding, "b".repeat(40)),
    size: 1024,
    sha256: "c".repeat(64),
  },
  release: { kind: "pending" },
};
const cleanSettlement: PublicationSettlement = {
  ...savedSettlement,
  checkpoint: { kind: "clean", head: "b".repeat(40) },
  preservation: { kind: "pending" },
};
const terminal = (settlement: PublicationSettlement = savedSettlement) => ({
  kind: "terminal",
  record: {
    id: registration.runId,
    threadKey,
    status: "completed",
    repo: publicationBinding.repo,
    userId: publicationBinding.requester,
    parentInstanceId: publicationBinding.instanceId,
    idempotencyKey: publicationBinding.step,
    publicationSettlement: settlement,
  },
});
const ordinaryTerminal = {
  kind: "terminal",
  record: {
    id: registration.runId,
    threadKey,
    status: "completed",
    repo: publicationBinding.repo,
    userId: publicationBinding.requester,
  },
};
const shipReviewTerminal = {
  kind: "terminal",
  record: {
    ...ordinaryTerminal.record,
    ...coordinatorFields({
      parentInstanceId: "ship-review",
      idempotencyKey: idempotencyKeyFor("ship-review", "U12/1/review"),
      unit: "U12",
      instanceAttempt: 0,
    }),
  },
};
const cleanTree = {
  present: true,
  branch: original.ref,
  head: "b".repeat(40),
  uncommittedChanges: 0,
  untrackedNonIgnored: 0,
  unpushedCommits: 1,
};

type UnderTest = {
  sweepWorktrees(resource: string): Promise<{ evicted: string[]; kept: number }>;
  evictBinding(binding: unknown, active: boolean, context: string, why: string): Promise<string>;
  automaticContainerLoss(reason: string, action: () => Promise<void>): Promise<boolean>;
  detachThread(
    threadKey: string,
    force: boolean,
    pushed: readonly unknown[],
    runId: string,
    ownerGen: string,
    ownerFence: number,
  ): Promise<unknown>;
  observeRunForEviction: ReturnType<typeof vi.fn>;
  observePrivateTree: ReturnType<typeof vi.fn>;
  withMirrorLock: (fn: () => Promise<unknown>) => Promise<{ value: unknown }>;
  workspaceExclusiveOpsInFlight: Set<string>;
};

function probe(
  options: {
    owner?: unknown;
    unavailable?: boolean;
    privateTree?: unknown;
    absentPrivateTree?: boolean;
    cacheEligible?: boolean;
    spendAccepted?: boolean;
    lastAttachAt?: string;
    registration?: Record<string, unknown> | null;
    fence?: unknown;
    runtimeActive?: boolean;
    binding?: Record<string, unknown>;
  } = {},
) {
  let binding: Record<string, unknown> = {
    ...original,
    ...options.binding,
    lastAttachAt: options.lastAttachAt ?? original.lastAttachAt,
  };
  let runRegistration = options.registration === undefined ? { ...registration } : options.registration;
  const fence = "fence" in options ? options.fence : runFence;
  const removed = vi.fn(async () => {});
  const cleanCache = vi.fn(async () => {});
  const observeRunForEviction = vi.fn(async () => (options.unavailable ? null : (options.owner ?? liveOwner)));
  const observePrivateTree = vi.fn(async () => (options.privateTree === undefined ? cleanTree : options.privateTree));
  const observeAbsentPrivateTree = vi.fn(async () => options.absentPrivateTree === true);
  const markPoolUserSpent = vi.fn(async () => options.spendAccepted !== false);
  const Scope = runInNewContext(`${compiled}\nPreservationUnderTest`, {
    isWorkspaceOwner,
    workspaceOwnerKey,
    workspaceSettlementOf,
    workspaceBindingOf,
    WORKSPACE_PREDECESSORS_MAX: 20,
    WORKSPACE_RECONCILE_BINDINGS_MAX: 20,
    WORKSPACE_SETTLEMENT_CURSOR_KEY: "settlement-cursor",
    RESOURCE_KEY: "resource",
    decideWorkspaceRemoval,
    planForceDetach,
    registeredRunOwnsRelease,
    CLEAN_IDLE_RELEASE_S: 3600,
    RUN_REGISTRATION_GRACE_MS: MINUTE,
    WORKTREE_TTL_DAYS_DEFAULT: 7,
    THREAD_KEY_PREFIX: "thread:",
    THREADS_DIR: "/workspace/threads",
    THREAD_USERS: options.cacheEligible ? [original.user] : [],
    threadUserCacheCleanArgv: () => ["cache-clean"],
    systemClock: () => NOW,
    runRegKey: (key: string) => `runReg:${key}`,
    runFenceKey: (key: string) => `runFence:${key}`,
    threadBindingKey: (key: string) => `thread:${key}`,
    parentDir: (path: string) => path.slice(0, path.lastIndexOf("/")),
    evictedTreeSentence: () => "",
    console: { log: () => {}, warn: () => {} },
    errMsg: (err: unknown) => String(err),
  }) as new () => UnderTest;
  const instance = new Scope();
  Object.assign(instance, {
    registry: () => ({ getRecord: async () => ({ worktreeTtlDays: 7 }) }),
    ctx: {
      storage: {
        put: async () => {},
        list: async () => new Map([[`thread:${threadKey}`, binding]]),
        get: async (key: string) =>
          key === `thread:${threadKey}`
            ? binding
            : key === `runReg:${threadKey}`
              ? runRegistration
              : key === `runFence:${threadKey}`
                ? fence
                : undefined,
        delete: async (key: string) => {
          if (key === `runReg:${threadKey}`) runRegistration = null;
        },
      },
    },
    threadAttaches: { run: async (_key: string, action: () => Promise<unknown>) => action() },
    threadOpsInFlight: new Map(),
    workspaceExclusiveOpsInFlight: new Set(),
    isRuntimeActive: async () => options.runtimeActive ?? true,
    measureTreeBeforeEviction: async () => undefined,
    poolUserOwnerMatches: async () => true,
    withMirrorLock: async (action: () => Promise<unknown>) => ({ value: await action() }),
    runOk: async (argv: string[]) => {
      if (argv[0] === "rm") await removed();
    },
    run: async (argv: string[]) => {
      if (argv[0] === "cache-clean") await cleanCache();
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    putThreadBinding: async (next: Record<string, unknown>) => {
      binding = next;
    },
    observeRunForEviction,
    observePrivateTree,
    observeAbsentPrivateTree,
    markPoolUserSpent,
  });
  return {
    instance,
    removed,
    cleanCache,
    observeRunForEviction,
    observePrivateTree,
    observeAbsentPrivateTree,
    markPoolUserSpent,
    binding: () => binding,
    replaceBinding: (next: Record<string, unknown>) => {
      binding = next;
    },
  };
}

describe("paused unpublished work at resident removal", () => {
  it("keeps a live owner after deadline, grace, clean-idle and TTL", async () => {
    for (const lastAttachAt of [original.lastAttachAt, new Date(NOW - 8 * DAY).toISOString()]) {
      const p = probe({ lastAttachAt });
      expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
      expect(p.removed).not.toHaveBeenCalled();
      expect(p.binding().preservationBlocked).toBe("owner-live");
      expect(p.observeRunForEviction).toHaveBeenCalled();
      expect(p.observePrivateTree).not.toHaveBeenCalled();
    }
  });

  it("clears a visible blocker once the exact owner has a saved terminal tree", async () => {
    const p = probe();
    await p.instance.sweepWorktrees("repo:owner/name");
    expect(p.binding().preservationBlocked).toBe("owner-live");
    p.instance.observeRunForEviction = vi.fn(async () => terminal());
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [threadKey], kept: 0 });
    expect(p.binding().preservationBlocked).toBeUndefined();
  });

  it.each([
    { name: "unavailable", owner: null },
    { name: "foreign", owner: { kind: "terminal", record: { ...terminal().record, id: "other-run" } } },
    { name: "provisional", owner: { kind: "unknown" } },
  ])("keeps uncertain authority ($name)", async ({ owner }) => {
    const p = probe({ owner, unavailable: owner === null });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(p.removed).not.toHaveBeenCalled();
  });

  it.each([
    { name: "saved", settlement: savedSettlement, unpushed: 1 },
    { name: "clean", settlement: cleanSettlement, unpushed: 0 },
  ])("releases an exact terminal owner with fresh $name evidence", async ({ settlement, unpushed }) => {
    const p = probe({ owner: terminal(settlement), privateTree: { ...cleanTree, unpushedCommits: unpushed } });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [threadKey], kept: 0 });
    expect(p.removed).toHaveBeenCalledOnce();
    expect(p.binding().evicted).toBe(true);
  });

  it.each([
    { name: "readonly review", readonly: true, force: true },
    { name: "non-coordinator run", readonly: false, force: false },
  ])(
    "releases an ordinary terminal $name through detach when the checkout matches its clean attach HEAD",
    async ({ readonly, force }) => {
      const p = probe({
        owner: ordinaryTerminal,
        binding: { sha: "b".repeat(40), readonly },
        privateTree: { ...cleanTree, unpushedCommits: 0 },
      });
      expect(
        await p.instance.detachThread(
          threadKey,
          force,
          [],
          registration.runId,
          registration.ownerGen,
          registration.ownerFence,
        ),
      ).toEqual({ released: true, user: original.user });
      expect(p.removed).toHaveBeenCalledOnce();
      expect(p.binding().evicted).toBe(true);
    },
  );

  it.each([
    { name: "missing attach HEAD", binding: { readonly: true }, tree: { ...cleanTree, unpushedCommits: 0 } },
    {
      name: "changed HEAD",
      binding: { readonly: true, sha: "c".repeat(40) },
      tree: { ...cleanTree, unpushedCommits: 0 },
    },
    { name: "unpushed commit", binding: { readonly: true, sha: "b".repeat(40) }, tree: cleanTree },
    {
      name: "tracked edit",
      binding: { readonly: true, sha: "b".repeat(40) },
      tree: { ...cleanTree, uncommittedChanges: 1, unpushedCommits: 0 },
    },
    {
      name: "untracked file",
      binding: { readonly: true, sha: "b".repeat(40) },
      tree: { ...cleanTree, untrackedNonIgnored: 1, unpushedCommits: 0 },
    },
  ])("keeps a Ship review checkout with $name", async ({ binding, tree }) => {
    const p = probe({
      owner: shipReviewTerminal,
      binding,
      privateTree: tree,
    });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(p.removed).not.toHaveBeenCalled();
  });

  it("keeps a clean Ship review checkout when its exact owner or fence is unverified", async () => {
    for (const options of [{ unavailable: true }, { fence: { ...runFence, ownerFence: runFence.ownerFence + 1 } }]) {
      const p = probe({
        owner: shipReviewTerminal,
        binding: { sha: "b".repeat(40), readonly: true },
        privateTree: { ...cleanTree, unpushedCommits: 0 },
        ...options,
      });
      expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
      expect(p.removed).not.toHaveBeenCalled();
    }
  });

  it("releases a clean Ship review child without a coding receipt through detach and sweep", async () => {
    const options = {
      owner: shipReviewTerminal,
      binding: { sha: "b".repeat(40), readonly: true },
      privateTree: { ...cleanTree, unpushedCommits: 0 },
    };
    const detached = probe(options);
    expect(
      await detached.instance.detachThread(
        threadKey,
        true,
        [],
        registration.runId,
        registration.ownerGen,
        registration.ownerFence,
      ),
    ).toEqual({ released: true, user: original.user });
    expect(detached.removed).toHaveBeenCalledOnce();
    const swept = probe(options);
    expect(await swept.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [threadKey], kept: 0 });
    expect(swept.removed).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "later tracked work", tree: { ...cleanTree, uncommittedChanges: 1 } },
    { name: "later untracked work", tree: { ...cleanTree, untrackedNonIgnored: 1 } },
    { name: "moved HEAD", tree: { ...cleanTree, head: "d".repeat(40) } },
    { name: "missing tree", tree: null },
  ])("does not let a saved checkpoint cover $name", async ({ tree }) => {
    const p = probe({ owner: terminal(), privateTree: tree });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(p.removed).not.toHaveBeenCalled();
  });

  it("does not wake a sleeping container to invent current private-tree evidence", async () => {
    const p = probe({ owner: terminal(), runtimeActive: false });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(p.observePrivateTree).not.toHaveBeenCalled();
    expect(p.removed).not.toHaveBeenCalled();
  });

  it("keeps partial registrations and surviving durable fences", async () => {
    for (const options of [{ registration: { ...registration, ownerFence: undefined } }, { registration: null }]) {
      const p = probe(options);
      expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
      expect(p.removed).not.toHaveBeenCalled();
    }
  });

  it("still removes a positively untracked legacy cache", async () => {
    const p = probe({
      registration: { threadKey, registeredAt: registration.registeredAt, deadlineAt: registration.deadlineAt },
      fence: undefined,
    });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [threadKey], kept: 0 });
    expect(p.removed).toHaveBeenCalledOnce();
  });

  it("rechecks the binding after a slow owner read before removal", async () => {
    const p = probe({ owner: terminal() });
    let release!: () => void;
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    p.instance.observeRunForEviction = vi.fn(async () => {
      entered();
      await held;
      return terminal();
    });
    const pending = p.instance.sweepWorktrees("repo:owner/name");
    await enteredRead;
    p.replaceBinding({ ...original, lastAttachAt: new Date(NOW).toISOString(), user: "worker3" });
    release();
    expect(await pending).toEqual({ evicted: [], kept: 1 });
    expect(p.removed).not.toHaveBeenCalled();
  });

  it("rechecks again after the mirror-lock wait", async () => {
    const p = probe({ owner: terminal() });
    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    p.instance.withMirrorLock = async (action) => {
      entered();
      await held;
      return { value: await action() };
    };
    const pending = p.instance.sweepWorktrees("repo:owner/name");
    await enteredLock;
    p.replaceBinding({ ...original, lastAttachAt: new Date(NOW).toISOString(), user: "worker3" });
    release();
    expect(await pending).toEqual({ evicted: [], kept: 1 });
    expect(p.removed).not.toHaveBeenCalled();
  });
});

describe("missing private tree recovery", () => {
  it("retires a terminal owner's independently absent directory and records the loss", async () => {
    const p = probe({ owner: ordinaryTerminal, privateTree: null, absentPrivateTree: true });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [threadKey], kept: 0 });
    expect(p.markPoolUserSpent).toHaveBeenCalledWith(original.user, `thread:${threadKey}`);
    expect(p.binding().evictedUnmeasured).toBe("private tree absent on active VM; prior contents unverified");
  });

  it("keeps an unreadable directory and a live owner", async () => {
    const unreadable = probe({ owner: ordinaryTerminal, privateTree: null });
    expect(await unreadable.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    const live = probe({ privateTree: null, absentPrivateTree: true });
    expect(await live.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(live.observeAbsentPrivateTree).not.toHaveBeenCalled();
    const wrongFence = probe({
      owner: ordinaryTerminal,
      privateTree: null,
      absentPrivateTree: true,
      fence: { ...runFence, ownerFence: runFence.ownerFence + 1 },
    });
    expect(await wrongFence.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(wrongFence.observeAbsentPrivateTree).not.toHaveBeenCalled();
  });

  it("keeps the binding if the historical UID spend cannot be fenced", async () => {
    const p = probe({ owner: ordinaryTerminal, privateTree: null, absentPrivateTree: true, spendAccepted: false });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(p.removed).not.toHaveBeenCalled();
  });

  it("rechecks absence under the mirror lock and keeps a newly present tree", async () => {
    const p = probe({ owner: ordinaryTerminal, privateTree: null, absentPrivateTree: true });
    let inMirrorLock = false;
    const observedInside: boolean[] = [];
    p.instance.withMirrorLock = async (action) => {
      inMirrorLock = true;
      try {
        return { value: await action() };
      } finally {
        inMirrorLock = false;
      }
    };
    p.observeAbsentPrivateTree.mockImplementation(async () => {
      observedInside.push(inMirrorLock);
      return !inMirrorLock;
    });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [], kept: 1 });
    expect(observedInside).toEqual([false, true]);
    expect(p.removed).not.toHaveBeenCalled();
  });

  it("does not delete a directory or home cache after missing-tree proof", async () => {
    const p = probe({ owner: ordinaryTerminal, privateTree: null, absentPrivateTree: true, cacheEligible: true });
    expect(await p.instance.sweepWorktrees("repo:owner/name")).toEqual({ evicted: [threadKey], kept: 0 });
    expect(p.observeAbsentPrivateTree).toHaveBeenCalledTimes(2);
    expect(p.removed).not.toHaveBeenCalled();
    expect(p.cleanCache).not.toHaveBeenCalled();
  });

  it("does not use missing-disk proof to authorize automatic VM loss", async () => {
    const p = probe({ owner: ordinaryTerminal, privateTree: null, absentPrivateTree: true });
    Object.assign(p.instance, {
      runsInFlightCount: () => 0,
      liveBindings: async () => [p.binding()],
      recordRefreshError: async () => {},
      recreateAdmission: { run: async (fn: () => Promise<boolean>) => ({ busy: false, value: await fn() }) },
    });
    expect(await p.instance.automaticContainerLoss("image-stale", async () => {})).toBe(false);
    expect(p.binding().evicted).toBe(false);
  });

  it("checks the shipped absent-directory probe and refuses uncertain evidence", async () => {
    const method = resident?.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === "observeAbsentPrivateTree",
    );
    if (!method) throw new Error("ResidentDO.observeAbsentPrivateTree is missing");
    const compiledProbe = ts.transpileModule(`class AbsentProbe { ${method.getText(source)} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let canonicalPath = original.worktreePath;
    const Probe = runInNewContext(`${compiledProbe}\nAbsentProbe`, {
      threadWorktreePath: async () => canonicalPath,
      replacementWorktreePath: async () => `${canonicalPath}-ref-hash`,
      parentDir: (path: string) => path.slice(0, path.lastIndexOf("/")),
      poolBindingKey: (user: string) => `pool:${user}`,
      parsePoolBindings,
      shellQuote,
    }) as new () => {
      observeAbsentPrivateTree(binding: typeof original): Promise<boolean>;
    };
    const check = async (
      options: {
        runtime?: boolean;
        state?: string;
        hydrating?: boolean;
        recreateHeld?: boolean;
        claimants?: string[];
        directoryPresent?: boolean;
        strayDirectory?: boolean;
        stageContent?: boolean;
        processActive?: boolean;
        wrongPath?: boolean;
        realDirectory?: string;
      } = {},
    ) => {
      canonicalPath = options.realDirectory ? `${options.realDirectory}/ref` : original.worktreePath;
      const instance = new Probe();
      Object.assign(instance, {
        isRuntimeActive: async () => options.runtime ?? true,
        getStatus: async () => ({ state: options.state ?? "warm" }),
        hydration: options.hydrating ? {} : null,
        recreateAdmission: { blocked: async () => options.recreateHeld ?? false },
        ctx: { storage: { get: async () => options.claimants ?? [threadKey] } },
        run: async (argv: string[]) =>
          argv[0] === "pgrep"
            ? {
                exitCode: options.processActive ? 0 : 1,
                stdout: options.processActive ? "12\n" : "",
                stderr: "",
                timedOut: false,
              }
            : options.realDirectory
              ? (() => {
                  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
                  return {
                    exitCode: result.status ?? 1,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    timedOut: false,
                  };
                })()
              : {
                  exitCode: options.directoryPresent ? 42 : 0,
                  stdout: options.directoryPresent ? "" : "absent\n",
                  stderr: "",
                  timedOut: false,
                },
        poolUserHasOldThreadDir: async () => options.strayDirectory ?? false,
        poolUserHasOldStageContent: async () => options.stageContent ?? false,
      });
      return instance.observeAbsentPrivateTree({
        ...original,
        worktreePath: options.wrongPath ? "/tmp/foreign" : canonicalPath,
      });
    };
    expect(await check()).toBe(true);
    for (const options of [
      { runtime: false },
      { state: "restoring" },
      { hydrating: true },
      { recreateHeld: true },
      { claimants: [threadKey, "another"] },
      { directoryPresent: true },
      { strayDirectory: true },
      { stageContent: true },
      { processActive: true },
      { wrongPath: true },
    ])
      expect(await check(options)).toBe(false);
    const root = mkdtempSync(join(tmpdir(), "resident missing tree "));
    try {
      expect(await check({ realDirectory: join(root, "absent dir") })).toBe(true);
      const present = join(root, "present dir");
      mkdirSync(present);
      expect(await check({ realDirectory: present })).toBe(false);
      symlinkSync(present, join(root, "linked dir"));
      expect(await check({ realDirectory: join(root, "linked dir") })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("one preservation guard covers automatic loss paths", () => {
  it("keeps the VM for a live owner and permits loss only for a verified terminal tree", async () => {
    for (const [owner, expected] of [
      [liveOwner, false],
      [terminal(), true],
    ] as const) {
      const p = probe({ owner });
      const action = vi.fn(async () => {});
      Object.assign(p.instance, {
        runsInFlightCount: () => 0,
        liveBindings: async () => [p.binding()],
        recordRefreshError: async () => {},
        recreateAdmission: { run: async (fn: () => Promise<boolean>) => ({ busy: false, value: await fn() }) },
      });
      expect(await p.instance.automaticContainerLoss("test", action)).toBe(expected);
      expect(action).toHaveBeenCalledTimes(expected ? 1 : 0);
    }
  });

  it("all worktree removals use the guarded primitive; VM loss and idle checks retain known owners", () => {
    const entry = workerText.slice(workerText.indexOf("export class ResidentDO"));
    const evict = methodOf(entry, "evictBinding")!;
    expect(evict.indexOf("workspaceRemovalDecision(before, runtimeActive)")).toBeLessThan(
      evict.indexOf('["rm", "-rf", threadDir]'),
    );
    for (const name of ["sweepWorktrees", "reclaimFinishedRefs", "admitThreadDisk", "detachThread"])
      expect(methodOf(entry, name), name).toContain("this.evictBinding(");
    for (const name of [
      "refreshFailed",
      "escalateRuntimeUnreachable",
      "recoverFromDiskFull",
      "reconcileImage",
      "restoreCheckout",
      "runProvisioning",
      "rebuild",
    ])
      expect(methodOf(entry, name), name).toContain("automaticContainerLoss");
    expect(methodOf(entry, "registeredRunsBeyondOps")).toContain("hasRunOwnerField(r)");
    expect(methodOf(entry, "isIdle")).toContain("registeredRunsBeyondOps");
  });

  it("attach cannot replace a retained checkout without the same preservation decision", () => {
    const entry = workerText.slice(workerText.indexOf("export class ResidentDO"));
    const attach = methodOf(entry, "attachThreadBody")!;
    const ensure = methodOf(entry, "ensureThreadWorktree")!;
    const ownPr = methodOf(entry, "rebindToOwnPr")!;
    const back = methodOf(entry, "returnBindingToDefault")!;
    expect(attach).toContain("guardWorkspaceReplacement(storedPrior)");
    expect(ownPr).toContain("guardWorkspaceReplacement(prior)");
    expect(back).toContain("guardWorkspaceReplacement(current)");
    expect(ensure.indexOf("guardWorkspaceReplacement(")).toBeLessThan(ensure.indexOf('["rm", "-rf", wt]'));
  });
});

describe("strict private-tree observation", () => {
  it("requires a present readable tree, exact branch and head, and explicit tracked, untracked and unpushed counts", () => {
    const output =
      "present=yes\nbranch=codex/owner-work\nhead=" + "b".repeat(40) + "\ntracked=0\nuntracked=1\nunpushed=2\n";
    const result = { stdout: output, exitCode: 0, timedOut: false };
    expect(parsePrivateTreeObservation(result)).toMatchObject({
      present: true,
      untrackedNonIgnored: 1,
      unpushedCommits: 2,
    });
    expect(parsePrivateTreeObservation({ ...result, stdout: output.replace("untracked=1\n", "") })).toBeNull();
    expect(parsePrivateTreeObservation({ ...result, stdout: output + "head=" + "b".repeat(40) + "\n" })).toBeNull();
    expect(parsePrivateTreeObservation({ ...result, stdout: output.replace("present=yes", "present=no") })).toBeNull();
    expect(parsePrivateTreeObservation({ ...result, truncated: true })).toBeNull();
    expect(parsePrivateTreeObservation({ ...result, exitCode: 1 })).toBeNull();
    expect(parsePrivateTreeObservation({ ...result, timedOut: true })).toBeNull();
  });

  it("runs Git as the thread user and includes non-ignored untracked files", () => {
    const script = privateTreeObservationScript(original.worktreePath, original.user);
    expect(script).toContain("su -s /bin/bash");
    expect(script).toContain("--untracked-files=all");
    expect(script).toContain("git symbolic-ref --quiet --short HEAD");
    expect(script).toContain("git rev-parse --verify HEAD");
    expect(script).toContain("git rev-list --count HEAD --not --remotes");
  });
});
