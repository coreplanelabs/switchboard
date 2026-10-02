import { describe, expect, it } from "vitest";
import { runSessionIdentity } from "./sessionIdentity.js";
import { coordinatorFields } from "../coordinator/contract.js";

describe("run session identity comes from the admitted unit", () => {
  const threadKey = "slack:C1:1.0";
  const coordinator = {
    parentInstanceId: "plan-p-2",
    idempotencyKey: "plan-p-2:U11/3/coding",
    unit: "U11",
    instanceAttempt: 2,
  };
  it("uses one coding lane and one review lane across rounds and reissues", () => {
    expect(runSessionIdentity(threadKey, "coding", coordinator)).toEqual({
      key: "plan-p:U11:coding:@context-v1",
      legacyKey: `${threadKey}:coding`,
    });
    expect(
      runSessionIdentity(threadKey, "coding", {
        ...coordinator,
        parentInstanceId: "plan-p-3",
        instanceAttempt: 3,
        idempotencyKey: "new-round",
      }),
    ).toEqual({ key: "plan-p:U11:coding:@context-v1", legacyKey: `${threadKey}:coding` });
    expect(runSessionIdentity(threadKey, "review", coordinator).key).toBe("plan-p:U11:review:@context-v1");
  });
  it("preserves resumed keys and never infers unit authority from an idempotency string", () => {
    expect(
      runSessionIdentity(threadKey, "coding", {
        parentInstanceId: "plan-p-2",
        idempotencyKey: "plan-p-2:U11/3/coding",
      }),
    ).toEqual({ key: `${threadKey}:coding:@context-v1`, legacyKey: `${threadKey}:coding` });
    expect(
      runSessionIdentity(threadKey, "coding", coordinator, {
        key: `${threadKey}:coding`,
        seedFrom: 0,
        request: 0,
        range: { from: 0 },
      }),
    ).toEqual({ key: `${threadKey}:coding` });
    expect(runSessionIdentity(threadKey, "general", coordinator)).toEqual({
      key: `${threadKey}:general:@context-v1`,
      legacyKey: `${threadKey}:general`,
    });
  });
  it("keeps an original instance name intact when its explicit attempt is zero", () => {
    const original = { ...coordinator, parentInstanceId: "plan-p-0", instanceAttempt: 0 };
    expect(runSessionIdentity(threadKey, "coding", original).key).toBe("plan-p-0:U11:coding:@context-v1");
    expect(coordinatorFields(original)).toMatchObject({ coordinatorAttempt: 0 });
  });
  it("persists the typed unit association independently of the idempotency string", () => {
    expect(coordinatorFields(coordinator)).toMatchObject({ coordinatorUnit: "U11" });
    expect(
      coordinatorFields({ parentInstanceId: coordinator.parentInstanceId, idempotencyKey: coordinator.idempotencyKey }),
    ).not.toHaveProperty("coordinatorUnit");
  });
});
