import { describe, expect, it } from "vitest";
import {
  BOT_HEALTH_URL,
  classifyDeployOutput,
  DEPLOY_ORDER,
  formatPlan,
  parseDeployArgs,
  planDeploy,
  PRODUCTION_ACCOUNT_ID,
  WORKERS,
} from "./plan.js";

// The one production deploy order, as a pure plan (README "Deploying on
// Cloudflare Containers", AGENTS.md "Deploy order"). The runner
// (deployAllCli.ts) only executes what this module plans, so the order, the
// filters, and the force gating are provable here without touching wrangler.

describe("WORKERS / DEPLOY_ORDER", () => {
  it("is state Worker → bot → resident → sandbox, each once, each with its dir and command", () => {
    expect(DEPLOY_ORDER).toEqual(["memory", "bot", "resident", "sandbox"]);
    expect(WORKERS.map((w) => w.dir)).toEqual(["deploy/cloudflare-memory", "deploy/cloudflare", "deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
    expect(new Set(WORKERS.map((w) => w.script)).size).toBe(4);
  });

  it("names which steps are preflighted and how each preflight is forced; the resident needs its bearer", () => {
    const byName = Object.fromEntries(WORKERS.map((w) => [w.name, w]));
    expect(byName.memory.preflight).toBeUndefined();
    expect(byName.sandbox.preflight).toBeUndefined();
    expect(byName.bot.preflight).toEqual({ forceEnv: "SWITCHBOARD_DEPLOY_FORCE", healthUrl: BOT_HEALTH_URL });
    expect(byName.resident.preflight).toEqual({ forceEnv: "RESIDENT_DEPLOY_FORCE" });
    expect(byName.resident.requiredEnv).toEqual(["RESIDENT_ADMIN_TOKEN"]);
    expect(PRODUCTION_ACCOUNT_ID).toBe("3c7b28f23cc93f09e77bb0a9ffcb7e6f");
  });

  it("only the bot has a live gate — deployed ≠ live for the container; the other Workers swap instantly", () => {
    const byName = Object.fromEntries(WORKERS.map((w) => [w.name, w]));
    expect(byName.bot.liveGate).toEqual({ healthUrl: BOT_HEALTH_URL });
    expect(BOT_HEALTH_URL).toBe("https://switchboard.coreplanelabs.dev/healthz");
    for (const n of ["memory", "resident", "sandbox"] as const) expect(byName[n].liveGate, n).toBeUndefined();
    const plan = planDeploy({ only: undefined, skip: undefined, dryRun: true, force: false, allowBranch: false, waitMaxMinutes: 30, pollSeconds: 60 });
    expect(plan.steps.find((s) => s.name === "bot")).toMatchObject({ healthUrl: BOT_HEALTH_URL, liveGate: { healthUrl: BOT_HEALTH_URL } });
    expect(plan.steps.find((s) => s.name === "resident")).not.toHaveProperty("liveGate");
    expect(plan.steps.find((s) => s.name === "resident")).not.toHaveProperty("healthUrl");
    expect(formatPlan(plan)).toContain("then wait until live (https://switchboard.coreplanelabs.dev/healthz not draining + build.commit == HEAD)");
  });
});

describe("parseDeployArgs", () => {
  it("defaults: everything, no force, not dry, main-only, 30 min wait, 60 s poll", () => {
    expect(parseDeployArgs([])).toEqual({
      ok: true,
      opts: { only: undefined, skip: undefined, dryRun: false, force: false, allowBranch: false, waitMaxMinutes: 30, pollSeconds: 60 },
    });
  });

  it("parses --only/--skip lists (comma or repeated), --dry-run, --force, --allow-branch, --wait-max, --poll", () => {
    const r = parseDeployArgs(["--only", "bot,resident", "--only", "sandbox", "--dry-run", "--force", "--allow-branch", "--wait-max", "5", "--poll", "10"]);
    expect(r).toEqual({
      ok: true,
      opts: { only: ["bot", "resident", "sandbox"], skip: undefined, dryRun: true, force: true, allowBranch: true, waitMaxMinutes: 5, pollSeconds: 10 },
    });
    expect(parseDeployArgs(["--skip=sandbox"])).toMatchObject({ ok: true, opts: { skip: ["sandbox"] } });
  });

  it("rejects unknown flags, unknown Worker names, and non-positive numbers by name", () => {
    expect(parseDeployArgs(["--yolo"])).toEqual({ ok: false, error: "unknown option `--yolo`" });
    expect(parseDeployArgs(["--only", "memory,botz"])).toEqual({ ok: false, error: "unknown Worker `botz` (known: memory, bot, resident, sandbox)" });
    expect(parseDeployArgs(["--wait-max", "0"])).toEqual({ ok: false, error: "`--wait-max` expects a positive integer (minutes), got `0`" });
    expect(parseDeployArgs(["--poll"])).toEqual({ ok: false, error: "`--poll` expects a positive integer (seconds), got ``" });
  });
});

describe("planDeploy", () => {
  const parse = (argv: string[]) => {
    const r = parseDeployArgs(argv);
    if (!r.ok) throw new Error(r.error);
    return planDeploy(r.opts);
  };

  it("keeps the canonical order whatever order --only names them in", () => {
    expect(parse(["--only", "sandbox,memory"]).steps.map((s) => s.name)).toEqual(["memory", "sandbox"]);
    expect(parse(["--only", "resident,bot"]).steps.map((s) => s.name)).toEqual(["bot", "resident"]);
  });

  it("--skip removes steps; --only and --skip compose", () => {
    expect(parse(["--skip", "sandbox"]).steps.map((s) => s.name)).toEqual(["memory", "bot", "resident"]);
    expect(parse(["--only", "bot,resident", "--skip", "resident"]).steps.map((s) => s.name)).toEqual(["bot"]);
  });

  it("each step spawns its dir's deploy script with the Cloudflare env vars removed and never a force env unless --force", () => {
    const plan = parse([]);
    for (const s of plan.steps) {
      expect(s.command).toEqual(["npm", "run", "deploy"]);
      expect(s.unsetEnv).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
      expect(s.setEnv).toEqual({});
    }
    const forced = parse(["--force"]);
    expect(forced.steps.find((s) => s.name === "bot")!.setEnv).toEqual({ SWITCHBOARD_DEPLOY_FORCE: "1" });
    expect(forced.steps.find((s) => s.name === "resident")!.setEnv).toEqual({ RESIDENT_DEPLOY_FORCE: "1" });
    expect(forced.steps.find((s) => s.name === "memory")!.setEnv).toEqual({});
    expect(forced.warnings).toEqual(["--force: preflights are bypassed — in-flight runs on bot and resident WILL be killed"]);
  });

  it("only preflighted steps may be retried on a refusal; the wait budget comes from the options", () => {
    const plan = parse(["--wait-max", "7", "--poll", "30"]);
    expect(plan.steps.map((s) => [s.name, s.retryOnPreflightRefusal])).toEqual([
      ["memory", false],
      ["bot", true],
      ["resident", true],
      ["sandbox", false],
    ]);
    expect(plan.waitMaxMs).toBe(7 * 60_000);
    expect(plan.pollMs).toBe(30_000);
    expect(parse(["--force"]).steps.every((s) => !s.retryOnPreflightRefusal)).toBe(true); // forced → nothing to wait for
  });

  it("--dry-run marks the plan and formatPlan renders it in order with the checks it would run", () => {
    const plan = parse(["--dry-run", "--only", "memory,bot"]);
    expect(plan.dryRun).toBe(true);
    const text = formatPlan(plan);
    expect(text.indexOf("1. memory")).toBeLessThan(text.indexOf("2. bot"));
    expect(text).toContain("deploy/cloudflare-memory");
    expect(text).toContain("preflight (retry every 60s up to 30 min)");
    expect(text).toContain(PRODUCTION_ACCOUNT_ID);
    expect(text).toContain("origin/main");
    expect(text).not.toContain("resident");
  });

  it("--allow-branch relaxes only the branch check, never the clean-tree or account checks", () => {
    expect(parse([]).checks).toEqual({ account: PRODUCTION_ACCOUNT_ID, cleanTree: true, atOriginMain: true });
    expect(parse(["--allow-branch"]).checks).toEqual({ account: PRODUCTION_ACCOUNT_ID, cleanTree: true, atOriginMain: false });
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
