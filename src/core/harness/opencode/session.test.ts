import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../chatMessage.js";
import {
  openCodeImportBody,
  openCodeSeedAndRequest,
  openCodeSessionId,
  openCodeSessionToolName,
  openCodeStoreMessages,
} from "./session.js";

// Feature: docs/reference/specs/harness.md item 5 — seed and rebuild are an
// import. The runner's `ChatMessage[]` (plus compactions and settlements)
// becomes the `POST /api/session/import` body: one store message per seed turn,
// each compaction a compaction message, a settled in-flight call a completed
// tool content carrying its note. The shapes are what `@opencode/cli@2.0.3`
// accepted in the spike.

const AT = 1_700_000_000_000;
const LOC = { directory: "/tmp/switchboard-oc-run-c" };
const opts = { sessionID: "ses_run-c", location: LOC, agent: "switchboard", at: AT };

describe("openCodeSessionToolName", () => {
  it("maps the record's words to the session's own names (bash→shell, find→glob), keeps every other name, and keeps a relayed tool's name even when it is a record word", () => {
    expect(openCodeSessionToolName("bash")).toBe("shell");
    expect(openCodeSessionToolName("find")).toBe("glob");
    expect(openCodeSessionToolName("read")).toBe("read");
    expect(openCodeSessionToolName("github_file")).toBe("github_file");
    expect(openCodeSessionToolName("bash", new Set(["bash"]))).toBe("bash");
  });
});

describe("openCodeSessionId", () => {
  it("prefixes the run id with `ses_` and folds any character the id allows but the session id does not", () => {
    expect(openCodeSessionId("run-c")).toBe("ses_run-c");
    expect(openCodeSessionId("run.c:1")).toBe("ses_run-c-1");
  });
});

describe("openCodeStoreMessages — the seed as store messages", () => {
  const seed: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "earlier question" }] },
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
  ];

  it("writes exactly one store message per seed turn, a user turn as `user` and an assistant turn as `assistant` (the count the mirror's seedLength skip relies on)", () => {
    const messages = openCodeStoreMessages(seed, opts);
    expect(messages).toHaveLength(seed.length);
    expect(messages.map((m) => m.type)).toEqual(["user", "assistant"]);
    expect(messages[0]).toMatchObject({ type: "user", text: "earlier question" });
    expect(messages[1]).toMatchObject({ type: "assistant", agent: "switchboard" });
    expect((messages[1].content as unknown[])[0]).toEqual({ type: "text", text: "earlier answer" });
    // Every assistant message carries time.completed, or import drops it.
    expect((messages[1].time as Record<string, unknown>).completed).toBeTypeOf("number");
  });

  it("an assistant turn's tool call becomes a completed tool content carrying the following user turn's result under the session's own tool name (the record's `bash` written as OpenCode's `shell`), and that user turn writes no message of its own", () => {
    const transcript: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "echo hi" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const messages = openCodeStoreMessages(transcript, opts);
    // Four turns → three store messages (the tool-result user turn is folded in).
    expect(messages.map((m) => m.type)).toEqual(["user", "assistant", "assistant"]);
    const toolContent = (messages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolContent.type).toBe("tool");
    expect(toolContent.id).toBe("call_1");
    // The record's word back in the session's own name: a rebuilt model reads a
    // history whose tools its own table holds, so its first call runs.
    expect(toolContent.name).toBe("shell");
    const state = toolContent.state as Record<string, unknown>;
    expect(state.status).toBe("completed");
    expect((state.content as Array<Record<string, unknown>>)[0]).toEqual({ type: "text", text: "hi" });
  });

  it("a relayed tool keeps its own name in the import, and a name that is neither a record word nor relayed passes through", () => {
    const transcript: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t_find", name: "find", input: { pattern: "*" } },
          { type: "tool_use", id: "t_relay", name: "github_file", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t_find", content: "ok" },
          { type: "tool_result", toolUseId: "t_relay", content: "ok" },
        ],
      },
    ];
    const messages = openCodeStoreMessages(transcript, { ...opts, relayedTools: new Set(["github_file"]) });
    const names = (messages[0].content as Array<Record<string, unknown>>).map((c) => c.name);
    expect(names).toEqual(["glob", "github_file"]);
  });

  it("a call in flight at a death (no following result) carries the settlement note in its tool content", () => {
    const transcript: ChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_hung", name: "await_runs", input: {} }] },
    ];
    const settlements = new Map([
      ["call_hung", "the bot restarted while this call was in flight; re-check its effects"],
    ]);
    const messages = openCodeStoreMessages(transcript, { ...opts, settlements });
    const state = (messages[0].content as Array<Record<string, unknown>>)[0].state as Record<string, unknown>;
    expect((state.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "text",
      text: "the bot restarted while this call was in flight; re-check its effects",
    });
    // The error state the schema requires (`Session.StructuredError`: `type`
    // and `message`): OpenCode's own type for a tool it interrupts, the note as
    // the message (what the store's projection falls back to).
    expect(state.status).toBe("error");
    expect(state.error).toEqual({
      type: "aborted",
      message: "the bot restarted while this call was in flight; re-check its effects",
    });
  });

  it("an error tool content with no text carries OpenCode's own words as its message, so the state still decodes", () => {
    const transcript: ChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_silent", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_silent", content: "", isError: true }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_hung", name: "bash", input: {} }] },
    ];
    const messages = openCodeStoreMessages(transcript, opts);
    const stateOf = (i: number) =>
      (messages[i].content as Array<Record<string, unknown>>)[0].state as Record<string, unknown>;
    expect(stateOf(0).error).toEqual({ type: "tool.execution", message: "The tool call failed" });
    expect(stateOf(1).error).toEqual({ type: "aborted", message: "Tool execution interrupted" });
  });

  it("a call whose following result the record marked an error becomes an error tool content typed as the tool's own failure, its output as the content", () => {
    const transcript: ChatMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_failed", name: "bash", input: { command: "make" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "call_failed", content: "make: *** [all] Error 2", isError: true }],
      },
    ];
    const messages = openCodeStoreMessages(transcript, opts);
    expect(messages).toHaveLength(1);
    const state = (messages[0].content as Array<Record<string, unknown>>)[0].state as Record<string, unknown>;
    expect(state.status).toBe("error");
    expect(state.error).toEqual({ type: "tool.execution", message: "make: *** [all] Error 2" });
    expect(state.content).toEqual([{ type: "text", text: "make: *** [all] Error 2" }]);
  });

  it("a completed tool content carries no error", () => {
    const transcript: ChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_ok", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_ok", content: "ok" }] },
    ];
    const state = (openCodeStoreMessages(transcript, opts)[0].content as Array<Record<string, unknown>>)[0]
      .state as Record<string, unknown>;
    expect(state).not.toHaveProperty("error");
  });
});

