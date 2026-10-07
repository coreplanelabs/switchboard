import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import type { ClaimRequest } from "./types.js";
import type { RunRecord } from "../runRecord.js";
import { FRICTION_CATEGORIES } from "../runFriction.js";
import { createCheckExecution } from "../checkExecution.js";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunReport } from "./threadSession.js";
import { contextThreadSessionKey } from "./sessionLog.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { markdownOutput } from "../llmOutput/markdown.js";
import { getAgent } from "../../agents/registry.js";
import {
  workspaceAllocationOf,
  allocationMatchesRun,
  sameWorkspaceAllocation,
  originalColdAllocation,
  declaredOriginalColdAllocationOf,
  workspaceDurabilityArchiveOf,
  type WorkspaceAllocation,
} from "./workspaceDurability.js";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
export const allocation: WorkspaceAllocation = {
  version: 1,
  kind: "exclusive-scratch",
  runId: id,
  requester: "slack:fixture",
  threadKey: "mcp:fixture:original",
  repo: "fixture/repo",
  ref: "codex/fixture",
  headSha: "a".repeat(40),
  allocationKey: `review:${id}`,
  custody: "session-report",
};
function claim(): ClaimRequest {
  return {
    runId: id,
    threadKey: allocation.threadKey,
    gen: "g1",
    leaseMs: 1000,
    startedAt: 1,
    phase: "attaching",
    system: "",
    tools: [],
    meta: {
      channelId: "mcp:fixture",
      userId: allocation.requester,
      threadKey: allocation.threadKey,
      repo: allocation.repo,
      ref: allocation.ref,
      headSha: allocation.headSha,
      readonly: true,
      profile: { machine: "repo-resident", identity: "read", minutes: 25 },
      workspaceAllocation: structuredClone(allocation),
    },
  };
}

describe("declared original cold allocation", () => {
  function input() {
    const meta = { ...claim().meta, pr: 42 };
    return {
      runId: id,
      registered: structuredClone(getAgent("review")),
      identity: meta,
      target: { repo: allocation.repo!, ref: allocation.ref!, headSha: allocation.headSha!, pr: 42 },
    };
  }
  it("constructs versioned original purpose and exact PR target data independent of names", () => {
    const value = input(),
      result = originalColdAllocation(value);
    expect(result).toMatchObject({
      version: 2,
      kind: "exclusive-scratch",
      runId: id,
      requester: allocation.requester,
      threadKey: allocation.threadKey,
      pr: 42,
      policy: {
        version: 1,
        purpose: "pull-request-review",
        resident: "retained",
        cold: {
          kind: "exclusive-scratch",
          scope: "original-cold-allocation",
          custody: "session-report-and-review-publication",
        },
      },
    });
    expect(workspaceAllocationOf(result)).toEqual(result);
    expect(declaredOriginalColdAllocationOf(result)).toEqual(result);
    value.registered.name = "renamed-purpose";
    expect(originalColdAllocation(value)).toEqual(result);
    value.registered.resourceLifetime!.cold = "retained";
    expect(result!.policy.cold.scope).toBe("original-cold-allocation");
  });
  it("refuses missing unrelated contradictory policy and incomplete or mismatched gated target", () => {
    for (const agent of [
      getAgent("explore"),
      getAgent("coding"),
      { ...getAgent("review"), resourceLifetime: undefined },
    ]) {
      const value = input();
      value.registered = structuredClone(agent);
      expect(originalColdAllocation(value)).toBeUndefined();
    }
    for (const field of ["repo", "ref", "headSha", "pr"] as const) {
      const missing = input();
      delete (missing.identity as Record<string, unknown>)[field];
      expect(originalColdAllocation(missing)).toBeUndefined();
      const foreign = input();
      (foreign.target as Record<string, unknown>)[field] = field === "pr" ? 43 : "different";
      expect(originalColdAllocation(foreign)).toBeUndefined();
    }
    const zero = input();
    zero.target.pr = zero.identity.pr = 0;
    expect(originalColdAllocation(zero)).toBeUndefined();
    const unknown = input();
    unknown.registered.resourceLifetime = { version: 2, ephemeral: true } as never;
    expect(originalColdAllocation(unknown)).toBeUndefined();
  });
  it("reads legacy envelopes without eligibility or upgrade and refuses same-store late minting", async () => {
    expect(workspaceAllocationOf(allocation)).toEqual(allocation);
    expect(declaredOriginalColdAllocationOf(allocation)).toBeUndefined();
    expect(workspaceDurabilityArchiveOf({ version: 1, runId: id, startedAt: 1, allocation })?.allocation).toEqual(
      allocation,
    );
    const declared = originalColdAllocation(input())!;
    for (const prior of [allocation, undefined]) {
      const store = new InMemoryRunLedger(() => 2),
        req = claim();
      req.meta.pr = 42;
      if (!prior) delete req.meta.workspaceAllocation;
      await store.claim(req);
      await expect(
        store.claim({ ...req, phase: "live", meta: { ...req.meta, workspaceAllocation: declared } }),
      ).rejects.toThrow(/immutable|retrofitted/);
      expect(store.live.get(id)!.meta.workspaceAllocation).toEqual(prior);
    }
    const mutated = { ...declared, pr: 43 };
    expect(sameWorkspaceAllocation(declared, mutated)).toBe(false);
    expect(
      workspaceAllocationOf({ ...declared, policy: { ...declared.policy, resident: "exclusive-scratch" } }),
    ).toBeUndefined();
  });
});

