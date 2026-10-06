import { describe, expect, it, vi } from "vitest";
import {
  BRANCH_IDENTITY_BASELINE_MAX_BYTES,
  BRANCH_IDENTITY_BASELINE_MAX_COMMITS,
  branchIdentityBaselineFor,
  isBranchIdentityBaseline,
  type BranchIdentityBaseline,
} from "./branchIdentityBaseline.js";
import { preserveCheckpointState } from "./runLedger/checkpointState.js";
import { isRunWorkEvidence, MAX_RECORD_BYTES } from "./runRecord.js";
import { rewriteRunCommits } from "../execution/identityRewrite.js";
import type { ComparedCommit } from "../execution/githubPulls.js";

const baseline = (): BranchIdentityBaseline => ({
  version: 1,
  binding: {
    runId: "original-run",
    requester: "cli:requester",
    threadKey: "cli:thread",
    repo: "acme/api",
    branch: "plan/original/u1",
    base: "main",
    head: "a".repeat(40),
    instanceId: "plan-original",
    step: "plan-original:U11/0/coding",
  },
  state: {
    kind: "known",
    commits: [
      {
        sha: "b".repeat(40),
        author: { name: "Original Author", email: "author@example.test" },
        date: new Date(0).toISOString(),
        message: "Original commit",
      },
    ],
  },
});

