import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { CLI_CALLER, cliCatalogue, parseCliArgv, runCli } from "../cli.js";
import { ConfigStore } from "../config.js";
import { createCommandHttpHandler } from "../channels/commandHttp.js";
import { handleMcpRequest } from "../channels/mcp.js";
import { grantsFor } from "./authz/grants.js";
import { ALL_CAPABILITIES, NO_CAPABILITIES, type Capabilities } from "./capabilities.js";
import { buildCoreCommands } from "./commandCatalogue.js";
import { handleChatCommand, parseChatCommand } from "./commandChat.js";
import { CommandRegistry, type CommandDef, type CommandInvoker } from "./commandRegistry.js";
import { coreCommandGroups, registerCoreCommands, type CoreCommandDeps } from "./commands/all.js";
import { httpPath, mcpToolName } from "./commandSurface.js";
import type { CoreDeps } from "./dispatcher.js";
import { docCommands } from "../docs/reference.js";
import { RunRegistry } from "./runRegistry.js";

// Feature: docs/reference/specs/command-registry.md item 28 — a command whose capability is
// off is HIDDEN on every surface, not answered `unavailable`. The real catalogue
// is bound twice (everything on, everything off) and each adapter is asked what
// it shows and what it answers when the hidden command is named anyway.

const CONFIG_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/m
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
`;

function catalogue(capabilities: Capabilities): CommandInvoker {
  const dir = mkdtempSync(join(tmpdir(), "swb-caps-cmds-"));
  writeFileSync(join(dir, "config.yaml"), CONFIG_YAML);
  const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
  return buildCoreCommands(config, null, {
    registry: new RunRegistry(),
    env: {},
    dataDir: dir,
    warn: () => {},
    audit: () => {},
    capabilities,
  });
}

/** Every registration, whatever is on — the docs generator's view. */
function everyCommand(): CommandDef<unknown>[] {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  return registry.list() as CommandDef<unknown>[];
}

const ids = (cmds: ReadonlyArray<{ id: string }>) => cmds.map((c) => c.id).sort();

/** The capability each gated command needs — the one table the surfaces below are checked against. */
const GATES: Record<string, (c: Capabilities) => boolean> = {
  "memory.list": (c) => c.memory,
  "memory.forget": (c) => c.memory,
  "friction.report": (c) => c.runHistory,
  "friction.propose": (c) => c.runHistory,
  "repo.list": (c) => c.residents,
  "repo.onboard": (c) => c.residents,
  "repo.offboard": (c) => c.residents,
  "repo.rebuild": (c) => c.residents,
  "repo.reconfigure": (c) => c.residents,
  "repo.test": (c) => c.residents || c.execution === "local",
  "repo.build": (c) => c.residents || c.execution === "local",
  "mcp.list": (c) => c.mcp,
  "mcp.add": (c) => c.mcp,
  "mcp.connect": (c) => c.mcp,
  "mcp.show": (c) => c.mcp,
  "mcp.remove": (c) => c.mcp,
  "schedule.list": (c) => c.schedules,
};

/** Nothing on, tools in a per-thread sandbox: the deterministic ops have no backend either. */
const NOTHING: Capabilities = { ...NO_CAPABILITIES, execution: "cloudflare" };

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
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    status: () => status,
    text: () => out.join(""),
  };
}

describe("enabledWhen on the core catalogue — which capability each command needs", () => {
  it("every gated command names exactly the capability the table says; every other command is always on", () => {
    for (const cmd of everyCommand()) {
      const gate = GATES[cmd.id];
      if (!gate) {
        expect(cmd.enabledWhen, `${cmd.id} should be always on`).toBeUndefined();
        continue;
      }
      expect(cmd.enabledWhen, `${cmd.id} should be gated`).toBeDefined();
      // Flip every boolean axis one at a time from all-on: the command must go
      // dark exactly when the table's predicate does.
      for (const key of Object.keys(ALL_CAPABILITIES) as Array<keyof Capabilities>) {
        if (typeof ALL_CAPABILITIES[key] !== "boolean") continue;
        const flipped = { ...ALL_CAPABILITIES, [key]: false } as Capabilities;
        expect(cmd.enabledWhen!(flipped), `${cmd.id} with ${key} off`).toBe(gate(flipped));
      }
      expect(cmd.enabledWhen!(NOTHING), `${cmd.id} with nothing on`).toBe(gate(NOTHING));
      expect(cmd.enabledWhen!({ ...NOTHING, execution: "local" }), `${cmd.id} local`).toBe(
        gate({ ...NOTHING, execution: "local" }),
      );
    }
  });

  it("no runs.* command is gated: every one answers for live runs without a history store", () => {
    for (const cmd of everyCommand().filter((c) => c.id.startsWith("runs."))) {
      expect(cmd.enabledWhen, cmd.id).toBeUndefined();
    }
  });
});

describe("hiding per surface — the catalogue bound with everything on vs nothing on", () => {
  const on = catalogue(ALL_CAPABILITIES);
  const off = catalogue(NOTHING);
  const hidden = Object.keys(GATES).sort();

  it("the bound catalogue lists every registration when all is on, and exactly the gated ones vanish when nothing is on", () => {
    expect(ids(on.list())).toEqual(ids(everyCommand()));
    expect(ids(off.list())).toEqual(ids(everyCommand()).filter((id) => !hidden.includes(id)));
    for (const id of hidden) {
      expect(on.get(id), id).toBeDefined();
      expect(off.get(id), id).toBeUndefined();
    }
  });

  it("naming a hidden command is `not_found` on invoke — never `unavailable`", async () => {
    const res = await off.invoke("memory.list", { args: [], options: {} }, CLI_CALLER);
    expect(res).toMatchObject({ ok: false, error: "not_found", decidedBy: "registry" });
    const still = await on.invoke("memory.list", { args: [], options: {} }, CLI_CALLER);
    // With memory on but no store the handler's own defence in depth answers.
    expect(still).toMatchObject({ ok: false, error: "unavailable", decidedBy: "handler" });
  });

  it("help: the chat catalogue and `<group> help` omit hidden commands; a hidden group's `help` is prose; the bare word `help` still answers", async () => {
    const admin = { userId: "slack:UADMIN", channelId: "slack:C1", threadKey: "slack:C1:1" };
    const dir = mkdtempSync(join(tmpdir(), "swb-caps-help-"));
    writeFileSync(join(dir, "config.yaml"), CONFIG_YAML);
    const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
    const helpOf = async (commands: CommandInvoker) => {
      const parsed = parseChatCommand("help", commands);
      expect(parsed?.kind).toBe("invoke");
      return handleChatCommand({ commands, parsed: parsed!, msg: admin, config });
    };
    const onText = await helpOf(on);
    const offText = await helpOf(off);
    expect(onText).toContain("`memory list`");
    expect(onText).toContain("`repo onboard`");
    expect(onText).toContain("`schedule list`");
    expect(offText).not.toContain("memory");
    expect(offText).not.toContain("`repo ");
    expect(offText).not.toContain("schedule");
    expect(offText).toContain("`config show`");
    expect(parseChatCommand("memory help", on)?.kind).toBe("reply");
    expect(parseChatCommand("memory help", off)).toBeNull();
    // A group whose every chat member is hidden (`friction analyze` is CLI-only) is prose too.
    expect(parseChatCommand("friction help", on)?.kind).toBe("reply");
    expect(parseChatCommand("friction help", off)).toBeNull();
  });

  it("chat: a hidden `<group> <verb>` is prose (null), so the message goes to the model, never `unavailable`", () => {
    expect(parseChatCommand("memory list", on)?.kind).toBe("invoke");
    expect(parseChatCommand("memory list", off)).toBeNull();
    expect(parseChatCommand("repo list", off)).toBeNull();
    expect(parseChatCommand("runs list", off)?.kind).toBe("invoke");
  });

  it("CLI: the catalogue omits hidden commands and naming one is a usage error (exit 2) listing what exists", async () => {
    expect(cliCatalogue(on)).toContain("memory list");
    expect(cliCatalogue(off)).not.toContain("memory list");
    expect(cliCatalogue(off)).toContain("runs list");
    const parsed = parseCliArgv(["memory", "list"], off);
    expect(parsed.kind).toBe("usage");
    const out = await runCli(off, parsed as Extract<typeof parsed, { kind: "usage" }>, CLI_CALLER);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("unknown command: memory list");
    expect(out.stderr).not.toContain("unavailable");
    expect(parseCliArgv(["memory", "list"], on).kind).toBe("command");
  });

  it("HTTP: /api/<id> of a hidden command is the adapter's 404, byte-identical to an unknown id", async () => {
    const grants = (id: string) => grantsFor(id, { commandGroups: coreCommandGroups() });
    const handler = createCommandHttpHandler(off, { grantsFor: grants });
    const hiddenReq = fakeReqRes("GET", httpPath("memory.list"));
    await handler(hiddenReq.req, hiddenReq.res, { sub: "user-1" });
    const unknownReq = fakeReqRes("GET", "/api/nosuch.thing");
    await handler(unknownReq.req, unknownReq.res, { sub: "user-1" });
    expect(hiddenReq.status()).toBe(404);
    expect(hiddenReq.text()).toBe(unknownReq.text());
    const onHandler = createCommandHttpHandler(on, { grantsFor: grants });
    const shown = fakeReqRes("GET", httpPath("memory.list"));
    await onHandler(shown.req, shown.res, { sub: "user-1" });
    expect(shown.status()).not.toBe(404);
  });

  it("MCP: tools/list omits hidden commands; tools/call on one is the same `unknown tool` error an unregistered name gets", async () => {
    const auth = { tokens: { tok: { subject: "alice" } } };
    const grants = () => ({
      actions: new Set(["memory:read", "runs:read"]),
      channels: "all" as const,
      repos: new Set<string>(),
    });
    const list = async (commands: CommandInvoker) => {
      const res = await handleMcpRequest(
        {
          method: "POST",
          headers: { authorization: "Bearer tok" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        },
        {} as CoreDeps,
        { auth, commands, grantsFor: grants },
      );
      return ((res.body as { result: { tools: Array<{ name: string }> } }).result.tools ?? []).map((t) => t.name);
    };
    expect(await list(on)).toContain(mcpToolName("memory.list"));
    expect(await list(off)).not.toContain(mcpToolName("memory.list"));
    expect(await list(off)).toContain(mcpToolName("runs.list"));
    const call = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer tok" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: mcpToolName("memory.list"), arguments: {} },
        }),
      },
      {} as CoreDeps,
      { auth, commands: off, grantsFor: grants },
    );
    const body = call.body as { error?: { code: number; message: string; data?: { code?: string } } };
    expect(body.error).toMatchObject({ code: -32602, message: `unknown tool: ${mcpToolName("memory.list")}` });
    expect(body.error?.data?.code).not.toBe("unavailable");
  });

  it("the reference docs render the FULL catalogue: a registry with no capabilities given lists everything", () => {
    const docs = docCommands(everyCommand());
    expect(ids(docs)).toEqual(ids(everyCommand()));
    expect(ids(docs)).toEqual(expect.arrayContaining(hidden));
  });
});
