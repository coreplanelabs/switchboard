import { RESTORE_BACKUP_EXPIRY_BUFFER_MS } from "../../src/core/budgets.js";
import {
  archiveControlAnswer,
  archiveCapabilitySchema,
  executeRestoreArchive,
  prepareRestoreArchive,
  restoreIdentitySchema,
  restorePrivateDirectory,
  RestoreArchiveUnconfirmedError,
} from "./restoreArchive.js";
import { captureException } from "../../src/core/runStateWriteDiagnostic.js";
import { NativeRunScopes, CloudflareNativeScopeTransport } from "./nativeScope.js";
import { RecordedCheckOperation } from "./checkOperation.js";
import { checkCommandHash } from "../../src/execution/checkOperation.js";
import type { CheckSource } from "../../src/core/checkInspection.js";
import { NativeOperationJournal, unstartedNativeOperator, nativeOperationOriginSchema } from "./nativeOperation.js";
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError,
  BackupNotFoundError,
  BackupExpiredError,
} from "@cloudflare/sandbox/errors";
import { levelPosts, memorySide, mergeOutbox, seatSide } from "./levels.js";
import { uidLedger, uidOwner, issuedUidCount, claimUid, reserveUid, readUidReport } from "./uidOwnership";
import { provisionUidCommand } from "./uidProvision";
import { isResidentPoolUser } from "../../src/execution/residentPoolSpends.js";
import {
  isWorkspaceOwner,
  isAcknowledgedWorkspaceOwner,
  workspaceOwnerKey,
  workspaceBindingOf,
  workspaceSettlementOf,
} from "../../src/core/workspaceSettlement";
import { webcrypto } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { idleForPoolRecycle, retryPoolRecycleAfterRefresh } from "../../src/execution/residentRecreateAdmission.js";
import { liveDrain } from "./drain.js";
import { KeyedAsyncLock } from "./keyedAsyncLock.js";
import {
  killStaleBuildProcessesCommand,
  accumulateRestoreProgress,
  judgeRestoreProgress,
  runtimeUnreachableReason,
  runtimeUnreachableRung,
} from "../../src/execution/residentRefresh.js";
import { ControlResetError } from "./threadErr.js";
import { SandboxRuntimeBusyError } from "../../src/execution/sandboxErrors.js";
import { methodOf, readSource } from "./testing/sourceScan";
import {
  mayRunAsPoolUser,
  parsePoolBindings,
  parseSpentPoolUsers,
  spendPoolUser,
  unavailablePoolUsers,
  ownedPoolUsers,
} from "../../src/execution/residentPoolSpends";
import { admitThreadDiskWithRollback, boundByFor, rememberOwnBranches } from "../../src/execution/residentRebind";
import { planForceDetach } from "../../src/execution/residentDetach";
import { decideWorkspaceRemoval, hasRunOwnerField } from "./workspacePreservation";
import {
  classifyDeployRegistration,
  classifyDeployRegistrationWithLedger,
  deployRegistrationState,
  registeredRunAllowsClaim,
  registeredRunAllowsReattach,
  registeredRunNeedsProtection,
  registeredRunOwnsRelease,
  decideOwnerReconciliation,
  validRunOwner,
} from "./runRegistration";