describe("openCodeImportBody", () => {
  const seed: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "q1" }] },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
  ];

  it("carries the session info with the location, a zero rate card, the agent and the model, and the seed messages", () => {
    const body = openCodeImportBody(seed, {
      ...opts,
      model: { providerID: "switchboard", id: "claude-fable-5", variant: "high" },
    });
    expect(body.info).toMatchObject({
      id: "ses_run-c",
      location: LOC,
      agent: "switchboard",
      model: { providerID: "switchboard", id: "claude-fable-5", variant: "high" },
      cost: 0,
    });
    expect(body.location).toEqual(LOC);
    expect(body.messages).toHaveLength(2);
    // No secret and no bearer anywhere in the body.
    expect(JSON.stringify(body)).not.toContain("sbr_");
  });

  it("appends each compaction as a compaction message with the stored summary, after the turns", () => {
    const body = openCodeImportBody(seed, {
      ...opts,
      compactions: [{ summary: "the earlier turns, summarized" }],
    });
    expect(body.messages).toHaveLength(3);
    const compaction = body.messages[2];
    expect(compaction.type).toBe("compaction");
    expect(compaction).toMatchObject({ status: "completed", summary: "the earlier turns, summarized" });
  });

  it("stamps every message, tool content and compaction from one ticking clock, so a compaction's timestamp is strictly later than every tool content's — no collision when a turn carries tool calls (F4)", () => {
    // A seed whose assistant turn carries two tool calls: the tool contents tick
    // the clock past the message count, so a compaction stamped from the message
    // count alone would collide with a tool content.
    const withTools: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "one" } },
          { type: "tool_use", id: "t2", name: "bash", input: { command: "two" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "ok one" },
          { type: "tool_result", toolUseId: "t2", content: "ok two" },
        ],
      },
    ];
    const body = openCodeImportBody(withTools, { ...opts, compactions: [{ summary: "summarized" }] });
    const stampsOf = (m: Record<string, unknown>): number[] => {
      const time = m.time as { created?: number } | undefined;
      const contentStamps = Array.isArray(m.content)
        ? (m.content as Record<string, unknown>[]).flatMap((c) => {
            const t = c.time as { created?: number } | undefined;
            return typeof t?.created === "number" ? [t.created] : [];
          })
        : [];
      return [...(typeof time?.created === "number" ? [time.created] : []), ...contentStamps];
    };
    const compaction = body.messages[body.messages.length - 1];
    expect(compaction.type).toBe("compaction");
    const compactionAt = (compaction.time as { created: number }).created;
    const earlier = body.messages.slice(0, -1).flatMap(stampsOf);
    expect(earlier.length).toBeGreaterThan(0);
    for (const stamp of earlier) expect(compactionAt).toBeGreaterThan(stamp);
  });
});

describe("openCodeSeedAndRequest", () => {
  it("splits the last user turn off as the request and leaves the earlier turns as the seed", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "and now this" }] },
    ];
    const { seed, request } = openCodeSeedAndRequest(messages);
    expect(seed.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(request).toBe("and now this");
  });

  it("a seed of one user turn has no earlier turns and the turn is the request", () => {
    const { seed, request } = openCodeSeedAndRequest([
      { role: "user", content: [{ type: "text", text: "just this" }] },
    ]);
    expect(seed).toEqual([]);
    expect(request).toBe("just this");
  });
});
