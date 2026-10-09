import { describe, expect, it } from "vitest";
import { stagingValidation, type ValidationCheck } from "./stagingCi.js";

const commit = "a".repeat(40);
const checks: ValidationCheck[] = [
  ...["change plan", "bot", "web", "docs", "workers", "image", "package"].map((name, i) => ({
    id: i + 1,
    name: `ci / ${name}`,
    status: "completed",
    conclusion: "success",
    app: { slug: "depot-code-access" },
  })),
  { id: 10, name: "pr-title / title", status: "completed", conclusion: "success", app: { slug: "depot-code-access" } },
  { id: 11, name: "CodeQL", status: "completed", conclusion: "success", app: { slug: "github-advanced-security" } },
  { id: 12, name: "zizmor", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
];
const input = () => ({
  repository: "example/gateway",
  commit,
  permission: "write",
  pull: {
    number: 1,
    state: "open",
    user: { login: "maintainer" },
    head: {
      ref: "release-please--branches--main--components--switchboard",
      sha: commit,
      repo: { full_name: "example/gateway" },
    },
  },
  checks: structuredClone(checks),
});

describe("staging validation before credentials", () => {
  it("admits only the current trusted head after validation and package smoke finish", () => {
    expect(stagingValidation(input())).toEqual({ kind: "ready" });
    expect(stagingValidation({ ...input(), automatic: true, permission: undefined })).toEqual({ kind: "ready" });
    const skipped = input();
    skipped.checks
      .filter((check) => ["ci / web", "ci / docs", "ci / package"].includes(check.name))
      .forEach((check) => {
        check.conclusion = "skipped";
      });
    expect(stagingValidation(skipped)).toEqual({ kind: "ready" });
  });
  it("automatically stages release PRs and keeps ordinary PR staging opt-in", () => {
    const ordinary = input();
    ordinary.pull.head.ref = "feature/change";
    expect(stagingValidation({ ...ordinary, automatic: true, permission: undefined })).toEqual({
      kind: "refused",
      reason: "not_a_release",
    });
    expect(stagingValidation(ordinary)).toEqual({ kind: "ready" });
    expect(stagingValidation({ ...input(), automatic: true, permission: undefined })).toEqual({ kind: "ready" });
  });
  it("refuses a fork, closed pull, moved head and a manual actor without repository write access", () => {
    const fork = input();
    fork.pull.head.repo.full_name = "outside/gateway";
    expect(stagingValidation(fork)).toEqual({ kind: "refused", reason: "fork" });
    const closed = input();
    closed.pull.state = "closed";
    expect(stagingValidation(closed)).toEqual({ kind: "refused", reason: "closed" });
    const moved = input();
    moved.pull.head.sha = "b".repeat(40);
    expect(stagingValidation(moved)).toEqual({ kind: "refused", reason: "head_changed" });
    expect(stagingValidation({ ...input(), permission: "read" })).toEqual({
      kind: "refused",
      reason: "actor_not_trusted",
    });
  });
  it("waits for pending or absent checks and refuses failed validation", () => {
    const pending = input();
    pending.checks[0].status = "in_progress";
    pending.checks[0].conclusion = null;
    expect(stagingValidation(pending)).toEqual({ kind: "waiting", reason: "ci / change plan" });
    const missing = input();
    missing.checks = missing.checks.filter((check) => check.name !== "ci / package");
    expect(stagingValidation(missing)).toEqual({ kind: "waiting", reason: "ci / package" });
    const failed = input();
    failed.checks[0].conclusion = "failure";
    expect(stagingValidation(failed)).toEqual({ kind: "refused", reason: "validation_failed:ci / change plan" });
  });
  it("uses the newest result from the expected app and ignores checks from another app", () => {
    const spoof = input();
    spoof.checks[0].app.slug = "different-app";
    expect(stagingValidation(spoof)).toEqual({ kind: "waiting", reason: "ci / change plan" });
    const rerun = input();
    rerun.checks.push({ ...checks[0], id: 100, conclusion: "failure" });
    expect(stagingValidation(rerun)).toEqual({ kind: "refused", reason: "validation_failed:ci / change plan" });
  });
});