describe("deploy registration activity", () => {
  const registration = { threadKey: "mcp:run", runId: "r1", ownerGen: "g1", ownerFence: 7 };
  const fence = { runId: "r1", ownerGen: "g1", ownerFence: 7 };
  const state = (owner: unknown, patch: Record<string, unknown> = {}) =>
    deployRegistrationState({ threadKey: "mcp:run", registration, fence, owner, ...patch });

  it("counts a live owner as executing and keeps an exact terminal owner retained", () => {
    expect(state({ kind: "live", row: { runId: "r1", threadKey: "mcp:run", ownerGen: "g1" } })).toBe("executing");
    expect(state({ kind: "terminal", record: { id: "r1", threadKey: "mcp:run", status: "failed" } })).toBe("retained");
    expect(state({ kind: "terminal", record: { id: "r1", threadKey: "mcp:run", status: "stopped_hard" } })).toBe(
      "retained",
    );
  });

  it("retains an exact acknowledged owner without granting workspace removal", () => {
    const owner = { kind: "acknowledged", owner: fence, revision: 1 };
    expect(state(owner)).toBe("retained");
    expect(
      decideWorkspaceRemoval({
        binding: { threadKey: "mcp:run", ref: "main", user: "worker2", worktreePath: "/private/work" },
        registration,
        fence,
        owner,
        tree: { present: false, absenceVerified: true },
      }),
    ).toEqual({ removable: false, reason: "owner-unverified" });
  });

  it("keeps acknowledged retention subject to the exact UID ledger and sole claimant", () => {
    const input = {
      threadKey: "mcp:run",
      registration,
      fence,
      owner: { kind: "acknowledged", owner: fence, revision: 1 },
      user: "worker2",
      ledger: [{ user: "worker2", owner: "thread:mcp:run" }],
      claimants: ["mcp:run"],
      pool: ["worker2"],
      cutoff: 0,
      now: 1_000_000,
      graceMs: 60_000,
      opInFlight: 0,
    };
    expect(classifyDeployRegistrationWithLedger(input).state).toBe("retained");
    expect(classifyDeployRegistrationWithLedger({ ...input, ledger: [] })).toMatchObject({
      state: "unknown",
      reason: "ledger-unverified",
    });
    expect(classifyDeployRegistrationWithLedger({ ...input, claimants: ["mcp:run", "mcp:other"] })).toMatchObject({
      state: "unknown",
      reason: "binding-conflict",
    });
  });

  it("reconciles an acknowledged owner through the same retained observation", () => {
    expect(
      decideOwnerReconciliation({
        binding: { threadKey: "mcp:run", user: "worker2" },
        registration,
        fence,
        lastRunOwner: null,
        owner: { kind: "acknowledged", owner: fence, revision: 1 },
        ledger: [{ user: "worker2", owner: "thread:mcp:run" }],
        claimants: ["mcp:run"],
        pool: ["worker2"],
        cutoff: 0,
        now: 1_000_000,
        graceMs: 60_000,
        opInFlight: 0,
      }),
    ).toEqual({ action: "current", legacy: false, spend: false });
  });

  it("refuses foreign or malformed acknowledged evidence without changing live-owner protection", () => {
    const acknowledged = { kind: "acknowledged", owner: fence, revision: 1 };
    for (const revision of [undefined, null, 0, -1, 0.5, "1", true, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(state({ ...acknowledged, revision })).toBe("unknown");
    for (const owner of [
      undefined,
      null,
      [],
      { ...fence, runId: "r2" },
      { ...fence, ownerGen: "g2" },
      { ...fence, ownerFence: 8 },
    ])
      expect(state({ ...acknowledged, owner })).toBe("unknown");
    expect(state(acknowledged, { fence: { ...fence, ownerFence: 8 } })).toBe("unknown");
    expect(state(acknowledged, { registration: { ...registration, threadKey: "mcp:other" } })).toBe("unknown");
    expect(state({ kind: "live", row: { runId: "r1", threadKey: "mcp:run", ownerGen: "g1" }, revision: 1 })).toBe(
      "executing",
    );
  });

  it("fails closed on missing owner, stale generation or fence, and provisional terminal history", () => {
    expect(state(null)).toBe("unknown");
    expect(state({ kind: "unknown" })).toBe("unknown");
    expect(state({ kind: "live", row: { runId: "r1", threadKey: "mcp:run", ownerGen: "g2" } })).toBe("unknown");
    expect(
      state(
        { kind: "terminal", record: { id: "r1", threadKey: "mcp:run", status: "failed" } },
        { fence: { ...fence, ownerFence: 8 } },
      ),
    ).toBe("unknown");
    expect(
      state(
        { kind: "terminal", record: { id: "r1", threadKey: "mcp:run", status: "failed" } },
        { registration: { ...registration, ownerFence: 0 }, fence: { ...fence, ownerFence: 0 } },
      ),
    ).toBe("unknown");
    expect(
      state({ kind: "terminal", record: { id: "r1", threadKey: "mcp:run", status: "failed", provisional: true } }),
    ).toBe("unknown");
    expect(state({ kind: "terminal", record: { id: "r2", threadKey: "mcp:run", status: "failed" } })).toBe("unknown");
    expect(
      state(
        { kind: "terminal", record: { id: "r1", threadKey: "mcp:run", status: "failed" } },
        { registration: undefined },
      ),
    ).toBe("unknown");
  });

  it("classifies only an elapsed, ownerless legacy registration as nonexecuting while retaining its workspace", () => {
    const now = 1_000_000;
    const legacy = { threadKey: "mcp:run", registeredAt: "1970-01-01T00:01:00.000Z", deadlineAt: 800_000 };
    const input = {
      threadKey: "mcp:run",
      registration: legacy,
      fence: undefined,
      lastRunOwner: undefined,
      owner: null,
      lastAttachAt: "1970-01-01T00:01:00.000Z",
      cutoff: now - 100_000,
      now,
      opInFlight: 0,
      graceMs: 60_000,
    };
    expect(classifyDeployRegistration(input)).toEqual({
      state: "retained",
      category: "legacy",
      reason: "protection-elapsed",
    });
    expect(classifyDeployRegistration({ ...input, now: 800_000 })).toMatchObject({
      state: "unknown",
      reason: "legacy-protected",
    });
    expect(classifyDeployRegistration({ ...input, opInFlight: 1 })).toMatchObject({
      state: "executing",
      reason: "operation-active",
    });
    expect(classifyDeployRegistration({ ...input, registration: { ...legacy, deadlineAt: undefined } })).toMatchObject({
      state: "retained",
      reason: "protection-elapsed",
    });
    expect(
      classifyDeployRegistration({ ...input, registration: { ...legacy, deadlineAt: undefined }, lastAttachAt: "bad" }),
    ).toMatchObject({
      state: "unknown",
      reason: "legacy-protected",
    });
    // The classification is a read: it must not delete either durable row.
    const activity = method("getResidentDeployInfo");
    expect(activity).toContain("registrationReadback");
    expect(activity).not.toContain("deleteThreadBinding(");
    expect(activity).not.toContain("evictBinding(");
  });

  it("retains an elapsed ownerless legacy registration with a persisted null last-run owner", () => {
    const input = {
      threadKey: "mcp:run",
      registration: { threadKey: "mcp:run", registeredAt: "1970-01-01T00:01:00.000Z", deadlineAt: 800_000 },
      fence: undefined,
      lastRunOwner: null,
      owner: null,
      lastAttachAt: "1970-01-01T00:01:00.000Z",
      cutoff: 900_000,
      now: 1_000_000,
      opInFlight: 0,
      graceMs: 60_000,
    };
    expect(classifyDeployRegistration(input)).toEqual({
      state: "retained",
      category: "legacy",
      reason: "protection-elapsed",
    });
    expect(classifyDeployRegistration({ ...input, now: 860_000 })).toEqual({
      state: "unknown",
      category: "legacy",
      reason: "legacy-protected",
    });
    expect(
      classifyDeployRegistration({
        ...input,
        registration: { ...input.registration, deadlineAt: undefined },
        cutoff: 60_000,
      }),
    ).toEqual({
      state: "unknown",
      category: "legacy",
      reason: "legacy-protected",
    });
    expect(classifyDeployRegistration({ ...input, opInFlight: 1 })).toEqual({
      state: "executing",
      category: "legacy",
      reason: "operation-active",
    });
    expect(classifyDeployRegistration({ ...input, fence: { ownerFence: 7 } })).toEqual({
      state: "unknown",
      category: "unknown",
      reason: "owner-unverified",
    });
  });

  it("fails closed on partial, malformed, fenced and named-owner legacy lookalikes without leaking identifiers", () => {
    const input = {
      threadKey: "mcp:run",
      registration: { threadKey: "mcp:run", registeredAt: "1970-01-01T00:01:00.000Z", deadlineAt: 800_000 },
      fence: undefined,
      lastRunOwner: undefined,
      owner: null,
      lastAttachAt: "1970-01-01T00:01:00.000Z",
      cutoff: 900_000,
      now: 1_000_000,
      opInFlight: 0,
      graceMs: 60_000,
    };
    const refused = [
      { registration: { ...input.registration, threadKey: "mcp:other" } },
      { registration: { ...input.registration, runId: "r1" } },
      { registration: { ...input.registration, ownerGen: "g1" } },
      { registration: { ...input.registration, ownerFence: 7 } },
      { registration: { ...input.registration, runId: null } },
      { registration: { ...input.registration, deadlineAt: "bad" } },
      { registration: { ...input.registration, registeredAt: "bad" } },
      { registration: { ...input.registration, registeredAt: "1970-01-01T00:20:00.000Z" } },
      { registration: { ...input.registration, deadlineAt: 1 } },
      { registration: null },
      { registration: [] },
      { fence: { runId: "r1", ownerGen: "g1", ownerFence: 7 } },
      { lastRunOwner: { runId: "r1" } },
      { lastRunOwner: {} },
      { lastRunOwner: "malformed" as never },
    ];
    for (const patch of refused) {
      const result = classifyDeployRegistration({ ...input, ...patch });
      expect(result.state, JSON.stringify(patch)).toBe("unknown");
      expect(JSON.stringify(result)).not.toMatch(/mcp:|r1|g1/);
    }
    const activity = method("getResidentDeployInfo");
    expect(activity).toContain("category");
    expect(activity).toContain("reason");
  });

  it("fences owned reattach before the activity read while keeping preservation counts intact", () => {
    const registry = source.slice(
      source.indexOf("export class ResidentRegistryDO"),
      source.indexOf("export class ResidentDO"),
    );
    const start = methodOf(registry, "installDeployFence")!;
    const activity = method("getResidentDeployInfo");
    const attach = method("attachThreadTraced");
    const route = source.slice(source.indexOf("async function handleDeployFence"));
    expect(start).toContain("swapFence: true");
    expect(start).toContain("deployFenceReady(fenced, now)");
    expect(route.indexOf("registry.setDeployFence(versionId, attempt)")).toBeLessThan(
      route.indexOf("getResidentDeployInfo()"),
    );
    expect(route.indexOf("getResidentDeployInfo()")).toBeLessThan(route.indexOf("registry.verifyDeployFence("));
    expect(methodOf(registry, "deployFenceVerified")).toContain("deployFenceReady(current, now)");
    expect(attach).toContain("drain.swapFence || !registered");
    expect(activity).toContain("this.runsInFlightCount()");
    expect(activity).toContain("this.threadOpsInFlight.get(binding.threadKey)");
    expect(activity).toContain("classifyDeployRegistration");
    expect(method("registeredRunsBeyondOps")).toContain("hasRunOwnerField(binding.lastRunOwner)");
  });

  it("holds a durable admission across already-bound work and rejects a quiet read with admitted work", () => {
    const registry = source.slice(
      source.indexOf("export class ResidentRegistryDO"),
      source.indexOf("export class ResidentDO"),
    );
    const begin = methodOf(registry, "beginDeployAdmission")!;
    const end = methodOf(registry, "endDeployAdmission")!;
    const verify = methodOf(registry, "deployFenceVerified")!;
    const route = source.slice(source.indexOf("async function handleDeployFence"));
    expect(begin).toContain("swapFence");
    expect(begin).toContain("DEPLOY_ADMISSION_KEY_PREFIX");
    expect(end).toContain("DEPLOY_ADMISSION_KEY_PREFIX");
    expect(verify).toContain("getDeployObligations(txn)");
    expect(route).toContain("registry.verifyDeployFence(fence.since, fence.until, versionId)");
    for (const name of ["attachThreadTraced", "detachThread", "runOp", "withThreadBusy"]) {
      expect(method(name), `${name} must participate in the admission barrier`).toContain("withDeployAdmission");
    }
    expect(method("updateRunDeadline")).toContain("withDeployAdmission");
    expect(source).toContain('case "/onboard":\n            return await withFleetAdmission');
    expect(source).toContain('case "/offboard":\n            return await withFleetAdmission');
    expect(source).toContain('case "/rebuild":\n            return await withFleetAdmission');
    expect(methodOf(registry, "setDrain")).toContain("swapFence");
    expect(methodOf(registry, "clearDrain")).toContain("postUploadVersion(record, versionId, versionTimestamp)");
    expect(methodOf(registry, "clearDrain")).toContain("getDeployObligations(txn)");
    expect(source.slice(source.indexOf("async function handleReconcile"))).toContain("beginTrackedDeployAdmission");
  });

  it("admits scheduled refresh steps and watchdog lifecycle work before either can start after the quiet read", () => {
    const step = method("runInstanceStep");
    expect(step).toContain("beginTrackedDeployAdmission");
    expect(step).toContain("endTrackedDeployAdmission");
    expect(step.indexOf("beginTrackedDeployAdmission")).toBeLessThan(step.indexOf("refreshAdmissionsInFlight++"));
    expect(step.indexOf("endTrackedDeployAdmission")).toBeGreaterThan(step.indexOf("fn({ count })"));
    const watchdog = source.slice(source.indexOf("async function runWatchdog("), source.indexOf("function json("));
    expect(watchdog).toContain("beginTrackedDeployAdmission");
    expect(watchdog).toContain("endTrackedDeployAdmission");
    expect(watchdog.indexOf("beginTrackedDeployAdmission")).toBeLessThan(watchdog.indexOf("createRefreshInstance("));
  });

  it("admits reconcile before its drain read and distinguishes the deployed Worker version", () => {
    const registry = source.slice(
      source.indexOf("export class ResidentRegistryDO"),
      source.indexOf("export class ResidentDO"),
    );
    const reconcile = source.slice(
      source.indexOf("async function handleReconcile("),
      source.indexOf("async function handleResidents("),
    );
    expect(reconcile).toContain("beginTrackedDeployAdmission");
    expect(reconcile.indexOf("beginTrackedDeployAdmission")).toBeLessThan(reconcile.indexOf("registry.list()"));
    expect(reconcile).toContain("endTrackedDeployAdmission");
    expect(methodOf(registry, "beginDeployReconcileAdmission")).toContain(
      "postUploadVersion(record, versionId, versionTimestamp)",
    );
    expect(methodOf(registry, "installDeployFence")).toContain("swapVersion");
    expect(methodOf(registry, "clearDrain")).toContain("postUploadVersion(record, versionId, versionTimestamp)");
    expect(source).toContain("CF_VERSION_METADATA");
  });

  it("recovers one admin-selected orphan only under a fresh fence and independent idle probes", () => {
    const registry = source.slice(
      source.indexOf("export class ResidentRegistryDO"),
      source.indexOf("export class ResidentDO"),
    );
    const handler = source.slice(
      source.indexOf("async function handleRecoverAdmission("),
      source.indexOf("/** POST /reconcile"),
    );
    expect(source).toContain('"/deploy-admissions": { scope: "admin", method: "GET" }');
    expect(source).toContain('"/recover-admission": { scope: "admin", method: "POST" }');
    expect(source).toContain('"/recover-quoted-admission": { scope: "admin", method: "POST" }');
    expect(handler).toContain("recoveryEvidenceUrl(evidence)");
    expect(handler.indexOf("registry.setDeployFence(versionId)")).toBeLessThan(
      handler.indexOf("getResidentRecoveryProbe()"),
    );
    expect(handler.indexOf("getResidentRecoveryProbe()")).toBeLessThan(handler.indexOf("recoveryViewsAreIdle(views)"));
    expect(handler.indexOf("recoveryViewsAreIdle(views)")).toBeLessThan(
      handler.indexOf("registry.recoverQuotedDeployAdmission("),
    );
    expect(handler).toContain("registry.clearDeployFence(fence.since, fence.until, versionId)");
    const recover = methodOf(registry, "recoverQuotedDeployAdmission")!;
    expect(recover).toContain("this.ctx.storage.transaction");
    expect(recover).toContain("fence.swapVersion !== versionId");
    expect(recover).toContain("await txn.delete(key)");
  });
});

// A deploy's preflight promises to refuse while a resident has a run in
// flight (docs/reference/specs/resident-repos.md item 44) — but a harness
// run's process lives in the CONTAINER between the bot's operator calls, so
// the in-memory op counters read 0 while it runs and a deploy could roll the
// resident under it. The resident therefore holds a durable registration per
// run, written by the attach and cleared by the binding's eviction (detach,
// sweep, disk pressure — every release path ends in `evictBinding`), and the
// preflight-facing counts (`GET /residents` live view, `GET /status`,
// `/debug info`) add the registrations the op counters do not already see
// until their run budget or clean-idle window ends.
// Plain Node, the entry read as text, never loaded (deploy/* convention).

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

describe("exact-thread owner reconciliation", () => {
  const now = 1_000_000;
  const binding = { threadKey: "mcp:run", user: "worker2", lastAttachAt: "1970-01-01T00:01:00.000Z" };
  const legacy = { threadKey: binding.threadKey, registeredAt: binding.lastAttachAt, deadlineAt: 800_000 };
  const owned = { ...legacy, runId: "r1", ownerGen: "g1", ownerFence: 7 };
  const input = {
    binding,
    registration: legacy as unknown,
    fence: undefined as unknown,
    owner: null as unknown,
    lastRunOwner: null as unknown,
    ledger: [] as unknown,
    claimants: [binding.threadKey] as unknown,
    pool: [binding.user, "worker3"],
    now,
    cutoff: 900_000,
    graceMs: 60_000,
    opInFlight: 0,
  };

  it("marks only an elapsed ownerless registration and its missing exact UID spend without losing the row", () => {
    expect(decideOwnerReconciliation(input)).toEqual({ action: "migrate", legacy: true, spend: true });
    expect(
      decideOwnerReconciliation({ ...input, ledger: [{ user: binding.user, owner: `thread:${binding.threadKey}` }] }),
    ).toEqual({ action: "migrate", legacy: true, spend: false });
    expect(decideOwnerReconciliation({ ...input, registration: { ...legacy, legacyRetainedAt: now } })).toEqual({
      action: "migrate",
      legacy: false,
      spend: true,
    });
  });

  it("the fenced readback refuses a missing or conflicting spend until the exact thread is reconciled", () => {
    const view = {
      threadKey: binding.threadKey,
      registration: legacy,
      fence: undefined,
      lastRunOwner: null,
      owner: null,
      lastAttachAt: binding.lastAttachAt,
      now,
      cutoff: 900_000,
      graceMs: 60_000,
      opInFlight: 0,
      user: binding.user,
      claimants: [binding.threadKey],
      pool: input.pool,
      ledger: [] as unknown,
    };
    expect(classifyDeployRegistrationWithLedger(view)).toEqual({
      state: "unknown",
      category: "unknown",
      reason: "ledger-unverified",
    });
    const reconciled = { ...view, ledger: [{ user: binding.user, owner: `thread:${binding.threadKey}` }] };
    expect(classifyDeployRegistrationWithLedger(reconciled)).toEqual({
      state: "retained",
      category: "legacy",
      reason: "protection-elapsed",
    });
    expect(
      classifyDeployRegistrationWithLedger({ ...reconciled, registration: { ...legacy, legacyRetainedAt: now } }),
    ).toEqual({ state: "retained", category: "legacy", reason: "legacy-reconciled" });
    expect(
      classifyDeployRegistrationWithLedger({ ...reconciled, registration: { ...legacy, legacyRetainedAt: undefined } }),
    ).toEqual({ state: "unknown", category: "unknown", reason: "malformed-registration" });
    expect(
      classifyDeployRegistrationWithLedger({ ...view, claimants: [binding.threadKey, "mcp:other"] }),
    ).toMatchObject({ state: "unknown", reason: "binding-conflict" });
    expect(classifyDeployRegistrationWithLedger({ ...view, opInFlight: 1 })).toMatchObject({ state: "executing" });
  });

  it("reconciles a terminal current owner with an absent spend, but never overwrites a live owner", () => {
    const terminal = { kind: "terminal", record: { id: "r1", threadKey: binding.threadKey, status: "failed" } };
    expect(
      decideOwnerReconciliation({
        ...input,
        registration: owned,
        fence: { runId: "r1", ownerGen: "g1", ownerFence: 7 },
        owner: terminal,
      }),
    ).toEqual({ action: "migrate", legacy: false, spend: true });
    expect(
      decideOwnerReconciliation({
        ...input,
        registration: owned,
        fence: { runId: "r1", ownerGen: "g1", ownerFence: 7 },
        owner: { kind: "live", row: { runId: "r1", threadKey: binding.threadKey, ownerGen: "g1" } },
      }),
    ).toEqual({ action: "refuse", reason: "owner-active" });
  });

  it("refuses partial, mismatched, unreadable, protected and conflicting evidence without changing a UID", () => {
    const patches = [
      { registration: { ...legacy, runId: "r1" } },
      { registration: { ...legacy, ownerFence: 7 } },
      { registration: { ...legacy, legacyRetainedAt: undefined } },
      { registration: { ...legacy, legacyRetainedAt: now + 1 } },
      { registration: { ...legacy, deadlineAt: now } },
      { registration: null },
      { fence: { ownerFence: 7 } },
      { lastRunOwner: { runId: "r1" } },
      { owner: { kind: "unknown" } },
      { opInFlight: 1 },
      { ledger: undefined },
      { ledger: [{ user: binding.user, owner: "thread:mcp:other" }] },
      { claimants: [binding.threadKey, "mcp:other"] },
      { claimants: null },
      { binding: { ...binding, threadKey: "mcp:other" } },
    ];
    for (const patch of patches) {
      const answer = decideOwnerReconciliation({ ...input, ...patch });
      expect(answer.action, JSON.stringify(patch)).toBe("refuse");
      expect(JSON.stringify(answer)).not.toMatch(/mcp:|r1|worker2/);
    }
  });

  it("refuses incomplete new admissions before attachment and commits the full owner triple atomically", () => {
    expect(validRunOwner("r1", "g1", 7)).toBe(true);
    for (const owner of [
      [undefined, "g1", 7],
      ["r1", undefined, 7],
      ["r1", "g1", undefined],
      ["", "g1", 7],
      ["r1", "", 7],
      ["r1", "g1", 0],
      ["r1", "g1", 1.5],
      ["r1", "g1", Number.MAX_SAFE_INTEGER + 1],
      ["r".repeat(129), "g1", 7],
    ])
      expect(validRunOwner(owner[0], owner[1], owner[2])).toBe(false);
    const attach = source.slice(
      source.indexOf("async function handleAttach("),
      source.indexOf("async function handleRunDeadline("),
    );
    expect(attach).toContain("if (!validRunOwner(runId, ownerGen, ownerFence))");
    const traced = methodOf(residentDO, "attachThreadTraced")!;
    expect(traced.indexOf("validRunOwner(runId, ownerGen, ownerFence)")).toBeLessThan(
      traced.indexOf("await this.attachThreadBody("),
    );
    const register = methodOf(residentDO, "registerRun")!;
    expect(register).toContain("validRunOwner(runId, ownerGen, ownerFence)");
    expect(register).toContain("txn.put(runFenceKey(threadKey)");
    expect(register).toContain("txn.put(runRegKey(threadKey)");
    expect(register).not.toContain("...(runId !== undefined");
  });

  it("keeps private legacy bytes in the reconciliation and preservation decisions", () => {
    const spent = spendPoolUser([], input.pool, binding.user, `thread:${binding.threadKey}`);
    expect(spent).not.toBeNull();
    expect(
      mayRunAsPoolUser(spent, input.pool, binding.user, [binding.threadKey], undefined, `thread:${binding.threadKey}`),
    ).toBe(true);
    expect(mayRunAsPoolUser(spent, input.pool, binding.user, ["mcp:other"], undefined, `thread:mcp:other`)).toBe(false);
    expect(spendPoolUser(spent, input.pool, binding.user, `thread:${binding.threadKey}`)).toEqual(spent);
    expect(
      decideOwnerReconciliation({ ...input, ledger: spent, registration: { ...legacy, legacyRetainedAt: now } }),
    ).toEqual({ action: "current", legacy: false, spend: false });
    expect(
      decideWorkspaceRemoval({
        binding: { ...binding, ref: "main", worktreePath: "/workspace/private" },
        registration: { ...legacy, legacyRetainedAt: now },
        fence: undefined,
        owner: null,
        tree: null,
      }),
    ).toEqual({ removable: false, reason: "legacy-retained" });
    const attach = methodOf(residentDO, "attachThreadBody")!;
    const detach = methodOf(residentDO, "detachThread")!;
    expect(attach).toContain("this.claimRetainedThreadUser(storedPrior)");
    expect(detach).toContain("this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`)");
    expect(detach.indexOf("registeredRunOwnsRelease(registration, runId, ownerGen, ownerFence)")).toBeLessThan(
      detach.indexOf("this.poolUserOwnerMatches(binding.user"),
    );
  });

  it("treats a present malformed retention marker as unknown and preserves its workspace", () => {
    const marked = { ...legacy, legacyRetainedAt: undefined };
    const view = {
      threadKey: binding.threadKey,
      registration: marked,
      fence: undefined,
      lastRunOwner: null,
      owner: null,
      lastAttachAt: binding.lastAttachAt,
      cutoff: 900_000,
      now,
      graceMs: 60_000,
      opInFlight: 0,
    };
    expect(classifyDeployRegistration(view)).toEqual({
      state: "unknown",
      category: "unknown",
      reason: "malformed-registration",
    });
    expect(decideOwnerReconciliation({ ...input, registration: marked })).toMatchObject({ action: "refuse" });
    expect(
      decideWorkspaceRemoval({
        binding: { ...binding, ref: "main", worktreePath: "/workspace/private" },
        registration: marked,
        fence: undefined,
        owner: null,
        tree: null,
      }),
    ).toMatchObject({ removable: false });
  });

  it("offers an admin-only exact-thread path with disk and activity checks before one durable claim", () => {
    const reconcile = methodOf(residentDO, "reconcileRetainedOwner")!;
    expect(source).toContain('case "reconcile-owner":');
    expect(reconcile).toContain("this.threadAttaches.run(threadKey");
    expect(reconcile).toContain("this.withDeployAdmission(");
    expect(reconcile).toContain("this.poolUserHasOldThreadDir(");
    expect(reconcile).toContain("decideOwnerReconciliation(");
    expect(reconcile).toContain("this.ctx.storage.transaction(");
    expect(reconcile).toContain("uidLedger");
    expect(reconcile).not.toMatch(/evictBinding|deleteThreadBinding|rm -rf/);
  });

  it.each(["canonical", "collision-safe replacement"] as const)(
    "reconciles an exact retained %s worktree path after verifying its owner and directory",
    async (form) => {
      const fixture = await ownerFlow(form);
      if (form === "collision-safe replacement") {
        expect(await fixture.pathFor("foo/bar")).toBe(fixture.canonicalPath);
        expect(fixture.worktreePath).toMatch(/-ref-[a-f0-9]{8}$/);
      }
      const result = await fixture.instance.reconcileRetainedOwner(fixture.threadKey);
      expect(result).toMatchObject({ migrated: 1, legacy: 1, ledger: 1 });
      expect(await fixture.instance.currentUidLedger()).toEqual([
        { user: "worker2", owner: `thread:${fixture.threadKey}` },
      ]);
      expect(fixture.rows.get(`runReg:${fixture.threadKey}`)).toMatchObject({ legacyRetainedAt: fixture.now });
      expect(fixture.privateBytes()).toBe("private uncommitted work");
      expect(fixture.checkedPaths).toContain(fixture.worktreePath);
    },
  );

  it("refuses a stored worktree path that is neither canonical nor a collision-safe replacement", async () => {
    const fixture = await ownerFlow("invalid");
    expect(await fixture.instance.reconcileRetainedOwner(fixture.threadKey)).toMatchObject({ status: 503 });
    expect(fixture.rows.get("resident:spentPoolUsers")).toEqual([]);
    expect(fixture.checkedPaths).toEqual([]);
    expect(fixture.privateBytes()).toBe("private uncommitted work");
  });

  it("restores the exact retained owner's OS account before reattaching after a cold VM start", async () => {
    const fixture = await ownerFlow("canonical");
    await fixture.instance.reconcileRetainedOwner(fixture.threadKey);
    let provisioned = false;
    const nativeRun = fixture.instance.run;
    fixture.instance.run = async (argv: string[]) => {
      if (argv[0] === "/bin/sh") {
        expect(argv.slice(-2)).toEqual(["worker2", "2002"]);
        provisioned = true;
      }
      return nativeRun(argv);
    };
    expect(await fixture.attach("new-run", 8)).toMatchObject({ user: "worker2", ownerFence: 8 });
    expect(provisioned).toBe(true);
    expect(fixture.privateBytes()).toBe("private uncommitted work");
  });

  it("repairs the exact-thread ledger, attaches a new owner without touching private bytes, then fences detach", async () => {
    const fixture = await ownerFlow("canonical");
    const { instance, rows, threadKey } = fixture;
    expect(await instance.reconcileRetainedOwner(threadKey)).toMatchObject({ migrated: 1, ledger: 1 });
    const attached = await fixture.attach("new-run", 8);
    expect(attached).not.toHaveProperty("error");
    expect(attached).toMatchObject({ ownerFence: 8 });
    expect(rows.get(`runReg:${threadKey}`)).toMatchObject({ runId: "new-run", ownerGen: "new-gen", ownerFence: 8 });
    expect(rows.get(`runFence:${threadKey}`)).toEqual({ runId: "new-run", ownerGen: "new-gen", ownerFence: 8 });
    expect(fixture.privateBytes()).toBe("private uncommitted work");
    expect((rows.get(`thread:${threadKey}`) as { user: string }).user).toBe("worker2");

    expect(await instance.detachThread(threadKey, false, [], "other-run", "new-gen", 8)).toMatchObject({
      released: false,
      reason: expect.stringContaining("run-registration-mismatch"),
    });
    expect(await fixture.attach("other-run", 8)).toMatchObject({ status: 409 });
    rows.set("pool:worker2", [threadKey, "mcp:other"]);
    expect(await instance.detachThread(threadKey, false, [], "new-run", "new-gen", 8)).toMatchObject({ status: 503 });
    rows.set("pool:worker2", [threadKey]);
    expect(fixture.privateBytes()).toBe("private uncommitted work");
    // Even the exact owner cannot delete unsaved bytes; after a verified
    // terminal, clean checkout, only that owner can actually release it.
    expect(await instance.detachThread(threadKey, false, [], "new-run", "new-gen", 8)).toMatchObject({
      released: false,
      reason: expect.stringContaining("workspace-preservation"),
    });
    expect(fixture.privateBytes()).toBe("private uncommitted work");
    fixture.makeSafeToRelease();
    expect(await instance.detachThread(threadKey, false, [], "new-run", "new-gen", 8)).toMatchObject({
      released: true,
      user: "worker2",
    });
    expect(fixture.privateBytes()).toBeUndefined();
    expect((rows.get(`thread:${threadKey}`) as { evicted: boolean }).evicted).toBe(true);
    expect(rows.has(`runReg:${threadKey}`)).toBe(false);
    expect(await instance.currentUidLedger()).toEqual([{ user: "worker2", owner: `thread:${threadKey}` }]);
  });

  it.each(["registration", "last-run-owner"] as const)(
    "keeps private bytes when a partial owner row meets legacy detach (%s)",
    async (place) => {
      const fixture = await ownerFlow("canonical");
      const { instance, rows, threadKey } = fixture;
      const registrationKey = `runReg:${threadKey}`;
      const bindingKey = `thread:${threadKey}`;
      rows.set("resident:spentPoolUsers", [{ user: "worker2", owner: `thread:${threadKey}` }]);
      if (place === "registration") {
        rows.set(registrationKey, { ...(rows.get(registrationKey) as object), ownerFence: undefined });
      } else {
        rows.set(bindingKey, {
          ...(rows.get(bindingKey) as object),
          lastRunOwner: { ownerFence: undefined },
        });
      }
      expect(await instance.detachThread(threadKey, false, [])).toMatchObject({ released: false });
      expect(fixture.privateBytes()).toBe("private uncommitted work");
      expect(rows.get(bindingKey)).toMatchObject({ user: "worker2", evicted: false });
      expect(rows.has(registrationKey)).toBe(true);
    },
  );

  it("keeps private bytes when a malformed retained marker reaches legacy detach", async () => {
    const fixture = await ownerFlow("canonical");
    const { instance, rows, threadKey } = fixture;
    const registrationKey = `runReg:${threadKey}`;
    rows.set("resident:spentPoolUsers", [{ user: "worker2", owner: `thread:${threadKey}` }]);
    rows.set(registrationKey, { ...(rows.get(registrationKey) as object), legacyRetainedAt: undefined });
    expect(await instance.detachThread(threadKey, false, [])).toMatchObject({ released: false });
    expect(fixture.privateBytes()).toBe("private uncommitted work");
    expect(rows.has(registrationKey)).toBe(true);
  });

  it("keeps any partial owner field out of the legacy removal path", () => {
    const binding = {
      threadKey: "mcp:run",
      ref: "main",
      user: "worker2",
      worktreePath: "/workspace/private",
      lastRunOwner: null,
    };
    const registration = { threadKey: binding.threadKey };
    const input = { binding, registration, fence: undefined, owner: null, tree: null };
    expect(decideWorkspaceRemoval(input)).toEqual({ removable: true });
    for (const field of ["runId", "ownerGen", "ownerFence"] as const) {
      expect(decideWorkspaceRemoval({ ...input, registration: { ...registration, [field]: undefined } })).toEqual({
        removable: false,
        reason: "owner-registration-incomplete",
      });
      expect(
        decideWorkspaceRemoval({ ...input, binding: { ...binding, lastRunOwner: { [field]: undefined } } }),
      ).toEqual({ removable: false, reason: "owner-registration-incomplete" });
    }
  });

  it.each(["registration", "fence"] as const)(
    "refuses attach before materialization when the persisted %s has ownerFence: undefined",
    async (place) => {
      const fixture = await ownerFlow("canonical");
      const key = `${place === "registration" ? "runReg" : "runFence"}:${fixture.threadKey}`;
      const partial = { ownerFence: undefined };
      fixture.rows.set(key, partial);
      const beforeRegistration = fixture.rows.get(`runReg:${fixture.threadKey}`);
      const beforeFence = fixture.rows.get(`runFence:${fixture.threadKey}`);
      expect(await fixture.attach("new-run", 8)).toMatchObject({ status: 409 });
      expect(fixture.rows.get(`runReg:${fixture.threadKey}`)).toBe(beforeRegistration);
      expect(fixture.rows.get(`runFence:${fixture.threadKey}`)).toBe(beforeFence);
      expect(fixture.privateBytes()).toBe("private uncommitted work");
      expect(fixture.materializations()).toBe(0);
    },
  );
});

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("a run's registration is held from attach to release", () => {
  it("only the current run may release its workspace, including after its deadline", () => {
    expect(registeredRunOwnsRelease({ runId: "run-1", ownerGen: "gen-new" }, "run-1", "gen-old")).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-1", ownerGen: "gen-new" }, "run-1", "gen-new")).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-2" }, "run-1")).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-2" }, undefined)).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-1" }, "run-1")).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-1", ownerGen: "gen-1", ownerFence: 7 }, "run-1", "gen-1", 7)).toBe(
      true,
    );
    expect(registeredRunOwnsRelease({}, undefined)).toBe(true);
    expect(registeredRunOwnsRelease({ ownerFence: undefined }, undefined)).toBe(false);
    expect(registeredRunOwnsRelease({ runId: undefined }, undefined)).toBe(false);
    expect(registeredRunOwnsRelease({ ownerGen: undefined }, undefined)).toBe(false);
    expect(registeredRunOwnsRelease(undefined, undefined)).toBe(false);
    expect(registeredRunOwnsRelease(undefined, "run-1")).toBe(false);

    const detach = method("detachThread");
    expect(detach).toContain("this.threadAttaches.run(threadKey");
    expect(detach).toContain("registeredRunOwnsRelease(registration, runId, ownerGen, ownerFence)");
    expect(detach).toContain("registeredRunOwnsRelease(binding.lastRunOwner, runId, ownerGen, ownerFence)");
    expect(detach.indexOf("registeredRunOwnsRelease(registration, runId, ownerGen, ownerFence)")).toBeLessThan(
      detach.lastIndexOf("await this.rememberOwnBranches(threadKey, pushed)"),
    );
    expect(source).toMatch(
      /ctx\.stub\.detachThread\(\s*ctx\.threadKey,\s*body\.force === true,\s*pushed\.pushed,\s*runId,\s*ownerGen,\s*ownerFence,\s*requestContext,?\s*\)/,
    );
  });

  it("only the owning run with a live deadline may reattach through drain, memory, and image gates", () => {
    const now = Date.parse("2026-09-28T23:49:00.000Z");
    const grace = 60_000;
    const own = { runId: "run-1", deadlineAt: now };
    expect(registeredRunAllowsReattach({ ...own, ownerGen: "gen-new" }, "run-1", now, grace, "gen-old")).toBe(false);
    expect(registeredRunAllowsReattach({ ...own, ownerGen: "gen-new" }, "run-1", now, grace, "gen-new")).toBe(false);
    expect(
      registeredRunAllowsReattach({ ...own, ownerGen: "gen-new", ownerFence: 7 }, "run-1", now, grace, "gen-new", 7),
    ).toBe(true);
    const reclaimed = { ...own, ownerGen: "same-second-a", ownerFence: 7 };
    expect(registeredRunAllowsReattach(reclaimed, "run-1", now, grace, "same-second-b", 8)).toBe(true);
    expect(registeredRunAllowsReattach(reclaimed, "run-1", now, grace, "same-second-b", 6)).toBe(false);
    expect(registeredRunAllowsReattach(own, "run-1", now + grace, grace)).toBe(false);
    expect(registeredRunAllowsReattach(own, "run-1", now + grace + 1, grace)).toBe(false);
    expect(registeredRunAllowsReattach(own, "run-2", now, grace)).toBe(false);
    expect(registeredRunAllowsReattach(own, undefined, now, grace)).toBe(false);
    expect(registeredRunAllowsReattach(undefined, "run-1", now, grace)).toBe(false);
    expect(registeredRunAllowsReattach({ runId: "run-1" }, "run-1", now, grace)).toBe(false);
    expect(registeredRunAllowsReattach({ deadlineAt: now }, "run-1", now, grace)).toBe(false);
    expect(registeredRunAllowsReattach({ runId: "run-1", deadlineAt: NaN }, "run-1", now, grace)).toBe(false);
  });
  it("a larger ledger fence claims across runs or generations; delayed older attaches cannot replace it", () => {
    const old = { runId: "run-1", ownerGen: "same-second-a", ownerFence: 7 };
    expect(registeredRunAllowsClaim(old, "run-1", "same-second-b", 8)).toBe(true);
    expect(registeredRunAllowsClaim(old, "run-2", "same-second-b", 8)).toBe(true);
    expect(registeredRunAllowsClaim({ ...old, runId: "run-2", ownerFence: 8 }, "run-1", old.ownerGen, 7)).toBe(false);
    expect(registeredRunAllowsClaim(old, "run-1", old.ownerGen, 7)).toBe(true);
    expect(registeredRunAllowsClaim(old, "run-2", old.ownerGen, 7)).toBe(false);
    expect(registeredRunAllowsClaim(old, "run-1", undefined)).toBe(false);
    expect(registeredRunAllowsClaim({ runId: "run-1" }, "run-1", "same-second-b", 8)).toBe(false);
    expect(registeredRunAllowsClaim({ runId: undefined }, "run-1", "same-second-b", 8)).toBe(false);
    // Both the registration and the high-water row may contain this partial
    // persisted property. Its presence must not be mistaken for ownerlessness.
    expect(registeredRunAllowsClaim({ ownerFence: undefined }, "run-1", "same-second-b", 8)).toBe(false);
    expect(registeredRunAllowsClaim({ ownerFence: 7 }, "run-1", "same-second-b", 8)).toBe(false);
    expect(
      registeredRunAllowsClaim(
        { runId: "run-1", ownerGen: "same-second-a", ownerFence: 0 },
        "run-1",
        "same-second-b",
        8,
      ),
    ).toBe(false);
    expect(registeredRunAllowsClaim({}, "run-1", "same-second-b", 8)).toBe(true);
    // The high-water row remains after /detach or a binding purge.
    expect(registeredRunAllowsClaim(old, "run-1", "same-second-a", 6)).toBe(false);
    const attach = method("attachThreadTraced");
    expect(attach).toContain("this.threadAttaches.run(threadKey");
    expect(attach).toContain("registeredRunAllowsClaim(current, runId, ownerGen, ownerFence)");
    expect(attach).toContain("registeredRunAllowsClaim(accepted, runId, ownerGen, ownerFence)");
    expect(attach).toContain("runFenceKey(threadKey)");
    expect(method("registerRun")).toContain("txn.put(runFenceKey(threadKey)");
    expect(method("deleteThreadBinding")).not.toContain("runFenceKey(threadKey)");
    expect(method("evictBinding")).not.toContain("runFenceKey(threadKey)");
    expect(attach.indexOf("registeredRunAllowsClaim(current, runId, ownerGen, ownerFence)")).toBeLessThan(
      attach.indexOf("await this.attachThreadBody("),
    );
  });
  it("checks the attachment fence under the thread lock before drain, memory, and image gates", () => {
    const attach = method("attachThreadTraced");
    const lock = attach.indexOf("this.threadAttaches.run(threadKey");
    const fence = attach.indexOf("registeredRunAllowsClaim(current, runId, ownerGen, ownerFence)");
    const drain = attach.indexOf("await this.fleetDrain()");
    const memory = attach.indexOf('await this.memoryGate("attach"');
    const image = attach.indexOf('this.reconcileImage("attach")');
    expect(lock).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(lock);
    expect(drain).toBeGreaterThan(fence);
    expect(memory).toBeGreaterThan(drain);
    expect(image).toBeGreaterThan(memory);
    expect(method("attachThread")).not.toContain("this.recreateAdmission.pending");
  });
  it("registrations are durable rows under their own prefix — a fresh isolate still counts the process that survived in the container", () => {
    expect(source).toMatch(/const RUN_REG_KEY_PREFIX = "runReg:";/);
    expect(source).toMatch(/const runRegKey = \(threadKey: string\) => `\$\{RUN_REG_KEY_PREFIX\}\$\{threadKey\}`;/);
    const register = method("registerRun");
    expect(register).toMatch(/txn\.put\(runRegKey\(threadKey\)/);
    expect(register).toMatch(/registeredAt/);
    expect(register).toContain("deadlineAt: now + runBudgetMs");
    expect(register).toContain("runId");
  });

  it("the lease update changes only its own durable registration", () => {
    const update = method("updateRunDeadline");
    expect(update).toMatch(
      /registration\.runId !== runId \|\|\s*registration\.ownerGen !== ownerGen \|\|\s*registration\.ownerFence !== ownerFence/,
    );
    expect(update).toContain("const deadlineAt = systemClock() + remainingMs");
    expect(source).toContain('"/run-deadline": { scope: "operator", method: "POST" }');
  });

  it("a successful attach registers the run; a refused attach does not", async () => {
    const fixture = await ownerFlow("canonical");
    expect(await fixture.attach("new-run", 8)).toMatchObject({ ownerFence: 8 });
    const registration = structuredClone(fixture.rows.get(`runReg:${fixture.threadKey}`));
    const refused = await fixture.attach("other-run", 8);
    expect(refused).toMatchObject({ status: 409 });
    expect(refused).not.toHaveProperty("ownerFence");
    expect(fixture.rows.get(`runReg:${fixture.threadKey}`)).toEqual(registration);
  });

  it("refuses new work before materialization but permits the exact live owner's reattach", async () => {
    const fixture = await ownerFlow("canonical");
    const full = {
      error: "resident workload is full (16/16 active owners)",
      status: 503,
      reason: "workload-full",
      cause: "system",
    };
    fixture.instance.reserveWorkloadSlot = async () => full;
    expect(await fixture.attach("new-run", 8)).toEqual(full);
    expect(fixture.materializations()).toBe(0);
    fixture.instance.reserveWorkloadSlot = async (owner: string) => {
      fixture.instance.workloadReservations.add(owner);
      return null;
    };
    expect(await fixture.attach("new-run", 8)).toMatchObject({ ownerFence: 8 });
    expect([...fixture.instance.workloadReservations]).toEqual([]);
    fixture.instance.reserveWorkloadSlot = async () => full;
    expect(await fixture.attach("new-run", 8)).toMatchObject({ ownerFence: 8 });
  });

  it("the binding's eviction clears the registration — detach, sweep and disk pressure all end there", () => {
    const evict = method("evictBinding");
    expect(evict).toMatch(/await this\.ctx\.storage\.delete\(runRegKey\(binding\.threadKey\)\);/);
    // The delete sits on the success path, after the evicted write — a
    // give-way (re-attached during eviction) keeps the registration.
    const put = evict.indexOf("evicted: true");
    const del = evict.indexOf("storage.delete(runRegKey(");
    expect(put).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(put);
  });

  it("finished-ref cleanup rechecks bounded registration liveness before keeping a tree", () => {
    const reclaim = method("reclaimFinishedRefs");
    expect(reclaim).toContain("registeredRunNeedsProtection(");
    expect(reclaim).not.toContain(
      "if ((await this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey))) !== undefined)",
    );
  });
});

