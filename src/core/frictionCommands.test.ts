import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { CommandRegistry, bindCommands, type CommandInvoker } from "./commandRegistry.js";
import { registerFrictionCommands, type FrictionCommandDeps } from "./commands/friction.js";
import { InMemoryFrictionLedger } from "./frictionLedger.js";
import { handleFrictionCommand, parseFrictionCommand, toRegistryInvocation } from "./frictionCommands.js";
import type { FrictionRunRecord } from "./frictionProposals.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunEvent } from "./runEvents.js";
import type { IncomingMessage } from "./types.js";

// Feature: features/self-improvement.md — the LEGACY chat form of the
// self-improvement trigger (`friction report` / `friction propose [--dry-run]
// [--top N] [--min-runs N] [--repo o/n]`) translated onto the registry's
// `friction.report` / `friction.propose` (#157 R13). The syntax and every reply
// are unchanged: the golden strings here were captured from the pre-migration
// handler. The gate is the registry's (`repoManager` = the fail-closed
// repo-management set), reached through the same `ConfigStore.chatGateFor`.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function config(extra = ""): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "friction-cmd-"));
  dirs.push(dir);
  const yaml = `
providers:
  fake: { type: anthropic, apiKeyEnv: X }
defaults:
  agent: general
  models: { general: fake/m }
permissions:
  admins: [slack:UADMIN]
  repoManagement: [slack:UDEV]
${extra}
`;
  writeFileSync(join(dir, "config.yaml"), yaml);
  return new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
}

const SELF_IMPROVEMENT = `
selfImprovement:
  repo: coreplanelabs/switchboard
`;

const msg = (text: string, userId = "slack:UADMIN"): IncomingMessage => ({
  channelId: "slack:C1",
  userId,
  threadKey: "slack:C1:1",
  text,
});

let t = 0;
const at = (ms: number) => (t += ms);
const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary, at: at(10) });
const result = (ok: boolean, summary: string, ms: number): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary, at: at(ms) });
function lockfileRun(runId: string, finishedAt: number): FrictionRunRecord {
  t = 0;
  return {
    runId,
    agent: "coding",
    finishedAt,
    diagnosis: analyzeRunFriction([call("$ pnpm install --frozen-lockfile"), result(false, "ERR_PNPM_OUTDATED_LOCKFILE", 45_000)]),
  };
}
async function seededLedger() {
  const ledger = new InMemoryFrictionLedger();
  await ledger.record(lockfileRun("r1", 1));
  await ledger.record(lockfileRun("r2", 2));
  return ledger;
}

/** The registry the dispatcher hands the adapter, bound the way src/index.ts binds it. */
function commandsFor(cfg: ConfigStore, deps: Partial<FrictionCommandDeps["friction"]> = {}): { commands: CommandInvoker; invoked: string[] } {
  const registry = new CommandRegistry<FrictionCommandDeps>({ audit: () => {} });
  registerFrictionCommands(registry);
  const bound = bindCommands(registry, { friction: { config: () => cfg.config.selfImprovement, ...deps } });
  const invoked: string[] = [];
  return {
    invoked,
    commands: {
      ...bound,
      invoke: (id, raw, caller) => {
        invoked.push(id);
        return bound.invoke(id, raw, caller);
      },
    },
  };
}

const GOLDEN_REPORT = "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high";

