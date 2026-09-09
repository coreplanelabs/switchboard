import { describe, expect, it } from "vitest";
import type { AffectedReport } from "../../deploy/affected.js";
import { formatPlan, type DeployHost, type DeployPlan } from "../../deploy/plan.js";
import { profileUrls, type LoadedProfile } from "../../deploy/profile.js";
import type { DeployRunResult } from "../../deploy/run.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { parseInvocation } from "../commandSurface.js";
import { RESTART_TOKEN_ENV, type RestartPlan } from "../../deploy/restart.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES, TEST_REGISTRY_PROFILE } from "../../deploy/testing/profile.js";
import type { ImagesHostIO } from "../../deploy/imagesHost.js";
import type { RestartRunResult } from "../../deploy/run.js";
import {
  GENERATED_HEADER,
  PROJECT_FACTS_FILE,
  SITE_CONFIG_TARGET,
  TEMPLATE_FILE,
  workerConfigTargets,
} from "../../deploy/wranglerTemplate.js";
import type { SecretsSource } from "../../deploy/secrets.js";
import type { SecretsHostIO } from "../../deploy/secretsHost.js";
import {
  deployAll,
  deployInit,
  deployPlan,
  deployRestart,
  deployConfig,
  deployImages,
  deploySecrets,
  registerDeployCommands,
  type DeployCommandDeps,
} from "./deploy.js";

// Feature: docs/reference/specs/command-registry.md (phase 4b): the production deploy order
// as commands — `deploy plan` (pure, every surface) and `deploy all` (CLI only;
// the former `npm run deploy:all`), sharing one option set so the plan you read
// is the plan you run. The runner is injected; nothing here spawns a process.

const cli: Caller = callerWith("cli", "cli:local", "all");
/** A Slack admin: every grant. */
const admin: Caller = callerWith("chat", "slack:UADMIN", "all");
const mcp = (...actions: string[]): Caller => callerWith("mcp", "mcp:alice", actions);

const neverRestarts = async (): Promise<RestartRunResult> => {
  throw new Error("must not restart");
};

const neverAffected = async (): Promise<AffectedReport> => {
  throw new Error("must not compute affected");
};

/** A report as src/deploy/affected.ts would produce: the bot and resident selected, memory and sandbox not. */
const REPORT: AffectedReport = {
  head: "f".repeat(40),
  workers: [
    { name: "memory", decision: "skip", base: { kind: "live", commit: "a".repeat(40) }, reasons: [] },
    { name: "bot", decision: "deploy", base: { kind: "live", commit: "a".repeat(40) }, reasons: ["src/index.ts"] },
    {
      name: "resident",
      decision: "deploy",
      base: { kind: "release", tag: "v0.1.0", commit: "c".repeat(40) },
      reasons: ["deploy/cloudflare-resident/Dockerfile"],
    },
    { name: "sandbox", decision: "skip", base: { kind: "live", commit: "a".repeat(40) }, reasons: [] },
  ],
  selected: ["bot", "resident"],
  unclassified: [],
  deployAll: false,
  markdown: "(md)",
};
const NOTHING: AffectedReport = {
  ...REPORT,
  workers: REPORT.workers.map((w) => ({ ...w, decision: "skip", reasons: [] })),
  selected: [],
};

/** The installation the tests deploy to: the fixture profile, loaded as a real one. */
const LOADED: LoadedProfile = { profile: TEST_PROFILE, origin: "profile", path: "deploy/profile.json" };
/** Where the tests run from: a checkout, unless a test says it is the published package in an operator's directory. */
const CHECKOUT_ROOT: DeployHost["root"] = { mode: "checkout", path: "/work/switchboard" };
const PACKAGE_ROOT_AT: DeployHost["root"] = { mode: "package", path: "/srv/switchboard", version: "1.12.0" };
const URLS = profileUrls(TEST_PROFILE);
const BOT_HEALTH_URL = URLS.healthUrl("bot");
const BOT_ADMIN_RESTART_URL = URLS.botAdminRestartUrl;

function bind(
  run: (plan: DeployPlan) => Promise<DeployRunResult>,
  hasNodeModules: (dir: string) => boolean = () => true,
  restart: (plan: RestartPlan) => Promise<RestartRunResult> = neverRestarts,
  affected: (opts: { base?: string }) => Promise<AffectedReport> = neverAffected,
  profile: () => Promise<LoadedProfile> = async () => LOADED,
  // project.json is on every disk: the Workers' images and the site's name come from it.
  disk: Map<string, string> = new Map([[PROJECT_FACTS_FILE, FACTS]]),
  secrets: SecretsHostIO = noSecrets,
  pushConfig: DeployCommandDeps["deploy"]["pushConfig"] = neverPushes,
  root: DeployHost["root"] = CHECKOUT_ROOT,
  images: ImagesHostIO = noImages,
) {
  const registry = new CommandRegistry<DeployCommandDeps>({ audit: () => {} });
  registerDeployCommands(registry);
  const plans: DeployPlan[] = [];
  const restartPlans: RestartPlan[] = [];
  const affectedCalls: { base?: string }[] = [];
  const writes: string[] = [];
  const commands = bindCommands(registry, {
    deploy: {
      run: (plan) => {
        plans.push(plan);
        return run(plan);
      },
      restart: (plan) => {
        restartPlans.push(plan);
        return restart(plan);
      },
      host: { root, hasNodeModules },
      affected: (opts) => {
        affectedCalls.push(opts);
        return affected(opts);
      },
      profile,
      secrets,
      pushConfig,
      images,
      cliVersion: () => TEST_PUBLISHED_IMAGES.version,
      files: {
        read: async (path) => disk.get(path),
        write: async (path, text) => {
          writes.push(path);
          disk.set(path, text);
        },
      },
    },
  });
  return { commands, plans, restartPlans, affectedCalls, disk, writes };
}

/** An images host that must never be reached — every test but `deploy.images`'s (and registry-mode plans) binds it. */
const noImages: ImagesHostIO = {
  registry: async () => {
    throw new Error("must not read the registry");
  },
  docker: async () => {
    throw new Error("must not probe docker");
  },
  copy: async () => {
    throw new Error("must not copy");
  },
};

/** A config push that must never happen — every test but `deploy.config`'s binds it. */
const neverPushes: DeployCommandDeps["deploy"]["pushConfig"] = async () => {
  throw new Error("must not push config");
};
/** A secrets host that must never be reached — every test but `deploy.secrets`'s binds it. */
const noSecrets: SecretsHostIO = {
  manifest: async () => {
    throw new Error("must not read the manifest");
  },
  present: async () => {
    throw new Error("must not probe the source");
  },
  put: async () => {
    throw new Error("must not put");
  },
};

/** A one-line template per Worker dir (and the site's): enough to see the profile and the facts land in the render. */
const TEMPLATE = '{ "name": "{{script}}", "account_id": "{{account}}", "routes": [{ "pattern": "{{hostname}}" }] }\n';
/** The project facts the site's config renders from — a made-up project, so no test pins the real host. */
const FACTS = JSON.stringify({
  name: "switchboard",
  docs: "https://docs.example.test",
  images: TEST_PUBLISHED_IMAGES.names,
});
const templatesOnDisk = () =>
  new Map<string, string>([
    ...workerConfigTargets(TEST_PROFILE).map((t): [string, string] => [t.templatePath, TEMPLATE]),
    [SITE_CONFIG_TARGET.templatePath, TEMPLATE],
    [PROJECT_FACTS_FILE, FACTS],
  ]);
/** Every file `deploy init` renders: the Workers the profile has, then the site. */
const renderedPaths = () => [
  ...workerConfigTargets(TEST_PROFILE).map((t) => t.outputPath),
  SITE_CONFIG_TARGET.outputPath,
];
const neverRunsPlan = async (): Promise<DeployRunResult> => {
  throw new Error("must not run");
};
const neverRuns = () => bind(neverRunsPlan);

