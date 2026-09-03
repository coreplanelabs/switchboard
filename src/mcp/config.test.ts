import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_AGENTS, parseMcpConfig } from "./config.js";

const agents = ["general", "coding", "review", "ship", "research"];
const env = { MCP_GITHUB_TOKEN: "ghp_secret" };

describe("parseMcpConfig", () => {
  it("absent or empty → no servers", () => {
    expect(parseMcpConfig(undefined, { env, knownAgents: agents })).toEqual([]);
    expect(parseMcpConfig({}, { env, knownAgents: agents })).toEqual([]);
    expect(parseMcpConfig({ servers: [] }, { env, knownAgents: agents })).toEqual([]);
  });

  it("valid entries → specs with the resolved token and default agents", () => {
    const specs = parseMcpConfig(
      {
        servers: [
          { name: "github", url: "https://api.githubcopilot.com/mcp/", auth: { type: "bearer", tokenEnv: "MCP_GITHUB_TOKEN" }, agents: ["general", "coding", "coding"] },
          { name: "public-1", url: "https://mcp.example.com/mcp" },
        ],
      },
      { env, knownAgents: agents },
    );
    expect(specs).toEqual([
      { name: "github", url: "https://api.githubcopilot.com/mcp/", agents: ["general", "coding"], auth: { type: "bearer", token: "ghp_secret" } },
      { name: "public-1", url: "https://mcp.example.com/mcp", agents: [...DEFAULT_MCP_AGENTS] },
    ]);
    expect(DEFAULT_MCP_AGENTS).not.toContain("review");
  });

  it.each([
    [{ servers: "nope" }, /mcp\.servers: expected a list/],
    [{ servers: [{ name: "Bad Name", url: "https://x.example" }] }, /servers\[0\]\.name: expected a slug/],
    [{ servers: [{ name: "a", url: "https://x.example" }, { name: "a", url: "https://y.example" }] }, /duplicate server name "a"/],
    [{ servers: [{ name: "a" }] }, /mcp\.servers\.a\.url: expected an http\(s\) URL/],
    [{ servers: [{ name: "a", url: "ftp://x.example" }] }, /mcp\.servers\.a\.url:/],
    [{ servers: [{ name: "a", url: "http://169.254.169.254/latest" }] }, /mcp\.servers\.a\.url: .*169\.254/],
    [{ servers: [{ name: "a", url: "http://localhost:3000/mcp" }] }, /mcp\.servers\.a\.url:/],
    [{ servers: [{ name: "a", url: "https://x.example", agents: ["wizard"] }] }, /unknown agent "wizard"/],
    [{ servers: [{ name: "a", url: "https://x.example", agents: [] }] }, /agents: expected a non-empty list/],
    [{ servers: [{ name: "a", url: "https://x.example", auth: { type: "oauth" } }] }, /auth\.type: expected "bearer"/],
    [{ servers: [{ name: "a", url: "https://x.example", auth: { type: "bearer" } }] }, /auth\.tokenEnv: expected an environment variable name/],
    [{ servers: [{ name: "a", url: "https://x.example", auth: { type: "bearer", tokenEnv: "MISSING" } }] }, /auth: MISSING is not set/],
  ])("refuses %j naming the entry", (raw, pattern) => {
    expect(() => parseMcpConfig(raw, { env, knownAgents: agents })).toThrow(pattern);
  });

  it("never echoes the token in an error", () => {
    let message = "";
    try {
      parseMcpConfig({ servers: [{ name: "a", url: "https://x.example", auth: { type: "bearer", tokenEnv: "MCP_GITHUB_TOKEN" }, agents: ["nope"] }] }, { env, knownAgents: agents });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('unknown agent "nope"');
    expect(message).not.toContain("ghp_secret");
  });
});
