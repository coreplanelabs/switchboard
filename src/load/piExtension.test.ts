import { describe, expect, it } from "vitest";
import { submitPrDescriptionTool, submitVerdictTool } from "../tools/submit.js";
import piExtension, {
  HOOK_PREFIX,
  type PiExtensionApi,
  type PiExtensionContext,
  type PiToolDefinition,
} from "./piExtension.js";

// The extension pi loads for `load:pi` (docs/reference/specs/load-harness.md,
// the pi driver items): the two terminal tools as the bot's own definitions —
// the production relay serves the description and schema src/tools/submit.ts
// declares, and pi holds the model to whatever schema it is served, so a
// definition that drifts from the bot's changes what the model is asked for (a
// `submit_verdict` served without `head` yields verdicts naming no head) —
// and a `tool_call` hook that reports every call the model asked for. It has
// no imports so pi's own loader runs it unchanged; its one channel back to the
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
  it("registers the two terminal tools as the native definitions field for field — the description and the JSON Schema the relay serves, `head` required of a verdict — with no TypeBox symbol on the schema", () => {
    const f = fakePi();
    piExtension(f.pi);
    expect([...f.tools.keys()].sort()).toEqual(["submit_pr_description", "submit_verdict"]);
    const verdict = f.tools.get("submit_verdict")!;
    // The head is what the reviewed-head guard's fallback reads; a schema that
    // does not require it is a verdict the model is free to submit without one.
    expect(verdict.parameters.required).toEqual(["verdict", "summary", "head"]);
    const native = submitVerdictTool.inputSchema as { properties: Record<string, unknown> };
    expect(verdict.parameters.properties.head).toEqual(native.properties.head);
    expect(verdict.parameters).toEqual(submitVerdictTool.inputSchema);
    expect(verdict.description).toBe(submitVerdictTool.description);
    const pr = f.tools.get("submit_pr_description")!;
    expect(pr.parameters).toEqual(submitPrDescriptionTool.inputSchema);
    expect(pr.description).toBe(submitPrDescriptionTool.description);
    // No TypeBox symbol on either schema: pi validates plain JSON Schema.
    expect(Object.getOwnPropertySymbols(pr.parameters)).toEqual([]);
    expect(Object.getOwnPropertySymbols(verdict.parameters)).toEqual([]);
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

  it("submit_verdict does the same for a review-shaped run — the head rides in the notice as the model passed it", async () => {
    const f = fakePi();
    piExtension(f.pi);
    const params = { verdict: "approve", summary: "fine", head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" };
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