describe("deploy.plan", () => {
  it("computes the canonical plan (memory → bot → resident → sandbox) with the bot's live gate, and renders formatPlan", async () => {
    const { commands } = neverRuns();
    const res = await commands.invoke("deploy.plan", {}, admin);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const plan = res.value as unknown as DeployPlan;
    expect(plan.steps.map((s) => s.name)).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(plan.steps[1]).toMatchObject({ liveGate: { healthUrl: BOT_HEALTH_URL }, retryOnPreflightRefusal: true });
    expect(plan).toMatchObject({
      dryRun: true,
      force: false,
      waitMaxMs: 10 * 60_000,
      pollMs: 60_000,
      checks: { atOriginMain: true },
    });
    expect(renderText(commands.get("deploy.plan")!, res.value)).toBe(formatPlan(plan));
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain("then wait until live");
    // A rotated secret needs no image build: the plan points at `deploy restart`.
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain("deploy restart");
  });

  it("carries where it runs from (deps.deploy.host.root) and prints it first: a checkout, or the published package in the operator's directory with the git checks off", async () => {
    const checkout = await neverRuns().commands.invoke("deploy.plan", {}, cli);
    if (!checkout.ok) throw new Error(checkout.message);
    expect((checkout.value as unknown as DeployPlan).root).toEqual(CHECKOUT_ROOT);
    expect(renderText(deployPlan, checkout.value).split("\n")[0]).toBe("Root: /work/switchboard (a checkout)");
    const { commands } = bind(
      async () => {
        throw new Error("must not run");
      },
      () => true,
      neverRestarts,
      neverAffected,
      async () => LOADED,
      new Map(),
      noSecrets,
      neverPushes,
      PACKAGE_ROOT_AT,
    );
    const pkg = await commands.invoke("deploy.plan", {}, cli);
    if (!pkg.ok) throw new Error(pkg.message);
    const plan = pkg.value as unknown as DeployPlan;
    expect(plan.root).toEqual(PACKAGE_ROOT_AT);
    expect(plan.checks).toMatchObject({ cleanTree: false, atOriginMain: false });
    const text = renderText(deployPlan, pkg.value);
    expect(text.split("\n")[0]).toBe("Root: /srv/switchboard (the published package 1.12.0)");
    expect(text).not.toContain("origin/main");
  });

  it("reads the checkout through its deps: the dirs without node_modules are in checks.nodeModulesMissing and the rendered check line names them", async () => {
    const { commands } = bind(
      async () => {
        throw new Error("must not run");
      },
      (dir) => dir !== "deploy/cloudflare-sandbox",
    );
    const res = await commands.invoke("deploy.plan", {}, cli);
    if (!res.ok) throw new Error(res.message);
    expect((res.value as unknown as DeployPlan).checks.nodeModulesMissing).toEqual(["deploy/cloudflare-sandbox"]);
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain(
      "node_modules missing in deploy/cloudflare-sandbox — the runner will `npm ci` there first",
    );
    const all = await neverRuns().commands.invoke("deploy.plan", {}, cli);
    if (!all.ok) throw new Error(all.message);
    expect(renderText(commands.get("deploy.plan")!, all.value)).toContain("node_modules present in every dir");
  });

  it("--only/--skip (comma lists), --force, --allow-branch, --wait-max, --poll shape the plan; an unknown Worker or an empty selection is invalid_input naming the expectation", async () => {
    const { commands } = neverRuns();
    const bound = parseInvocation(commands.get("deploy.plan")!, [
      "--only",
      "bot,resident",
      "--skip",
      "resident",
      "--force",
      "--allow-branch",
      "--wait-max",
      "5",
      "--poll",
      "10",
    ]);
    expect(bound.kind).toBe("invoke");
    const res = await commands.invoke("deploy.plan", bound.kind === "invoke" ? bound.input : {}, cli);
    if (!res.ok) throw new Error(res.message);
    const plan = res.value as unknown as DeployPlan;
    expect(plan.steps.map((s) => s.name)).toEqual(["bot"]);
    expect(plan.steps[0]).toMatchObject({ setEnv: { SWITCHBOARD_DEPLOY_FORCE: "1" }, retryOnPreflightRefusal: false });
    expect(plan).toMatchObject({ force: true, waitMaxMs: 5 * 60_000, pollMs: 10_000, checks: { atOriginMain: false } });
    expect(plan.warnings[0]).toContain("--force");
    const bad = await commands.invoke("deploy.plan", { options: { only: "bot,frontend" } }, cli);
    expect(bad).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "only: expected a comma list of Workers (memory, bot, resident, sandbox)",
    });
    expect(JSON.stringify(bad)).not.toContain("frontend");
    expect(await commands.invoke("deploy.plan", { options: { only: "bot", skip: "bot" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "nothing to deploy after --only/--skip filters",
    });
    expect(await commands.invoke("deploy.plan", { options: { waitMax: "0" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("--affected asks the probe once and plans exactly the report's selection (in order, minus --skip); the report rides on the plan and renders first; --base reaches the probe", async () => {
    const { commands, affectedCalls } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      async () => REPORT,
    );
    const res = await commands.invoke("deploy.plan", { options: { affected: true } }, cli);
    if (!res.ok) throw new Error(res.message);
    const plan = res.value as unknown as DeployPlan;
    expect(affectedCalls).toEqual([{}]);
    expect(plan.steps.map((s) => s.name)).toEqual(["bot", "resident"]);
    expect(plan.affected).toEqual(REPORT);
    const text = renderText(commands.get("deploy.plan")!, res.value);
    expect(text.startsWith("Affected: bot, resident (HEAD fffffff; judged per Worker against what it serves)")).toBe(
      true,
    );
    expect(text).toContain("  - resident: deploy — release v0.1.0 — deploy/cloudflare-resident/Dockerfile");
    const skipped = await commands.invoke("deploy.plan", { options: { affected: true, skip: "resident" } }, cli);
    expect(skipped.ok && (skipped.value as unknown as DeployPlan).steps.map((s) => s.name)).toEqual(["bot"]);
    const bound = parseInvocation(commands.get("deploy.plan")!, ["--affected", "--base", "HEAD^"]);
    expect(bound.kind).toBe("invoke");
    await commands.invoke("deploy.plan", bound.kind === "invoke" ? bound.input : {}, cli);
    expect(affectedCalls.at(-1)).toEqual({ base: "HEAD^" });
    // Without --affected the probe is never consulted (the checkout may be no repo at all).
    const plain = await bind(neverRunsPlan).commands.invoke("deploy.plan", {}, cli);
    expect(plain.ok && (plain.value as unknown as DeployPlan).affected).toBeUndefined();
  });

  it("--only narrows an --affected selection (never widens it); --base without --affected is invalid_input; a hostile --base never reaches the probe", async () => {
    const { commands, affectedCalls } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      async () => REPORT,
    );
    const narrowed = await commands.invoke("deploy.plan", { options: { affected: true, only: "bot,memory" } }, cli);
    expect(narrowed.ok && (narrowed.value as unknown as DeployPlan).steps.map((s) => s.name)).toEqual(["bot"]); // memory is not affected; resident is, but was not asked for
    expect(affectedCalls).toEqual([{}]);
    expect(await commands.invoke("deploy.plan", { options: { base: "HEAD^" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "--base only means something with --affected",
    });
    const hostile = await commands.invoke("deploy.plan", { options: { affected: true, base: "HEAD; rm -rf /" } }, cli);
    expect(hostile).toMatchObject({ ok: false, error: "invalid_input" });
    expect(JSON.stringify(hostile)).not.toContain("rm -rf");
    // A leading `-` would reach git's argv looking like an option.
    expect(await commands.invoke("deploy.plan", { options: { affected: true, base: "-Ofile" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    expect(affectedCalls).toEqual([{}]); // only the narrowed call above reached the probe
  });

  it("an empty --affected selection is a successful plan with no steps — nothing to deploy is an answer, not a mistake", async () => {
    const { commands } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      async () => NOTHING,
    );
    const res = await commands.invoke("deploy.plan", { options: { affected: true } }, cli);
    if (!res.ok) throw new Error(res.message);
    expect((res.value as unknown as DeployPlan).steps).toEqual([]);
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain(
      "Affected: nothing to deploy — every Worker already serves this tree's inputs",
    );
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain("Steps: none — nothing to deploy");
  });

  it("is operator-gated in chat, deploy:read on machine surfaces, and exposed everywhere; deploy.all is CLI-only", async () => {
    const { commands } = neverRuns();
    expect(deployPlan).toMatchObject({ action: "deploy:read", effect: "read" });
    expect(deployPlan.surfaces).toBeUndefined();
    expect(deployAll).toMatchObject({
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(await commands.invoke("deploy.plan", {}, mcp("runs:read"))).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    expect((await commands.invoke("deploy.plan", {}, mcp("deploy:read"))).ok).toBe(true);
    expect(await commands.invoke("deploy.all", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("deploy.all", {}, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});

describe("deploy.all", () => {
  it("hands the runner the SAME plan `deploy plan` computes (dryRun false) and reports the version → live table on success", async () => {
    const { commands, plans } = bind(async (plan) => ({
      kind: "ran",
      ok: true,
      results: plan.steps.map((s) => ({
        name: s.name,
        script: s.script,
        versionId: `v-${s.name}`,
        live: s.liveGate ? "live" : "n/a",
        status: "deployed",
      })),
      notAttempted: [],
    }));
    const res = await commands.invoke("deploy.all", { options: { only: "memory,bot" } }, cli);
    expect(res.ok).toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0].steps.map((s) => s.name)).toEqual(["memory", "bot"]);
    expect(plans[0].dryRun).toBe(false);
    const planned = await commands.invoke("deploy.plan", { options: { only: "memory,bot" } }, cli);
    expect(planned.ok && { ...(planned.value as object), dryRun: false }).toEqual(plans[0]);
    const text = renderText(commands.get("deploy.all")!, res.ok ? res.value : null);
    expect(text).toMatch(/^deployed and live\n/);
    expect(text).toContain("memory    switchboard-memory     v-memory                               n/a      deployed");
    expect(text).toContain("bot       switchboard            v-bot                                  live     deployed");
  });

  it("a refused pre-check is `unavailable` listing the problems; a stopped run is `unavailable` with the table, incl. what was not attempted (exit 1 on the CLI, never 0)", async () => {
    const refused = bind(async () => ({
      kind: "refused",
      problems: ["working tree is not clean", "HEAD abc1234 != origin/main def5678"],
    }));
    expect(await refused.commands.invoke("deploy.all", {}, cli)).toMatchObject({
      ok: false,
      error: "unavailable",
      message: "refusing —\n  - working tree is not clean\n  - HEAD abc1234 != origin/main def5678",
    });
    const stopped = bind(async () => ({
      kind: "ran",
      ok: false,
      results: [
        { name: "memory", script: "switchboard-memory", versionId: "v1", live: "n/a", status: "deployed" },
        {
          name: "bot",
          script: "switchboard",
          versionId: "v2",
          live: "deployed, not live: old container still draining",
          status: "FAILED: deployed but NOT live",
        },
      ],
      notAttempted: ["resident", "sandbox"],
    }));
    const res = await stopped.commands.invoke("deploy.all", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toContain("deploy stopped —");
    expect(res.ok ? "" : res.message).toContain("FAILED: deployed but NOT live");
    expect(res.ok ? "" : res.message).toContain("not attempted: resident, sandbox");
    expect(
      await stopped.commands.invoke("deploy.all", { options: { skip: "memory,bot,resident,sandbox" } }, cli),
    ).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("a step whose preflight was still refusing at the end of the wait budget is `unavailable` like any stopped run: what a refusal names now is a rollout still settling, a real anomaly past the budget (runs in flight no longer refuse — run-history item 39)", async () => {
    const stuck = bind(async () => ({
      kind: "ran",
      ok: false,
      results: [
        { name: "memory", script: "switchboard-memory", versionId: "v1", live: "n/a", status: "deployed" },
        {
          name: "bot",
          script: "switchboard",
          live: "not deployed",
          status: "FAILED: preflight still refusing after 10 min (container rollout in progress: state=updating)",
        },
      ],
      notAttempted: ["resident", "sandbox"],
    }));
    const res = await stuck.commands.invoke("deploy.all", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    const message = res.ok ? "" : res.message;
    expect(message).toMatch(/^deploy stopped —/);
    expect(message).toContain("state=updating");
    expect(message).toContain("memory    switchboard-memory     v1");
    expect(message).toContain("not attempted: resident, sandbox");
    const mixed = bind(async () => ({
      kind: "ran",
      ok: false,
      results: [
        {
          name: "bot",
          script: "switchboard",
          versionId: "v2",
          live: "deployed, not live: old container still draining",
          status: "FAILED: deployed but NOT live",
        },
      ],
      notAttempted: ["resident", "sandbox"],
    }));
    expect(await mixed.commands.invoke("deploy.all", {}, cli)).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("--affected hands the runner the report's plan (dryRun false, the report attached); an empty selection runs nothing and says so with exit 0", async () => {
    const { commands, plans } = bind(
      async (plan) => ({
        kind: "ran",
        ok: true,
        results: plan.steps.map((s) => ({
          name: s.name,
          script: s.script,
          versionId: `v-${s.name}`,
          live: s.liveGate ? "live" : "n/a",
          status: "deployed",
        })),
        notAttempted: [],
      }),
      () => true,
      neverRestarts,
      async () => REPORT,
    );
    const res = await commands.invoke("deploy.all", { options: { affected: true } }, cli);
    expect(res.ok).toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0].steps.map((s) => s.name)).toEqual(["bot", "resident"]);
    expect(plans[0]).toMatchObject({ dryRun: false, affected: REPORT });
    expect(renderText(commands.get("deploy.all")!, res.ok ? res.value : null)).toContain(
      "bot       switchboard            v-bot",
    );

    const nothing = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      async () => NOTHING,
    );
    const idle = await nothing.commands.invoke("deploy.all", { options: { affected: true } }, cli);
    expect(idle.ok).toBe(true);
    expect(nothing.plans).toEqual([]); // the runner was never called
    const text = renderText(commands.get("deploy.all")!, idle.ok ? idle.value : null);
    expect(text.startsWith("nothing to deploy — every Worker already serves this tree's inputs\n")).toBe(true);
    expect(text).toContain("Steps: none — nothing to deploy");
  });
});

// `deploy restart` (docs/reference/specs/slack-channel.md item 8): restart the bot container
// without a build so a rotated secret goes live — the runner is injected.
describe("deploy.restart", () => {
  const BEFORE = "2026-08-30T10:00:00.000Z";
  const AFTER = "2026-08-30T10:00:41.000Z";
  const restarted = async (plan: RestartPlan): Promise<RestartRunResult> => ({
    kind: "ran",
    ok: true,
    target: plan.target,
    previousStartedAt: BEFORE,
    startedAt: AFTER,
    waitedMs: 41_000,
  });

  it("is CLI-only, deploy:write, operator-gated — like deploy.all", async () => {
    const { commands } = neverRuns();
    expect(deployRestart).toMatchObject({
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(await commands.invoke("deploy.restart", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("deploy.restart", {}, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("hands the runner the bot plan (default --only bot; --force/--wait-max/--poll shape it) and renders the old → new startedAt", async () => {
    const { commands, restartPlans } = bind(
      async () => {
        throw new Error("must not deploy");
      },
      () => true,
      restarted,
    );
    const res = await commands.invoke("deploy.restart", {}, cli);
    expect(res.ok).toBe(true);
    expect(restartPlans).toEqual([
      {
        target: "bot",
        adminUrl: BOT_ADMIN_RESTART_URL,
        healthUrl: BOT_HEALTH_URL,
        tokenEnv: RESTART_TOKEN_ENV,
        force: false,
        waitMaxMs: 10 * 60_000,
        pollMs: 60_000,
        liveDeadlineMs: expect.any(Number),
      },
    ]);
    const text = renderText(commands.get("deploy.restart")!, res.ok ? res.value : null);
    expect(text).toContain("bot restarted");
    expect(text).toContain(`startedAt ${AFTER} (was ${BEFORE})`);
    expect(text).toContain("41s");
    const bound = parseInvocation(commands.get("deploy.restart")!, [
      "--only",
      "bot",
      "--force",
      "--wait-max",
      "5",
      "--poll",
      "10",
    ]);
    expect(bound.kind).toBe("invoke");
    await commands.invoke("deploy.restart", bound.kind === "invoke" ? bound.input : {}, cli);
    expect(restartPlans[1]).toMatchObject({ force: true, waitMaxMs: 5 * 60_000, pollMs: 10_000 });
  });

  it("only the bot can be restarted: another Worker is invalid_input (they have no long-lived container)", async () => {
    const { commands, restartPlans } = bind(async () => {
      throw new Error("must not deploy");
    });
    expect(await commands.invoke("deploy.restart", { options: { only: "resident" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    expect(await commands.invoke("deploy.restart", { options: { waitMax: "0" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    expect(restartPlans).toEqual([]);
  });

  it("a refused runner (no bearer) and a run that did not go live are `unavailable` with the reason — exit 1, never 0", async () => {
    const refused = bind(
      async () => {
        throw new Error("must not deploy");
      },
      () => true,
      async () => ({ kind: "refused", problems: ["SWITCHBOARD_DEPLOY_TOKEN is not set in the environment"] }),
    );
    expect(await refused.commands.invoke("deploy.restart", {}, cli)).toMatchObject({
      ok: false,
      error: "unavailable",
      message: "refusing —\n  - SWITCHBOARD_DEPLOY_TOKEN is not set in the environment",
    });
    const notLive = bind(
      async () => {
        throw new Error("must not deploy");
      },
      () => true,
      async () => ({
        kind: "ran",
        ok: false,
        target: "bot",
        previousStartedAt: BEFORE,
        waitedMs: 1_200_000,
        reason: "old container still answering (started 2026-08-30T10:00:00.000Z) — gave up after 20 min",
      }),
    );
    const res = await notLive.commands.invoke("deploy.restart", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toContain("bot NOT restarted — old container still answering");
  });
});

describe("deploy.init", () => {
  const init = (disk: Map<string, string>, profile: () => Promise<LoadedProfile> = async () => LOADED) =>
    bind(neverRunsPlan, () => true, neverRestarts, neverAffected, profile, disk);

  it("is CLI-only, deploy:write, operator-gated — like deploy.all", async () => {
    const { commands } = init(templatesOnDisk());
    expect(deployInit).toMatchObject({
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(await commands.invoke("deploy.init", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("deploy.init", {}, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("renders every Worker's wrangler.jsonc from its template and the profile, and the site's from project.json (header first), writes them, and is a no-op the second time", async () => {
    const { commands, disk, writes } = init(templatesOnDisk());
    const res = await commands.invoke("deploy.init", {}, cli);
    if (!res.ok) throw new Error(res.message);
    const paths = renderedPaths();
    expect(res.value).toEqual({
      profile: { origin: "profile", path: "deploy/profile.json" },
      files: paths.map((path) => ({ path, status: "written" })),
    });
    expect(writes).toEqual(paths);
    expect(disk.get("deploy/cloudflare-resident/wrangler.jsonc")).toBe(
      `${GENERATED_HEADER.join("\n")}\n{ "name": "switchboard-resident", "account_id": "${TEST_PROFILE.account}", "routes": [{ "pattern": "switchboard-resident.example.test" }] }\n`,
    );
    // The site: `<name>-docs` on the docs host from the facts, the account from the profile.
    expect(disk.get("deploy/cloudflare-docs/wrangler.jsonc")).toBe(
      `${GENERATED_HEADER.join("\n")}\n{ "name": "switchboard-docs", "account_id": "${TEST_PROFILE.account}", "routes": [{ "pattern": "docs.example.test" }] }\n`,
    );
    expect(renderText(commands.get("deploy.init")!, res.value)).toBe(
      ["Worker configs from deploy/profile.json:", ...paths.map((path) => `  written   ${path}`)].join("\n"),
    );
    const again = await commands.invoke("deploy.init", {}, cli);
    if (!again.ok) throw new Error(again.message);
    expect((again.value as { files: { status: string }[] }).files.every((f) => f.status === "unchanged")).toBe(true);
    expect(writes).toHaveLength(paths.length);
  });

  it("from the published package the files are written by their tree path and the output names where they land: under .switchboard/", async () => {
    const disk = templatesOnDisk();
    const { commands, writes } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => LOADED,
      disk,
      noSecrets,
      neverPushes,
      PACKAGE_ROOT_AT,
    );
    const res = await commands.invoke("deploy.init", {}, cli);
    if (!res.ok) throw new Error(res.message);
    const paths = renderedPaths();
    // The host's file access maps a tree path into the work area; the command hands it tree paths.
    expect(writes).toEqual(paths);
    expect((res.value as { files: { path: string }[] }).files.map((f) => f.path)).toEqual(
      paths.map((p) => `.switchboard/${p}`),
    );
    expect(renderText(commands.get("deploy.init")!, res.value)).toContain(
      "  written   .switchboard/deploy/cloudflare-memory/wrangler.jsonc",
    );
  });

  it("the site's config needs project.json: without it, or with a `docs` fact that is not a URL, the render is `unavailable` naming the file; nothing is written", async () => {
    const noFacts = templatesOnDisk();
    noFacts.delete(PROJECT_FACTS_FILE);
    const without = init(noFacts);
    const res = await without.commands.invoke("deploy.init", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toContain("project.json: no such file");
    expect(without.writes).toEqual([]);
    const badFacts = templatesOnDisk();
    badFacts.set(PROJECT_FACTS_FILE, JSON.stringify({ name: "switchboard", docs: "not a url" }));
    const bad = init(badFacts);
    const badRes = await bad.commands.invoke("deploy.init", {}, cli);
    expect(badRes.ok ? "" : badRes.message).toContain('project.json: `docs` "not a url" is not a URL');
    expect(bad.writes).toEqual([]);
  });

  it("--check writes nothing: equal files pass; a hand-edited or absent rendered file is `conflict` (exit 1) naming it and the fix", async () => {
    const disk = templatesOnDisk();
    const { commands, writes } = init(disk);
    const missing = await commands.invoke("deploy.init", { options: { check: true } }, cli);
    expect(missing).toMatchObject({ ok: false, error: "conflict" });
    expect(missing.ok ? "" : missing.message).toContain("deploy/cloudflare-memory/wrangler.jsonc (missing)");
    expect(missing.ok ? "" : missing.message).toContain("run `npm run deploy:gen` and commit the result");
    expect(writes).toEqual([]);
    // Generate, then the check passes …
    await commands.invoke("deploy.init", {}, cli);
    expect(await commands.invoke("deploy.init", { options: { check: true } }, cli)).toMatchObject({ ok: true });
    // … until someone edits a rendered file by hand.
    disk.set("deploy/cloudflare/wrangler.jsonc", `${disk.get("deploy/cloudflare/wrangler.jsonc")}// tweak\n`);
    const stale = await commands.invoke("deploy.init", { options: { check: true } }, cli);
    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    expect(stale.ok ? "" : stale.message).toContain("deploy/cloudflare/wrangler.jsonc (stale)");
    expect(stale.ok ? "" : stale.message).not.toContain("cloudflare-memory");
  });

  it("a missing template or a placeholder the profile cannot fill is `unavailable` naming the template file; nothing is written", async () => {
    const disk = templatesOnDisk();
    disk.delete(`deploy/cloudflare-sandbox/${TEMPLATE_FILE}`);
    disk.set(`deploy/cloudflare/${TEMPLATE_FILE}`, '"{{access.aud}}"\n');
    const { commands, writes } = init(disk);
    const res = await commands.invoke("deploy.init", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toContain(`deploy/cloudflare-sandbox/${TEMPLATE_FILE}: no such file`);
    expect(res.ok ? "" : res.message).toContain(
      `deploy/cloudflare/${TEMPLATE_FILE} line 1: {{access.aud}} has no value in the deployment profile`,
    );
    expect(writes).toEqual([]);
  });

  it("renders from the example profile too (a fresh clone can see the shape) and the text says so", async () => {
    const example: LoadedProfile = { ...LOADED, origin: "example", path: "deploy/profile.example.json" };
    const { commands } = init(templatesOnDisk(), async () => example);
    const res = await commands.invoke("deploy.init", {}, cli);
    if (!res.ok) throw new Error(res.message);
    expect(renderText(commands.get("deploy.init")!, res.value)).toContain(
      "Worker configs from deploy/profile.example.json (the EXAMPLE profile):",
    );
  });
});

describe("deploy.secrets", () => {
  const MANIFEST = {
    secrets: [
      { name: "SLACK_BOT_TOKEN", workers: ["bot"] },
      { name: "ANTHROPIC_ADMIN_KEY", workers: ["bot"], optional: true },
      { name: "MEMORY_TOKEN", workers: ["bot", "resident", "memory"] },
    ],
  };
  /** A source holding `values`; every put is recorded (name + dir), never a value, and answers `putCode`. */
  function host(values: string[], opts: { manifest?: unknown; putCode?: (name: string) => number } = {}) {
    const puts: string[] = [];
    const probes: { source: SecretsSource; names: readonly string[] }[] = [];
    const io: SecretsHostIO = {
      manifest: async () => ("manifest" in opts ? opts.manifest : MANIFEST),
      present: async (source, names) => {
        probes.push({ source, names });
        return { ok: true, present: new Set(names.filter((n) => values.includes(n))) };
      },
      put: async (_source, dir, name) => {
        puts.push(`${name} → ${dir}`);
        return { code: opts.putCode?.(name) ?? 0, output: opts.putCode?.(name) ? "✘ [ERROR] boom" : "" };
      },
    };
    return { io, puts, probes };
  }
  /** The templates are on disk (a checkout has them); the rendered wrangler.jsonc is NOT (gitignored) unless `disk` says so. */
  const withSecrets = (
    io: SecretsHostIO,
    profile: () => Promise<LoadedProfile> = async () => LOADED,
    disk: Map<string, string> = templatesOnDisk(),
  ) => bind(neverRunsPlan, () => true, neverRestarts, neverAffected, profile, disk, io);

  it("is CLI-only, deploy:write, operator-gated — like deploy.all", async () => {
    const { commands } = withSecrets(host([]).io);
    expect(deploySecrets).toMatchObject({
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(await commands.invoke("deploy.secrets", { args: ["bot"] }, admin)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await commands.invoke("deploy.secrets", { args: ["bot"] }, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("puts every manifest secret the Worker holds that the source has, in manifest order, from the profile's source (the default directory when unset); an absent optional one is skipped and said", async () => {
    const h = host(["SLACK_BOT_TOKEN", "MEMORY_TOKEN"]);
    const { commands, disk, writes } = withSecrets(h.io);
    const res = await commands.invoke("deploy.secrets", { args: ["bot"] }, cli);
    if (!res.ok) throw new Error(res.message);
    expect(res.value).toEqual({
      worker: "bot",
      dir: "deploy/cloudflare",
      source: "~/.secrets/switchboard/<NAME>",
      put: ["SLACK_BOT_TOKEN", "MEMORY_TOKEN"],
      skippedOptional: ["ANTHROPIC_ADMIN_KEY"],
    });
    expect(h.puts).toEqual(["SLACK_BOT_TOKEN → deploy/cloudflare", "MEMORY_TOKEN → deploy/cloudflare"]);
    // The Worker's wrangler.jsonc (generated, absent from a clean checkout) is rendered from the
    // profile BEFORE wrangler runs in that dir — the same file `deploy init` writes, and only this
    // Worker's.
    expect(writes).toEqual(["deploy/cloudflare/wrangler.jsonc"]);
    expect(disk.get("deploy/cloudflare/wrangler.jsonc")).toContain(`"name": "switchboard"`);
    // The source was asked once, about the Worker's names only.
    expect(h.probes).toEqual([
      {
        source: { kind: "dir", path: "~/.secrets/switchboard" },
        names: ["SLACK_BOT_TOKEN", "ANTHROPIC_ADMIN_KEY", "MEMORY_TOKEN"],
      },
    ]);
    expect(renderText(commands.get("deploy.secrets")!, res.value)).toBe(
      [
        "skip  ANTHROPIC_ADMIN_KEY (optional; no value at ~/.secrets/switchboard/ANTHROPIC_ADMIN_KEY)",
        "put   SLACK_BOT_TOKEN → deploy/cloudflare",
        "put   MEMORY_TOKEN → deploy/cloudflare",
        "done: 2 secret(s) on bot from ~/.secrets/switchboard/<NAME>",
      ].join("\n"),
    );
  });

  it("from the published package the puts run in the same tree-path directory and the output names it under .switchboard/", async () => {
    const h = host(["MEMORY_TOKEN"]);
    const { commands } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => LOADED,
      templatesOnDisk(),
      h.io,
      neverPushes,
      PACKAGE_ROOT_AT,
    );
    const res = await commands.invoke("deploy.secrets", { args: ["memory"] }, cli);
    if (!res.ok) throw new Error(res.message);
    expect(res.value).toMatchObject({
      worker: "memory",
      dir: ".switchboard/deploy/cloudflare-memory",
      put: ["MEMORY_TOKEN"],
    });
    expect(h.puts).toEqual(["MEMORY_TOKEN → deploy/cloudflare-memory"]);
    expect(renderText(commands.get("deploy.secrets")!, res.value)).toContain(
      "put   MEMORY_TOKEN → .switchboard/deploy/cloudflare-memory",
    );
  });

  it("reads an op:// source from the profile; the memory Worker gets only its own secret", async () => {
    const h = host(["MEMORY_TOKEN"]);
    const op: LoadedProfile = {
      ...LOADED,
      profile: { ...TEST_PROFILE, secretsSource: "op://Prod/Switchboard secrets" },
    };
    const { commands } = withSecrets(h.io, async () => op);
    const res = await commands.invoke("deploy.secrets", { args: ["memory"] }, cli);
    if (!res.ok) throw new Error(res.message);
    expect(res.value).toMatchObject({
      worker: "memory",
      dir: "deploy/cloudflare-memory",
      source: "op://Prod/Switchboard secrets/<NAME>",
      put: ["MEMORY_TOKEN"],
    });
    expect(h.probes[0].source).toEqual({ kind: "op", vault: "Prod", item: "Switchboard secrets" });
  });

  it("refuses BEFORE any upload when a required value is absent, naming the secret and where it was expected", async () => {
    const h = host(["SLACK_BOT_TOKEN"]);
    const { commands } = withSecrets(h.io);
    const res = await commands.invoke("deploy.secrets", { args: ["bot"] }, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toBe(
      "refusing: no value for required bot secret(s) MEMORY_TOKEN — expected ~/.secrets/switchboard/<NAME>. Nothing uploaded.",
    );
    expect(h.puts).toEqual([]);
  });

  it("--only narrows the put; a name that is not one of the Worker's secrets is invalid_input naming the manifest's", async () => {
    const h = host(["SLACK_BOT_TOKEN", "MEMORY_TOKEN"]);
    const { commands } = withSecrets(h.io);
    const res = await commands.invoke("deploy.secrets", { args: ["bot"], options: { only: "MEMORY_TOKEN" } }, cli);
    if (!res.ok) throw new Error(res.message);
    expect(res.value).toMatchObject({ put: ["MEMORY_TOKEN"], skippedOptional: [] });
    expect(h.puts).toEqual(["MEMORY_TOKEN → deploy/cloudflare"]);
    const bad = await commands.invoke("deploy.secrets", { args: ["bot"], options: { only: "SANDBOX_TOKEN" } }, cli);
    expect(bad).toMatchObject({ ok: false, error: "invalid_input" });
    expect(bad.ok ? "" : bad.message).toContain(
      "SANDBOX_TOKEN is not a bot secret (manifest: SLACK_BOT_TOKEN, ANTHROPIC_ADMIN_KEY, MEMORY_TOKEN)",
    );
    expect(
      await commands.invoke("deploy.secrets", { args: ["bot"], options: { only: "lowercase" } }, cli),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await commands.invoke("deploy.secrets", { args: ["edge"] }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("renders only the target Worker's wrangler.jsonc and leaves a current one alone; a template that cannot render is `unavailable` naming it, with nothing put", async () => {
    const h = host(["MEMORY_TOKEN"]);
    const current = templatesOnDisk();
    const first = withSecrets(h.io, undefined, current);
    const one = await first.commands.invoke("deploy.secrets", { args: ["memory"] }, cli);
    if (!one.ok) throw new Error(one.message);
    expect(first.writes).toEqual(["deploy/cloudflare-memory/wrangler.jsonc"]);
    // Rendered already (by `deploy init` or a previous put): nothing rewritten, the put still happens.
    const second = withSecrets(host(["MEMORY_TOKEN"]).io, undefined, current);
    const two = await second.commands.invoke("deploy.secrets", { args: ["memory"] }, cli);
    if (!two.ok) throw new Error(two.message);
    expect(second.writes).toEqual([]);
    // No template on disk: refused before any put, naming the template.
    const bare = host(["MEMORY_TOKEN"]);
    const none = await withSecrets(bare.io, undefined, new Map([[PROJECT_FACTS_FILE, FACTS]])).commands.invoke(
      "deploy.secrets",
      { args: ["memory"] },
      cli,
    );
    expect(none).toMatchObject({ ok: false, error: "unavailable" });
    expect(none.ok ? "" : none.message).toContain(`cannot render deploy/cloudflare-memory/wrangler.jsonc`);
    expect(none.ok ? "" : none.message).toContain(`deploy/cloudflare-memory/${TEMPLATE_FILE}: no such file`);
    expect(bare.puts).toEqual([]);
  });

  it("a failed put stops the run naming what was not attempted and wrangler's [ERROR] line; a missing or invalid manifest, an unreadable source, and a bad secretsSource are `unavailable`", async () => {
    const failing = host(["SLACK_BOT_TOKEN", "MEMORY_TOKEN"], { putCode: (n) => (n === "SLACK_BOT_TOKEN" ? 1 : 0) });
    const res = await withSecrets(failing.io).commands.invoke("deploy.secrets", { args: ["bot"] }, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toBe(
      "wrangler secret put SLACK_BOT_TOKEN failed (exit 1) in deploy/cloudflare; stopping — MEMORY_TOKEN not attempted. [ERROR] boom",
    );
    expect(failing.puts).toEqual(["SLACK_BOT_TOKEN → deploy/cloudflare"]);

    const none = await withSecrets(host([], { manifest: undefined }).io).commands.invoke(
      "deploy.secrets",
      { args: ["bot"] },
      cli,
    );
    expect(none).toMatchObject({ ok: false, error: "unavailable" });
    expect(none.ok ? "" : none.message).toBe("deploy/secrets.manifest.json: no such file");

    const invalid = await withSecrets(
      host([], { manifest: { secrets: [{ name: "x", workers: [] }] } }).io,
    ).commands.invoke("deploy.secrets", { args: ["bot"] }, cli);
    expect(invalid).toMatchObject({ ok: false, error: "unavailable" });
    expect(invalid.ok ? "" : invalid.message).toContain("deploy/secrets.manifest.json is invalid");

    const unreadable: SecretsHostIO = {
      ...host([]).io,
      present: async () => ({
        ok: false,
        problem: "secretsSource ~/.secrets/switchboard: no such directory (/home/x/.secrets/switchboard)",
      }),
    };
    const dir = await withSecrets(unreadable).commands.invoke("deploy.secrets", { args: ["bot"] }, cli);
    expect(dir).toMatchObject({ ok: false, error: "unavailable" });
    expect(dir.ok ? "" : dir.message).toContain("no such directory");

    const badSource: LoadedProfile = { ...LOADED, profile: { ...TEST_PROFILE, secretsSource: "s3://bucket" } };
    const bad = await withSecrets(host([]).io, async () => badSource).commands.invoke(
      "deploy.secrets",
      { args: ["bot"] },
      cli,
    );
    expect(bad).toMatchObject({ ok: false, error: "unavailable" });
    expect(bad.ok ? "" : bad.message).toContain("unknown scheme");
  });
});

describe("deploy.config", () => {
  function pusher(outcome: Awaited<ReturnType<DeployCommandDeps["deploy"]["pushConfig"]>>) {
    const calls: { source: string; stateWorkerUrl: string; key: string }[] = [];
    const pushConfig: DeployCommandDeps["deploy"]["pushConfig"] = async (o) => {
      calls.push(o);
      return outcome;
    };
    return { calls, pushConfig };
  }
  const withPush = (
    p: DeployCommandDeps["deploy"]["pushConfig"],
    profile: () => Promise<LoadedProfile> = async () => LOADED,
  ) => bind(neverRunsPlan, () => true, neverRestarts, neverAffected, profile, new Map(), noSecrets, p);
  const PUSHED = {
    ok: true as const,
    how: "config from config/config.production.yaml",
    version: 7,
    sha256: "ab".repeat(32),
    bytes: 9007,
  };

  // Feature: docs/reference/specs/release-and-deploy.md item 14 — a profile without a state Worker has no document to push to.
  it("a profile with no memory (state) Worker → `unavailable` naming the profile, and nothing is pushed", async () => {
    const p = pusher(PUSHED);
    const botOnly: LoadedProfile = {
      ...LOADED,
      profile: { ...TEST_PROFILE, workers: { bot: TEST_PROFILE.workers.bot } },
    };
    const { commands } = withPush(p.pushConfig, async () => botOnly);
    const res = await commands.invoke("deploy.config", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable", decidedBy: "handler" });
    expect(res.ok ? "" : res.message).toContain("deploy/profile.json names no memory (state) Worker");
    expect(p.calls).toEqual([]);
  });

  it("is CLI-only, deploy:write, operator-gated — like deploy.all", async () => {
    const { commands } = withPush(pusher(PUSHED).pushConfig);
    expect(deployConfig).toMatchObject({
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(await commands.invoke("deploy.config", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("deploy.config", {}, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("pushes the profile's configSource to the `base` document on the profile's state Worker and says how to make it live", async () => {
    const p = pusher(PUSHED);
    const { commands } = withPush(p.pushConfig);
    const res = await commands.invoke("deploy.config", {}, cli);
    if (!res.ok) throw new Error(res.message);
    expect(p.calls).toEqual([
      {
        source: "config/config.production.yaml",
        stateWorkerUrl: "https://switchboard-memory.example.test",
        key: "base",
      },
    ]);
    expect(res.value).toEqual({
      source: "config/config.production.yaml",
      how: "config from config/config.production.yaml",
      document: "base",
      stateWorkerUrl: "https://switchboard-memory.example.test",
      version: 7,
      sha256: "ab".repeat(32),
      bytes: 9007,
    });
    expect(renderText(commands.get("deploy.config")!, res.value)).toBe(
      [
        'pushed config from config/config.production.yaml → document "base" v7 on https://switchboard-memory.example.test (sha256 abababababab, 9007 bytes)',
        "the bot reads it on its next start: `deploy restart`",
      ].join("\n"),
    );
  });

  it("--source overrides the profile's configSource", async () => {
    const p = pusher(PUSHED);
    const { commands } = withPush(p.pushConfig);
    const res = await commands.invoke(
      "deploy.config",
      { options: { source: "github://acme/infra/switchboard/config.yaml@main" } },
      cli,
    );
    if (!res.ok) throw new Error(res.message);
    expect(p.calls[0].source).toBe("github://acme/infra/switchboard/config.yaml@main");
  });

  it("an unreadable or invalid source, a missing bearer, or a refusing Worker is `unavailable` with the host's problem", async () => {
    const p = pusher({
      ok: false,
      problem: "configSource config/nope.yaml: the config does not validate — No model configured",
    });
    const res = await withPush(p.pushConfig).commands.invoke("deploy.config", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toBe(
      "configSource config/nope.yaml: the config does not validate — No model configured",
    );
  });
});

// Feature: docs/reference/specs/release-and-deploy.md items 25–26 — `deploy images`
// copies the release's images into the account registry once per version, and in
// `registry` mode `deploy plan` / `deploy all` refuse a step whose image is not
// there. The host half is injected; nothing here runs Docker or wrangler.
describe("deploy.images", () => {
  const ACCOUNT = TEST_PROFILE.account;
  const REGISTRY: LoadedProfile = { profile: TEST_REGISTRY_PROFILE, origin: "profile", path: "deploy/profile.json" };
  const target = (name: string, version = "1.2.3") => `registry.cloudflare.com/${ACCOUNT}/${name}:${version}`;

  /** An images host over an in-memory registry: `copy` records the call and lands the tag; `docker` answers as told. */
  function imagesHost(
    present: Record<string, string[]>,
    docker: { ok: true } | { ok: false; problem: string } = { ok: true },
  ) {
    const registry = new Map(Object.entries(present).map(([name, tags]) => [name, new Set(tags)]));
    const copies: string[] = [];
    const accounts: string[] = [];
    let listed = 0;
    const io: ImagesHostIO = {
      registry: async (account) => {
        accounts.push(account);
        listed++;
        return { value: [...registry.entries()].map(([name, tags]) => ({ name, tags: [...tags] })) };
      },
      docker: async () => docker,
      copy: async (copy, account) => {
        copies.push(`${copy.source} → ${copy.target}`);
        accounts.push(account);
        registry.set(copy.name, new Set([...(registry.get(copy.name) ?? []), copy.version]));
        return { code: 0, output: `Pushed image: ${copy.target}\n` };
      },
    };
    return {
      io,
      copies,
      accounts,
      listings: () => listed,
      forget: (name: string) => registry.delete(name),
    };
  }
  const withImages = (h: ReturnType<typeof imagesHost>, profile: LoadedProfile = REGISTRY) =>
    bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => profile,
      undefined,
      noSecrets,
      neverPushes,
      CHECKOUT_ROOT,
      h.io,
    );

  it("is CLI-only, deploy:write, operator-gated — like deploy.all", async () => {
    const { commands } = withImages(imagesHost({}));
    expect(deployImages).toMatchObject({
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(await commands.invoke("deploy.images", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("deploy.images", {}, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("copies the images the account registry lacks at the CLI's version — pull from where the release published them, push under the account — skips the ones present, confirms each landed, and says so", async () => {
    const h = imagesHost({ switchboard: ["1.2.3", "1.2.2"] });
    const { commands } = withImages(h);
    const res = await commands.invoke("deploy.images", {}, cli);
    if (!res.ok) throw new Error(res.message);
    expect(res.value).toEqual({
      version: "1.2.3",
      account: ACCOUNT,
      images: [
        { kind: "bot", source: "ghcr.io/example/switchboard:1.2.3", target: target("switchboard"), status: "present" },
        {
          kind: "resident",
          source: "ghcr.io/example/switchboard-resident:1.2.3",
          target: target("switchboard-resident"),
          status: "copied",
        },
        {
          kind: "sandbox",
          source: "ghcr.io/example/switchboard-sandbox:1.2.3",
          target: target("switchboard-sandbox"),
          status: "copied",
        },
      ],
    });
    expect(h.copies).toEqual([
      `ghcr.io/example/switchboard-resident:1.2.3 → ${target("switchboard-resident")}`,
      `ghcr.io/example/switchboard-sandbox:1.2.3 → ${target("switchboard-sandbox")}`,
    ]);
    // Read before (the plan) and after (the proof); every call carries the profile's account.
    expect(h.listings()).toBe(2);
    expect(new Set(h.accounts)).toEqual(new Set([ACCOUNT]));
    expect(renderText(commands.get("deploy.images")!, res.value)).toBe(
      [
        `present    bot      ${target("switchboard")}`,
        `copied     resident ${target("switchboard-resident")} ← ghcr.io/example/switchboard-resident:1.2.3`,
        `copied     sandbox  ${target("switchboard-sandbox")} ← ghcr.io/example/switchboard-sandbox:1.2.3`,
        `version 1.2.3 on account ${ACCOUNT}: 1 present, 2 copied`,
      ].join("\n"),
    );
    // Idempotent: a second run finds everything present, copies nothing, never asks for Docker.
    const again = withImages(
      imagesHost(
        { switchboard: ["1.2.3"], "switchboard-resident": ["1.2.3"], "switchboard-sandbox": ["1.2.3"] },
        { ok: false, problem: "no docker" },
      ),
    );
    const twice = await again.commands.invoke("deploy.images", {}, cli);
    if (!twice.ok) throw new Error(twice.message);
    expect((twice.value as { images: { status: string }[] }).images.every((i) => i.status === "present")).toBe(true);
    expect(renderText(commands.get("deploy.images")!, twice.value)).toContain("3 present, 0 copied");
  });

  it("--dry-run only says what would be copied and touches nothing; the version is always this CLI's own — there is no --version, since the rendered configs reference nothing else", async () => {
    const h = imagesHost({ switchboard: ["1.2.2"] });
    const { commands } = withImages(h);
    const res = await commands.invoke("deploy.images", { options: { dryRun: true } }, cli);
    if (!res.ok) throw new Error(res.message);
    expect(res.value).toMatchObject({
      version: "1.2.3",
      images: [
        { kind: "bot", target: target("switchboard"), status: "would copy" },
        { kind: "resident", status: "would copy" },
        { kind: "sandbox", status: "would copy" },
      ],
    });
    expect(h.copies).toEqual([]);
    expect(h.listings()).toBe(1);
    expect(renderText(commands.get("deploy.images")!, res.value)).toContain(
      "0 present, 3 to copy (dry run — nothing pulled or pushed)",
    );
    expect(Object.keys(deployImages.options!.shape)).toEqual(["dryRun"]);
    const skew = await commands.invoke("deploy.images", { options: { version: "2.0.0" } }, cli);
    expect(skew).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("refuses the example profile, a registry that cannot be read, and — before anything is pulled — a host without Docker, naming where Docker is", async () => {
    const example: LoadedProfile = { ...REGISTRY, origin: "example", path: "deploy/profile.example.json" };
    const onExample = await withImages(imagesHost({}), example).commands.invoke("deploy.images", {}, cli);
    expect(onExample).toMatchObject({ ok: false, error: "unavailable" });
    expect(onExample.ok ? "" : onExample.message).toContain("deploy/profile.example.json is the example profile");
    const unreadable: ImagesHostIO = {
      ...imagesHost({}).io,
      registry: async () => ({
        error: "wrangler containers images list --json failed: ✘ [ERROR] Authentication error",
      }),
    };
    const denied = await bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => REGISTRY,
      undefined,
      noSecrets,
      neverPushes,
      CHECKOUT_ROOT,
      unreadable,
    ).commands.invoke("deploy.images", {}, cli);
    expect(denied).toMatchObject({ ok: false, error: "unavailable" });
    expect(denied.ok ? "" : denied.message).toBe(
      "cannot read the account registry — wrangler containers images list --json failed: ✘ [ERROR] Authentication error",
    );
    const noDocker = imagesHost(
      {},
      { ok: false, problem: "docker is not available here — run it in .github/workflows/deploy-production.yml" },
    );
    const refused = await withImages(noDocker).commands.invoke("deploy.images", {}, cli);
    expect(refused).toMatchObject({ ok: false, error: "unavailable" });
    expect(refused.ok ? "" : refused.message).toBe(
      "docker is not available here — run it in .github/workflows/deploy-production.yml",
    );
    expect(noDocker.copies).toEqual([]);
  });

  it("a failed copy stops the run naming the image, what was not attempted and wrangler's [ERROR] line; a push the registry does not list afterwards is a failure too", async () => {
    const failing = imagesHost({ switchboard: ["1.2.3"] });
    failing.io.copy = async (copy) => {
      failing.copies.push(copy.kind);
      return {
        code: 1,
        output:
          "npx wrangler containers push switchboard-resident:1.2.3 exited 1\n✘ [ERROR] Unsupported platform: Image platform (linux/arm64)\n",
      };
    };
    const res = await withImages(failing).commands.invoke("deploy.images", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toBe(
      `copying the resident image (ghcr.io/example/switchboard-resident:1.2.3 → ${target("switchboard-resident")}) failed (exit 1); stopping — sandbox not attempted. [ERROR] Unsupported platform: Image platform (linux/arm64)`,
    );
    expect(failing.copies).toEqual(["resident"]);
    const silent = imagesHost({ switchboard: ["1.2.3"], "switchboard-resident": ["1.2.3"] });
    const landsNowhere = silent.io.copy;
    silent.io.copy = async (copy, account) => {
      const r = await landsNowhere(copy, account);
      silent.forget(copy.name);
      return r;
    };
    const unlisted = await withImages(silent).commands.invoke("deploy.images", {}, cli);
    expect(unlisted).toMatchObject({ ok: false, error: "unavailable" });
    expect(unlisted.ok ? "" : unlisted.message).toBe(
      `pushed ${target("switchboard-sandbox")}, but the account registry does not list ${target("switchboard-sandbox")} afterwards`,
    );
  });

  it("without `images` in project.json the command (and every render) is `unavailable` naming the file", async () => {
    const disk = new Map([
      [PROJECT_FACTS_FILE, JSON.stringify({ name: "switchboard", docs: "https://docs.example.test" })],
    ]);
    const { commands } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => REGISTRY,
      disk,
      noSecrets,
      neverPushes,
      CHECKOUT_ROOT,
      imagesHost({}).io,
    );
    const res = await commands.invoke("deploy.images", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toBe("project.json: `images` is missing");
  });

  it("a `build`-mode plan never reads the published images: project.json without `images` still plans, its Images line from the Dockerfiles alone; the same facts in `registry` mode are `unavailable`", async () => {
    const noImages = () =>
      new Map([[PROJECT_FACTS_FILE, JSON.stringify({ name: "switchboard", docs: "https://docs.example.test" })]]);
    const build = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => LOADED,
      noImages(),
    );
    const res = await build.commands.invoke("deploy.plan", {}, cli);
    if (!res.ok) throw new Error(res.message);
    expect((res.value as unknown as DeployPlan).images).toEqual({
      mode: "build",
      images: [
        { kind: "bot", dockerfile: "../../Dockerfile" },
        { kind: "resident", dockerfile: "./Dockerfile" },
        { kind: "sandbox", dockerfile: "./Dockerfile" },
      ],
    });
    const registry = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => REGISTRY,
      noImages(),
    );
    const refused = await registry.commands.invoke("deploy.plan", {}, cli);
    expect(refused).toMatchObject({ ok: false, error: "unavailable" });
    expect(refused.ok ? "" : refused.message).toBe("project.json: `images` is missing");
  });
});

describe("deploy.plan / deploy.all in registry mode", () => {
  const ACCOUNT = TEST_PROFILE.account;
  const REGISTRY: LoadedProfile = { profile: TEST_REGISTRY_PROFILE, origin: "profile", path: "deploy/profile.json" };
  const listing = (names: string[]): ImagesHostIO => ({
    registry: async () => ({ value: names.map((name) => ({ name, tags: ["1.2.3"] })) }),
    docker: async () => {
      throw new Error("must not probe docker");
    },
    copy: async () => {
      throw new Error("must not copy");
    },
  });
  const planWith = (
    io: ImagesHostIO,
    profile: LoadedProfile = REGISTRY,
    run: (plan: DeployPlan) => Promise<DeployRunResult> = neverRunsPlan,
  ) =>
    bind(
      run,
      () => true,
      neverRestarts,
      neverAffected,
      async () => profile,
      undefined,
      noSecrets,
      neverPushes,
      CHECKOUT_ROOT,
      io,
    );

  it("probes the account registry once and plans with every step's image present — the plan says so and `deploy all` runs it", async () => {
    let probes = 0;
    const io = listing(["switchboard", "switchboard-resident", "switchboard-sandbox"]);
    const counted: ImagesHostIO = { ...io, registry: async (a) => (probes++, io.registry(a)) };
    const { commands, plans } = planWith(counted, REGISTRY, async (plan) => ({
      kind: "ran",
      ok: true,
      results: plan.steps.map((s) => ({ name: s.name, script: s.script, live: "n/a", status: "deployed" })),
      notAttempted: [],
    }));
    const res = await commands.invoke("deploy.plan", {}, cli);
    if (!res.ok) throw new Error(res.message);
    const plan = res.value as unknown as DeployPlan;
    expect(plan.images).toEqual({
      mode: "registry",
      version: "1.2.3",
      images: [
        { kind: "bot", ref: `registry.cloudflare.com/${ACCOUNT}/switchboard:1.2.3`, present: true },
        { kind: "resident", ref: `registry.cloudflare.com/${ACCOUNT}/switchboard-resident:1.2.3`, present: true },
        { kind: "sandbox", ref: `registry.cloudflare.com/${ACCOUNT}/switchboard-sandbox:1.2.3`, present: true },
      ],
    });
    expect(probes).toBe(1);
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain("Images: registry (version 1.2.3)");
    const all = await commands.invoke("deploy.all", {}, cli);
    expect(all.ok).toBe(true);
    expect(plans).toHaveLength(1);
  });

  it("from the package root the same registry-mode plan probes the same listing and plans the same references — the images are registry copies, nothing is built from the package's directories", async () => {
    const io = listing(["switchboard", "switchboard-resident", "switchboard-sandbox"]);
    const { commands } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => REGISTRY,
      undefined,
      noSecrets,
      neverPushes,
      PACKAGE_ROOT_AT,
      io,
    );
    const res = await commands.invoke("deploy.plan", {}, cli);
    if (!res.ok) throw new Error(res.message);
    const plan = res.value as unknown as DeployPlan;
    expect(plan.root).toEqual(PACKAGE_ROOT_AT);
    expect(plan.images).toMatchObject({
      mode: "registry",
      images: [
        { kind: "bot", ref: `registry.cloudflare.com/${ACCOUNT}/switchboard:1.2.3`, present: true },
        { kind: "resident", present: true },
        { kind: "sandbox", present: true },
      ],
    });
    const text = renderText(commands.get("deploy.plan")!, res.value);
    expect(text.split("\n")[0]).toBe("Root: /srv/switchboard (the published package 1.12.0)");
    expect(text).toContain("Images: registry (version 1.2.3)");
    expect(text).not.toContain("Dockerfile");
  });

  it("refuses — plan and all alike, nothing run — when a planned step's image is missing, naming the image and `deploy images`; a step without a container needs no image", async () => {
    const io = listing(["switchboard"]);
    const { commands, plans } = planWith(io);
    for (const id of ["deploy.plan", "deploy.all"]) {
      const res = await commands.invoke(id, {}, cli);
      expect(res, id).toMatchObject({ ok: false, error: "unavailable" });
      expect(res.ok ? "" : res.message).toBe(
        `refusing — the account registry has no image for resident (registry.cloudflare.com/${ACCOUNT}/switchboard-resident:1.2.3), sandbox (registry.cloudflare.com/${ACCOUNT}/switchboard-sandbox:1.2.3); run \`deploy images\` first: it copies the release's images at version 1.2.3 into the account registry`,
      );
    }
    expect(plans).toEqual([]);
    const memoryOnly = await commands.invoke("deploy.plan", { options: { only: "memory" } }, cli);
    expect(memoryOnly.ok).toBe(true);
    const botOnly = await commands.invoke("deploy.plan", { options: { only: "bot" } }, cli);
    expect(botOnly.ok).toBe(true);
  });

  it("a registry that cannot be read is `unavailable` with wrangler's words; the example profile is never probed and its plan reads `not probed`", async () => {
    const denied: ImagesHostIO = {
      ...listing([]),
      registry: async () => ({
        error: "wrangler containers images list --json failed: ✘ [ERROR] Authentication error",
      }),
    };
    const res = await planWith(denied).commands.invoke("deploy.plan", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toBe(
      "cannot read the account registry — wrangler containers images list --json failed: ✘ [ERROR] Authentication error",
    );
    const example: LoadedProfile = { ...REGISTRY, origin: "example", path: "deploy/profile.example.json" };
    const onExample = planWith(denied, example);
    const fromExample = await onExample.commands.invoke("deploy.plan", {}, cli);
    if (!fromExample.ok) throw new Error(fromExample.message);
    expect((fromExample.value as unknown as DeployPlan).images).toMatchObject({
      mode: "registry",
      images: [
        { kind: "bot", present: undefined },
        { kind: "resident", present: undefined },
        { kind: "sandbox", present: undefined },
      ],
    });
    expect(renderText(onExample.commands.get("deploy.plan")!, fromExample.value)).toContain("(not probed)");
  });

  it("build mode (the default, this project's own) never probes the registry and plans each Dockerfile", async () => {
    const res = await neverRuns().commands.invoke("deploy.plan", {}, cli);
    if (!res.ok) throw new Error(res.message);
    expect((res.value as unknown as DeployPlan).images).toEqual({
      mode: "build",
      images: [
        { kind: "bot", dockerfile: "../../Dockerfile" },
        { kind: "resident", dockerfile: "./Dockerfile" },
        { kind: "sandbox", dockerfile: "./Dockerfile" },
      ],
    });
  });

  it("`deploy init` in registry mode renders each container's image as the account registry reference at the CLI's version", async () => {
    const disk = new Map<string, string>([
      ...workerConfigTargets(TEST_PROFILE).map((t): [string, string] => [t.templatePath, '{ "image": "{{image}}" }\n']),
      [`deploy/cloudflare-memory/${TEMPLATE_FILE}`, '{ "name": "{{script}}" }\n'],
      [SITE_CONFIG_TARGET.templatePath, '{ "name": "{{script}}" }\n'],
      [PROJECT_FACTS_FILE, FACTS],
    ]);
    const { commands } = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => REGISTRY,
      disk,
      noSecrets,
      neverPushes,
      CHECKOUT_ROOT,
      noImages,
    );
    const res = await commands.invoke("deploy.init", {}, cli);
    if (!res.ok) throw new Error(res.message);
    expect(disk.get("deploy/cloudflare/wrangler.jsonc")).toContain(
      `{ "image": "registry.cloudflare.com/${ACCOUNT}/switchboard:1.2.3" }`,
    );
    expect(disk.get("deploy/cloudflare-sandbox/wrangler.jsonc")).toContain(
      `{ "image": "registry.cloudflare.com/${ACCOUNT}/switchboard-sandbox:1.2.3" }`,
    );
    // The same templates under the default profile render the Dockerfiles.
    const build = bind(
      neverRunsPlan,
      () => true,
      neverRestarts,
      neverAffected,
      async () => LOADED,
      new Map(disk),
      noSecrets,
      neverPushes,
      CHECKOUT_ROOT,
      noImages,
    );
    await build.commands.invoke("deploy.init", {}, cli);
    expect(build.disk.get("deploy/cloudflare/wrangler.jsonc")).toContain('{ "image": "../../Dockerfile" }');
  });
});
