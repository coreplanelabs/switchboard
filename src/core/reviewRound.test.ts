import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "../agents/registry.js";
import { reviewTargetBlock } from "./reviewTarget.js";
import { declaredProfile } from "../config/profile.js";
import { resetResidentProbeCache } from "../execution/factory.js";
import type { Executor } from "../execution/executor.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
import type { FollowUpTurnInput } from "./harness/contract.js";
import type { PrCommitList } from "./headMoved.js";
import type { RunEvent } from "./runEvents.js";
import { RunControl } from "./runRegistry/runControl.js";
import {
  attachRoundWorkspace,
  checkPrHeadPreflight,
  guardAttachedHead,
  makeSystemComposer,
  releaseModeFor,
  runReviewPostStep,
  settleReviewedHead,
  type SettleReviewedHeadInput,
} from "./reviewRound.js";

// Feature: docs/reference/specs/agent-ship.md — the review-round and coding-PR machinery
// extracted from dispatch() as callable units, each parameterized on an
// explicit AgentDef instead of the dispatch's top-level resolved agent, so a
// ship round can invoke them per child round. The
// dispatcher suites prove the plain paths byte-identical; the tests here
// prove the SEAMS: each unit is callable with an explicit agent, and the
// attach/release pairing follows that agent's toolset.

const HEAD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";
const OTHER = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
const THIRD = "1111111111111111111111111111111111111111";

describe("releaseModeFor (per-agent attach/release pairing)", () => {
  it("a read identity → always; a writing one → if-idle (released unless a command is still in flight)", () => {
    expect(releaseModeFor("read", { hardStopped: false })).toBe("always");
    expect(releaseModeFor("write", { hardStopped: false })).toBe("if-idle");
    expect(releaseModeFor("none", { hardStopped: false })).toBe("if-idle");
  });

  it("a hard stop forces always regardless of the identity", () => {
    expect(releaseModeFor("write", { hardStopped: true })).toBe("always");
    expect(releaseModeFor("read", { hardStopped: true })).toBe("always");
  });

  it("a command still in flight at the run's end forces always too — the workspace is torn down as after a hard stop, never held behind the hung command — and so does a gate bypass, whatever is in flight: what ran in the workspace was never vetted", () => {
    expect(releaseModeFor("write", { hardStopped: false, commandInFlight: true })).toBe("always");
    expect(releaseModeFor("none", { hardStopped: false, commandInFlight: true })).toBe("always");
    expect(releaseModeFor("write", { hardStopped: false, gateBypassed: true })).toBe("always");
    expect(releaseModeFor("write", { hardStopped: false, commandInFlight: false, gateBypassed: false })).toBe(
      "if-idle",
    );
  });
});

describe("attachRoundWorkspace (explicit AgentDef → attach + paired release)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetResidentProbeCache();
  });

  /** A resident backend stub recording each route's request body. */
  function residentStub(attached: { ref: string; sha: string }) {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ path, body });
        if (path === "/status") return new Response(JSON.stringify({ state: "warm", reason: "" }), { status: 200 });
        if (path === "/attach") {
          return new Response(JSON.stringify({ ...attached, workspace: "/workspace/threads/t/x", user: "worker1" }), {
            status: 200,
          });
        }
        if (path === "/detach") return new Response(JSON.stringify({ released: true }), { status: 200 });
        throw new Error(`unexpected fetch: ${String(url)}`);
      }),
    );
    return calls;
  }

  function factoryOptions() {
    const dir = mkdtempSync(join(tmpdir(), "swb-round-"));
    return {
      execution: { resident: { baseUrl: "https://resident.example" } },
      workspaceDir: join(dir, "workspaces"),
      dataDir: dir,
    };
  }

  it("a readonly AgentDef yields a readonly resident attach, and release() detaches with force (mode always)", async () => {
    const calls = residentStub({ ref: "patch-1", sha: HEAD });
    const round = await attachRoundWorkspace({
      factory: factoryOptions(),
      round: {
        threadKey: "t-ro",
        agent: AGENTS.review,
        profile: declaredProfile(AGENTS.review),
        repo: "acme/api",
        ref: "patch-1",
        headSha: HEAD,
      },
      logKey: "t-ro",
    });
    expect(round.selection.resident).toBe(true);
    const attach = calls.find((c) => c.path === "/attach");
    expect(attach?.body).toMatchObject({ readonly: true, sha: HEAD });
    await round.release({ hardStopped: false });
    const detach = calls.find((c) => c.path === "/detach");
    expect(detach?.body).toMatchObject({ force: true });
  });

  it("a writable AgentDef yields a writable attach (no readonly flag), and release() detaches if-idle (no force)", async () => {
    const calls = residentStub({ ref: "main", sha: HEAD });
    const round = await attachRoundWorkspace({
      factory: factoryOptions(),
      round: {
        threadKey: "t-rw",
        agent: AGENTS.coding,
        profile: declaredProfile(AGENTS.coding),
        repo: "acme/api",
        ref: "main",
      },
      logKey: "t-rw",
    });
    const attach = calls.find((c) => c.path === "/attach");
    expect(attach?.body).not.toHaveProperty("readonly");
    await round.release({ hardStopped: false });
    const detach = calls.find((c) => c.path === "/detach");
    expect(detach?.body).toMatchObject({ force: false });
  });

  it("a hard stop releases a writable round's workspace with force (mode always)", async () => {
    const calls = residentStub({ ref: "main", sha: HEAD });
    const round = await attachRoundWorkspace({
      factory: factoryOptions(),
      round: {
        threadKey: "t-hard",
        agent: AGENTS.coding,
        profile: declaredProfile(AGENTS.coding),
        repo: "acme/api",
        ref: "main",
      },
      logKey: "t-hard",
    });
    await round.release({ hardStopped: true });
    expect(calls.find((c) => c.path === "/detach")?.body).toMatchObject({ force: true });
  });

  it("release() is a no-op when the executor holds nothing releasable (a no-repo agent)", async () => {
    const round = await attachRoundWorkspace({
      factory: {
        workspaceDir: mkdtempSync(join(tmpdir(), "swb-null-")),
        dataDir: mkdtempSync(join(tmpdir(), "swb-null-")),
      },
      round: { threadKey: "t-none", agent: AGENTS.general, profile: declaredProfile(AGENTS.general) },
      logKey: "t-none",
    });
    await expect(round.release({ hardStopped: false })).resolves.toBeUndefined();
  });
});

