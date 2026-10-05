import { describe, expect, it } from "vitest";
import {
  InMemoryCoordinatorInstanceStore,
  NullCoordinatorInstanceStore,
  WorkerCoordinatorInstanceStore,
} from "./instanceStore.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import {
  prepareMaintenanceAdmission,
  planMaintenanceAdmission,
  releaseMaintenanceReservation,
  type MaintenanceAdmissionInput,
} from "./maintenanceAdmission.js";
import { planUnitEffectTransition } from "./unitEffect.js";

const headSha = "a".repeat(40);
const input: MaintenanceAdmissionInput = {
  version: 1,
  intent: {
    kind: "command",
    requestId: "cli:request:7",
    actorId: "cli:local",
    userId: "cli:local",
    channelId: "cli:default",
    threadKey: "cli:default:request:7",
  },
  target: { repo: "acme/api", pr: 7, ref: "fix/pr", base: "main", headSha },
  createdAt: 100,
  bounds: { leaseMinutes: 15, spendCapUsd: 5 },
};
const instance: CoordinatorInstance = {
  id: "original_ship",
  kind: "ship",
  userId: "cli:local",
  channelId: "cli:default",
  threadKey: "cli:default:original",
  repo: "acme/api",
  branch: "fix/pr",
  base: "main",
  createdAt: 1,
};
const ended: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "pr",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
  publication: {
    repo: instance.repo,
    pr: 7,
    headRef: instance.branch,
    baseRef: "main",
    publicationRef: instance.branch,
    expectedHeadSha: headSha,
    owner: { instanceId: instance.id, unit: "ONE" },
  },
  ending: {
    kind: "aborted",
    report: "Original private report",
    at: 2,
    outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 0 },
  },
};
const rows = (unit?: CoordinatorUnit) => ({
  complete: true,
  units: unit ? [{ instance, unit }] : [],
  runs: [],
  effects: [],
});
describe("durable maintenance admission", () => {
  it("recovers exact no-op cancellation ACK loss but never cancels a begun or foreign action", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const first = await store.admitMaintenance(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lost = {
      listUnits: (id: string) => store.listUnits(id),
      transitionUnitEffect: async (change: Parameters<typeof store.transitionUnitEffect>[0]) => {
        await store.transitionUnitEffect(change);
        throw new Error("lost ACK");
      },
    };
    expect(await releaseMaintenanceReservation(first, lost)).toBe(true);
    expect(await releaseMaintenanceReservation(first, store)).toBe(true);
    const second = await store.admitMaintenance({
      ...input,
      intent: {
        ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
        requestId: "cli:request:8",
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(await releaseMaintenanceReservation(first, store)).toBe(false);
    const preparedCell = { ...second.unit.currentEffect!, preparation: undefined };
    const prepared = await store.transitionUnitEffect({
      kind: "prepare",
      expected: second.unit,
      execution: second.execution,
      effect: preparedCell,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      (
        await store.transitionUnitEffect({
          kind: "begin",
          expected: prepared.unit,
          execution: second.execution,
          effectId: second.effectId,
          call: 0,
        })
      ).ok,
    ).toBe(true);
    expect(await releaseMaintenanceReservation(second, store)).toBe(false);
    expect((await store.listUnits(second.instance.id))[0]!.currentEffect!.calls[0]!.state).toBe("pending");
  });
  it("releases a prepared multi-call plan only before any call begins and retains accepted results", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const admitted = await store.admitMaintenance(input);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const prepare = await store.transitionUnitEffect({
      kind: "prepare",
      expected: admitted.unit,
      execution: admitted.execution,
      effect: {
        ...admitted.unit.currentEffect!,
        preparation: undefined,
        calls: [
          { operation: "rebase_push", state: "unstarted" },
          { operation: "review_anchor", state: "unstarted" },
        ],
      },
    });
    expect(prepare.ok).toBe(true);
    if (!prepare.ok) return;
    expect(await releaseMaintenanceReservation(admitted, store)).toBe(true);
    expect((await store.listUnits(admitted.instance.id))[0]!.currentEffect).toMatchObject({
      phase: "settled",
      calls: [
        { state: "refused", cause: "not_started" },
        { state: "refused", cause: "not_started" },
      ],
    });
    const next = await store.admitMaintenance({
      ...input,
      intent: {
        ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
        requestId: "cli:request:next",
      },
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const prepared = await store.transitionUnitEffect({
      kind: "prepare",
      expected: next.unit,
      execution: next.execution,
      effect: { ...next.unit.currentEffect!, preparation: undefined },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const begun = await store.transitionUnitEffect({
      kind: "begin",
      expected: prepared.unit,
      execution: next.execution,
      effectId: next.effectId,
      call: 0,
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const completed = await store.transitionUnitEffect({
      kind: "complete",
      expected: begun.unit,
      execution: next.execution,
      effectId: next.effectId,
      call: 0,
      outcome: { state: "accepted", commitSha: "b".repeat(40) },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const before = structuredClone(completed.unit);
    expect(await releaseMaintenanceReservation(next, store)).toBe(false);
    expect((await store.listUnits(next.instance.id))[0]).toEqual(before);
  });
  it("holds lost or contradictory Worker receipts instead of treating transport failure as a second admission", async () => {
    const first = planMaintenanceAdmission(await prepareMaintenanceAdmission(input), rows(), []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    for (const mode of ["exact", "wrong_target", "lost", "malformed"] as const) {
      const fetch = async () => {
        if (mode === "lost") throw new Error("lost transport");
        if (mode === "malformed") return Response.json({ ok: true });
        if (mode === "wrong_target")
          return Response.json({
            ...first,
            unit: {
              ...first.unit,
              currentEffect: {
                ...first.unit.currentEffect!,
                target: { ...first.unit.currentEffect!.target, headSha: "b".repeat(40) },
              },
            },
          });
        return Response.json(first);
      };
      const client = new WorkerCoordinatorInstanceStore({
        baseUrl: "https://memory.example.test",
        token: "private-test",
        storeKey: "runs:default",
        fetch,
      });
      expect((await client.admitMaintenance(input)).ok).toBe(mode === "exact");
    }
    expect(await new NullCoordinatorInstanceStore().admitMaintenance()).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
  it("keeps one original action when the same source retries at its saved pushed head and refuses conflicting immutable bounds", async () => {
    const prepared = await prepareMaintenanceAdmission(input);
    const result = planMaintenanceAdmission(prepared, rows(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nextHead = "b".repeat(40);
    const completed: CoordinatorUnit = {
      ...result.unit,
      publication: { ...result.unit.publication!, expectedHeadSha: nextHead },
      lastPush: nextHead,
      currentEffect: {
        ...result.unit.currentEffect!,
        preparation: undefined,
        phase: "settled",
        calls: [{ operation: "rebase_push", state: "accepted", commitSha: nextHead }],
      },
    };
    const retained = { ...rows(), units: [{ instance: result.instance, unit: completed }] };
    const retry = await prepareMaintenanceAdmission({
      ...input,
      createdAt: 200,
      target: { ...input.target, headSha: nextHead },
    });
    expect(retry.actionId).toBe(prepared.actionId);
    expect(planMaintenanceAdmission(retry, retained, [result.instance])).toMatchObject({
      ok: true,
      replayed: true,
      effectId: result.effectId,
      ordinal: result.ordinal,
    });
    const changedBase = await prepareMaintenanceAdmission({ ...input, target: { ...input.target, base: "release" } });
    expect(planMaintenanceAdmission(changedBase, retained, [result.instance])).toEqual({
      ok: false,
      reason: "conflict",
    });
    const changed = await prepareMaintenanceAdmission({ ...input, bounds: { leaseMinutes: 30, spendCapUsd: 5 } });
    expect(changed.actionId).toBe(prepared.actionId);
    expect(planMaintenanceAdmission(changed, retained, [result.instance])).toEqual({ ok: false, reason: "conflict" });
  });
  it("releases a no-op reservation using only exact never-started cancellation and reuses the retained standalone owner", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    const first = await store.admitMaintenance(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const canceled = await store.transitionUnitEffect({
      kind: "cancel",
      expected: first.unit,
      execution: first.execution,
      effectId: first.effectId,
      call: 0,
    });
    expect(canceled.ok).toBe(true);
    if (!canceled.ok) return;
    const settled = await store.transitionUnitEffect({
      kind: "settle",
      expected: canceled.unit,
      execution: first.execution,
      effectId: first.effectId,
    });
    expect(settled.ok).toBe(true);
    expect(await store.findPullOwners(input.target)).toEqual({ ok: true, owners: [] });
    const next = await store.admitMaintenance({
      ...input,
      intent: {
        ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
        requestId: "cli:request:8",
      },
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.instance).toEqual(first.instance);
    expect(next.execution.maintenance?.intent).toMatchObject({
      userId: input.intent.kind === "command" && input.intent.userId,
    });
    expect(next.ordinal).toBe(2);
    expect(next.unit.currentEffect?.preparation).toBe("reserved");
  });
  it("refuses foreign requester context for a retained standalone or ended Ship owner", async () => {
    const first = planMaintenanceAdmission(await prepareMaintenanceAdmission(input), rows(), []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const standalone = {
      ...first.unit,
      currentEffect: {
        ...first.unit.currentEffect!,
        phase: "settled" as const,
        preparation: undefined,
        calls: [{ operation: "rebase_push" as const, state: "refused" as const, cause: "not_started" as const }],
      },
    };
    for (const patch of [
      { userId: "cli:other", actorId: "cli:other" },
      { channelId: "cli:other" },
      { authenticatedAs: "http:other" },
      { postedBy: "slack:OTHER" },
    ]) {
      const prepared = await prepareMaintenanceAdmission({
        ...input,
        intent: {
          ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
          requestId: "cli:request:foreign",
          ...patch,
        },
      });
      for (const original of [
        { instance: first.instance, unit: standalone },
        { instance, unit: ended },
      ])
        expect(planMaintenanceAdmission(prepared, { ...rows(), units: [original] }, [original.instance])).toEqual({
          ok: false,
          reason: "owned",
        });
    }
    expect(standalone.publication).toEqual(first.unit.publication);
    expect(ended.ending?.report).toBe("Original private report");
  });
  it("rebinds a new same-owner intent to the current native head and base without changing original private custody", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    await store.put(instance);
    seedCoordinatorUnit(store, ended);
    const moved = {
      ...input,
      intent: {
        ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
        requestId: "cli:request:moved",
      },
      target: { ...input.target, headSha: "b".repeat(40), base: "release" },
    };
    const admitted = await store.admitMaintenance(moved);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.instance).toEqual(instance);
    expect(admitted.unit.ending).toEqual(ended.ending);
    expect(admitted.unit.publication).toEqual({
      ...ended.publication!,
      expectedHeadSha: moved.target.headSha,
      baseRef: "release",
    });
    expect((await store.listUnits(instance.id))[0]).toEqual(admitted.unit);
    const prepared = await store.transitionUnitEffect({
      kind: "prepare",
      expected: admitted.unit,
      execution: admitted.execution,
      effect: { ...admitted.unit.currentEffect!, preparation: undefined },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const begun = await store.transitionUnitEffect({
      kind: "begin",
      expected: prepared.unit,
      execution: admitted.execution,
      effectId: admitted.effectId,
      call: 0,
    });
    expect(begun.ok).toBe(true);
    expect(await store.get(instance.id)).toEqual(instance);
  });
  it("holds active effects, accepted live children and rivals before rebinding a new intent", async () => {
    const first = planMaintenanceAdmission(await prepareMaintenanceAdmission(input), rows(), []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const moved = await prepareMaintenanceAdmission({
      ...input,
      intent: {
        ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
        requestId: "cli:request:moved",
      },
      target: { ...input.target, headSha: "b".repeat(40), base: "release" },
    });
    const settled = {
      ...first.unit,
      currentEffect: {
        ...first.unit.currentEffect!,
        phase: "settled" as const,
        preparation: undefined,
        calls: [{ operation: "spawn" as const, state: "accepted" as const, runId: "live-child" }],
      },
    };
    const baseRows = { ...rows(), units: [{ instance: first.instance, unit: settled }] };
    for (const held of [
      { ...baseRows, units: [{ instance: first.instance, unit: first.unit }] },
      {
        ...baseRows,
        runs: [
          {
            runId: "live-child",
            live: true,
            repo: "acme/api",
            meta: { channelId: "cli:default", userId: "cli:local", threadKey: "cli:default:live", repo: "acme/api" },
          },
        ],
      },
      { ...baseRows, effects: [{ id: "rival", kind: "rebase_round", repo: "acme/api", number: 7 }] },
    ])
      expect(planMaintenanceAdmission(moved, held, [first.instance])).toEqual({ ok: false, reason: "owned" });
  });
  it("holds a rowless ordinary Ship admission and malformed or contradictory retained owner snapshots", async () => {
    const prepared = await prepareMaintenanceAdmission(input);
    expect(planMaintenanceAdmission(prepared, rows(), [instance])).toEqual({ ok: false, reason: "owned" });
    expect(planMaintenanceAdmission(prepared, rows(ended), [])).toEqual({ ok: false, reason: "incomplete" });
    expect(planMaintenanceAdmission(prepared, rows(ended), [instance, instance])).toEqual({
      ok: false,
      reason: "incomplete",
    });
  });
  it("requires immutable preparation before begin and retains exact ended ownership through accepted completion", async () => {
    const result = planMaintenanceAdmission(await prepareMaintenanceAdmission(input), rows(ended), [instance]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reserved = result.unit;
    const effect = {
      ...reserved.currentEffect!,
      calls: [
        { operation: "rebase_push" as const, state: "unstarted" as const },
        { operation: "approval_reset" as const, state: "unstarted" as const },
      ],
    };
    delete effect.preparation;
    expect(
      planUnitEffectTransition(
        { kind: "begin", expected: reserved, execution: result.execution, effectId: result.effectId, call: 0 },
        result.instance,
        reserved,
      ),
    ).toEqual({ ok: false, reason: "conflict" });
    const prepared = planUnitEffectTransition(
      { kind: "prepare", expected: reserved, execution: result.execution, effect },
      result.instance,
      reserved,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.unit.ending).toEqual(ended.ending);
    const begun = planUnitEffectTransition(
      { kind: "begin", expected: prepared.unit, execution: result.execution, effectId: result.effectId, call: 0 },
      result.instance,
      prepared.unit,
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const completed = planUnitEffectTransition(
      {
        kind: "complete",
        expected: begun.unit,
        execution: result.execution,
        effectId: result.effectId,
        call: 0,
        outcome: { state: "accepted", commitSha: "b".repeat(40) },
      },
      { ...result.instance, stop: { at: 3 } },
      begun.unit,
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.unit.ending).toEqual(ended.ending);
    expect(
      planUnitEffectTransition(
        { kind: "begin", expected: completed.unit, execution: result.execution, effectId: result.effectId, call: 1 },
        { ...result.instance, stop: { at: 3 } },
        completed.unit,
      ),
    ).toEqual({ ok: false, reason: "stopped" });
  });
  it("creates a real rowless maintenance owner and replays only its exact original source intent", async () => {
    const prepared = await prepareMaintenanceAdmission(input);
    const first = planMaintenanceAdmission(prepared, rows(), []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.instance.kind).toBe("maintenance");
    expect(first.execution.workflowId).toBeUndefined();
    expect(first.unit.currentEffect?.preparation).toBe("reserved");
    const retained = { ...rows(), units: [{ instance: first.instance, unit: first.unit }] };
    expect(planMaintenanceAdmission(prepared, retained, [first.instance])).toMatchObject({
      ok: true,
      replayed: true,
      instance: first.instance,
      unit: first.unit,
    });
    const other = await prepareMaintenanceAdmission({
      ...input,
      intent: {
        ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
        requestId: "cli:request:8",
      },
    });
    expect(planMaintenanceAdmission(other, retained, [first.instance])).toEqual({ ok: false, reason: "owned" });
  });
  it("preserves an ended original owner's requester and terminal report while refusing active producers", async () => {
    const prepared = await prepareMaintenanceAdmission(input);
    const result = planMaintenanceAdmission(prepared, rows(ended), [instance]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance).toEqual(instance);
    expect(result.unit.ending).toEqual(ended.ending);
    expect(result.unit.publication).toEqual(ended.publication);
    const { ending: _ending, ...active } = ended;
    expect(planMaintenanceAdmission(prepared, rows(active), [instance])).toEqual({ ok: false, reason: "owned" });
    expect(
      planMaintenanceAdmission(
        prepared,
        { ...rows(ended), effects: [{ id: "pending", kind: "rebase_round", repo: "acme/api", number: 7 }] },
        [instance],
      ),
    ).toEqual({ ok: false, reason: "owned" });
  });
  it("refuses incomplete owner scans, changed exact target and a watch source naming a different original owner", async () => {
    const prepared = await prepareMaintenanceAdmission(input);
    expect(planMaintenanceAdmission(prepared, { ...rows(), complete: false }, [])).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(
      planMaintenanceAdmission(
        await prepareMaintenanceAdmission({ ...input, target: { ...input.target, ref: "other/ref" } }),
        rows(ended),
        [instance],
      ),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(
      planMaintenanceAdmission(
        await prepareMaintenanceAdmission({
          ...input,
          intent: {
            kind: "watch",
            eventId: "github:push:1",
            instanceId: "other",
            unit: "ONE",
            requester: instance.userId,
          },
        }),
        rows(ended),
        [instance],
      ),
    ).toEqual({ ok: false, reason: "stale" });
  });
  it("atomically reserves one existing cell before any local preparation, without requiring a Workflow", async () => {
    const ledger = new InMemoryRunLedger();
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    await store.put(instance);
    seedCoordinatorUnit(store, ended);
    const results = await Promise.all([
      store.admitMaintenance(input),
      store.admitMaintenance({
        ...input,
        intent: {
          ...(input.intent as Extract<MaintenanceAdmissionInput["intent"], { kind: "command" }>),
          requestId: "cli:request:8",
        },
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "owned" }]);
    const current = (await store.listUnits(instance.id))[0]!;
    expect(current.ending).toEqual(ended.ending);
    expect(current.currentEffect?.calls).toEqual([{ operation: "rebase_push", state: "unstarted" }]);
  });
});
