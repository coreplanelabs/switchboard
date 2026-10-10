// Feature: docs/reference/specs/load-harness.md — actual offline HTTP proof and comparable receipts.
import { describe, expect, it } from "vitest";
import { runModelCapacity, compareModelCapacity } from "./modelCapacity.js";
import { execFileSync } from "node:child_process";

describe("offline model capacity", () => {
  it("completes two calls per caller, returns all credits and compares settings without hiding environment changes", async () => {
    const current = await runModelCapacity({
      profile: "test",
      clients: 2,
      turns: 2,
      requestKiB: 1,
      frameKiB: 1,
      baselineMiB: 0,
      providerDelayMs: 0,
      minConcurrent: 2,
      noQueue: true,
    });
    expect(current.checks.find((check) => check.name === "all credits returned")).toEqual({
      name: "all credits returned",
      pass: true,
    });
    expect(current.metrics).toMatchObject({
      calls: 4,
      exact: 4,
      attempts: 4,
      peakActive: 2,
      peakQueued: 0,
      final: { active: 0, queued: 0, storageBytes: 0 },
    });
    const reordered = {
      ...current,
      environment: Object.fromEntries(Object.entries(current.environment).reverse()) as typeof current.environment,
    };
    expect(compareModelCapacity(current, reordered).comparable).toBe(true);
    const changed = { ...current, settings: { ...current.settings, workers: 16 } };
    expect(compareModelCapacity(current, changed)).toMatchObject({
      comparable: true,
      settingsChanged: ["workers"],
      delta: { callP95Ms: 0, healthP95Ms: 0 },
    });
    const other = { ...current, environment: { ...current.environment, cpuMax: "different quota" } };
    expect(compareModelCapacity(current, other)).toMatchObject({
      comparable: false,
      reasons: ["runtime or quota changed"],
    });
  });
  it("the load CLI advertises repeatable model capacity without requiring Docker or credentials for help", () => {
    const help = execFileSync(process.execPath, ["--import", "tsx", "scripts/load.ts", "model-capacity", "--help"], {
      encoding: "utf8",
    });
    expect(help).toContain("model-capacity");
    expect(help).toContain("--baseline");
  });
});
