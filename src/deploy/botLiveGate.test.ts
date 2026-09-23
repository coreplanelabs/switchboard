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
  before: { value: { version: 17, image: NEWER_IMAGE } },
  target: { image: PRIOR_IMAGE },
  expectedCommit: PRIOR_COMMIT,
  elapsedMs,
});

describe("decideBotLive rollback fence", () => {
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
      summary: `container application ${APP} targets ${PRIOR_IMAGE} at version 18 (up from 17); /healthz serves exact ${PRIOR_COMMIT}`,
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