describe("durable branch identity baseline", () => {
  it.each([
    { kind: "known", commits: [] },
    { kind: "boundary", sha: "a".repeat(40) },
    { kind: "boundary", sha: "abcd" },
    { kind: "unknown" },
    { kind: "unknown", reason: "The original read was unavailable." },
  ] as const)("retains a typed %j baseline without converting unknown to known", (state) => {
    expect(isBranchIdentityBaseline({ ...baseline(), state })).toBe(true);
  });

  it("retains exact old commit fingerprints and permits an empty commit message", () => {
    const original = baseline();
    if (original.state.kind !== "known") throw new Error("fixture must be known");
    original.state.commits[0]!.message = "";
    expect(isBranchIdentityBaseline(original)).toBe(true);
    const restored = branchIdentityBaselineFor(original, original.binding);
    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
  });

  it.each([
    null,
    { ...baseline(), version: 2 },
    { ...baseline(), extra: true },
    { ...baseline(), binding: { ...baseline().binding, head: "abcd" } },
    { ...baseline(), binding: { ...baseline().binding, repo: "../api" } },
    { ...baseline(), binding: { ...baseline().binding, branch: "../main" } },
    { ...baseline(), binding: { ...baseline().binding, requester: "" } },
    { ...baseline(), binding: { ...baseline().binding, step: undefined } },
    { ...baseline(), binding: { ...baseline().binding, instanceId: undefined } },
    { ...baseline(), binding: { ...baseline().binding, step: "other:U11/0/coding" } },
    { ...baseline(), state: { kind: "known", commits: [{ sha: "b".repeat(40) }] } },
    {
      ...baseline(),
      state: {
        kind: "known",
        commits: [{ sha: "b".repeat(40), author: { name: "Name", email: 1 }, date: "date", message: "message" }],
      },
    },
    { ...baseline(), state: { kind: "boundary", sha: "a".repeat(41) } },
    { ...baseline(), state: { kind: "unknown", commits: [] } },
  ])("refuses malformed baseline evidence %j", (value) => {
    expect(isBranchIdentityBaseline(value)).toBe(false);
  });

  it("refuses oversized fingerprints and commit ranges rather than dropping evidence", () => {
    const original = baseline();
    if (original.state.kind !== "known") throw new Error("fixture must be known");
    const commit = original.state.commits[0]!;
    expect(
      isBranchIdentityBaseline({
        ...original,
        state: {
          kind: "known",
          commits: [{ ...commit, message: "界".repeat(BRANCH_IDENTITY_BASELINE_MAX_BYTES / 2) }],
        },
      }),
    ).toBe(false);
    expect(
      isBranchIdentityBaseline({
        ...original,
        state: {
          kind: "known",
          commits: Array.from({ length: BRANCH_IDENTITY_BASELINE_MAX_COMMITS + 1 }, (_, index) => ({
            ...commit,
            sha: index.toString(16).padStart(40, "0"),
          })),
        },
      }),
    ).toBe(false);
    expect(
      isBranchIdentityBaseline({
        ...original,
        state: {
          kind: "known",
          commits: Array.from({ length: BRANCH_IDENTITY_BASELINE_MAX_COMMITS }, (_, index) => ({
            ...commit,
            sha: index.toString(16).padStart(40, "0"),
          })),
        },
      }),
    ).toBe(true);
  });

  it("restores the original baseline after the current attachment head advances", () => {
    const original = baseline();
    expect(branchIdentityBaselineFor(original, { ...original.binding, head: "c".repeat(40) })).toEqual(original);
    const { head: _head, ...identity } = original.binding;
    expect(branchIdentityBaselineFor(original, identity)).toEqual(original);
  });

  it("keeps an inherited author only for its original fingerprint after restart", async () => {
    const original = baseline();
    if (original.state.kind !== "known") throw new Error("fixture must be known");
    const inherited = original.state.commits[0]!;
    const bot = { name: "Automation", email: "automation@example.test" };
    const commit: ComparedCommit = {
      sha: "c".repeat(40),
      treeSha: "d".repeat(40),
      parents: [inherited.sha],
      author: { ...inherited.author, date: inherited.date },
      committer: bot,
      message: inherited.message,
    };
    const restored = branchIdentityBaselineFor(original, { ...original.binding, head: commit.sha });
    const api = {
      compareRange: vi.fn(async () => ({ totalCommits: 1, commits: [commit] })),
      createCommit: vi.fn(async () => "e".repeat(40)),
      forceMoveRef: vi.fn(async () => undefined),
    };
    const input = {
      repo: original.binding.repo,
      base: original.binding.base,
      branch: original.binding.branch,
      expectedTip: commit.sha,
      startState: restored!.state,
      bot,
      api,
      readOnly: true as const,
    };
    expect(await rewriteRunCommits(input)).toEqual({ kind: "clean", tip: commit.sha });
    commit.message = "New content by the same inherited author";
    expect(await rewriteRunCommits(input)).toEqual({
      kind: "unreadable",
      reason: "the published head requires an identity rewrite",
    });
    expect(api.createCommit).not.toHaveBeenCalled();
    expect(api.forceMoveRef).not.toHaveBeenCalled();
  });

  it("retains a boundary through restart and refuses a range that lost it", async () => {
    const original = { ...baseline(), state: { kind: "boundary" as const, sha: "b".repeat(40) } };
    const restored = branchIdentityBaselineFor(original, { ...original.binding, head: "c".repeat(40) });
    const bot = { name: "Automation", email: "automation@example.test" };
    const createCommit = vi.fn(async () => "e".repeat(40));
    const forceMoveRef = vi.fn(async () => undefined);
    expect(
      await rewriteRunCommits({
        repo: original.binding.repo,
        base: original.binding.base,
        branch: original.binding.branch,
        startState: restored!.state,
        bot,
        readOnly: true,
        api: { compareRange: async () => ({ totalCommits: 0, commits: [] }), createCommit, forceMoveRef },
      }),
    ).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("pre-push head") });
    expect(createCommit).not.toHaveBeenCalled();
    expect(forceMoveRef).not.toHaveBeenCalled();
  });

  it("restores unknown evidence without authorizing an identity read or publication", async () => {
    const original = { ...baseline(), state: { kind: "unknown" as const, reason: "The original read failed." } };
    const restored = branchIdentityBaselineFor(original, original.binding);
    const api = {
      compareRange: vi.fn(async () => ({ totalCommits: 0, commits: [] })),
      createCommit: vi.fn(async () => "e".repeat(40)),
      forceMoveRef: vi.fn(async () => undefined),
    };
    expect(
      await rewriteRunCommits({
        repo: original.binding.repo,
        base: original.binding.base,
        branch: original.binding.branch,
        startState: restored!.state,
        bot: { name: "Automation", email: "automation@example.test" },
        api,
      }),
    ).toEqual({ kind: "unreadable", reason: "the branch's start state is unknown (The original read failed.)" });
    expect(api.compareRange).not.toHaveBeenCalled();
    expect(api.createCommit).not.toHaveBeenCalled();
    expect(api.forceMoveRef).not.toHaveBeenCalled();
  });

  it.each([
    { runId: "different-run" },
    { requester: "cli:stranger" },
    { threadKey: "cli:other" },
    { repo: "acme/other" },
    { branch: "plan/other/u1" },
    { base: "release" },
    { instanceId: "plan-other", step: "plan-other:U11/0/coding" },
    { step: "plan-original:U11/1/findings" },
    { head: "invalid" },
  ])("refuses baseline substitution across its admitted binding %j", (change) => {
    const original = baseline();
    expect(branchIdentityBaselineFor(original, { ...original.binding, ...change })).toBeUndefined();
  });
});

