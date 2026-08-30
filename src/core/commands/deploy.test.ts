import { describe, expect, it } from "vitest";
import { BOT_HEALTH_URL, formatPlan, type DeployPlan } from "../../deploy/plan.js";
import type { DeployRunResult } from "../../deploy/run.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { parseInvocation } from "../commandSurface.js";
import { deployAll, deployPlan, registerDeployCommands, type DeployCommandDeps } from "./deploy.js";

// Feature: features/command-registry.md (phase 4b): the production deploy order
// as commands — `deploy plan` (pure, every surface) and `deploy all` (CLI only;
// the former `npm run deploy:all`), sharing one option set so the plan you read
// is the plan you run. The runner is injected; nothing here spawns a process.

const cli: Caller = { kind: "cli", id: "cli:local", scopes: "all" };
const admin: Caller = { kind: "chat", id: "slack:UADMIN", scopes: new Set(), chatGate: () => true };
const mcp = (...scopes: string[]): Caller => ({ kind: "mcp", id: "mcp:alice", scopes: new Set(scopes) });

function bind(run: (plan: DeployPlan) => Promise<DeployRunResult>) {
  const registry = new CommandRegistry<DeployCommandDeps>({ audit: () => {} });
  registerDeployCommands(registry);
  const plans: DeployPlan[] = [];
  const commands = bindCommands(registry, {
    deploy: {
      run: (plan) => {
        plans.push(plan);
        return run(plan);
      },
    },
  });
  return { commands, plans };
}
const neverRuns = () => bind(async () => {
  throw new Error("must not run");
});

describe("deploy.plan", () => {
  it("computes the canonical plan (memory → bot → resident → sandbox) with the bot's live gate, and renders formatPlan", async () => {
    const { commands } = neverRuns();
    const res = await commands.invoke("deploy.plan", {}, admin);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const plan = res.value as unknown as DeployPlan;
    expect(plan.steps.map((s) => s.name)).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(plan.steps[1]).toMatchObject({ liveGate: { healthUrl: BOT_HEALTH_URL }, retryOnPreflightRefusal: true });
    expect(plan).toMatchObject({ dryRun: true, force: false, waitMaxMs: 30 * 60_000, pollMs: 60_000, checks: { atOriginMain: true } });
    expect(renderText(commands.get("deploy.plan")!, res.value)).toBe(formatPlan(plan));
    expect(renderText(commands.get("deploy.plan")!, res.value)).toContain("then wait until live");
  });

  it("--only/--skip (comma lists), --force, --allow-branch, --wait-max, --poll shape the plan; an unknown Worker or an empty selection is invalid_input naming the expectation", async () => {
    const { commands } = neverRuns();
    const bound = parseInvocation(commands.get("deploy.plan")!, ["--only", "bot,resident", "--skip", "resident", "--force", "--allow-branch", "--wait-max", "5", "--poll", "10"]);
    expect(bound.kind).toBe("invoke");
    const res = await commands.invoke("deploy.plan", bound.kind === "invoke" ? bound.input : {}, cli);
    if (!res.ok) throw new Error(res.message);
    const plan = res.value as unknown as DeployPlan;
    expect(plan.steps.map((s) => s.name)).toEqual(["bot"]);
    expect(plan.steps[0]).toMatchObject({ setEnv: { SWITCHBOARD_DEPLOY_FORCE: "1" }, retryOnPreflightRefusal: false });
    expect(plan).toMatchObject({ force: true, waitMaxMs: 5 * 60_000, pollMs: 10_000, checks: { atOriginMain: false } });
    expect(plan.warnings[0]).toContain("--force");
    const bad = await commands.invoke("deploy.plan", { options: { only: "bot,frontend" } }, cli);
    expect(bad).toMatchObject({ ok: false, error: "invalid_input", message: "only: expected a comma list of Workers (memory, bot, resident, sandbox)" });
    expect(JSON.stringify(bad)).not.toContain("frontend");
    expect(await commands.invoke("deploy.plan", { options: { only: "bot", skip: "bot" } }, cli)).toMatchObject({ ok: false, error: "invalid_input", message: "nothing to deploy after --only/--skip filters" });
    expect(await commands.invoke("deploy.plan", { options: { waitMax: "0" } }, cli)).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("is operator-gated in chat, deploy:read on machine surfaces, and exposed everywhere; deploy.all is CLI-only", async () => {
    const { commands } = neverRuns();
    expect(deployPlan).toMatchObject({ scope: "deploy:read", chatGate: "operator", effect: "read" });
    expect(deployPlan.surfaces).toBeUndefined();
    expect(deployAll).toMatchObject({ scope: "deploy:write", chatGate: "operator", effect: "write", surfaces: { chat: false, mcp: false, http: false } });
    expect(await commands.invoke("deploy.plan", {}, mcp("runs:read"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("deploy.plan", {}, mcp("deploy:read"))).ok).toBe(true);
    expect(await commands.invoke("deploy.all", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("deploy.all", {}, mcp("deploy:write"))).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("deploy.all", () => {
  it("hands the runner the SAME plan `deploy plan` computes (dryRun false) and reports the version → live table on success", async () => {
    const { commands, plans } = bind(async (plan) => ({
      kind: "ran",
      ok: true,
      results: plan.steps.map((s) => ({ name: s.name, script: s.script, versionId: `v-${s.name}`, live: s.liveGate ? "live" : "n/a", status: "deployed" })),
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
    const refused = bind(async () => ({ kind: "refused", problems: ["working tree is not clean", "HEAD abc1234 != origin/main def5678"] }));
    expect(await refused.commands.invoke("deploy.all", {}, cli)).toMatchObject({ ok: false, error: "unavailable", message: "refusing —\n  - working tree is not clean\n  - HEAD abc1234 != origin/main def5678" });
    const stopped = bind(async () => ({
      kind: "ran",
      ok: false,
      results: [
        { name: "memory", script: "switchboard-memory", versionId: "v1", live: "n/a", status: "deployed" },
        { name: "bot", script: "switchboard", versionId: "v2", live: "deployed, not live: old container still draining", status: "FAILED: deployed but NOT live" },
      ],
      notAttempted: ["resident", "sandbox"],
    }));
    const res = await stopped.commands.invoke("deploy.all", {}, cli);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect(res.ok ? "" : res.message).toContain("deploy stopped —");
    expect(res.ok ? "" : res.message).toContain("FAILED: deployed but NOT live");
    expect(res.ok ? "" : res.message).toContain("not attempted: resident, sandbox");
    expect(await stopped.commands.invoke("deploy.all", { options: { skip: "memory,bot,resident,sandbox" } }, cli)).toMatchObject({ ok: false, error: "invalid_input" });
  });
});
