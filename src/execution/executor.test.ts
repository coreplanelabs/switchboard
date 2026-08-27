import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalOperations } from "./executor.js";

// Feature: features/resident-repos.md — U6 LocalOperations: the dev-only
// second Operations implementation (≥2-implementations invariant, KTD8).
// No command table and no refs locally — fixed Node conventions run in the
// thread's local workspace dir, and a requested ref is honestly reported as
// ignored. A failing command is a RESULT (ok:false), never an error path.

function workspace(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "swb-localops-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

describe("LocalOperations", () => {
  it("status reports a missing workspace as ok:false (dev-only, no resident lifecycle)", async () => {
    const ops = new LocalOperations(join(tmpdir(), "swb-localops-nonexistent"));
    const res = await ops.run("status", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: false });
    if (res.kind === "result") expect(res.summary).toMatch(/no local workspace/i);
  });

  it("status reports an existing workspace as ok:true", async () => {
    const dir = workspace({ name: "x", version: "0.0.0" });
    const res = await ops(dir).run("status", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
  });

  it("test runs `npm test` and a passing run is ok:true", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: "node -e \"console.log('local-ok')\"" } });
    const res = await ops(dir).run("test", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
    if (res.kind === "result") {
      expect(res.summary).toMatch(/test .*passed/i);
      expect(res.output).toContain("local-ok");
    }
  });

  it("a failing test run is a RESULT with a named failure, not an error", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: "node -e \"process.exit(1)\"" } });
    const res = await ops(dir).run("test", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: false });
    if (res.kind === "result") expect(res.summary).toMatch(/failed/i);
  });

  it("build uses --if-present so a script-less package still passes", async () => {
    const dir = workspace({ name: "x", version: "0.0.0" });
    const res = await ops(dir).run("build", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
  });

  it("a requested ref is honestly reported as ignored (local mode has no refs)", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: "node -e \"0\"" } });
    const res = await ops(dir).run("test", { repo: "acme/api", ref: "main" });
    if (res.kind === "result") expect(res.summary).toMatch(/ref .*ignored/i);
  });

  // Local mode has no onboard-time repo binding, so "for <repo>" is an intent
  // claim, not a verified checkout — the summary must disclose the workspace
  // was not verified to hold req.repo (mirrors the ref-not-verified note).
  it("a run against an existing workspace discloses it was not verified to hold the repo (local mode)", async () => {
    const dir = workspace({ name: "x", version: "0.0.0", scripts: { test: "node -e \"0\"" } });
    const res = await ops(dir).run("test", { repo: "acme/api" });
    if (res.kind === "result") expect(res.summary).toMatch(/workspace not verified to hold acme\/api \(local mode\)/);
  });

  it("status on an existing workspace also discloses it was not verified to hold the repo", async () => {
    const dir = workspace({ name: "x", version: "0.0.0" });
    const res = await ops(dir).run("status", { repo: "acme/api" });
    expect(res).toMatchObject({ kind: "result", ok: true });
    if (res.kind === "result") expect(res.summary).toMatch(/workspace not verified to hold acme\/api \(local mode\)/);
  });
});

function ops(dir: string): LocalOperations {
  return new LocalOperations(dir);
}
