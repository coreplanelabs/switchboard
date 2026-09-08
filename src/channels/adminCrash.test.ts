import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAdminCrash } from "./adminCrash.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";

// `POST /admin/crash` (docs/reference/specs/run-history.md item 36, plan D12): the kill
// injection behind the durable-runs receipts — authorized exactly like
// `deploy restart` (a `deploy:write` bearer), answered before the process
// exits hard (PID 1 cannot SIGKILL itself; the exit is the same event).

const TOKENS = JSON.stringify({ "tok-deployer": { subject: "ops" }, "tok-reader": { subject: "reader" } });
// Config's grants for the tokens' `http:<subject>` actors: only ops holds deploy:write.
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
  const killed: string[] = [];
  const deferred: (() => void)[] = [];
  const logs: string[] = [];
  const deps = {
    tokens: "tokens" in over ? over.tokens : TOKENS,
    grantsFor: (id: string) => GRANTS[id] ?? NO_GRANTS,
    generation: "20260907T231512Z-3fa9c1d2",
    kill: () => void killed.push("exit 137"),
    defer: (fn: () => void) => void deferred.push(fn),
    log: (l: string) => void logs.push(l),
  };
  return { deps, killed, deferred, logs };
}

describe("POST /admin/crash", () => {
  it("a deploy:write bearer gets 202 with this generation, and the hard exit is deferred until after the response", () => {
    const h = harness();
    const { req, res, writes } = request("POST", "Bearer tok-deployer");
    handleAdminCrash(req, res, h.deps);
    expect(writes.status).toBe(202);
    expect(JSON.parse(writes.body!)).toEqual({ ok: true, generation: "20260907T231512Z-3fa9c1d2", pid: process.pid });
    expect(h.killed).toEqual([]); // not yet: the response must leave first
    expect(h.deferred).toHaveLength(1);
    h.deferred[0]();
    expect(h.killed).toEqual(["exit 137"]);
    expect(h.logs[0]).toContain("ops → hard exit 137");
  });

  it("no bearer → 401, a bearer without deploy:write → 403, no token map → 503; nothing is killed or deferred", () => {
    for (const [auth, status] of [
      [undefined, 401],
      ["Bearer nope", 401],
      ["Bearer tok-reader", 403],
    ] as const) {
      const h = harness();
      const { req, res, writes } = request("POST", auth);
      handleAdminCrash(req, res, h.deps);
      expect(writes.status).toBe(status);
      expect(JSON.parse(writes.body!).ok).toBe(false);
      expect(h.deferred).toEqual([]);
    }
    const off = harness({ tokens: undefined });
    const { req, res, writes } = request("POST", "Bearer tok-deployer");
    handleAdminCrash(req, res, off.deps);
    expect(writes.status).toBe(503);
    expect(off.deferred).toEqual([]);
  });

  it("only POST", () => {
    const h = harness();
    const { req, res, writes } = request("GET", "Bearer tok-deployer");
    handleAdminCrash(req, res, h.deps);
    expect(writes.status).toBe(405);
    expect(h.deferred).toEqual([]);
  });
});