describe("checkPrHeadPreflight (explicit AgentDef, before any model call)", () => {
  // The unit is pure: refusing here structurally precedes any attach or
  // provider call — the dispatcher (and a ship round) returns on ok:false
  // before touching either.
  it("a review AgentDef with a resolved PR but no usable head refuses, naming the PR", () => {
    const r = checkPrHeadPreflight({
      agent: AGENTS.review,
      requestText: "review https://github.com/acme/api/pull/42",
      repoCtx: { repo: "acme/api", pr: 42, headSha: undefined },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.where).toBe("acme/api#42");
      expect(r.reply).toContain("not started");
      expect(r.reply).toContain("acme/api#42");
    }
  });

  it("an unreachable bound PR refuses the same way", () => {
    const r = checkPrHeadPreflight({
      agent: AGENTS.review,
      requestText: "take another look",
      repoCtx: { repo: "acme/api", prUnpostable: { number: 7, reason: "unreachable" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.where).toBe("acme/api#7");
  });

  it("a resolved head, a slack-only opt-out, or a non-review AgentDef all pass", () => {
    expect(
      checkPrHeadPreflight({
        agent: AGENTS.review,
        requestText: "review it",
        repoCtx: { repo: "acme/api", pr: 42, headSha: HEAD },
      }).ok,
    ).toBe(true);
    expect(
      checkPrHeadPreflight({
        agent: AGENTS.review,
        requestText: "review it — slack only",
        repoCtx: { repo: "acme/api", pr: 42 },
      }).ok,
    ).toBe(true);
    expect(
      checkPrHeadPreflight({ agent: AGENTS.coding, requestText: "fix it", repoCtx: { repo: "acme/api", pr: 42 } }).ok,
    ).toBe(true);
  });
});

describe("guardAttachedHead (before any model call)", () => {
  // Like the pre-flight, the guard runs strictly before the round's model
  // turn: a "refused" outcome means the caller releases and replies without
  // ever invoking a provider — no provider handle even reaches the unit.
  it("attached at the PR head → verified, no lookup", async () => {
    const fetchPrHead = vi.fn(async () => THIRD);
    const r = await guardAttachedHead({
      pr: { repo: "acme/api", number: 42 },
      expectedHeadSha: HEAD,
      attached: { sha: HEAD, ref: "patch-1" },
      fallbackRef: undefined,
      fetchPrHead,
      logKey: "t",
    });
    expect(r).toEqual({ outcome: "verified" });
    expect(fetchPrHead).not.toHaveBeenCalled();
  });

  it("attached at another commit that IS the PR's current head → adopted with that head", async () => {
    const r = await guardAttachedHead({
      pr: { repo: "acme/api", number: 42 },
      expectedHeadSha: HEAD,
      attached: { sha: OTHER, ref: "patch-1" },
      fallbackRef: undefined,
      fetchPrHead: async () => OTHER,
      logKey: "t",
    });
    expect(r).toEqual({ outcome: "adopted", headSha: OTHER });
  });

  it("attach-head mismatch (current head is neither) → refused with the named shas, before any model call", async () => {
    const r = await guardAttachedHead({
      pr: { repo: "acme/api", number: 42 },
      expectedHeadSha: HEAD,
      attached: { sha: OTHER, ref: "patch-1" },
      fallbackRef: undefined,
      fetchPrHead: async () => THIRD,
      logKey: "t",
    });
    expect(r.outcome).toBe("refused");
    if (r.outcome === "refused") {
      expect(r.reply).toContain("acme/api#42");
      expect(r.reply).toContain(`\`${OTHER.slice(0, 7)}\``);
      expect(r.reply).toContain(`\`${HEAD.slice(0, 7)}\``);
      expect(r.reply).toMatch(/re-send/i);
    }
  });

  it("a current-head lookup that throws refuses too (unknown proves nothing)", async () => {
    const r = await guardAttachedHead({
      pr: { repo: "acme/api", number: 42 },
      expectedHeadSha: HEAD,
      attached: { sha: OTHER, ref: undefined },
      fallbackRef: "patch-1",
      fetchPrHead: async () => {
        throw new Error("GitHub down");
      },
      logKey: "t",
    });
    expect(r.outcome).toBe("refused");
    if (r.outcome === "refused") expect(r.reply).toContain("`patch-1`"); // the fallback ref names the branch
  });

  it("a malformed or absent sha on either side proves nothing → unverified", async () => {
    const fetchPrHead = vi.fn(async () => HEAD);
    const base = { pr: { repo: "acme/api", number: 42 }, fallbackRef: undefined, fetchPrHead, logKey: "t" };
    expect(
      await guardAttachedHead({ ...base, expectedHeadSha: undefined, attached: { sha: OTHER, ref: "b" } }),
    ).toEqual({ outcome: "unverified" });
    expect(
      await guardAttachedHead({ ...base, expectedHeadSha: HEAD, attached: { sha: "not-a-sha", ref: "b" } }),
    ).toEqual({ outcome: "unverified" });
    expect(fetchPrHead).not.toHaveBeenCalled();
  });
});

describe("makeSystemComposer (head-pinned composition with an explicit AgentDef)", () => {
  const blocks = { memory: undefined, config: undefined, instructions: undefined, skills: undefined };

  it("no blocks, no resident, no PR target → the agent's own prompt, byte-identical", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      prTarget: undefined,
      blocks,
    });
    expect(compose({ sha: undefined, verified: false })).toBe(AGENTS.general.system);
  });

  // docs/reference/specs/session-log.md item 10: what the session already knows
  // is advisory context like memory, and sits right after it.
  it("the notes block follows the memory block and precedes the config block; absent, the prompt is untouched", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      prTarget: undefined,
      blocks: { ...blocks, memory: "MEMORY", notes: "NOTES", config: "CONFIG" },
    });
    expect(compose({ sha: undefined, verified: false })).toBe(`MEMORY\n\nNOTES\n\nCONFIG\n\n${AGENTS.general.system}`);
    const without = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      prTarget: undefined,
      blocks: { ...blocks, memory: "MEMORY", config: "CONFIG" },
    });
    expect(without({ sha: undefined, verified: false })).toBe(`MEMORY\n\nCONFIG\n\n${AGENTS.general.system}`);
  });

  it("the thread's artifacts block follows the notes block and precedes the config block; without notes it follows memory (session-log item 9)", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      prTarget: undefined,
      blocks: { ...blocks, memory: "MEMORY", notes: "NOTES", artifacts: "ARTIFACTS", config: "CONFIG" },
    });
    expect(compose({ sha: undefined, verified: false })).toBe(
      `MEMORY\n\nNOTES\n\nARTIFACTS\n\nCONFIG\n\n${AGENTS.general.system}`,
    );
    const withoutNotes = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      prTarget: undefined,
      blocks: { ...blocks, memory: "MEMORY", artifacts: "ARTIFACTS", config: "CONFIG" },
    });
    expect(withoutNotes({ sha: undefined, verified: false })).toBe(
      `MEMORY\n\nARTIFACTS\n\nCONFIG\n\n${AGENTS.general.system}`,
    );
  });

  it("a PR review target pins the REVIEW TARGET block to the given head and recomposes at a new one", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.review,
      resident: true,
      repo: "acme/api",
      workspace: "/workspace/threads/t/x",
      prTarget: { repo: "acme/api", pr: 42, ref: "patch-1", baseRef: "main" },
      blocks,
    });
    const first = compose({ sha: HEAD, verified: true });
    expect(first).toContain(HEAD);
    expect(first).toContain("acme/api");
    const moved = compose({ sha: OTHER, verified: false });
    expect(moved).toContain(OTHER);
    expect(moved).not.toContain(HEAD);
  });

  it("a unit contract block sits right after the REVIEW TARGET block and before the trailing skills; without a target it follows the agent prompt", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.review,
      resident: true,
      repo: "acme/api",
      workspace: "/workspace/threads/t/x",
      prTarget: { repo: "acme/api", pr: 42, ref: "patch-1", baseRef: "main" },
      contract: "## Contract\n\nTHE BLOCK",
      blocks: { ...blocks, skills: "SKL" },
    });
    const system = compose({ sha: HEAD, verified: true });
    const target = system.indexOf("REVIEW TARGET (resolved by Switchboard");
    const contract = system.indexOf("## Contract\n\nTHE BLOCK");
    expect(target).toBeGreaterThan(0);
    expect(contract).toBeGreaterThan(target);
    expect(system.endsWith("## Contract\n\nTHE BLOCK\n\nSKL")).toBe(true);
    const bare = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      prTarget: undefined,
      contract: "## Contract\n\nTHE BLOCK",
      blocks,
    });
    expect(bare({ sha: undefined, verified: false })).toBe(`${AGENTS.general.system}\n\n## Contract\n\nTHE BLOCK`);
  });

  it("blocks lead in order (memory, config, instructions) and skills trail the agent prompt", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      prTarget: undefined,
      blocks: { memory: "MEM", config: "CFG", instructions: "INS", skills: "SKL" },
    });
    const system = compose({ sha: undefined, verified: false });
    expect(system).toBe(`MEM\n\nCFG\n\nINS\n\n${AGENTS.general.system}\n\nSKL`);
  });
});

