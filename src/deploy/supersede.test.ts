import { describe, expect, it } from "vitest";
import { DEPLOY_FORCE_ENV, type DeployStep } from "./plan.js";
import { stepHealth, supersededSteps, type SupersedeReads } from "./supersede.js";

// Feature: docs/reference/specs/release-and-deploy.md item 32 — a deploy never
// rolls an older build over a newer one: before anything uploads, each selected
// Worker's live /healthz build.commit is read, and a live commit that already
// contains the commit being deployed refuses the Worker by name; --force (or
// the force env) overrides for a deliberate rollback, with the note.

const DEPLOYING = "e2ba9e4c000000000000000000000000000000aa";
const NEWER = "1145eea8000000000000000000000000000000bb";
const OLDER = "9c01d2ef000000000000000000000000000000cc";

const step = (over: Partial<DeployStep>): DeployStep => ({
  name: "memory",
  script: "switchboard-memory",
  dir: "deploy/cloudflare-memory",
  command: ["npm", "run", "deploy"],
  unsetEnv: [],
  setEnv: {},
  requiredEnv: [],
  capabilities: [],
  retryOnPreflightRefusal: false,
  wakeUrl: "https://memory.example.test/healthz",
  why: "state Worker",
  ...over,
});

const botStep = step({
  name: "bot",
  script: "switchboard",
  dir: "deploy/cloudflare",
  liveGate: {
    kind: "bot",
    healthUrl: "https://bot.example.test/healthz",
    containerApp: "switchboard-switchboardserver",
  },
  healthUrl: "https://bot.example.test/healthz",
  wakeUrl: undefined as unknown as string,
});

const sandboxStep = step({
  name: "sandbox",
  script: "switchboard-sandbox",
  dir: "deploy/cloudflare-sandbox",
  liveGate: {
    kind: "sandbox",
    healthUrl: "https://sandbox.example.test/healthz",
    bearerEnv: "SANDBOX_TOKEN",
    containerApp: "switchboard-sandbox-switchboardsandbox",
  },
  wakeUrl: undefined as unknown as string,
});

interface Fake {
  reads: SupersedeReads;
  liveReads: { url: string; bearerEnv: string | undefined }[];
  ancestryAsked: { deploying: string; live: string }[];
}

/** A world where every Worker serves `live` and ancestry answers `contains`. */
function fake(
  live: string | undefined,
  contains: boolean | undefined,
  env: Record<string, string | undefined> = {},
): Fake {
  const liveReads: Fake["liveReads"] = [];
  const ancestryAsked: Fake["ancestryAsked"] = [];
  return {
    liveReads,
    ancestryAsked,
    reads: {
      env,
      readLive: async (url, bearerEnv) => {
        liveReads.push({ url, bearerEnv });
        return live === undefined ? undefined : { build: { commit: live } };
      },
      liveContains: async (deploying, l) => {
        ancestryAsked.push({ deploying, live: l });
        return contains;
      },
    },
  };
}

const checkout = { mode: "checkout" as const, path: "/repo" };

