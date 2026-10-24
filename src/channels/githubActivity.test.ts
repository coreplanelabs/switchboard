import { describe, expect, it } from "vitest";
import { githubActivityTaskMatch, normalizeGithubActivity } from "./githubActivity.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import type { GithubPullSourceContext } from "../execution/githubReadSource.js";
import type { SourceEventRecord } from "../core/runLedger/sourceEvents.js";

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
  it("supplies common text for human and bot comments across every PR comment surface", async () => {
    const contents: unknown[] = [];
    for (const event of ["issue_comment", "pull_request_review_comment", "pull_request_review"]) {
      for (const type of ["User", "Bot"]) {
        const normalized = await normalizeGithubActivity(
          source,
          { event, delivery: `${event}-${type}` },
          payload(event, { ...user, type }),
        );
        expect(normalized.kind).toBe("normalized");
        if (normalized.kind !== "normalized") throw new Error("Expected comment normalization");
        expect(normalized.event.version).toBe(2);
        const content = normalized.event.content;
        if (!content || content.kind !== "text") throw new Error("Expected common text");
        contents.push({ kind: content.kind, state: content.state, text: content.text });
        expect(normalized.event.payload).not.toHaveProperty("activity");
        expect(normalized.event.content).not.toHaveProperty("metadata.body");
      }
    }
    expect(contents).toEqual(
      Array.from({ length: 6 }, () => ({ kind: "text", state: "present", text: "This changes the retry limit." })),
    );
  });

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
      event: { content: { kind: "text", state: "present", text: comment.body } },
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
          content: {
            kind: "text",
            state: "present",
            text: comment.body,
            metadata: {
              author: user,
            },
          },
          payload: {
            repository: { id: 3, fullName: "acme/api" },
            pullNumber: 7,
          },
        },
      });
      expect(bot).toMatchObject({
        kind: "normalized",
        event: {
          kind: "source-evidence",
          content: {
            kind: "text",
            state: "present",
            metadata: {
              author: { ...user, type: "Bot" },
            },
          },
        },
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
        content: {
          kind: "text",
          state: "present",
          metadata: {
            replyToId: 9,
            reviewId: 10,
            location: {
              path: "src/retry.ts",
              commitSha: "a".repeat(40),
              originalCommitSha: "b".repeat(40),
              line: null,
              originalLine: 20,
            },
          },
        },
        payload: { native },
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
      event: {
        kind: "source-evidence",
        content: {
          kind: "text",
          state: "deleted",
          text: comment.body,
        },
      },
    });
    const dismissed = await normalizeGithubActivity(
      source,
      { event: "pull_request_review", delivery: "dismissed" },
      { ...payload("pull_request_review"), action: "dismissed" },
    );
    expect(dismissed).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-evidence",
        content: {
          kind: "text",
          state: "withdrawn",
          text: comment.body,
        },
      },
    });
    if (deleted.kind !== "normalized") throw new Error("expected deleted evidence");
    expect(Object.keys(deleted.event).sort()).toEqual([
      "authorId",
      "changeId",
      "content",
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
        content: {
          kind: "text",
          state: "present",
          text: comment.body,
          metadata: {
            author: null,
          },
        },
        payload: { native: { comment: { body: comment.body } } },
      },
    });
  });

  it("retains unavailable source text without inventing a body", async () => {
    expect(
      await normalizeGithubActivity(
        source,
        { event: "issue_comment", delivery: "unknown-body" },
        {
          ...payload(),
          comment: { ...comment, body: null },
        },
      ),
    ).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-evidence",
        content: { kind: "text", state: "present", text: null },
        payload: { native: { comment: { body: null } } },
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
    expect(await normalizeGithubActivity(source, { event: "workflow_run", delivery: "two" }, {})).toEqual({
      kind: "ignored",
      reason: "event",
    });
  });
});

const pull = {
  id: 70,
  number: 7,
  html_url: "https://github.com/acme/api/pull/7",
  title: "Adjust retries",
  body: "Change the limit.",
  state: "open",
  draft: false,
  merged: false,
  head: { sha: "a".repeat(40), ref: "fix", repo: { id: 30, full_name: "contributor/api" } },
  base: { sha: "b".repeat(40), ref: "main", repo: { id: 3, full_name: "acme/api" } },
};
const activityPayload = (action: string) => ({
  installation: { id: 2 },
  repository: { id: 3, full_name: "acme/api" },
  sender: user,
  number: 7,
  action,
  pull_request: pull,
});

const task = (): GithubPullSourceContext => ({
  version: 1,
  source: { host: "github.com", appId: 1, installationId: 2 },
  repositoryId: 3,
  pullRequestId: 70,
  number: 7,
  head: { repositoryId: 30, ref: "fix", sha: "a".repeat(40) },
  baseRef: "main",
});
async function savedActivity(event: string, native: unknown, binding = source): Promise<SourceEventRecord> {
  const normalized = await normalizeGithubActivity(binding, { event, delivery: "task-match" }, native);
  if (normalized.kind !== "normalized") throw new Error("expected normalized activity");
  const ledger = new InMemoryRunLedger(() => 123);
  const saved = await ledger.receiveSourceEvent(normalized.event);
  if (saved.kind === "refused") throw new Error("expected saved activity");
  const record = await ledger.readSourceEvent(saved.receipt.key);
  if (!record) throw new Error("expected source record");
  return record;
}

