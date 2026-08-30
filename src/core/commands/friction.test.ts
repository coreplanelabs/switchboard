import { describe, expect, it } from "vitest";
import { InMemoryIssueTracker } from "../../execution/githubIssues.js";
import { CommandRegistry, bindCommands, renderText, type Caller, type CommandInvoker } from "../commandRegistry.js";
import { jsonSchemaFor } from "../commandSurface.js";
import { InMemoryFrictionLedger, RunStoreFrictionLedger } from "../frictionLedger.js";
import type { FrictionRunRecord } from "../frictionProposals.js";
import type { RunRecord } from "../runRecord.js";
import { analyzeRunFriction } from "../runFriction.js";
import type { RunEvent } from "../runEvents.js";
import { InMemoryRunStore } from "../runStore.js";
import { formatSelfImprovementReport, type SelfImprovementConfig, type SelfImprovementReport } from "../selfImprovement.js";
import { frictionCommands, NO_LEDGER_MESSAGE, NO_REPO_MESSAGE, registerFrictionCommands, type FrictionCommandDeps } from "./friction.js";

// Feature: features/self-improvement.md (triggers) / features/command-registry.md
// (migration, R13/AE12): `friction.report` and `friction.propose` as registry
// commands — the same step the chat command has always run, now reachable on
// every surface, with the chat gates unchanged (`report` open, `propose` =
// repo managers) and explicit `friction:read` / `friction:write` scopes for
// machine callers. Golden text below is the pre-migration chat reply, captured
// verbatim from the legacy handler before it was removed.

let t = 0;
const at = (ms: number) => (t += ms);
const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary, at: at(10) });
const result = (ok: boolean, summary: string, ms: number): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary, at: at(ms) });
const lockfileEvents = () => {
  t = 0;
  return [call("$ pnpm install --frozen-lockfile"), result(false, "ERR_PNPM_OUTDATED_LOCKFILE", 45_000)];
};

function lockfileRun(runId: string, finishedAt: number): FrictionRunRecord {
  return { runId, agent: "coding", label: `coding · acme/${runId}`, finishedAt, diagnosis: analyzeRunFriction(lockfileEvents()) };
}

async function seededLedger() {
  const ledger = new InMemoryFrictionLedger();
  await ledger.record(lockfileRun("r1", 1_700_000_000_001));
  await ledger.record(lockfileRun("r2", 1_700_000_000_002));
  return ledger;
}

const CONFIG: SelfImprovementConfig = { repo: "coreplanelabs/switchboard" };

function bind(deps: Partial<FrictionCommandDeps["friction"]> = {}): { commands: CommandInvoker; tracker: InMemoryIssueTracker } {
  const tracker = new InMemoryIssueTracker();
  const registry = new CommandRegistry<FrictionCommandDeps>({ audit: () => {} });
  registerFrictionCommands(registry);
  const commands = bindCommands(registry, { friction: { tracker, config: () => CONFIG, readSource: async () => "", ...deps } });
  return { commands, tracker };
}

const chat = (userId: string, gates: { repoManager: boolean }): Caller => ({
  kind: "chat",
  id: userId,
  scopes: new Set(),
  chatGate: (gate) => (gate === "open" ? true : gate === "repoManager" ? gates.repoManager : false),
});
const mcp = (...scopes: string[]): Caller => ({ kind: "mcp", id: "mcp:alice", scopes: new Set(scopes) });

/** A seeded ledger whose newest record was diagnosed on a head-truncated stream. */
async function truncatedLedger() {
  const ledger = await seededLedger();
  const r3 = lockfileRun("r3", 1_700_000_000_003);
  await ledger.record({ ...r3, diagnosis: { ...r3.diagnosis, truncatedInput: true } });
  return ledger;
}

const GOLDEN_REPORT = "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high";

type Invoked = Awaited<ReturnType<CommandInvoker["invoke"]>>;

function text(commands: CommandInvoker, id: string, res: Invoked): string {
  if (!res.ok) throw new Error(res.message);
  return renderText(commands.get(id)!, res.value);
}

function reportOf(res: Invoked): SelfImprovementReport {
  if (!res.ok) throw new Error(res.message);
  return res.value as unknown as SelfImprovementReport;
}

