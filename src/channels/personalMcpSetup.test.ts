import { describe, expect, it, vi } from "vitest";
import { createPersonalMcpSetupHandler } from "./personalMcpSetup.js";
import { InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import { NO_GRANTS } from "../core/authz/types.js";

describe("personal MCP setup", () => {
  const challenge = "a".repeat(64);
  const identity = { sub: "one", email: "one@example.com" };
  const grantsFor = (id: string) =>
    id === "mcp:personal:one"
      ? { actions: new Set(["dispatch", "runs:read"]), channels: "all" as const, repos: new Set<string>() }
      : NO_GRANTS;

  function request(method: string, url: string, body = "", origin = "https://bot.example") {
    async function* chunks() {
      yield Buffer.from(body);
    }
    const req = Object.assign(chunks(), {
      method,
      url,
      headers: {
        host: "bot.example",
        origin,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
    });
    let status = 0;
    let payload = "";
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (text?: string) => {
        payload = text ?? "";
      },
    };
    return { req: req as never, res: res as never, status: () => status, payload: () => payload };
  }

  it("approves a digest after sign-in and the matching same-origin form, then revokes only that owner's device", async () => {
    const store = new InMemoryPersonalTokenStore();
    const handler = createPersonalMcpSetupHandler({ store, grantsFor, publicOrigin: "https://bot.example" });
    const page = request("GET", `/settings/connect?challenge=${challenge}`);
    expect(handler(page.req, page.res, identity)).toBe(true);
    await vi.waitFor(() => expect(page.status()).toBe(200));
    expect(page.payload()).toContain(challenge.slice(0, 8).toUpperCase());
    const approve = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
    handler(approve.req, approve.res, identity);
    await vi.waitFor(() => expect(approve.status()).toBe(200));
    expect((await store.get(challenge))?.subject).toBe("personal:one");
    const foreign = request("POST", "/settings/connect", `action=revoke&challenge=${challenge}`);
    handler(foreign.req, foreign.res, { sub: "two", email: "two@example.com" });
    await vi.waitFor(() => expect(foreign.status()).toBe(403));
    expect(await store.get(challenge)).not.toBeNull();
    const revoke = request("POST", "/settings/connect", `action=revoke&challenge=${challenge}`);
    handler(revoke.req, revoke.res, identity);
    await vi.waitFor(() => expect(revoke.status()).toBe(303));
    expect(await store.get(challenge)).toBeNull();
  });

  it("rejects cross-site posts and sessions without a verified email", async () => {
    const store = new InMemoryPersonalTokenStore();
    const handler = createPersonalMcpSetupHandler({ store, grantsFor, publicOrigin: "https://bot.example" });
    const foreign = request(
      "POST",
      "/settings/connect",
      `action=approve&challenge=${challenge}`,
      "https://elsewhere.example",
    );
    handler(foreign.req, foreign.res, identity);
    await vi.waitFor(() => expect(foreign.status()).toBe(403));
    expect(await store.get(challenge)).toBeNull();
    const unlinked = request("GET", "/settings/connect");
    handler(unlinked.req, unlinked.res, { sub: "one" });
    await vi.waitFor(() => expect(unlinked.status()).toBe(403));
  });
});
