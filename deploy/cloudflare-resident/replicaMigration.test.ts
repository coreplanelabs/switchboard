import { describe, expect, it } from "vitest";
import { placementHistoryThreads, replicaMaintenanceFence } from "./replicaMigration";

describe("replica activation maintenance", () => {
  const fence = {
    since: "2026-01-01T00:00:00.000Z",
    until: "2026-01-01T01:00:00.000Z",
    swapVersion: "original-worker",
    swapAt: "2026-01-01T00:05:00.000Z",
  };
  const drain = { ...fence, reason: "deploy", by: "operator", swapFence: true };
  const now = Date.parse("2026-01-01T00:15:00.000Z");
  it("requires the same live swap fence and only its own reconciliation permit", () => {
    const permits = new Map([["deploy:admission:reconcile", { kind: "reconcile" }]]);
    expect(replicaMaintenanceFence(drain, permits, "reconcile", now)).toEqual(fence);
    expect(
      replicaMaintenanceFence(
        drain,
        new Map([...permits, ["deploy:admission:foreign", { kind: "resident-call" }]]),
        "reconcile",
        now,
      ),
    ).toBeUndefined();
    expect(replicaMaintenanceFence(drain, permits, "missing", now)).toBeUndefined();
    expect(
      replicaMaintenanceFence(drain, new Map([["deploy:admission:reconcile", { kind: "watchdog" }]]), "reconcile", now),
    ).toBeUndefined();
    expect(
      replicaMaintenanceFence(drain, permits, "reconcile", now, { ...fence, swapVersion: "other-worker" }),
    ).toBeUndefined();
    expect(replicaMaintenanceFence(drain, permits, "reconcile", Date.parse(fence.until) + 1)).toBeUndefined();
  });
  it("imports evicted, partially attached and historical owners without reading private files", () => {
    expect(
      placementHistoryThreads(
        new Map<string, unknown>([
          ["thread:mcp:default:evicted", { evicted: true }],
          ["runFence:mcp:default:attaching", { ownerFence: 1 }],
          ["uid:g:user:worker34", "thread:mcp:default:reserved"],
          ["uid:g:owner:hash", { owner: "thread:mcp:default:reserved", user: "worker34" }],
          [
            "resident:spentPoolUsers",
            [
              { user: "worker2", owner: "thread:mcp:default:legacy" },
              { user: "worker3", owner: "op:build" },
            ],
          ],
          ["resident:state", "warm"],
        ]),
      ),
    ).toEqual(["mcp:default:attaching", "mcp:default:evicted", "mcp:default:legacy", "mcp:default:reserved"]);
    expect(() => placementHistoryThreads(new Map([["runFence:invalid", {}]]))).toThrow("history could not be verified");
    expect(() => placementHistoryThreads(new Map([["uid:g:user:worker34", null]]))).toThrow(
      "UID history could not be verified",
    );
  });
});
