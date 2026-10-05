import { describe, expect, it } from "vitest";
import { publishedHeadEvidence } from "./publishedHeadAdoption.js";

const HEAD = "6dca321e00afdda6179eb45c64438a126cb42465";
const INSTANCE = "original-instance";
const REF = "original/branch";
const KEY = `${INSTANCE}:U12/0/coding`;

function evidence() {
  const instance = {
    id: INSTANCE,
    repo: "acme/api",
    base: "main",
    userId: "slack:U12",
    threadKey: "mcp:default:source",
  };
  const row = {
    instanceId: INSTANCE,
    unit: "U12",
    branch: REF,
    threadKey: "mcp:default:source",
    startedAt: 1,
    rounds: [{ index: 0, agent: "coding", outcome: "started", at: 2 }],
    ending: { kind: "aborted", report: "paused", at: 10 },
  };
  const run = {
    id: "coding-run",
    parentInstanceId: INSTANCE,
    idempotencyKey: KEY,
    agent: "coding",
    userId: "slack:U12",
    repo: instance.repo,
    threadKey: row.threadKey,
    startedAt: 3,
    finishedAt: 9,
    finished: true,
    persisted: true,
    status: "failed",
    truncated: false,
    eventCount: 3,
    storedEventCount: 3,
    events: [
      { type: "tool_call", tool: "publish_branch", callId: "call-publish" },
      { type: "pushed_head", ref: REF, sha: HEAD, by: "push" },
      { type: "tool_result", tool: "publish_branch", callId: "call-publish", ok: true },
    ],
    pushed: [{ ref: REF, sha: HEAD, by: "push" }],
  };
  return { instance, row, run, runs: [run] };
}

function settledHistory() {
  const facts = evidence();
  const run = {
    ...facts.run,
    eventCount: 4,
    storedEventCount: 4,
    events: [
      { type: "tool_call", tool: "publish_branch", callId: "call-publish", seq: 1 },
      { type: "pushed_head", ref: REF, sha: "a".repeat(40), by: "push", seq: 2 },
      { type: "pushed_head", ref: REF, sha: HEAD, by: "push", seq: 3 },
      { type: "pushed_head", ref: REF, sha: HEAD, by: "salvage", seq: 4 },
    ],
    pushed: [{ ref: REF, sha: HEAD, by: "salvage" }],
    publicationSettlement: {
      version: 1,
      binding: {
        runId: facts.run.id,
        instanceId: INSTANCE,
        step: KEY,
        repo: facts.instance.repo,
        branch: REF,
        requester: facts.instance.userId,
        threadKey: facts.run.threadKey,
        generation: "g1",
      },
      checkpoint: { kind: "created", head: HEAD },
      publication: { kind: "accepted", head: HEAD },
      preservation: { kind: "pending" },
      release: { kind: "pending" },
    },
  };
  return { ...facts, run, runs: [run] };
}

