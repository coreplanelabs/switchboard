import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { parseDirectives } from "../../directives.js";
import { buildCoreCommands } from "../commandCatalogue.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { NullRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { answerChatCommand, answerOperation, isInlineRunCommand, type FastPathDeps } from "./fastPath.js";

// Feature: docs/reference/specs/command-registry.md (the chat adapter as stage A),
// docs/reference/specs/routing-and-config.md item 10 — the fast paths' own
// contract: what they answer, what they hand on. The inline command runs, the
// receipts and the natural-language translation into `repo.test|build` are
// proven end to end through `dispatch()` in `src/core/dispatcher.test.ts`
// (`registry chat commands in the fast-path chain`, `inline command runs + run
// receipts`, `deterministic ops fast-path`).

const NOW = 10_000;

const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
`;

function deps(withCommands: boolean): FastPathDeps {
  const dir = mkdtempSync(join(tmpdir(), "swb-fastpath-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  const config = new ConfigStore(path, join(dir, "overrides.json"));
  const registry = new RunRegistry();
  const commands = buildCoreCommands(config, null, {
    registry,
    env: process.env,
    dataDir: dir,
    warn: () => {},
    audit: () => {},
  });
  return {
    config,
    runRegistry: registry,
    runHistoryWriter: new NullRunHistoryWriter(),
    clock: () => NOW,
    ...(withCommands ? { commands } : {}),
  };
}

const msg = (text: string): IncomingMessage => ({
  channelId: "slack:CX",
  userId: "slack:UX",
  threadKey: "slack:CX:1.0",
  text,
});

function request(text: string, d: FastPathDeps) {
  const replies: string[] = [];
  const history = vi.fn(async () => []);
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history,
  };
  const message = msg(text);
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  const ending = createRunEnding({ registry: d.runRegistry! });
  return { ctx: { msg: message, io, ending, trace }, replies, history };
}

describe("answerChatCommand — stage A", () => {
  it("without a command registry no message is a command: nothing answered, nothing fetched", async () => {
    const d = deps(false);
    const { ctx, replies, history } = request("help", d);
    expect(await answerChatCommand(d, ctx)).toBe(false);
    expect(replies).toEqual([]);
    expect(history).not.toHaveBeenCalled();
  });

  it("a registered chat command is answered inline through the registry and the dispatch is over — before any history fetch", async () => {
    const d = deps(true);
    const { ctx, replies, history } = request("help", d);
    expect(await answerChatCommand(d, ctx)).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Switchboard");
    expect(history).not.toHaveBeenCalled();
    expect(d.runRegistry!.listActive()).toEqual([]); // `help` does no work: no inline run
  });

  it("prose is handed on untouched", async () => {
    const d = deps(true);
    const { ctx, replies } = request("hello there, how are you", d);
    expect(await answerChatCommand(d, ctx)).toBe(false);
    expect(replies).toEqual([]);
  });
});

describe("answerOperation — the natural-language op fast path", () => {
  it("prose that names no op is handed on", async () => {
    const d = deps(true);
    const { ctx, replies } = request("hello there, how are you", d);
    const directives = parseDirectives(ctx.msg.text);
    expect(await answerOperation(d, { ...ctx, directives, history: [] })).toBe(false);
    expect(replies).toEqual([]);
  });

  it("an explicit agent: or model: directive disables recognition — the user picked a model path", async () => {
    const d = deps(true);
    const { ctx, replies } = request("agent:coding run the tests on main in acme/api", d);
    const directives = parseDirectives(ctx.msg.text);
    expect(directives.agent).toBe("coding");
    expect(await answerOperation(d, { ...ctx, directives, history: [] })).toBe(false);
    expect(replies).toEqual([]);
  });

  it("without a command registry nothing is recognized", async () => {
    const d = deps(false);
    const { ctx } = request("run the tests on main in acme/api", d);
    expect(await answerOperation(d, { ...ctx, directives: parseDirectives(ctx.msg.text), history: [] })).toBe(false);
  });
});

describe("isInlineRunCommand — which commands are recorded as runs", () => {
  it("commands that do work are runs; replies from local state are not", () => {
    for (const id of [
      "friction.report",
      "friction.propose",
      "memory.forget",
      "repo.onboard",
      "repo.offboard",
      "repo.rebuild",
      "repo.reconfigure",
      "repo.test",
      "repo.build",
      "mcp.add",
      "mcp.connect",
      "mcp.remove",
    ])
      expect(isInlineRunCommand(id), id).toBe(true);
    for (const id of [
      "help.show",
      "config.show",
      "config.set",
      "memory.list",
      "repo.list",
      "runs.list",
      "schedule.list",
      "mcp.list",
      "mcp.show",
    ])
      expect(isInlineRunCommand(id), id).toBe(false);
  });
});
