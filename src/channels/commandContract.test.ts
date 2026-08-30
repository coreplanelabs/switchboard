import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { CommandRegistry, bindCommands, type Caller, type CommandInvoker } from "../core/commandRegistry.js";
import { registerRunsCommands, type RunsCommandDeps } from "../core/commands/runs.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { RunEvent } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import { CLI_CALLER, parseCommandArgs, runCommand } from "../commandCli.js";
import { createCommandHttpHandler } from "./commandHttp.js";
import { handleMcpRequest } from "./mcp.js";

// Feature: features/command-registry.md — the SHARED ADAPTER CONTRACT (AE3,
// R7/R10). One fixture (a live run with a `tok-` capability token and a
// persisted run) is driven through every adapter; each row must hand back the
// exact JSON object `invoke` produced, and no surface may leak a token. Rows
// are table-driven so the chat adapter (U13) adds one row, not one test file.

const NOW = 1_700_000_000_000;

function record(id: string, finishedAt: number): RunRecord {
  const events: RunEvent[] = [
    { type: "input", text: "please do the thing", seq: 1 },
    { type: "tool_call", tool: "bash", summary: "$ ls", seq: 2 },
    { type: "answer", text: "all done", seq: 3 },
  ];
  return {
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: `slack:C1:${id}`,
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
  const live = reg.create("coding · acme/live", { agent: "coding", model: "anthropic/claude", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
  reg.publish(live.id, { type: "input", text: "live request" });
  reg.publish(live.id, { type: "tool_call", tool: "bash", summary: "$ pwd" });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record("fin-1", NOW - 1000));
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const commands = bindCommands(registry, { runs: createRunsService({ registry: reg, store }) });
  return { commands, liveId: live.id, liveToken: live.token, persistedId: "fin-1" };
}

// ---- one row per adapter -----------------------------------------------------

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
  call(commands: CommandInvoker, id: string, input: Record<string, string>): Promise<SurfaceResult>;
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

const httpRow: AdapterRow = {
  name: "http",
  caller: { kind: "access", id: "access:user-1", scopes: new Set() },
  async call(commands, id, input) {
    const handler = createCommandHttpHandler(commands, { operatorIdentities: () => [], serviceTokenScopes: () => [], devBypassActive: false });
    const t = fakeReqRes("GET", `/api/${id}?${new URLSearchParams(input).toString()}`);
    await handler(t.req, t.res, { sub: "user-1" });
    expect(t.status()).toBe(200);
    return { json: JSON.parse(t.text()), wire: t.text() };
  },
};

const mcpRow: AdapterRow = {
  name: "mcp",
  caller: { kind: "mcp", id: "mcp:alice", scopes: new Set(["runs:read"]) },
  async call(commands, id, input) {
    const res = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer tok" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: id.replace(".", "_"), arguments: input } }),
      },
      {} as CoreDeps,
      { auth: { tokens: { tok: { subject: "alice", scopes: ["runs:read"] } } }, commands },
    );
    const wire = JSON.stringify(res.body);
    const body = res.body as { result?: { content: { text: string }[] } };
    expect(body.result, wire).toBeTruthy();
    const text = body.result!.content[0].text;
    return { json: JSON.parse(text.slice(text.indexOf("\n") + 1)), wire };
  },
};

const cliRow: AdapterRow = {
  name: "cli",
  caller: CLI_CALLER,
  async call(commands, id, input) {
    const [group, verb] = id.split(".");
    const parsed = parseCommandArgs([group, verb, ...Object.entries(input).map(([k, v]) => `--${k}=${v}`), "--json"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const out = await runCommand(commands, parsed, CLI_CALLER);
    expect(out.exitCode, out.stderr).toBe(0);
    return { json: JSON.parse(out.stdout), wire: out.stdout + out.stderr };
  },
};

const rows: AdapterRow[] = [httpRow, mcpRow, cliRow];

// ---- the contract ------------------------------------------------------------

describe.each(rows)("adapter contract — $name", (row) => {
  it("runs.list {status:'all'} hands back the exact invoke JSON: both runs once, no token", async () => {
    const f = await fixture();
    const reference = await f.commands.invoke("runs.list", { status: "all" }, row.caller);
    expect(reference.ok).toBe(true);
    const got = await row.call(f.commands, "runs.list", { status: "all" });
    expect(got.json).toEqual(reference.ok ? reference.value : null);
    const ids = (got.json as { runs: { id: string }[] }).runs.map((r) => r.id);
    expect(ids.sort()).toEqual([f.persistedId, f.liveId].sort());
    expect(got.wire).not.toContain("tok-");
    expect(got.wire).not.toContain(f.liveToken);
  });

  it("runs.get {id} for the live and the persisted run hands back the exact invoke JSON, no token", async () => {
    const f = await fixture();
    for (const id of [f.liveId, f.persistedId]) {
      const reference = await f.commands.invoke("runs.get", { id }, row.caller);
      expect(reference.ok, id).toBe(true);
      const got = await row.call(f.commands, "runs.get", { id });
      expect(got.json, id).toEqual(reference.ok ? reference.value : null);
      expect(got.wire).not.toContain("tok-");
    }
  });
});

// Red-verified: adding `token: s.token` to `liveView()` in runsService.ts fails
// all six rows above on the `tok-` scan.
