import { describe, expect, it } from "vitest";
import { busyAfterKillReason, busyReason, planForceDetach } from "./residentDetach.js";

const poolUsers = ["worker2", "worker3", "worker17"];

describe("planForceDetach (force-detach kills the thread's in-flight processes)", () => {
  it("nothing in flight → proceed, force or not", () => {
    expect(planForceDetach({ force: false, inFlight: 0, user: "worker2", poolUsers })).toEqual({ action: "proceed" });
    expect(planForceDetach({ force: true, inFlight: 0, user: "worker2", poolUsers })).toEqual({ action: "proceed" });
  });

  it("non-force with an op in flight keeps today's busy guard exactly", () => {
    expect(planForceDetach({ force: false, inFlight: 2, user: "worker2", poolUsers })).toEqual({
      action: "refuse",
      reason: "busy: 2 operation(s) in flight on this thread — kept",
    });
  });

  it("force with an op in flight kills the pool user's processes", () => {
    expect(planForceDetach({ force: true, inFlight: 1, user: "worker17", poolUsers })).toEqual({
      action: "kill",
      user: "worker17",
      inFlight: 1,
    });
  });

  it.each(["root", "", "worker1", "worker18", "nobody"])(
    "force never kills as a non-pool user (%j) — refuses with a named reason",
    (user) => {
      const plan = planForceDetach({ force: true, inFlight: 1, user, poolUsers });
      expect(plan.action).toBe("refuse");
      if (plan.action !== "refuse") throw new Error("unreachable");
      expect(plan.reason).toBe(
        `busy: 1 operation(s) in flight on this thread — kept; refusing to kill: "${user}" is not a pool user`,
      );
    },
  );

  it("reason strings carry the count", () => {
    expect(busyReason(3)).toBe("busy: 3 operation(s) in flight on this thread — kept");
    expect(busyAfterKillReason(1)).toBe("busy after kill: 1 op(s) still in flight — kept");
  });
});
