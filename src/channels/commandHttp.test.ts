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
import { ALL_GRANTS, grantsFor, parseGrantsConfig, type GrantsConfig } from "../core/authz/grants.js";
import { NO_GRANTS } from "../core/authz/types.js";

/** A parsed `grants` block (config.yaml's shape) — throws on a malformed fixture. */
const native = (cfg: GrantsConfig) => {
  const parsed = parseGrantsConfig(cfg);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.grants;
};
/** One operator (every read + write over every channel) and one service token; everyone else is a plain browser session. */
const OPERATOR_AND_READER: GrantsConfig = {
  "access:op-1": { actions: ["runs:read", "runs:write"], channels: "all" },
  "access:svc:reader-bot": { actions: ["runs:read"], channels: "all" },
};
import { callerWith } from "../core/testing/callers.js";
import {
  accessActor,
  callerFor,
  resolveAccessActor,
  callerIdFor,
  createCommandHttpHandler,
  isCommandPath,
  serviceTokenAllowed,
  type CommandHttpOptions,
} from "./commandHttp.js";

// Feature: docs/reference/specs/command-registry.md — the generic HTTP adapter for `/api/*`
// No per-command code: every registered command is
// served by name; write safety and caller resolution are the adapter's only
// logic (who may reach /api at all is the dashboard auth strategy's decision,
// dashboardAuth.test.ts).

const NOW = 1_700_000_000_000;

/** A persisted run in a PUBLIC Slack channel (so every Access identity may read it) unless overridden. */
function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = [
    { type: "input", messageId: "m1", text: "please do the thing", seq: 1 },
    { type: "answer", text: "all done", seq: 2 },
  ];
  return {
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:UA",
    threadKey: `slack:C1:${id}`,
    channelVisibility: "public",
    ...over,
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
  const live = reg.create("coding · acme/live", {
    agent: "coding",
    channelId: "slack:C1",
    userId: "slack:UA",
    threadKey: "slack:C1:t",
    channelVisibility: "public",
  });
  reg.publish(live.id, { type: "input", messageId: "m1", text: "live request" });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record("fin-1", NOW - 1000));
  // A finished run from a private Slack group: visible to all-channels holders and its own user only.
  await store.put(
    record("fin-priv", NOW - 2000, {
      channelId: "slack:G_PRIV",
      userId: "slack:UC",
      threadKey: "slack:G_PRIV:fin-priv",
      channelVisibility: "private",
    }),
  );
  const runs = createRunsService({ registry: reg, store });
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const commands: CommandInvoker = bindCommands(registry, { runs: async () => runs });
  const opts: CommandHttpOptions = {
    // Config's grants as `ConfigStore.grantsFor` resolves them: an operator (every read + write over every channel), one service token; every other browser session holds the reads.
    grantsFor: (id) => grantsFor(id, { grants: native(OPERATOR_AND_READER), commandGroups: ["runs"] }),
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
  fakeReqRes({
    method: "POST",
    url: "/api/runs.stop",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

function stopNotes(reg: RunRegistry, id: string): RunEvent[] {
  return (reg.snapshotById(id)?.events ?? []).filter((e) => e.type === "run_note" && e.kind === "stop_requested");
}

describe("isCommandPath (the ONE gate predicate)", () => {
  it("claims /api and everything under /api/, including sloppy and encoded spellings", () => {
    for (const p of [
      "/api",
      "/api/",
      "/api/runs.list",
      "/api/unknown.cmd",
      "//api/runs.list",
      "/api/runs.list/",
      "/%61pi/runs.list",
      "/api%2Fruns.list",
      "/API/runs.list",
    ]) {
      expect(isCommandPath(p), p).toBe(true);
    }
  });

  it("claims every registry-derived path", async () => {
    const { commands } = await fixture();
    for (const cmd of commands.list()) expect(isCommandPath(toSurfaceNames(cmd.id).http)).toBe(true);
  });

  it("leaves other paths alone", () => {
    for (const p of ["/", "/runs", "/runs/abc", "/apiary", "/healthz", "/mcp", "/ingress"])
      expect(isCommandPath(p), p).toBe(false);
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
    // The adapter passes `invoke`'s object through untouched (the same actor: an unlisted browser session holds the group reads and no channel).
    const direct = await commands.invoke(
      "runs.list",
      { options: { status: "all" } },
      callerWith("access", "access:user-1", { actions: new Set(["runs:read"]) }),
    );
    expect(body).toEqual(direct.ok ? direct.value : null);
  });

  it("POST JSON is accepted for a read command; query strings coerce like JSON", async () => {
    const { handler } = await fixture();
    const post = fakeReqRes({
      method: "POST",
      url: "/api/runs.list",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "all", limit: 1 }),
    });
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
    const bad = fakeReqRes({
      method: "POST",
      url: "/api/runs.list",
      headers: { "content-type": "application/json" },
      body: "[1,2",
    });
    await handler(bad.req, bad.res, browser);
    expect(bad.status).toBe(400);
    expect(bad.json().code).toBe("invalid_input");
    const form = fakeReqRes({
      method: "POST",
      url: "/api/runs.list",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "status=all",
    });
    await handler(form.req, form.res, browser);
    expect(form.status).toBe(415);
    expect(form.bodyRead).toBe(false);
  });

  it("an oversized body → 413 without invoking", async () => {
    const { handler } = await fixture({ maxBodyBytes: 8 });
    const t = fakeReqRes({
      method: "POST",
      url: "/api/runs.list",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "all" }),
    });
    await handler(t.req, t.res, browser);
    expect(t.status).toBe(413);
    expect(t.destroyed).toBe(true);
  });
});

