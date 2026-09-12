import { describe, expect, it } from "vitest";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { CoordinatorInstance, CoordinatorTag } from "../core/coordinator/contract.js";
import type { DispatchOutcome } from "../core/dispatch/outcome.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { createRunsService } from "../core/runsService.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent } from "../core/runEvents.js";
import type { RunRecord } from "../core/runRecord.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import type { OpenPrRef } from "../execution/githubPulls.js";
import {
  COORDINATOR_ADMIN_PREFIX,
  createAdminCoordinatorHandler,
  handleCoordinatorRequest,
  isCoordinatorAdminPath,
  type AdminCoordinatorDeps,
} from "./adminCoordinator.js";

// Feature: docs/reference/specs/http-ingress.md item 9 — the bot steps a ship
// coordinator calls: `spawn`, `read-record`, `pr-check` and the shim's
// `authorize` question, behind the `coordinator` bearer whose actor holds
// `coordinator:step`. The spawn never takes an actor from its caller: the
// requester, channel and thread come from the parent ship record, and a
// retried spawn meets its own child by the key on the child's row.

const NOW = 1_700_000_000_000;
const TOKENS = new Secret(
  JSON.stringify({ "tok-coord": { subject: "coordinator" }, "tok-ops": { subject: "ops" } }),
  "SWITCHBOARD_INGRESS_TOKENS",
);
const GRANTS: Record<string, Grants> = {
  "http:coordinator": { actions: new Set(["coordinator:step"]), channels: new Set(), repos: new Set() },
  "http:ops": { actions: new Set(["deploy:write", "runs:read"]), channels: new Set(), repos: new Set() },
};
const INSTANCE: CoordinatorInstance = {
  id: "ship_acme_api_1",
  kind: "ship",
  userId: "slack:UALICE",
  userName: "alice",
  channelId: "slack:C1",
  channelName: "general",
  threadKey: "slack:C1:1.0",
  sourceUrl: "https://acme.slack.com/archives/C1/p1",
  repo: "acme/api",
  branch: "plan/orchestration/u12",
  base: "main",
  createdAt: NOW - 60_000,
};
const KEY = "ship_acme_api_1:u12/0/coding";
const TAG: CoordinatorTag = { parentInstanceId: INSTANCE.id, idempotencyKey: KEY };

const answer = (text: string): RunEvent => ({ type: "answer", text });

