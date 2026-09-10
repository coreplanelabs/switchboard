import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { secretsFrom } from "../secrets.js";
import { AGENTS } from "../agents/registry.js";
import { CLI_CALLER, runCli } from "../cli.js";
import { parseAppConfigText } from "../config.js";
import { createLiveViewHandler, type LiveViewContext } from "../channels/liveView.js";
import { makeShellRenderer } from "../channels/webShell.js";
import { retentionSentence, SEED_ELEMENT_ID, type RunsIndexSeed, type ScheduledSeed } from "../channels/webSeed.js";
import { DEPLOY_ORDER, formatPlan, planDeploy, type DeployOptions, type WorkerName } from "../deploy/plan.js";
import { parseProfile, PROFILE_EXAMPLE_PATH, type LoadedProfile } from "../deploy/profile.js";
import { TEST_PUBLISHED_IMAGES } from "../deploy/testing/profile.js";
import { ALL_CAPABILITIES, capabilitiesFrom, NO_CAPABILITIES, type Capabilities } from "./capabilities.js";
import { CAPABILITY_KEYS, dependsOn, isEnabled, visibleUnder, withOn } from "./capabilityGating.js";
import { invokeChatCommand, parseChatCommand } from "./commandChat.js";
import { CommandRegistry } from "./commandRegistry.js";
import { RunRegistry } from "./runRegistry.js";
import { InMemoryRunStore } from "./runStore.js";
import { createRunsService } from "./runsService.js";
import { SCHEDULES } from "./schedules.js";
import { InMemoryScheduleStore } from "./scheduleStore.js";
import { selfDescriptionBlock } from "./selfDescription.js";
import { callerWith } from "./testing/callers.js";
import { CAPABILITY_FIXTURES, type CapabilityFixture } from "./testing/capabilityFixtures.js";
import {
  ADAPTER_CALLER_KIND,
  ADAPTER_KINDS,
  CATALOGUE,
  CHAT_CHANNEL,
  fixture,
  mcpToolNames,
  NOW,
  POWER,
  presenceOf,
  type AdapterKind,
  type Fixture,
} from "./testing/conformanceFixture.js";

// Feature: docs/reference/specs/capabilities.md — the product adapts to what is on. One
// `Capabilities` value (src/core/capabilities.ts) is computed at startup and
// every surface reads it. This suite is the PROOF, in two halves:
//
//   1. Three installations as CONFIGURATIONS (`src/core/testing/capabilityFixtures.ts`):
//      `minimal`, `local-full`, `cloud-full`. Each is a config.yaml plus an
//      environment, and the round trip through `capabilitiesFrom` is asserted —
//      so the fixtures are shapes an operator can copy, not hand-typed flags.
//      Under each one, every surface is snapshotted: `help` on chat, the MCP
//      `tools/list`, the HTTP `/api` catalogue, the CLI catalogue, the web seeds
//      of `/runs` and `/runs/scheduled`, the self-description block. The deploy
//      plan is snapshotted for the full example profile and for a bot-only
//      deployment. A snapshot changes when — and only when — a surface changes
//      what it shows for that shape; the diff IS the review.
//
//   2. The capability AXIS: for every axis of the contract, turning it on from
//      the minimal world changes exactly the commands whose `enabledWhen`
//      depends on it — added or removed, as the predicates say — on every
//      adapter (HTTP, MCP, CLI, chat); every fixture shows exactly the commands
//      enabled under it. The expectation is DERIVED from the registry
//      (`dependsOn`, `visibleUnder` — src/core/capabilityGating.ts), so a new
//      gated command is covered the moment it is registered, and a snapshot of
//      the gating map fences which commands depend on each capability.
//
// The world every case is driven against is the conformance suite's
// (`src/core/testing/conformanceFixture.ts`), with the fixture's `Capabilities`
// injected — one place builds it, both suites read it. Nothing real runs:
// `node:child_process` and `fetch` are disarmed for the whole file.

vi.mock("node:child_process", () => {
  const armed = (name: string) => () => {
    throw new Error(`capability suite: node:child_process.${name} must never run — a command reached a real executor`);
  };
  return {
    spawn: armed("spawn"),
    spawnSync: armed("spawnSync"),
    exec: armed("exec"),
    execSync: armed("execSync"),
    execFile: armed("execFile"),
    execFileSync: armed("execFileSync"),
    fork: armed("fork"),
  };
});

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("capability suite: fetch must never run — a command reached the network");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** The conformance world under this shape's capabilities. */
const under = (caps: Capabilities): Promise<Fixture> => fixture(() => {}, "config", caps);

