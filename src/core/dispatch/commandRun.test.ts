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
import { isSpanRecord, type RunEvent } from "../runEvents.js";
import type { RunRecord } from "../runRecord.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { FastPathDeps } from "./fastPath.js";
import {
  isInlineRunCommand,
  runInlineCommandRun,
  recordRefusal,
  recordRoutedDecision,
  runChatCommand,
  type RouteEventFields,
} from "./commandRun.js";
import { refusalOf } from "../refusal.js";
import { ROUTE_RECEIPT_CAP } from "./route.js";

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
  it.each(["stop", "unavailable"])(
    "awaits channel admission and records a stop before executing a command (%s)",
    async (mode) => {
      const d = deps();
      const { message, io, ending, trace } = request("repo test", d);
      let release!: () => void;
      io.runStarted = ({ id }) =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            if (mode === "unavailable") {
              reject(new Error("binding unavailable"));
              return;
            }
            d.runRegistry.requestStopById(id, "hard", { kind: "chat", id: "test" });
            resolve();
          };
        });
      const execute = vi.fn(async () => ({ ok: true, text: "executed" }));
      const running = runInlineCommandRun(d, message, "repo.test", io, execute, ending, trace);
      const rejected = expect(running).rejects.toThrow("stopped");
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(execute).not.toHaveBeenCalled();
      release();
      await rejected;
      expect(execute).not.toHaveBeenCalled();
      expect(d.runRegistry.getById("run-cmd")).toMatchObject({ finished: true, status: "stopped_hard" });
      ending.drain(false);
    },
  );
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

// Feature: docs/reference/specs/run-history.md item 2 and
// docs/reference/specs/routing-and-config.md item 21 (record 0044, the counts):
// a door decision about a state change is a run record — a hand-back invokes
// nothing and tells no surface, a paste is recorded whatever its command.

/** The routed `config set` the door hands back, as its record carries it. */
const HAND_BACK: RouteEventFields = {
  preset: "command",
  reason: "command config.set",
  model: "anthropic/general-model",
  command: "config.set",
  input: { args: ["channel"], options: { models: { coding: "anthropic/other-model" } } },
  receipt: "config set channel --models.coding anthropic/other-model",
  outcome: "hand_back",
};
const HAND_BACK_LINE = `To run this: ${HAND_BACK.receipt}`;

/** The registry's `invoke` behind a spy, so a test can say whether any handler ran. */
function spiedInvoke(d: FastPathDeps) {
  const commands = d.commands!;
  const invoke = vi.fn(commands.invoke.bind(commands));
  d.commands = { ...commands, invoke };
  return invoke;
}

/** The null writer with its `write` spied, so the sealed record's shape is readable. */
function keepingWriter() {
  const writer = new NullRunHistoryWriter();
  const write = vi.spyOn(writer, "write");
  return { writer, records: (): RunRecord[] => write.mock.calls.map((c) => c[0]) };
}

const contentTypes = (events: readonly RunEvent[]) => events.filter((e) => !isSpanRecord(e)).map((e) => e.type);