describe("the preflight-facing counts see registered runs the op counters miss", () => {
  it.each(["registration", "last-run-owner"] as const)(
    "counts a persisted partial owner field in %s as protected activity",
    async (place) => {
      const fixture = await ownerFlow("canonical");
      const { instance, rows, threadKey } = fixture;
      expect(await instance.getInFlightCount()).toBe(0);
      if (place === "registration")
        rows.set(`runReg:${threadKey}`, { ...(rows.get(`runReg:${threadKey}`) as object), ownerFence: undefined });
      else
        rows.set(`thread:${threadKey}`, {
          ...(rows.get(`thread:${threadKey}`) as object),
          lastRunOwner: { ownerFence: undefined },
        });
      expect(await instance.getInFlightCount()).toBe(1);
    },
  );

  it("registeredRunsBeyondOps retains durable owners beyond the execution deadline and bounds only legacy registrations", () => {
    const count = method("registeredRunsBeyondOps");
    expect(count).toMatch(/this\.ctx\.storage\.list<RunRegistration>\(\{ prefix: RUN_REG_KEY_PREFIX \}\)/);
    expect(count).toContain("registeredRunNeedsProtection(");
    expect(count).toContain("hasRunOwnerField(r)");
    expect(count).toContain("runFenceKey(binding.threadKey)");
    expect(count).toContain("this.threadOpsInFlight.get(binding.threadKey) ?? 0");
    expect(count).toContain("r.deadlineAt + RUN_REGISTRATION_GRACE_MS");
    expect(count).toContain("systemClock() - CLEAN_IDLE_RELEASE_S * 1000");
  });

  it("an abandoned registration stops blocking at the sweep's idle boundary, while an active or unknown one remains protected", () => {
    const cutoff = Date.parse("2026-09-28T23:48:00.000Z");
    expect(registeredRunNeedsProtection("2026-09-28T23:47:59.999Z", 0, cutoff)).toBe(false);
    expect(registeredRunNeedsProtection("2026-09-28T23:48:00.000Z", 0, cutoff)).toBe(true);
    expect(registeredRunNeedsProtection("2026-09-28T23:49:00.000Z", 0, cutoff)).toBe(true);
    expect(registeredRunNeedsProtection(undefined, 0, cutoff)).toBe(true);
    expect(registeredRunNeedsProtection("invalid", 0, cutoff)).toBe(true);
    expect(registeredRunNeedsProtection("2026-09-28T23:49:00.000Z", 1, cutoff)).toBe(false);
    const now = Date.parse("2026-09-28T23:49:00.000Z");
    expect(registeredRunNeedsProtection("2026-09-28T23:49:00.000Z", 0, cutoff, now - 1, now)).toBe(false);
    expect(registeredRunNeedsProtection("2026-09-28T23:49:00.000Z", 0, cutoff, now, now)).toBe(true);
    expect(registeredRunNeedsProtection("2026-09-28T23:49:00.000Z", 0, cutoff, undefined, now)).toBe(true);
    expect(registeredRunNeedsProtection("2026-09-28T23:49:00.000Z", 0, cutoff, NaN, now)).toBe(true);
    expect(registeredRunNeedsProtection("2026-09-28T23:47:59.999Z", 0, cutoff, now + 1, now)).toBe(true);
  });

  it("the idle sweep protects a registered run through its budget even when its last command was over an hour ago", () => {
    const sweep = method("sweepWorktrees");
    expect(sweep).toContain("this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey))");
    expect(sweep).toContain("systemClock() <= registration.deadlineAt + RUN_REGISTRATION_GRACE_MS");
  });

  it("GET /status adds the registrations (getInFlightCount), so a person sees the protected registration count", () => {
    const status = method("getInFlightCount");
    expect(status).toMatch(/this\.inFlightCount\(\) \+ \(await this\.registeredRunsBeyondOps\(\)\)/);
  });

  it("the live view's inFlight and runsInFlight (GET /residents, /debug info) both carry the registrations", () => {
    expect(source).toMatch(/inFlight: this\.inFlightCount\(\) \+ registeredRuns,/);
    expect(source).toMatch(/runsInFlight: this\.runsInFlightCount\(\) \+ registeredRuns,/);
  });

  it("isIdle protects a registered run beyond an hour of inactivity but permits sleep after its bounded deadline", () => {
    const now = Date.parse("2026-09-28T23:49:00.000Z");
    const oldAttach = "2026-09-28T22:00:00.000Z";
    expect(registeredRunNeedsProtection(oldAttach, 0, now - 60 * 60_000, now + 1, now)).toBe(true);
    expect(registeredRunNeedsProtection(oldAttach, 0, now - 60 * 60_000, now - 1, now)).toBe(false);
    const idle = method("isIdle");
    expect(idle).toContain("this.registeredRunsBeyondOps()");
    expect(idle).toContain("this.inFlightCount()");
    const reconcile = method("reconcileImage");
    expect(reconcile).toMatch(/await this\.registeredRunsBeyondOps\(\)/);
    expect(reconcile).toMatch(/deferring restart until the resident is quiet/);
  });
});