describe("original workspace allocation", () => {
  it("acknowledges the canonical original allocation across keep refresh and promotion without exposing caller aliases", async () => {
    const store = new InMemoryRunLedger(() => 2),
      req = claim();
    const first = (await store.claim(req)) as unknown as {
      ok: boolean;
      allocationAck?: {
        version: number;
        runId: string;
        threadKey: string;
        gen: string;
        startedAt: number;
        allocation: WorkspaceAllocation | null;
      };
    };
    expect(first.allocationAck).toEqual({
      version: 1,
      runId: id,
      threadKey: allocation.threadKey,
      gen: "g1",
      startedAt: 1,
      allocation,
    });
    first.allocationAck!.allocation!.custody = "session-report-and-review-publication";
    req.meta.workspaceAllocation!.kind = "retained";
    const original = claim();
    delete original.meta.workspaceAllocation;
    for (const phase of ["attaching", "live", "live"] as const) {
      const reply = (await store.claim({ ...original, phase })) as unknown as { allocationAck?: unknown };
      expect(reply.allocationAck).toEqual({
        version: 1,
        runId: id,
        threadKey: allocation.threadKey,
        gen: "g1",
        startedAt: 1,
        allocation,
      });
      expect(store.live.get(id)!.meta.workspaceAllocation).toEqual(allocation);
    }
    const legacy = new InMemoryRunLedger(() => 2),
      missing = claim();
    delete missing.meta.workspaceAllocation;
    expect(await legacy.claim(missing)).toMatchObject({ ok: true, allocationAck: { allocation: null } });
  });
  it("validates explicit versioned identity without interpreting the agent label", () => {
    expect(workspaceAllocationOf(allocation)).toEqual(allocation);
    expect(allocationMatchesRun(allocation, id, claim().meta)).toBe(true);
    expect(workspaceAllocationOf({ ...allocation, version: 2 })).toBeUndefined();
    expect(workspaceAllocationOf({ ...allocation, ephemeral: true })).toBeUndefined();
    expect(allocationMatchesRun({ ...allocation, requester: "slack:foreign" }, id, claim().meta)).toBe(false);
    expect(sameWorkspaceAllocation(undefined, allocation)).toBe(false);
  });
  it("refuses replacement and late minting at promotion and preserves its original data", async () => {
    const store = new InMemoryRunLedger(() => 2);
    const req = claim();
    expect(await store.claim(req)).toMatchObject({ ok: true });
    req.meta.workspaceAllocation!.kind = "retained";
    expect(store.live.get(id)?.meta.workspaceAllocation).toEqual(allocation);
    const changed = claim();
    changed.phase = "live";
    changed.meta.workspaceAllocation = { ...allocation, kind: "retained" };
    await expect(store.claim(changed)).rejects.toThrow(/workspace allocation/i);
    const legacy = new InMemoryRunLedger(() => 2);
    const before = claim();
    delete before.meta.workspaceAllocation;
    await legacy.claim(before);
    await expect(legacy.claim({ ...claim(), phase: "live" })).rejects.toThrow(/workspace allocation/i);
  });
  it("retains first admission through abandonment and rejects a replacement contract", async () => {
    const store = new InMemoryRunLedger(() => 2);
    await store.claim(claim());
    expect(await store.abandon(id, "g1")).toEqual({ ok: true });
    const changed = claim();
    changed.meta.workspaceAllocation = { ...allocation, custody: "session-report-and-review-publication" };
    await expect(store.claim(changed)).rejects.toThrow(/workspace allocation/i);
  });
  it("preserves legacy absence through abandonment instead of minting a later contract", async () => {
    const store = new InMemoryRunLedger(() => 2);
    const legacy = claim();
    delete legacy.meta.workspaceAllocation;
    await store.claim(legacy);
    await store.abandon(id, "g1");
    await expect(store.claim(claim())).rejects.toThrow(/workspace allocation/i);
  });
});

