import { describe, expect, it } from "vitest";
import { InMemoryCoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./coordinator/contract.js";
import { recoverRunnerOwnedPulls, RunnerOwnershipFence } from "./runnerOwnership.js";

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

describe("recoverRunnerOwnedPulls", () => {
  it("rebuilds an unfinished resumed runner's pull ownership from durable unit rows after process-local state was lost", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance("runner_live", "acme/api"));
    await instances.putUnits([unit("runner_live", "unit", 77)]);

    const owned = await recoverRunnerOwnedPulls(["runner_live"], instances);

    expect(owned).toEqual(new Set(["acme/api#77"]));
  });

  it("does not restore ownership for a unit that already ended", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance("runner_ended", "acme/api"));
    await instances.putUnits([unit("runner_ended", "unit", 78, { kind: "merge_ready", report: "ready", at: 2 })]);

    expect(await recoverRunnerOwnedPulls(["runner_ended"], instances)).toEqual(new Set());
  });

  it("rebuilds an active recovery claim even though its original parent Workflow is terminal", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance("runner_recovery", "acme/api"));
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
    ]);

    expect(await recoverRunnerOwnedPulls([], instances)).toEqual(new Set(["acme/api#81"]));
  });
});

describe("RunnerOwnershipFence", () => {
  it("refuses sweep ownership reads until a complete live-run listing rebuilds durable ownership", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance("runner_live", "acme/api"));
    await instances.putUnits([unit("runner_live", "unit", 77)]);
    const fence = new RunnerOwnershipFence(true);

    await fence.recover(
      {
        liveListingComplete: false,
        liveHosted: [],
        resumable: [{ kind: "rehost", hosting: { instanceId: "runner_live", until: 10 } }],
        liveElsewhere: [],
      },
      instances,
    );
    expect(() => fence.owns("acme/api", 77)).toThrow("runner ownership recovery is still in progress");

    await fence.recover({ liveListingComplete: true, liveHosted: [], resumable: [], liveElsewhere: [] }, instances);
    expect(fence.owns("acme/api", 77)).toBe(true);
    expect(fence.owner("acme/api", 77)).toEqual({ instanceId: "runner_live", unit: "unit" });
  });

  it("refuses claims and reservations while boot ownership reconstruction is incomplete", () => {
    const fence = new RunnerOwnershipFence(true);
    expect(() => fence.claim("acme/api", 77, { instanceId: "runner_live", unit: "unit" })).toThrow(
      "runner ownership recovery is still in progress",
    );
    expect(() => fence.reserve("acme/api", 77, { instanceId: "runner_live", unit: "unit" })).toThrow(
      "runner ownership recovery is still in progress",
    );
  });

  it("recovers a current-generation hosted runner even when classification omitted it from resumable", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance("runner_failed", "acme/api"));
    await instances.putUnits([unit("runner_failed", "unit", 79)]);
    const fence = new RunnerOwnershipFence(true);

    await fence.recover(
      {
        liveListingComplete: true,
        liveHosted: [{ instanceId: "runner_failed", until: 10 }],
        resumable: [],
        liveElsewhere: [],
      },
      instances,
    );

    expect(fence.owns("acme/api", 79)).toBe(true);
  });

  it("recovers a foreign-generation hosted runner while its lease remains live", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance("runner_foreign", "acme/api"));
    await instances.putUnits([unit("runner_foreign", "unit", 80)]);
    const fence = new RunnerOwnershipFence(true);

    await fence.recover(
      {
        liveListingComplete: true,
        liveHosted: [],
        resumable: [],
        liveElsewhere: [{ hosting: { instanceId: "runner_foreign", until: 10 } }],
      },
      instances,
    );

    expect(fence.owns("acme/api", 80)).toBe(true);
  });

  it("starts recovered when no run ledger exists and keeps process-local claims separate from recovered claims", () => {
    const fence = new RunnerOwnershipFence(false);
    expect(fence.owns("acme/api", 77)).toBe(false);

    expect(fence.claim("acme/api", 77, { instanceId: "runner_live", unit: "unit" })).toBe(true);
    expect(fence.owns("acme/api", 77)).toBe(true);
    expect(fence.owner("acme/api", 77)).toEqual({ instanceId: "runner_live", unit: "unit" });
    expect(fence.release("acme/api", 77)).toBe(true);
    expect(fence.owns("acme/api", 77)).toBe(false);
  });

  it("an exclusive reservation transfers only from its exact token and current owner to the new runner", () => {
    const fence = new RunnerOwnershipFence(false);
    const continuation = { instanceId: "runner_continuation", unit: "unit" };
    const reissued = { instanceId: "runner_reissued", unit: "unit" };
    const intervening = { instanceId: "runner_intervening", unit: "other" };

    const token = fence.reserve("acme/api", 77, continuation);
    expect(token).toBeTypeOf("symbol");
    expect(fence.reserve("acme/api", 77, continuation)).toBeUndefined();
    expect(fence.claim("acme/api", 77, intervening)).toBe(false);
    expect(fence.owner("acme/api", 77)).toEqual(continuation);
    expect(fence.transferReservation("acme/api", 77, Symbol("stale"), continuation, reissued)).toBe(false);
    expect(fence.transferReservation("acme/api", 77, token!, intervening, reissued)).toBe(false);
    expect(fence.owner("acme/api", 77)).toEqual(continuation);
    expect(fence.transferReservation("acme/api", 77, token!, continuation, reissued)).toBe(true);
    expect(fence.owner("acme/api", 77)).toEqual(reissued);
    expect(fence.claim("acme/api", 77, intervening)).toBe(false);
    expect(fence.releaseReservation("acme/api", 77, token!)).toBe(false);
  });

  it("a failed reissued start releases only the transferred owner and never a successor", () => {
    const fence = new RunnerOwnershipFence(false);
    const continuation = { instanceId: "runner_continuation", unit: "unit" };
    const reissued = { instanceId: "runner_reissued", unit: "unit" };
    const successor = { instanceId: "runner_successor", unit: "unit" };
    const token = fence.reserve("acme/api", 77, continuation)!;

    expect(fence.transferReservation("acme/api", 77, token, continuation, reissued)).toBe(true);
    expect(fence.release("acme/api", 77, continuation)).toBe(false);
    expect(fence.release("acme/api", 77, reissued)).toBe(true);
    expect(fence.claim("acme/api", 77, successor)).toBe(true);
    expect(fence.release("acme/api", 77, reissued)).toBe(false);
    expect(fence.owner("acme/api", 77)).toEqual(successor);
  });

  it("an intervening runner cannot displace an existing owner, and a stale release cannot erase it", () => {
    const fence = new RunnerOwnershipFence(false);
    const continuation = { instanceId: "runner_continuation", unit: "unit" };
    const intervening = { instanceId: "runner_intervening", unit: "other" };

    expect(fence.claim("acme/api", 77, continuation)).toBe(true);
    expect(fence.claim("acme/api", 77, intervening)).toBe(false);
    expect(fence.owner("acme/api", 77)).toEqual(continuation);
    expect(fence.release("acme/api", 77, intervening)).toBe(false);
    expect(fence.owner("acme/api", 77)).toEqual(continuation);
    expect(fence.release("acme/api", 77, continuation)).toBe(true);
    expect(fence.owns("acme/api", 77)).toBe(false);
  });
});
