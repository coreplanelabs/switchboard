import { describe, expect, it } from "vitest";
import { LIVE_GATE_POLL_MS } from "./liveGate.js";
import { workersFor, type DeployStep, type BotLiveGate } from "./plan.js";
import { deployStep, type SandboxGateDeps, type StepExec } from "./run.js";
import type { AppState, HealthRead, Read } from "./sandboxLiveGate.js";
import { TEST_PROFILE } from "./testing/profile.js";

const PRIOR_COMMIT = "903ae2855833637fbcc0c0a22d54e7268be75965";
const NEWER_COMMIT = "c60b26943f774d0aa765bd42a0f94e3e428627a6";
const PRIOR_IMAGE = "registry.cloudflare.com/account/switchboard:1.260.6";
const NEWER_IMAGE = "registry.cloudflare.com/account/switchboard:1.261.0";
const APP = "switchboard-switchboardserver";
const WORKER_VERSION = "813f9b05-fba0-499b-ad78-9a6cc90ab092";
const before: Read<AppState> = { value: { version: 17, image: NEWER_IMAGE } };
const after: Read<AppState> = { value: { version: 18, image: PRIOR_IMAGE } };
const serving = (commit: string): HealthRead => ({ status: 200, body: { ok: true, build: { commit } } });
const gate = workersFor(TEST_PROFILE).find((worker) => worker.name === "bot")!.liveGate as BotLiveGate;
const botStep: DeployStep = {
  name: "bot",
  script: "switchboard",
  dir: "deploy/cloudflare",
  command: ["npm", "run", "deploy"],
  unsetEnv: ["CLOUDFLARE_ACCOUNT_ID"],
  setEnv: { SWITCHBOARD_BASE_URL: "https://switchboard.example.test" },
  requiredEnv: [],
  capabilities: [],
  retryOnPreflightRefusal: true,
  healthUrl: "https://switchboard.example.test/healthz",
  liveGate: gate,
  why: "container shim",
};
const plan = { waitMaxMs: 10 * 60_000, pollMs: 60_000 };
const deployOutput = [
  "│ Container application changes",
  `├ EDIT ${APP}`,
  `│ -         "image": "${NEWER_IMAGE}",`,
  `│ +         "image": "${PRIOR_IMAGE}",`,
  "╰ Applied changes",
  `Current Version ID: ${WORKER_VERSION}`,
].join("\n");

interface Scripted {
  app: Read<AppState>[];
  health: HealthRead[];
}

function harness(script: Scripted) {
  const calls: string[] = [];
  const lines: string[] = [];
  const indexes = { app: 0, health: 0 };
  let clock = 0;
  const next = <T>(values: T[], key: keyof typeof indexes): T => {
    const at = indexes[key]++;
    return values[Math.min(at, values.length - 1)]!;
  };
  const deps: SandboxGateDeps = {
    env: {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readHealth: async () => {
      calls.push("readHealth");
      return next(script.health, "health");
    },
    readAppState: async () => {
      calls.push("readAppState");
      return next(script.app, "app");
    },
    readInstances: async () => {
      throw new Error("bot gate does not list instances");
    },
    probeExec: async () => {
      throw new Error("bot gate does not probe /exec");
    },
  };
  const io = { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), stream: () => {} };
  const exec: StepExec = async () => {
    calls.push("exec");
    return { code: 0, output: deployOutput };
  };
  return { deps, io, exec, calls, lines };
}

describe("deployStep (bot rollback fence)", () => {
  it("binds the bot gate to the profile-derived application name", () => {
    expect(gate).toEqual({
      kind: "bot",
      healthUrl: "https://switchboard.example.test/healthz",
      containerApp: APP,
    });
  });

  it("reads the application before the full prior-package deploy and succeeds only after target, version, and exact health agree", async () => {
    const h = harness({ app: [before, before, after], health: [serving(NEWER_COMMIT), serving(PRIOR_COMMIT)] });

    const outcome = await deployStep(botStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec);

    expect(outcome).toEqual({ ok: true, versionId: WORKER_VERSION, live: "live" });
    expect(h.calls).toEqual(["readAppState", "exec", "readAppState", "readHealth", "readAppState", "readHealth"]);
    expect(h.lines).toContain(
      `[deploy:all] bot: container application at version 17 (image ${NEWER_IMAGE}) before the upload`,
    );
    expect(h.lines).toContain(
      `[deploy:all] bot: wrangler printed a container change — image ${PRIOR_IMAGE}; the application must leave version 17`,
    );
    expect(h.lines).toContain(
      `[deploy:all] bot: deployed, not live yet — container application ${APP} still targets ${NEWER_IMAGE}; expected ${PRIOR_IMAGE} (0m 0s)`,
    );
    expect(h.lines).toContain(
      `[deploy:all] bot: live (container application ${APP} targets ${PRIOR_IMAGE} at version 18 (up from 17); /healthz serves exact ${PRIOR_COMMIT}; ${LIVE_GATE_POLL_MS / 1000}s after the upload)`,
    );
  });

  it("refuses the deployment by retained target name when the application never leaves the newer image", async () => {
    const h = harness({ app: [before], health: [serving(PRIOR_COMMIT)] });

    const outcome = await deployStep(botStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec);

    expect(outcome).toMatchObject({
      ok: false,
      versionId: WORKER_VERSION,
      live: expect.stringContaining(
        `container application ${APP} still targets ${NEWER_IMAGE}; expected ${PRIOR_IMAGE}`,
      ),
      reason: expect.stringContaining("deployed but NOT live"),
    });
  });
});
