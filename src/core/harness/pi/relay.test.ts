import { describe, expect, it } from "vitest";
import type { Executor } from "../../../execution/executor.js";
import { TOOLSETS, submitVerdictTool, type RunnableTool } from "../../../tools/workspace.js";
import { buildReviewPostBody, type ReviewVerdict } from "../../reviewVerdict.js";
import { checkReviewedHead } from "../../reviewedHead.js";
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
import { relayedTools } from "./harness.js";

// Feature: docs/reference/specs/harness-pi.md item 7 — the bot's side of the
// extension: the tool definitions served as they are declared, the gate that
// judges pi's own tools by the rules for the run's identity and refuses everything
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

function live(opts: { blocked?: string; withSpan?: boolean; identity?: "none" | "read" | "write" } = {}) {
  const events: RunEvent[] = [];
  const progress: string[] = [];
  const sink = recordingSink();
  const agentSpan = opts.withSpan
    ? createTracer({ clock: () => 1 })
        .start("request", { sinks: [sink] })
        .start("run.agent")
    : undefined;
  const openSpan = agentSpan?.start("tool.update_status");
  const seen: string[] = [];
  const harness: LiveHarness = {
    runId: "run-7",
    tools: [echo, throwing, seeing],
    toolContext: { executor, reportProgress: (c) => void progress.push(c) },
    backend: "resident",
    rules: { identity: opts.identity ?? "write", checkout: "/work/repo", branch: "feat/x" },
    emit: (e) => void events.push(e),
    toolSpan: (callId) => (callId === "c1" ? openSpan : undefined),
    gateSaw: (callId) => void seen.push(callId),
    toolsBlocked: () => opts.blocked,
  };
  return { harness, events, progress, sink, openSpan, seen };
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
  it("a review run's pi is served the readonly toolset's submit_verdict as the native tool declares it — the description that says to run `git rev-parse HEAD`, and a schema requiring `head` beside the verdict and the summary (harness-pi item 11)", () => {
    const { harness } = live({ identity: "read" });
    harness.tools = relayedTools(TOOLSETS.readonly);
    const served = relayedToolDefinitions(harness).find((d) => d.name === "submit_verdict")!;
    expect(served).toEqual({
      name: "submit_verdict",
      description: submitVerdictTool.description,
      inputSchema: submitVerdictTool.inputSchema,
    });
    expect(served.description).toContain("run `git rev-parse HEAD` in the checkout you read");
    const schema = served.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(["verdict", "summary", "head"]);
    expect(schema.properties.head).toEqual({
      type: "string",
      description: "Output of `git rev-parse HEAD` in the checkout you reviewed (the commit the review is about)",
    });
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
      reason: "submit_verdict is the `verdict` bundle, outside the write identity's reach",
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
        summary: "submit_verdict refused: submit_verdict is the `verdict` bundle, outside the write identity's reach",
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

  it("tells the harness the gate saw the call — allowed, refused or blocked by the write-up alike — so a call that ends unseen is known to have bypassed it", () => {
    const open = live();
    authorizeToolCall(open.harness, { toolCallId: "a", tool: "update_status", input: {} });
    authorizeToolCall(open.harness, { toolCallId: "b", tool: "bash", input: { command: "git push origin main" } });
    authorizeToolCall(open.harness, { toolCallId: "c", tool: "submit_verdict", input: {} });
    expect(open.seen).toEqual(["a", "b", "c"]);
    const blocked = live({ blocked: "write up" });
    authorizeToolCall(blocked.harness, { toolCallId: "d", tool: "read", input: { path: "x" } });
    expect(blocked.seen).toEqual(["d"]);
  });
});

// docs/reference/specs/harness-pi.md item 10 — the review preset on the
// harness: the gate under a read identity, and the verdict path — a relayed
// `submit_verdict` is the native tool's own call, so what reaches the run's
// `onVerdict` and the post-step is what the native loop's call yields.
describe("authorizeToolCall — a read-identity run", () => {
  const verdictTool: RunnableTool = {
    name: "submit_verdict",
    description: "the verdict",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return "verdict recorded: approve";
    },
  };
  it("refuses pi's edit and write as outside the reach and a push as read-only, each a tool_refused note; allows read, an ordinary command and the relayed verdict", () => {
    const { harness, events } = live({ identity: "read" });
    harness.tools = [verdictTool];
    expect(authorizeToolCall(harness, { toolCallId: "a", tool: "read", input: { path: "src/x.ts" } })).toEqual({
      allow: true,
    });
    expect(
      authorizeToolCall(harness, { toolCallId: "b", tool: "bash", input: { command: "git diff origin/main...HEAD" } }),
    ).toEqual({ allow: true });
    expect(authorizeToolCall(harness, { toolCallId: "c", tool: "submit_verdict", input: {} })).toEqual({ allow: true });
    expect(authorizeToolCall(harness, { toolCallId: "d", tool: "edit", input: { path: "src/x.ts" } })).toEqual({
      allow: false,
      reason: "edit is the `write-files` bundle, outside the read identity's reach",
    });
    expect(authorizeToolCall(harness, { toolCallId: "e", tool: "write", input: { path: "src/x.ts" } })).toEqual({
      allow: false,
      reason: "write is the `write-files` bundle, outside the read identity's reach",
    });
    expect(
      authorizeToolCall(harness, { toolCallId: "f", tool: "bash", input: { command: "git push origin feat/x" } }),
    ).toEqual({ allow: false, reason: "read-only — a read-identity run never pushes" });
    expect(events.map((e) => (e.type === "run_note" ? e.summary : e.type))).toEqual([
      "edit refused: edit is the `write-files` bundle, outside the read identity's reach",
      "write refused: write is the `write-files` bundle, outside the read identity's reach",
      "bash refused: read-only — a read-identity run never pushes",
    ]);
  });
});

