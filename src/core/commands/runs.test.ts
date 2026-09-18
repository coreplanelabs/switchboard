import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { CLI_ACTOR, resolveActor } from "../authz/actor.js";
import { ALL_GRANTS, grantsFor, parseGrantsConfig } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import { chatCallerFor } from "../commandChat.js";
import { CommandRegistry, renderText, UNTRUSTED_OPEN, type Caller } from "../commandRegistry.js";
import type { ChatMessage } from "../chatMessage.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { callerWith } from "../testing/callers.js";
import { jsonSchemaFor } from "../commandSurface.js";
import type { RunEvent } from "../runEvents.js";
import { analyzeRunFriction } from "../runFriction.js";
import type { RunRecord } from "../runRecord.js";
import { RunRegistry } from "../runRegistry.js";
import { InMemoryRunStore } from "../runStore.js";
import { createRunsService } from "../runsService.js";
import { registerRunsCommands, runsCommands, type RunReadDenied, type RunsCommandDeps, wrapEvent } from "./runs.js";

// Feature: docs/reference/specs/command-registry.md — the `runs.*` registrations — and
// docs/reference/specs/authorization.md items 5–7: what a caller
// may SEE is `authorize` / `predicateFor` on its Actor; a denied point read is
// `not_found`; lists are filtered by the store predicate.

const NOW = 1_700_000_000_000;

function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = over.events ?? [
    { type: "input", messageId: "m1", text: "please do the thing", seq: 1 },
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
    userId: "slack:UALICE",
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
  await store.put(
    record("fin-priv", NOW - 3000, { channelId: "slack:G_PRIV", userId: "slack:UIVY", channelVisibility: "private" }),
  );
  await store.put(
    record("fin-pub", NOW - 4000, { channelId: "slack:C_PUB", userId: "slack:UIVY", channelVisibility: "public" }),
  );
  const runs = createRunsService({ registry: reg, store });
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const denied: RunReadDenied[] = [];
  const deps: RunsCommandDeps = { runs: async () => runs, denied: (e) => denied.push(e) };
  return { reg, store, registry, deps, denied };
}

const set = (...names: string[]) => new Set(names);
const actor = (
  kind: Actor["kind"],
  id: string,
  actions: Set<string> | "all",
  channels: Set<string> | "all",
): Actor => ({ kind, id, grants: { actions, channels, repos: set() } });

/** Config's grants for the machine callers below (`grantsFor`): x-bot is granted its one channel, ci none. */
const MACHINE_GRANTS = {
  "mcp:x-bot": { actions: ["runs:read", "runs:write"], channels: ["mcp:X"] },
  "mcp:ci": { actions: ["runs:read", "runs:write"] },
};
const machineGrants = parseGrantsConfig(MACHINE_GRANTS);
if (!machineGrants.ok) throw new Error(machineGrants.errors.join("; "));
const MACHINE_SOURCE = { grants: machineGrants.grants };

const cli: Caller = { kind: "cli", id: "cli:local", actor: CLI_ACTOR };
/** A machine reader granted every channel natively (an ops token). */
const reader: Caller = {
  kind: "mcp",
  id: "mcp:reader",
  actor: actor("service", "mcp:reader", set("runs:read", "runs:write"), "all"),
};
/** A token pinned to channel X by its `channel` key: its one channel grant is `mcp:X`. */
const pinnedX: Caller = {
  kind: "mcp",
  id: "mcp:x-bot",
  actor: resolveActor({ surface: "mcp", subjectId: "x-bot" }, (id) => grantsFor(id, MACHINE_SOURCE)),
};
/** A token WITHOUT a `channel` key: no channel grant at all. */
const unpinned: Caller = {
  kind: "mcp",
  id: "mcp:ci",
  actor: resolveActor({ surface: "mcp", subjectId: "ci" }, (id) => grantsFor(id, MACHINE_SOURCE)),
};
const dispatchOnly: Caller = {
  kind: "mcp",
  id: "mcp:agent",
  actor: actor("service", "mcp:agent", set("dispatch"), set()),
};
/** A Slack admin: every grant. */
const chatOperator: Caller = {
  kind: "chat",
  id: "slack:UADMIN",
  actor: { kind: "user", id: "slack:UADMIN", grants: ALL_GRANTS },
};
/** An Access operator configured NATIVELY without `channels: all`: every runs action, no channel membership. */
const accessOperator: Caller = {
  kind: "access",
  id: "access:op-2",
  actor: actor("user", "access:op-2", set("runs:read", "runs:write"), set()),
};

function value<T>(res: { ok: true; value: unknown } | { ok: false }): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.value as T;
}
const ids = (res: { ok: true; value: unknown } | { ok: false }) =>
  value<{ runs: { id: string }[] }>(res).runs.map((r) => r.id);

