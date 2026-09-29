import { describe, expect, it } from "vitest";
import { nextDeployImageReconcile, replacementContainerStarted } from "./imageReconcileState";

describe("nextDeployImageReconcile", () => {
  const build = "a".repeat(40);
  const newer = "b".repeat(40);

  it("starts a cycle for a new Worker build, even when an older build left a pending report", () => {
    expect(nextDeployImageReconcile(build, undefined, false)).toBe("start");
    expect(nextDeployImageReconcile(newer, { build, cycleIssued: true }, true)).toBe("start");
  });

  it("keeps a verified report on another reconcile of the same build", () => {
    expect(nextDeployImageReconcile(build, { build, cycleIssued: true }, false)).toBe("verified");
    expect(nextDeployImageReconcile(build, { build, cycleIssued: false }, false)).toBe("verified");
  });

  it("retries only a cycle that was deferred; a stopped container waits for its own report", () => {
    expect(nextDeployImageReconcile(build, { build, cycleIssued: false }, true)).toBe("retry-cycle");
    expect(nextDeployImageReconcile(build, { build, cycleIssued: true }, true)).toBe("await-report");
  });
});

describe("replacementContainerStarted", () => {
  it("requires two known and different boot IDs before treating a reused disk as a fresh container", () => {
    expect(replacementContainerStarted("old", "new")).toBe(true);
    expect(replacementContainerStarted("old", "old")).toBe(false);
    expect(replacementContainerStarted(undefined, "new")).toBe(false);
    expect(replacementContainerStarted("old", undefined)).toBe(false);
  });
});