// docs/reference/specs/harness-pi.md item 12: the gate for a run without a
// workspace. pi's own tools are never on such a run's allowlist, so pi never
// has one to call; a call that reaches the gate all the same (a stale
// allowlist, a pi that grew a tool) is refused by name with a `tool_refused`
// note, and the run's relayed tools are allowed as on every run.
describe("authorizeToolCall: a run without a workspace (identity none)", () => {
  it("refuses every one of pi's own tools by name, each a tool_refused note, and allows the relayed tools", () => {
    const { harness, events } = live({ identity: "none" });
    expect(authorizeToolCall(harness, { toolCallId: "a", tool: "update_status", input: { checklist: "x" } })).toEqual({
      allow: true,
    });
    expect(authorizeToolCall(harness, { toolCallId: "b", tool: "github_file", input: {} })).toEqual({ allow: true });
    expect(authorizeToolCall(harness, { toolCallId: "c", tool: "bash", input: { command: "ls" } })).toEqual({
      allow: false,
      reason: "bash is the `shell` bundle: a run without a workspace (identity none) has none of pi's own tools",
    });
    expect(authorizeToolCall(harness, { toolCallId: "d", tool: "read", input: { path: "README.md" } })).toEqual({
      allow: false,
      reason: "read is the `files` bundle: a run without a workspace (identity none) has none of pi's own tools",
    });
    expect(authorizeToolCall(harness, { toolCallId: "e", tool: "write", input: { path: "x", content: "" } })).toEqual({
      allow: false,
      reason: "write is the `write-files` bundle: a run without a workspace (identity none) has none of pi's own tools",
    });
    expect(events.map((e) => (e.type === "run_note" ? e.summary : e.type))).toEqual([
      "bash refused: bash is the `shell` bundle: a run without a workspace (identity none) has none of pi's own tools",
      "read refused: read is the `files` bundle: a run without a workspace (identity none) has none of pi's own tools",
      "write refused: write is the `write-files` bundle: a run without a workspace (identity none) has none of pi's own tools",
    ]);
  });
});