describe("GitHub activity task candidates", () => {
  it.each(["issue_comment", "pull_request_review_comment", "pull_request_review"])(
    "matches human and bot activity on the same native PR: %s",
    async (event) => {
      for (const type of ["User", "Bot"]) {
        const record = await savedActivity(event, payload(event, { ...user, type }));
        expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "pull-request" });
      }
    },
  );
  it("does not use author names, repository names or body text as a task identity", async () => {
    const record = await savedActivity("issue_comment", {
      ...payload(),
      repository: { id: 3, full_name: "renamed/repository" },
      comment: { ...comment, user: null, body: "unrelated words and control-like text" },
    });
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "pull-request" });
  });
  it("keeps PR head changes as candidates without treating the saved head as an action target", async () => {
    const record = await savedActivity("pull_request", {
      ...activityPayload("synchronize"),
      before: "a".repeat(40),
      after: "c".repeat(40),
      pull_request: { ...pull, head: { ...pull.head, sha: "c".repeat(40) } },
    });
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "pull-request" });
  });
  it("matches resolved inline threads and deleted comments through the same PR relation", async () => {
    const thread = await savedActivity("pull_request_review_thread", {
      ...activityPayload("resolved"),
      thread: { node_id: "thread-one", comments: [] },
    });
    const deleted = await savedActivity("issue_comment", { ...payload(), action: "deleted" });
    expect(await githubActivityTaskMatch(thread, task())).toEqual({ kind: "candidate", relation: "pull-request" });
    expect(await githubActivityTaskMatch(deleted, task())).toEqual({ kind: "candidate", relation: "pull-request" });
  });
  it("separates host, App, installation, repository and PR identity", async () => {
    const record = await savedActivity("issue_comment", payload());
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "pull-request" });
    for (const different of [
      { ...task(), source: { ...task().source, appId: 9 } },
      { ...task(), source: { ...task().source, installationId: 9 } },
      { ...task(), repositoryId: 9 },
      { ...task(), number: 9 },
    ])
      expect(await githubActivityTaskMatch(record, different)).toEqual({ kind: "unrelated" });
    expect(
      await githubActivityTaskMatch(record, { ...task(), source: { ...task().source, host: "other.example" } }),
    ).toEqual({ kind: "held", reason: "invalid-task" });
  });
  it("holds a conflicting native PR ID instead of trusting its number alone", async () => {
    const record = await savedActivity("pull_request", {
      ...activityPayload("edited"),
      pull_request: { ...pull, id: 71 },
    });
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "held", reason: "identity-conflict" });
    const sameId = await savedActivity("pull_request", {
      ...activityPayload("edited"),
      number: 8,
      pull_request: { ...pull, number: 8 },
    });
    expect(await githubActivityTaskMatch(sameId, task())).toEqual({ kind: "held", reason: "identity-conflict" });
    const other = await savedActivity("pull_request", {
      ...activityPayload("edited"),
      number: 8,
      pull_request: { ...pull, id: 71, number: 8 },
    });
    expect(await githubActivityTaskMatch(other, task())).toEqual({ kind: "unrelated" });
  });
  it("holds altered receipts and missing task identity without guessing from names", async () => {
    const record = await savedActivity("issue_comment", payload());
    expect(await githubActivityTaskMatch(record, undefined)).toEqual({ kind: "held", reason: "invalid-task" });
    record.event.payload = { changed: true };
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "held", reason: "invalid-record" });
  });
  it("holds unsupported commit and ref relationships instead of reporting them unrelated", async () => {
    const commit = await savedActivity("commit_comment", {
      ...payload("commit_comment"),
      comment: { ...comment, commit_id: "a".repeat(40) },
    });
    const ref = await savedActivity("delete", {
      installation: { id: 2 },
      repository: { id: 3, full_name: "acme/api" },
      sender: user,
      ref: "fix",
      ref_type: "branch",
    });
    expect(await githubActivityTaskMatch(commit, task())).toEqual({ kind: "held", reason: "unsupported-relationship" });
    expect(await githubActivityTaskMatch(ref, task())).toEqual({ kind: "held", reason: "unsupported-relationship" });
  });
  it("checks native identity even when a changed normalized wrapper has a consistent receipt", async () => {
    const normalized = await normalizeGithubActivity(
      source,
      { event: "issue_comment", delivery: "changed" },
      payload(),
    );
    if (normalized.kind !== "normalized") throw new Error("expected normalized activity");
    const ledger = new InMemoryRunLedger(() => 123);
    const event = { ...normalized.event, payload: { ...(normalized.event.payload as object), pullNumber: 9 } };
    const saved = await ledger.receiveSourceEvent(event);
    if (saved.kind === "refused") throw new Error("expected generic event storage");
    const record = await ledger.readSourceEvent(saved.receipt.key);
    expect(await githubActivityTaskMatch(record, { ...task(), number: 9 })).toEqual({
      kind: "held",
      reason: "identity-conflict",
    });
  });
  it("captures the source record and task before asynchronous receipt validation", async () => {
    const record = await savedActivity("issue_comment", payload());
    const context = task();
    const pending = githubActivityTaskMatch(record, context);
    context.number = 9;
    record.receipt.sequence = 99;
    record.event.sourceId = "github:github.com:app:9:installation:9";
    expect(await pending).toEqual({ kind: "candidate", relation: "pull-request" });
  });
  it("holds legacy content and requester events without upgrading either", async () => {
    const record = await savedActivity("issue_comment", payload());
    const { content: _content, ...fields } = record.event;
    for (const event of [
      { ...fields, version: 1 },
      { ...record.event, kind: "request" },
    ]) {
      const ledger = new InMemoryRunLedger(() => 123);
      const saved = await ledger.receiveSourceEvent(event);
      if (saved.kind === "refused") throw new Error("expected valid generic source envelope");
      expect(await githubActivityTaskMatch(await ledger.readSourceEvent(saved.receipt.key), task())).toEqual({
        kind: "held",
        reason: "unsupported-relationship",
      });
    }
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "pull-request" });
  });
  it("holds unsafe input without invoking accessors", async () => {
    const record = await savedActivity("issue_comment", payload());
    let reads = 0;
    const unsafe = Object.defineProperty({}, "task", {
      enumerable: true,
      get: () => {
        reads++;
        return task();
      },
    });
    expect(await githubActivityTaskMatch(record, unsafe)).toEqual({ kind: "held", reason: "invalid-record" });
    expect(reads).toBe(0);
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "pull-request" });
  });
});

