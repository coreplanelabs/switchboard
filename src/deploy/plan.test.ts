import { describe, expect, it } from "vitest";
import type { AffectedReport } from "./affected.js";
import {
  capabilityProblem,
  classifyDeployOutput,
  CONFIG_DOCUMENT_KEY,
  containerApplicationName,
  decideAccount,
  DEPLOY_ORDER,
  formatPlan,
  formatPlanImages,
  planDeploy,
  RESIDENT_BEARER_ENVS,
  RESIDENT_WAIT_MAX_MS,
  SANDBOX_BEARER_ENV,
  SANDBOX_CONTAINER_CLASS,
  WORKER_SPECS,
  workersFor,
  type DeployHost,
  type DeployOptions,
  type DeployPlan,
  type ImagesInput,
} from "./plan.js";
import { EXAMPLE_ACCOUNT, profileUrls, type LoadedProfile } from "./profile.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES, TEST_REGISTRY_PROFILE } from "./testing/profile.js";

// The one production deploy order, as a pure plan (README "Deploying on
// Cloudflare Containers", AGENTS.md "Deploy order"). The runner
// (src/deploy/run.ts, behind the registry's `deploy all`) only executes what
// this module plans, so the order, the filters, the force gating, and the
// checks the plan reports are provable here without touching wrangler. The
// options are the registry's `deploy.*` parse (src/core/commands/deploy.ts);
// here they are built directly. WHERE the Workers live comes from a deployment
// profile (src/deploy/profile.ts); the fixture is an installation that is
// nobody's, so nothing here pins a real account or hostname.

const LOADED: LoadedProfile = { profile: TEST_PROFILE, origin: "profile", path: "deploy/profile.json" };
const WORKERS = workersFor(TEST_PROFILE);
const BOT_HEALTH_URL = profileUrls(TEST_PROFILE).healthUrl("bot");
const SANDBOX_HEALTH_URL = profileUrls(TEST_PROFILE).healthUrl("sandbox");

const DEFAULTS: DeployOptions = {
  only: undefined,
  skip: undefined,
  dryRun: false,
  force: false,
  allowBranch: false,
  waitMaxMinutes: 30,
  pollSeconds: 60,
};
const HOST_ROOT = { mode: "checkout" as const, path: "/work/switchboard" };
const installed: DeployHost = { root: HOST_ROOT, hasNodeModules: () => true };
/** The release's images, as the planner is told them; `build`-mode plans (the fixture's) name their Dockerfiles instead. */
const IMAGES: ImagesInput = { mode: "build" };
const plan = (
  opts: Partial<DeployOptions> = {},
  host: DeployHost = installed,
  loaded: LoadedProfile = LOADED,
  images: ImagesInput = IMAGES,
) => planDeploy({ ...DEFAULTS, ...opts }, host, loaded, images);

