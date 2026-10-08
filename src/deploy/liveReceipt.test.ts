import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const workflow = parse(readFileSync(".github/workflows/deploy-production.yml", "utf8"));
const receipt = Object.values(workflow.jobs as Record<string, { steps: { name?: string; run?: string }[] }>)
  .flatMap((job) => job.steps)
  .find((step) => step.name === "what is live")!.run!;
const ready = {
  draining: null,
  count: 1,
  residents: [{ resource: "repo:acme/api", live: { imageReport: "current" } }],
};

function runReceipt(
  opts: {
    health?: unknown;
    registry?: unknown;
    token?: string;
    plan?: string;
    httpFailure?: boolean;
    emptyHealth?: boolean;
    emptyRegistry?: boolean;
    packageCommit?: string;
    selected?: boolean;
    deployOutcome?: string;
    acceptance?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "live-receipt-"));
  try {
    const plan = {
      root: opts.packageCommit ? { mode: "package", commit: opts.packageCommit } : { mode: "checkout" },
      steps:
        opts.selected === false
          ? []
          : [
              {
                name: "resident",
                script: "resident",
                wakeUrl: "https://resident.example.test/healthz",
                drain: { url: "https://resident.example.test" },
              },
            ],
    };
    writeFileSync(join(dir, "plan.json"), opts.plan ?? JSON.stringify(plan));
    writeFileSync(
      join(dir, "health-fixture.json"),
      opts.emptyHealth ? "" : JSON.stringify(opts.health ?? { ok: true, build: { commit: HEAD } }),
    );
    writeFileSync(join(dir, "registry.json"), opts.emptyRegistry ? "" : JSON.stringify(opts.registry ?? ready));
    writeFileSync(join(dir, "cli"), '#!/bin/bash\ncat "$RUNNER_TEMP/plan.json"\n', { mode: 0o755 });
    writeFileSync(
      join(dir, "curl"),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$RUNNER_TEMP/reads"
if [[ "\${*: -1}" == */residents ]]; then cat "$RUNNER_TEMP/registry.json"; else cat "$RUNNER_TEMP/health-fixture.json"; fi
exit ${opts.httpFailure ? 22 : 0}
`,
      { mode: 0o755 },
    );
    const script = opts.acceptance
      ? Object.values(workflow.jobs as Record<string, { steps: { name?: string; run?: string }[] }>)
          .flatMap((job) => job.steps)
          .find((step) => step.name === "deployment acceptance receipt")!.run!
      : receipt;
    writeFileSync(join(dir, "receipt.sh"), script);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", join(dir, "receipt.sh")], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
        GITHUB_SHA: HEAD,
        CLI: join(dir, "cli"),
        LABEL: "release",
        RESIDENT_READ_TOKEN: opts.token ?? "read-fixture",
        DEPLOY_OUTCOME: opts.deployOutcome ?? "success",
        SMOKE_REQUIRED: "true",
        SMOKE_OUTCOME: "skipped",
      },
    });
    return {
      code: result.status,
      output: result.stdout + result.stderr,
      summary: readFileSync(join(dir, "summary"), "utf8"),
      reads: (() => {
        try {
          return readFileSync(join(dir, "reads"), "utf8");
        } catch {
          return "";
        }
      })(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Each case executes the release shell with real jq and curl processes. A CI
// shard can spend more than Vitest's 5s default under concurrent jobs. Keep
// the case budget above the child timeout so a hung shell fails by name.
describe("what is live deployment receipt", { timeout: 35_000 }, () => {
  it("retains a truthful local cancelled acceptance receipt without smoke or readiness credit", () => {
    const result = runReceipt({ deployOutcome: "cancelled", acceptance: true });
    expect(result.code).toBe(0);
    expect(result.summary).toContain("Deployment cancelled. Earlier completed uploads may remain");
    expect(result.summary).toContain("Capability acceptance: not run — deployment cancelled");
    expect(result.summary).toContain("drain cleanup remain unconfirmed");
    expect(result.summary).not.toContain("Capability acceptance: passed");
    expect(result.reads).toBe("");
    const incomplete = runReceipt({ acceptance: true });
    expect(incomplete.code).toBe(1);
    expect(incomplete.summary).toContain("failed or incomplete");
  });

  it("reports cancellation locally without starting health reads", () => {
    const normal = runReceipt();
    expect(normal.code).toBe(0);
    expect(normal.summary).toContain("Selected Workers match the exact source commit");
    expect(normal.reads).toContain("/healthz");
    const cancelled = runReceipt({ deployOutcome: "cancelled" });
    expect(cancelled.code).toBe(0);
    expect(cancelled.summary).toContain("Readiness not read: deployment cancelled");
    expect(cancelled.reads).toBe("");
  });

  it("the executable workflow fails a healthy Worker when registry image reports are pending", () => {
    const r = runReceipt({
      registry: {
        ...ready,
        draining: { holds: ["repo:acme/api"] },
        residents: [{ resource: "repo:acme/api", live: { imageReport: "pending" } }],
      },
    });
    expect(r.code).toBe(1);
    expect(r.summary).toContain("repo:acme/api");
    expect(r.summary).not.toContain("Deployed:");
  });

  it.each([
    { health: { ok: true } },
    { health: { ok: true, build: { commit: OTHER } } },
    { health: { ok: true, build: { commit: HEAD.slice(0, 7) } } },
    { health: { ok: false, build: { commit: HEAD } } },
    { registry: { ...ready, residents: [{ resource: "repo:acme/api", live: { imageReport: "pending" } }] } },
    { registry: { ...ready, draining: { holds: [] } } },
    { registry: { residents: [] } },
    { registry: { ...ready, count: 2 } },
    { registry: { ...ready, residents: [{ resource: "repo:acme/api", live: { error: "unreachable" } }] } },
    { token: "" },
    { httpFailure: true },
    { emptyHealth: true },
    { emptyRegistry: true },
    { plan: "" },
    { plan: "not JSON" },
    { packageCommit: "unknown" },
  ])("fails closed on missing identity, unreadable evidence or registry mismatch: %j", (opts) => {
    expect(runReceipt(opts).code).toBe(1);
  });

  it("passes only the frozen selected fleet with exact commits and current undrained reports", () => {
    expect(runReceipt().code).toBe(0);
    expect(runReceipt({ selected: false, health: { ok: false } }).code).toBe(0);
  });

  it("package mode compares its source commit, not the operator repository commit", () => {
    expect(runReceipt({ packageCommit: OTHER, health: { ok: true, build: { commit: OTHER } } }).code).toBe(0);
    expect(runReceipt({ packageCommit: OTHER }).code).toBe(1);
  });

  it("the receipt shell parses without contacting production", () => {
    expect(() => execFileSync("bash", ["-n"], { input: receipt })).not.toThrow();
  });
});
