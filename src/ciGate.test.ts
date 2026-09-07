import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { failedJobs, parseNeeds } from "../scripts/ci-gate.mjs";

// `bot` and `workers` are required status checks that stand for a fan-out of
// matrix jobs (.github/workflows/ci.yml). The gate job passes its `needs`
// context to scripts/ci-gate.mjs; the gate is green only when every upstream
// job succeeded — a leg that failed, was cancelled, or never ran fails it.

const script = fileURLToPath(new URL("../scripts/ci-gate.mjs", import.meta.url));

function runGate(needs: string | undefined): { code: number; out: string } {
  const env = { ...process.env };
  delete env.NEEDS;
  if (needs !== undefined) env.NEEDS = needs;
  try {
    return { code: 0, out: execFileSync(process.execPath, [script], { env, encoding: "utf8", stdio: "pipe" }) };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

describe("failedJobs", () => {
  it("is empty when every upstream job succeeded", () => {
    expect(failedJobs({ a: { result: "success" }, b: { result: "success" } })).toEqual([]);
  });

  it.each(["failure", "cancelled", "skipped"])("names a job whose result is %s", (result) => {
    expect(failedJobs({ ok: { result: "success" }, bad: { result } })).toEqual([{ id: "bad", result }]);
  });

  it("treats a job with no result as failed (never green by omission)", () => {
    expect(failedJobs({ ghost: undefined })).toEqual([{ id: "ghost", result: "missing" }]);
  });
});

describe("parseNeeds", () => {
  it("rejects an unset value with the fix in the message", () => {
    expect(() => parseNeeds(undefined)).toThrow(/toJSON\(needs\)/);
  });

  it.each(["{}", "[]", "null", '"x"'])("rejects %s — a gate with nothing upstream guards nothing", (raw) => {
    expect(() => parseNeeds(raw)).toThrow(/no jobs/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseNeeds("{nope")).toThrow();
  });
});

describe("npm run ci:gate", () => {
  it("exits 0 and lists each job when all succeeded", () => {
    const r = runGate(JSON.stringify({ "bot-checks": { result: "success" }, "bot-tests": { result: "success" } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("bot-checks: success");
    expect(r.out).toContain("ci:gate ok — 2 upstream job(s) succeeded");
  });

  it("exits 1 naming the failed leg", () => {
    const r = runGate(JSON.stringify({ "bot-checks": { result: "success" }, "bot-tests": { result: "failure" } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("ci:gate FAILED — bot-tests failure");
  });

  it("exits 1 when a leg was skipped or cancelled", () => {
    expect(runGate(JSON.stringify({ x: { result: "skipped" } })).code).toBe(1);
    expect(runGate(JSON.stringify({ x: { result: "cancelled" } })).code).toBe(1);
  });

  it("exits 1 with NEEDS unset or empty", () => {
    expect(runGate(undefined).code).toBe(1);
    expect(runGate("{}").code).toBe(1);
  });
});
