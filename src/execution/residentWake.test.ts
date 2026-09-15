import { describe, expect, it } from "vitest";
import {
  WAKE_WAIT_MAX_MS,
  isContainerRolling,
  sandboxRestartedMessage,
  wakeDecision,
  wakeWaitBudget,
} from "./residentWake.js";

// Feature: docs/reference/specs/resident-repos.md item 65: a resident container
// that exited under a live run (the container rollout after a resident Worker
// deploy) is gone for about a minute, not for good. These are the pure
// decisions the client makes before it counts a strike: which refusals name a
// rolling container, whether the engine view says the container is coming
// back, and how long the wait may take.

describe("isContainerRolling: the refusals that name a container gone for a moment", () => {
  it("recognizes the incident's answer and its rollout siblings", () => {
    for (const error of [
      "not-serviceable: The container just exited",
      "not-serviceable: The container is not running, consider calling start()",
      "not-serviceable: Process supervisor is closed",
      "not-serviceable: Container is starting. Please retry in a moment.",
      "not-serviceable: the sandbox lifetime is no longer current",
      "image-stale: the container predates the current pool and is restarting; retry shortly",
    ]) {
      expect(isContainerRolling(error), error).toBe(true);
    }
  });

  it("leaves every other refusal to the rules that already own it", () => {
    for (const error of [
      "not-serviceable: registry record or repo facts missing",
      "not-serviceable: resident is not provisioned yet, nothing to hydrate",
      "not-serviceable: no-snapshot: resident has no recorded snapshot to rehydrate from",
      "mirror-busy: the mirror is locked by a refresh",
      "runtime-replaced: the resident runtime was replaced (a deploy) while this command ran",
      "worktree-missing: still gone",
      "The container just exited",
      "",
      undefined,
      42,
    ]) {
      expect(isContainerRolling(error), String(error)).toBe(false);
    }
  });
});

describe("wakeDecision: the engine view says whether the container is coming back", () => {
  const status = (state: string, reason = "") => ({ kind: "status" as const, state, reason });

  it("waits while the engine holds a snapshot the container wakes from: restoring, warm, refreshing, degraded with an intact checkout", () => {
    for (const probe of [
      status("restoring", "rehydrating"),
      status("warm"),
      status("refreshing", "fetching"),
      status("degraded", "github-unreachable: fetch failed"),
    ]) {
      const decision = wakeDecision(probe);
      expect(decision.wait, probe.state).toBe(true);
      expect(decision.why).toContain(probe.state);
    }
  });

  it("waits through the degraded reasons the engine retries on its own", () => {
    for (const reason of [
      "restore-interrupted: the runtime was replaced under the restore",
      "runtime-unreachable: the container's control port did not answer within 30 s (attempt 2 of 6)",
      "stale-mid-flight: the last instance x is not running",
    ]) {
      expect(wakeDecision(status("degraded", reason)).wait, reason).toBe(true);
    }
  });

  it("strikes on a definite answer no wake recovers from, naming it", () => {
    for (const probe of [
      status("down", "no-snapshot: nothing to rehydrate from"),
      status("degraded", "disk-full: 0 KiB free"),
      status("degraded", "install-failed: exit 1"),
      status("onboarding"),
      status("not-onboarded"),
      status("unknown"),
    ]) {
      const decision = wakeDecision(probe);
      expect(decision.wait, probe.state).toBe(false);
      expect(decision.why).toContain(probe.state);
    }
  });

  it("strikes when the resident Worker itself did not answer: nothing says the container is coming back", () => {
    const decision = wakeDecision({ kind: "unreachable", error: "fetch failed", transport: true });
    expect(decision.wait).toBe(false);
    expect(decision.why).toContain("fetch failed");
  });
});

describe("wakeWaitBudget: the wait is the command's budget under a three-minute ceiling", () => {
  it("is the ceiling with no command budget, the command budget when smaller, the ceiling when larger, never negative", () => {
    expect(WAKE_WAIT_MAX_MS).toBe(3 * 60_000);
    expect(wakeWaitBudget(undefined)).toBe(WAKE_WAIT_MAX_MS);
    expect(wakeWaitBudget(20_000)).toBe(20_000);
    expect(wakeWaitBudget(10 * 60_000)).toBe(WAKE_WAIT_MAX_MS);
    expect(wakeWaitBudget(0)).toBe(0);
    expect(wakeWaitBudget(-5)).toBe(0);
    expect(wakeWaitBudget(Number.NaN)).toBe(WAKE_WAIT_MAX_MS);
  });
});

describe("sandboxRestartedMessage: what the model is told about the tree it comes back to", () => {
  it("names the wait, the fresh worktree's ref and short sha, and that uncommitted and unpushed work is gone", () => {
    const text = sandboxRestartedMessage({ waitedMs: 53_400, ref: "main", sha: "abc1234def5678" });
    expect(text).toContain("53s");
    expect(text).toContain("main@abc1234");
    expect(text).toMatch(/uncommitted/);
    expect(text).toMatch(/unpushed/);
  });
});
