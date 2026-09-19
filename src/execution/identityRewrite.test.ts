import { describe, expect, it, vi } from "vitest";
import type { ComparedCommit, CompareResult } from "./githubPulls.js";
import {
  EMPTY_START_STATE,
  authorEnvEnabled,
  pairOfBinding,
  readBranchStartState,
  requesterPairFor,
  rewriteRunCommits,
  type BranchStartState,
  type IdentityPair,
  type RewriteApi,
} from "./identityRewrite.js";

// Feature: docs/reference/specs/agent-coding.md item 2 (record 0062, "The
// identity rewrite") — before the bot opens or edits a pull request, the
// commits the run pushed carry only the allowed identities: the requester
// pair, the bot pair, or a start-state author pair kept by fingerprint;
// everything else is rewritten over the Git Data API with the same trees, the
// original author dates and the committer sent explicitly as the bot pair —
// and an unreadable range (over 300 commits, an unknown start state, a moved
// tip after two rebuilds, a ruleset refusal) opens nothing.

const BOT: IdentityPair = { name: "switchboard-dev[bot]", email: "9999+switchboard-dev[bot]@users.noreply.github.com" };
const IVY = pairOfBinding({ login: "ivy-dev", id: 4242 });
const RAJ: IdentityPair = { name: "Raj", email: "raj@example.com" };

const commit = (
  sha: string,
  over: Partial<Omit<ComparedCommit, "author" | "committer">> & {
    author?: Partial<ComparedCommit["author"]>;
    committer?: Partial<ComparedCommit["committer"]>;
  } = {},
): ComparedCommit => ({
  sha,
  treeSha: over.treeSha ?? `tree-${sha}`,
  parents: over.parents ?? [],
  author: { name: IVY.name, email: IVY.email, date: "2026-09-18T10:00:00Z", ...over.author },
  committer: { name: BOT.name, email: BOT.email, ...over.committer },
  message: over.message ?? `msg ${sha}`,
});

/** A stub Git Data seam: compare answers consumed in order (the re-read after
 *  each rebuild takes the next one), rebuilds minting `r1`, `r2`, … */
function apiOf(compares: Array<CompareResult | "missing" | undefined>) {
  let reads = 0;
  const created: Array<Parameters<RewriteApi["createCommit"]>[1]> = [];
  const moved: Array<{ branch: string; sha: string }> = [];
  const api: RewriteApi = {
    compareRange: async () => compares[Math.min(reads++, compares.length - 1)],
    createCommit: async (_repo, c) => {
      created.push(c);
      return `r${created.length}`;
    },
    forceMoveRef: async (_repo, branch, sha) => {
      moved.push({ branch, sha });
    },
  };
  return { api, created, moved, reads: () => reads };
}

const runRewrite = (
  api: RewriteApi,
  over: { startState?: BranchStartState; requester?: IdentityPair; bot?: IdentityPair | undefined } = {},
) =>
  rewriteRunCommits({
    repo: "acme/api",
    base: "main",
    branch: "feat/x",
    startState: over.startState ?? EMPTY_START_STATE,
    bot: "bot" in over ? over.bot : BOT,
    ...(over.requester !== undefined ? { requester: over.requester } : {}),
    api,
  });