describe("runs.* registrations", () => {
  it("registers the nine commands with the declared actions and chat opt-outs", () => {
    const byId = Object.fromEntries(runsCommands.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual([
      "runs.children",
      "runs.events",
      "runs.findings",
      "runs.friction",
      "runs.get",
      "runs.list",
      "runs.search",
      "runs.stop",
      "runs.unit",
    ]);
    for (const id of [
      "runs.list",
      "runs.get",
      "runs.events",
      "runs.friction",
      "runs.unit",
      "runs.children",
      "runs.findings",
      "runs.search",
    ]) {
      expect(byId[id].action).toBe("runs:read");
      expect(byId[id].effect).toBe("read");
    }
    expect(byId["runs.stop"]).toMatchObject({ action: "runs:write", effect: "write" });
    // The findings ledger reads finished records: it needs run history and says so; every other read is always on.
    expect(byId["runs.findings"].enabledWhen).toBeDefined();
    for (const id of Object.keys(byId).filter((id) => id !== "runs.findings"))
      expect(byId[id].enabledWhen, id).toBeUndefined();
    // The listings of run metadata are chat-shaped; what carries stored free text is not.
    for (const id of ["runs.list", "runs.unit", "runs.children", "runs.findings"])
      expect(byId[id].surfaces?.chat).toBeUndefined();
    for (const id of ["runs.get", "runs.events", "runs.friction", "runs.search"])
      expect(byId[id].surfaces?.chat).toBe(false);
  });

  it("jsonSchemaFor(runs.list) has a three-value status enum", () => {
    const schema = jsonSchemaFor(runsCommands.find((c) => c.id === "runs.list")!) as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties.status.enum).toEqual(["active", "finished", "all"]);
  });

  it("a dispatch-only MCP caller is refused on runs.list and runs.stop", async () => {
    const { registry, deps } = await setup();
    expect(await registry.invoke("runs.list", { options: { status: "all" } }, dispatchOnly, deps)).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    expect(
      await registry.invoke("runs.stop", { args: ["fin-x"], options: { mode: "soft" } }, dispatchOnly, deps),
    ).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("chat callers can list but not get/events/friction (surface opt-out)", async () => {
    const { registry, deps } = await setup();
    expect(await registry.invoke("runs.list", { options: { status: "all" } }, chatOperator, deps)).toMatchObject({
      ok: true,
    });
    expect(await registry.invoke("runs.get", { args: ["fin-x"], options: {} }, chatOperator, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await registry.invoke("runs.events", { args: ["fin-x"], options: {} }, chatOperator, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await registry.invoke("runs.friction", { args: ["fin-x"], options: {} }, chatOperator, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});

describe("runs.list", () => {
  it("returns metadata only: no message text, no token", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("coding · acme/live", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:t",
    });
    reg.publish(id, { type: "input", messageId: "m1", text: "live secret request" });
    const out = value<{ runs: { id: string }[] }>(
      await registry.invoke("runs.list", { options: { status: "all" } }, reader, deps),
    );
    expect(out.runs.map((r) => r.id)).toEqual([id, "fin-x", "fin-y", "fin-priv", "fin-pub"]);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/please do the thing|all done|live secret request/);
    expect(json).not.toMatch(/tok-/);
    expect(json).not.toMatch(/"events"/);
  });

  it("status defaults to active (docs/reference/specs/run-history.md: active by default, `all` opt-in) — a bare `runs list` equals `--status active`", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("coding · acme/live", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:t",
    });
    const bare = await registry.invoke("runs.list", {}, reader, deps);
    expect(bare).toEqual(await registry.invoke("runs.list", { options: { status: "active" } }, reader, deps));
    expect(ids(bare)).toEqual([id]);
    expect(
      value<{ runs: { id: string }[] }>(
        await registry.invoke("runs.list", { options: { status: "all" } }, reader, deps),
      ).runs,
    ).toHaveLength(5);
  });

  // session-log.md item 9: a thread's story is its runs, newest first.
  it("`--thread` lists one thread's runs, live and finished, newest first, and nothing from another thread", async () => {
    const { reg, store, registry, deps } = await setup();
    const live = reg.create("coding · acme/live", {
      agent: "coding",
      channelId: "mcp:X",
      userId: "slack:UALICE",
      threadKey: "mcp:X:t1",
    });
    await store.put(
      record("fin-t1", NOW - 500, { channelId: "mcp:X", channelVisibility: "machine", threadKey: "mcp:X:t1" }),
    );
    const out = value<{ runs: { id: string; threadKey?: string }[] }>(
      await registry.invoke("runs.list", { options: { status: "all", thread: "mcp:X:t1" } }, reader, deps),
    );
    expect(out.runs.map((r) => r.id)).toEqual([live.id, "fin-t1"]);
    expect(out.runs.every((r) => r.threadKey === "mcp:X:t1")).toBe(true);
  });

  it("the parent option lists the runs one run spawned or that continue a thread it opened, newest first, and nothing else", async () => {
    const { store, registry, deps } = await setup();
    await store.put(
      record("kid-1", NOW - 500, { parentRunId: "fin-x", channelId: "mcp:X", channelVisibility: "machine" }),
    );
    await store.put(
      record("kid-2", NOW - 700, { parentRunId: "fin-x", channelId: "mcp:X", channelVisibility: "machine" }),
    );
    expect(ids(await registry.invoke("runs.list", { options: { status: "all", parent: "fin-x" } }, cli, deps))).toEqual(
      ["kid-1", "kid-2"],
    );
    expect(ids(await registry.invoke("runs.list", { options: { status: "all", parent: "fin-y" } }, cli, deps))).toEqual(
      [],
    );
    // the same predicate as every listing: a caller pinned elsewhere sees none of them
    expect(
      ids(await registry.invoke("runs.list", { options: { status: "all", parent: "fin-x" } }, unpinned, deps)),
    ).toEqual([]);
  });

  it("limit:'10' (string) and limit:10 yield the same result", async () => {
    const { registry, deps } = await setup();
    const a = await registry.invoke(
      "runs.list",
      { options: { status: "finished", limit: "10", sinceMs: String(NOW - 2500) } },
      reader,
      deps,
    );
    const b = await registry.invoke(
      "runs.list",
      { options: { status: "finished", limit: 10, sinceMs: NOW - 2500 } },
      reader,
      deps,
    );
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
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, pinnedX, deps))).toEqual([
      "fin-x",
      "fin-pub",
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0].visibleTo).toEqual({
      kind: "or",
      of: [
        { kind: "channels-in", channelIds: ["mcp:X"] },
        { kind: "visibility-in", visibilities: ["public"] },
        { kind: "user-is", userId: "mcp:x-bot" },
      ],
    });
    list.mockClear();
    // An actor the table cannot place (unknown kind) is refused at the door — the registry's own `authorize` says
    // `unknown-actor-kind` before any handler runs — so the store is never asked (its predicate would be `none` anyway).
    const bogus: Caller = {
      ...reader,
      actor: { kind: "bogus" as Actor["kind"], id: "mcp:reader", grants: ALL_GRANTS },
    };
    expect(await registry.invoke("runs.list", { options: { status: "all" } }, bogus, deps)).toMatchObject({
      ok: false,
      error: "unauthorized",
      decidedBy: "registry",
    });
    expect(list).not.toHaveBeenCalled();
    // `all` is no constraint: the store's own query is unchanged for an all-channels actor.
    await registry.invoke("runs.list", { options: { status: "all" } }, reader, deps);
    expect(list.mock.calls[0][0]).not.toHaveProperty("visibleTo");
  });
});

