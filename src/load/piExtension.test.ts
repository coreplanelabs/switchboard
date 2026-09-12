import { describe, expect, it } from "vitest";
import piExtension, {
  HOOK_PREFIX,
  type PiExtensionApi,
  type PiExtensionContext,
  type PiToolDefinition,
} from "./piExtension.js";

// The extension pi loads for `load:pi` (docs/reference/specs/load-harness.md,
// the pi driver items): the terminal tools a coding child needs and a
// `tool_call` hook that reports every call the model asked for. It has no
// imports so pi's own loader runs it unchanged; its one channel back to the
// driver is pi's `notify` UI request, which RPC mode writes to stdout as an
// `extension_ui_request`. These tests drive it with a fake `pi`.

function fakePi() {
  const tools = new Map<string, PiToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: PiExtensionContext) => unknown>();
  const pi: PiExtensionApi = {
    registerTool: (def) => {
      tools.set(def.name, def);
    },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  };
  const notices: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
    mode: "rpc",
    hasUI: true,
  };
  return { pi, tools, handlers, notices, ctx };
}

const payloadOf = (n: { message: string }) =>
  JSON.parse(n.message.slice(HOOK_PREFIX.length)) as Record<string, unknown>;

describe("piExtension", () => {
  it("registers the two terminal tools with plain JSON-schema parameters", () => {
    const f = fakePi();
    piExtension(f.pi);
    expect([...f.tools.keys()].sort()).toEqual(["submit_pr_description", "submit_verdict"]);
    const pr = f.tools.get("submit_pr_description")!;
    expect(pr.parameters.type).toBe("object");
    expect(pr.parameters.required).toEqual([
      "title",
      "tldr",
      "whatWhy",
      "tour",
      "remaining",
      "decisions",
      "risks",
      "validation",
    ]);
    // No TypeBox symbol on the schema: pi validates plain JSON Schema.
    expect(Object.getOwnPropertySymbols(pr.parameters)).toEqual([]);
    expect(f.tools.get("submit_verdict")!.parameters.required).toEqual(["verdict", "summary"]);
  });

  it("the tool_call hook reports the call through notify and never blocks", async () => {
    const f = fakePi();
    piExtension(f.pi);
    const out = await f.handlers.get("tool_call")!(
      { toolCallId: "call_7", toolName: "bash", input: { command: "ls" } },
      f.ctx,
    );
    expect(out).toBeUndefined();
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0].message.startsWith(HOOK_PREFIX)).toBe(true);
    expect(payloadOf(f.notices[0])).toEqual({
      kind: "tool_call",
      toolCallId: "call_7",
      toolName: "bash",
      input: { command: "ls" },
    });
  });

  it("submit_pr_description hands the object to the driver and tells the model it was recorded", async () => {
    const f = fakePi();
    piExtension(f.pi);
    const params = { title: "T", tldr: "x" };
    const result = await f.tools.get("submit_pr_description")!.execute("call_1", params, undefined, undefined, f.ctx);
    expect(payloadOf(f.notices[0])).toEqual({ kind: "submit_pr_description", params });
    expect(result.content[0].text).toMatch(/recorded/);
    expect(result.content[0].text).toMatch(/later call replaces/);
  });

  it("submit_verdict does the same for a review-shaped run", async () => {
    const f = fakePi();
    piExtension(f.pi);
    const params = { verdict: "approve", summary: "fine" };
    const result = await f.tools.get("submit_verdict")!.execute("call_2", params, undefined, undefined, f.ctx);
    expect(payloadOf(f.notices[0])).toEqual({ kind: "submit_verdict", params });
    expect(result.content[0].text).toMatch(/recorded/);
  });

  it("announces the session start with pi's mode so the driver can prove it is in RPC mode", async () => {
    const f = fakePi();
    piExtension(f.pi);
    await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx);
    expect(payloadOf(f.notices[0])).toEqual({ kind: "session_start", mode: "rpc", hasUI: true });
  });
});