describe("GitHub pull and commit activity normalization", () => {
  it("retains commit comments without inventing a PR or requester", async () => {
    const native = {
      installation: { id: 2 },
      repository: { id: 3, full_name: "acme/api" },
      action: "created",
      comment: {
        ...comment,
        commit_id: "c".repeat(40),
        html_url: "https://github.com/acme/api/commit/cccc#commitcomment-5",
      },
    };
    const result = await normalizeGithubActivity(source, { event: "commit_comment", delivery: "commit-one" }, native);
    expect(result).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-evidence",
        objectId: "github:github.com:repository:3:commit:5",
        content: {
          kind: "text",
          state: "present",
          text: comment.body,
          metadata: {
            surface: "commit",
            commitSha: "c".repeat(40),
            author: user,
          },
        },
        payload: {
          native,
        },
      },
    });
    if (result.kind !== "normalized") throw new Error("expected commit evidence");
    expect(result.event.payload).not.toHaveProperty("pullNumber");
    expect(result.event).not.toHaveProperty("requesterId");
    expect(
      await normalizeGithubActivity(
        source,
        { event: "commit_comment", delivery: "edit" },
        { ...native, action: "edited" },
      ),
    ).toEqual({ kind: "ignored", reason: "action" });
  });

  it("keeps fork head, base and before/after identities on synchronization facts", async () => {
    const native = { ...activityPayload("synchronize"), before: "d".repeat(40), after: pull.head.sha };
    const result = await normalizeGithubActivity(source, { event: "pull_request", delivery: "sync" }, native);
    expect(result).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        objectId: "github:github.com:repository:3:pull-request:70",
        content: {
          kind: "facts",
          facts: {
            surface: "pull-request",
            action: "synchronize",
            state: "open",
            head: { repositoryId: 30, ref: "fix", sha: pull.head.sha },
            base: { repositoryId: 3, ref: "main", sha: pull.base.sha },
            before: "d".repeat(40),
            after: pull.head.sha,
          },
        },
        payload: {
          pullNumber: 7,
          native,
        },
      },
    });
    expect(
      await normalizeGithubActivity(
        source,
        { event: "pull_request", delivery: "bad" },
        { ...native, after: "e".repeat(40) },
      ),
    ).toEqual({ kind: "refused", reason: "invalid-payload" });
  });

  it.each(["opened", "edited", "reopened", "closed", "converted_to_draft", "ready_for_review"])(
    "retains the snapshot and action for %s without selecting a worker",
    async (action) => {
      const native = {
        ...activityPayload(action),
        pull_request: {
          ...pull,
          state: action === "closed" ? "closed" : "open",
          draft: action === "converted_to_draft",
        },
      };
      const result = await normalizeGithubActivity(source, { event: "pull_request", delivery: action }, native);
      expect(result).toMatchObject({
        kind: "normalized",
        event: {
          kind: "source-fact",
          content: {
            kind: "facts",
            facts: {
              action,
              title: "Adjust retries",
              body: "Change the limit.",
              draft: action === "converted_to_draft",
              merged: false,
            },
          },
          payload: {
            native,
          },
        },
      });
    },
  );

  it("distinguishes a same-head edit while keeping redelivery and key order stable", async () => {
    const native = activityPayload("edited");
    const a = await normalizeGithubActivity(source, { event: "pull_request", delivery: "first" }, native);
    const b = await normalizeGithubActivity(
      source,
      { event: "pull_request", delivery: "again" },
      Object.fromEntries(Object.entries(native).reverse()),
    );
    const c = await normalizeGithubActivity(
      source,
      { event: "pull_request", delivery: "change" },
      { ...native, changes: { title: { from: "Old title" } }, pull_request: { ...pull, title: "Another title" } },
    );
    if (a.kind !== "normalized" || b.kind !== "normalized" || c.kind !== "normalized")
      throw new Error("expected PR facts");
    expect(a.event.changeId).toMatch(/^[a-f0-9]{64}$/);
    expect(b.event.changeId).toBe(a.event.changeId);
    expect(c.event.changeId).not.toBe(a.event.changeId);
    expect(c.event.objectId).toBe(a.event.objectId);
  });

  it("uses the native thread node ID and keeps resolution separate from comment evidence", async () => {
    const native = { ...activityPayload("resolved"), thread: { node_id: "PRRT_example", comments: [comment] } };
    const resolved = await normalizeGithubActivity(
      source,
      { event: "pull_request_review_thread", delivery: "resolve" },
      native,
    );
    const reopened = await normalizeGithubActivity(
      source,
      { event: "pull_request_review_thread", delivery: "unresolve" },
      { ...native, action: "unresolved" },
    );
    expect(resolved).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        objectId: "github:github.com:repository:3:thread:PRRT_example",
        content: { kind: "facts", facts: { surface: "thread", nodeId: "PRRT_example", state: "resolved" } },
        payload: { pullNumber: 7, native },
      },
    });
    if (resolved.kind !== "normalized" || reopened.kind !== "normalized") throw new Error("expected thread facts");
    expect(reopened.event.changeId).not.toBe(resolved.event.changeId);
    expect(reopened.event.objectId).toBe(resolved.event.objectId);
  });

  it.each([{ toString: null }, ["open"]])("holds malformed PR lifecycle states (%#)", async (state) => {
    const result = await normalizeGithubActivity(
      source,
      { event: "pull_request", delivery: "malformed-state" },
      {
        ...activityPayload("opened"),
        pull_request: { ...pull, state },
      },
    );
    expect(result).toEqual({ kind: "refused", reason: "invalid-payload" });
  });

  it("holds malformed branch identities and source data on the shared boundary", async () => {
    for (const native of [
      { ...activityPayload("opened"), number: 8 },
      { ...activityPayload("opened"), installation: { id: 99 } },
      { ...activityPayload("opened"), pull_request: { ...pull, head: { ...pull.head, sha: "not-a-sha" } } },
    ]) {
      expect(await normalizeGithubActivity(source, { event: "pull_request", delivery: "bad" }, native)).toMatchObject({
        kind: "refused",
      });
    }
  });

  it("retains a deleted fork and unknown actor without inventing identities", async () => {
    const result = await normalizeGithubActivity(
      source,
      { event: "pull_request", delivery: "deleted-fork" },
      {
        ...activityPayload("closed"),
        sender: null,
        pull_request: { ...pull, state: "closed", head: { ...pull.head, repo: null } },
      },
    );
    expect(result).toMatchObject({
      kind: "normalized",
      event: {
        content: {
          kind: "facts",
          facts: { actor: null, state: "closed", head: { repositoryId: null, ref: "fix", sha: "a".repeat(40) } },
        },
      },
    });
    if (result.kind !== "normalized") throw new Error("expected source fact");
    expect(result.event).not.toHaveProperty("authorId");
  });
});

