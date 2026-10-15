import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConfigStore } from "../../config.js";
import { processSecrets } from "../../secrets.js";
import { conversationCommandTools } from "../../tools/commands.js";
import type { ToolContext } from "../../tools/runnableTool.js";
import { buildCoreCommands } from "../commandCatalogue.js";
import { bindCommands, CommandRegistry, type CommandInput } from "../commandRegistry.js";
import { InMemoryConfirmationStore } from "../confirmations.js";
import { relayToolCall, RelayedCalls, type LiveHarness } from "../harness/pi/relay.js";
import { startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { NullRunHistoryWriter } from "../runHistoryWriter.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { contextThreadSessionKey } from "../runLedger/sessionLog.js";
import { RunRegistry } from "../runRegistry.js";
import type { ChannelIO, ConfirmationOffer, IncomingMessage } from "../types.js";
import { consumeAndRun } from "./confirm.js";
import { executeConversationCommand } from "./conversationCommand.js";
import { createOrchestratorDecisions, type OrchestratorCommandDecision } from "./orchestratorDecisions.js";
import { LEASE_MS } from "../runLedger/types.js";

// Feature: docs/reference/specs/main-agent-actions.md — native command receipts.
const YAML = `
organization: acme
providers:
  anthropic: { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
defaults:
  agent: general
  models: { general: anthropic/general-model, coding: anthropic/coding-model }
  boundary: { confirm: destructive }
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
`;

function fixture(persistent = true) {
  const dir = mkdtempSync(join(tmpdir(), "swb-command-receipt-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  const config = new ConfigStore(path, join(dir, "overrides.json"));
  let n = 0;
  const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => "token" });
  const ledger = new InMemoryRunLedger();
  const confirmations = new InMemoryConfirmationStore();
  const deps = {
    config,
    runRegistry: registry,
    runHistoryWriter: new NullRunHistoryWriter(),
    confirmations,
    commands: buildCoreCommands(config, null, {
      registry,
      secrets: processSecrets,
      dataDir: dir,
      warn: () => {},
      audit: () => {},
      operations: () => ({ run: async (_op, input) => ({ kind: "result", ok: true, summary: `Passed ${input.ref}` }) }),
    }),
    ...(persistent
      ? {
          runLedger: {
            sessionPersistence: true,
            appendSession: ledger.appendSession.bind(ledger),
            readSessionTail: ledger.readSessionTail.bind(ledger),
            readRequesterTarget: ledger.readRequesterTarget.bind(ledger),
            checkpointRequesterTarget: ledger.checkpointRequesterTarget.bind(ledger),
          },
        }
      : {}),
  };
  const message: IncomingMessage = {
    channelId: "slack:DTEST",
    threadKey: "slack:DTEST:1.0",
    userId: "slack:UADMIN",
    messageId: "1",
    text: "run both commands",
  };
  const parent = registry.create("Main conversation", {
    agent: "orchestrator",
    channelId: message.channelId,
    userId: message.userId,
    threadKey: message.threadKey,
    channelVisibility: "private",
  });
  const trace = startRequestRoot({}, { channel: "slack", receivedAt: 0 });
  trace.bindRun(parent.id, (event) => registry.publish(parent.id, event));
  const ending = createRunEnding({ registry });
  const ready = ledger.claim({
    runId: parent.id,
    threadKey: message.threadKey,
    gen: "command-generation",
    leaseMs: LEASE_MS,
    startedAt: 0,
    meta: { agent: "orchestrator", channelId: message.channelId, userId: message.userId, threadKey: message.threadKey },
    system: "",
    tools: [],
  });
  const decisions = createOrchestratorDecisions({
    owner: {
      runId: parent.id,
      requesterId: message.userId,
      channelId: message.channelId,
      threadKey: message.threadKey,
    },
    save: async (entries) =>
      (await ledger.setState(parent.id, "command-generation", { orchestratorDecisions: entries })).ok,
  });
  const admission = {
    record: (decision: OrchestratorCommandDecision) => decisions.record(decision),
    check: async () => ({ ok: true as boolean }),
  };
  const replies: string[] = [];
  const offers: ConfirmationOffer[] = [];
  const io: ChannelIO = {
    reply: async (text) => void replies.push(text),
    history: async () => [],
    status: async () => ({ update: () => {}, done: async () => {} }),
    offer: async (offer) => void offers.push(offer),
  };
  const invoke = async (id: string, input: CommandInput, callId: string, msg = message) => {
    await ready;
    return executeConversationCommand(
      deps,
      {
        msg,
        io,
        trace,
        ending,
        invocationId: JSON.stringify([parent.id, callId]),
        context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
        check: async () =>
          (await admission.check()).ok ? { ok: true } : { ok: false, code: "direct-audience-denied" },
        recordDecision: (decision: OrchestratorCommandDecision) => admission.record(decision),
      },
      id,
      input,
    );
  };
  const session = () => ledger.sessions.get(contextThreadSessionKey(message.threadKey));
  const saved = () => (session()?.rows ?? []).map((row) => JSON.parse(row.json).part.text as string);
  const toolContext: ToolContext = {
    executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "" },
    command: async (_source, id, input, callId) => invoke(id, input, callId),
  };
  return {
    deps,
    config,
    message,
    parent,
    registry,
    trace,
    ending,
    io,
    replies,
    offers,
    ledger,
    invoke,
    session,
    saved,
    toolContext,
    admission,
  };
}

