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

describe("publishedHeadEvidence — one original committed head", () => {
  it("admits the durable original push without claiming a description or dirty checkout", () => {
    expect(publishedHeadEvidence(evidence())).toEqual({ ok: true, head: HEAD, runId: "coding-run" });
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
