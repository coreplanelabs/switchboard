import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS } from "./liveGate.js";
import { decideBotLive, type BotLiveInput } from "./botLiveGate.js";

const PRIOR_COMMIT = "903ae2855833637fbcc0c0a22d54e7268be75965";
const NEWER_COMMIT = "c60b26943f774d0aa765bd42a0f94e3e428627a6";
const APP = "switchboard-switchboardserver";
const PRIOR_IMAGE = "registry.cloudflare.com/account/switchboard:1.260.6";
const NEWER_IMAGE = "registry.cloudflare.com/account/switchboard:1.261.0";

interface RollbackWorld {
  registry: Set<string>;
  workerVersion: string;
  app: { version: number; image: string };
  healthCommit: string;
  startedAt: string;
}

const newerWorld = (): RollbackWorld => ({
  registry: new Set([NEWER_IMAGE]),
  workerVersion: "worker-newer",
  app: { version: 17, image: NEWER_IMAGE },
  healthCommit: NEWER_COMMIT,
  startedAt: "2026-09-23T09:00:00.000Z",
});

const input = (world: RollbackWorld, elapsedMs = LIVE_GATE_DEADLINE_MS): BotLiveInput => ({
  containerApp: APP,
  health: { status: 200, body: { ok: true, build: { commit: world.healthCommit }, startedAt: world.startedAt } },
  app: { value: world.app },
  expectedImage: PRIOR_IMAGE,
  instances: { value: [{ name: "singleton", state: "running", version: world.app.version }] },
  expectedCommit: PRIOR_COMMIT,
  elapsedMs,
});

