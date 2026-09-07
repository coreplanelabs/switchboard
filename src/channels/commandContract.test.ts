import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { ConfigStore } from "../config.js";
import { CLI_CALLER, parseCliArgv, runCommand } from "../cli.js";
import { grantsFor } from "../core/authz/grants.js";
import { chatCallerFor, handleChatCommand, parseChatCommand } from "../core/commandChat.js";
import { coreCommandGroups } from "../core/commands/all.js";
import { callerWith } from "../core/testing/callers.js";
import { renderText, type Caller, type CommandDef, type CommandInvoker } from "../core/commandRegistry.js";
import { buildCoreCommands } from "../core/commandCatalogue.js";
import { camelToKebab, cliFlag, httpPath, jsonSchemaFor, mcpToolName, toSurfaceNames } from "../core/commandSurface.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { RunStoreFrictionLedger } from "../core/frictionLedger.js";
import type { ResidentAdminClient } from "../core/residentAdmin.js";
import type { RunEvent } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import { createCommandHttpHandler } from "./commandHttp.js";
import { handleMcpRequest } from "./mcp.js";

// Feature: features/command-registry.md — the SHARED ADAPTER CONTRACT (AE3,
// R7/R10, KTD21). One fixture (a live run with a `tok-` capability token and a
// persisted run, the friction ledger served from the same store, and a resident
// registry stub) is driven through every adapter; each row must hand back the
// exact JSON object `invoke` produced, and no surface may leak a token. Every
// row receives the SAME by-name input and spells it the way its surface does —
// kebab-case query keys (HTTP GET), camelCase JSON (MCP), `--kebab` flags with
// positionals (CLI argv and chat text) — all derived from the definition.

const NOW = 1_700_000_000_000;

const RESIDENTS = {
  cap: 6,
  count: 1,
  residents: [{ resource: "repo:jshttp/vary", defaultRef: "master", live: { state: "warm", reason: "", sha: "0123456789abcdef" } }],
};

const residentAdmin: ResidentAdminClient = {
  onboard: async () => ({ status: 500, data: {} }),
  offboard: async () => ({ status: 500, data: {} }),
  reconfigure: async () => ({ status: 500, data: {} }),
  rebuild: async () => ({ status: 500, data: {} }),
  residents: async () => ({ status: 200, data: RESIDENTS }),
  status: async () => ({ status: 200, data: { state: "warm", reason: "", inFlight: 0 } }),
};

const CONFIG_YAML = `
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
permissions:
  admins: ["slack:UADMIN"]
`;

function record(id: string, finishedAt: number): RunRecord {
  const events: RunEvent[] = [
    { type: "input", text: "please do the thing", seq: 1 },
    { type: "tool_call", tool: "bash", summary: "$ pnpm install --frozen-lockfile", seq: 2, at: 10 },
    { type: "tool_result", tool: "bash", ok: false, summary: "ERR_PNPM_OUTDATED_LOCKFILE", seq: 3, at: 45_010 },
    { type: "answer", text: "all done", seq: 4 },
  ];
  return {
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: `slack:C1:${id}`,
    channelVisibility: "public", // every adapter caller may read a public run: the contract is about transport, not visibility
    startedAt: finishedAt - 10_000,
    finishedAt,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
  };
}

