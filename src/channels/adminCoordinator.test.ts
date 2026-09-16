import { describe, expect, it } from "vitest";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { AGENTS } from "../agents/registry.js";
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
  MergedPrRef,
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
  REVIEW_POSTED_CHECKS,
  REVIEW_POSTED_RECHECK_MS,
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
/** The tag the spawn stamps: the instance, the step's key and the plan's base (INSTANCE.base). */
const TAG: CoordinatorTag = { parentInstanceId: INSTANCE.id, idempotencyKey: KEY, base: "main" };

const answer = (text: string): RunEvent => ({ type: "answer", text });

function record(id: string, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = [
    { type: "input", messageId: "m1", text: "do the unit", seq: 1 },
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
    /** The merged pull request heading the branch, asked only when no open one does. */
    mergedPr?: MergedPrRef | null | Error;
    /** The target repository's files at the base ref and its open issues (the in-memory GitHub). */
    files?: Record<string, string>;
    issues?: IssueSummary[];
    branchError?: Error;
    reviews?: PullRequestReview[];
    /** GitHub's review list per fetch, in order (the last entry repeats): a list the post reaches late. */
    reviewsSequence?: Array<PullRequestReview[] | undefined>;
    self?: GithubIdentity;
    ioFor?: (thread: { threadKey: string; userId: string; cardTs?: string }) => ChannelIO | undefined;
    /** The recover path's open-or-edit: the opened pull request, or the refusal (nothing pushed). */
    openPr?: { number: number; htmlUrl: string; created: boolean } | Error;
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
  const mergedLookups: Array<[string, string]> = [];
  const branches: Array<[string, string, string]> = [];
  const threadsAsked: Array<{ threadKey: string; userId: string; cardTs?: string }> = [];
  const written: RunRecord[] = [];
  const merges: Array<{ pr: { repo: string; number: number }; opts: { sha: string; title: string } }> = [];
  const opens: Array<{ repo: string; headBranch: string; base: string; title: string; body: string }> = [];
  const sleeps: number[] = [];
  let reviewFetches = 0;
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
    findMergedPrByHead: async (repo, branch) => {
      mergedLookups.push([repo, branch]);
      if (over.mergedPr instanceof Error) throw over.mergedPr;
      return over.mergedPr ?? null;
    },
    openPullRequest: async (target) => {
      opens.push(target);
      if (over.openPr instanceof Error) throw over.openPr;
      return over.openPr ?? { number: 77, htmlUrl: "https://github.com/acme/api/pull/77", created: true };
    },
    github,
    createBranchRef: async (repo, branch, fromRef) => {
      branches.push([repo, branch, fromRef]);
      if (over.branchError) throw over.branchError;
    },
    fetchPrReviews: async () => {
      const i = reviewFetches++;
      const seq = over.reviewsSequence;
      return seq ? seq[Math.min(i, seq.length - 1)] : over.reviews;
    },
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
    sleep: async (ms) => void sleeps.push(ms),
    log: (l) => void logs.push(l),
  };
  return {
    deps,
    sleeps,
    reviewFetches: () => reviewFetches,
    registry,
    store,
    ledger,
    instances,
    dispatched,
    replies,
    logs,
    prLookups,
    mergedLookups,
    opens,
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

  it("the tag carries the instance's base — the branch the child's pull request targets — and no base field at all for an instance that knows none, so the post-step's own resolution runs", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), h.deps);
    expect(h.dispatched[0].opts.coordinator.base).toBe("main");
    const { base: _base, ...baseless } = INSTANCE;
    const noBase = harness();
    await noBase.instances.put(baseless);
    await handleCoordinatorRequest(post(`${COORDINATOR_ADMIN_PREFIX}spawn`, spawnBody), noBase.deps);
    expect(noBase.dispatched[0].opts.coordinator).toEqual({ parentInstanceId: INSTANCE.id, idempotencyKey: KEY });
    expect("base" in noBase.dispatched[0].opts.coordinator).toBe(false);
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

  it("answers state merged — the number, url, merge commit and when GitHub says it merged — for a branch no open pull request heads but a merged one does, asked only after the open lookup came back empty; an open pull request never asks for a merged one; no pull request of either kind is still none; the merged lookup failing is 502 too", async () => {
    const MERGED_PR: MergedPrRef = {
      number: 12,
      htmlUrl: "https://github.com/acme/api/pull/12",
      sha: "9".repeat(40),
      mergedAt: "2026-09-13T23:55:59Z",
    };
    const merged = harness({ mergedPr: MERGED_PR });
    await merged.instances.put(INSTANCE);
    expect(
      await handleCoordinatorRequest(
        post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id }),
        merged.deps,
      ),
    ).toEqual({
      status: 200,
      body: {
        ok: true,
        state: "merged",
        prNumber: 12,
        url: "https://github.com/acme/api/pull/12",
        sha: "9".repeat(40),
        mergedAt: "2026-09-13T23:55:59Z",
        at: NOW,
      },
    });
    expect(merged.prLookups).toEqual([["acme/api", "plan/orchestration/u12"]]);
    expect(merged.mergedLookups).toEqual([["acme/api", "plan/orchestration/u12"]]);

    const open = harness({
      pr: { number: 12, htmlUrl: "https://github.com/acme/api/pull/12", headSha: "abc123" },
      mergedPr: MERGED_PR,
    });
    await open.instances.put(INSTANCE);
    expect(
      (
        await handleCoordinatorRequest(
          post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id }),
          open.deps,
        )
      ).body,
    ).toMatchObject({ state: "open", prNumber: 12 });
    expect(open.mergedLookups).toEqual([]);

    const none = harness();
    await none.instances.put(INSTANCE);
    expect(
      (
        await handleCoordinatorRequest(
          post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id }),
          none.deps,
        )
      ).body,
    ).toEqual({ ok: true, state: "none", at: NOW });
    expect(none.mergedLookups).toEqual([["acme/api", "plan/orchestration/u12"]]);

    const down = harness({ mergedPr: new Error("PR lookup failed: HTTP 502") });
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

  it("recover after a dead coding child: with nothing heading the branch, the pull request is opened from the pushed branch itself — a minimal body naming the unit when the record holds no description — and a refused create still answers none", async () => {
    const h = harness();
    await h.instances.put(INSTANCE);
    const res = await handleCoordinatorRequest(
      post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, {
        parentInstanceId: INSTANCE.id,
        recover: { runId: "11111111-1111-4111-8111-111111111111" },
      }),
      h.deps,
    );
    expect(res.body).toEqual({
      ok: true,
      state: "open",
      prNumber: 77,
      url: "https://github.com/acme/api/pull/77",
      at: NOW,
    });
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0]).toMatchObject({ repo: "acme/api", headBranch: "plan/orchestration/u12", base: "main" });
    expect(h.opens[0]!.body).toContain("ended before it could open the pull request");

    // Nothing pushed: GitHub refuses the create, and the check answers `none` as before.
    const refused = harness({ openPr: new Error("PR create failed: HTTP 422 no commits between main and the head") });
    await refused.instances.put(INSTANCE);
    const none = await handleCoordinatorRequest(
      post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, {
        parentInstanceId: INSTANCE.id,
        recover: { runId: "11111111-1111-4111-8111-111111111111" },
      }),
      refused.deps,
    );
    expect(none.body).toEqual({ ok: true, state: "none", unrecovered: "no_commits", at: NOW });

    // Without `recover`, nothing is ever opened from here.
    const plain = harness();
    await plain.instances.put(INSTANCE);
    await handleCoordinatorRequest(
      post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id }),
      plain.deps,
    );
    expect(plain.opens).toHaveLength(0);
  });
});

