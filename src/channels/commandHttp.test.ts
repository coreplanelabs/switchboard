import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { CommandRegistry, bindCommands, type CommandInvoker } from "../core/commandRegistry.js";
import { toSurfaceNames } from "../core/commandSurface.js";
import { registerRunsCommands, type RunsCommandDeps } from "../core/commands/runs.js";
import type { RunEvent } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import type { AccessIdentity } from "./accessAuth.js";
import { ALL_GRANTS, grantsFor } from "../core/authz/grants.js";
import { NO_GRANTS } from "../core/authz/types.js";
import { callerFor, callerIdFor, createCommandHttpHandler, isCommandPath, isLocalhostBase, serviceTokenAllowed, type CommandHttpOptions } from "./commandHttp.js";

// Feature: features/command-registry.md — the generic HTTP adapter for `/api/*`
// (R7/R9/R10, KTD13/KTD15). No per-command code: every registered command is
// served by name; write safety, caller resolution, and the dev-bypass rule are
// the adapter's only logic.

const NOW = 1_700_000_000_000;

function record(id: string, finishedAt: number): RunRecord {
  const events: RunEvent[] = [
    { type: "input", text: "please do the thing", seq: 1 },
    { type: "answer", text: "all done", seq: 2 },
  ];
  return {
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: `slack:C1:${id}`,
    startedAt: finishedAt - 10_000,
    finishedAt,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
  };
}