describe("rewriteRunCommits — the run's commits carry only the allowed identities (record 0062)", () => {
  it("ships with the author env off: the flag is false and no requester pair is read without it", () => {
    expect(authorEnvEnabled).toBe(false);
    expect(requesterPairFor({ login: "ivy-dev", id: 4242 })).toBeUndefined();
    expect(requesterPairFor({ login: "ivy-dev", id: 4242 }, true)).toEqual(IVY);
    expect(requesterPairFor(undefined, true)).toBeUndefined();
  });

  it("start state empty; two run commits authored by the requester pair, committed by the bot pair, trailer the bot pair, the flag on: clean", async () => {
    const { api, created, moved } = apiOf([
      {
        totalCommits: 2,
        commits: [
          commit("a1b2", { message: `one\n\nCo-Authored-By: ${BOT.name} <${BOT.email}>` }),
          commit("b2c3", { parents: ["a1b2"] }),
        ],
      },
    ]);
    const result = await runRewrite(api, { requester: IVY });
    expect(result).toEqual({ kind: "clean", tip: "b2c3" });
    expect(created).toHaveLength(0);
    expect(moved).toHaveLength(0);
  });

  it("a second commit authored by a stranger: rewritten 1 — one rebuild with b2c3's tree and parent a1b2, the requester pair as author with the original date, the bot pair sent explicitly as committer, then a forced ref move and a clean re-read", async () => {
    const offending = commit("b2c3", { parents: ["a1b2"], author: { ...RAJ, date: "2026-09-18T11:00:00Z" } });
    const { api, created, moved } = apiOf([
      { totalCommits: 2, commits: [commit("a1b2"), offending] },
      {
        totalCommits: 2,
        commits: [
          commit("a1b2"),
          commit("r1", { parents: ["a1b2"], author: { ...IVY, date: "2026-09-18T11:00:00Z" } }),
        ],
      },
    ]);
    const result = await runRewrite(api, { requester: IVY });
    expect(result).toEqual({
      kind: "rewritten",
      count: 1,
      replaced: ["author Raj <raj@example.com>"],
      tip: "r1",
    });
    expect(created).toEqual([
      {
        message: "msg b2c3",
        tree: "tree-b2c3",
        parents: ["a1b2"],
        author: { name: IVY.name, email: IVY.email, date: "2026-09-18T11:00:00Z" },
        committer: { name: BOT.name, email: BOT.email },
      },
    ]);
    expect(moved).toEqual([{ branch: "feat/x", sha: "r1" }]);
  });

  it("a commit committed by the requester pair (the model set GIT_COMMITTER_*) is rewritten; committed by the bot's name at a foreign address too", async () => {
    for (const committer of [IVY, { name: "switchboard-dev[bot]", email: "victim@corp.example" }]) {
      const { api, created } = apiOf([
        { totalCommits: 1, commits: [commit("a1b2", { committer })] },
        { totalCommits: 1, commits: [commit("r1")] },
      ]);
      const result = await runRewrite(api, { requester: IVY });
      expect(result.kind).toBe("rewritten");
      expect(created[0].committer).toEqual({ name: BOT.name, email: BOT.email });
    }
  });

  it("a real name over the bot's address, and the requester's noreply under a stranger's name, are both rewritten (exact pairs)", async () => {
    for (const author of [
      { name: "Ivy Real Name", email: BOT.email },
      { name: "Raj", email: IVY.email },
    ]) {
      const { api, created } = apiOf([
        { totalCommits: 1, commits: [commit("a1b2", { author })] },
        { totalCommits: 1, commits: [commit("r1", { author: { ...IVY } })] },
      ]);
      const result = await runRewrite(api, { requester: IVY });
      expect(result.kind).toBe("rewritten");
      expect(created[0].author).toEqual({ name: IVY.name, email: IVY.email, date: "2026-09-18T10:00:00Z" });
    }
  });

  it("a foreign Co-Authored-By trailer is rewritten with the line dropped and the bot trailer kept", async () => {
    const message = `fix: x\n\nCo-Authored-By: Raj <raj@example.com>\nCo-Authored-By: ${BOT.name} <${BOT.email}>`;
    const { api, created } = apiOf([
      { totalCommits: 1, commits: [commit("a1b2", { message })] },
      { totalCommits: 1, commits: [commit("r1", { message: `fix: x\n\nCo-Authored-By: ${BOT.name} <${BOT.email}>` })] },
    ]);
    const result = await runRewrite(api, { requester: IVY });
    expect(result).toMatchObject({ kind: "rewritten", count: 1, replaced: ["co-author Raj <raj@example.com>"] });
    expect(created[0].message).toBe(`fix: x\n\nCo-Authored-By: ${BOT.name} <${BOT.email}>`);
    // The author already passed, so it is kept as written.
    expect(created[0].author.name).toBe(IVY.name);
  });

  it("the first offending commit is the third of five: commits four and five are rebuilt too, same trees and messages, parents remapped, and a clean chain results", async () => {
    const chain = [
      commit("c1"),
      commit("c2", { parents: ["c1"] }),
      commit("c3", { parents: ["c2"], author: { ...RAJ } }),
      commit("c4", { parents: ["c3"] }),
      commit("c5", { parents: ["c4"] }),
    ];
    const { api, created, moved } = apiOf([
      { totalCommits: 5, commits: chain },
      {
        totalCommits: 5,
        commits: [
          commit("c1"),
          commit("c2", { parents: ["c1"] }),
          commit("r1", { parents: ["c2"], author: { ...IVY }, message: "msg c3", treeSha: "tree-c3" }),
          commit("r2", { parents: ["r1"], message: "msg c4", treeSha: "tree-c4" }),
          commit("r3", { parents: ["r2"], message: "msg c5", treeSha: "tree-c5" }),
        ],
      },
    ]);
    const result = await runRewrite(api, { requester: IVY });
    expect(result).toMatchObject({ kind: "rewritten", count: 1, tip: "r3" });
    expect(created.map((c) => ({ tree: c.tree, parents: c.parents, message: c.message }))).toEqual([
      { tree: "tree-c3", parents: ["c2"], message: "msg c3" },
      { tree: "tree-c4", parents: ["r1"], message: "msg c4" },
      { tree: "tree-c5", parents: ["r2"], message: "msg c5" },
    ]);
    // Four and five already passed: their authors are kept.
    expect(created[1].author.name).toBe(IVY.name);
    expect(moved).toEqual([{ branch: "feat/x", sha: "r3" }]);
  });

  it("a rebased start commit keeps its start pair by fingerprint (same pair, date and message under a new sha); a new commit is judged", async () => {
    const ivyStart: IdentityPair = { name: "Ivy Person", email: "ivy@example.com" };
    const startState: BranchStartState = {
      kind: "known",
      commits: [{ sha: "c0c0", author: ivyStart, date: "2026-09-01T00:00:00Z", message: "m0" }],
    };
    const rebased = commit("c1c1", { author: { ...ivyStart, date: "2026-09-01T00:00:00Z" }, message: "m0" });
    const fresh = commit("d1d1", { parents: ["c1c1"] });
    const { api, created } = apiOf([{ totalCommits: 2, commits: [rebased, fresh] }]);
    const result = await runRewrite(api, { startState, requester: IVY });
    expect(result).toEqual({ kind: "clean", tip: "d1d1" });
    expect(created).toHaveLength(0);
  });

  it("a NEW commit authored with a start pair but a different message fails the fingerprint and is rewritten to the requester pair", async () => {
    const ivyStart: IdentityPair = { name: "Ivy Person", email: "ivy@example.com" };
    const startState: BranchStartState = {
      kind: "known",
      commits: [{ sha: "c0c0", author: ivyStart, date: "2026-09-01T00:00:00Z", message: "m0" }],
    };
    const impostor = commit("d1d1", { author: { ...ivyStart, date: "2026-09-01T00:00:00Z" }, message: "new work" });
    const { api, created } = apiOf([
      { totalCommits: 1, commits: [impostor] },
      { totalCommits: 1, commits: [commit("r1", { message: "new work" })] },
    ]);
    const result = await runRewrite(api, { startState, requester: IVY });
    expect(result).toMatchObject({ kind: "rewritten", count: 1 });
    expect(created[0].author).toEqual({ name: IVY.name, email: IVY.email, date: "2026-09-01T00:00:00Z" });
  });

  it("a passing descendant carrying a fingerprinted start pair after the first offender is rebuilt (new parent) with its author KEPT", async () => {
    const ivyStart: IdentityPair = { name: "Ivy Person", email: "ivy@example.com" };
    const startState: BranchStartState = {
      kind: "known",
      commits: [{ sha: "c0c0", author: ivyStart, date: "2026-09-01T00:00:00Z", message: "m0" }],
    };
    const offender = commit("d1d1", { author: { ...RAJ } });
    const descendant = commit("d2d2", {
      parents: ["d1d1"],
      author: { ...ivyStart, date: "2026-09-01T00:00:00Z" },
      message: "m0",
    });
    const { api, created } = apiOf([
      { totalCommits: 2, commits: [offender, descendant] },
      {
        totalCommits: 2,
        commits: [
          commit("r1", { author: { ...IVY } }),
          commit("r2", { parents: ["r1"], author: { ...ivyStart, date: "2026-09-01T00:00:00Z" }, message: "m0" }),
        ],
      },
    ]);
    const result = await runRewrite(api, { startState, requester: IVY });
    expect(result).toMatchObject({ kind: "rewritten", count: 1 });
    expect(created[1].parents).toEqual(["r1"]);
    expect(created[1].author).toEqual({ name: ivyStart.name, email: ivyStart.email, date: "2026-09-01T00:00:00Z" });
  });

  it("a boundary start state (the branch's pre-push head) keeps a human commit planted under the run's commits: never rebuilt, its author kept, only the run's commits above it rewritten", async () => {
    const human: IdentityPair = { name: "Priya Human", email: "priya@example.com" };
    const planted = commit("aaaa1111", { author: { ...human } });
    const runCommit = commit("bbbb2222", { parents: ["aaaa1111"], author: { ...RAJ } });
    const { api, created, moved } = apiOf([
      { totalCommits: 2, commits: [planted, runCommit] },
      {
        totalCommits: 2,
        commits: [planted, commit("r1", { parents: ["aaaa1111"], author: { ...IVY }, message: "msg bbbb2222" })],
      },
    ]);
    // The boundary is the push status line's abbreviated pre-push head.
    const result = await runRewrite(api, { startState: { kind: "boundary", sha: "aaaa111" }, requester: IVY });
    expect(result).toMatchObject({ kind: "rewritten", count: 1, tip: "r1" });
    // Only the run's commit was rebuilt — onto the planted commit's own sha —
    // and the planted commit keeps its author: no rebuild names its tree.
    expect(created).toEqual([
      {
        message: "msg bbbb2222",
        tree: "tree-bbbb2222",
        parents: ["aaaa1111"],
        author: { name: IVY.name, email: IVY.email, date: "2026-09-18T10:00:00Z" },
        committer: { name: BOT.name, email: BOT.email },
      },
    ]);
    expect(moved).toEqual([{ branch: "feat/x", sha: "r1" }]);
  });

  it("a boundary head no longer in the range, and one an abbreviation leaves ambiguous, are unreadable with no writes — history the run did not create is never rewritten below it", async () => {
    const gone = apiOf([{ totalCommits: 1, commits: [commit("bbbb2222", { author: { ...RAJ } })] }]);
    expect(await runRewrite(gone.api, { startState: { kind: "boundary", sha: "aaaa111" }, requester: IVY })).toEqual({
      kind: "unreadable",
      reason: expect.stringContaining("pre-push head aaaa111 is not in the compare"),
    });
    expect(gone.created).toHaveLength(0);
    expect(gone.moved).toHaveLength(0);

    const twins = apiOf([
      { totalCommits: 2, commits: [commit("aaaa1111"), commit("aaaa2222", { parents: ["aaaa1111"] })] },
    ]);
    expect(await runRewrite(twins.api, { startState: { kind: "boundary", sha: "aaaa" }, requester: IVY })).toEqual({
      kind: "unreadable",
      reason: expect.stringContaining("matches 2 commits"),
    });
    expect(twins.created).toHaveLength(0);
  });

  it("no binding and the flag off (no requester pair): a commit authored with the requester's own noreply pair is rewritten to the BOT pair", async () => {
    const { api, created } = apiOf([
      { totalCommits: 1, commits: [commit("a1b2", { author: { ...IVY } })] },
      { totalCommits: 1, commits: [commit("r1", { author: { ...BOT } })] },
    ]);
    const result = await runRewrite(api);
    expect(result).toMatchObject({ kind: "rewritten", count: 1 });
    expect(created[0].author).toEqual({ name: BOT.name, email: BOT.email, date: "2026-09-18T10:00:00Z" });
  });

  it("unreadable, no writes: over 300 commits; an unknown start state; a compare that cannot be read; a missing bot identity", async () => {
    const over = apiOf([{ totalCommits: 301, commits: [] }]);
    expect(await runRewrite(over.api)).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("301") });
    expect(over.created).toHaveLength(0);
    expect(over.moved).toHaveLength(0);

    const unknown = apiOf([{ totalCommits: 0, commits: [] }]);
    expect(await runRewrite(unknown.api, { startState: { kind: "unknown" } })).toMatchObject({
      kind: "unreadable",
      reason: expect.stringContaining("the read at attach failed"),
    });
    expect(unknown.reads()).toBe(0);

    // An unknown state that says why (no read was ever fired) keeps its own
    // reason: the refusal never claims a read that never ran.
    const neverRead = apiOf([{ totalCommits: 0, commits: [] }]);
    expect(
      await runRewrite(neverRead.api, { startState: { kind: "unknown", reason: "no read was attempted" } }),
    ).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("no read was attempted") });
    expect(neverRead.reads()).toBe(0);

    const failed = apiOf([undefined]);
    expect(await runRewrite(failed.api)).toMatchObject({ kind: "unreadable" });

    const noBot = apiOf([{ totalCommits: 0, commits: [] }]);
    expect(await runRewrite(noBot.api, { bot: undefined })).toMatchObject({ kind: "unreadable" });
    expect(noBot.reads()).toBe(0);
  });

  it("a tip that moved after two rebuilds is unreadable — the third disagreement gives up", async () => {
    const spoof = { totalCommits: 1, commits: [commit("a1b2", { author: { ...RAJ } })] };
    // Every re-read finds a fresh offending tip: two rebuilds are spent, the
    // third disagreement is unreadable.
    const { api, moved } = apiOf([spoof, spoof, spoof]);
    const result = await runRewrite(api, { requester: IVY });
    expect(result).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("moved twice") });
    expect(moved).toHaveLength(2);
  });

  it("a ruleset's 422 on the ref move is unreadable with the rule named", async () => {
    const { api } = apiOf([{ totalCommits: 1, commits: [commit("a1b2", { author: { ...RAJ } })] }]);
    api.forceMoveRef = async () => {
      throw new Error("ref move failed for feat/x: HTTP 422 force pushes are blocked by a ruleset");
    };
    const result = await runRewrite(api, { requester: IVY });
    expect(result).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("HTTP 422") });
  });
});