describe("pr-check recover — the answer says why nothing was recovered, and GitHub being down is never none", () => {
  const RUN = "11111111-1111-4111-8111-111111111111";
  const recoverCheck = (deps: Parameters<typeof handleCoordinatorRequest>[1]) =>
    handleCoordinatorRequest(
      post(`${COORDINATOR_ADMIN_PREFIX}pr-check`, { parentInstanceId: INSTANCE.id, recover: { runId: RUN } }),
      deps,
    );

  it("an instance with no base branch attempts no create and answers none with `no_base`", async () => {
    const h = harness();
    const { base: _base, ...withoutBase } = INSTANCE;
    await h.instances.put(withoutBase as typeof INSTANCE);
    const res = await recoverCheck(h.deps);
    expect(res.body).toEqual({ ok: true, state: "none", unrecovered: "no_base", at: NOW });
    expect(h.opens).toHaveLength(0);
  });

  it("a create GitHub refuses for any reason other than an empty branch is github_unavailable — the step is asked again, and the report never claims nothing was pushed", async () => {
    const down = harness({ openPr: new Error("PR create failed: HTTP 502 bad gateway") });
    await down.instances.put(INSTANCE);
    expect(await recoverCheck(down.deps)).toEqual({
      status: 502,
      body: { ok: false, error: "github_unavailable", message: "PR create failed: HTTP 502 bad gateway", at: NOW },
    });
    const forbidden = harness({ openPr: new Error("PR create failed: HTTP 403 resource not accessible") });
    await forbidden.instances.put(INSTANCE);
    expect((await recoverCheck(forbidden.deps)).status).toBe(502);
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
    merge: "runner",
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

  it("plan answers the instance's units with where each stands, who merges from the instance's field, the caps as clipped, the base and the children's own budgets; an instance without the field is a person's merge; an unknown instance is 404", async () => {
    const h = await planHarness();
    expect(await call(h, "plan", { parentInstanceId: PLAN_INSTANCE.id })).toEqual({
      status: 200,
      body: {
        ok: true,
        planId: "fixture",
        merge: "runner",
        generated: false,
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
    expect(body).toMatchObject({
      ok: true,
      base: "main",
      // The record carries no `merge` field — written before it existed — so a person merges.
      merge: "person",
      // No `plan.path` on the record: the mark of a generated plan, answered for the machine's report.
      generated: true,
      caps: { maxRounds: 3, maxMinutes: 120 },
      units: [],
    });
    expect("planId" in body).toBe(false);
  });

  /** A requesting thread's channel that opens threads: each lead gets the next key, and the leads are kept. */
  function openingIo(opened: string[]): ChannelIO {
    return {
      reply: async () => {},
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
      openThread: async (lead) => {
        opened.push(lead);
        return {
          thread: {
            threadKey: `slack:C1:${opened.length + 1}.0`,
            sourceUrl: `https://acme.slack.com/archives/C1/p${opened.length + 1}`,
          },
          io: {
            reply: async () => {},
            status: async () => ({ update: () => {}, done: async () => {} }),
            history: async () => [],
          },
        };
      },
    };
  }

  it("unit-start opens a plan unit's thread and, beside it, the unit's review thread through the requesting thread's channel, finds the board issue titled by the unit id, and writes both threads on the row; a second start answers the same threads and opens none; a task unit runs in the requesting thread with a review thread of its own; an unknown unit is 404", async () => {
    const opened: string[] = [];
    const h = await planHarness({
      ioFor: () => openingIo(opened),
      issues: [issue(7, "Something else"), issue(834, "U10: Warm the cache on wake (unit)")],
    });
    const first = await call(h, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" });
    expect(first).toEqual({
      status: 200,
      body: {
        ok: true,
        threadKey: "slack:C1:2.0",
        reviewThreadKey: "slack:C1:3.0",
        branch: "plan/fixture/u10",
        base: "main",
        issue: 834,
        at: NOW,
      },
    });
    expect(opened).toHaveLength(2);
    expect(opened[0]).toContain("↳ *ship* unit U10 — Warm the cache on wake for alice");
    expect(opened[0]).toContain("`plan/fixture/u10` in acme/api");
    expect(opened[1]).toContain("↳ *ship* review of unit U10 — Warm the cache on wake for alice");
    expect(opened[1]).toContain("`plan/fixture/u10` in acme/api");
    expect(h.threadsAsked[0]).toEqual({ threadKey: INSTANCE.threadKey, userId: INSTANCE.userId });
    const rows = await h.instances.listUnits(PLAN_INSTANCE.id);
    expect(rows[0]).toEqual(
      unitRow("U10", {
        threadKey: "slack:C1:2.0",
        sourceUrl: "https://acme.slack.com/archives/C1/p2",
        reviewThread: { threadKey: "slack:C1:3.0", sourceUrl: "https://acme.slack.com/archives/C1/p3" },
        issue: 834,
        startedAt: NOW,
      }),
    );
    // Idempotent: the same threads, no further lead.
    expect((await call(h, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" })).body).toMatchObject({
      threadKey: "slack:C1:2.0",
      reviewThreadKey: "slack:C1:3.0",
    });
    expect(opened).toHaveLength(2);
    expect((await call(h, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U99" })).status).toBe(404);

    // A row written before the review thread existed: its start opens the review thread alone.
    const older = await planHarness({ ioFor: () => openingIo(opened) });
    await older.instances.putUnits([
      unitRow("U10", { threadKey: "slack:C1:2.0", sourceUrl: "https://acme.slack.com/archives/C1/p2", startedAt: 5 }),
    ]);
    const resumed = await call(older, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" });
    expect(resumed.body).toMatchObject({ threadKey: "slack:C1:2.0", reviewThreadKey: "slack:C1:4.0" });
    expect(opened).toHaveLength(3);
    expect(opened[2]).toContain("↳ *ship* review of unit U10");
    expect((await older.instances.listUnits(PLAN_INSTANCE.id))[0]).toMatchObject({
      threadKey: "slack:C1:2.0",
      reviewThread: { threadKey: "slack:C1:4.0" },
      startedAt: 5,
    });

    // A generated plan's unit (the instance's `plan` has no `path`) runs in the
    // requesting thread: no unit thread is opened, no board issue is looked up,
    // and the review lead carries the task wording.
    const taskOpened: string[] = [];
    const task = harness({
      ioFor: () => openingIo(taskOpened),
      // An open issue titled by the unit id: a generated unit must NOT pick it up.
      issues: [issue(834, "U1: anything (unit)")],
    });
    const generated: CoordinatorInstance = {
      ...INSTANCE,
      plan: { id: "warm-the-cache-abc123" },
      branch: "plan/warm-the-cache-abc123/u1",
    };
    await task.instances.put(generated);
    await task.instances.putUnits([
      { instanceId: INSTANCE.id, unit: "U1", slug: "u1", branch: generated.branch, dependsOn: [], rounds: [] },
    ]);
    expect(await call(task, "unit-start", { parentInstanceId: INSTANCE.id, unit: "U1" })).toEqual({
      status: 200,
      body: {
        ok: true,
        threadKey: INSTANCE.threadKey,
        reviewThreadKey: "slack:C1:2.0",
        branch: generated.branch,
        base: "main",
        at: NOW,
      },
    });
    expect(taskOpened).toHaveLength(1);
    expect(taskOpened[0]).toContain("↳ *ship* review of the task for alice");
    const genRow = (await task.instances.listUnits(INSTANCE.id))[0]!;
    expect(genRow).toMatchObject({
      threadKey: INSTANCE.threadKey,
      sourceUrl: INSTANCE.sourceUrl,
      reviewThread: { threadKey: "slack:C1:2.0", sourceUrl: "https://acme.slack.com/archives/C1/p2" },
    });
    expect(genRow.issue).toBeUndefined();
  });

  it("unit-start without a channel that can open a thread is 503; a channel whose open fails is 502 and the row is unchanged; a review thread whose open fails leaves the unit thread on the row, so the retry opens the review thread alone", async () => {
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

    let opens = 0;
    const secondFails = await planHarness({
      ioFor: () => ({
        reply: async () => {},
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
        openThread: async () => {
          opens++;
          if (opens === 2) throw new Error("rate limited");
          return {
            thread: { threadKey: `slack:C1:${opens + 1}.0` },
            io: {
              reply: async () => {},
              status: async () => ({ update: () => {}, done: async () => {} }),
              history: async () => [],
            },
          };
        },
      }),
    });
    const half = await call(secondFails, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" });
    expect(half).toEqual({
      status: 502,
      body: { ok: false, error: "thread_failed", message: "rate limited", at: NOW },
    });
    expect((await secondFails.instances.listUnits(PLAN_INSTANCE.id))[0]).toEqual(
      unitRow("U10", { threadKey: "slack:C1:2.0" }),
    );
    const retried = await call(secondFails, "unit-start", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" });
    expect(retried.body).toMatchObject({ ok: true, threadKey: "slack:C1:2.0", reviewThreadKey: "slack:C1:4.0" });
    expect(opens).toBe(3);
  });

  it("spawn with a review brief dispatches the review child into the unit's review thread, never the unit thread: a run live in the unit thread does not make it busy, one live in the review thread does, and the child is the review preset, whose read identity gives it a readonly worktree of its own; a row without a review thread has one opened at the first review spawn and stored", async () => {
    const review = (step: string) => ({
      parentInstanceId: PLAN_INSTANCE.id,
      step,
      preset: "review",
      brief: { kind: "review", unit: "U10", pr: 7, headSha: "a".repeat(40), round: 1 },
    });
    const h = await planHarness();
    await h.instances.putUnits([
      unitRow("U10", {
        threadKey: "slack:C1:2.0",
        sourceUrl: "https://acme.slack.com/archives/C1/p2",
        reviewThread: { threadKey: "slack:C1:3.0", sourceUrl: "https://acme.slack.com/archives/C1/p3" },
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      }),
    ]);
    // A person's run in the unit thread: the review still runs, in its own thread.
    h.registry.create("coding · person", {
      agent: "coding",
      channelId: PLAN_INSTANCE.channelId,
      userId: PLAN_INSTANCE.userId,
      threadKey: "slack:C1:2.0",
    });
    const res = await call(h, "spawn", review("U10/1/review"));
    expect(res).toEqual({ status: 200, body: { ok: true, runId: "run-child", threadKey: "slack:C1:3.0", at: NOW } });
    expect(h.dispatched).toHaveLength(1);
    const { msg, opts } = h.dispatched[0];
    expect(msg.threadKey).toBe("slack:C1:3.0");
    expect(msg.sourceUrl).toBe("https://acme.slack.com/archives/C1/p3");
    expect(msg.text.startsWith("agent:review in acme/api: https://github.com/acme/api/pull/7\n\n")).toBe(true);
    expect(msg.text).toContain(`Review pull request acme/api#7 at head \`${"a".repeat(40)}\``);
    expect(opts.coordinator).toEqual({
      parentInstanceId: PLAN_INSTANCE.id,
      idempotencyKey: "plan-fixture:U10/1/review",
      base: "main",
    });
    expect(AGENTS.review.identity).toBe("read");
    expect(h.threadsAsked.at(-1)).toEqual({ threadKey: "slack:C1:3.0", userId: PLAN_INSTANCE.userId });

    // A run live in the review thread is what makes a review spawn busy.
    const busy = await planHarness();
    await busy.instances.putUnits([
      unitRow("U10", { threadKey: "slack:C1:2.0", reviewThread: { threadKey: "slack:C1:3.0" } }),
    ]);
    const other = busy.registry.create("review · person", {
      agent: "review",
      channelId: PLAN_INSTANCE.channelId,
      userId: PLAN_INSTANCE.userId,
      threadKey: "slack:C1:3.0",
    });
    expect(await call(busy, "spawn", review("U10/1/review"))).toEqual({
      status: 409,
      body: { ok: false, error: "busy", runId: other.id, agent: "review", at: NOW },
    });
    expect(busy.dispatched).toEqual([]);

    // A row written before the review thread existed: the first review spawn opens it and stores it.
    const opened: string[] = [];
    const older = await planHarness({ ioFor: () => openingIo(opened) });
    await older.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:9.0" })]);
    const late = await call(older, "spawn", review("U10/1/review"));
    expect(late).toEqual({ status: 200, body: { ok: true, runId: "run-child", threadKey: "slack:C1:2.0", at: NOW } });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("↳ *ship* review of unit U10");
    expect(older.threadsAsked[0]).toEqual({ threadKey: INSTANCE.threadKey, userId: INSTANCE.userId });
    expect(older.dispatched[0].msg.threadKey).toBe("slack:C1:2.0");
    expect((await older.instances.listUnits(PLAN_INSTANCE.id))[0]).toMatchObject({
      threadKey: "slack:C1:9.0",
      reviewThread: { threadKey: "slack:C1:2.0", sourceUrl: "https://acme.slack.com/archives/C1/p2" },
    });
  });

  it("spawn with a findings brief is refused busy while a run is live in the unit thread (a person's, since the runner awaited its own child) and dispatched into it when none is; a run that takes the unit thread between the read and the claim is answered from that run", async () => {
    const findings = {
      parentInstanceId: PLAN_INSTANCE.id,
      step: "U10/1/findings",
      preset: "coding",
      brief: { kind: "findings", unit: "U10", pr: 7, reviewRunId: "run-r1" },
    };
    const reviewRecord = record("run-r1", {
      agent: "review",
      threadKey: "slack:C1:3.0",
      parentInstanceId: PLAN_INSTANCE.id,
      idempotencyKey: "plan-fixture:U10/1/review",
      verdict: {
        verdict: "request_changes",
        summary: "one nit",
        findings: [{ id: "F1", severity: "minor", file: "src/a.ts", line: 3, title: "off by one" }],
      },
      reviewHead: "a".repeat(40),
      events: [{ type: "answer", text: "Changes requested: one nit.", seq: 1 }],
    });
    const rows = () => [unitRow("U10", { threadKey: "slack:C1:2.0", reviewThread: { threadKey: "slack:C1:3.0" } })];
    const live = await planHarness();
    await live.instances.putUnits(rows());
    await live.store.put(reviewRecord);
    const person = live.registry.create("coding · person", {
      agent: "coding",
      channelId: PLAN_INSTANCE.channelId,
      userId: PLAN_INSTANCE.userId,
      threadKey: "slack:C1:2.0",
    });
    expect(await call(live, "spawn", findings)).toEqual({
      status: 409,
      body: { ok: false, error: "busy", runId: person.id, agent: "coding", at: NOW },
    });
    expect(live.dispatched).toEqual([]);

    const free = await planHarness();
    await free.instances.putUnits(rows());
    await free.store.put(reviewRecord);
    // A run live in the REVIEW thread does not hold the unit thread.
    free.registry.create("review · child", {
      agent: "review",
      channelId: PLAN_INSTANCE.channelId,
      userId: PLAN_INSTANCE.userId,
      threadKey: "slack:C1:3.0",
    });
    expect(await call(free, "spawn", findings)).toEqual({
      status: 200,
      body: { ok: true, runId: "run-child", threadKey: "slack:C1:2.0", at: NOW },
    });
    expect(free.dispatched).toHaveLength(1);
    expect(free.dispatched[0].msg.threadKey).toBe("slack:C1:2.0");
    expect(free.dispatched[0].msg.text.startsWith("agent:coding in acme/api on branch plan/fixture/u10: ")).toBe(true);

    const raced = await planHarness({
      script: async (msg) => {
        raced.registry.create("coding · person", {
          agent: "coding",
          channelId: msg.channelId,
          userId: msg.userId,
          threadKey: msg.threadKey,
        });
        return { status: "refused", refusal: "coordinator_thread_live" };
      },
    });
    await raced.instances.putUnits(rows());
    await raced.store.put(reviewRecord);
    expect(await call(raced, "spawn", findings)).toMatchObject({
      status: 409,
      body: { ok: false, error: "busy", agent: "coding", at: NOW },
    });
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

  it("spawn with a contract brief composes the coding child's turn from the plan at the base ref: the unit's branch in the text, the contract and the tag as its options; a findings brief dispatches the review run's findings into the unit thread as `agent:coding` with the tag as its only option, no finding-id tag; a brief for a unit without a thread is 409; a brief the bot cannot compose is 502", async () => {
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
    // The child runs AT the unit branch; the tag says which branch its pull
    // request targets — the plan's base — since the thread cannot.
    expect(opts.coordinator).toEqual({
      parentInstanceId: PLAN_INSTANCE.id,
      idempotencyKey: "plan-fixture:U10/0/coding",
      base: "main",
    });
    const contract = (opts as { contract?: ChildContract }).contract!;
    expect(contract.unit.id).toBe("U10");
    expect(contract.issue).toEqual({ repo: "acme/api", number: 834 });
    expect(contract.agentRules).toEqual({ file: "AGENTS.md", text: "# Rules" });
    expect(contract.rebase).toEqual({ branch: "plan/fixture/u10", onto: "main" });

    // The findings brief: the review run's record carries the findings and the words, and the message goes
    // into the unit thread as the requester with the directive explicit, so the coding session there continues
    // whatever the thread's sticky agent says.
    await h.store.put(
      record("run-r1", {
        agent: "review",
        threadKey: "slack:C1:3.0",
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
    const findings = await call(h, "spawn", {
      parentInstanceId: PLAN_INSTANCE.id,
      step: "U10/1/findings",
      preset: "coding",
      brief: { kind: "findings", unit: "U10", pr: 7, reviewRunId: "run-r1" },
    });
    expect(findings).toEqual({
      status: 200,
      body: { ok: true, runId: "run-child", threadKey: "slack:C1:2.0", at: NOW },
    });
    const findingsDispatch = h.dispatched[1];
    expect(findingsDispatch.msg.threadKey).toBe("slack:C1:2.0");
    expect(findingsDispatch.msg.userId).toBe(PLAN_INSTANCE.userId);
    expect(
      findingsDispatch.msg.text.startsWith(
        "agent:coding in acme/api on branch plan/fixture/u10: The review of acme/api#7 requested changes.",
      ),
    ).toBe(true);
    expect(findingsDispatch.msg.text).toContain("[minor] F1 src/a.ts:3 — off by one");
    expect(findingsDispatch.msg.text).toContain("Review:\nChanges requested: one nit.");
    expect(findingsDispatch.opts).toEqual({
      coordinator: { parentInstanceId: PLAN_INSTANCE.id, idempotencyKey: "plan-fixture:U10/1/findings", base: "main" },
    });
    // No dispatch of this route carries a finding-id tag: the tool records what the run submits and the
    // runner matches the ids.
    for (const d of h.dispatched) expect("fixRound" in d.opts).toBe(false);

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
    expect(await bad({ brief: { kind: "review", unit: "U10", pr: 7, round: 2, prior: { fixRunId: "run-f1" } } })).toBe(
      400,
    );
    expect(await bad({ brief: { kind: "findings", unit: "U10", pr: 7 } })).toBe(400);
    // The fix brief kind is gone: a coordinator still sending one is refused like any unknown kind.
    expect(await bad({ brief: { kind: "fix", unit: "U10", pr: 7, reviewRunId: "run-r1" } })).toBe(400);
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
        idempotencyKey: "plan-fixture:U10/1/findings",
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

  it("read-record answers a finished child's verdict and reviewed head, dispositions and handoff while the registry still holds the row — the record landed in the store inside the registry's window, and the store is what the runner reads", async () => {
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
    const meta = {
      channelId: INSTANCE.channelId,
      userId: INSTANCE.userId,
      threadKey: "slack:C1:2.0",
      parentInstanceId: PLAN_INSTANCE.id,
    };
    // Three children finish a second before the runner reads them: each row is
    // still in the registry (inside its 60 s TTL) and each record has landed.
    const review = h.registry.create("review", {
      ...meta,
      agent: "review",
      idempotencyKey: "plan-fixture:U10/1/review",
    });
    h.registry.publish(review.id, { type: "answer", text: "LGTM: clean" });
    h.registry.finish(review.id, "completed");
    await h.store.put(
      record(review.id, {
        ...meta,
        agent: "review",
        idempotencyKey: "plan-fixture:U10/1/review",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewHead: HEAD,
        events: [{ type: "answer", text: "LGTM: clean", seq: 1 }],
      }),
    );
    h.registry.markPersisted(review.id);
    const fix = h.registry.create("fix", { ...meta, agent: "coding", idempotencyKey: "plan-fixture:U10/1/fix" });
    h.registry.finish(fix.id, "completed");
    await h.store.put(
      record(fix.id, {
        ...meta,
        idempotencyKey: "plan-fixture:U10/1/fix",
        dispositions: [{ findingId: "F1", disposition: "fixed", note: "done" }],
      }),
    );
    h.registry.markPersisted(fix.id);
    const coding = h.registry.create("coding", {
      ...meta,
      agent: "coding",
      idempotencyKey: "plan-fixture:U10/0/coding",
    });
    h.registry.finish(coding.id, "completed");
    await h.store.put(
      record(coding.id, {
        ...meta,
        idempotencyKey: "plan-fixture:U10/0/coding",
        handoff: { deviations: [], followUps: [], unproven: [] },
      }),
    );
    h.registry.markPersisted(coding.id);
    for (const id of [review.id, fix.id, coding.id]) expect(h.registry.getById(id)?.finished).toBe(true);

    const read = (runId: string) => call(h, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId, unit: "U10" });
    expect((await read(review.id)).body).toMatchObject({
      run: {
        id: review.id,
        finished: true,
        finalReply: "LGTM: clean",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewHead: HEAD,
        reviewPosted: true,
      },
    });
    expect((await read(fix.id)).body).toMatchObject({
      run: { id: fix.id, finished: true, dispositions: [{ findingId: "F1", disposition: "fixed", note: "done" }] },
    });
    expect((await read(coding.id)).body).toMatchObject({ run: { id: coding.id, finished: true, handoff: true } });
  });

  // docs/reference/specs/http-ingress.md item 9, agent-review.md item 18 — the
  // review child records its own post; the runner trusts that record and asks
  // GitHub only when the record is silent, patiently.
  it("read-record answers reviewPosted from the child's recorded post — true at the reviewed head with the verdict, on the unit's pull request — and never asks GitHub, whose review list may not surface the review yet", async () => {
    const HEAD = "a".repeat(40);
    // GitHub shows nothing: the review was posted a second ago.
    const h = await planHarness({ reviews: [] });
    await h.instances.putUnits([
      unitRow("U10", { threadKey: "slack:C1:2.0", pr: { number: 7, url: "https://github.com/acme/api/pull/7" } }),
    ]);
    const tag = { parentInstanceId: PLAN_INSTANCE.id, idempotencyKey: "plan-fixture:U10/1/review" };
    await h.store.put(
      record("run-r1", {
        ...tag,
        agent: "review",
        threadKey: "slack:C1:2.0",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewHead: HEAD,
        reviewPost: { posted: true, target: { repo: "acme/api", number: 7 }, head: HEAD, verdict: "approve" },
        events: [{ type: "answer", text: "LGTM: clean", seq: 1 }],
      }),
    );
    const res = await call(h, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId: "run-r1", unit: "U10" });
    expect(res.body).toMatchObject({
      run: { id: "run-r1", verdict: { verdict: "approve" }, reviewHead: HEAD, reviewPosted: true },
    });
    expect("reviewPostReason" in (res.body as { run: Record<string, unknown> }).run).toBe(false);
    expect(h.reviewFetches()).toBe(0);
    expect(h.sleeps).toEqual([]);
  });

  it("read-record answers a recorded skip as reviewPosted: false with the child's reason, GitHub never asked — a skip the child chose is not a post GitHub has yet to surface", async () => {
    const HEAD = "a".repeat(40);
    // GitHub even shows a matching review (an older one): the record wins.
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
    await h.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0", pr: { number: 7, url: "u" } })]);
    await h.store.put(
      record("run-r1", {
        parentInstanceId: PLAN_INSTANCE.id,
        idempotencyKey: "plan-fixture:U10/1/review",
        agent: "review",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewHead: HEAD,
        reviewPost: { posted: false, reason: "digest covered 3 of 5 files" },
      }),
    );
    const res = await call(h, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId: "run-r1", unit: "U10" });
    expect(res.body).toMatchObject({
      run: { id: "run-r1", reviewPosted: false, reviewPostReason: "digest covered 3 of 5 files" },
    });
    expect(h.reviewFetches()).toBe(0);
  });

  it("a recorded post at another head, with another verdict or on another pull request is not trusted: GitHub decides", async () => {
    const HEAD = "a".repeat(40);
    const stale = [
      { posted: true, target: { repo: "acme/api", number: 7 }, head: "b".repeat(40), verdict: "approve" },
      { posted: true, target: { repo: "acme/api", number: 7 }, head: HEAD, verdict: "request_changes" },
      { posted: true, target: { repo: "acme/api", number: 8 }, head: HEAD, verdict: "approve" },
    ] as const;
    for (const reviewPost of stale) {
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
      await h.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0", pr: { number: 7, url: "u" } })]);
      await h.store.put(
        record("run-r1", {
          parentInstanceId: PLAN_INSTANCE.id,
          idempotencyKey: "plan-fixture:U10/1/review",
          agent: "review",
          verdict: { verdict: "approve", summary: "clean", findings: [] },
          reviewHead: HEAD,
          reviewPost,
        }),
      );
      const res = await call(h, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId: "run-r1", unit: "U10" });
      expect(res.body, JSON.stringify(reviewPost)).toMatchObject({ run: { reviewPosted: true } });
      expect(h.reviewFetches(), JSON.stringify(reviewPost)).toBe(1);
    }
  });

  it("with no recorded post (an older child) GitHub is asked up to three times, a pause apart, and the first sighting answers true; a review GitHub never shows answers false after the third; a GitHub that stays silent answers nothing", async () => {
    const HEAD = "a".repeat(40);
    const standing: PullRequestReview[] = [
      { author: { login: "acme-switchboard[bot]", id: 4242 }, state: "COMMENTED", commitId: HEAD, body: "LGTM: clean" },
    ];
    const seed = async (h: Awaited<ReturnType<typeof planHarness>>) => {
      await h.instances.putUnits([unitRow("U10", { threadKey: "slack:C1:2.0", pr: { number: 7, url: "u" } })]);
      await h.store.put(
        record("run-r1", {
          parentInstanceId: PLAN_INSTANCE.id,
          idempotencyKey: "plan-fixture:U10/1/review",
          agent: "review",
          verdict: { verdict: "approve", summary: "clean", findings: [] },
          reviewHead: HEAD,
        }),
      );
      return call(h, "read-record", { parentInstanceId: PLAN_INSTANCE.id, runId: "run-r1", unit: "U10" });
    };
    // The list surfaces the review on the third look.
    const late = await planHarness({ reviewsSequence: [[], [], standing] });
    expect((await seed(late)).body).toMatchObject({ run: { reviewPosted: true } });
    expect(late.reviewFetches()).toBe(3);
    expect(late.sleeps).toEqual([REVIEW_POSTED_RECHECK_MS, REVIEW_POSTED_RECHECK_MS]);
    // The first look already sees it: no pause.
    const prompt = await planHarness({ reviews: standing });
    expect((await seed(prompt)).body).toMatchObject({ run: { reviewPosted: true } });
    expect(prompt.reviewFetches()).toBe(1);
    expect(prompt.sleeps).toEqual([]);
    // Never shown: false, after every look.
    const never = await planHarness({ reviews: [] });
    expect((await seed(never)).body).toMatchObject({ run: { reviewPosted: false } });
    expect("reviewPostReason" in ((await seed(never)).body as { run: Record<string, unknown> }).run).toBe(false);
    expect(never.reviewFetches()).toBe(REVIEW_POSTED_CHECKS * 2);
    // Silent (the fetch answers nothing) on every look: unknown, never a guess.
    const silent = await planHarness({ reviewsSequence: [undefined] });
    const body = (await seed(silent)).body as { run: Record<string, unknown> };
    expect("reviewPosted" in body.run).toBe(false);
    expect(silent.reviewFetches()).toBe(REVIEW_POSTED_CHECKS);
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

  it("pr-check for a unit whose branch only a merged pull request heads answers merged and remembers that pull request on the row, so the row reads like a unit the runner merged", async () => {
    const h = await planHarness({
      mergedPr: {
        number: 12,
        htmlUrl: "https://github.com/acme/api/pull/12",
        sha: "9".repeat(40),
        mergedAt: "2026-09-13T23:55:59Z",
      },
    });
    expect(await call(h, "pr-check", { parentInstanceId: PLAN_INSTANCE.id, unit: "U10" })).toEqual({
      status: 200,
      body: {
        ok: true,
        state: "merged",
        prNumber: 12,
        url: "https://github.com/acme/api/pull/12",
        sha: "9".repeat(40),
        mergedAt: "2026-09-13T23:55:59Z",
        at: NOW,
      },
    });
    expect(h.prLookups).toEqual([["acme/api", "plan/fixture/u10"]]);
    expect(h.mergedLookups).toEqual([["acme/api", "plan/fixture/u10"]]);
    expect((await h.instances.listUnits(PLAN_INSTANCE.id))[0].pr).toEqual({
      number: 12,
      url: "https://github.com/acme/api/pull/12",
    });
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

    // A review_pending ending's headSha — the coding child's own last push —
    // is persisted on the row as lastPush, so the next attempt's pre-check can
    // start at the review round; a value that is not a sha leaves the row alone.
    expect(
      (
        await call(h, "unit-end", {
          parentInstanceId: PLAN_INSTANCE.id,
          unit: "U10",
          ending: { kind: "review_pending", report: "⏸ capped" },
          headSha: "ABCDEF1234abcdef1234abcdef1234abcdef1234",
        })
      ).status,
    ).toBe(200);
    expect((await h.instances.listUnits(PLAN_INSTANCE.id))[0].lastPush).toBe(
      "abcdef1234abcdef1234abcdef1234abcdef1234",
    );
    await call(h, "unit-end", {
      parentInstanceId: PLAN_INSTANCE.id,
      unit: "U10",
      ending: { kind: "review_pending", report: "⏸ capped" },
      headSha: "not-a-sha",
    });
    expect((await h.instances.listUnits(PLAN_INSTANCE.id))[0].lastPush).toBe(
      "abcdef1234abcdef1234abcdef1234abcdef1234",
    );
    // Restore the merge_ready ending for the finish assertions below.
    await call(h, "unit-end", {
      parentInstanceId: PLAN_INSTANCE.id,
      unit: "U10",
      ending: {
        kind: "merge_ready",
        report: "✅ Merge-ready after 1 review round: https://github.com/acme/api/pull/7",
      },
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    });

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
    // The record names the instance whose story it is (agent-ship item 17), so its page can list the units.
    expect(rec.events[0]).toMatchObject({ type: "run_meta", agent: "ship", instanceId: PLAN_INSTANCE.id });
    expect(rec.parentInstanceId).toBeUndefined(); // the pipeline's own record is nobody's child
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

  it("a generated instance (a `plan` with no `path`) carries the task wording: the card line and the record's summary name no unit id, and finish posts no summary reply — the unit's report already landed in the requesting thread", async () => {
    const replies: Array<{ threadKey: string; text: string }> = [];
    const closes: StatusUpdate[] = [];
    const h = harness({
      ioFor: (thread) => ({
        reply: async (text) => void replies.push({ threadKey: thread.threadKey, text }),
        status: async () => ({ update: () => {}, done: async (frame) => void closes.push(frame) }),
        history: async () => [],
      }),
    });
    const generated: CoordinatorInstance = {
      ...PLAN_INSTANCE,
      id: "plan-warm-abc123",
      plan: { id: "warm-abc123" },
      merge: "person",
      branch: "plan/warm-abc123/u1",
    };
    await h.instances.put(generated);
    await h.instances.putUnits([
      {
        instanceId: generated.id,
        unit: "U1",
        slug: "u1",
        branch: generated.branch,
        dependsOn: [],
        rounds: [],
        threadKey: generated.threadKey,
        ending: { kind: "merge_ready", report: "ready", at: NOW },
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      },
    ]);
    expect(await call(h, "finish", { parentInstanceId: generated.id, outcome: "completed" })).toEqual({
      status: 200,
      body: { ok: true, runId: "run-parent", at: NOW },
    });
    const summary = h.written[0]!.events.at(-1)!;
    expect(summary.type === "answer" ? summary.text : "").toBe("✅ merge_ready — https://github.com/acme/api/pull/7");
    // The card closes with the task wording — no `U1 ·` prefix on the line.
    expect(closes).toHaveLength(1);
    expect(JSON.stringify(closes[0])).not.toContain("U1 ·");
    // No summary reply: the unit ran in the requesting thread, its report is there.
    expect(replies).toEqual([]);
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
    merge: "runner",
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

  it("the instance's field decides, then the branch's shape as defense in depth: a task instance and an instance without the field wait for a person naming the field; a runner instance on a branch of another shape or another plan is refused naming the field and the branch; the release pull request is refused by name", async () => {
    // A plan instance whose field says person — or says nothing — waits for a person, plan branch or not.
    const person = harness({ prFacts: facts(), reviews: approving, checks: green });
    await person.instances.put({ ...PLAN_INSTANCE, merge: "person" });
    await person.instances.putUnits([row()]);
    expect((await merge(person)).body).toMatchObject({
      outcome: "refused",
      reason: "the instance's `merge` field says person — waits for a person's merge",
    });
    expect(person.merges).toEqual([]);
    const absent = harness({ prFacts: facts(), reviews: approving, checks: green });
    const { merge: _dropped, ...withoutField } = PLAN_INSTANCE;
    await absent.instances.put(withoutField);
    await absent.instances.putUnits([row()]);
    expect((await merge(absent)).body).toMatchObject({
      outcome: "refused",
      reason: "the instance's `merge` field says person — waits for a person's merge",
    });
    // A task instance whose record says runner anyway — defense in depth: the branch's shape refuses it.
    const task = harness({ prFacts: facts({ headRef: "ship/fix-x-abc123" }), reviews: approving, checks: green });
    await task.instances.put({ ...INSTANCE, merge: "runner" });
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
      reason:
        "the instance's `merge` field says runner but `ship/fix-x-abc123` is not a branch of plan `(none)` — waits for a person's merge",
    });
    expect(task.merges).toEqual([]);
    const other = await mergeHarness({}, { branch: "plan/other-plan/u10-warm" });
    expect((await merge(other)).body).toMatchObject({
      outcome: "refused",
      reason:
        "the instance's `merge` field says runner but `plan/other-plan/u10-warm` is not a branch of plan `fixture` — waits for a person's merge",
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

  it("a conflicting pull request (mergeable_state dirty) is refused at once, before the checks are read — zero checks stays pending only on a mergeable pull request", async () => {
    // Checks unreadable would answer 502; the dirty refusal lands first, so
    // the checks were never consulted.
    const dirty = await mergeHarness({
      prFacts: facts({ mergeable: false, mergeableState: "dirty" }),
      checks: undefined,
    });
    expect(await merge(dirty)).toEqual({
      status: 200,
      body: {
        ok: true,
        outcome: "refused",
        reason: `acme/api#7 conflicts with \`main\` at \`${HEAD.slice(0, 7)}\`, rebase and re-issue`,
        at: NOW,
      },
    });
    expect(dirty.merges).toEqual([]);
    // The refusal names the pull request's own base — a stacked unit rebases
    // onto its parent, not onto main.
    const stacked = await mergeHarness({
      prFacts: facts({ mergeable: false, mergeableState: "dirty", baseRef: "plan/fixture/u9" }),
      checks: undefined,
    });
    expect((await merge(stacked)).body).toMatchObject({
      outcome: "refused",
      reason: `acme/api#7 conflicts with \`plan/fixture/u9\` at \`${HEAD.slice(0, 7)}\`, rebase and re-issue`,
    });
    // A mergeable pull request with zero checks still answers pending.
    const clean = await mergeHarness({
      prFacts: facts({ mergeable: true, mergeableState: "clean" }),
      checks: { total: 0, pending: [], failed: [] },
    });
    expect((await merge(clean)).body).toMatchObject({ outcome: "pending" });
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

  it("unit-end leaves the unit's ending on its board issue — the report under a line naming the unit, the ending and the pull request, and the last coding child's typed handoff rendered under it when the ending names that run (a run of this instance, none for another's, a missing one or a record without a handoff); a unit without an issue leaves none; a failed comment never fails the step", async () => {
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
    // The last coding child's typed handoff (agent-ship item 14) rides the
    // comment under the report when the ending names the child's run: read
    // from its record, a run of this instance and no other — a run outside the
    // instance, one the history lacks, or a record without a handoff leaves the
    // comment as the report alone.
    const handoff = {
      deviations: [{ from: "one table", to: "two tables", why: "the row outgrew the record" }],
      followUps: [],
      unproven: [{ criterion: "the live receipt", why: "needs staging" }],
    };
    await h.store.put(
      record("run-c0", {
        parentInstanceId: PLAN_INSTANCE.id,
        idempotencyKey: `${PLAN_INSTANCE.id}:U10/1/fix`,
        handoff,
      }),
    );
    await h.store.put(
      record("run-else", { parentInstanceId: "ship_other_1", idempotencyKey: "ship_other_1:x", handoff }),
    );
    await h.store.put(
      record("run-bare", { parentInstanceId: PLAN_INSTANCE.id, idempotencyKey: `${PLAN_INSTANCE.id}:y` }),
    );
    const ended = (codingRunId: unknown) =>
      call(h, "unit-end", {
        parentInstanceId: PLAN_INSTANCE.id,
        unit: "U10",
        ending: { kind: "merged", report: "✅ Merged after 1 review round" },
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
        codingRunId,
      });
    for (const id of ["run-c0", "run-else", "run-bare", "run-missing", 42]) expect((await ended(id)).status).toBe(200);
    const bodies = (await h.github.getIssue("acme/api", issue.number)).comments.slice(1).map((c) => c.body);
    expect(bodies[0]).toBe(
      "**Plan runner — U10 ended `merged`** · https://github.com/acme/api/pull/7\n\n✅ Merged after 1 review round\n\n" +
        "**Handoff — U10** · pull request [#7](https://github.com/acme/api/pull/7)\n\n" +
        "### Deviations\n\n- one table → two tables — the row outgrew the record\n\n" +
        "### Unproven\n\n- the live receipt — needs staging\n\n" +
        "### Ledger rows\n\nPaste into the plan's follow-ups ledger while the plan is `proposed`; a person decides each disposition.\n\n" +
        "```markdown\n| Follow-up | Source | Disposition |\n|---|---|---|\n" +
        "| Deviation: one table → two tables — the row outgrew the record | U10 handoff ([#7](https://github.com/acme/api/pull/7)) | open |\n" +
        "| Unproven: the live receipt — needs staging | U10 handoff ([#7](https://github.com/acme/api/pull/7)) | open |\n```",
    );
    for (const body of bodies.slice(1))
      expect(body).toBe(
        "**Plan runner — U10 ended `merged`** · https://github.com/acme/api/pull/7\n\n✅ Merged after 1 review round",
      );
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
