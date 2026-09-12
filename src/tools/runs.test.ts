import { describe, expect, it, vi } from "vitest";
import { NO_GRANTS, type Actor } from "../core/authz/types.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService, LEDGER_LIST_TTL_MS } from "../core/runsService.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent } from "../core/runEvents.js";
import type { RunRecord } from "../core/runRecord.js";
import type { SpawnCapability } from "../core/dispatch/spawn.js";
import { steerRun, type DispatchFollowUp } from "../core/dispatch/admission.js";
import { AWAIT_POLL_MS, waitCapabilityFor, type WaitCapability } from "../core/dispatch/awaitChildren.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { RunControl } from "../core/runRegistry/runControl.js";
import { FollowUpInbox, ThreadAdmission } from "../core/threadAdmission.js";
import { RUN_DEADLINE_RESERVE_MS } from "../execution/bashTimeout.js";
import type { Executor } from "../execution/executor.js";
import type { ToolContext } from "./workspace.js";
import {
  awaitRunsTool,
  getRunStatusTool,
  listRunsTool,
  RUN_TOOLS,
  sendToRunTool,
  spawnRunTool,
  type SteerCapability,
} from "./runs.js";

// Feature: docs/reference/specs/agent-conductor.md items 3–4 and 8 — the run
// tools a spawning run holds: `spawn_run` calls the spawn capability with the
// run's remaining wall clock; `list_runs` and `get_run_status` answer through
// `RunsService` under the requester's own `runs:read` predicate, so a parent
// sees exactly the runs its requester may (docs/reference/specs/authorization.md
// items 5–6) and a denied point read is `not_found` like an unknown id;
// `send_to_run` steers a live child through the inbox a thread reply takes;
// `await_runs` waits for the named runs' ends within the parent's budget and
// hands each end back as data.

const NOW = 100_000;
const executor = {} as Executor;

function world() {
  let n = 0;
  const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  const ledger = new InMemoryRunLedger(() => NOW);
  // The service's own clock paces its ledger listing cache; a test that changes
  // the ledger between reads advances it past the cache's TTL.
  let serviceAt = NOW;
  const service = createRunsService({ registry, store, ledger, clock: () => serviceAt });
  return { registry, store, ledger, service, advanceService: (ms: number) => void (serviceAt += ms) };
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

  it("RUN_TOOLS is exactly the five; only `await_runs` is side-effect free (a pure wait: it may run beside the reads and runs again at a resume), never a spawn, a steer or the reads of live state", () => {
    expect(RUN_TOOLS.map((t) => t.name)).toEqual([
      "spawn_run",
      "send_to_run",
      "await_runs",
      "list_runs",
      "get_run_status",
    ]);
    for (const t of RUN_TOOLS) expect(t.sideEffectFree, t.name).toBe(t.name === "await_runs" ? true : undefined);
  });
});

/** A live child in the registry (a research run of alice's, spawned by `run-p`) holding its own thread slot. */
function liveChild(
  w: ReturnType<typeof world>,
  admission: ThreadAdmission<DispatchFollowUp>,
  over: { parentRunId?: string; channelId?: string; userId?: string; visibility?: "public" | "private" } = {},
) {
  const threadKey = `slack:CX:${Math.random()}`;
  const run = w.registry.create("research · child", {
    agent: "research",
    channelId: over.channelId ?? "slack:CX",
    userId: over.userId ?? "slack:UALICE",
    threadKey,
    channelVisibility: over.visibility ?? "public",
    ...("parentRunId" in over ? (over.parentRunId ? { parentRunId: over.parentRunId } : {}) : { parentRunId: "run-p" }),
  });
  const slot = admission.claim(threadKey, { agent: "research", now: NOW });
  slot.live.runId = run.id;
  return { run, threadKey, slot: slot.live };
}

/** The steer as `runToolCapabilities` builds it: the real `steerRun` over a
 *  recording ledger push and an allowlist the test controls, sending as alice
 *  from the parent run `run-p` in the parent's thread. */