describe("channel visibility (authorization.md items 5–7)", () => {
  it("a pinned token sees its channel and the public runs — never another machine channel or a private run — on list (even when asking for another channel) and on get/events/friction/stop", async () => {
    const { reg, registry, deps } = await setup();
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, pinnedX, deps))).toEqual([
      "fin-x",
      "fin-pub",
    ]);
    expect(
      ids(await registry.invoke("runs.list", { options: { status: "all", channel: "mcp:Y" } }, pinnedX, deps)),
    ).toEqual([]);
    expect(
      ids(await registry.invoke("runs.list", { options: { status: "all", channel: "mcp:Y" } }, reader, deps)),
    ).toEqual(["fin-y"]);
    for (const cmd of ["runs.get", "runs.events", "runs.friction"]) {
      expect(await registry.invoke(cmd, { args: ["fin-y"], options: {} }, pinnedX, deps)).toMatchObject({
        ok: false,
        error: "not_found",
      });
      expect(await registry.invoke(cmd, { args: ["fin-priv"], options: {} }, pinnedX, deps)).toMatchObject({
        ok: false,
        error: "not_found",
      });
      expect(await registry.invoke(cmd, { args: ["fin-x"], options: {} }, pinnedX, deps)).toMatchObject({ ok: true });
    }
    const { id } = reg.create("x", {
      channelId: "mcp:Y",
      userId: "mcp:u",
      threadKey: "mcp:Y:t",
      channelVisibility: "machine",
    });
    expect(await registry.invoke("runs.stop", { args: [id], options: { mode: "soft" } }, pinnedX, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("an unpinned token (no `channel` key) holds no channel: it lists NOTHING and gets not_found on every run — a deliberate departure from the pre-table gates", async () => {
    const { registry, deps } = await setup();
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, unpinned, deps))).toEqual([
      "fin-pub",
    ]); // the public run only (member-of's public half)
    for (const cmd of ["runs.get", "runs.events", "runs.friction"]) {
      for (const run of ["fin-x", "fin-y", "fin-priv"])
        expect(await registry.invoke(cmd, { args: [run], options: {} }, unpinned, deps), `${cmd} ${run}`).toMatchObject(
          { ok: false, error: "not_found" },
        );
    }
    expect(
      await registry.invoke("runs.stop", { args: ["fin-x"], options: { mode: "soft" } }, unpinned, deps),
    ).toMatchObject({ ok: false, error: "not_found" });
    // The one thing everyone may read: a run stamped `public` (member-of's public half).
    expect(await registry.invoke("runs.get", { args: ["fin-pub"], options: {} }, unpinned, deps)).toMatchObject({
      ok: true,
    });
  });

  it("an unpinned token speaking as TEXT is no longer pinned to the channel it speaks in: `runs list` from channel mcp:X lists nothing (today's per-request pin is gone)", async () => {
    const { registry, deps } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "swb-runs-authz-"));
    writeFileSync(
      join(dir, "config.yaml"),
      'organization: acme\nproviders:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\ngrants:\n  "slack:UADMIN": { actions: all, channels: all, repos: all }\n  "mcp:x-bot": { actions: [runs:read, runs:write], channels: [mcp:X] }\n  "mcp:ci": { actions: [runs:read, runs:write] }\n',
    );
    const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"), { commandGroups: ["runs"] });
    const spokenInX = chatCallerFor({ userId: "mcp:ci", channelId: "mcp:X", threadKey: "mcp:X:t" }, config);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, spokenInX, deps))).toEqual([
      "fin-pub",
    ]); // not fin-x: the channel it speaks in grants nothing
    const pinnedSpokenInY = chatCallerFor({ userId: "mcp:x-bot", channelId: "mcp:Y", threadKey: "mcp:Y:t" }, config);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, pinnedSpokenInY, deps))).toEqual([
      "fin-x",
      "fin-pub",
    ]); // its grant, not the channel it speaks in
  });

  it("an Access operator without all-channels gets not_found outside their channels — a private Slack run is invisible on get/events/friction; the public run and their own are not", async () => {
    const { registry, deps, denied } = await setup();
    for (const cmd of ["runs.get", "runs.events", "runs.friction"]) {
      const res = await registry.invoke(cmd, { args: ["fin-priv"], options: {} }, accessOperator, deps);
      expect(res, cmd).toMatchObject({ ok: false, error: "not_found", status: 404 });
      // Byte-identical to a run that does not exist.
      expect(res).toEqual(await registry.invoke(cmd, { args: ["nope"], options: {} }, accessOperator, deps));
    }
    expect(await registry.invoke("runs.get", { args: ["fin-pub"], options: {} }, accessOperator, deps)).toMatchObject({
      ok: true,
    });
    // The deny reason reaches the audit sink only — never the reply.
    expect(denied).toEqual([
      { commandId: "runs.get", actorId: "access:op-2", action: "runs:read", reason: "not-member" },
      { commandId: "runs.events", actorId: "access:op-2", action: "runs:read", reason: "not-member" },
      { commandId: "runs.friction", actorId: "access:op-2", action: "runs:read", reason: "not-member" },
    ]);
  });

  it("an Access operator without all-channels lists only public and granted runs; an admin lists the fleet", async () => {
    const { registry, deps } = await setup();
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, accessOperator, deps))).toEqual([
      "fin-pub",
    ]);
    const granted: Caller = {
      ...accessOperator,
      actor: actor("user", "access:op-2", set("runs:read", "runs:write"), set("slack:G_PRIV")),
    };
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, granted, deps))).toEqual([
      "fin-priv",
      "fin-pub",
    ]);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, chatOperator, deps))).toEqual([
      "fin-x",
      "fin-y",
      "fin-priv",
      "fin-pub",
    ]);
  });

  it("a run is its user's own: the DM/private run's user reads it without a channel grant (is-self); a reader with no channel grant sees the public run only", async () => {
    const { registry, deps } = await setup();
    const owner: Caller = {
      kind: "access",
      id: "access:u9",
      actor: actor("user", "slack:UIVY", set("runs:read"), set()),
    };
    expect(await registry.invoke("runs.get", { args: ["fin-priv"], options: {} }, owner, deps)).toMatchObject({
      ok: true,
    });
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, owner, deps))).toEqual([
      "fin-priv",
      "fin-pub",
    ]);
    const noChannels: Caller = callerWith("mcp", "mcp:ghost", { actions: set("runs:read") });
    expect(await registry.invoke("runs.get", { args: ["fin-x"], options: {} }, noChannels, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, noChannels, deps))).toEqual([
      "fin-pub",
    ]);
  });

  it("a live run without a stamp is `unknown` — never public: only a channel grant, all-channels, or its own user reads it", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("x", { channelId: "slack:C_PUB", userId: "slack:UALICE", threadKey: "slack:C_PUB:t" });
    expect(await registry.invoke("runs.get", { args: [id], options: {} }, accessOperator, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await registry.invoke("runs.get", { args: [id], options: {} }, reader, deps)).toMatchObject({ ok: true });
  });
});

