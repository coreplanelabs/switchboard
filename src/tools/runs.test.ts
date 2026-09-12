import { describe, expect, it, vi } from "vitest";
import { NO_GRANTS, type Actor } from "../core/authz/types.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent } from "../core/runEvents.js";
import type { RunRecord } from "../core/runRecord.js";
import type { SpawnCapability } from "../core/dispatch/spawn.js";
import type { Executor } from "../execution/executor.js";
import type { ToolContext } from "./workspace.js";
import { getRunStatusTool, listRunsTool, RUN_TOOLS, spawnRunTool } from "./runs.js";

// Feature: docs/reference/specs/agent-conductor.md items 3–4 — the three run
// tools a spawning run holds: `spawn_run` calls the spawn capability with the
// run's remaining wall clock; `list_runs` and `get_run_status` answer through
// `RunsService` under the requester's own `runs:read` predicate, so a parent
// sees exactly the runs its requester may (docs/reference/specs/authorization.md
// items 5–6) and a denied point read is `not_found` like an unknown id.

const NOW = 100_000;
const executor = {} as Executor;

function world() {
  let n = 0;
  const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  const service = createRunsService({ registry, store });
  return { registry, store, service };
}

const alice: Actor = { kind: "user", id: "slack:UALICE", grants: NO_GRANTS };
const admin: Actor = { kind: "user", id: "slack:UADMIN", grants: ALL_GRANTS };

function ctxFor(
  w: ReturnType<typeof world>,
  actor: Actor,
  over: Partial<ToolContext> & { runId?: string } = {},
): ToolContext {
  const { runId, ...rest } = over;
  return { executor, runs: { service: w.service, actor, ...(runId !== undefined ? { runId } : {}) }, ...rest };
}

function persisted(id: string, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = [
    { type: "input", text: "what is a Durable Object?", seq: 1 },
    { type: "answer", text: "A Durable Object is a single-instance coordination point.", seq: 2 },
  ];
  return {
    id,
    label: "research · #general · alice",
    agent: "research",
    model: "anthropic/m",
    channelId: "slack:CX",
    userId: "slack:UALICE",
    threadKey: `slack:CX:${id}`,
    channelVisibility: "public",
    startedAt: NOW - 20_000,
    finishedAt: NOW - 10_000,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
    ...over,
  };
}

