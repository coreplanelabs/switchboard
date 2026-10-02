import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectHosted,
  hostedUrl,
  installCodexMcp,
  mcpProxyError,
  proxyHostedMcp,
  readHostedProfile,
} from "./hostedClient.js";

describe("hosted client setup", () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-client-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts only an HTTPS origin, except localhost", () => {
    expect(hostedUrl("bot.example")).toBe("https://bot.example");
    expect(hostedUrl("https://bot.example/")).toBe("https://bot.example");
    expect(hostedUrl("http://localhost:3000")).toBe("http://localhost:3000");
    for (const value of [
      "http://bot.example",
      "https://bot.example/path",
      "https://user:pass@bot.example",
      "https://bot.example?x=1",
    ])
      expect(() => hostedUrl(value)).toThrow();
  });

  it("preserves unrelated Codex config and replaces only the Switchboard MCP section", () => {
    const path = join(temp(), "config.toml");
    writeFileSync(
      path,
      '[model]\nname = "one"\n\n[mcp_servers.switchboard]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "other"\n',
    );
    installCodexMcp(path);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('[model]\nname = "one"');
    expect(text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(text.match(/\[mcp_servers\.switchboard\]/g)).toHaveLength(1);
    expect(text).not.toContain('command = "old"');
    expect(text).toContain('"mcp-proxy"');
    installCodexMcp(path);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("removes old Switchboard child tables even across unrelated Codex servers", () => {
    const path = join(temp(), "config.toml");
    writeFileSync(
      path,
      '[mcp_servers.switchboard]\ncommand = "old"\n\n[mcp_servers.switchboard.env]\nSECRET = "old-credential"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.switchboard.headers]\nAuthorization = "old-header"\n\n[[mcp_servers.switchboard.extra]]\nvalue = "old-setting"\n\n[mcp_servers."switchboard".options]\nvalue = "old-option"\n\n[mcp_servers.switchboard_helper]\ncommand = "helper"\n',
    );
    installCodexMcp(path);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("old-credential");
    expect(text).not.toContain("old-header");
    expect(text).not.toContain("old-setting");
    expect(text).not.toContain("old-option");
    expect(text).not.toMatch(/\[\[?mcp_servers\.switchboard\.(env|headers|extra)/);
    expect(text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(text).toContain('[mcp_servers.switchboard_helper]\ncommand = "helper"');
    expect(text.match(/\[mcp_servers\.switchboard\]/g)).toHaveLength(1);
    installCodexMcp(path);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("replaces quoted-parent Switchboard tables and children without touching other servers", () => {
    const path = join(temp(), "config.toml");
    writeFileSync(
      path,
      '["mcp_servers".switchboard]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "other"\n\n[["mcp_servers"."switchboard".headers]]\nvalue = "old-header"\n\n[\'mcp_servers\'.switchboard.env]\nSECRET = "old-credential"\n\n["mcp_servers".switchboard_helper]\ncommand = "helper"\n',
    );
    installCodexMcp(path);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("old-credential");
    expect(text).not.toContain("old-header");
    expect(text).not.toContain('command = "old"');
    expect(text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(text).toContain('["mcp_servers".switchboard_helper]\ncommand = "helper"');
    expect(text.match(/\[mcp_servers\.switchboard\]/g)).toHaveLength(1);
    installCodexMcp(path);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("replaces an inline Switchboard server under mcp_servers while preserving siblings", () => {
    const path = join(temp(), "config.toml");
    writeFileSync(
      path,
      '[model]\nname = "one"\n\n[mcp_servers]\nother = { command = "other" }\nswitchboard = { command = "old", env = { SECRET = "old-credential" } }\nhelper = { command = "helper" }\n',
    );
    installCodexMcp(path);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("old-credential");
    expect(text).not.toContain('command = "old"');
    expect(text).toContain('[mcp_servers]\nother = { command = "other" }\nhelper = { command = "helper" }');
    expect(text).toContain('[model]\nname = "one"');
    expect(text.match(/\[mcp_servers\.switchboard\]/g)).toHaveLength(1);
    installCodexMcp(path);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("replaces a document-root inline server without retaining credentials or freezing sibling tables", () => {
    const path = join(temp(), "config.toml");
    writeFileSync(
      path,
      'mcp_servers = { switchboard = { command = "old", env = { SECRET = "old-credential" } }, other = { command = "other", args = ["comma, and } bracket", "ok"] }, "switchboard_helper" = { command = "helper" } }\nmodel = "one"\n',
    );
    installCodexMcp(path);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("old-credential");
    expect(text).not.toContain('command = "old"');
    expect(text).not.toContain("mcp_servers = {");
    expect(text).toContain('mcp_servers.other = { command = "other", args = ["comma, and } bracket", "ok"] }');
    expect(text).toContain('mcp_servers."switchboard_helper" = { command = "helper" }');
    expect(text).toContain('model = "one"');
    expect(text.match(/\[mcp_servers\.switchboard\]/g)).toHaveLength(1);
    installCodexMcp(path);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("opens an empty root inline parent before adding the Codex server", () => {
    const path = join(temp(), "config.toml");
    writeFileSync(path, '"mcp_servers" = {}\nmodel = "one"\n');
    installCodexMcp(path);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('model = "one"');
    expect(text).not.toContain('"mcp_servers" = {}');
    expect(text.match(/\[mcp_servers\.switchboard\]/g)).toHaveLength(1);
  });

  it("replaces quoted and dotted server assignments without removing similarly named servers", () => {
    const path = join(temp(), "config.toml");
    writeFileSync(
      path,
      `'mcp_servers'.'switchboard' = { command = "old", env = { SECRET = "old-credential" } }\n[mcp_servers.other]\ncommand = "other"\n`,
    );
    installCodexMcp(path);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("old-credential");
    expect(text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(text.match(/\[mcp_servers\.switchboard\]/g)).toHaveLength(1);
    installCodexMcp(path);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("waits for browser approval, verifies a real read, and stores the bearer only in a private local file", async () => {
    const dir = temp();
    const profilePath = join(dir, "client.json");
    const codexPath = join(dir, "config.toml");
    const links: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { method: string };
        calls++;
        if (calls === 1)
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001 } }), { status: 401 });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              body.method === "initialize"
                ? { serverInfo: { name: "switchboard" } }
                : { content: [{ text: "runs.list: ok\n{}" }] },
          }),
          { status: 200 },
        );
      }),
    );
    await connectHosted("https://bot.example", {
      open: (url) => links.push(url),
      output: () => {},
      pollMs: 0,
      attempts: 3,
      profilePath,
      codexPath,
    });
    expect(links).toHaveLength(1);
    const profile = readHostedProfile(profilePath);
    expect(profile?.url).toBe("https://bot.example");
    expect(profile?.bearer).toMatch(/^[a-f0-9]{64}$/);
    expect(links[0]).not.toContain(profile!.bearer);
    expect(statSync(profilePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(codexPath, "utf8")).not.toContain(profile!.bearer);
  });

  it("forwards JSON-RPC envelopes through the private bearer without changing ids or tool arguments", async () => {
    const sent: { url: string; authorization: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({
          url,
          authorization: String((init.headers as Record<string, string>).authorization),
          body: String(init.body),
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "request-7", result: { content: [{ type: "text", text: "ok" }] } }),
        );
      }),
    );
    const profile = { url: "https://bot.example", bearer: "f".repeat(64) };
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "request-7",
      method: "tools/call",
      params: { name: "runs_get", arguments: { id: "run-1" } },
    });
    expect(JSON.parse((await proxyHostedMcp(profile, line)) ?? "null")).toMatchObject({
      id: "request-7",
      result: { content: [{ text: "ok" }] },
    });
    expect(sent).toEqual([{ url: "https://bot.example/mcp", authorization: `Bearer ${profile.bearer}`, body: line }]);
  });

  it("answers a failed stdio request by id and leaves notifications unanswered", () => {
    expect(JSON.parse(mcpProxyError('{"jsonrpc":"2.0","id":"read-4","method":"tools/list"}') ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: "read-4",
      error: { code: -32603, message: "Switchboard connection failed" },
    });
    expect(mcpProxyError('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeUndefined();
  });
});
