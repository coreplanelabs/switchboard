import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAdminRestartAuthorize } from "./adminRestartAuthorize.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";

// `POST /admin/restart/authorize` (features/slack-channel.md item 8): the Worker
// shim asks the bot whether a `deploy restart` bearer's actor holds
// `deploy:write` — the bot's config is the one grants source, the Worker only
// holds the token map. Answers exactly what `authorizeRestart` decides.

const TOKENS = JSON.stringify({ "tok-deployer": { subject: "ops" }, "tok-reader": { subject: "reader" } });
const GRANTS: Record<string, Grants> = {
  "http:ops": { actions: new Set(["deploy:write"]), channels: new Set(), repos: new Set() },
  "http:reader": { actions: new Set(["runs:read"]), channels: new Set(), repos: new Set() },
};

function request(method: string, authorization?: string) {
  const writes: { status?: number; body?: string } = {};
  const req = { method, headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
  const res = {
    writeHead: (status: number) => void (writes.status = status),
    end: (body: string) => void (writes.body = body),
  } as unknown as ServerResponse;
  return { req, res, writes };
}

function harness(over: { tokens?: string | undefined } = {}) {
  const logs: string[] = [];
  return {
    deps: {
      tokens: "tokens" in over ? over.tokens : TOKENS,
      grantsFor: (id: string) => GRANTS[id] ?? NO_GRANTS,
      log: (l: string) => void logs.push(l),
    },
    logs,
  };
}

describe("POST /admin/restart/authorize", () => {
  it("a bearer whose http:<subject> actor holds deploy:write → 200 with the subject", () => {
    const h = harness();
    const { req, res, writes } = request("POST", "Bearer tok-deployer");
    handleAdminRestartAuthorize(req, res, h.deps);
    expect(writes.status).toBe(200);
    expect(JSON.parse(writes.body!)).toEqual({ ok: true, subject: "ops" });
    expect(h.logs).toEqual([]);
  });

  it("no bearer → 401, an unknown bearer → 401, a bearer without the grant → 403, no token map → 503; the reason is logged and never the token", () => {
    for (const [auth, status] of [
      [undefined, 401],
      ["Bearer nope", 401],
      ["Bearer tok-reader", 403],
    ] as const) {
      const h = harness();
      const { req, res, writes } = request("POST", auth);
      handleAdminRestartAuthorize(req, res, h.deps);
      expect(writes.status, String(auth)).toBe(status);
      expect(JSON.parse(writes.body!).ok).toBe(false);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).not.toContain("tok-");
      expect(writes.body).not.toContain("tok-");
    }
    const off = harness({ tokens: undefined });
    const { req, res, writes } = request("POST", "Bearer tok-deployer");
    handleAdminRestartAuthorize(req, res, off.deps);
    expect(writes.status).toBe(503);
  });

  it("only POST", () => {
    const h = harness();
    const { req, res, writes } = request("GET", "Bearer tok-deployer");
    handleAdminRestartAuthorize(req, res, h.deps);
    expect(writes.status).toBe(405);
    expect(h.logs).toEqual([]);
  });
});
