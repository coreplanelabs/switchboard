import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piLaunchFiles, piRunPaths } from "./pi/process.js";
import { openCodeLaunchFiles, openCodeRunPaths } from "./opencode/process.js";

// The existing launch boundary supplies declarations, never tool authority.
// Load the actual generated adapters while the discovery route is unavailable.
const definitions = [
  {
    name: "report_status",
    description: 'Report "status" without evaluating ${code}.',
    inputSchema: JSON.parse(
      '{"type":"object","properties":{"message":{"type":"string"},"__proto__":{"type":"string"}}}',
    ),
  },
];
const model = { id: "model", providerType: "openai-compatible", maxTokens: 1000 } as const;
let dir: string;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.SWITCHBOARD_RUN_BEARER;
  delete process.env.SWITCHBOARD_HARNESS_URL;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("runner-owned tool registration", () => {
  it.each(["pi", "opencode"] as const)(
    "%s registers launch definitions without discovery and still asks the bot for authority",
    async (harness) => {
      vi.useFakeTimers();
      dir = realpathSync(mkdtempSync(join(tmpdir(), "swb-launch-tools-")));
      symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
      process.env.SWITCHBOARD_RUN_BEARER = "private-run-bearer";
      process.env.SWITCHBOARD_HARNESS_URL = "https://bot.example";
      const calls: Array<{ path: string; body: unknown }> = [];
      let allow = false;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        if (path === "/harness/tools")
          return new Response(JSON.stringify({ error: "reclaim_pending" }), { status: 503 });
        return new Response(
          JSON.stringify(
            path === "/harness/authorize"
              ? { allow, reason: "not admitted" }
              : { content: [{ type: "text", text: "status recorded" }], isError: false },
          ),
        );
      });
      const declarations = structuredClone(definitions);
      const launch = {
        runId: "run",
        model,
        harnessUrl: "https://bot.example",
        identity: "none" as const,
        system: "Check status",
        relayTools: declarations,
      };
      const source =
        harness === "pi"
          ? piLaunchFiles({ ...launch, paths: piRunPaths("run"), modelStreamTimeoutMs: 1000 }).at(-1)!.content
          : openCodeLaunchFiles({ ...launch, paths: openCodeRunPaths("run") })[1].content;
      declarations[0].name = "changed-after-render";
      declarations[0].description = "changed-after-render";
      expect(source).not.toContain("private-run-bearer");
      const file = join(dir, "adapter.mjs");
      writeFileSync(file, source);
      const adapter = (await import(pathToFileURL(file).href)).default;
      const tools: any[] = [];
      let gate: ((event: unknown) => Promise<unknown>) | undefined;
      const initialize =
        harness === "pi"
          ? adapter({
              registerTool: (tool: unknown) => tools.push(tool),
              on: (name: string, handler: typeof gate) => {
                if (name === "tool_call") gate = handler;
              },
            })
          : adapter.setup({
              tool: { transform: async (fn: any) => fn({ add: (tool: unknown) => tools.push(tool) }), hook: () => {} },
            });
      const settled = Promise.resolve(initialize).then(
        () => null,
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await settled).toBeNull();
      expect(tools.map((tool) => tool.name)).toEqual(["report_status"]);
      expect(tools[0].description).toBe('Report "status" without evaluating ${code}.');
      expect(harness === "pi" ? tools[0].parameters : tools[0].input).toEqual(
        JSON.parse('{"type":"object","properties":{"message":{"type":"string"},"__proto__":{"type":"string"}}}'),
      );
      expect(calls).toEqual([]);
      const input = { message: "ready" };
      if (harness === "pi") {
        expect(await gate!({ toolCallId: "denied", toolName: "report_status", input })).toEqual({
          block: true,
          reason: "not admitted",
        });
      } else {
        await expect(tools[0].execute(input, { id: "denied" })).rejects.toThrow("not admitted");
      }
      expect(calls.map((call) => call.path)).toEqual(["/harness/authorize"]);
      allow = true;
      if (harness === "pi") {
        await gate!({ toolCallId: "allowed", toolName: "report_status", input });
        expect(await tools[0].execute("allowed", input)).toEqual({
          content: [{ type: "text", text: "status recorded" }],
          details: {},
        });
      } else {
        expect(await tools[0].execute(input, { id: "allowed" })).toEqual({ content: "status recorded" });
      }
      expect(calls.at(-1)).toEqual({
        path: "/harness/tool",
        body: { toolCallId: "allowed", tool: "report_status", input: { message: "ready" } },
      });
    },
  );
});