/** How many axes are on: booleans as themselves, the two enums by their all-on value. */
function axesOn(caps: Capabilities): number {
  return CAPABILITY_KEYS.filter((k) => caps[k] === ALL_CAPABILITIES[k]).length;
}

// ---- the surfaces, as one shape sees them --------------------------------------------------------

async function helpOnChat(f: Fixture): Promise<string> {
  const parsed = parseChatCommand("help", f.commands);
  if (!parsed) throw new Error("chat did not recognize `help`");
  const res = await invokeChatCommand({
    commands: f.commands,
    parsed,
    msg: { channelId: CHAT_CHANNEL, userId: POWER, threadKey: `${CHAT_CHANNEL}:t1` },
    config: f.config,
    now: NOW,
  });
  expect(res.ok, res.text).toBe(true);
  return res.text;
}

/** Every `/api/<id>` that answers an admin with anything but 404, sorted. */
async function httpCatalogue(f: Fixture): Promise<string[]> {
  const present: string[] = [];
  for (const cmd of CATALOGUE) if ((await presenceOf(f, cmd)).http) present.push(cmd.id);
  return present.sort();
}

async function cliCatalogue(f: Fixture): Promise<string> {
  const out = await runCli(f.commands, { kind: "catalogue" }, CLI_CALLER);
  expect(out.exitCode).toBe(0);
  return out.stdout;
}

/** A page's seed island, read back the way the web app reads it. */
function seedOf(html: string): unknown {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the rendered page");
  return JSON.parse(m[1]);
}

/** One GET through the real live-view handler (the index and scheduled routes finish asynchronously). */
function page(handler: ReturnType<typeof createLiveViewHandler>, url: string, ctx: LiveViewContext): Promise<unknown> {
  const chunks: string[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const req = { method: "GET", url, headers: {}, socket: { remoteAddress: "127.0.0.1" }, on: () => {} };
  const res = {
    writeHead: () => {},
    write: (c: string) => void chunks.push(c),
    end: (c?: string) => {
      if (c) chunks.push(c);
      finish();
    },
  };
  const handled = handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
    ctx,
  );
  expect(handled, `${url}: the live view claims this route`).toBe(true);
  return finished.then(() => seedOf(chunks.join("")));
}

/**
 * The `/runs` and `/runs/scheduled` seeds as src/index.ts wires them for this
 * shape: the shell stamps the capabilities; retention is the configured window
 * only when run history is on; the Scheduled panel always lists the registry's
 * schedules and has a firing store only when schedules are on.
 */