describe("WORKER_SPECS / workersFor / DEPLOY_ORDER", () => {
  it("is state Worker → bot → resident → sandbox, each once, each with its dir and command", () => {
    expect(DEPLOY_ORDER).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(WORKER_SPECS.map((w) => w.name)).toEqual(DEPLOY_ORDER);
    expect(WORKERS.map((w) => w.dir)).toEqual([
      "deploy/cloudflare-memory",
      "deploy/cloudflare",
      "deploy/cloudflare-resident",
      "deploy/cloudflare-sandbox",
    ]);
    expect(new Set(WORKERS.map((w) => w.script)).size).toBe(4);
  });

  it("names which steps are preflighted and how each preflight is forced; the resident needs any one of its three bearers — read is enough; the sandbox needs SANDBOX_TOKEN (its live gate reads everything with it)", () => {
    const byName = Object.fromEntries(WORKERS.map((w) => [w.name, w]));
    expect(byName.memory.preflight).toBeUndefined();
    expect(byName.sandbox.preflight).toBeUndefined();
    expect(byName.bot.preflight).toEqual({
      forceEnv: "SWITCHBOARD_DEPLOY_FORCE",
      baseUrlEnv: "SWITCHBOARD_BASE_URL",
      healthUrl: BOT_HEALTH_URL,
    });
    expect(byName.resident.preflight).toEqual({ forceEnv: "RESIDENT_DEPLOY_FORCE", baseUrlEnv: "RESIDENT_BASE_URL" });
    // Each Worker knows its own origin — what its preflight is pointed at.
    expect(WORKERS.map((w) => w.baseUrl)).toEqual([
      "https://switchboard-memory.example.test",
      "https://switchboard.example.test",
      "https://switchboard-resident.example.test",
      "https://switchboard-sandbox.example.test",
    ]);
    // The same three the resident's preflight.mjs reads (TOKEN_ENV_VARS): CI holds the read token and nothing more.
    expect(byName.resident.requiredEnv).toEqual([
      { anyOf: ["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"] },
    ]);
    expect(RESIDENT_BEARER_ENVS).toEqual(["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"]);
    expect(formatPlan(plan())).toContain(
      "needs one of RESIDENT_ADMIN_TOKEN / RESIDENT_OPERATOR_TOKEN / RESIDENT_READ_TOKEN",
    );
    expect(byName.sandbox.requiredEnv).toEqual([{ anyOf: ["SANDBOX_TOKEN"] }]);
    expect(byName.memory.requiredEnv).toBeUndefined();
    expect(byName.bot.requiredEnv).toBeUndefined();
    expect(formatPlan(plan())).toContain(
      "sandbox (switchboard-sandbox) — deploy/cloudflare-sandbox: npm run deploy — needs SANDBOX_TOKEN",
    );
  });

  it("the profile binds each Worker to its script name and hostname; the account, the health URLs and the config source are the profile's, never a constant", () => {
    expect(WORKERS.map((w) => [w.name, w.script, w.healthUrl])).toEqual([
      ["memory", "switchboard-memory", "https://switchboard-memory.example.test/healthz"],
      ["bot", "switchboard", "https://switchboard.example.test/healthz"],
      ["resident", "switchboard-resident", "https://switchboard-resident.example.test/healthz"],
      ["sandbox", "switchboard-sandbox", "https://switchboard-sandbox.example.test/healthz"],
    ]);
    const p = plan();
    expect(p.checks.account).toBe(TEST_PROFILE.account);
    expect(p.profile).toEqual({ origin: "profile", path: "deploy/profile.json" });
    // The config goes to the state Worker's `base` document, never into the image.
    expect(p.config).toEqual({
      source: "config/config.production.yaml",
      document: CONFIG_DOCUMENT_KEY,
      stateWorkerUrl: "https://switchboard-memory.example.test",
    });
    expect(CONFIG_DOCUMENT_KEY).toBe("base");
    expect(formatPlan(p)).toContain(
      'Profile: deploy/profile.json; config: config/config.production.yaml → document "base" on https://switchboard-memory.example.test',
    );
    // Another installation, another fleet — the same specs.
    const other = workersFor({
      ...TEST_PROFILE,
      workers: { ...TEST_PROFILE.workers, bot: { script: "sb", hostname: "sb.example.test" } },
    });
    expect(other.find((w) => w.name === "bot")).toMatchObject({
      script: "sb",
      healthUrl: "https://sb.example.test/healthz",
      baseUrl: "https://sb.example.test",
      preflight: {
        forceEnv: "SWITCHBOARD_DEPLOY_FORCE",
        baseUrlEnv: "SWITCHBOARD_BASE_URL",
        healthUrl: "https://sb.example.test/healthz",
      },
      liveGate: { kind: "health", healthUrl: "https://sb.example.test/healthz" },
    });
    // The sandbox's container application follows its script name: another script, another app.
    const renamed = workersFor({
      ...TEST_PROFILE,
      workers: { ...TEST_PROFILE.workers, sandbox: { script: "sbx", hostname: "sbx.example.test" } },
    });
    expect(renamed.find((w) => w.name === "sandbox")!.liveGate).toEqual({
      kind: "sandbox",
      healthUrl: "https://sbx.example.test/healthz",
      bearerEnv: "SANDBOX_TOKEN",
      containerApp: "sbx-switchboardsandbox",
    });
  });

  it("a plan from the example profile can be read, says so, and carries the origin `deploy all` refuses on", () => {
    const example: LoadedProfile = {
      profile: { ...TEST_PROFILE, account: EXAMPLE_ACCOUNT },
      origin: "example",
      path: "deploy/profile.example.json",
    };
    const p = plan({}, installed, example);
    expect(p.profile.origin).toBe("example");
    expect(p.warnings[0]).toContain("deploy/profile.example.json is the EXAMPLE");
    expect(formatPlan(p)).toContain("Profile: deploy/profile.example.json (example)");
  });

  it("every Worker names its entry, its /healthz and its inputs; only the sandbox's /healthz needs a bearer", () => {
    for (const w of WORKERS) {
      expect(w.entry, w.name).toBe(`${w.dir}/worker.ts`);
      expect(w.healthUrl, w.name).toMatch(
        /^https:\/\/switchboard(-memory|-resident|-sandbox)?\.example\.test\/healthz$/,
      );
      expect(w.inputs.paths, w.name).toContain(`${w.dir}/`);
      // One root lockfile: each Worker is judged by its own workspace's closure; only the
      // bot (an image whose `npm ci` installs the toolchain) counts devDependencies, for the
      // root package and web plus its own shim.
      expect(w.inputs.lockfile, w.name).toEqual(
        w.name === "bot"
          ? [
              { workspace: "", includeDev: true },
              { workspace: "web", includeDev: true },
              { workspace: "deploy/cloudflare", includeDev: false },
            ]
          : [{ workspace: w.dir, includeDev: false }],
      );
      expect(w.inputs.paths, w.name).not.toContain("package-lock.json");
    }
    expect(WORKERS.map((w) => w.healthBearerEnv)).toEqual([undefined, undefined, undefined, "SANDBOX_TOKEN"]);
    expect(WORKERS.find((w) => w.name === "bot")!.healthUrl).toBe(BOT_HEALTH_URL);
  });

  it("the bot and the sandbox carry live gates — deployed ≠ live for a container rollout; memory and resident have none", () => {
    const byName = Object.fromEntries(WORKERS.map((w) => [w.name, w]));
    const specs = Object.fromEntries(WORKER_SPECS.map((w) => [w.name, w]));
    expect(specs.bot.liveGate).toEqual({ kind: "health" });
    expect(byName.bot.liveGate).toEqual({ kind: "health", healthUrl: BOT_HEALTH_URL });
    expect(BOT_HEALTH_URL).toBe("https://switchboard.example.test/healthz");
    // The sandbox gate reads its Worker, its container application and an /exec probe, all with the
    // same bearer its /healthz needs — so the gate's bearer IS the health bearer — and the application is the
    // one wrangler names from the profile's script + the static class in deploy/cloudflare-sandbox/wrangler.jsonc.
    expect(specs.sandbox.liveGate).toEqual({
      kind: "sandbox",
      bearerEnv: "SANDBOX_TOKEN",
      containerClass: "SwitchboardSandbox",
    });
    expect(byName.sandbox.liveGate).toEqual({
      kind: "sandbox",
      healthUrl: SANDBOX_HEALTH_URL,
      bearerEnv: SANDBOX_BEARER_ENV,
      containerApp: "switchboard-sandbox-switchboardsandbox",
    });
    expect(SANDBOX_HEALTH_URL).toBe("https://switchboard-sandbox.example.test/healthz");
    expect(SANDBOX_BEARER_ENV).toBe(byName.sandbox.healthBearerEnv);
    // The same rule names the bot's application (deploy/cloudflare/preflight.mjs APP_NAME).
    expect(containerApplicationName("switchboard", "SwitchboardServer")).toBe("switchboard-switchboardserver");
    expect(SANDBOX_CONTAINER_CLASS).toBe("SwitchboardSandbox");
    for (const n of ["memory", "resident"] as const) expect(byName[n].liveGate, n).toBeUndefined();
    const p = plan({ dryRun: true });
    expect(p.steps.find((s) => s.name === "bot")).toMatchObject({
      healthUrl: BOT_HEALTH_URL,
      liveGate: { kind: "health", healthUrl: BOT_HEALTH_URL },
    });
    expect(p.steps.find((s) => s.name === "sandbox")).toMatchObject({ liveGate: byName.sandbox.liveGate });
    expect(p.steps.find((s) => s.name === "sandbox")).not.toHaveProperty("healthUrl"); // no preflight heartbeat
    expect(p.steps.find((s) => s.name === "resident")).not.toHaveProperty("liveGate");
    expect(p.steps.find((s) => s.name === "resident")).not.toHaveProperty("healthUrl");
    const text = formatPlan(p);
    expect(text).toContain(
      "then wait until live (https://switchboard.example.test/healthz not draining + build.commit == HEAD)",
    );
    expect(text).toContain(
      "then wait until live (https://switchboard-sandbox.example.test/healthz build.commit == HEAD + every running switchboard-sandbox-switchboardsandbox instance on the app version + an /exec probe answers ok from one)",
    );
    expect(byName.sandbox.why).toContain("an `echo ok` probe answers from one");
  });

  it("the bot step says how a rotated secret goes live — `wrangler secret put` alone leaves the running container on its old env; `deploy restart` (no build) restarts it", () => {
    const bot = WORKERS.find((w) => w.name === "bot")!;
    expect(bot.why).toContain("wrangler secret put");
    expect(bot.why).toContain("deploy restart");
    expect(formatPlan(plan())).toContain("rotated bot secret");
  });
});

