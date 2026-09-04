import { describe, expect, it } from "vitest";
import { InMemoryMcpClient } from "./fake.js";
import { CompositeMcpToolSource, StaticMcpToolSource, mcpGuidanceBlock } from "./source.js";
import type { McpServerSpec } from "./types.js";

const linear: McpServerSpec = { name: "linear", url: "https://mcp.linear.app/mcp", agents: ["general", "research"] };
const github: McpServerSpec = { name: "github", url: "https://api.githubcopilot.com/mcp/", agents: ["general", "coding", "review"] };

function clients() {
  const byName: Record<string, InMemoryMcpClient> = {
    linear: new InMemoryMcpClient([{ name: "search_issues", inputSchema: {} }, { name: "create_issue", inputSchema: {} }]),
    github: new InMemoryMcpClient([{ name: "get_pr", inputSchema: {}, annotations: { readOnlyHint: true } }]),
  };
  return { byName, factory: (s: McpServerSpec) => byName[s.name] };
}

describe("StaticMcpToolSource", () => {
  it("serves only the servers scoped to the agent; review gets none unless listed", async () => {
    const { factory } = clients();
    const src = new StaticMcpToolSource([linear, github], { factory });
    const general = await src.toolsFor("general", { userId: "slack:U1" });
    expect(general.tools.map((t) => t.name).sort()).toEqual(["mcp__github__get_pr", "mcp__linear__create_issue", "mcp__linear__search_issues"]);
    expect(general.servers).toEqual([
      { server: "linear", toolCount: 2 },
      { server: "github", toolCount: 1 },
    ]);
    const research = await src.toolsFor("research", { userId: "slack:U1" });
    expect(research.tools.map((t) => t.name)).toEqual(["mcp__linear__search_issues", "mcp__linear__create_issue"]);
    const review = await src.toolsFor("review", { userId: "slack:U1" });
    expect(review.tools.map((t) => t.name)).toEqual(["mcp__github__get_pr"]); // listed explicitly
    const onlyLinear = new StaticMcpToolSource([linear], { factory });
    expect(await onlyLinear.toolsFor("review", { userId: "slack:U1" })).toEqual({ tools: [], servers: [] });
  });

  it("a failing server is an outcome, the others still serve", async () => {
    const { byName, factory } = clients();
    byName.linear.failListWith = "HTTP 503 from https://mcp.linear.app/mcp?token=abc";
    const src = new StaticMcpToolSource([linear, github], { factory });
    const out = await src.toolsFor("general", { userId: "slack:U1" });
    expect(out.tools.map((t) => t.name)).toEqual(["mcp__github__get_pr"]);
    expect(out.servers[0].server).toBe("linear");
    expect(out.servers[0].toolCount).toBeUndefined();
    expect(out.servers[0].unavailable).toContain("HTTP 503");
    expect(out.servers[1]).toEqual({ server: "github", toolCount: 1 });
  });

  it("caches tools/list per server for the TTL, then refreshes; a failure is not cached", async () => {
    const { byName, factory } = clients();
    let t = 0;
    const src = new StaticMcpToolSource([linear], { factory, now: () => t, cacheTtlMs: 1000 });
    await src.toolsFor("general", { userId: "u" });
    await src.toolsFor("general", { userId: "u" });
    expect(byName.linear.listCalls).toBe(1);
    t = 1500;
    await src.toolsFor("general", { userId: "u" });
    expect(byName.linear.listCalls).toBe(2);
    byName.linear.failListWith = "down";
    t = 3000;
    await src.toolsFor("general", { userId: "u" });
    byName.linear.failListWith = undefined;
    const again = await src.toolsFor("general", { userId: "u" });
    expect(byName.linear.listCalls).toBe(4);
    expect(again.servers[0].toolCount).toBe(2);
  });

  it("one client per server, reused across runs; one call budget per run", async () => {
    const created: string[] = [];
    const inner = clients();
    const src = new StaticMcpToolSource([linear], {
      factory: (s) => {
        created.push(s.name);
        return inner.factory(s);
      },
    });
    const r1 = await src.toolsFor("general", { userId: "u" });
    const r2 = await src.toolsFor("general", { userId: "u" });
    expect(created).toEqual(["linear"]);
    // The two runs' tools are distinct closures (separate budgets).
    expect(r1.tools[0]).not.toBe(r2.tools[0]);
  });
});

describe("mcpGuidanceBlock", () => {
  it("is undefined with nothing scoped", () => {
    expect(mcpGuidanceBlock([])).toBeUndefined();
  });

  it("lists served servers with tool counts and names the unavailable ones", () => {
    const block = mcpGuidanceBlock([
      { server: "linear", toolCount: 2 },
      { server: "vanta", toolCount: 1 },
      { server: "github", unavailable: "HTTP 503" },
    ])!;
    expect(block).toContain("## External MCP tools");
    expect(block).toContain("- linear: 2 tools");
    expect(block).toContain("- vanta: 1 tool\n");
    expect(block).toContain("mcp__<server>__");
    expect(block).toContain("- github: unavailable (HTTP 503)");
    expect(block).toContain("DATA from a third-party service");
  });

  it("when nothing answered it says so instead of listing tools", () => {
    const block = mcpGuidanceBlock([{ server: "linear", unavailable: "timeout" }])!;
    expect(block).toContain("none answered for this run");
    expect(block).not.toContain("You have tools");
  });
});

describe("CompositeMcpToolSource (config wins over registry, item 1)", () => {
  it("concatenates outcomes; a later source's tool with a taken name is dropped and its server outcome says so", async () => {
    const a = new StaticMcpToolSource([{ name: "linear", url: "https://a.example/mcp", agents: ["general"] }], {
      factory: () => new InMemoryMcpClient([{ name: "search_issues", inputSchema: {} }]),
    });
    const b = new StaticMcpToolSource([{ id: "user:slack:U1/linear", name: "linear", url: "https://b.example/mcp", agents: ["general"] }, { name: "vanta", url: "https://v.example/mcp", agents: ["general"] }], {
      factory: () => new InMemoryMcpClient([{ name: "search_issues", inputSchema: {} }]),
    });
    const out = await new CompositeMcpToolSource([a, b]).toolsFor("general", { userId: "slack:U1" });
    expect(out.tools.map((t) => t.name)).toEqual(["mcp__linear__search_issues", "mcp__vanta__search_issues"]);
    expect(out.servers).toEqual([
      { server: "linear", toolCount: 1 },
      { server: "linear", unavailable: "name shadowed by a server from an earlier source (config wins over registry, org over user)" },
      { server: "vanta", toolCount: 1 },
    ]);
  });

  it("an empty source list is an empty run", async () => {
    expect(await new CompositeMcpToolSource([]).toolsFor("general", { userId: "u" })).toEqual({ tools: [], servers: [] });
  });
});