const check = {
  id: 90,
  head_sha: "c".repeat(40),
  head_branch: null,
  name: "build",
  status: "completed",
  conclusion: "failure",
  app: { id: 91 },
  pull_requests: [{ id: 70, number: 7, head: pull.head, base: pull.base }],
};
const checkPayload = (surface: "check_run" | "check_suite", action = "completed") => ({
  installation: { id: 2 },
  repository: { id: 3, full_name: "acme/api" },
  sender: user,
  action,
  [surface]: check,
});
const statusPayload = () => ({
  installation: { id: 2 },
  repository: { id: 3, full_name: "acme/api" },
  sender: null,
  id: 92,
  sha: "c".repeat(40),
  context: "external/build",
  state: "failure",
  description: "Build failed",
  target_url: "https://ci.example/build/92",
});

describe("GitHub fact task candidates", () => {
  const localTask = (): GithubPullSourceContext => ({ ...task(), head: { ...task().head, repositoryId: 3 } });
  const refPayload = (ref = "refs/heads/fix") => ({
    installation: { id: 2 },
    repository: { id: 3, full_name: "acme/api" },
    sender: user,
    ref,
    before: "a".repeat(40),
    after: "b".repeat(40),
    created: false,
    deleted: false,
    forced: true,
  });
  const installationPayload = (action = "suspend") => ({
    action,
    installation: { id: 2, app_id: 1, repository_selection: "selected", permissions: { contents: "read" } },
  });

  it("matches exact saved head and base branch refs without selecting a new head", async () => {
    for (const ref of ["fix", "main"]) {
      const push = await savedActivity("push", refPayload(`refs/heads/${ref}`));
      const deleted = await savedActivity("delete", { ...refPayload(), ref, ref_type: "branch" });
      expect(await githubActivityTaskMatch(push, localTask())).toEqual({ kind: "candidate", relation: "ref" });
      expect(await githubActivityTaskMatch(deleted, localTask())).toEqual({ kind: "candidate", relation: "ref" });
    }
    const unknownHead = await savedActivity("push", { ...refPayload(), after: "c".repeat(40) });
    expect(await githubActivityTaskMatch(unknownHead, localTask())).toEqual({ kind: "candidate", relation: "ref" });
  });

  it("holds tags, unknown branches and fork refs without stripping literal prefixes", async () => {
    for (const ref of ["refs/tags/fix", "refs/heads/other", "refs/heads/refs/heads/fix"]) {
      const record = await savedActivity("push", refPayload(ref));
      expect(await githubActivityTaskMatch(record, localTask())).toEqual({
        kind: "held",
        reason: "unsupported-relationship",
      });
    }
    const head = await savedActivity("push", refPayload());
    expect(await githubActivityTaskMatch(head, task())).toEqual({ kind: "held", reason: "unsupported-relationship" });
    const literal = await savedActivity("delete", { ...refPayload(), ref: "refs/heads/fix", ref_type: "branch" });
    expect(
      await githubActivityTaskMatch(literal, { ...localTask(), head: { ...localTask().head, ref: "refs/heads/fix" } }),
    ).toEqual({ kind: "candidate", relation: "ref" });
  });

  it.each(["check_run", "check_suite", "status"] as const)(
    "matches %s only to the exact saved head commit in its repository",
    async (event) => {
      const native =
        event === "status"
          ? { ...statusPayload(), sha: "a".repeat(40) }
          : {
              ...checkPayload(event),
              [event]: { ...check, head_sha: "a".repeat(40), pull_requests: [] },
            };
      const record = await savedActivity(event, native);
      expect(await githubActivityTaskMatch(record, localTask())).toEqual({
        kind: "candidate",
        relation: "head-commit",
      });
      expect(await githubActivityTaskMatch(record, task())).toEqual({
        kind: "held",
        reason: "unsupported-relationship",
      });
      const advanced = { ...localTask(), head: { ...localTask().head, sha: "b".repeat(40) } };
      expect(await githubActivityTaskMatch(record, advanced)).toEqual({
        kind: "held",
        reason: "unsupported-relationship",
      });
    },
  );

  it("does not infer the checked commit or task membership from check PR associations", async () => {
    const stale = await savedActivity("check_run", checkPayload("check_run"));
    expect(await githubActivityTaskMatch(stale, localTask())).toEqual({
      kind: "held",
      reason: "unsupported-relationship",
    });
    const checked = await savedActivity("check_run", {
      ...checkPayload("check_run"),
      check_run: {
        ...check,
        head_sha: "a".repeat(40),
        pull_requests: [{ id: 80, number: 8, head: { ...pull.head, sha: "b".repeat(40) }, base: pull.base }],
      },
    });
    expect(await githubActivityTaskMatch(checked, localTask())).toEqual({ kind: "candidate", relation: "head-commit" });
    const conflict = await savedActivity("check_run", {
      ...checkPayload("check_run"),
      check_run: {
        ...check,
        head_sha: "a".repeat(40),
        pull_requests: [{ ...check.pull_requests[0], id: 71 }],
      },
    });
    expect(await githubActivityTaskMatch(conflict, localTask())).toEqual({ kind: "held", reason: "identity-conflict" });
  });

  it("matches repository lifecycle by saved native ID despite a rename and refuses another source", async () => {
    const record = await savedActivity("repository", {
      installation: { id: 2 },
      action: "renamed",
      repository: {
        id: 3,
        full_name: "renamed/api",
        private: true,
        archived: false,
      },
    });
    expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "repository" });
    expect(await githubActivityTaskMatch(record, { ...task(), repositoryId: 9 })).toEqual({ kind: "unrelated" });
    expect(
      await githubActivityTaskMatch(record, { ...task(), source: { ...task().source, installationId: 9 } }),
    ).toEqual({ kind: "unrelated" });
  });

  it("matches installation identity without treating repository selections as access inventory", async () => {
    for (const repositories of [undefined, [], [{ id: 9 }]]) {
      const record = await savedActivity("installation", {
        ...installationPayload(),
        ...(repositories === undefined ? {} : { repositories }),
      });
      expect(await githubActivityTaskMatch(record, task())).toEqual({ kind: "candidate", relation: "installation" });
      expect(await githubActivityTaskMatch(record, { ...task(), source: { ...task().source, appId: 9 } })).toEqual({
        kind: "unrelated",
      });
    }
    const selection = await savedActivity("installation_repositories", {
      ...installationPayload("removed"),
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [],
    });
    expect(await githubActivityTaskMatch(selection, task())).toEqual({ kind: "candidate", relation: "installation" });
  });

  it("holds altered fact wrappers and conflicting native identity even with valid generic receipts", async () => {
    const checkRecord = await savedActivity("status", statusPayload());
    const repositoryRecord = await savedActivity("repository", {
      installation: { id: 2 },
      action: "archived",
      repository: { id: 3, full_name: "acme/api", private: false, archived: true },
    });
    const installationRecord = await savedActivity("installation", installationPayload());
    const events = [
      { ...checkRecord.event, content: { kind: "facts", facts: { surface: "status", commitSha: "a".repeat(40) } } },
      { ...repositoryRecord.event, objectId: "github:github.com:repository:3:repository:3" },
      {
        ...installationRecord.event,
        payload: {
          ...(installationRecord.event.payload as object),
          native: { ...installationPayload(), installation: { ...installationPayload().installation, app_id: 9 } },
        },
      },
    ];
    for (const event of events) {
      const ledger = new InMemoryRunLedger(() => 123);
      const saved = await ledger.receiveSourceEvent(event);
      if (saved.kind === "refused") throw new Error("expected generic receipt");
      expect(await githubActivityTaskMatch(await ledger.readSourceEvent(saved.receipt.key), localTask())).toEqual({
        kind: "held",
        reason: "identity-conflict",
      });
    }
    expect(await githubActivityTaskMatch(repositoryRecord, task())).toEqual({
      kind: "candidate",
      relation: "repository",
    });
  });
});