async function webSeeds(caps: Capabilities) {
  const registry = new RunRegistry({ now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  const handler = createLiveViewHandler({
    shell: makeShellRenderer({ js: "/assets/main-test.js", css: [] }, caps),
    service: createRunsService({ registry, store: caps.runHistory ? store : null, clock: () => NOW }),
    index: registry,
    retention: caps.runHistory ? { retentionDays: 30 } : null,
    scheduled: { schedules: SCHEDULES, store: caps.schedules ? new InMemoryScheduleStore() : undefined },
    now: () => NOW,
  });
  const admin: LiveViewContext = { actor: callerWith("access", "access:admin", "all").actor };
  const runs = (await page(handler, "/runs", admin)) as RunsIndexSeed & { capabilities: Capabilities };
  const scheduled = (await page(handler, "/runs/scheduled", admin)) as ScheduledSeed & {
    capabilities: Capabilities;
  };
  expect(scheduled.capabilities).toEqual(runs.capabilities);
  return {
    capabilities: runs.capabilities,
    runs: {
      retentionDays: runs.retentionDays,
      retention: retentionSentence(runs.retentionDays),
      rows: runs.rows.length,
    },
    scheduled: {
      schedules: scheduled.rows === null ? null : scheduled.rows.map((r) => r.name),
      firingsUnavailable: scheduled.firingsUnavailable ?? null,
    },
  };
}

// ---- 1. the fixtures are configurations ----------------------------------------------------------

describe("capability fixtures — real configurations", () => {
  it.each(CAPABILITY_FIXTURES)(
    "$name: its config.yaml and env produce its Capabilities through capabilitiesFrom (the round trip)",
    (fx: CapabilityFixture) => {
      expect(capabilitiesFrom(parseAppConfigText(fx.yaml), fx.env, secretsFrom(fx.env))).toEqual(fx.capabilities);
    },
  );

  it("minimal is the contract's all-off value with the local-dev dashboard; cloud-full is its all-on value", () => {
    const [minimal, , cloudFull] = CAPABILITY_FIXTURES;
    expect(minimal.capabilities).toEqual(NO_CAPABILITIES);
    expect(cloudFull.capabilities).toEqual(ALL_CAPABILITIES);
  });

  it("the three shapes are distinct and strictly more is on in each than the one before", () => {
    const counts = CAPABILITY_FIXTURES.map((fx) => axesOn(fx.capabilities));
    expect(CAPABILITY_FIXTURES.map((fx) => fx.name)).toEqual(["minimal", "local-full", "cloud-full"]);
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
    expect(counts[2]).toBe(CAPABILITY_KEYS.length);
  });

  it("local-full turns on nothing that needs a Worker: execution local, no residents, costs, schedules or ledger", () => {
    const local = CAPABILITY_FIXTURES[1].capabilities;
    expect(local).toMatchObject({
      execution: "local",
      residents: false,
      costs: false,
      schedules: false,
      runLedger: false,
    });
    expect(local).toMatchObject({ memory: true, runHistory: true, mcp: true, github: true });
  });
});

// ---- 1. every surface under each shape -----------------------------------------------------------

describe.each(CAPABILITY_FIXTURES.map((fx) => ({ name: fx.name, fx })))("capability surfaces — $name", ({ fx }) => {
  it("help on chat", async () => {
    expect(await helpOnChat(await under(fx.capabilities))).toMatchSnapshot();
  });

  it("MCP tools/list names", async () => {
    expect((await mcpToolNames(await under(fx.capabilities))).sort()).toMatchSnapshot();
  });

  it("HTTP catalogue: the /api/<id> routes that answer an admin", async () => {
    expect(await httpCatalogue(await under(fx.capabilities))).toMatchSnapshot();
  });

  it("CLI catalogue", async () => {
    expect(await cliCatalogue(await under(fx.capabilities))).toMatchSnapshot();
  });

  it("web seeds: /runs (capabilities, retention sentence) and /runs/scheduled (schedules, firing store)", async () => {
    const seeds = await webSeeds(fx.capabilities);
    expect(seeds.capabilities).toEqual(fx.capabilities);
    expect(seeds).toMatchSnapshot();
  });

  it("self-description block (the resident cap is the Worker's answer — 6 where there is a fleet)", () => {
    expect(
      selfDescriptionBlock(AGENTS, "acme", fx.capabilities, fx.capabilities.residents ? 6 : undefined),
    ).toMatchSnapshot();
  });
});

// ---- 1. the deploy plan --------------------------------------------------------------------------

describe("deploy plan — what `deploy plan` prints", () => {
  const raw = JSON.parse(readFileSync(new URL("../../deploy/profile.example.json", import.meta.url), "utf8")) as {
    workers: { bot: unknown };
  };
  const loaded = (profile: unknown, path: string): LoadedProfile => {
    const parsed = parseProfile(profile);
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    return { profile: parsed.profile, origin: "example", path };
  };
  const example = loaded(raw, PROFILE_EXAMPLE_PATH);
  /** The example profile with only the bot: the smallest installation the profile can describe. */
  const botOnly = loaded({ ...raw, workers: { bot: raw.workers.bot } }, "deploy/profile.bot-only.json");
  const options = (only?: WorkerName[]): DeployOptions => ({
    only,
    skip: undefined,
    dryRun: true,
    force: false,
    allowBranch: false,
    waitMaxMinutes: 10,
    pollSeconds: 60,
  });
  const checkout = { root: { mode: "checkout" as const, path: "/work/switchboard" }, hasNodeModules: () => true };

  it("the full example profile: every Worker, in the canonical order", () => {
    const plan = planDeploy(options(), checkout, example, {
      mode: "registry",
      published: TEST_PUBLISHED_IMAGES,
      unprobed: "the example profile",
    });
    expect(plan.steps.map((s) => s.name)).toEqual(DEPLOY_ORDER);
    expect(formatPlan(plan)).toMatchSnapshot();
  });

  it("a bot-only profile is a one-step plan with no state Worker to push the config to", () => {
    const plan = planDeploy(options(), checkout, botOnly, {
      mode: "registry",
      published: TEST_PUBLISHED_IMAGES,
      unprobed: "the example profile",
    });
    expect(plan.steps.map((s) => s.name)).toEqual(["bot"]);
    expect(plan.config.stateWorkerUrl).toBeUndefined();
    expect(formatPlan(plan)).toMatchSnapshot();
  });
});

// ---- 2. the capability axis ----------------------------------------------------------------------

/** The commands each adapter shows, sorted — what the fixture's surfaces actually answer. */
async function shownOn(f: Fixture): Promise<Record<AdapterKind, string[]>> {
  const shown: Record<AdapterKind, string[]> = { http: [], mcp: [], cli: [], chat: [] };
  for (const cmd of CATALOGUE) {
    const presence = await presenceOf(f, cmd);
    for (const kind of ADAPTER_KINDS) if (presence[kind]) shown[kind].push(cmd.id);
  }
  for (const kind of ADAPTER_KINDS) shown[kind].sort();
  return shown;
}

/** The commands each adapter must show under `caps`: enabled by the registry AND exposed on that surface. */
function expectedOn(caps: Capabilities): Record<AdapterKind, string[]> {
  const enabled = visibleUnder(CATALOGUE, caps);
  return Object.fromEntries(
    ADAPTER_KINDS.map((kind) => [
      kind,
      enabled
        .filter((cmd) => CommandRegistry.exposedTo(cmd, ADAPTER_CALLER_KIND[kind]))
        .map((cmd) => cmd.id)
        .sort(),
    ]),
  ) as Record<AdapterKind, string[]>;
}

describe("capability axis — a capability turning on changes exactly the commands its enabledWhen names", () => {
  it("which commands each capability turns on, derived from the registry's enabledWhen — update deliberately", () => {
    const gating = Object.fromEntries(
      CATALOGUE.filter((cmd) => dependsOn(cmd).length > 0).map((cmd) => [cmd.id, dependsOn(cmd)]),
    );
    expect(gating).toMatchSnapshot();
  });

  it.each(CAPABILITY_FIXTURES)("$name: every adapter shows exactly the commands enabled under it", async (fx) => {
    expect(await shownOn(await under(fx.capabilities))).toEqual(expectedOn(fx.capabilities));
  });

  it.each(CAPABILITY_KEYS)(
    "%s: from the minimal world, turning it on changes exactly the commands whose enabledWhen depends on it, on every adapter",
    async (key) => {
      const on = withOn(key);
      const [shownOff, shownOn_] = [await shownOn(await under(NO_CAPABILITIES)), await shownOn(await under(on))];
      expect(shownOff).toEqual(expectedOn(NO_CAPABILITIES));
      expect(shownOn_).toEqual(expectedOn(on));
      // The commands this flip adds and removes, from the predicates alone — and every one of them depends on the axis.
      const added = CATALOGUE.filter((cmd) => !isEnabled(cmd, NO_CAPABILITIES) && isEnabled(cmd, on));
      const removed = CATALOGUE.filter((cmd) => isEnabled(cmd, NO_CAPABILITIES) && !isEnabled(cmd, on));
      for (const cmd of [...added, ...removed]) expect(dependsOn(cmd), `${cmd.id} depends on ${key}`).toContain(key);
      const ids = (cmds: typeof CATALOGUE, kind: AdapterKind) =>
        cmds
          .filter((cmd) => CommandRegistry.exposedTo(cmd, ADAPTER_CALLER_KIND[kind]))
          .map((cmd) => cmd.id)
          .sort();
      for (const kind of ADAPTER_KINDS) {
        expect(
          shownOn_[kind].filter((id) => !shownOff[kind].includes(id)),
          `${key} on ${kind}: added`,
        ).toEqual(ids(added, kind));
        expect(
          shownOff[kind].filter((id) => !shownOn_[kind].includes(id)),
          `${key} on ${kind}: removed`,
        ).toEqual(ids(removed, kind));
      }
    },
  );
});
