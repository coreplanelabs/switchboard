import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import {
  InMemoryReviewFeedbackStore,
  reviewFeedbackPublicationOf,
  refreshReviewFeedback,
  ReviewFeedbackReadError,
} from "./reviewFeedback.js";

const now = 1_800_000_000_000;
const receipt = {
  version: 1,
  runId: "review-one",
  target: { repo: "acme/api", number: 7, commitId: "a".repeat(40) },
  bodyHash: "b".repeat(64),
  state: "accepted",
  verdict: "request_changes",
  feedback: { format: 1, findings: 1, at: now },
  nativeReview: {
    id: "42",
    nodeId: "PRR_one",
    url: "https://github.com/acme/api/pull/7#pullrequestreview-42",
    publishedAt: now,
  },
};

describe("exact review feedback storage", () => {
  it("retains feedback only through the original ledger owner's pending-to-accepted commit", async () => {
    const ledger = new InMemoryRunLedger(() => now);
    await ledger.claim({
      runId: receipt.runId,
      threadKey: "slack:C1:1",
      gen: "g1",
      leaseMs: 30_000,
      startedAt: now,
      meta: {
        agent: "review",
        channelId: "slack:C1",
        userId: "slack:U_fixture",
        threadKey: "slack:C1:1",
        repo: "acme/api",
        pr: 7,
      },
      card: null,
      system: "review",
      tools: [],
    });
    const pending = { ...receipt, state: "pending", nativeReview: undefined };
    expect(await ledger.setState(receipt.runId, "g1", { reviewPublication: pending })).toEqual({ ok: true });
    expect(await ledger.setState(receipt.runId, "wrong-owner", { reviewPublication: receipt })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect((await ledger.reviewFeedback.list(now - 1, now + 1)).entries).toEqual([]);
    expect(await ledger.setState(receipt.runId, "g1", { reviewPublication: receipt })).toEqual({ ok: true });
    expect((await ledger.reviewFeedback.list(now - 1, now + 1)).entries.map((r) => r.publication.review?.id)).toEqual([
      "42",
    ]);
    await ledger.setState(receipt.runId, "g1", { reviewPublication: receipt });
    expect((await ledger.reviewFeedback.list(now - 1, now + 1)).entries.map((r) => r.publication.runId)).toEqual([
      "review-one",
    ]);
  });
  it("registers accepted publications once and preserves publication identity without requiring optional feedback identity", async () => {
    const store = new InMemoryReviewFeedbackStore();
    const publication = reviewFeedbackPublicationOf(receipt)!;
    await store.retain(publication);
    await store.retain(publication);
    store.retain({ ...publication, runId: "duplicate-native-review" });
    const unknown = reviewFeedbackPublicationOf({ ...receipt, runId: "without-native", nativeReview: undefined })!;
    await store.retain(unknown);
    expect((await store.list(now - 1, now + 1)).entries.map((x) => x.publication.runId)).toEqual([
      "review-one",
      "without-native",
    ]);
    expect(reviewFeedbackPublicationOf({ ...receipt, state: "uncertain" })).toBeUndefined();
    expect(publication).toMatchObject({ runId: "review-one", repo: "acme/api", review: { nodeId: "PRR_one" } });
  });

  it("collects complete current votes, preserves them on a failed read, and resumes after shared backoff", async () => {
    let clock = now;
    const store = new InMemoryReviewFeedbackStore(() => clock);
    store.retain(reviewFeedbackPublicationOf(receipt)!);
    const votes = [{ id: "r1", actorType: "User" as const, actorId: "u1", content: "up" as const }];
    expect(await refreshReviewFeedback(store, { read: async () => votes }, { now: () => clock })).toBe(1);
    clock += 3_600_001;
    expect(
      await refreshReviewFeedback(
        store,
        {
          read: async () => {
            throw new ReviewFeedbackReadError("unavailable", clock + 4_000_000);
          },
        },
        { now: () => clock },
      ),
    ).toBe(1);
    expect((await store.list(now - 1, now + 1)).entries[0].snapshot).toEqual({
      status: "unavailable",
      checkedAt: clock,
      completedAt: now,
      votes,
    });
    clock += 3_600_001;
    expect(await refreshReviewFeedback(store, { read: async () => [] }, { now: () => clock })).toBe(0);
    clock += 400_000;
    expect(await refreshReviewFeedback(store, { read: async () => [] }, { now: () => clock })).toBe(1);
    expect((await store.list(now - 1, now + 1)).entries[0].snapshot).toEqual({
      status: "complete",
      checkedAt: clock,
      completedAt: clock,
      votes: [],
    });
  });

  it("replaces removed votes only after complete reads and fences expired or superseded collection leases", async () => {
    const store = new InMemoryReviewFeedbackStore();
    await store.retain(reviewFeedbackPublicationOf(receipt)!);
    const [first] = await store.claim(now, 1);
    expect(
      await store.complete(
        first,
        {
          status: "complete",
          checkedAt: now,
          votes: [{ id: "vote-1", actorId: "user-1", actorType: "User", content: "up" }],
        },
        now,
      ),
    ).toBe(true);
    expect((await store.list(now - 1, now + 1)).entries[0].snapshot?.votes).toEqual([
      { id: "vote-1", actorId: "user-1", actorType: "User", content: "up" },
    ]);
    const [expired] = await store.claim(now + 3_600_001, 1);
    const [replacement] = await store.claim(now + 3_900_002, 1);
    expect(
      await store.complete(expired, { status: "complete", checkedAt: now + 3_900_002, votes: [] }, now + 3_900_002),
    ).toBe(false);
    expect(
      await store.complete(replacement, { status: "unavailable", checkedAt: now + 3_900_002 }, now + 3_900_002),
    ).toBe(true);
    expect((await store.list(now - 1, now + 1)).entries[0].snapshot?.votes).toEqual([
      { id: "vote-1", actorId: "user-1", actorType: "User", content: "up" },
    ]);
    const [removed] = await store.claim(now + 7_500_003, 1);
    await store.complete(removed, { status: "complete", checkedAt: now + 7_500_003, votes: [] }, now + 7_500_003);
    expect((await store.list(now - 1, now + 1)).entries[0].snapshot?.votes).toEqual([]);
  });

  it("shares durable cooldown and includes open reviews independently of merged delivery data", async () => {
    const store = new InMemoryReviewFeedbackStore();
    await store.retain(reviewFeedbackPublicationOf(receipt)!);
    await store.cooldown(now + 30_000);
    expect(await store.claim(now, 1)).toEqual([]);
    const claimed = await store.claim(now + 30_001, 1);
    expect(claimed.map((x) => x.publication.pr)).toEqual([7]);
  });
});
