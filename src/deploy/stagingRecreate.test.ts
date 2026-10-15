import { describe, expect, it } from "vitest";
import {
  planStagingRecreation,
  recreateStaging,
  StagingDependencyFieldsError,
  stagingRestorationSecrets,
  STAGING_RESTORATION_KEYS,
} from "./stagingRecreate.js";
import { TEST_PROFILE } from "./testing/profile.js";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const source = { commit: "a".repeat(40), configSha256: "b".repeat(64) };

function fixture() {
  const profile = structuredClone(TEST_PROFILE);
  for (const worker of Object.values(profile.workers))
    worker.script = worker.script.replace("switchboard", "switchboard-staging");
  const names = Object.values(profile.workers).map((worker) => worker.script);
  const envelope = <T>(result: T[]) => ({ success: true, result });
  const inventory = {
    scripts: envelope(names.map((id) => ({ id }))),
    applications: envelope([
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "switchboard-staging-switchboardserver",
        durable_objects: { namespace_id: "2".repeat(32) },
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "switchboard-staging-resident-residentdo",
        durable_objects: { namespace_id: "3".repeat(32) },
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "switchboard-staging-sandbox-switchboardsandbox",
        durable_objects: { namespace_id: "4".repeat(32) },
      },
    ]),
    namespaces: envelope(
      names.map((script, index) => ({ id: String(index + 1).repeat(32), script, name: script + "_State" })),
    ),
    workflows: envelope([
      { name: "switchboard-staging-ship-coordinator", script_name: "switchboard-staging" },
      { name: "switchboard-staging-resident-refresh", script_name: "switchboard-staging-resident" },
    ]),
    dependencies: Object.fromEntries(
      names.map((name) => [
        name,
        {
          references: {
            services: { incoming: [], outgoing: [] },
            durable_objects: [],
            domains: [{ service: name, hostname: name + ".example.test" }],
          },
          tails: [],
        },
      ]),
    ) as Record<string, { references: Record<string, unknown>; tails: unknown[] }>,
  };
  return { profile, inventory, production: "f".repeat(32) };
}