describe("runReviewPostStep (explicit AgentDef decides the post)", () => {
  const answer = "Looks solid.";
  const verdict = { verdict: "approve" as const, summary: "solid change", head: HEAD };

  function harness() {
    const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const replies: string[] = [];
    return {
      posts,
      replies,
      post: async (target: ReviewCommentTarget, body: string) => void posts.push({ target, body }),
      reply: async (text: string) => void replies.push(text),
    };
  }

  it("a review AgentDef with a verified head posts, pinned to it — and reports { posted: true }", async () => {
    const h = harness();
    const out = await runReviewPostStep({
      agent: AGENTS.review,
      requestText: "review acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42 },
      heads: { reviewHead: HEAD, observedHead: HEAD },
      verdict,
      digest: undefined,
      answer,
      carried: undefined,
      hardStopped: false,
      post: h.post,
      fetchPrHead: async () => HEAD,
      reply: h.reply,
      logKey: "t",
    });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].target).toMatchObject({ repo: "acme/api", number: 42, commitId: HEAD });
    expect(h.posts[0].body.startsWith("LGTM:")).toBe(true);
    expect(out).toEqual({ posted: true, target: { repo: "acme/api", number: 42 }, head: HEAD, verdict: "approve" });
  });

  it("a non-review AgentDef never posts, even with a resolved PR and a verdict", async () => {
    const h = harness();
    const out = await runReviewPostStep({
      agent: AGENTS.coding,
      requestText: "fix acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42 },
      heads: { reviewHead: HEAD, observedHead: HEAD },
      verdict,
      digest: undefined,
      answer,
      carried: undefined,
      hardStopped: false,
      post: h.post,
      fetchPrHead: async () => HEAD,
      reply: h.reply,
      logKey: "t",
    });
    expect(h.posts).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
    expect(out).toMatchObject({ posted: false });
  });

  it("the reviewed-head guard refuses a strayed head fail-closed: no post, the thread told both shas, the outcome carries the reason", async () => {
    const h = harness();
    const out = await runReviewPostStep({
      agent: AGENTS.review,
      requestText: "review acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42 },
      heads: { reviewHead: HEAD, observedHead: OTHER },
      verdict,
      digest: undefined,
      answer,
      carried: undefined,
      hardStopped: false,
      post: h.post,
      fetchPrHead: async () => HEAD,
      reply: h.reply,
      logKey: "t",
    });
    expect(h.posts).toHaveLength(0);
    expect(h.replies.some((r) => r.includes("Slack-only"))).toBe(true);
    expect(out).toEqual({ posted: false, reason: expect.stringContaining("is not the PR head") });
  });

  it("a post that throws comes back { posted: false, reason } — ship's merge-ready gate consumes it; the thread is told Slack-only", async () => {
    const h = harness();
    const out = await runReviewPostStep({
      agent: AGENTS.review,
      requestText: "review acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42 },
      heads: { reviewHead: HEAD, observedHead: HEAD },
      verdict,
      digest: undefined,
      answer,
      carried: undefined,
      hardStopped: false,
      post: async () => {
        throw new Error("HTTP 502 bad gateway");
      },
      fetchPrHead: async () => HEAD,
      reply: h.reply,
      logKey: "t",
    });
    expect(out).toEqual({ posted: false, reason: "HTTP 502 bad gateway" });
    expect(h.replies.some((r) => r.includes("Slack-only"))).toBe(true);
  });

  it("a hard-stopped round posts nothing and says nothing — and reports posted: false", async () => {
    const h = harness();
    const out = await runReviewPostStep({
      agent: AGENTS.review,
      requestText: "review acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42 },
      heads: { reviewHead: HEAD, observedHead: HEAD },
      verdict,
      digest: undefined,
      answer,
      carried: undefined,
      hardStopped: true,
      post: h.post,
      fetchPrHead: async () => HEAD,
      reply: h.reply,
      logKey: "t",
    });
    expect(h.posts).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
    expect(out).toMatchObject({ posted: false });
  });

  // Feature: docs/reference/specs/agent-review.md item 15 — the digest-coverage
  // guard. A 41-file PR whose digest covered 13 files was approved; the head
  // guard could not see it (the head was right), so the post-step now holds the
  // digest's totals against the PR's size from GitHub.
  describe("digest-coverage guard (item 15)", () => {
    const prSize = { changedFiles: 41, additions: 2459, deletions: 579 };
    const base = (h: ReturnType<typeof harness>) => ({
      agent: AGENTS.review,
      requestText: "review acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42, prSize },
      heads: { reviewHead: HEAD, observedHead: HEAD },
      verdict,
      answer,
      carried: undefined,
      hardStopped: false,
      post: h.post,
      fetchPrHead: async () => HEAD,
      reply: h.reply,
      logKey: "t",
    });

    it("a digest that covered less than the PR → no post, the thread told 'digest covered N of M files', the outcome carries the reason", async () => {
      const h = harness();
      const out = await runReviewPostStep({
        ...base(h),
        digest: { complete: true, base: "origin/main", totals: { files: 13, additions: 144, deletions: 53 } },
      });
      expect(h.posts).toHaveLength(0);
      expect(h.replies).toHaveLength(1);
      expect(h.replies[0]).toContain("Review not posted to acme/api#42");
      expect(h.replies[0]).toContain("digest covered 13 of 41 files");
      expect(h.replies[0]).toContain("Slack-only");
      expect(out).toMatchObject({ posted: false });
      expect((out as { reason: string }).reason).toContain("digest covered 13 of 41 files");
    });

    it("a digest that could not state its totals (its listing was cut) → no post, the reason named", async () => {
      const h = harness();
      const out = await runReviewPostStep({
        ...base(h),
        digest: { complete: false, base: "origin/main", reason: "the file listing exceeded the executor's output cap" },
      });
      expect(h.posts).toHaveLength(0);
      expect(h.replies[0]).toContain("exceeded the executor's output cap");
      expect(out).toMatchObject({ posted: false });
    });

    it("a digest that matches the PR posts as usual, pinned to the head", async () => {
      const h = harness();
      const out = await runReviewPostStep({
        ...base(h),
        digest: { complete: true, base: "origin/main", totals: { files: 41, additions: 2459, deletions: 579 } },
      });
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0].target).toMatchObject({ commitId: HEAD });
      expect(h.replies).toHaveLength(0);
      expect(out).toMatchObject({ posted: true, head: HEAD });
    });

    it("no digest, or no PR size to compare against → nothing to hold the review to; it posts", async () => {
      const h = harness();
      await runReviewPostStep({ ...base(h), digest: undefined });
      await runReviewPostStep({
        ...base(h),
        repoCtx: { repo: "acme/api", pr: 42 },
        digest: { complete: true, base: "origin/main", totals: { files: 13, additions: 144, deletions: 53 } },
      });
      expect(h.posts).toHaveLength(2);
      expect(h.replies).toHaveLength(0);
    });

    it("the head guard is asked first: a strayed head is refused as a head mismatch, whatever the digest says", async () => {
      const h = harness();
      await runReviewPostStep({
        ...base(h),
        heads: { reviewHead: HEAD, observedHead: "f".repeat(40) },
        digest: { complete: true, base: "origin/main", totals: { files: 13, additions: 144, deletions: 53 } },
      });
      expect(h.posts).toHaveLength(0);
      expect(h.replies).toHaveLength(1);
      expect(h.replies[0]).toContain("is not the PR head");
      expect(h.replies[0]).not.toContain("digest covered");
    });
  });

  // docs/reference/specs/agent-review.md item 18 — the post is a recorded fact of
  // the run: the step knows the outcome in-process and publishes it onto the
  // run's stream, so the record a coordinator reads the second the run
  // finishes says whether the verdict landed on the pull request — without
  // asking GitHub, whose review list can lag the post it just accepted.
  describe("the post as a recorded fact (item 18)", () => {
    const base = (h: ReturnType<typeof harness>, events: RunEvent[]) => ({
      agent: AGENTS.review,
      requestText: "review acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42 },
      heads: { reviewHead: HEAD, observedHead: HEAD },
      verdict,
      digest: undefined,
      answer,
      carried: undefined,
      hardStopped: false,
      post: h.post,
      fetchPrHead: async () => HEAD,
      reply: h.reply,
      publish: (e: RunEvent) => void events.push(e),
      logKey: "t",
    });

    it("a successful post publishes `review_posted` with the pull request, the pinned head and the verdict — the same facts the outcome carries", async () => {
      const h = harness();
      const events: RunEvent[] = [];
      const out = await runReviewPostStep(base(h, events));
      expect(out).toEqual({ posted: true, target: { repo: "acme/api", number: 42 }, head: HEAD, verdict: "approve" });
      expect(events).toEqual([
        { type: "review_posted", repo: "acme/api", number: 42, head: HEAD, verdict: "approve", at: expect.any(Number) },
      ]);
    });

    it("a review carried across a rebase records the head it was pinned to — the current one — not the one it read", async () => {
      const h = harness();
      const events: RunEvent[] = [];
      const out = await runReviewPostStep({
        ...base(h, events),
        carried: { reviewed: HEAD, current: OTHER, commits: 2 },
        fetchPrHead: async () => OTHER,
      });
      expect(out).toMatchObject({ posted: true, head: OTHER });
      expect(events[0]).toMatchObject({ type: "review_posted", head: OTHER });
    });

    it("the carried-review note is an acknowledgement (routing-and-config item 28): one line through `ack` when the caller gives one, never through `reply`; without `ack` it falls back to `reply`", async () => {
      const h = harness();
      const acks: string[] = [];
      await runReviewPostStep({
        ...base(h, []),
        carried: { reviewed: HEAD, current: OTHER, commits: 2 },
        fetchPrHead: async () => OTHER,
        ack: async (text: string) => void acks.push(text),
      });
      expect(acks).toEqual([
        `ℹ️ acme/api#42: review carried to ${OTHER.slice(0, 7)} — a rebase of the same 2 commits (reviewed ${HEAD.slice(0, 7)}).`,
      ]);
      expect(h.replies).toEqual([]);
      const bare = harness();
      await runReviewPostStep({
        ...base(bare, []),
        carried: { reviewed: HEAD, current: OTHER, commits: 2 },
        fetchPrHead: async () => OTHER,
      });
      expect(bare.replies).toHaveLength(1);
      expect(bare.replies[0]).toContain("review carried to");
    });

    it("a skipped post (the reviewed-head guard) publishes a `review_not_posted` note carrying the reason the outcome carries — a recorded skip, distinguishable from a post GitHub has not surfaced yet", async () => {
      const h = harness();
      const events: RunEvent[] = [];
      const out = await runReviewPostStep({ ...base(h, events), heads: { reviewHead: HEAD, observedHead: OTHER } });
      expect(out).toEqual({ posted: false, reason: expect.stringContaining("is not the PR head") });
      expect(events).toEqual([
        {
          type: "run_note",
          kind: "review_not_posted",
          summary: `review not posted to acme/api#42: ${(out as { reason: string }).reason}`,
          at: expect.any(Number),
        },
      ]);
    });

    it("a post GitHub refused publishes the same note with GitHub's reason", async () => {
      const h = harness();
      const events: RunEvent[] = [];
      const out = await runReviewPostStep({
        ...base(h, events),
        post: async () => {
          throw new Error("HTTP 502 bad gateway");
        },
      });
      expect(out).toEqual({ posted: false, reason: "HTTP 502 bad gateway" });
      expect(events).toEqual([
        {
          type: "run_note",
          kind: "review_not_posted",
          summary: "review not posted to acme/api#42: HTTP 502 bad gateway",
          at: expect.any(Number),
        },
      ]);
    });

    it("a review with no pull request to post to records the skip without a target; a non-review round and a hard-stopped round publish nothing", async () => {
      const noPr = harness();
      const noPrEvents: RunEvent[] = [];
      const out = await runReviewPostStep({ ...base(noPr, noPrEvents), repoCtx: { repo: "acme/api" } });
      expect(out).toEqual({ posted: false, reason: "no PR resolved" });
      expect(noPrEvents).toEqual([
        {
          type: "run_note",
          kind: "review_not_posted",
          summary: "review not posted: no PR resolved",
          at: expect.any(Number),
        },
      ]);

      const coding = harness();
      const codingEvents: RunEvent[] = [];
      await runReviewPostStep({ ...base(coding, codingEvents), agent: AGENTS.coding, requestText: "fix acme/api#42" });
      expect(codingEvents).toEqual([]);

      const stopped = harness();
      const stoppedEvents: RunEvent[] = [];
      await runReviewPostStep({ ...base(stopped, stoppedEvents), hardStopped: true });
      expect(stoppedEvents).toEqual([]);
    });

    it("without a `publish` seam the step still answers the same outcome — the plain caller's shape is unchanged", async () => {
      const h = harness();
      const { publish: _publish, ...input } = base(h, []);
      expect(await runReviewPostStep(input)).toMatchObject({ posted: true, head: HEAD });
    });
  });
});

