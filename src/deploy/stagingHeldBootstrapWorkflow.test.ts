import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("held bootstrap workflow", () => {
  const source = readFileSync(".github/workflows/deploy-staging-bootstrap.yml", "utf8");
  const workflow = parse(source);
  it("has a manual-only distinct status behind the original shared staging lock", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs.bootstrap.name).toBe("staging / bootstrap held");
    expect(workflow.jobs.bootstrap.environment).toBe("staging");
    expect(workflow.jobs.bootstrap.concurrency).toEqual({
      group: "deploy-staging",
      queue: "max",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.validate.if).toContain("github.run_attempt == 1");
    expect(workflow.jobs.bootstrap.if).toContain("github.run_attempt == 1");
    expect(workflow.jobs.bootstrap).not.toHaveProperty("outputs.accepted");
    expect(source).not.toContain("staging / full stack");
    expect(source).not.toContain("staging / Review E2E");
  });
  it("gives only staging deploy/read/drain credentials after the exact head recheck", () => {
    const steps = workflow.jobs.bootstrap.steps;
    const recheck = steps.findIndex((step: any) => step.id === "recheck");
    const deploy = steps.findIndex((step: any) => step.name === "install the held Resident support once");
    expect(deploy).toBeGreaterThan(recheck);
    expect(steps[deploy].env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.STAGING_CLOUDFLARE_DEPLOY_TOKEN }}");
    expect(steps[deploy].env.RESIDENT_READ_TOKEN).toBe("${{ secrets.STAGING_RESIDENT_READ_TOKEN }}");
    expect(steps[deploy].env.RESIDENT_DRAIN_TOKEN).toBe("${{ secrets.STAGING_RESIDENT_DRAIN_TOKEN }}");
    expect(source).not.toMatch(
      /secrets\.(?:RESIDENT_ADMIN|STAGING_ADMIN|CLOUDFLARE_API_TOKEN|MEMORY_TOKEN|SANDBOX_TOKEN)/,
    );
    for (const step of steps.filter((step: any) => step.uses?.startsWith("actions/checkout")))
      expect(step.with["persist-credentials"]).toBe(false);
    expect(steps.find((step: any) => step.id === "config-token").with["permission-contents"]).toBe("read");
  });
});