async function fixture() {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `live-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const live = reg.create("coding · acme/live", { agent: "coding", model: "anthropic/claude", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t", channelVisibility: "public" });
  reg.publish(live.id, { type: "input", text: "live request" });
  reg.publish(live.id, { type: "tool_call", tool: "bash", summary: "$ pwd" });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record("fin-1", NOW - 1000));
  await store.put(record("fin-2", NOW - 2000)); // a second run so the lockfile friction RECURS (≥2 distinct runs)
  const dir = mkdtempSync(join(tmpdir(), "swb-contract-"));
  writeFileSync(join(dir, "config.yaml"), CONFIG_YAML);
  const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
  // The ONE catalogue every real process binds (`buildCoreCommands`), over this fixture's stores.
  const commands = buildCoreCommands(config, store, {
    registry: reg,
    env: {},
    dataDir: dir,
    warn: () => {},
    audit: () => {},
    runs: createRunsService({ registry: reg, store }),
    frictionLedger: new RunStoreFrictionLedger(store),
    tracker: new InMemoryIssueTracker(),
    residentAdmin: () => residentAdmin,
    now: () => NOW,
  });
  return { commands, config, liveId: live.id, liveToken: live.token, persistedIds: ["fin-1", "fin-2"] };
}

// ---- one row per adapter -----------------------------------------------------

/** A by-name input, as every surface addresses it: declared argument names and camelCase option keys. */
type Named = Record<string, string>;

/** What every adapter row must produce for a command: the JSON object it handed
 *  back to its caller (parsed out of its own wire format) and the full wire
 *  text, which is what the no-token assertion scans. */
interface SurfaceResult {
  json: unknown;
  wire: string;
}

interface AdapterRow {
  name: string;
  /** The Caller the adapter is expected to resolve — `invoke` is called with it
   *  directly to produce the reference object. */
  caller: Caller;
  call(f: Awaited<ReturnType<typeof fixture>>, id: string, named: Named): Promise<SurfaceResult>;
}

/** The registry's `{ args, options }` for a by-name input — what the reference `invoke` receives. */
function inputFor(cmd: CommandDef<unknown>, named: Named) {
  const argNames = new Set((cmd.args ?? []).map((a) => a.name));
  return {
    args: (cmd.args ?? []).map((a) => named[a.name]),
    options: Object.fromEntries(Object.entries(named).filter(([k]) => !argNames.has(k))),
  };
}

/** The CLI/chat spelling of a by-name input: positionals in declared order, then `--kebab value`. */
function wordsFor(cmd: CommandDef<unknown>, named: Named): string[] {
  const argNames = new Set((cmd.args ?? []).map((a) => a.name));
  return [
    ...(cmd.args ?? []).flatMap((a) => (named[a.name] === undefined ? [] : [named[a.name]])),
    ...Object.entries(named)
      .filter(([k]) => !argNames.has(k))
      .flatMap(([k, v]) => [cliFlag(k), v]),
  ];
}

function fakeReqRes(method: string, url: string, headers: IncomingHttpHeaders = {}) {
  const req = {
    method,
    url,
    headers: { host: "bot.example.test", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    on: () => {},
    destroy: () => {},
    async *[Symbol.asyncIterator]() {},
  };
  const out: string[] = [];
  let status = 0;
  const res = {
    writeHead: (s: number) => void (status = s),
    end: (c?: string) => {
      if (c) out.push(c);
    },
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, status: () => status, text: () => out.join("") };
}

/** An unlisted Access browser session holds every group's read (the legacy translation). */
const BROWSER_GRANTS = { commandGroups: coreCommandGroups() };

const httpRow: AdapterRow = {
  name: "http",
  caller: callerWith("access", "access:user-1", grantsFor("access:user-1", BROWSER_GRANTS)),
  async call(f, id, named) {
    const handler = createCommandHttpHandler(f.commands, { grantsFor: (actorId) => grantsFor(actorId, BROWSER_GRANTS), devBypassActive: false });
    // A query string spells option keys in kebab-case (`?since-ms=…`); argument names are what they are.
    const query = new URLSearchParams(Object.entries(named).map(([k, v]) => [camelToKebab(k), v]));
    const t = fakeReqRes("GET", `${httpPath(id)}?${query.toString()}`);
    await handler(t.req, t.res, { sub: "user-1" });
    expect(t.status(), t.text()).toBe(200);
    return { json: JSON.parse(t.text()), wire: t.text() };
  },
};

const MCP_SCOPES = ["runs:read", "friction:read", "repo:read"];

const mcpRow: AdapterRow = {
  name: "mcp",
  caller: callerWith("mcp", "mcp:alice", MCP_SCOPES),
  async call(f, id, named) {
    const res = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer tok" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: mcpToolName(id), arguments: named } }),
      },
      {} as CoreDeps,
      { auth: { tokens: { tok: { subject: "alice", scopes: MCP_SCOPES } } }, commands: f.commands },
    );
    const body = res.body as { result?: { content: { text: string }[] }; error?: unknown };
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    const text = body.result!.content[0].text;
    return { json: JSON.parse(text.slice(text.indexOf("\n") + 1)), wire: JSON.stringify(res.body) };
  },
};

const cliRow: AdapterRow = {
  name: "cli",
  caller: CLI_CALLER,
  async call(f, id, named) {
    const cmd = f.commands.get(id)!;
    const parsed = parseCliArgv([...toSurfaceNames(id).cli, ...wordsFor(cmd, named), "--json"], f.commands);
    if (parsed.kind !== "command") throw new Error(JSON.stringify(parsed));
    const out = await runCommand(f.commands, parsed, CLI_CALLER);
    expect(out.exitCode, out.stderr).toBe(0);
    return { json: JSON.parse(out.stdout), wire: out.stdout + out.stderr };
  },
};

const rows: AdapterRow[] = [httpRow, mcpRow, cliRow];

// ---- the contract ------------------------------------------------------------

describe.each(rows)("adapter contract — $name", (row) => {
  it("runs.list {status:'all'} hands back the exact invoke JSON: both runs once, no token", async () => {
    const f = await fixture();
    const reference = await f.commands.invoke("runs.list", inputFor(f.commands.get("runs.list")!, { status: "all" }), row.caller);
    expect(reference.ok).toBe(true);
    const got = await row.call(f, "runs.list", { status: "all" });
    expect(got.json).toEqual(reference.ok ? reference.value : null);
    const ids = (got.json as { runs: { id: string }[] }).runs.map((r) => r.id);
    expect(ids.sort()).toEqual([...f.persistedIds, f.liveId].sort());
    expect(got.wire).not.toContain("tok-");
    expect(got.wire).not.toContain(f.liveToken);
  });

  it("a bare runs.list (no options) defaults to the active runs — the same JSON as {status:'active'}: the live run only", async () => {
    const f = await fixture();
    const reference = await f.commands.invoke("runs.list", inputFor(f.commands.get("runs.list")!, { status: "active" }), row.caller);
    expect(reference.ok).toBe(true);
    const got = await row.call(f, "runs.list", {});
    expect(got.json).toEqual(reference.ok ? reference.value : null);
    expect((got.json as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual([f.liveId]);
    expect(got.wire).not.toContain("tok-");
  });

  it("runs.get <id> for the live and the persisted run hands back the exact invoke JSON, no token", async () => {
    const f = await fixture();
    for (const id of [f.liveId, f.persistedIds[0]]) {
      const reference = await f.commands.invoke("runs.get", inputFor(f.commands.get("runs.get")!, { id }), row.caller);
      expect(reference.ok, id).toBe(true);
      const got = await row.call(f, "runs.get", { id });
      expect(got.json, id).toEqual(reference.ok ? reference.value : null);
      expect(got.wire).not.toContain("tok-");
    }
  });

  it("runs.events <id> --after-seq 1 --limit 2: a positional argument plus two kebab↔camel options bind identically on every surface", async () => {
    const f = await fixture();
    const named = { id: f.persistedIds[0], afterSeq: "1", limit: "2" };
    const reference = await f.commands.invoke("runs.events", inputFor(f.commands.get("runs.events")!, named), row.caller);
    expect(reference.ok, JSON.stringify(reference)).toBe(true);
    const got = await row.call(f, "runs.events", named);
    expect(got.json).toEqual(reference.ok ? reference.value : null);
    const page = got.json as { events: { seq: number }[] };
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(got.wire).not.toContain("tok-");
  });
});

// Red-verified: adding `token: s.token` to `liveView()` in runsService.ts fails
// the rows above on the `tok-` scan.

// ---- migrated chat commands (U9, R13) ----------------------------------------

describe.each(rows)("adapter contract for migrated commands — $name", (row) => {
  it("friction.report --limit 5 hands back the exact invoke JSON: the recurring lockfile pattern over the two persisted runs, no token", async () => {
    const f = await fixture();
    const reference = await f.commands.invoke("friction.report", { options: { limit: 5 } }, row.caller);
    expect(reference.ok, JSON.stringify(reference)).toBe(true);
    const got = await row.call(f, "friction.report", { limit: "5" });
    expect(got.json).toEqual(reference.ok ? reference.value : null);
    const report = got.json as { runsAnalyzed: number; patterns: { key: string; runIds: string[] }[] };
    expect(report.runsAnalyzed).toBe(2);
    expect(report.patterns.map((p) => p.key)).toEqual(["setup_install:pnpm install --frozen-lockfile"]);
    expect(report.patterns[0].runIds.sort()).toEqual(f.persistedIds.sort());
    expect(got.wire).not.toContain("tok-");
    expect(got.wire).not.toContain(f.liveToken);
  });

  it("repo.list hands back the resident registry body exactly as invoke returned it", async () => {
    const f = await fixture();
    const reference = await f.commands.invoke("repo.list", {}, row.caller);
    expect(reference.ok).toBe(true);
    const got = await row.call(f, "repo.list", {});
    expect(got.json).toEqual(reference.ok ? reference.value : null);
    expect(got.json).toEqual(RESIDENTS);
    expect(got.wire).not.toContain("tok-");
  });
});

// ---- the chat row ------------------------------------------------------------

describe("adapter contract — chat", () => {
  const caller = (config: ConfigStore, userId: string): Caller => chatCallerFor({ userId, channelId: "slack:CX", threadKey: "slack:CX:t" }, config);

  it("`runs list --status all` renders renderText(invoke JSON) for the same caller; no token anywhere", async () => {
    const f = await fixture();
    const parsed = parseChatCommand("runs list --status all", f.commands);
    expect(parsed).toEqual({ kind: "invoke", id: "runs.list", input: { args: [], options: { status: "all" } } });
    const direct = await f.commands.invoke("runs.list", { options: { status: "all" } }, caller(f.config, "slack:UADMIN"));
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error("unreachable");
    const reply = await handleChatCommand({ commands: f.commands, parsed: parsed!, msg: { channelId: "slack:CX", userId: "slack:UADMIN", threadKey: "slack:CX:t" }, config: f.config, now: NOW });
    expect(reply).toBe(renderText(f.commands.get("runs.list")!, direct.value, { now: NOW, surface: "chat" }));
    expect(reply.split("\n")).toHaveLength(3);
    expect(reply).not.toContain("tok-");
    expect(JSON.stringify(direct.value)).not.toContain("tok-");
  });

  it("a bare `runs list` in chat lists the active runs (the spec's default) instead of demanding --status", async () => {
    const f = await fixture();
    const parsed = parseChatCommand("runs list", f.commands);
    expect(parsed).toEqual({ kind: "invoke", id: "runs.list", input: { args: [], options: {} } });
    const direct = await f.commands.invoke("runs.list", { options: { status: "active" } }, caller(f.config, "slack:UADMIN"));
    if (!direct.ok) throw new Error("unreachable");
    const reply = await handleChatCommand({ commands: f.commands, parsed: parsed!, msg: { channelId: "slack:CX", userId: "slack:UADMIN", threadKey: "slack:CX:t" }, config: f.config, now: NOW });
    expect(reply).toBe(renderText(f.commands.get("runs.list")!, direct.value, { now: NOW, surface: "chat" }));
    expect(reply.split("\n")).toHaveLength(1);
    expect(reply).toContain(f.liveId.slice(0, 8));
    expect(reply).not.toContain("expected one of");
  });

  it("`friction report --limit 5` and `repo list` reply with the command's own render of the same JSON the machine rows saw", async () => {
    const f = await fixture();
    for (const [text, id, named] of [
      ["friction report --limit 5", "friction.report", { limit: "5" }],
      ["repo list", "repo.list", {}],
    ] as const) {
      const parsed = parseChatCommand(text, f.commands)!;
      expect(parsed.kind).toBe("invoke");
      const direct = await f.commands.invoke(id, inputFor(f.commands.get(id)!, named), caller(f.config, "slack:UX"));
      expect(direct.ok, id).toBe(true);
      const reply = await handleChatCommand({ commands: f.commands, parsed, msg: { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:t" }, config: f.config });
      expect(reply).toBe(renderText(f.commands.get(id)!, direct.ok ? direct.value : null));
      expect(reply).not.toContain("tok-");
    }
  });

  it("error mapping mirrors invoke: unauthorized → restricted line; invalid input → option line without the value", async () => {
    const f = await fixture();
    const parsed = parseChatCommand("runs list --status bogus", f.commands)!;
    expect(await handleChatCommand({ commands: f.commands, parsed, msg: { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:t" }, config: f.config })).toBe("🚫 `runs list` is restricted. Ask <@slack:UADMIN>.");
    const admin = await handleChatCommand({ commands: f.commands, parsed, msg: { channelId: "slack:CX", userId: "slack:UADMIN", threadKey: "slack:CX:t" }, config: f.config });
    expect(admin).toBe('⚠️ `runs list`: status: expected one of "active", "finished", "all"');
    expect(admin).not.toContain("bogus");
  });
});

// ---- naming: one definition, four spellings ---------------------------------------

describe("derived naming across surfaces (KTD2/KTD21)", () => {
  it("every registered option key is camelCase in TypeScript/MCP/JSON and kebab-case on the CLI/chat; every id is snake_case as an MCP tool and /api/<id> over HTTP", async () => {
    const f = await fixture();
    const seen: Record<string, string> = {};
    for (const cmd of f.commands.list()) {
      expect(mcpToolName(cmd.id)).toBe(cmd.id.replace(".", "_"));
      expect(httpPath(cmd.id)).toBe(`/api/${cmd.id}`);
      const schema = jsonSchemaFor(cmd) as { properties: Record<string, unknown> };
      for (const key of Object.keys(cmd.options?.shape ?? {})) {
        expect(key, `${cmd.id} option ${key}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(schema.properties, `${cmd.id} MCP schema has ${key}`).toHaveProperty(key);
        seen[key] = cliFlag(key);
      }
      for (const arg of cmd.args ?? []) expect(schema.properties, `${cmd.id} MCP schema has argument ${arg.name}`).toHaveProperty(arg.name);
    }
    expect(seen).toMatchObject({ sinceMs: "--since-ms", beforeId: "--before-id", afterSeq: "--after-seq", minRuns: "--min-runs", dryRun: "--dry-run", limit: "--limit", mode: "--mode" });
  });

  it("the migrated forms read as specified: runs get <id> [--include], runs events <id> [--after-seq] [--limit], runs stop <id> --mode, friction propose [--dry-run] …", async () => {
    const f = await fixture();
    const { usageLine } = await import("../core/commandSurface.js");
    const byId = Object.fromEntries(f.commands.list().map((c) => [c.id, usageLine(c)]));
    expect(byId["runs.get"]).toBe("runs get <id> [--include <messages>]");
    expect(byId["runs.events"]).toBe("runs events <id> [--after-seq <integer>] [--limit <integer>]");
    expect(byId["runs.friction"]).toBe("runs friction <id>");
    expect(byId["runs.stop"]).toBe("runs stop <id> --mode <soft|hard>");
    expect(byId["runs.list"]).toBe("runs list [--status <active|finished|all>] [--agent <string>] [--channel <string>] [--since-ms <integer>] [--limit <integer>] [--before <integer>] [--before-id <string>]");
    expect(byId["friction.report"]).toBe("friction report [--since-ms <integer>] [--limit <integer>] [--min-runs <integer>]");
    expect(byId["friction.propose"]).toBe("friction propose [--dry-run] [--top <integer>] [--min-runs <integer>] [--repo <string>]");
    // Phase 4b: every remaining command, derived from its typed definition.
    expect(byId["help.show"]).toBe("help show");
    expect(byId["config.show"]).toBe("config show [--channel <string>]");
    expect(byId["config.set"]).toBe("config set <scope> [--agent <string>] [--model <string>] [--models <object>] [--effort <low|medium|high|xhigh|max>] [--efforts <object>] [--channel <string>]");
    expect(byId["config.clear"]).toBe("config clear <scope> [--channel <string>]");
    expect(byId["config.instructions"]).toBe("config instructions <scope> [text…] [--channel <string>]");
    expect(byId["memory.list"]).toBe("memory list [query…] [--scope <me|org|repo|channel|all>] [--limit <integer>] [--repo <string>]");
    expect(byId["memory.forget"]).toBe("memory forget <id>");
    expect(byId["repo.onboard"]).toBe("repo onboard <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>] [--evict-coldest]");
    expect(byId["repo.offboard"]).toBe("repo offboard <slug> [--dry-run]");
    expect(byId["repo.reconfigure"]).toBe("repo reconfigure <slug> [--ref <string>] [--test <string>] [--build <string>] [--install <string>]");
    expect(byId["repo.rebuild"]).toBe("repo rebuild <slug> [--dry-run]");
    expect(byId["repo.test"]).toBe("repo test <slug> [ref]");
    expect(byId["repo.build"]).toBe("repo build <slug> [ref]");
    expect(byId["schedule.list"]).toBe("schedule list");
    expect(byId["friction.analyze"]).toBe("friction analyze [source] [--slow-ms <number>] [--in-progress]");
    expect(byId["deploy.plan"]).toBe("deploy plan [--only <string>] [--skip <string>] [--affected] [--base <string>] [--force] [--allow-branch] [--wait-max <integer>] [--poll <integer>]");
    expect(byId["deploy.all"]).toBe(byId["deploy.plan"].replace("deploy plan", "deploy all"));
    expect(byId["env.bootstrap"]).toBe("env bootstrap --env <string> --service <string> [--apply] [--out <string>] [--manifest <string>]");
    // CLI-only commands never reach chat, MCP, or HTTP.
    expect(byId["deploy.restart"]).toBe("deploy restart [--only <bot>] [--force] [--wait-max <integer>] [--poll <integer>]");
    for (const id of ["deploy.all", "deploy.restart", "env.bootstrap", "friction.analyze"]) expect(f.commands.get(id)!.surfaces, id).toEqual({ chat: false, mcp: false, http: false });
    expect(byId["repo.list"]).toBe("repo list");
  });
});