function steerFor(
  admission: ThreadAdmission<DispatchFollowUp>,
  opts: { allow?: boolean; pushSeq?: number | undefined } = {},
): SteerCapability & { pushes: Array<{ runId: string; message: Record<string, unknown> }> } {
  const pushes: Array<{ runId: string; message: Record<string, unknown> }> = [];
  return {
    pushes,
    steer: (target, text) =>
      steerRun(
        {
          config: { canRunAgent: () => opts.allow ?? true },
          runLedger: {
            pushInbox: async (runId, message) => {
              pushes.push({ runId, message });
              return "pushSeq" in opts ? opts.pushSeq : 21;
            },
          },
          clock: () => NOW,
          admission,
        },
        {
          userId: "slack:UALICE",
          userName: "alice",
          channelId: "slack:CX",
          sourceUrl: "https://acme.slack.com/archives/CX/p10",
          from: { runId: "run-p" },
        },
        target,
        text,
      ),
  };
}

describe("send_to_run — a parent steers a live child through the inbox a thread reply takes", () => {
  it("on a live child: the text lands in the child's inbox as the requesting user with the parent run as `from`, the durable copy is pushed first, and the parent is told it is folded in and read at the child's next step", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { run, slot } = liveChild(w, admission);
    const steer = steerFor(admission);
    const out = await sendToRunTool.run(
      { id: run.id, text: "narrow it to Workers" },
      ctxFor(w, alice, { runId: "run-p", steer }),
    );
    expect(out).toMatch(/^steered/);
    expect(out).toContain(run.id);
    expect(out).toContain("next step");
    expect(steer.pushes).toEqual([
      expect.objectContaining({
        runId: run.id,
        message: expect.objectContaining({ text: "narrow it to Workers", userId: "slack:UALICE", fromRunId: "run-p" }),
      }),
    ]);
    const [item] = slot.inbox.drain();
    expect(item).toMatchObject({
      text: "narrow it to Workers",
      userId: "slack:UALICE",
      userName: "alice",
      from: { runId: "run-p" },
      ledgerSeq: 21,
    });
    expect(item.io).toBeUndefined();
  });

  it("a child live on another generation (no slot here, the ledger took the copy) is steered through its durable inbox, and the parent is told so", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const child = liveChild(w, admission);
    admission.release(child.threadKey, child.slot); // in the registry here, but the slot is another generation's
    const steer = steerFor(admission);
    const out = await sendToRunTool.run(
      { id: child.run.id, text: "narrow it" },
      ctxFor(w, alice, { runId: "run-p", steer }),
    );
    expect(out).toMatch(/^steered/);
    expect(out).toContain("another bot generation");
  });

  it("refused by name: a run that already ended is `not_live` with its status and nothing is pushed; a run this run did not spawn is `not_child`; an unknown id and one the requester may not read are `not_found`", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const steer = steerFor(admission);
    await w.store.put(persisted("r-done", { parentRunId: "run-p" }));
    expect(
      await sendToRunTool.run({ id: "r-done", text: "more" }, ctxFor(w, alice, { runId: "run-p", steer })),
    ).toMatch(/^not_live: r-done .*completed/);
    const { run: other } = liveChild(w, admission, { parentRunId: "run-someone-else" });
    expect(
      await sendToRunTool.run({ id: other.id, text: "more" }, ctxFor(w, alice, { runId: "run-p", steer })),
    ).toMatch(/^not_child/);
    const { run: secret } = liveChild(w, admission, {
      channelId: "slack:CPRIV",
      userId: "slack:UBOB",
      visibility: "private",
    });
    expect(await sendToRunTool.run({ id: secret.id, text: "more" }, ctxFor(w, alice, { runId: "run-p", steer }))).toBe(
      "not_found",
    );
    expect(await sendToRunTool.run({ id: "run-nope", text: "more" }, ctxFor(w, alice, { runId: "run-p", steer }))).toBe(
      "not_found",
    );
    expect(steer.pushes).toEqual([]);
  });

  it("a requester the live agent's allowlist excludes is refused as a thread reply would be; a child that ended during the push is `not_live`; an empty text is a string error; without the capability the tool says so", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { run } = liveChild(w, admission);
    const denied = steerFor(admission, { allow: false });
    expect(
      await sendToRunTool.run({ id: run.id, text: "more" }, ctxFor(w, alice, { runId: "run-p", steer: denied })),
    ).toMatch(/^refused \(live_agent_allowlist\)/);
    expect(denied.pushes).toEqual([]);
    // The slot is gone and the ledger refused the push: nothing is live to hear it.
    const orphan = liveChild(w, admission);
    admission.release(orphan.threadKey, orphan.slot);
    const refusedPush = steerFor(admission, { pushSeq: undefined });
    expect(
      await sendToRunTool.run(
        { id: orphan.run.id, text: "more" },
        ctxFor(w, alice, { runId: "run-p", steer: refusedPush }),
      ),
    ).toMatch(/^not_live/);
    expect(
      await sendToRunTool.run({ id: run.id, text: "  " }, ctxFor(w, alice, { runId: "run-p", steer: denied })),
    ).toMatch(/text/);
    expect(await sendToRunTool.run({ id: run.id, text: "more" }, { executor })).toBe(
      "run tools are not available in this context.",
    );
    expect(await sendToRunTool.run({ id: run.id, text: "more" }, ctxFor(w, alice, { runId: "run-p" }))).toBe(
      "run tools are not available in this context.",
    );
  });
});