async function closureFixture(over?: {
  missingSession?: boolean;
  pending?: boolean;
  missingBirth?: boolean;
  missingReport?: boolean;
  raw?: string;
  parent?: boolean;
  maintenance?: boolean;
}) {
  const store = new InMemoryRunLedger(() => 30);
  const req = claim();
  if (over?.parent || over?.maintenance) {
    Object.assign(req.meta, {
      parentInstanceId: "original-parent",
      coordinatorUnit: "unit",
      idempotencyKey: "original-parent:unit/0/review",
    });
    Object.assign(req.meta.workspaceAllocation!, {
      parentInstanceId: req.meta.parentInstanceId,
      coordinatorUnit: req.meta.coordinatorUnit,
      idempotencyKey: req.meta.idempotencyKey,
    });
    if (over?.maintenance) {
      req.meta.maintenanceActionId = `m_${"c".repeat(64)}`;
      req.meta.workspaceAllocation!.maintenanceActionId = req.meta.maintenanceActionId;
    }
  }
  req.phase = "live";
  const key = `${allocation.threadKey}:review`;
  req.meta.session = { key, seedFrom: 0, request: 0, range: { from: 0 } };
  await store.claim(req);
  await store.claimSession(key, id, "g1");
  const raw = over?.raw ?? "durable fixture report bytes";
  const parsed = markdownOutput.parse(raw);
  if (!parsed.ok) throw new Error("fixture output refused");
  const report = parsed.value;
  const events = [
    { type: "lease" as const, seq: 1, startedAt: 1, endsAt: 100, loopEndsAt: 90 },
    { type: "answer" as const, seq: 2, text: report },
  ];
  await store.append(id, "g1", events);
  if (!over?.missingSession)
    await store.step(
      id,
      "g1",
      { step: 0, seq: 2, turnIndex: 2, inFlight: [], inboxConsumedSeq: 0, remainingMs: 0, turn: 1, iteration: 1 },
      [
        { idx: 0, message: { role: "user", content: [{ type: "text", text: "fixture request" }] } },
        { idx: 1, message: { role: "assistant", content: [{ type: "text", text: raw }] } },
      ],
      key,
    );
  if (!over?.missingReport)
    await appendRunReport(
      store,
      {
        runId: id,
        threadKey: req.meta.threadKey,
        requester: req.meta.userId,
        channelId: req.meta.channelId,
        text: report,
        context: UNKNOWN_CONTEXT_DEPENDENCIES,
      },
      async () => null,
    );
  await store.setState(id, "g1", {
    binding: {
      backend: "sandbox",
      sandboxKey: allocation.allocationKey,
      ref: allocation.ref,
      container: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
    },
    harness: {
      harness: "pi",
      pid: 12,
      logOffset: 0,
      relaunches: 0,
      container: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      ...(!over?.missingBirth
        ? { processBirth: "dddddddd-dddd-4ddd-dddd-dddddddddddd:12", bearerHash: "b".repeat(64) }
        : {}),
    },
    ...(over?.pending ? { reviewPublication: { state: "uncertain" } } : {}),
  });
  const record: RunRecord = {
    id,
    channelId: req.meta.channelId,
    userId: req.meta.userId,
    threadKey: req.meta.threadKey,
    repo: req.meta.repo,
    ...(req.meta.parentInstanceId
      ? {
          parentInstanceId: req.meta.parentInstanceId,
          coordinatorUnit: req.meta.coordinatorUnit,
          idempotencyKey: req.meta.idempotencyKey,
        }
      : {}),
    ...(req.meta.maintenanceActionId ? { maintenanceActionId: req.meta.maintenanceActionId } : {}),
    channelVisibility: "machine",
    startedAt: 1,
    finishedAt: 30,
    status: "completed",
    eventCount: 2,
    storedEventCount: 2,
    truncated: false,
    events,
    session: { ...req.meta.session!, range: { from: 0, to: 1 } },
    diagnosis: {
      eventCount: 2,
      toolCalls: 0,
      byCategory: Object.fromEntries(
        FRICTION_CATEGORIES.map((c) => [c, { count: 0, durationMs: 0 }]),
      ) as RunRecord["diagnosis"]["byCategory"],
      findings: [],
      verdict: "fixture",
    },
  };
  await store.finishing(id, "g1");
  return {
    store,
    record,
    key,
    reportKey: contextThreadSessionKey(req.meta.threadKey),
    originalAllocation: req.meta.workspaceAllocation!,
  };
}