describe("migrated commands over MCP — scopes (AE12)", () => {
  async function callAs(commands: CommandInvoker, scopes: string[], name: string, args: Record<string, string> = {}) {
    const res = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer tok" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      },
      {} as CoreDeps,
      { auth: { tokens: { tok: { subject: "alice", scopes } } }, commands },
    );
    return res.body as { result?: unknown; error?: { code: number; data?: { code: string } } };
  }

  it("a dispatch-only token is refused on friction_report, repo_list, and friction_propose; runs:write is refused on friction_propose; friction:write runs it", async () => {
    const f = await fixture();
    for (const name of ["friction_report", "repo_list", "friction_propose"]) {
      const body = await callAs(f.commands, ["dispatch"], name);
      expect(body.error?.data?.code, name).toBe("unauthorized");
    }
    expect((await callAs(f.commands, ["runs:write"], "friction_propose")).error?.data?.code).toBe("unauthorized");
    // friction:write passes the gate; with no `selfImprovement.repo` and no `repo` arg the step is `unavailable`, not unauthorized
    expect((await callAs(f.commands, ["friction:write"], "friction_propose")).error?.data?.code).toBe("unavailable");
    expect((await callAs(f.commands, ["friction:write"], "friction_propose", { dryRun: "true", repo: "acme/api" })).result).toBeTruthy();
  });
});
