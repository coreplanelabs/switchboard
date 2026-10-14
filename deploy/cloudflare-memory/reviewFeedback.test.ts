import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fetchMemoryTest } from "./testFetch.ts";
import type { RunHistoryDO } from "./worker.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";

const auth = { authorization: "Bearer test-token", "content-type": "application/json" };
async function post(path: string, body: unknown, authorized = true) {
  const raw = JSON.stringify(body);
  return fetchMemoryTest(
    `https://memory.example${path}`,
    {
      method: "POST",
      headers: {
        ...(authorized ? auth : { "content-type": "application/json" }),
        "content-length": String(new TextEncoder().encode(raw).byteLength),
      },
      body: raw,
    },
    async (res) => ({ status: res.status, data: (await res.json()) as Record<string, unknown> }),
  );
}
let sequence = 0;
async function seed() {
  const now = Date.now(),
    key = `runs:feedback-${now}-${sequence++}`,
    runId = "review-one",
    threadKey = "slack:C1:feedback";
  const receipt = {
    version: 1,
    runId,
    target: { repo: "acme/api", number: 7, commitId: "a".repeat(40) },
    bodyHash: "b".repeat(64),
    verdict: "request_changes",
    state: "accepted",
    feedback: { format: 1, findings: 1, at: now },
    nativeReview: {
      id: "42",
      nodeId: "PRR_one",
      url: "https://github.com/acme/api/pull/7#pullrequestreview-42",
      publishedAt: now,
    },
  };
  const claim = await post("/runs/claim", {
    storeKey: key,
    run: {
      runId,
      threadKey,
      gen: "g1",
      leaseMs: 30_000,
      startedAt: now,
      meta: { agent: "review", repo: "acme/api", pr: 7, channelId: "slack:C1", userId: "slack:U_fixture", threadKey },
      card: null,
      system: "review",
      tools: [],
    },
  });
  expect(claim.status).toBe(200);
  return { now, key, runId, threadKey, receipt };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
const state = (f: Fixture, receipt: unknown, gen = "g1") =>
  post("/runs/state", { storeKey: f.key, runId: f.runId, gen, state: { reviewPublication: receipt } });
const list = (f: Fixture) =>
  post("/runs/review-feedback/list", { storeKey: f.key, sinceMs: f.now - 1000, untilMs: f.now + 60_000 });
async function accept(f: Fixture) {
  expect((await state(f, { ...f.receipt, state: "pending", nativeReview: undefined })).data).toMatchObject({
    ok: true,
  });
  expect((await state(f, f.receipt)).data).toMatchObject({ ok: true });
}

describe("review feedback through the state Worker", () => {
  it("retains one owner-bound native receipt, survives ordinary record deletion, and never registers fabricated acceptance", async () => {
    const f = await seed();
    await state(f, f.receipt);
    expect((await list(f)).data.entries).toEqual([]);
    await state(f, { ...f.receipt, state: "pending", nativeReview: undefined });
    expect((await state(f, f.receipt, "another-owner")).data).toMatchObject({ ok: false, reason: "fenced" });
    expect((await list(f)).data.entries).toEqual([]);
    await accept(f);
    await state(f, f.receipt);
    expect((await list(f)).data.entries).toMatchObject([
      { publication: { runId: f.runId, repo: "acme/api", pr: 7, review: { id: "42" } } },
    ]);
    const record = {
      id: f.runId,
      label: "review",
      agent: "review",
      repo: "acme/api",
      targetPr: 7,
      reviewHead: "a".repeat(40),
      channelId: "slack:C1",
      userId: "slack:U_fixture",
      threadKey: f.threadKey,
      channelVisibility: "unknown",
      startedAt: f.now,
      finishedAt: f.now + 1,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: {
        eventCount: 0,
        toolCalls: 0,
        byCategory: Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, { count: 0, durationMs: 0 }])),
        findings: [],
        verdict: "no friction detected",
      },
    };
    expect((await post("/runs/finish", { storeKey: f.key, runId: f.runId, gen: "g1", record })).status).toBe(200);
    expect((await post("/runs/delete", { storeKey: f.key, id: f.runId })).data).toMatchObject({ deleted: true });
    expect((await list(f)).data.entries).toMatchObject([{ publication: { runId: f.runId, review: { id: "42" } } }]);
  });

  it("fences stale collection owners and preserves the previous complete votes after a failed read", async () => {
    const f = await seed();
    await accept(f);
    const claim = async () =>
      (
        (await post("/runs/review-feedback/claim", { storeKey: f.key, limit: 1 })).data.claims as {
          publication: { runId: string };
          lease: number;
        }[]
      )[0];
    const first = await claim();
    const finish = (lease: number, update: unknown) =>
      post("/runs/review-feedback/complete", { storeKey: f.key, runId: f.runId, lease, update });
    const vote = { id: "R_one", actorId: "U_one", actorType: "User", content: "up" };
    expect((await finish(first.lease, { status: "complete", checkedAt: f.now, votes: [vote] })).data).toEqual({
      ok: true,
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(f.key));
    await runInDurableObject(stub, (_inst: RunHistoryDO, ctx) =>
      ctx.storage.sql.exec("UPDATE review_feedback_publications SET checked_at=0,lease_until=0"),
    );
    const expired = await claim();
    await runInDurableObject(stub, (_inst: RunHistoryDO, ctx) =>
      ctx.storage.sql.exec("UPDATE review_feedback_publications SET lease_until=0"),
    );
    const replacement = await claim();
    expect((await finish(expired.lease, { status: "complete", checkedAt: f.now, votes: [] })).data).toEqual({
      ok: false,
    });
    expect((await finish(replacement.lease, { status: "unavailable", checkedAt: f.now })).data).toEqual({ ok: true });
    expect((await list(f)).data.entries).toMatchObject([{ snapshot: { status: "unavailable", votes: [vote] } }]);
    await runInDurableObject(stub, (_inst: RunHistoryDO, ctx) =>
      ctx.storage.sql.exec("UPDATE review_feedback_publications SET checked_at=0,lease_until=0"),
    );
    const removed = await claim();
    expect((await finish(removed.lease, { status: "complete", checkedAt: f.now, votes: [] })).data).toEqual({
      ok: true,
    });
    expect((await list(f)).data.entries).toMatchObject([{ snapshot: { status: "complete", votes: [] } }]);
  });

  it("requires the bearer and rejects malformed ranges, claims and snapshots", async () => {
    const f = await seed();
    expect(
      (await post("/runs/review-feedback/list", { storeKey: f.key, sinceMs: f.now, untilMs: f.now + 1 }, false)).status,
    ).toBe(401);
    for (const [path, body] of [
      ["list", { sinceMs: "bad", untilMs: f.now }],
      ["claim", { limit: 0 }],
      ["claim", { limit: 21 }],
      ["complete", { runId: f.runId, lease: 1, update: { status: "complete", checkedAt: f.now } }],
    ] as const)
      expect((await post(`/runs/review-feedback/${path}`, { storeKey: f.key, ...body })).status).toBe(400);
    await accept(f);
    expect((await post("/runs/review-feedback/cooldown", { storeKey: f.key, untilMs: f.now + 60_000 })).data).toEqual({
      ok: true,
    });
    expect((await post("/runs/review-feedback/claim", { storeKey: f.key, limit: 1 })).data).toEqual({ claims: [] });
  });
});
