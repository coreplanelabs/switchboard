import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isBackgroundOperationHeld, withTimeout } from "../../src/execution/residentRefresh.js";
import { methodOf, readSource } from "./testing/sourceScan";

// Item 67 (docs/reference/specs/resident-repos.md): consecutive refresh cycles
// that fail in the resident's OWN steps climb a ladder — count, recreate the
// container, down into item 36's rebuild — while a failure in the repository's
// command keeps parking. Plain Node, the entry read as text, never loaded —
// like runtimeUnreachable.test.ts and autoRebuild.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

function residentWithMethod(name: string, globals: Record<string, unknown>): any {
  const compiled = ts.transpileModule(`class Resident { ${method(name)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Resident = runInNewContext(`${compiled}\nResident`, globals);
  return new Resident();
}

function heldOperation(): Error {
  const held = new Error("workspace outcome is unknown");
  held.name = "BackgroundOperationHeldError";
  return held;
}

function opaqueOutcome(): Error {
  const start = source.indexOf("class OpaqueNativeOutcomeUnconfirmedError extends Error");
  const end = source.indexOf("type NativeRequestContext", start);
  const compiled = ts.transpileModule(`${source.slice(start, end)}\nOpaqueNativeOutcomeUnconfirmedError`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const OpaqueNativeOutcomeUnconfirmedError = runInNewContext(compiled);
  return new OpaqueNativeOutcomeUnconfirmedError("original SDK outcome is unconfirmed");
}

describe("the count lives in storage under one key", () => {
  it("noteInfraStreak is the one writer that bumps it; refreshComplete, a repo-step failure, the down rung and the fault injection are its erasers", () => {
    expect(source).toMatch(/^const INFRA_STREAK_KEY = "resident:infraStreak";$/m);
    expect(method("noteInfraStreak")).toMatch(/this\.ctx\.storage\.put\(INFRA_STREAK_KEY, row\)/);
    expect(method("refreshComplete")).toMatch(/storage\.delete\(INFRA_STREAK_KEY\)/);
    const others = residentDO.replace(method("noteInfraStreak"), "").replace(method("debugSetInfraStreak"), "");
    expect(others).not.toMatch(/storage\.put\(INFRA_STREAK_KEY/);
  });
});

describe("refreshFailed climbs the ladder for resident steps and parks for repo steps", () => {
  const body = () => method("refreshFailed");

  it("keeps a held original operation degraded without counting it as a VM fault", async () => {
    const compiled = ts.transpileModule(`class Resident { ${body()} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Resident = runInNewContext(`${compiled}\nResident`, {
      console: { log: () => {} },
      INFRA_STREAK_KEY: "resident:infraStreak",
      isRepoCommandStep: () => false,
    });
    const resident = new Resident();
    const calls: string[] = [];
    resident.ctx = {
      storage: {
        delete: async (key: string) => {
          calls.push(`delete:${key}`);
        },
      },
    };
    resident.recordRefreshError = async (reason: string) => {
      calls.push(`record:${reason}`);
    };
    resident.setResidentState = async (state: string, reason: string) => {
      calls.push(`state:${state}:${reason}`);
    };
    resident.noteInfraStreak = async () => {
      throw new Error("held operation counted as a VM fault");
    };
    await resident.refreshFailed(
      {
        step: "measure",
        reason: "refresh-held: an earlier operation is still active or its result is unknown",
        operationHeld: true,
        diskFull: false,
      },
      0,
    );
    expect(calls).toEqual([
      "record:refresh-held: an earlier operation is still active or its result is unknown",
      "delete:resident:infraStreak",
      "state:degraded:refresh-held: an earlier operation is still active or its result is unknown",
    ]);
  });

  it("a repo-command step's failure is degraded as before and ends the resident-step streak", () => {
    const b = body();
    const repo = b.indexOf("if (isRepoCommandStep(failure.step))");
    expect(repo).toBeGreaterThan(-1);
    const branch = b.slice(repo, b.indexOf("const row = await this.noteInfraStreak"));
    expect(branch).toMatch(/storage\.delete\(INFRA_STREAK_KEY\)/);
    expect(branch).toMatch(/setResidentState\("degraded", failure\.reason\)/);
  });

  it("a resident step's failure is counted and the rung decides: count → degraded; recreate → recreateContainer with the infra-streak reason; down → fenced destroy, clear the row, goDown", () => {
    const b = body();
    expect(b).toMatch(/const row = await this\.noteInfraStreak\(failure\.step\)/);
    expect(b).toMatch(/switch \(infraStreakRung\(row\.count\)\)/);
    const recreate = b.slice(b.indexOf('case "recreate"'), b.indexOf('case "down"'));
    expect(recreate).toMatch(/await this\.recreateContainer\(infraStreakReason\(row, "recreate"\)\)/);
    const down = b.slice(b.indexOf('case "down"'));
    expect(down).toMatch(/infraStreakReason\(row, "down"\)/);
    expect(down).toMatch(/await this\.destroyConfirmed\(\)/);
    expect(down).toMatch(/storage\.delete\(INFRA_STREAK_KEY\)/);
    expect(down).toMatch(/await this\.goDown\(reason\)/);
  });

  it("the disk-full recovery keeps its own path, before any counting", () => {
    const b = body();
    expect(b.indexOf("if (failure.diskFull)")).toBeLessThan(b.indexOf("isRepoCommandStep"));
  });
});