describe("planDeploy", () => {
  it("keeps the canonical order whatever order --only names them in", () => {
    expect(plan({ only: ["sandbox", "memory"] }).steps.map((s) => s.name)).toEqual(["memory", "sandbox"]);
    expect(plan({ only: ["resident", "bot"] }).steps.map((s) => s.name)).toEqual(["bot", "resident"]);
  });

  it("--skip removes steps; --only and --skip compose", () => {
    expect(plan({ skip: ["sandbox"] }).steps.map((s) => s.name)).toEqual(["memory", "bot", "resident"]);
    expect(plan({ only: ["bot", "resident"], skip: ["resident"] }).steps.map((s) => s.name)).toEqual(["bot"]);
  });

  it("each step spawns its dir's deploy script with only CLOUDFLARE_ACCOUNT_ID removed (the API token is CI's credential; the account is asserted, not assumed); a preflighted step gets its origin from the profile, and a force env only under --force", () => {
    const byName = (p: DeployPlan) => Object.fromEntries(p.steps.map((s) => [s.name, s]));
    const plain = byName(plan());
    for (const s of Object.values(plain)) {
      expect(s.command).toEqual(["npm", "run", "deploy"]);
      expect(s.unsetEnv).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
    }
    // The preflights have no address of their own: deploy all tells each one where its Worker is.
    expect(plain.bot.setEnv).toEqual({ SWITCHBOARD_BASE_URL: "https://switchboard.example.test" });
    expect(plain.resident.setEnv).toEqual({ RESIDENT_BASE_URL: "https://switchboard-resident.example.test" });
    expect(plain.memory.setEnv).toEqual({});
    expect(plain.sandbox.setEnv).toEqual({});
    // Unguarded steps whose /healthz is public are woken once after the deploy; the bot's live gate
    // polls instead, and the sandbox's /healthz needs a bearer.
    expect(plain.memory.wakeUrl).toBe("https://switchboard-memory.example.test/healthz");
    expect(plain.resident.wakeUrl).toBe("https://switchboard-resident.example.test/healthz");
    expect(plain.bot).not.toHaveProperty("wakeUrl");
    expect(plain.sandbox).not.toHaveProperty("wakeUrl");
    const forcedPlan = plan({ force: true });
    const forced = byName(forcedPlan);
    expect(forced.bot.setEnv).toEqual({
      SWITCHBOARD_BASE_URL: "https://switchboard.example.test",
      SWITCHBOARD_DEPLOY_FORCE: "1",
    });
    expect(forced.resident.setEnv).toEqual({
      RESIDENT_BASE_URL: "https://switchboard-resident.example.test",
      RESIDENT_DEPLOY_FORCE: "1",
    });
    expect(forced.memory.setEnv).toEqual({});
    // The plan text names the force env alone — the base URL is set too, but not to 1.
    expect(forced.bot.forcedBy).toBe("SWITCHBOARD_DEPLOY_FORCE");
    expect(plain.bot).not.toHaveProperty("forcedBy");
    expect(formatPlan(forcedPlan)).toContain("preflight FORCED (SWITCHBOARD_DEPLOY_FORCE=1)");
    expect(formatPlan(forcedPlan)).toContain("preflight FORCED (RESIDENT_DEPLOY_FORCE=1)");
    expect(formatPlan(forcedPlan)).not.toContain("BASE_URL,");
    expect(forcedPlan.warnings).toEqual([
      "--force: preflights are bypassed — in-flight runs on bot and resident are SIGTERM-drained (finish if they can, else killed at the drain deadline)",
    ]);
  });

  it("only preflighted steps may be retried on a refusal; the wait budget comes from the options", () => {
    const p = plan({ waitMaxMinutes: 7, pollSeconds: 30 });
    expect(p.steps.map((s) => [s.name, s.retryOnPreflightRefusal])).toEqual([
      ["memory", false],
      ["bot", true],
      ["resident", true],
      ["sandbox", false],
    ]);
    expect(p.waitMaxMs).toBe(7 * 60_000);
    expect(p.pollMs).toBe(30_000);
    expect(plan({ force: true }).steps.every((s) => !s.retryOnPreflightRefusal)).toBe(true); // forced → nothing to wait for
  });

  it("the resident step carries its own wait budget (RESIDENT_WAIT_MAX_MS, 30 min): its refusals are runs in flight and a provisioning, which last minutes, not a rollout; the bot keeps the plan's", () => {
    const p = plan({ waitMaxMinutes: 7 });
    const byName = Object.fromEntries(p.steps.map((s) => [s.name, s]));
    expect(byName.resident.waitMaxMs).toBe(RESIDENT_WAIT_MAX_MS);
    expect(RESIDENT_WAIT_MAX_MS).toBe(30 * 60_000);
    expect(byName.bot.waitMaxMs).toBeUndefined();
    expect(byName.memory.waitMaxMs).toBeUndefined();
    const text = formatPlan(p);
    expect(text).toContain("resident");
    expect(text).toMatch(/resident.*up to 30 min/);
    expect(text).toMatch(/bot.*up to 7 min/);
  });

  it("--dry-run marks the plan and formatPlan renders it in order with the checks it would run", () => {
    const p = plan({ dryRun: true, only: ["memory", "bot"] });
    expect(p.dryRun).toBe(true);
    const text = formatPlan(p);
    expect(text.indexOf("1. memory")).toBeLessThan(text.indexOf("2. bot"));
    expect(text).toContain("deploy/cloudflare-memory");
    expect(text).toContain("preflight (retry every 60s up to 30 min)");
    expect(text).toContain(TEST_PROFILE.account);
    expect(text).toContain("origin/main");
    expect(text).not.toContain("resident");
  });

  it("--allow-branch relaxes only the branch check, never the clean-tree or account checks", () => {
    expect(plan().checks).toMatchObject({ account: TEST_PROFILE.account, cleanTree: true, atOriginMain: true });
    expect(plan({ allowBranch: true }).checks).toMatchObject({
      account: TEST_PROFILE.account,
      cleanTree: true,
      atOriginMain: false,
    });
  });

  it("the plan carries and prints where it runs from: a checkout at its root, with the tree checks on", () => {
    const p = plan();
    expect(p.root).toEqual(HOST_ROOT);
    const text = formatPlan(p);
    expect(text.split("\n")[0]).toBe("Root: /work/switchboard (a checkout)");
    expect(text).toContain("Checks: wrangler account = ");
    expect(text).toContain("; clean tree; HEAD == origin/main; ");
  });

  it("from the published package there is no tree: both git checks are off whatever --allow-branch says, the root is the operator's directory at the package's version, and the text says the sources are the package's — never `origin/main`", () => {
    const fromPackage: DeployHost = {
      root: { mode: "package", path: "/srv/switchboard", version: "1.12.0" },
      hasNodeModules: (dir) => dir === "deploy/cloudflare-memory",
    };
    const p = plan({}, fromPackage);
    expect(p.checks).toMatchObject({ account: TEST_PROFILE.account, cleanTree: false, atOriginMain: false });
    expect(plan({ allowBranch: true }, fromPackage).checks).toMatchObject({ cleanTree: false, atOriginMain: false });
    expect(p.root).toEqual({ mode: "package", path: "/srv/switchboard", version: "1.12.0" });
    // The steps themselves are the same steps: the same dirs, commands and gates.
    expect(p.steps).toEqual(plan().steps);
    const text = formatPlan(p);
    expect(text.split("\n")[0]).toBe("Root: /srv/switchboard (the published package 1.12.0)");
    expect(text).toContain(
      `Checks: wrangler account = ${TEST_PROFILE.account}; Worker sources are the package's (version 1.12.0), materialised under .switchboard/ — no git; deploy/cloudflare, deploy/cloudflare-resident, deploy/cloudflare-sandbox not installed under .switchboard/ — the runner will \`npm ci\` them there first`,
    );
    expect(text).not.toContain("origin/main");
    expect(text).not.toContain("clean tree");
  });

  it("the node_modules check tells the truth: every planned dir is probed, the missing ones are named and the runner's `npm ci` announced", () => {
    expect(plan().checks.nodeModulesMissing).toEqual([]);
    expect(formatPlan(plan())).toContain("; node_modules present in every dir");
    const probed: string[] = [];
    const partial: DeployHost = {
      root: HOST_ROOT,
      hasNodeModules: (dir) => {
        probed.push(dir);
        return dir === "deploy/cloudflare-memory" || dir === "deploy/cloudflare";
      },
    };
    const p = plan({}, partial);
    expect(probed).toEqual([
      "deploy/cloudflare-memory",
      "deploy/cloudflare",
      "deploy/cloudflare-resident",
      "deploy/cloudflare-sandbox",
    ]);
    expect(p.checks.nodeModulesMissing).toEqual(["deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
    expect(formatPlan(p)).toContain(
      "; node_modules missing in deploy/cloudflare-resident, deploy/cloudflare-sandbox — the runner will `npm ci` there first",
    );
    expect(formatPlan(p)).not.toContain("present in every dir");
    // Only the planned steps are probed: a skipped Worker's dir is nobody's business.
    expect(plan({ only: ["bot"] }, partial).checks.nodeModulesMissing).toEqual([]);
  });

  it("an affected report selects the steps (in canonical order, minus --skip), rides on the plan, and renders before the checks; an empty selection is a plan with no steps that says so", () => {
    const report: AffectedReport = {
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
        {
          name: "sandbox",
          decision: "deploy",
          base: { kind: "none", reason: "/healthz: HTTP 401" },
          reasons: ["unsure: no base — /healthz: HTTP 401; no release tag before HEAD"],
        },
      ],
      selected: ["bot", "resident", "sandbox"],
      unclassified: [],
      deployAll: false,
      markdown: "(md)",
    };
    const p = plan({ affected: report });
    expect(p.steps.map((s) => s.name)).toEqual(["bot", "resident", "sandbox"]);
    // `--only` narrows the selection, never widens it: memory is asked for but not affected.
    expect(plan({ affected: report, only: ["memory", "resident"] }).steps.map((s) => s.name)).toEqual(["resident"]);
    expect(p.affected).toBe(report);
    const text = formatPlan(p);
    expect(text.indexOf("Affected: bot, resident, sandbox")).toBe(0);
    expect(text).toContain("  - memory: skip — live aaaaaaa — no input changed");
    expect(text).toContain(
      "  - sandbox: deploy — none — unsure: no base — /healthz: HTTP 401; no release tag before HEAD",
    );
    expect(text.indexOf("Affected:")).toBeLessThan(text.indexOf("Checks:"));
    expect(plan({ affected: report, skip: ["sandbox"] }).steps.map((s) => s.name)).toEqual(["bot", "resident"]);
    const nothing = plan({
      affected: {
        ...report,
        workers: report.workers.map((w) => ({ ...w, decision: "skip", reasons: [] })),
        selected: [],
      },
    });
    expect(nothing.steps).toEqual([]);
    expect(formatPlan(nothing)).toContain(
      "Affected: nothing to deploy — every Worker already serves this tree's inputs",
    );
    expect(formatPlan(nothing)).toContain("Steps: none — nothing to deploy");
    expect(plan().affected).toBeUndefined();
  });
});

// Feature: docs/reference/specs/release-and-deploy.md item 14 — the plan iterates the
// profile's Workers: an installation with only the bot is a one-step plan, the
// bot plus the state Worker a two-step plan, and our production profile's plan
// is byte-identical to before Workers became optional.
describe("planDeploy over a partial profile", () => {
  const botOnly: LoadedProfile = {
    ...LOADED,
    profile: { ...TEST_PROFILE, workers: { bot: TEST_PROFILE.workers.bot } },
  };
  const botAndState: LoadedProfile = {
    ...LOADED,
    profile: { ...TEST_PROFILE, workers: { memory: TEST_PROFILE.workers.memory, bot: TEST_PROFILE.workers.bot } },
  };

  it("a bot-only profile is a one-step plan: the bot with its preflight and live gate, no state Worker to push the config to (the plan says so), nothing else", () => {
    const p = plan({}, installed, botOnly);
    expect(p.steps.map((s) => s.name)).toEqual(["bot"]);
    expect(p.steps[0]).toMatchObject({
      script: "switchboard",
      dir: "deploy/cloudflare",
      liveGate: { kind: "health", healthUrl: BOT_HEALTH_URL },
      retryOnPreflightRefusal: true,
    });
    expect(p.config).toEqual({ source: "config/config.production.yaml", document: CONFIG_DOCUMENT_KEY });
    expect(p.warnings).toEqual([]);
    const text = formatPlan(p);
    expect(text).toContain(
      "config: config/config.production.yaml (no state Worker in the profile — not pushed anywhere)",
    );
    expect(text).toContain("Steps:\n  1. bot (switchboard)");
    expect(text).not.toContain("2. ");
    expect(workersFor(botOnly.profile).map((w) => w.name)).toEqual(["bot"]);
  });

  it("the bot plus the state Worker is a two-step plan in canonical order, with the config pushed to that Worker", () => {
    const p = plan({}, installed, botAndState);
    expect(p.steps.map((s) => s.name)).toEqual(["memory", "bot"]);
    expect(p.config.stateWorkerUrl).toBe("https://switchboard-memory.example.test");
    expect(formatPlan(p)).toContain('→ document "base" on https://switchboard-memory.example.test');
  });

  it("`--only` naming a Worker the profile lacks deploys nothing for it and says so in a warning; `--skip` of an absent Worker is silent", () => {
    const p = plan({ only: ["sandbox", "bot"] }, installed, botOnly);
    expect(p.steps.map((s) => s.name)).toEqual(["bot"]);
    expect(p.warnings).toEqual(["--only names sandbox: not among this profile's Workers — nothing to deploy for it"]);
    expect(plan({ skip: ["resident"] }, installed, botOnly).warnings).toEqual([]);
  });

  it("the full production-shaped profile plans exactly as before: every Worker, in order, the config pushed to the state Worker", () => {
    const p = plan();
    expect(p.steps.map((s) => s.name)).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(p.config).toEqual({
      source: "config/config.production.yaml",
      document: CONFIG_DOCUMENT_KEY,
      stateWorkerUrl: "https://switchboard-memory.example.test",
    });
    expect(p.warnings).toEqual([]);
  });
});

describe("capabilityProblem", () => {
  it("every Worker with an image needs the Containers scope (containers list) — bot, sandbox AND resident, which also needs R2 (r2 bucket list); the memory Worker nothing; the plan carries each step's checks", () => {
    const byName = Object.fromEntries(WORKERS.map((w) => [w.name, w]));
    const containers = { command: ["wrangler", "containers", "list", "--json"], needs: "Containers: Edit" };
    expect(byName.memory.capabilities).toBeUndefined();
    expect(byName.bot.capabilities).toEqual([containers]);
    expect(byName.sandbox.capabilities).toEqual([containers]);
    // The resident carries its own Containers check: an --affected release can select it without the bot.
    expect(byName.resident.capabilities).toEqual([
      containers,
      { command: ["wrangler", "r2", "bucket", "list"], needs: "Workers R2 Storage: Edit" },
    ]);
    const p = plan();
    expect(p.steps.find((s) => s.name === "resident")!.capabilities).toEqual(byName.resident.capabilities);
    expect(p.steps.find((s) => s.name === "memory")!.capabilities).toEqual([]);
    expect(formatPlan(p)).toContain(
      "credential must pass `wrangler containers list --json` (Containers: Edit) and `wrangler r2 bucket list` (Workers R2 Storage: Edit)",
    );
  });

  it("a failing check is a problem naming the Worker, the scope and wrangler's own [ERROR] lines — ANSI stripped, npm noise dropped; a passing check or a step without one is silent", () => {
    const bot = WORKERS.find((w) => w.name === "bot")!;
    const wranglerOut = [
      "",
      " ⛅️ wrangler 4.120.1",
      "───────────────────",
      "\x1b[31m✘ [ERROR] A request to the Cloudflare API (/accounts/3c7b28f2/containers/applications) failed.\x1b[0m",
      "",
      "  Authentication error [code: 10000]",
      "npm ERR! code 1",
    ].join("\n");
    const containers = bot.capabilities![0];
    const problem = capabilityProblem("bot", containers, 1, wranglerOut);
    expect(problem).toBe(
      "bot: the credential cannot `wrangler containers list --json` — its deploy needs Containers: Edit; grant it on the token, or deploy with a login that has it. wrangler said: ✘ [ERROR] A request to the Cloudflare API (/accounts/3c7b28f2/containers/applications) failed. | Authentication error [code: 10000]",
    );
    expect(problem).not.toContain("\x1b");
    expect(problem).not.toContain("npm ERR");
    expect(capabilityProblem("bot", containers, 0, wranglerOut)).toBeUndefined();
    // No error-shaped line: the last lines are kept; no output at all: the exit code is the message.
    expect(capabilityProblem("bot", containers, 2, "a\nb\nc\nd")).toContain("wrangler said: b | c | d");
    expect(capabilityProblem("bot", containers, 2, "")).toContain("wrangler said: exit 2, no output");
  });
});

describe("decideAccount", () => {
  const account = TEST_PROFILE.account;
  const listing = `Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email someone@example.test.\n┌ Account Name │ Account ID ┐\n│ example-infra │ ${account} │\n└───┘`;

  it("passes when `wrangler whoami` lists the production account — a login or a user-owned token", () => {
    expect(decideAccount({ account, whoamiOutput: listing, whoamiExit: 0, tokenSet: false })).toEqual({
      ok: true,
      how: `wrangler whoami lists account ${account}`,
    });
    expect(decideAccount({ account, whoamiOutput: listing, whoamiExit: 0, tokenSet: true }).ok).toBe(true);
  });

  it("passes when the account is not listed but the token verifies active against it (an account-owned token has no memberships to list), and says so", () => {
    const noMemberships =
      "Getting User settings...\n👋 You are logged in with an API Token. Unable to retrieve email for this user. Are you missing the `User->User Details->Read` permission?";
    const verified = decideAccount({
      account,
      whoamiOutput: noMemberships,
      whoamiExit: 0,
      tokenSet: true,
      tokenVerify: { status: 200, body: JSON.stringify({ success: true, result: { id: "t", status: "active" } }) },
    });
    expect(verified).toEqual({
      ok: true,
      how: `CLOUDFLARE_API_TOKEN verifies active against account ${account} (account-owned token; wrangler whoami lists no memberships)`,
    });
    // Expired, disabled, or the wrong account (Cloudflare answers 200 with a non-active status, or 4xx): refused.
    for (const tokenVerify of [
      { status: 200, body: JSON.stringify({ result: { status: "expired" } }) },
      { status: 401, body: JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }) },
      { status: 200, body: "not json" },
    ]) {
      const r = decideAccount({ account, whoamiOutput: noMemberships, whoamiExit: 0, tokenSet: true, tokenVerify });
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.problem).toContain(`does not verify against it (HTTP ${tokenVerify.status})`);
    }
  });

  it("refuses with wrangler's own words and the way out — the foreign token, or the missing login — never a silent switch of credential", () => {
    const foreign = `┌ Account Name │ Account ID ┐\n│ other-account │ ${"1".repeat(32)} │\n└───┘`;
    const withToken = decideAccount({
      account,
      whoamiOutput: foreign,
      whoamiExit: 0,
      tokenSet: true,
      tokenVerify: { status: 403, body: "{}" },
    });
    expect(withToken).toEqual({
      ok: false,
      problem: `wrangler whoami does not list account ${account} (the deployment profile's) and the token does not verify against it (HTTP 403) — unset a CLOUDFLARE_API_TOKEN that belongs to another account, or use one for this account. wrangler said: ┌ Account Name │ Account ID ┐ | │ other-account │ ${"1".repeat(32)} │ | └───┘`,
    });
    const noLogin = decideAccount({ account, whoamiOutput: "", whoamiExit: 1, tokenSet: false });
    expect(noLogin).toEqual({
      ok: false,
      problem: `wrangler whoami does not list account ${account} (the deployment profile's) — run \`npx wrangler login\` in deploy/cloudflare. wrangler said: exit 1, no output`,
    });
    // A token that could not even be checked (network) is still a refusal, and says the check did not happen.
    const unchecked = decideAccount({ account, whoamiOutput: "", whoamiExit: 1, tokenSet: true });
    expect(unchecked.ok ? "" : unchecked.problem).toContain("and the token could not be verified against it");
  });
});

