import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoFromThread, resolveRepoContext } from "./repoContext.js";

// Feature: features/resident-repos.md — U7 repo/ref resolution BEFORE the
// model turn: explicit signals in the current message (owner/name slug,
// github.com repo/PR URL, conservative branch phrasing) → the thread's
// previously-established repo (derived from history, restart-safe, never
// stored) → none. Ref extraction is conservative by design (KTD6: binding is
// explicit-or-ask-once, never a silent guess): when in doubt the ref stays
// undefined and the attach path asks. PR head refs come from the GitHub REST
// API (never a gh shell-out — AGENTS.md invariant 5); all fetches are mocked.

function stubFetch(...responses: Array<{ status?: number; body?: unknown; reject?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
    if (next.reject) throw new TypeError(next.reject);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const msg = (text: string) => ({ text });

beforeEach(() => {
  // Deterministic credential path: no GitHub App mint, no ambient GH_TOKEN.
  vi.stubEnv("GITHUB_APP_ID", "");
  vi.stubEnv("GH_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveRepoContext: explicit signals in the current message", () => {
  it("owner/name slug + 'on branch X' phrasing", async () => {
    const { fn } = stubFetch();
    await expect(
      resolveRepoContext(msg("fix the bug in coreplanelabs/switchboard on branch fix/x"), []),
    ).resolves.toEqual({ repo: "coreplanelabs/switchboard", ref: "fix/x" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("'on <well-known>' binds the ref; trailing punctuation on the slug is stripped", async () => {
    await expect(
      resolveRepoContext(msg('agent:coding on master in jshttp/vary: run node -e "console.log(1)" and report'), []),
    ).resolves.toEqual({ repo: "jshttp/vary", ref: "master" });
  });

  it("branch:X token form", async () => {
    await expect(resolveRepoContext(msg("deploy branch:release-2 in acme/api"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "release-2",
    });
  });

  it("Slack-markup repo URL (<url|label>) is unwrapped and parsed", async () => {
    await expect(
      resolveRepoContext(msg("review <https://github.com/jshttp/vary|github.com/jshttp/vary> please"), []),
    ).resolves.toEqual({ repo: "jshttp/vary" });
  });

  it("a /tree/<ref> URL yields repo AND ref", async () => {
    await expect(
      resolveRepoContext(msg("look at https://github.com/acme/api/tree/fix/login-bug"), []),
    ).resolves.toEqual({ repo: "acme/api", ref: "fix/login-bug" });
  });

  it("uppercase slugs are lowercased (resident resource ids are lowercase)", async () => {
    await expect(resolveRepoContext(msg("fix it in CorePlaneLabs/Switchboard"), [])).resolves.toEqual({
      repo: "coreplanelabs/switchboard",
    });
  });

  it("'on <slug-shaped>' with no other repo signal is a repo mention, not a ref", async () => {
    await expect(resolveRepoContext(msg("run the tests on jshttp/vary"), [])).resolves.toEqual({
      repo: "jshttp/vary",
    });
  });

  it("'on <slug-shaped>' WITH a repo signal present is a ref", async () => {
    await expect(resolveRepoContext(msg("on fix/x in coreplanelabs/switchboard please"), [])).resolves.toEqual({
      repo: "coreplanelabs/switchboard",
      ref: "fix/x",
    });
  });
});

describe("resolveRepoContext: PR URLs and shorthand", () => {
  it("a PR URL yields repo + head ref via the GitHub REST API", async () => {
    const { fn, calls } = stubFetch({ body: { head: { ref: "patch-1", repo: { full_name: "jshttp/vary" } } } });
    await expect(
      resolveRepoContext(msg("review <https://github.com/jshttp/vary/pull/42|#42>"), []),
    ).resolves.toEqual({ repo: "jshttp/vary", ref: "patch-1", pr: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/jshttp/vary/pulls/42");
  });

  it("owner/name#N shorthand resolves the same way", async () => {
    stubFetch({ body: { head: { ref: "patch-1", repo: { full_name: "acme/api" } } } });
    await expect(resolveRepoContext(msg("agent:review acme/api#7"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "patch-1",
      pr: 7,
    });
  });

  it("uses the token from resolveGithubToken when one is configured", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    const { calls } = stubFetch({ body: { head: { ref: "p", repo: { full_name: "acme/api" } } } });
    await resolveRepoContext(msg("https://github.com/acme/api/pull/1"), []);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer ghtok");
  });

  it("degrades gracefully: a failed PR fetch keeps the repo, leaves ref undefined", async () => {
    stubFetch({ reject: "fetch failed" });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
    });
  });

  it("an HTTP-level PR fetch failure degrades the same way", async () => {
    stubFetch({ status: 404, body: { message: "Not Found" } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
    });
  });

  it("cross-fork PR head refs are NOT bound (they don't resolve in the mirror)", async () => {
    stubFetch({ body: { head: { ref: "fork-branch", repo: { full_name: "other/fork" } } } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
    });
  });

  // Requires a POSITIVE same-repo match: a null head.repo (deleted fork) has a
  // head.ref but no owner to compare, so it must NOT bind the base repo's ref.
  // (Dropping the `headRepo &&` short-circuit is what makes this undefined.)
  it("a null head.repo (deleted fork) does NOT bind the base repo's ref — repo only", async () => {
    stubFetch({ body: { head: { ref: "patch-1", repo: null } } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
    });
  });

  it("a missing head.repo.full_name likewise leaves the ref undefined (repo only)", async () => {
    stubFetch({ body: { head: { ref: "patch-1", repo: {} } } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
    });
  });

  it("an explicit branch phrase wins over the PR head (no fetch happens)", async () => {
    const { fn } = stubFetch();
    await expect(
      resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42 on branch main"), []),
    ).resolves.toEqual({ repo: "jshttp/vary", ref: "main", pr: 42 });
    expect(fn).not.toHaveBeenCalled();
  });

  // The PR number carries the deterministic review post-step (issue #69): set
  // only when the CURRENT message names a PR of the resolved repo.
  it("a bare repo mention (no PR reference) carries no pr — nowhere to post", async () => {
    const { fn } = stubFetch();
    await expect(resolveRepoContext(msg("review coreplanelabs/switchboard"), [])).resolves.toEqual({
      repo: "coreplanelabs/switchboard",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("the PR number is NOT inherited from thread history (a stale PR never gets a later review)", async () => {
    const { fn } = stubFetch();
    const history = [{ role: "user" as const, text: "review https://github.com/acme/api/pull/7" }];
    // A follow-up in the same thread inherits the repo but not the PR number.
    await expect(resolveRepoContext(msg("take another look"), history)).resolves.toEqual({
      repo: "acme/api",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("resolveRepoContext: no signal / invalid signals", () => {
  it("no signal → {} and no network call", async () => {
    const { fn } = stubFetch();
    await expect(resolveRepoContext(msg("hello there, how are you"), [])).resolves.toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });

  it("file paths and metacharacter tokens are ignored — no partial garbage", async () => {
    await expect(
      resolveRepoContext(msg("run foo;rm/bar against src/core/dispatcher.ts and a/b/c"), []),
    ).resolves.toEqual({});
  });

  it("hostile ref phrasing is ignored (pattern-validated like the resident)", async () => {
    await expect(resolveRepoContext(msg("in acme/api on branch ../evil"), [])).resolves.toEqual({
      repo: "acme/api",
    });
    await expect(resolveRepoContext(msg("in acme/api on branch foo..bar"), [])).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("prose 'on <word>' is not a ref", async () => {
    await expect(resolveRepoContext(msg("work on it in acme/api and focus on speed"), [])).resolves.toEqual({
      repo: "acme/api",
    });
  });
});

describe("resolveRepoContext: thread history inheritance", () => {
  const history = [
    { role: "user" as const, text: "agent:coding fix the login bug in acme/api" },
    { role: "assistant" as const, text: "🌿 Which branch of `acme/api` should this thread work on?" },
  ];

  it("a follow-up with no repo signal inherits the thread's repo", async () => {
    await expect(resolveRepoContext(msg("now run the tests"), history)).resolves.toEqual({ repo: "acme/api" });
  });

  it("a follow-up naming a branch binds the ref against the inherited repo (ask-once answer)", async () => {
    await expect(resolveRepoContext(msg("on main"), history)).resolves.toEqual({ repo: "acme/api", ref: "main" });
    await expect(resolveRepoContext(msg("on fix/x"), history)).resolves.toEqual({ repo: "acme/api", ref: "fix/x" });
  });

  it("an explicit repo in the current message beats the thread's", async () => {
    await expect(resolveRepoContext(msg("also check acme/other"), history)).resolves.toEqual({ repo: "acme/other" });
  });

  // Regression (found validating #138): a review follow-up saying "the
  // `unset/unset` sentinel is gone" ran against repo `unset/unset` in a cold
  // sandbox — a prose token in backticks outranked both the PR URL in the same
  // message and the thread's repo, and the verdict never reached GitHub.
  it("a token inside a code span never establishes a repo — the thread's repo is kept", async () => {
    const { fn } = stubFetch();
    await expect(resolveRepoContext(msg("the `unset/unset` sentinel is gone; re-review please"), history)).resolves.toEqual({
      repo: "acme/api",
    });
    await expect(resolveRepoContext(msg("see `src/core` for the seam"), [])).resolves.toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });

  it("a slug inside a fenced ``` block (pasted logs/diffs) never establishes a repo either", async () => {
    const fence = "here is the log:\n```\n$ cd deploy/cloudflare && npm test\nFAIL src/core/x.test.ts\n```\nplease look";
    await expect(resolveRepoContext(msg(fence), history)).resolves.toEqual({ repo: "acme/api" });
    await expect(resolveRepoContext(msg(fence), [])).resolves.toEqual({});
  });

  it("a backticked ref still binds: `on \\`main\\`` and `on \\`fix/x\\`` (code spans only exclude the bare-slug branch)", async () => {
    await expect(resolveRepoContext(msg("on `main`"), history)).resolves.toEqual({ repo: "acme/api", ref: "main" });
    await expect(resolveRepoContext(msg("on `fix/x`"), history)).resolves.toEqual({ repo: "acme/api", ref: "fix/x" });
    await expect(resolveRepoContext(msg("in acme/api on branch `release-2`"), [])).resolves.toEqual({ repo: "acme/api", ref: "release-2" });
  });

  it("a PR URL's repo outranks a bare slug elsewhere in the same message", async () => {
    stubFetch({ body: { head: { ref: "feat/x", sha: "b".repeat(40), repo: { full_name: "acme/api" } } } });
    await expect(
      resolveRepoContext(msg("re-review https://github.com/acme/api/pull/9 — I removed the unset/unset sentinel"), []),
    ).resolves.toEqual({ repo: "acme/api", ref: "feat/x", pr: 9, headSha: "b".repeat(40) });
  });

  it("repoFromThread ignores code-spanned tokens in history too", () => {
    expect(
      repoFromThread([
        { role: "user", text: "review https://github.com/acme/api/pull/7" },
        { role: "user", text: "the `foo/bar` helper is unused" },
      ]),
    ).toBe("acme/api");
  });

  it("assistant turns never establish a repo (user signals only)", async () => {
    const h = [{ role: "assistant" as const, text: "try acme/fake maybe?" }];
    await expect(resolveRepoContext(msg("go ahead"), h)).resolves.toEqual({});
  });

  it("repoFromThread: last user-turn repo wins; PR URLs count via their repo part, with NO fetch", async () => {
    const { fn } = stubFetch();
    expect(
      repoFromThread([
        { role: "user", text: "review https://github.com/acme/api/pull/7" },
        { role: "assistant", text: "done" },
        { role: "user", text: "now look at acme/web" },
      ]),
    ).toBe("acme/web");
    expect(fn).not.toHaveBeenCalled();
  });
});

// Feature: features/agent-review.md — the PR head SHA rides along with the PR
// number so the posted review is pinned via commit_id.
describe("PR head SHA for review pinning", () => {
  const SHA = "a".repeat(40);

  it("a same-repo PR carries headSha alongside ref and pr", async () => {
    stubFetch({ body: { head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } });
    const ctx = await resolveRepoContext({ text: "review https://github.com/acme/api/pull/7" });
    expect(ctx).toEqual({ repo: "acme/api", ref: "patch-1", pr: 7, headSha: SHA });
  });

  it("a cross-fork PR still carries headSha even though its ref is not bound", async () => {
    stubFetch({ body: { head: { ref: "fork-branch", sha: SHA, repo: { full_name: "other/fork" } } } });
    const ctx = await resolveRepoContext({ text: "review https://github.com/acme/api/pull/7" });
    expect(ctx.ref).toBeUndefined();
    expect(ctx.headSha).toBe(SHA);
    expect(ctx.pr).toBe(7);
  });

  it("a malformed sha is dropped; a failed fetch leaves headSha undefined", async () => {
    stubFetch({ body: { head: { ref: "patch-1", sha: "not-a-sha", repo: { full_name: "acme/api" } } } });
    expect((await resolveRepoContext({ text: "https://github.com/acme/api/pull/7" })).headSha).toBeUndefined();
    stubFetch({ reject: "fetch failed" });
    const ctx = await resolveRepoContext({ text: "https://github.com/acme/api/pull/7" });
    expect(ctx.headSha).toBeUndefined();
    expect(ctx.pr).toBe(7);
  });
});
