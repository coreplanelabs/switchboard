import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import type { ChatMessage } from "../core/chatMessage.js";
import type { Notepad } from "../core/runLedger/types.js";
import type { RunsService } from "../core/runsService.js";
import { InMemoryGithubApi } from "../execution/githubApi.js";
import { InMemoryMcpClient } from "../mcp/fake.js";
import { StaticMcpToolSource } from "../mcp/source.js";
import type { ToolContext } from "./runnableTool.js";
import { sessionCapabilityFor } from "./session.js";
import { mergeTools, TOOLSETS } from "./toolsets.js";

// Feature: docs/reference/specs/orchestration-plane.md item 12 — the actual
// offered tools, over the same requester/session capabilities as any turn.
describe("orchestrator conversational reads", () => {
  it("reads GitHub and MCP evidence then recalls it in the same session without gaining writes or another requester's access", async () => {
    const api = new InMemoryGithubApi({
      "acme/api": { private: false, files: { "README.md": "The API accepts a cursor for the next page." } },
    });
    const source = new StaticMcpToolSource(
      [{ name: "metrics", url: "https://metrics.example/mcp", agents: ["orchestrator"] }],
      {
        factory: () =>
          new InMemoryMcpClient([
            {
              name: "read",
              inputSchema: {},
              annotations: { readOnlyHint: true },
              handler: async () => ({
                content: [{ type: "text", text: "record: usage; window: last completed hour UTC; count: 4" }],
              }),
            },
            { name: "write", inputSchema: {} },
          ]),
      },
    );
    const extra = await source.toolsFor("orchestrator", { userId: "user:reader" });
    const tools = mergeTools(TOOLSETS[AGENTS.orchestrator.toolset], extra.tools);
    const tool = (name: string) => {
      const found = tools.find((t) => t.name === name);
      expect(found, name).toBeDefined();
      return found!;
    };
    let notepad: Notepad | null = null;
    const turns: ChatMessage[] = [];
    const key = "web:reader:orchestrator";
    const ledger = {
      readSession: vi.fn(async () => ({
        complete: true as const,
        turns: turns.length,
        messages: turns,
        compactions: [],
      })),
      searchSession: vi.fn(async () => ({ hits: [], gaps: [] })),
      readNotepad: vi.fn(async () => notepad),
      writeNotepad: vi.fn(async (_key: string, text: string) => {
        notepad = { text, updatedAt: 1 };
        return { ok: true as const };
      }),
    };
    const context = (userId = "user:reader"): ToolContext => ({
      executor: {} as ToolContext["executor"],
      agentName: "orchestrator",
      github: {
        api,
        canWrite: () => false,
        readableRepos: async () => (userId === "user:reader" ? api.listRepos() : []),
      },
      session: sessionCapabilityFor(
        { runId: "turn-1", session: { key, seedFrom: 0, request: 0, range: { from: 1 } } },
        ledger,
      ),
      runs: {
        runId: "turn-1",
        actor: { kind: "user", id: userId, grants: { actions: new Set(), channels: new Set(), repos: new Set() } },
        service: {
          getRun: async () => ({
            ok: true,
            value: {
              id: "turn-1",
              userId: "user:reader",
              threadKey: key,
              channelVisibility: "private",
              startedAt: 1,
              finished: false,
              eventCount: 0,
            },
          }),
        } as unknown as RunsService,
      },
    });
    const ctx = context();
    const github = String(await tool("github_file").run({ repo: "acme/api", path: "README.md", ref: "main" }, ctx));
    expect(github).toContain("https://github.com/acme/api/blob/main/README.md");
    expect(github).toContain("cursor");
    expect(
      String(await tool("github_file").run({ repo: "acme/api", path: "README.md" }, context("user:other"))),
    ).toContain("not allowed");
    const mcp = String(await tool("mcp__metrics__read").run({}, ctx));
    expect(mcp).toContain("last completed hour UTC");
    expect(mcp).toContain("<<<UNTRUSTED");
    const evidence = `${github}\n${mcp}`;
    turns.push({ role: "assistant", content: [{ type: "text", text: evidence }] });
    await tool("notes").run({ text: evidence }, ctx);
    // A later turn reconstructs the capability, not a new agent/session.
    const later = context();
    expect(String(await tool("notes").run({}, later))).toContain("cursor");
    expect(String(await tool("recall").run({ turn: 0 }, later))).toContain("last completed hour UTC");
    expect(ledger.readSession).toHaveBeenCalledWith(key, 0, 0);
    expect(ledger.writeNotepad).toHaveBeenCalledWith(key, evidence, "turn-1");
    expect(await tool("recall").run({ turn: 0 }, context("user:other"))).toBe('{"turn":0,"content":null}');
    expect(ledger.readSession).toHaveBeenCalledTimes(1);
    for (const absent of ["github_issue_create", "spawn_run", "submit_pr_description", "bash", "mcp__metrics__write"]) {
      expect(
        tools.some((t) => t.name === absent),
        absent,
      ).toBe(false);
    }
    expect(await tool("github_file").run({ repo: "acme/hidden", path: "README.md" }, ctx)).toContain("not allowed");
    expect(await tool("github_file").run({}, { ...ctx, github: undefined })).toContain("not available");
    expect(await tool("plane_show").run({}, ctx)).toContain("instead of answering the question from memory");
  });
});
