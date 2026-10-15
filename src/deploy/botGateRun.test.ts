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
import { TEST_PROFILE, TEST_MAINTENANCE } from "./testing/profile.js";

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

describe("build deployment waits for its uploaded target", () => {
  const oldTarget: Read<AppState> = { value: { version: 55, image: NEWER_IMAGE } };
  const newTarget: Read<AppState> = { value: { version: 56, image: PRIOR_IMAGE } };
  const loaded = (version: number): HealthRead => ({
    status: 200,
    body: {
      ok: true,
      draining: false,
      build: { commit: PRIOR_COMMIT },
      loadedBase: {
        schema: 1,
        source: { kind: "state", key: `base-${PRIOR_COMMIT}`, version },
        sha256: "a".repeat(64),
        process: { commit: PRIOR_COMMIT },
      },
    },
  });
  const buildStep = { ...botStep, botImage: undefined };

  it("same-commit image replacement does not finish on the old healthy application and config", async () => {
    const h = harness({ app: [oldTarget, oldTarget, newTarget], health: [loaded(1), loaded(2)] });
    const result = await deployStep(buildStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec);
    expect(result).toEqual({ ok: true, versionId: WORKER_VERSION, live: "live" });
    expect(h.lines.join("\n")).toContain(`targets ${PRIOR_IMAGE} at version 56`);
    expect(h.lines.join("\n")).not.toContain(`live (container application ${APP} targets ${NEWER_IMAGE} at version 55`);
  });

  it("same-commit old image cannot succeed at the existing deadline", async () => {
    const h = harness({ app: [oldTarget], health: [loaded(1)] });
    expect(await deployStep(buildStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec)).toMatchObject({
      ok: false,
      versionId: WORKER_VERSION,
      live: expect.stringContaining("deployed, not live"),
    });
  });

  it("a new application version with the old image still refuses", async () => {
    const h = harness({ app: [oldTarget, { value: { version: 56, image: NEWER_IMAGE } }], health: [loaded(1)] });
    expect(await deployStep(buildStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec)).toMatchObject({
      ok: false,
      versionId: WORKER_VERSION,
      live: expect.stringContaining("expected uploaded image"),
    });
  });

  it("a Worker-only upload retains its unchanged application target", async () => {
    const h = harness({ app: [oldTarget], health: [loaded(1)], output: `Current Version ID: ${WORKER_VERSION}` });
    expect(await deployStep(buildStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec)).toEqual({
      ok: true,
      versionId: WORKER_VERSION,
      live: "live",
    });
  });

  it("a configuration-only rollout must leave the old application version", async () => {
    const h = harness({
      app: [oldTarget, oldTarget, { value: { version: 56, image: NEWER_IMAGE } }],
      health: [loaded(1)],
      output: `Container application changes\nEDIT ${APP}\n+ "max_instances": 1\nCurrent Version ID: ${WORKER_VERSION}`,
    });
    expect(await deployStep(buildStep, plan, PRIOR_COMMIT, h.io, h.deps, h.exec)).toEqual({
      ok: true,
      versionId: WORKER_VERSION,
      live: "live",
    });
    expect(h.lines.join("\n")).toContain(`targets ${NEWER_IMAGE} at version 56`);
  });
});

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
    const native = parseInstancesPage({
      instances: [{ name: "singleton", state: "inactive", version: null }],
      result_info: { next_page_token: null },
    });
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
    const h = harness({
      app: [initial, initial, final],
      health: [serving(PRIOR_COMMIT), serving(NEWER_COMMIT)],
      output: deployOutput
        .replace(`-         "image": "${NEWER_IMAGE}"`, `-         "image": "${PRIOR_IMAGE}"`)
        .replace(`+         "image": "${PRIOR_IMAGE}"`, `+         "image": "${NEWER_IMAGE}"`),
    });
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
      output: deployOutput.replace(`+         "image": "${PRIOR_IMAGE}"`, `+         "image": "${selected}"`),
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