describe("list_runs — the runs the requester may see", () => {
  it("lists this run's live children by default (the parent's own id), and every visible run with scope: all; a run in a private channel the requester is not a member of is absent for them and present for an admin", async () => {
    const w = world();
    const meta = (channelId: string, userId: string, visibility: "public" | "private", parentRunId?: string) => ({
      agent: "research",
      channelId,
      userId,
      threadKey: `${channelId}:${Math.random()}`,
      channelVisibility: visibility,
      ...(parentRunId ? { parentRunId } : {}),
    });
    const parent = w.registry.create("conductor · alice", meta("slack:CX", "slack:UALICE", "public"));
    const child1 = w.registry.create("research · child", meta("slack:CX", "slack:UALICE", "public", parent.id));
    const child2 = w.registry.create("research · child", meta("slack:CX", "slack:UALICE", "public", parent.id));
    w.registry.publish(child2.id, { type: "tool_call", tool: "web_search", summary: "durable objects" });
    const stranger = w.registry.create("coding · bob", meta("slack:CPRIV", "slack:UBOB", "private"));
    const otherChild = w.registry.create("research · x", meta("slack:CX", "slack:UBOB", "public", "run-other"));

    const mine = await listRunsTool.run({}, ctxFor(w, alice, { runId: parent.id }));
    const rows = JSON.parse(String(mine)) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id).sort()).toEqual([child1.id, child2.id].sort());
    expect(rows.find((r) => r.id === child2.id)).toMatchObject({
      agent: "research",
      status: "running",
      parentRunId: parent.id,
    });
    expect(String(rows.find((r) => r.id === child2.id)!.activity)).toContain("durable objects");
    expect(JSON.stringify(rows)).not.toMatch(/tok-/); // never a capability token

    const all = JSON.parse(String(await listRunsTool.run({ scope: "all" }, ctxFor(w, alice, { runId: parent.id }))));
    const allIds = (all as Array<{ id: string }>).map((r) => r.id).sort();
    expect(allIds).toEqual([parent.id, child1.id, child2.id, otherChild.id].sort());
    expect(allIds).not.toContain(stranger.id);

    const admins = JSON.parse(String(await listRunsTool.run({ scope: "all" }, ctxFor(w, admin, { runId: parent.id }))));
    expect((admins as Array<{ id: string }>).map((r) => r.id)).toContain(stranger.id);
  });

  // A parent's children must never fall off the page: the children scope
  // pages the service until it has them (or the listing ends), whatever else
  // the requester may see is newer.
  it("scope: children pages past newer runs the requester may see — children older than a full page of other runs are still listed, up to `limit`", async () => {
    const w = world();
    // More unrelated finished runs than one full page (the store's 200), all
    // newer than the parent's three children.
    for (let i = 0; i < 203; i++) await w.store.put(persisted(`r-other-${i}`, { finishedAt: NOW - 1000 - i }));
    for (let i = 0; i < 3; i++)
      await w.store.put(persisted(`r-kid-${i}`, { finishedAt: NOW - 50_000 - i, parentRunId: "run-p" }));
    const listRuns = vi.spyOn(w.service, "listRuns");
    const rows = JSON.parse(
      String(await listRunsTool.run({ status: "finished", limit: 2 }, ctxFor(w, alice, { runId: "run-p" }))),
    ) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(["r-kid-0", "r-kid-1"]); // the two newest children, not the two newest runs
    expect(rows.every((r) => r.parentRunId === "run-p")).toBe(true);
    // The service was asked for full pages and followed its cursor onto a
    // second page, never the caller's small limit.
    expect(listRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [opts] of listRuns.mock.calls) expect(opts.limit).toBeGreaterThan(2);
    expect(listRuns.mock.calls[1][0].before).toBeDefined();
    // `scope: all` keeps the caller's limit as the page size: the two newest runs.
    const all = JSON.parse(
      String(
        await listRunsTool.run({ status: "finished", scope: "all", limit: 2 }, ctxFor(w, alice, { runId: "run-p" })),
      ),
    ) as Array<Record<string, unknown>>;
    expect(all.map((r) => r.id)).toEqual(["r-other-0", "r-other-1"]);
  });

  it("finished runs come from the store too, with their terminal status; without a runs capability the tool says so", async () => {
    const w = world();
    await w.store.put(persisted("r-done", { parentRunId: "run-p" }));
    const rows = JSON.parse(
      String(await listRunsTool.run({ status: "finished" }, ctxFor(w, alice, { runId: "run-p" }))),
    ) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r-done", status: "completed", parentRunId: "run-p" });
    expect(await listRunsTool.run({}, { executor })).toBe("run tools are not available in this context.");
  });
});

describe("get_run_status — one run as the requester may see it", () => {
  it("a live child: running, with its activity line; a finished one: its terminal status and the final reply's text wrapped as untrusted content", async () => {
    const w = world();
    const live = w.registry.create("research · child", {
      agent: "research",
      channelId: "slack:CX",
      userId: "slack:UALICE",
      threadKey: "slack:CX:2",
      channelVisibility: "public",
      parentRunId: "run-p",
    });
    w.registry.publish(live.id, { type: "tool_call", tool: "web_fetch", summary: "GET https://example.com" });
    const running = JSON.parse(String(await getRunStatusTool.run({ id: live.id }, ctxFor(w, alice))));
    expect(running).toMatchObject({ id: live.id, agent: "research", status: "running", parentRunId: "run-p" });
    expect(String(running.activity)).toContain("example.com");
    expect("finalReply" in running).toBe(false);

    await w.store.put(persisted("r-done"));
    const done = JSON.parse(String(await getRunStatusTool.run({ id: "r-done" }, ctxFor(w, alice))));
    expect(done).toMatchObject({ id: "r-done", status: "completed" });
    expect(String(done.finalReply)).toContain("A Durable Object is a single-instance coordination point.");
    expect(String(done.finalReply)).toMatch(/untrusted/i);
  });

  it("an unknown id and a run the requester may not read are both `not_found` — never which", async () => {
    const w = world();
    const secret = w.registry.create("coding · bob", {
      agent: "coding",
      channelId: "slack:CPRIV",
      userId: "slack:UBOB",
      threadKey: "slack:CPRIV:1",
      channelVisibility: "private",
    });
    expect(await getRunStatusTool.run({ id: "run-nope" }, ctxFor(w, alice))).toBe("not_found");
    expect(await getRunStatusTool.run({ id: secret.id }, ctxFor(w, alice))).toBe("not_found");
    expect(JSON.parse(String(await getRunStatusTool.run({ id: secret.id }, ctxFor(w, admin))))).toMatchObject({
      id: secret.id,
      status: "running",
    });
    expect(await getRunStatusTool.run({ id: "run-nope" }, { executor })).toBe(
      "run tools are not available in this context.",
    );
  });

  it("a child this run spawned that was refused at a gate after it registered (its row is gone) answers from the spawn capability: refused, by the gate's name", async () => {
    const w = world();
    const spawn: SpawnCapability = {
      spawn: async () => ({ kind: "refused", reason: "x", message: "" }),
      childOutcome: (id) => (id === "run-gone" ? { status: "refused", refusal: "repo_not_onboarded" } : undefined),
    };
    expect(JSON.parse(String(await getRunStatusTool.run({ id: "run-gone" }, ctxFor(w, alice, { spawn }))))).toEqual({
      id: "run-gone",
      status: "refused",
      reason: "repo_not_onboarded",
    });
    expect(await getRunStatusTool.run({ id: "run-other" }, ctxFor(w, alice, { spawn }))).toBe("not_found");
  });
});