describe("runs.get / runs.events / runs.friction", () => {
  it("unknown id → not_found; malformed id → invalid_input naming id", async () => {
    const { registry, deps } = await setup();
    expect(await registry.invoke("runs.get", { args: ["nope"], options: {} }, reader, deps)).toMatchObject({
      ok: false,
      error: "not_found",
      status: 404,
    });
    const bad = await registry.invoke("runs.get", { args: ["has spaces!"], options: {} }, reader, deps);
    expect(bad).toMatchObject({ ok: false, error: "invalid_input" });
    if (bad.ok) throw new Error("unreachable");
    expect(bad.message).toMatch(/\bid\b/);
    expect(bad.message).not.toMatch(/spaces/);
  });

  it("runs.get without include returns no events; include=messages wraps every text field as untrusted", async () => {
    const { registry, deps } = await setup();
    const bare = value<{ events?: unknown }>(
      await registry.invoke("runs.get", { args: ["fin-x"], options: {} }, reader, deps),
    );
    expect(bare.events).toBeUndefined();
    const full = value<{ events: RunEvent[] }>(
      await registry.invoke("runs.get", { args: ["fin-x"], options: { include: "messages" } }, reader, deps),
    );
    expect(full.events).toHaveLength(4);
    for (const e of full.events) {
      if (e.type === "input" || e.type === "context" || e.type === "answer" || e.type === "assistant")
        expect(e.text).toContain(UNTRUSTED_OPEN);
      if (e.type === "tool_call" || e.type === "tool_result") expect(e.summary).toContain(UNTRUSTED_OPEN);
    }
    expect(JSON.stringify(full)).toContain("please do the thing");
    expect(JSON.stringify(full)).not.toMatch(/tok-/);
  });

  // costs.md item 4c: the record's dollars ride `runs get` on every surface.
  it("runs.get renders the run's cost on the text surfaces — dollars per model, or unpriced — and carries it as JSON", async () => {
    const { registry, store, deps } = await setup();
    const tokens = (input: number) => ({
      turns: 1,
      inputTokens: input,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const machine = { channelId: "mcp:X", channelVisibility: "machine" as const };
    await store.put(
      record("fin-mixed", NOW - 500, {
        ...machine,
        usage: { turns: 2, byModel: { "anthropic/claude-haiku-4-5": tokens(1_000_000), "mystery/model-x": tokens(5) } },
      }),
    );
    await store.put(
      record("fin-priced", NOW - 400, {
        ...machine,
        usage: { turns: 1, byModel: { "anthropic/claude-haiku-4-5": tokens(1_000_000) } },
      }),
    );
    const get = runsCommands.find((c) => c.id === "runs.get")!;
    const mixed = await registry.invoke("runs.get", { args: ["fin-mixed"], options: {} }, reader, deps);
    const view = value<{ cost: { usd: number | null; byModel: Record<string, { usd: number | null }> } }>(mixed);
    expect(view.cost.usd).toBeNull();
    expect(view.cost.byModel["anthropic/claude-haiku-4-5"].usd).toBeCloseTo(1, 9);
    expect(view.cost.byModel["mystery/model-x"].usd).toBeNull();
    const text = renderText(get, mixed.ok ? mixed.value : null);
    expect(text).toContain("cost: unpriced · anthropic/claude-haiku-4-5 $1.00 · mystery/model-x unpriced");
    expect(text).not.toMatch(/cost: \$0/);
    expect(text).toContain("id: fin-mixed"); // the other fields keep their key: value lines
    const priced = await registry.invoke("runs.get", { args: ["fin-priced"], options: {} }, reader, deps);
    expect(renderText(get, priced.ok ? priced.value : null)).toContain(
      "cost: $1.00 · anthropic/claude-haiku-4-5 $1.00",
    );
    // A record from before usage existed has no cost line at all.
    const old = await registry.invoke("runs.get", { args: ["fin-x"], options: {} }, reader, deps);
    expect(renderText(get, old.ok ? old.value : null)).not.toContain("cost:");
  });

  it("wrapEvent wraps a tool result's output and a span end's error too; a span with no error is returned as is", () => {
    const wrapped = wrapEvent({ type: "tool_result", tool: "bash", ok: true, summary: "ok", output: "raw out" });
    expect((wrapped as { output: string }).output).toContain(UNTRUSTED_OPEN);
    expect((wrapped as { summary: string }).summary).toContain(UNTRUSTED_OPEN);
    const failed = wrapEvent({
      type: "span_end",
      spanId: "s1",
      name: "post.reply",
      startedAt: 1,
      durationMs: 2,
      status: "error",
      error: "slack said no",
    });
    expect((failed as { error: string }).error).toContain(UNTRUSTED_OPEN);
    expect((failed as { error: string }).error).toContain("slack said no");
    const clean = {
      type: "span_end",
      spanId: "s2",
      name: "post.reply",
      startedAt: 1,
      durationMs: 2,
      status: "ok",
    } as const;
    expect(wrapEvent(clean)).toBe(clean);
    const start = { type: "span_start", spanId: "s3", name: "dispatch.compose", at: 1 } as const;
    expect(wrapEvent(start)).toBe(start);
  });

  it("runs.events pages with afterSeq/limit (coerced) and wraps text", async () => {
    const { registry, deps } = await setup();
    const page = value<{ events: RunEvent[]; nextAfterSeq?: number }>(
      await registry.invoke("runs.events", { args: ["fin-x"], options: { afterSeq: "1", limit: "2" } }, reader, deps),
    );
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page.nextAfterSeq).toBe(3);
    expect((page.events[0] as { summary: string }).summary).toContain(UNTRUSTED_OPEN);
  });

  it("runs.friction returns the stored diagnosis", async () => {
    const { registry, deps } = await setup();
    const out = value<{ id: string; finished: boolean; diagnosis: { verdict: string } }>(
      await registry.invoke("runs.friction", { args: ["fin-x"], options: {} }, reader, deps),
    );
    expect(out).toMatchObject({ id: "fin-x", finished: true });
    expect(typeof out.diagnosis.verdict).toBe("string");
  });

  it("runs.get fetches the run once — the authorization check reuses the payload's view", async () => {
    const { registry, deps } = await setup();
    const getRun = vi.spyOn(await deps.runs(), "getRun");
    const out = value<{ id: string; events?: unknown[] }>(
      await registry.invoke("runs.get", { args: ["fin-x"], options: { include: "messages" } }, pinnedX, deps),
    );
    expect(out.id).toBe("fin-x");
    expect(out.events).toHaveLength(4);
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledWith("fin-x", { include: "messages" });
  });

  it("every handler resolves the `runs` accessor exactly once per invocation", async () => {
    const { registry, deps, reg } = await setup();
    const live = reg.create("coding · acme/live", {
      agent: "coding",
      channelId: "mcp:X",
      userId: "mcp:u",
      threadKey: "mcp:X:t",
      channelVisibility: "machine",
    });
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
    expect(await registry.invoke("runs.stop", { args: ["fin-x"], options: { mode: "soft" } }, cli, deps)).toMatchObject(
      { ok: false, error: "conflict", status: 409 },
    );
    expect(await registry.invoke("runs.stop", { args: ["nope"], options: { mode: "soft" } }, cli, deps)).toMatchObject({
      ok: false,
      error: "not_found",
      status: 404,
    });
  });

  it("stops a live run and records the caller as the structured actor", async () => {
    const { reg, registry, deps } = await setup();
    const { id, token } = reg.create("coding · acme/live", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:t",
    });
    const res = await registry.invoke("runs.stop", { args: [id], options: { mode: "hard" } }, reader, deps);
    expect(res).toEqual({ ok: true, value: { id, mode: "hard", state: "stopping" } });
    const snap = reg.snapshot(id, token)!;
    const note = snap.events.find((e) => e.type === "run_note" && e.kind === "stop_requested") as Extract<
      RunEvent,
      { type: "run_note" }
    >;
    expect(note.actor).toEqual({ kind: "mcp", id: "mcp:reader" });
  });

  it("stopping needs runs:write AND visibility: a reader without the write grant is refused by the registry, a writer outside the channel gets not_found", async () => {
    const { reg, registry, deps } = await setup();
    const { id } = reg.create("x", {
      channelId: "mcp:Y",
      userId: "mcp:u",
      threadKey: "mcp:Y:t",
      channelVisibility: "machine",
    });
    expect(await registry.invoke("runs.stop", { args: [id], options: { mode: "soft" } }, pinnedX, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    const writerY: Caller = {
      kind: "mcp",
      id: "mcp:y-bot",
      actor: actor("service", "mcp:y-bot", set("runs:read", "runs:write"), set("mcp:Y")),
    };
    expect(await registry.invoke("runs.stop", { args: [id], options: { mode: "soft" } }, writerY, deps)).toMatchObject({
      ok: true,
    });
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

// docs/reference/specs/agent-ship.md item 17, agent-conductor.md item 11 and
// session-log.md item 11 — the three listings that read across runs, on the
// command surface: a unit's runs in round order, a conductor's children, one
// session's search; each under the caller's predicate, a deny `not_found` or
// empty exactly as the point reads and the list answer.
describe("runs unit / runs children / runs search — the unit is the reading unit", () => {
  const T0 = NOW - 100_000;
  const KEY = "slack:C1:u1:coding";
  const turn = (role: "user" | "assistant", text: string): ChatMessage => ({ role, content: [{ type: "text", text }] });

  async function world() {
    let n = 0;
    const reg = new RunRegistry({ genId: () => `id-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
    const store = new InMemoryRunStore({ now: () => NOW });
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put({
      id: "plan-p-1",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:parent",
      repo: "acme/api",
      branch: "plan/p/u1",
      createdAt: T0 - 1_000,
    });
    await instances.putUnits([
      {
        instanceId: "plan-p-1",
        unit: "U16",
        slug: "u1",
        branch: "plan/p/u1",
        dependsOn: [],
        threadKey: "slack:C1:u1",
        reviewThread: { threadKey: "slack:C1:u1r" },
        rounds: [
          { index: 0, agent: "coding", outcome: "started", at: T0 },
          { index: 1, agent: "review", outcome: "started", at: T0 + 11_000 },
          { index: 1, agent: "coding", outcome: "started", at: T0 + 21_000 },
        ],
      },
    ]);
    const at = (id: string, threadKey: string, agent: string, startedAt: number, over: Partial<RunRecord> = {}) =>
      record(id, startedAt + 5_000, { threadKey, agent, startedAt, ...over });
    await store.put(
      at("c0", "slack:C1:u1", "coding", T0 + 1_000, {
        session: { key: KEY, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
      }),
    );
    await store.put(at("r1", "slack:C1:u1r", "review", T0 + 12_000));
    await store.put(at("c1", "slack:C1:u1", "coding", T0 + 22_000));
    await store.put(at("cond", "slack:C1:cond", "conductor", T0));
    await store.put(at("k1", "slack:C1:k1", "research", T0 + 2_000, { parentRunId: "cond" }));
    await store.put(at("k2", "slack:C1:k2", "explore", T0 + 1_000, { parentRunId: "cond" }));
    const ledger = new InMemoryRunLedger(() => NOW);
    await ledger.claimSession(KEY, "c0", "g1");
    await ledger.seed(
      "c0",
      "g1",
      [turn("user", "please fix the flaky lockfile test"), turn("assistant", "the lockfile is fine")].map(
        (message, idx) => ({ idx, message }),
      ),
      KEY,
    );
    const runs = createRunsService({ registry: reg, store, units: instances, sessions: ledger });
    const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
    registerRunsCommands(registry);
    const denied: RunReadDenied[] = [];
    const deps: RunsCommandDeps = { runs: async () => runs, denied: (e) => denied.push(e) };
    return { registry, deps, denied };
  }

  it("runs unit answers the unit's runs in round order with their round and thread, and renders one line per run under the unit's threads — aligned columns for the terminal, a chat shape without padded columns", async () => {
    const { registry, deps } = await world();
    const res = await registry.invoke("runs.unit", { args: ["plan-p-1:U16"], options: {} }, cli, deps);
    const v = value<{
      unit: string;
      threads: Record<string, string>;
      runs: Array<{ id: string; round: number; thread: string }>;
    }>(res);
    expect(v.unit).toBe("plan-p-1:U16");
    expect(v.threads).toEqual({ coding: "slack:C1:u1", review: "slack:C1:u1r" });
    expect(v.runs.map((r) => [r.id, r.round, r.thread])).toEqual([
      ["c0", 0, "coding"],
      ["r1", 1, "review"],
      ["c1", 1, "coding"],
    ]);
    expect(JSON.stringify(v)).not.toMatch(/tok-/);
    const cmd = registry.get("runs.unit")!;
    const text = renderText(cmd, value(res));
    const lines = text.split("\n");
    expect(lines[0]).toBe("unit plan-p-1:U16 — coding thread slack:C1:u1, review thread slack:C1:u1r");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^c0\s+coding\s+completed\s+\S+\s+round 0 coding$/);
    expect(lines[2]).toMatch(/^r1\s+review\s+completed\s+\S+\s+round 1 review$/);
    const chat = renderText(cmd, value(res), { surface: "chat" });
    expect(chat.split("\n")[1]).toMatch(/^• `c0` — coding · completed · \S+ · round 0 coding$/);
    expect(chat.split("\n").filter((l) => /\S {2,}\S/.test(l))).toEqual([]);
    expect(renderText(cmd, { unit: "plan-p-1:U17", instanceId: "plan-p-1", threads: {}, rounds: [], runs: [] })).toBe(
      "unit plan-p-1:U17 — thread not opened yet\n(none)",
    );
  });

  it("an unknown unit is not_found (`unit not found`), a malformed key is invalid_input naming `unit`, a reader outside the predicate is told not_found exactly as for an unknown unit, and chat is a surface for the listing", async () => {
    const { registry, deps } = await world();
    expect(await registry.invoke("runs.unit", { args: ["plan-p-1:U77"], options: {} }, cli, deps)).toMatchObject({
      ok: false,
      error: "not_found",
      message: "unit not found",
      decidedBy: "handler",
    });
    const malformed = await registry.invoke("runs.unit", { args: ["nonsense"], options: {} }, cli, deps);
    expect(malformed).toMatchObject({ ok: false, error: "invalid_input" });
    if (malformed.ok) throw new Error("unreachable");
    expect(malformed.message).toMatch(/unit/);
    expect(await registry.invoke("runs.unit", { args: ["plan-p-1:U16"], options: {} }, pinnedX, deps)).toMatchObject({
      ok: false,
      error: "not_found",
      message: "unit not found",
    });
    expect(
      await registry.invoke("runs.unit", { args: ["plan-p-1:U16"], options: {} }, chatOperator, deps),
    ).toMatchObject({ ok: true });
  });

  it("runs children lists the runs naming the parent oldest started first, behind the parent's own point read: an unknown parent, and a parent outside the predicate, are run not found with the deny on the audit line", async () => {
    const { registry, deps, denied } = await world();
    const res = await registry.invoke("runs.children", { args: ["cond"], options: {} }, cli, deps);
    const v = value<{ parentRunId: string; runs: Array<{ id: string; parentRunId?: string }> }>(res);
    expect(v.parentRunId).toBe("cond");
    expect(v.runs.map((r) => [r.id, r.parentRunId])).toEqual([
      ["k2", "cond"],
      ["k1", "cond"],
    ]);
    const cmd = registry.get("runs.children")!;
    expect(renderText(cmd, value(res)).split("\n")).toHaveLength(3);
    expect(renderText(cmd, value(res)).split("\n")[0]).toBe("children of cond");
    expect(renderText(cmd, { parentRunId: "k1", runs: [] })).toBe("children of k1\n(none)");
    expect(await registry.invoke("runs.children", { args: ["nope"], options: {} }, cli, deps)).toMatchObject({
      ok: false,
      error: "not_found",
      message: "run not found",
    });
    expect(await registry.invoke("runs.children", { args: ["cond"], options: {} }, pinnedX, deps)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(denied).toEqual([
      { commandId: "runs.children", actorId: "mcp:x-bot", action: "runs:read", reason: expect.any(String) },
    ]);
  });

  it("runs search answers the matching turns with their run, snippets wrapped as untrusted, the limit option capping them; a reader outside the predicate gets no hits, a malformed key is invalid_input naming session, and chat is not a surface for it", async () => {
    const { registry, deps } = await world();
    const res = await registry.invoke("runs.search", { args: [KEY, "flaky lockfile"], options: {} }, cli, deps);
    const v = value<{
      session: string;
      hits: Array<{ turn: number; role: string; snippet: string; runId?: string }>;
      gaps: number[];
    }>(res);
    expect(v.session).toBe(KEY);
    expect(v.gaps).toEqual([]);
    expect(v.hits.map((h) => [h.turn, h.role, h.runId])).toEqual([
      [0, "user", "c0"],
      [1, "assistant", "c0"],
    ]);
    for (const h of v.hits) expect(h.snippet).toContain(UNTRUSTED_OPEN);
    expect(v.hits[0].snippet).toContain("please fix the flaky lockfile test");
    const one = await registry.invoke(
      "runs.search",
      { args: [KEY, "flaky lockfile"], options: { limit: 1 } },
      cli,
      deps,
    );
    expect(value<{ hits: unknown[] }>(one).hits).toHaveLength(1);
    const outside = await registry.invoke("runs.search", { args: [KEY, "flaky"], options: {} }, pinnedX, deps);
    expect(value<{ hits: unknown[] }>(outside)).toEqual({ session: KEY, hits: [], gaps: [] });
    const malformed = await registry.invoke("runs.search", { args: ["bad key!", "flaky"], options: {} }, cli, deps);
    expect(malformed).toMatchObject({ ok: false, error: "invalid_input" });
    if (malformed.ok) throw new Error("unreachable");
    expect(malformed.message).toMatch(/session/);
    expect(
      await registry.invoke("runs.search", { args: [KEY, "flaky"], options: {} }, chatOperator, deps),
    ).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("runs findings — a pull request's findings ledger on every surface (agent-ship item 18)", () => {
  const T0 = NOW - 100_000;
  const HEAD = "a".repeat(40);
  const URL = "https://github.com/acme/api/pull/42";

  async function world() {
    let n = 0;
    const reg = new RunRegistry({ genId: () => `id-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
    const store = new InMemoryRunStore({ now: () => NOW });
    const at = (id: string, agent: string, startedAt: number, over: Partial<RunRecord> = {}) =>
      record(id, startedAt + 5_000, { agent, startedAt, repo: "acme/api", channelVisibility: "public", ...over });
    await store.put(at("c0", "coding", T0, { pr: { number: 42, url: URL } }));
    await store.put(
      at("r1", "review", T0 + 10_000, {
        channelId: "slack:G_PRIV",
        channelVisibility: "private",
        verdict: {
          verdict: "request_changes",
          summary: "two",
          head: HEAD,
          findings: [
            { id: "F1", severity: "major", file: "src/a.ts", line: 12, title: "null path unguarded" },
            { id: "F2", severity: "nit", file: "src/b.ts", title: "typo" },
          ],
        },
        reviewHead: HEAD,
        reviewPost: { posted: true, target: { repo: "acme/api", number: 42 }, head: HEAD, verdict: "request_changes" },
      }),
    );
    await store.put(
      at("c1", "coding", T0 + 20_000, {
        pr: { number: 42, url: URL },
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "guarded it" },
          { findingId: "F2", disposition: "declined", note: "the library's spelling" },
        ],
      }),
    );
    const runs = createRunsService({ registry: reg, store });
    const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
    registerRunsCommands(registry);
    const denied: RunReadDenied[] = [];
    const deps: RunsCommandDeps = { runs: async () => runs, denied: (e) => denied.push(e) };
    return { registry, deps };
  }

  it("answers the ledger for `owner/repo#N` and for the pull request URL alike — titles and notes wrapped as untrusted on the JSON surface — and renders one line per finding under a header: aligned columns for the terminal, a chat shape without padded columns, both unwrapped", async () => {
    const { registry, deps } = await world();
    const res = await registry.invoke("runs.findings", { args: ["acme/api#42"], options: {} }, cli, deps);
    const v = value<{
      repo: string;
      pr: { number: number; url?: string };
      runs: Array<{ id: string }>;
      findings: Array<{ id: string; status: string; title?: string; disposition?: { note: string } }>;
    }>(res);
    expect(v.repo).toBe("acme/api");
    expect(v.pr).toEqual({ number: 42, url: URL });
    expect(v.runs.map((r) => r.id)).toEqual(["c0", "r1", "c1"]);
    expect(v.findings.map((f) => [f.id, f.status])).toEqual([
      ["F1", "awaiting re-review"],
      ["F2", "awaiting re-review"],
    ]);
    expect(v.findings[0].title).toContain(UNTRUSTED_OPEN);
    expect(v.findings[0].title).toContain("null path unguarded");
    expect(v.findings[1].disposition!.note).toContain(UNTRUSTED_OPEN);
    expect(v.findings[1].disposition!.note).toContain("the library's spelling");
    expect(JSON.stringify(v)).not.toMatch(/tok-/);
    const byUrl = await registry.invoke("runs.findings", { args: [URL], options: {} }, cli, deps);
    expect(byUrl).toEqual(res);
    const cmd = registry.get("runs.findings")!;
    const text = renderText(cmd, value(res));
    const lines = text.split("\n");
    expect(lines[0]).toBe("findings for acme/api#42 — 2 findings: 2 awaiting re-review");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(
      /^F1\s{2,}major\s{2,}src\/a\.ts:12\s{2,}null path unguarded\s{2,}awaiting re-review\s{2,}guarded it$/,
    );
    expect(lines[2]).toMatch(
      /^F2\s{2,}nit\s{2,}src\/b\.ts\s{2,}typo\s{2,}awaiting re-review\s{2,}the library's spelling$/,
    );
    expect(text).not.toContain("UNTRUSTED");
    const chat = renderText(cmd, value(res), { surface: "chat" });
    expect(chat.split("\n")[1]).toBe(
      "• `F1` · major · src/a.ts:12 · null path unguarded · awaiting re-review — guarded it",
    );
    expect(chat.split("\n").filter((l) => /\S {2,}\S/.test(l))).toEqual([]);
    expect(chat).not.toContain("UNTRUSTED");
    expect(
      renderText(cmd, {
        repo: "acme/api",
        pr: { number: 7 },
        unit: "plan-p-1:U16",
        runs: [],
        findings: [{ id: "F1", severity: "major", file: "f", title: "t", status: "re-raised", reRaisedAfter: "fixed" }],
      }),
    ).toBe(
      "findings for acme/api#7 (unit plan-p-1:U16) — 1 finding: 1 re-raised\nF1  major  f  t  re-raised after fixed",
    );
    expect(renderText(cmd, { repo: "acme/api", pr: { number: 7 }, runs: [{ id: "c" }], findings: [] })).toBe(
      "findings for acme/api#7 — 0 findings\n(none)",
    );
  });

  it("a pull request no run names is not_found (`no runs name this pull request`); a malformed reference is invalid_input naming `pr`; a reader outside the private review reads the ledger from the public runs alone; chat is a surface for it", async () => {
    const { registry, deps } = await world();
    expect(await registry.invoke("runs.findings", { args: ["acme/api#99"], options: {} }, cli, deps)).toMatchObject({
      ok: false,
      error: "not_found",
      message: "no runs name this pull request",
      decidedBy: "handler",
    });
    const malformed = await registry.invoke("runs.findings", { args: ["acme/api"], options: {} }, cli, deps);
    expect(malformed).toMatchObject({ ok: false, error: "invalid_input" });
    if (malformed.ok) throw new Error("unreachable");
    expect(malformed.message).toContain("pr");
    expect(malformed.message).not.toContain("acme/api");
    // The reviewer's run is private: a reader admitted to public runs sees the
    // coding runs' story — the dispositions answer ids no review it saw issued.
    const reader = callerWith("access", "access:ro", { actions: set("runs:read") });
    const partial = value<{ runs: Array<{ id: string }>; findings: Array<{ id: string; status: string }> }>(
      await registry.invoke("runs.findings", { args: ["acme/api#42"], options: {} }, reader, deps),
    );
    expect(partial.runs.map((r) => r.id)).toEqual(["c0", "c1"]);
    expect(partial.findings.map((f) => [f.id, f.status])).toEqual([
      ["F1", "unknown id"],
      ["F2", "unknown id"],
    ]);
    const slack = callerWith("chat", "slack:UPOWER", "all", {
      origin: { channelId: "slack:C1", threadKey: "slack:C1:t" },
    });
    const chat = await registry.invoke("runs.findings", { args: ["acme/api#42"], options: {} }, slack, deps);
    expect(chat.ok).toBe(true);
  });
});

describe("runs.list --mine (record 0042, the runs page): the caller's own runs, a narrowing of what they may read", () => {
  /** A Slack person who may read every channel: `--mine` drops everything they did not request. */
  const ivy: Caller = {
    kind: "chat",
    id: "slack:UIVY",
    actor: actor("user", "slack:UIVY", set("runs:read"), "all"),
  };
  /** A dashboard session linked to ivy (identity, not authority): the same runs as ivy's own. */
  const linkedIvy: Caller = {
    kind: "access",
    id: "access:ivy",
    actor: {
      ...actor("user", "access:ivy", set("runs:read"), set()),
      self: ["access:ivy", "slack:UIVY"],
      asUser: { id: "slack:UIVY" },
    },
  };
  /** The same session unlinked: no run is ever requested as `access:<sub>`, so nothing is theirs. */
  const unlinked: Caller = {
    kind: "access",
    id: "access:ivy",
    actor: actor("user", "access:ivy", set("runs:read"), set()),
  };

  it("lists only the runs the caller requested, private ones included, and nothing of anyone else's", async () => {
    const { registry, deps } = await setup();
    expect(ids(await registry.invoke("runs.list", { options: { status: "all" } }, ivy, deps))).toEqual([
      "fin-x",
      "fin-y",
      "fin-priv",
      "fin-pub",
    ]);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all", mine: true } }, ivy, deps))).toEqual([
      "fin-priv",
      "fin-pub",
    ]);
    expect(
      ids(await registry.invoke("runs.list", { options: { status: "all", mine: true } }, linkedIvy, deps)),
    ).toEqual(["fin-priv", "fin-pub"]);
    expect(ids(await registry.invoke("runs.list", { options: { status: "all", mine: true } }, unlinked, deps))).toEqual(
      [],
    );
    // The fleet reader (a service token) requested nothing either — `--mine` never widens.
    expect(ids(await registry.invoke("runs.list", { options: { status: "all", mine: true } }, reader, deps))).toEqual(
      [],
    );
  });

  it("is a store predicate, not a filter after loading: the store is asked with the readable predicate ANDed with the caller's self set; a text surface's `--mine` (\"true\") is the same ask", async () => {
    const { store, registry, deps } = await setup();
    const list = vi.spyOn(store, "list");
    await registry.invoke("runs.list", { options: { status: "all", mine: true } }, linkedIvy, deps);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0].visibleTo).toEqual({
      kind: "and",
      of: [
        {
          kind: "or",
          of: [
            { kind: "visibility-in", visibilities: ["public"] },
            { kind: "user-is", userId: "access:ivy" },
            { kind: "user-is", userId: "slack:UIVY" },
          ],
        },
        {
          kind: "or",
          of: [
            { kind: "user-is", userId: "access:ivy" },
            { kind: "user-is", userId: "slack:UIVY" },
          ],
        },
      ],
    });
    list.mockClear();
    // An all-channels person: the readable half is no constraint, so the store's filter is the self set alone.
    await registry.invoke("runs.list", { options: { status: "all", mine: "true" } }, ivy, deps);
    expect(list.mock.calls[0][0].visibleTo).toEqual({ kind: "user-is", userId: "slack:UIVY" });
    expect(jsonSchemaFor(runsCommands.find((c) => c.id === "runs.list")!)).toMatchObject({
      properties: { mine: expect.anything() },
    });
  });
});
