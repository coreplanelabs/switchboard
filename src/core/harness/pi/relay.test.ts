import { describe, expect, it } from "vitest";
import type { Executor } from "../../../execution/executor.js";
import type { RunnableTool } from "../../../tools/workspace.js";
import type { RunEvent } from "../../runEvents.js";
import { recordingSink } from "../../testing/recordingSink.js";
import { createTracer } from "../../trace/tracer.js";
import {
  HarnessRegistry,
  authorizeToolCall,
  piContentOf,
  relayedToolDefinitions,
  runRelayedTool,
  type LiveHarness,
} from "./relay.js";

// Feature: docs/reference/specs/harness-pi.md item 7 — the bot's side of the
// extension: the tool definitions served as they are declared, the gate that
// judges pi's own tools by the coding preset's rules and refuses everything
// during the write-up (a `tool_refused` note each time), and a relayed tool
// run in the bot with the run's own context under the call's span.

const echo: RunnableTool = {
  name: "update_status",
  description: "the card",
  inputSchema: { type: "object", properties: { checklist: { type: "string" } } },
  async run(input, ctx) {
    ctx.reportProgress?.(String(input.checklist));
    ctx.publish?.({ type: "run_note", kind: "wrap_up", summary: "from the tool" });
    return `status updated: ${String(input.checklist)}`;
  },
};
const throwing: RunnableTool = {
  name: "submit_pr_description",
  description: "the PR",
  inputSchema: { type: "object", properties: {} },
  async run() {
    throw new Error("the description is missing its title");
  },
};
const seeing: RunnableTool = {
  name: "github_file",
  description: "a file",
  inputSchema: { type: "object", properties: {} },
  async run() {
    return [
      { type: "text", text: "a picture" },
      { type: "image", mediaType: "image/png", data: "AAA=" },
      { type: "document", mediaType: "application/pdf", data: "BBB=", name: "spec.pdf" },
    ];
  },
};
const executor: Executor = {
  exec: async (c) => `ran ${c}`,
  readFile: async () => "",
  writeFile: async () => "",
};

function live(opts: { blocked?: string; withSpan?: boolean } = {}) {
  const events: RunEvent[] = [];
  const progress: string[] = [];
  const sink = recordingSink();
  const agentSpan = opts.withSpan
    ? createTracer({ clock: () => 1 })
        .start("request", { sinks: [sink] })
        .start("run.agent")
    : undefined;
  const openSpan = agentSpan?.start("tool.update_status");
  const harness: LiveHarness = {
    runId: "run-7",
    tools: [echo, throwing, seeing],
    toolContext: { executor, reportProgress: (c) => void progress.push(c) },
    backend: "resident",
    rules: { checkout: "/work/repo", branch: "feat/x" },
    emit: (e) => void events.push(e),
    toolSpan: (callId) => (callId === "c1" ? openSpan : undefined),
    toolsBlocked: () => opts.blocked,
  };
  return { harness, events, progress, sink, openSpan };
}

describe("HarnessRegistry", () => {
  it("knows a run while it is registered and forgets exactly that registration", () => {
    const r = new HarnessRegistry();
    const { harness } = live();
    const forget = r.register(harness);
    expect(r.get("run-7")).toBe(harness);
    expect(r.size()).toBe(1);
    forget();
    expect(r.get("run-7")).toBeUndefined();
    forget();
    expect(r.size()).toBe(0);
  });
});

describe("relayedToolDefinitions", () => {
  it("serves name, description and schema as the native table declares them — and nothing runnable", () => {
    const { harness } = live();
    expect(relayedToolDefinitions(harness)).toEqual([
      { name: "update_status", description: "the card", inputSchema: echo.inputSchema },
      { name: "submit_pr_description", description: "the PR", inputSchema: throwing.inputSchema },
      { name: "github_file", description: "a file", inputSchema: seeing.inputSchema },
    ]);
  });
});