function record(id: string, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = [
    { type: "input", text: "do the unit", seq: 1 },
    { ...answer("the handoff"), seq: 2 },
  ];
  return {
    id,
    agent: "coding",
    channelId: INSTANCE.channelId,
    userId: INSTANCE.userId,
    threadKey: INSTANCE.threadKey,
    channelVisibility: "unknown",
    startedAt: NOW - 30_000,
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

type Script = (msg: IncomingMessage, io: ChannelIO, opts: { coordinator: CoordinatorTag }) => Promise<DispatchOutcome>;

/** The child registers, then its dispatch completes: the common path. */
const registers =
  (id: string): Script =>
  async (_msg, io) => {
    io.runStarted?.({ id });
    return { status: "completed" };
  };

function harness(over: { script?: Script; tokens?: Secret | undefined; pr?: OpenPrRef | null | Error } = {}) {
  let n = 0;
  const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  const ledger = new InMemoryRunLedger(() => NOW);
  const runs = createRunsService({ registry, store, ledger, clock: () => NOW + 1 });
  const instances = new InMemoryCoordinatorInstanceStore();
  const dispatched: Array<{ msg: IncomingMessage; opts: { coordinator: CoordinatorTag } }> = [];
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
  const logs: string[] = [];
  const prLookups: Array<[string, string]> = [];
  const deps: AdminCoordinatorDeps = {
    tokens: "tokens" in over ? over.tokens : TOKENS,
    grantsFor: (id) => GRANTS[id] ?? NO_GRANTS,
    instances,
    runs,
    dispatch: async (msg, dispatchIo, opts) => {
      dispatched.push({ msg, opts });
      return (over.script ?? registers("run-child"))(msg, dispatchIo, opts);
    },
    ioFor: () => io,
    findOpenPrByHead: async (repo, branch) => {
      prLookups.push([repo, branch]);
      if (over.pr instanceof Error) throw over.pr;
      return over.pr ?? null;
    },
    clock: () => NOW,
    log: (l) => void logs.push(l),
  };
  return { deps, registry, store, ledger, instances, dispatched, replies, logs, prLookups };
}

/** A POST with the coordinator's bearer by default; `null` sends none. */
const post = (path: string, body: unknown, auth: string | null = "Bearer tok-coord") => ({
  method: "POST",
  path,
  headers: auth !== null ? { authorization: auth } : {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const spawnBody = { parentInstanceId: INSTANCE.id, step: "u12/0/coding", preset: "coding", prompt: "do the unit" };

describe("the coordinator routes — the bearer (item 9)", () => {
  it("names its paths", () => {
    expect(COORDINATOR_ADMIN_PREFIX).toBe("/admin/coordinator/");
    expect(isCoordinatorAdminPath("/admin/coordinator/spawn")).toBe(true);
    expect(isCoordinatorAdminPath("/admin/coordinator")).toBe(false);
    expect(isCoordinatorAdminPath("/admin/restart")).toBe(false);
  });

  it("a bearer without coordinator:step is refused 403 on every route; no bearer is 401; no token map is 503; nothing is dispatched or read", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    for (const path of ["authorize", "spawn", "read-record", "pr-check"]) {
      const body = path === "spawn" ? spawnBody : { parentInstanceId: INSTANCE.id, runId: "run-1" };
      const forbidden = await handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}${path}`, body, "Bearer tok-ops"),
        h.deps,
      );
      expect(forbidden.status, path).toBe(403);
      expect((forbidden.body as { error: string }).error).toContain("coordinator:step");
      const anonymous = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}${path}`, body, null), h.deps);
      expect(anonymous.status, path).toBe(401);
      const unknown = await handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}${path}`, body, "Bearer nope"),
        h.deps,
      );
      expect(unknown.status, path).toBe(401);
    }
    expect(h.dispatched).toEqual([]);
    expect(h.prLookups).toEqual([]);
    const off = harness({ tokens: undefined });
    expect((await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), off.deps)).status).toBe(
      503,
    );
  });

  it("the shim's authorize question answers 200 with the subject for the granted bearer; a non-POST is 405; an unknown step is 404", async () => {
    const h = harness();
    expect(await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}authorize`, ""), h.deps)).toEqual({
      status: 200,
      body: { ok: true, subject: "coordinator" },
    });
    expect(
      (
        await handleCoordinatorRequest(
          { ...post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), method: "GET" },
          h.deps,
        )
      ).status,
    ).toBe(405);
    expect((await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}merge`, {}), h.deps)).status).toBe(404);
  });
});

describe("POST /admin/coordinator/spawn — the child as the parent record's requester (item 9)", () => {
  it("dispatches the child as the instance's user, channel and thread — a body naming another user is ignored — with the preset directive, the repository and the prompt as its text and the coordinator tag as its option; answers the run id and thread at registration", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    const res = await handleCoordinatorRequest(
      post(`${COORDINATOR_ADMIN_PREFIX}spawn`, {
        ...spawnBody,
        userId: "slack:UEVIL",
        channelId: "slack:CEVIL",
        budget: 30,
      }),
      h.deps,
    );
    expect(res).toEqual({ status: 200, body: { ok: true, runId: "run-child", threadKey: INSTANCE.threadKey } });
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].msg).toEqual({
      channelId: INSTANCE.channelId,
      userId: INSTANCE.userId,
      userName: "alice",
      channelName: "general",
      threadKey: INSTANCE.threadKey,
      sourceUrl: INSTANCE.sourceUrl,
      text: "agent:coding budget:30 in acme/api: do the unit",
      receivedAt: NOW,
    });
    expect(h.dispatched[0].opts).toEqual({ coordinator: TAG });
  });

  it("an unknown parentInstanceId is refused 404 and nothing is dispatched", async () => {
    const h = harness();
    const res = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps);
    expect(res).toEqual({ status: 404, body: { ok: false, error: "unknown_instance" } });
    expect(h.dispatched).toEqual([]);
  });

  it("a live run on the instance's thread carrying the same key answers its id with alreadySpawned and starts nothing", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    const live = h.registry.create("coding · child", {
      agent: "coding",
      channelId: INSTANCE.channelId,
      userId: INSTANCE.userId,
      threadKey: INSTANCE.threadKey,
      ...TAG,
    });
    const res = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps);
    expect(res).toEqual({
      status: 200,
      body: { ok: true, runId: live.id, threadKey: INSTANCE.threadKey, alreadySpawned: true },
    });
    expect(h.dispatched).toEqual([]);
  });

  it("a live run on the thread without the key — another step's child, or a person's run — answers busy (409) naming it and starts nothing; a run live on another generation's ledger row counts the same", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    const other = h.registry.create("review · previous", {
      agent: "review",
      channelId: INSTANCE.channelId,
      userId: INSTANCE.userId,
      threadKey: INSTANCE.threadKey,
      parentInstanceId: INSTANCE.id,
      idempotencyKey: "ship_acme_api_1:u12/0/review",
    });
    const busy = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps);
    expect(busy).toEqual({ status: 409, body: { ok: false, error: "busy", runId: other.id, agent: "review" } });
    expect(h.dispatched).toEqual([]);

    const far = harness();
    await far.instances.put(INSTANCE);
    await far.ledger.claim({
      runId: "run-far",
      threadKey: INSTANCE.threadKey,
      gen: "gen-OTHER",
      leaseMs: 30_000,
      startedAt: NOW - 5_000,
      meta: { agent: "coding", channelId: INSTANCE.channelId, userId: INSTANCE.userId, threadKey: INSTANCE.threadKey },
      card: null,
      system: "sys",
      tools: [],
    });
    const farBusy = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), far.deps);
    expect(farBusy).toEqual({ status: 409, body: { ok: false, error: "busy", runId: "run-far", agent: "coding" } });
    expect(far.dispatched).toEqual([]);
  });

  it("a finished run in the instance's thread carrying the key answers its id with alreadySpawned and starts nothing — a retry that lands after the child ended never spawns a second one", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    await h.store.put(record("run-done", { ...TAG }));
    await h.store.put(record("run-other-thread", { threadKey: "slack:C1:2.0", ...TAG }));
    const res = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps);
    expect(res).toEqual({
      status: 200,
      body: { ok: true, runId: "run-done", threadKey: INSTANCE.threadKey, alreadySpawned: true },
    });
    expect(h.dispatched).toEqual([]);
  });

  it("a requester without the preset's grant is refused by the authorize stage's own name, with what the thread was told (403)", async () => {
    const h = harness({
      script: async (_msg, io) => {
        await io.reply("🚫 You're not on the allowlist for the `coding` agent.");
        return { status: "refused", refusal: "agent_allowlist" };
      },
    });
    await h.instances.put(INSTANCE);
    const res = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps);
    expect(res).toEqual({
      status: 403,
      body: { ok: false, error: "agent_allowlist", message: "🚫 You're not on the allowlist for the `coding` agent." },
    });
  });

  it("a spawn the admission stage refused because a run took the thread meanwhile (coordinator_thread_live) is answered from that run: alreadySpawned for the same key, busy otherwise", async () => {
    const h = harness({
      script: async (msg) => {
        // The race: a run claims the thread between the route's read and the dispatch.
        h.registry.create("coding · child", {
          agent: "coding",
          channelId: msg.channelId,
          userId: msg.userId,
          threadKey: msg.threadKey,
          ...TAG,
        });
        return { status: "refused", refusal: "coordinator_thread_live" };
      },
    });
    await h.instances.put(INSTANCE);
    const res = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps);
    expect(res).toMatchObject({ status: 200, body: { ok: true, runId: "run-1", alreadySpawned: true } });
  });

  it("a dispatch that ended with no run and no gate's name is a failed spawn (502) naming what the thread saw; an instance whose channel cannot be rebuilt is 503", async () => {
    const h = harness({
      script: async (_msg, io) => {
        await io.reply("⚠️ the resident could not be attached");
        return { status: "failed" };
      },
    });
    await h.instances.put(INSTANCE);
    expect(await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps)).toEqual({
      status: 502,
      body: { ok: false, error: "spawn_failed", message: "⚠️ the resident could not be attached" },
    });
    const noChannel = harness();
    await noChannel.instances.put(INSTANCE);
    noChannel.deps.ioFor = () => undefined;
    expect(await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), noChannel.deps)).toEqual(
      {
        status: 503,
        body: { ok: false, error: "no_channel" },
      },
    );
    expect(noChannel.dispatched).toEqual([]);
  });

  it("validates the body before anything is read: a bad instance id, a step with a colon, an unknown preset, the ship preset, an empty prompt, a budget under two minutes and non-JSON are 400", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    const bad = [
      { ...spawnBody, parentInstanceId: "has:colon" },
      { ...spawnBody, step: "a:b" },
      { ...spawnBody, preset: "nope" },
      { ...spawnBody, preset: "ship" },
      { ...spawnBody, prompt: "   " },
      { ...spawnBody, budget: 1 },
      "not json",
    ];
    for (const body of bad) {
      const res = await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, body), h.deps);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.dispatched).toEqual([]);
  });
});

describe("POST /admin/coordinator/read-record — a run of the instance, and no other (item 9)", () => {
  it("answers a live child's status and a finished child's status and final reply; a run of another instance, a run of none, and an unknown id are not_found alike", async () => {
    const h = harness();
    const live = h.registry.create("coding · child", {
      agent: "coding",
      channelId: INSTANCE.channelId,
      userId: INSTANCE.userId,
      threadKey: INSTANCE.threadKey,
      ...TAG,
    });
    h.registry.publish(live.id, { type: "tool_call", tool: "bash", summary: "$ npm test" });
    await h.store.put(record("run-done", { ...TAG }));
    await h.store.put(record("run-elsewhere", { parentInstanceId: "ship_other_1", idempotencyKey: "ship_other_1:x" }));
    await h.store.put(record("run-plain"));
    const read = (runId: string) =>
      handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}read-record`, { parentInstanceId: INSTANCE.id, runId }),
        h.deps,
      );
    expect(await read(live.id)).toEqual({
      status: 200,
      body: {
        ok: true,
        run: {
          id: live.id,
          finished: false,
          agent: "coding",
          startedAt: NOW,
          activity: "$ npm test",
          parentInstanceId: INSTANCE.id,
          idempotencyKey: KEY,
        },
      },
    });
    expect(await read("run-done")).toEqual({
      status: 200,
      body: {
        ok: true,
        run: {
          id: "run-done",
          finished: true,
          status: "completed",
          agent: "coding",
          startedAt: NOW - 30_000,
          finishedAt: NOW - 10_000,
          parentInstanceId: INSTANCE.id,
          idempotencyKey: KEY,
          finalReply: "the handoff",
        },
      },
    });
    for (const id of ["run-elsewhere", "run-plain", "run-nope"]) {
      expect(await read(id), id).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    }
    expect(
      (
        await handleCoordinatorRequest(
          post(`${COORDINATOR_ADMIN_PREFIX}read-record`, { parentInstanceId: INSTANCE.id }),
          h.deps,
        )
      ).status,
    ).toBe(400);
  });
});