describe("runRelayedTool — the verdict path", () => {
  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const input = {
    verdict: "approve",
    summary: "looks correct",
    head: HEAD,
    findings: [{ id: "F1", severity: "nit", file: "src/x.ts", line: 3, title: "a name" }],
  };
  it("a relayed submit_verdict is the native tool's own call: the run's onVerdict receives the verdict the native loop's call yields, the model reads the same acknowledgement, and the post-step's body is the same — `LGTM:` first, the findings under it", async () => {
    const submitVerdict = TOOLSETS.readonly.find((t) => t.name === "submit_verdict")!;
    const relayed: ReviewVerdict[] = [];
    const native: ReviewVerdict[] = [];
    const { harness } = live({ identity: "read" });
    harness.tools = [submitVerdict];
    harness.toolContext = { executor, onVerdict: (v) => void relayed.push(v) };
    const answer = await runRelayedTool(harness, { toolCallId: "c3", tool: "submit_verdict", input });
    // The native loop's call is `tool.run(input, ctx)` (src/runner.ts).
    const nativeText = await submitVerdict.run(input, { executor, onVerdict: (v) => void native.push(v) });
    expect(native).toHaveLength(1);
    expect(relayed).toEqual(native);
    expect(nativeText).toBe("verdict recorded: approve (1 finding)");
    expect(answer).toEqual({ content: [{ type: "text", text: nativeText }], isError: false });
    const body = buildReviewPostBody("The review.", relayed[0]);
    expect(body).toBe(buildReviewPostBody("The review.", native[0]));
    expect(body).toBe("LGTM: looks correct\n- [nit] F1 src/x.ts:3 — a name\n\nThe review.");
  });
  it("a relayed verdict the parser rejects is the same error the native call answers, and no verdict reaches the run", async () => {
    const submitVerdict = TOOLSETS.readonly.find((t) => t.name === "submit_verdict")!;
    const relayed: ReviewVerdict[] = [];
    const { harness } = live({ identity: "read" });
    harness.tools = [submitVerdict];
    harness.toolContext = { executor, onVerdict: (v) => void relayed.push(v) };
    const bad = { verdict: "ship it", summary: "x", head: HEAD };
    const answer = await runRelayedTool(harness, { toolCallId: "c4", tool: "submit_verdict", input: bad });
    const nativeText = await submitVerdict.run(bad, { executor });
    expect(answer).toEqual({ content: [{ type: "text", text: nativeText }], isError: false });
    expect(nativeText).toMatch(/^error: verdict must be exactly/);
    expect(relayed).toEqual([]);
  });
  it("a relayed verdict naming no head is neither refused nor stamped: the run's onVerdict receives what the native call yields — no head — and the reviewed-head guard then fails closed on it unless the worktree's own HEAD was observed", async () => {
    const submitVerdict = TOOLSETS.readonly.find((t) => t.name === "submit_verdict")!;
    const relayed: ReviewVerdict[] = [];
    const native: ReviewVerdict[] = [];
    const { harness } = live({ identity: "read" });
    harness.tools = [submitVerdict];
    harness.toolContext = { executor, onVerdict: (v) => void relayed.push(v) };
    const headless = { verdict: "approve", summary: "looks correct" };
    const answer = await runRelayedTool(harness, { toolCallId: "c5", tool: "submit_verdict", input: headless });
    const nativeText = await submitVerdict.run(headless, { executor, onVerdict: (v) => void native.push(v) });
    expect(answer).toEqual({ content: [{ type: "text", text: nativeText }], isError: false });
    expect(nativeText).toBe("verdict recorded: approve");
    expect(relayed).toEqual(native);
    expect(relayed).toEqual([{ verdict: "approve", summary: "looks correct" }]);
    expect(relayed[0].head).toBeUndefined();
    // The guard's two sources: the model's head is the fallback for a
    // workspace whose HEAD could not be read — a head the relay wrote from the
    // run's expectation would pass exactly the check that exists to catch a
    // review of another commit — and the observed HEAD rescues nothing but
    // the case where the model said nothing.
    expect(checkReviewedHead({ expected: HEAD, reported: relayed[0].head })).toEqual({
      ok: false,
      reason: "reviewed head unknown — the workspace HEAD could not be read and no head was reported with the verdict",
    });
    expect(checkReviewedHead({ expected: HEAD, observed: HEAD, reported: relayed[0].head })).toEqual({
      ok: true,
      head: HEAD,
      source: "observed",
    });
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
