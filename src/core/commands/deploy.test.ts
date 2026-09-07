import { describe, expect, it } from "vitest";
import type { AffectedReport } from "../../deploy/affected.js";
import { BOT_HEALTH_URL, formatPlan, type DeployPlan } from "../../deploy/plan.js";
import type { DeployRunResult } from "../../deploy/run.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { parseInvocation } from "../commandSurface.js";
import { BOT_ADMIN_RESTART_URL, RESTART_TOKEN_ENV, type RestartPlan } from "../../deploy/restart.js";
import type { RestartRunResult } from "../../deploy/run.js";
import { deployAll, deployPlan, deployRestart, registerDeployCommands, type DeployCommandDeps } from "./deploy.js";

// Feature: features/command-registry.md (phase 4b): the production deploy order
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

function bind(
  run: (plan: DeployPlan) => Promise<DeployRunResult>,
  hasNodeModules: (dir: string) => boolean = () => true,
  restart: (plan: RestartPlan) => Promise<RestartRunResult> = neverRestarts,
  affected: (opts: { base?: string }) => Promise<AffectedReport> = neverAffected,
) {
  const registry = new CommandRegistry<DeployCommandDeps>({ audit: () => {} });
  registerDeployCommands(registry);
  const plans: DeployPlan[] = [];
  const restartPlans: RestartPlan[] = [];
  const affectedCalls: { base?: string }[] = [];
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
      checkout: { hasNodeModules },
      affected: (opts) => {
        affectedCalls.push(opts);
        return affected(opts);
      },
    },
  });
  return { commands, plans, restartPlans, affectedCalls };
}
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
      waitMaxMs: 30 * 60_000,
      pollMs: 60_000,
      checks: { atOriginMain: true },
    });
    expect(renderText(commands.get("deploy.plan")!, res.value)).toBe(formatPlan(plan));
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain("then wait until live");
    // A rotated secret needs no image build: the plan points at `deploy restart`.
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain("deploy restart");
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

// `deploy restart` (features/slack-channel.md item 8): restart the bot container
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
        waitMaxMs: 30 * 60_000,
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