// agent-review.md item 12 + harness-pi.md item 14: a substantive head move's
// ONE more turn is a `prompt` on the run's own pi session — the seam the run
// stage hands over (`followUp`) — with the follow-up text naming the new head,
// the turn's own verdict capture, and the settle around it (worktree moved
// first, head re-probed after). A round with no session left (a `finish` plan)
// keeps the verdict for the head it reviewed and says so.
describe("settleReviewedHead — the head-move re-review", () => {
  const list = (subjects: string[]): PrCommitList => ({
    commits: subjects.map((message, i) => ({ sha: `${i + 1}`.repeat(40), message })),
    files: ["src/x.ts"],
    filesTruncated: false,
  });
  /** A settle whose PR moved substantively under the review: reviewed `HEAD`,
   *  the PR now at `OTHER` with one more commit; a movable executor whose
   *  `rev-parse HEAD` follows the move. */
  function moved(turn: Partial<SettleReviewedHeadInput["turn"]> = {}) {
    let head = HEAD;
    const moves: string[] = [];
    const executor = {
      exec: async (cmd: string) => (cmd.includes("rev-parse") ? `${head}\n` : ""),
      moveTo: async (sha: string) => {
        moves.push(sha);
        head = sha;
        return { sha };
      },
    } as unknown as Executor;
    const events: RunEvent[] = [];
    const replies: string[] = [];
    const labels: string[] = [];
    const input: SettleReviewedHeadInput = {
      pr: { repo: "acme/api", number: 42 },
      baseRef: "main",
      reviewHead: HEAD,
      verdict: { verdict: "approve", summary: "ok", head: HEAD, findings: [] },
      answer: "First review: approve.",
      messages: [{ role: "user", content: [{ type: "text", text: "review acme/api#42" }] }],
      executor,
      turn: {
        agent: AGENTS.review,
        toolContext: { executor },
        onEvent: (e) => void events.push(e),
        control: new RunControl(),
        ...turn,
      },
      fetchPrHead: async () => OTHER,
      fetchPrCommits: async ({ sha }) =>
        sha === HEAD ? list(["feat: the change"]) : list(["feat: the change", "fix: review nits"]),
      preReviewStopped: () => false,
      notify: { reply: async (t) => void replies.push(t), headMoved: (s) => void labels.push(s) },
      logKey: "t",
    };
    return { input, executor, events, replies, labels, moves };
  }

  it("a substantive move's one more turn is a prompt on the run's session: the worktree moved first, the follow-up text as the appended user turn, the round's budget, the turn's own verdict capture, the head re-probed after", async () => {
    const followUp = vi.fn(async (input: FollowUpTurnInput) => {
      // the relayed submit_verdict, run in the bot under THIS turn's context
      input.toolContext.onVerdict?.({
        verdict: "request_changes",
        summary: "the new test is wrong",
        head: OTHER,
        findings: [],
      });
      return "Second review: the new test is wrong.";
    });
    const w = moved({ followUp });
    const out = await settleReviewedHead(w.input);
    expect(w.moves).toEqual([OTHER]);
    expect(followUp).toHaveBeenCalledTimes(1);
    const input = followUp.mock.calls[0][0];
    expect(input.text).toContain("moved from e8e43f4 to d75b5a5");
    expect(input.text).toContain("Switchboard has already moved your worktree to d75b5a5");
    expect(input.text).toContain("- 2222222 fix: review nits");
    expect(input.maxTurns).toBe(AGENTS.review.maxTurns);
    expect(input.maxMinutes).toBe(AGENTS.review.maxMinutes);
    expect(input.toolContext.executor).toBe(w.executor);
    // the round's transcript grew: the first review, then the follow-up
    expect(w.input.messages).toHaveLength(3);
    expect(w.input.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "First review: approve." }],
    });
    expect(w.input.messages[2]).toEqual({ role: "user", content: [{ type: "text", text: input.text }] });
    // the settle's outcome: the second answer and verdict, the new head, the observed head re-probed after the turn
    expect(out).toEqual({
      answer: "Second review: the new test is wrong.",
      verdict: expect.objectContaining({ verdict: "request_changes", head: OTHER }),
      reviewHead: OTHER,
      observedHead: OTHER,
      carried: undefined,
    });
    // the same notes around it
    expect(w.events).toEqual([expect.objectContaining({ type: "run_note", kind: "head_moved" })]);
    expect(w.labels).toEqual(["head moved → d75b5a5"]);
    expect(w.replies[0]).toContain("🔀 acme/api#42 moved during the run");
  });

  it("a follow-up turn pi refuses fails the settle: the throw propagates to the run, nothing is swallowed", async () => {
    const w = moved({
      followUp: async () => {
        throw new Error("pi refused the prompt: no reason");
      },
    });
    await expect(settleReviewedHead(w.input)).rejects.toThrow("pi refused the prompt");
    expect(w.moves).toEqual([OTHER]); // the worktree had moved before the turn was asked for
  });

  // A `finish` plan (run-history item 37): the loop answered before a bot
  // restart and its pi is gone, so a move it finds has no session to re-review
  // on. The verdict stands for the head it reviewed, the record says so, and
  // the post gate pins it there (agent-review item 10).
  it("without a session to prompt (a finish plan) a substantive move is not re-reviewed: no worktree move, a head_moved note saying the session is gone, the verdict and the reviewed head kept, the observed head re-read", async () => {
    const w = moved();
    const out = await settleReviewedHead(w.input);
    expect(w.moves).toEqual([]);
    expect(w.replies).toEqual([]);
    expect(w.labels).toEqual([]);
    expect(w.events).toEqual([
      expect.objectContaining({
        type: "run_note",
        kind: "head_moved",
        summary: expect.stringMatching(
          /not re-reviewed: the loop answered before a restart and its session is gone; the verdict stands for e8e43f4/,
        ),
      }),
    ]);
    expect(out).toEqual({
      answer: "First review: approve.",
      verdict: expect.objectContaining({ verdict: "approve", head: HEAD }),
      reviewHead: HEAD,
      observedHead: HEAD,
      carried: undefined,
    });
    expect(w.input.messages).toHaveLength(1); // nothing appended: no turn was asked
  });
});

