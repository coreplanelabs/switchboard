import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { actor } from "../core/authz/testing.js";
import { createHomeService } from "../core/home/service.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { makePageSender } from "./webShell.js";
import { createHomeViewHandler } from "./homeView.js";
import { resolveWorkViewScope, withWorkViewScope } from "./workViewScope.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { seedCoordinatorUnit } from "../core/testing/coordinatorInstance.js";
import { createHomeConditionReader } from "../core/home/conditions.js";
import { CommandRegistry } from "../core/commandRegistry.js";
import { registerMergeCommands, type MergeCommandDeps } from "../core/commands/merge.js";
import { callerWith } from "../core/testing/callers.js";

const viewer = actor("user", "access:alice", { actions: "all", channels: "all", repos: "all" });
function response() {
  let status = 0,
    body = "",
    complete: () => void;
  const ended = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    ended,
    value: () => ({ status, body }),
    res: {
      setHeader() {},
      writeHead(value: number) {
        status = value;
      },
      end(value: string) {
        body = value;
        complete();
      },
    } as unknown as ServerResponse,
  };
}
function handler() {
  const service = createHomeService({
    organizationId: "installation-a",
    instances: { listInstances: async () => ({ items: [] }), listUnits: async () => [] },
  });
  return createHomeViewHandler(
    service,
    makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
    "installation-a",
  );
}
const request = (url: string, method = "GET") =>
  ({ url, method, headers: { accept: "application/json" } }) as IncomingMessage;

