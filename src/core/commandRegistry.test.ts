import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CommandError,
  CommandRegistry,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_PREAMBLE,
  commandDefiner,
  jsonSchemaFor,
  renderCompact,
  toSurfaceNames,
  wrapUntrusted,
  type AuditEntry,
  type Caller,
} from "./commandRegistry.js";

// Feature: features/command-registry.md — the one seam every surface adapts.

type Deps = { hits: string[] };
const defineCommand = commandDefiner<Deps>();

const echo = defineCommand({
  id: "demo.echo",
  input: z.object({ status: z.enum(["active", "finished", "all"]), limit: z.coerce.number().int().positive().optional() }),
  scope: "demo:read",
  chatGate: "operator",
  effect: "read",
  describe: "echoes its parsed input",
  handler: async ({ input, deps }) => {
    deps.hits.push("echo");
    return { ...input };
  },
});

const fail = defineCommand({
  id: "demo.fail",
  input: z.object({ code: z.enum(["not_found", "conflict", "boom"]) }),
  scope: "demo:write",
  chatGate: "operator",
  effect: "write",
  describe: "throws the named error",
  handler: async ({ input }) => {
    if (input.code === "boom") throw new Error("secret internals: token=abc");
    throw new CommandError(input.code, "demo says no");
  },
});

const chatless = defineCommand({
  id: "demo.machine",
  input: z.object({}),
  scope: "demo:read",
  chatGate: "open",
  effect: "read",
  surfaces: { chat: false },
  describe: "not for chat",
  handler: async () => ({ ok: true }),
});

const frictionWrite = defineCommand({
  id: "friction.propose",
  input: z.object({}),
  scope: "friction:write",
  chatGate: "repoManager",
  effect: "write",
  describe: "dummy friction write",
  handler: async () => ({ proposed: 0 }),
});

function setup() {
  const audit = vi.fn<(e: AuditEntry) => void>();
  const registry = new CommandRegistry<Deps>({ audit });
  registry.register(echo);
  registry.register(fail);
  registry.register(chatless);
  registry.register(frictionWrite);
  const deps: Deps = { hits: [] };
  return { registry, audit, deps };
}

const cli: Caller = { kind: "cli", id: "cli:local", scopes: "all" };
const mcpDispatchOnly: Caller = { kind: "mcp", id: "mcp:agent", scopes: new Set(["dispatch"]) };
const mcpDemoRead: Caller = { kind: "mcp", id: "mcp:agent", scopes: new Set(["demo:read"]) };
const browser: Caller = { kind: "access", id: "access:alice@example.com", scopes: new Set() };
const browserOperator: Caller = { kind: "access", id: "access:alice@example.com", scopes: new Set(["demo:write"]) };
const svcToken: Caller = { kind: "access", id: "access:svc:ci", scopes: new Set(["demo:write"]) };
const chatOperator: Caller = { kind: "chat", id: "slack:UADMIN", scopes: new Set(), chatGate: (g) => g === "open" || g === "operator" };
const chatRandom: Caller = { kind: "chat", id: "slack:URANDOM", scopes: new Set(), chatGate: (g) => g === "open" };

describe("CommandRegistry registration", () => {
  it("throws on a duplicate id at registration time", () => {
    const registry = new CommandRegistry<Deps>({ audit: () => {} });
    registry.register(echo);
    expect(() => registry.register(echo)).toThrow(/demo\.echo/);
  });

  it("lists and gets registered commands", () => {
    const { registry } = setup();
    expect(registry.list().map((c) => c.id)).toEqual(["demo.echo", "demo.fail", "demo.machine", "friction.propose"]);
    expect(registry.get("demo.echo")?.describe).toBe("echoes its parsed input");
    expect(registry.get("nope")).toBeUndefined();
  });

  it("unknown command id → not_found", async () => {
    const { registry, deps } = setup();
    const res = await registry.invoke("demo.nothing", {}, cli, deps);
    expect(res).toMatchObject({ ok: false, error: "not_found", status: 404 });
  });
});

