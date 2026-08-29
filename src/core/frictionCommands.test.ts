import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { InMemoryFrictionLedger } from "./frictionLedger.js";
import { handleFrictionCommand, parseFrictionCommand } from "./frictionCommands.js";
import type { FrictionRunRecord } from "./frictionProposals.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunEvent } from "./runEvents.js";
import type { IncomingMessage } from "./types.js";

// Feature: features/self-improvement.md — the on-demand trigger: `friction
// report` / `friction propose [--dry-run]` chat commands, answered inline
// (never a model turn), channel-agnostic. `propose` files issues, so it sits
// behind the fail-closed repo-management gate (admins only when unset).

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

describe("parseFrictionCommand", () => {
  it("recognizes report / propose with flags; anything else is not a friction command", () => {
    expect(parseFrictionCommand("friction report")).toEqual({ verb: "report", dryRun: false });
    expect(parseFrictionCommand("Friction propose")).toEqual({ verb: "propose", dryRun: false });
    expect(parseFrictionCommand("friction propose --dry-run --top 2 --min-runs=3")).toEqual({
      verb: "propose",
      dryRun: true,
      top: 2,
      minRuns: 3,
    });
    expect(parseFrictionCommand("what friction did we see?")).toBeNull();
    expect(parseFrictionCommand("frictionless")).toBeNull();
    expect(parseFrictionCommand("friction")).toBeNull();
  });

  it("names bad flags instead of guessing", () => {
    expect(parseFrictionCommand("friction propose --bogus")).toEqual({ error: expect.stringContaining("--bogus") });
    expect(parseFrictionCommand("friction propose --top x")).toEqual({ error: expect.stringContaining("--top") });
    expect(parseFrictionCommand("friction propose --top 0")).toEqual({ error: expect.stringContaining("--top") });
  });
});

describe("handleFrictionCommand", () => {
  it("returns null for non-friction text (falls through to the model)", async () => {
    expect(await handleFrictionCommand(config(), msg("hello"), {})).toBeNull();
  });

  it("`friction report` is open to everyone and reads the ledger without touching GitHub", async () => {
    const tracker = new InMemoryIssueTracker();
    const reply = await handleFrictionCommand(config(SELF_IMPROVEMENT), msg("friction report", "slack:UNOBODY"), {
      ledger: await seededLedger(),
      tracker,
    });
    expect(reply).toContain("2 runs analyzed");
    expect(reply).toContain("setup_install:pnpm install --frozen-lockfile");
    expect(tracker.calls).toEqual([]);
  });

  it("`friction propose` is refused by name for non-admins (fail-closed) and files nothing", async () => {
    const tracker = new InMemoryIssueTracker();
    const reply = await handleFrictionCommand(config(SELF_IMPROVEMENT), msg("friction propose", "slack:UNOBODY"), {
      ledger: await seededLedger(),
      tracker,
    });
    expect(reply).toMatch(/🚫/);
    expect(reply).toContain("<@slack:UADMIN>");
    expect(tracker.calls).toEqual([]);
  });

  it("`friction propose` by an admin files the deduped proposals and replies with the links", async () => {
    const tracker = new InMemoryIssueTracker();
    const deps = { ledger: await seededLedger(), tracker };
    const reply = await handleFrictionCommand(config(SELF_IMPROVEMENT), msg("friction propose --top 1"), deps);
    expect(reply).toContain("https://github.com/coreplanelabs/switchboard/issues/1");
    expect(tracker.issues("coreplanelabs/switchboard")).toHaveLength(1);
    const again = await handleFrictionCommand(config(SELF_IMPROVEMENT), msg("friction propose --top 1"), deps);
    expect(again).toMatch(/already open/i);
    expect(tracker.issues("coreplanelabs/switchboard")).toHaveLength(1);
  });

  it("`--dry-run` shows what would be filed and files nothing", async () => {
    const tracker = new InMemoryIssueTracker();
    const reply = await handleFrictionCommand(config(SELF_IMPROVEMENT), msg("friction propose --dry-run"), {
      ledger: await seededLedger(),
      tracker,
    });
    expect(reply).toMatch(/dry run/i);
    expect(tracker.issues("coreplanelabs/switchboard")).toEqual([]);
  });

  it("without `selfImprovement.repo` configured, propose explains what to set; report still works", async () => {
    const tracker = new InMemoryIssueTracker();
    const ledger = await seededLedger();
    expect(await handleFrictionCommand(config(), msg("friction propose"), { ledger, tracker })).toContain("selfImprovement.repo");
    expect(await handleFrictionCommand(config(), msg("friction report"), { ledger, tracker })).toContain("2 runs analyzed");
    expect(tracker.calls).toEqual([]);
  });

  it("with no ledger wired, both verbs say the ledger is unavailable", async () => {
    expect(await handleFrictionCommand(config(SELF_IMPROVEMENT), msg("friction report"), {})).toMatch(/ledger/i);
  });

  it("a parse error is returned as the reply", async () => {
    expect(await handleFrictionCommand(config(), msg("friction propose --nope"), {})).toContain("--nope");
  });
});
