import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_KEY_ENV, parseMcpSettings } from "./config.js";

describe("parseMcpSettings (the `mcp` block — features/mcp-tools.md item 13)", () => {
  it("absent → undefined (MCP off); `mcp: {}` → the defaults", () => {
    expect(parseMcpSettings(undefined)).toBeUndefined();
    expect(parseMcpSettings(null)).toBeUndefined();
    expect(parseMcpSettings({})).toEqual({ credentialKeyEnv: DEFAULT_MCP_KEY_ENV });
    expect(parseMcpSettings({ credentialKeyEnv: "MY_KEY", secretsPath: "./data/x.json" })).toEqual({ credentialKeyEnv: "MY_KEY", secretsPath: "./data/x.json" });
  });

  it("refuses a non-mapping, a bad env name, a bad path — and the moved `servers` list, naming where servers live now", () => {
    expect(() => parseMcpSettings([])).toThrow(/mcp: expected a mapping/);
    expect(() => parseMcpSettings({ credentialKeyEnv: "" })).toThrow(/credentialKeyEnv/);
    expect(() => parseMcpSettings({ secretsPath: 3 })).toThrow(/secretsPath/);
    expect(() => parseMcpSettings({ servers: [] })).toThrow(/mcp\.servers moved: declare servers as `defaults\.mcpServers`/);
  });
});