async function fixture(over: Partial<CommandHttpOptions> = {}) {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `live-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const live = reg.create("coding · acme/live", { agent: "coding", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
  reg.publish(live.id, { type: "input", text: "live request" });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record("fin-1", NOW - 1000));
  const runs = createRunsService({ registry: reg, store });
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const commands: CommandInvoker = bindCommands(registry, { runs: async () => runs });
  const opts: CommandHttpOptions = {
    operatorIdentities: () => ["access:op-1"],
    serviceTokenScopes: (cn) => (cn === "reader-bot" ? ["runs:read"] : []),
    // The same two legacy keys, as `ConfigStore.grantsFor` would translate them.
    grantsFor: (id) => grantsFor(id, { permissions: { operators: ["access:op-1"], serviceTokens: { "reader-bot": ["runs:read"] } }, commandGroups: ["runs"] }),
    devBypassActive: false,
    ...over,
  };
  const handler = createCommandHttpHandler(commands, opts);
  return { reg, live, commands, handler };
}

interface FakeReqInit {
  method: string;
  url: string;
  headers?: IncomingHttpHeaders;
  body?: string;
  remoteAddress?: string;
}

/** A node req/res double: the request is async-iterable (for `readBody`) and
 *  carries a socket address; the response records status/headers/body. */
function fakeReqRes(init: FakeReqInit) {
  const chunks = init.body === undefined ? [] : [Buffer.from(init.body)];
  let destroyed = false;
  let bodyRead = false;
  const req = {
    method: init.method,
    url: init.url,
    headers: { host: "bot.example.test", ...(init.headers ?? {}) },
    socket: { remoteAddress: init.remoteAddress ?? "127.0.0.1" },
    on: () => {},
    destroy: () => void (destroyed = true),
    async *[Symbol.asyncIterator]() {
      bodyRead = true;
      for (const c of chunks) yield c;
    },
  };
  let status = 0;
  let outHeaders: Record<string, string> = {};
  const out: string[] = [];
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      outHeaders = Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    },
    end: (c?: string) => {
      if (c) out.push(c);
    },
  };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get headers() {
      return outHeaders;
    },
    get destroyed() {
      return destroyed;
    },
    get bodyRead() {
      return bodyRead;
    },
    json: () => JSON.parse(out.join("")) as Record<string, unknown>,
    text: () => out.join(""),
  };
}

const browser: AccessIdentity = { sub: "user-1", email: "u@example.com" };
const operator: AccessIdentity = { sub: "op-1" };
const readerBot: AccessIdentity = { sub: "", commonName: "reader-bot" };
const unknownBot: AccessIdentity = { sub: "", commonName: "nobody" };

const stopPost = (id: string, headers: IncomingHttpHeaders = {}, body = JSON.stringify({ id, mode: "soft" })) =>
  fakeReqRes({ method: "POST", url: "/api/runs.stop", headers: { "content-type": "application/json", ...headers }, body });

function stopNotes(reg: RunRegistry, id: string): RunEvent[] {
  return (reg.snapshotById(id)?.events ?? []).filter((e) => e.type === "run_note" && e.kind === "stop_requested");
}

describe("isCommandPath (the ONE gate predicate, KTD13)", () => {
  it("claims /api and everything under /api/, including sloppy and encoded spellings", () => {
    for (const p of ["/api", "/api/", "/api/runs.list", "/api/unknown.cmd", "//api/runs.list", "/api/runs.list/", "/%61pi/runs.list", "/api%2Fruns.list", "/API/runs.list"]) {
      expect(isCommandPath(p), p).toBe(true);
    }
  });

  it("claims every registry-derived path", async () => {
    const { commands } = await fixture();
    for (const cmd of commands.list()) expect(isCommandPath(toSurfaceNames(cmd.id).http)).toBe(true);
  });

  it("leaves other paths alone", () => {
    for (const p of ["/", "/runs", "/runs/abc", "/apiary", "/healthz", "/mcp", "/ingress"]) expect(isCommandPath(p), p).toBe(false);
  });
});

describe("createCommandHttpHandler — read commands", () => {
  it("GET /api/runs.list?status=all → 200 JSON with Cache-Control: no-store and no token", async () => {
    const { handler, commands } = await fixture();
    const t = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all" });
    await handler(t.req, t.res, browser);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toMatch(/^application\/json/);
    expect(t.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(t.headers).some((h) => h.startsWith("access-control-"))).toBe(false);
    const body = t.json() as { runs: { id: string }[] };
    expect(body.runs.map((r) => r.id).sort()).toEqual(["fin-1", "live-1"]);
    expect(t.text()).not.toContain("tok-");
    // The adapter passes `invoke`'s object through untouched.
    const direct = await commands.invoke("runs.list", { options: { status: "all" } }, { kind: "access", id: "access:user-1", scopes: new Set() });
    expect(body).toEqual(direct.ok ? direct.value : null);
  });

  it("POST JSON is accepted for a read command; query strings coerce like JSON", async () => {
    const { handler } = await fixture();
    const post = fakeReqRes({ method: "POST", url: "/api/runs.list", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "all", limit: 1 }) });
    await handler(post.req, post.res, browser);
    const get = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all&limit=1" });
    await handler(get.req, get.res, browser);
    expect(post.status).toBe(200);
    expect(get.status).toBe(200);
    expect(get.json()).toEqual(post.json());
    expect((get.json() as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("bad input → 400 {error, code:'invalid_input'} that names the field without echoing the value", async () => {
    const { handler } = await fixture();
    const t = fakeReqRes({ method: "GET", url: "/api/runs.list?status=s3cret-value" });
    await handler(t.req, t.res, browser);
    expect(t.status).toBe(400);
    const body = t.json();
    expect(body.code).toBe("invalid_input");
    expect(String(body.error)).toContain("status");
    expect(t.text()).not.toContain("s3cret-value");
    expect(t.headers["cache-control"]).toBe("no-store");
  });

  it("unknown run → 404 not_found; unknown command → 404 JSON (never falls through)", async () => {
    const { handler } = await fixture();
    const missing = fakeReqRes({ method: "GET", url: "/api/runs.get?id=nope" });
    await handler(missing.req, missing.res, browser);
    expect(missing.status).toBe(404);
    expect(missing.json().code).toBe("not_found");
    for (const url of ["/api/unknown.cmd", "/api", "/api/", "//api/runs.list", "/api/runs.list/", "/api/../runs"]) {
      const t = fakeReqRes({ method: "GET", url });
      await handler(t.req, t.res, browser);
      expect(t.status, url).toBe(404);
      expect(t.json().code, url).toBe("not_found");
      expect(t.headers["cache-control"]).toBe("no-store");
    }
  });

  it("a non-JSON POST body → 400 invalid_input; a non-JSON content-type → 415", async () => {
    const { handler } = await fixture();
    const bad = fakeReqRes({ method: "POST", url: "/api/runs.list", headers: { "content-type": "application/json" }, body: "[1,2" });
    await handler(bad.req, bad.res, browser);
    expect(bad.status).toBe(400);
    expect(bad.json().code).toBe("invalid_input");
    const form = fakeReqRes({ method: "POST", url: "/api/runs.list", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "status=all" });
    await handler(form.req, form.res, browser);
    expect(form.status).toBe(415);
    expect(form.bodyRead).toBe(false);
  });

  it("an oversized body → 413 without invoking", async () => {
    const { handler } = await fixture({ maxBodyBytes: 8 });
    const t = fakeReqRes({ method: "POST", url: "/api/runs.list", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "all" }) });
    await handler(t.req, t.res, browser);
    expect(t.status).toBe(413);
    expect(t.destroyed).toBe(true);
  });
});

describe("createCommandHttpHandler — write safety (KTD15, AE8)", () => {
  it("GET /api/runs.stop → 405 with allow: POST and no stop_requested note", async () => {
    const { handler, reg, live } = await fixture();
    const t = fakeReqRes({ method: "GET", url: `/api/runs.stop?id=${live.id}&mode=soft` });
    await handler(t.req, t.res, operator);
    expect(t.status).toBe(405);
    expect(t.headers.allow).toBe("POST");
    expect(stopNotes(reg, live.id)).toHaveLength(0);
  });

  it("POST /api/runs.stop with a foreign Origin → 403 and no stop_requested note (body never read)", async () => {
    const { handler, reg, live } = await fixture();
    const t = stopPost(live.id, { origin: "https://evil.example" });
    await handler(t.req, t.res, operator);
    expect(t.status).toBe(403);
    expect(t.json().code).toBe("forbidden_origin");
    expect(t.bodyRead).toBe(false);
    expect(stopNotes(reg, live.id)).toHaveLength(0);
  });

  it("Sec-Fetch-Site: cross-site → 403; same-origin Origin (against the host) → allowed", async () => {
    const { handler, reg, live } = await fixture();
    const cross = stopPost(live.id, { "sec-fetch-site": "cross-site" });
    await handler(cross.req, cross.res, operator);
    expect(cross.status).toBe(403);
    expect(stopNotes(reg, live.id)).toHaveLength(0);
    const same = stopPost(live.id, { origin: "https://bot.example.test", "sec-fetch-site": "same-origin" });
    await handler(same.req, same.res, operator);
    expect(same.status).toBe(200);
    expect(stopNotes(reg, live.id)).toHaveLength(1);
  });

  it("same-origin is judged against PUBLIC_BASE_URL when set (a spoofed Host does not help)", async () => {
    const { handler, reg, live } = await fixture({ publicBaseUrl: "https://switchboard.example.dev" });
    const spoofed = stopPost(live.id, { origin: "https://bot.example.test" });
    await handler(spoofed.req, spoofed.res, operator);
    expect(spoofed.status).toBe(403);
    const real = stopPost(live.id, { origin: "https://switchboard.example.dev" });
    await handler(real.req, real.res, operator);
    expect(real.status).toBe(200);
    expect(stopNotes(reg, live.id)).toHaveLength(1);
  });

  it("same-origin against PUBLIC_BASE_URL is the FULL origin: same host on another port or scheme → 403", async () => {
    const { handler, reg, live } = await fixture({ publicBaseUrl: "https://switchboard.example.dev" });
    const port = stopPost(live.id, { origin: "https://switchboard.example.dev:8443" });
    await handler(port.req, port.res, operator);
    expect(port.status).toBe(403);
    const scheme = stopPost(live.id, { origin: "http://switchboard.example.dev" });
    await handler(scheme.req, scheme.res, operator);
    expect(scheme.status).toBe(403);
    expect(stopNotes(reg, live.id)).toHaveLength(0);
  });

  it("a write POST without content-type: application/json → 415, nothing published", async () => {
    const { handler, reg, live } = await fixture();
    const t = fakeReqRes({ method: "POST", url: "/api/runs.stop", body: JSON.stringify({ id: live.id, mode: "soft" }) });
    await handler(t.req, t.res, operator);
    expect(t.status).toBe(415);
    expect(stopNotes(reg, live.id)).toHaveLength(0);
  });

  it("bad mode → 400 invalid_input without echoing; finished run → 409 conflict", async () => {
    const { handler, live } = await fixture();
    const bad = stopPost(live.id, {}, JSON.stringify({ id: live.id, mode: "explode-now" }));
    await handler(bad.req, bad.res, operator);
    expect(bad.status).toBe(400);
    expect(bad.json().code).toBe("invalid_input");
    expect(bad.text()).toContain("mode");
    expect(bad.text()).not.toContain("explode-now");
    const fin = stopPost("fin-1");
    await handler(fin.req, fin.res, operator);
    expect(fin.status).toBe(409);
    expect(fin.json().code).toBe("conflict");
  });

  it("an operator's stop records the structured access actor", async () => {
    const { handler, reg, live } = await fixture();
    const t = stopPost(live.id);
    await handler(t.req, t.res, operator);
    expect(t.status).toBe(200);
    const note = stopNotes(reg, live.id)[0] as { actor?: unknown };
    expect(note.actor).toEqual({ kind: "access", id: "access:op-1" });
  });
});

describe("createCommandHttpHandler — caller resolution (R9)", () => {
  it("a browser identity without an operators entry: 200 on runs.list, 403 on POST runs.stop before the body is read", async () => {
    const { handler, reg, live } = await fixture();
    const list = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all" });
    await handler(list.req, list.res, browser);
    expect(list.status).toBe(200);
    const stop = stopPost(live.id);
    await handler(stop.req, stop.res, browser);
    expect(stop.status).toBe(403);
    expect(stop.json().code).toBe("unauthorized");
    expect(stop.bodyRead).toBe(false);
    expect(stopNotes(reg, live.id)).toHaveLength(0);
  });

  it("a service token is honored with exactly its configured scopes: reader-bot reads, cannot stop; an unlisted token holds nothing", async () => {
    const { handler, live } = await fixture();
    const list = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all" });
    await handler(list.req, list.res, readerBot);
    expect(list.status).toBe(200);
    const stop = stopPost(live.id);
    await handler(stop.req, stop.res, readerBot);
    expect(stop.status).toBe(403);
    const nobody = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all" });
    await handler(nobody.req, nobody.res, unknownBot);
    expect(nobody.status).toBe(403);
    expect(nobody.json().code).toBe("unauthorized");
  });

  it("a service token with runs:write stops a run as actor access:svc:<common_name>", async () => {
    const { handler, reg, live } = await fixture({ serviceTokenScopes: (cn) => (cn === "ops-bot" ? ["runs:read", "runs:write"] : []) });
    const t = stopPost(live.id);
    await handler(t.req, t.res, { sub: "", commonName: "ops-bot" });
    expect(t.status).toBe(200);
    expect((stopNotes(reg, live.id)[0] as { actor?: unknown }).actor).toEqual({ kind: "access", id: "access:svc:ops-bot" });
  });
});

describe("createCommandHttpHandler — dev bypass (KTD13)", () => {
  it("serves loopback callers under the bypass, refuses a non-loopback remote with 403", async () => {
    const { handler } = await fixture({ devBypassActive: true });
    const local = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all", remoteAddress: "::ffff:127.0.0.1" });
    await handler(local.req, local.res, { sub: "dev-bypass" });
    expect(local.status).toBe(200);
    const remote = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all", remoteAddress: "10.0.0.7" });
    await handler(remote.req, remote.res, { sub: "dev-bypass" });
    expect(remote.status).toBe(403);
    expect(remote.json().code).toBe("forbidden");
  });

  it("refuses every /api/* request under the bypass when PUBLIC_BASE_URL names a non-localhost host", async () => {
    const { handler } = await fixture({ devBypassActive: true, publicBaseUrl: "https://switchboard.example.dev" });
    const t = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all", remoteAddress: "127.0.0.1" });
    await handler(t.req, t.res, { sub: "dev-bypass" });
    expect(t.status).toBe(403);
    const ok = createCommandHttpHandler((await fixture()).commands, {
      operatorIdentities: () => [],
      serviceTokenScopes: () => [],
      grantsFor: () => NO_GRANTS,
      devBypassActive: true,
      publicBaseUrl: "http://localhost:3000",
    });
    const l = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all" });
    await ok(l.req, l.res, { sub: "dev-bypass" });
    expect(l.status).toBe(200);
  });

  it("the bypass rule does not apply when the bypass is inactive", async () => {
    const { handler } = await fixture({ publicBaseUrl: "https://switchboard.example.dev" });
    const t = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all", remoteAddress: "10.0.0.7" });
    await handler(t.req, t.res, browser);
    expect(t.status).toBe(200);
  });
});

describe("serviceTokenAllowed — a service token is a command-surface credential only", () => {
  it("admits a service token on /api/* (every spelling isCommandPath claims) and nowhere else", () => {
    for (const p of ["/api/runs.list", "/api", "//api/runs.list", "/API/runs.list"]) expect(serviceTokenAllowed(p, readerBot), p).toBe(true);
    for (const p of ["/runs", "/runs?all=1", "/runs/live-1/events", "/runs/live-1/stop", "/residents", "/costs", "/costs.json", "/costs/prod"]) {
      expect(serviceTokenAllowed(p, readerBot), p).toBe(false);
      expect(serviceTokenAllowed(p, unknownBot), p).toBe(false);
    }
  });

  it("a browser session (and the dev-bypass identity) is allowed everywhere the gate admits it", () => {
    for (const p of ["/runs", "/runs/live-1", "/residents", "/costs", "/api/runs.list"]) {
      expect(serviceTokenAllowed(p, browser), p).toBe(true);
      expect(serviceTokenAllowed(p, { sub: "dev-bypass" }), p).toBe(true);
    }
  });
});

describe("callerIdFor — one Access identity → caller id mapping for /api and the audit line", () => {
  it("browser → access:<sub>; service token → access:svc:<common_name>, never a bare `access:`", () => {
    expect(callerIdFor(browser)).toBe("access:user-1");
    expect(callerIdFor(readerBot)).toBe("access:svc:reader-bot");
    expect(callerIdFor(readerBot)).not.toBe("access:");
  });

  it("callerFor carries the same identity as an Actor: browser sub → user access:<sub>, service token → service access:svc:<cn>, grants from the lookup (plan U2)", async () => {
    const { commands } = await fixture();
    const opts: CommandHttpOptions = {
      operatorIdentities: () => ["access:op-1"],
      serviceTokenScopes: (cn) => (cn === "reader-bot" ? ["runs:read"] : []),
      grantsFor: (id) => grantsFor(id, { permissions: { admins: ["access:op-1"], serviceTokens: { "reader-bot": ["runs:read"] } } }),
      devBypassActive: false,
    };
    expect(callerFor({ sub: "op-1" }, commands, opts).actor).toEqual({ kind: "user", id: "access:op-1", grants: ALL_GRANTS });
    expect(callerFor(browser, commands, opts).actor).toEqual({ kind: "user", id: "access:user-1", grants: NO_GRANTS });
    expect(callerFor(readerBot, commands, opts).actor).toEqual({ kind: "service", id: "access:svc:reader-bot", grants: { actions: new Set(["runs:read"]), channels: "all", repos: new Set() } });
    // The legacy fields the registry still decides on are untouched.
    expect(callerFor(browser, commands, opts)).toMatchObject({ kind: "access", id: "access:user-1", scopes: new Set() });
  });

  it("is the id callerFor's Caller carries", async () => {
    const { handler, reg } = await fixture({ serviceTokenScopes: () => ["runs:write"] });
    const live = reg.create("x", { agent: "coding", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:x" });
    const t = stopPost(live.id);
    await handler(t.req, t.res, readerBot);
    expect(t.status).toBe(200);
    expect((stopNotes(reg, live.id)[0] as { actor?: unknown }).actor).toEqual({ kind: "access", id: callerIdFor(readerBot) });
  });
});

describe("isLocalhostBase — the ONE localhost rule for the dev bypass (liveView + /api)", () => {
  it("unset → localhost; localhost, 127.0.0.1 and [::1] hosts (any port) → true", () => {
    expect(isLocalhostBase(undefined)).toBe(true);
    expect(isLocalhostBase("")).toBe(true);
    expect(isLocalhostBase("http://localhost:3000")).toBe(true);
    expect(isLocalhostBase("http://127.0.0.1")).toBe(true);
    expect(isLocalhostBase("http://[::1]:8080")).toBe(true);
  });

  it("a remote host → false; a malformed value (no scheme) → false and never throws", () => {
    expect(isLocalhostBase("https://switchboard.example.dev")).toBe(false);
    expect(() => isLocalhostBase("switchboard.example.com")).not.toThrow();
    expect(isLocalhostBase("switchboard.example.com")).toBe(false);
    expect(isLocalhostBase("not a url")).toBe(false);
  });
});
