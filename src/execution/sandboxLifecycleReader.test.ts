import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  checkpointIfSafe,
  sameOwner,
  normalizedSeedDoorOrigin,
  boundSeedOriginMatches,
  seedClaimHeadMatches,
  type CheckpointRecord,
} from "./sandboxCheckpoint.js";
import { decodeLifecycle, updateCheckpoint, type LifecycleRecord } from "./sandboxOperationWindow.js";
import { seedMarkerText } from "./seedPlan.js";
import { sandboxStartingAnswer } from "./sandboxErrors.js";

const OWNER_KEY = "switchboard.preservation.owner";
const SEED_KEY = "switchboard.preservation.seedState";
const legacy: CheckpointRecord = {
  owner: {
    run: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requester: "mcp:operator",
    thread: "mcp:thread",
    repository: "example/project",
    ref: "main",
    head: "b".repeat(40),
    seed: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    container: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  },
  doorOrigin: "https://example.test",
  backupId: "checkpoint-original",
};
const versioned = (): LifecycleRecord => ({
  version: 2,
  lifecycle: {
    allocation: {
      runId: legacy.owner.run,
      ownerGen: "original-generation",
      allocationKey: "original-allocation",
      actorId: "a".repeat(64),
    },
    binding: "pending",
    admission: "open",
    operationWindow: { issuedThrough: 0, settledThrough: 0, slots: Array(16).fill(null) },
  },
});

