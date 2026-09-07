import { describe, expect, it } from "vitest";
import type { AffectedReport } from "./affected.js";
import { BOT_HEALTH_URL, classifyDeployOutput, decideAccount, DEPLOY_ORDER, formatPlan, planDeploy, PRODUCTION_ACCOUNT_ID, RESIDENT_BEARER_ENVS, WORKERS, type CheckoutProbe, type DeployOptions } from "./plan.js";

// The one production deploy order, as a pure plan (README "Deploying on
// Cloudflare Containers", AGENTS.md "Deploy order"). The runner
// (src/deploy/run.ts, behind the registry's `deploy all`) only executes what
// this module plans, so the order, the filters, the force gating, and the
// checks the plan reports are provable here without touching wrangler. The
// options are the registry's `deploy.*` parse (src/core/commands/deploy.ts);
// here they are built directly.

const DEFAULTS: DeployOptions = { only: undefined, skip: undefined, dryRun: false, force: false, allowBranch: false, waitMaxMinutes: 30, pollSeconds: 60 };
const installed: CheckoutProbe = { hasNodeModules: () => true };
const plan = (opts: Partial<DeployOptions> = {}, checkout: CheckoutProbe = installed) => planDeploy({ ...DEFAULTS, ...opts }, checkout);

describe("WORKERS / DEPLOY_ORDER", () => {
  it("is state Worker → bot → resident → sandbox, each once, each with its dir and command", () => {
    expect(DEPLOY_ORDER).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(WORKERS.map((w) => w.dir)).toEqual(["deploy/cloudflare-memory", "deploy/cloudflare", "deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
    expect(new Set(WORKERS.map((w) => w.script)).size).toBe(4);
  });

  it("names which steps are preflighted and how each preflight is forced; the resident needs any one of its three bearers — read is enough", () => {
    const byName = Object.fromEntries(WORKERS.map((w) => [w.name, w]));
    expect(byName.memory.preflight).toBeUndefined();
    expect(byName.sandbox.preflight).toBeUndefined();
    expect(byName.bot.preflight).toEqual({ forceEnv: "SWITCHBOARD_DEPLOY_FORCE", healthUrl: BOT_HEALTH_URL });
    expect(byName.resident.preflight).toEqual({ forceEnv: "RESIDENT_DEPLOY_FORCE" });
    // The same three the resident's preflight.mjs reads (TOKEN_ENV_VARS): CI holds the read token and nothing more.
    expect(byName.resident.requiredEnv).toEqual([{ anyOf: ["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"] }]);
    expect(RESIDENT_BEARER_ENVS).toEqual(["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"]);
    expect(formatPlan(plan())).toContain("needs one of RESIDENT_ADMIN_TOKEN / RESIDENT_OPERATOR_TOKEN / RESIDENT_READ_TOKEN");
    expect(PRODUCTION_ACCOUNT_ID).toBe("3c7b28f23cc93f09e77bb0a9ffcb7e6f");
  });

  it("every Worker names its entry, its /healthz and its inputs; only the sandbox's /healthz needs a bearer", () => {
    for (const w of WORKERS) {
      expect(w.entry, w.name).toBe(`${w.dir}/worker.ts`);
      expect(w.healthUrl, w.name).toMatch(/^https:\/\/switchboard(-memory|-resident|-sandbox)?\.coreplanelabs\.dev\/healthz$/);
      expect(w.inputs.paths, w.name).toContain(`${w.dir}/`);
      expect(w.inputs.prodDepsLockfiles, w.name).toEqual([`${w.dir}/package-lock.json`]);
    }
    expect(WORKERS.map((w) => w.healthBearerEnv)).toEqual([undefined, undefined, undefined, "SANDBOX_TOKEN"]);
    expect(WORKERS.find((w) => w.name === "bot")!.healthUrl).toBe(BOT_HEALTH_URL);
  });

  it("only the bot has a live gate — deployed ≠ live for the container; the other Workers swap instantly", () => {
    const byName = Object.fromEntries(WORKERS.map((w) => [w.name, w]));
    expect(byName.bot.liveGate).toEqual({ healthUrl: BOT_HEALTH_URL });
    expect(BOT_HEALTH_URL).toBe("https://switchboard.coreplanelabs.dev/healthz");
    for (const n of ["memory", "resident", "sandbox"] as const) expect(byName[n].liveGate, n).toBeUndefined();
    const p = plan({ dryRun: true });
    expect(p.steps.find((s) => s.name === "bot")).toMatchObject({ healthUrl: BOT_HEALTH_URL, liveGate: { healthUrl: BOT_HEALTH_URL } });
    expect(p.steps.find((s) => s.name === "resident")).not.toHaveProperty("liveGate");
    expect(p.steps.find((s) => s.name === "resident")).not.toHaveProperty("healthUrl");
    expect(formatPlan(p)).toContain("then wait until live (https://switchboard.coreplanelabs.dev/healthz not draining + build.commit == HEAD)");
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

  it("each step spawns its dir's deploy script with only CLOUDFLARE_ACCOUNT_ID removed (the API token is CI's credential; the account is asserted, not assumed) and never a force env unless --force", () => {
    for (const s of plan().steps) {
      expect(s.command).toEqual(["npm", "run", "deploy"]);
      expect(s.unsetEnv).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
      expect(s.setEnv).toEqual({});
    }
    const forced = plan({ force: true });
    expect(forced.steps.find((s) => s.name === "bot")!.setEnv).toEqual({ SWITCHBOARD_DEPLOY_FORCE: "1" });
    expect(forced.steps.find((s) => s.name === "resident")!.setEnv).toEqual({ RESIDENT_DEPLOY_FORCE: "1" });
    expect(forced.steps.find((s) => s.name === "memory")!.setEnv).toEqual({});
    expect(forced.warnings).toEqual(["--force: preflights are bypassed — in-flight runs on bot and resident are SIGTERM-drained (finish if they can, else killed at the drain deadline)"]);
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

  it("--dry-run marks the plan and formatPlan renders it in order with the checks it would run", () => {
    const p = plan({ dryRun: true, only: ["memory", "bot"] });
    expect(p.dryRun).toBe(true);
    const text = formatPlan(p);
    expect(text.indexOf("1. memory")).toBeLessThan(text.indexOf("2. bot"));
    expect(text).toContain("deploy/cloudflare-memory");
    expect(text).toContain("preflight (retry every 60s up to 30 min)");
    expect(text).toContain(PRODUCTION_ACCOUNT_ID);
    expect(text).toContain("origin/main");
    expect(text).not.toContain("resident");
  });

  it("--allow-branch relaxes only the branch check, never the clean-tree or account checks", () => {
    expect(plan().checks).toMatchObject({ account: PRODUCTION_ACCOUNT_ID, cleanTree: true, atOriginMain: true });
    expect(plan({ allowBranch: true }).checks).toMatchObject({ account: PRODUCTION_ACCOUNT_ID, cleanTree: true, atOriginMain: false });
  });

  it("the node_modules check tells the truth: every planned dir is probed, the missing ones are named and the runner's `npm ci` announced", () => {
    expect(plan().checks.nodeModulesMissing).toEqual([]);
    expect(formatPlan(plan())).toContain("; node_modules present in every dir");
    const probed: string[] = [];
    const partial: CheckoutProbe = {
      hasNodeModules: (dir) => {
        probed.push(dir);
        return dir === "deploy/cloudflare-memory" || dir === "deploy/cloudflare";
      },
    };
    const p = plan({}, partial);
    expect(probed).toEqual(["deploy/cloudflare-memory", "deploy/cloudflare", "deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
    expect(p.checks.nodeModulesMissing).toEqual(["deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
    expect(formatPlan(p)).toContain("; node_modules missing in deploy/cloudflare-resident, deploy/cloudflare-sandbox — the runner will `npm ci` there first");
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
        { name: "resident", decision: "deploy", base: { kind: "release", tag: "v0.1.0", commit: "c".repeat(40) }, reasons: ["deploy/cloudflare-resident/Dockerfile"] },
        { name: "sandbox", decision: "deploy", base: { kind: "none", reason: "/healthz: HTTP 401" }, reasons: ["unsure: no base — /healthz: HTTP 401; no release tag before HEAD"] },
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
    expect(text).toContain("  - sandbox: deploy — none — unsure: no base — /healthz: HTTP 401; no release tag before HEAD");
    expect(text.indexOf("Affected:")).toBeLessThan(text.indexOf("Checks:"));
    expect(plan({ affected: report, skip: ["sandbox"] }).steps.map((s) => s.name)).toEqual(["bot", "resident"]);
    const nothing = plan({ affected: { ...report, workers: report.workers.map((w) => ({ ...w, decision: "skip", reasons: [] })), selected: [] } });
    expect(nothing.steps).toEqual([]);
    expect(formatPlan(nothing)).toContain("Affected: nothing to deploy — every Worker already serves this tree's inputs");
    expect(formatPlan(nothing)).toContain("Steps: none — nothing to deploy");
    expect(plan().affected).toBeUndefined();
  });
});

describe("decideAccount", () => {
  const account = PRODUCTION_ACCOUNT_ID;
  const listing = `Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email justin@coreplane.ai.\n┌ Account Name │ Account ID ┐\n│ coreplane-infra │ ${account} │\n└───┘`;

  it("passes when `wrangler whoami` lists the production account — a login or a user-owned token", () => {
    expect(decideAccount({ account, whoamiOutput: listing, whoamiExit: 0, tokenSet: false })).toEqual({ ok: true, how: `wrangler whoami lists account ${account}` });
    expect(decideAccount({ account, whoamiOutput: listing, whoamiExit: 0, tokenSet: true }).ok).toBe(true);
  });

  it("passes when the account is not listed but the token verifies active against it (an account-owned token has no memberships to list), and says so", () => {
    const noMemberships = "Getting User settings...\n👋 You are logged in with an API Token. Unable to retrieve email for this user. Are you missing the `User->User Details->Read` permission?";
    const verified = decideAccount({ account, whoamiOutput: noMemberships, whoamiExit: 0, tokenSet: true, tokenVerify: { status: 200, body: JSON.stringify({ success: true, result: { id: "t", status: "active" } }) } });
    expect(verified).toEqual({ ok: true, how: `CLOUDFLARE_API_TOKEN verifies active against account ${account} (account-owned token; wrangler whoami lists no memberships)` });
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
    const foreign = `┌ Account Name │ Account ID ┐\n│ baseberry-uat │ ${"1".repeat(32)} │\n└───┘`;
    const withToken = decideAccount({ account, whoamiOutput: foreign, whoamiExit: 0, tokenSet: true, tokenVerify: { status: 403, body: "{}" } });
    expect(withToken).toEqual({
      ok: false,
      problem: `wrangler whoami does not list account ${account} (coreplane-infra) and the token does not verify against it (HTTP 403) — unset a CLOUDFLARE_API_TOKEN that belongs to another account, or use one for this account. wrangler said: ┌ Account Name │ Account ID ┐ | │ baseberry-uat │ ${"1".repeat(32)} │ | └───┘`,
    });
    const noLogin = decideAccount({ account, whoamiOutput: "", whoamiExit: 1, tokenSet: false });
    expect(noLogin).toEqual({ ok: false, problem: `wrangler whoami does not list account ${account} (coreplane-infra) — run \`npx wrangler login\` in deploy/cloudflare. wrangler said: exit 1, no output` });
    // A token that could not even be checked (network) is still a refusal, and says the check did not happen.
    const unchecked = decideAccount({ account, whoamiOutput: "", whoamiExit: 1, tokenSet: true });
    expect(unchecked.ok ? "" : unchecked.problem).toContain("and the token could not be verified against it");
  });
});

describe("classifyDeployOutput", () => {
  it("a preflight refusal is retryable and names what would be killed; success yields the version id", () => {
    const refused = "[bot-preflight] preflight REFUSED: a Worker deploy rolls the bot container —\n  - 2 run(s) in flight — a rollout would kill them\n  wait and retry";
    expect(classifyDeployOutput(1, refused)).toEqual({ kind: "preflight-refused", reason: "2 run(s) in flight — a rollout would kill them" });
    const ok = "Uploaded switchboard (2.35 sec)\n  schedule: * * * * *\nCurrent Version ID: c9444f7b-ead3-41d3-8e41-10af7c9e38ce\ncontainer awake: HTTP 200";
    expect(classifyDeployOutput(0, ok)).toEqual({ kind: "deployed", versionId: "c9444f7b-ead3-41d3-8e41-10af7c9e38ce" });
  });

  it("any other non-zero exit is a hard failure (no retry); a zero exit without a version id is reported as such", () => {
    expect(classifyDeployOutput(1, "✘ [ERROR] Could not resolve \"@cloudflare/sandbox\"")).toEqual({ kind: "failed", reason: '✘ [ERROR] Could not resolve "@cloudflare/sandbox"' });
    expect(classifyDeployOutput(0, "nothing useful")).toEqual({ kind: "deployed", versionId: undefined });
  });

  it("prefers the real cause over npm's `npm ERR!` preamble; falls back to the preamble when that is all there is", () => {
    const out = "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n✘ [ERROR] Could not resolve \"@cloudflare/sandbox\"\nnpm ERR! Failed at the deploy script";
    expect(classifyDeployOutput(1, out)).toEqual({ kind: "failed", reason: '✘ [ERROR] Could not resolve "@cloudflare/sandbox"' });
    expect(classifyDeployOutput(1, "npm ERR! code ELIFECYCLE")).toEqual({ kind: "failed", reason: "npm ERR! code ELIFECYCLE" });
  });
});