describe("journal holds stay outside restore recovery", () => {
  it("recognizes the real unknown native outcome error through a snapshot wrapper", () => {
    const unknown = opaqueOutcome();
    expect(unknown.name).toBe("OpaqueNativeOutcomeUnconfirmedError");
    expect(isBackgroundOperationHeld(new Error("snapshot failed", { cause: unknown }))).toBe(true);
  });

  it.each(["rejected effect", "invalid acknowledgement", "lost settlement"])(
    "keeps a %s as an unknown native outcome",
    async (scenario) => {
      const resident = residentWithMethod("withOpaqueNativeEffect", {
        OpaqueNativeOutcomeUnconfirmedError: opaqueOutcome().constructor,
      });
      resident.beginThreadNativeOperation = async () => ({
        settle: async () => {
          if (scenario === "lost settlement") throw new Error("storage reply lost");
        },
      });
      let failure: unknown;
      try {
        await resident.withOpaqueNativeEffect(
          async () => {
            if (scenario === "rejected effect") throw new Error("backup reply lost");
            return { id: "backup" };
          },
          () => scenario !== "invalid acknowledgement",
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ name: "OpaqueNativeOutcomeUnconfirmedError" });
      expect(isBackgroundOperationHeld(failure)).toBe(true);
    },
  );

  it.each(["rejected upload", "mirror timeout", "checkout timeout"])(
    "holds a %s before VM recovery",
    async (scenario) => {
      let call = 0;
      const resident = residentWithMethod("takeSnapshot", {
        backupTransferMode: () => ({ mode: "local", localBucket: true, missing: [] }),
        MIRROR_DIR: "/mirror",
        CHECKOUT_DIR: "/checkout",
        SNAPSHOT_TTL_S: 100,
        CHECKOUT_SNAPSHOT_EXCLUDES: [],
        R2_TRANSFER_TIMEOUT_MS: 5,
        withTimeout,
        OpaqueNativeOutcomeUnconfirmedError: opaqueOutcome().constructor,
        StepError: class extends Error {
          constructor(
            public step: string,
            message: string,
            cause: unknown,
          ) {
            super(message, { cause });
          }
        },
        errMsg: (error: { message?: string }) => error.message ?? "unknown",
        console: { log: () => {} },
      });
      resident.withOpaqueNativeEffect = async () => {
        call++;
        if (
          (scenario === "rejected upload" && call === 1) ||
          (scenario === "mirror timeout" && call === 1) ||
          (scenario === "checkout timeout" && call === 2)
        ) {
          if (scenario === "rejected upload") throw opaqueOutcome();
          return new Promise(() => {});
        }
        return { id: "backup", dir: call === 1 ? "/mirror" : "/checkout" };
      };
      let failure: unknown;
      try {
        await resident.takeSnapshot("repo:example", "main", "sha", "key");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ step: "snapshot", cause: { name: "OpaqueNativeOutcomeUnconfirmedError" } });
      expect(isBackgroundOperationHeld(failure)).toBe(true);
    },
  );

  it.each(["journal", "opaque outcome"])("a refused %s checkout restore preserves the VM", async (scenario) => {
    const held = scenario === "journal" ? heldOperation() : opaqueOutcome();
    const calls: string[] = [];
    const resident = residentWithMethod("restoreCheckout", {
      planRestore: () => ({ action: "restore" }),
      MIRROR_DIR: "/mirror",
      CHECKOUT_DIR: "/checkout",
      STAGING_CHECKOUT_DIR: "/staging",
      RETIRED_CHECKOUT_DIR: "/retired",
      DISK_MARKERS: [],
      systemClock: () => 0,
      isBackgroundOperationHeld,
    });
    resident.pendingRestores = new Set();
    resident.readyStamp = async () => null;
    resident.runOk = async (_argv: unknown, step: string) => {
      calls.push(step);
    };
    resident.restoreExtracted = async () => {
      calls.push("restore");
      throw held;
    };
    resident.isRuntimeActive = async () => {
      throw new Error("a held restore probed the runtime");
    };
    resident.automaticContainerLoss = async () => {
      throw new Error("a held restore reached VM recovery");
    };
    await expect(resident.restoreCheckout({ sha: "a" }, 1000)).rejects.toBe(held);
    expect(calls).toEqual(["clean-before-restore", "restore"]);
  });

  it("a still-running original restore does not authorize a VM stop", async () => {
    const resident = residentWithMethod("restoreCheckout", {
      planRestore: () => ({ action: "restore" }),
      systemClock: () => 0,
      withTimeout,
      OpaqueNativeOutcomeUnconfirmedError: opaqueOutcome().constructor,
    });
    resident.pendingRestores = new Set([new Promise(() => {})]);
    resident.readyStamp = async () => null;
    resident.runOk = async () => {
      throw new Error("unknown restore reached cleanup");
    };
    resident.automaticContainerLoss = async () => {
      throw new Error("unknown restore stopped the VM");
    };
    let failure: unknown;
    try {
      await resident.restoreCheckout({ sha: "sha" }, 5);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: "OpaqueNativeOutcomeUnconfirmedError" });
    expect(isBackgroundOperationHeld(failure)).toBe(true);
  });

  it("a held dependency restore keeps its backup and does not install instead", async () => {
    const held = heldOperation();
    const cleanupRefusal = new AggregateError([new Error("backup data missing"), held], "cleanup is held", {
      cause: held,
    });
    const calls: string[] = [];
    const resident = residentWithMethod("materializeDeps", {
      planDepsMaterialization: () => ({ action: "restore" }),
      systemClock: () => 0,
      RESTORE_MAX_MS: 1000,
      crypto: { randomUUID: () => "attempt" },
      OpaqueNativeOutcomeUnconfirmedError: class extends Error {},
      isBackgroundOperationHeld,
    });
    resident.depsInFlight = new Map();
    resident.depsBackupRecord = async () => ({ backup: { id: "original" } });
    resident.depsEntryComplete = async () => false;
    resident.assertThreadOperationAllowed = async () => {};
    resident.withSharedNativeOperation = async (_source: string, work: () => Promise<unknown>) => work();
    resident.restoreDepsEntry = async () => {
      calls.push("restore");
      throw cleanupRefusal;
    };
    resident.dropDepsBackups = async () => {
      calls.push("drop-backup");
    };
    resident.installDepsEntry = async () => {
      calls.push("install");
    };
    await expect(resident.materializeDeps("key", "sha", "install", 1000)).rejects.toBe(cleanupRefusal);
    expect(calls).toEqual(["restore"]);
    expect(resident.depsInFlight.size).toBe(0);
  });

  it.each(["direct hold", "cleanup hold"])("dependency restore preserves a %s", async (scenario) => {
    const held = heldOperation();
    const ordinary = new Error("backup data missing");
    const calls: string[] = [];
    const resident = residentWithMethod("restoreDepsEntry", {
      depsScratchPath: () => "/scratch",
      depsStagingPath: () => "/staging",
      systemClock: () => 0,
      OpaqueNativeOutcomeUnconfirmedError: class extends Error {},
      isBackgroundOperationHeld,
    });
    resident.ensureDepsStoreDir = async () => {
      calls.push("open-store");
      throw scenario === "direct hold" ? held : ordinary;
    };
    resident.run = async () => {
      calls.push("cleanup");
      throw held;
    };
    let failure: unknown;
    try {
      await resident.restoreDepsEntry("key", {}, 1000, "attempt");
    } catch (error) {
      failure = error;
    }
    if (scenario === "direct hold") {
      expect(failure).toBe(held);
      expect(calls).toEqual(["open-store"]);
    } else {
      expect(failure).toMatchObject({ errors: [ordinary, held], cause: held });
      expect(isBackgroundOperationHeld(failure)).toBe(true);
      expect(calls).toEqual(["open-store", "cleanup"]);
    }
  });

  it.each(["direct hold", "cleanup hold"])("dependency install preserves a %s", async (scenario) => {
    const held = heldOperation();
    const ordinary = new Error("install failed");
    const calls: string[] = [];
    const resident = residentWithMethod("installDepsEntry", {
      depsScratchPath: () => "/scratch",
      depsStagingPath: () => "/staging",
      systemClock: () => 0,
      isBackgroundOperationHeld,
    });
    resident.acquireDepsInstallSlot = async () => {};
    resident.releaseDepsInstallSlot = () => calls.push("release-slot");
    resident.ensureDepsStoreDir = async () => {
      calls.push("open-store");
      throw scenario === "direct hold" ? held : ordinary;
    };
    resident.run = async () => {
      calls.push("cleanup");
      throw held;
    };
    let failure: unknown;
    try {
      await resident.installDepsEntry("key", "sha", "install", 1000, { attempt: "attempt" });
    } catch (error) {
      failure = error;
    }
    if (scenario === "direct hold") {
      expect(failure).toBe(held);
      expect(calls).toEqual(["open-store", "release-slot"]);
    } else {
      expect(failure).toMatchObject({ errors: [ordinary, held], cause: held });
      expect(isBackgroundOperationHeld(failure)).toBe(true);
      expect(calls).toEqual(["open-store", "cleanup", "release-slot"]);
    }
  });

  it("a held old dependency attempt stops a replacement install", async () => {
    const held = heldOperation();
    const calls: string[] = [];
    const resident = residentWithMethod("installDeps", {
      planInstallDeps: () => ({ action: "install" }),
      crypto: { randomUUID: () => "new-attempt" },
      depsLeaseKey: () => "lease",
      systemClock: () => 0,
      DEPS_STEP_OVERHEAD_MS: 100,
      takeMutex: () => ({ action: "take", dead: { tree: "/old" }, why: "expired" }),
      depsScratchPath: () => "/new",
      depsAttemptOfScratchPath: () => "old-attempt",
      depsAttemptPaths: () => ["/old", "/old-staging"],
      killStaleBuildProcessesCommand: () => ["kill-stale"],
      BUILD_USER: "worker1",
      console: { log: () => {} },
      isBackgroundOperationHeld,
    });
    resident.ctx = {
      storage: {
        get: async () => null,
        put: async () => calls.push("lease"),
      },
    };
    resident.depsEntryComplete = async () => false;
    resident.nextHolder = () => "holder";
    resident.runOk = async () => "";
    resident.run = async () => {
      calls.push("cleanup");
      throw held;
    };
    resident.materializeDeps = async () => {
      calls.push("install");
    };
    await expect(resident.installDeps({ key: "key", sha: "sha", installCmd: "install", budgetMs: 1000 })).rejects.toBe(
      held,
    );
    expect(calls).toEqual(["cleanup"]);
  });

  it("hydration cannot mark a held dependency adoption ready", async () => {
    const held = heldOperation();
    const states: string[] = [];
    const snap = { ref: "main", sha: "sha", lockfileHash: "key" };
    const resident = residentWithMethod("doHydrate", {
      STATE_KEY: "state",
      SNAPSHOT_KEY: "snapshot",
      FACTS_KEY: "facts",
      RESTORE_MAX_MS: 1000,
      systemClock: () => 0,
      isBackgroundOperationHeld,
    });
    resident.ctx = {
      storage: {
        get: async () =>
          new Map([
            ["state", "warm"],
            ["snapshot", snap],
            ["facts", { defaultRef: "main", sha: "sha", lockfileHash: "key" }],
          ]),
      },
    };
    resident.isRuntimeActive = async () => false;
    resident.setResidentState = async (state: string) => states.push(state);
    resident.restoreCheckout = async () => ({ done: false });
    resident.adoptCheckoutDeps = async () => {
      throw held;
    };
    resident.writeDiskMarkers = async () => {
      throw new Error("held hydration wrote ready markers");
    };
    await expect(resident.doHydrate()).rejects.toBe(held);
    expect(states).toEqual(["restoring"]);
  });

  it("hydration cannot mark an unknown dependency materialization ready", async () => {
    const held = opaqueOutcome();
    const states: string[] = [];
    const snap = { ref: "main", sha: "sha", lockfileHash: "key" };
    const resident = residentWithMethod("doHydrate", {
      STATE_KEY: "state",
      SNAPSHOT_KEY: "snapshot",
      FACTS_KEY: "facts",
      RESOURCE_KEY: "resource",
      CHECKOUT_DIR: "/checkout",
      RESTORE_MAX_MS: 1000,
      REFRESH_INSTALL_TIMEOUT_MS: 1000,
      systemClock: () => 0,
      isBackgroundOperationHeld,
      planMaterializeDeps: () => ({ action: "materialize", why: "missing" }),
      planWakeDepsBudget: () => ({ action: "install", installBudgetMs: 100 }),
      console: { log: () => {} },
    });
    resident.ctx = {
      storage: {
        get: async (key: unknown) =>
          Array.isArray(key)
            ? new Map([
                ["state", "warm"],
                ["snapshot", snap],
                ["facts", { defaultRef: "main", sha: "sha", lockfileHash: "key" }],
              ])
            : "repo:example",
      },
    };
    resident.registry = () => ({ getRecord: async () => ({ commands: { install: "install" } }) });
    resident.isRuntimeActive = async () => false;
    resident.setResidentState = async (state: string) => states.push(state);
    resident.restoreCheckout = async () => ({ done: false });
    resident.adoptCheckoutDeps = async () => {};
    resident.run = async () => ({ exitCode: 1 });
    resident.depsEntryComplete = async () => false;
    resident.installDeps = async () => {
      throw held;
    };
    resident.writeDiskMarkers = async () => {
      throw new Error("held hydration wrote ready markers");
    };
    await expect(resident.doHydrate()).rejects.toBe(held);
    expect(states).toEqual(["restoring"]);
  });
});