describe("decideBotLive rollback fence", () => {
  it.each([
    { name: "singleton", state: "stopped", version: 18 },
    { name: "singleton", state: "inactive", version: null },
  ])("accepts exact healthy singleton when native placement state lags: %j", (singleton) => {
    const world = newerWorld();
    world.app = { version: 18, image: PRIOR_IMAGE };
    world.healthCommit = PRIOR_COMMIT;
    const evidence = { ...input(world), instances: { value: [singleton] } };
    expect(decideBotLive(evidence)).toMatchObject({ kind: "live" });
    expect(
      decideBotLive({ ...evidence, health: { status: 200, body: { ok: true, build: { commit: NEWER_COMMIT } } } }),
    ).toMatchObject({ kind: "failed", reason: expect.stringContaining("expected exact") });
    expect(
      decideBotLive({
        ...evidence,
        health: { status: 200, body: { ok: true, build: { commit: PRIOR_COMMIT }, draining: true } },
      }),
    ).toMatchObject({ kind: "failed", reason: expect.stringContaining("draining") });
  });

  it("accepts a reused lower application version only when selected image and runtime agree", () => {
    const world = newerWorld();
    world.app = { version: 16, image: PRIOR_IMAGE };
    world.healthCommit = PRIOR_COMMIT;
    expect(decideBotLive(input(world))).toMatchObject({ kind: "live" });
  });

  it.each([17, 18])(
    "refuses a competing running instance on version %s despite healthy singleton response",
    (version) => {
      const world = newerWorld();
      world.app = { version: 18, image: PRIOR_IMAGE };
      world.healthCommit = PRIOR_COMMIT;
      const evidence = input(world);
      evidence.instances = {
        value: [
          { name: "singleton", state: "stopped", version: 18 },
          { name: "other", state: "running", version },
        ],
      };
      expect(decideBotLive(evidence)).toMatchObject({ kind: "failed", reason: expect.stringContaining("singleton") });
    },
  );

  it("refuses an old singleton despite exact selected health and target", () => {
    const world = newerWorld();
    world.app = { version: 18, image: PRIOR_IMAGE };
    world.healthCommit = PRIOR_COMMIT;
    const evidence = input(world);
    evidence.instances = { value: [{ name: "singleton", state: "running", version: 17 }] };
    expect(decideBotLive(evidence)).toMatchObject({ kind: "failed", reason: expect.stringContaining("singleton") });
  });

  it.each([
    { error: "unreadable" },
    { value: [] },
    { value: [{ name: "singleton", state: "running", version: null }] },
    { value: [{ name: "other", state: "running", version: 18 }] },
    { value: [{ name: "singleton", state: "unknown", version: 18 }] },
    {
      value: [
        { name: "singleton", state: "running", version: 18 },
        { name: "singleton", state: "running", version: 17 },
      ],
    },
  ])("refuses incomplete runtime evidence: %j", (instances) => {
    const world = newerWorld();
    world.app = { version: 18, image: PRIOR_IMAGE };
    world.healthCommit = PRIOR_COMMIT;
    expect(decideBotLive({ ...input(world), instances })).toMatchObject({ kind: "failed" });
  });
  it("registry image copy changes inventory only and is refused because the named container application still targets the newer image", () => {
    const world = newerWorld();

    world.registry.add(PRIOR_IMAGE);

    expect(world.registry.has(PRIOR_IMAGE)).toBe(true);
    expect(world.workerVersion).toBe("worker-newer");
    expect(world.app).toEqual({ version: 17, image: NEWER_IMAGE });
    expect(decideBotLive(input(world))).toEqual({
      kind: "failed",
      reason: `container application ${APP} still targets ${NEWER_IMAGE}; expected ${PRIOR_IMAGE} — still not live after 20 min (deadline 20 min)`,
    });
  });

  it("Worker rollback and restart change only Worker/process state and are refused while the named container application retains the newer target", () => {
    const world = newerWorld();

    world.workerVersion = "worker-prior";
    world.startedAt = "2026-09-23T09:05:00.000Z";

    expect(world.workerVersion).toBe("worker-prior");
    expect(world.startedAt).toBe("2026-09-23T09:05:00.000Z");
    expect(world.app).toEqual({ version: 17, image: NEWER_IMAGE });
    expect(decideBotLive(input(world))).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`container application ${APP} still targets ${NEWER_IMAGE}`),
    });
  });

  it("a full prior-package deploy succeeds only after the application advances to the intended prior image and /healthz serves the prior exact commit", () => {
    const world = newerWorld();

    world.workerVersion = "worker-prior-upload";
    world.app = { version: 18, image: PRIOR_IMAGE };
    world.healthCommit = PRIOR_COMMIT;
    world.startedAt = "2026-09-23T09:10:00.000Z";

    expect(decideBotLive(input(world, 30_000))).toEqual({
      kind: "live",
      summary: `container application ${APP} targets ${PRIOR_IMAGE} at version 18; singleton /healthz serves exact ${PRIOR_COMMIT}`,
    });
  });

  it("an exact commit that is still draining is not accepted as the live rollback generation", () => {
    const world = newerWorld();
    world.app = { version: 18, image: PRIOR_IMAGE };
    world.healthCommit = PRIOR_COMMIT;
    const draining = input(world, 30_000);
    if ("body" in draining.health && draining.health.body) draining.health.body.draining = true;

    expect(decideBotLive(draining)).toEqual({
      kind: "waiting",
      reason: "health: the exact deployed commit answers but its container is draining",
    });
  });

  it("application advancement alone is refused when /healthz does not serve the prior exact commit", () => {
    const world = newerWorld();
    world.app = { version: 18, image: PRIOR_IMAGE };

    expect(decideBotLive(input(world))).toEqual({
      kind: "failed",
      reason: `health: serving commit ${NEWER_COMMIT}, expected exact ${PRIOR_COMMIT} — still not live after 20 min (deadline 20 min)`,
    });
    world.healthCommit = PRIOR_COMMIT.slice(0, 12);
    expect(decideBotLive(input(world))).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining(`serving commit ${PRIOR_COMMIT.slice(0, 12)}, expected exact ${PRIOR_COMMIT}`),
    });
  });
});

describe("config publication readiness", () => {
  it.each([
    { name: "singleton", state: "stopped", version: 18 },
    { name: "singleton", state: "inactive", version: null },
  ])("waits for native running evidence without extending the deadline: %j", (instance) => {
    const world = newerWorld();
    world.app = { version: 18, image: PRIOR_IMAGE };
    world.healthCommit = PRIOR_COMMIT;
    const evidence: BotLiveInput = {
      ...input(world, 0),
      requireRunningSingleton: true,
      instances: { value: [instance] },
    };
    expect(decideBotLive(evidence)).toMatchObject({
      kind: "waiting",
      reason: expect.stringContaining("before config acceptance"),
    });
    expect(decideBotLive({ ...evidence, elapsedMs: LIVE_GATE_DEADLINE_MS })).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("deadline"),
    });
    expect(
      decideBotLive({ ...evidence, instances: { value: [{ name: "singleton", state: "running", version: 18 }] } }),
    ).toMatchObject({ kind: "live" });
  });
});