describe("POST /admin/coordinator/pr-check — the open pull request heading the instance's branch (item 9)", () => {
  it("answers state none when no pull request heads the branch, the number, url and head when one does, 404 for an unknown instance, and 502 when GitHub cannot be asked", async () => {
    const none = harness();
    await none.instances.put(INSTANCE);
    expect(
      await handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id }),
        none.deps,
      ),
    ).toEqual({
      status: 200,
      body: { ok: true, state: "none" },
    });
    expect(none.prLookups).toEqual([["acme/api", "plan/orchestration/u12"]]);

    const open = harness({ pr: { number: 12, htmlUrl: "https://github.com/acme/api/pull/12", headSha: "abc123" } });
    await open.instances.put(INSTANCE);
    expect(
      await handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id }),
        open.deps,
      ),
    ).toEqual({
      status: 200,
      body: { ok: true, state: "open", prNumber: 12, url: "https://github.com/acme/api/pull/12", headSha: "abc123" },
    });

    expect(
      await handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: "ship_none" }),
        open.deps,
      ),
    ).toEqual({
      status: 404,
      body: { ok: false, error: "unknown_instance" },
    });

    const down = harness({ pr: new Error("PR lookup failed: HTTP 502") });
    await down.instances.put(INSTANCE);
    expect(
      await handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id }),
        down.deps,
      ),
    ).toEqual({
      status: 502,
      body: { ok: false, error: "github_unavailable", message: "PR lookup failed: HTTP 502" },
    });
  });
});

