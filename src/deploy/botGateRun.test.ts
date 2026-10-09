import { describe, expect, it, vi } from "vitest";
import { LIVE_GATE_POLL_MS } from "./liveGate.js";
import { workersFor, type DeployStep, type BotLiveGate } from "./plan.js";
import {
  deployStep,
  readRawBotApplication,
  waitUntilBotLive,
  defaultSandboxGateDeps,
  type SandboxGateDeps,
  type StepExec,
} from "./run.js";
import { parseInstancesPage, type AppState, type HealthRead, type Read } from "./sandboxLiveGate.js";
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
  botImage: PRIOR_IMAGE,
  botAccount: TEST_PROFILE.account,
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
  listed?: Read<AppState>;
  output?: string;
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
    readListedAppState: async () => script.listed ?? script.app[0]!,
    readInstances: async () => {
      calls.push("readInstances");
      const app = script.app[Math.min(indexes.app - 1, script.app.length - 1)]!;
      return "value" in app ? { value: [{ name: "singleton", state: "running", version: app.value.version }] } : app;
    },
    probeExec: async () => {
      throw new Error("bot gate does not probe /exec");
    },
  };
  const io = { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), stream: () => {} };
  const exec: StepExec = async () => {
    calls.push("exec");
    return { code: 0, output: script.output ?? deployOutput };
  };
  return { deps, io, exec, calls, lines };
}

