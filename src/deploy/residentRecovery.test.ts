import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { TEST_PROFILE } from "./testing/profile.js";
import {
  qualifyResidentRecovery,
  recoverResidentDeployment,
  residentRecoveryHash,
  type ResidentRecoveryIO,
  type ResidentRecoveryPlan,
} from "./residentRecovery.js";

const plan: ResidentRecoveryPlan = {
  commit: "a".repeat(40),
  workerVersion: "11111111-1111-4111-8111-111111111111",
  fence: {
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-01T01:30:00.000Z",
    by: "deploy all",
    reason: "deploy aaaaaaa",
    swapFence: true,
    swapVersion: "22222222-2222-4222-8222-222222222222",
    swapAt: "2026-10-01T00:00:01.000Z",
    swapBuild: "old",
    swapAcquisitionId: "33333333-3333-4333-8333-333333333333",
  },
  imageTarget: { application: "staging-resident-residentdo", version: 7, image: "registry.test/resident@sha256:abc" },
};

function fixture() {
  const actions: string[] = [];
  const journal: string[] = [];
  const registry: Record<string, unknown> = {
    count: 0,
    residents: [],
    inFlight: 0,
    inFlightUnknown: 0,
    draining: structuredClone(plan.fence),
    stagingMaintenance: null,
  };
  const observation = {
    commit: plan.commit,
    workerVersion: plan.workerVersion,
    imageTarget: plan.imageTarget,
    registry,
  };
  const io: ResidentRecoveryIO = {
    observe: async () => structuredClone(observation),
    record: async (phase) => {
      journal.push(phase);
    },
    reconcile: async (target) => {
      actions.push("reconcile");
      return { status: 200, body: { reconciled: [], imageTarget: target } };
    },
    reopen: async () => {
      actions.push("reopen");
      registry.draining = null;
      return { status: 200, body: { cleared: true, draining: null } };
    },
  };
  return { io, registry, observation, actions, journal };
}

describe("recoverResidentDeployment", () => {
  it("finishes an exact prior upload and verifies reopened admission without another upload", async () => {
    const h = fixture();
    expect(await recoverResidentDeployment(plan, h.io)).toEqual({ state: "reopened" });
    expect(h.actions).toEqual(["reconcile", "reopen"]);
    expect(h.journal).toEqual([
      "reconcile-requested",
      "reconcile-answered",
      "reopen-requested",
      "reopen-answered",
      "reopened",
    ]);
  });

  it("keeps a changed upload or fence held before starting recovery", async () => {
    for (const change of ["commit", "version", "image", "fence", "inflight", "maintenance"]) {
      const h = fixture();
      if (change === "commit") h.observation.commit = "b".repeat(40);
      if (change === "version") h.observation.workerVersion = "44444444-4444-4444-8444-444444444444";
      if (change === "image") h.observation.imageTarget = { ...plan.imageTarget, version: 8 };
      if (change === "fence") h.registry.draining = { ...plan.fence, swapAcquisitionId: "changed" };
      if (change === "inflight") h.registry.inFlight = 1;
      if (change === "maintenance") h.registry.stagingMaintenance = { state: "held" };
      expect(await recoverResidentDeployment(plan, h.io), change).toMatchObject({
        state: "held",
        reason: expect.any(String),
      });
      expect(h.actions, change).toEqual([]);
    }
  });

  it("does not reopen or repeat a reconciliation whose reply is unknown", async () => {
    const h = fixture();
    h.io.reconcile = async () => {
      h.actions.push("reconcile");
      return { error: "transport unavailable" };
    };
    expect(await recoverResidentDeployment(plan, h.io)).toEqual({ state: "held", reason: "reconcile-unverified" });
    expect(h.actions).toEqual(["reconcile"]);
    expect(h.journal).toEqual(["reconcile-requested", "reconcile-unverified"]);
  });

  it("rechecks the original target after reconciliation before reopening", async () => {
    const h = fixture();
    h.io.reconcile = async (target) => {
      h.actions.push("reconcile");
      h.registry.draining = { ...plan.fence, until: "2026-10-01T02:00:00.000Z" };
      return { status: 200, body: { reconciled: [], imageTarget: target } };
    };
    expect(await recoverResidentDeployment(plan, h.io)).toMatchObject({
      state: "held",
      reason: "selected-fence-changed",
    });
    expect(h.actions).toEqual(["reconcile"]);
  });

  it("retains an acknowledged reopen as unverified until the registry confirms it", async () => {
    const h = fixture();
    h.io.reopen = async () => ({ status: 200, body: { cleared: true, draining: null } });
    expect(await recoverResidentDeployment(plan, h.io)).toEqual({
      state: "held",
      reason: "reopen-readback-unverified",
    });
  });

  it("a failed journal write prevents the next mutation", async () => {
    const h = fixture();
    h.io.record = async () => {
      throw new Error("journal unavailable");
    };
    await expect(recoverResidentDeployment(plan, h.io)).rejects.toThrow("journal unavailable");
    expect(h.actions).toEqual([]);
  });
});