/** The wait as the dispatcher builds it, over a virtual clock: every sleep
 *  advances the clock by its delay, and the test may hand it hooks — one per
 *  sleep, in order — that run at the sleep's start (a child finishing, a stop,
 *  a follow-up); a hook that returns `"hold"` leaves the sleep pending until
 *  its signal aborts, so only a registry wake or a hard stop can end it. */
function waitFor(
  w: ReturnType<typeof world>,
  opts: { control?: RunControl; inbox?: FollowUpInbox; hooks?: Array<() => void | "hold"> } = {},
) {
  let at = NOW;
  const slept: Array<{ ms: number; signal: AbortSignal | undefined }> = [];
  const hooks = [...(opts.hooks ?? [])];
  const wait: WaitCapability = waitCapabilityFor({
    registry: w.registry,
    control: opts.control ?? new RunControl(),
    inbox: opts.inbox ?? new FollowUpInbox(),
    clock: () => at,
    sleep: (ms, signal) => {
      slept.push({ ms, signal });
      const hook = hooks.shift();
      if (hook?.() === "hold")
        return new Promise((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      at += ms;
      return Promise.resolve();
    },
  });
  return { wait, slept, now: () => at };
}

const report = (out: unknown) =>
  JSON.parse(String(out)) as {
    ended: string;
    waitedMs: number;
    note: string;
    runs: Array<Record<string, unknown>>;
  };

describe("await_runs — the children's ends, as data, within the parent's budget", () => {
  it("every named run ended: each end comes back with its status — a completed child with its final reply wrapped as untrusted content, an interrupted child as `interrupted` (nothing restarts it), an id the requester may not read as `not_found` — and the wait never slept", async () => {
    const w = world();
    await w.store.put(persisted("r-done", { parentRunId: "run-p" }));
    await w.store.put(
      persisted("r-cut", {
        parentRunId: "run-p",
        status: "interrupted",
        events: [],
        eventCount: 0,
        storedEventCount: 0,
      }),
    );
    await w.store.put(
      persisted("r-secret", { channelId: "slack:CPRIV", userId: "slack:UBOB", channelVisibility: "private" }),
    );
    const { wait, slept } = waitFor(w);
    const before = w.registry.size();
    const out = report(
      await awaitRunsTool.run(
        { ids: ["r-done", "r-cut", "r-secret", "run-nope"] },
        ctxFor(w, alice, { runId: "run-p", wait, remainingMs: () => 30 * 60_000 }),
      ),
    );
    expect(out.ended).toBe("all_ended");
    expect(out.runs.map((r) => [r.id, r.status])).toEqual([
      ["r-done", "completed"],
      ["r-cut", "interrupted"],
      ["r-secret", "not_found"],
      ["run-nope", "not_found"],
    ]);
    expect(String(out.runs[0].finalReply)).toContain("A Durable Object is a single-instance coordination point.");
    expect(String(out.runs[0].finalReply)).toMatch(/untrusted/i);
    expect(out.runs[0]).toMatchObject({ agent: "research", threadKey: "slack:CX:r-done" });
    expect("finalReply" in out.runs[1]).toBe(false);
    expect(slept).toEqual([]);
    expect(w.registry.size()).toBe(before); // nothing was restarted or created
    expect(out.waitedMs).toBe(0);
  });

  it("a child ending in this process wakes the wait through the registry's end frame — the sleep is never left to run out — and its reply comes back", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { run } = liveChild(w, admission);
    const finishChild = () => {
      w.registry.publish(run.id, { type: "answer", text: "Workers are isolates." });
      w.registry.finish(run.id, "completed");
      w.registry.seal(run.id, { replyOk: true });
      return "hold" as const;
    };
    const { wait, slept } = waitFor(w, { hooks: [finishChild] });
    const out = report(
      await awaitRunsTool.run(
        { ids: [run.id] },
        ctxFor(w, alice, { runId: "run-p", wait, remainingMs: () => 30 * 60_000 }),
      ),
    );
    expect(out.ended).toBe("all_ended");
    expect(out.runs[0]).toMatchObject({ id: run.id, status: "completed", agent: "research" });
    expect(String(out.runs[0].finalReply)).toContain("Workers are isolates.");
    expect(slept).toHaveLength(1); // one sleep, held — the wake ended it
    expect(slept[0].ms).toBe(AWAIT_POLL_MS);
  });

  it("the parent's remaining budget less the wrap-up reserve ends the wait as `budget`: the children still running are reported as such with their activity and keep running; the note says to write up", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { run } = liveChild(w, admission);
    w.registry.publish(run.id, { type: "tool_call", tool: "web_fetch", summary: "GET https://example.com" });
    const { wait, slept, now } = waitFor(w);
    const remaining = RUN_DEADLINE_RESERVE_MS + 12_000; // 12 s of waiting before the edge
    const out = report(
      await awaitRunsTool.run(
        { ids: [run.id] },
        ctxFor(w, alice, { runId: "run-p", wait, remainingMs: () => remaining }),
      ),
    );
    expect(out.ended).toBe("budget");
    expect(out.runs[0]).toMatchObject({ id: run.id, status: "running" });
    expect(String(out.runs[0].activity)).toContain("example.com");
    expect(out.note).toMatch(/write up/i);
    expect(out.note).toContain(run.id);
    // Slept in poll-sized steps, the last one clipped to the edge, and stopped exactly there.
    expect(slept.map((s) => s.ms)).toEqual([AWAIT_POLL_MS, AWAIT_POLL_MS, 2_000]);
    expect(now()).toBe(NOW + 12_000);
    expect(out.waitedMs).toBe(12_000);
    expect(w.registry.getById(run.id)?.finished).toBe(false); // still running
  });

  it("`timeoutMinutes` is the caller's own cap: the wait ends as `timeout` when it elapses first; a budget already inside the reserve ends at once as `budget` without a read of the clock", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { run } = liveChild(w, admission);
    const t = waitFor(w);
    const timedOut = report(
      await awaitRunsTool.run(
        { ids: [run.id], timeoutMinutes: 1 },
        ctxFor(w, alice, { runId: "run-p", wait: t.wait, remainingMs: () => 60 * 60_000 }),
      ),
    );
    expect(timedOut.ended).toBe("timeout");
    expect(timedOut.runs[0]).toMatchObject({ status: "running" });
    expect(t.now()).toBe(NOW + 60_000);
    const b = waitFor(w);
    const edge = report(
      await awaitRunsTool.run(
        { ids: [run.id] },
        ctxFor(w, alice, { runId: "run-p", wait: b.wait, remainingMs: () => RUN_DEADLINE_RESERVE_MS - 1 }),
      ),
    );
    expect(edge.ended).toBe("budget");
    expect(b.slept).toEqual([]);
  });

  it("a stop ends the wait at once as `stop`; a follow-up landing in the parent's own inbox ends it as `follow_up`, so the parent hears it at its next step", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { run } = liveChild(w, admission);
    const control = new RunControl();
    const stopped = waitFor(w, { control, hooks: [() => void control.requestStop("soft")] });
    const s = report(
      await awaitRunsTool.run(
        { ids: [run.id] },
        ctxFor(w, alice, { runId: "run-p", wait: stopped.wait, remainingMs: () => 30 * 60_000 }),
      ),
    );
    expect(s.ended).toBe("stop");
    expect(s.runs[0]).toMatchObject({ status: "running" });
    expect(stopped.slept).toHaveLength(1);

    const inbox = new FollowUpInbox();
    const nudged = waitFor(w, {
      inbox,
      hooks: [() => void inbox.push({ text: "also check pricing", userId: "slack:UALICE", at: NOW })],
    });
    const f = report(
      await awaitRunsTool.run(
        { ids: [run.id] },
        ctxFor(w, alice, { runId: "run-p", wait: nudged.wait, remainingMs: () => 30 * 60_000 }),
      ),
    );
    expect(f.ended).toBe("follow_up");
    expect(f.note).toMatch(/follow-up/);
    expect(inbox.size).toBe(1); // left for the runner's drain, never consumed here
  });

  it("a child another generation drives (a ledger row, no registry frame) is reported `running` elsewhere at the cut; once its record is in the store the wait ends from the store alone", async () => {
    const w = world();
    await w.ledger.claim({
      runId: "run-far",
      threadKey: "slack:CX:far",
      gen: "gen-OTHER",
      leaseMs: 30_000,
      startedAt: NOW - 5_000,
      meta: {
        agent: "research",
        channelId: "slack:CX",
        userId: "slack:UALICE",
        threadKey: "slack:CX:far",
        channelVisibility: "public",
        parentRunId: "run-p",
      },
      card: null,
      system: "sys",
      tools: [],
    });
    const far = waitFor(w);
    const cut = report(
      await awaitRunsTool.run(
        { ids: ["run-far"] },
        ctxFor(w, alice, { runId: "run-p", wait: far.wait, remainingMs: () => RUN_DEADLINE_RESERVE_MS }),
      ),
    );
    expect(cut.ended).toBe("budget");
    expect(cut.runs[0]).toMatchObject({ id: "run-far", status: "running", elsewhere: true, agent: "research" });
    // The other generation finished it: its row is gone and its record is in the store.
    await w.ledger.abandon("run-far", "gen-OTHER");
    await w.store.put(persisted("run-far", { parentRunId: "run-p", threadKey: "slack:CX:far" }));
    w.advanceService(LEDGER_LIST_TTL_MS + 1);
    const done = report(
      await awaitRunsTool.run(
        { ids: ["run-far"] },
        ctxFor(w, alice, { runId: "run-p", wait: waitFor(w).wait, remainingMs: () => 30 * 60_000 }),
      ),
    );
    expect(done.ended).toBe("all_ended");
    expect(done.runs[0]).toMatchObject({ id: "run-far", status: "completed" });
  });

  it("a child this run spawned whose row is gone (refused at a gate after it registered) ends by the gate's name from the spawn capability's memory", async () => {
    const w = world();
    const spawn: SpawnCapability = {
      spawn: async () => ({ kind: "refused", reason: "x", message: "" }),
      childOutcome: (id) => (id === "run-gone" ? { status: "refused", refusal: "repo_not_onboarded" } : undefined),
    };
    const out = report(
      await awaitRunsTool.run(
        { ids: ["run-gone"] },
        ctxFor(w, alice, { runId: "run-p", spawn, wait: waitFor(w).wait, remainingMs: () => 30 * 60_000 }),
      ),
    );
    expect(out.ended).toBe("all_ended");
    expect(out.runs[0]).toEqual({ id: "run-gone", status: "refused", reason: "repo_not_onboarded" });
  });

  it("the sleep ends on the run's hard-stop signal, so a hard stop ends a waiting call at once; validation: `ids` must be a non-empty list of strings (duplicates folded), `timeoutMinutes` a whole positive number; without the capability the tool says so", async () => {
    const w = world();
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { run } = liveChild(w, admission);
    const controller = new AbortController();
    const control = new RunControl();
    const hardStop = () => {
      control.requestStop("hard");
      controller.abort();
    };
    const { wait, slept } = waitFor(w, { control, hooks: [hardStop] });
    const out = report(
      await awaitRunsTool.run(
        { ids: [run.id, run.id] },
        ctxFor(w, alice, { runId: "run-p", wait, remainingMs: () => 30 * 60_000, signal: controller.signal }),
      ),
    );
    expect(slept[0].signal?.aborted).toBe(true); // the sleep's signal followed the run's hard stop
    expect(out.ended).toBe("stop");
    expect(out.runs).toHaveLength(1); // the duplicate folded

    const ctx = ctxFor(w, alice, { runId: "run-p", wait: waitFor(w).wait });
    expect(await awaitRunsTool.run({}, ctx)).toMatch(/ids/);
    expect(await awaitRunsTool.run({ ids: [] }, ctx)).toMatch(/ids/);
    expect(await awaitRunsTool.run({ ids: "run-1" }, ctx)).toMatch(/ids/);
    expect(await awaitRunsTool.run({ ids: [run.id], timeoutMinutes: 0 }, ctx)).toMatch(/timeoutMinutes/);
    expect(await awaitRunsTool.run({ ids: [run.id], timeoutMinutes: 1.5 }, ctx)).toMatch(/timeoutMinutes/);
    expect(await awaitRunsTool.run({ ids: [run.id] }, { executor })).toBe(
      "run tools are not available in this context.",
    );
    expect(await awaitRunsTool.run({ ids: [run.id] }, ctxFor(w, alice, { runId: "run-p" }))).toBe(
      "run tools are not available in this context.",
    );
  });
});