describe("parseFrictionCommand", () => {
  it("recognizes report / propose with flags; anything else is not a friction command", () => {
    expect(parseFrictionCommand("friction report")).toEqual({ verb: "report", dryRun: false });
    expect(parseFrictionCommand("Friction propose")).toEqual({ verb: "propose", dryRun: false });
    expect(parseFrictionCommand("friction propose --dry-run --top 2 --min-runs=3 --repo acme/api")).toEqual({
      verb: "propose",
      dryRun: true,
      top: 2,
      minRuns: 3,
      repo: "acme/api",
    });
    expect(parseFrictionCommand("what friction did we see?")).toBeNull();
    expect(parseFrictionCommand("frictionless")).toBeNull();
    // the registry's own `key=value` form belongs to parseChatCommand, not here
    expect(parseFrictionCommand("friction report minRuns=2")).toBeNull();
    expect(parseFrictionCommand("friction propose dryRun=true top=3")).toBeNull();
  });

  it("claims every message whose first word is `friction`: mixed `--flag key=value` syntax and an unknown verb are deterministic usage errors, never the model", () => {
    expect(parseFrictionCommand("friction propose --dry-run top=2")).toEqual({ error: expect.stringContaining("Unknown option `top=2`") });
    expect(parseFrictionCommand("friction report minRuns=2 --top 3")).toEqual({ error: expect.stringContaining("Unknown option `minRuns=2`") });
    expect(parseFrictionCommand("friction propose --dry-run now")).toEqual({ error: expect.stringContaining("Unknown option `now`") });
    expect(parseFrictionCommand("friction bogus")).toEqual({ error: expect.stringContaining("`friction bogus`") });
    expect(parseFrictionCommand("friction")).toEqual({ error: expect.stringContaining("use `friction report [") });
    // A mixed message's error names the `key=value` form as the alternative, so the reader can pick one syntax.
    expect((parseFrictionCommand("friction propose --dry-run top=2") as { error: string }).error).toContain("key=value");
  });

  it("names bad flags instead of guessing", () => {
    expect(parseFrictionCommand("friction propose --bogus")).toEqual({ error: expect.stringContaining("--bogus") });
    expect(parseFrictionCommand("friction propose --top x")).toEqual({ error: expect.stringContaining("--top") });
    expect(parseFrictionCommand("friction propose --top 0")).toEqual({ error: expect.stringContaining("--top") });
    expect(parseFrictionCommand("friction propose --repo nope")).toEqual({ error: expect.stringContaining("--repo") });
  });

  it("translates to the registry invocation with raw string inputs; report takes only minRuns", () => {
    expect(toRegistryInvocation({ verb: "report", dryRun: true, top: 3, minRuns: 2 })).toEqual({ id: "friction.report", input: { minRuns: "2" } });
    expect(toRegistryInvocation({ verb: "propose", dryRun: true, top: 3, repo: "acme/api" })).toEqual({
      id: "friction.propose",
      input: { dryRun: "true", top: "3", repo: "acme/api" },
    });
    expect(toRegistryInvocation({ verb: "propose", dryRun: false })).toEqual({ id: "friction.propose", input: {} });
  });
});