describe("classifyDeployOutput", () => {
  it("a preflight refusal is retryable and names what would be killed; success yields the version id", () => {
    const refused =
      "[bot-preflight] preflight REFUSED: a Worker deploy rolls the bot container —\n  - 2 run(s) in flight — a rollout would kill them\n  wait and retry";
    expect(classifyDeployOutput(1, refused)).toEqual({
      kind: "preflight-refused",
      reason: "2 run(s) in flight — a rollout would kill them",
    });
    const ok =
      "Uploaded switchboard (2.35 sec)\n  schedule: * * * * *\nCurrent Version ID: c9444f7b-ead3-41d3-8e41-10af7c9e38ce\ncontainer awake: HTTP 200";
    expect(classifyDeployOutput(0, ok)).toEqual({
      kind: "deployed",
      versionId: "c9444f7b-ead3-41d3-8e41-10af7c9e38ce",
    });
  });

  it("any other non-zero exit is a hard failure (no retry); a zero exit without a version id is reported as such", () => {
    expect(classifyDeployOutput(1, '✘ [ERROR] Could not resolve "@cloudflare/sandbox"')).toEqual({
      kind: "failed",
      reason: '✘ [ERROR] Could not resolve "@cloudflare/sandbox"',
    });
    expect(classifyDeployOutput(0, "nothing useful")).toEqual({ kind: "deployed", versionId: undefined });
  });

  it("prefers the real cause over npm's `npm ERR!` preamble; falls back to the preamble when that is all there is", () => {
    const out =
      'npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n✘ [ERROR] Could not resolve "@cloudflare/sandbox"\nnpm ERR! Failed at the deploy script';
    expect(classifyDeployOutput(1, out)).toEqual({
      kind: "failed",
      reason: '✘ [ERROR] Could not resolve "@cloudflare/sandbox"',
    });
    expect(classifyDeployOutput(1, "npm ERR! code ELIFECYCLE")).toEqual({
      kind: "failed",
      reason: "npm ERR! code ELIFECYCLE",
    });
  });
});