describe("publishedHeadEvidence — one original committed head", () => {
  it("accepts the canonical final head after native updates and same-head salvage", () => {
    const facts = settledHistory();
    const before = structuredClone(facts);
    expect(publishedHeadEvidence(facts)).toEqual({ ok: true, head: HEAD, runId: "coding-run" });
    expect(facts).toEqual(before);
  });

  it("requires a run-bound accepted settlement for a multi-push history", () => {
    const facts = settledHistory();
    expect(publishedHeadEvidence({ ...facts, run: { ...facts.run, publicationSettlement: undefined } })).toMatchObject({
      ok: false,
      error: "push_unverified",
    });
    for (const field of ["runId", "requester", "branch"] as const) {
      const changed = structuredClone(facts);
      changed.run.publicationSettlement.binding[field] = "foreign";
      expect(publishedHeadEvidence(changed)).toMatchObject({ ok: false, error: "publication_settlement_unverified" });
    }
    const pending = structuredClone(facts);
    pending.run.publicationSettlement.publication.kind = "pending";
    expect(publishedHeadEvidence(pending)).toMatchObject({ ok: false, error: "publication_settlement_unverified" });
  });

  it("refuses foreign or malformed pushes and contradictory salvage without trusting the display summary", () => {
    for (const change of [{ ref: "foreign/branch" }, { sha: "short" }, { by: "unknown" }, { receipt: {} }]) {
      const facts = settledHistory();
      const events = facts.run.events.map((event, i) => (i === 1 ? { ...event, ...change } : event));
      expect(publishedHeadEvidence({ ...facts, run: { ...facts.run, events } })).toMatchObject({ ok: false });
    }
    const facts = settledHistory();
    for (const index of [2, 3]) {
      const events = facts.run.events.map((event, i) => (i === index ? { ...event, sha: "b".repeat(40) } : event));
      expect(publishedHeadEvidence({ ...facts, run: { ...facts.run, events } })).toMatchObject({
        ok: false,
        error: "push_unverified",
      });
    }
    expect(
      publishedHeadEvidence({ ...facts, run: { ...facts.run, pushed: [{ ref: REF, sha: HEAD, by: "push" }] } }),
    ).toMatchObject({ ok: false, error: "push_unverified" });
    const events = facts.run.events.map((event) =>
      event.type === "pushed_head" ? { ...event, by: "salvage" } : event,
    );
    expect(publishedHeadEvidence({ ...facts, run: { ...facts.run, events } })).toMatchObject({ ok: false });
  });

  it("requires the contiguous prefix through the final native push even with an accepted settlement", () => {
    const facts = settledHistory();
    const run = { ...facts.run, truncated: true, eventCount: 6 };
    expect(publishedHeadEvidence({ ...facts, run })).toMatchObject({ ok: true, head: HEAD });
    const events = run.events.filter((event) => event.seq !== 2);
    expect(publishedHeadEvidence({ ...facts, run: { ...run, events, storedEventCount: events.length } })).toMatchObject(
      { ok: false, error: "child_record_incomplete" },
    );
  });
  it("admits the durable original push without claiming a description or dirty checkout", () => {
    expect(publishedHeadEvidence(evidence())).toEqual({ ok: true, head: HEAD, runId: "coding-run" });
  });

  it("adopts only a push retained before a trimmed unanswered description", () => {
    const facts = evidence();
    const run = {
      ...facts.run,
      truncated: true,
      eventCount: 7,
      storedEventCount: 5,
      events: [
        ...facts.run.events.map((event, index) => ({ ...event, seq: index + 1 })),
        { type: "tool_call", tool: "submit_pr_description", callId: "call-description", summary: "submit", seq: 4 },
        { type: "run_note", kind: "stopped", summary: "coding stopped", seq: 7 },
      ],
    };
    expect(publishedHeadEvidence({ ...facts, run })).toEqual({ ok: true, head: HEAD, runId: "coding-run" });
    expect(
      publishedHeadEvidence({ ...facts, run: { ...run, events: run.events.slice(1), storedEventCount: 4 } }),
    ).toMatchObject({
      ok: false,
      error: "child_record_incomplete",
    });
    expect(publishedHeadEvidence({ ...facts, run: { ...run, pushed: undefined } })).toMatchObject({
      ok: false,
      error: "push_unverified",
    });
    expect(publishedHeadEvidence({ ...facts, run: { ...run, pr: { number: 99 } } })).toMatchObject({
      ok: false,
      error: "push_unverified",
    });
    expect(publishedHeadEvidence({ ...facts, run: { ...run, doorPublicationPending: {} } })).toMatchObject({
      ok: false,
      error: "door_publication_unresolved",
    });
  });

  it("holds while the original child is live, even if the remote already has its push", () => {
    const facts = evidence();
    facts.run.finished = false;
    expect(publishedHeadEvidence(facts)).toMatchObject({ ok: false, error: "original_child_active" });
  });

  it("accepts the production branch recorder without an authorization event and before the tool result", () => {
    const facts = evidence();
    expect(publishedHeadEvidence(facts)).toEqual({ ok: true, head: HEAD, runId: "coding-run" });
    expect(publishedHeadEvidence({ ...facts, run: { ...facts.run, doorPublicationPending: null } })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a conflicting later push and a pending Door effect", () => {
    const facts = evidence();
    facts.run.events.push({ type: "pushed_head", ref: REF, sha: "a".repeat(40), by: "push" });
    facts.run.eventCount++;
    facts.run.storedEventCount++;
    expect(publishedHeadEvidence(facts)).toMatchObject({ ok: false, error: "push_unverified" });
    const pending = evidence();
    expect(publishedHeadEvidence({ ...pending, run: { ...pending.run, doorPublicationPending: {} } })).toMatchObject({
      ok: false,
      error: "door_publication_unresolved",
    });
  });

  it("refuses competing child records, foreign identity and a contradictory settlement", () => {
    const facts = evidence();
    const sibling = { ...facts.run, id: "sibling", idempotencyKey: `${INSTANCE}:U13/0/coding` };
    expect(publishedHeadEvidence({ ...facts, runs: [...facts.runs, sibling] })).toMatchObject({ ok: true });
    expect(
      publishedHeadEvidence({
        ...facts,
        runs: [...facts.runs, { ...facts.run, id: "rival", idempotencyKey: `${INSTANCE}:U12/1/coding` }],
      }),
    ).toMatchObject({
      ok: false,
      error: "child_evidence_ambiguous",
    });
    expect(publishedHeadEvidence({ ...facts, run: { ...facts.run, userId: "slack:U13" } })).toMatchObject({
      ok: false,
      error: "child_identity_mismatch",
    });
    expect(publishedHeadEvidence({ ...facts, run: { ...facts.run, publicationSettlement: null } })).toMatchObject({
      ok: false,
      error: "publication_settlement_unverified",
    });
  });
});