function actualMethods(): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const path = new URL("../../deploy/cloudflare-sandbox/worker.ts", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const klass = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "SwitchboardSandbox",
  );
  const names = [
    "preserveBeforeDestroy",
    "preservationRecord",
    "inspectRepairDependencies",
    "seed",
    "claimMatches",
    "readLegacyPreservation",
    "saveLegacyPreservation",
  ];
  const methods = klass?.members.filter(
    (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && names.includes(node.name.getText(source)),
  );
  if (!methods) throw new Error("preservation methods unavailable");
  const compiled = ts.transpileModule(
    `class Methods { ${methods.map((method) => method.getText(source)).join("\n")} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  return new Function(
    "PRESERVATION_KEY",
    "PRESERVATION_SEED_STATE_KEY",
    "SEED_MARKER",
    "PRESERVATION_CONTAINER_MARKER",
    "checkpointIfSafe",
    "decodeLifecycle",
    "updateCheckpoint",
    "sameOwner",
    "normalizedSeedDoorOrigin",
    "boundSeedOriginMatches",
    "seedClaimHeadMatches",
    "seedMarkerText",
    "sandboxStartingAnswer",
    `${compiled}\nreturn Methods.prototype;`,
  )(
    OWNER_KEY,
    SEED_KEY,
    "/fixture-seed",
    "/fixture-container",
    checkpointIfSafe,
    decodeLifecycle,
    updateCheckpoint,
    sameOwner,
    normalizedSeedDoorOrigin,
    boundSeedOriginMatches,
    seedClaimHeadMatches,
    seedMarkerText,
    sandboxStartingAnswer,
  );
}
function actualGuard() {
  return actualMethods().preserveBeforeDestroy as (this: ReturnType<typeof host>, why: "idle") => Promise<boolean>;
}
function host(record: unknown, options: { seeded?: boolean; running?: boolean } = {}) {
  const f = {
    ctx: {
      container: { running: options.running ?? true },
      id: { name: legacy.owner.thread, toString: () => "f".repeat(64) },
      storage: {
        get: vi.fn(async (key: string) =>
          key === OWNER_KEY ? record : key === SEED_KEY ? (options.seeded ? "seeded" : "unseeded") : undefined,
        ),
        put: vi.fn(),
      },
    },
    exists: vi.fn(async () => ({ success: true, exists: options.seeded ?? false })),
    readFile: vi.fn(async () => ({ content: legacy.owner.container })),
    createBackup: vi.fn(),
    idle: { served: vi.fn(async (operation: () => Promise<unknown>) => operation()) },
    checkoutFence: { shared: vi.fn(async (operation: () => Promise<unknown>) => operation()) },
    gate: { through: vi.fn(async (operation: () => Promise<unknown>) => operation()) },
    seedNow: vi.fn(async () => ({ seeded: true, cached: false, sha: legacy.owner.head })),
    writeFile: vi.fn(),
    env: {},
  };
  Object.setPrototypeOf(f, actualMethods());
  return f;
}

describe("sandbox preservation lifecycle reader", () => {
  it("retains pending or unverified versioned records before a waking probe or unseeded teardown", async () => {
    const pending = versioned();
    const bound = { ...versioned(), owner: legacy.owner };
    bound.lifecycle.binding = "bound";
    const closing = versioned();
    closing.lifecycle.admission = "closing";
    const unknown = versioned();
    unknown.lifecycle.binding = "unknown";
    for (const record of [pending, bound, closing, unknown]) {
      const f = host(record);
      expect(await actualGuard().call(f, "idle")).toBe(false);
      expect(f.exists).not.toHaveBeenCalled();
      expect(f.readFile).not.toHaveBeenCalled();
      expect(f.createBackup).not.toHaveBeenCalled();
    }
  });
  it("retains malformed present records without consulting the SDK", async () => {
    for (const record of [{}, null, { ...legacy, lifecycle: versioned().lifecycle }, { ...versioned(), version: 3 }]) {
      const f = host(record);
      expect(await actualGuard().call(f, "idle")).toBe(false);
      expect(f.exists).not.toHaveBeenCalled();
    }
  });
  it("keeps the positively unseeded no-record legacy path", async () => {
    const f = host(undefined);
    expect(await actualGuard().call(f, "idle")).toBe(true);
    expect(f.exists).toHaveBeenCalledOnce();
    expect(f.createBackup).not.toHaveBeenCalled();
  });
  it("keeps complete legacy seeded ownership retained", async () => {
    const f = host(legacy, { seeded: true });
    expect(await actualGuard().call(f, "idle")).toBe(false);
    expect(f.readFile).toHaveBeenCalledOnce();
    expect(f.createBackup).not.toHaveBeenCalled();
    expect(f.ctx.storage.put).not.toHaveBeenCalled();
  });
  it("does not inspect a stopped container", async () => {
    const f = host(versioned(), { running: false });
    expect(await actualGuard().call(f, "idle")).toBe(false);
    expect(f.ctx.storage.get).not.toHaveBeenCalled();
    expect(f.exists).not.toHaveBeenCalled();
  });
  it("retains conflicting legacy owner and unseeded classification without a probe", async () => {
    const f = host(legacy);
    expect(await actualGuard().call(f, "idle")).toBe(false);
    expect(f.exists).not.toHaveBeenCalled();
  });
});

describe("sandbox preservation metadata", () => {
  it("reports unsupported repair metadata as unknown even without a prior attempt", async () => {
    const f = host(versioned());
    expect(await actualMethods().inspectRepairDependencies!.call(f, legacy.owner, legacy.owner.head)).toEqual({
      kind: "unknown",
    });
    expect(f.exists).not.toHaveBeenCalled();
    expect(f.ctx.storage.put).not.toHaveBeenCalled();
  });
  it("keeps the normal legacy no-attempt repair metadata result", async () => {
    const f = host(legacy);
    expect(await actualMethods().inspectRepairDependencies!.call(f, legacy.owner, legacy.owner.head)).toEqual({
      kind: "none",
    });
  });
  it("keeps unsupported lifecycle data unavailable instead of exposing it as legacy or missing", async () => {
    for (const record of [versioned(), {}, null]) {
      const f = host(record);
      await expect(actualMethods().preservationRecord!.call(f)).rejects.toThrow("preservation lifecycle unavailable");
      expect(f.exists).not.toHaveBeenCalled();
      expect(f.createBackup).not.toHaveBeenCalled();
    }
  });
  it("preserves the legacy snapshot and the truly absent record", async () => {
    for (const record of [legacy, undefined]) {
      const f = host(record);
      expect(await actualMethods().preservationRecord!.call(f)).toMatchObject({ record: record ?? null });
      expect(f.exists).not.toHaveBeenCalled();
    }
  });
  it("refuses unsupported seed preflight before idle warm-up and classification writes", async () => {
    const f = host(versioned());
    const claim = { ...legacy.owner };
    delete (claim as Partial<typeof claim>).container;
    const seed = {
      slug: legacy.owner.repository,
      ref: legacy.owner.ref,
      sha: legacy.owner.head,
      checkoutBackupId: legacy.owner.seed,
    };
    const result = await actualMethods().seed!.call(f, seed, { GIT_DOOR_ORIGIN: legacy.doorOrigin }, claim);
    expect(result).toMatchObject({ seeded: false, reason: "seed-incompatible" });
    expect(f.idle.served).not.toHaveBeenCalled();
    expect(f.gate.through).not.toHaveBeenCalled();
    expect(f.ctx.storage.put).not.toHaveBeenCalled();
    expect(f.seedNow).not.toHaveBeenCalled();
    expect(f.writeFile).not.toHaveBeenCalled();
  });
});
