import { describe, expect, it } from "vitest";
import {
  chatCompletion,
  codingProfileScript,
  nextStep,
  reviewProfileScript,
  startScriptedProvider,
  type Script,
} from "./scriptedProvider.js";

// `load:e2e` drives the bot with a model that never thinks (docs/reference/specs/
// load-harness.md item 6): an OpenAI-compatible server answering the
// `openaiCompat` provider's Chat Completions request from a fixed script. The
// script is a state machine keyed on how many tool results the conversation
// already carries, so the same server serves fifty conversations at once with
// no per-conversation state, and the harness measures infrastructure, not the
// model.

const script: Script = [
  { kind: "tool", name: "read_file", input: { path: "README.md" } },
  { kind: "tool", name: "bash", input: { command: "echo hi" }, text: "Running a command." },
  { kind: "text", text: "All done." },
];

const toolMsg = (id: string) => ({ role: "tool" as const, tool_call_id: id, content: "ok" });

describe("nextStep — the step is the count of tool results so far", () => {
  it("no tool results → the first step; two → the third; past the end → the final text", () => {
    expect(nextStep(script, [{ role: "user", content: "go" }])).toEqual(script[0]);
    expect(
      nextStep(script, [
        { role: "user", content: "go" },
        { role: "assistant", content: null },
        toolMsg("call_0"),
        toolMsg("call_1"),
      ]),
    ).toEqual(script[2]);
    const past = nextStep(script, [toolMsg("a"), toolMsg("b"), toolMsg("c"), toolMsg("d")]);
    expect(past).toEqual({ kind: "text", text: "All done." });
  });

  it("a script without a trailing text step still ends: past the last tool the answer is a default text", () => {
    const onlyTools: Script = [{ kind: "tool", name: "bash", input: { command: "true" } }];
    expect(nextStep(onlyTools, [toolMsg("a")])).toEqual({ kind: "text", text: "Done." });
  });
});

describe("chatCompletion — the OpenAI wire shape the openaiCompat provider parses", () => {
  it("a tool step answers one tool_call with JSON arguments and finish_reason tool_calls", () => {
    const res = chatCompletion({ model: "scripted", messages: [{ role: "user", content: "go" }] }, script, () => 1_000);
    expect(res.object).toBe("chat.completion");
    expect(res.model).toBe("scripted");
    const choice = res.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.role).toBe("assistant");
    expect(choice.message.tool_calls).toEqual([
      {
        id: "call_0",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
      },
    ]);
    expect(res.usage).toEqual({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
  });

  it("a tool step's optional text rides as message.content; the tool_call id is the step index", () => {
    const res = chatCompletion({ model: "m", messages: [toolMsg("call_0")] }, script, () => 0);
    expect(res.choices[0].message.content).toBe("Running a command.");
    expect(res.choices[0].message.tool_calls?.[0].id).toBe("call_1");
  });

  it("a text step answers content with finish_reason stop and no tool_calls", () => {
    const res = chatCompletion({ model: "m", messages: [toolMsg("a"), toolMsg("b")] }, script, () => 0);
    expect(res.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: "All done." },
      finish_reason: "stop",
    });
  });

  it("an undeclared tool is removed from the script for the request, so each declared tool is called exactly once", () => {
    const mixed: Script = [
      { kind: "tool", name: "write_file", input: { path: "x" } },
      { kind: "tool", name: "read_file", input: { path: "a" } },
      { kind: "tool", name: "bash", input: { command: "b" } },
      { kind: "text", text: "end" },
    ];
    const tools = [
      { type: "function", function: { name: "read_file" } },
      { type: "function", function: { name: "bash" } },
    ];
    const first = chatCompletion({ model: "m", messages: [{ role: "user", content: "go" }], tools }, mixed, () => 0);
    expect(first.choices[0].message.tool_calls?.[0].function.name).toBe("read_file");
    const second = chatCompletion({ model: "m", messages: [toolMsg("call_0")], tools }, mixed, () => 0);
    expect(second.choices[0].message.tool_calls?.[0].function.name).toBe("bash");
    const third = chatCompletion({ model: "m", messages: [toolMsg("a"), toolMsg("b")], tools }, mixed, () => 0);
    expect(third.choices[0]).toMatchObject({ message: { content: "end" }, finish_reason: "stop" });
  });

  it("only tools the request declares are called: an undeclared tool step is skipped to the next one", () => {
    const res = chatCompletion(
      {
        model: "m",
        messages: [{ role: "user", content: "go" }],
        tools: [{ type: "function", function: { name: "bash" } }],
      },
      script,
      () => 0,
    );
    expect(res.choices[0].message.tool_calls?.[0].function.name).toBe("bash");
  });
});

describe("profile scripts", () => {
  it("the coding profile reads, runs the CPU burn for the asked seconds, writes under the harness dir, and ends with text — no terminal tool", () => {
    const s = codingProfileScript({ cpuSeconds: 7 });
    const names = s.map((step) => (step.kind === "tool" ? step.name : "text"));
    expect(names).toEqual(["read_file", "bash", "bash", "write_file", "text"]);
    const burn = s[2];
    expect(burn.kind === "tool" && String(burn.input.command)).toContain("7");
    const write = s[3];
    expect(write.kind === "tool" && String(write.input.path)).toMatch(/^\.load-harness\//);
    expect(names).not.toContain("submit_pr_description");
  });

  it("the review profile ends with submit_verdict only when asked, so the default run has no GitHub side effect", () => {
    expect(reviewProfileScript({ cpuSeconds: 1 }).some((s) => s.kind === "tool" && s.name === "submit_verdict")).toBe(
      false,
    );
    const withVerdict = reviewProfileScript({ cpuSeconds: 1, terminal: true });
    const last = withVerdict[withVerdict.length - 2];
    expect(last.kind === "tool" && last.name).toBe("submit_verdict");
    expect(last.kind === "tool" && last.input.verdict).toBe("approve");
  });
});

describe("startScriptedProvider — the server", () => {
  it("serves POST /chat/completions from the script and 404s anything else", async () => {
    const server = await startScriptedProvider(script, { port: 0 });
    try {
      const res = await fetch(`${server.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ finish_reason: string }> };
      expect(body.choices[0].finish_reason).toBe("tool_calls");
      expect((await fetch(`${server.url}/nope`)).status).toBe(404);
      expect(server.requests).toBe(2);
    } finally {
      await server.close();
    }
  });
});