describe("identity baseline retention in checkpoint state", () => {
  it("accepts the first valid baseline and restores it across omitted state patches", () => {
    const original = baseline();
    const first = preserveCheckpointState({}, { branchIdentityBaseline: original });
    expect(first).toEqual({ branchIdentityBaseline: original });
    expect(first!.branchIdentityBaseline).not.toBe(original);
    const next = preserveCheckpointState(first!, { verdict: "later" });
    expect(next).toEqual({ branchIdentityBaseline: original, verdict: "later" });
    expect(next!.branchIdentityBaseline).not.toBe(original);
    expect(preserveCheckpointState(first!, { branchIdentityBaseline: structuredClone(original) })).toEqual(first);
  });

  it("refuses a changed first head, changed fingerprint or unknown-to-known replacement", () => {
    const original = baseline();
    expect(
      preserveCheckpointState(
        { branchIdentityBaseline: original },
        {
          branchIdentityBaseline: { ...original, binding: { ...original.binding, head: "c".repeat(40) } },
        },
      ),
    ).toBeUndefined();
    expect(
      preserveCheckpointState(
        { branchIdentityBaseline: original },
        {
          branchIdentityBaseline: { ...original, state: { kind: "known", commits: [] } },
        },
      ),
    ).toBeUndefined();
    const unknown = { ...original, state: { kind: "unknown" } };
    expect(
      preserveCheckpointState({ branchIdentityBaseline: unknown }, { branchIdentityBaseline: original }),
    ).toBeUndefined();
  });

  it("refuses malformed incoming or retained evidence without silently clearing it", () => {
    expect(preserveCheckpointState({}, { branchIdentityBaseline: { version: 1 } })).toBeUndefined();
    expect(preserveCheckpointState({ branchIdentityBaseline: { version: 1 } }, {})).toBeUndefined();
    expect(
      preserveCheckpointState({ branchIdentityBaseline: baseline() }, { branchIdentityBaseline: null }),
    ).toBeUndefined();
  });

  it("retains the existing source checkpoint and unit seed guards", () => {
    expect(
      preserveCheckpointState(
        { contextCheckpointReceipt: { id: "saved" } },
        {
          branchIdentityBaseline: baseline(),
          contextCheckpointReceipt: { id: "changed" },
        },
      ),
    ).toBeUndefined();
    expect(preserveCheckpointState({}, { branchIdentityBaseline: baseline(), unitSeedReceipt: {} })).toBeUndefined();
  });

  it("charges the retained baseline against the existing aggregate evidence budget", () => {
    const read = {
      tool: "work_status" as const,
      callId: "status-00000000",
      input: { actId: "original-act" },
      resultHash: "a".repeat(64),
      observation: {
        version: 1 as const,
        actId: "original-act",
        instanceId: "original-instance",
        unit: "U11",
        attempt: 0,
        requesterId: "cli:requester",
        channelId: "cli:local",
        mainThreadKey: "cli:thread",
        snapshotHash: "b".repeat(64),
        observedAt: 1,
      },
    };
    const count = Math.floor((MAX_RECORD_BYTES - 16 * 1024) / (JSON.stringify(read).length + 1));
    const workReads = Array.from({ length: count }, (_, index) => ({
      ...read,
      callId: `status-${String(index).padStart(8, "0")}`,
    }));
    const original = baseline();
    if (original.state.kind !== "known") throw new Error("fixture must be known");
    original.state.commits[0]!.message = "x".repeat(40 * 1024);
    expect(isBranchIdentityBaseline(original)).toBe(true);
    expect(isRunWorkEvidence({ workReads })).toBe(true);
    expect(preserveCheckpointState({ branchIdentityBaseline: original }, { workReads }) === undefined).toBe(true);
  });
});
