import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "../runFriction.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import {
  InMemoryCoordinatorInstanceStore,
  WorkerCoordinatorInstanceStore,
  NullCoordinatorInstanceStore,
} from "./instanceStore.js";
import {
  isUnitCurrentEffect,
  isUnitEffectTransition,
  unitEffectResultMatches,
  type UnitEffectTransition,
  type UnitEffectTransitionResult,
  type UnitEffectCompletionOutcome,
} from "./unitEffect.js";
import {
  CoordinatorUnitWriteConflict,
  isCoordinatorUnit,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";

const instance: CoordinatorInstance = {
  id: "ship_effect_contract",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:C1",
  threadKey: "slack:C1:1",
  repo: "acme/api",
  base: "main",
  branch: "fix/effect",
  plan: { id: "effect" },
  merge: "person",
  createdAt: 1,
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "u1",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  threadKey: instance.threadKey,
};
const effect = {
  version: 1,
  ordinal: 1,
  id: "ONE/branch",
  execution: { workflowId: instance.id },
  target: { repo: instance.repo, ref: instance.branch, base: instance.base!, headSha: "a".repeat(40) },
  phase: "active",
  calls: [{ operation: "branch_create", state: "pending" }],
} as const;
async function retained(row: CoordinatorUnit, owner: CoordinatorInstance = instance) {
  const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
  expect(await store.put(owner)).toEqual({ ok: true });
  // Retained private input, not a successful ordinary admission of an effect.
  (store as unknown as { units: Map<string, string> }).units.set(`${instance.id}\0ONE`, JSON.stringify(row));
  return store;
}

const execution = { workflowId: instance.id };
const admitted = { ...effect, calls: [{ operation: "branch_create", state: "unstarted" }] } as const;
const transition = (store: InMemoryCoordinatorInstanceStore, input: UnitEffectTransition) =>
  store.transitionUnitEffect(input);
function accepted(result: UnitEffectTransitionResult): CoordinatorUnit {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.unit;
}

describe("unit current effect", () => {
  it("an accepted queue retains ownership after stop until exact terminal evidence, and an unknown enqueue cannot resolve from absence", async () => {
    const published: CoordinatorUnit = {
      ...unit,
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      publication: {
        repo: instance.repo,
        pr: 7,
        headRef: unit.branch,
        baseRef: "main",
        publicationRef: unit.branch,
        expectedHeadSha: "a".repeat(40),
        owner: { instanceId: instance.id, unit: unit.unit },
      },
    };
    for (const state of ["accepted", "uncertain"] as const) {
      const store = await retained(published);
      const job = {
        ...admitted,
        target: { ...admitted.target, pr: 7 },
        calls: [{ operation: "enqueue" as const, state: "unstarted" as const }],
      };
      let row = accepted(await transition(store, { kind: "admit", expected: published, execution, effect: job }));
      row = accepted(await transition(store, { kind: "begin", expected: row, execution, effectId: job.id, call: 0 }));
      row = accepted(
        await transition(store, {
          kind: "complete",
          expected: row,
          execution,
          effectId: job.id,
          call: 0,
          outcome: { state },
        }),
      );
      await store.markStopped(instance.id, 2);
      expect(await transition(store, { kind: "settle", expected: row, execution, effectId: job.id })).toEqual({
        ok: false,
        reason: "uncertain",
      });
      const target = { repo: instance.repo, ref: unit.branch, base: "main", pr: 7, headSha: "a".repeat(40) };
      expect(
        await transition(store, {
          kind: "resolve",
          expected: row,
          execution,
          effectId: job.id,
          call: 0,
          observation: { kind: "pull_merged", ...target, headSha: "b".repeat(40), commitSha: "9".repeat(40) },
        }),
      ).toEqual({ ok: false, reason: "conflict" });
      if (state === "uncertain")
        expect(
          await transition(store, {
            kind: "resolve",
            expected: row,
            execution,
            effectId: job.id,
            call: 0,
            observation: { kind: "pull_dequeued", ...target },
          }),
        ).toEqual({ ok: false, reason: "conflict" });
      row = accepted(
        await transition(store, {
          kind: "resolve",
          expected: row,
          execution,
          effectId: job.id,
          call: 0,
          observation: { kind: "pull_merged", ...target, commitSha: "9".repeat(40) },
        }),
      );
      expect(row.currentEffect).toMatchObject({
        phase: "settled",
        calls: [{ operation: "enqueue", state: "accepted" }],
      });
    }
  });

  it("decoder and transport cannot accept a merge without its native commit receipt or an enqueue with unrelated receipts", () => {
    for (const operation of ["merge", "enqueue"] as const) {
      const malformed =
        operation === "merge"
          ? { state: "accepted" as const }
          : { state: "accepted" as const, commitSha: "9".repeat(40) };
      const pending = { ...unit, currentEffect: { ...effect, calls: [{ operation, state: "pending" as const }] } };
      const bad = { ...pending, currentEffect: { ...effect, calls: [{ operation, ...malformed }] } };
      const input: UnitEffectTransition = {
        kind: "complete",
        expected: pending,
        execution,
        effectId: effect.id,
        call: 0,
        outcome: malformed,
      };
      expect(isUnitCurrentEffect(bad.currentEffect)).toBe(false);
      expect(isUnitEffectTransition(input)).toBe(false);
      expect(unitEffectResultMatches(input, bad)).toBe(false);
    }
  });

  it("stop-first refuses admission while admission-first retains an accepted outcome after stop", async () => {
    const stopped = await retained(unit);
    await stopped.markStopped(instance.id, 2);
    expect(await transition(stopped, { kind: "admit", expected: unit, execution, effect: admitted })).toEqual({
      ok: false,
      reason: "stopped",
    });
    expect(await stopped.listUnits(instance.id)).toEqual([unit]);
    const store = await retained(unit);
    const active = accepted(await transition(store, { kind: "admit", expected: unit, execution, effect: admitted }));
    const pending = accepted(
      await transition(store, { kind: "begin", expected: active, execution, effectId: effect.id, call: 0 }),
    );
    await store.markStopped(instance.id, 2);
    const completed = accepted(
      await transition(store, {
        kind: "complete",
        expected: pending,
        execution,
        effectId: effect.id,
        call: 0,
        outcome: { state: "accepted", commitSha: "b".repeat(40) },
      }),
    );
    const settled = accepted(
      await transition(store, { kind: "settle", expected: completed, execution, effectId: effect.id }),
    );
    expect(settled.currentEffect?.phase).toBe("settled");
    expect(settled.currentEffect?.calls[0]).toEqual({
      operation: "branch_create",
      state: "accepted",
      commitSha: "b".repeat(40),
    });
  });
  it("a lost begin response and unknown call outcome never grant replay or retirement", async () => {
    const store = await retained(unit);
    const active = accepted(await transition(store, { kind: "admit", expected: unit, execution, effect: admitted }));
    const pending = accepted(
      await transition(store, { kind: "begin", expected: active, execution, effectId: effect.id, call: 0 }),
    );
    expect(
      await transition(store, { kind: "begin", expected: active, execution, effectId: effect.id, call: 0 }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      await transition(store, { kind: "begin", expected: pending, execution, effectId: effect.id, call: 0 }),
    ).toEqual({ ok: false, reason: "uncertain" });
    const unknown = accepted(
      await transition(store, {
        kind: "complete",
        expected: pending,
        execution,
        effectId: effect.id,
        call: 0,
        outcome: { state: "uncertain" },
      }),
    );
    expect(await transition(store, { kind: "settle", expected: unknown, execution, effectId: effect.id })).toEqual({
      ok: false,
      reason: "uncertain",
    });
    expect(
      await transition(store, {
        kind: "admit",
        expected: unknown,
        execution,
        effect: { ...admitted, id: "another", ordinal: 2 },
      }),
    ).toEqual({ ok: false, reason: "busy" });
    expect((await store.listUnits(instance.id))[0]).toEqual(unknown);
  });
  it("caller execution identity and canonical owner completeness are required in the admission", async () => {
    const store = await retained(unit);
    expect(
      await transition(store, { kind: "admit", expected: unit, execution: { workflowId: "other" }, effect: admitted }),
    ).toEqual({ ok: false, reason: "execution" });
    const unpaired = new InMemoryCoordinatorInstanceStore();
    await unpaired.put(instance);
    await unpaired.putUnits([unit]);
    expect(await transition(unpaired, { kind: "admit", expected: unit, execution, effect: admitted })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    // Existing conflicting private rows must refuse without repairing either owner.
    (store as unknown as { units: Map<string, string> }).units.set(
      `${instance.id}\0OTHER`,
      JSON.stringify({ ...unit, unit: "OTHER", startedAt: 2 }),
    );
    expect(await transition(store, { kind: "admit", expected: unit, execution, effect: admitted })).toEqual({
      ok: false,
      reason: "owned",
    });
    expect((await store.listUnits(instance.id))[0]).toEqual(unit);
  });
  it("stop between admission and begin can cancel only work that has never crossed the call boundary", async () => {
    const store = await retained(unit);
    const active = accepted(await transition(store, { kind: "admit", expected: unit, execution, effect: admitted }));
    await store.markStopped(instance.id, 2);
    expect(
      await transition(store, { kind: "begin", expected: active, execution, effectId: effect.id, call: 0 }),
    ).toEqual({ ok: false, reason: "stopped" });
    const cancelled = accepted(
      await transition(store, { kind: "cancel", expected: active, execution, effectId: effect.id, call: 0 }),
    );
    expect(
      accepted(await transition(store, { kind: "settle", expected: cancelled, execution, effectId: effect.id }))
        .currentEffect?.phase,
    ).toBe("settled");
    const pending = { ...unit, currentEffect: effect } as CoordinatorUnit;
    const retainedPending = await retained(pending);
    expect(
      await transition(retainedPending, { kind: "cancel", expected: pending, execution, effectId: effect.id, call: 0 }),
    ).toEqual({ ok: false, reason: "uncertain" });
  });
  it("the Worker transport requires an exact typed receipt and Null refuses admission", async () => {
    const input: UnitEffectTransition = { kind: "admit", expected: unit, execution, effect: admitted };
    const result = { ok: true, unit: { ...unit, currentEffect: admitted } };
    const options = { baseUrl: "https://memory.test", token: "test-token", storeKey: "effect-test" };
    for (const [body, status, expected] of [
      [result, 200, result],
      [{ ...result, unit: { ...result.unit, branch: "foreign" } }, 200, { ok: false, reason: "unavailable" }],
      [
        { ...result, unit: { ...result.unit, currentEffect: { ...admitted, id: "foreign" } } },
        200,
        { ok: false, reason: "unavailable" },
      ],
      [result, 409, { ok: false, reason: "unavailable" }],
      [{ ok: false, reason: "stopped" }, 409, { ok: false, reason: "stopped" }],
      [{ ok: false, reason: "new_unknown_word" }, 409, { ok: false, reason: "unavailable" }],
    ] as const) {
      const client = new WorkerCoordinatorInstanceStore({
        ...options,
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://memory.test/runs/coordinator/units/effect-transition");
          expect(JSON.parse(init!.body as string).input).toEqual(input);
          return Response.json(body, { status });
        },
      });
      expect(await client.transitionUnitEffect(input)).toEqual(expected);
    }
    expect(await new NullCoordinatorInstanceStore().transitionUnitEffect(input)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
  it("a malformed retained settled cell cannot overwrite uncertain private work", async () => {
    const malformed = {
      ...unit,
      currentEffect: { ...effect, phase: "settled", calls: [{ operation: "branch_create", state: "uncertain" }] },
    } as CoordinatorUnit;
    const store = await retained(malformed);
    expect(
      await transition(store, {
        kind: "admit",
        expected: malformed,
        execution,
        effect: { ...admitted, id: "next", ordinal: 2 },
      }),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(isCoordinatorUnit(malformed)).toBe(false);
    expect((store as unknown as { units: Map<string, string> }).units.get(`${instance.id}\0ONE`)).toBe(
      JSON.stringify(malformed),
    );
  });
  it("settled pre-PR effects allow publication binding without poisoning canonical owner reads", async () => {
    const settled = {
      ...unit,
      currentEffect: {
        ...effect,
        phase: "settled",
        calls: [{ operation: "branch_create", state: "accepted", commitSha: "b".repeat(40) }],
      },
    } as CoordinatorUnit;
    const store = await retained(settled);
    const next = {
      ...settled,
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      publication: {
        repo: instance.repo,
        pr: 7,
        headRef: unit.branch,
        baseRef: instance.base!,
        expectedHeadSha: "b".repeat(40),
        publicationRef: unit.branch,
        owner: { instanceId: instance.id, unit: unit.unit },
      },
    };
    expect(await store.compareAndReplaceUnit(settled, next)).toEqual({ ok: true });
    expect(await store.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual({
      ok: true,
      owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }],
    });
    expect(await store.findPullOwners({ repo: "another/repo", pr: 1 })).toEqual({ ok: true, owners: [] });
  });
  it("admission reserves outcome capacity before any external call can start", async () => {
    const longUnit = { ...unit, branch: "ref".repeat(170) };
    const owner = { ...instance, branch: longUnit.branch, base: "base".repeat(128) };
    const store = await retained(longUnit, owner);
    const tooLarge = {
      ...admitted,
      target: { ...admitted.target, ref: longUnit.branch, base: owner.base },
      id: "effect".repeat(85),
      calls: Array.from({ length: 32 }, (_, index) => ({
        operation: "check_rerequest" as const,
        resourceId: Number.MAX_SAFE_INTEGER - index,
        state: "unstarted" as const,
      })),
    };
    expect(await transition(store, { kind: "admit", expected: longUnit, execution, effect: tooLarge })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(await store.listUnits(instance.id)).toEqual([longUnit]);
  });
  it("a begun call cannot be completed with a never-started receipt", async () => {
    const pending = { ...unit, currentEffect: effect } as CoordinatorUnit;
    const store = await retained(pending);
    expect(
      await transition(store, {
        kind: "complete",
        expected: pending,
        execution,
        effectId: effect.id,
        call: 0,
        outcome: { state: "refused", cause: "not_started" } as unknown as UnitEffectCompletionOutcome,
      }),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(await store.listUnits(instance.id)).toEqual([pending]);
  });
  it("a retained unpublished push fences the full head used for the next effect", async () => {
    const pushed = { ...unit, lastPush: "b".repeat(40) };
    const store = await retained(pushed);
    expect(await transition(store, { kind: "admit", expected: pushed, execution, effect: admitted })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(await store.listUnits(instance.id)).toEqual([pushed]);
  });
  it("a multi-call plan retains every maximum-size accepted receipt and retires only after the final call", async () => {
    const store = await retained(unit);
    const plan = {
      ...admitted,
      calls: Array.from({ length: 32 }, () => ({ operation: "rebase_push" as const, state: "unstarted" as const })),
    };
    let row = accepted(await transition(store, { kind: "admit", expected: unit, execution, effect: plan }));
    const options = { baseUrl: "https://memory.test", token: "test-token", storeKey: "effect-test" };
    const client = new WorkerCoordinatorInstanceStore({
      ...options,
      fetch: async (_url, init) => {
        const result = await transition(store, JSON.parse(init!.body as string).input);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      },
    });
    for (let call = 0; call < 32; call++) {
      row = accepted(
        await client.transitionUnitEffect({ kind: "begin", expected: row, execution, effectId: effect.id, call }),
      );
      row = accepted(
        await client.transitionUnitEffect({
          kind: "complete",
          expected: row,
          execution,
          effectId: effect.id,
          call,
          outcome: { state: "accepted", commitSha: "b".repeat(40), runId: "r".repeat(64) },
        }),
      );
      if (call < 31)
        expect(
          await client.transitionUnitEffect({ kind: "settle", expected: row, execution, effectId: effect.id }),
        ).toEqual({ ok: false, reason: "uncertain" });
    }
    const result = accepted(
      await client.transitionUnitEffect({ kind: "settle", expected: row, execution, effectId: effect.id }),
    );
    expect(result.currentEffect?.phase).toBe("settled");
    expect(result.currentEffect?.calls).toHaveLength(32);
    expect(result.currentEffect?.calls.every((call) => call.state === "accepted")).toBe(true);
    expect(await store.listUnits(instance.id)).toEqual([result]);
  });
  it("only an exact branch-ref observation resolves an unknown creation without replay", async () => {
    const row = {
      ...unit,
      currentEffect: { ...effect, calls: [{ operation: "branch_create", state: "uncertain" }] },
    } as CoordinatorUnit;
    const store = await retained(row);
    const input = {
      kind: "resolve" as const,
      expected: row,
      execution,
      effectId: effect.id,
      call: 0,
      observation: { kind: "branch_ref" as const, repo: instance.repo, ref: unit.branch, headSha: "a".repeat(40) },
    };
    expect(
      await transition(store, { ...input, observation: { ...input.observation, headSha: "b".repeat(40) } }),
    ).toEqual({ ok: false, reason: "conflict" });
    expect(await transition(store, { ...input, observation: { ...input.observation, ref: "fix/foreign" } })).toEqual({
      ok: false,
      reason: "conflict",
    });
    await store.markStopped(instance.id, 2);
    const resolved = accepted(await transition(store, input));
    expect(resolved.currentEffect?.calls[0]).toEqual({
      operation: "branch_create",
      state: "accepted",
      commitSha: "a".repeat(40),
    });
    expect(await transition(store, input)).toEqual({ ok: false, reason: "stale" });
    expect(
      accepted(await transition(store, { kind: "settle", expected: resolved, execution, effectId: effect.id }))
        .currentEffect?.phase,
    ).toBe("settled");
  });
  it("the transport refuses an accepted resolution receipt for a mismatched observation", async () => {
    const row = {
      ...unit,
      currentEffect: { ...effect, calls: [{ operation: "branch_create", state: "uncertain" }] },
    } as CoordinatorUnit;
    const client = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://memory.test",
      token: "test",
      storeKey: "test",
      fetch: async () =>
        Response.json({
          ok: true,
          unit: {
            ...row,
            currentEffect: {
              ...effect,
              calls: [{ operation: "branch_create", state: "accepted", commitSha: effect.target.headSha }],
            },
          },
        }),
    });
    expect(
      await client.transitionUnitEffect({
        kind: "resolve",
        expected: row,
        execution,
        effectId: effect.id,
        call: 0,
        observation: { kind: "branch_ref", repo: instance.repo, ref: unit.branch, headSha: "b".repeat(40) },
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });
  it("ordinary CAS cannot introduce effect authority", async () => {
    const store = await retained(unit);
    expect(await store.compareAndReplaceUnit(unit, { ...unit, currentEffect: effect } as CoordinatorUnit)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await store.listUnits(instance.id)).toEqual([unit]);
  });
  it("ordinary CAS cannot erase a pending effect", async () => {
    const row = { ...unit, currentEffect: effect } as CoordinatorUnit;
    const store = await retained(row);
    expect(await store.compareAndReplaceUnit(row, unit)).toEqual({ ok: false, reason: "stale" });
    expect(await store.listUnits(instance.id)).toEqual([row]);
  });
  it("whole-row batches preserve an uncertain effect before mutating any unit", async () => {
    const row = {
      ...unit,
      currentEffect: { ...effect, calls: [{ operation: "branch_create", state: "uncertain" }] },
    } as CoordinatorUnit;
    const store = await retained(row);
    await expect(store.putUnits([{ ...unit, unit: "OTHER", branch: "fix/other" }, unit])).rejects.toBeInstanceOf(
      CoordinatorUnitWriteConflict,
    );
    expect(await store.listUnits(instance.id)).toEqual([row]);
  });
});

describe("spawn effect durable receipt", () => {
  async function setup() {
    const ledger = new InMemoryRunLedger(() => 2);
    const store = new InMemoryCoordinatorInstanceStore(ledger);
    await store.put(instance);
    const pending: CoordinatorUnit = {
      ...unit,
      currentEffect: {
        ...effect,
        id: "ONE/0/coding",
        calls: [{ operation: "spawn", state: "uncertain" }],
      },
    };
    (store as unknown as { units: Map<string, string> }).units.set(`${instance.id}\0ONE`, JSON.stringify(pending));
    const meta = {
      agent: "coding",
      channelId: instance.channelId,
      userId: instance.userId,
      threadKey: unit.threadKey!,
      repo: instance.repo,
      ref: unit.branch,
      parentInstanceId: instance.id,
      coordinatorUnit: unit.unit,
      coordinatorAttempt: 0,
      idempotencyKey: `${instance.id}:ONE/0/coding`,
      operationTarget: { repo: instance.repo, ref: unit.branch },
    };
    expect(
      await ledger.claim({
        runId: "exact-child",
        threadKey: unit.threadKey!,
        gen: "g1",
        leaseMs: 1000,
        startedAt: 2,
        meta,
        card: null,
        system: "",
        tools: [],
        state: {},
      }),
    ).toMatchObject({ ok: true });
    const tag = {
      seq: 1,
      type: "coordinator_tag" as const,
      parentInstanceId: instance.id,
      unit: unit.unit,
      branch: unit.branch,
      base: instance.base,
    };
    await ledger.append("exact-child", "g1", [tag]);
    const input = {
      kind: "resolve",
      expected: pending,
      execution,
      effectId: "ONE/0/coding",
      call: 0,
      observation: { kind: "spawn_run", runId: "exact-child" },
    } as Extract<UnitEffectTransition, { kind: "resolve" }>;
    return { ledger, store, pending, meta, tag, input };
  }
  it("a review receipt must retain its exact admitted pull and head", async () => {
    for (const changed of [{ pr: 8 }, { headSha: "b".repeat(40) }, { headSha: undefined }]) {
      const h = await setup();
      const cell = h.pending.currentEffect!;
      cell.id = "ONE/1/review";
      cell.target = { ...cell.target, pr: 7 };
      h.pending.pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
      h.pending.publication = {
        repo: instance.repo,
        pr: 7,
        headRef: unit.branch,
        baseRef: "main",
        expectedHeadSha: "a".repeat(40),
        publicationRef: unit.branch,
        owner: { instanceId: instance.id, unit: unit.unit },
      };
      (h.store as unknown as { units: Map<string, string> }).units.set(
        `${instance.id}\0ONE`,
        JSON.stringify(h.pending),
      );
      Object.assign(h.ledger.live.get("exact-child")!.meta, {
        agent: "review",
        idempotencyKey: `${instance.id}:ONE/1/review`,
        pr: 7,
        headSha: "a".repeat(40),
        ...changed,
      });
      Object.assign(h.ledger.events.get("exact-child")![0], { publication: h.pending.publication });
      expect(await h.store.transitionUnitEffect({ ...h.input, effectId: cell.id })).toEqual({
        ok: false,
        reason: "conflict",
      });
    }
  });
  it("a finished review resolves from its original admission metadata, never its final workspace head", async () => {
    for (const original of ["a".repeat(40), "b".repeat(40), undefined]) {
      const h = await setup();
      const cell = h.pending.currentEffect!;
      cell.id = "ONE/1/review";
      cell.target = { ...cell.target, pr: 7 };
      h.pending.pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
      h.pending.publication = {
        repo: instance.repo,
        pr: 7,
        headRef: unit.branch,
        baseRef: "main",
        expectedHeadSha: "a".repeat(40),
        publicationRef: unit.branch,
        owner: { instanceId: instance.id, unit: unit.unit },
      };
      (h.store as unknown as { units: Map<string, string> }).units.set(
        `${instance.id}\0ONE`,
        JSON.stringify(h.pending),
      );
      const meta = { ...h.meta, agent: "review", idempotencyKey: `${instance.id}:ONE/1/review` };
      const events = [
        ...(original
          ? [
              {
                type: "run_meta" as const,
                agent: "review",
                seq: 1,
                repo: instance.repo,
                ref: unit.branch,
                pr: 7,
                headSha: original,
              },
            ]
          : []),
        { ...h.tag, seq: 2, publication: h.pending.publication },
        { type: "run_meta" as const, agent: "review", seq: 3, pr: 8, headSha: "b".repeat(40) },
      ];
      // A terminal review need not open a PR. Its final HEAD is a separate workspace observation.
      const record = {
        ...meta,
        id: "exact-child",
        channelVisibility: "unknown" as const,
        startedAt: 2,
        finishedAt: 3,
        status: "completed" as const,
        headSha: "c".repeat(40),
        eventCount: events.length,
        storedEventCount: events.length,
        truncated: false,
        events,
        diagnosis: analyzeRunFriction([]),
      };
      expect(await h.ledger.finish("exact-child", "g1", record)).toMatchObject({ ok: true });
      const out = await h.store.transitionUnitEffect({ ...h.input, effectId: cell.id });
      expect(out.ok).toBe(original === "a".repeat(40));
      if (out.ok)
        expect(out.unit.currentEffect?.calls[0]).toEqual({
          operation: "spawn",
          state: "accepted",
          runId: "exact-child",
        });
      else expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
    }
  });

  it("a different preset cannot satisfy the exact coding step receipt", async () => {
    const h = await setup();
    h.ledger.live.get("exact-child")!.meta.agent = "review";
    expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "conflict" });
    expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
  });
  it("resolves an uncertain spawn from its exact ledger child after stop, without granting another begin", async () => {
    const h = await setup();
    await h.store.markStopped(instance.id, 3);
    const resolved = accepted(await h.store.transitionUnitEffect(h.input));
    expect(resolved.currentEffect?.calls).toEqual([{ operation: "spawn", state: "accepted", runId: "exact-child" }]);
    expect(
      await h.store.transitionUnitEffect({
        kind: "begin",
        expected: resolved,
        execution,
        effectId: "ONE/0/coding",
        call: 0,
      }),
    ).toEqual({ ok: false, reason: "stopped" });
    expect(
      accepted(
        await h.store.transitionUnitEffect({ kind: "settle", expected: resolved, execution, effectId: "ONE/0/coding" }),
      ).currentEffect?.phase,
    ).toBe("settled");
  });
  it("terminal evidence resolves the original spawn after the live row has gone", async () => {
    const h = await setup();
    const record = {
      ...h.meta,
      id: "exact-child",
      channelVisibility: "unknown" as const,
      startedAt: 2,
      finishedAt: 3,
      status: "completed" as const,
      eventCount: 1,
      storedEventCount: 1,
      truncated: false,
      events: [h.tag],
      diagnosis: analyzeRunFriction([]),
    };
    expect(await h.ledger.finish("exact-child", "g1", record)).toMatchObject({ ok: true });
    expect(h.ledger.live.has("exact-child")).toBe(false);
    expect(accepted(await h.store.transitionUnitEffect(h.input)).currentEffect?.calls).toEqual([
      { operation: "spawn", state: "accepted", runId: "exact-child" },
    ]);
  });
  it("accepted completion cannot invent a run receipt or omit the exact run identity", async () => {
    const h = await setup();
    const pending = {
      ...h.pending,
      currentEffect: {
        ...h.pending.currentEffect!,
        calls: [{ operation: "spawn" as const, state: "pending" as const }],
      },
    };
    (h.store as unknown as { units: Map<string, string> }).units.set(`${instance.id}\0ONE`, JSON.stringify(pending));
    expect(
      await h.store.transitionUnitEffect({
        kind: "complete",
        expected: pending,
        execution,
        effectId: "ONE/0/coding",
        call: 0,
        outcome: { state: "accepted" },
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await h.store.transitionUnitEffect({
        kind: "complete",
        expected: pending,
        execution,
        effectId: "ONE/0/coding",
        call: 0,
        outcome: { state: "accepted", runId: "foreign-child" },
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      accepted(
        await h.store.transitionUnitEffect({
          kind: "complete",
          expected: pending,
          execution,
          effectId: "ONE/0/coding",
          call: 0,
          outcome: { state: "accepted", runId: "exact-child" },
        }),
      ).currentEffect?.calls,
    ).toEqual([{ operation: "spawn", state: "accepted", runId: "exact-child" }]);
  });
  it("a provisional tombstone is never terminal proof and does not hide its exact live claim", async () => {
    const h = await setup();
    h.ledger.finished.set("exact-child", {
      ...h.meta,
      id: "exact-child",
      channelVisibility: "unknown",
      startedAt: 2,
      finishedAt: 3,
      status: "interrupted",
      provisional: true,
      eventCount: 1,
      storedEventCount: 1,
      truncated: false,
      events: [h.tag],
      diagnosis: analyzeRunFriction([]),
    });
    expect(accepted(await h.store.transitionUnitEffect(h.input)).currentEffect?.calls[0]).toEqual({
      operation: "spawn",
      state: "accepted",
      runId: "exact-child",
    });
    const alone = await setup();
    alone.ledger.finished.set("exact-child", h.ledger.finished.get("exact-child")!);
    alone.ledger.live.clear();
    expect(await alone.store.transitionUnitEffect(alone.input)).toEqual({ ok: false, reason: "unavailable" });
    expect(await alone.store.listUnits(instance.id)).toEqual([alone.pending]);
  });
  it("a conflicting provisional record cannot hide behind matching coordinator keys", async () => {
    for (const changed of [{ agent: "orchestrator" }, { hosted: true as const }, { startedAt: 1 }]) {
      const h = await setup();
      h.ledger.finished.set("exact-child", {
        ...h.meta,
        id: "exact-child",
        channelVisibility: "unknown",
        startedAt: 2,
        finishedAt: 3,
        status: "interrupted",
        provisional: true,
        eventCount: 1,
        storedEventCount: 1,
        truncated: false,
        events: [h.tag],
        diagnosis: analyzeRunFriction([]),
        ...changed,
      });
      expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "incomplete" });
      expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
    }
  });
  it("a null Workflow tag cannot inherit the original Workflow", async () => {
    const h = await setup();
    h.ledger.events.set("exact-child", [{ ...h.tag, transportWorkflowId: null } as unknown as typeof h.tag]);
    expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "conflict" });
    expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
  });
  it("missing ledger or missing child cannot prove admission and leaves uncertain bytes unchanged", async () => {
    const h = await setup();
    h.ledger.live.clear();
    expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "unavailable" });
    expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
    const unpaired = new InMemoryCoordinatorInstanceStore();
    await unpaired.put(instance);
    (unpaired as unknown as { units: Map<string, string> }).units.set(`${instance.id}\0ONE`, JSON.stringify(h.pending));
    expect(await unpaired.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "unavailable" });
  });
  it("rejects same-key children with foreign actor, unit, branch, attempt, thread, credential or Workflow evidence", async () => {
    for (const changed of [
      { userId: "slack:UBOB" },
      { coordinatorUnit: "OTHER" },
      { ref: "fix/foreign" },
      { coordinatorAttempt: 1 },

      { authenticatedAs: "slack:credential" },
      { postedBy: "slack:bot:BOTHER" },
      { repo: "acme/foreign" },
      { parentInstanceId: "foreign" },
      { idempotencyKey: `${instance.id}:ONE/1/coding` },
    ]) {
      const h = await setup();
      h.ledger.live.get("exact-child")!.meta = { ...h.meta, ...changed };
      expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "conflict" });
      expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
    }
    const h = await setup();
    h.ledger.events.set("exact-child", [{ ...h.tag, transportWorkflowId: "retired-workflow" }]);
    expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "conflict" });
  });
  it("a corrupted live claim identity never borrows its index key or metadata thread", async () => {
    for (const change of [{ runId: "other" }, { threadKey: "slack:C1:foreign" }]) {
      const h = await setup();
      Object.assign(h.ledger.live.get("exact-child")!, change);
      expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "incomplete" });
      expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
    }
  });
  it("missing or contradictory tag observations never turn a claim into accepted spawn evidence", async () => {
    const h = await setup();
    h.ledger.events.clear();
    expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "incomplete" });
    h.ledger.events.set("exact-child", [h.tag, { ...h.tag, branch: "foreign" }]);
    expect(await h.store.transitionUnitEffect(h.input)).toEqual({ ok: false, reason: "incomplete" });
    expect(await h.store.listUnits(instance.id)).toEqual([h.pending]);
  });
});
