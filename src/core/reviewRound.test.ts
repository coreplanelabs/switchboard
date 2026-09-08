import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "../agents/registry.js";
import { resetResidentProbeCache } from "../execution/factory.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
import {
  attachRoundWorkspace,
  checkPrHeadPreflight,
  guardAttachedHead,
  makeSystemComposer,
  releaseModeFor,
  runReviewPostStep,
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
  it("readonly agent → always; writable agent → if-clean", () => {
    expect(releaseModeFor(AGENTS.review, { hardStopped: false })).toBe("always");
    expect(releaseModeFor(AGENTS.coding, { hardStopped: false })).toBe("if-clean");
  });

  it("a hard stop forces always regardless of the agent", () => {
    expect(releaseModeFor(AGENTS.coding, { hardStopped: true })).toBe("always");
    expect(releaseModeFor(AGENTS.review, { hardStopped: true })).toBe("always");
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
      round: { threadKey: "t-ro", agent: AGENTS.review, repo: "acme/api", ref: "patch-1", headSha: HEAD },
      logKey: "t-ro",
    });
    expect(round.selection.resident).toBe(true);
    const attach = calls.find((c) => c.path === "/attach");
    expect(attach?.body).toMatchObject({ readonly: true, sha: HEAD });
    await round.release({ hardStopped: false });
    const detach = calls.find((c) => c.path === "/detach");
    expect(detach?.body).toMatchObject({ force: true });
  });

  it("a writable AgentDef yields a writable attach (no readonly flag), and release() detaches if-clean (no force)", async () => {
    const calls = residentStub({ ref: "main", sha: HEAD });
    const round = await attachRoundWorkspace({
      factory: factoryOptions(),
      round: { threadKey: "t-rw", agent: AGENTS.coding, repo: "acme/api", ref: "main" },
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
      round: { threadKey: "t-hard", agent: AGENTS.coding, repo: "acme/api", ref: "main" },
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
      round: { threadKey: "t-none", agent: AGENTS.general },
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
    expect(out).toEqual({ posted: true });
  });

  it("a non-review AgentDef never posts, even with a resolved PR and a verdict", async () => {
    const h = harness();
    const out = await runReviewPostStep({
      agent: AGENTS.coding,
      requestText: "fix acme/api#42",
      repoCtx: { repo: "acme/api", pr: 42 },
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
});
