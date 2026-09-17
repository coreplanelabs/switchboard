import { describe, expect, it } from "vitest";
import {
  CONTAINER_GONE_WORDING,
  WAKE_WAIT_MAX_MS,
  containerGoneMessage,
  isContainerRolling,
  sandboxRestartedMessage,
  saysContainerGone,
  saysControlReset,
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
  it("the platform's gone-for-a-moment wording is one exported list, so the harness's container seam composes it instead of keeping a second copy", () => {
    expect(CONTAINER_GONE_WORDING.test("The container just exited")).toBe(true);
    expect(CONTAINER_GONE_WORDING.test("Container is starting. Please retry in a moment.")).toBe(true);
    expect(CONTAINER_GONE_WORDING.test("The container is not running, consider calling start()")).toBe(false);
    expect(CONTAINER_GONE_WORDING.flags).toBe("i");
  });

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

// Feature: docs/reference/specs/resident-repos.md items 43 and 27 — the two
// answers that say the container under the thread is gone, which /exec hands
// back as the typed restart the pi harness keys on (harness-pi.md item 16).
describe("saysContainerGone: the answers that say the container under the thread is gone", () => {
  it("is the resident's runtime-replaced and the preflight's worktree-missing, and none of the answers that leave the container standing", () => {
    expect(
      saysContainerGone({ error: "runtime-replaced: the resident runtime was replaced", reason: "runtime-replaced" }),
    ).toBe(true);
    expect(
      saysContainerGone({
        error: "worktree-missing: the container disk was recycled since the last attach — POST /attach to recreate",
        needs: "attach",
      }),
    ).toBe(true);
    for (const data of [
      {
        error: "evicted: this thread's worktree was evicted after inactivity — POST /attach to recreate",
        needs: "attach",
      },
      { error: "not-attached: no binding for this threadKey — POST /attach first", needs: "attach" },
      { error: "not-serviceable: The container just exited", state: "warm" },
      { error: "worktree-missing: mentioned without needs" },
      { stdout: "fine", exitCode: 0 },
      // A DO control reset leaves the container standing: never container-gone.
      { error: "control-reset: the DO was reset", reason: "control-reset" },
      {},
    ]) {
      expect(saysContainerGone(data), JSON.stringify(data)).toBe(false);
    }
  });

  it("containerGoneMessage carries the resident's own words and that the command was not run again", () => {
    expect(containerGoneMessage(" runtime-replaced: deploy ")).toBe(
      "runtime-replaced: deploy; the command was not run again",
    );
  });
});

describe("saysControlReset: a DO reset over a live container, distinct from a replacement", () => {
  it("is exactly the resident's control-reset reason, and never a runtime-replaced, a worktree-missing or a plain result", () => {
    expect(saysControlReset({ error: "control-reset: the DO was reset", reason: "control-reset" })).toBe(true);
    for (const data of [
      { error: "runtime-replaced: the resident runtime was replaced", reason: "runtime-replaced" },
      { error: "worktree-missing: recycled", needs: "attach" },
      { error: "the text says control-reset but the reason does not", reason: "runtime-replaced" },
      { stdout: "fine", exitCode: 0 },
      {},
    ]) {
      expect(saysControlReset(data), JSON.stringify(data)).toBe(false);
    }
  });
});