describe("supersededSteps — a deploy never rolls an older build over a newer one", () => {
  it("a live commit ahead of the deploying one (it already contains it) is refused by name, naming both commits and that nothing is to be re-run", async () => {
    const world = fake(NEWER, true);
    const out = await supersededSteps({ steps: [botStep], force: false, root: checkout }, DEPLOYING, world.reads);
    expect(out.problems).toEqual([
      `refused: bot is live on ${NEWER.slice(0, 7)} which already contains ${DEPLOYING.slice(0, 7)}; this release is superseded — re-run nothing, the newer release carries it`,
    ]);
    expect(out.notes).toEqual([]);
    expect(world.ancestryAsked).toEqual([{ deploying: DEPLOYING, live: NEWER }]);
  });

  it("a Worker live on the very commit being deployed proceeds — ancestry is never asked (a commit contains itself)", async () => {
    const world = fake(DEPLOYING, true);
    const out = await supersededSteps({ steps: [botStep], force: false, root: checkout }, DEPLOYING, world.reads);
    expect(out.problems).toEqual([]);
    expect(world.ancestryAsked).toEqual([]);
  });

  it("a live commit behind the deploying one (a normal upgrade) proceeds", async () => {
    const world = fake(OLDER, false);
    const out = await supersededSteps({ steps: [botStep], force: false, root: checkout }, DEPLOYING, world.reads);
    expect(out.problems).toEqual([]);
    expect(out.notes).toEqual([]);
  });

  it("--force proceeds over a superseding live commit, with the note naming the deliberate rollback", async () => {
    const world = fake(NEWER, true);
    const out = await supersededSteps({ steps: [botStep], force: true, root: checkout }, DEPLOYING, world.reads);
    expect(out.problems).toEqual([]);
    expect(out.notes).toEqual([
      `bot is live on ${NEWER.slice(0, 7)} which already contains ${DEPLOYING.slice(0, 7)} — deploying anyway (--force): a deliberate rollback`,
    ]);
  });

  it(`${DEPLOY_FORCE_ENV}=1 in the environment overrides like --force, and the note names the env var`, async () => {
    const world = fake(NEWER, true, { [DEPLOY_FORCE_ENV]: "1" });
    const out = await supersededSteps({ steps: [botStep], force: false, root: checkout }, DEPLOYING, world.reads);
    expect(out.problems).toEqual([]);
    expect(out.notes).toEqual([
      `bot is live on ${NEWER.slice(0, 7)} which already contains ${DEPLOYING.slice(0, 7)} — deploying anyway (${DEPLOY_FORCE_ENV}=1): a deliberate rollback`,
    ]);
  });

  it("a live commit that cannot be read proceeds — the guard refuses only what it can prove, and never asks git", async () => {
    const world = fake(undefined, true);
    const out = await supersededSteps({ steps: [botStep], force: false, root: checkout }, DEPLOYING, world.reads);
    expect(out.problems).toEqual([]);
    expect(world.ancestryAsked).toEqual([]);
  });

  it("an ancestry git cannot answer (an unknown sha, a dirty build) proceeds", async () => {
    const world = fake("unknown", undefined);
    const out = await supersededSteps({ steps: [botStep], force: false, root: checkout }, DEPLOYING, world.reads);
    expect(out.problems).toEqual([]);
    expect(world.ancestryAsked).toEqual([{ deploying: DEPLOYING, live: "unknown" }]);
  });

  it("from the published package nothing is judged — there is no git to ask ancestry of", async () => {
    const world = fake(NEWER, true);
    const out = await supersededSteps(
      { steps: [botStep], force: false, root: { mode: "package", path: "/home/op" } },
      DEPLOYING,
      world.reads,
    );
    expect(out.problems).toEqual([]);
    expect(world.liveReads).toEqual([]);
  });

  it("every planned step is judged at its own health endpoint — the sandbox's with its bearer env, the memory Worker's wake URL, the bot's gate URL", async () => {
    const world = fake(NEWER, true);
    const out = await supersededSteps(
      { steps: [step({}), botStep, sandboxStep], force: false, root: checkout },
      DEPLOYING,
      world.reads,
    );
    expect(world.liveReads).toEqual([
      { url: "https://memory.example.test/healthz", bearerEnv: undefined },
      { url: "https://bot.example.test/healthz", bearerEnv: undefined },
      { url: "https://sandbox.example.test/healthz", bearerEnv: "SANDBOX_TOKEN" },
    ]);
    expect(out.problems).toHaveLength(3);
    expect(out.problems[0]).toContain("memory is live on");
    expect(out.problems[2]).toContain("sandbox is live on");
  });
});

describe("stepHealth — where a step's live commit is read from", () => {
  it("prefers the live gate's URL, then the heartbeat's, then the wake URL; a step with none is skipped", () => {
    expect(stepHealth(botStep)).toEqual({ url: "https://bot.example.test/healthz" });
    expect(stepHealth(sandboxStep)).toEqual({
      url: "https://sandbox.example.test/healthz",
      bearerEnv: "SANDBOX_TOKEN",
    });
    expect(stepHealth(step({}))).toEqual({ url: "https://memory.example.test/healthz" });
    expect(stepHealth(step({ wakeUrl: undefined as unknown as string }))).toBeUndefined();
  });
});
