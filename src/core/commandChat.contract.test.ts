import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../config.js";
import { bindCommands } from "./commandRegistry.js";
import { handleChatCommand, parseChatCommand, RESERVED_CHAT_GROUPS } from "./commandChat.js";
import { CommandRegistry, renderCompact, type Caller } from "./commandRegistry.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import { RunRegistry } from "./runRegistry.js";
import { InMemoryRunStore } from "./runStore.js";
import { createRunsService } from "./runsService.js";
import { registerRunsCommands, type RunsCommandDeps } from "./commands/runs.js";

// Feature: features/command-registry.md — the chat row of the shared adapter
// contract (#157 U7/U13): the same fixture as the HTTP/MCP/CLI rows (one live +
// one persisted run); the text a chat caller sees is `renderCompact` of exactly
// the JSON `invoke` returns, and no live-run token appears anywhere. When
// `src/channels/commandContract.test.ts` lands, this row folds into its table.

const NOW = 1_700_000_000_000;
const TOKEN = "tok-live-secret";

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

function persisted(id: string): RunRecord {
  const events = [
    { type: "input" as const, text: "please do the thing", seq: 1 },
    { type: "answer" as const, text: "all done", seq: 2 },
  ];
  return {
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: `slack:C1:${id}`,
    startedAt: NOW - 20_000,
    finishedAt: NOW - 5_000,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
  };
}

async function fixture() {
  const reg = new RunRegistry({ genId: () => "live0001", genToken: () => TOKEN, now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(persisted("fin00001"));
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const deps: RunsCommandDeps = { runs: createRunsService({ registry: reg, store }) };
  reg.create("review · acme/api", { agent: "review", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
  const dir = mkdtempSync(join(tmpdir(), "swb-chat-contract-"));
  writeFileSync(join(dir, "config.yaml"), CONFIG_YAML);
  const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
  return { registry, deps, config, commands: bindCommands(registry, deps) };
}

describe("command contract — chat row", () => {
  it("chat `runs list status=all` renders renderCompact(invoke JSON) for the same caller; no token anywhere", async () => {
    const { registry, deps, config, commands } = await fixture();
    const text = "runs list status=all";
    const parsed = parseChatCommand(text, commands, RESERVED_CHAT_GROUPS);
    expect(parsed).toEqual({ id: "runs.list", input: { status: "all" } });

    const caller: Caller = { kind: "chat", id: "slack:UADMIN", scopes: new Set(), chatGate: config.chatGateFor("slack:UADMIN") };
    const direct = await registry.invoke("runs.list", { status: "all" }, caller, deps);
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error("unreachable");

    const reply = await handleChatCommand({ commands, parsed: parsed!, msg: { channelId: "slack:CX", userId: "slack:UADMIN" }, config, now: NOW });
    expect(reply).toBe(renderCompact("runs.list", direct.value, { now: NOW }));
    expect(reply.split("\n")).toHaveLength(2);
    expect(reply).not.toContain(TOKEN);
    expect(JSON.stringify(direct.value)).not.toContain(TOKEN);
  });

  it("chat error mapping mirrors invoke: unauthorized → restricted line; invalid input → field line", async () => {
    const { config, commands } = await fixture();
    const parsed = parseChatCommand("runs list status=bogus", commands, RESERVED_CHAT_GROUPS)!;
    expect(await handleChatCommand({ commands, parsed, msg: { channelId: "slack:CX", userId: "slack:UX" }, config })).toBe("🚫 `runs list` is restricted. Ask <@slack:UADMIN>.");
    const admin = await handleChatCommand({ commands, parsed, msg: { channelId: "slack:CX", userId: "slack:UADMIN" }, config });
    expect(admin).toBe('⚠️ `runs list`: status: expected one of "active", "finished", "all"');
    expect(admin).not.toContain("bogus");
  });
});
