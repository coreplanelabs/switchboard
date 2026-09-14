// Feature: docs/reference/specs/model-proxy.md — `POST /admin/model-proxy/bearer`:
// an operator's bearer for a live run, so the proxy can be probed and receipted
// against a real run before any harness consumes it. Authorized like the
// restart and the crash (a `deploy:write` ingress bearer); the minted bearer
// spends the run's own turns and dies with the run.
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import { createTracer } from "../core/trace/tracer.js";
import { RunBearerStore, type RunBearerGrant } from "../core/modelProxy/runBearers.js";
import { handleAdminModelProxyBearer, MODEL_PROXY_BEARER_PATH } from "./adminModelProxy.js";
import { ANTHROPIC_MESSAGES_PATH } from "./modelProxy.js";

const TOKENS = new Secret(
  JSON.stringify({ "tok-deployer": { subject: "ops" }, "tok-reader": { subject: "reader" } }),
  "SWITCHBOARD_INGRESS_TOKENS",
);
const GRANTS: Record<string, Grants> = {
  "http:ops": { actions: new Set(["deploy:write"]), channels: new Set(), repos: new Set() },
  "http:reader": { actions: new Set(["runs:read"]), channels: new Set(), repos: new Set() },
};
const START = 1_700_000_000_000;

function request(method: string, body: string, authorization?: string) {
  const writes: { status?: number; body?: string } = {};
  async function* iter() {
    yield Buffer.from(body, "utf8");
  }
  const req = Object.assign(iter(), {
    method,
    headers: authorization ? { authorization } : {},
    destroy: () => void (writes.body ??= ""),
  }) as unknown as IncomingMessage;
  const res = {
    writeHead: (status: number) => void (writes.status = status),
    end: (payload: string) => void (writes.body = payload),
  } as unknown as ServerResponse;
  return { req, res, writes, json: () => JSON.parse(writes.body ?? "null") as Record<string, unknown> };
}

function harness() {
  const clock = { now: START };
  const bearers = new RunBearerStore({ clock: () => clock.now });
  const span = createTracer({ clock: () => clock.now }).start("request", { sinks: [] });
  const grant = (runId: string, over: Partial<RunBearerGrant> = {}): RunBearerGrant => ({
    runId,
    modelRef: "anthropic/claude-opus-5",
    providerName: "anthropic",
    providerType: "anthropic",
    model: "claude-opus-5",
    maxTokens: 64000,
    maxTurns: 60,
    expiresAt: START + 50 * 60_000,
    span,
    publish: () => {},
    ...over,
  });
  const logs: string[] = [];
  const deps = {
    tokens: TOKENS as Secret | undefined,
    grantsFor: (id: string) => GRANTS[id] ?? NO_GRANTS,
    bearers,
    log: (l: string) => void logs.push(l),
  };
  return { clock, bearers, grant, deps, logs };
}

async function settled(t: ReturnType<typeof request>) {
  for (let i = 0; i < 50 && t.writes.status === undefined; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("POST /admin/model-proxy/bearer — an operator's bearer for a live run", () => {
  it("is served at the path the bot wires", () => {
    expect(MODEL_PROXY_BEARER_PATH).toBe("/admin/model-proxy/bearer");
  });

  it("a deploy:write bearer gets 201 with a bearer for the live run, its expiry, the pinned model, the proxy path and the turns so far — the log names the operator and the run, never the bearer", async () => {
    const h = harness();
    h.bearers.mint(h.grant("run-1"));
    h.bearers.consumeTurn("run-1");
    const t = request("POST", JSON.stringify({ runId: "run-1" }), "Bearer tok-deployer");
    handleAdminModelProxyBearer(t.req, t.res, h.deps);
    await settled(t);
    expect(t.writes.status).toBe(201);
    const body = t.json();
    expect(body).toMatchObject({
      ok: true,
      runId: "run-1",
      expiresAt: START + 50 * 60_000,
      model: "anthropic/claude-opus-5",
      path: ANTHROPIC_MESSAGES_PATH,
      turns: { used: 1, max: 60 },
    });
    const bearer = body.bearer as string;
    expect(bearer.startsWith("sbr_run-1.")).toBe(true);
    expect(h.bearers.verify(bearer)).toMatchObject({ ok: true, turns: 1 });
    expect(h.logs.join("\n")).toContain("ops → bearer for run-1");
    expect(h.logs.join("\n")).not.toContain(bearer.split(".")[1]);
  });

  it("a run this bot never minted is 404 unknown_run; a run that ended is 409 run_ended; a run past its expiry is 409 too", async () => {
    const h = harness();
    h.bearers.mint(h.grant("ended"));
    h.bearers.revoke("ended");
    h.bearers.mint(h.grant("expired", { expiresAt: START + 1000 }));
    const unknown = request("POST", JSON.stringify({ runId: "nope" }), "Bearer tok-deployer");
    handleAdminModelProxyBearer(unknown.req, unknown.res, h.deps);
    await settled(unknown);
    expect(unknown.writes.status).toBe(404);
    expect(unknown.json().error).toBe("unknown_run");
    const ended = request("POST", JSON.stringify({ runId: "ended" }), "Bearer tok-deployer");
    handleAdminModelProxyBearer(ended.req, ended.res, h.deps);
    await settled(ended);
    expect(ended.writes.status).toBe(409);
    expect(ended.json().error).toBe("run_ended");
    h.clock.now = START + 1000;
    const expired = request("POST", JSON.stringify({ runId: "expired" }), "Bearer tok-deployer");
    handleAdminModelProxyBearer(expired.req, expired.res, h.deps);
    await settled(expired);
    expect(expired.writes.status).toBe(409);
    expect(expired.json().error).toBe("run_ended");
  });

  it("refuses from the headers alone — no bearer 401, a bearer without deploy:write 403 naming the grant, no token map 503, a non-POST 405 — and mints nothing", async () => {
    const h = harness();
    h.bearers.mint(h.grant("run-1"));
    const cases: Array<[ReturnType<typeof request>, number, Parameters<typeof handleAdminModelProxyBearer>[2]]> = [
      [request("POST", JSON.stringify({ runId: "run-1" })), 401, h.deps],
      [request("POST", JSON.stringify({ runId: "run-1" }), "Bearer tok-reader"), 403, h.deps],
      [
        request("POST", JSON.stringify({ runId: "run-1" }), "Bearer tok-deployer"),
        503,
        { ...h.deps, tokens: undefined },
      ],
      [request("GET", "", "Bearer tok-deployer"), 405, h.deps],
    ];
    for (const [t, status, deps] of cases) {
      handleAdminModelProxyBearer(t.req, t.res, deps);
      await settled(t);
      expect(t.writes.status).toBe(status);
    }
    expect(cases[1][0].json().error).toContain("deploy:write");
    expect(h.bearers.grantOf("run-1")?.turns).toBe(0);
    expect(h.logs.filter((l) => l.includes("bearer for"))).toHaveLength(0);
  });

  it("a body that is not `{ runId }` — no JSON, no runId, a runId outside the run-id alphabet — is 400 and mints nothing", async () => {
    const h = harness();
    h.bearers.mint(h.grant("run-1"));
    for (const body of ["{not json", "{}", JSON.stringify({ runId: 5 }), JSON.stringify({ runId: "../etc" }), "[]"]) {
      const t = request("POST", body, "Bearer tok-deployer");
      handleAdminModelProxyBearer(t.req, t.res, h.deps);
      await settled(t);
      expect(t.writes.status).toBe(400);
    }
  });
});
