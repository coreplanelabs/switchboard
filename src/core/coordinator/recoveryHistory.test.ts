import { describe, expect, it } from "vitest";
import {
  hasRecoverySettlementCapacity,
  RECOVERY_ROW_MAX_BYTES,
  RECOVERY_SETTLEMENT_MAX_BYTES,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { generatedTaskOf } from "./generatedTask.js";
import { isRecoveryReceipt, recoveryActionRenewed, RECOVERY_HISTORY_LIMITS } from "./recoveryHistory.js";

const instance: CoordinatorInstance = {
  id: "ship_acme_api_1",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:C1",
  threadKey: "slack:C1:1.0",
  repo: "acme/api",
  branch: "plan/api/u1",
  base: "main",
  plan: { id: "api" },
  merge: "person",
  createdAt: 1,
};
const request = (messageId = "slack:C1:2.0") => ({ userId: instance.userId, threadKey: instance.threadKey, messageId });
const ended = (): CoordinatorUnit => ({
  instanceId: instance.id,
  unit: "U12",
  slug: "u1",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  threadKey: instance.threadKey,
  ending: {
    kind: "aborted",
    report: "first result",
    at: 10,
    outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 1 },
  },
});
const recovering = (row: CoordinatorUnit, number = 1): CoordinatorUnit => {
  const { ending, ...rest } = row;
  return {
    ...rest,
    recovery: {
      kind: "findings",
      round: number,
      expectedHeadSha: "a".repeat(40),
      remainingMs: 1000,
      claimedAt: 20 + number,
      step: `U12/recovery/${number}/findings`,
      reviewRunId: `review-${number}`,
      reviewKey: `review-key-${number}`,
      previousEnding: ending!,
      workflowId: `recovery-review-${number}`,
      deadlineAt: 1000,
    },
  };
};
const settled = (row: CoordinatorUnit, number = 1): CoordinatorUnit => {
  const { recovery, ...rest } = row;
  return {
    ...rest,
    ending: {
      kind: "aborted",
      report: `result ${number}`,
      at: 30 + number,
      outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: number + 1 },
    },
    recoveryReceipt: { reviewRunId: recovery!.reviewRunId, workflowId: recovery!.workflowId, at: 30 + number },
  };
};

