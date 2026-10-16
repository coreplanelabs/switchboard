import { describe, expect, it } from "vitest";
import { normalizeGithubActivity } from "./githubActivity.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";

const source = { host: "github.com", appId: 1, installationId: 2, repositoryId: 3 };
const user = { id: 4, login: "reviewer", type: "User" };
const comment = {
  id: 5,
  body: "This changes the retry limit.",
  html_url: "https://github.com/acme/api/pull/7#issuecomment-5",
  user,
  created_at: "2026-10-14T12:00:00Z",
  updated_at: "2026-10-14T12:00:00Z",
};
const payload = (event = "issue_comment", author = user) => ({
  action: event === "pull_request_review" ? "submitted" : "created",
  installation: { id: 2 },
  repository: { id: 3, full_name: "acme/api" },
  ...(event === "issue_comment" ? { issue: { number: 7, pull_request: {} } } : { pull_request: { number: 7 } }),
  ...(event === "pull_request_review"
    ? { review: { ...comment, user: author, state: "commented", submitted_at: comment.created_at } }
    : { comment: { ...comment, user: author } }),
});

describe("GitHub comment normalization", () => {
  it("keeps the verified source and delivery snapshot across asynchronous hashing", async () => {
    const binding = { ...source };
    const headers = { event: "issue_comment", delivery: "original" };
    const pending = normalizeGithubActivity(binding, headers, payload());
    binding.installationId = 99;
    binding.repositoryId = 100;
    headers.delivery = "later";
    expect(await pending).toMatchObject({
      kind: "normalized",
      event: {
        sourceId: "github:github.com:app:1:installation:2",
        deliveryId: "original",
        objectId: "github:github.com:repository:3:conversation:5",
        payload: { repository: { id: 3 } },
      },
    });
  });
  it("uses the existing source receipt for a duplicate delivery and holds changed content", async () => {
    const native = payload();
    const result = await normalizeGithubActivity(source, { event: "issue_comment", delivery: "one" }, native);
    if (result.kind !== "normalized") throw new Error("expected normalized source input");
    const ledger = new InMemoryRunLedger(() => 123);
    const first = await ledger.receiveSourceEvent(result.event);
    expect(first).toMatchObject({ kind: "received", receipt: { sequence: 1, receivedAt: 123 } });
    if (first.kind === "refused") throw new Error("expected saved source input");
    const reordered = await normalizeGithubActivity(
      source,
      { event: "issue_comment", delivery: "one" },
      Object.fromEntries(Object.entries(native).reverse()),
    );
    if (reordered.kind !== "normalized") throw new Error("expected reordered source input");
    expect(await ledger.receiveSourceEvent(reordered.event)).toEqual({ kind: "duplicate", receipt: first.receipt });
    const changed = await normalizeGithubActivity(
      source,
      { event: "issue_comment", delivery: "one" },
      { ...native, comment: { ...comment, body: "Changed body" } },
    );
    if (changed.kind !== "normalized") throw new Error("expected changed source input");
    expect(await ledger.receiveSourceEvent(changed.event)).toEqual({ kind: "refused", reason: "delivery-conflict" });
    expect(await ledger.readSourceEvent(first.receipt.key)).toMatchObject({
      event: { payload: { activity: { body: comment.body } } },
      job: { stage: "received", attempts: 0 },
    });
  });

  it("holds unsafe input without evaluating an accessor", async () => {
    let reads = 0;
    const native = { ...payload(), comment: { ...comment } };
    Object.defineProperty(native.comment, "body", {
      enumerable: true,
      get: () => {
        reads++;
        return "getter body";
      },
    });
    expect(await normalizeGithubActivity(source, { event: "issue_comment", delivery: "one" }, native)).toEqual({
      kind: "refused",
      reason: "invalid-event",
    });
    expect(reads).toBe(0);
  });
  it.each(["issue_comment", "pull_request_review_comment", "pull_request_review"])(
    "retains the same untrusted evidence contract for humans and bots on %s",
    async (event) => {
      const human = await normalizeGithubActivity(source, { event, delivery: "human-delivery" }, payload(event));
      const bot = await normalizeGithubActivity(
        source,
        { event, delivery: "bot-delivery" },
        payload(event, { ...user, type: "Bot" }),
      );
      expect(human).toMatchObject({
        kind: "normalized",
        event: {
          kind: "source-evidence",
          sourceId: "github:github.com:app:1:installation:2",
          authorId: "github:github.com:user:4",
          payload: {
            repository: { id: 3, fullName: "acme/api" },
            pullNumber: 7,
            activity: { body: comment.body, author: user },
          },
        },
      });
      expect(bot).toMatchObject({
        kind: "normalized",
        event: { kind: "source-evidence", payload: { activity: { author: { ...user, type: "Bot" } } } },
      });
    },
  );

  it("separates delivery identity from stable object revisions and preserves native inline metadata", async () => {
    const native = {
      ...payload("pull_request_review_comment"),
      comment: {
        ...comment,
        path: "src/retry.ts",
        in_reply_to_id: 9,
        pull_request_review_id: 10,
        line: null,
        original_line: 20,
        commit_id: "a".repeat(40),
        original_commit_id: "b".repeat(40),
      },
    };
    const a = await normalizeGithubActivity(source, { event: "pull_request_review_comment", delivery: "one" }, native);
    const b = await normalizeGithubActivity(source, { event: "pull_request_review_comment", delivery: "two" }, native);
    expect(a).toMatchObject({
      kind: "normalized",
      event: {
        objectId: "github:github.com:repository:3:inline:5",
        deliveryId: "one",
        payload: { activity: { replyToId: 9, reviewId: 10 }, native },
      },
    });
    if (a.kind !== "normalized" || b.kind !== "normalized") throw new Error("expected normalized evidence");
    expect(a.event.changeId).toMatch(/^[a-f0-9]{64}$/);
    expect(b.event.changeId).toBe(a.event.changeId);
    const reordered = await normalizeGithubActivity(
      source,
      { event: "pull_request_review_comment", delivery: "reordered" },
      { ...native, comment: Object.fromEntries(Object.entries(native.comment).reverse()) },
    );
    expect(reordered).toMatchObject({ kind: "normalized", event: { changeId: a.event.changeId } });
    const edited = await normalizeGithubActivity(
      source,
      { event: "pull_request_review_comment", delivery: "three" },
      { ...native, action: "edited", comment: { ...native.comment, body: "Changed at the same timestamp." } },
    );
    if (edited.kind !== "normalized") throw new Error("expected edited evidence");
    expect(edited.event.changeId).not.toBe(a.event.changeId);
    expect(edited.event.objectId).toBe(a.event.objectId);
  });

  it("retains deletions and review dismissals as evidence rather than a new requester action", async () => {
    const deleted = await normalizeGithubActivity(
      source,
      { event: "issue_comment", delivery: "deleted" },
      { ...payload(), action: "deleted" },
    );
    expect(deleted).toMatchObject({
      kind: "normalized",
      event: { kind: "source-evidence", payload: { activity: { state: "deleted", body: comment.body } } },
    });
    const dismissed = await normalizeGithubActivity(
      source,
      { event: "pull_request_review", delivery: "dismissed" },
      { ...payload("pull_request_review"), action: "dismissed" },
    );
    expect(dismissed).toMatchObject({
      kind: "normalized",
      event: { kind: "source-evidence", payload: { activity: { state: "dismissed" } } },
    });
    if (deleted.kind !== "normalized") throw new Error("expected deleted evidence");
    expect(Object.keys(deleted.event).sort()).toEqual([
      "authorId",
      "changeId",
      "deliveryId",
      "kind",
      "objectId",
      "payload",
      "sourceId",
      "version",
    ]);
  });

  it("retains null authors and returns a detached source record", async () => {
    const native = { ...payload(), comment: { ...comment, user: null } };
    const result = await normalizeGithubActivity(source, { event: "issue_comment", delivery: "one" }, native);
    native.comment.body = "Later mutation";
    expect(result).toMatchObject({
      kind: "normalized",
      event: {
        payload: { activity: { body: comment.body, author: null }, native: { comment: { body: comment.body } } },
      },
    });
  });

  it.each([
    { ...payload(), installation: { id: 99 } },
    { ...payload(), repository: { id: 99, full_name: "acme/api" } },
    { ...payload(), comment: { ...comment, id: 0 } },
    { ...payload(), comment: { ...comment, user: undefined } },
    { ...payload(), comment: { ...comment, html_url: "https://other.example/item" } },
    { ...payload(), comment: { ...comment, body: "x".repeat(400 * 1024) } },
  ])("holds malformed, foreign or oversized source input (%#)", async (native) => {
    expect(await normalizeGithubActivity(source, { event: "issue_comment", delivery: "one" }, native)).toMatchObject({
      kind: "refused",
    });
  });

  it("ignores ordinary issue comments and unsupported activity without selecting a task", async () => {
    expect(
      await normalizeGithubActivity(
        source,
        { event: "issue_comment", delivery: "one" },
        { ...payload(), issue: { number: 7 } },
      ),
    ).toEqual({ kind: "ignored", reason: "not-pull-request" });
    expect(await normalizeGithubActivity(source, { event: "push", delivery: "two" }, {})).toEqual({
      kind: "ignored",
      reason: "event",
    });
  });
});