// Execute the shipped DO methods with durable fake storage and a bounded fake
// disk. The seams simulate workerd's storage, container and history; owner,
// reconciliation, attachment, and detachment decisions are not reimplemented.
const parsedWorker = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true);
const ownerMethods = [
  "cancellationPending",
  "reconcileRetainedOwner",
  "attachThreadTraced",
  "withOwnedNativeOperation",
  "withNativeOperationScope",
  "attachThreadBody",
  "allocateThreadUser",
  "claimRetainedThreadUser",
  "ensurePoolAccount",
  "markPoolUserSpent",
  "currentUidLedger",
  "poolUserOwnerMatches",
  "workspaceDiscarded",
  "registerRun",
  "detachThread",
  "retainWorkspacePredecessor",
  "reconcileWorkspaceSettlements",
  "reconcileWorkspaceBinding",
  "ackWorkspaceSettlement",
  "evictBinding",
  "workspaceRemovalDecision",
  "reportBlockedWorkspace",
  "registeredRunsBeyondOps",
  "getInFlightCount",
];
const ownerFunctions = ["threadWorktreePath", "replacementWorktreePath"];
const compiledOwnerFlow = ts.transpileModule(
  `${ownerFunctions
    .map((name) => {
      const fn = parsedWorker.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      if (!fn) throw new Error(`worker.ts declares ${name}`);
      return fn.getText(parsedWorker);
    })
    .join("\n")}
  class OwnerFlowUnderTest {
    async withDeployAdmission(_producer: string, _context: unknown, fn: () => Promise<unknown>) { return fn(); }
    ${ownerMethods.map((name) => method(name)).join("\n")}
  }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type OwnerFlowInstance = {
  reserveWorkloadSlot(owner: string): Promise<unknown>;
  workloadReservations: Set<string>;
  getInFlightCount(): Promise<number>;
  currentUidLedger(): Promise<{ user: string; owner: string }[]>;
  run(argv: string[]): Promise<unknown>;
  reconcileRetainedOwner(key: string): Promise<unknown>;
  attachThreadTraced(
    key: string,
    ref: string | null,
    readonly: boolean,
    sha: string | null,
    reuse: boolean,
    record: unknown,
    start: number,
    reason: unknown,
    door: unknown,
    budget: number,
    runId: string,
    ownerGen: string,
    ownerFence: number,
  ): Promise<unknown>;
  detachThread(
    key: string,
    force: boolean,
    pushed: unknown[],
    id?: string,
    gen?: string,
    fence?: number,
  ): Promise<unknown>;
};

async function ownerFlow(pathForm: "canonical" | "collision-safe replacement" | "invalid") {
  const now = Date.parse("2026-10-02T03:00:00Z");
  const threadKey = "mcp:run";
  const ref = pathForm === "collision-safe replacement" ? "foo-bar" : "main";
  const Suite = runInNewContext(
    `${compiledOwnerFlow}\n({ OwnerFlowUnderTest, threadWorktreePath, replacementWorktreePath })`,
    {
      uidLedger,
      readUidReport,
      uidOwner,
      issuedUidCount,
      claimUid,
      reserveUid,
      provisionUidCommand,
      crypto: webcrypto,
      NativeOperationJournal,
      NativeRunScopes,
      RecordedCheckOperation,
      unstartedNativeOperator,
      TextEncoder,
      THREADS_DIR: "/workspace/threads",
      MIRROR_DIR: "/workspace/mirror",
      isResidentPoolUser,
      THREAD_USERS: ["worker2", "worker3"],
      SPENT_POOL_USERS_KEY: "resident:spentPoolUsers",
      FACTS_KEY: "facts",
      RESOURCE_KEY: "resource",
      CLEAN_IDLE_RELEASE_S: 3600,
      RUN_REGISTRATION_GRACE_MS: 60_000,
      RUN_REG_KEY_PREFIX: "runReg:",
      systemClock: () => now,
      threadBindingKey: (key: string) => `thread:${key}`,
      runRegKey: (key: string) => `runReg:${key}`,
      runFenceKey: (key: string) => `runFence:${key}`,
      poolBindingKey: (user: string) => `pool:${user}`,
      parentDir: (path: string) => path.slice(0, path.lastIndexOf("/")),
      decideOwnerReconciliation,
      registeredRunAllowsClaim,
      registeredRunAllowsReattach,
      registeredRunOwnsRelease,
      registeredRunNeedsProtection,
      validRunOwner,
      spendPoolUser,
      parsePoolBindings,
      mayRunAsPoolUser,
      planForceDetach,
      decideWorkspaceRemoval,
      hasRunOwnerField,
      isWorkspaceOwner,
      isAcknowledgedWorkspaceOwner,
      workspaceOwnerKey,
      workspaceSettlementOf,
      workspaceBindingOf,
      WORKSPACE_PREDECESSORS_MAX: 20,
      WORKSPACE_RECONCILE_BINDINGS_MAX: 20,
      WORKSPACE_SETTLEMENT_CURSOR_KEY: "settlement-cursor",
      admitThreadDiskWithRollback,
      boundByFor,
      rememberOwnBranches,
      planReadonlyAttach: () => ({}),
      replacementWorktreeCleanup: () => null,
      threadUserCacheCleanArgv: () => ["true"],
      evictedTreeSentence: () => "",
      catchAllErr: (err: unknown) => ({ error: String(err), status: 500 }),
      console: { log: () => {}, warn: () => {} },
      errMsg: (err: unknown) => String(err),
    },
  ) as {
    OwnerFlowUnderTest: new () => OwnerFlowInstance;
    threadWorktreePath: (key: string, ref: string) => Promise<string>;
    replacementWorktreePath: (key: string, ref: string, prior: string) => Promise<string>;
  };
  const canonical = await Suite.threadWorktreePath(threadKey, ref);
  const worktreePath =
    pathForm === "collision-safe replacement"
      ? await Suite.replacementWorktreePath(threadKey, ref, canonical)
      : pathForm === "invalid"
        ? `${canonical}-ref-bogus`
        : canonical;
  const binding = {
    threadKey,
    ref,
    worktreePath,
    user: "worker2",
    lastAttachAt: new Date(now - 2 * 3600_000).toISOString(),
    boundAt: new Date(now - 3 * 3600_000).toISOString(),
    sha: "a".repeat(40),
    evicted: false,
  };
  const rows = new Map<string, unknown>([
    [`thread:${threadKey}`, binding],
    [
      `runReg:${threadKey}`,
      {
        threadKey,
        registeredAt: binding.lastAttachAt,
        deadlineAt: now - 120_000,
      },
    ],
    ["pool:worker2", [threadKey]],
    ["resident:spentPoolUsers", []],
    ["resource", "repo:owner/name"],
    ["facts", { defaultRef: ref }],
  ]);
  const bytes = new Map([[worktreePath, "private uncommitted work"]]);
  const checkedPaths: string[] = [];
  let materializations = 0;
  let safeToRelease = false;
  let metadataAcked = false;
  const storage = {
    get: async (key: string | string[]) =>
      Array.isArray(key) ? new Map(key.map((part) => [part, rows.get(part)])) : rows.get(key),
    put: async (key: string, value: unknown) => {
      rows.set(key, value);
    },
    delete: async (key: string) => {
      rows.delete(key);
    },
    list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
    transaction: async <T>(fn: (txn: typeof storage) => Promise<T>) => fn(storage),
  };
  const instance = new Suite.OwnerFlowUnderTest();
  Object.assign(instance, {
    ctx: { storage },
    env: {},
    threadAttaches: { run: async (_key: string, action: () => Promise<unknown>) => action() },
    threadOpsInFlight: new Map(),
    runNativeScopes: new Map(),
    threadOperationScope: new AsyncLocalStorage(),
    opUsersInUse: new Map(),
    poolUsersInspecting: new Set(),
    workspaceExclusiveOpsInFlight: new Set(),
    recreateAdmission: { blocked: async () => false },
    ensureHydrated: async () => {},
    inFlightCount: () => 0,
    liveBindings: async () => [rows.get(`thread:${threadKey}`)],
    fleetDrain: async () => null,
    memoryGate: async () => null,
    reserveWorkloadSlot: async () => null,
    workloadReservations: new Set(),
    reconcileImage: async () => "current",
    refreshIfStale: async () => {},
    isRuntimeActive: async () => true,
    containerIdentity: async () => "vm-known",
    poolUserHasOldThreadDir: async () => false,
    rebindToOwnPr: async (prior: unknown) => ({ binding: prior }),
    admitThreadDisk: async () => ({ committedKiB: 0 }),
    diskCommittedKiB: 0,
    attachThreadCreate: async ({
      binding: attached,
    }: {
      binding: { threadKey: string; ref: string; worktreePath: string; user: string };
    }) => {
      materializations++;
      rows.set(`thread:${attached.threadKey}`, { ...attached, sha: "a".repeat(40), container: "vm-known" });
      return {
        workspace: attached.worktreePath,
        ref: attached.ref,
        user: attached.user,
        sha: "a".repeat(40),
        container: "vm-known",
      };
    },
    putThreadBinding: async (row: { threadKey: string }) => {
      rows.set(`thread:${row.threadKey}`, row);
    },
    ackWorkspaceSettlement: async () => {
      expect(rows.get(`thread:${threadKey}`)).toMatchObject({ workspaceSettlement: { revision: 1 } });
      metadataAcked = true;
      return true;
    },
    observeRunForEviction: async () => {
      if (!safeToRelease) return { kind: "live", row: { runId: "new-run", threadKey, ownerGen: "new-gen" } };
      const registration = rows.get(`runReg:${threadKey}`) as {
        workspace: unknown;
        runId: string;
        ownerGen: string;
        ownerFence: number;
      };
      if (metadataAcked)
        return {
          kind: "acknowledged",
          owner: { runId: registration.runId, ownerGen: registration.ownerGen, ownerFence: registration.ownerFence },
          revision: 1,
        };
      const terminal = {
        id: registration.runId,
        threadKey,
        status: "completed",
        repo: "owner/name",
        userId: "slack:UOWNER",
      };
      return {
        kind: "terminal",
        record: terminal,
        settlement: {
          version: 1,
          revision: 1,
          owner: { runId: registration.runId, ownerGen: registration.ownerGen, ownerFence: registration.ownerFence },
          binding: registration.workspace,
          record: terminal,
          publication: { version: 1, repo: "owner/name", branches: [], complete: true },
        },
      };
    },
    observePrivateTree: async () => ({
      present: true,
      branch: ref,
      head: "a".repeat(40),
      uncommittedChanges: 0,
      untrackedNonIgnored: 0,
      unpushedCommits: 0,
    }),
    measureTreeBeforeEviction: async () => undefined,
    withMirrorLock: async (action: () => Promise<unknown>) => ({ value: await action() }),
    runOk: async (argv: string[]) => {
      if (argv[0] === "rm") bytes.delete(worktreePath);
    },
    run: async (argv: string[]) => {
      if (argv[0] === "/bin/sh") return { exitCode: 0, stdout: "account-ready\n", stderr: "", timedOut: false };
      if (argv[0] === "pgrep") return { exitCode: 1, stdout: "", stderr: "" };
      if (argv[0] === "sh") {
        checkedPaths.push(argv.at(-1)!);
        return { exitCode: 0, stdout: "worker2\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return {
    instance,
    rows,
    now,
    threadKey,
    worktreePath,
    canonicalPath: canonical,
    pathFor: (otherRef: string) => Suite.threadWorktreePath(threadKey, otherRef),
    checkedPaths,
    materializations: () => materializations,
    privateBytes: () => bytes.get(worktreePath),
    makeSafeToRelease: () => {
      safeToRelease = true;
    },
    attach: (runId: string, fence: number) =>
      instance.attachThreadTraced(
        threadKey,
        null,
        true,
        null,
        false,
        {},
        now,
        { refByDefault: true, ownPr: null },
        undefined,
        60_000,
        runId,
        "new-gen",
        fence,
      ),
  };
}

describe("cancelled owner attachment", () => {
  it("rejects reuse of a cancelled original with a higher fence and allows a distinct successor", async () => {
    const h = await ownerFlow("canonical");
    h.rows.set(`cancelled:${h.threadKey}:run-cancelled`, { stopped: true });
    expect(await h.attach("run-cancelled", 100)).toMatchObject({ error: "run cancelled", status: 409 });
    expect(h.materializations()).toBe(0);
    expect(await h.attach("run-distinct", 101)).toMatchObject({ ref: "main", user: "worker2" });
    expect(h.rows.get(`runReg:${h.threadKey}`)).toMatchObject({
      runId: "run-distinct",
      ownerGen: "new-gen",
      ownerFence: 101,
    });
    expect(h.privateBytes()).toBe("private uncommitted work");
  });
});

const workloadSource = readSource("worker.ts");
const sharedWorkloadSource = readSource("shared.ts");
const RESIDENT_WORKLOAD_LIMIT = Number(sharedWorkloadSource.match(/RESIDENT_WORKLOAD_LIMIT = (\d+)/)?.[1]);
const workloadPool = Array.from({ length: 32 }, (_, i) => `worker${i + 2}`);

function workloadResident(
  options: { live?: number; retained?: number; unknown?: number; processes?: string; probeFails?: boolean } = {},
) {
  const compiled = ts.transpileModule(
    `${ts
      .createSourceFile("worker.ts", workloadSource, ts.ScriptTarget.Latest, true)
      .statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RuntimeUnreachableError")!
      .getText()}
     ${ts
       .createSourceFile("worker.ts", workloadSource, ts.ScriptTarget.Latest, true)
       .statements.find(
         (node) => ts.isClassDeclaration(node) && node.name?.text === "OpaqueNativeOutcomeUnconfirmedError",
       )!
       .getText()}
     ${ts
       .createSourceFile("worker.ts", workloadSource, ts.ScriptTarget.Latest, true)
       .statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "emitDeployAdmission")!
       .getText()}
     ${ts
       .createSourceFile("worker.ts", workloadSource, ts.ScriptTarget.Latest, true)
       .statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "StepError")!
       .getText()}
     class Resident { ${[
       "activeWorkloadOwners",
       "getWorkloadAudit",
       "workloadRecordHash",
       "hashWorkloadAudit",
       "logWorkloadRefusal",
       "workloadAuditReport",
       "observeRunForEviction",
       "workloadOwnerObservation",
       "residentLevels",
       "getResidentRecoveryProbe",
       "reserveWorkloadSlot",
       "allocateOpUser",
       "withOpNativeOperation",
       "operationOrigin",
       "withOpaqueNativeEffect",
       "withSharedNativeOperation",
       "runProvisioning",
       "buildUserRun",
       "runOk",
       "assertOk",
       "restoreWithProgress",
       "restoreExtracted",
       "withNativeOperationScope",
       "runOp",
       "run",
       "noteRuntimeUnreachable",
       "runtimeUnreachableRow",
       "clearRuntimeUnreachable",
       "beginThreadNativeOperation",
       "getNativeOperations",
       "recoverNativeOperation",
       "withRecreateSafeAdmin",
       "registeredRunsBeyondOps",
       "automaticContainerLoss",
       "recreateContainer",
       "inFlightCount",
       "runsInFlightCount",
       "reserveSafePoolUser",
       "ensurePoolAccount",
       "markPoolUserSpent",
       "currentUidLedger",
       "getResidentInfo",
     ]
       .map((name) => methodOf(workloadSource, name) ?? "")
       .join("\n")} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const native = {
    loseOutput: false,
    scopeCalls: [] as Record<string, any>[],
    sdkExecCount: 0,
    closeError: undefined as Error | undefined,
    unsupportedOperator: false,
    archiveRunUnknown: false,
    archiveCleanupError: false,
    archiveLostRun: false,
    bootstrapError: undefined as Error | undefined,
    restoreTick: undefined as Promise<void> | undefined,
    onLaunch: undefined as ((value: Record<string, any>) => void) | undefined,
    accountCommands: false,
    statusError: undefined as Error | undefined,
    statusValue: undefined as unknown,
    onStatus: undefined as (() => void) | undefined,
    execCount: 0,
    outputCount: 0,
    logs: [] as string[],
    failLog: false,
    failWarnLog: undefined as boolean | undefined,
    launchError: undefined as Error | undefined,
    output: undefined as
      { stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated?: boolean } | undefined,
  };
  const owners = new Map<string, unknown>();
  let onOwnerRead: ((runId: string) => Promise<void>) | undefined;
  const Native = runInNewContext(`${compiled}\nResident`, {
    uidLedger,
    readUidReport,
    uidOwner,
    issuedUidCount,
    claimUid,
    reserveUid,
    provisionUidCommand,
    crypto: webcrypto,
    NativeOperationJournal,
    archiveControlAnswer,
    archiveCapabilitySchema,
    executeRestoreArchive,
    prepareRestoreArchive,
    restoreIdentitySchema,
    restorePrivateDirectory,
    RestoreArchiveUnconfirmedError,
    RESTORE_BACKUP_EXPIRY_BUFFER_MS,
    NATIVE_SCOPE_CONTROL_MS: 2000,
    captureException,
    nativeOperationOriginSchema,
    workerVersionId: () => null,
    NativeRunScopes,
    RecordedCheckOperation,
    unstartedNativeOperator,
    registeredRunOwnsRelease,
    URL,
    TextEncoder,
    AbortSignal,
    RUN_STORE_KEY: "runs",
    RUN_STORE_TIMEOUT_MS: 10000,
    fetch: async (_url: unknown, init: { body: string }) => ({
      ok: true,
      json: async () => {
        const runId = JSON.parse(init.body).runId;
        await onOwnerRead?.(runId);
        return owners.get(runId) ?? null;
      },
    }),
    RESIDENT_WORKLOAD_LIMIT,
    injectedBuildStamp: () => ({ commit: "test-build", builtAt: "2026-10-14T00:00:00Z" }),
    levelPosts,
    memorySide,
    mergeOutbox,
    seatSide,
    LEVELS_LAST_KEY: "levels:last",
    LEVELS_OUTBOX_KEY: "levels:outbox",
    isResidentPoolUser,
    THREAD_USERS: workloadPool,
    BUILD_USER: "worker1",
    MIRROR_DIR: "/workspace/mirror",
    CHECKOUT_DIR: "/workspace/checkout",
    STAGING_CHECKOUT_DIR: "/workspace/checkout.staging",
    RETIRED_CHECKOUT_DIR: "/workspace/checkout.retired",
    DISK_MARKERS: [],
    githubAppConfigured: () => false,
    killStaleBuildProcessesCommand,
    RUN_REG_KEY_PREFIX: "run:",
    RESOURCE_KEY: "resource",
    RESIDENT_ID_KEY: "resident:instanceId",
    SPENT_POOL_USERS_KEY: "resident:spentPoolUsers",
    THREAD_KEY_PREFIX: "thread:",
    IMAGE_REPORT_PENDING_KEY: "image-pending",
    SNAPSHOT_KEY: "snapshot",
    STATE_KEY: "resident:state",
    REASON_KEY: "resident:reason",
    UPDATED_KEY: "resident:updatedAt",
    FACTS_KEY: "resident:facts",
    DISK_KEY: "resident:disk",
    MIRROR_MUTEX_KEY: "resident:mirrorMutex",
    LIFECYCLE_KEY: "resident:lifecycle",
    REFRESH_INSTANCE_KEY: "resident:refreshInstance",
    AUTO_REBUILDS_KEY: "resident:autoRebuilds",
    INFRA_STREAK_KEY: "resident:infraStreak",
    MEMORY_KEY: "resident:memory",
    IMAGE_RECONCILE_KEY: "imageReconcile",
    RECREATE_ADMISSION_KEY: "resident:recreateAdmission",
    PROVISION_RUN_CALLBACK: "runProvisioning",
    PROVISIONING_CALLBACK: "onProvisioningDeadline",
    BUILD_ID: "test-build",
    inFlightKey: (kind: string) => `resident:in-flight:${kind}`,
    inFlightRow: (refresh: unknown, hydration: unknown) => ({ refresh: refresh ?? null, hydration: hydration ?? null }),
    lifecycleOf: () => "workflow",
    idleForPoolRecycle,
    retryPoolRecycleAfterRefresh,
    liveDrain,
    spendPoolUser,
    unavailablePoolUsers,
    ownedPoolUsers,
    hasRunOwnerField,
    registeredRunNeedsProtection,
    CLEAN_IDLE_RELEASE_S: 3600,
    RUN_REGISTRATION_GRACE_MS: 10_000,
    THREAD_KEY_RE: /^[a-z]{1,32}:[A-Za-z0-9._:-]{1,128}$/,
    runRegKey: (thread: string) => `run:${thread}`,
    runFenceKey: (thread: string) => `fence:${thread}`,
    poolBindingKey: (user: string) => `claim:${user}`,
    systemClock: () => 10_000_000,
    setTimeout: (fn: () => void) => {
      void native.restoreTick?.then(fn);
      return 0;
    },
    accumulateRestoreProgress,
    judgeRestoreProgress,
    RESTORE_POLL_MS: 1000,
    classifyDeployRegistrationWithLedger,
    isAcknowledgedWorkspaceOwner,
    parseSpentPoolUsers,
    parsePoolBindings,
    validRunOwner,
    createStepTrace: () => ({ steps: () => [] }),
    emitStepRoot: () => {},
    refusalOutcome: () => "refused",
    DESTROY_UNCONFIRMED_KEY: "destroy-unconfirmed",
    CLEANUP_PENDING_KEY: "cleanup",
    DEFAULT_EXEC_TIMEOUT_MS: 1000,
    RUNTIME_UNREACHABLE_KEY: "resident:runtimeUnreachable",
    RUNTIME_UNREACHABLE_DOWN_AT: 6,
    SDK_CONNECT_TIMEOUT_MS: 30_000,
    runtimeUnreachableReason,
    ControlResetError,
    SandboxRuntimeBusyError,
    errMsg: (error: Error) => error.message,
    createExtensionProcessSandbox: () => ({
      getProcess: async (id: string) => ({
        status: async () => ({
          id,
          pid: 42,
          startedAt: "2026-10-11T00:00:00.000Z",
          state: "exited",
          endedAt: "2026-10-11T00:00:01.000Z",
          exit: { code: 0, timedOut: false },
        }),
      }),
      exec: async (argv: readonly string[]) => {
        native.sdkExecCount++;
        native.execCount++;
        if (native.launchError) throw native.launchError;
        return {
          status: async () => {
            native.onStatus?.();
            if (native.statusError) throw native.statusError;
            return (
              native.statusValue ?? {
                id: "original-process",
                pid: 42,
                startedAt: "2026-10-11T00:00:00.000Z",
                state: "running",
              }
            );
          },
          output: async () => {
            native.outputCount++;
            if (native.loseOutput) throw new Error("native output lost");
            if (native.output) return native.output;
            return {
              stdout: native.accountCommands
                ? argv[0] === "/bin/sh"
                  ? "account-ready\n"
                  : "root\nworker1\n"
                : "completed",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              truncated: false,
            };
          },
        };
      },
    }),
    isControlReset: (error: Error) => error.message === "fixture-control-reset",
    isRuntimeReplacement: () => false,
    isRuntimeBusy: (error: Error) => error.message === "fixture-runtime-busy",
    isRuntimeUnreachable: (error: Error) => error.name === "AbortError",
    ProcessWaitTimeoutError: class extends Error {},
    RPCTransportError,
    OperationInterruptedError,
    BackupNotFoundError,
    BackupExpiredError,
    selfAndCauses: (error: unknown) => [error, (error as { cause?: unknown })?.cause].filter(Boolean),
    console: {
      log: (line: string) => {
        if (native.failLog) throw new Error("diagnostic sink unavailable");
        native.logs.push(line);
      },
      warn: (line: string) => {
        if (native.failWarnLog ?? native.failLog) throw new Error("diagnostic sink unavailable");
        native.logs.push(line);
      },
    },
  });
  const instance = new Native();
  const rows = new Map<string, unknown>();
  const lifecycle: string[] = [];
  const bindings: any[] = [];
  const spent: { user: string; owner: string }[] = [];
  const live = options.live ?? 0;
  const retained = options.retained ?? 0;
  const unknown = options.unknown ?? 0;
  for (let i = 0; i < live + retained + unknown; i++) {
    const threadKey = `mcp:owner-${i}`;
    const owner = { runId: `run-${i}`, ownerGen: "generation", ownerFence: i + 1 };
    const user = `worker${i + 2}`;
    bindings.push({ threadKey, user, lastAttachAt: "1970-01-01T00:00:00Z" });
    rows.set(`run:${threadKey}`, { ...owner, threadKey });
    rows.set(`fence:${threadKey}`, owner);
    rows.set(`claim:${user}`, [threadKey]);
    spent.push({ user, owner: `thread:${threadKey}` });
    owners.set(
      owner.runId,
      i < live
        ? { kind: "live", row: { ...owner, threadKey } }
        : i < live + retained
          ? { kind: "terminal", record: { id: owner.runId, threadKey, status: "completed" } }
          : null,
    );
  }
  rows.set("resident:spentPoolUsers", spent);
  rows.set("resource", "repo:acme/api");
  Object.assign(instance, {
    workloadAdmissions: new KeyedAsyncLock(),
    workloadReservations: new Set<string>(),
    poolUsersInspecting: new Set<string>(),
    opOperationScope: new AsyncLocalStorage(),
    activeOperatorRequests: new Set<string>(),
    threadOperationScope: new AsyncLocalStorage(),
    withDeployAdmission: async (_producer: string, _context: unknown, fn: () => Promise<unknown>) => fn(),
    stepTrace: { run: (_trace: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    pendingRestores: new Set(),
    restoreProgressKiB: async () => 0,
    dirKiB: async () => 1,
    recreateAdmission: {
      pending: false,
      blocked: async () => false,
      run: async (fn: () => unknown) => ({ busy: false, value: await fn() }),
    },
    attachesInFlight: 0,
    attachAdmissionsInFlight: 0,
    refreshesInFlight: 0,
    refreshAdmissionsInFlight: 0,
    adminWorkInFlight: 0,
    hydration: null,
    workspaceExclusiveOpsInFlight: new Set<string>(),
    getStatus: async () => ({ state: "warm" }),
    memoryGauge: async () => null,
    listSchedules: async () => [],
    snapshotHandle: async () => null,
    incarnation: "test-incarnation",
    registry: () => ({ getDrain: async () => null }),
    swapIncarnation: () => {},
    setResidentState: async () => {},
    recordRefreshError: async () => {},
    destroyConfirmed: async () => {
      lifecycle.push("destroyed");
      rows.set("resident:spentPoolUsers", []);
    },
    ensureHydrated: async () => {
      lifecycle.push("hydrated");
    },
    poolUserHasOldThreadDir: async () => false,
    poolUserHasOldStageContent: async () => false,
    assertThreadOperationAllowed: async () => {},
    clearRuntimeUnreachable: async () => {},
    opAdmissionsInFlight: 0,
    runOpTraced: async () => {
      const user = await instance.allocateOpUser();
      return typeof user === "string" ? { ok: true, user } : user;
    },
    opUsersInUse: new Map<string, string>(),
    threadOpsInFlight: new Map<string, number>(),
    runNativeScopes: new Map(),
    ctx: {
      container: { running: true },
      id: { toString: () => "fixture-container" },
      storage: {
        get: async (key: string | string[]) =>
          Array.isArray(key)
            ? new Map(key.filter((name) => rows.has(name)).map((name) => [name, structuredClone(rows.get(name))]))
            : structuredClone(rows.get(key)),
        list: async ({ prefix, limit, startAfter = "" }: { prefix: string; limit?: number; startAfter?: string }) =>
          new Map(
            [...rows]
              .filter(([key]) => key.startsWith(prefix) && key > startAfter)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .slice(0, limit),
          ),
        put: async (key: string | Record<string, unknown>, value?: unknown) => {
          if (typeof key === "string") rows.set(key, structuredClone(value));
          else for (const [name, item] of Object.entries(key)) rows.set(name, structuredClone(item));
        },
        delete: async (key: string) => rows.delete(key),
      },
    },
    liveBindings: async () => bindings,
    env: { STATE_WORKER_URL: "https://state.invalid", MEMORY_TOKEN: "fixture-only" },
    isRuntimeActive: async () => true,
    run: async (command: string[]) => ({
      exitCode: options.probeFails ? 1 : 0,
      stdout: command[0] === "/bin/sh" ? "account-ready\n" : (options.processes ?? "root\nworker1\n"),
      stderr: "",
      timedOut: false,
      truncated: false,
    }),
    reserveSafePoolUser: async () => "worker18",
  });
  const nativeScopes = new Map<string, boolean>();
  const archives = new Map<string, any>();
  instance.nativeScopeTransport = () => ({
    request: async (value: Record<string, any>) => {
      native.scopeCalls.push(structuredClone(value));
      const output = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0, timedOut: false });
      if (value.mode === "inspect")
        return output({
          version: 1,
          boot: "11111111-1111-4111-8111-111111111111",
          ...(value.operator === true && !native.unsupportedOperator ? { operatorScopes: 1 } : {}),
          ...(value.archive ? { archiveRestores: 1 } : {}),
        });
      if (native.unsupportedOperator) throw new Error("operator scope unsupported");
      if (value.mode === "bootstrap") {
        if (native.unsupportedOperator) throw new Error("operator scope unsupported");
        nativeScopes.set(value.ref.id, false);
        if (native.bootstrapError) throw native.bootstrapError;
        return output({ ref: value.ref, closed: false });
      }
      if (value.mode === "close") {
        if (native.closeError) throw native.closeError;
        nativeScopes.set(value.ref.id, true);
        return output({ ref: value.ref, closed: true, populated: false });
      }
      if (value.mode === "view")
        return output({
          ref: value.ref,
          closed: nativeScopes.get(value.ref.id) === true,
          populated: false,
          present: true,
          ready: true,
        });
      if (value.mode.startsWith("archive-")) {
        if (value.mode === "archive-prepare")
          archives.set(value.attempt, { identity: value.identity, phase: "receiving", receivedBytes: 0 });
        const saved = archives.get(value.attempt);
        if (!saved) throw new Error("original archive absent");
        if (value.mode === "archive-append") {
          const size = atob(value.data).length;
          Object.assign(saved, {
            receivedBytes: value.offset + size,
            append: { id: value.appendId, offset: value.offset, size, hash: value.hash },
          });
        }
        if (value.mode === "archive-run") {
          if (native.archiveRunUnknown) {
            saved.phase = "installing";
            throw new Error("archive install unknown");
          }
          Object.assign(saved, {
            phase: "done",
            receipt: { identity: value.identity, outcome: "committed", cleanup: "complete" },
          });
          if (native.archiveLostRun) throw new Error("original reply lost");
        }
        if (value.mode === "archive-clean") {
          if (native.archiveCleanupError || saved.phase === "installing") throw new Error("archive cleanup unknown");
          if (!saved.receipt)
            Object.assign(saved, {
              phase: "done",
              receipt: { identity: value.identity, outcome: "aborted", cleanup: "complete", reason: "cancelled" },
            });
        }
        return output(saved);
      }
      if (value.mode === "kill-attempt")
        return output({ ref: value.ref, attempt: value.attempt, closed: false, populated: false });
      if (nativeScopes.get(value.ref.id)) throw new Error("native scope is closed");
      native.onLaunch?.(value);
      native.execCount++;
      if (native.launchError) throw native.launchError;
      native.outputCount++;
      if (native.loseOutput) throw new Error("native output lost");
      return (
        native.output ?? {
          stdout: value.role === "provision" ? "account-ready\n" : "completed",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
        }
      );
    },
  });
  const operatorEntry = instance.withOpNativeOperation.bind(instance);
  instance.withOpNativeOperation = (
    owner: string,
    fn: () => Promise<unknown>,
    producer = "op-test",
    context?: unknown,
  ) => operatorEntry(owner, fn, producer, context);
  // Legacy SDK requests retain their original journal/async context; they do not adopt a new owned scope.
  instance.legacyOperator = (owner: string, fn: () => Promise<unknown>) => {
    const scope = { key: `native-operation:${owner}`, owner, active: true, allocated: false };
    return instance.withNativeOperationScope(scope.key, { opOwner: owner }, scope, () =>
      instance.opOperationScope.run(scope, fn),
    );
  };
  const storageLock = new KeyedAsyncLock();
  instance.ctx.storage.transaction = async (fn: (store: unknown) => Promise<unknown>) =>
    storageLock.run("storage", () => fn(instance.ctx.storage));
  return {
    instance,
    rows,
    native,
    lifecycle,
    owners,
    onOwnerRead: (read: typeof onOwnerRead) => {
      onOwnerRead = read;
    },
  };
}

