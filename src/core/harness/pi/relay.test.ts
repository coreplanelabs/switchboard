import { afterEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../../../execution/executor.js";
import type { ChatMessage } from "../../chatMessage.js";
import { awaitRunsTool, sendToRunTool, spawnRunTool } from "../../../tools/runs.js";
import { TOOLSETS } from "../../../tools/toolsets.js";
import { submitVerdictTool } from "../../../tools/submit.js";
import type { RunnableTool } from "../../../tools/runnableTool.js";
import { ALL_GRANTS } from "../../authz/grants.js";
import type { Actor } from "../../authz/types.js";
import { sleepUnlessAborted, type WaitCapability } from "../../dispatch/awaitChildren.js";
import { webCapability } from "../../dispatch/run.js";
import { spawnCapabilityFor, type SpawnDeps } from "../../dispatch/spawn.js";
import { buildReviewPostBody, type ReviewVerdict } from "../../reviewVerdict.js";
import { checkReviewedHead } from "../../reviewedHead.js";
import type { RunEvent } from "../../runEvents.js";
import type { RunsService, RunView } from "../../runsService.js";
import { recordingSink } from "../../testing/recordingSink.js";
import { createTracer } from "../../trace/tracer.js";
import type { ChannelIO, IncomingMessage } from "../../types.js";
import {
  HarnessRegistry,
  RELAY_POLL_WINDOW_MS,
  RelayedCalls,
  authorizeToolCall,
  piContentOf,
  relayToolCall,
  relayedToolDefinitions,
  runRelayedTool,
  stillRunningNote,
  type LiveHarness,
  type RelayedToolAnswer,
} from "./relay.js";

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

  // harness.md item 6: the harness leaves a replaced run's registration
  // standing for the loop's relaunch; a loop that does not relaunch ends it here.
  it("forget(runId) ends whichever registration holds the run and its calls — the loop's word for a relaunch refused — and is a no-op for a run not registered", () => {
    const r = new HarnessRegistry();
    const { harness } = live();
    const forget = r.register(harness);
    const calls = r.calls("run-7")!;
    r.forget("run-7");
    expect(r.get("run-7")).toBeUndefined();
    expect(r.calls("run-7")).toBeUndefined();
    expect(calls.signal.aborted).toBe(true);
    forget(); // the earlier closure finds nothing of its own to forget
    r.forget("run-7");
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
    harness.tools = TOOLSETS.readonly;
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
  // live-view.md item 26: a relayed tool sees the call it runs under, the same id
  // the call's tool_call/tool_result events carry — attach_file records its file under it.
  it("a relayed tool's context carries the call's id, with or without a span", async () => {
    const seen: (string | undefined)[] = [];
    const probe: RunnableTool = {
      name: "probe",
      description: "records its call id",
      inputSchema: { type: "object", properties: {} },
      async run(_input, ctx) {
        seen.push(ctx.callId);
        return "seen";
      },
    };
    const { harness } = live();
    harness.tools = [probe];
    await runRelayedTool(harness, { toolCallId: "c9", tool: "probe", input: {} });
    const spanned = live({ withSpan: true });
    spanned.harness.tools = [probe];
    await runRelayedTool(spanned.harness, { toolCallId: "c10", tool: "probe", input: {} });
    expect(seen).toEqual(["c9", "c10"]);
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

const admin: Actor = { kind: "user", id: "slack:UADMIN", grants: ALL_GRANTS };
const textOf = (answer: RelayedToolAnswer) => answer.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const answerOf = (text: string) => ({ done: true, answer: { content: [{ type: "text", text }], isError: false } });

// Feature: docs/reference/specs/harness-pi.md item 12, the research preset on
// pi: its `web` toolset is what pi is served and nothing else; each relayed
// tool is the native one run in the bot with the run's own context, under the
// bot's own gates; every one of pi's own tools, and any tool outside the
// toolset, is refused at the gate with a `tool_refused` note.
describe("the research preset on pi: the web toolset relayed, run in the bot as the requesting user", () => {
  const research = () => {
    const w = live({ identity: "none" });
    w.harness.tools = TOOLSETS.web;
    w.harness.toolContext = { executor, web: webCapability() };
    return w;
  };

  it("serves exactly the web toolset's definitions (web_fetch, web_search, update_status and the GitHub reads) and none of pi's own tools", () => {
    const { harness } = research();
    expect(relayedToolDefinitions(harness).map((d) => d.name)).toEqual([
      "web_fetch",
      "web_search",
      "update_status",
      "github_repos",
      "github_file",
      "github_tree",
      "github_search_code",
      "github_issue_list",
      "github_issue_get",
      "github_actions_run",
      "github_actions_job_log",
    ]);
  });

  it("the gate allows web_fetch and web_search by name and refuses bash, edit and a tool outside the toolset (spawn_run) with a tool_refused note each", () => {
    const { harness, events } = research();
    const ask = (tool: string, input: unknown) => authorizeToolCall(harness, { toolCallId: `a-${tool}`, tool, input });
    expect(ask("web_fetch", { url: "https://example.com" })).toEqual({ allow: true });
    expect(ask("web_search", { query: "durable objects" })).toEqual({ allow: true });
    expect(ask("bash", { command: "curl https://example.com" })).toEqual({
      allow: false,
      reason: "bash is the `shell` bundle: a run without a workspace (identity none) has none of pi's own tools",
    });
    expect(ask("edit", { path: "notes.md" })).toEqual({
      allow: false,
      reason: "edit is the `write-files` bundle: a run without a workspace (identity none) has none of pi's own tools",
    });
    expect(ask("spawn_run", { preset: "research", prompt: "q" })).toEqual({
      allow: false,
      reason: "spawn_run is not in any bundle the none identity reaches",
    });
    expect(events.map((e) => (e as { kind?: string }).kind)).toEqual(["tool_refused", "tool_refused", "tool_refused"]);
  });

  it("a relayed web_fetch is the native tool run in the bot under its own URL guard: an internal address is refused without a fetch and the refusal is the content pi reads; a tool outside the toolset asked of the relay is named unknown", async () => {
    const { harness } = research();
    const answer = await runRelayedTool(harness, {
      toolCallId: "c9",
      tool: "web_fetch",
      input: { url: "http://127.0.0.1:8080/secret" },
    });
    expect(answer.isError).toBe(false);
    expect(answer.content).toEqual([{ type: "text", text: expect.stringMatching(/^web_fetch refused: /) }]);
    expect(await runRelayedTool(harness, { toolCallId: "c10", tool: "spawn_run", input: {} })).toEqual({
      content: [{ type: "text", text: "Unknown tool: spawn_run" }],
      isError: true,
    });
  });
});

// Feature: docs/reference/specs/harness-pi.md item 7, a relayed call that
// outlives one request. The bot answers within a window or says the call is
// still running; the same call id joins the one run and never starts it
// twice; the answer waits for the ask that reads it; a run's end stops what
// still runs.
describe("relayToolCall: a relayed call that outlives one request", () => {
  afterEach(() => vi.useRealTimers());

  /** A tool that answers when the test releases it, counting its runs. */
  function gated(name: string) {
    let release!: (text: string) => void;
    const answered = new Promise<string>((r) => (release = r));
    let runs = 0;
    const tool: RunnableTool = {
      name,
      description: "waits",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        runs++;
        return answered;
      },
    };
    return { tool, release, runs: () => runs };
  }

  it("a tool that answers within the window answers in one request, as before", async () => {
    const { harness } = live();
    const calls = new RelayedCalls();
    const ask = { toolCallId: "c1", tool: "update_status", input: { checklist: "x" } };
    expect(await relayToolCall(harness, calls, ask, { windowMs: 1_000 })).toEqual(answerOf("status updated: x"));
    expect(calls.size).toBe(1);
  });

  it("a tool still running after the window is pending; every later ask with the same call id joins the one run and never starts it twice; the ask after it answers reads the answer, and so does a retry after that", async () => {
    vi.useFakeTimers();
    const g = gated("slow");
    const { harness } = live();
    harness.tools = [g.tool];
    const calls = new RelayedCalls();
    const ask = { toolCallId: "c5", tool: "slow", input: {} };
    const first = relayToolCall(harness, calls, ask);
    const second = relayToolCall(harness, calls, ask);
    await vi.advanceTimersByTimeAsync(RELAY_POLL_WINDOW_MS);
    expect(await first).toEqual({ done: false });
    expect(await second).toEqual({ done: false });
    expect(g.runs()).toBe(1);
    const third = relayToolCall(harness, calls, ask);
    g.release("done at last");
    expect(await third).toEqual(answerOf("done at last"));
    expect(await relayToolCall(harness, calls, ask)).toEqual(answerOf("done at last"));
    expect(g.runs()).toBe(1);
    expect(calls.size).toBe(1);
  });

  it("an await_runs that ends after seven minutes of the run's clock is asked after every thirty-second window and answers once, the tool having run once: the wait outlives any single request", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const endAt = Date.now() + 7 * 60_000 + 1_000;
    const child: RunView = {
      id: "run-child",
      agent: "research",
      parentRunId: "run-7",
      threadKey: "slack:CX:9.0",
      startedAt: Date.now() - 1_000,
      eventCount: 0,
      finished: false,
    };
    const service = {
      async getRun(id: string, opts: { include?: "messages" } = {}) {
        if (id !== "run-child") return { ok: false as const, error: "not_found" as const };
        const finished = Date.now() >= endAt;
        return {
          ok: true as const,
          value: {
            ...child,
            finished,
            ...(finished ? { finishedAt: endAt, status: "completed" as const } : {}),
            ...(finished && opts.include === "messages"
              ? { events: [{ type: "answer", text: "A single-instance coordination point." }] }
              : {}),
          },
        };
      },
      async listRuns() {
        return { runs: [] };
      },
    } as unknown as RunsService;
    const wait: WaitCapability = {
      stopRequested: () => undefined,
      followUpsArrived: () => 0,
      watch: () => () => {},
      now: () => Date.now(),
      sleep: sleepUnlessAborted,
    };
    const { harness } = live({ identity: "none" });
    harness.tools = [awaitRunsTool];
    harness.toolContext = {
      executor,
      runs: { service, actor: admin, runId: "run-7" },
      wait,
      remainingMs: () => 60 * 60_000,
    };
    const calls = new RelayedCalls();
    const ask = { toolCallId: "c-await", tool: "await_runs", input: { ids: ["run-child"] } };
    let pendings = 0;
    let progress: Awaited<ReturnType<typeof relayToolCall>>;
    for (;;) {
      const asked = relayToolCall(harness, calls, ask);
      await vi.advanceTimersByTimeAsync(RELAY_POLL_WINDOW_MS);
      progress = await asked;
      if (progress.done) break;
      if (++pendings > 20) throw new Error("the wait never ended");
    }
    expect(pendings).toBe(14);
    expect(progress.answer.isError).toBe(false);
    const report = JSON.parse(textOf(progress.answer)) as { ended: string; waitedMs: number; runs: unknown[] };
    expect(report).toMatchObject({
      ended: "all_ended",
      runs: [
        {
          id: "run-child",
          status: "completed",
          finalReply: expect.stringContaining("A single-instance coordination point."),
        },
      ],
    });
    expect(report.waitedMs).toBeGreaterThanOrEqual(7 * 60_000);
    // A retry after the answer landed reads it again, with no second wait and no second run.
    expect(await relayToolCall(harness, calls, ask)).toEqual(progress);
    expect(calls.size).toBe(1);
  });

  it("send_to_run through the relay steers the run's live child as the requester, and the steer's answer is the content pi reads", async () => {
    const child: RunView = {
      id: "run-child",
      agent: "research",
      parentRunId: "run-7",
      threadKey: "slack:CX:9.0",
      startedAt: 1,
      eventCount: 0,
      finished: false,
    };
    const service = {
      async getRun(id: string) {
        return id === "run-child" ? { ok: true, value: child } : { ok: false, error: "not_found" };
      },
    } as unknown as RunsService;
    const steer = vi.fn(async () => ({ kind: "steered" as const, where: "here" as const, at: 2 }));
    const { harness } = live({ identity: "none" });
    harness.tools = [sendToRunTool];
    harness.toolContext = { executor, runs: { service, actor: admin, runId: "run-7" }, steer: { steer } };
    const answer = await relayToolCall(harness, new RelayedCalls(), {
      toolCallId: "c-steer",
      tool: "send_to_run",
      input: { id: "run-child", text: "narrow it to Workers" },
    });
    expect(answer).toEqual(
      answerOf(
        "steered: folded into the research run run-child — it reads it at its next step; a child that finishes before then never reads it.",
      ),
    );
    expect(steer).toHaveBeenCalledWith(
      { runId: "run-child", threadKey: "slack:CX:9.0", agent: "research" },
      "narrow it to Workers",
    );
  });

  it("when the run ends, a call still running is told to stop through its context's signal, and the registry's calls go with the registration", async () => {
    const registry = new HarnessRegistry();
    const { harness } = live();
    harness.tools = [
      {
        name: "waiting",
        description: "waits for the end",
        inputSchema: { type: "object", properties: {} },
        run: (_input, ctx) =>
          new Promise((r) => ctx.signal?.addEventListener("abort", () => r("stopped"), { once: true })),
      },
    ];
    const forget = registry.register(harness);
    const calls = registry.calls("run-7")!;
    const asked = relayToolCall(
      harness,
      calls,
      { toolCallId: "c-w", tool: "waiting", input: {} },
      { windowMs: 10_000 },
    );
    forget();
    expect(await asked).toEqual(answerOf("stopped"));
    expect(registry.calls("run-7")).toBeUndefined();
  });
});

// Feature: docs/reference/specs/harness-pi.md items 7 and 8 — a call the run's
// row says was in flight when the previous bot generation died is settled on
// the relay before pi's extension can ask again: the answer is the record's
// restart note, and the tool never runs a second time.
describe("RelayedCalls.settle — a call in flight when the previous generation died", () => {
  const note: RelayedToolAnswer = {
    content: [
      {
        type: "text",
        text: "The bot restarted while this update_status call was in flight; its result was lost — re-check its effects before re-running it.",
      },
    ],
    isError: true,
  };

  it("an ask for a settled call id is answered at once with the record's note and the tool never runs, asked once or again; a call the record does not know runs as before; a call already running keeps its own answer", async () => {
    const { harness, progress } = live();
    const calls = new RelayedCalls();
    calls.settle("c0", note);
    const ask = { toolCallId: "c0", tool: "update_status", input: { checklist: "step 1" } };
    expect(await relayToolCall(harness, calls, ask, { windowMs: 1_000 })).toEqual({ done: true, answer: note });
    expect(await relayToolCall(harness, calls, ask, { windowMs: 1_000 })).toEqual({ done: true, answer: note });
    expect(progress).toEqual([]);
    const fresh = { toolCallId: "c1", tool: "update_status", input: { checklist: "fresh" } };
    expect(await relayToolCall(harness, calls, fresh, { windowMs: 1_000 })).toEqual(answerOf("status updated: fresh"));
    expect(progress).toEqual(["fresh"]);
    let release!: (text: string) => void;
    let runs = 0;
    harness.tools = [
      {
        name: "slow",
        description: "waits",
        inputSchema: { type: "object", properties: {} },
        run: async () => (runs++, new Promise<string>((r) => (release = r))),
      },
    ];
    const running = relayToolCall(harness, calls, { toolCallId: "c2", tool: "slow", input: {} }, { windowMs: 10_000 });
    calls.settle("c2", note);
    release("ran to its end");
    expect(await running).toEqual(answerOf("ran to its end"));
    expect(runs).toBe(1);
    expect(calls.size).toBe(3);
  });
});

// Feature: docs/reference/specs/agent-conductor.md item 3, the conductor's
// spawn_run on pi. The relay hands the tool the run's conversation as the
// harness offers it (the session log's rows), read once the bridge has seen
// the call, so the child seeds from the parent's text turns exactly as a
// native conductor's child does; a write preset is refused by name in the tool
// result; a conversation the log cannot give seeds nothing.
describe("runRelayedTool: the conductor's spawn_run on pi", () => {
  const text = (role: "user" | "assistant", t: string): ChatMessage => ({ role, content: [{ type: "text", text: t }] });
  /** The parent's conversation as its session log holds it at the call: the seed, then the assistant turn that makes the call. */
  const log: ChatMessage[] = [
    text("user", "look into durable objects"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "Storage first: one research child." },
        {
          type: "tool_use",
          id: "t1",
          name: "spawn_run",
          input: { preset: "research", prompt: "what is a Durable Object?" },
        },
      ],
    },
  ];
  const quiet: ChannelIO = {
    reply: async () => {},
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };

  /** A spawning run over the real stage with `dispatch()` stubbed: a dispatched child registers at once. */
  function conducting(conversation: () => Promise<readonly ChatMessage[] | undefined>) {
    const dispatched: Array<{ text: string; opts: unknown }> = [];
    const leads: string[] = [];
    const order: string[] = [];
    const io: ChannelIO = {
      ...quiet,
      openThread: async (lead) => {
        leads.push(lead);
        return { thread: { threadKey: "slack:CX:9.0" }, io: quiet };
      },
    };
    const deps: SpawnDeps = {
      core: {
        config: { config: {}, grantsFor: () => new Set(), canRunAgent: () => true },
        runStore: {},
        runLedger: { pushInbox: async () => ({ ok: true }) },
      } as unknown as SpawnDeps["core"],
      dispatch: async (_core, msg, childIo, opts) => {
        dispatched.push({ text: msg.text, opts });
        childIo.runStarted?.({ id: "run-child" });
        return { status: "completed" };
      },
      registry: { listActive: () => [] },
      clock: () => 1,
    };
    const msg: IncomingMessage = {
      channelId: "slack:CX",
      userId: "slack:UX",
      userName: "alice",
      threadKey: "slack:CX:1.0",
      text: "agent:conductor look into durable objects",
      receivedAt: 1,
    };
    const spawn = spawnCapabilityFor(deps, { runId: "run-7", depth: 0, agentName: "conductor", msg, io });
    const { harness, events } = live({ identity: "none" });
    harness.tools = [spawnRunTool];
    harness.toolContext = {
      executor,
      spawn,
      remainingMs: () => 30 * 60_000,
      conversation: () => {
        order.push("read");
        return conversation();
      },
    };
    harness.callSeen = async (callId) => void order.push(`seen ${callId}`);
    return { harness, events, dispatched, leads, order };
  }

  it("reaches spawnChild with the parent's text turns (the conversation the harness offers, read after the bridge has seen the call), so the child is dispatched with `seed` set to what was said, never the tool call", async () => {
    const w = conducting(async () => log);
    const answer = await runRelayedTool(w.harness, {
      toolCallId: "t1",
      tool: "spawn_run",
      input: { preset: "research", prompt: "what is a Durable Object?" },
    });
    expect(answer.isError).toBe(false);
    expect(textOf(answer)).toContain("spawned a research run: run-child in thread slack:CX:9.0");
    expect(w.order).toEqual(["seen t1", "read"]);
    expect(w.dispatched).toEqual([
      {
        text: "agent:research what is a Durable Object?",
        opts: {
          parent: { runId: "run-7", depth: 1, remainingMs: 30 * 60_000 },
          seed: [
            { role: "user", text: "look into durable objects" },
            { role: "assistant", text: "Storage first: one research child." },
          ],
        },
      },
    ]);
    expect(w.leads).toHaveLength(1);
  });

  it("a `coding` spawn is refused `spawn_identity` by name in the tool result and starts nothing: no thread, no dispatch", async () => {
    const w = conducting(async () => log);
    const answer = await runRelayedTool(w.harness, {
      toolCallId: "t2",
      tool: "spawn_run",
      input: { preset: "coding", prompt: "fix the login test", repo: "acme/api" },
    });
    expect(answer.isError).toBe(false);
    expect(textOf(answer)).toMatch(/^spawn refused \(spawn_identity\): `coding` runs as a `write` identity/);
    expect(w.dispatched).toEqual([]);
    expect(w.leads).toEqual([]);
  });

  it("a conversation the harness cannot give hands the stage none: the child is dispatched without a seed and starts from its own thread", async () => {
    const w = conducting(async () => undefined);
    await runRelayedTool(w.harness, {
      toolCallId: "t3",
      tool: "spawn_run",
      input: { preset: "research", prompt: "q" },
    });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0].opts).toEqual({ parent: { runId: "run-7", depth: 1, remainingMs: 30 * 60_000 } });
  });
});

