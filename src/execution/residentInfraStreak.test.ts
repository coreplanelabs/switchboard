import { describe, expect, it } from "vitest";
import {
  INFRA_STREAK_DOWN_AT,
  INFRA_STREAK_RECREATE_AT,
  infraStreakReason,
  infraStreakRung,
  isInfraStreakReason,
  isRepoCommandStep,
  parksOnRepeat,
  REPO_COMMAND_STEPS,
  stepOfFailedReason,
} from "./residentInfraStreak.js";

// A refresh cycle that keeps failing in the resident's OWN steps (git against
// the mirror, probes, markers, restores) says nothing about the repository —
// it says the container or the disk is wrong — and heals the way item 64's
// runtime-unreachable ladder does: recreate the container, then go down into
// item 36's transition rebuild. A cycle that fails in the repository's own
// commands (the onboard-time command table) is evidence about the repo: it
// keeps parking, as before, and heals when the head is fixed
// (docs/reference/specs/resident-repos.md item 67).

describe("which step is whose", () => {
  it("the command-table steps are the repository's: install, build, test — and nothing else", () => {
    expect([...REPO_COMMAND_STEPS].sort()).toEqual(["build", "deps-install", "test"]);
    for (const step of REPO_COMMAND_STEPS) expect(isRepoCommandStep(step), step).toBe(true);
    for (const step of [
      "fetch",
      "checkout-update",
      "measure",
      "snapshot",
      "ready-stamp",
      "df",
      "refresh",
      "wake-fetch",
    ]) {
      expect(isRepoCommandStep(step), step).toBe(false);
    }
  });

  it("the stale-process sweep before a repo step is the resident's own machinery, not the repo's command", () => {
    expect(isRepoCommandStep("build-stale-sweep")).toBe(false);
    expect(isRepoCommandStep("deps-install-stale-sweep")).toBe(false);
  });

  it("the step is read off a `<step>-failed:` reason; any other reason has none", () => {
    expect(stepOfFailedReason("build-failed: exit 1: tsc")).toBe("build");
    expect(stepOfFailedReason("checkout-update-failed: exit 128: fatal: Could not parse object 'abc'")).toBe(
      "checkout-update",
    );
    expect(stepOfFailedReason("refresh-failed: The operation was aborted")).toBe("refresh");
    expect(stepOfFailedReason("github-unreachable: 503")).toBeNull();
    expect(stepOfFailedReason("disk-full: install: ENOSPC")).toBeNull();
    expect(stepOfFailedReason("")).toBeNull();
  });

  it("a degraded reason parks on repeat only when it is evidence about the repo or GitHub — a resident-step failure climbs the ladder instead and must never park", () => {
    // The week's data: one resident's `deps-install-failed: … configured to
    // use bun` parked (right — nothing a rebuild fixes); another's
    // `checkout-update-failed: Could not parse object` would have parked too
    // had it repeated, and that one IS ours to fix.
    expect(parksOnRepeat("deps-install-failed: exit 1: ERROR This project is configured to use bun")).toBe(true);
    expect(parksOnRepeat("build-failed: exit 1: tsc")).toBe(true);
    expect(parksOnRepeat("github-unreachable: 503 from api.github.com")).toBe(true);
    expect(parksOnRepeat("checkout-update-failed: exit 128: fatal: Could not parse object 'abc'")).toBe(false);
    expect(parksOnRepeat("fetch-failed: exit 128: fatal: not a git repository")).toBe(false);
    expect(parksOnRepeat("refresh-failed: The operation was aborted")).toBe(false);
  });
});

describe("the ladder over consecutive resident-step failures", () => {
  it("counts to the recreate rung, gives the recreated container one cycle of its own, then goes down", () => {
    expect(INFRA_STREAK_RECREATE_AT).toBe(3);
    expect(INFRA_STREAK_DOWN_AT).toBe(5);
    expect([1, 2, 3, 4, 5, 6].map(infraStreakRung)).toEqual(["count", "count", "recreate", "count", "down", "down"]);
    expect(() => infraStreakRung(0)).toThrow(RangeError);
  });

  const row = {
    step: "checkout-update",
    count: 3,
    firstAt: "2026-09-15T23:51:47.824Z",
    lastAt: "2026-09-16T00:11:47.001Z",
  };

  it("the recreate reason names the count, the step and what happens next; it is an infra-streak reason and a rehydration-flavored one", () => {
    const reason = infraStreakReason(row, "recreate");
    expect(reason).toBe(
      "infra-streak: 3 consecutive cycles failed in the resident's own steps (last: checkout-update, since 2026-09-15T23:51:47.824Z) — the container was destroyed, snapshots kept; the next cycle restores from the snapshot",
    );
    expect(isInfraStreakReason(reason)).toBe(true);
  });

  it("the down reason says a recreated container failed the same way and that a rebuild follows", () => {
    const reason = infraStreakReason({ ...row, count: 5 }, "down");
    expect(reason).toBe(
      "infra-streak: 5 consecutive cycles failed in the resident's own steps (last: checkout-update, since 2026-09-15T23:51:47.824Z) — a recreated container failed the same way; rebuilding",
    );
    expect(isInfraStreakReason(reason)).toBe(true);
    expect(isInfraStreakReason("checkout-update-failed: exit 128")).toBe(false);
  });
});