describe("recordRoutedDecision — a door decision as a run record no surface is told about (record 0044)", () => {
  it("publishes input, run_meta, route and answer, seals completed, calls no handler and neither runStarted nor runFinished", async () => {
    const d = deps();
    const kept = keepingWriter();
    d.runHistoryWriter = kept.writer;
    const invoke = spiedInvoke(d);
    const { message, io, ending, trace, replies } = request("use the other model for coding in this channel", d);
    const started = vi.fn();
    const finished = vi.fn();
    io.runStarted = started;
    io.runFinished = finished;
    const def = d.commands!.get("config.set")!;
    await recordRoutedDecision(d, message, io, def, HAND_BACK, HAND_BACK_LINE, ending, trace);
    await ending.sealAfterReply(
      async () => {},
      async () => void (await io.reply(HAND_BACK_LINE)),
    );
    const snap = d.runRegistry.snapshotById("run-cmd");
    expect(snap?.finished).toBe(true);
    expect(d.runRegistry.getById("run-cmd")).toMatchObject({ status: "completed", agent: "command" });
    expect(contentTypes(snap?.events ?? [])).toEqual(["input", "run_meta", "route", "answer"]);
    expect(snap?.events.find((e) => e.type === "route")).toMatchObject({ ...HAND_BACK, at: NOW });
    expect(snap?.events.find((e) => e.type === "answer")).toMatchObject({ text: HAND_BACK_LINE });
    expect(invoke).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(replies).toEqual([HAND_BACK_LINE]);
    // The sealed record is the run's: agent `command`, completed, the decision on it.
    const records = kept.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "run-cmd", agent: "command", status: "completed" });
    expect(records[0]!.events.find((e) => e.type === "route")).toMatchObject({ outcome: "hand_back" });
    // Nothing was written: the channel's config is as the fixture left it.
    expect(
      d.config.resolve({ channelId: "slack:CX", userId: "slack:UADMIN", request: { agent: "coding" } }).modelRef,
    ).not.toBe("anthropic/other-model");
  });
});

