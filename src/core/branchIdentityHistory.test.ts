import { describe, expect, it } from "vitest";
import { branchIdentityCaptureBlocked } from "./branchIdentityHistory.js";
import type { PublicationSettlement } from "./publicationSettlement.js";

const head = "a".repeat(40);
const branch = "feature/original";
const push = (ref = branch) => ({ type: "pushed_head", ref, sha: head, by: "push" });
const receipt = (ref = branch) => ({
  ...push(ref),
  receipt: {
    callId: "call",
    previousHeadSha: "b".repeat(40),
    repo: "o/r",
    pr: 1,
    owner: { instanceId: "pipeline", unit: "ONE" },
  },
});
const settlement = (): PublicationSettlement => ({
  version: 1,
  binding: {
    runId: "original",
    instanceId: "pipeline",
    step: "pipeline:ONE/0/coding",
    repo: "o/r",
    branch,
    requester: "cli:person",
    threadKey: "cli:thread",
    generation: "original",
  },
  checkpoint: { kind: "created", head },
  publication: { kind: "accepted", head },
  preservation: { kind: "pending" },
  release: { kind: "pending" },
});

describe("identity capture after retained publication", () => {
  it("allows an unwritten attachment, including a complete empty producer record", () => {
    expect(branchIdentityCaptureBlocked({}, "o/r", branch)).toBe(false);
    expect(
      branchIdentityCaptureBlocked(
        {
          branchPushReceipts: [],
          publicationReceipts: [],
          branchPublication: { version: 1, repo: "o/r", complete: true, branches: [] },
        },
        "o/r",
        branch,
      ),
    ).toBe(false);
  });
  it.each([
    { branchPushReceipts: [push()] },
    { pushedBranch: "auxiliary", branchPushReceipts: [push(), push("auxiliary")] },
    { publicationReceipts: [receipt()] },
    { publicationSettlement: settlement() },
    {
      branchPublication: {
        version: 1,
        repo: "o/r",
        complete: true,
        branches: [{ ref: branch, sha: head, by: "push" }],
      },
    },
  ])("does not recapture a canonically published attachment when display projections are missing", (state) => {
    expect(branchIdentityCaptureBlocked(state, "o/r", branch)).toBe(true);
  });
  it("checks receipts by attachment ref rather than the latest auxiliary push", () => {
    expect(
      branchIdentityCaptureBlocked(
        { pushedBranch: "auxiliary", branchPushReceipts: [push("auxiliary")] },
        "o/r",
        branch,
      ),
    ).toBe(false);
    expect(
      branchIdentityCaptureBlocked(
        { pushedBranch: "auxiliary", branchPushReceipts: [push(), push("auxiliary")] },
        "o/r",
        branch,
      ),
    ).toBe(true);
  });
  it.each([
    { branchPushReceipts: null },
    { branchPushReceipts: [{ ...push(), sha: "bad" }] },
    { publicationReceipts: null },
    { publicationReceipts: [push()] },
    { publicationSettlement: null },
    { publicationSettlement: { version: 1 } },
    { branchPublication: { version: 1, complete: false, branches: [] } },
    {
      doorPublicationPending: {
        id: "intent",
        repo: "o/r",
        update: { ref: `refs/heads/${branch}`, old: "b".repeat(40), next: head },
      },
    },
    { doorPublicationPending: { malformed: true } },
    { publicationSettlement: { ...settlement(), publication: { kind: "unknown", reason: "response lost" } } },
    {
      publicationSettlement: {
        ...settlement(),
        checkpoint: { kind: "pending" },
        publication: { kind: "not_attempted" },
      },
    },
  ])("keeps malformed or unresolved retained effects from laundering an advanced head", (state) => {
    expect(branchIdentityCaptureBlocked(state, "o/r", branch)).toBe(true);
  });
  it("does not turn a positively unforwarded Door request into accepted write evidence", () => {
    expect(
      branchIdentityCaptureBlocked(
        {
          doorPublicationPending: {
            id: "intent",
            repo: "o/r",
            update: { ref: `refs/heads/${branch}`, old: "b".repeat(40), next: head },
            outcome: "not_forwarded",
          },
        },
        "o/r",
        branch,
      ),
    ).toBe(false);
  });
});
