import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, UNTRUSTED_OPEN, type Caller } from "../commandRegistry.js";
import { jsonSchemaFor } from "../commandSurface.js";
import type { RunEvent } from "../runEvents.js";
import { analyzeRunFriction } from "../runFriction.js";
import type { RunRecord } from "../runRecord.js";
import { RunRegistry } from "../runRegistry.js";
import { InMemoryRunStore } from "../runStore.js";
import { createRunsService } from "../runsService.js";
import { registerRunsCommands, runsCommands, type RunsCommandDeps } from "./runs.js";

// Feature: features/command-registry.md — the `runs.*` registrations (R8/R9, KTD17/KTD18).

const NOW = 1_700_000_000_000;

function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = over.events ?? [
    { type: "input", text: "please do the thing", seq: 1 },
    { type: "tool_call", tool: "bash", summary: "$ ls", seq: 2 },
    { type: "tool_result", tool: "bash", ok: true, summary: "a b c", seq: 3 },
    { type: "answer", text: "all done", seq: 4 },
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
    ...over,
  };
}

async function setup() {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `id-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record("fin-x", NOW - 1000, { channelId: "http:X" }));
  await store.put(record("fin-y", NOW - 2000, { channelId: "http:Y" }));
  const runs = createRunsService({ registry: reg, store });
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const deps: RunsCommandDeps = { runs };
  return { reg, store, registry, deps };
}

const cli: Caller = { kind: "cli", id: "cli:local", scopes: "all" };
const reader: Caller = { kind: "mcp", id: "mcp:reader", scopes: new Set(["runs:read", "runs:write"]) };
const readerPinnedX: Caller = { kind: "access", id: "access:svc:x-bot", scopes: new Set(["runs:read", "runs:write"]), channel: "http:X" };
const dispatchOnly: Caller = { kind: "mcp", id: "mcp:agent", scopes: new Set(["dispatch"]) };
const chatOperator: Caller = { kind: "chat", id: "slack:UADMIN", scopes: new Set(), chatGate: () => true };

function value<T>(res: { ok: true; value: unknown } | { ok: false }): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.value as T;
}

describe("runs.* registrations", () => {
  it("registers the five commands with the declared scopes, gates, and chat opt-outs", () => {
    const byId = Object.fromEntries(runsCommands.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(["runs.events", "runs.friction", "runs.get", "runs.list", "runs.stop"]);
    for (const id of ["runs.list", "runs.get", "runs.events", "runs.friction"]) {
      expect(byId[id].scope).toBe("runs:read");
      expect(byId[id].effect).toBe("read");
      expect(byId[id].chatGate).toBe("operator");
    }
    expect(byId["runs.stop"]).toMatchObject({ scope: "runs:write", effect: "write", chatGate: "operator" });
    expect(byId["runs.list"].surfaces?.chat).toBeUndefined();
    for (const id of ["runs.get", "runs.events", "runs.friction"]) expect(byId[id].surfaces?.chat).toBe(false);
  });

  it("jsonSchemaFor(runs.list) has a three-value status enum", () => {
    const schema = jsonSchemaFor(runsCommands.find((c) => c.id === "runs.list")!) as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.status.enum).toEqual(["active", "finished", "all"]);
  });

  it("a dispatch-only MCP caller is refused on runs.list and runs.stop", async () => {
    const { registry, deps } = await setup();
    expect(await registry.invoke("runs.list", { options: { status: "all" } }, dispatchOnly, deps)).toMatchObject({ ok: false, error: "unauthorized" });
    expect(await registry.invoke("runs.stop", { args: ["fin-x"], options: { mode: "soft" } }, dispatchOnly, deps)).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("chat callers can list but not get/events/friction (surface opt-out)", async () => {
    const { registry, deps } = await setup();
    expect(await registry.invoke("runs.list", { options: { status: "all" } }, chatOperator, deps)).toMatchObject({ ok: true });
    expect(await registry.invoke("runs.get", { args: ["fin-x"], options: {} }, chatOperator, deps)).toMatchObject({ ok: false, error: "not_found" });
    expect(await registry.invoke("runs.events", { args: ["fin-x"], options: {} }, chatOperator, deps)).toMatchObject({ ok: false, error: "not_found" });
    expect(await registry.invoke("runs.friction", { args: ["fin-x"], options: {} }, chatOperator, deps)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("runs.list", () => {
  it("returns metadata only: no message text, no token", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("coding · acme/live", { agent: "coding", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
    reg.publish(id, { type: "input", text: "live secret request" });
    const out = value<{ runs: { id: string }[] }>(await registry.invoke("runs.list", { options: { status: "all" } }, reader, deps));
    expect(out.runs.map((r) => r.id)).toEqual([id, "fin-x", "fin-y"]);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/please do the thing|all done|live secret request/);
    expect(json).not.toMatch(/tok-/);
    expect(json).not.toMatch(/"events"/);
  });

  it("limit:'10' (string) and limit:10 yield the same result", async () => {
    const { registry, deps } = await setup();
    const a = await registry.invoke("runs.list", { options: { status: "finished", limit: "10", sinceMs: String(NOW - 5000) } }, reader, deps);
    const b = await registry.invoke("runs.list", { options: { status: "finished", limit: 10, sinceMs: NOW - 5000 } }, reader, deps);
    expect(a).toEqual(b);
    expect(value<{ runs: unknown[] }>(a).runs).toHaveLength(2);
  });

  it("{status:'bogus'} → invalid_input naming status without echoing the value", async () => {
    const { registry, deps } = await setup();
    const res = await registry.invoke("runs.list", { options: { status: "bogus" } }, reader, deps);
    expect(res).toMatchObject({ ok: false, error: "invalid_input" });
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toMatch(/status/);
    expect(res.message).not.toMatch(/bogus/);
  });

  it("a channel-pinned caller sees only its channel's runs, even when asking for another", async () => {
    const { registry, deps } = await setup();
    const pinned = value<{ runs: { id: string }[] }>(await registry.invoke("runs.list", { options: { status: "all" } }, readerPinnedX, deps));
    expect(pinned.runs.map((r) => r.id)).toEqual(["fin-x"]);
    const other = value<{ runs: { id: string }[] }>(await registry.invoke("runs.list", { options: { status: "all", channel: "http:Y" } }, readerPinnedX, deps));
    expect(other.runs).toEqual([]);
    const unpinned = value<{ runs: { id: string }[] }>(await registry.invoke("runs.list", { options: { status: "all", channel: "http:Y" } }, reader, deps));
    expect(unpinned.runs.map((r) => r.id)).toEqual(["fin-y"]);
  });
});

describe("runs.get / runs.events / runs.friction", () => {
  it("unknown id → not_found; malformed id → invalid_input naming id", async () => {
    const { registry, deps } = await setup();
    expect(await registry.invoke("runs.get", { args: ["nope"], options: {} }, reader, deps)).toMatchObject({ ok: false, error: "not_found", status: 404 });
    const bad = await registry.invoke("runs.get", { args: ["has spaces!"], options: {} }, reader, deps);
    expect(bad).toMatchObject({ ok: false, error: "invalid_input" });
    if (bad.ok) throw new Error("unreachable");
    expect(bad.message).toMatch(/\bid\b/);
    expect(bad.message).not.toMatch(/spaces/);
  });

  it("runs.get without include returns no events; include=messages wraps every text field as untrusted", async () => {
    const { registry, deps } = await setup();
    const bare = value<{ events?: unknown }>(await registry.invoke("runs.get", { args: ["fin-x"], options: {} }, reader, deps));
    expect(bare.events).toBeUndefined();
    const full = value<{ events: RunEvent[] }>(await registry.invoke("runs.get", { args: ["fin-x"], options: { include: "messages" } }, reader, deps));
    expect(full.events).toHaveLength(4);
    for (const e of full.events) {
      if (e.type === "input" || e.type === "context" || e.type === "answer" || e.type === "assistant") expect(e.text).toContain(UNTRUSTED_OPEN);
      if (e.type === "tool_call" || e.type === "tool_result") expect(e.summary).toContain(UNTRUSTED_OPEN);
    }
    expect(JSON.stringify(full)).toContain("please do the thing");
    expect(JSON.stringify(full)).not.toMatch(/tok-/);
  });

  it("runs.events pages with afterSeq/limit (coerced) and wraps text", async () => {
    const { registry, deps } = await setup();
    const page = value<{ events: RunEvent[]; nextAfterSeq?: number }>(await registry.invoke("runs.events", { args: ["fin-x"], options: { afterSeq: "1", limit: "2" } }, reader, deps));
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page.nextAfterSeq).toBe(3);
    expect((page.events[0] as { summary: string }).summary).toContain(UNTRUSTED_OPEN);
  });

  it("runs.friction returns the stored diagnosis", async () => {
    const { registry, deps } = await setup();
    const out = value<{ id: string; finished: boolean; diagnosis: { verdict: string } }>(await registry.invoke("runs.friction", { args: ["fin-x"], options: {} }, reader, deps));
    expect(out).toMatchObject({ id: "fin-x", finished: true });
    expect(typeof out.diagnosis.verdict).toBe("string");
  });

  it("a channel-pinned caller gets not_found for another channel's run on get/events/friction", async () => {
    const { registry, deps } = await setup();
    for (const cmd of ["runs.get", "runs.events", "runs.friction"]) {
      expect(await registry.invoke(cmd, { args: ["fin-y"], options: {} }, readerPinnedX, deps)).toMatchObject({ ok: false, error: "not_found" });
      expect(await registry.invoke(cmd, { args: ["fin-x"], options: {} }, readerPinnedX, deps)).toMatchObject({ ok: true });
    }
  });

  it("a channel-pinned runs.get fetches the run once — the visibility check reuses the payload's view", async () => {
    const { registry, deps } = await setup();
    const getRun = vi.spyOn(deps.runs, "getRun");
    const out = value<{ id: string; events?: unknown[] }>(await registry.invoke("runs.get", { args: ["fin-x"], options: { include: "messages" } }, readerPinnedX, deps));
    expect(out.id).toBe("fin-x");
    expect(out.events).toHaveLength(4);
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledWith("fin-x", { include: "messages" });
  });
});

describe("runs.stop", () => {
  it("finished run → conflict; unknown → not_found", async () => {
    const { registry, deps } = await setup();
    expect(await registry.invoke("runs.stop", { args: ["fin-x"], options: { mode: "soft" } }, cli, deps)).toMatchObject({ ok: false, error: "conflict", status: 409 });
    expect(await registry.invoke("runs.stop", { args: ["nope"], options: { mode: "soft" } }, cli, deps)).toMatchObject({ ok: false, error: "not_found", status: 404 });
  });

  it("stops a live run and records the caller as the structured actor", async () => {
    const { reg, registry, deps } = await setup();
    const { id, token } = reg.create("coding · acme/live", { agent: "coding", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
    const res = await registry.invoke("runs.stop", { args: [id], options: { mode: "hard" } }, reader, deps);
    expect(res).toEqual({ ok: true, value: { id, mode: "hard", state: "stopping" } });
    const snap = reg.snapshot(id, token)!;
    const note = snap.events.find((e) => e.type === "run_note" && e.kind === "stop_requested") as Extract<RunEvent, { type: "run_note" }>;
    expect(note.actor).toEqual({ kind: "mcp", id: "mcp:reader" });
  });

  it("a channel-pinned caller cannot stop another channel's run", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("x", { channelId: "http:Y", userId: "http:u", threadKey: "http:Y:t" });
    expect(await registry.invoke("runs.stop", { args: [id], options: { mode: "soft" } }, readerPinnedX, deps)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("mode is required and must be soft|hard", async () => {
    const { registry, deps } = await setup();
    const res = await registry.invoke("runs.stop", { args: ["fin-x"], options: { mode: "nuke" } }, cli, deps);
    expect(res).toMatchObject({ ok: false, error: "invalid_input" });
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toMatch(/mode/);
    expect(res.message).not.toMatch(/nuke/);
  });
});