describe("resident UID status report", () => {
  it("reports initialized ownership and leaves inconsistent stored counts unverified", async () => {
    const { instance, rows } = workloadResident();
    rows.set("uid:state", { generation: "current", next: 35, issued: 1 });
    rows.set("uid:current:user:worker34", "thread:current");
    const before = structuredClone(rows);
    expect(await instance.getResidentInfo()).toMatchObject({
      poolUsersSpent: 1,
      poolUserSpends: [{ user: "worker34", owner: "thread:current" }],
      poolUserSpendsComplete: true,
    });
    expect(rows).toEqual(before);
    rows.set("uid:state", { generation: "current", next: 35, issued: 2 });
    const corrupt = structuredClone(rows);
    expect(await instance.getResidentInfo()).toMatchObject({
      poolUsersSpent: null,
      poolUserSpends: null,
      poolUserSpendsComplete: false,
    });
    expect(rows).toEqual(corrupt);
  });

  it("marks a bounded owner preview incomplete without changing ownership", async () => {
    const { instance, rows, native, lifecycle } = workloadResident();
    rows.set("uid:state", { generation: "current", next: 229, issued: 129 });
    for (let i = 100; i <= 228; i++) rows.set(`uid:current:user:worker${i}`, `thread:owner-${i}`);
    const before = structuredClone(rows);
    const info = await instance.getResidentInfo();
    expect(info).toMatchObject({ poolUsersSpent: 129, poolUserSpendsComplete: false });
    expect(info.poolUserSpends).toHaveLength(128);
    expect(rows).toEqual(before);
    expect(native.execCount).toBe(0);
    expect(lifecycle).toEqual([]);
  });

  it.each([{ legacy: [] }, { legacy: [{ user: "worker11", owner: "thread:old" }] }])(
    "reports absent current UID state as unverified without migrating legacy rows %j",
    async ({ legacy }) => {
      const { instance, rows } = workloadResident();
      rows.set("resident:spentPoolUsers", legacy);
      const before = structuredClone(rows);
      instance.run = async () => {
        throw new Error("status must not run a command");
      };
      expect(await instance.getResidentInfo()).toMatchObject({
        uidAllocation: "dynamic",
        poolUsersTotal: null,
        poolUsersSpent: null,
        poolUserSpends: null,
        poolUserSpendsComplete: false,
        workloadLimit: 16,
      });
      expect(rows).toEqual(before);
    },
  );
});

function statusObservationFailure(kind: "invalid_frame" | "protocol_error" = "invalid_frame") {
  return new RPCTransportError({
    code: ErrorCode.RPC_TRANSPORT_ERROR,
    httpStatus: 500,
    timestamp: "2026-10-11T00:00:00.000Z",
    message: "synthetic-private-status",
    context: { kind, originalMessage: "synthetic-private-status", errorName: "TypeError" },
  });
}

