import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { CLI_ACTOR, resolveActor } from "../authz/actor.js";
import { ALL_GRANTS, grantsFor } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import { chatCallerFor } from "../commandChat.js";
import { CommandRegistry, UNTRUSTED_OPEN, type Caller } from "../commandRegistry.js";
import { jsonSchemaFor } from "../commandSurface.js";
import type { IngressTokenMap } from "../ingressTokens.js";
import type { RunEvent } from "../runEvents.js";
import { analyzeRunFriction } from "../runFriction.js";
import type { RunRecord } from "../runRecord.js";
import { RunRegistry } from "../runRegistry.js";
import { InMemoryRunStore } from "../runStore.js";
import { createRunsService } from "../runsService.js";
import { registerRunsCommands, runsCommands, type RunReadDenied, type RunsCommandDeps } from "./runs.js";

// Feature: features/command-registry.md — the `runs.*` registrations (R8/R9,
// KTD17/KTD18) — and features/authorization.md items 5–7 (U3): what a caller
// may SEE is `authorize` / `predicateFor` on its Actor; a denied point read is
// `not_found`; lists are filtered by the store predicate.

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
    channelVisibility: "unknown",
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

/** Four persisted runs across the visibilities the policy distinguishes: two
 *  machine channels, a private Slack group, and a public Slack channel. */