describe("createAdminCoordinatorHandler — the node adapter decides the door from the headers alone (item 9)", () => {
  /** A node request: headers, method, url and a body the adapter may or may not read. */
  function nodeRequest(method: string, url: string, auth: string | null, body: string) {
    let bodyRead = false;
    let destroyed = false;
    const writes: { status?: number; body?: string } = {};
    let resolveAnswered!: (w: { status?: number; body?: string }) => void;
    const answered = new Promise<{ status?: number; body?: string }>((resolve) => {
      resolveAnswered = resolve;
    });
    const req = {
      method,
      url,
      headers: auth !== null ? { authorization: auth } : {},
      destroy: () => void (destroyed = true),
      async *[Symbol.asyncIterator]() {
        bodyRead = true;
        yield Buffer.from(body);
      },
    } as unknown as HttpRequest;
    const res = {
      writeHead: (status: number) => void (writes.status = status),
      end: (text: string) => {
        writes.body = text;
        resolveAnswered(writes);
      },
    } as unknown as ServerResponse;
    return { req, res, answered, bodyRead: () => bodyRead, destroyed: () => destroyed };
  }

  it("an unknown step, a non-POST and a refused bearer are answered 404 / 405 / 401 / 403 from the headers — the body is never read and the request is destroyed", async () => {
    const h = harness();
    const handler = createAdminCoordinatorHandler(h.deps);
    const cases: Array<[string, string, string | null, number]> = [
      ["POST", `${COORDINATOR_ADMIN_PREFIX}merge`, "Bearer tok-coord", 404],
      ["GET", `${COORDINATOR_ADMIN_PREFIX}spawn`, "Bearer tok-coord", 405],
      ["POST", `${COORDINATOR_ADMIN_PREFIX}spawn`, null, 401],
      ["POST", `${COORDINATOR_ADMIN_PREFIX}spawn`, "Bearer tok-ops", 403],
    ];
    for (const [method, url, auth, status] of cases) {
      const r = nodeRequest(method, url, auth, JSON.stringify(spawnBody));
      handler(r.req, r.res);
      expect((await r.answered).status, `${method} ${url}`).toBe(status);
      expect(r.bodyRead(), `${method} ${url} body`).toBe(false);
      expect(r.destroyed(), `${method} ${url} destroyed`).toBe(true);
    }
    expect(h.dispatched).toEqual([]);
  });

  it("an admitted POST reads the body once the door is open and answers the step; the bearer is looked at exactly once per request", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    // The secret is frozen, so the count is a proxy in front of it: one `reveal` per request.
    let reveals = 0;
    const counted = new Proxy(TOKENS, {
      get(target, property, receiver) {
        if (property === "reveal") {
          reveals += 1;
          return target.reveal.bind(target);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const handler = createAdminCoordinatorHandler({ ...h.deps, tokens: counted });
    const r = nodeRequest("POST", `${COORDINATOR_ADMIN_PREFIX}spawn`, "Bearer tok-coord", JSON.stringify(spawnBody));
    handler(r.req, r.res);
    const out = await r.answered;
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body!)).toEqual({ ok: true, runId: "run-child", threadKey: INSTANCE.threadKey });
    expect(r.bodyRead()).toBe(true);
    expect(reveals).toBe(1);
  });
});