describe("the fetch step names GitHub only for GitHub's failures", () => {
  it("a fetch that failed on the mirror goes through refreshFailed as the resident step `fetch` before anything is called github-unreachable", () => {
    const body = method("refreshFetch");
    const mirror = body.indexOf("if (fetchFailureIsMirrors(message))");
    const github = body.indexOf("const reason = `github-unreachable: ${message}`");
    expect(mirror).toBeGreaterThan(-1);
    expect(github).toBeGreaterThan(mirror);
    const branch = body.slice(mirror, github);
    expect(branch).toMatch(/await this\.refreshFailed\(failure, selfInFlight\)/);
    expect(branch).toMatch(/return \{ ok: false, reason: failure\.reason \}/);
    // The failure handed on was classified with the step named `fetch`.
    expect(body).toMatch(/const failure = await this\.classifyFailure\("fetch", message\)/);
  });
});

describe("the reasons are read as the resident's, never the repo's", () => {
  it("`infra-streak:` is a non-evidence reason (the gate always runs the next cycle) and the gate parks only what parksOnRepeat allows", () => {
    const m = /^const NON_EVIDENCE_REASON = \/(.*)\/;$/m.exec(source);
    expect(m).not.toBeNull();
    expect(new RegExp(m![1]).test("infra-streak: 3 consecutive cycles failed …")).toBe(true);
    expect(source).toMatch(
      /entry\.state === "degraded" && !isNonEvidenceReason\(entry\.reason\) && parksOnRepeat\(entry\.reason\)/,
    );
  });
});