async function setup() {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `id-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record("fin-x", NOW - 1000, { channelId: "mcp:X", channelVisibility: "machine" }));
  await store.put(record("fin-y", NOW - 2000, { channelId: "mcp:Y", channelVisibility: "machine" }));
  await store.put(record("fin-priv", NOW - 3000, { channelId: "slack:G_PRIV", userId: "slack:U9", channelVisibility: "private" }));
  await store.put(record("fin-pub", NOW - 4000, { channelId: "slack:C_PUB", userId: "slack:U9", channelVisibility: "public" }));
  const runs = createRunsService({ registry: reg, store });
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const denied: RunReadDenied[] = [];
  const deps: RunsCommandDeps = { runs: async () => runs, denied: (e) => denied.push(e) };
  return { reg, store, registry, deps, denied };
}

const set = (...names: string[]) => new Set(names);
const actor = (kind: Actor["kind"], id: string, actions: Set<string> | "all", channels: Set<string> | "all"): Actor => ({ kind, id, grants: { actions, channels, repos: set() } });

/** The ingress token map every machine caller below is translated from (`grantsFor`, KTD6). */
const TOKENS: IngressTokenMap = {
  "tok-x": { subject: "x-bot", channel: "X", scopes: ["runs:read", "runs:write"] },
  "tok-ci": { subject: "ci", scopes: ["runs:read", "runs:write"] },
};

const cli: Caller = { kind: "cli", id: "cli:local", scopes: "all", actor: CLI_ACTOR };
/** A machine reader granted every channel natively (an ops token). */
const reader: Caller = { kind: "mcp", id: "mcp:reader", scopes: set("runs:read", "runs:write"), actor: actor("service", "mcp:reader", set("runs:read", "runs:write"), "all") };
/** A token pinned to channel X by its `channel` key: its one channel grant is `mcp:X`. */
const pinnedX: Caller = { kind: "mcp", id: "mcp:x-bot", scopes: set("runs:read", "runs:write"), actor: resolveActor({ surface: "mcp", subjectId: "x-bot" }, (id) => grantsFor(id, { ingressTokens: TOKENS })) };
/** A token WITHOUT a `channel` key: no channel grant at all (OQ4, option a). */
const unpinned: Caller = { kind: "mcp", id: "mcp:ci", scopes: set("runs:read", "runs:write"), actor: resolveActor({ surface: "mcp", subjectId: "ci" }, (id) => grantsFor(id, { ingressTokens: TOKENS })) };
const dispatchOnly: Caller = { kind: "mcp", id: "mcp:agent", scopes: set("dispatch"), actor: actor("service", "mcp:agent", set("dispatch"), set()) };
const chatOperator: Caller = { kind: "chat", id: "slack:UADMIN", scopes: set(), chatGate: () => true, actor: { kind: "user", id: "slack:UADMIN", grants: ALL_GRANTS } };
/** An Access operator configured NATIVELY without `channels: all` (OQ1): every runs action, no channel membership. */
const accessOperator: Caller = { kind: "access", id: "access:op-2", scopes: set("runs:read", "runs:write"), actor: actor("user", "access:op-2", set("runs:read", "runs:write"), set()) };

function value<T>(res: { ok: true; value: unknown } | { ok: false }): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.value as T;
}
const ids = (res: { ok: true; value: unknown } | { ok: false }) => value<{ runs: { id: string }[] }>(res).runs.map((r) => r.id);

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
    expect(out.runs.map((r) => r.id)).toEqual([id, "fin-x", "fin-y", "fin-priv", "fin-pub"]);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/please do the thing|all done|live secret request/);
    expect(json).not.toMatch(/tok-/);
    expect(json).not.toMatch(/"events"/);
  });

  it("status defaults to active (features/run-history.md: active by default, `all` opt-in) — a bare `runs list` equals `--status active`", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("coding · acme/live", { agent: "coding", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
    const bare = await registry.invoke("runs.list", {}, reader, deps);
    expect(bare).toEqual(await registry.invoke("runs.list", { options: { status: "active" } }, reader, deps));
    expect(ids(bare)).toEqual([id]);
    expect(value<{ runs: { id: string }[] }>(await registry.invoke("runs.list", { options: { status: "all" } }, reader, deps)).runs).toHaveLength(5);
  });

  it("limit:'10' (string) and limit:10 yield the same result", async () => {
    const { registry, deps } = await setup();
    const a = await registry.invoke("runs.list", { options: { status: "finished", limit: "10", sinceMs: String(NOW - 2500) } }, reader, deps);
    const b = await registry.invoke("runs.list", { options: { status: "finished", limit: 10, sinceMs: NOW - 2500 } }, reader, deps);
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

  it("passes the actor's predicate to the store and never filters after: the store is asked with `visibleTo`, and `none` never touches it", async () => {
    const { store, registry, deps } = await setup();
    const list = vi.spyOn(store, "list");
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, pinnedX, deps))).toEqual(["fin-x", "fin-pub"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0].visibleTo).toEqual({ kind: "or", of: [{ kind: "channels-in", channelIds: ["mcp:X"] }, { kind: "visibility-in", visibilities: ["public"] }, { kind: "user-is", userId: "mcp:x-bot" }] });
    list.mockClear();
    // An actor the table cannot place (unknown kind) → `none`: no store call, an empty page.
    const bogus: Caller = { ...reader, actor: { kind: "bogus" as Actor["kind"], id: "mcp:reader", grants: ALL_GRANTS } };
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, bogus, deps))).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    // `all` is no constraint: the store's own query is unchanged for an all-channels actor.
    await registry.invoke("runs.list", { options: { status: "all" } }, reader, deps);
    expect(list.mock.calls[0][0]).not.toHaveProperty("visibleTo");
  });
});

describe("channel visibility (authorization.md items 5–7)", () => {
  it("a pinned token sees its channel and the public runs — never another machine channel or a private run — on list (even when asking for another channel) and on get/events/friction/stop (KTD10 preserved, R12 d)", async () => {
    const { reg, registry, deps } = await setup();
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, pinnedX, deps))).toEqual(["fin-x", "fin-pub"]);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all", channel: "mcp:Y" } }, pinnedX, deps))).toEqual([]);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all", channel: "mcp:Y" } }, reader, deps))).toEqual(["fin-y"]);
    for (const cmd of ["runs.get", "runs.events", "runs.friction"]) {
      expect(await registry.invoke(cmd, { args: ["fin-y"], options: {} }, pinnedX, deps)).toMatchObject({ ok: false, error: "not_found" });
      expect(await registry.invoke(cmd, { args: ["fin-priv"], options: {} }, pinnedX, deps)).toMatchObject({ ok: false, error: "not_found" });
      expect(await registry.invoke(cmd, { args: ["fin-x"], options: {} }, pinnedX, deps)).toMatchObject({ ok: true });
    }
    const { id } = reg.create("x", { channelId: "mcp:Y", userId: "mcp:u", threadKey: "mcp:Y:t", channelVisibility: "machine" });
    expect(await registry.invoke("runs.stop", { args: [id], options: { mode: "soft" } }, pinnedX, deps)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("an unpinned token (no `channel` key) holds no channel: it lists NOTHING and gets not_found on every run — R12's fourth deliberate change (OQ4 a)", async () => {
    const { registry, deps } = await setup();
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, unpinned, deps))).toEqual(["fin-pub"]); // the public run only (member-of's public half)
    for (const cmd of ["runs.get", "runs.events", "runs.friction"]) {
      for (const run of ["fin-x", "fin-y", "fin-priv"]) expect(await registry.invoke(cmd, { args: [run], options: {} }, unpinned, deps), `${cmd} ${run}`).toMatchObject({ ok: false, error: "not_found" });
    }
    expect(await registry.invoke("runs.stop", { args: ["fin-x"], options: { mode: "soft" } }, unpinned, deps)).toMatchObject({ ok: false, error: "not_found" });
    // The one thing everyone may read: a run stamped `public` (member-of's public half).
    expect(await registry.invoke("runs.get", { args: ["fin-pub"], options: {} }, unpinned, deps)).toMatchObject({ ok: true });
  });

  it("an unpinned token speaking as TEXT is no longer pinned to the channel it speaks in: `runs list` from channel mcp:X lists nothing (today's per-request pin is gone)", async () => {
    const { registry, deps } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "swb-runs-authz-"));
    writeFileSync(join(dir, "config.yaml"), "providers:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\npermissions:\n  admins: [\"slack:UADMIN\"]\n");
    const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"), () => {}, { ingressTokens: TOKENS, commandGroups: ["runs"] });
    const spokenInX = { ...chatCallerFor({ userId: "mcp:ci", channelId: "mcp:X", threadKey: "mcp:X:t" }, config), chatGate: () => true };
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, spokenInX, deps))).toEqual(["fin-pub"]); // not fin-x: the channel it speaks in grants nothing
    const pinnedSpokenInY = { ...chatCallerFor({ userId: "mcp:x-bot", channelId: "mcp:Y", threadKey: "mcp:Y:t" }, config), chatGate: () => true };
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, pinnedSpokenInY, deps))).toEqual(["fin-x", "fin-pub"]); // its grant, not the channel it speaks in
  });

  it("an Access operator without all-channels gets not_found outside their channels — a private Slack run is invisible on get/events/friction; the public run and their own are not (R12 b)", async () => {
    const { registry, deps, denied } = await setup();
    for (const cmd of ["runs.get", "runs.events", "runs.friction"]) {
      const res = await registry.invoke(cmd, { args: ["fin-priv"], options: {} }, accessOperator, deps);
      expect(res, cmd).toMatchObject({ ok: false, error: "not_found", status: 404 });
      // Byte-identical to a run that does not exist.
      expect(res).toEqual(await registry.invoke(cmd, { args: ["nope"], options: {} }, accessOperator, deps));
    }
    expect(await registry.invoke("runs.get", { args: ["fin-pub"], options: {} }, accessOperator, deps)).toMatchObject({ ok: true });
    // The deny reason reaches the audit sink only — never the reply.
    expect(denied).toEqual([
      { commandId: "runs.get", actorId: "access:op-2", action: "runs:read", reason: "not-member" },
      { commandId: "runs.events", actorId: "access:op-2", action: "runs:read", reason: "not-member" },
      { commandId: "runs.friction", actorId: "access:op-2", action: "runs:read", reason: "not-member" },
    ]);
  });

  it("an Access operator without all-channels lists only public and granted runs; an admin lists the fleet", async () => {
    const { registry, deps } = await setup();
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, accessOperator, deps))).toEqual(["fin-pub"]);
    const granted: Caller = { ...accessOperator, actor: actor("user", "access:op-2", set("runs:read", "runs:write"), set("slack:G_PRIV")) };
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, granted, deps))).toEqual(["fin-priv", "fin-pub"]);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, chatOperator, deps))).toEqual(["fin-x", "fin-y", "fin-priv", "fin-pub"]);
  });

  it("a run is its user's own: the DM/private run's user reads it without a channel grant (is-self); a caller without an actor holds NO_GRANTS and sees the public run only", async () => {
    const { registry, deps } = await setup();
    const owner: Caller = { kind: "access", id: "access:u9", scopes: set("runs:read"), actor: actor("user", "slack:U9", set("runs:read"), set()) };
    expect(await registry.invoke("runs.get", { args: ["fin-priv"], options: {} }, owner, deps)).toMatchObject({ ok: true });
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, owner, deps))).toEqual(["fin-priv", "fin-pub"]);
    const actorless: Caller = { kind: "mcp", id: "mcp:ghost", scopes: set("runs:read") };
    expect(await registry.invoke("runs.get", { args: ["fin-x"], options: {} }, actorless, deps)).toMatchObject({ ok: false, error: "not_found" });
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, actorless, deps))).toEqual(["fin-pub"]);
  });

  it("a live run without a stamp is `unknown` — never public: only a channel grant, all-channels, or its own user reads it", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("x", { channelId: "slack:C_PUB", userId: "slack:U1", threadKey: "slack:C_PUB:t" });
    expect(await registry.invoke("runs.get", { args: [id], options: {} }, accessOperator, deps)).toMatchObject({ ok: false, error: "not_found" });
    expect(await registry.invoke("runs.get", { args: [id], options: {} }, reader, deps)).toMatchObject({ ok: true });
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

  it("runs.get fetches the run once — the authorization check reuses the payload's view", async () => {
    const { registry, deps } = await setup();
    const getRun = vi.spyOn(await deps.runs(), "getRun");
    const out = value<{ id: string; events?: unknown[] }>(await registry.invoke("runs.get", { args: ["fin-x"], options: { include: "messages" } }, pinnedX, deps));
    expect(out.id).toBe("fin-x");
    expect(out.events).toHaveLength(4);
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledWith("fin-x", { include: "messages" });
  });

  it("every handler resolves the `runs` accessor exactly once per invocation (#409, F1)", async () => {
    const { registry, deps, reg } = await setup();
    const live = reg.create("coding · acme/live", { agent: "coding", channelId: "mcp:X", userId: "mcp:u", threadKey: "mcp:X:t", channelVisibility: "machine" });
    let resolved = 0;
    const counted: RunsCommandDeps = {
      runs: () => {
        resolved++;
        return deps.runs();
      },
    };
    const invocations: [string, { args?: string[]; options?: Record<string, string> }][] = [
      ["runs.list", {}],
      ["runs.get", { args: ["fin-x"] }],
      ["runs.events", { args: ["fin-x"] }],
      ["runs.friction", { args: ["fin-x"] }],
      ["runs.stop", { args: [live.id], options: { mode: "soft" } }],
    ];
    for (const [id, input] of invocations) {
      resolved = 0;
      expect((await registry.invoke(id, input, pinnedX, counted)).ok).toBe(true);
      expect(resolved, id).toBe(1);
    }
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

  it("stopping needs runs:write AND visibility: a reader without the write grant is refused by the registry, a writer outside the channel gets not_found", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("x", { channelId: "mcp:Y", userId: "mcp:u", threadKey: "mcp:Y:t", channelVisibility: "machine" });
    expect(await registry.invoke("runs.stop", { args: [id], options: { mode: "soft" } }, pinnedX, deps)).toMatchObject({ ok: false, error: "not_found" });
    const writerY: Caller = { kind: "mcp", id: "mcp:y-bot", scopes: set("runs:read", "runs:write"), actor: actor("service", "mcp:y-bot", set("runs:read", "runs:write"), set("mcp:Y")) };
    expect(await registry.invoke("runs.stop", { args: [id], options: { mode: "soft" } }, writerY, deps)).toMatchObject({ ok: true });
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