describe("qualifyResidentRecovery", () => {
  function input() {
    const h = fixture();
    return {
      repository: "acme/gateway",
      account: "1".repeat(32),
      script: "staging-resident",
      hostname: "resident.staging.test",
      controller: {
        status: "completed",
        conclusion: "cancelled",
        path: ".github/workflows/deploy-staging.yml",
        repository: { full_name: "acme/gateway" },
      },
      artifactPlan: {
        root: { mode: "checkout", commit: plan.commit },
        profile: {
          selection: {
            account: "1".repeat(32),
            workers: { resident: { script: "staging-resident", hostname: "resident.staging.test" } },
          },
        },
      },
      observed: {
        ...h.observation,
        imageTarget: {
          ...plan.imageTarget,
          image: `registry.cloudflare.com/${"1".repeat(32)}/staging-resident-residentdo@sha256:${"f".repeat(64)}`,
        },
      },
      log: "",
    };
  }
  function receipt() {
    const v = input();
    v.log = `[deploy:all] ▶ resident (staging-resident)\n[resident-deploy-fence-acquisition] {"id":"33333333-3333-4333-8333-333333333333","phase":"requested"}\n[build-stamp] ${plan.commit} @ 2026-10-01T00:00:02.000Z\nContainer application changes\nEDIT staging-resident-residentdo\n+ "image": "${v.observed.imageTarget.image}"\nCurrent Version ID: ${plan.workerVersion}\n`;
    return v;
  }

  it("selects the uploaded Resident from the original terminal controller artifact", () => {
    const v = receipt();
    const qualified = qualifyResidentRecovery(v);
    expect(qualified).toEqual({ ...plan, imageTarget: v.observed.imageTarget });
    expect(residentRecoveryHash(qualified)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses live controllers and foreign, incomplete or changed upload receipts", () => {
    for (const change of ["live", "repository", "account", "source", "version", "acquisition", "image"]) {
      const v = receipt();
      if (change === "live") v.controller.status = "in_progress";
      if (change === "repository") v.controller.repository.full_name = "other/repo";
      if (change === "account") v.account = "2".repeat(32);
      if (change === "source") v.observed.commit = "b".repeat(40);
      if (change === "version") v.observed.workerVersion = "44444444-4444-4444-8444-444444444444";
      if (change === "acquisition") v.log = v.log.replace('"phase":"requested"', '"phase":"sealed"');
      if (change === "image") v.observed.imageTarget.image = "registry.test/unrelated";
      expect(() => qualifyResidentRecovery(v), change).toThrow();
    }
  });
});

describe("staging Resident recovery CLI", () => {
  it.each([
    { mode: "matched", at: 0, lost: false, expected: ["/reconcile", "/undrain"] },
    { mode: "matched", at: 0, lost: true, expected: ["/reconcile"] },
    { mode: "version", at: 2, lost: false, expected: [] },
    { mode: "image", at: 3, lost: false, expected: ["/reconcile"] },
    { mode: "missing", at: 3, lost: false, expected: ["/reconcile"] },
    { mode: "version", at: 4, lost: false, expected: ["/reconcile", "/undrain"] },
    { mode: "missing", at: 4, lost: false, expected: ["/reconcile", "/undrain"] },
  ])(
    "keeps $mode direct evidence at read $at qualified and never repeats effects (lost reply: $lost)",
    ({ mode, at, lost, expected }) => {
      const directory = mkdtempSync(join(tmpdir(), "resident-recovery-cli-"));
      try {
        const account = "1".repeat(32);
        const workers = Object.fromEntries(
          Object.entries(TEST_PROFILE.workers).map(([kind, worker]) => [
            kind,
            {
              ...worker,
              script: `gateway-staging-${kind}`,
              hostname: `${kind}.staging.test`,
            },
          ]),
        );
        const config = parse(readFileSync("config/config.example.yaml", "utf8"));
        for (const key of ["runHistory", "runtimeOverrides", "memory"])
          config[key] = { worker: { baseUrl: "https://memory.staging.test" } };
        config.grants = { "http:staging": { actions: ["dispatch"], channels: ["http:staging"] } };
        config.execution = {
          type: "cloudflare",
          url: "https://sandbox.staging.test",
          resident: { baseUrl: "https://resident.staging.test" },
        };
        config.artifacts = { r2: { accountId: account, bucket: "gateway-staging-artifacts" } };
        config.metrics = { dataset: "gateway_staging_runs" };
        const configPath = join(directory, "config.yaml");
        const profilePath = join(directory, "profile.json");
        writeFileSync(configPath, stringify(config));
        const profile = {
          ...TEST_PROFILE,
          zone: "staging.test",
          account,
          workers,
          configSource: configPath,
          artifacts: { bucket: "gateway-staging-artifacts" },
          metrics: { dataset: "gateway_staging_runs" },
        };
        writeFileSync(profilePath, JSON.stringify(profile));
        const image = `registry.cloudflare.com/${account}/gateway-staging-resident-residentdo@sha256:${"f".repeat(64)}`;
        const artifactPlan = { root: { mode: "checkout", commit: plan.commit }, profile: { selection: profile } };
        const log = `[deploy:all] ▶ resident (gateway-staging-resident)\n[resident-deploy-fence-acquisition] {"id":"33333333-3333-4333-8333-333333333333","phase":"requested"}\n[build-stamp] ${plan.commit} @ 2026-10-01T00:00:02.000Z\nContainer application changes\nEDIT gateway-staging-resident-residentdo\n+ "image": "${image}"\nCurrent Version ID: ${plan.workerVersion}\n`;
        writeFileSync(join(directory, "log"), log);
        writeFileSync(join(directory, "plan"), JSON.stringify(artifactPlan));
        const bin = join(directory, "bin");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "gh"),
          `#!${process.execPath}\nconst p=process.argv[3];process.stdout.write(p.endsWith('/zip')?'archive':JSON.stringify(p.includes('/artifacts')?{artifacts:[{id:1,name:'staging-deploy-123-1',expired:false}]}:{run_attempt:1,status:'completed',conclusion:'cancelled',path:'.github/workflows/deploy-staging.yml',repository:{full_name:'acme/gateway'}}));`,
          { mode: 0o700 },
        );
        writeFileSync(
          join(bin, "unzip"),
          `#!${process.execPath}\nprocess.stdout.write(require('fs').readFileSync(require('path').join(process.env.RECOVERY_FIXTURE,process.argv[4]==='staging-deploy.log'?'log':'plan')));`,
          { mode: 0o700 },
        );
        const preload = join(directory, "fetch.mjs");
        writeFileSync(
          preload,
          `import{readFileSync,writeFileSync,appendFileSync}from'node:fs';
globalThis.fetch=async(url,options={})=>{const state=JSON.parse(readFileSync(process.env.RECOVERY_STATE,'utf8'));const u=new URL(url);let data;
if(options.method==='POST'){appendFileSync(process.env.RECOVERY_EFFECTS,JSON.stringify({path:u.pathname,body:JSON.parse(options.body)})+'\\n');if(u.pathname==='/reconcile'){if(process.env.RECOVERY_LOST==='1')throw Error('reply unavailable');data={reconciled:[],imageTarget:JSON.parse(options.body).imageTarget};}else if(u.pathname==='/undrain'){state.draining=null;writeFileSync(process.env.RECOVERY_STATE,JSON.stringify(state));data={cleared:true,draining:null};}else throw Error('unexpected mutation');}
else if(u.pathname==='/healthz')data={ok:true,build:{commit:'${plan.commit}'}};
else if(u.pathname==='/residents')data=state;
else if(u.pathname.endsWith('/deployments'))data={success:true,result:{deployments:[{versions:[{version_id:'${plan.workerVersion}',percentage:100}]}]}};
else if(u.pathname.endsWith('/containers/applications'))data={success:true,result:[{id:'11111111-2222-4333-8444-555555555555',name:'gateway-staging-resident-residentdo',version:7,configuration:{image:'${image}'}}]};
else if(u.pathname.endsWith('/containers/applications/11111111-2222-4333-8444-555555555555')){state.directReads=(state.directReads??0)+1;writeFileSync(process.env.RECOVERY_STATE,JSON.stringify(state));const bad=state.directReads===Number(process.env.RECOVERY_BAD_AT);if(bad&&process.env.RECOVERY_BAD_MODE==='missing')return Response.json({success:false},{status:404});data={success:true,result:{id:'11111111-2222-4333-8444-555555555555',name:'gateway-staging-resident-residentdo',version:bad&&process.env.RECOVERY_BAD_MODE==='version'?6:7,configuration:{image:bad&&process.env.RECOVERY_BAD_MODE==='image'?'different-image':'${image}'}}};}
else throw Error('unexpected network request');return Response.json(data);};`,
        );
        {
          const state = join(directory, `state-${lost}`);
          const effects = join(directory, `effects-${lost}`);
          const receipt = join(directory, `receipt-${lost}`);
          writeFileSync(
            state,
            JSON.stringify({
              count: 0,
              residents: [],
              inFlight: 0,
              inFlightUnknown: 0,
              stagingMaintenance: null,
              draining: plan.fence,
            }),
          );
          writeFileSync(effects, "");
          const env = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            SWITCHBOARD_DEPLOY_PROFILE: profilePath,
            SWITCHBOARD_STAGING_ACCOUNT: account,
            SWITCHBOARD_PRODUCTION_ACCOUNT: TEST_PROFILE.account,
            CLOUDFLARE_API_TOKEN: "fixture",
            RESIDENT_READ_TOKEN: "fixture",
            RESIDENT_DRAIN_TOKEN: "fixture",
            SWITCHBOARD_DEPLOY_FORCE: "0",
            RESIDENT_DEPLOY_FORCE: "0",
            GITHUB_REPOSITORY: "acme/gateway",
            RECOVERY_FIXTURE: directory,
            RECOVERY_STATE: state,
            RECOVERY_EFFECTS: effects,
            RECOVERY_LOST: lost ? "1" : "0",
            RECOVERY_BAD_MODE: mode,
            RECOVERY_BAD_AT: String(at),
          };
          const run = (extra: string[] = []) =>
            spawnSync(
              process.execPath,
              [
                "--import",
                preload,
                "--import",
                "tsx",
                "scripts/staging-deploy.ts",
                "--recover-resident",
                "--run",
                "123",
                "--attempt",
                "1",
                "--receipt",
                receipt,
                ...extra,
              ],
              { env, encoding: "utf8", timeout: 20_000 },
            );
          const preview = run();
          expect(preview.status, preview.stderr).toBe(0);
          expect(readFileSync(effects, "utf8")).toBe("");
          const selected = JSON.parse(readFileSync(receipt, "utf8")).hash;
          writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), directReads: 0 }));
          const applied = run(["--apply", selected]);
          expect(applied.status, applied.stderr).toBe(lost || at ? 1 : 0);
          if (!at)
            expect(JSON.parse(applied.stdout)).toEqual(
              lost ? { state: "held", reason: "reconcile-unverified" } : { state: "reopened" },
            );
          else
            expect(applied.stderr).toContain(
              mode === "missing"
                ? "Recovery evidence read failed: HTTP 404"
                : "Resident application list and direct target do not agree",
            );
          const retained = readFileSync(effects, "utf8");
          expect(
            retained.trim()
              ? retained
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line).path)
              : [],
          ).toEqual(expected);
          expect(run(["--apply", selected]).status).toBe(1);
          expect(readFileSync(effects, "utf8")).toBe(retained);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