describe("canonical scratch custody disposition", () => {
  it("refuses stale pin plans and legacy pruning after same-range custody reacquisition", async () => {
    const { store, key } = await closureFixture();
    const before = (await store.custodyPinRevision(key))!;
    const first = await store.protectCustodyRanges(key, id, [{ from: 0, to: 1 }]);
    const beforeReacquisition = (await store.custodyPinRevision(key))!;
    const second = await store.protectCustodyRanges(key, id, [{ from: 0, to: 1 }]);
    expect(first.ok && second.ok && second.revision > first.revision).toBe(true);
    expect(await store.retainRangePinsIfRevision(key, before, [])).toMatchObject({
      ok: false,
      reason: "revision-changed",
    });
    expect(await store.retainRangePinsIfRevision(key, beforeReacquisition, [])).toMatchObject({
      ok: false,
      reason: "revision-changed",
    });
    expect(await store.retainRangePins(key, [])).toMatchObject({ ok: false, reason: "custody-protected" });
    expect(store.sessions.get(key)!.rangePins![id]).toEqual([{ from: 0, to: 1 }]);
    const current = (await store.custodyPinRevision(key))!;
    expect(await store.retainRangePinsIfRevision(key, current, [id])).toMatchObject({
      ok: true,
      revision: current.revision + 1,
    });
  });
  it("keeps ordinary pin pruning while reset or unreadable guarded revision stays held", async () => {
    const { store, key, record } = await closureFixture();
    expect(await store.retainRangePins(key, [])).toMatchObject({ ok: true });
    await store.finish(id, "g1", record);
    const log = store.sessions.get(key)!;
    delete log.pinRevision;
    expect(await store.custodyPinRevision(key)).toBeUndefined();
    expect(await store.workspaceDisposition(allocation)).toEqual({ kind: "held", reason: "custody-unavailable" });
    expect(await store.retainRangePins(key, [])).toMatchObject({ ok: false });
    expect(log.rangePins![id]).toBeDefined();
  });
  it("retains malformed pin metadata instead of replacing uncertain protection", async () => {
    const { store, key } = await closureFixture();
    const log = store.sessions.get(key)!;
    log.rangePins = { [id]: "unknown saved protection" } as unknown as NonNullable<typeof log.rangePins>;
    const before = JSON.stringify(log.rangePins);
    expect((await store.protectCustodyRanges(key, id, [{ from: 0, to: 1 }])).ok).toBe(false);
    expect((await store.retainRangePinsIfRevision(key, { version: 1, revision: 0, guarded: false }, [])).ok).toBe(
      false,
    );
    expect(JSON.stringify(log.rangePins)).toBe(before);
  });
  it("closes normalized reports and original parent or maintenance children using independent custody", async () => {
    for (const over of [{ raw: "*Review complete.*" }, { parent: true }, { maintenance: true }]) {
      const { store, record, originalAllocation } = await closureFixture(over);
      expect(await store.finish(id, "g1", record)).toMatchObject({ ok: true });
      expect(await store.workspaceDisposition(originalAllocation)).toMatchObject({
        kind: "terminal",
        disposition: { kind: "scratch-custody-closed" },
      });
    }
  });
  it("holds an answer event without the original immutable report and rechecks report and loop bytes", async () => {
    const missing = await closureFixture({ missingReport: true });
    await missing.store.finish(id, "g1", missing.record);
    expect(await missing.store.workspaceDisposition(allocation)).toMatchObject({
      kind: "terminal",
      disposition: { kind: "retained" },
    });
    for (const kind of ["changed", "trimmed", "foreign", "unknown", "loop"] as const) {
      const { store, record, reportKey, key } = await closureFixture();
      await store.finish(id, "g1", record);
      const log = store.sessions.get(kind === "loop" ? key : reportKey)!;
      if (kind === "trimmed") log.trimmed.add("0:0");
      else if (kind === "unknown") store.sessions.delete(reportKey);
      else if (kind === "foreign") log.rowIds!.set(`run:${id}:answer`, 99);
      else log.rows[0].json = log.rows[0].json.replace("fixture", "changed");
      expect(await store.workspaceDisposition(allocation), kind).toEqual({
        kind: "held",
        reason: "custody-unavailable",
      });
    }
  });
  it("fences report and loop mutation across asynchronous custody reads", async () => {
    for (const kind of ["report", "loop"] as const) {
      const { store, record, reportKey, key } = await closureFixture();
      const target = store as unknown as { workspaceCustody(row: unknown): Promise<unknown> };
      const original = target.workspaceCustody.bind(store);
      target.workspaceCustody = async (row) => {
        const custody = await original(row);
        store.sessions.get(kind === "report" ? reportKey : key)!.rows[0].json = "{}";
        return custody;
      };
      expect(await store.finish(id, "g1", record)).toEqual({ ok: false, reason: "fenced" });
      expect(await store.workspaceDisposition(allocation)).toEqual({ kind: "held", reason: "live" });
    }
  });
  it("holds changed foreign or unreadable report custody before finish while keeping real queued work held", async () => {
    for (const kind of ["changed", "foreign", "unreadable", "job", "inbox", "paused"] as const) {
      const { store, record, reportKey } = await closureFixture({ parent: true });
      if (kind === "job") store.jobs.set(id, [{ kind: "fixture", payload: {} }]);
      else if (kind === "inbox") await store.pushInbox(id, { text: "unread" });
      else if (kind === "paused")
        await store.setState(id, "g1", { ...store.live.get(id)!.state, pausedForRetry: true });
      else if (kind === "unreadable")
        store.readSessionEntry = async () => {
          throw new Error("fixture unknown report read");
        };
      else {
        const log = store.sessions.get(reportKey)!;
        if (kind === "foreign") log.rows[0].json = log.rows[0].json.replace('"assistant"', '"user"');
        else log.rows[0].json = log.rows[0].json.replace("fixture", "changed");
      }
      const originalAllocation = store.live.get(id)!.meta.workspaceAllocation!;
      expect(await store.finish(id, "g1", record)).toMatchObject({ ok: true });
      expect(await store.workspaceDisposition(originalAllocation), kind).toMatchObject({
        kind: "terminal",
        disposition: { kind: "retained" },
      });
    }
  });
  it("accepts real recorded nonzero completion and not-started refusal while unknown or missing receipts hold", async () => {
    for (const outcome of [
      "nonzero",
      "refused",
      "unknown",
      "missing",
      "foreign-owner",
      "foreign-call",
      "foreign-workspace",
    ] as const) {
      const folder = await mkdtemp(join(tmpdir(), "swb-disposable-check-"));
      const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      const execute = (command: string) => {
        const r = spawnSync("bash", ["-c", command], { cwd: folder, env, encoding: "utf8" });
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1, truncated: false };
      };
      try {
        expect(
          execute(
            "git init -q -b codex/fixture && git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c user.name=Fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture",
          ).exitCode,
        ).toBe(0);
        await writeFile(join(folder, "untracked"), "dummy temporary bytes");
        const { store, record } = await closureFixture();
        const cwd = await realpath(folder);
        const binding = store.live.get(id)!.state.binding as Record<string, unknown>;
        await store.setState(id, "g1", {
          ...store.live.get(id)!.state,
          binding: { ...binding, workspace: outcome === "foreign-workspace" ? "/foreign/fixture" : cwd },
        });
        let authorised = 0,
          sends = 0;
        const checks = createCheckExecution({
          executor: () => ({
            execResult: async (command: string) => {
              sends++;
              if (outcome === "unknown" && sends > 1) throw new Error("fixture lost collection");
              return execute(command);
            },
          }),
          workspace: () => cwd,
          recordingAvailable: true,
          owner: {
            runId: id,
            requester: outcome === "foreign-owner" ? "slack:foreign" : allocation.requester,
            threadKey: allocation.threadKey,
            repo: allocation.repo!,
          },
          authorizeCommand: () => ++authorised === 1 || outcome !== "refused",
          remainingMs: () => 120_000,
          signal: new AbortController().signal,
          clock: () => 10,
          save: async (state) =>
            (await store.setState(id, "g1", { ...store.live.get(id)!.state, checkExecutions: state })).ok,
        });
        if (outcome !== "missing")
          expect(
            (
              await checks.run(
                { command: "exit 7", purpose: "verification" },
                outcome === "foreign-call" ? "another-call" : "typed-negative",
              )
            ).kind,
          ).toBe("recorded");
        const calls = [
          { type: "tool_call" as const, seq: 3, tool: "run_check", callId: "typed-negative", summary: "display-only" },
          {
            type: "tool_result" as const,
            seq: 4,
            tool: "run_check",
            callId: "typed-negative",
            ok: false,
            exitCode: 7,
            summary: "display deliberately not authority",
          },
        ];
        await store.append(id, "g1", calls);
        record.events.push(...calls);
        record.eventCount += 2;
        record.storedEventCount += 2;
        expect(await store.finish(id, "g1", record)).toMatchObject({ ok: true });
        const result = await store.workspaceDisposition(allocation);
        expect(result, JSON.stringify(result)).toMatchObject({
          kind: "terminal",
          disposition: { kind: outcome === "nonzero" || outcome === "refused" ? "scratch-custody-closed" : "retained" },
        });
      } finally {
        await rm(folder, { recursive: true });
      }
    }
  });
  it("derives custody only from original contract and actual owned step session and report writes", async () => {
    const { store, record } = await closureFixture();
    expect(await store.workspaceDisposition(allocation)).toEqual({ kind: "held", reason: "live" });
    expect(await store.finish(id, "g1", record)).toMatchObject({ ok: true });
    expect(await store.workspaceDisposition(allocation)).toMatchObject({
      kind: "terminal",
      disposition: {
        kind: "scratch-custody-closed",
        ownerGen: "g1",
        custody: { leaseSeq: 1, reportSeq: 2, step: 0, from: 0, through: 1 },
      },
    });
    expect(await store.workspaceDisposition({ ...allocation, requester: "slack:foreign" })).toMatchObject({
      kind: "held",
    });
    await expect(store.claim(claim())).rejects.toThrow(/terminal/);
  });
  it("holds missing session birth token or unknown publication instead of trusting completed status", async () => {
    for (const over of [{ missingSession: true }, { missingBirth: true }, { pending: true }]) {
      const { store, record } = await closureFixture(over);
      expect(await store.finish(id, "g1", record)).toMatchObject({ ok: true });
      expect(await store.workspaceDisposition(allocation)).toMatchObject({
        kind: "terminal",
        disposition: { kind: "retained" },
      });
    }
  });
  it("refuses forged record state and CAS receipts and withholds custody when retained session data changes", async () => {
    const { store, record, key } = await closureFixture();
    expect(await store.setState(id, "g1", { workspaceDisposition: { kind: "scratch-custody-closed" } })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(
      await store.assignLiveState(id, "g1", {
        state: "working",
        expectedSeq: 0,
        at: 1,
        statePatch: { workspaceAllocation: allocation },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await store.finish(id, "g1", {
        ...record,
        workspaceDisposition: { kind: "scratch-custody-closed" },
      } as unknown as RunRecord),
    ).toMatchObject({ ok: false });
    expect(await store.finish(id, "rival", record)).toEqual({ ok: false, reason: "fenced" });
    await store.finish(id, "g1", record);
    store.sessions.get(key)!.rows = [];
    expect(await store.workspaceDisposition(allocation)).toEqual({ kind: "held", reason: "custody-unavailable" });
  });
});