describe("native Resident dependency before Bot upload", () => {
  const guarded = { ...botStep, residentExecutionGate: { baseUrl: "https://resident.example.test" } };

  it("refuses an old or unreadable Resident without uploading Bot, including a forced step", async () => {
    for (const answer of [{ status: 200, body: { ok: true } }, { error: "unavailable" }]) {
      const h = harness({ app: [before, after], health: [serving(PRIOR_COMMIT)] });
      const original = h.deps.readHealth;
      h.deps.env = { RESIDENT_READ_TOKEN: "fixture" };
      h.deps.readHealth = async (url, ...args) =>
        new URL(url).origin === "https://resident.example.test" ? answer : original(url, ...args);
      const result = await deployStep(
        { ...guarded, forcedBy: "SWITCHBOARD_DEPLOY_FORCE" },
        plan,
        PRIOR_COMMIT,
        h.io,
        h.deps,
        h.exec,
      );
      expect(result).toMatchObject({ ok: false, live: "not deployed", noUpload: true });
      expect(h.calls).not.toContain("exec");
    }
  });

  it("requires a ready image registry before uploading against a versioned receiver", async () => {
    for (const imageReport of ["unknown", "current"]) {
      const h = harness({ app: [before, after], health: [serving(PRIOR_COMMIT)] });
      const original = h.deps.readHealth;
      h.deps.env = { RESIDENT_READ_TOKEN: "fixture" };
      h.deps.readHealth = async (url, ...args) => {
        if (url === "https://resident.example.test/healthz")
          return { status: 200, body: { ok: true, features: { nativeRunScopes: "native-v1" } } };
        if (url === "https://resident.example.test/residents")
          return {
            status: 200,
            body: { draining: null, count: 1, residents: [{ resource: "repo:example/repo", live: { imageReport } }] },
          };
        return original(url, ...args);
      };
      const result = await deployStep(guarded, plan, PRIOR_COMMIT, h.io, h.deps, h.exec);
      expect(result.ok).toBe(imageReport === "current");
      expect(h.calls.includes("exec")).toBe(imageReport === "current");
    }
  });
  it("accepts only the exact held staging window after image readiness", async () => {
    const h = harness({ app: [before, after], health: [serving(PRIOR_COMMIT)] });
    const original = h.deps.readHealth;
    const maintenance = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, sourceCommit: PRIOR_COMMIT } };
    h.deps.env = { RESIDENT_READ_TOKEN: "fixture" };
    h.deps.readHealth = async (url, ...args) => {
      if (url.endsWith("/healthz") && new URL(url).origin === "https://resident.example.test")
        return { status: 200, body: { ok: true, features: { nativeRunScopes: "native-v1" } } };
      if (url === "https://resident.example.test/residents")
        return {
          status: 200,
          body: {
            draining: { holds: ["selected"] },
            count: 0,
            residents: [],
            stagingMaintenance: {
              schema: 1,
              state: "held",
              fixtureSha256: maintenance.fixtureSha256,
              decisionSha256: maintenance.decisionSha256,
              holdId: maintenance.holdId,
              generation: maintenance.generation,
              attempt: maintenance.attempt,
              window: {
                state: "completed",
                blocking: 0,
                excluded: 1,
                stored: 1,
                requestEnd: "unobserved",
                nativeOutcome: "unverified",
              },
            },
          },
        };
      return original(url, ...args);
    };
    expect(
      (
        await deployStep(
          { ...guarded, residentExecutionGate: { ...guarded.residentExecutionGate, maintenance } },
          plan,
          PRIOR_COMMIT,
          h.io,
          h.deps,
          h.exec,
        )
      ).ok,
    ).toBe(true);
    expect(h.calls).toContain("exec");
    const stale = { ...maintenance, attempt: { ...maintenance.attempt, sourceCommit: NEWER_COMMIT } };
    h.calls.length = 0;
    expect(
      await deployStep(
        { ...guarded, residentExecutionGate: { ...guarded.residentExecutionGate, maintenance: stale } },
        plan,
        PRIOR_COMMIT,
        h.io,
        h.deps,
        h.exec,
      ),
    ).toMatchObject({ ok: false, noUpload: true });
    expect(h.calls).not.toContain("exec");
  });
  it.each(["unsealed", "wrong-state", "incomplete", "foreign", "stale", "image", "expired"])(
    "refuses the %s retained window without Bot upload",
    async (fault) => {
      const h = harness({ app: [before, after], health: [serving(PRIOR_COMMIT)] });
      const original = h.deps.readHealth;
      const maintenance = {
        ...TEST_MAINTENANCE,
        attempt: {
          ...TEST_MAINTENANCE.attempt,
          sourceCommit: PRIOR_COMMIT,
          ...(fault === "expired" ? { deadline: 1 } : {}),
        },
      };
      h.deps.now = () => 100;
      h.deps.env = { RESIDENT_READ_TOKEN: "fixture" };
      const held = {
        schema: 1,
        state: "held",
        holdId: maintenance.holdId,
        generation: maintenance.generation,
        fixtureSha256: maintenance.fixtureSha256,
        decisionSha256: maintenance.decisionSha256,
        attempt: { ...maintenance.attempt },
        window: {
          state: "completed",
          blocking: 0,
          excluded: 1,
          stored: 1,
          requestEnd: "unobserved",
          nativeOutcome: "unverified",
        },
      };
      if (fault === "unsealed") held.window.state = "fenced";
      if (fault === "wrong-state") held.window.state = "released";
      if (fault === "incomplete") held.window.stored = 0;
      if (fault === "foreign") held.holdId = "22222222-2222-4222-8222-222222222222";
      if (fault === "stale") held.attempt.sourceCommit = NEWER_COMMIT;
      h.deps.readHealth = async (url, ...args) => {
        if (url === "https://resident.example.test/healthz")
          return { status: 200, body: { ok: true, features: { nativeRunScopes: "native-v1" } } };
        if (url === "https://resident.example.test/residents")
          return {
            status: 200,
            body: {
              draining: { holds: ["selected"] },
              count: 1,
              residents: [
                { resource: "repo:example/repo", live: { imageReport: fault === "image" ? "pending" : "current" } },
              ],
              stagingMaintenance: held,
            },
          };
        return original(url, ...args);
      };
      expect(
        await deployStep(
          { ...guarded, residentExecutionGate: { ...guarded.residentExecutionGate, maintenance } },
          plan,
          PRIOR_COMMIT,
          h.io,
          h.deps,
          h.exec,
        ),
      ).toMatchObject({ ok: false, noUpload: true });
      expect(h.calls).not.toContain("exec");
    },
  );
});