describe("the fault injection and the read view", () => {
  it("`infra-streak` sets the row's count (0 deletes it) and `break-mirror` removes the mirror's config — a fault the wake check does not heal — under its own step name; both are admin-only by construction", () => {
    expect(method("debugSetInfraStreak")).toMatch(
      /if \(count === 0\) \{\s*await this\.ctx\.storage\.delete\(INFRA_STREAK_KEY\)/,
    );
    // The fault must survive the wake check (`readyStamp` tests `objects/`
    // and `.git`): removing the mirror's `config` leaves both and makes the
    // fetch fail — `'origin' does not appear to be a git repository`.
    expect(method("debugBreakMirror")).toMatch(/\["rm", "-f", `\$\{MIRROR_DIR\}\/config`\], "break-mirror"/);
    expect(method("debugBreakMirror")).not.toMatch(/objects/);
    const readOps = /^const READ_DEBUG_OPS = new Set\(\[([^\]]*)\]\);$/m.exec(source);
    expect(readOps).not.toBeNull();
    expect(readOps![1]).not.toMatch(/infra-streak|break-mirror/);
    expect(source).toMatch(/case "infra-streak":/);
    expect(source).toMatch(/case "break-mirror":/);
  });

  it("`/debug info` reads the row and carries it with its rung", () => {
    const body = method("getResidentInfo");
    const list = /const map = await this\.ctx\.storage\.get<unknown>\(\[([^\]]*)\]\)/.exec(body);
    expect(list![1]).toMatch(/\bINFRA_STREAK_KEY\b/);
    expect(body).toMatch(/infraStreak: /);
    expect(body).toMatch(/rung: infraStreakRung\(row\.count\)/);
  });
});