describe("recovery history store", () => {
  it("refuses recovery ownership conflict before journaling any action or receipt", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const row = { ...ended(), pr: { number: 7, url: "https://github.com/acme/api/pull/7" } };
    // The retained ended row is preexisting canonical evidence, not a new admission.
    (store as unknown as { units: Map<string, string> }).units.set(
      `${row.instanceId}\0${row.unit}`,
      JSON.stringify(row),
    );
    const held: CoordinatorUnit = { ...row, unit: "OTHER", branch: "fix/other", ending: undefined };
    expect(await store.putUnits([held])).toEqual({ ok: true });
    expect(
      await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row),
        request: request(),
      }),
    ).toEqual({ ok: false, reason: "owned" });
    expect(await store.listUnits(instance.id)).toEqual([row, held]);
    expect(await store.getRecoveryAction(row, request())).toBeNull();
    expect((await store.listRecoveryHistory(row)).receipts).toEqual([]);
  });
  it.each(["claim replay", "execution key order"] as const)("active recovery effect preserves %s", async (proof) => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    expect(await store.put(instance)).toEqual({ ok: true });
    const row = ended();
    expect(await store.putUnits([row])).toEqual({ ok: true });
    const input = { kind: "claim" as const, expected: row, replacement: recovering(row), request: request() };
    const result = await store.transitionRecovery(input);
    if (!result.ok) throw new Error(result.reason);
    const execution = {
      workflowId: result.unit.recovery!.workflowId,
      recoveryActionId: result.unit.recovery!.actionId!,
    };
    const admitted = await store.transitionUnitEffect({
      kind: "admit",
      expected: result.unit,
      execution,
      effect: {
        version: 1,
        id: "recovery/spawn",
        ordinal: 1,
        phase: "active",
        execution,
        target: { repo: instance.repo, ref: row.branch, base: instance.base!, headSha: "a".repeat(40) },
        calls: [{ operation: "spawn", state: "unstarted" }],
      },
    });
    if (!admitted.ok) throw new Error(admitted.reason);
    if (proof === "claim replay") {
      // Re-send the original admission fields, excluding the store-assigned action ID.
      const { actionId: _assigned, ...originalClaim } = admitted.unit.recovery!;
      const action = await store.getRecoveryAction(row, request());
      expect(
        await store.transitionRecovery({
          kind: "claim",
          expected: admitted.unit,
          replacement: { ...admitted.unit, recovery: originalClaim },
          request: request(),
        }),
      ).toEqual({ ok: true, unit: admitted.unit, replayed: true });
      expect(await store.getRecoveryAction(row, request())).toEqual(action);
      expect(await store.listUnits(instance.id)).toEqual([admitted.unit]);
    } else {
      const action = await store.getRecoveryAction(row, request());
      for (const changed of [
        { ...execution, workflowId: "recovery-other" },
        { ...execution, recoveryActionId: "r_" + "f".repeat(64) },
      ]) {
        expect(
          await store.transitionUnitEffect({
            kind: "begin",
            expected: admitted.unit,
            execution: changed,
            effectId: "recovery/spawn",
            call: 0,
          }),
        ).toEqual({ ok: false, reason: "execution" });
        expect(await store.listUnits(instance.id)).toEqual([admitted.unit]);
      }
      const foreign = {
        kind: "begin" as const,
        expected: admitted.unit,
        execution: { ...execution, authority: "untrusted" },
        effectId: "recovery/spawn",
        call: 0,
      };
      expect(await store.transitionUnitEffect(foreign)).toEqual({ ok: false, reason: "conflict" });
      expect(await store.listUnits(instance.id)).toEqual([admitted.unit]);
      const reverseExecution = { recoveryActionId: execution.recoveryActionId, workflowId: execution.workflowId };
      expect(
        await store.transitionUnitEffect({
          kind: "begin",
          expected: admitted.unit,
          execution: reverseExecution,
          effectId: "recovery/spawn",
          call: 0,
        }),
      ).toMatchObject({ ok: true });
      const actual = (await store.listUnits(instance.id))[0]!;
      expect(JSON.stringify(actual.currentEffect!.execution)).toBe(JSON.stringify(execution));
      expect(await store.getRecoveryAction(row, request())).toEqual(action);
    }
  });
  it.each([100, 2000, 7000])(
    "effect admission retains recovery settlement space with %s bytes remaining",
    async (remaining) => {
      const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
      expect(await store.put(instance)).toEqual({ ok: true });
      const source = {
        requesterId: instance.userId,
        threadKey: instance.threadKey,
        runId: "source-run",
        repo: instance.repo,
      };
      const row = { ...ended(), generatedTask: generatedTaskOf("x", source) };
      expect(await store.putUnits([row])).toEqual({ ok: true });
      const claim = await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row),
        request: request(),
      });
      if (!claim.ok) throw new Error(claim.reason);
      const { recovery, ...rest } = claim.unit;
      const { previousEnding: _previous, ...metadataClaim } = recovery!;
      const size = new TextEncoder().encode(JSON.stringify({ ...rest, recovery: metadataClaim })).byteLength;
      const textLength = RECOVERY_ROW_MAX_BYTES - RECOVERY_SETTLEMENT_MAX_BYTES - size - remaining + 1;
      const retained = { ...claim.unit, generatedTask: generatedTaskOf("x".repeat(textLength), source) };
      (store as unknown as { units: Map<string, string> }).units.set(
        `${row.instanceId}\0${row.unit}`,
        JSON.stringify(retained),
      );
      expect(hasRecoverySettlementCapacity(retained)).toBe(true);
      const execution = { workflowId: retained.recovery!.workflowId, recoveryActionId: retained.recovery!.actionId! };
      const admitted = await store.transitionUnitEffect({
        kind: "admit",
        expected: retained,
        execution,
        effect: {
          version: 1,
          id: "recovery/spawn",
          ordinal: 1,
          phase: "active",
          execution,
          target: { repo: instance.repo, ref: row.branch, base: instance.base!, headSha: "a".repeat(40) },
          calls: Array.from({ length: remaining === 100 ? 1 : 32 }, () => ({
            operation: "spawn" as const,
            state: "unstarted" as const,
          })),
        },
      });
      if (remaining === 7000) {
        if (!admitted.ok) throw new Error(admitted.reason);
        expect(
          await store.compareAndReplaceUnit(admitted.unit, { ...admitted.unit, threadEvidence: "x".repeat(4000) }),
        ).toEqual({ ok: false, reason: "stale" });
        expect(await store.listUnits(instance.id)).toEqual([admitted.unit]);
      } else {
        expect(admitted).toEqual({ ok: false, reason: "conflict" });
        expect(await store.listUnits(instance.id)).toEqual([retained]);
      }
    },
  );

  it("requires reconciled admission and preserves history through confirmation replay", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const pending: CoordinatorInstance = { ...instance, admission: "unreconciled" };
    await store.put(pending);
    const row = ended();
    await store.putUnits([row]);
    const input = { kind: "claim" as const, expected: row, replacement: recovering(row), request: request() };
    expect(await store.transitionRecovery(input)).toMatchObject({ ok: false, reason: "conflict" });
    expect((await store.listRecoveryHistory(row)).receipts).toEqual([]);
    expect(await store.getRecoveryAction(row, request())).toBeNull();
    expect(await store.confirmCreated({ ...pending, runId: "different-create" })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await store.confirmCreated(pending)).toEqual({ ok: true });
    const claimed = await store.transitionRecovery(input);
    if (!claimed.ok) throw new Error(claimed.reason);
    const action = await store.getRecoveryAction(row, request());
    const history = await store.listRecoveryHistory(row);
    expect(await store.confirmCreated(pending)).toEqual({ ok: true });
    expect(await store.listUnits(instance.id)).toEqual([claimed.unit]);
    expect(await store.getRecoveryAction(row, request())).toEqual(action);
    expect(await store.listRecoveryHistory(row)).toEqual(history);
    const completed = await store.transitionRecovery({
      kind: "settle",
      expected: claimed.unit,
      replacement: settled(claimed.unit),
    });
    if (!completed.ok) throw new Error(completed.reason);
    const finalHistory = await store.listRecoveryHistory(row);
    expect(await store.confirmCreated(pending)).toEqual({ ok: true });
    expect(await store.listUnits(instance.id)).toEqual([completed.unit]);
    expect(await store.listRecoveryHistory(row)).toEqual(finalHistory);
    expect(await store.get(instance.id)).toEqual({ ...pending, admission: "created" });
  });

  it("replay reads recover or renew intent only from complete digest-bound admission fields", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const row = ended();
    await store.putUnits([row]);
    const claimed = await store.transitionRecovery({
      kind: "claim",
      expected: row,
      replacement: recovering(row),
      request: request(),
    });
    if (!claimed.ok) throw new Error(claimed.reason);
    const action = (await store.getRecoveryAction(row, request()))!;
    expect(await recoveryActionRenewed(action)).toBe(false);
    const admission = JSON.parse(action.payload) as { transition: Record<string, unknown> };
    const resigned = async (transition: Record<string, unknown>) => {
      const payload = JSON.stringify({ ...admission, transition }, (_key, part: unknown) =>
        typeof part === "object" && part !== null && !Array.isArray(part)
          ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)))
          : part,
      );
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
      const payloadDigest = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return { ...action, payload, payloadDigest };
    };
    const renewed = {
      ...admission.transition,
      renewed: true,
      accounting: {
        spendUsd: 1,
        children: [{ runId: "coding", key: "coding-key", usd: 1 }],
        grant: { renewals: 1 },
        renewalsSpent: 1,
      },
    };
    expect(await recoveryActionRenewed(await resigned(renewed))).toBe(true);
    for (const transition of [
      {},
      { ...admission.transition, workflowId: "foreign" },
      { ...admission.transition, reviewRunId: "foreign" },
      { ...admission.transition, renewed: false },
    ])
      expect(await recoveryActionRenewed(await resigned(transition))).toBeNull();
    expect(await recoveryActionRenewed({ ...action, payloadDigest: "0".repeat(64) })).toBeNull();
  });

  it("rejects identity and provenance changes in every recovery transition", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const row = ended();
    await store.putUnits([row]);
    const mutations: Partial<CoordinatorUnit>[] = [
      { threadKey: "slack:COTHER:1.0" },
      { sourceUrl: "https://example.com/other" },
      { threadEvidence: "different evidence" },
      {
        generatedTask: await generatedTaskOf("different request", {
          requesterId: instance.userId,
          threadKey: instance.threadKey,
          runId: "other-run",
          repo: instance.repo,
        }),
      },
    ];
    for (const mutation of mutations)
      expect(
        await store.transitionRecovery({
          kind: "claim",
          expected: row,
          replacement: { ...recovering(row), ...mutation },
          request: request(),
        }),
      ).toMatchObject({ ok: false, reason: "conflict" });
    expect(await store.listUnits(instance.id)).toEqual([row]);
    expect((await store.listRecoveryHistory(row)).receipts).toEqual([]);
    const claimed = await store.transitionRecovery({
      kind: "claim",
      expected: row,
      replacement: recovering(row),
      request: request(),
    });
    if (!claimed.ok) throw new Error(claimed.reason);
    const before = await store.listRecoveryHistory(row);
    for (const mutation of mutations) {
      expect(
        await store.transitionRecovery({
          kind: "settle",
          expected: claimed.unit,
          replacement: { ...settled(claimed.unit), ...mutation },
        }),
      ).toMatchObject({ ok: false, reason: "conflict" });
      expect(
        await store.transitionRecovery({
          kind: "refuse",
          expected: claimed.unit,
          replacement: { ...row, ...mutation },
          error: "refused",
        }),
      ).toMatchObject({ ok: false, reason: "conflict" });
    }
    expect(await store.listUnits(instance.id)).toEqual([claimed.unit]);
    expect(await store.listRecoveryHistory(row)).toEqual(before);
    expect(await store.getRecoveryAction(row, request())).toMatchObject({ state: "pending" });
  });

  it("retains both predecessors across two recovery settlements", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    let row = ended();
    await store.putUnits([row]);
    const original = structuredClone(row.ending);
    for (const number of [1, 2]) {
      const claimed = await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row, number),
        request: request(`slack:C1:${number + 1}.0`),
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.reason);
      row = claimed.unit;
      const completed = await store.transitionRecovery({
        kind: "settle",
        expected: row,
        replacement: settled(row, number),
      });
      expect(completed.ok).toBe(true);
      if (!completed.ok) throw new Error(completed.reason);
      row = completed.unit;
    }
    const page = await store.listRecoveryHistory(row);
    expect(page.receipts.map((receipt) => receipt.ending.report)).toEqual(["first result", "result 1", "result 2"]);
    expect(page.receipts[0]!.ending).toEqual(original);
    expect(page.receipts[0]!.provenance).toBe("observed_predecessor");
    expect(page.receipts[1]!.predecessorId).toBe(page.receipts[0]!.id);
    expect(page.receipts[2]!.predecessorId).toBe(page.receipts[1]!.id);
    expect(
      await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row, 1),
        request: request("slack:C1:4.0"),
      }),
    ).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("binds action replay to its request and preserves a definitive refusal", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const row = ended();
    await store.putUnits([row]);
    const claim = { kind: "claim" as const, expected: row, replacement: recovering(row), request: request() };
    const first = await store.transitionRecovery(claim);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    expect(await store.transitionRecovery(claim)).toEqual({ ...first, replayed: true });
    const laterClock = recovering(row);
    laterClock.recovery!.claimedAt += 1;
    laterClock.recovery!.remainingMs -= 1;
    expect(await store.transitionRecovery({ ...claim, replacement: laterClock })).toEqual({ ...first, replayed: true });
    expect(await store.transitionRecovery({ ...claim, replacement: recovering(row, 2) })).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    const refused = await store.transitionRecovery({
      kind: "refuse",
      expected: first.unit,
      replacement: row,
      error: "recovery_workflow_failed",
    });
    expect(refused.ok).toBe(true);
    const saved = await store.getRecoveryAction(row, request());
    expect(saved).toMatchObject({ state: "refused", error: "recovery_workflow_failed" });
    expect(await store.transitionRecovery(claim)).toMatchObject({ ok: false, reason: "conflict" });
    if (!refused.ok) throw new Error(refused.reason);
    const later = await store.transitionRecovery({
      ...claim,
      expected: refused.unit,
      replacement: recovering(refused.unit, 2),
      request: request("slack:C1:3.0"),
    });
    expect(later.ok).toBe(true);
    expect((await store.getRecoveryAction(row, request("slack:C1:3.0")))?.id).not.toBe(saved?.id);
  });

  it("fences alternate writers without losing history or consuming wake events", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const row = ended();
    await store.putUnits([row]);
    const claimed = await store.transitionRecovery({
      kind: "claim",
      expected: row,
      replacement: recovering(row),
      request: request(),
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(claimed.reason);
    const before = await store.listRecoveryHistory(row);
    expect(await store.compareAndReplaceUnit(claimed.unit, settled(claimed.unit))).toEqual({
      ok: false,
      reason: "stale",
    });
    await expect(store.putUnits([{ ...row, unit: "U13" }, row])).rejects.toThrow();
    expect(await store.listUnits(instance.id)).toEqual([claimed.unit]);
    expect(await store.replace(instance)).toEqual({ ok: false, reason: "exists" });
    await store.appendEvent(row, { sender: instance.userId, text: "Continue", mode: "steer", at: 25 });
    await expect(
      store.answerWake(row, "U12/wait/1", { kind: "answered", reply: "Continue" }, [1], "wake"),
    ).rejects.toThrow();
    expect(await store.listEvents(row, true)).toHaveLength(1);
    expect(await store.listRecoveryHistory(row)).toEqual(before);
  });

  it("refuses oversized transitions before changing the unit", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const row = {
      ...ended(),
      generatedTask: generatedTaskOf("界".repeat(90_000), {
        requesterId: instance.userId,
        threadKey: instance.threadKey,
        runId: "source-run",
        repo: instance.repo,
      }),
    };
    await store.putUnits([row]);
    expect(
      await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row),
        request: request(),
      }),
    ).toMatchObject({ ok: false, reason: "capacity" });
    expect(await store.listUnits(instance.id)).toEqual([row]);
    expect((await store.listRecoveryHistory(row)).receipts).toEqual([]);
  });

  it("reserves terminal row space before admitting a large but valid task", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    const row = {
      ...ended(),
      generatedTask: generatedTaskOf("x".repeat(100_000), {
        requesterId: instance.userId,
        threadKey: instance.threadKey,
        runId: "source-run",
        repo: instance.repo,
      }),
    };
    await store.putUnits([row]);
    expect(
      await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row),
        request: request(),
      }),
    ).toMatchObject({ ok: false, reason: "capacity" });
    expect(await store.listUnits(instance.id)).toEqual([row]);
  });

  it("reserves the final receipt slot and pages history without trimming predecessors", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(instance);
    let row = ended();
    await store.putUnits([row]);
    for (let number = 1; number <= RECOVERY_HISTORY_LIMITS.actions; number++) {
      const claimed = await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row, number),
        request: request(`request-${number}`),
      });
      if (!claimed.ok) throw new Error(claimed.reason);
      const complete = await store.transitionRecovery({
        kind: "settle",
        expected: claimed.unit,
        replacement: settled(claimed.unit, number),
      });
      if (!complete.ok) throw new Error(complete.reason);
      row = complete.unit;
    }
    expect(
      await store.transitionRecovery({
        kind: "claim",
        expected: row,
        replacement: recovering(row, 33),
        request: request("request-33"),
      }),
    ).toMatchObject({ ok: false, reason: "capacity" });
    let cursor = 0;
    const reports: string[] = [];
    for (;;) {
      const page = await store.listRecoveryHistory(row, cursor);
      expect(page.receipts.length).toBeLessThanOrEqual(RECOVERY_HISTORY_LIMITS.pageCount);
      reports.push(...page.receipts.map((receipt) => receipt.ending.report));
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(reports).toHaveLength(33);
    expect(reports[0]).toBe("first result");
    expect(reports.at(-1)).toBe("result 32");
  });

  it("rejects receipts without an ending or with contradictory nested outcomes", () => {
    const receipt = {
      version: 1,
      id: "observed",
      seq: 1,
      instanceId: instance.id,
      unit: "U12",
      provenance: "observed_predecessor",
    };
    expect(isRecoveryReceipt(receipt)).toBe(false);
    expect(
      isRecoveryReceipt({
        ...receipt,
        ending: { ...ended().ending, outcome: { schemaVersion: 1, kind: "merged", reviewRounds: 1 } },
      }),
    ).toBe(false);
    expect(isRecoveryReceipt({ ...receipt, ending: ended().ending })).toBe(true);
  });
});