describe("spawn_run — the capability, called with the run's remaining wall clock", () => {
  it("passes the request and the remaining budget to the capability and reports the child's id, thread and link", async () => {
    const spawn = {
      spawn: vi.fn(async () => ({
        kind: "spawned" as const,
        runId: "run-child",
        threadKey: "slack:CX:9.0",
        url: "https://acme.slack.com/archives/CX/p90",
      })),
      childOutcome: () => undefined,
    };
    const out = await spawnRunTool.run(
      { preset: "research", prompt: "what changed in v2?", budget: 10 },
      { executor, spawn, remainingMs: () => 25 * 60_000 },
    );
    expect(spawn.spawn).toHaveBeenCalledWith(
      { preset: "research", prompt: "what changed in v2?", budget: 10 },
      25 * 60_000,
    );
    expect(out).toContain("run-child");
    expect(out).toContain("slack:CX:9.0");
    expect(out).toContain("https://acme.slack.com/archives/CX/p90");
    expect(out).toContain("get_run_status");
  });

  it("relays a refusal by name with the text the child's thread saw", async () => {
    const spawn: SpawnCapability = {
      spawn: async () => ({
        kind: "refused",
        reason: "agent_allowlist",
        message: "🚫 You're not on the allowlist for the `coding` agent.",
      }),
      childOutcome: () => undefined,
    };
    const out = await spawnRunTool.run({ preset: "coding", prompt: "fix", repo: "acme/api" }, { executor, spawn });
    expect(out).toContain("agent_allowlist");
    expect(out).toContain("not on the allowlist");
  });

  it("validates before calling the capability: an unknown preset and a budget under two minutes are string errors naming the rule", async () => {
    const spawn = { spawn: vi.fn(), childOutcome: () => undefined } as unknown as SpawnCapability;
    expect(await spawnRunTool.run({ preset: "turbo", prompt: "x" }, { executor, spawn })).toMatch(
      /unknown preset "turbo"/,
    );
    expect(await spawnRunTool.run({ preset: "research", prompt: "x", budget: 1 }, { executor, spawn })).toMatch(
      /budget.*at least 2/,
    );
    expect(await spawnRunTool.run({ preset: "research", prompt: "" }, { executor, spawn })).toMatch(/prompt/);
    expect(spawn.spawn).not.toHaveBeenCalled();
  });

  it("outside a spawning run the null capability answers an honest refusal, and nothing starts", async () => {
    const out = await spawnRunTool.run({ preset: "research", prompt: "x" }, { executor });
    expect(out).toContain("spawn_unavailable");
    expect(out).toMatch(/no run is spawning here/);
  });

  it("RUN_TOOLS is exactly the three, and none is side-effect free (a spawn starts a run; the reads answer about live state and run in order)", () => {
    expect(RUN_TOOLS.map((t) => t.name)).toEqual(["spawn_run", "list_runs", "get_run_status"]);
    for (const t of RUN_TOOLS) expect(t.sideEffectFree).toBeUndefined();
  });
});
