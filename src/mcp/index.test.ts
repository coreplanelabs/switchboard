import { describe, expect, it } from "vitest";
import { fakeMcpServerFetch } from "./fake.js";
import { httpMcpClientFactory } from "./index.js";

// docs/reference/specs/mcp-tools.md item 11: the production client factory turns a
// resolved spec into request headers — the bearer under Authorization, and the
// `headersEnv` values as they were named (a Cloudflare Access service token pair).

const TOOLS = [{ name: "search", inputSchema: {} }];

describe("httpMcpClientFactory", () => {
  it("sends the spec's headers on every request, the bearer beside them, and nothing when the spec has neither", async () => {
    const both = fakeMcpServerFetch({ tools: TOOLS });
    await httpMcpClientFactory(both.fetch)({
      name: "lake",
      url: "https://vega.example/mcp",
      agents: ["general"],
      auth: { type: "bearer", token: "tok" },
      headers: { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s3cret" },
    }).listTools();
    expect(both.requests.length).toBeGreaterThan(1); // initialize + tools/list
    for (const r of both.requests) {
      expect(r.headers.authorization).toBe("Bearer tok");
      expect(r.headers["cf-access-client-id"]).toBe("id.access");
      expect(r.headers["cf-access-client-secret"]).toBe("s3cret");
    }

    const headersOnly = fakeMcpServerFetch({ tools: TOOLS });
    await httpMcpClientFactory(headersOnly.fetch)({
      name: "lake",
      url: "https://vega.example/mcp",
      agents: ["general"],
      headers: { "CF-Access-Client-Id": "id.access" },
    }).listTools();
    for (const r of headersOnly.requests) {
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers["cf-access-client-id"]).toBe("id.access");
    }

    const bare = fakeMcpServerFetch({ tools: TOOLS });
    await httpMcpClientFactory(bare.fetch)({
      name: "lake",
      url: "https://vega.example/mcp",
      agents: ["general"],
    }).listTools();
    for (const r of bare.requests) {
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers["cf-access-client-id"]).toBeUndefined();
    }
  });
});