describe("deployment health cancellation", () => {
  it("aborts an already pending health response and performs no later poll", async () => {
    try {
      const positive = harness({ app: [after], health: [serving(PRIOR_COMMIT)] });
      expect(await waitUntilBotLive(botStep, gate, PRIOR_COMMIT, positive.io, positive.deps)).toMatchObject({
        live: true,
        waitedMs: 0,
      });
      const h = harness({ app: [after], health: [] });
      const control = new AbortController();
      let sends = 0;
      vi.stubGlobal("fetch", async (_url: Parameters<typeof fetch>[0], init: RequestInit) => {
        sends++;
        const response = new Response(
          new ReadableStream({
            start(c) {
              init.signal?.addEventListener("abort", () => c.error(new Error("fixture aborted")), { once: true });
            },
          }),
        );
        queueMicrotask(() => control.abort());
        return response;
      });
      h.deps.signal = control.signal;
      h.deps.readHealth = defaultSandboxGateDeps.readHealth;
      expect(await waitUntilBotLive(botStep, gate, PRIOR_COMMIT, h.io, h.deps)).toEqual({
        live: false,
        reason: "deployment cancelled",
      });
      expect(sends).toBe(1);
      expect(h.calls).toEqual(["readAppState", "readInstances"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("deployStep (bot rollback fence)", () => {
  it("uses fresh singleton health when Wrangler reports an inactive placement without a version", async () => {
    const h = harness({ app: [before, after], health: [serving(PRIOR_COMMIT)] });
    const native = parseInstancesPage([{ name: "singleton", state: "inactive", version: null }]);
    expect(native).toBeDefined();
    h.deps.readInstances = async () => ({ value: native!.rows });
    expect(await deployStep(botStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec)).toMatchObject({
      ok: true,
      live: "live",
    });
  });

  it("refuses the stale list that makes Wrangler skip rollback before any upload even by force", async () => {
    const h = harness({
      app: [before],
      listed: { value: { version: 16, image: PRIOR_IMAGE } },
      health: [serving(NEWER_COMMIT)],
    });
    const outcome = await deployStep(
      { ...botStep, forcedBy: "SWITCHBOARD_DEPLOY_FORCE" },
      plan,
      PRIOR_COMMIT,
      h.io,
      h.deps,
      h.exec,
    );
    expect(outcome).toMatchObject({
      ok: false,
      live: "not deployed",
      reason: expect.stringContaining("application list/direct mismatch"),
    });
    expect(h.calls).toEqual(["readAppState"]);
  });

  it("ignores no-changes prose and accepts reused prior target only after runtime and exact health agree", async () => {
    const reused = { value: { version: 16, image: PRIOR_IMAGE } };
    const h = harness({
      app: [before, before, reused],
      health: [serving(NEWER_COMMIT), serving(PRIOR_COMMIT)],
      output: `no changes ${APP}\nCurrent Version ID: ${WORKER_VERSION}`,
    });
    expect(await deployStep(botStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec)).toEqual({
      ok: true,
      versionId: WORKER_VERSION,
      live: "live",
    });
    expect(h.lines.join("\n")).not.toContain("Worker-only");
  });

  it("also admits a forward version only after application and runtime uptake", async () => {
    const initial = { value: { version: 16, image: PRIOR_IMAGE } };
    const final = { value: { version: 17, image: NEWER_IMAGE } };
    const h = harness({ app: [initial, initial, final], health: [serving(PRIOR_COMMIT), serving(NEWER_COMMIT)] });
    expect(
      await deployStep({ ...botStep, botImage: NEWER_IMAGE }, plan, NEWER_COMMIT, h.io, h.deps, h.exec),
    ).toMatchObject({ ok: true, live: "live" });
  });

  it.each([
    { error: "denied" },
    { value: { version: 17, image: null } },
    { value: { version: 17.5, image: NEWER_IMAGE } },
    { value: { version: 17, image: PRIOR_IMAGE } },
  ])("refuses unreadable or inconsistent list evidence before upload: %j", async (listed) => {
    const h = harness({ app: [before], listed, health: [serving(NEWER_COMMIT)] });
    expect(await deployStep(botStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec)).toMatchObject({
      ok: false,
      live: "not deployed",
    });
    expect(h.calls).not.toContain("exec");
  });

  it("admits a fresh forward image with differing list and effective native versions", async () => {
    const stale = { value: { version: 73, image: PRIOR_IMAGE } };
    const effective = { value: { version: 74, image: NEWER_IMAGE } };
    const selected = "registry.cloudflare.com/account/switchboard:1.262.0";
    const landed = { value: { version: 75, image: selected } };
    const h = harness({
      app: [effective, effective, landed],
      listed: stale,
      health: [serving(NEWER_COMMIT), serving(PRIOR_COMMIT)],
    });
    expect(
      await deployStep({ ...botStep, botImage: selected }, plan, PRIOR_COMMIT, h.io, h.deps, h.exec),
    ).toMatchObject({ ok: true, live: "live" });
    expect(h.calls).toContain("exec");
    expect(h.lines.join("\n")).toContain(`still targets ${NEWER_IMAGE}; expected ${selected}`);
  });

  it("keeps Worker-only and build deployments available across differing native views", async () => {
    const effective = { value: { version: 74, image: NEWER_IMAGE } };
    const listed = { value: { version: 73, image: PRIOR_IMAGE } };
    for (const botImage of [NEWER_IMAGE, undefined]) {
      const h = harness({
        app: [effective],
        listed,
        health: [serving(NEWER_COMMIT)],
        output: `no changes ${APP}\nCurrent Version ID: ${WORKER_VERSION}`,
      });
      expect(await deployStep({ ...botStep, botImage }, plan, NEWER_COMMIT, h.io, h.deps, h.exec)).toMatchObject({
        ok: true,
        live: "live",
      });
    }
  });

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
    expect(h.calls).toEqual([
      "readAppState",
      "exec",
      "readAppState",
      "readInstances",
      "readHealth",
      "readAppState",
      "readInstances",
      "readHealth",
    ]);
    expect(h.lines).toContain(
      `[deploy:all] bot: container application at version 17 (image ${NEWER_IMAGE}) before the upload`,
    );
    expect(h.lines).toContain(
      `[deploy:all] bot: gate requires ${PRIOR_IMAGE}, unique singleton identity and exact healthy commit ${PRIOR_COMMIT}`,
    );
    expect(h.lines).toContain(
      `[deploy:all] bot: deployed, not live yet — container application ${APP} still targets ${NEWER_IMAGE}; expected ${PRIOR_IMAGE} (0m 0s)`,
    );
    expect(h.lines).toContain(
      `[deploy:all] bot: live (container application ${APP} targets ${PRIOR_IMAGE} at version 18; singleton /healthz serves exact ${PRIOR_COMMIT}; ${LIVE_GATE_POLL_MS / 1000}s after the upload)`,
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

describe("raw bot application read", () => {
  it.each([
    [{ type: "api_token", token: "fixture-token" }, { authorization: "Bearer fixture-token" }],
    [{ type: "oauth", token: "fixture-oauth" }, { authorization: "Bearer fixture-oauth" }],
    [
      { type: "api_key", key: "fixture-key", email: "fixture@example.test" },
      { "X-Auth-Key": "fixture-key", "X-Auth-Email": "fixture@example.test" },
    ],
  ])("uses deploy's raw endpoint and Wrangler auth mode: %j", async (auth, headers) => {
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${TEST_PROFILE.account}/containers/applications`);
      expect(init?.headers).toEqual(headers);
      return Response.json({
        success: true,
        result: [{ name: APP, version: 16, configuration: { image: PRIOR_IMAGE } }],
      });
    };
    expect(await readRawBotApplication(TEST_PROFILE.account, APP, auth, fetcher)).toEqual({
      value: { version: 16, image: PRIOR_IMAGE },
    });
  });

  it.each([
    { success: true, result: [{ name: APP, version: 16, image: PRIOR_IMAGE }] },
    { success: false, result: [{ name: APP, version: 16, configuration: { image: PRIOR_IMAGE } }] },
    { success: true, result: [] },
    { success: true, result: [{ name: "other", version: 16, configuration: { image: PRIOR_IMAGE } }] },
  ])("refuses dashboard shapes or missing native evidence: %j", async (body) => {
    const result = await readRawBotApplication(
      TEST_PROFILE.account,
      APP,
      { type: "api_token", token: "fixture" },
      async () => Response.json(body),
    );
    // A flattened dashboard image must never substitute for configuration.image.
    expect(result).toHaveProperty("error");
  });

  it("never exposes credential-bearing error bodies", async () => {
    const result = await readRawBotApplication(
      TEST_PROFILE.account,
      APP,
      { type: "api_token", token: "private-fixture" },
      async () => new Response("private-fixture", { status: 403 }),
    );
    expect(result).toEqual({ error: "raw application list HTTP 403" });
  });
});