describe("handleFrictionCommand (legacy form → registry)", () => {
  it("returns null for non-friction text without touching the registry (falls through to the next stage)", async () => {
    const cfg = config();
    const { commands, invoked } = commandsFor(cfg);
    expect(await handleFrictionCommand(cfg, msg("hello"), commands)).toBeNull();
    expect(invoked).toEqual([]);
  });

  it("`friction report` replies with the exact pre-migration text for an admin and a non-admin (AE10), GitHub untouched", async () => {
    const cfg = config(SELF_IMPROVEMENT);
    const tracker = new InMemoryIssueTracker();
    const { commands, invoked } = commandsFor(cfg, { ledger: await seededLedger(), tracker });
    expect(await handleFrictionCommand(cfg, msg("friction report"), commands)).toBe(GOLDEN_REPORT);
    expect(await handleFrictionCommand(cfg, msg("friction report", "slack:UNOBODY"), commands)).toBe(GOLDEN_REPORT);
    expect(await handleFrictionCommand(cfg, msg("friction report --top 3", "slack:UNOBODY"), commands)).toBe(GOLDEN_REPORT);
    expect(invoked).toEqual(["friction.report", "friction.report", "friction.report"]);
    expect(tracker.calls).toEqual([]);
  });

  it("`friction propose --top 3` is refused with the legacy wording for a plain user and files for a repoManagement-listed non-admin (R13)", async () => {
    const cfg = config(SELF_IMPROVEMENT);
    const tracker = new InMemoryIssueTracker();
    const { commands } = commandsFor(cfg, { ledger: await seededLedger(), tracker });
    expect(await handleFrictionCommand(cfg, msg("friction propose --top 3", "slack:UNOBODY"), commands)).toBe(
      "🚫 Filing friction proposals (`friction propose`) is restricted. Ask <@slack:UADMIN>.",
    );
    expect(tracker.calls).toEqual([]);
    expect(await handleFrictionCommand(cfg, msg("friction propose --top 3", "slack:UDEV"), commands)).toBe(
      "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high\n\n*Filed:*\n• https://github.com/coreplanelabs/switchboard/issues/1 — [friction] setup/install recurs in 2 of 2 runs: pnpm install --frozen-lockfile",
    );
    expect(tracker.issues("coreplanelabs/switchboard")).toHaveLength(1);
    expect(await handleFrictionCommand(cfg, msg("friction propose --top 3"), commands)).toBe(
      "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high\n\n*Already open (not refiled):*\n• https://github.com/coreplanelabs/switchboard/issues/1 — `setup_install:pnpm install --frozen-lockfile`",
    );
    expect(tracker.issues("coreplanelabs/switchboard")).toHaveLength(1);
  });

  it("`--dry-run` shows what would be filed and files nothing", async () => {
    const cfg = config(SELF_IMPROVEMENT);
    const tracker = new InMemoryIssueTracker();
    const { commands } = commandsFor(cfg, { ledger: await seededLedger(), tracker });
    expect(await handleFrictionCommand(cfg, msg("friction propose --dry-run --top 3", "slack:UDEV"), commands)).toBe(
      "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern · dry run (nothing filed)\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high\n\n*Would file (dry run):*\n• [friction] setup/install recurs in 2 of 2 runs: pnpm install --frozen-lockfile",
    );
    expect(tracker.issues("coreplanelabs/switchboard")).toEqual([]);
  });

  it("without `selfImprovement.repo` configured, propose explains what to set (legacy line) and `--repo` supplies one; report still works", async () => {
    const cfg = config();
    const tracker = new InMemoryIssueTracker();
    const { commands } = commandsFor(cfg, { ledger: await seededLedger(), tracker });
    expect(await handleFrictionCommand(cfg, msg("friction propose"), commands)).toBe(
      "⚠️ Set `selfImprovement.repo` (an `owner/name`) in config.yaml to tell `friction propose` where to file issues.",
    );
    expect(await handleFrictionCommand(cfg, msg("friction report"), commands)).toBe(GOLDEN_REPORT);
    expect(tracker.calls).toEqual([]);
    expect(await handleFrictionCommand(cfg, msg("friction propose --repo acme/other --dry-run"), commands)).toMatch(/dry run/i);
  });

  it("with no ledger wired, both verbs say the ledger is unavailable (legacy line)", async () => {
    const cfg = config(SELF_IMPROVEMENT);
    const { commands } = commandsFor(cfg);
    const expected = "⚠️ The friction ledger isn't wired in this process, so there are no recent runs to analyze.";
    expect(await handleFrictionCommand(cfg, msg("friction report"), commands)).toBe(expected);
    expect(await handleFrictionCommand(cfg, msg("friction propose"), commands)).toBe(expected);
  });

  it("a parse error is returned as the reply and never reaches the registry", async () => {
    const cfg = config();
    const { commands, invoked } = commandsFor(cfg);
    expect(await handleFrictionCommand(cfg, msg("friction propose --nope"), commands)).toBe(
      "Unknown option `--nope` — `friction propose` accepts `--dry-run`, `--top <n>`, `--min-runs <n>`, `--repo <owner/name>`.",
    );
    expect(invoked).toEqual([]);
  });
});