describe("GitHub repository activity normalization", () => {
  const repository = {
    id: 3,
    full_name: "acme/api",
    private: true,
    archived: false,
    visibility: "private",
    default_branch: "main",
  };
  const native = {
    action: "edited",
    installation: { id: 2 },
    repository,
    sender: user,
    changes: { default_branch: { from: "old-main" } },
  };

  it.each([
    "created",
    "edited",
    "deleted",
    "renamed",
    "transferred",
    "archived",
    "unarchived",
    "privatized",
    "publicized",
  ])("retains %s as a repository fact without a PR or access grant", async (action) => {
    const payload = {
      ...native,
      action,
      repository: {
        ...repository,
        archived: action === "archived",
        private: action !== "publicized",
        visibility: action === "publicized" ? "public" : "private",
      },
    };
    const result = await normalizeGithubActivity(source, { event: "repository", delivery: action }, payload);
    expect(result).toMatchObject({
      kind: "normalized",
      event: {
        version: 2,
        kind: "source-fact",
        objectId: "github:github.com:repository:3",
        authorId: "github:github.com:user:4",
        content: {
          kind: "facts",
          facts: {
            surface: "repository",
            id: 3,
            action,
            private: action !== "publicized",
            archived: action === "archived",
            visibility: action === "publicized" ? "public" : "private",
            defaultBranch: "main",
            changes: native.changes,
            actor: user,
          },
        },
        payload: {
          repository: { id: 3, fullName: "acme/api" },
          native: payload,
        },
      },
    });
    if (result.kind !== "normalized") throw new Error("expected repository fact");
    expect(Object.keys(result.event.payload as object).sort()).toEqual(["native", "repository", "version"]);
  });

  it("keeps native identity through rename and transfer and rejects a name reused by another repository", async () => {
    const first = await normalizeGithubActivity(source, { event: "repository", delivery: "one" }, native);
    const renamed = await normalizeGithubActivity(
      source,
      { event: "repository", delivery: "two" },
      {
        ...native,
        action: "renamed",
        repository: { ...repository, full_name: "acme/new-api" },
        changes: { repository: { name: { from: "api" } } },
      },
    );
    const moved = await normalizeGithubActivity(
      source,
      { event: "repository", delivery: "three" },
      {
        ...native,
        action: "transferred",
        repository: { ...repository, full_name: "new-owner/new-api" },
        changes: { owner: { from: { user: { id: 9, login: "acme" } } } },
      },
    );
    if (first.kind !== "normalized" || renamed.kind !== "normalized" || moved.kind !== "normalized")
      throw new Error("expected repository facts");
    expect(first.event.objectId).toBe("github:github.com:repository:3");
    expect(renamed.event.objectId).toBe(first.event.objectId);
    expect(moved.event.objectId).toBe(first.event.objectId);
    expect(moved.event.payload).toMatchObject({ repository: { id: 3, fullName: "new-owner/new-api" } });
    expect(
      await normalizeGithubActivity(
        source,
        { event: "repository", delivery: "reuse" },
        { ...native, repository: { ...repository, id: 99 } },
      ),
    ).toEqual({ kind: "refused", reason: "source-mismatch" });
  });

  it("freezes native snapshots and separates metadata changes from delivery identity", async () => {
    const payload = structuredClone(native);
    const pending = normalizeGithubActivity(source, { event: "repository", delivery: "one" }, payload);
    payload.repository.full_name = "later/change";
    const first = await pending;
    const again = await normalizeGithubActivity(source, { event: "repository", delivery: "two" }, native);
    const changed = await normalizeGithubActivity(
      source,
      { event: "repository", delivery: "three" },
      { ...native, repository: { ...repository, default_branch: "next-main" } },
    );
    if (first.kind !== "normalized" || again.kind !== "normalized" || changed.kind !== "normalized")
      throw new Error("expected repository facts");
    expect(first.event).toMatchObject({
      deliveryId: "one",
      content: { kind: "facts", facts: { defaultBranch: "main" } },
      payload: { repository: { fullName: "acme/api" } },
    });
    expect(first.event.changeId).toMatch(/^[a-f0-9]{64}$/);
    expect(again.event.changeId).toBe(first.event.changeId);
    expect(changed.event.changeId).not.toBe(first.event.changeId);
  });

  it("keeps unknown metadata and actor identity as source data", async () => {
    const payload = {
      ...native,
      sender: null,
      repository: { id: 3, full_name: "acme/api", private: true, archived: false },
    };
    expect(await normalizeGithubActivity(source, { event: "repository", delivery: "unknown" }, payload)).toMatchObject({
      kind: "normalized",
      event: { content: { kind: "facts", facts: { defaultBranch: null, visibility: null, actor: null } } },
    });
    expect(
      await normalizeGithubActivity(
        source,
        { event: "repository", delivery: "bot" },
        { ...native, sender: { ...user, type: "Bot" } },
      ),
    ).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        authorId: "github:github.com:user:4",
        content: { kind: "facts", facts: { actor: { type: "Bot" } } },
      },
    });
  });

  it("holds malformed or contradictory state and ignores unsupported actions", async () => {
    expect(await normalizeGithubActivity(source, { event: "repository", delivery: "valid" }, native)).toMatchObject({
      kind: "normalized",
    });
    for (const payload of [
      { ...native, action: "archived" },
      { ...native, action: "publicized" },
      { ...native, repository: { ...repository, private: "true" } },
      { ...native, repository: { ...repository, archived: null } },
      { ...native, repository: { ...repository, default_branch: {} } },
      { ...native, repository: { ...repository, visibility: [] } },
      { ...native, installation: { id: 99 } },
    ]) {
      expect(await normalizeGithubActivity(source, { event: "repository", delivery: "bad" }, payload)).toMatchObject({
        kind: "refused",
      });
    }
    expect(
      await normalizeGithubActivity(
        source,
        { event: "repository", delivery: "future" },
        { ...native, action: "future" },
      ),
    ).toEqual({ kind: "ignored", reason: "action" });
  });
});

