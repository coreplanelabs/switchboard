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
import type { FastPathDeps } from "./fastPath.js";
import { isInlineRunCommand, runChatCommand, type RouteEventFields } from "./commandRun.js";

// Feature: docs/reference/specs/command-registry.md item 18 — the command-run
// machinery the fast paths and the request router's command branch share
// (record 0036, unit 2): the same functions the fast path ran before they moved
// here, behaving as they did, plus the one thing the router adds — its
// decision on the command run's record, right after `run_meta`, redacted.

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

function deps(): FastPathDeps & { runRegistry: RunRegistry } {
  const dir = mkdtempSync(join(tmpdir(), "swb-commandrun-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  const config = new ConfigStore(path, join(dir, "overrides.json"));
  const registry = new RunRegistry({ genId: () => "run-cmd", genToken: () => "tok" });
  const commands = buildCoreCommands(config, null, {
    registry,
    secrets: processSecrets,
    dataDir: dir,
    warn: () => {},
    audit: () => {},
  });
  return { config, runRegistry: registry, runHistoryWriter: new NullRunHistoryWriter(), clock: () => NOW, commands };
}

const msg = (text: string, user = "slack:UADMIN"): IncomingMessage => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: "slack:CX:1.0",
  text,
});

function request(text: string, d: FastPathDeps & { runRegistry: RunRegistry }) {
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: vi.fn(async () => []),
  };
  const message = msg(text);
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  const ending = createRunEnding({ registry: d.runRegistry });
  return { message, io, ending, trace, replies };
}

const ROUTE: RouteEventFields = {
  preset: "command",
  reason: "command repo.test",
  model: "anthropic/general-model",
  command: "repo.test",
  input: { args: ["acme/api", "main"], options: {} },
  receipt: "repo test acme/api main",
};

describe("runChatCommand — the machinery moved from the fast path", () => {
  it("records an inline run for a command that does work (`repo.test`) and none for one that answers from local state (`config.show`) — exactly as the fast path did", async () => {
    expect(isInlineRunCommand("repo.test")).toBe(true);
    expect(isInlineRunCommand("mcp.promote")).toBe(true); // a promote does work: an org entry and a ticket
    expect(isInlineRunCommand("mcp.list")).toBe(false);
    expect(isInlineRunCommand("config.show")).toBe(false);
    const d = deps();
    const { message, io, ending, trace } = request("config show", d);
    const shown = await runChatCommand(
      d,
      message,
      io,
      { kind: "invoke", id: "config.show", input: { args: [], options: {} } },
      ending,
      trace,
    );
    expect(shown.ok).toBe(true);
    expect(d.runRegistry.snapshotById("run-cmd")).toBeNull();
    await runChatCommand(
      d,
      message,
      io,
      { kind: "invoke", id: "repo.test", input: { args: ["acme/api", "main"], options: {} } },
      ending,
      trace,
    );
    // The op's own outcome in this harness is not the point; the record is:
    // one run, finished with the command's own status, its answer the reply.
    const snap = d.runRegistry.snapshotById("run-cmd");
    expect(snap?.finished).toBe(true);
    expect(snap?.events.map((e) => e.type)).toEqual(expect.arrayContaining(["input", "run_meta", "answer"]));
    expect(snap?.events.some((e) => e.type === "route")).toBe(false);
  });

  it("a `route` passed in is published on the command run right after `run_meta` — the router's decision beside the run it caused — and the audit door is the router's", async () => {
    const d = deps();
    const { message, io, ending, trace } = request("run the tests on main", d);
    await runChatCommand(
      d,
      message,
      io,
      { kind: "invoke", id: "repo.test", input: { args: ["acme/api", "main"], options: {} } },
      ending,
      trace,
      { route: ROUTE, source: "route" },
    );
    const events = d.runRegistry.snapshotById("run-cmd")?.events ?? [];
    const types = events.map((e) => e.type);
    expect(types.indexOf("route")).toBe(types.indexOf("run_meta") + 1);
    expect(events.find((e) => e.type === "route")).toMatchObject({
      type: "route",
      preset: "command",
      command: "repo.test",
      input: { args: ["acme/api", "main"], options: {} },
      receipt: "repo test acme/api main",
      at: NOW,
    });
    // One record, finished with the command's own status, one answer: the
    // reply is its projection.
    expect(d.runRegistry.snapshotById("run-cmd")?.finished).toBe(true);
    expect(events.filter((e) => e.type === "answer")).toHaveLength(1);
  });

  it("a command that makes no run gets no `route` event to ride: the option is inert for a log-only command", async () => {
    const d = deps();
    const { message, io, ending, trace } = request("show config", d);
    const res = await runChatCommand(
      d,
      message,
      io,
      { kind: "invoke", id: "config.show", input: { args: [], options: {} } },
      ending,
      trace,
      { route: { ...ROUTE, command: "config.show", receipt: "config show" }, source: "route" },
    );
    expect(res.ok).toBe(true);
    expect(d.runRegistry.snapshotById("run-cmd")).toBeNull();
  });
});