describe("native timeout ending custody", () => {
  it.each([
    "acknowledged",
    "refused",
    "foreign",
    "launcher-unconfirmed",
    "salvage-pending",
    "missing-proof",
    "missing-proof-log-failed",
  ] as const)("retires only an originally acknowledged timeout: %s", async (outcome) => {
    vi.useFakeTimers();
    try {
      const h = workloadResident();
      h.native.failWarnLog = outcome === "missing-proof-log-failed";
      const threadKey = "slack:C1:timeout-proof";
      const owner = { runId: "run-timeout", ownerGen: "generation", ownerFence: 7 };
      const context = { threadKey, ...owner, incarnation: "test-incarnation" };
      const request = { command: "printf progress; sleep 5", timeoutMs: 50 };
      const operation = { key: "a".repeat(64), commandHash: await checkCommandHash(request.command) };
      const neighbor = {
        opOwner: "op:neighbor",
        native: { version: 1, closed: false, pending: { next: { kind: "opaque" } } },
      };
      h.rows.set("native-operation:op:neighbor", neighbor);
      h.rows.set("private-file", "uncommitted work");
      let finish!: (code: number) => void;
      const exitCode = new Promise<number>((resolve) => {
        finish = resolve;
      });
      let launchSubmitted!: () => void;
      const submitted = new Promise<void>((resolve) => {
        launchSubmitted = resolve;
      });
      const calls: Array<Record<string, unknown>> = [];
      const native = new CloudflareNativeScopeTransport({
        running: true,
        exec: async (_argv: unknown, options: { stdin: ReadableStream }) => {
          const call = JSON.parse(await new Response(options.stdin).text());
          calls.push(call);
          if (call.mode === "launch") {
            launchSubmitted();
            return { stdout: new Response("progress").body, stderr: new Response("").body, exitCode };
          }
          if (call.mode === "kill-attempt" && outcome !== "launcher-unconfirmed") finish(137);
          const answer =
            call.mode === "inspect"
              ? { version: 1, boot: "11111111-1111-4111-8111-111111111111" }
              : {
                  ref:
                    call.mode === "kill-attempt" && outcome === "foreign"
                      ? { ...call.ref, owner: { ...owner, runId: "foreign" } }
                      : call.ref,
                  ...(call.attempt ? { attempt: call.attempt } : {}),
                  closed: false,
                  ...(call.mode === "kill-attempt" ? { populated: false } : {}),
                };
          return {
            stdout: new Response(JSON.stringify(answer)).body,
            stderr: new Response("").body,
            exitCode: Promise.resolve(call.mode === "kill-attempt" && outcome === "refused" ? 125 : 0),
          };
        },
      } as any);
      h.instance.ctx.container = { running: true };
      h.instance.threadOperationScope = new AsyncLocalStorage();
      h.instance.nativeScopeTransport = () => ({
        request: async (value: Record<string, unknown>, timeoutMs: number) => {
          const output = await native.request(value, timeoutMs);
          if (value.mode === "launch" && outcome.startsWith("missing-proof")) {
            const { nativeEnding: _ending, ...partial } = output;
            return partial;
          }
          return output;
        },
      });
      const scopes = new NativeRunScopes(h.instance.ctx.storage, native);
      await scopes.birth(threadKey, owner, true, async () => {});
      const checks = new RecordedCheckOperation(h.instance.ctx.storage);
      const journal = new NativeOperationJournal(h.instance.ctx.storage);
      let nativeKey = "";
      let salvageAttempt = "";
      const pending = checks
        .execute(
          context,
          operation,
          request,
          async () => true,
          async (key) => {
            nativeKey = key;
            const scope = { key, owner, threadKey, active: true };
            const answer = await h.instance.withNativeOperationScope(key, owner, scope, async () => {
              const result = await h.instance.threadOperationScope.run(scope, () =>
                Object.getPrototypeOf(h.instance).run.call(h.instance, ["/bin/sh", "-c", request.command], {
                  timeoutMs: 50,
                }),
              );
              if (outcome === "salvage-pending") salvageAttempt = await journal.begin(key, "opaque");
              return result;
            });
            return {
              stdout: answer.stdout,
              stderr: answer.stderr,
              exitCode: answer.exitCode,
              truncated: answer.truncated === true,
            };
          },
        )
        .then(
          (value) => ({ kind: "returned", value }),
          (error: Error) => ({ kind: "failed", message: error.message }),
        );
      await Promise.race([
        submitted,
        pending.then((answer) => {
          throw new Error("failed before native submission: " + JSON.stringify(answer));
        }),
      ]);
      await vi.advanceTimersByTimeAsync(2050);
      const answer = await pending;
      const selected: CheckSource = {
        version: 1,
        state: "terminal",
        threadKey,
        operation,
        selector: { runId: owner.runId, callId: "original-timeout", phase: "command" },
        resource: {
          type: "run",
          id: owner.runId,
          userId: "u1",
          channelId: "slack:C1",
          channelVisibility: "private",
          repo: "acme/app",
        },
      };
      expect(calls.map((call) => call.mode)).toEqual(["inspect", "bootstrap", "launch", "kill-attempt"]);
      expect(calls[3]).toMatchObject({ ref: calls[2].ref, attempt: calls[2].attempt });
      expect(h.rows.get("native-operation:op:neighbor")).toEqual(neighbor);
      expect(h.rows.get("private-file")).toBe("uncommitted work");
      if (outcome === "acknowledged") {
        expect(answer).toMatchObject({
          kind: "returned",
          value: { kind: "completed", result: { stdout: "progress", exitCode: 124 } },
        });
        expect(h.rows.has(nativeKey)).toBe(false);
        expect(await checks.inspectRecorded(selected, true)).toEqual({
          kind: "retired",
          reason: "native_ended",
          proofHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } else if (outcome === "salvage-pending") {
        expect(answer).toMatchObject({ kind: "returned", value: { kind: "unknown" } });
        expect(h.rows.get(nativeKey)).toMatchObject({
          native: { closed: true, pending: { [salvageAttempt]: { kind: "opaque" } } },
        });
        expect(await checks.inspectRecorded(selected, true)).toEqual({ kind: "unavailable", reason: "proof" });
        await journal.settle(nativeKey, salvageAttempt);
        expect(await checks.inspectRecorded(selected, true)).toMatchObject({
          kind: "retired",
          reason: "native_ended",
        });
        expect(calls.filter((call) => call.mode === "launch")).toHaveLength(1);
        expect(calls.filter((call) => call.mode === "kill-attempt")).toHaveLength(1);
      } else {
        expect(answer).toMatchObject({ kind: "failed" });
        if (outcome.startsWith("missing-proof")) {
          expect(answer).toEqual({ kind: "failed", message: "native timeout ending is unconfirmed" });
          const diagnostics = h.native.logs
            .filter((line) => line.startsWith("[native-timeout-ending] "))
            .map((line) => JSON.parse(line.slice("[native-timeout-ending] ".length)));
          expect(diagnostics).toEqual(
            outcome === "missing-proof-log-failed"
              ? []
              : [
                  {
                    phase: "unconfirmed",
                    runId: "run-timeout",
                    ownerGen: "generation",
                    ownerFence: 7,
                    boot: "11111111-1111-4111-8111-111111111111",
                    attempt: expect.stringMatching(/^[a-f0-9-]{36}$/),
                    exitCode: 124,
                  },
                ],
          );
        }
        expect(h.rows.get(nativeKey)).toMatchObject({ ...owner, native: { closed: true } });
        expect(await checks.inspectRecorded(selected, true)).toEqual({
          kind: "pending",
          reason: "native_ending_unproven",
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("owned background operation admission", () => {
  it("binds the real producer and owned scope before the first native payload", async () => {
    const h = workloadResident();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.native.onLaunch = (value) => {
      expect(h.rows.get("native-operation:op:before-effect")).toMatchObject({
        opOwner: "op:before-effect",
        origin: {
          producer: "op-test",
          resource: "repo:acme/api",
          actor: "operator",
          sourceId: "check-a",
          callId: "22222222-2222-4222-8222-222222222222",
        },
        native: {
          scope: { kind: "operation", owner: { opOwner: "op:before-effect" } },
          pending: { [value.attempt]: { kind: "process" } },
        },
      });
    };
    expect(
      await h.instance.withOpNativeOperation("op:before-effect", () => h.instance.run(["true"]), "op-test", {
        sourceId: "check-a",
        callId: "22222222-2222-4222-8222-222222222222",
        actor: "operator",
        traceId: null,
        parentSourceId: null,
      }),
    ).toEqual({ stdout: "completed", stderr: "", exitCode: 0, timedOut: false, truncated: false });
    expect(h.native.scopeCalls.filter((call) => call.mode === "launch")).toHaveLength(1);
    expect(h.native.sdkExecCount).toBe(0);
    expect(
      await new NativeOperationJournal(h.instance.ctx.storage).operatorEnded("native-operation:op:before-effect", {
        opOwner: "op:before-effect",
      }),
    ).toBe(true);
  });

  it("refuses an unsupported old controller before an SDK or payload launch", async () => {
    const h = workloadResident();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.native.unsupportedOperator = true;
    await expect(h.instance.withOpNativeOperation("op:old-controller", () => h.instance.run(["true"]))).rejects.toThrow(
      "operator scope unsupported",
    );
    expect(
      await new NativeOperationJournal(h.instance.ctx.storage).operatorEnded("native-operation:op:old-controller", {
        opOwner: "op:old-controller",
      }),
    ).toBe(true);
    expect(h.native.sdkExecCount).toBe(0);
    expect(h.native.scopeCalls.filter((call) => call.mode === "launch")).toEqual([]);
  });

  it("closes the original no-payload scope after a lost bootstrap reply", async () => {
    const h = workloadResident();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.native.bootstrapError = new Error("bootstrap reply lost");
    await expect(h.instance.withOpNativeOperation("op:bootstrap-lost", () => h.instance.run(["true"]))).rejects.toThrow(
      "bootstrap reply lost",
    );
    expect(
      await new NativeOperationJournal(h.instance.ctx.storage).operatorEnded("native-operation:op:bootstrap-lost", {
        opOwner: "op:bootstrap-lost",
      }),
    ).toBe(true);
    expect(h.native.scopeCalls.map((call) => call.mode)).toEqual(["inspect", "bootstrap", "inspect", "close"]);
    expect(h.native.sdkExecCount).toBe(0);
  });

  function provisioningFixture() {
    const h = workloadResident();
    h.rows.set("resident:state", "onboarding");
    const events: string[] = [];
    Object.assign(h.instance, {
      currentUidLedger: async () => ({}),
      registry: () => ({
        getRecord: async () => ({ defaultRef: "main", provisioningTimeoutMs: 1000, commands: { build: "" } }),
      }),
      runOk: async (argv: readonly string[], _step: string, opts?: Record<string, unknown>) => {
        const result = await Object.getPrototypeOf(h.instance).run.call(h.instance, argv, opts);
        if (result.exitCode !== 0) throw new Error("provisioning command failed");
        events.push(argv[0] === "rm" ? "cleaned" : "command");
        return result.stdout;
      },
      gitWithCred: async (_token: unknown, args: string[]) => {
        const result = await Object.getPrototypeOf(h.instance).run.call(h.instance, ["git", ...args]);
        if (result.exitCode !== 0) throw new Error("clone failed");
        events.push("cloned");
      },
      ensureGitSetup: async () => {},
      withMirrorLock: async (fn: () => Promise<unknown>) => fn(),
      refExists: async () => true,
      readMirrorSha: async () => "a".repeat(40),
      lockfileKey: async () => "lockfile",
      buildUserRun: async () => {},
      snapshot: async () => ({ done: true, record: { mirror: { id: "mirror" }, checkout: { id: "checkout" } } }),
      writeDiskMarkers: async () => {},
      deleteSchedules: () => {},
      residentIdentity: async () => "repo:acme/api",
      reportPendingImageCurrent: async () => {},
      setResidentState: async (state: string, reason?: string) => {
        h.rows.set("resident:state", state);
        h.rows.set("resident:reason", reason);
      },
      withDeployAdmission: async (producer: string, context: unknown, fn: () => Promise<unknown>) => {
        events.push("deploy-admitted:" + producer);
        return fn();
      },
    });
    return { ...h, events };
  }

  it("owns scheduled provisioning before cleanup and reaches warm after cloning", async () => {
    const h = provisioningFixture();
    const admissions: unknown[] = [];
    h.native.onLaunch = () => {
      admissions.push([...h.rows.values()].filter((row: any) => row?.origin?.producer === "provisioning"));
    };
    await h.instance.runProvisioning("repo:acme/api");
    expect(h.rows.get("resident:state")).toBe("warm");
    expect(h.rows.get("resident:facts")).toMatchObject({
      defaultRef: "main",
      sha: "a".repeat(40),
      lockfileHash: "lockfile",
    });
    expect(h.events.slice(0, 3)).toEqual(["deploy-admitted:provisioning", "cleaned", "cloned"]);
    expect(admissions[0]).toMatchObject([
      {
        origin: { producer: "provisioning", sourceId: "provisioning" },
        native: { scope: { kind: "operation" }, pending: expect.any(Object) },
      },
    ]);
    expect(await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).toEqual(new Map());
  });

  it("leaves onboarding untouched when deployment protection refuses provisioning", async () => {
    const h = provisioningFixture();
    h.instance.withDeployAdmission = async () => ({ error: "deploy-fence: upload in progress" });
    await expect(h.instance.runProvisioning("repo:acme/api")).rejects.toThrow("deploy-fence: upload in progress");
    expect(h.rows.get("resident:state")).toBe("onboarding");
    expect(h.events).toEqual([]);
    expect(h.native.sdkExecCount).toBe(0);
  });

  it("rechecks onboarding after admission before a delayed callback can clean a warm tree", async () => {
    const h = provisioningFixture();
    h.instance.withDeployAdmission = async (_producer: string, _context: unknown, fn: () => Promise<unknown>) => {
      h.rows.set("resident:state", "warm");
      return fn();
    };
    await h.instance.runProvisioning("repo:acme/api");
    expect(h.rows.get("resident:state")).toBe("warm");
    expect(h.events).toEqual([]);
    expect(h.native.scopeCalls.filter((call) => call.mode === "launch")).toEqual([]);
  });

  it("ignores a stale provisioning payload for another resident resource", async () => {
    const h = provisioningFixture();
    await h.instance.runProvisioning("repo:acme/other");
    expect(h.rows.get("resident:state")).toBe("onboarding");
    expect(h.events).toEqual([]);
    expect(h.native.scopeCalls).toEqual([]);
  });

  it("keeps an unknown provisioning effect held instead of starting another clone", async () => {
    const h = provisioningFixture();
    h.native.launchError = new Error("original cleanup reply lost");
    await h.instance.runProvisioning("repo:acme/api");
    expect(h.rows.get("resident:state")).toBe("down");
    const held = [...h.rows.values()].filter(
      (value: any) => value?.original?.origin?.producer === "provisioning",
    ) as any[];
    expect(held).toMatchObject([
      {
        original: { origin: { producer: "provisioning" }, native: { closed: true, pending: expect.any(Object) } },
        receipt: { originalOperationOutcome: "unknown" },
      },
    ]);
    expect(Object.values(held[0].original.native.pending)).toHaveLength(1);
    h.rows.set("resident:state", "onboarding");
    h.native.launchError = undefined;
    await expect(h.instance.runProvisioning("repo:acme/api")).rejects.toThrow(
      "background producer has an original active or unknown operation",
    );
    expect(h.native.scopeCalls.filter((call) => call.mode === "launch")).toHaveLength(1);
  });

  it("runs a refresh build with its writable user home in the original operator scope", async () => {
    const h = workloadResident();
    h.instance.runOk = Object.getPrototypeOf(h.instance).runOk.bind(h.instance);
    h.instance.run = Object.getPrototypeOf(h.instance).run.bind(h.instance);
    h.native.onLaunch = (value) => {
      if (value.argv.some((arg: string) => arg.includes("write-home-cache"))) {
        if (value.role !== "user" || value.user !== "worker1") throw new Error("build home cache is read-only");
        h.native.output = { stdout: "cache-created", stderr: "", exitCode: 0, timedOut: false };
      }
    };
    expect(
      await h.instance.withSharedNativeOperation("refresh-step", () =>
        h.instance.buildUserRun("write-home-cache", "build", 1000),
      ),
    ).toBe("cache-created");
    expect(h.native.scopeCalls.find((call) => call.role === "user")).toMatchObject({
      user: "worker1",
      argv: ["/bin/bash", "-c", "cd /workspace/checkout && write-home-cache"],
    });
  });

  it("refuses a build without an original operation before any root fallback", async () => {
    const h = workloadResident();
    h.instance.runOk = Object.getPrototypeOf(h.instance).runOk.bind(h.instance);
    h.instance.run = Object.getPrototypeOf(h.instance).run.bind(h.instance);
    await expect(h.instance.buildUserRun("write-home-cache", "build", 1000)).rejects.toThrow(
      "build command requires its original operator scope",
    );
    expect(h.native.sdkExecCount).toBe(0);
  });

  it("records a service mutation before launch and forwards its exact paths", async () => {
    const h = workloadResident();
    let pending: unknown;
    h.native.onLaunch = () => {
      pending = [...h.rows.values()].flatMap((value: any) => Object.values(value?.native?.pending ?? {}));
    };
    await h.instance.withSharedNativeOperation(
      "hydration",
      () =>
        Object.getPrototypeOf(h.instance).run.call(h.instance, ["rm", "-rf", "/workspace/mirror"], {
          workspacePaths: ["/workspace/mirror"],
        }),
      "mutation-a",
    );
    expect(pending).toEqual([{ kind: "process", mutationPaths: ["/workspace/mirror"] }]);
    expect(h.native.scopeCalls.find((call) => call.mode === "launch")).toMatchObject({
      workspacePaths: ["/workspace/mirror"],
      argv: ["rm", "-rf", "/workspace/mirror"],
    });
    expect(await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).toEqual(new Map());
  });

  it("refuses service mutation without an original native scope", async () => {
    const h = workloadResident();
    await expect(
      Object.getPrototypeOf(h.instance).run.call(h.instance, ["rm", "-rf", "/workspace/mirror"], {
        workspacePaths: ["/workspace/mirror"],
      }),
    ).rejects.toThrow("workspace mutation requires its original native scope");
    expect(h.native.scopeCalls).toEqual([]);
    expect(h.native.sdkExecCount).toBe(0);
  });

  function archiveFixture(
    h: ReturnType<typeof workloadResident>,
    phase?: "metadata" | "expired" | "archive" | "error",
  ) {
    const id = "44444444-4444-4444-8444-444444444444";
    const backup = { id, dir: "/workspace/mirror" };
    h.instance.env.BACKUP_BUCKET = {
      get: async (key: string) => {
        if (phase === "error") throw new Error("storage read failed token=fixture-secret");
        if (key === `backups/${id}/meta.json`)
          return phase === "metadata"
            ? null
            : {
                size: 128,
                etag: "a".repeat(32),
                json: async () => ({
                  id,
                  sizeBytes: 3,
                  createdAt: new Date(10_000_000).toISOString(),
                  ttl: phase === "expired" ? 1 : 3600,
                }),
              };
        if (key === `backups/${id}/data.sqsh`)
          return {
            size: 3,
            etag: "a".repeat(32),
            body: new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array([1, 2, 3]));
                c.close();
              },
            }),
          };
        throw new Error("unexpected archive key");
      },
      head: async (key: string) => {
        expect(key).toBe(`backups/${id}/data.sqsh`);
        return phase === "archive" ? null : { size: 3, etag: "a".repeat(32) };
      },
    };
    h.instance.restoreBackup = () => {
      throw new Error("SDK restore must not be called");
    };
    return {
      backup,
      restore: () =>
        h.instance.withSharedNativeOperation(
          "deps-materialize",
          () => h.instance.restoreWithProgress(backup, "restore", 11_000_000),
          "cache-a",
        ),
    };
  }

  it.each([false, true])(
    "permits fallback from read-only missing or expired archive checks: local=%s",
    async (localBucket) => {
      for (const phase of ["metadata", "expired", "archive"] as const) {
        const h = workloadResident();
        const f = archiveFixture(h, phase);
        const restore = () =>
          h.instance.withSharedNativeOperation(
            "deps-materialize",
            async () => {
              try {
                await h.instance.restoreWithProgress({ ...f.backup, localBucket }, "restore", 11_000_000);
              } catch (error) {
                if (error instanceof BackupNotFoundError || error instanceof BackupExpiredError)
                  return "installer allowed";
                throw error;
              }
              throw new Error("unexpected success");
            },
            "cache-refusal",
          );
        expect(await restore()).toBe("installer allowed");
        expect(await restore()).toBe("installer allowed");
        expect(
          h.native.scopeCalls.filter((call) => call.mode.startsWith("archive-") || call.mode === "launch"),
        ).toEqual([]);
        const events = h.native.logs
          .filter((line) => line.startsWith("[resident-deploy-admission] "))
          .map((line) => JSON.parse(line.slice("[resident-deploy-admission] ".length)))
          .filter((event) => event.event === "native.opaque.not-started");
        expect(events).toMatchObject([
          { phase: "archive-preflight", outcome: "not-started", commit: "not-admitted", reason: "verified-no-start" },
          { phase: "archive-preflight", outcome: "not-started", commit: "not-admitted" },
        ]);
        expect(await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).toEqual(new Map());
      }
    },
  );

  it("reports bounded preflight refusal details without claiming a durable settlement", async () => {
    const h = workloadResident();
    const f = archiveFixture(h, "error");
    await expect(f.restore()).rejects.toThrow("storage read failed");
    const events = h.native.logs
      .filter((line) => line.startsWith("[resident-deploy-admission] "))
      .map((line) => JSON.parse(line.slice("[resident-deploy-admission] ".length)));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "native.opaque.not-started",
        commit: "not-admitted",
        errorName: "Error",
        errorMessage: "storage read failed token=«redacted»",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("fixture-secret");
    expect(await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).toEqual(new Map());
  });

  it("preserves the original preflight refusal when its log sink fails", async () => {
    const h = workloadResident();
    const f = archiveFixture(h, "metadata");
    h.native.failLog = true;
    await expect(f.restore()).rejects.toBeInstanceOf(BackupNotFoundError);
    expect(await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).toEqual(new Map());
  });

  it("retains the original archive cleanup receipt before ending the operator", async () => {
    const h = workloadResident();
    const f = archiveFixture(h);
    h.native.archiveLostRun = true;
    await expect(f.restore()).resolves.toBeUndefined();
    expect(h.native.scopeCalls.filter((call) => call.mode.startsWith("archive-")).map((call) => call.mode)).toEqual([
      "archive-prepare",
      "archive-append",
      "archive-run",
      "archive-read",
    ]);
    expect(await new NativeOperationJournal(h.instance.ctx.storage).unresolved()).toEqual(new Map());
    const archived = [...h.rows.values()].filter((value: any) => value?.original?.native?.restoreReceipts) as any[];
    expect(archived).toHaveLength(1);
    expect(Object.values(archived[0].original.native.restoreReceipts)).toMatchObject([
      {
        receipt: {
          identity: { backupId: f.backup.id, target: "/workspace/mirror" },
          outcome: "committed",
          cleanup: "complete",
        },
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

  it("keeps an uncertain install and its producer held without replay or cleanup by name", async () => {
    const h = workloadResident();
    const f = archiveFixture(h);
    h.native.archiveRunUnknown = true;
    await expect(f.restore()).rejects.toThrow("original archive result or cleanup is unconfirmed");
    await expect(f.restore()).rejects.toThrow("background producer has an original active or unknown operation");
    expect(h.native.scopeCalls.filter((call) => call.mode === "archive-run")).toHaveLength(1);
    expect(h.native.scopeCalls.filter((call) => call.mode === "kill-attempt")).toHaveLength(1);
    const rows = (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations;
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0]!.journal!.pending)).toMatchObject([
      { kind: "opaque", restore: { backupId: f.backup.id, target: "/workspace/mirror" } },
    ]);
  });
});

describe("native process identity collection", () => {
  const execute = (h: ReturnType<typeof workloadResident>) =>
    h.instance.legacyOperator("op:identity-test", () =>
      Object.getPrototypeOf(h.instance).run.call(h.instance, ["/bin/echo", "fixture"]),
    );
  it("retains the full original identity before unrelated memo cleanup can fail", async () => {
    const h = workloadResident();
    h.instance.clearRuntimeUnreachable = async () => {
      throw new Error("memo cleanup unavailable");
    };
    await expect(execute(h)).rejects.toThrow("memo cleanup unavailable");
    const rows = (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations;
    expect(rows).toMatchObject([{ recoverable: true, journal: { closed: true } }]);
    expect(Object.values(rows[0]!.journal!.pending).map((attempt) => attempt.process)).toEqual([
      { id: "original-process", pid: 42, startedAt: "2026-10-11T00:00:00.000Z" },
    ]);
  });
  it.each(["invalid_frame", "protocol_error"] as const)(
    "collects the same acknowledged handle after observational %s without replay",
    async (kind) => {
      const h = workloadResident();
      h.native.statusError = statusObservationFailure(kind);
      expect(await execute(h)).toEqual({
        stdout: "completed",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      });
      expect({
        exec: h.native.execCount,
        output: h.native.outputCount,
        holds: (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations.length,
      }).toEqual({ exec: 1, output: 1, holds: 0 });
      expect(h.native.logs.join("\n")).toContain("RPCTransportError");
      expect(h.native.logs.join("\n")).not.toContain("synthetic-private-status");
    },
  );
  it("keeps the missing identity held when the original collector also loses its result", async () => {
    const h = workloadResident();
    h.native.statusError = statusObservationFailure();
    h.native.loseOutput = true;
    await expect(execute(h)).rejects.toThrow("native output lost");
    expect((await new NativeOperationJournal(h.instance.ctx.storage).list()).operations).toMatchObject([
      { recoverable: false, recoveryReason: "original-native-evidence-unavailable", journal: { closed: true } },
    ]);
    expect({ exec: h.native.execCount, output: h.native.outputCount }).toEqual({ exec: 1, output: 1 });
  });
  it("does not reinterpret identity parsing or journal persistence failure as observation", async () => {
    for (const mode of ["shape", "store"] as const) {
      const h = workloadResident();
      if (mode === "shape") h.native.statusValue = { id: "malformed", pid: 0 };
      else {
        const put = h.instance.ctx.storage.put;
        h.instance.ctx.storage.put = async (key: string, value: any) => {
          if (value?.native && Object.values(value.native.pending).some((attempt: any) => attempt.process))
            throw statusObservationFailure();
          return put(key, value);
        };
      }
      await expect(execute(h)).rejects.toThrow();
      expect({
        exec: h.native.execCount,
        output: h.native.outputCount,
        holds: (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations.length,
      }).toEqual({ exec: 1, output: 0, holds: 1 });
    }
  });
  it("does not abandon collection when observation logging fails", async () => {
    const h = workloadResident();
    h.native.statusError = statusObservationFailure();
    h.native.failLog = true;
    expect(await execute(h)).toEqual({
      stdout: "completed",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    expect({
      exec: h.native.execCount,
      output: h.native.outputCount,
      holds: (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations.length,
    }).toEqual({ exec: 1, output: 1, holds: 0 });
  });
  it("rechecks the current authority before collecting after an observation failure", async () => {
    const h = workloadResident();
    h.native.statusError = statusObservationFailure();
    h.native.onStatus = () => {
      h.instance.assertThreadOperationAllowed = async () => {
        throw new Error("owner changed");
      };
    };
    await expect(execute(h)).rejects.toThrow("owner changed");
    expect({
      exec: h.native.execCount,
      output: h.native.outputCount,
      holds: (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations.length,
    }).toEqual({ exec: 1, output: 0, holds: 1 });
  });
  it("retains uncertain runtime and unclassified status faults without collecting or replay", async () => {
    for (const error of [
      new RPCTransportError({
        code: ErrorCode.RPC_TRANSPORT_ERROR,
        httpStatus: 500,
        timestamp: "2026-10-11T00:00:00.000Z",
        message: "peer lost",
        context: { kind: "peer_closed", originalMessage: "peer lost", errorName: "Error" },
      }),
      new Error("unclassified status fault"),
    ]) {
      const h = workloadResident();
      h.native.statusError = error;
      await expect(execute(h)).rejects.toThrow();
      expect({
        exec: h.native.execCount,
        output: h.native.outputCount,
        holds: (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations.length,
      }).toEqual({ exec: 1, output: 0, holds: 1 });
    }
  });
  it("refuses status failures carrying authentication or ownership denial", async () => {
    for (const cause of [{ status: 403 }, { code: "OWNER_MISMATCH" }, { code: "FENCE_MISMATCH" }]) {
      const h = workloadResident();
      h.native.statusError = statusObservationFailure();
      (h.native.statusError as Error & { cause: unknown }).cause = cause;
      await expect(execute(h)).rejects.toThrow();
      expect({
        exec: h.native.execCount,
        output: h.native.outputCount,
        holds: (await new NativeOperationJournal(h.instance.ctx.storage).list()).operations.length,
      }).toEqual({ exec: 1, output: 0, holds: 1 });
    }
  });
});

describe("resident launch acknowledgement recovery", () => {
  const key = "native-operation:op:ack-loss";
  const result = { stdout: "completed", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  const execute = (h: ReturnType<typeof workloadResident>) => {
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    return h.instance.legacyOperator("op:ack-loss", () => h.instance.run(["true"]));
  };
  function failTransaction(
    h: ReturnType<typeof workloadResident>,
    phase: "admission" | "identity",
    commit: boolean,
    readable = true,
    close = false,
  ) {
    const storage = h.instance.ctx.storage;
    const transaction = storage.transaction;
    const get = storage.get;
    let count = 0;
    let failed = false;
    storage.transaction = async (action: (rows: unknown) => Promise<unknown>) => {
      if (++count !== (phase === "admission" ? 2 : 3)) return transaction(action);
      if (commit) await transaction(action);
      if (close) h.instance.opOperationScope.getStore().active = false;
      failed = true;
      throw new Error("storage acknowledgement lost");
    };
    storage.get = async (rowKey: string) => {
      if (failed && !readable && rowKey === key) {
        failed = false;
        throw new Error("readback unavailable");
      }
      return get(rowKey);
    };
  }
  it.each(["admission", "identity"] as const)(
    "collects one original command after committed %s acknowledgement loss",
    async (phase) => {
      const h = workloadResident();
      h.rows.set("private-evidence", "private uncommitted work");
      failTransaction(h, phase, true);
      expect(await execute(h)).toEqual(result);
      expect(h.native.execCount).toBe(1);
      expect(h.native.outputCount).toBe(1);
      expect(await h.instance.getNativeOperations()).toEqual({ operations: [], cursor: null });
      expect(h.rows.get("private-evidence")).toBe("private uncommitted work");
    },
  );
  it("does not submit when admission rolls back or its committed readback is unavailable", async () => {
    for (const commit of [false, true]) {
      const h = workloadResident();
      failTransaction(h, "admission", commit, false);
      await expect(execute(h)).rejects.toThrow("readback unavailable");
      expect(h.native.execCount).toBe(0);
      const inventory = await h.instance.getNativeOperations();
      if (commit) {
        expect(inventory.operations).toMatchObject([
          {
            key,
            recoverable: false,
            recoveryReason: "original-native-evidence-unavailable",
            journal: { closed: true },
          },
        ]);
        expect(Object.values(inventory.operations[0].journal.pending)).toEqual([{ kind: "process" }]);
      } else expect(inventory).toEqual({ operations: [], cursor: null });
    }
    expect(await execute(workloadResident())).toEqual(result);
  });
  it("settles only a never-submitted admission when its scope closes during lost acknowledgement", async () => {
    const h = workloadResident();
    h.rows.set("native-operation:op:unrelated", { opOwner: "op:unrelated" });
    failTransaction(h, "admission", true, true, true);
    await expect(execute(h)).rejects.toThrow("operator command ended");
    expect(h.native.execCount).toBe(0);
    expect(h.rows.get(key)).toBeUndefined();
    expect(h.rows.get("native-operation:op:unrelated")).toEqual({ opOwner: "op:unrelated" });
    expect(await execute(workloadResident())).toEqual(result);
  });
  it("retains identity after committed write when readback and collection remain unacknowledged", async () => {
    const h = workloadResident();
    failTransaction(h, "identity", true, false);
    await expect(execute(h)).rejects.toThrow("readback unavailable");
    const inventory = await h.instance.getNativeOperations();
    expect(inventory.operations).toMatchObject([
      {
        key,
        recoverable: true,
        journal: { closed: true },
      },
    ]);
    expect(Object.values(inventory.operations[0].journal.pending)).toEqual([
      { kind: "process", process: { id: "original-process", pid: 42, startedAt: "2026-10-11T00:00:00.000Z" } },
    ]);
    const receipt = await h.instance.recoverNativeOperation(key, inventory.operations[0].recordHash);
    expect(receipt).toMatchObject({
      key,
      outcome: "native-ended",
      processes: [
        {
          id: "original-process",
          pid: 42,
          startedAt: "2026-10-11T00:00:00.000Z",
          state: "exited",
          endedAt: "2026-10-11T00:00:01.000Z",
          exit: { code: 0, timedOut: false },
        },
      ],
    });
    expect(h.native.execCount).toBe(1);
  });
  it("keeps a lost native launch acknowledgement unknown without replay", async () => {
    const h = workloadResident();
    h.native.launchError = new Error("original launch acknowledgement lost");
    await expect(execute(h)).rejects.toThrow("original launch acknowledgement lost");
    const inventory = await h.instance.getNativeOperations();
    expect(inventory.operations).toMatchObject([
      { key, recoverable: false, recoveryReason: "original-native-evidence-unavailable", journal: { closed: true } },
    ]);
    expect(Object.values(inventory.operations[0].journal.pending)).toEqual([{ kind: "process" }]);
    expect(await h.instance.recoverNativeOperation(key, inventory.operations[0].recordHash)).toEqual({
      error: "native-operation-recovery-refused: original-native-evidence-unavailable",
      status: 409,
    });
    expect(h.native.execCount).toBe(1);
    expect(await execute(workloadResident())).toEqual(result);
  });
});

describe("resident workload admission", () => {
  it("labels separate members and their admission refusals with the stored physical resident ID", async () => {
    const primary = workloadResident({ live: 1 });
    const secondary = workloadResident({ live: 16 });
    primary.rows.set("resource", "repo:acme/app");
    secondary.rows.set("resource", "repo:acme/app");
    secondary.rows.set("resident:instanceId", "resident-secondary");
    const reports = await Promise.all([
      primary.instance.getWorkloadAudit("repo:acme/app"),
      secondary.instance.getWorkloadAudit("repo:acme/app", "resident-secondary"),
    ]);
    expect(reports.map(({ resource, residentId, used }: any) => ({ resource, residentId, used }))).toEqual([
      { resource: "repo:acme/app", residentId: "repo:acme/app", used: 1 },
      { resource: "repo:acme/app", residentId: "resident-secondary", used: 16 },
    ]);
    expect(
      [primary, secondary].map((member) =>
        member.native.logs.map((line) => JSON.parse(line.slice(11))).find((event) => event.event === "workload-audit"),
      ),
    ).toMatchObject([
      { resource: "repo:acme/app", residentId: "repo:acme/app", used: 1 },
      { resource: "repo:acme/app", residentId: "resident-secondary", used: 16 },
    ]);
    expect(await secondary.instance.reserveWorkloadSlot("op:new")).toMatchObject({ reason: "workload-full" });
    const refusal = secondary.native.logs
      .map((line) => JSON.parse(line.slice(11)))
      .find((event) => event.event === "admission-refused");
    expect(refusal).toMatchObject({ resource: "repo:acme/app", residentId: "resident-secondary", used: 16 });
  });

  it("keeps workload evidence incomplete when the resident identity cannot be read", async () => {
    const h = workloadResident({ live: 1 });
    const get = h.instance.ctx.storage.get;
    h.instance.ctx.storage.get = async (key: string) => {
      if (key === "resident:instanceId") throw new Error("identity read unavailable");
      return get(key);
    };
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({
      resource: "repo:acme/app",
      residentId: "unknown",
      used: 1,
      complete: false,
      issues: ["resident-identity-unavailable"],
    });
  });

  it("does not label an uninitialized or mismatched secondary as the primary", async () => {
    const h = workloadResident();
    for (const stored of [undefined, "resident-other"]) {
      if (stored === undefined) h.rows.delete("resident:instanceId");
      else h.rows.set("resident:instanceId", stored);
      expect(await h.instance.getWorkloadAudit("repo:acme/app", "resident-secondary")).toMatchObject({
        resource: "repo:acme/app",
        residentId: "unknown",
        used: 0,
        complete: false,
        issues: ["resident-identity-unavailable"],
      });
    }
    h.rows.set("resident:instanceId", "resident-secondary");
    expect(await h.instance.getWorkloadAudit("repo:acme/app", "resident-secondary")).toMatchObject({
      resource: "repo:acme/app",
      residentId: "resident-secondary",
      used: 0,
      complete: true,
    });
  });

  it("refuses operation recovery while a request is active or its thread owner changed", async () => {
    const h = workloadResident({ retained: 1 });
    const journal = new NativeOperationJournal(h.instance.ctx.storage);
    const key = "native-operation:mcp:owner-0:run-0:original";
    await journal.open(key, { runId: "run-0", ownerGen: "generation", ownerFence: 1 }, "mcp:owner-0");
    const attempt = await journal.begin(key, "process");
    await journal.launched(key, attempt, { id: "original-process", pid: 42, startedAt: "2026-10-11T00:00:00.000Z" });
    await journal.close(key);
    const operation = (await h.instance.getNativeOperations()).operations[0];
    const before = structuredClone(h.rows.get(key));
    h.instance.opAdmissionsInFlight = 1;
    expect(await h.instance.recoverNativeOperation(key, operation.recordHash)).toEqual({
      error: "native-operation-recovery-refused: request-active",
      status: 409,
    });
    h.instance.opAdmissionsInFlight = 0;
    h.rows.set("fence:mcp:owner-0", { runId: "successor", ownerGen: "generation", ownerFence: 2 });
    expect(await h.instance.recoverNativeOperation(key, operation.recordHash)).toEqual({
      error: "native-operation-recovery-refused: record-or-owner-changed",
      status: 409,
    });
    expect(h.rows.get(key)).toEqual(before);
  });

  it("recovers a lost operator result without replaying its command", async () => {
    const { instance, rows, native } = workloadResident();
    instance.run = Object.getPrototypeOf(instance).run;
    native.loseOutput = true;
    await expect(instance.legacyOperator("op:lost", () => instance.run(["true"]))).rejects.toThrow(
      "native output lost",
    );
    rows.set("private-files", "unpublished bytes");
    rows.set("native-operation:op:legacy", { opOwner: "op:legacy" });
    const operation = (await instance.getNativeOperations()).operations.find(
      (row: { key: string }) => row.key === "native-operation:op:lost",
    );
    const result = await instance.recoverNativeOperation(operation.key, operation.recordHash);
    expect(result).toMatchObject({
      key: "native-operation:op:lost",
      outcome: "native-ended",
      processes: [{ id: "original-process", exit: { code: 0 } }],
    });
    expect(rows.get("private-files")).toBe("unpublished bytes");
    expect(rows.get("native-operation:op:legacy")).toEqual({ opOwner: "op:legacy" });
    expect(rows.has("native-operation:op:lost")).toBe(false);
    expect(rows.get("native-operation-receipt:native-operation:op:lost")).toMatchObject({
      receipt: result,
      original: { opOwner: "op:lost" },
    });
    expect(await instance.recoverNativeOperation(operation.key, operation.recordHash)).toEqual(result);
  });
  it("lists legacy native operations without inspecting a runtime", async () => {
    const { instance, rows } = workloadResident();
    rows.set("native-operation:op:unknown", { opOwner: "op:unknown" });
    instance.run = async () => {
      throw new Error("metadata must not inspect native processes");
    };
    const report = await instance.getNativeOperations();
    expect(report.operations).toEqual([
      expect.objectContaining({
        key: "native-operation:op:unknown",
        owner: { opOwner: "op:unknown" },
        recoverable: false,
        journal: null,
      }),
    ]);
    expect(rows.get("native-operation:op:unknown")).toEqual({ opOwner: "op:unknown" });
  });

  it("keeps background processes beyond the former roster visible to recovery", async () => {
    const { instance } = workloadResident();
    instance.run = async () => ({
      exitCode: 0,
      stdout: "1 root\n20 worker253\n21 2001\n22 2253\n",
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    expect(await instance.getResidentRecoveryProbe()).toEqual({ activeProcesses: 3 });
    instance.run = async () => ({ exitCode: 0, stdout: "20 worker-broken\n", stderr: "", timedOut: false });
    await expect(instance.getResidentRecoveryProbe()).rejects.toThrow("resident process identity is unverified");
  });

  it("reports work capacity independently of 250 retained terminal owners without touching the VM", async () => {
    const { instance, rows } = workloadResident({ retained: 250 });
    await instance.activeWorkloadOwners();
    let ownerReads = 0;
    instance.observeRunForEviction = async () => {
      ownerReads++;
      throw new Error("levels must not read the state Worker");
    };
    instance.run = async () => {
      throw new Error("levels must not touch the VM");
    };
    expect(await instance.residentLevels()).toMatchObject({ seat: { used: 0, total: 16, side: "below" } });
    expect(ownerReads).toBe(0);
    rows.set("native-operation:op:unknown", { opOwner: "op:unknown" });
    expect(await instance.residentLevels()).toMatchObject({ seat: { used: 1, total: 16, side: "below" } });
    rows.set("uid:state", null);
    expect(await instance.residentLevels()).toMatchObject({ seat: { used: 16, total: 16, side: "above" } });
  });

  it("audits the same unique owners as admission, with original native evidence and terminal trees excluded", async () => {
    const h = workloadResident({ live: 1, retained: 1, unknown: 1, processes: "root\nworker2\nworker2\n" });
    h.instance.workloadReservations.add("thread:mcp:owner-0");
    h.rows.set("resident:spentPoolUsers", [
      ...(h.rows.get("resident:spentPoolUsers") as { user: string; owner: string }[]),
      { user: "worker40", owner: "op:building" },
    ]);
    h.instance.opUsersInUse.set("worker40", "op:building");
    h.rows.set("native-operation:mcp:owner-0:run-0:call", {
      runId: "run-0",
      ownerGen: "generation",
      ownerFence: 1,
      native: {
        version: 1,
        closed: true,
        threadKey: "mcp:owner-0",
        pending: {
          launch: { kind: "process", process: { id: "original", pid: 42, startedAt: "2026-10-14T00:00:00Z" } },
        },
      },
    });
    h.rows.set("native-operation:op:old", { opOwner: "op:old", privateOptions: "fixture-private" });
    const original = (await h.instance.getNativeOperations()).operations.find((o: { key: string }) =>
      o.key.endsWith(":call"),
    );
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({
      schema: 1,
      resource: "repo:acme/app",
      residentId: "repo:acme/app",
      build: { commit: "test-build" },
      used: 4,
      workloadLimit: 16,
      complete: true,
      processes: "identities-only",
      consistency: "best-effort",
    });
    expect(report.owners.map((o: { key: string }) => o.key)).toEqual([
      "op:building",
      "op:old",
      "thread:mcp:owner-0",
      "thread:mcp:owner-2",
    ]);
    const live = report.owners.find((o: { key: string }) => o.key === "thread:mcp:owner-0");
    expect(live.sources.map((s: { kind: string }) => s.kind)).toEqual([
      "reservation",
      "binding",
      "native-operation",
      "process",
      "uid-allocation",
    ]);
    expect(report.uidHistory).toEqual({ issued: 4, complete: true });
    expect(live.sources.find((s: { kind: string }) => s.kind === "native-operation")).toMatchObject({
      key: original.key,
      recordHash: original.recordHash,
      runId: "run-0",
      ownerGen: "generation",
      ownerFence: 1,
      processes: [{ id: "original", pid: 42, startedAt: "2026-10-14T00:00:00Z" }],
    });
    expect(report.owners.find((o: { key: string }) => o.key === "thread:mcp:owner-2").sources[0]).toMatchObject({
      kind: "binding",
      state: "unknown",
      reason: "owner-unverified",
      user: "worker4",
    });
    expect(JSON.stringify(report)).not.toContain("fixture-private");
    expect(await h.instance.reserveWorkloadSlot("op:next")).toBeNull();
  });

  it("keeps an incomplete process or UID observation explicitly unverified without clearing holds", async () => {
    const h = workloadResident({ live: 1, probeFails: true });
    h.rows.set("native-operation:op:unknown", { opOwner: "op:unknown" });
    const original = structuredClone(h.rows.get("native-operation:op:unknown"));
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({
      used: null,
      complete: false,
      processes: "unavailable",
      issues: ["workload-observation-unavailable"],
    });
    expect(h.rows.get("native-operation:op:unknown")).toEqual(original);
    expect(await h.instance.reserveWorkloadSlot("op:new")).toMatchObject({
      reason: "workload-unverified",
      status: 503,
    });
    const refusal = JSON.parse(
      h.native.logs
        .find((line) => line.startsWith("[workload] ") && JSON.parse(line.slice(11)).event === "admission-refused")!
        .slice(11),
    );
    expect(refusal).toMatchObject({
      event: "admission-refused",
      requestedOwner: "op:new",
      reason: "workload-unverified",
      used: null,
      complete: false,
      processes: "unavailable",
      issues: ["workload-observation-unavailable"],
    });
    h.rows.set("uid:state", null);
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({ used: null, complete: false });
  });

  it("an early audit failure warns without exception payload and a failed warning cannot replace partial evidence", async () => {
    const h = workloadResident();
    const held = { opOwner: "op:held" };
    const counter = { count: 2, firstAt: "1970-01-01T00:00:00.000Z", lastAt: "1970-01-01T00:00:01.000Z" };
    h.instance.workloadReservations.add("op:held");
    h.rows.set("native-operation:op:held", held);
    h.rows.set("resident:runtimeUnreachable", counter);
    h.rows.set("uid:state", null);
    const expected = {
      used: null,
      complete: false,
      issues: ["workload-observation-unavailable"],
      owners: [{ key: "op:held", sources: [{ kind: "reservation" }] }],
    };
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject(expected);
    expect(h.native.logs.map((line) => JSON.parse(line.slice(11)))).toEqual([
      { event: "workload-observation-unavailable", resource: "repo:acme/app", errorType: "Error" },
    ]);
    h.native.failWarnLog = true;
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject(expected);
    expect(h.rows.get("native-operation:op:held")).toEqual({ opOwner: "op:held" });
    expect(h.rows.get("resident:runtimeUnreachable")).toEqual(counter);
  });

  it("logs one bounded successful audit summary and a failed log leaves its report and original obligations unchanged", async () => {
    const h = workloadResident({ live: 1 });
    const held = { opOwner: "op:held" };
    const counter = { count: 2, firstAt: "1970-01-01T00:00:00.000Z", lastAt: "1970-01-01T00:00:01.000Z" };
    h.rows.set("native-operation:op:held", held);
    h.rows.set("resident:runtimeUnreachable", counter);
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({
      used: 2,
      complete: true,
      owners: [{ key: "op:held" }, { key: "thread:mcp:owner-0" }],
    });
    expect(h.native.logs.map((line) => JSON.parse(line.slice(11)))).toEqual([
      {
        event: "workload-audit",
        resource: "repo:acme/app",
        residentId: "repo:acme/app",
        asOf: "1970-01-01T02:46:40.000Z",
        finishedAt: "1970-01-01T02:46:40.000Z",
        used: 2,
        complete: true,
        ownersOmitted: 0,
        issues: [],
      },
    ]);
    h.native.failLog = true;
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toEqual(report);
    expect(h.rows.get("native-operation:op:held")).toEqual({ opOwner: "op:held" });
    expect(h.rows.get("resident:runtimeUnreachable")).toEqual(counter);
  });

  it("bounds audit output and records the original full-capacity contributors without admitting work", async () => {
    const h = workloadResident({ live: 16 });
    expect(await h.instance.reserveWorkloadSlot("op:new")).toMatchObject({ reason: "workload-full", status: 503 });
    const refusal = JSON.parse(
      h.native.logs
        .find((line) => line.startsWith("[workload] ") && JSON.parse(line.slice(11)).event === "admission-refused")!
        .slice(11),
    );
    expect(refusal).toMatchObject({
      schema: 1,
      event: "admission-refused",
      reason: "workload-full",
      used: 16,
      complete: true,
      processes: "identities-only",
    });
    expect(refusal.owners.map((o: { key: string }) => o.key)).toContain("thread:mcp:owner-15");
    for (let i = 0; i < 140; i++) h.rows.set(`native-operation:op:${i}`, { opOwner: `op:extra-${i}` });
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({ used: 156, complete: false, ownersOmitted: 28 });
    expect(report.owners).toHaveLength(128);
  });

  it("bounds both audit and original refusal JSON bytes while retaining all sixteen compact owner identities", async () => {
    const h = workloadResident();
    for (let i = 0; i < 16; i++)
      h.rows.set(`native-operation:mcp:large-${i}:run-${i}:call`, {
        runId: `run-${i}`,
        ownerGen: "generation",
        ownerFence: 1,
        native: {
          version: 1,
          closed: true,
          threadKey: `mcp:large-${i}`,
          pending: Object.fromEntries(
            Array.from({ length: 64 }, (_, j) => [
              `attempt-${j}`,
              { kind: "process", process: { id: "x".repeat(256), pid: j + 1, startedAt: "2026-10-14T00:00:00Z" } },
            ]),
          ),
        },
      });
    const original = structuredClone([...h.rows].filter(([key]) => key.startsWith("native-operation:")));
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({ used: 16, complete: false, ownersOmitted: 0 });
    expect(report.owners).toHaveLength(16);
    expect(report.detailsOmitted).toBeGreaterThan(0);
    expect(report.issues).toContain("workload-details-omitted");
    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(60 * 1024);
    expect(
      report.owners.every(
        (row: { sources: { kind: string }[] }) => row.sources.length > 0 && row.sources[0].kind === "native-operation",
      ),
    ).toBe(true);
    expect(await h.instance.reserveWorkloadSlot("op:new")).toMatchObject({ reason: "workload-full", status: 503 });
    const line = h.native.logs.find(
      (entry) => entry.startsWith("[workload] ") && JSON.parse(entry.slice(11)).event === "admission-refused",
    )!;
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(64 * 1024);
    const refusal = JSON.parse(line.slice(11));
    expect(refusal).toMatchObject({ event: "admission-refused", used: 16, complete: false, ownersOmitted: 0 });
    expect(refusal.owners).toHaveLength(16);
    expect(refusal.issues).toContain("workload-details-omitted");
    expect([...h.rows].filter(([key]) => key.startsWith("native-operation:"))).toEqual(original);
    for (let i = 0; i < 20; i++) h.rows.set(`native-operation:${String(i).padStart(2, "0")}:${"x".repeat(4000)}`, {});
    const oversizedKeys = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(oversizedKeys).toMatchObject({ used: 36, complete: false });
    expect(oversizedKeys.ownersOmitted).toBeGreaterThan(0);
    expect(oversizedKeys.owners.length + oversizedKeys.ownersOmitted).toBe(36);
    expect(new TextEncoder().encode(JSON.stringify(oversizedKeys)).byteLength).toBeLessThanOrEqual(60 * 1024);
  });

  it("an incomplete observation lists only the counter's captured members, excluding retained terminal bindings", async () => {
    const h = workloadResident({ live: 1, retained: 1, probeFails: true });
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({ used: null, complete: false, processes: "unavailable" });
    expect(report.owners.map((row: { key: string }) => row.key)).toEqual(["thread:mcp:owner-0"]);
    expect(await h.instance.reserveWorkloadSlot("op:new")).toMatchObject({
      reason: "workload-unverified",
      status: 503,
    });
    const refusal = JSON.parse(
      h.native.logs
        .find((line) => line.startsWith("[workload] ") && JSON.parse(line.slice(11)).event === "admission-refused")!
        .slice(11),
    );
    expect(refusal).toMatchObject({ used: null, complete: false });
    expect(refusal.owners.map((row: { key: string }) => row.key)).toEqual(["thread:mcp:owner-0"]);
  });

  it("reads an inactive resident without creating a native runtime", async () => {
    const h = workloadResident({ retained: 1 });
    h.instance.isRuntimeActive = async () => false;
    h.instance.run = async () => {
      throw new Error("audit must not start an inactive runtime");
    };
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({
      used: 0,
      complete: true,
      processes: "runtime-inactive",
      owners: [],
    });
  });

  it("joins a held native owner's recorded UID without turning retained history into workloads", async () => {
    const h = workloadResident({ retained: 2 });
    h.rows.set("native-operation:mcp:owner-0:run-0:legacy", { runId: "run-0", ownerGen: "generation", ownerFence: 1 });
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({
      used: 1,
      uidHistory: { issued: 2, complete: true },
      complete: true,
      owners: [{ key: "thread:mcp:owner-0" }],
    });
    expect(report.owners[0].sources).toContainEqual({
      kind: "uid-allocation",
      user: "worker2",
      reason: "recorded-owner",
    });
    h.rows.set("claim:worker2", ["mcp:owner-0", "mcp:foreign"]);
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({
      used: 1,
      complete: true,
      issues: ["uid-claims-unverified"],
    });
    expect(await h.instance.reserveWorkloadSlot("op:new")).toBeNull();
  });

  it("a failed diagnostic sink leaves the full-workload refusal and held owners unchanged", async () => {
    const h = workloadResident({ live: 16 });
    h.native.failLog = true;
    h.native.failWarnLog = false;
    expect(await h.instance.reserveWorkloadSlot("op:new")).toMatchObject({ reason: "workload-full", status: 503 });
    expect(h.native.logs.map((line) => JSON.parse(line.slice(11)))).toEqual([
      {
        event: "refusal-diagnostics-unavailable",
        reason: "workload-full",
        requestedOwner: "op:new",
        errorType: "Error",
      },
    ]);
    h.native.failWarnLog = true;
    expect(await h.instance.reserveWorkloadSlot("op:other")).toMatchObject({ reason: "workload-full", status: 503 });
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({ used: 16, complete: true });
  });

  it.each(["success", "output-failure", "nonzero", "timedout", "truncated", "stderr", "invalid"])(
    "manual audit preserves the durable recovery counter through a real runner %s",
    async (boundary) => {
      const h = workloadResident();
      h.instance.run = Object.getPrototypeOf(h.instance).run;
      h.instance.clearRuntimeUnreachable = Object.getPrototypeOf(h.instance).clearRuntimeUnreachable;
      const prior = { count: 2, firstAt: "1970-01-01T00:00:00.000Z", lastAt: "1970-01-01T00:00:01.000Z" };
      h.rows.set("resident:runtimeUnreachable", prior);
      h.native.output = {
        stdout: boundary === "invalid" ? "worker!invalid\n" : "root\nworker1\n",
        stderr: boundary === "stderr" ? "fixture-warning" : "",
        exitCode: boundary === "nonzero" ? 1 : 0,
        timedOut: boundary === "timedout",
        truncated: boundary === "truncated",
      };
      h.native.loseOutput = boundary === "output-failure";
      expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({
        used: boundary === "success" ? 0 : null,
        complete: boundary === "success",
      });
      expect(h.rows.get("resident:runtimeUnreachable")).toEqual(prior);
      expect(runtimeUnreachableRung((h.rows.get("resident:runtimeUnreachable") as { count: number }).count)).toBe(
        "re-arm",
      );
    },
  );

  it("manual unreachable observation preserves count two so the next ordinary failure uses the stop rung", async () => {
    const h = workloadResident();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.clearRuntimeUnreachable = Object.getPrototypeOf(h.instance).clearRuntimeUnreachable;
    const prior = { count: 2, firstAt: "1970-01-01T00:00:00.000Z", lastAt: "1970-01-01T00:00:01.000Z" };
    h.rows.set("resident:runtimeUnreachable", prior);
    h.native.launchError = Object.assign(new Error("fixture-connect-failed"), { name: "AbortError" });
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({ used: null, complete: false });
    expect(h.rows.get("resident:runtimeUnreachable")).toEqual(prior);
    expect(runtimeUnreachableRung((h.rows.get("resident:runtimeUnreachable") as { count: number }).count)).toBe(
      "re-arm",
    );
    const failure = await h.instance.run(["true"]).catch((error: { count: number; name: string }) => error);
    expect(failure).toMatchObject({ name: "RuntimeUnreachableError", count: 3 });
    expect(runtimeUnreachableRung(failure.count)).toBe("stop");
    h.native.launchError = undefined;
    h.native.output = { stdout: "root\nworker1\n", stderr: "", exitCode: 0, timedOut: false };
    expect([...(await h.instance.activeWorkloadOwners())]).toEqual([]);
    expect(h.rows.get("resident:runtimeUnreachable")).toBeUndefined();
  });

  it("ordinary admission and maintenance retain their original unreachable accounting after an audit", async () => {
    const h = workloadResident();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.clearRuntimeUnreachable = Object.getPrototypeOf(h.instance).clearRuntimeUnreachable;
    h.rows.set("resident:runtimeUnreachable", {
      count: 2,
      firstAt: "1970-01-01T00:00:00.000Z",
      lastAt: "1970-01-01T00:00:01.000Z",
    });
    h.native.launchError = Object.assign(new Error("fixture-connect-failed"), { name: "AbortError" });
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({ used: null, complete: false });
    expect(await h.instance.reserveWorkloadSlot("op:new")).toMatchObject({
      reason: "workload-unverified",
      status: 503,
    });
    expect(h.rows.get("resident:runtimeUnreachable")).toMatchObject({ count: 3 });
    expect(runtimeUnreachableRung((h.rows.get("resident:runtimeUnreachable") as { count: number }).count)).toBe("stop");
    const maintenance = await h.instance.activeWorkloadOwners().catch((error: { count: number }) => error);
    expect(maintenance).toMatchObject({ name: "RuntimeUnreachableError", count: 4 });
    expect(runtimeUnreachableRung(maintenance.count)).toBe("recreate");
  });

  it.each([
    "other-spawn",
    "control-reset",
    "runtime-busy",
    "cleanup",
    "destroy-unconfirmed",
    "inactive",
    "earlier-capture",
    "enrichment",
  ])("manual audit preserves recovery accounting at the %s boundary", async (boundary) => {
    const h = workloadResident();
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.instance.clearRuntimeUnreachable = Object.getPrototypeOf(h.instance).clearRuntimeUnreachable;
    const prior = { count: 2, firstAt: "1970-01-01T00:00:00.000Z", lastAt: "1970-01-01T00:00:01.000Z" };
    h.rows.set("resident:runtimeUnreachable", prior);
    h.native.output = { stdout: "root\nworker1\n", stderr: "", exitCode: 0, timedOut: false };
    if (boundary === "other-spawn") h.native.launchError = new Error("fixture-permission-failure");
    if (boundary === "control-reset") h.native.launchError = new Error("fixture-control-reset");
    if (boundary === "runtime-busy") h.native.launchError = new Error("fixture-runtime-busy");
    if (boundary === "cleanup") h.rows.set("cleanup", { pending: true });
    if (boundary === "destroy-unconfirmed") h.rows.set("destroy-unconfirmed", true);
    if (boundary === "inactive") h.instance.isRuntimeActive = async () => false;
    if (boundary === "earlier-capture") h.rows.set("uid:state", null);
    if (boundary === "enrichment")
      h.instance.currentUidLedger = async () => {
        throw new Error("fixture-ledger-unavailable");
      };
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({
      used: ["inactive", "enrichment"].includes(boundary) ? 0 : null,
      complete: boundary === "inactive",
    });
    expect(h.rows.get("resident:runtimeUnreachable")).toEqual(prior);
  });

  it("does not carry a cached terminal result into a newer owner fence", async () => {
    const { instance, rows } = workloadResident({ retained: 1 });
    await instance.activeWorkloadOwners();
    rows.set("run:mcp:owner-0", { threadKey: "mcp:owner-0", runId: "new-run", ownerGen: "new-gen", ownerFence: 2 });
    rows.set("fence:mcp:owner-0", { runId: "new-run", ownerGen: "new-gen", ownerFence: 2 });
    instance.observeRunForEviction = async () => {
      throw new Error("levels must not read the state Worker");
    };
    expect(await instance.residentLevels()).toMatchObject({ seat: { used: 1, total: 16, side: "below" } });
  });

  it("a delayed old owner observation cannot overwrite the current workload hint", async () => {
    const h = workloadResident({ retained: 1 });
    const old = { threadKey: "mcp:owner-0", runId: "run-0", ownerGen: "generation", ownerFence: 1 };
    const next = { ...old, runId: "run-new", ownerFence: 2 };
    const currentHint = {
      runId: next.runId,
      ownerGen: next.ownerGen,
      ownerFence: next.ownerFence,
      observation: { kind: "acknowledged", owner: next, revision: 5 },
    };
    h.onOwnerRead(async () => {
      h.rows.set("run:mcp:owner-0", next);
      h.rows.set("fence:mcp:owner-0", next);
      h.rows.set("resident:workloadOwner:mcp:owner-0", currentHint);
    });
    expect(await h.instance.observeRunForEviction(old)).toMatchObject({ kind: "terminal", record: { id: "run-0" } });
    expect(h.rows.get("resident:workloadOwner:mcp:owner-0")).toEqual(currentHint);
    expect(await h.instance.residentLevels()).toMatchObject({ seat: { used: 0, total: 16 } });
  });

  it("does not attribute a foreign or moved-fence canonical response to the held native owner", async () => {
    const h = workloadResident({ retained: 1 });
    const owner = { runId: "run-0", ownerGen: "generation", ownerFence: 1 };
    h.rows.set("native-operation:mcp:owner-0:run-0:call", owner);
    for (const response of [
      { kind: "terminal", record: { id: "foreign", threadKey: "mcp:owner-0", status: "completed" } },
      { kind: "acknowledged", owner: { ...owner, ownerFence: 2 }, revision: 1 },
      { kind: "live", row: { ...owner, threadKey: "mcp:owner-0", binding: { ownerGen: "generation", ownerFence: 2 } } },
      {
        kind: "terminal",
        record: { id: "run-0", threadKey: "mcp:owner-0", status: "completed" },
        settlement: { owner: { ...owner, ownerFence: 2 } },
      },
    ]) {
      h.owners.set("run-0", response);
      const report = await h.instance.getWorkloadAudit("repo:acme/app");
      expect(report).toMatchObject({ used: 1, complete: true });
      expect(report.owners[0].sources.find((s: { kind: string }) => s.kind === "native-operation")).toMatchObject({
        canonicalKind: "unknown",
        runId: "run-0",
        ownerFence: 1,
      });
    }
    h.owners.set("run-0", { kind: "acknowledged", owner, revision: 4 });
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report.owners[0].sources.find((s: { kind: string }) => s.kind === "native-operation")).toMatchObject({
      canonicalKind: "acknowledged",
      canonicalRevision: 4,
    });
  });

  it("a delayed diagnostic owner read does not block new admission or rescan the captured count", async () => {
    const h = workloadResident();
    h.rows.set("native-operation:mcp:old:old-run:call", { runId: "old-run", ownerGen: "old-gen", ownerFence: 1 });
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.onOwnerRead(async () => {
      entered();
      await blocked;
    });
    const audit = h.instance.getWorkloadAudit("repo:acme/app");
    await reading;
    let result: unknown = "pending";
    const admission = h.instance.reserveWorkloadSlot("op:new").then((response: unknown) => {
      result = response;
    });
    try {
      await vi.waitFor(() => expect(result).toBeNull(), { timeout: 250 });
    } finally {
      release();
      await admission;
    }
    expect(await audit).toMatchObject({ used: 1, complete: true, owners: [{ key: "thread:mcp:old" }] });
    expect([...(await h.instance.activeWorkloadOwners())]).toEqual(["op:new", "thread:mcp:old"]);
  });

  it("fresh native owner reads are deduplicated and bounded to the returned contributor projection", async () => {
    const h = workloadResident();
    const reads: string[] = [];
    h.onOwnerRead(async (runId) => {
      reads.push(runId);
    });
    h.rows.set("native-operation:mcp:old:run-old:first", { runId: "run-old", ownerGen: "old-gen", ownerFence: 1 });
    h.rows.set("native-operation:mcp:old:run-old:second", { runId: "run-old", ownerGen: "old-gen", ownerFence: 1 });
    expect(await h.instance.getWorkloadAudit("repo:acme/app")).toMatchObject({
      used: 1,
      complete: true,
      owners: [{ key: "thread:mcp:old", sources: [{ canonicalKind: "unknown" }, { canonicalKind: "unknown" }] }],
    });
    expect(reads).toEqual(["run-old"]);
    for (let i = 0; i < 140; i++)
      h.rows.set(`native-operation:mcp:extra-${i}:run-${i}:call`, {
        runId: `run-${i}`,
        ownerGen: "generation",
        ownerFence: 1,
      });
    reads.length = 0;
    const report = await h.instance.getWorkloadAudit("repo:acme/app");
    expect(report).toMatchObject({ used: 141, ownersOmitted: 13, complete: false });
    expect(report.owners).toHaveLength(128);
    expect(reads).toHaveLength(128);
  });

  it("creates fresh identities for 252 completed operations through the native admission boundary", async () => {
    const { instance, rows, native, lifecycle } = workloadResident();
    instance.reserveSafePoolUser = Object.getPrototypeOf(instance).reserveSafePoolUser;
    instance.run = Object.getPrototypeOf(instance).run;
    native.accountCommands = true;
    // The command-table stage is the external boundary here. Exercise real
    // request admission, allocation, native echo and completion on both sides.
    instance.runOpTraced = async () => {
      const user = await instance.allocateOpUser();
      if (typeof user !== "string") return user;
      instance.opUsersInUse.delete(user);
      return { ok: true, user };
    };
    for (let i = 0; i < 251; i++)
      expect(await instance.runOp("test", null)).toEqual({ ok: true, user: `worker${i + 34}` });
    expect(await instance.runOp("test", null)).toEqual({ ok: true, user: "worker285" });
    expect(await issuedUidCount(instance.ctx.storage)).toBe(252);
    expect([...(await instance.activeWorkloadOwners())]).toEqual([]);
    expect([...rows.keys()].filter((key) => key.startsWith("native-operation:"))).toEqual([]);
    expect(lifecycle).toEqual([]);
  });

  it("preserves an owner's old private directory instead of lending its UID", async () => {
    const { instance } = workloadResident();
    instance.reserveSafePoolUser = Object.getPrototypeOf(instance).reserveSafePoolUser;
    instance.poolUserHasOldThreadDir = async () => true;
    expect(await instance.reserveSafePoolUser("thread:mcp:old")).toMatchObject({
      status: 503,
      error: "pool-user-contaminated: workspace identity retains private files",
    });
    expect(await uidOwner(instance.ctx.storage, "worker34")).toBe("thread:mcp:old");
    instance.poolUserHasOldThreadDir = async () => false;
    expect(await instance.reserveSafePoolUser("thread:mcp:new")).toBe("worker35");
    expect(await uidOwner(instance.ctx.storage, "worker34")).toBe("thread:mcp:old");
  });

  it("serializes competing identity reservations without sharing an account", async () => {
    const { instance } = workloadResident();
    instance.reserveSafePoolUser = Object.getPrototypeOf(instance).reserveSafePoolUser;
    expect(
      await Promise.all([
        instance.reserveSafePoolUser("thread:mcp:first"),
        instance.reserveSafePoolUser("thread:mcp:second"),
      ]),
    ).toEqual(["worker34", "worker35"]);
    expect(await uidOwner(instance.ctx.storage, "worker34")).toBe("thread:mcp:first");
    expect(await uidOwner(instance.ctx.storage, "worker35")).toBe("thread:mcp:second");
  });

  it("keeps a failed account creation reserved and its unknown native outcome occupied", async () => {
    const { instance, rows, native } = workloadResident();
    instance.reserveSafePoolUser = Object.getPrototypeOf(instance).reserveSafePoolUser;
    instance.run = Object.getPrototypeOf(instance).run;
    native.accountCommands = true;
    native.loseOutput = true;
    const owner = "op:lost-account-result";
    expect(await instance.withOpNativeOperation(owner, () => instance.reserveSafePoolUser(owner))).toMatchObject({
      status: 503,
      reason: "workload-unverified",
    });
    expect(await uidOwner(instance.ctx.storage, "worker34")).toBe(owner);
    expect(rows.get(`native-operation-ending:native-operation:${owner}`)).toMatchObject({
      original: { opOwner: owner, native: { version: 1, closed: true } },
      receipt: { originalOperationOutcome: "unknown", purpose: "operator-scope-ending" },
    });
    native.loseOutput = false;
    expect(
      await instance.withOpNativeOperation("op:new-owner", () => instance.reserveSafePoolUser("op:new-owner")),
    ).toBe("worker35");
    expect(await uidOwner(instance.ctx.storage, "worker34")).toBe(owner);
  });

  it("refuses a new disposable operation at sixteen live owners despite unused UIDs", async () => {
    const { instance } = workloadResident({ live: 16 });
    expect(await instance.runOp("test", null)).toEqual({
      error: "resident workload is full (16/16 active owners)",
      trace: [],
      status: 503,
      reason: "workload-full",
      cause: "system",
    });
    expect([...instance.opUsersInUse]).toEqual([]);
  });

  it("admits work despite sixteen retained finished owners and their spent identities", async () => {
    const { instance } = workloadResident({ retained: 16 });
    expect(await instance.runOp("test", null)).toEqual({ ok: true, user: "worker18" });
    expect([...instance.opUsersInUse.values()]).toEqual([expect.stringMatching(/^op:/)]);
  });

  it("counts unknown owners, and processes remaining under finished owners", async () => {
    const unknown = workloadResident({ unknown: 16 });
    expect(await unknown.instance.reserveWorkloadSlot("thread:mcp:new")).toMatchObject({
      status: 503,
      reason: "workload-full",
    });
    const lingering = workloadResident({ retained: 16, processes: workloadPool.slice(0, 16).join("\n") + "\n" });
    expect(await lingering.instance.reserveWorkloadSlot("thread:mcp:new")).toMatchObject({
      status: 503,
      reason: "workload-full",
    });
  });

  it("allows admission below the limit when one owner lookup is unavailable, but refuses an unreadable UID ledger", async () => {
    const { instance, rows } = workloadResident({ unknown: 1 });
    expect(await instance.runOp("test", null)).toEqual({ ok: true, user: "worker18" });
    rows.set("uid:state", null);
    expect(await instance.reserveWorkloadSlot("thread:mcp:new")).toMatchObject({
      status: 503,
      reason: "workload-unverified",
    });
  });

  it("admits a fresh operator identity after 251 finished owners without resetting their VM", async () => {
    const { instance, rows, lifecycle } = workloadResident();
    rows.set(
      "resident:spentPoolUsers",
      Array.from({ length: 251 }, (_, i) => ({ user: `worker${i + 2}`, owner: `op:ended-${i}` })),
    );
    rows.set("snapshot", { mirrorBackupId: "mirror", checkoutBackupId: "checkout" });
    instance.reserveSafePoolUser = Object.getPrototypeOf(instance).reserveSafePoolUser;
    expect(await instance.runOp("test", null)).toEqual({ ok: true, user: "worker253" });
    expect(lifecycle).toEqual([]);
    expect(await uidOwner(instance.ctx.storage, "worker2")).toBe("op:ended-0");
    expect(await uidOwner(instance.ctx.storage, "worker253")).toMatch(/^op:/);
  });

  it("does not exclude a foreign native marker after the caller's own marker", async () => {
    const { instance, rows, lifecycle } = workloadResident();
    rows.set(
      "resident:spentPoolUsers",
      workloadPool.map((user, i) => ({ user, owner: `op:ended-${i}` })),
    );
    rows.set("snapshot", { mirrorBackupId: "mirror", checkoutBackupId: "checkout" });
    rows.set("native-operation:zz-foreign", { opOwner: "op:foreign" });
    instance.reserveSafePoolUser = Object.getPrototypeOf(instance).reserveSafePoolUser;
    expect(await instance.runOp("test", null)).toEqual({ ok: true, user: "worker34" });
    expect(await instance.activeWorkloadOwners()).toContain("op:foreign");
    expect(lifecycle).toEqual([]);
    expect(rows.get("native-operation:zz-foreign")).toEqual({ opOwner: "op:foreign" });
  });

  it("does not exclude the caller after UID allocation or an unobserved native result", async () => {
    const allocated = workloadResident();
    expect(
      await allocated.instance.withOpNativeOperation("op:allocated", async () => {
        expect(await allocated.instance.allocateOpUser()).toBe("worker18");
        return allocated.instance.registeredRunsBeyondOps();
      }),
    ).toBe(1);

    const pending = workloadResident();
    pending.instance.run = Object.getPrototypeOf(pending.instance).run;
    pending.native.loseOutput = true;
    expect(
      await pending.instance.withOpNativeOperation("op:pending", async () => {
        await expect(pending.instance.run(["true"])).rejects.toThrow("native output lost");
        return pending.instance.registeredRunsBeyondOps();
      }),
    ).toBe(1);
    expect(pending.rows.get("native-operation-ending:native-operation:op:pending")).toMatchObject({
      original: { opOwner: "op:pending", native: { closed: true } },
      receipt: { originalOperationOutcome: "unknown", purpose: "operator-scope-ending" },
    });
  });

  it("does not count the current unstarted request as a second owner for the final attachment slot", async () => {
    const h = workloadResident({ live: 15 });
    expect(
      await h.instance.withOpNativeOperation(
        "op:attach-slot",
        () => h.instance.reserveWorkloadSlot("thread:mcp:new"),
        "resident-call",
      ),
    ).toBeNull();
    expect([...h.instance.workloadReservations]).toEqual(["thread:mcp:new"]);
  });

  it.each(["foreign", "pending", "allocated", "bound"] as const)(
    "counts an operation with %s state during attachment admission",
    async (state) => {
      const h = workloadResident({ live: 15 });
      const result = await h.instance.withOpNativeOperation(
        "op:attach-slot",
        async () => {
          const scope = h.instance.opOperationScope.getStore();
          if (state === "foreign") {
            h.rows.set("native-operation:op:foreign", { opOwner: "op:foreign" });
          } else if (state === "allocated") {
            scope.allocated = true;
          } else {
            const journal = new NativeOperationJournal(h.instance.ctx.storage);
            if (state === "pending") await journal.begin(scope.key, "opaque");
            else
              await journal.bindScope(scope.key, {
                version: 1,
                kind: "operation",
                id: "33333333-3333-4333-8333-333333333333",
                boot: "11111111-1111-4111-8111-111111111111",
                owner: { opOwner: scope.owner },
              });
          }
          return h.instance.reserveWorkloadSlot("thread:mcp:new");
        },
        "resident-call",
      );
      expect(result).toMatchObject({ reason: "workload-full", status: 503 });
      expect([...h.instance.workloadReservations]).toEqual([]);
    },
  );

  it("counts host-wide lingering processes through the fixed inventory inside a request scope", async () => {
    const h = workloadResident({ retained: 16 });
    h.instance.run = Object.getPrototypeOf(h.instance).run;
    h.native.onLaunch = (value) => {
      h.native.output = {
        stdout:
          value.role === "inventory" && value.inventory === "users"
            ? Array.from({ length: 16 }, (_, i) => `worker${i + 2}`).join("\n") + "\n"
            : "root\nworker1\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
    };
    expect(
      await h.instance.withOpNativeOperation(
        "op:attach-inventory",
        () => h.instance.reserveWorkloadSlot("thread:mcp:new"),
        "resident-call",
      ),
    ).toMatchObject({ reason: "workload-full", status: 503 });
    expect([...h.instance.workloadReservations]).toEqual([]);
  });

  it("admits only one of two competing owners for the final slot", async () => {
    const { instance } = workloadResident({ live: 15 });
    expect(
      await Promise.all([
        instance.reserveWorkloadSlot("thread:mcp:first"),
        instance.reserveWorkloadSlot("thread:mcp:second"),
      ]),
    ).toEqual([
      null,
      {
        error: "resident workload is full (16/16 active owners)",
        status: 503,
        reason: "workload-full",
        cause: "system",
      },
    ]);
    expect([...instance.workloadReservations]).toEqual(["thread:mcp:first"]);
    expect(await instance.reserveWorkloadSlot("thread:mcp:owner-0")).toBeNull();
  });

  it("retains native operations across an isolate restart and deduplicates their owners", async () => {
    const { instance, rows } = workloadResident({ retained: 16 });
    for (let i = 0; i < 16; i++) {
      const owner = { runId: `run-${i}`, ownerGen: "generation", ownerFence: i + 1 };
      rows.set(`native-operation:mcp:owner-${i}:run-${i}:request-a`, owner);
      rows.set(`native-operation:mcp:owner-${i}:run-${i}:request-b`, owner);
    }
    expect(await instance.reserveWorkloadSlot("thread:mcp:new")).toMatchObject({
      status: 503,
      reason: "workload-full",
    });
    expect(await instance.reserveWorkloadSlot("thread:mcp:owner-0")).toBeNull();
  });

  it("keeps unresolved anonymous operations occupied after the in-memory map is lost", async () => {
    const { instance, rows } = workloadResident();
    for (let i = 0; i < 16; i++) rows.set(`native-operation:op:operation-${i}`, { opOwner: `op:operation-${i}` });
    expect(await instance.runOp("test", null)).toMatchObject({ status: 503, reason: "workload-full" });
    expect(await instance.reserveWorkloadSlot("op:operation-0")).toBeNull();
  });

  it("refuses an unreadable process probe without spending an identity", async () => {
    const { instance } = workloadResident({ probeFails: true });
    expect(await instance.runOp("test", null)).toEqual({
      error: "resident workload could not be verified",
      trace: [],
      status: 503,
      reason: "workload-unverified",
      cause: "system",
    });
    expect([...instance.workloadReservations]).toEqual([]);
  });

  it("releases an acknowledged operator command but keeps an unobserved native outcome", async () => {
    const { instance, rows, native } = workloadResident();
    instance.run = Object.getPrototypeOf(instance).run;
    expect(await instance.withOpNativeOperation("op:known", () => instance.run(["true"]))).toEqual({
      stdout: "completed",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    expect(rows.has("native-operation:op:known")).toBe(false);
    native.loseOutput = true;
    await expect(instance.withOpNativeOperation("op:unknown", () => instance.run(["true"]))).rejects.toThrow(
      "native output lost",
    );
    expect(rows.get("native-operation-ending:native-operation:op:unknown")).toMatchObject({
      original: { opOwner: "op:unknown", origin: { producer: "op-test" }, native: { scope: { kind: "operation" } } },
      receipt: { purpose: "operator-scope-ending", originalOperationOutcome: "unknown" },
    });
    native.loseOutput = false;
    expect([...(await instance.activeWorkloadOwners())]).toEqual([]);
  });
});
