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
    writeFileSync(join(dir, "receipt.sh"), receipt);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", join(dir, "receipt.sh")], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
        GITHUB_SHA: HEAD,
        CLI: join(dir, "cli"),
        LABEL: "release",
        RESIDENT_READ_TOKEN: opts.token ?? "read-fixture",
      },
    });
    return {
      code: result.status,
      output: result.stdout + result.stderr,
      summary: readFileSync(join(dir, "summary"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("what is live deployment receipt", () => {
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