describe("readBranchStartState — the branch's commits over the base at attach (record 0062)", () => {
  it("a branch equal to its base is empty without a read; a 404 (a new branch) is empty; a read carries the fingerprints", async () => {
    const compare = vi.fn(async (): Promise<CompareResult | "missing" | undefined> => ({
      totalCommits: 1,
      commits: [commit("c0c0", { author: { name: "Ivy Person", email: "ivy@example.com" } })],
    }));
    expect(await readBranchStartState("acme/api", "main", "main", compare)).toEqual(EMPTY_START_STATE);
    expect(compare).not.toHaveBeenCalled();
    expect(await readBranchStartState("acme/api", "main", "feat/x", async () => "missing")).toEqual(EMPTY_START_STATE);
    expect(await readBranchStartState("acme/api", "main", "feat/x", compare)).toEqual({
      kind: "known",
      commits: [
        {
          sha: "c0c0",
          author: { name: "Ivy Person", email: "ivy@example.com" },
          date: "2026-09-18T10:00:00Z",
          message: "msg c0c0",
        },
      ],
    });
  });

  it("a failed read, and a range over 300 commits, are unknown — the rewrite then fails closed", async () => {
    expect(await readBranchStartState("acme/api", "main", "feat/x", async () => undefined)).toEqual({
      kind: "unknown",
    });
    expect(
      await readBranchStartState("acme/api", "main", "feat/x", async () => ({ totalCommits: 301, commits: [] })),
    ).toEqual({ kind: "unknown" });
    expect(
      await readBranchStartState("acme/api", "main", "feat/x", async () => {
        throw new Error("boom");
      }),
    ).toEqual({ kind: "unknown" });
  });
});