describe("createCommandHttpHandler — write safety", () => {
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
    const t = fakeReqRes({
      method: "POST",
      url: "/api/runs.stop",
      body: JSON.stringify({ id: live.id, mode: "soft" }),
    });
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

describe("createCommandHttpHandler — caller resolution", () => {
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

  // Feature: docs/decisions/0053 — a write from a session viewing as a person is refused in the one sentence, whatever the person's grants say.
  it("a session viewing as a person (record 0053) reads on runs.list and is refused POST runs.stop before the body is read with the view-as sentence, not the grant refusal; the same session without the cookie stops the run", async () => {
    const table = { grants: native(OPERATOR_AND_READER), commandGroups: ["runs"] };
    const { handler, reg, live } = await fixture({
      grantsFor: (id) => (id === "access:admin" ? ALL_GRANTS : grantsFor(id, table)),
    });
    const viewing: AccessIdentity = { sub: "admin", viewAs: "slack:UIVY" };
    const list = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all" });
    await handler(list.req, list.res, viewing);
    expect(list.status).toBe(200);
    const stop = stopPost(live.id);
    await handler(stop.req, stop.res, viewing);
    expect(stop.status).toBe(403);
    expect(stop.json()).toEqual({
      error: "You are viewing as slack:UIVY; writes are your own to make — exit view-as to write.",
      code: "unauthorized",
    });
    expect(stop.bodyRead).toBe(false);
    expect(stopNotes(reg, live.id)).toHaveLength(0);
    const own = stopPost(live.id);
    await handler(own.req, own.res, { sub: "admin" });
    expect(own.status).toBe(200);
    expect(stopNotes(reg, live.id)).toHaveLength(1);
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
    const { handler, reg, live } = await fixture({
      grantsFor: (id) =>
        grantsFor(id, {
          grants: native({ "access:svc:ops-bot": { actions: ["runs:read", "runs:write"], channels: "all" } }),
        }),
    });
    const t = stopPost(live.id);
    await handler(t.req, t.res, { sub: "", commonName: "ops-bot" });
    expect(t.status).toBe(200);
    expect((stopNotes(reg, live.id)[0] as { actor?: unknown }).actor).toEqual({
      kind: "access",
      id: "access:svc:ops-bot",
    });
  });
});

describe("createCommandHttpHandler — the Access API is bound by channel visibility (authorization.md items 5–7)", () => {
  /** An operator configured NATIVELY without `channels: all`: every runs action, no channel membership. */
  const nativeOperator: AccessIdentity = { sub: "op-2" };
  const nativeGrants = (id: string) =>
    id === "access:op-2"
      ? { actions: new Set(["runs:read", "runs:write"]), channels: new Set<string>(), repos: new Set<string>() }
      : grantsFor(id, { grants: native(OPERATOR_AND_READER), commandGroups: ["runs"] });

  it("an Access operator without all-channels gets 404 not_found on a private-channel run, byte-identical to a run that does not exist; an operator with all-channels reads it", async () => {
    const { handler } = await fixture({ grantsFor: nativeGrants });
    const priv = fakeReqRes({ method: "GET", url: "/api/runs.get?id=fin-priv" });
    await handler(priv.req, priv.res, nativeOperator);
    expect(priv.status).toBe(404);
    expect(priv.json()).toEqual({ error: "no run found", code: "not_found" });
    const missing = fakeReqRes({ method: "GET", url: "/api/runs.get?id=nope" });
    await handler(missing.req, missing.res, nativeOperator);
    expect(missing.status).toBe(404);
    expect(missing.text()).toBe(priv.text());
    for (const url of ["/api/runs.events?id=fin-priv", "/api/runs.friction?id=fin-priv"]) {
      const t = fakeReqRes({ method: "GET", url });
      await handler(t.req, t.res, nativeOperator);
      expect(t.status, url).toBe(404);
    }
    const asOperator = fakeReqRes({ method: "GET", url: "/api/runs.get?id=fin-priv" });
    await handler(asOperator.req, asOperator.res, operator);
    expect(asOperator.status).toBe(200);
    expect((asOperator.json() as { id: string }).id).toBe("fin-priv");
  });

  it("runs.list from the Access API shows an operator without all-channels only the public runs; an operator and the reader bot with all-channels see the fleet; a browser identity config names nothing for sees the public runs", async () => {
    const { handler, live } = await fixture({ grantsFor: nativeGrants });
    const listed = async (identity: AccessIdentity) => {
      const t = fakeReqRes({ method: "GET", url: "/api/runs.list?status=all" });
      await handler(t.req, t.res, identity);
      expect(t.status).toBe(200);
      return (t.json() as { runs: { id: string }[] }).runs.map((r) => r.id);
    };
    expect(await listed(nativeOperator)).toEqual([live.id, "fin-1"]);
    expect(await listed(operator)).toEqual([live.id, "fin-1", "fin-priv"]);
    expect(await listed(readerBot)).toEqual([live.id, "fin-1", "fin-priv"]);
    expect(await listed(browser)).toEqual([live.id, "fin-1"]);
  });
});

describe("serviceTokenAllowed — a service token is a command-surface credential only", () => {
  it("admits a service token on /api/* (every spelling isCommandPath claims) and nowhere else", () => {
    for (const p of ["/api/runs.list", "/api", "//api/runs.list", "/API/runs.list"])
      expect(serviceTokenAllowed(p, readerBot), p).toBe(true);
    for (const p of [
      "/runs",
      "/runs?all=1",
      "/runs/live-1/events",
      "/runs/live-1/stop",
      "/residents",
      "/costs",
      "/costs.json",
      "/costs/prod",
    ]) {
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

  it("callerFor carries the identity as the Actor the table decides on: browser sub → user access:<sub>, service token → service access:svc:<cn>, grants from the lookup — and the browser session's email beside it, read by no gate", async () => {
    const opts: Pick<CommandHttpOptions, "grantsFor"> = {
      grantsFor: (id) =>
        grantsFor(id, {
          grants: native({
            "access:op-1": { actions: "all", channels: "all", repos: "all" },
            "access:svc:reader-bot": { actions: ["runs:read"], channels: "all" },
          }),
          commandGroups: ["runs"],
        }),
    };
    expect((await callerFor({ sub: "op-1" }, opts)).actor).toEqual({
      kind: "user",
      id: "access:op-1",
      grants: ALL_GRANTS,
    });
    // An unlisted browser session: its baseline (the reads, the two personal chat writes), nothing the adapter added.
    expect((await callerFor(browser, opts)).actor).toEqual({
      kind: "user",
      id: "access:user-1",
      grants: { actions: new Set(["runs:read", "memory:write", "mcp:write"]), channels: new Set(), repos: new Set() },
    });
    expect((await callerFor(readerBot, opts)).actor).toEqual({
      kind: "service",
      id: "access:svc:reader-bot",
      grants: { actions: new Set(["runs:read"]), channels: "all", repos: new Set() },
    });
    expect(await callerFor(browser, opts)).toEqual({
      kind: "access",
      id: "access:user-1",
      actor: (await callerFor(browser, opts)).actor,
      email: "u@example.com",
    });
    // A service token has no email; a session without one carries none.
    expect(await callerFor(readerBot, opts)).not.toHaveProperty("email");
    expect(await callerFor({ sub: "op-1" }, opts)).not.toHaveProperty("email");
    // No lookup knowledge → no grants (fail-closed).
    expect((await callerFor(browser, { grantsFor: () => NO_GRANTS })).actor.grants).toBe(NO_GRANTS);
  });

  // Feature: docs/decisions/0042 — the dashboard link is identity, never authority.
  it("resolveAccessActor links a browser session whose email names a Slack person as a second self id and asUser, with id and grants unchanged; no email, no lookup, no match, a bot, a failure, or a service token → the unlinked actor", async () => {
    const grantsLookup = (id: string) => grantsFor(id, { commandGroups: ["runs"] });
    const people: Record<string, { id: string; name?: string } | undefined> = {
      "alice@example.test": { id: "slack:UALICE", name: "alice" },
      "bot@example.test": undefined,
    };
    const personByEmail = async (email: string) => people[email];
    const alice = { sub: "a1", email: "alice@example.test" };
    const linked = await resolveAccessActor(alice, { grantsFor: grantsLookup, personByEmail });
    const unlinked = accessActor(alice, grantsLookup);
    expect(linked).toEqual({
      ...unlinked,
      self: ["access:a1", "slack:UALICE"],
      asUser: { id: "slack:UALICE", name: "alice" },
    });
    expect(linked.id).toBe("access:a1");
    expect(linked.grants).toEqual(unlinked.grants);
    // Every way to stay unlinked yields exactly today's actor.
    for (const [identity, opts] of [
      [{ sub: "a1" }, { grantsFor: grantsLookup, personByEmail }],
      [alice, { grantsFor: grantsLookup }],
      [
        { sub: "b2", email: "nobody@example.test" },
        { grantsFor: grantsLookup, personByEmail },
      ],
      [
        { sub: "b3", email: "bot@example.test" },
        { grantsFor: grantsLookup, personByEmail },
      ],
      [
        alice,
        {
          grantsFor: grantsLookup,
          personByEmail: async () => {
            throw new Error("slack down");
          },
        },
      ],
      [
        { sub: "", commonName: "svc", email: "alice@example.test" },
        { grantsFor: grantsLookup, personByEmail },
      ],
    ] as const) {
      const actor = await resolveAccessActor(identity, opts);
      expect(actor, JSON.stringify(identity)).toEqual(accessActor(identity, grantsLookup));
      expect(actor.self).toBeUndefined();
    }
    // A person id that is not a chat identity never links either.
    const odd = await resolveAccessActor(alice, {
      grantsFor: grantsLookup,
      personByEmail: async () => ({ id: "http:alice" }),
    });
    expect(odd.self).toBeUndefined();
  });

  // Feature: docs/reference/specs/authorization.md item 7 — the linked person's channels.
  it("resolveAccessActor carries the linked person's channels as memberOf; no lookup, unknown, a failing lookup or an unlinked session carry none, and grants never change", async () => {
    const grantsLookup = (id: string) => grantsFor(id, { commandGroups: ["runs"] });
    const personByEmail = async () => ({ id: "slack:UALICE", name: "alice" });
    const alice = { sub: "a1", email: "alice@example.test" };
    const asked: string[] = [];
    const channelsOf = async (actorId: string) => (asked.push(actorId), new Set(["slack:CPRIV", "slack:CPUB"]));
    const withChannels = await resolveAccessActor(alice, { grantsFor: grantsLookup, personByEmail, channelsOf });
    expect(withChannels.memberOf).toEqual(new Set(["slack:CPRIV", "slack:CPUB"]));
    expect(asked).toEqual(["slack:UALICE"]); // the person's channels, never the session's id
    expect(withChannels.grants).toEqual(accessActor(alice, grantsLookup).grants);
    for (const opts of [
      { grantsFor: grantsLookup, personByEmail },
      { grantsFor: grantsLookup, personByEmail, channelsOf: async (): Promise<"unknown"> => "unknown" },
      {
        grantsFor: grantsLookup,
        personByEmail,
        channelsOf: async (): Promise<ReadonlySet<string>> => {
          throw new Error("slack down");
        },
      },
    ]) {
      const actor = await resolveAccessActor(alice, opts);
      expect(actor).not.toHaveProperty("memberOf");
      expect(actor.self).toEqual(["access:a1", "slack:UALICE"]); // still linked
    }
    const unlinked = await resolveAccessActor({ sub: "a2" }, { grantsFor: grantsLookup, personByEmail, channelsOf });
    expect(unlinked).not.toHaveProperty("memberOf");
    expect(asked).toEqual(["slack:UALICE"]); // an unlinked session asks for nobody
  });

  // Feature: docs/decisions/0053 — a cookie's word narrows an admin and nobody else.
  it("resolveAccessActor with viewAs: a session holding all becomes the admin on behalf of the person — the person's browser-baseline grants, self and directory channels under the admin's id, viewingAs named; anyone else, or a non-person id, resolves exactly as without the cookie", async () => {
    const table = { grants: new Map([["access:admin", ALL_GRANTS]]), commandGroups: ["runs", "config"] };
    const grantsLookup = (id: string) => grantsFor(id, table);
    const asked: string[] = [];
    const channelsOf = async (actorId: string) => (asked.push(actorId), new Set(["slack:CPRIV"]));
    const personName = async (id: string) => (id === "slack:UIVY" ? "ivy" : undefined);
    const personByEmail = async () => ({ id: "slack:UADMIN", name: "admin" });
    const admin = { sub: "admin", email: "admin@example.test", viewAs: "slack:UIVY" };
    const viewing = await resolveAccessActor(admin, { grantsFor: grantsLookup, personByEmail, channelsOf, personName });
    const own = accessActor({ sub: "admin" }, grantsLookup);
    expect(viewing).toEqual({
      ...own,
      onBehalfOf: {
        kind: "user",
        id: "slack:UIVY",
        grants: grantsLookup("access:slack:UIVY"), // the browser baseline, never ivy's Slack grants
        self: ["slack:UIVY"],
        asUser: { id: "slack:UIVY", name: "ivy" },
        memberOf: new Set(["slack:CPRIV"]),
      },
      asUser: { id: "slack:UIVY", name: "ivy" },
      viewingAs: { id: "slack:UIVY", name: "ivy" },
    });
    expect(viewing.id).toBe("access:admin");
    expect(viewing.grants).toEqual(ALL_GRANTS); // the admin's own; the intersection is the person's
    expect(viewing.self).toBeUndefined(); // the admin's own link is not consulted while viewing
    expect(asked).toEqual(["slack:UIVY"]); // the person's channels, never the admin's
    // Without a name lookup or with a failing one, the id stands in.
    const unnamed = await resolveAccessActor(admin, { grantsFor: grantsLookup, channelsOf });
    expect(unnamed.viewingAs).toEqual({ id: "slack:UIVY" });
    const failing = await resolveAccessActor(admin, {
      grantsFor: grantsLookup,
      personName: async () => {
        throw new Error("slack down");
      },
    });
    expect(failing.viewingAs).toEqual({ id: "slack:UIVY" });
    expect(failing.onBehalfOf).not.toHaveProperty("memberOf");
    // A session without `all` carrying the same cookie: its ordinary actor, its own link intact, nobody asked.
    asked.length = 0;
    const alice = { sub: "a1", email: "alice@example.test", viewAs: "slack:UIVY" };
    const aliceByEmail = async () => ({ id: "slack:UALICE", name: "alice" });
    const narrowed = await resolveAccessActor(alice, {
      grantsFor: grantsLookup,
      personByEmail: aliceByEmail,
      channelsOf,
    });
    expect(narrowed).toEqual(
      await resolveAccessActor(
        { sub: "a1", email: "alice@example.test" },
        { grantsFor: grantsLookup, personByEmail: aliceByEmail, channelsOf },
      ),
    );
    expect(narrowed).not.toHaveProperty("viewingAs");
    expect(narrowed.self).toEqual(["access:a1", "slack:UALICE"]);
    // An admin whose cookie names something that is not a Slack person: as if it carried none.
    for (const viewAs of ["access:other", "http:ops", "slack:C123", "", "slack:U<script>"]) {
      const odd = await resolveAccessActor(
        { ...admin, viewAs },
        { grantsFor: grantsLookup, personByEmail, channelsOf },
      );
      expect(odd, viewAs).toEqual(
        await resolveAccessActor(
          { sub: "admin", email: "admin@example.test" },
          { grantsFor: grantsLookup, personByEmail, channelsOf },
        ),
      );
    }
    // A service token never views as anyone.
    const svc = await resolveAccessActor(
      { sub: "", commonName: "ci", viewAs: "slack:UIVY" },
      { grantsFor: grantsLookup },
    );
    expect(svc).not.toHaveProperty("viewingAs");
  });

  it("resolveAccessActor bounds the channels wait: a lookup slower than the bound resolves the linked actor without memberOf, and its late rejection is swallowed", async () => {
    const grantsLookup = (id: string) => grantsFor(id, { commandGroups: ["runs"] });
    const personByEmail = async () => ({ id: "slack:UALICE", name: "alice" });
    const alice = { sub: "a1", email: "alice@example.test" };
    let fail!: (e: Error) => void;
    const slow = new Promise<ReadonlySet<string>>((_, reject) => (fail = reject));
    const late = await resolveAccessActor(alice, {
      grantsFor: grantsLookup,
      personByEmail,
      channelsOf: () => slow,
      channelsOfTimeoutMs: 10,
    });
    expect(late).not.toHaveProperty("memberOf");
    expect(late.self).toEqual(["access:a1", "slack:UALICE"]);
    fail(new Error("slack down, late")); // after the bound: nothing to observe, nothing unhandled
    await new Promise((r) => setTimeout(r, 0));
    // Within the bound the answer rides along.
    const prompt = await resolveAccessActor(alice, {
      grantsFor: grantsLookup,
      personByEmail,
      channelsOf: async () => new Set(["slack:CPRIV"]),
      channelsOfTimeoutMs: 1000,
    });
    expect(prompt.memberOf).toEqual(new Set(["slack:CPRIV"]));
  });

  it("is the id callerFor's Caller carries", async () => {
    const { handler, reg } = await fixture({
      grantsFor: (id) =>
        grantsFor(id, { grants: native({ "access:svc:reader-bot": { actions: ["runs:write"], channels: "all" } }) }),
    });
    const live = reg.create("x", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:x",
    });
    const t = stopPost(live.id);
    await handler(t.req, t.res, readerBot);
    expect(t.status).toBe(200);
    expect((stopNotes(reg, live.id)[0] as { actor?: unknown }).actor).toEqual({
      kind: "access",
      id: callerIdFor(readerBot),
    });
  });
});
