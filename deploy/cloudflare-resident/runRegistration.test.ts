import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";
import {
  deployRegistrationState,
  registeredRunAllowsClaim,
  registeredRunAllowsReattach,
  registeredRunNeedsProtection,
  registeredRunOwnsRelease,
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
    expect(route.indexOf("registry.setDeployFence()")).toBeLessThan(route.indexOf("getResidentDeployInfo()"));
    expect(route.indexOf("getResidentDeployInfo()")).toBeLessThan(route.indexOf("registry.getDrain()"));
    expect(route).toContain("deployFenceReady(current, now)");
    expect(attach).toContain("drain.swapFence || !registered");
    expect(activity).toContain("this.runsInFlightCount()");
    expect(activity).toContain("this.threadOpsInFlight.get(binding.threadKey)");
    expect(activity).toContain("deployRegistrationState");
    expect(method("registeredRunsBeyondOps")).toContain("binding.lastRunOwner?.runId");
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

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("a run's registration is held from attach to release", () => {
  it("only the current run may release its workspace, including after its deadline", () => {
    expect(registeredRunOwnsRelease({ runId: "run-1", ownerGen: "gen-new" }, "run-1", "gen-old")).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-1", ownerGen: "gen-new" }, "run-1", "gen-new")).toBe(true);
    expect(registeredRunOwnsRelease({ runId: "run-2" }, "run-1")).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-2" }, undefined)).toBe(false);
    expect(registeredRunOwnsRelease({ runId: "run-1" }, "run-1")).toBe(true);
    expect(registeredRunOwnsRelease({ runId: undefined }, undefined)).toBe(true);
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
    expect(registeredRunAllowsReattach({ ...own, ownerGen: "gen-new" }, "run-1", now, grace, "gen-new")).toBe(true);
    const reclaimed = { ...own, ownerGen: "same-second-a", ownerFence: 7 };
    expect(registeredRunAllowsReattach(reclaimed, "run-1", now, grace, "same-second-b", 8)).toBe(true);
    expect(registeredRunAllowsReattach(reclaimed, "run-1", now, grace, "same-second-b", 6)).toBe(false);
    expect(registeredRunAllowsReattach(own, "run-1", now + grace, grace)).toBe(true);
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
    expect(registeredRunAllowsClaim({ runId: "run-1" }, "run-1", "same-second-b", 8)).toBe(true);
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

  it("a successful attach registers the run; a refused attach does not", () => {
    const attach = method("attachThreadTraced");
    expect(attach).toMatch(
      /if \(!\("error" in res\)\) await this\.registerRun\(threadKey, runBudgetMs, runId, ownerGen, ownerFence\);/,
    );
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
  it("registeredRunsBeyondOps retains durable owners beyond the execution deadline and bounds only legacy registrations", () => {
    const count = method("registeredRunsBeyondOps");
    expect(count).toMatch(/this\.ctx\.storage\.list<RunRegistration>\(\{ prefix: RUN_REG_KEY_PREFIX \}\)/);
    expect(count).toContain("registeredRunNeedsProtection(");
    expect(count).toContain("r?.runId");
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
