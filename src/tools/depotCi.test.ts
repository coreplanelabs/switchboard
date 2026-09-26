import { describe, expect, it, vi } from "vitest";
import { TOOLSETS } from "./toolsets.js";
import type { ToolContext } from "./runnableTool.js";

const context = () =>
  ({
    executor: { exec: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() },
    depotCi: { call: vi.fn(async () => ({ text: "FAIL test: expected true got false" })) },
  }) as unknown as ToolContext;
const names = ["depot_ci_inspect", "depot_ci_logs", "depot_ci_retry_failed"];
const tool = (name: string) => TOOLSETS.full.find((t) => t.name === name)!;

describe("Depot CI tools", () => {
  it("gives coding children inspection, logs and failed-only retry but no other preset", () => {
    for (const name of names) {
      expect(tool(name), name).toBeDefined();
      for (const [set, tools] of Object.entries(TOOLSETS))
        if (set !== "full") expect(tools.map((t) => t.name)).not.toContain(name);
    }
    expect(tool(names[0]).sideEffectFree).toBe(true);
    expect(tool(names[1]).sideEffectFree).toBe(true);
    expect(tool(names[2]).sideEffectFree).not.toBe(true);
  });

  it("accepts a Depot check link as an identity, not a fetch URL", async () => {
    const ctx = context();
    const out = await tool(names[0]).run(
      { workflow: "https://depot.dev/orgs/org-one/workflows/workflow-one?job=test&attempt=attempt-one" },
      ctx,
    );
    expect(ctx.depotCi!.call).toHaveBeenCalledWith({ operation: "inspect", workflowId: "workflow-one" }, undefined);
    expect(out).toContain("FAIL test");
    expect(out).toContain("UNTRUSTED");
  });

  it("refuses broad inputs and wrong URL hosts before the bridge", async () => {
    const ctx = context();
    for (const input of [
      { workflow: "workflow-one", repo: "other/private" },
      { workflow: "https://evil.example/orgs/x/workflows/y" },
      { workflow: "workflow-one", token: "secret" },
      { workflow: "https://user:pass@depot.dev/orgs/x/workflows/y" },
    ])
      expect(await tool(names[0]).run(input, ctx)).toContain("invalid");
    expect(await tool(names[2]).run({ workflow: "workflow-one", expectedHead: "abc" }, ctx)).toContain("invalid");
    expect(ctx.depotCi!.call).not.toHaveBeenCalled();
  });

  it("passes only typed log selection and exact-head failed-only intent", async () => {
    const ctx = context();
    await tool(names[1]).run({ workflow: "workflow-one", jobId: "job-one", lines: 400, attemptId: "attempt-one" }, ctx);
    expect(ctx.depotCi!.call).toHaveBeenLastCalledWith(
      { operation: "logs", workflowId: "workflow-one", jobId: "job-one", lines: 400, attemptId: "attempt-one" },
      undefined,
    );
    await tool(names[2]).run({ workflow: "workflow-one", expectedHead: "a".repeat(40) }, ctx);
    expect(ctx.depotCi!.call).toHaveBeenLastCalledWith(
      { operation: "retry_failed", workflowId: "workflow-one", expectedHead: "a".repeat(40) },
      undefined,
    );
  });

  it("reports unavailable context and sanitized failures without exposing a credential", async () => {
    for (const name of names)
      expect(await tool(name).run({}, { executor: {} } as ToolContext)).toContain("unavailable");
    const ctx = context();
    vi.mocked(ctx.depotCi!.call).mockRejectedValue(new Error("private upstream body"));
    const out = await tool(names[0]).run({ workflow: "workflow-one" }, ctx);
    expect(out).not.toContain("private upstream body");
    expect(out).toContain("failed");
  });
});