describe("conversation command receipts", () => {
  it("saves the orchestrator and source decision before applying a command", async () => {
    const f = fixture();
    let before: unknown;
    const apply = f.config.setUserOverride.bind(f.config);
    vi.spyOn(f.config, "setUserOverride").mockImplementation(async (...args) => {
      before = structuredClone(f.ledger.live.get(f.parent.id)?.state.orchestratorDecisions);
      return apply(...args);
    });
    const result = await f.invoke("config.set", { args: ["me"], options: { effort: "high" } }, "set-first");
    expect(JSON.parse(result.text).outcome).toBe("ran");
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({ effort: "high" });
    expect(before).toMatchObject([
      {
        version: 1,
        id: '["run-1","set-first"]',
        owner: { runId: "run-1", requesterId: "slack:UADMIN", channelId: "slack:DTEST", threadKey: "slack:DTEST:1.0" },
        source: { kind: "request", messageId: "1" },
        command: "config.set",
        line: "config set me --effort high",
      },
    ]);
  });

  it("holds a command when its decision cannot be saved", async () => {
    const f = fixture();
    f.admission.record = async () => false;
    const refused = await f.invoke("config.set", { args: ["me"], options: { effort: "high" } }, "held");
    expect(refused).toEqual({ ok: false, text: "The command decision could not be saved; no command ran." });
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({});
    f.admission.record = async (decision) => {
      return (await f.ledger.setState(f.parent.id, "command-generation", { orchestratorDecisions: [decision] })).ok;
    };
    const accepted = await f.invoke("config.set", { args: ["me"], options: { effort: "high" } }, "accepted");
    expect(JSON.parse(accepted.text).outcome).toBe("ran");
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({ effort: "high" });
  });

  it("rechecks source access after the decision acknowledgement", async () => {
    const f = fixture();
    f.admission.check = async () => ({ ok: f.ledger.live.get(f.parent.id)?.state.orchestratorDecisions === undefined });
    const result = await f.invoke("config.set", { args: ["me"], options: { effort: "high" } }, "lost-source");
    expect(result).toEqual({ ok: false, text: "Requester source access is unavailable; no command ran." });
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({});
    f.admission.check = async () => ({ ok: true });
    const accepted = await f.invoke("config.set", { args: ["me"], options: { effort: "high" } }, "fresh-source");
    expect(JSON.parse(accepted.text).outcome).toBe("ran");
  });

  it("preserves command arguments named reason and intent", async () => {
    const f = fixture();
    const commands = new CommandRegistry({ audit: () => {} });
    commands.register({
      id: "backend.explain",
      action: "config:read",
      effect: "read",
      describe: "Read an explanation",
      args: [{ name: "reason", schema: z.string(), describe: "Reason" }],
      options: z.object({ intent: z.string() }),
      handler: async ({ args, options }) => `${args.reason}: ${options.intent}`,
    });
    f.deps.commands = bindCommands(commands, {});
    const result = await f.invoke(
      "backend.explain",
      { args: ["requested reason"], options: { intent: "requested intent" } },
      "explain",
    );
    expect(JSON.parse(result.text).outcome).toBe("ran");
    expect(f.replies).toEqual(["requested reason: requested intent"]);
  });

  it("preserves raw parameters for the registry's schema transformations", async () => {
    const f = fixture();
    const commands = new CommandRegistry({ audit: () => {} });
    commands.register({
      id: "backend.size",
      action: "config:read",
      effect: "read",
      describe: "Read a string size",
      args: [{ name: "text", schema: z.string().transform((value) => value.length), describe: "Text" }],
      handler: async ({ args }) => `size ${args.text}`,
    });
    f.deps.commands = bindCommands(commands, {});
    const result = await f.invoke("backend.size", { args: ["hello"] }, "size");
    expect(JSON.parse(result.text).outcome).toBe("ran");
    expect(f.replies).toEqual(["size 5"]);
  });

  it("refuses an unknown option before it can be hidden by a positional argument", async () => {
    const f = fixture();
    const refused = await f.invoke(
      "config.set",
      { args: ["me"], options: { scope: "channel", effort: "high" } },
      "invalid",
    );
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("scope");
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({});
    const accepted = await f.invoke("config.set", { args: ["me"], options: { effort: "high" } }, "valid");
    expect(JSON.parse(accepted.text).outcome).toBe("ran");
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({ effort: "high" });
  });

  it.each(["pi", "opencode"])(
    "the shared harness relay keeps distinct calls and replays one call once (%s)",
    async (mode) => {
      const f = fixture();
      await f.config.setChannelOverride("slack:CFIRST", { effort: "low" });
      await f.config.setChannelOverride("slack:CSECOND", { effort: "high" });
      const harness: LiveHarness = {
        runId: f.parent.id,
        tools: conversationCommandTools(f.deps.commands),
        toolContext: f.toolContext,
        rules: { identity: "read", checkout: "/workspace", protectedBranches: [] },
        emit: () => {},
        gateSaw: () => {},
        toolsBlocked: () => undefined,
        toolSpan: () => (mode === "pi" ? f.trace.root.start("tool.command_run") : undefined),
      };
      const calls = new RelayedCalls();
      const ask = {
        toolCallId: "first",
        tool: "command_run",
        input: {
          command: "config.show",
          parameters: { channel: "slack:CFIRST" },
          sourceMessage: f.message.text,
        },
      };
      const first = await relayToolCall(harness, calls, ask);
      const replay = await relayToolCall(harness, calls, ask);
      const second = await relayToolCall(harness, calls, {
        ...ask,
        toolCallId: "second",
        input: {
          ...ask.input,
          parameters: { channel: "slack:CSECOND" },
        },
      });
      expect([first.done, replay.done, second.done]).toEqual([true, true, true]);
      expect(replay).toEqual(first);
      expect(f.replies.map((text) => /effort `([^`]+)`/.exec(text)?.[1])).toEqual(["low", "high"]);
      expect(f.saved().map((text) => /effort `([^`]+)`/.exec(text)?.[1])).toEqual(["low", "high"]);
      expect(JSON.stringify([first, replay, second])).not.toContain("*Effective for you in this channel:*");
    },
  );

  it("requires the trusted tool call id before applying a command", async () => {
    const f = fixture();
    const tool = conversationCommandTools(f.deps.commands).find((tool) => tool.name === "command_run")!;
    const context = f.toolContext;
    const input = { command: "config.set", parameters: { scope: "me", effort: "high" }, sourceMessage: f.message.text };
    expect(await tool.run(input, context)).toBe("error: The command call could not be identified; nothing ran.");
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({});
    const result = await tool.run(input, { ...context, callId: "verified-call" });
    if (typeof result !== "string") throw new Error("Expected a command receipt");
    expect(JSON.parse(result).outcome).toBe("ran");
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({ effort: "high" });
    expect(f.saved()).toEqual(["Updated your scope: effort `high`."]);
  });

  it("retains separate receipts for applied personal settings in one turn", async () => {
    const f = fixture();
    const first = await f.invoke("config.set", { args: ["me"], options: { efforts: { general: "low" } } }, "first");
    const second = await f.invoke(
      "config.set",
      { args: ["me"], options: { models: { coding: "anthropic/coding-model" } } },
      "second",
    );
    expect(f.config.scopes(f.message.channelId, f.message.userId).user).toEqual({
      efforts: { general: "low" },
      models: { coding: "anthropic/coding-model" },
    });
    expect(f.replies).toEqual([
      "Updated your scope: efforts `general=low`.",
      "Updated your scope: models `coding=anthropic/coding-model`, efforts `general=low`.",
    ]);
    expect(f.saved()).toEqual(f.replies);
    expect([first, second].map((result) => JSON.parse(result.text).outcome)).toEqual(["ran", "ran"]);
  });

  it("retains both inline repository outcomes without replacing the main trace", async () => {
    const f = fixture();
    await f.invoke("repo.test", { args: ["acme/api", "first"] }, "first");
    await f.invoke("repo.test", { args: ["acme/api", "second"] }, "second");
    expect(f.replies).toEqual(["✅ Passed first", "✅ Passed second"]);
    expect(f.saved()).toEqual(["✅ Passed first", "✅ Passed second"]);
    expect(f.trace.runId).toBe("run-1");
    expect(
      f.registry
        .listActive()
        .filter((run) => run.status === "completed")
        .map((run) => run.id)
        .sort(),
    ).toEqual(["run-2", "run-3"]);
  });

  it("keeps identical submissions and distinct deferred completions bound to their calls", async () => {
    const f = fixture();
    const commands = new CommandRegistry({ audit: () => {} });
    commands.register({
      id: "backend.wait",
      action: "config:read",
      effect: "read",
      describe: "Start query",
      args: [{ name: "query", schema: z.string(), describe: "Query" }],
      handler: async ({ args }) => ({ query: args.query }),
      render: () => "Query queued.",
      settle: async (value) => ({ ok: true, text: `Finished ${(value as { query: string }).query}.` }),
    });
    f.deps.commands = bindCommands(commands, {});
    const first = await f.invoke("backend.wait", { args: ["first"] }, "first");
    const second = await f.invoke("backend.wait", { args: ["second"] }, "second");
    await expect
      .poll(() => f.replies.filter((text) => text.startsWith("Finished")).sort())
      .toEqual(["Finished first.", "Finished second."]);
    expect(f.saved().sort()).toEqual(["Finished first.", "Finished second.", "Query queued.", "Query queued."]);
    expect([first, second].map((result) => JSON.parse(result.text).outcome)).toEqual(["submitted", "submitted"]);
    expect([first.text, second.text].join(" ")).not.toContain("Finished");
  });

  it("persists separate approval offers without executing their handlers", async () => {
    const f = fixture();
    await f.config.setChannelOverride("slack:CFIRST", { effort: "low" });
    await f.config.setChannelOverride("slack:CSECOND", { effort: "low" });
    const first = await f.invoke(
      "config.set",
      { args: ["channel"], options: { channel: "slack:CFIRST", effort: "high" } },
      "first",
    );
    const second = await f.invoke(
      "config.set",
      { args: ["channel"], options: { channel: "slack:CSECOND", effort: "medium" } },
      "second",
    );
    expect([first, second].map((result) => JSON.parse(result.text).outcome)).toEqual([
      "approval_pending",
      "approval_pending",
    ]);
    expect(f.offers).toHaveLength(2);
    expect(f.offers[0].id).not.toBe(f.offers[1].id);
    expect(f.config.scopes("slack:CFIRST", f.message.userId).channel).toEqual({ effort: "low" });
    expect(f.config.scopes("slack:CSECOND", f.message.userId).channel).toEqual({ effort: "low" });
    expect(f.saved()).toHaveLength(2);
    expect(await f.deps.confirmations.consume(f.offers[0].id, [f.message.userId])).toMatchObject({
      ok: false,
      refused: "used",
    });
  });

  it("keeps separately consumed approvals isolated by their original offer ids", async () => {
    const f = fixture();
    for (const [channel, effort, callId] of [
      ["slack:CFIRST", "high", "first"],
      ["slack:CSECOND", "medium", "second"],
    ]) {
      const pending = await f.invoke("config.set", { args: ["channel"], options: { channel, effort } }, callId);
      expect(JSON.parse(pending.text).outcome).toBe("approval_pending");
      const offer = f.offers.at(-1)!;
      const trace = startRequestRoot({}, { channel: "slack", receivedAt: 0 });
      const result = await consumeAndRun(
        f.deps,
        { id: offer.id, actorIds: [f.message.userId] },
        f.io,
        createRunEnding({ registry: f.registry }),
        trace,
        async () => ({ status: "completed" }),
        async () => ({ ok: true }),
      );
      expect(result).toMatchObject({ kind: "ran", result: { ok: true } });
      expect(await f.deps.confirmations.consume(offer.id, [f.message.userId])).toMatchObject({
        ok: false,
        refused: "used",
      });
    }
    expect(f.config.scopes("slack:CFIRST", f.message.userId).channel).toEqual({ effort: "high" });
    expect(f.config.scopes("slack:CSECOND", f.message.userId).channel).toEqual({ effort: "medium" });
    expect(f.saved()).toHaveLength(4);
    expect([...f.session()!.rowIds!.keys()].filter((key) => key.startsWith("confirmation:"))).toEqual(
      f.offers.map((offer) => `confirmation:${offer.id}:command:config.set`),
    );
  });

  it("reuses one receipt only for exact call replay and keeps a later requester message independent", async () => {
    const f = fixture();
    await f.config.setChannelOverride("slack:CFIRST", { effort: "low" });
    await f.config.setChannelOverride("slack:CSECOND", { effort: "high" });
    const input = { options: { channel: "slack:CFIRST" } };
    await f.invoke("config.show", input, "same-call");
    await f.invoke("config.show", input, "same-call");
    await f.invoke("config.show", { options: { channel: "slack:CSECOND" } }, "later-call", {
      ...f.message,
      messageId: "2",
    });
    expect(f.replies.map((text) => /effort `([^`]+)`/.exec(text)?.[1])).toEqual(["low", "low", "high"]);
    expect(f.saved().map((text) => /effort `([^`]+)`/.exec(text)?.[1])).toEqual(["low", "high"]);
  });

  it("delivers separate native outcomes without conversation persistence", async () => {
    const f = fixture(false);
    await f.config.setChannelOverride("slack:CFIRST", { effort: "low" });
    await f.config.setChannelOverride("slack:CSECOND", { effort: "high" });
    await f.invoke("config.show", { options: { channel: "slack:CFIRST" } }, "first");
    await f.invoke("config.show", { options: { channel: "slack:CSECOND" } }, "second");
    expect(f.replies.map((text) => /effort `([^`]+)`/.exec(text)?.[1])).toEqual(["low", "high"]);
    expect(f.saved()).toEqual([]);
  });
});
