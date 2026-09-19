import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { processSecrets } from "../../secrets.js";
import { ConfigStore } from "../../config.js";
import { buildCoreCommands } from "../commandCatalogue.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { NullRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import * as fastPath from "./fastPath.js";
import { answerChatCommand, isInlineRunCommand, type FastPathDeps } from "./fastPath.js";

// Feature: docs/reference/specs/command-registry.md (the chat adapter as stage A),
// docs/reference/specs/routing-and-config.md item 10 — the fast path's own
// contract: what it answers, what it hands on. Stage A is the ONE fast path:
// the typed grammar, and nothing that reads prose. The inline command runs and
// the receipts are proven end to end through `dispatch()` in
// `src/core/dispatcher.test.ts` (`registry chat commands in the fast-path
// chain`, `inline command runs + run receipts`); the natural op forms reach
// `repo.test|build` through the router's door there too (`deterministic ops`).

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
    secrets: processSecrets,
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

describe("stage A is the only fast path — no natural form is recognized without the model", () => {
  it("the natural op forms are prose here: handed on untouched, nothing replied, no history fetched, no run — the router's door is their way to repo.test|build", async () => {
    const d = deps(true);
    for (const text of ["run the tests on main in acme/api", "build main in acme/api", "Run tests on master."]) {
      const { ctx, replies, history } = request(text, d);
      expect(await answerChatCommand(d, ctx), text).toBe(false);
      expect(replies, text).toEqual([]);
      expect(history, text).not.toHaveBeenCalled();
    }
    expect(d.runRegistry!.listActive()).toEqual([]);
  });

  it("the module exports the typed grammar's stage and the inline-run predicate, and nothing that reads prose", () => {
    expect(Object.keys(fastPath).sort()).toEqual(["COMMAND_RUN_AGENT", "answerChatCommand", "isInlineRunCommand"]);
  });
});

describe("isInlineRunCommand — which commands are recorded as runs", () => {
  it("commands that do work are runs; replies from local state are not", () => {
    for (const id of [
      "friction.report",
      "friction.propose",
      "memory.forget",
      "memory.sweep",
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