describe("friction.report", () => {
  it("is open to any chat caller and renders the exact pre-migration reply (AE10)", async () => {
    const { commands, tracker } = bind({ ledger: await seededLedger() });
    for (const caller of [chat("slack:UADMIN", { repoManager: true }), chat("slack:UNOBODY", { repoManager: false })]) {
      const res = await commands.invoke("friction.report", {}, caller);
      expect(res.ok, caller.id).toBe(true);
      expect(text(commands, "friction.report", res)).toBe(GOLDEN_REPORT);
    }
    expect(tracker.calls).toEqual([]);
  });

  it("returns the structured report as JSON (runsAnalyzed, ranked patterns, nothing filed) and coerces string inputs", async () => {
    const { commands } = bind({ ledger: await seededLedger() });
    const res = await commands.invoke("friction.report", { options: { limit: "1", minRuns: "1" } }, mcp("friction:read"));
    expect(res.ok).toBe(true);
    const report = reportOf(res);
    expect(report.runsAnalyzed).toBe(1);
    expect(report.patterns.map((p) => p.key)).toEqual(["setup_install:pnpm install --frozen-lockfile"]);
    expect(report.filed).toEqual([]);
    expect(report.dryRun).toBe(false);
    expect(renderText(commands.get("friction.report")!, res.ok ? res.value : null)).toBe(formatSelfImprovementReport(report));
  });

  it("without a ledger is `unavailable` with the legacy message; a bad limit names the field only", async () => {
    const { commands } = bind();
    const res = await commands.invoke("friction.report", {}, mcp("friction:read"));
    expect(res).toMatchObject({ ok: false, error: "unavailable", status: 503, message: NO_LEDGER_MESSAGE });
    const bad = await commands.invoke("friction.report", { options: { limit: "zero" } }, mcp("friction:read"));
    expect(bad).toMatchObject({ ok: false, error: "invalid_input" });
    expect((bad as { message: string }).message).toMatch(/^limit: /);
    expect((bad as { message: string }).message).not.toContain("zero");
  });

  it("a channel-pinned caller analyzes only its channel's runs (KTD10): channel-Y labels never appear", async () => {
    const NOW = 1_700_000_000_000;
    const store = new InMemoryRunStore({ now: () => NOW });
    const record = (id: string, channelId: string): RunRecord => {
      const events = lockfileEvents();
      return {
        id,
        label: `coding · ${channelId === "http:x" ? "x-repo" : "y-repo"}/${id}`,
        agent: "coding",
        model: "m",
        channelId,
        userId: "slack:U1",
        threadKey: `${channelId}:${id}`,
        startedAt: NOW - 60_000,
        finishedAt: NOW - 1000,
        status: "completed",
        eventCount: events.length,
        storedEventCount: events.length,
        truncated: false,
        events,
        diagnosis: analyzeRunFriction(events),
      };
    };
    for (const id of ["x1", "x2"]) await store.put(record(id, "http:x"));
    for (const id of ["y1", "y2"]) await store.put(record(id, "http:y"));
    const legacy = await seededLedger(); // legacy rows carry no channel → excluded under a pin
    const { commands } = bind({ ledger: new RunStoreFrictionLedger(store, legacy) });

    const pinned = await commands.invoke("friction.report", { options: { minRuns: "1" } }, { ...mcp("friction:read"), channel: "http:x" });
    expect(pinned.ok).toBe(true);
    const report = reportOf(pinned);
    expect(report.runsAnalyzed).toBe(2);
    const labels = report.patterns.flatMap((p) => p.examples.map((e) => e.label));
    expect(labels.every((l) => l?.includes("x-repo"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("y-repo");
    expect(JSON.stringify(report)).not.toContain("acme/r1");

    const unpinned = await commands.invoke("friction.report", { options: { minRuns: "1" } }, mcp("friction:read"));
    expect(reportOf(unpinned).runsAnalyzed).toBe(6);
  });
});

describe("friction.propose", () => {
  it("a repoManager chat caller files through the tracker with the exact pre-migration reply; a plain user is refused (R13)", async () => {
    const { commands, tracker } = bind({ ledger: await seededLedger() });
    const refused = await commands.invoke("friction.propose", { options: { top: "3" } }, chat("slack:UNOBODY", { repoManager: false }));
    expect(refused).toMatchObject({ ok: false, error: "unauthorized", status: 403 });
    expect(tracker.calls).toEqual([]);

    const filed = await commands.invoke("friction.propose", { options: { top: "3" } }, chat("slack:UDEV", { repoManager: true }));
    expect(text(commands, "friction.propose", filed)).toBe(
      "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern · 1 filed\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high\n\n*Filed:*\n• https://github.com/coreplanelabs/switchboard/issues/1 — [friction] setup/install recurs in 2 of 2 runs: pnpm install --frozen-lockfile",
    );
    expect(tracker.issues("coreplanelabs/switchboard")).toHaveLength(1);

    const again = await commands.invoke("friction.propose", { options: { top: "3" } }, chat("slack:UADMIN", { repoManager: true }));
    expect(text(commands, "friction.propose", again)).toBe(
      "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern · 1 already open\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high\n\n*Already open (not refiled):*\n• https://github.com/coreplanelabs/switchboard/issues/1 — `setup_install:pnpm install --frozen-lockfile`",
    );
    expect(tracker.issues("coreplanelabs/switchboard")).toHaveLength(1);
  });

  it("`dryRun` is a real boolean on text surfaces: \"false\" files, \"true\" files nothing", async () => {
    const { commands, tracker } = bind({ ledger: await seededLedger() });
    const dry = await commands.invoke("friction.propose", { options: { dryRun: "true", top: "3" } }, mcp("friction:write"));
    expect(text(commands, "friction.propose", dry)).toBe(
      "🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern · dry run (nothing filed)\n\n1. `setup_install:pnpm install --frozen-lockfile` — 2 runs · 2× · 1m 30s · high\n\n*Would file (dry run):*\n• [friction] setup/install recurs in 2 of 2 runs: pnpm install --frozen-lockfile",
    );
    expect(tracker.issues("coreplanelabs/switchboard")).toEqual([]);
    const wet = await commands.invoke("friction.propose", { options: { dryRun: "false" } }, mcp("friction:write"));
    expect(wet.ok).toBe(true);
    expect(tracker.issues("coreplanelabs/switchboard")).toHaveLength(1);
    expect(await commands.invoke("friction.propose", { options: { dryRun: "yes" } }, mcp("friction:write"))).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("`repo` overrides the configured target; without either it is `unavailable` with the legacy hint", async () => {
    const { commands, tracker } = bind({ ledger: await seededLedger(), config: () => undefined });
    expect(await commands.invoke("friction.propose", {}, mcp("friction:write"))).toMatchObject({ ok: false, error: "unavailable", message: NO_REPO_MESSAGE });
    const res = await commands.invoke("friction.propose", { options: { repo: "acme/other" } }, mcp("friction:write"));
    expect(res.ok).toBe(true);
    expect(tracker.issues("acme/other")).toHaveLength(1);
    expect(await commands.invoke("friction.propose", { options: { repo: "not a slug" } }, mcp("friction:write"))).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("a tracker failure is `unavailable` carrying its message, not a 500", async () => {
    const tracker = new InMemoryIssueTracker();
    tracker.listOpen = async () => {
      throw new Error("GitHub App credentials missing");
    };
    const registry = new CommandRegistry<FrictionCommandDeps>({ audit: () => {} });
    registerFrictionCommands(registry);
    const commands = bindCommands(registry, { friction: { ledger: await seededLedger(), tracker, config: () => CONFIG, readSource: async () => "" } });
    expect(await commands.invoke("friction.propose", {}, mcp("friction:write"))).toMatchObject({ ok: false, error: "unavailable", message: "GitHub App credentials missing" });
  });
});

describe("scopes on machine surfaces (AE12)", () => {
  it("a dispatch-only token is refused on both; runs:write is refused on friction.propose; the exact scope passes", async () => {
    const { commands, tracker } = bind({ ledger: await seededLedger() });
    for (const id of ["friction.report", "friction.propose"]) {
      expect(await commands.invoke(id, {}, mcp("dispatch")), id).toMatchObject({ ok: false, error: "unauthorized", status: 403 });
    }
    expect(await commands.invoke("friction.propose", {}, mcp("runs:write"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect(await commands.invoke("friction.report", {}, mcp("friction:write"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("friction.report", {}, mcp("friction:read"))).ok).toBe(true);
    expect((await commands.invoke("friction.propose", { options: { dryRun: "true" } }, mcp("friction:write"))).ok).toBe(true);
    expect(tracker.issues("coreplanelabs/switchboard")).toEqual([]);
  });

  it("declares the R13 gates and derives a JSON schema (dryRun accepts a boolean or its string form)", () => {
    const byId = Object.fromEntries(frictionCommands.map((c) => [c.id, c]));
    expect(byId["friction.report"]).toMatchObject({ scope: "friction:read", chatGate: "open", effect: "read" });
    expect(byId["friction.propose"]).toMatchObject({ scope: "friction:write", chatGate: "repoManager", effect: "write" });
    const schema = jsonSchemaFor(byId["friction.propose"]) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["dryRun", "minRuns", "repo", "top"]);
    expect(JSON.stringify(schema.properties.dryRun)).toContain('"boolean"');
  });
});

describe("friction.analyze (CLI only) — the former frictionCli", () => {
  const CAPTURE = [
    "retry: 3000",
    'data: {"type":"tool_call","tool":"bash","summary":"$ npm test","at":1}',
    'data: {"type":"tool_result","tool":"bash","ok":false,"summary":"boom","at":30000}',
    "garbage",
    "event: end",
    "data: {}",
  ].join("\n");
  const cli: Caller = { kind: "cli", id: "cli:local", scopes: "all" };

  function bindAnalyze(files: Record<string, string>) {
    return bind({
      readSource: async (source) => {
        if (!(source in files)) throw new Error("ENOENT: no such file");
        return files[source];
      },
    }).commands;
  }

  it("reads a file (or stdin as `-`), diagnoses it, counts skipped lines, and renders the report", async () => {
    const commands = bindAnalyze({ "run.sse": CAPTURE, "-": CAPTURE });
    const res = await commands.invoke("friction.analyze", { args: ["run.sse"] }, cli);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toMatchObject({ source: "run.sse", events: 2, skipped: 1 });
    const text = renderText(commands.get("friction.analyze")!, res.value);
    expect(text).toMatch(/verdict:/);
    expect(text).toContain("(skipped 1 unparseable line)");
    expect((await commands.invoke("friction.analyze", {}, cli)).ok).toBe(true); // stdin default
  });

  it("--slow-ms and --in-progress reach the analyzer; a trailing unpaired call under the default hints at --in-progress, never with it", async () => {
    const trailing = 'data: {"type":"tool_call","tool":"bash","summary":"$ npm test","at":1}';
    const commands = bindAnalyze({ live: trailing, "run.sse": CAPTURE });
    const hinted = await commands.invoke("friction.analyze", { args: ["live"] }, cli);
    expect(hinted.ok && (hinted.value as { hint?: string }).hint).toMatch(/--in-progress/);
    const quiet = await commands.invoke("friction.analyze", { args: ["live"], options: { inProgress: "true" } }, cli);
    expect(quiet.ok && (quiet.value as { hint?: string }).hint).toBeUndefined();
    const slow = await commands.invoke("friction.analyze", { args: ["run.sse"], options: { slowMs: "10" } }, cli);
    expect(slow.ok && JSON.stringify(slow.value)).toContain("slow_tool");
  });

  it("a missing file is `not_found`, a stream without events is `invalid_input` (never a crash); the command is CLI-only", async () => {
    const commands = bindAnalyze({ empty: "not json\n" });
    expect(await commands.invoke("friction.analyze", { args: ["missing.jsonl"] }, cli)).toMatchObject({ ok: false, error: "not_found", message: expect.stringContaining("missing.jsonl") });
    expect(await commands.invoke("friction.analyze", { args: ["empty"] }, cli)).toMatchObject({ ok: false, error: "invalid_input", message: "no run events found in empty (1 unparseable lines)" });
    expect(await commands.invoke("friction.analyze", { args: ["empty"] }, chat("slack:UX", { repoManager: false }))).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("friction.analyze", { args: ["empty"] }, mcp("friction:read"))).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("friction.report — truncated inputs", () => {
  it("counts records diagnosed on a truncated event stream (`truncatedRuns`) and the rendered report says so", async () => {
    const { commands } = bind({ ledger: await truncatedLedger() });
    const res = await commands.invoke("friction.report", {}, chat("slack:UX", { repoManager: false }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect((res.value as { truncatedRuns: number; runsAnalyzed: number }).truncatedRuns).toBe(1);
    expect(renderText(commands.get("friction.report")!, res.value)).toContain("3 runs analyzed (1 run diagnosed on a truncated event stream — patterns may be incomplete)");
  });
});