describe("staging installation recreation", () => {
  it("retains bounded dependency field shapes without provider values when an unknown field refuses", () => {
    const h = fixture();
    h.inventory.dependencies["switchboard-staging"].references = {
      unfamiliar: { target: "must-not-appear", credential: "secret-value" },
    };
    let refused: unknown;
    try {
      planStagingRecreation(h.profile, h.production, h.inventory, source);
    } catch (error) {
      refused = error;
    }
    expect((refused as Error).message).toBe(
      "staging dependency kind is unverified for switchboard-staging: unfamiliar",
    );
    expect(refused).toBeInstanceOf(StagingDependencyFieldsError);
    expect((refused as StagingDependencyFieldsError).diagnostic).toEqual({
      worker: "switchboard-staging",
      fieldCount: 1,
      fields: [{ name: "unfamiliar", type: "object", keyCount: 2, keys: ["credential", "target"] }],
    });
    expect(JSON.stringify((refused as StagingDependencyFieldsError).diagnostic)).not.toContain("secret-value");
    expect(JSON.stringify((refused as StagingDependencyFieldsError).diagnostic)).not.toContain("must-not-appear");
    h.inventory.dependencies["switchboard-staging"].references = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field_${i}`, "not-printed"]),
    );
    try {
      planStagingRecreation(h.profile, h.production, h.inventory, source);
    } catch (error) {
      refused = error;
    }
    expect((refused as StagingDependencyFieldsError).diagnostic.fieldCount).toBe(20);
    expect((refused as StagingDependencyFieldsError).diagnostic.fields).toHaveLength(8);
    h.inventory.dependencies["switchboard-staging"].references = {
      "invalid field\nprivate-fragment": ["not-retained"],
    };
    try {
      planStagingRecreation(h.profile, h.production, h.inventory, source);
    } catch (error) {
      refused = error;
    }
    expect((refused as StagingDependencyFieldsError).diagnostic.fields).toEqual([
      { name: "unrecognized-field", type: "array", length: 1 },
    ]);
    expect((refused as Error).message).toBe(
      "staging dependency kind is unverified for switchboard-staging: unrecognized-field",
    );
  });
  it("accepts the published Wrangler dependency shape and preserves selected incoming Worker dependencies", () => {
    const h = fixture();
    h.inventory.dependencies["switchboard-staging"].references = {
      services: {
        incoming: [{ name: "BOT", service: "switchboard-staging-memory", environment: "production" }],
        outgoing: [],
        pages_function: false,
      },
      durable_objects: [
        {
          name: "Coordinator",
          service: "switchboard-staging-memory",
          environment: "production",
          durable_object_namespace_id: "2".repeat(32),
          durable_object_namespace_name: "Coordinator",
        },
      ],
      dispatch_outbounds: [],
    };
    expect(
      planStagingRecreation(h.profile, h.production, h.inventory, source)
        .deletions.filter((e) => e.kind === "worker")
        .map((e) => e.name),
    ).toEqual([
      "switchboard-staging-memory",
      "switchboard-staging",
      "switchboard-staging-resident",
      "switchboard-staging-sandbox",
    ]);
  });
  it("requires only the exact restoration roster and matching original CI bearers", () => {
    const values = Object.fromEntries(STAGING_RESTORATION_KEYS.map((name) => [name, `${name}-fixture-value`]));
    const restored = stagingRestorationSecrets(JSON.stringify(values), values, {});
    expect(restored.MEMORY_TOKEN).toBe("MEMORY_TOKEN-fixture-value");
    expect(restored.GITHUB_APP_PRIVATE_KEY).toBe("GITHUB_APP_PRIVATE_KEY-fixture-value");
    expect(() =>
      stagingRestorationSecrets(JSON.stringify({ ...values, OPENAI_ADMIN_KEY: "must-not-be-copied" }), values, {}),
    ).toThrow("undeclared name");
    const { SLACK_BOT_TOKEN: _missing, ...incomplete } = values;
    expect(() => stagingRestorationSecrets(JSON.stringify(incomplete), values, {})).toThrow("roster is incomplete");
    expect(() =>
      stagingRestorationSecrets(JSON.stringify(values), { ...values, RESIDENT_DRAIN_TOKEN: "different" }, {}),
    ).toThrow("match the original staging CI inputs");
    expect(() => stagingRestorationSecrets('{"private": "secret-fragment', values, {})).toThrowError(
      "staging runtime secret bundle is invalid",
    );
  });
  it("refuses a configured provider key outside the exact restoration roster", () => {
    const values = Object.fromEntries(STAGING_RESTORATION_KEYS.map((name) => [name, `${name}-fixture-value`]));
    expect(
      stagingRestorationSecrets(JSON.stringify(values), values, {
        openai: { apiKeyEnv: "OPENAI_API_KEY" },
        anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
      }).OPENAI_API_KEY,
    ).toBe("OPENAI_API_KEY-fixture-value");
    for (const apiKeyEnv of ["OPENROUTER_API_KEY", "toString"])
      expect(() => stagingRestorationSecrets(JSON.stringify(values), values, { external: { apiKeyEnv } })).toThrow(
        "configured provider key cannot be restored",
      );
  });
  it.each([
    [0, "11111111-1111-4111-8111-111111111111"],
    [1, "22222222-2222-4222-8222-222222222222"],
    [2, "33333333-3333-4333-8333-333333333333"],
  ] as const)("requires positive ownership of application %i before any deletion", async (index, id) => {
    const h = fixture();
    const plan = planStagingRecreation(h.profile, h.production, h.inventory, source);
    expect(plan.deletions[index].path).toBe(`/accounts/${"1234567890abcdef".repeat(2)}/containers/applications/${id}`);
    const application: Record<string, unknown> = h.inventory.applications.result[index];
    for (const namespace of ["missing", "unknown", "foreign", "other-selected-worker"] as const) {
      application.durable_objects =
        namespace === "missing"
          ? {}
          : {
              namespace_id: namespace === "unknown" ? "e".repeat(32) : "1".repeat(32),
            };
      h.inventory.namespaces.result[0].script =
        namespace === "foreign" ? "production-worker" : "switchboard-staging-memory";
      let deleted = 0;
      await expect(async () => {
        const proposed = planStagingRecreation(h.profile, h.production, h.inventory, source);
        await recreateStaging(proposed.sha256, {
          preflight: async () => {},
          readPlan: async () => planStagingRecreation(h.profile, h.production, h.inventory, source),
          remove: async () => {
            deleted++;
          },
          absent: async () => {},
          initialize: async () => {},
          record: async () => {},
        });
      }).rejects.toThrow("application namespace ownership is unverified");
      expect(deleted).toBe(0);
    }
  });
  it("plans only the selected staging resources and deletes Memory before its Bot dependency", () => {
    const { profile, inventory, production } = fixture();
    const plan = planStagingRecreation(profile, production, inventory, source);
    expect(plan.deletions.map((entry) => [entry.kind, entry.name])).toEqual([
      ["application", "switchboard-staging-switchboardserver"],
      ["application", "switchboard-staging-resident-residentdo"],
      ["application", "switchboard-staging-sandbox-switchboardsandbox"],
      ["workflow", "switchboard-staging-ship-coordinator"],
      ["workflow", "switchboard-staging-resident-refresh"],
      ["worker", "switchboard-staging-memory"],
      ["worker", "switchboard-staging"],
      ["worker", "switchboard-staging-resident"],
      ["worker", "switchboard-staging-sandbox"],
    ]);
    expect(plan.account).toBe("1234567890abcdef".repeat(2));
  });

  it("refuses production, retained maintenance, foreign dependencies and incomplete provider inventory", () => {
    const h = fixture();
    expect(() => planStagingRecreation(h.profile, h.profile.account, h.inventory, source)).toThrow(
      "separate staging account",
    );
    expect(() =>
      planStagingRecreation({ ...h.profile, residentMaintenance: {} as never }, h.production, h.inventory, source),
    ).toThrow("ordinary profile");
    h.inventory.dependencies["switchboard-staging"].references = {
      services: { incoming: [{ service: "production-bot" }] },
    };
    expect(() => planStagingRecreation(h.profile, h.production, h.inventory, source)).toThrow(
      "outside the selected staging installation",
    );
    h.inventory.dependencies["switchboard-staging"].references = { unknown_kind: [] };
    expect(() => planStagingRecreation(h.profile, h.production, h.inventory, source)).toThrow(
      "staging dependency kind is unverified",
    );
    h.inventory.dependencies["switchboard-staging"].references = {};
    h.inventory.scripts = { ...h.inventory.scripts, result_info: { total_pages: 2 } } as typeof h.inventory.scripts;
    expect(() => planStagingRecreation(h.profile, h.production, h.inventory, source)).toThrow(
      "inventory is incomplete",
    );
  });

  it("requires the approved exact plan and positive absence before first installation", async () => {
    const h = fixture();
    const plan = planStagingRecreation(h.profile, h.production, h.inventory, source);
    const observed: string[] = [];
    const io = {
      preflight: async () => {},
      readPlan: async () => plan,
      remove: async (entry: { name: string }) => {
        observed.push(entry.name);
      },
      absent: async () => {
        observed.push("absence-proved");
      },
      initialize: async () => {
        observed.push("initialized");
      },
      record: async (phase: string) => {
        observed.push(phase);
      },
    };
    await expect(recreateStaging("0".repeat(64), io)).rejects.toThrow("approved staging reset plan changed");
    expect(observed).toEqual([]);
    const result = await recreateStaging(plan.sha256, io);
    expect(result).toEqual({ status: "recreated", planSha256: plan.sha256, acceptance: "not-run" });
    expect(observed).toEqual([
      "deleting",
      ...plan.deletions.map((entry) => entry.name),
      "absence-proved",
      "initializing",
      "initialized",
      "recreated",
    ]);
  });

  it("stops an uncertain delete or missing absence proof without retry or initialization", async () => {
    const h = fixture();
    const plan = planStagingRecreation(h.profile, h.production, h.inventory, source);
    const state = { deletes: 0, initialized: 0 };
    const io = {
      preflight: async () => {},
      readPlan: async () => plan,
      remove: async (): Promise<void> => {
        state.deletes++;
        throw new Error("delete outcome unknown");
      },
      absent: async () => {},
      initialize: async () => {
        state.initialized++;
      },
      record: async () => {},
    };
    await expect(recreateStaging(plan.sha256, io)).rejects.toThrow("delete outcome unknown");
    expect(state).toEqual({ deletes: 1, initialized: 0 });
    io.remove = async () => {
      state.deletes++;
    };
    io.absent = async () => {
      throw new Error("old namespace still exists");
    };
    await expect(recreateStaging(plan.sha256, io)).rejects.toThrow("old namespace still exists");
    expect(state).toEqual({ deletes: 10, initialized: 0 });
  });

  it("refuses to delete when runtime secret restoration is unavailable", async () => {
    const h = fixture();
    const plan = planStagingRecreation(h.profile, h.production, h.inventory, source);
    const state = { deletes: 0, initialized: 0 };
    await expect(
      recreateStaging(plan.sha256, {
        preflight: async () => {
          throw new Error("runtime secret restoration unavailable");
        },
        readPlan: async () => plan,
        remove: async () => {
          state.deletes++;
        },
        absent: async () => {},
        initialize: async () => {
          state.initialized++;
        },
        record: async () => {},
      }),
    ).rejects.toThrow("runtime secret restoration unavailable");
    expect(state).toEqual({ deletes: 0, initialized: 0 });
  });
});

describe("staging recreation workflow", () => {
  const workflow = parse(readFileSync(".github/workflows/recreate-staging.yml", "utf8"));
  it("qualifies the candidate with the trusted main controller before running candidate code", () => {
    const steps = workflow.jobs.recreate.steps;
    const controller = steps.find((step: { with?: { path?: string } }) => step.with?.path === "controller");
    expect(controller?.with.ref).toBe("${{ github.workflow_sha }}");
    const recheck = steps.findIndex((step: { id?: string }) => step.id === "recheck");
    expect(steps[recheck]["working-directory"]).toBe("controller");
    const candidateInstall = steps.findIndex(
      (step: { run?: string; "working-directory"?: string }) =>
        step.run === "npm ci" && step["working-directory"] === "candidate",
    );
    expect(candidateInstall).toBeGreaterThan(recheck);
  });
  it("keeps recreation behind the original staging lock without publishing acceptance", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs.recreate.concurrency).toEqual({
      group: "deploy-staging",
      queue: "max",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.recreate.environment).toBe("staging");
    expect(workflow.jobs.recreate.if).toContain("github.run_attempt == 1");
    expect(workflow.jobs.recreate.name).toBe("staging / explicit recreation");
    expect(workflow.jobs.recreate.outputs).toBeUndefined();
  });
  it.each(["", "a".repeat(64)])("passes destructive authority only with an explicit approved plan: %s", (approved) => {
    const step = workflow.jobs.recreate.steps.find(
      (step: { name?: string }) => step.name === "plan or recreate the selected staging installation once",
    );
    const directory = mkdtempSync(join(tmpdir(), "staging-recreation-workflow-"));
    const receipt = join(directory, "argv.json");
    try {
      writeFileSync(
        join(directory, "npm"),
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.ARGV_RECEIPT, JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o700 },
      );
      const result = spawnSync("bash", ["-e", "-c", step.run], {
        encoding: "utf8",
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          ARGV_RECEIPT: receipt,
          APPROVED_PLAN: approved,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([
        "run",
        "--silent",
        "staging:deploy",
        "--",
        "--recreate",
        "--receipt",
        join(directory, "staging-recreation.json"),
        ...(approved ? ["--apply", approved] : []),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
