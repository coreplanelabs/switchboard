import { describe, expect, it } from "vitest";
import { checkoutUpdateCommand, planRefresh, type RefreshDisk } from "./residentRefresh.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

const disk = (over: Partial<RefreshDisk> = {}): RefreshDisk => ({ head: OLD, installedKey: KEY_A, builtSha: OLD, ...over });

describe("planRefresh (#163: lockfile-hash install gate + on-disk checkpoints)", () => {
  it("default branch did not move → unchanged, whatever the disk says", () => {
    expect(planRefresh({ sha: OLD, factsSha: OLD, lockfileKey: KEY_A, disk: disk() })).toEqual({ action: "unchanged" });
    expect(
      planRefresh({ sha: OLD, factsSha: OLD, lockfileKey: KEY_B, disk: disk({ head: null, installedKey: null, builtSha: null }) }),
    ).toEqual({ action: "unchanged" });
  });

  it("sha moved, committed lockfile unchanged → rebuild WITHOUT install, deps kept through the clean", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk() });
    expect(plan).toMatchObject({ action: "rebuild", install: false, clean: "keep-deps" });
    expect(plan.action === "rebuild" && plan.why).toMatch(/lockfile unchanged/);
  });

  it("sha moved, committed lockfile changed → full clean + install", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_B, disk: disk() });
    expect(plan).toMatchObject({ action: "rebuild", install: true, clean: "all" });
    expect(plan.action === "rebuild" && plan.why).toMatch(/lockfile changed/);
  });

  it("no deps marker on disk (pre-#163 container, or a full clean that was interrupted) → conservative full install", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ installedKey: null }) });
    expect(plan).toMatchObject({ action: "rebuild", install: true, clean: "all" });
    expect(plan.action === "rebuild" && plan.why).toMatch(/no deps marker/);
  });

  it("checkpoint hit: checkout HEAD, built marker and deps key all already match → reuse (snapshot only)", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: NEW, builtSha: NEW }) });
    expect(plan).toMatchObject({ action: "reuse" });
    expect(plan.action === "reuse" && plan.why).toMatch(/already materialized/);
  });

  it("built marker matches but the checkout HEAD does not → never reuse; rebuild on the kept deps", () => {
    expect(planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: OLD, builtSha: NEW }) })).toMatchObject({
      action: "rebuild",
      install: false,
      clean: "keep-deps",
    });
    expect(planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: null, builtSha: NEW }) })).toMatchObject({
      action: "rebuild",
      install: false,
    });
  });

  it("checkout at the new sha but the build never finished → keep deps, rebuild only", () => {
    expect(planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: NEW, builtSha: OLD }) })).toMatchObject({
      action: "rebuild",
      install: false,
      clean: "keep-deps",
    });
    expect(planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: NEW, builtSha: null }) })).toMatchObject({
      action: "rebuild",
      install: false,
    });
  });

  it("checkout and build markers match the sha but the deps key does not → full install, never reuse", () => {
    expect(planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_B, disk: disk({ head: NEW, builtSha: NEW }) })).toMatchObject({
      action: "rebuild",
      install: true,
      clean: "all",
    });
  });
});

describe("checkoutUpdateCommand", () => {
  it("keep-deps: cleans every gitignored/untracked path EXCEPT node_modules (fresh build inodes, deps preserved)", () => {
    const cmd = checkoutUpdateCommand(NEW, "keep-deps");
    expect(cmd).toContain(`git reset --hard --quiet ${NEW}`);
    expect(cmd).toContain("git clean -fdx -e node_modules");
  });

  it("keep-deps: sweeps the build-written caches inside node_modules at any depth (they open+truncate hardlinked inodes)", () => {
    const cmd = checkoutUpdateCommand(NEW, "keep-deps");
    expect(cmd).toContain("find . -path '*/node_modules/*' -type d \\( -name .cache -o -name .vite \\) -prune -exec rm -rf {} +");
    // The sweep runs after the clean, so it never races git over the same paths.
    expect(cmd.indexOf("git clean")).toBeLessThan(cmd.indexOf("find ."));
  });

  it("all: the unconditional -x clean (deps are about to be reinstalled), no cache sweep needed", () => {
    const cmd = checkoutUpdateCommand(NEW, "all");
    expect(cmd).toContain(`git reset --hard --quiet ${NEW}`);
    expect(cmd).toMatch(/git clean -fdx$/);
    expect(cmd).not.toContain("-e node_modules");
    expect(cmd).not.toContain("find .");
  });
});