// Feature: docs/reference/specs/execution.md item 26 — a seeded sandbox gets the
// agent's seeded variant naming the checkout, and a review's REVIEW TARGET
// block its seeded branch; a resident run is never seeded, and resident wins.
describe("makeSystemComposer — the seeded sandbox", () => {
  const blocks = { memory: undefined, config: undefined, instructions: undefined, skills: undefined };

  it("swaps in the seeded variant and names the checkout and the repository", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.coding,
      resident: false,
      repo: "acme/api",
      workspace: undefined,
      seeded: { workspace: "/workspace/checkout" },
      prTarget: undefined,
      blocks,
    });
    const system = compose({ sha: undefined, verified: false });
    expect(system.startsWith(AGENTS.coding.seededSystem!)).toBe(true);
    expect(system).toContain("Target repository: acme/api.");
    expect(system).toContain("cd /workspace/checkout");
    expect(system).not.toContain(AGENTS.coding.system);
  });

  it("a seeded review carries the REVIEW TARGET block's seeded branch — no clone, the checkout named, the head check first", () => {
    const compose = makeSystemComposer({
      agent: AGENTS.review,
      resident: false,
      repo: "acme/api",
      workspace: undefined,
      seeded: { workspace: "/workspace/checkout" },
      prTarget: { repo: "acme/api", pr: 42, ref: "patch-1", baseRef: "main" },
      blocks,
    });
    const system = compose({ sha: "e".repeat(40), verified: false });
    expect(system).toContain(AGENTS.review.seededSystem!);
    expect(system).toContain(
      reviewTargetBlock({
        repo: "acme/api",
        pr: 42,
        ref: "patch-1",
        baseRef: "main",
        headSha: "e".repeat(40),
        resident: false,
        seeded: { workspace: "/workspace/checkout" },
      }),
    );
    expect(system).not.toContain("gh pr checkout");
  });

  it("resident wins: a seeded flag beside resident is ignored, and without a seeded variant the agent's own prompt stands", () => {
    const both = makeSystemComposer({
      agent: AGENTS.coding,
      resident: true,
      repo: "acme/api",
      workspace: "/workspace/threads/t/main",
      seeded: { workspace: "/workspace/checkout" },
      prTarget: undefined,
      blocks,
    })({ sha: undefined, verified: false });
    expect(both.startsWith(AGENTS.coding.residentSystem!)).toBe(true);
    const general = makeSystemComposer({
      agent: AGENTS.general,
      resident: false,
      repo: undefined,
      workspace: undefined,
      seeded: { workspace: "/workspace/checkout" },
      prTarget: undefined,
      blocks,
    })({ sha: undefined, verified: false });
    expect(general).toBe(AGENTS.general.system);
  });
});