// Feature: docs/reference/specs/release-and-deploy.md items 25–26 — the plan says where
// each step's container image comes from. `build`: the Dockerfile wrangler builds.
// `registry`: the account registry reference at the version, and whether the
// registry holds it — `deploy all` copies a missing one — or `undefined` when it
// was not probed (the example profile, which nothing deploys).
describe("the plan's images", () => {
  const REGISTRY: LoadedProfile = { profile: TEST_REGISTRY_PROFILE, origin: "profile", path: "deploy/profile.json" };
  const account = TEST_PROFILE.account;

  it("in build mode names each image step's Dockerfile — the memory step has none — and formatPlan says wrangler builds them", () => {
    const p = plan();
    expect(p.images).toEqual({
      mode: "build",
      images: [
        { kind: "bot", dockerfile: "../../Dockerfile" },
        { kind: "resident", dockerfile: "./Dockerfile" },
        { kind: "sandbox", dockerfile: "./Dockerfile" },
      ],
    });
    expect(formatPlan(p)).toContain(
      "Images: build — wrangler builds bot: ../../Dockerfile, resident: ./Dockerfile, sandbox: ./Dockerfile at deploy time",
    );
    expect(plan({ only: ["memory"] }).images).toEqual({ mode: "build", images: [] });
    expect(formatPlanImages(plan({ only: ["memory"] }).images)).toBe("Images: build — no step has a container");
  });

  it("in registry mode names each image step's account-registry reference at the version and whether the listing holds it; the line counts the present ones and says `deploy all` copies the rest", () => {
    const listing = [
      { name: "switchboard", tags: ["1.2.3"] },
      { name: "switchboard-resident", tags: ["1.2.2"] },
    ];
    const p = plan({}, installed, REGISTRY, { mode: "registry", published: TEST_PUBLISHED_IMAGES, registry: listing });
    expect(p.images).toEqual({
      mode: "registry",
      version: "1.2.3",
      images: [
        { kind: "bot", ref: `registry.cloudflare.com/${account}/switchboard:1.2.3`, present: true },
        { kind: "resident", ref: `registry.cloudflare.com/${account}/switchboard-resident:1.2.3`, present: false },
        { kind: "sandbox", ref: `registry.cloudflare.com/${account}/switchboard-sandbox:1.2.3`, present: false },
      ],
    });
    const text = formatPlan(p);
    expect(text).toContain("Images: registry (version 1.2.3) — 1 of 3 present; deploy all copies the rest — ");
    expect(text).toContain(`bot: registry.cloudflare.com/${account}/switchboard:1.2.3 (present)`);
    expect(text).toContain(`resident: registry.cloudflare.com/${account}/switchboard-resident:1.2.3 (missing)`);
    const all = [
      ...listing,
      { name: "switchboard-resident", tags: ["1.2.3"] },
      { name: "switchboard-sandbox", tags: ["1.2.3"] },
    ];
    expect(
      formatPlanImages(
        plan({}, installed, REGISTRY, { mode: "registry", published: TEST_PUBLISHED_IMAGES, registry: all }).images,
      ),
    ).toContain("Images: registry (version 1.2.3) — 3 of 3 present — bot: ");
    expect(
      formatPlanImages(plan({}, installed, REGISTRY, { mode: "registry", published: TEST_PUBLISHED_IMAGES }).images),
    ).toBe(
      `Images: registry (version 1.2.3) — not probed (the example profile) — bot: registry.cloudflare.com/${account}/switchboard:1.2.3, resident: registry.cloudflare.com/${account}/switchboard-resident:1.2.3, sandbox: registry.cloudflare.com/${account}/switchboard-sandbox:1.2.3`,
    );
    // Only the planned steps' images are judged: `--only memory` needs none.
    expect(
      plan({ only: ["memory"] }, installed, REGISTRY, {
        mode: "registry",
        published: TEST_PUBLISHED_IMAGES,
        registry: [],
      }).images,
    ).toEqual({
      mode: "registry",
      version: "1.2.3",
      images: [],
    });
    expect(formatPlanImages({ mode: "registry", version: "1.2.3", images: [] })).toBe(
      "Images: registry (version 1.2.3) — no step has a container",
    );
  });

  it("without a listing (the example profile is never probed) every image is `not probed`, said as such", () => {
    const p = plan({ only: ["bot"] }, installed, REGISTRY, { mode: "registry", published: TEST_PUBLISHED_IMAGES });
    expect(p.images).toEqual({
      mode: "registry",
      version: "1.2.3",
      images: [{ kind: "bot", ref: `registry.cloudflare.com/${account}/switchboard:1.2.3`, present: undefined }],
    });
    expect(formatPlan(p)).toContain(
      `Images: registry (version 1.2.3) — not probed (the example profile) — bot: registry.cloudflare.com/${account}/switchboard:1.2.3`,
    );
  });
});
