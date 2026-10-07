import {
  isWorkspaceOwner,
  isAcknowledgedWorkspaceOwner,
  workspaceOwnerKey,
  workspaceBindingOf,
  workspaceSettlementOf,
} from "../../src/core/workspaceSettlement";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";
import { mayRunAsPoolUser, parsePoolBindings, spendPoolUser } from "../../src/execution/residentPoolSpends";
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
    const start = methodOf(registry, "setDeployFence")!;
    const activity = method("getResidentDeployInfo");
    const attach = method("attachThreadTraced");
    const route = source.slice(source.indexOf("async function handleDeployFence"));
    expect(start).toContain("swapFence: true");
    expect(start).toContain("deployFenceReady(fenced, now)");
    expect(route.indexOf("registry.setDeployFence(versionId)")).toBeLessThan(route.indexOf("getResidentDeployInfo()"));
    expect(route.indexOf("getResidentDeployInfo()")).toBeLessThan(route.indexOf("registry.verifyDeployFence("));
    expect(methodOf(registry, "verifyDeployFence")).toContain("deployFenceReady(current, now)");
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
    const verify = methodOf(registry, "verifyDeployFence")!;
    const route = source.slice(source.indexOf("async function handleDeployFence"));
    expect(begin).toContain("swapFence");
    expect(begin).toContain("DEPLOY_ADMISSION_KEY_PREFIX");
    expect(end).toContain("DEPLOY_ADMISSION_KEY_PREFIX");
    expect(verify).toContain("DEPLOY_ADMISSION_KEY_PREFIX");
    expect(route).toContain("registry.verifyDeployFence(fence.since, fence.until, versionId)");
    for (const name of ["attachThreadTraced", "detachThread", "runOpTraced", "withThreadBusy"]) {
      expect(method(name), `${name} must participate in the admission barrier`).toContain("withDeployAdmission");
    }
    expect(method("updateRunDeadline")).toContain("withDeployAdmission");
    expect(source).toContain('case "/onboard":\n            return await withFleetAdmission');
    expect(source).toContain('case "/offboard":\n            return await withFleetAdmission');
    expect(source).toContain('case "/rebuild":\n            return await withFleetAdmission');
    expect(methodOf(registry, "setDrain")).toContain("swapFence");
    expect(methodOf(registry, "clearDrain")).toContain("postUploadVersion(record, versionId, versionTimestamp)");
    expect(methodOf(registry, "clearDrain")).toContain("DEPLOY_ADMISSION_KEY_PREFIX");
    expect(source.slice(source.indexOf("async function handleReconcile"))).toContain("beginDeployReconcileAdmission");
  });

  it("admits scheduled refresh steps and watchdog lifecycle work before either can start after the quiet read", () => {
    const step = method("runInstanceStep");
    expect(step).toContain("beginDeployAdmission");
    expect(step).toContain("endDeployAdmission");
    expect(step.indexOf("beginDeployAdmission")).toBeLessThan(step.indexOf("refreshAdmissionsInFlight++"));
    expect(step.indexOf("endDeployAdmission")).toBeGreaterThan(step.indexOf("fn({ count })"));
    const watchdog = source.slice(source.indexOf("async function runWatchdog("), source.indexOf("function json("));
    expect(watchdog).toContain("beginDeployAdmission");
    expect(watchdog).toContain("endDeployAdmission");
    expect(watchdog.indexOf("beginDeployAdmission")).toBeLessThan(watchdog.indexOf("createRefreshInstance("));
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
    expect(reconcile).toContain("beginDeployReconcileAdmission");
    expect(reconcile.indexOf("beginDeployReconcileAdmission")).toBeLessThan(reconcile.indexOf("registry.list()"));
    expect(reconcile).toContain("endDeployAdmission");
    expect(methodOf(registry, "beginDeployReconcileAdmission")).toContain(
      "postUploadVersion(record, versionId, versionTimestamp)",
    );
    expect(methodOf(registry, "setDeployFence")).toContain("swapVersion");
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
    expect(handler).toContain("recoveryEvidenceUrl(evidence)");
    expect(handler.indexOf("registry.setDeployFence(versionId)")).toBeLessThan(
      handler.indexOf("getResidentRecoveryProbe()"),
    );
    expect(handler.indexOf("getResidentRecoveryProbe()")).toBeLessThan(handler.indexOf("recoveryViewsAreIdle(views)"));
    expect(handler.indexOf("recoveryViewsAreIdle(views)")).toBeLessThan(handler.indexOf("recoverDeployAdmission(id"));
    expect(handler).toContain("registry.clearDeployFence(fence.since, fence.until, versionId)");
    const recover = methodOf(registry, "recoverDeployAdmission")!;
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
    expect(reconcile).toContain("SPENT_POOL_USERS_KEY");
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
      expect(fixture.rows.get("spent")).toEqual([{ user: "worker2", owner: `thread:${fixture.threadKey}` }]);
      expect(fixture.rows.get(`runReg:${fixture.threadKey}`)).toMatchObject({ legacyRetainedAt: fixture.now });
      expect(fixture.privateBytes()).toBe("private uncommitted work");
      expect(fixture.checkedPaths).toContain(fixture.worktreePath);
    },
  );

  it("refuses a stored worktree path that is neither canonical nor a collision-safe replacement", async () => {
    const fixture = await ownerFlow("invalid");
    expect(await fixture.instance.reconcileRetainedOwner(fixture.threadKey)).toMatchObject({ status: 503 });
    expect(fixture.rows.get("spent")).toEqual([]);
    expect(fixture.checkedPaths).toEqual([]);
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
    expect(rows.get(`spent`)).toEqual([{ user: "worker2", owner: `thread:${threadKey}` }]);
  });

  it.each(["registration", "last-run-owner"] as const)(
    "keeps private bytes when a partial owner row meets legacy detach (%s)",
    async (place) => {
      const fixture = await ownerFlow("canonical");
      const { instance, rows, threadKey } = fixture;
      const registrationKey = `runReg:${threadKey}`;
      const bindingKey = `thread:${threadKey}`;
      rows.set("spent", [{ user: "worker2", owner: `thread:${threadKey}` }]);
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
    rows.set("spent", [{ user: "worker2", owner: `thread:${threadKey}` }]);
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
      /ctx\.stub\.detachThread\(\s*ctx\.threadKey,\s*body\.force === true,\s*pushed\.pushed,\s*runId,\s*ownerGen,\s*ownerFence,?\s*\)/,
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
  "reconcileRetainedOwner",
  "attachThreadTraced",
  "attachThreadBody",
  "allocateThreadUser",
  "claimRetainedThreadUser",
  "markPoolUserSpent",
  "poolUserOwnerMatches",
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
    async withDeployAdmission(fn: () => Promise<unknown>) { return fn(); }
    ${ownerMethods.map((name) => method(name)).join("\n")}
  }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type OwnerFlowInstance = {
  getInFlightCount(): Promise<number>;
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
      crypto: webcrypto,
      TextEncoder,
      THREADS_DIR: "/workspace/threads",
      MIRROR_DIR: "/workspace/mirror",
      THREAD_USERS: ["worker2", "worker3"],
      SPENT_POOL_USERS_KEY: "spent",
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
      registeredRunAllowsReattach: () => false,
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
    ["spent", []],
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
    opUsersInUse: new Map(),
    poolUsersInspecting: new Set(),
    workspaceExclusiveOpsInFlight: new Set(),
    recreateAdmission: { blocked: async () => false },
    ensureHydrated: async () => {},
    inFlightCount: () => 0,
    liveBindings: async () => [rows.get(`thread:${threadKey}`)],
    fleetDrain: async () => null,
    memoryGate: async () => null,
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