describe("runChatCommand — the recording rule widens to a routed decision with an outcome (record 0044)", () => {
  const SET = {
    kind: "invoke",
    id: "config.set",
    input: { args: ["channel"], options: { models: { coding: "anthropic/other-model" } } },
  } as const;

  it("a `config.set` call carrying a route with `outcome: pasted` is recorded — the handler runs, the record carries the outcome and the hand-back's id — and the channel is told of no run", async () => {
    const d = deps();
    const invoke = spiedInvoke(d);
    const { message, io, ending, trace } = request("config set channel --models.coding anthropic/other-model", d);
    const started = vi.fn();
    const finished = vi.fn();
    io.runStarted = started;
    io.runFinished = finished;
    const res = await runChatCommand(d, message, io, SET, ending, trace, {
      route: { ...HAND_BACK, reason: "pasted after hand-back", outcome: "pasted", handBackRunId: "run-hb" },
    });
    expect(res.ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toBe("config.set");
    const snap = d.runRegistry.snapshotById("run-cmd");
    expect(snap?.finished).toBe(true);
    expect(d.runRegistry.getById("run-cmd")).toMatchObject({ status: "completed", agent: "command" });
    expect(contentTypes(snap?.events ?? [])).toEqual(["input", "run_meta", "route", "answer"]);
    expect(snap?.events.find((e) => e.type === "route")).toMatchObject({
      command: "config.set",
      outcome: "pasted",
      handBackRunId: "run-hb",
      reason: "pasted after hand-back",
    });
    // A typed no-work command is answered as it always was: no run announced.
    expect(started).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
  });

  it("the same call with a route and no outcome \u2014 a routed read's shape \u2014 records nothing, as today", async () => {
    const d = deps();
    const invoke = spiedInvoke(d);
    const { message, io, ending, trace } = request("set the coding model here", d);
    const { outcome: _outcome, ...noOutcome } = HAND_BACK;
    const res = await runChatCommand(d, message, io, SET, ending, trace, { route: noOutcome, source: "route" });
    expect(res.ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(d.runRegistry.snapshotById("run-cmd")).toBeNull();
  });

  it("an inline-run command is still announced to the channel when it carries an outcome — the paste of `mcp add` is the run it always was", async () => {
    expect(isInlineRunCommand("mcp.add")).toBe(true);
    const d = deps();
    const { message, io, ending, trace } = request("mcp add acme https://mcp.example.test/sse", d);
    const started = vi.fn();
    io.runStarted = started;
    await runChatCommand(
      d,
      message,
      io,
      { kind: "invoke", id: "mcp.add", input: { args: ["acme", "https://mcp.example.test/sse"], options: {} } },
      ending,
      trace,
      {
        route: {
          ...HAND_BACK,
          command: "mcp.add",
          input: { args: ["acme", "https://mcp.example.test/sse"], options: {} },
          receipt: "mcp add acme https://mcp.example.test/sse",
          reason: "pasted after hand-back",
          outcome: "pasted",
          handBackRunId: "run-hb",
        },
      },
    );
    expect(started).toHaveBeenCalledWith({ id: "run-cmd" });
    expect(d.runRegistry.snapshotById("run-cmd")?.events.find((e) => e.type === "route")).toMatchObject({
      outcome: "pasted",
      handBackRunId: "run-hb",
    });
  });
});

// Feature: docs/reference/specs/run-history.md item 2 and record 0054, as
// amended: every refusal the door makes is a run record — agent `door`, the
// code as the label's lead, completed, no surface told, the redacted request
// and one `refusal` event carrying the code, the cause and the capped sentence.
describe("recordRefusal — every refusal is a run record (record 0054, as amended)", () => {
  it("writes one `door` record: completed, the code leading the label, input + refusal as its content events, and neither runStarted nor runFinished", async () => {
    const d = deps();
    const kept = keepingWriter();
    d.runHistoryWriter = kept.writer;
    const { message, io, ending, trace, replies } = request("agent:coding fix it", d);
    const started = vi.fn();
    const finished = vi.fn();
    io.runStarted = started;
    io.runFinished = finished;
    await recordRefusal(d, message, io, refusalOf("agent_allowlist", "you may not run coding here"), ending, trace);
    ending.drain(undefined);
    const snap = d.runRegistry.snapshotById("run-cmd");
    expect(snap?.finished).toBe(true);
    expect(d.runRegistry.getById("run-cmd")).toMatchObject({ status: "completed", agent: "door" });
    expect(d.runRegistry.getById("run-cmd")?.label).toMatch(/^agent_allowlist · /);
    expect(contentTypes(snap?.events ?? [])).toEqual(["input", "refusal"]);
    expect(snap?.events.find((e) => e.type === "input")).toMatchObject({ text: "agent:coding fix it" });
    expect(snap?.events.find((e) => e.type === "refusal")).toMatchObject({
      code: "agent_allowlist",
      cause: "policy",
      text: "you may not run coding here",
    });
    expect(started).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(replies).toEqual([]); // the record says nothing: the caller already rendered the sentence
    const records = kept.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "run-cmd",
      agent: "door",
      status: "completed",
      threadKey: "slack:CX:1.0",
    });
    expect(records[0]!.events.find((e) => e.type === "refusal")).toMatchObject({ code: "agent_allowlist" });
  });

  it("the refusal event's sentence is redacted and capped like a receipt", async () => {
    const d = deps();
    const { message, io, ending, trace } = request("x", d);
    const long = `the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 was refused ${"y".repeat(400)}`;
    await recordRefusal(d, message, io, refusalOf("uncaught", long), ending, trace);
    const refusal = d.runRegistry.snapshotById("run-cmd")?.events.find((e) => e.type === "refusal");
    expect(refusal).toMatchObject({ code: "uncaught", cause: "system" });
    const text = (refusal as { text: string }).text;
    expect(text).not.toContain("ghp_abcdefghijklmnop");
    expect(text.length).toBeLessThanOrEqual(ROUTE_RECEIPT_CAP + 1); // the cap plus the ellipsis
    expect(text.endsWith("…")).toBe(true);
  });

  it("a message with no thread of its own records with the channel as its thread key", async () => {
    const d = deps();
    const kept = keepingWriter();
    d.runHistoryWriter = kept.writer;
    const { message, io, ending, trace } = request("hi", d);
    await recordRefusal(d, { ...message, threadKey: "" }, io, refusalOf("uncaught", "boom"), ending, trace);
    ending.drain(undefined);
    expect(d.runRegistry.getById("run-cmd")).toMatchObject({ threadKey: "slack:CX" });
    expect(kept.records()[0]).toMatchObject({ threadKey: "slack:CX" });
  });
});
