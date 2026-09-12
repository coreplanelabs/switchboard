import { describe, expect, it } from "vitest";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { CoordinatorInstance, CoordinatorTag, CoordinatorUnit } from "../core/coordinator/contract.js";
import type { ChildContract } from "../core/ship/contract.js";
import type { DispatchOutcome } from "../core/dispatch/outcome.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { createRunsService } from "../core/runsService.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent } from "../core/runEvents.js";
import { isRunRecord, type RunRecord } from "../core/runRecord.js";
import type { ChannelIO, IncomingMessage, StatusUpdate } from "../core/types.js";
import type {
  CommitChecks,
  MergeResult,
  OpenPrRef,
  PullRequestFacts,
  PullRequestReview,
} from "../execution/githubPulls.js";
import { InMemoryGithubApi, type IssueSummary } from "../execution/githubApi.js";
import type { GithubIdentity } from "../execution/githubApp.js";
import type { RunHistoryWriter } from "../core/runHistoryWriter.js";
import {
  COORDINATOR_ADMIN_PREFIX,
  createAdminCoordinatorHandler,
  handleCoordinatorRequest,
  isCoordinatorAdminPath,
  type AdminCoordinatorDeps,
} from "./adminCoordinator.js";

// Feature: docs/reference/specs/http-ingress.md item 9 — the bot steps a ship
// coordinator calls behind the `coordinator` bearer whose actor holds
// `coordinator:step`: `spawn`, `read-record`, `pr-check`, the plan runner's own
// `plan`, `unit-start`, `branch`, `round`, `unit-end`, `merge` and `finish`, and the
// shim's `authorize` question. The spawn never takes an actor from its caller:
// the requester, channel and thread come from the parent ship record (a plan
// unit's from its own row), and a retried spawn meets its own child by the key
// on the child's row. Every answer carries `at`, the bot's clock.
const NOW = 1_700_000_000_000;
const TOKENS = new Secret(
  JSON.stringify({
    "tok-coord": { subject: "coordinator" },
    "tok-step": { subject: "stepper" },
    "tok-ops": { subject: "ops" },
  }),
  "SWITCHBOARD_INGRESS_TOKENS",
);
const GRANTS: Record<string, Grants> = {
  "http:coordinator": { actions: new Set(["coordinator:step", "plan:merge"]), channels: new Set(), repos: new Set() },
  "http:stepper": { actions: new Set(["coordinator:step"]), channels: new Set(), repos: new Set() },
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

function harness(
  over: {
    script?: Script;
    tokens?: Secret | undefined;
    pr?: OpenPrRef | null | Error;
    /** The target repository's files at the base ref and its open issues (the in-memory GitHub). */
    files?: Record<string, string>;
    issues?: IssueSummary[];
    branchError?: Error;
    reviews?: PullRequestReview[];
    self?: GithubIdentity;
    ioFor?: (thread: { threadKey: string; userId: string; cardTs?: string }) => ChannelIO | undefined;
    /** The merge step's GitHub: the pull request's facts, the checks at the head, the squash's answer. */
    prFacts?: PullRequestFacts | Error;
    checks?: CommitChecks | Error;
    merge?: MergeResult | Error;
  } = {},
) {
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
  const branches: Array<[string, string, string]> = [];
  const threadsAsked: Array<{ threadKey: string; userId: string; cardTs?: string }> = [];
  const written: RunRecord[] = [];
  const merges: Array<{ pr: { repo: string; number: number }; opts: { sha: string; title: string } }> = [];
  const github = new InMemoryGithubApi({ "acme/api": { files: over.files ?? {}, issues: over.issues ?? [] } });
  const deps: AdminCoordinatorDeps = {
    tokens: "tokens" in over ? over.tokens : TOKENS,
    grantsFor: (id) => GRANTS[id] ?? NO_GRANTS,
    instances,
    runs,
    dispatch: async (msg, dispatchIo, opts) => {
      dispatched.push({ msg, opts });
      return (over.script ?? registers("run-child"))(msg, dispatchIo, opts);
    },
    ioFor: (thread) => {
      threadsAsked.push(thread);
      return over.ioFor ? over.ioFor(thread) : io;
    },
    findOpenPrByHead: async (repo, branch) => {
      prLookups.push([repo, branch]);
      if (over.pr instanceof Error) throw over.pr;
      return over.pr ?? null;
    },
    github,
    createBranchRef: async (repo, branch, fromRef) => {
      branches.push([repo, branch, fromRef]);
      if (over.branchError) throw over.branchError;
    },
    fetchPrReviews: async () => over.reviews,
    selfIdentity: async () => over.self ?? { login: "acme-switchboard[bot]", id: 4242 },
    fetchPrFacts: async () => {
      if (over.prFacts instanceof Error) throw over.prFacts;
      return over.prFacts;
    },
    fetchCommitChecks: async () => {
      if (over.checks instanceof Error) throw over.checks;
      return over.checks;
    },
    mergePullRequest: async (pr, opts) => {
      merges.push({ pr, opts });
      if (over.merge instanceof Error) throw over.merge;
      return over.merge ?? { ok: true, sha: "9".repeat(40) };
    },
    runHistoryWriter: {
      write: (record: RunRecord) => void written.push(record),
      pending: () => 0,
      settled: async () => {},
    } as unknown as RunHistoryWriter,
    channelVisibilityOf: async () => "public",
    clock: () => NOW,
    log: (l) => void logs.push(l),
  };
  return {
    deps,
    registry,
    store,
    ledger,
    instances,
    dispatched,
    replies,
    logs,
    prLookups,
    branches,
    threadsAsked,
    written,
    merges,
    github,
  };
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
    expect((await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}explode`, {}), h.deps)).status).toBe(404);
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
    expect(res).toEqual({
      status: 200,
      body: { ok: true, runId: "run-child", threadKey: INSTANCE.threadKey, at: NOW },
    });
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
      body: { ok: true, runId: live.id, threadKey: INSTANCE.threadKey, alreadySpawned: true, at: NOW },
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
    expect(busy).toEqual({
      status: 409,
      body: { ok: false, error: "busy", runId: other.id, agent: "review", at: NOW },
    });
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
    expect(farBusy).toEqual({
      status: 409,
      body: { ok: false, error: "busy", runId: "run-far", agent: "coding", at: NOW },
    });
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
      body: { ok: true, runId: "run-done", threadKey: INSTANCE.threadKey, alreadySpawned: true, at: NOW },
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
      body: {
        ok: false,
        error: "agent_allowlist",
        message: "🚫 You're not on the allowlist for the `coding` agent.",
        at: NOW,
      },
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
      body: { ok: false, error: "spawn_failed", message: "⚠️ the resident could not be attached", at: NOW },
    });
    const noChannel = harness();
    await noChannel.instances.put(INSTANCE);
    noChannel.deps.ioFor = () => undefined;
    expect(await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), noChannel.deps)).toEqual(
      {
        status: 503,
        body: { ok: false, error: "no_channel", at: NOW },
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
        at: NOW,
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
        at: NOW,
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
      body: { ok: true, state: "none", at: NOW },
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
      body: {
        ok: true,
        state: "open",
        prNumber: 12,
        url: "https://github.com/acme/api/pull/12",
        headSha: "abc123",
        at: NOW,
      },
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
      body: { ok: false, error: "github_unavailable", message: "PR lookup failed: HTTP 502", at: NOW },
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
      ["POST", `${COORDINATOR_ADMIN_PREFIX}explode`, "Bearer tok-coord", 404],
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
    expect(JSON.parse(out.body!)).toEqual({ ok: true, runId: "run-child", threadKey: INSTANCE.threadKey, at: NOW });
    expect(r.bodyRead()).toBe(true);
    expect(reveals).toBe(1);
  });
});

// Feature: docs/reference/specs/http-ingress.md item 9 — the plan runner's own
// steps: the plan it walks, a unit's start (its thread, its board issue) and
// end (its report), the branch, the round boundaries the card draws, and the
// finish that writes the parent's record. Every answer carries `at`, the bot's
// clock — the machine's only time.
describe("the plan runner's steps — plan, unit-start, branch, round, unit-end, finish (item 9)", () => {
  const PLAN_INSTANCE: CoordinatorInstance = {
    ...INSTANCE,
    id: "plan-fixture",
    plan: { id: "fixture", path: "docs/plans/fixture.md" },
    caps: { maxRounds: 2, maxMinutes: 45 },
    card: { channel: "C1", ts: "1.5" },
    runId: "run-parent",
    label: "*ship* · acme/api · fixture",
  };
  const PLAN_TEXT = [
    "# Fixture - Plan",
    "",
    "### U10. Warm the cache on wake",
    "",
    "- **Goal**: A wake never starts cold.",
    "- **Dependencies**: none.",
    "- **Test scenarios**:",
    "  - a cold wake restores from the archive.",
    "",
    "### U11. Retire the alarm",
    "",
    "- **Dependencies**: U10.",
    "",
  ].join("\n");
  const unitRow = (unit: string, over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
    instanceId: PLAN_INSTANCE.id,
    unit,
    slug: unit.toLowerCase(),
    title: unit === "U10" ? "Warm the cache on wake" : "Retire the alarm",
    branch: `plan/fixture/${unit.toLowerCase()}`,
    dependsOn: unit === "U11" ? ["U10"] : [],
    rounds: [],
    ...over,
  });
  const issue = (number: number, title: string): IssueSummary => ({
    number,
    title,
    state: "open",
    url: `https://github.com/acme/api/issues/${number}`,
    labels: [],
    assignees: [],
    author: "alice",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
  });
  const call = (h: ReturnType<typeof harness>, step: string, body: Record<string, unknown>) =>
    handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}${step}`, body), h.deps);
  async function planHarness(over: Parameters<typeof harness>[0] = {}) {
    const h = harness({ files: { "docs/plans/fixture.md": PLAN_TEXT, "AGENTS.md": "# Rules" }, ...over });
    await h.instances.put(PLAN_INSTANCE);
    await h.instances.putUnits([unitRow("U10"), unitRow("U11")]);
    return h;
  }

  it("plan answers the instance's units with where each stands, the caps as clipped, the base and the children's own budgets; an unknown instance is 404", async () => {
    const h = await planHarness();
    expect(await call(h, "plan", { parentInstanceId: PLAN_INSTANCE.id })).toEqual({
      status: 200,
      body: {
        ok: true,
        planId: "fixture",
        repo: "acme/api",
        base: "main",
        caps: { maxRounds: 2, maxMinutes: 45 },
        childMinutes: { coding: 45, review: 25 },
        units: [unitRow("U10"), unitRow("U11")],
        at: NOW,
      },
    });
    expect((await call(h, "plan", { parentInstanceId: "plan-none" })).status).toBe(404);
    // A task-string instance without caps answers the defaults and no plan id.
    const task = harness();
    await task.instances.put(INSTANCE);
    const body = (await call(task, "plan", { parentInstanceId: INSTANCE.id })).body as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, base: "main", caps: { maxRounds: 3, maxMinutes: 120 }, units: [] });
    expect("planId" in body).toBe(false);
  });

  it("unit-start opens a plan unit's thread through the requesting thread's channel, finds the board issue titled by the unit id, and writes the row; a second start answers the same thread; a task unit runs in the requesting thread; an unknown unit is 404", async () => {
    const opened: string[] = [];
    const parentIo: ChannelIO = {
      reply: async () => {},
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
      openThread: async (lead) => {
        opened.push(lead);
        return {
          thread: { threadKey: `slack:C1:${opened.length + 1}.0`, sourceUrl: "https://acme.slack.com/archives/C1/p2" },
          io: {
            reply: async () => {},
            status: async () => ({ update: () => {}, done: async () => {} }),
            history: async () => [],
          },
        };
      },
    };
    const h = await planHarness({
      ioFor: () => parentIo,
      issues: [issue(7, "Something else"), issue(834, "U10: Warm the cache on wake (unit)")],
    });
    const first = await call(h, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" });
    expect(first).toEqual({
      status: 200,
      body: { ok: true, threadKey: "slack:C1:2.0", branch: "plan/fixture/u10", base: "main", issue: 834, at: NOW },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("↳ *ship* unit U10 — Warm the cache on wake for alice");
    expect(opened[0]).toContain("`plan/fixture/u10` in acme/api");
    expect(h.threadsAsked[0]).toEqual({ threadKey: INSTANCE.threadKey, userId: INSTANCE.userId });
    const rows = await h.instances.listUnits(PLAN_INSTANCE.id);
    expect(rows[0]).toEqual(
      unitRow("U10", {
        threadKey: "slack:C1:2.0",
        sourceUrl: "https://acme.slack.com/archives/C1/p2",
        issue: 834,
        startedAt: NOW,
      }),
    );
    // Idempotent: the same thread, no second lead.
    expect((await call(h, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" })).body).toMatchObject({
      threadKey: "slack:C1:2.0",
    });
    expect(opened).toHaveLength(1);
    expect((await call(h, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U99" })).status).toBe(404);

    const task = harness();
    await task.instances.put(INSTANCE);
    await task.instances.putUnits([
      { instanceId: INSTANCE.id, unit: "task", slug: "task", branch: INSTANCE.branch, dependsOn: [], rounds: [] },
    ]);
    expect(await call(task, "unit-start", { parentInstanceId: INSTANCE.id, unit: "task" })).toEqual({
      status: 200,
      body: { ok: true, threadKey: INSTANCE.threadKey, branch: INSTANCE.branch, base: "main", at: NOW },
    });
    expect((await task.instances.listUnits(INSTANCE.id))[0]).toMatchObject({
      threadKey: INSTANCE.threadKey,
      sourceUrl: INSTANCE.sourceUrl,
    });
  });

  it("unit-start without a channel that can open a thread is 503; a channel whose open fails is 502 and the row is unchanged", async () => {
    const noThread = await planHarness({ ioFor: () => undefined });
    expect((await call(noThread, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" })).status).toBe(503);
    const failing = await planHarness({
      ioFor: () => ({
        reply: async () => {},
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
        openThread: async () => {
          throw new Error("chat.postMessage answered without a ts");
        },
      }),
    });
    const res = await call(failing, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" });
    expect(res).toEqual({
      status: 502,
      body: { ok: false, error: "thread_failed", message: "chat.postMessage answered without a ts", at: NOW },
    });
    expect((await failing.instances.listUnits(PLAN_INSTANCE.id))[0]).toEqual(unitRow("U10"));
  });

  it("branch creates the unit's branch from the base on origin and answers ok; a create that fails answers ok: false with the reason, never a throw; an instance without a base says so", async () => {
    const h = await planHarness();
    expect(await call(h, "branch", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" })).toEqual({
      status: 200,
      body: { ok: true, branch: "plan/fixture/u10", base: "main", at: NOW },
    });
    expect(h.branches).toEqual([["acme/api", "plan/fixture/u10", "main"]]);
    const failing = await planHarness({ branchError: new Error("HTTP 403 forbidden") });
    expect(await call(failing, "branch", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" })).toEqual({
      status: 200,
      body: { ok: false, reason: "HTTP 403 forbidden", at: NOW },
    });
    const noBase = harness();
    await noBase.instances.put({ ...INSTANCE, base: undefined });
    expect((await call(noBase, "branch", { parentInstanceId: INSTANCE.id })).body).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no base branch is known"),
    });
  });

  it("spawn with a contract brief composes the coding child's turn from the plan at the base ref: the unit's branch in the text, the contract and the tag as its options; a fix brief carries the review run's findings and the finding ids; a brief for a unit without a thread is 409; a brief the bot cannot compose is 502", async () => {
    const h = await planHarness();
    await h.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0", issue: 834 })]);
    const res = await call(h, "spawn", {
      parentInstanceId: PLAN_INSTANCE.id,
      step: "U10/0/coding",
      preset: "coding",
      brief: { kind: "contract", unit: "U10", rebase: { branch: "plan/fixture/u10", onto: "main" } },
    });
    expect(res).toEqual({ status: 200, body: { ok: true, runId: "run-child", threadKey: "slack:C1:2.0", at: NOW } });
    expect(h.dispatched).toHaveLength(1);
    const { msg, opts } = h.dispatched[0];
    expect(msg.threadKey).toBe("slack:C1:2.0");
    expect(msg.text.startsWith("agent:coding in acme/api on branch plan/fixture/u10: Implement unit U10")).toBe(true);
    expect(opts.coordinator).toEqual({
      parentInstanceId: PLAN_INSTANCE.id,
      idempotencyKey: "plan-fixture:U10/0/coding",
    });
    const contract = (opts as { contract?: ChildContract }).contract!;
    expect(contract.unit.id).toBe("U10");
    expect(contract.issue).toEqual({ repo: "acme/api", number: 834 });
    expect(contract.agentRules).toEqual({ file: "AGENTS.md", text: "# Rules" });
    expect(contract.rebase).toEqual({ branch: "plan/fixture/u10", onto: "main" });

    // The fix brief: the review run's record carries the findings and the words.
    await h.store.put(
      record("run-r1", {
        agent: "review",
        threadKey: "slack:C1:2.0",
        parentInstanceId: PLAN_INSTANCE.id,
        idempotencyKey: "plan-fixture:U10/1/review",
        verdict: {
          verdict: "request_changes",
          summary: "one nit",
          findings: [{ id: "F1", severity: "minor", file: "src/a.ts", line: 3, title: "off by one" }],
        },
        reviewHead: "a".repeat(40),
        events: [{ type: "answer", text: "Changes requested: one nit.", seq: 1 }],
      }),
    );
    const fix = await call(h, "spawn", {
      parentInstanceId: PLAN_INSTANCE.id,
      step: "U10/1/fix",
      preset: "coding",
      brief: { kind: "fix", unit: "U10", pr: 7, reviewRunId: "run-r1" },
    });
    expect(fix.status).toBe(200);
    const fixDispatch = h.dispatched[1];
    expect(fixDispatch.msg.text).toContain("The review of acme/api#7 requested changes.");
    expect(fixDispatch.msg.text).toContain("[minor] F1 src/a.ts:3 — off by one");
    expect((fixDispatch.opts as { fixRound?: unknown }).fixRound).toEqual({ findingIds: ["F1"] });

    const noThread = await planHarness();
    expect(
      await call(noThread, "spawn", {
        parentInstanceId: PLAN_INSTANCE.id,
        step: "U11/0/coding",
        preset: "coding",
        brief: { kind: "contract", unit: "U11", rebase: { branch: "plan/fixture/u11", onto: "main" } },
      }),
    ).toEqual({ status: 409, body: { ok: false, error: "unit_not_started", unit: "U11", at: NOW } });
    const noPlan = await planHarness({ files: { "AGENTS.md": "# Rules" } });
    await noPlan.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0" })]);
    const failed = await call(noPlan, "spawn", {
      parentInstanceId: PLAN_INSTANCE.id,
      step: "U10/0/coding",
      preset: "coding",
      brief: { kind: "contract", unit: "U10", rebase: { branch: "plan/fixture/u10", onto: "main" } },
    });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ ok: false, error: "brief_failed", at: NOW });
    expect(noPlan.dispatched).toEqual([]);
  });

  it("spawn's body validation: a brief beside a prompt, a brief of the wrong preset, a malformed brief and a bad unit are 400", async () => {
    const h = await planHarness();
    const bad = async (over: Record<string, unknown>) =>
      (await call(h, "spawn", { parentInstanceId: PLAN_INSTANCE.id, step: "U10/0/coding", preset: "coding", ...over }))
        .status;
    expect(
      await bad({ prompt: "x", brief: { kind: "contract", unit: "U10", rebase: { branch: "b", onto: "main" } } }),
    ).toBe(400);
    expect(
      await bad({ preset: "review", brief: { kind: "contract", unit: "U10", rebase: { branch: "b", onto: "main" } } }),
    ).toBe(400);
    expect(await bad({ brief: { kind: "review", unit: "U10", pr: "7", round: 1 } })).toBe(400);
    expect(await bad({ brief: { kind: "fix", unit: "U10", pr: 7 } })).toBe(400);
    expect(await bad({ brief: { kind: "merge", unit: "U10" } })).toBe(400);
    expect(await bad({ prompt: "x", unit: "has space" })).toBe(400);
    expect(h.dispatched).toEqual([]);
  });

  it("read-record answers a finished child's typed artifacts — the pull request it opened, the verdict and reviewed head, whether the bot's verdict stands on the pull request at that head, the dispositions, whether a handoff was submitted", async () => {
    const HEAD = "a".repeat(40);
    const h = await planHarness({
      reviews: [
        {
          author: { login: "acme-switchboard[bot]", id: 4242 },
          state: "COMMENTED",
          commitId: HEAD,
          body: "LGTM: clean",
        },
      ],
    });
    await h.instances.putUnits([
      unitRow("U10", { threadKey: "slack:C1:2.0", pr: { number: 7, url: "https://github.com/acme/api/pull/7" } }),
    ]);
    const tag = { parentInstanceId: PLAN_INSTANCE.id, idempotencyKey: "plan-fixture:U10/0/coding" };
    await h.store.put(
      record("run-c0", {
        ...tag,
        threadKey: "slack:C1:2.0",
        handoff: { deviations: [], followUps: [], unproven: [] },
        events: [
          { type: "pr_opened", number: 7, url: "https://github.com/acme/api/pull/7", created: true, seq: 1 },
          { type: "answer", text: "Done — branch pushed.", seq: 2 },
        ],
      }),
    );
    await h.store.put(
      record("run-r1", {
        ...tag,
        idempotencyKey: "plan-fixture:U10/1/review",
        agent: "review",
        threadKey: "slack:C1:2.0",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewHead: HEAD,
        events: [{ type: "answer", text: "LGTM: clean", seq: 1 }],
      }),
    );
    await h.store.put(
      record("run-f1", {
        ...tag,
        idempotencyKey: "plan-fixture:U10/1/fix",
        threadKey: "slack:C1:2.0",
        dispositions: [{ findingId: "F1", disposition: "fixed", note: "done" }],
      }),
    );
    const read = (runId: string) => call(h, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId, unit: "U10" });
    expect((await read("run-c0")).body).toMatchObject({
      run: {
        id: "run-c0",
        finished: true,
        pr: { number: 7, url: "https://github.com/acme/api/pull/7", created: true },
        finalReply: "Done — branch pushed.",
        handoff: true,
      },
      at: NOW,
    });
    expect((await read("run-r1")).body).toMatchObject({
      run: {
        id: "run-r1",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewHead: HEAD,
        reviewPosted: true,
      },
    });
    expect((await read("run-f1")).body).toMatchObject({
      run: { id: "run-f1", dispositions: [{ findingId: "F1", disposition: "fixed", note: "done" }] },
    });
    // The verdict stands only at ITS head, by THIS bot: another author at the
    // head, the bot at another head, the bot's other verdict at the head → false;
    // GitHub silent → unknown.
    const notStanding: PullRequestReview[][] = [
      [{ author: { login: "alice" }, state: "APPROVED", commitId: HEAD, body: "LGTM: clean" }],
      [
        {
          author: { login: "acme-switchboard[bot]", id: 4242 },
          state: "COMMENTED",
          commitId: "b".repeat(40),
          body: "LGTM: clean",
        },
      ],
      // The same first seven hex digits, another commit: two full shas are compared whole.
      [
        {
          author: { login: "acme-switchboard[bot]", id: 4242 },
          state: "COMMENTED",
          commitId: `${HEAD.slice(0, 7)}${"b".repeat(33)}`,
          body: "LGTM: clean",
        },
      ],
      [
        {
          author: { login: "acme-switchboard[bot]", id: 4242 },
          state: "COMMENTED",
          commitId: HEAD,
          body: "Changes requested: x",
        },
      ],
    ];
    for (const reviews of notStanding) {
      const other = await planHarness({ reviews });
      await other.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0", pr: { number: 7, url: "u" } })]);
      await other.store.put(
        record("run-r1", {
          ...tag,
          agent: "review",
          verdict: { verdict: "approve", summary: "clean" },
          reviewHead: HEAD,
        }),
      );
      expect(
        (
          (await call(other, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId: "run-r1", unit: "U10" }))
            .body as {
            run: { reviewPosted?: boolean };
          }
        ).run.reviewPosted,
        JSON.stringify(reviews),
      ).toBe(false);
    }
    const silent = await planHarness();
    await silent.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0", pr: { number: 7, url: "u" } })]);
    await silent.store.put(
      record("run-r1", {
        ...tag,
        agent: "review",
        verdict: { verdict: "approve", summary: "clean" },
        reviewHead: HEAD,
      }),
    );
    expect(
      "reviewPosted" in
        (
          (await call(silent, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId: "run-r1", unit: "U10" }))
            .body as {
            run: Record<string, unknown>;
          }
        ).run,
    ).toBe(false);
  });

  it("pr-check for a unit looks up the unit's branch and remembers the pull request on the row", async () => {
    const h = await planHarness({
      pr: { number: 12, htmlUrl: "https://github.com/acme/api/pull/12", headSha: "abc123" },
    });
    expect(await call(h, "pr-check", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" })).toEqual({
      status: 200,
      body: {
        ok: true,
        state: "open",
        prNumber: 12,
        url: "https://github.com/acme/api/pull/12",
        headSha: "abc123",
        at: NOW,
      },
    });
    expect(h.prLookups).toEqual([["acme/api", "plan/fixture/u10"]]);
    expect((await h.instances.listUnits(PLAN_INSTANCE.id))[0].pr).toEqual({
      number: 12,
      url: "https://github.com/acme/api/pull/12",
    });
    expect((await call(h, "pr-check", { parentInstanceId: PLAN_INSTANCE.id, unit: "U99" })).status).toBe(404);
  });

  it("round appends the boundary to the unit's row and redraws the card from the instance's card handle with one line per unit; a malformed boundary is 400", async () => {
    const frames: StatusUpdate[] = [];
    const h = await planHarness({
      ioFor: (thread) => ({
        reply: async () => {},
        status: async (initial) => {
          frames.push({ ...initial, cardTs: thread.cardTs } as StatusUpdate);
          return { update: () => {}, done: async () => {} };
        },
        history: async () => [],
      }),
    });
    await h.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0" })]);
    expect(
      await call(h, "round", {
        parentInstanceId: PLAN_INSTANCE.id,
        unit: "U10",
        index: 0,
        agent: "coding",
        outcome: "started",
      }),
    ).toEqual({ status: 200, body: { ok: true, at: NOW } });
    expect((await h.instances.listUnits(PLAN_INSTANCE.id))[0].rounds).toEqual([
      { index: 0, agent: "coding", outcome: "started", at: NOW },
    ]);
    expect(frames).toHaveLength(1);
    expect((frames[0] as { cardTs?: string }).cardTs).toBe("1.5");
    const text = JSON.stringify(frames[0]);
    expect(text).toContain("U10 · Round 0 — coding · started");
    expect(text).toContain("U11 · waiting");
    expect(
      (
        await call(h, "round", {
          parentInstanceId: PLAN_INSTANCE.id,
          unit: "U10",
          index: 0,
          agent: "ship",
          outcome: "started",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, "round", {
          parentInstanceId: PLAN_INSTANCE.id,
          unit: "U10",
          index: 0,
          agent: "coding",
          outcome: "won",
        })
      ).status,
    ).toBe(400);
  });

  it("unit-end writes the ending and the pull request on the row, posts the report in the unit's thread and redraws the card; finish writes the parent's record from the rows, closes the card and tells the requesting thread the plan's summary", async () => {
    const replies: Array<{ threadKey: string; text: string }> = [];
    const closes: StatusUpdate[] = [];
    const h = await planHarness({
      ioFor: (thread) => ({
        reply: async (text) => void replies.push({ threadKey: thread.threadKey, text }),
        status: async () => ({ update: () => {}, done: async (frame) => void closes.push(frame) }),
        history: async () => [],
      }),
    });
    await h.instances.putUnits([
      unitRow("U10", {
        threadKey: "slack:C1:2.0",
        rounds: [
          { index: 0, agent: "coding", outcome: "started", at: NOW - 3000 },
          { index: 0, agent: "coding", outcome: "pr_opened", at: NOW - 2000 },
          { index: 1, agent: "review", outcome: "started", at: NOW - 1000 },
          { index: 1, agent: "review", outcome: "approve", at: NOW - 500 },
        ],
      }),
    ]);
    expect(
      await call(h, "unit-end", {
        parentInstanceId: PLAN_INSTANCE.id,
        unit: "U10",
        ending: {
          kind: "merge_ready",
          report: "✅ Merge-ready after 1 review round: https://github.com/acme/api/pull/7",
        },
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      }),
    ).toEqual({ status: 200, body: { ok: true, told: true, at: NOW } });
    expect(replies).toEqual([
      { threadKey: "slack:C1:2.0", text: "✅ Merge-ready after 1 review round: https://github.com/acme/api/pull/7" },
    ]);
    const rows = await h.instances.listUnits(PLAN_INSTANCE.id);
    expect(rows[0].ending).toEqual({
      kind: "merge_ready",
      report: "✅ Merge-ready after 1 review round: https://github.com/acme/api/pull/7",
      at: NOW,
    });
    expect(rows[0].pr).toEqual({ number: 7, url: "https://github.com/acme/api/pull/7" });
    expect(
      (await call(h, "unit-end", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10", ending: { kind: "x" } })).status,
    ).toBe(400);

    expect(await call(h, "finish", { parentInstanceId: PLAN_INSTANCE.id, outcome: "completed" })).toEqual({
      status: 200,
      body: { ok: true, runId: "run-parent", at: NOW },
    });
    expect(h.written).toHaveLength(1);
    const rec = h.written[0];
    expect(rec).toMatchObject({
      id: "run-parent",
      label: "*ship* · acme/api · fixture",
      agent: "ship",
      channelId: INSTANCE.channelId,
      userId: INSTANCE.userId,
      threadKey: INSTANCE.threadKey,
      channelVisibility: "public",
      repo: "acme/api",
      startedAt: PLAN_INSTANCE.createdAt,
      finishedAt: NOW,
      status: "completed",
      userName: "alice",
    });
    expect(rec.events.map((e) => e.type)).toEqual([
      "run_meta",
      "ship_round",
      "ship_round",
      "ship_round",
      "ship_round",
      "answer",
    ]);
    expect(rec.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const summary = rec.events.at(-1);
    expect(summary?.type === "answer" ? summary.text : "").toBe(
      "✅ U10 — merge_ready — https://github.com/acme/api/pull/7\n• U11 — not started",
    );
    expect(isRunRecord(rec)).toBe(true);
    expect(closes).toHaveLength(1);
    expect(JSON.stringify(closes[0])).toContain("✅");
    expect(replies.at(-1)).toEqual({
      threadKey: INSTANCE.threadKey,
      text: "Plan fixture ended (completed):\n✅ U10 — merge_ready — https://github.com/acme/api/pull/7\n• U11 — not started",
    });
    expect((await call(h, "finish", { parentInstanceId: PLAN_INSTANCE.id, outcome: "won" })).status).toBe(400);
  });
});

// Feature: docs/reference/specs/http-ingress.md item 9 — the runner's merge
// (record 0031's merge grant): a plan branch's pull request, squashed by the
// bot at exactly the approved head once the bot's own review approves there
// and every check is green; refused by reason otherwise, so a person decides.
describe("POST /admin/coordinator/merge — the runner's squash of a unit's pull request (item 9)", () => {
  const HEAD = "a".repeat(40);
  const MERGED = "9".repeat(40);
  const PLAN_INSTANCE: CoordinatorInstance = {
    ...INSTANCE,
    id: "plan-fixture",
    plan: { id: "fixture", path: "docs/plans/fixture.md" },
    caps: { maxRounds: 2, maxMinutes: 45 },
    runId: "run-parent",
  };
  const row = (over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
    instanceId: PLAN_INSTANCE.id,
    unit: "U10",
    slug: "u10-warm",
    branch: "plan/fixture/u10-warm",
    dependsOn: [],
    rounds: [],
    threadKey: "slack:C1:2.0",
    pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    ...over,
  });
  const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
    state: "open",
    author: { login: "acme-switchboard[bot]", id: 4242 },
    headRef: "plan/fixture/u10-warm",
    headSha: HEAD,
    sameRepoHead: true,
    baseRef: "main",
    title: "feat(cache): warm on wake",
    ...over,
  });
  const approving: PullRequestReview[] = [
    { author: { login: "acme-switchboard[bot]", id: 4242 }, state: "COMMENTED", commitId: HEAD, body: "LGTM: clean" },
  ];
  const green: CommitChecks = { total: 3, pending: [], failed: [] };
  const body = { parentInstanceId: PLAN_INSTANCE.id, unit: "U10", prNumber: 7, headSha: HEAD };
  async function mergeHarness(over: Parameters<typeof harness>[0] = {}, unit: Partial<CoordinatorUnit> = {}) {
    const h = harness({ prFacts: facts(), reviews: approving, checks: green, ...over });
    await h.instances.put(PLAN_INSTANCE);
    await h.instances.putUnits([row(unit)]);
    return h;
  }
  const call = (h: ReturnType<typeof harness>, step: string, b: Record<string, unknown>) =>
    handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}${step}`, b), h.deps);
  const merge = (h: ReturnType<typeof harness>, b: Record<string, unknown> = body, auth?: string) =>
    handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}merge`, b, auth), h.deps);

  it("every guard green: the bot squashes the pull request at exactly the approved head with the title as the commit, and answers merged with the squash's sha", async () => {
    const h = await mergeHarness();
    expect(await merge(h)).toEqual({ status: 200, body: { ok: true, outcome: "merged", sha: MERGED, at: NOW } });
    expect(h.merges).toEqual([
      { pr: { repo: "acme/api", number: 7 }, opts: { sha: HEAD, title: "feat(cache): warm on wake" } },
    ]);
    // A seven-hex approved head still pins the squash to what GitHub has.
    const short = await mergeHarness();
    expect((await merge(short, { ...body, headSha: HEAD.slice(0, 7) })).body).toMatchObject({ outcome: "merged" });
  });

  it("the grant decides first: a coordinator bearer without plan:merge is refused naming the grant, and nothing is asked of GitHub", async () => {
    const h = await mergeHarness();
    expect(await merge(h, body, "Bearer tok-step")).toEqual({
      status: 200,
      body: {
        ok: true,
        outcome: "refused",
        reason: 'the runner holds no plan:merge grant (grants["http:stepper"] in config.yaml) — a person merges',
        at: NOW,
      },
    });
    expect(h.merges).toEqual([]);
  });

  it("the branch decides, never the requester: a task instance, a branch of another shape and a branch of another plan wait for a person; the release pull request is refused by name", async () => {
    const task = harness({ prFacts: facts({ headRef: "ship/fix-x-abc123" }), reviews: approving, checks: green });
    await task.instances.put(INSTANCE);
    await task.instances.putUnits([
      {
        instanceId: INSTANCE.id,
        unit: "task",
        slug: "task",
        branch: "ship/fix-x-abc123",
        dependsOn: [],
        rounds: [],
        pr: { number: 7, url: "u" },
      },
    ]);
    expect((await merge(task, { ...body, parentInstanceId: INSTANCE.id, unit: "task" })).body).toMatchObject({
      outcome: "refused",
      reason: "`ship/fix-x-abc123` is not a branch of plan `(none)` — waits for a person's merge",
    });
    const other = await mergeHarness({}, { branch: "plan/other-plan/u10-warm" });
    expect((await merge(other)).body).toMatchObject({
      outcome: "refused",
      reason: "`plan/other-plan/u10-warm` is not a branch of plan `fixture` — waits for a person's merge",
    });
    expect(other.merges).toEqual([]);
    const release = await mergeHarness({
      prFacts: facts({ headRef: "release-please--branches--main", title: "chore(main): release 1.206.0" }),
    });
    expect((await merge(release)).body).toMatchObject({
      outcome: "refused",
      reason: "acme/api#7 is the release pull request — always a person's merge, never the runner's",
    });
    const releaseByTitle = await mergeHarness({ prFacts: facts({ title: "chore(main): release 1.206.0" }) });
    expect((await merge(releaseByTitle)).body).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("release pull request"),
    });
  });

  it("the pull request must be open, head the unit's branch and stand at the approved head; the bot's approving review must be pinned there — each refusal names what is off, and GitHub silent on the reviews is a passing 502", async () => {
    expect((await merge(await mergeHarness({ prFacts: facts({ state: "closed" }) }))).body).toMatchObject({
      outcome: "refused",
      reason: "acme/api#7 is closed",
    });
    expect(
      (await merge(await mergeHarness({ prFacts: facts({ headRef: "plan/fixture/u11-other" }) }))).body,
    ).toMatchObject({
      outcome: "refused",
      reason: "acme/api#7 heads `plan/fixture/u11-other`, not the unit's branch `plan/fixture/u10-warm`",
    });
    expect((await merge(await mergeHarness({ prFacts: facts({ headSha: "b".repeat(40) }) }))).body).toMatchObject({
      outcome: "refused",
      reason: `the head of acme/api#7 moved: \`${"b".repeat(7)}\` is not the approved \`${HEAD.slice(0, 7)}\``,
    });
    const otherAuthor = await mergeHarness({
      reviews: [{ author: { login: "alice" }, state: "APPROVED", commitId: HEAD, body: "LGTM: clean" }],
    });
    expect((await merge(otherAuthor)).body).toMatchObject({
      outcome: "refused",
      reason: `no approving review by the bot stands on acme/api#7 at \`${HEAD.slice(0, 7)}\``,
    });
    const changes = await mergeHarness({
      reviews: [
        {
          author: { login: "acme-switchboard[bot]", id: 4242 },
          state: "COMMENTED",
          commitId: HEAD,
          body: "Changes requested: x",
        },
      ],
    });
    expect((await merge(changes)).body).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("no approving review"),
    });
    const silent = await mergeHarness({ reviews: undefined });
    expect(await merge(silent)).toEqual({
      status: 502,
      body: { ok: false, error: "github_unavailable", message: "the reviews of acme/api#7 could not be read", at: NOW },
    });
    expect(silent.merges).toEqual([]);
  });

  it("the checks at the head: red is a refusal naming the runs, running or none yet is pending for the machine's poll, unreadable is a passing 502", async () => {
    const red = await mergeHarness({ checks: { total: 3, pending: [], failed: ["ci / bot / lint"] } });
    expect((await merge(red)).body).toMatchObject({
      outcome: "refused",
      reason: `CI is red at \`${HEAD.slice(0, 7)}\`: ci / bot / lint`,
    });
    const running = await mergeHarness({
      checks: { total: 3, pending: ["ci / bot / test 1 of 4", "ci / web"], failed: [] },
    });
    expect(await merge(running)).toEqual({
      status: 200,
      body: {
        ok: true,
        outcome: "pending",
        reason: `2 check(s) still running at \`${HEAD.slice(0, 7)}\`: ci / bot / test 1 of 4, ci / web`,
        at: NOW,
      },
    });
    const none = await mergeHarness({ checks: { total: 0, pending: [], failed: [] } });
    expect((await merge(none)).body).toMatchObject({
      outcome: "pending",
      reason: `no check has reported at \`${HEAD.slice(0, 7)}\` yet`,
    });
    const unreadable = await mergeHarness({ checks: undefined });
    expect((await merge(unreadable)).status).toBe(502);
    for (const h of [red, running, none, unreadable]) expect(h.merges).toEqual([]);
  });

  it("GitHub's own refusal of the squash — a conflict, a branch protection, a head that moved between the check and the merge — is answered as refused in GitHub's words; the pull request unreadable or the merge call failing is a passing 502; a malformed body is 400 and an unknown instance or unit 404", async () => {
    const conflict = await mergeHarness({ merge: { ok: false, status: 405, reason: "Pull Request is not mergeable" } });
    expect((await merge(conflict)).body).toMatchObject({
      outcome: "refused",
      reason: "GitHub refused the merge of acme/api#7 (HTTP 405): Pull Request is not mergeable",
    });
    const unreadable = await mergeHarness({ prFacts: undefined });
    expect(await merge(unreadable)).toEqual({
      status: 502,
      body: { ok: false, error: "github_unavailable", message: "acme/api#7 could not be read", at: NOW },
    });
    const threw = await mergeHarness({ merge: new Error("HTTP 502 bad gateway") });
    expect((await merge(threw)).status).toBe(502);
    const h = await mergeHarness();
    for (const bad of [
      { ...body, prNumber: "7" },
      { ...body, prNumber: 0 },
      { ...body, headSha: "xyz" },
      { ...body, unit: undefined },
      { ...body, parentInstanceId: "has:colon" },
    ])
      expect((await merge(h, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await merge(h, { ...body, parentInstanceId: "plan-none" })).status).toBe(404);
    expect((await merge(h, { ...body, unit: "U99" })).status).toBe(404);
    expect(h.merges).toEqual([]);
  });

  it("unit-end leaves the unit's ending on its board issue as the runner's handoff — the report under a line naming the unit, the ending and the pull request; a unit without an issue leaves none; a failed comment never fails the step", async () => {
    const h = await mergeHarness({ issues: [] });
    await h.instances.putUnits([row({ issue: 834 })]);
    // The in-memory GitHub needs the issue to exist for the comment.
    await h.github.createIssue("acme/api", { title: "U10: Warm the cache (unit)", body: "" });
    const issue = (await h.github.listIssues("acme/api", { state: "open", limit: 10 }))[0]!;
    await h.instances.putUnits([row({ issue: issue.number })]);
    expect(
      (
        await call(h, "unit-end", {
          parentInstanceId: PLAN_INSTANCE.id,
          unit: "U10",
          ending: {
            kind: "merge_refused",
            report: "⚠️ The review approved acme/api#7 but the runner did not merge it: conflict",
          },
          pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
        })
      ).status,
    ).toBe(200);
    const { comments } = await h.github.getIssue("acme/api", issue.number);
    expect(comments.map((c) => c.body)).toEqual([
      "**Plan runner — U10 ended `merge_refused`** · https://github.com/acme/api/pull/7\n\n⚠️ The review approved acme/api#7 but the runner did not merge it: conflict",
    ]);
    const noIssue = await mergeHarness();
    expect(
      (
        await call(noIssue, "unit-end", {
          parentInstanceId: PLAN_INSTANCE.id,
          unit: "U10",
          ending: { kind: "aborted", report: "x" },
        })
      ).status,
    ).toBe(200);
    const gone = await mergeHarness();
    await gone.instances.putUnits([row({ issue: 4242 })]);
    expect(
      (
        await call(gone, "unit-end", {
          parentInstanceId: PLAN_INSTANCE.id,
          unit: "U10",
          ending: { kind: "aborted", report: "x" },
        })
      ).body,
    ).toMatchObject({ ok: true });
    expect(gone.logs.some((l) => l.includes("the board comment could not be posted"))).toBe(true);
  });
});