describe("GitHub check and status normalization", () => {
  it.each(["check_run", "check_suite"] as const)(
    "keeps %s commit facts separate from stale PR associations",
    async (surface) => {
      const native = checkPayload(surface);
      const result = await normalizeGithubActivity(source, { event: surface, delivery: "check" }, native);
      expect(result).toMatchObject({
        kind: "normalized",
        event: {
          kind: "source-fact",
          objectId: `github:github.com:repository:3:${surface}:90`,
          content: {
            kind: "facts",
            facts: {
              surface,
              action: "completed",
              id: 90,
              commitSha: "c".repeat(40),
              status: "completed",
              conclusion: "failure",
              appId: 91,
              pullRequests: [{ id: 70, number: 7, head: { sha: "a".repeat(40), repositoryId: 30 } }],
            },
          },
          payload: {
            native,
          },
        },
      });
      if (result.kind !== "normalized") throw new Error("expected check fact");
      expect(result.event.payload).not.toHaveProperty("pullNumber");
    },
  );

  it("keeps a fork check with no PR association and no actor", async () => {
    const native = checkPayload("check_suite", "requested");
    const result = await normalizeGithubActivity(
      source,
      { event: "check_suite", delivery: "fork" },
      {
        ...native,
        sender: null,
        check_suite: { ...check, status: null, conclusion: null, pull_requests: [] },
      },
    );
    expect(result).toMatchObject({
      kind: "normalized",
      event: { content: { kind: "facts", facts: { actor: null, status: null, conclusion: null, pullRequests: [] } } },
    });
    if (result.kind !== "normalized") throw new Error("expected fork check fact");
    expect(result.event).not.toHaveProperty("authorId");
    expect(result.event.payload).not.toHaveProperty("pullNumber");
  });

  it("retains status without an action or invented PR and permits the external CI link", async () => {
    const native = statusPayload();
    expect(await normalizeGithubActivity(source, { event: "status", delivery: "status" }, native)).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        objectId: "github:github.com:repository:3:status:92",
        content: {
          kind: "facts",
          facts: {
            surface: "status",
            id: 92,
            commitSha: "c".repeat(40),
            context: "external/build",
            state: "failure",
            description: "Build failed",
            targetUrl: "https://ci.example/build/92",
            actor: null,
          },
        },
        payload: {
          native,
        },
      },
    });
  });

  it("retains the checked commit and status when the optional CI link is empty", async () => {
    const native = { ...statusPayload(), target_url: "" };
    expect(await normalizeGithubActivity(source, { event: "status", delivery: "empty-link" }, native)).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        content: {
          kind: "facts",
          facts: { commitSha: "c".repeat(40), context: "external/build", state: "failure", targetUrl: "" },
        },
        payload: {
          native,
        },
      },
    });
  });

  it("separates check transitions and action requests from delivery identity", async () => {
    const native = checkPayload("check_run");
    const first = await normalizeGithubActivity(source, { event: "check_run", delivery: "one" }, native);
    const again = await normalizeGithubActivity(source, { event: "check_run", delivery: "two" }, native);
    const changed = await normalizeGithubActivity(
      source,
      { event: "check_run", delivery: "three" },
      {
        ...native,
        action: "requested_action",
        requested_action: { identifier: "retry" },
      },
    );
    if (first.kind !== "normalized" || again.kind !== "normalized" || changed.kind !== "normalized")
      throw new Error("expected check facts");
    expect(first.event.changeId).toMatch(/^[a-f0-9]{64}$/);
    expect(again.event.changeId).toBe(first.event.changeId);
    expect(changed.event.changeId).not.toBe(first.event.changeId);
    expect(changed.event.objectId).toBe(first.event.objectId);
    expect(changed.event.content).toMatchObject({ kind: "facts", facts: { action: "requested_action" } });
  });

  it.each([
    { ...statusPayload(), sha: "bad" },
    { ...statusPayload(), installation: { id: 99 } },
    { ...statusPayload(), state: { toString: null } },
  ])("holds malformed or foreign commit status (%#)", async (native) => {
    expect(await normalizeGithubActivity(source, { event: "status", delivery: "bad" }, native)).toMatchObject({
      kind: "refused",
    });
  });

  it("holds malformed PR associations and ignores unknown check actions", async () => {
    const native = checkPayload("check_run");
    const bad = { ...native, check_run: { ...check, pull_requests: [{ number: 7 }] } };
    expect(await normalizeGithubActivity(source, { event: "check_run", delivery: "bad" }, bad)).toEqual({
      kind: "refused",
      reason: "invalid-payload",
    });
    expect(
      await normalizeGithubActivity(
        source,
        { event: "check_run", delivery: "future" },
        { ...native, action: "unknown" },
      ),
    ).toEqual({ kind: "ignored", reason: "action" });
  });
});