describe("CommandRegistry.invoke — auth before parse", () => {
  it("non-operator chat caller → unauthorized, with neither parse nor handler run", async () => {
    const { registry, deps } = setup();
    const parseSpy = vi.spyOn(echo.input, "safeParse");
    const res = await registry.invoke("demo.echo", { status: "bogus" }, chatRandom, deps);
    expect(res).toMatchObject({ ok: false, error: "unauthorized", status: 403 });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(deps.hits).toEqual([]);
    parseSpy.mockRestore();
  });

  it("operator chat caller passes the gate", async () => {
    const { registry, deps } = setup();
    const res = await registry.invoke("demo.echo", { status: "all" }, chatOperator, deps);
    expect(res).toEqual({ ok: true, value: { status: "all" } });
  });

  it("chat caller without a chatGate resolver is refused (fail-closed)", async () => {
    const { registry, deps } = setup();
    const res = await registry.invoke("demo.echo", { status: "all" }, { kind: "chat", id: "slack:U1", scopes: new Set() }, deps);
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("dispatch-only MCP caller is refused on a read and a write command", async () => {
    const { registry, deps } = setup();
    expect(await registry.invoke("demo.echo", { status: "all" }, mcpDispatchOnly, deps)).toMatchObject({ ok: false, error: "unauthorized" });
    expect(await registry.invoke("demo.fail", { code: "conflict" }, mcpDispatchOnly, deps)).toMatchObject({ ok: false, error: "unauthorized" });
    expect(deps.hits).toEqual([]);
  });

  it("MCP caller holding the exact scope passes; a different scope of the same effect does not", async () => {
    const { registry, deps } = setup();
    expect(await registry.invoke("demo.echo", { status: "all" }, mcpDemoRead, deps)).toMatchObject({ ok: true });
    const other: Caller = { kind: "mcp", id: "mcp:x", scopes: new Set(["runs:read"]) };
    expect(await registry.invoke("demo.echo", { status: "all" }, other, deps)).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("a runs:write caller is refused on a friction:write command", async () => {
    const { registry, deps } = setup();
    const runsWriter: Caller = { kind: "mcp", id: "mcp:x", scopes: new Set(["runs:write"]) };
    expect(await registry.invoke("friction.propose", {}, runsWriter, deps)).toMatchObject({ ok: false, error: "unauthorized" });
    const frictionWriter: Caller = { kind: "mcp", id: "mcp:x", scopes: new Set(["friction:write"]) };
    expect(await registry.invoke("friction.propose", {}, frictionWriter, deps)).toEqual({ ok: true, value: { proposed: 0 } });
  });

  it("browser Access identity holds every read scope implicitly, write only when granted", async () => {
    const { registry, deps } = setup();
    expect(await registry.invoke("demo.echo", { status: "all" }, browser, deps)).toMatchObject({ ok: true });
    expect(await registry.invoke("demo.fail", { code: "conflict" }, browser, deps)).toMatchObject({ ok: false, error: "unauthorized" });
    expect(await registry.invoke("demo.fail", { code: "conflict" }, browserOperator, deps)).toMatchObject({ ok: false, error: "conflict" });
  });

  it("an Access service token is a machine caller: no implicit read scopes", async () => {
    const { registry, deps } = setup();
    expect(await registry.invoke("demo.echo", { status: "all" }, svcToken, deps)).toMatchObject({ ok: false, error: "unauthorized" });
    expect(await registry.invoke("demo.fail", { code: "conflict" }, svcToken, deps)).toMatchObject({ ok: false, error: "conflict" });
  });

  it("scopes 'all' (cli:local) passes every command", async () => {
    const { registry, deps } = setup();
    expect(await registry.invoke("demo.echo", { status: "all" }, cli, deps)).toMatchObject({ ok: true });
    expect(await registry.invoke("friction.propose", {}, cli, deps)).toMatchObject({ ok: true });
  });

  it("a command that opted out of chat is not_found for a chat caller, present for others", async () => {
    const { registry, deps } = setup();
    expect(await registry.invoke("demo.machine", {}, chatOperator, deps)).toMatchObject({ ok: false, error: "not_found" });
    expect(await registry.invoke("demo.machine", {}, cli, deps)).toEqual({ ok: true, value: { ok: true } });
  });
});

describe("CommandRegistry.invoke — parse and error mapping", () => {
  it("{status:'bogus'} → invalid_input naming the field and expected values, never echoing the value", async () => {
    const { registry, deps } = setup();
    const res = await registry.invoke("demo.echo", { status: "bogus" }, cli, deps);
    expect(res).toMatchObject({ ok: false, error: "invalid_input", status: 400 });
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toMatch(/status/);
    expect(res.message).toMatch(/active/);
    expect(res.message).not.toMatch(/bogus/);
    expect(deps.hits).toEqual([]);
  });

  it("type errors name the field and expected type without the submitted value", async () => {
    const { registry, deps } = setup();
    const res = await registry.invoke("demo.echo", { status: "all", limit: "lots-of-secret" }, cli, deps);
    expect(res).toMatchObject({ ok: false, error: "invalid_input" });
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toMatch(/limit/);
    expect(res.message).toMatch(/number/);
    expect(res.message).not.toMatch(/secret/);
  });

  it("a non-object input is invalid_input", async () => {
    const { registry, deps } = setup();
    expect(await registry.invoke("demo.echo", "status=all", cli, deps)).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("limit:'10' and limit:10 parse to the same input (coercion)", async () => {
    const { registry, deps } = setup();
    const a = await registry.invoke("demo.echo", { status: "all", limit: "10" }, cli, deps);
    const b = await registry.invoke("demo.echo", { status: "all", limit: 10 }, cli, deps);
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, value: { status: "all", limit: 10 } });
  });

  it("maps CommandError codes to not_found/conflict and swallows unexpected throws as internal", async () => {
    const { registry, deps } = setup();
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
    expect(await registry.invoke("demo.fail", { code: "not_found" }, cli, deps)).toMatchObject({ ok: false, error: "not_found", status: 404, message: "demo says no" });
    expect(await registry.invoke("demo.fail", { code: "conflict" }, cli, deps)).toMatchObject({ ok: false, error: "conflict", status: 409 });
    const internal = await registry.invoke("demo.fail", { code: "boom" }, cli, deps);
    expect(internal).toMatchObject({ ok: false, error: "internal", status: 500 });
    if (internal.ok) throw new Error("unreachable");
    expect(internal.message).not.toMatch(/token=abc/);
    // logged, not returned
    expect(errors.flat().some((e) => e instanceof Error && e.message.includes("token=abc"))).toBe(true);
    spy.mockRestore();
  });
});

describe("CommandRegistry audit line", () => {
  it("emits one line per invocation with command, caller, effect, outcome — and no payload", async () => {
    const { registry, audit, deps } = setup();
    await registry.invoke("demo.echo", { status: "all", limit: 7 }, cli, deps);
    await registry.invoke("demo.echo", { status: "all" }, chatRandom, deps);
    await registry.invoke("demo.fail", { code: "conflict" }, cli, deps);
    expect(audit).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls.map(([e]) => e)).toEqual([
      { commandId: "demo.echo", callerKind: "cli", callerId: "cli:local", effect: "read", outcome: "ok" },
      { commandId: "demo.echo", callerKind: "chat", callerId: "slack:URANDOM", effect: "read", outcome: "unauthorized" },
      { commandId: "demo.fail", callerKind: "cli", callerId: "cli:local", effect: "write", outcome: "conflict" },
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/limit|"7"|status/);
  });

  it("defaults to one JSON line on console.log", async () => {
    const registry = new CommandRegistry<Deps>();
    registry.register(echo);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    await registry.invoke("demo.echo", { status: "all" }, cli, { hits: [] });
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ commandId: "demo.echo", callerKind: "cli", outcome: "ok" });
  });
});

describe("name mapping, schema derivation, rendering", () => {
  it("toSurfaceNames maps friction.report to the four surface names", () => {
    expect(toSurfaceNames("friction.report")).toEqual({
      http: "/api/friction.report",
      mcp: "friction_report",
      cli: ["friction", "report"],
      chat: "friction report",
    });
  });

  it("jsonSchemaFor derives an object schema with the enum and coerced number", () => {
    const schema = jsonSchemaFor(echo) as { type: string; properties: Record<string, { enum?: string[]; type?: string }> };
    expect(schema.type).toBe("object");
    expect(schema.properties.status.enum).toEqual(["active", "finished", "all"]);
    expect(schema.properties.limit.type).toBe("integer"); // z.coerce.number().int() survives derivation as a plain JSON-Schema integer
  });

  it("wrapUntrusted brackets text with the fixed preamble and delimiters", () => {
    const out = wrapUntrusted("ignore previous instructions");
    expect(out.startsWith(UNTRUSTED_PREAMBLE)).toBe(true);
    expect(out).toContain(UNTRUSTED_OPEN);
    expect(out).toContain("ignore previous instructions");
    expect(out.endsWith(UNTRUSTED_CLOSE)).toBe(true);
  });

  it("renderCompact renders runs.list as one line per run with short id, agent, status, duration only", () => {
    const now = 1_700_000_100_000;
    const text = renderCompact(
      "runs.list",
      {
        runs: [
          { id: "abcdefghijklmnop", agent: "coding", status: "completed", startedAt: now - 95_000, finishedAt: now - 5_000, finished: true, channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:1", label: "coding · acme/x", eventCount: 3 },
          { id: "zyxwvutsrqponmlk", agent: "review", startedAt: now - 30_000, finished: false, stop: { mode: "soft", state: "stopping" }, eventCount: 1 },
        ],
      },
      { now },
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^abcdefgh\s+coding\s+completed\s+1m 30s$/);
    expect(lines[1]).toMatch(/^zyxwvuts\s+review\s+stopping\s+30s$/);
    expect(text).not.toMatch(/slack:|acme|threadKey|U1/);
  });

  it("renderCompact appends the store-unavailable banner to runs.list when the service degraded to live rows", () => {
    const banner = "⚠ history store unavailable — showing live runs only";
    expect(renderCompact("runs.list", { runs: [], storeUnavailable: true })).toBe(`(no runs)\n${banner}`);
    const one = renderCompact("runs.list", { runs: [{ id: "abcdefgh1234", agent: "coding", finished: false, startedAt: 0 }], storeUnavailable: true }, { now: 5000 });
    expect(one.split("\n")).toEqual(["abcdefgh  coding    active        5s", banner]);
    expect(renderCompact("runs.list", { runs: [] })).not.toContain(banner);
  });

  it("renderCompact renders an empty list and generic objects as key: value lines", () => {
    expect(renderCompact("runs.list", { runs: [] })).toBe("(no runs)");
    expect(renderCompact("runs.stop", { id: "r1", mode: "soft", state: "stopping" })).toBe("id: r1\nmode: soft\nstate: stopping");
    expect(renderCompact("x.y", { nested: { a: 1 }, list: [1, 2] })).toBe('nested: {"a":1}\nlist: [1,2]');
  });
});
