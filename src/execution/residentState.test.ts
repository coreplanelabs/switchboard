import { describe, expect, it } from "vitest";
import { degradedIsServiceable, isServiceable, SERVICEABLE_STATES } from "./residentState.js";

// Feature: docs/reference/specs/resident-repos.md item 24 — the bot's attach decision per
// resident lifecycle state. `degraded` is serviceable only for reason classes
// that leave the checkout + dep cache intact (fetch/bookkeeping failures); a
// failure inside the rebuild lock section (checkout-update/install/build/
// snapshot) can leave a broken cache that a fresh thread would hardlink, so
// those stay cold until the next cycle rebuilds.

describe("isServiceable", () => {
  it("warm and refreshing attach regardless of reason", () => {
    expect(isServiceable("warm")).toBe(true);
    expect(isServiceable("refreshing", "")).toBe(true);
  });

  it("engine-owned states never attach", () => {
    for (const s of ["onboarding", "restoring", "down"]) expect(isServiceable(s, "anything")).toBe(false);
    expect(isServiceable("not-onboarded")).toBe(false);
    expect(isServiceable("bogus-state")).toBe(false);
  });

  it("degraded attaches only for fetch/bookkeeping reasons (checkout intact)", () => {
    expect(isServiceable("degraded", "github-unreachable: fetch timed out after 300000ms")).toBe(true);
    expect(isServiceable("degraded", "alarm-missed: refresh chain was dead; re-armed by watchdog")).toBe(true);
  });

  it("degraded stays cold for any failure inside the rebuild, an orphaned mid-flight marker, or an unknown reason", () => {
    for (const r of [
      // the orphaned cycle may have died inside the rebuild lock section
      "stale-mid-flight: refreshing since 2026-08-29T20:00:00Z with no cycle running; re-armed by watchdog",
      "install-failed: npm ERR! ERESOLVE",
      "build-failed: tsc exited 2",
      "checkout-update-failed: git reset --hard failed",
      "snapshot-failed: createBackup timed out",
      "refresh-failed: something else",
      "facts-failed: no repo facts recorded despite hydration",
      // a full disk cannot take a worktree, a credential file, or even
      // /etc/gitconfig.lock — attaching would fail at git-setup every time
      "disk-full: fetch Failed to write file '/workspace/.resident/git-credentials': ENOSPC: no space left on device (/workspace: 0 KiB free)",
      "",
      undefined,
      "github-unreachable-ish-but-not: x", // prefix must end at a word boundary
    ]) {
      expect(isServiceable("degraded", r), String(r)).toBe(false);
    }
    expect(degradedIsServiceable("github-unreachable")).toBe(true);
  });

  it("the serviceable set is exactly warm/refreshing/degraded", () => {
    expect([...SERVICEABLE_STATES].sort()).toEqual(["degraded", "refreshing", "warm"]);
  });
});