describe("GitHub ref activity normalization", () => {
  const push = {
    installation: { id: 2 },
    repository: { id: 3, full_name: "acme/api" },
    ref: "refs/heads/fix/retry",
    before: "a".repeat(40),
    after: "b".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    commits: [{ id: "b".repeat(40), message: "Fix retries" }],
    head_commit: { id: "b".repeat(40) },
    sender: user,
  };
  const deletion = {
    installation: { id: 2 },
    repository: { id: 3, full_name: "acme/api" },
    ref: "fix/retry",
    ref_type: "branch",
    pusher_type: "deploy_key",
    sender: user,
  };

  it("retains branch SHAs and force-push facts without selecting a PR", async () => {
    const native = { ...push, forced: true, pull_request: { number: 99 } };
    expect(await normalizeGithubActivity(source, { event: "push", delivery: "one" }, native)).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        authorId: "github:github.com:user:4",
        objectId: "github:github.com:repository:3:ref:refs/heads/fix/retry",
        content: {
          kind: "facts",
          facts: {
            surface: "ref",
            action: "push",
            ref: "refs/heads/fix/retry",
            refType: "branch",
            before: "a".repeat(40),
            after: "b".repeat(40),
            created: false,
            deleted: false,
            forced: true,
            baseRef: null,
            actor: user,
          },
        },
        payload: {
          native,
        },
      },
    });
    const result = await normalizeGithubActivity(source, { event: "push", delivery: "one" }, native);
    if (result.kind !== "normalized") throw new Error("expected ref fact");
    expect(Object.keys(result.event.payload as object).sort()).toEqual(["native", "repository", "version"]);
  });

  it("keeps creation and deletion zero-SHA sentinels without guessing a commit", async () => {
    const created = { ...push, created: true, before: "0".repeat(40) };
    const deleted = { ...push, deleted: true, after: "0".repeat(40), commits: [], head_commit: null };
    expect(await normalizeGithubActivity(source, { event: "push", delivery: "created" }, created)).toMatchObject({
      kind: "normalized",
      event: { content: { kind: "facts", facts: { created: true, before: "0".repeat(40), after: "b".repeat(40) } } },
    });
    expect(await normalizeGithubActivity(source, { event: "push", delivery: "deleted" }, deleted)).toMatchObject({
      kind: "normalized",
      event: {
        content: { kind: "facts", facts: { deleted: true, before: "a".repeat(40), after: "0".repeat(40) } },
        payload: { native: deleted },
      },
    });
  });

  it("keeps delete facts on the same full ref and preserves absent SHA facts as null", async () => {
    const result = await normalizeGithubActivity(source, { event: "delete", delivery: "delete" }, deletion);
    expect(result).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        objectId: "github:github.com:repository:3:ref:refs/heads/fix/retry",
        content: {
          kind: "facts",
          facts: {
            action: "delete",
            ref: "refs/heads/fix/retry",
            refType: "branch",
            before: null,
            after: null,
            created: null,
            deleted: true,
            forced: null,
            baseRef: null,
            actor: user,
          },
        },
        payload: {
          native: deletion,
        },
      },
    });
  });

  it("keeps branch and tag identities separate and does not strip literal ref prefixes", async () => {
    const tag = await normalizeGithubActivity(
      source,
      { event: "push", delivery: "tag" },
      { ...push, ref: "refs/tags/fix/retry" },
    );
    expect(tag).toMatchObject({
      kind: "normalized",
      event: {
        objectId: "github:github.com:repository:3:ref:refs/tags/fix/retry",
        content: { kind: "facts", facts: { refType: "tag" } },
      },
    });
    const literal = await normalizeGithubActivity(
      source,
      { event: "delete", delivery: "nested" },
      { ...deletion, ref: "refs/heads/fix/retry" },
    );
    expect(literal).toMatchObject({
      kind: "normalized",
      event: { objectId: "github:github.com:repository:3:ref:refs/heads/refs/heads/fix/retry" },
    });
  });

  it("separates delivery identity and changed ref snapshots while freezing input", async () => {
    const native = structuredClone(push);
    const pending = normalizeGithubActivity(source, { event: "push", delivery: "one" }, native);
    native.after = "c".repeat(40);
    const first = await pending;
    const again = await normalizeGithubActivity(source, { event: "push", delivery: "two" }, push);
    const changed = await normalizeGithubActivity(
      source,
      { event: "push", delivery: "three" },
      { ...push, forced: true },
    );
    if (first.kind !== "normalized" || again.kind !== "normalized" || changed.kind !== "normalized")
      throw new Error("expected ref facts");
    expect(first.event).toMatchObject({
      deliveryId: "one",
      content: { kind: "facts", facts: { after: "b".repeat(40) } },
    });
    expect(first.event.changeId).toMatch(/^[a-f0-9]{64}$/);
    expect(again.event.changeId).toBe(first.event.changeId);
    expect(changed.event.changeId).not.toBe(first.event.changeId);
    expect(changed.event.objectId).toBe(first.event.objectId);
  });

  it("preserves unknown actors and treats bot actors as source data", async () => {
    expect(
      await normalizeGithubActivity(source, { event: "push", delivery: "unknown" }, { ...push, sender: null }),
    ).toMatchObject({
      kind: "normalized",
      event: { kind: "source-fact", content: { kind: "facts", facts: { actor: null } } },
    });
    expect(
      await normalizeGithubActivity(
        source,
        { event: "delete", delivery: "bot" },
        { ...deletion, sender: { ...user, type: "Bot" } },
      ),
    ).toMatchObject({
      kind: "normalized",
      event: {
        kind: "source-fact",
        authorId: "github:github.com:user:4",
        content: { kind: "facts", facts: { actor: { type: "Bot" } } },
      },
    });
  });

  it("holds malformed transitions and foreign source identity while accepting a valid push", async () => {
    expect(await normalizeGithubActivity(source, { event: "push", delivery: "valid" }, push)).toMatchObject({
      kind: "normalized",
    });
    for (const invalid of [
      { ...push, before: "bad" },
      { ...push, created: "false" },
      { ...push, created: true, deleted: true },
      { ...push, before: "0".repeat(40) },
      { ...push, after: "0".repeat(40) },
      { ...push, created: true },
      { ...push, deleted: true },
      { ...push, ref: "fix/retry" },
      { ...push, ref: "refs/heads/" },
      { ...push, base_ref: {} },
      { ...push, installation: { id: 99 } },
      { ...push, repository: { id: 99, full_name: "acme/api" } },
    ]) {
      expect(await normalizeGithubActivity(source, { event: "push", delivery: "invalid" }, invalid)).toMatchObject({
        kind: "refused",
      });
    }
    for (const invalid of [
      { ...deletion, ref_type: "tree" },
      { ...deletion, ref: "" },
    ]) {
      expect(await normalizeGithubActivity(source, { event: "delete", delivery: "invalid" }, invalid)).toMatchObject({
        kind: "refused",
      });
    }
  });
});