describe("authorized Home pages", () => {
  it.each([
    { count: 199, status: "complete", partial: undefined, notices: [] },
    { count: 200, status: "partial", partial: true, notices: [{ event: "home.runs.limit_reached", limit: 200 }] },
  ])("reports a run-list limit only when reached at $count rows", async ({ count, status, partial, notices }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const read = createHomeViewHandler(
        createHomeService({ organizationId: "installation-a", instances: new InMemoryCoordinatorInstanceStore() }),
        makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
        "installation-a",
        {
          now: () => 2,
          liveRuns: async () => ({
            runs: Array.from({ length: count }, (_, index) => ({
              id: `private-run-${index}`,
              agent: "review",
              label: "Private run label",
              startedAt: 1,
              finished: false,
              eventCount: 0,
              liveState: { state: "working" as const, since: 1, bound: 1000 },
            })),
          }),
        },
      );
      const out = response();
      read(request("/home/snapshot?view=moving"), out.res, { actor: viewer, organization: "installation-a" });
      await out.ended;
      expect(out.value().status).toBe(200);
      const body = JSON.parse(out.value().body);
      expect(body.status).toBe(status);
      expect(body.overview.runsPartial).toBe(partial);
      expect(body.overview.counts.moving).toBe(count);
      expect(body.overview.runs).toHaveLength(50);
      expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual(notices);
    } finally {
      warn.mockRestore();
    }
  });
  it("keeps failed live-run reads partial and reports no private error details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const read = createHomeViewHandler(
        createHomeService({ organizationId: "installation-a", instances: new InMemoryCoordinatorInstanceStore() }),
        makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
        "installation-a",
        {
          liveRuns: async () => {
            throw new Error("PRIVATE_RUN_DETAIL");
          },
        },
      );
      const out = response();
      read(request("/home/snapshot"), out.res, { actor: viewer, organization: "installation-a" });
      await out.ended;
      expect(out.value().status).toBe(200);
      expect(JSON.parse(out.value().body)).toMatchObject({
        status: "partial",
        overview: { runsPartial: true, runs: [] },
      });
      expect(warn.mock.calls).toEqual([[JSON.stringify({ event: "home.runs.unavailable", reason: "read_failed" })]]);
      expect(out.value().body).not.toContain("PRIVATE_RUN_DETAIL");
    } finally {
      warn.mockRestore();
    }
  });
  it("serves bounded work pages with full unknown-work counts and permission-filtered standalone reviews", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put({
      id: "backlog",
      kind: "ship",
      userId: viewer.id,
      channelId: "mcp:default",
      threadKey: "mcp:default:one",
      repo: "sample/api",
      branch: "work",
      createdAt: 1,
    });
    await instances.putUnits(
      Array.from({ length: 55 }, (_, i) => ({
        instanceId: "backlog",
        unit: `U${i}`,
        slug: `u${i}`,
        branch: "work",
        dependsOn: [],
        rounds: [],
      })),
    );
    const liveRuns = vi.fn(async (_visibleTo: import("../core/authz/types.js").Predicate) => ({
      runs: [
        {
          id: "review",
          agent: "review",
          label: "Review current work",
          startedAt: 1,
          finished: false,
          eventCount: 0,
          liveState: { state: "working" as const, since: 1, bound: 1000 },
        },
      ],
    }));
    let fenced = false;
    let local = true;
    let included: readonly string[] = [];
    const read = createHomeViewHandler(
      createHomeService({ organizationId: "installation-a", instances }),
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        liveRuns,
        liveTokens: () =>
          new Map(
            local
              ? [
                  ["review", "local-token"],
                  ["foreign", "foreign-token"],
                ]
              : [],
          ),
        now: () => 2,
        privateRead: () => ({
          begin: async () => true,
          readMany: async () => new Map(),
          include: (keys) => {
            included = keys;
          },
          canEmit: async () => !fenced,
        }),
      },
    );
    const get = async (url: string) => {
      const out = response();
      read(request(url), out.res, { actor: viewer, organization: "installation-a" });
      await out.ended;
      return JSON.parse(out.value().body);
    };
    const first = await get("/home/snapshot?view=investigation");
    expect(first.waiting).toHaveLength(50);
    expect(included).toHaveLength(55);
    expect(first.overview).toMatchObject({
      counts: { moving: 1, waiting: 0, investigation: 55, pipelines: 0 },
      page: 1,
      pages: 2,
    });
    expect((await get("/home/snapshot?view=investigation&page=2")).waiting).toHaveLength(5);
    const active = await get("/home/snapshot?view=moving");
    expect(active.overview.runs).toEqual([
      {
        id: "review",
        agent: "review",
        label: "Review current work",
        startedAt: 1,
        liveState: { state: "working", since: 1, bound: 1000 },
        stateLabel: "working",
        viewPath: "/runs/review?t=local-token",
      },
    ]);
    expect(liveRuns.mock.calls[0]).toEqual([{ kind: "user-is", userId: "access:alice" }]);
    expect(JSON.stringify(active)).not.toContain("foreign-token");
    local = false;
    expect((await get("/home/snapshot?view=moving")).overview.runs[0].viewPath).toBe("/runs/review");
    fenced = true;
    const denied = response();
    read(request("/home/snapshot?view=moving"), denied.res, { actor: viewer, organization: "installation-a" });
    await denied.ended;
    expect(denied.value()).toEqual({ status: 404, body: "not found" });
  });
  it("observes a known registry merge through the existing targeted snapshot before direct History navigation", async () => {
    const now = Date.parse("1970-01-10T12:00:00Z"),
      head = "a".repeat(40);
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put({
      id: "merge-work",
      kind: "ship",
      userId: "access:alice",
      channelId: "web:alice",
      threadKey: "web:alice:original",
      repo: "sample/api",
      branch: "work",
      createdAt: 1,
    });
    const pr = { number: 42, url: "https://github.com/sample/api/pull/42" };
    const ready = {
      instanceId: "merge-work",
      unit: "task",
      slug: "task",
      branch: "work",
      dependsOn: [],
      rounds: [],
      pr,
      lastPush: head,
      ending: { kind: "merge_ready", report: "Original reviewed head.", at: now - 60000 },
      mergeAttention: { assignedTo: "access:alice", pr, headSha: head, at: now - 60000 },
    };
    seedCoordinatorUnit(instances, ready);
    const service = createHomeService({
      organizationId: "installation-a",
      instances,
      conditions: createHomeConditionReader(instances),
    });
    let merged = false;
    let epoch = "current",
      loseSource = false;
    let phase = 0;
    const phases: string[] = [];
    const emittedKeys: Array<{ phase: number; keys: readonly string[] }> = [];
    const observed: string[] = [];
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        now: () => now,
        privateEpoch: async () => epoch,
        privateRead: () => {
          const id = ++phase,
            captured = epoch;
          return {
            begin: async () => {
              phases.push(`begin:${id}`);
              return captured === "current";
            },
            readMany: async (groups) => {
              phases.push(`read:${id}`);
              return new Map(
                groups.flatMap((group) =>
                  group.units.map((row) => [`${group.instance.id}:${row.unit}`, true] as const),
                ),
              );
            },
            include: (keys) => {
              emittedKeys.push({ phase: id, keys });
            },
            canEmit: async () => captured === epoch,
          };
        },
        observeUnit: async (_context, key) => {
          observed.push(key);
          if (!merged) return "held";
          if (loseSource) epoch = "changed";
          const row = (await instances.listUnits("merge-work"))[0]!;
          await instances.compareAndReplaceUnit(row, {
            ...row,
            mergeAttention: {
              ...row.mergeAttention!,
              resolved: { sha: "b".repeat(40), at: now },
            },
          });
          return "observed";
        },
      },
    );
    async function get(url: string, person = viewer) {
      const out = response();
      read(request(url), out.res, { actor: person, organization: "installation-a" });
      await out.ended;
      return { ...out.value(), body: out.value().status === 200 ? JSON.parse(out.value().body) : null };
    }
    expect((await get("/home")).body.snapshot.needsYou[0].unit.unit).toBe("merge-work:task");
    expect((await get("/home/snapshot?observe=invalid")).status).toBe(400);
    expect((await get("/home/snapshot?observe=unknown%3Atask")).status).toBe(404);
    expect((await get("/home/snapshot?observe=merge-work%3Atask&observe=unknown%3Atask")).status).toBe(400);
    expect(
      (await get("/home/snapshot?observe=merge-work%3Atask", { ...viewer, viewingAs: { id: "access:alice" } })).status,
    ).toBe(404);
    seedCoordinatorUnit(instances, { ...ready, mergeAttention: { ...ready.mergeAttention, assignedTo: "access:bob" } });
    expect((await get("/home/snapshot?observe=merge-work%3Atask")).status).toBe(404);
    expect(observed).toEqual([]);
    seedCoordinatorUnit(instances, ready);
    const registry = new CommandRegistry<MergeCommandDeps>({ audit: () => {} });
    registerMergeCommands(registry);
    const result = await registry.invoke(
      "pulls.merge",
      { args: ["sample/api#42"], options: { head } },
      callerWith("access", "access:alice", ["merge:write"]),
      {
        merge: {
          service: async () => ({
            facts: async () => ({ state: "open", headSha: head, title: "Reviewed work" }),
            reviews: async () => [{ state: "APPROVED", commitId: head }],
            checks: async () => ({ total: 1, pending: [], failed: [] }),
            githubLogin: async () => "alice",
            merge: async () => {
              merged = true;
              return { ok: true, sha: "b".repeat(40) };
            },
            enqueue: async () => ({ ok: true }),
          }),
        },
      },
    );
    expect(result).toMatchObject({ ok: true, value: { kind: "merged", by: { user: "access:alice", login: "alice" } } });
    const phaseStart = phase,
      readStart = phases.length;
    expect((await get("/home/snapshot?observe=merge-work%3Atask")).body.needsYou).toEqual([]);
    expect(phases.slice(readStart)).toEqual([
      `begin:${phaseStart + 1}`,
      `read:${phaseStart + 1}`,
      `begin:${phaseStart + 2}`,
      `read:${phaseStart + 2}`,
    ]);
    expect(emittedKeys.slice(-2)).toEqual([
      { phase: phaseStart + 1, keys: ["merge-work:task"] },
      { phase: phaseStart + 2, keys: [] },
    ]);
    const history = await get("/home/history?tz=UTC");
    expect(history.body.history.units[0].unit).toMatchObject({
      unit: "merge-work:task",
      mergeCompletion: { at: now, sha: "b".repeat(40) },
      ending: { kind: "merge_ready", report: "Original reviewed head." },
    });
    expect(observed).toEqual(["merge-work:task"]);
    const repeated = await get("/home/snapshot?observe=merge-work%3Atask");
    expect(repeated.status).toBe(200);
    expect(repeated.body.observation).toBe("observed");
    expect(observed).toEqual(["merge-work:task"]);
    seedCoordinatorUnit(instances, ready);
    loseSource = true;
    const denied = await get("/home/snapshot?observe=merge-work%3Atask");
    expect(denied.status).toBe(404);
    expect(denied.body).toBeNull();
  });
  it("reads a background-completed merge for its saved assignee rather than only its creator", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put({
      id: "assigned-work",
      kind: "ship",
      userId: "access:bob",
      channelId: "web:bob",
      threadKey: "web:bob:original",
      repo: "sample/api",
      branch: "work",
      createdAt: 1,
    });
    const pr = { number: 42, url: "https://github.com/sample/api/pull/42" };
    const unit = {
      instanceId: "assigned-work",
      unit: "task",
      slug: "task",
      branch: "work",
      dependsOn: [],
      rounds: [],
      pr,
      lastPush: "a".repeat(40),
      ending: { kind: "merge_ready", report: "Original reviewed head.", at: 2 },
      mergeAttention: {
        assignedTo: "access:alice",
        pr,
        headSha: "a".repeat(40),
        at: 2,
        resolved: { sha: "b".repeat(40), at: 3 },
      },
    };
    seedCoordinatorUnit(instances, unit);
    const observe = vi.fn(async () => "held" as const);
    const read = createHomeViewHandler(
      createHomeService({
        organizationId: "installation-a",
        instances,
        conditions: createHomeConditionReader(instances),
      }),
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      { observeUnit: observe },
    );
    async function get(person = viewer) {
      const out = response();
      read(request("/home/snapshot?observe=assigned-work%3Atask"), out.res, {
        actor: person,
        organization: "installation-a",
      });
      await out.ended;
      return out.value();
    }
    const assigned = await get();
    expect(assigned.status).toBe(200);
    expect(JSON.parse(assigned.body)).toMatchObject({ observation: "observed", needsYou: [] });
    expect(await get(actor("user", "access:foreign", { actions: "all", channels: "all", repos: "all" }))).toEqual({
      status: 404,
      body: "not found",
    });
    expect(await get({ ...viewer, viewingAs: { id: "access:alice" } })).toEqual({ status: 404, body: "not found" });
    expect(await get(actor("user", "access:alice", { actions: new Set() }))).toEqual({
      status: 404,
      body: "not found",
    });
    expect(observe).not.toHaveBeenCalled();
  });
  it("schedules merge observation only after sending the current Home response", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: { listInstances: async () => ({ items: [] }), listUnits: async () => [] },
    });
    const events: string[] = [];
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        observe: () => {
          events.push("observe");
        },
      },
    );
    for (const path of ["/home", "/home/snapshot"]) {
      const out = response();
      const end = out.res.end.bind(out.res);
      out.res.end = ((body: string) => {
        events.push("response");
        return end(body);
      }) as ServerResponse["end"];
      read(request(path), out.res, { actor: viewer, organization: "installation-a" });
      await out.ended;
      expect(out.value().status).toBe(200);
    }
    expect(events).toEqual(["response", "observe", "response", "observe"]);
  });
  it("selects only serialized unresolved private rows for the final request guard", async () => {
    const instance = {
      id: "owned",
      kind: "ship" as const,
      userId: "access:alice",
      channelId: "web:alice",
      threadKey: "web:alice:1",
      repo: "sample/api",
      branch: "work",
      createdAt: 1,
    };
    const units = Array.from({ length: 1000 }, (_, index) => ({
      instanceId: instance.id,
      unit: `task-${index}`,
      slug: "task",
      branch: "work",
      dependsOn: [],
      rounds: [],
      title: `Private task ${index}`,
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: instance.threadKey,
        actId: `act-${index}`,
        repo: instance.repo,
        base: "main",
        question: "Private source",
        findings: [],
        requestedChange: "Fix it",
      },
      ...(index ? { ending: { kind: "merged", report: "Private report", at: 1 } } : {}),
    }));
    const service = createHomeService({
      organizationId: "installation-a",
      instances: {
        listInstances: async () => ({ items: [instance] }),
        listUnits: async () => units,
      },
    });
    let selected: readonly string[] = [];
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        privateRead: () => ({
          begin: async () => true,
          readMany: async (groups) =>
            new Map(
              groups.flatMap(({ instance, units }) =>
                units.map((unit) => [`${instance.id}:${unit.unit}`, true] as const),
              ),
            ),
          include: (keys) => {
            selected = keys;
          },
          canEmit: async () => true,
        }),
      },
    );
    const output = response();
    read(request("/home"), output.res, { actor: viewer, organization: "installation-a" });
    await output.ended;
    expect(output.value().status).toBe(200);
    expect(
      JSON.parse(output.value().body).snapshot.waiting.map((row: { unit: { title: string } }) => row.unit.title),
    ).toEqual(["Private task 0"]);
    expect(selected).toEqual(["owned:task-0"]);
    expect(output.value().body).not.toContain("Private task 999");
  });
  it("includes server-proved own answers in All people while Person cannot acquire an answer", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: { listInstances: async () => ({ items: [] }), listUnits: async () => [] },
    });
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        answers: async () => ({
          "own:answer": { thread: "worker:own:answer", revision: 1, question: "Own recorded question" },
        }),
      },
    );
    const actual = actor(
      "user",
      "access:alice",
      {},
      { grants: { actions: "all", channels: "all", repos: "all", organizations: "all" } },
    );
    withWorkViewScope(actual, resolveWorkViewScope(actual, { organization: "installation-a", mode: "everyone" }));
    expect(resolveWorkViewScope(actual, { organization: "installation-a", mode: "everyone" }).mode).toBe("everyone");
    const all = response();
    read(request("/home"), all.res, { actor: actual, organization: "installation-a" });
    await all.ended;
    expect(JSON.parse(all.value().body)).toMatchObject({
      page: "fleetHome",
      answers: { "own:answer": { thread: "worker:own:answer", revision: 1, question: "Own recorded question" } },
    });
    const person = { ...actual, viewingAs: { id: "access:bob" } };
    withWorkViewScope(person, resolveWorkViewScope(person, { organization: "installation-a" }));
    const viewed = response();
    read(request("/home"), viewed.res, { actor: person, organization: "installation-a" });
    await viewed.ended;
    expect(JSON.parse(viewed.value().body).answers).toBeUndefined();
  });
  it("opens an authorized private unit thread without seeding private input and fences permission loss before emission", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: { listInstances: async () => ({ items: [] }), listUnits: async () => [] },
    });
    let readable = true,
      revoke = false;
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        privateEpoch: async () => (readable ? "current-source" : undefined),
        thread: async (_context, key) => {
          if (!readable || key !== "worker:private-work:question") return;
          if (revoke) readable = false;
          return {
            label: "Owned unit",
            revision: 1,
            canWrite: true,
            entries: [{ id: "worker:1", role: "assistant", content: "Private recorded reply", isViewer: false }],
            history: { cursor: 1, hasMore: false, status: "partial" },
          };
        },
      },
    );
    const allowed = response();
    expect(
      read(request("/threads/worker%3Aprivate-work%3Aquestion"), allowed.res, {
        actor: viewer,
        organization: "installation-a",
      }),
    ).toBe(true);
    await allowed.ended;
    expect(allowed.value().status).toBe(200);
    expect(JSON.parse(allowed.value().body)).toMatchObject({
      page: "home",
      conversation: "worker:private-work:question",
      turns: [],
      conversations: [],
      suggestions: [],
      sendUrl: "",
    });
    expect(allowed.value().body).not.toContain("Private recorded reply");
    const unknown = response();
    read(request("/threads/worker%3Aforeign%3Aquestion"), unknown.res, {
      actor: viewer,
      organization: "installation-a",
    });
    await unknown.ended;
    expect(unknown.value()).toEqual({ status: 404, body: "not found" });
    revoke = true;
    const denied = response();
    read(request("/threads/worker%3Aprivate-work%3Aquestion"), denied.res, {
      actor: viewer,
      organization: "installation-a",
    });
    await denied.ended;
    expect(denied.value()).toEqual({ status: 404, body: "not found" });
  });
  it("fences private Home text when source permission changes during answer enrichment", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: {
        listInstances: async () => ({
          items: [
            {
              id: "private-work",
              kind: "ship",
              userId: "access:alice",
              channelId: "web:alice",
              threadKey: "web:alice:organization",
              repo: "example/app",
              branch: "work",
              createdAt: 1,
            },
          ],
        }),
        listUnits: async () => [
          {
            instanceId: "private-work",
            unit: "question",
            slug: "question",
            title: "Private source question",
            branch: "work/question",
            dependsOn: [],
            rounds: [],
            workBrief: {} as import("../core/coordinator/contract.js").CoordinatorUnit["workBrief"],
          },
        ],
      },
    });
    let readable = true,
      revoke = false;
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        privateUnit: async () => readable,
        privateEpoch: async () => "unchanged-host-epoch",
        answers: async () => {
          if (revoke) readable = false;
          return {};
        },
      },
    );
    const allowed = response();
    read(request("/home"), allowed.res, { actor: viewer, organization: "installation-a" });
    await allowed.ended;
    expect(allowed.value().status).toBe(200);
    expect(allowed.value().body).toContain("Private source question");
    revoke = true;
    const denied = response();
    read(request("/home"), denied.res, { actor: viewer, organization: "installation-a" });
    await denied.ended;
    expect(denied.value()).toEqual({ status: 404, body: "not found" });
  });
  it("uses the proved person for attention while retaining the credential's read authority", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: {
        listInstances: async () => ({
          items: [
            {
              id: "own-work",
              kind: "ship",
              userId: "access:alice",
              channelId: "slack:private",
              threadKey: "slack:private:1",
              repo: "example/app",
              branch: "work",
              createdAt: 1,
            },
            {
              id: "hidden-work",
              kind: "ship",
              userId: "person:alice",
              channelId: "slack:private",
              threadKey: "slack:private:2",
              repo: "example/app",
              branch: "work",
              createdAt: 2,
            },
          ],
        }),
        listUnits: async (instanceId) => [
          { instanceId, unit: "question", slug: "question", branch: "work/question", dependsOn: [], rounds: [] },
        ],
      },
      conditions: {
        list: async (unitKey) => [
          {
            id: `ask:${unitKey}`,
            unitKey,
            revision: 1,
            state: "open",
            owner: { kind: "person", id: "person:alice" },
            summary: "Confirm the target",
            nextAction: "Choose staging",
          },
        ],
      },
    });
    const admitted = actor("user", "access:alice", { actions: new Set(["runs:read"]) });
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
    );
    const output = response();
    read(request("/home/snapshot?actor=person:alice&attentionRecipient=person:foreign"), output.res, {
      actor: admitted,
      organization: "installation-a",
      attentionRecipient: "person:alice",
    });
    await output.ended;
    const snapshot = JSON.parse(output.value().body);
    expect(snapshot.attentionRecipient).toBe("person:alice");
    expect(snapshot.needsYou.map((row: { unit: { unit: string } }) => row.unit.unit)).toEqual(["own-work:question"]);
    expect(JSON.stringify(snapshot)).not.toContain("hidden-work");
    const forged = response();
    read(request("/home/snapshot?attentionRecipient=person:alice"), forged.res, {
      actor: admitted,
      organization: "installation-a",
    });
    await forged.ended;
    expect(JSON.parse(forged.value().body)).toMatchObject({ attentionRecipient: "access:alice", needsYou: [] });
  });
  it("ignores client actor and organization claims and paints the admitted organization", async () => {
    const output = response();
    expect(
      handler()(request("/home?organization=foreign&actor=bob"), output.res, {
        actor: viewer,
        organization: "installation-a",
      }),
    ).toBe(true);
    await output.ended;
    expect(output.value().status).toBe(200);
    expect(JSON.parse(output.value().body)).toMatchObject({
      page: "fleetHome",
      attentionRecipient: "access:alice",
      snapshot: { organizationId: "installation-a", status: "complete", needsYou: [], moving: [], waiting: [] },
    });
  });
  it("refuses absent and foreign tenant admission before building a page", async () => {
    for (const context of [{}, { actor: viewer, organization: "foreign" }]) {
      const output = response();
      handler()(request("/home"), output.res, context);
      await output.ended;
      expect(output.value()).toEqual({ status: 404, body: "not found" });
    }
  });
  it("keeps an unknown pipeline non-revealing and exposes a separate completed history page", async () => {
    const unknown = response();
    handler()(request("/pipelines/missing"), unknown.res, { actor: viewer, organization: "installation-a" });
    await unknown.ended;
    expect(unknown.value()).toEqual({ status: 404, body: "not found" });
    const history = response();
    handler()(request("/home/history"), history.res, { actor: viewer, organization: "installation-a" });
    await history.ended;
    expect(JSON.parse(history.value().body)).toMatchObject({
      page: "fleetHistory",
      history: { organizationId: "installation-a", status: "complete", units: [] },
    });
  });
  it("keeps completed pipeline links readable and preserves proven moving activity", async () => {
    const completed = {
      id: "completed",
      kind: "ship" as const,
      userId: "access:alice",
      channelId: "slack:C1",
      threadKey: "slack:C1:1",
      repo: "example/app",
      branch: "work",
      createdAt: 1,
    };
    const moving = { ...completed, id: "moving" };
    const home = createHomeService({
      organizationId: "installation-a",
      instances: {
        get: async (id) => (id === completed.id ? completed : id === moving.id ? moving : null),
        listInstances: async () => ({ items: [completed, moving] }),
        listUnits: async (id) => [
          {
            instanceId: id,
            unit: "unit",
            slug: "unit",
            branch: "work/unit",
            dependsOn: [],
            rounds: [],
            ...(id === "completed" ? { ending: { kind: "merged", at: 2, report: "Done" } } : {}),
          },
        ],
      },
      liveUnitRuns: async () => new Map([["moving:unit", new Set(["original-child"])]]),
    });
    const read = createHomeViewHandler(
      home,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
    );
    const finished = response();
    read(request("/pipelines/completed?attentionRecipient=person:foreign"), finished.res, {
      actor: viewer,
      organization: "installation-a",
      attentionRecipient: "person:alice",
    });
    await finished.ended;
    expect(finished.value().status).toBe(200);
    expect(JSON.parse(finished.value().body)).toMatchObject({
      page: "fleetPipeline",
      status: "complete",
      attentionRecipient: "person:alice",
      pipeline: { unresolved: 0, units: [{ unit: { unit: "completed:unit" } }] },
    });
    const active = response();
    read(request("/pipelines/moving"), active.res, { actor: viewer, organization: "installation-a" });
    await active.ended;
    expect(JSON.parse(active.value().body)).toMatchObject({
      page: "fleetPipeline",
      pipeline: { units: [{ unit: { unit: "moving:unit" }, activity: "moving" }] },
    });
  });
  it("returns unavailable rather than not found when canonical pipeline lookup is incomplete", async () => {
    const home = createHomeService({
      organizationId: "installation-a",
      maxPages: 1,
      instances: { listInstances: async () => ({ items: [], cursor: "more" }), listUnits: async () => [] },
    });
    const read = createHomeViewHandler(
      home,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
    );
    const output = response();
    read(request("/pipelines/not-yet-read"), output.res, { actor: viewer, organization: "installation-a" });
    await output.ended;
    expect(output.value()).toEqual({ status: 503, body: "Work is unavailable." });
  });
});