describe("authorizeToolCall — the gate", () => {
  it("allows a relayed tool and an ordinary pi command; refuses a push off the run's branch with the rule as the reason and a tool_refused note", () => {
    const { harness, events } = live();
    expect(authorizeToolCall(harness, { toolCallId: "a", tool: "update_status", input: {} })).toEqual({ allow: true });
    expect(authorizeToolCall(harness, { toolCallId: "b", tool: "bash", input: { command: "npm test" } })).toEqual({
      allow: true,
    });
    expect(
      authorizeToolCall(harness, { toolCallId: "c", tool: "bash", input: { command: "git push origin main" } }),
    ).toEqual({
      allow: false,
      reason: "repo:use — push to `main`, not the run's branch feat/x",
    });
    expect(authorizeToolCall(harness, { toolCallId: "d", tool: "submit_verdict", input: {} })).toEqual({
      allow: false,
      reason: "submit_verdict is the `verdict` bundle; the coding preset's reach does not include it",
    });
    expect(events).toEqual([
      {
        type: "run_note",
        kind: "tool_refused",
        summary: "bash refused: repo:use — push to `main`, not the run's branch feat/x",
      },
      {
        type: "run_note",
        kind: "tool_refused",
        summary:
          "submit_verdict refused: submit_verdict is the `verdict` bundle; the coding preset's reach does not include it",
      },
    ]);
  });

  it("during the write-up every tool is refused with the write-up's reason, relayed ones included", () => {
    const { harness, events } = live({ blocked: "the run is past its budget — write up, no more tool calls" });
    expect(authorizeToolCall(harness, { toolCallId: "a", tool: "update_status", input: {} })).toEqual({
      allow: false,
      reason: "the run is past its budget — write up, no more tool calls",
    });
    expect(authorizeToolCall(harness, { toolCallId: "b", tool: "read", input: { path: "x" } }).allow).toBe(false);
    expect(events).toHaveLength(2);
  });
});

describe("runRelayedTool — a native tool run in the bot for pi", () => {
  it("runs the tool with the run's context under the call's span — a tracing executor, the span on what it publishes — and answers pi's content", async () => {
    const { harness, events, progress, sink, openSpan } = live({ withSpan: true });
    const answer = await runRelayedTool(harness, {
      toolCallId: "c1",
      tool: "update_status",
      input: { checklist: "○ plan" },
    });
    expect(answer).toEqual({ content: [{ type: "text", text: "status updated: ○ plan" }], isError: false });
    expect(progress).toEqual(["○ plan"]);
    expect(events).toEqual([{ type: "run_note", kind: "wrap_up", summary: "from the tool", spanId: openSpan!.id }]);
    void sink;
  });

  it("without an open span the tool still runs with the run's context and publishes unstamped", async () => {
    const { harness, events } = live();
    await runRelayedTool(harness, { toolCallId: "other", tool: "update_status", input: { checklist: "x" } });
    expect(events[0]).toEqual({ type: "run_note", kind: "wrap_up", summary: "from the tool" });
  });

  it("a throwing tool is an error answer the model reads, an unknown tool is named, a non-object input is an empty one", async () => {
    const { harness } = live();
    expect(await runRelayedTool(harness, { toolCallId: "c2", tool: "submit_pr_description", input: {} })).toEqual({
      content: [{ type: "text", text: "Error: the description is missing its title" }],
      isError: true,
    });
    expect(await runRelayedTool(harness, { toolCallId: "c3", tool: "nope", input: {} })).toEqual({
      content: [{ type: "text", text: "Unknown tool: nope" }],
      isError: true,
    });
    expect((await runRelayedTool(harness, { toolCallId: "c4", tool: "update_status", input: "junk" })).content).toEqual(
      [{ type: "text", text: "status updated: undefined" }],
    );
  });

  it("images ride to pi as image blocks, a document as its descriptor", async () => {
    const { harness } = live();
    expect(await runRelayedTool(harness, { toolCallId: "c5", tool: "github_file", input: {} })).toEqual({
      content: [
        { type: "text", text: "a picture" },
        { type: "image", data: "AAA=", mimeType: "image/png" },
        { type: "text", text: "[document spec.pdf (application/pdf)]" },
      ],
      isError: false,
    });
    expect(piContentOf("plain")).toEqual([{ type: "text", text: "plain" }]);
  });
});
