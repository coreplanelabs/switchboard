import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import { describe, expect, it } from "vitest";
import { InMemoryCoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./coordinator/contract.js";
import { findRunnerPullOwner, runnerPullOwnerOf } from "./runnerOwnership.js";

const instance = (id: string, repo: string): CoordinatorInstance => ({
  id,
  kind: "ship",
  userId: "slack:REQUESTER",
  channelId: "slack:C1",
  threadKey: "slack:C1:1.0",
  repo,
  branch: `runner/${id}/u1`,
  createdAt: 1,
});

const unit = (instanceId: string, unitId: string, pr: number, ending?: CoordinatorUnit["ending"]): CoordinatorUnit => ({
  instanceId,
  unit: unitId,
  slug: unitId.toLowerCase(),
  branch: `runner/${instanceId}/${unitId.toLowerCase()}`,
  dependsOn: [],
  pr: { number: pr, url: `https://github.com/acme/api/pull/${pr}` },
  rounds: [],
  ...(ending !== undefined ? { ending } : {}),
});

describe("canonical runner pull owner", () => {
  it("reads an unhosted durable unit after restart without a boot rebuild or local claim", async () => {
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await instances.put(instance("runner_live", "acme/api"));
    await instances.putUnits([unit("runner_live", "unit", 77)]);
    expect(await findRunnerPullOwner(instances, "acme/api", 77)).toEqual({
      ok: true,
      owner: { instanceId: "runner_live", unit: "unit" },
    });
    expect(await findRunnerPullOwner(instances, "acme/api", 78)).toEqual({ ok: true });
  });

  it("never caches a prior owner across a later complete owner read", async () => {
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await instances.put(instance("runner_live", "acme/api"));
    const row = unit("runner_live", "unit", 77);
    await instances.putUnits([row]);
    expect((await findRunnerPullOwner(instances, "acme/api", 77)).ok).toBe(true);
    await instances.putUnits([
      {
        ...row,
        ending: {
          kind: "refused",
          report: "ready",
          at: 2,
          outcome: { schemaVersion: 1, kind: "refused", reviewRounds: 0 },
        },
      },
    ]);
    expect(await findRunnerPullOwner(instances, "acme/api", 77)).toEqual({ ok: true });
  });

  it("reads an active original recovery independently of parent hosting or process state", async () => {
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await instances.put(instance("runner_recovery", "acme/api"));
    expect(
      await instances.putUnits([
        {
          ...unit("runner_recovery", "unit", 81),
          recovery: {
            kind: "review",
            round: 2,
            expectedHeadSha: "a".repeat(40),
            remainingMs: 60_000,
            claimedAt: 2,
            step: "unit/recovery/2/review",
            reviewRunId: "review-1",
            previousEnding: { kind: "aborted", report: "recoverable", at: 1 },
            workflowId: "recovery-review-1",
            deadlineAt: 60_002,
            reviewKey: "runner_recovery:unit/1/review",
          },
        },
      ]),
    ).toEqual({ ok: true });
    expect(await findRunnerPullOwner(instances, "acme/api", 81)).toEqual({
      ok: true,
      owner: { instanceId: "runner_recovery", unit: "unit" },
    });
  });

  it.each([
    { ok: false, reason: "unavailable" },
    { ok: false, reason: "incomplete" },
    { ok: false, reason: "invalid" },
  ] as const)("retains canonical refusal %j", async (result) => {
    expect(await findRunnerPullOwner({ findPullOwners: async () => result }, "acme/api", 77)).toEqual(result);
  });

  it("retains transport uncertainty instead of treating it as no owner", async () => {
    expect(
      await findRunnerPullOwner(
        {
          findPullOwners: async () => {
            throw new Error("state unavailable");
          },
        },
        "acme/api",
        77,
      ),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it.each([
    {
      owners: [
        { kind: "unit", instanceId: "first", unit: "U11" },
        { kind: "unit", instanceId: "second", unit: "U12" },
      ],
    },
    { owners: [{ kind: "run", runId: "run" }] },
    { owners: [{ kind: "effect", id: "effect" }] },
    {
      owners: [
        { kind: "unit", instanceId: "first", unit: "U11" },
        { kind: "run", runId: "run" },
      ],
    },
  ])("refuses ambiguous and nonunit owners: %j", ({ owners }) => {
    expect(runnerPullOwnerOf({ ok: true, owners })).toEqual({ ok: false, reason: "incomplete" });
  });

  it("keeps the exact canonical action when routing a single recovery owner", () => {
    expect(
      runnerPullOwnerOf({
        ok: true,
        owners: [{ kind: "unit", instanceId: "first", unit: "U11", actionId: "original" }],
      }),
    ).toEqual({ ok: true, owner: { instanceId: "first", unit: "U11", recoveryActionId: "original" } });
    expect(runnerPullOwnerOf({ ok: true, owners: [{ kind: "unit" }] })).toEqual({ ok: false, reason: "unavailable" });
  });
});