// Feature: docs/reference/specs/harness-pi.md item 8 — a process relaunched
// under the same run (a replaced container, a rotated bearer) takes the run's
// registration over and keeps its relayed calls: a call in flight keeps
// running in the bot, is awaited up to the relay window with the others, and
// past it is the rebuilt session's still-running note — never lost.
describe("HarnessRegistry.replace and RelayedCalls.awaitInFlight — a relaunched process keeps the run's relayed calls", () => {
  afterEach(() => vi.useRealTimers());

  /** A tool that answers when the test releases it, counting its runs. */
  function gated(name: string) {
    let release!: (text: string) => void;
    const answered = new Promise<string>((r) => (release = r));
    let runs = 0;
    const tool: RunnableTool = {
      name,
      description: "waits",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        runs++;
        return answered;
      },
    };
    return { tool, release, runs: () => runs };
  }

  it("replace hands the run's registration to the relaunched process and keeps its calls: the held call runs once, the earlier registration's forget is a no-op, the answer reaches an ask through the new registration, and the new forget ends the calls", async () => {
    vi.useFakeTimers();
    const g = gated("slow");
    const registry = new HarnessRegistry();
    const first = live();
    first.harness.tools = [g.tool];
    const forgetFirst = registry.register(first.harness);
    const calls = registry.calls("run-7")!;
    const ask = { toolCallId: "c-held", tool: "slow", input: {} };
    const held = relayToolCall(first.harness, calls, ask, { windowMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await held).toEqual({ done: false });
    const next = live();
    next.harness.tools = [g.tool];
    const forgetNext = registry.replace(next.harness);
    expect(registry.get("run-7")).toBe(next.harness);
    expect(registry.calls("run-7")).toBe(calls);
    expect(registry.size()).toBe(1);
    forgetFirst();
    expect(registry.get("run-7")).toBe(next.harness);
    expect(calls.signal.aborted).toBe(false);
    expect(calls.inFlight()).toEqual(["c-held"]);
    g.release("done at last");
    expect(await relayToolCall(next.harness, registry.calls("run-7")!, ask, { windowMs: 1_000 })).toEqual(
      answerOf("done at last"),
    );
    expect(g.runs()).toBe(1);
    expect(calls.inFlight()).toEqual([]);
    forgetNext();
    expect(registry.get("run-7")).toBeUndefined();
    expect(registry.calls("run-7")).toBeUndefined();
    expect(calls.signal.aborted).toBe(true);
  });

  it("replace refuses by name a run that is not registered: nothing to hand over", () => {
    const registry = new HarnessRegistry();
    const { harness } = live();
    expect(() => registry.replace(harness)).toThrow("run run-7 is not registered on the relay: nothing to replace");
    expect(registry.size()).toBe(0);
  });

  it("awaitInFlight awaits every call still running up to one window: one that answers inside it is done with its answer, one still running after it is not done and keeps running — its result kept for an ask by the same id, never lost — and the rebuilt session's words for it are the still-running note; with nothing in flight it answers at once", async () => {
    vi.useFakeTimers();
    const quick = gated("quick");
    const slow = gated("slow");
    const { harness } = live();
    harness.tools = [quick.tool, slow.tool];
    const calls = new RelayedCalls();
    expect(await calls.awaitInFlight({ windowMs: 1_000 })).toEqual([]);
    void relayToolCall(harness, calls, { toolCallId: "c-q", tool: "quick", input: {} }, { windowMs: 1_000 });
    void relayToolCall(harness, calls, { toolCallId: "c-s", tool: "slow", input: {} }, { windowMs: 1_000 });
    expect(calls.inFlight()).toEqual(["c-q", "c-s"]);
    const awaited = calls.awaitInFlight({ windowMs: 1_000 });
    await vi.advanceTimersByTimeAsync(200);
    quick.release("quick done");
    await vi.advanceTimersByTimeAsync(800);
    expect(await awaited).toEqual([
      { callId: "c-q", ...answerOf("quick done") },
      { callId: "c-s", done: false },
    ]);
    expect(calls.inFlight()).toEqual(["c-s"]);
    expect(slow.runs()).toBe(1);
    expect(calls.signal.aborted).toBe(false);
    expect(stillRunningNote("slow")).toBe(
      "This slow call is still running in the bot: the process that made it was relaunched while the call was in flight, and the call keeps running there rather than being re-run — do not run it again; its result is kept on the relay under the same call id.",
    );
    slow.release("slow done");
    expect(
      await relayToolCall(harness, calls, { toolCallId: "c-s", tool: "slow", input: {} }, { windowMs: 1_000 }),
    ).toEqual(answerOf("slow done"));
    expect(slow.runs()).toBe(1);
    // A settled call was never running: the record's answer is not awaited.
    calls.settle("c-settled", { content: [{ type: "text", text: "from the record" }], isError: false });
    expect(calls.inFlight()).toEqual([]);
  });

  it("answered(callId) hands a relaunch the answer of a call that landed before the dead process could read it — a rejected start as the error answer — and nothing for a call still running or never asked", async () => {
    const quick = gated("quick");
    const slow = gated("slow");
    const { harness } = live();
    harness.tools = [quick.tool, slow.tool];
    const calls = new RelayedCalls();
    void relayToolCall(harness, calls, { toolCallId: "c-q", tool: "quick", input: {} }, { windowMs: 1 });
    void relayToolCall(harness, calls, { toolCallId: "c-s", tool: "slow", input: {} }, { windowMs: 1 });
    void relayToolCall(harness, calls, { toolCallId: "c-x", tool: "not-served", input: {} }, { windowMs: 1 });
    quick.release("quick done");
    await new Promise((r) => setImmediate(r));
    expect(calls.inFlight()).toEqual(["c-s"]);
    expect(await calls.answered("c-q")).toEqual({ content: [{ type: "text", text: "quick done" }], isError: false });
    expect(await calls.answered("c-s")).toBeUndefined();
    expect(await calls.answered("c-never")).toBeUndefined();
    expect(await calls.answered("c-x")).toMatchObject({ isError: true });
    // A settlement is the record's answer, not the bot's: never read as one.
    calls.settle("c-settled", { content: [{ type: "text", text: "from the record" }], isError: true });
    expect(await calls.answered("c-settled")).toBeUndefined();
    slow.release("slow done");
    calls.end();
  });

  it("a call whose start rejects is done with an error answer carrying the message, and the others' answers are still read: one straggler's exception never fails the wait", async () => {
    vi.useFakeTimers();
    const quick = gated("quick");
    const { harness } = live();
    harness.tools = [quick.tool];
    const calls = new RelayedCalls();
    void relayToolCall(harness, calls, { toolCallId: "c-q", tool: "quick", input: {} }, { windowMs: 1_000 });
    calls.join("c-throws", () => Promise.reject(new Error("the tool's promise blew up"))).catch(() => {});
    expect(calls.inFlight()).toEqual(["c-q", "c-throws"]);
    const awaited = calls.awaitInFlight({ windowMs: 1_000 });
    quick.release("quick done");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await awaited).toEqual([
      { callId: "c-q", ...answerOf("quick done") },
      {
        callId: "c-throws",
        done: true,
        answer: { content: [{ type: "text", text: "Error: the tool's promise blew up" }], isError: true },
      },
    ]);
    expect(calls.inFlight()).toEqual([]);
  });
});
