import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prCommitsSince, repoFromThread, resolveRepoContext } from "./repoContext.js";

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

  // 2026-08-30, PR #300: a re-review reading "re-review: rebuilt on main after
  // #298 landed …" bound `ref: "main"` from the prose "on main", which skipped
  // the PR head fetch entirely → no headSha → the resident kept the stale
  // worktree, the agent could not find the new head, and the reviewed-head
  // guard refused the post ("PR head unknown at resolution time"). A PR named
  // in the message is the explicit target: its head is ALWAYS fetched, and its
  // branch is the ref — prose "on X" in the same message never redirects it.
  const SHA = "5".repeat(40);
  it("a PR URL plus a prose 'on main' in the same message: the head is still fetched, the PR's branch is the ref", async () => {
    const { calls } = stubFetch({
      body: { state: "open", head: { ref: "feat/prompt-caching", sha: SHA, repo: { full_name: "acme/api" } }, base: { ref: "main" } },
    });
    await expect(
      resolveRepoContext(
        msg("agent:review https://github.com/acme/api/pull/300 — re-review: rebuilt on main after #298 landed the same caching. Head 517cfeb."),
        [],
      ),
    ).resolves.toEqual({ repo: "acme/api", ref: "feat/prompt-caching", pr: 300, headSha: SHA, baseRef: "main" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/300");
  });

  it("an explicit 'on branch X' beside a PR URL does not redirect the review either — the PR head is fetched and its branch bound", async () => {
    stubFetch({ body: { state: "open", head: { ref: "patch-1", sha: SHA, repo: { full_name: "jshttp/vary" } } } });
    await expect(
      resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42 on branch main"), []),
    ).resolves.toEqual({ repo: "jshttp/vary", ref: "patch-1", pr: 42, headSha: SHA });
  });

  it("a PR URL whose head fetch fails, with a prose ref beside it: the prose ref binds as a fallback, the head stays unknown", async () => {
    stubFetch({ reject: "fetch failed" });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42 on main"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      ref: "main",
      pr: 42,
    });
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

  it("a follow-up with no PR reference inherits the thread's OPEN PR for the post-step (pr + headSha, ref untouched)", async () => {
    const SHA = "b".repeat(40);
    const { fn, calls } = stubFetch({ body: { state: "open", head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } });
    const history = [{ role: "user" as const, text: "review https://github.com/acme/api/pull/7" }];
    // A re-review reply names no PR — the thread's PR is the target, pinned to
    // the head SHA fetched NOW (not the one the first review saw). The ref is
    // deliberately not rebound: inheritance serves the post-step only.
    await expect(resolveRepoContext(msg("re-review please — head abc1234"), history)).resolves.toEqual({
      repo: "acme/api",
      pr: 7,
      headSha: SHA,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/7");
  });
});

describe("resolveRepoContext: re-review follow-ups inherit the thread's PR (fail-closed)", () => {
  const SHA = "c".repeat(40);
  const history = [
    { role: "user" as const, text: "agent:review https://github.com/acme/api/pull/7 — lead with a verdict" },
    { role: "assistant" as const, text: "Verdict: approve — see https://github.com/acme/api/pull/99 for context" },
  ];

  it("the LAST user turn naming a PR wins; assistant turns never establish one", async () => {
    stubFetch({ body: { state: "open", head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const h = [...history, { role: "user" as const, text: "also review acme/api#8" }];
    const ctx = await resolveRepoContext(msg("re-review"), h);
    expect(ctx.pr).toBe(8);
    expect(ctx.headSha).toBe(SHA);
  });

  it("a PR named in the current message beats the thread's PR", async () => {
    stubFetch({ body: { state: "open", head: { ref: "p9", sha: SHA, repo: { full_name: "acme/api" } } } });
    await expect(resolveRepoContext(msg("now review acme/api#9"), history)).resolves.toEqual({
      repo: "acme/api",
      ref: "p9",
      pr: 9,
      headSha: SHA,
    });
  });

  it("a CLOSED/merged thread PR is not inherited — a later review in the thread posts nowhere", async () => {
    stubFetch({ body: { state: "closed", head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const ctx = await resolveRepoContext(msg("review this snippet: `foo()`"), history);
    expect(ctx.repo).toBe("acme/api");
    expect(ctx.pr).toBeUndefined();
    expect(ctx.headSha).toBeUndefined();
  });

  it("a failed or non-2xx fetch for the inherited PR fails closed: repo only, no pr, no headSha", async () => {
    stubFetch({ reject: "fetch failed" });
    await expect(resolveRepoContext(msg("take another look"), history)).resolves.toMatchObject({ repo: "acme/api" });
    stubFetch({ status: 404 });
    const ctx = await resolveRepoContext(msg("take another look"), history);
    expect(ctx).toMatchObject({ repo: "acme/api" });
    expect(ctx.pr).toBeUndefined();
    expect(ctx.headSha).toBeUndefined();
  });

  it("a malformed head sha fails closed too (an unpinned inherited review could approve an unreviewed push)", async () => {
    stubFetch({ body: { state: "open", head: { sha: "nope", repo: { full_name: "acme/api" } } } });
    await expect(resolveRepoContext(msg("re-review"), history)).resolves.toEqual({
      repo: "acme/api",
      prUnpostable: { number: 7, reason: "unreachable" },
    });
  });

  it("redirecting the thread to another repo BY URL drops the PR (no cross-repo post)", async () => {
    const { fn } = stubFetch();
    const h = [...history, { role: "user" as const, text: "switch to https://github.com/acme/other" }];
    await expect(resolveRepoContext(msg("run the tests"), h)).resolves.toEqual({ repo: "acme/other" });
    expect(fn).not.toHaveBeenCalled();
  });

  // Regression (PR #167, 2026-08-29): the re-review reply said "(index.ts +
  // features/memory.md §22)" — a bare path token outside backticks. It parsed
  // as repo `features/memory.md`, which unbound the thread's PR, so the second
  // LGTM never reached GitHub and the run went to a cold sandbox for a repo
  // that does not exist. A thread bound to a repo by a STRONG signal (PR URL,
  // repo URL, owner/name#N) is never rebound by a bare slug-shaped token.
  it("a bare slug-shaped token never rebinds a thread bound by URL — the PR is still inherited (#167)", async () => {
    stubFetch({ body: { state: "open", head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const text = "both nits addressed (index.ts + features/memory.md §22). Please re-review; comment only.";
    await expect(resolveRepoContext(msg(text), history)).resolves.toEqual({ repo: "acme/api", pr: 7, headSha: SHA });
  });

  it("a bare slug in an EARLIER follow-up does not rebind a URL-bound thread either", async () => {
    stubFetch({ body: { state: "open", head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const h = [...history, { role: "user" as const, text: "see features/memory.md for the rule" }];
    await expect(resolveRepoContext(msg("re-review"), h)).resolves.toEqual({ repo: "acme/api", pr: 7, headSha: SHA });
  });

  it("a bound PR that is closed is reported as unpostable, not silently dropped", async () => {
    stubFetch({ body: { state: "closed", head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    await expect(resolveRepoContext(msg("re-review"), history)).resolves.toEqual({
      repo: "acme/api",
      prUnpostable: { number: 7, reason: "closed" },
    });
  });

  it("a bound PR whose fetch fails is reported as unreachable", async () => {
    stubFetch({ status: 502 });
    await expect(resolveRepoContext(msg("re-review"), history)).resolves.toEqual({
      repo: "acme/api",
      prUnpostable: { number: 7, reason: "unreachable" },
    });
  });

  it("an explicit ref in the follow-up still binds and the PR is still inherited (one fetch, for the pin)", async () => {
    stubFetch({ body: { state: "open", head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } });
    await expect(resolveRepoContext(msg("re-review on branch patch-1"), history)).resolves.toEqual({
      repo: "acme/api",
      ref: "patch-1",
      pr: 7,
      headSha: SHA,
    });
  });

  it("a thread with no PR anywhere never fetches", async () => {
    const { fn } = stubFetch();
    const h = [{ role: "user" as const, text: "agent:coding fix login in acme/api" }];
    await expect(resolveRepoContext(msg("now run the tests"), h)).resolves.toEqual({ repo: "acme/api" });
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

  it("a STRONG repo signal in the current message beats the thread's; a bare slug does not", async () => {
    // URL form: unambiguously a repository → it rebinds.
    await expect(resolveRepoContext(msg("also check https://github.com/acme/other"), history)).resolves.toEqual({
      repo: "acme/other",
    });
    // Bare token: the thread's established repo stays (2026-08-29 guard).
    await expect(resolveRepoContext(msg("also check acme/other"), history)).resolves.toEqual({ repo: "acme/api" });
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

  it("repoFromThread: the last STRONG user-turn signal wins; a later bare slug cannot rebind a URL-bound thread; NO fetch", async () => {
    const { fn } = stubFetch();
    expect(
      repoFromThread([
        { role: "user", text: "review https://github.com/acme/api/pull/7" },
        { role: "assistant", text: "done" },
        { role: "user", text: "now look at acme/web" },
      ]),
    ).toBe("acme/api");
    expect(
      repoFromThread([
        { role: "user", text: "review https://github.com/acme/api/pull/7" },
        { role: "user", text: "now look at acme/web#3" },
      ]),
    ).toBe("acme/web");
    expect(fn).not.toHaveBeenCalled();
  });

  it("repoFromThread: a bare slug binds a thread that has no strong signal — first bind wins, a later bare slug never overrides", () => {
    expect(
      repoFromThread([
        { role: "user", text: "agent:coding fix login in acme/api" },
        { role: "user", text: "actually do it in acme/web" },
      ]),
    ).toBe("acme/api");
    // Redirecting a thread takes a STRONG signal.
    expect(
      repoFromThread([
        { role: "user", text: "agent:coding fix login in acme/api" },
        { role: "user", text: "actually do it in https://github.com/acme/web" },
      ]),
    ).toBe("acme/web");
  });
});

// Feature: features/agent-review.md item 9 — the PR's base branch rides along
// from the same REST call so the review agent can be told its diff base.
describe("PR base branch for the review target", () => {
  const SHA = "d".repeat(40);
  it("an explicit PR carries baseRef from base.ref (validated as a ref)", async () => {
    stubFetch({ body: { state: "open", base: { ref: "release/2.x" }, head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } } } });
    await expect(resolveRepoContext(msg("review https://github.com/acme/api/pull/3"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "p1",
      pr: 3,
      headSha: SHA,
      baseRef: "release/2.x",
    });
  });

  it("an inherited PR carries baseRef too", async () => {
    stubFetch({ body: { state: "open", base: { ref: "main" }, head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const history = [{ role: "user" as const, text: "review https://github.com/acme/api/pull/3" }];
    await expect(resolveRepoContext(msg("re-review"), history)).resolves.toEqual({ repo: "acme/api", pr: 3, headSha: SHA, baseRef: "main" });
  });

  it("a malformed or missing base.ref leaves baseRef unset (never partial garbage)", async () => {
    stubFetch({ body: { state: "open", base: { ref: "../evil" }, head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } } } });
    const ctx = await resolveRepoContext(msg("review https://github.com/acme/api/pull/3"), []);
    expect(ctx.baseRef).toBeUndefined();
    stubFetch({ body: { state: "open", head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } } } });
    expect((await resolveRepoContext(msg("review https://github.com/acme/api/pull/3"), [])).baseRef).toBeUndefined();
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

// Regression (2026-08-29): three Slack replies in a thread whose real repo was
// coreplanelabs/switchboard each contained an un-backticked prose token shaped
// like an owner/name slug — `reflection/review-post`, `try/catch`,
// `comment/spec` — and each rebound the thread's repo, sending a review into a
// cold sandbox for a repo that does not exist. #142 excluded code-spanned
// tokens and #167 made STRONG bindings sticky, but a weakly-bound thread (a
// bare `in coreplanelabs/switchboard` opener) was still hijacked by the next
// prose slug. The guard: a bare token NEVER overrides a repo the thread
// already established (any strength), and in an unbound thread it binds only
// when the injectable resident probe confirms an onboarded resource (no probe
// configured → binds as before: there is no registry to consult).
describe("bare prose slugs never hijack a thread (2026-08-29 regressions)", () => {
  const PAYLOADS = [
    "the reflection/review-post step is deduped now — one verdict per head SHA. please re-review",
    "good catch — wrapped the resolver in try/catch so a probe failure degrades to repo-only",
    "renamed per the comment/spec mismatch you flagged; criteria only, no receipts",
  ];
  const boundHistory = [
    { role: "user" as const, text: "agent:coding in coreplanelabs/switchboard: the resolver reads prose as a repo slug — fix it" },
    { role: "assistant" as const, text: "on it — branch pushed" },
  ];

  for (const payload of PAYLOADS) {
    it(`resolveRepoContext keeps the weakly-bound thread repo: ${JSON.stringify(payload.slice(0, 40))}…`, async () => {
      const { fn } = stubFetch();
      const probe = vi.fn(async (slug: string) => slug === "coreplanelabs/switchboard");
      await expect(resolveRepoContext(msg(payload), boundHistory, probe)).resolves.toEqual({
        repo: "coreplanelabs/switchboard",
      });
      // The payload slug is never even a candidate: the override guard is
      // absolute, not probe-dependent — only the thread's repo is vetted.
      expect(probe).toHaveBeenCalledWith("coreplanelabs/switchboard");
      expect(probe).not.toHaveBeenCalledWith(expect.stringMatching(/review-post|catch|spec/));
      expect(fn).not.toHaveBeenCalled();
    });

    it(`resolveRepoContext in a FRESH thread refuses the not-onboarded slug: ${JSON.stringify(payload.slice(0, 40))}…`, async () => {
      const probe = vi.fn(async () => false);
      await expect(resolveRepoContext(msg(payload), [], probe)).resolves.toEqual({});
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it(`repoFromThread keeps the weakly-bound thread repo: ${JSON.stringify(payload.slice(0, 40))}…`, () => {
      const h = [...boundHistory, { role: "user" as const, text: payload }];
      expect(repoFromThread(h, (slug) => slug === "coreplanelabs/switchboard")).toBe("coreplanelabs/switchboard");
      // The no-override rule holds even without a probe (sync callers may have none).
      expect(repoFromThread(h)).toBe("coreplanelabs/switchboard");
    });

    it(`repoFromThread in a FRESH thread refuses the not-onboarded slug: ${JSON.stringify(payload.slice(0, 40))}…`, () => {
      expect(repoFromThread([{ role: "user", text: payload }], () => false)).toBeUndefined();
    });
  }

  it("a bare slug binds an UNBOUND thread when the probe confirms it is onboarded", async () => {
    const probe = vi.fn(async (slug: string) => slug === "acme/api");
    await expect(resolveRepoContext(msg("agent:coding fix login in acme/api"), [], probe)).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("a bare slug never overrides even a weakly-established thread repo — probe-independent", async () => {
    const probe = vi.fn(async () => true); // everything onboarded — override still refused
    const h = [{ role: "user" as const, text: "agent:coding fix the login bug in acme/api" }];
    await expect(resolveRepoContext(msg("also check acme/other"), h, probe)).resolves.toEqual({
      repo: "acme/api",
    });
  });
});

// agent-review.md item 12: the head-moved classifier reads the PR's commits at
// the reviewed and the current head through GitHub's compare endpoint — one
// GET per side, never a shell-out. Malformed or failed answers are `undefined`
// (the classifier then has no verdict), never a partial list.
describe("prCommitsSince (compare base...sha for the head-moved classifier)", () => {
  const SHA = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
  const C1 = "1".repeat(40);
  const C2 = "2".repeat(40);

  it("asks GET /repos/{repo}/compare/{base}...{sha} and answers commits (oldest first, full message) + files", async () => {
    const { calls } = stubFetch({
      body: {
        commits: [
          { sha: C1, commit: { message: "feat: catalog\n\nbody" } },
          { sha: C2, commit: { message: "fix: nits" } },
        ],
        files: [{ filename: "src/a.ts" }, { filename: "docs/b.md" }],
      },
    });
    await expect(prCommitsSince({ repo: "acme/api", base: "main", sha: SHA })).resolves.toEqual({
      commits: [
        { sha: C1, message: "feat: catalog\n\nbody" },
        { sha: C2, message: "fix: nits" },
      ],
      files: ["src/a.ts", "docs/b.md"],
      filesTruncated: false,
    });
    expect(calls[0].url).toBe(`https://api.github.com/repos/acme/api/compare/main...${SHA}`);
  });

  it("300 files → filesTruncated (GitHub's cap); a base with a slash is URL-encoded", async () => {
    const { calls } = stubFetch({
      body: { commits: [], files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) },
    });
    const r = await prCommitsSince({ repo: "acme/api", base: "release/2", sha: SHA });
    expect(r?.filesTruncated).toBe(true);
    expect(r?.files).toHaveLength(300);
    expect(calls[0].url).toContain("/compare/release%2F2...");
  });

  it("undefined on a non-2xx, a network failure, a malformed commit, or a malformed base/sha", async () => {
    stubFetch({ status: 404 });
    await expect(prCommitsSince({ repo: "acme/api", base: "main", sha: SHA })).resolves.toBeUndefined();
    stubFetch({ reject: "fetch failed" });
    await expect(prCommitsSince({ repo: "acme/api", base: "main", sha: SHA })).resolves.toBeUndefined();
    stubFetch({ body: { commits: [{ sha: "zzz", commit: { message: "x" } }] } });
    await expect(prCommitsSince({ repo: "acme/api", base: "main", sha: SHA })).resolves.toBeUndefined();
    stubFetch({ body: { commits: "nope" } });
    await expect(prCommitsSince({ repo: "acme/api", base: "main", sha: SHA })).resolves.toBeUndefined();
    const { fn } = stubFetch();
    await expect(prCommitsSince({ repo: "acme/api", base: "main", sha: "not-a-sha" })).resolves.toBeUndefined();
    await expect(prCommitsSince({ repo: "acme/api", base: "bad ref", sha: SHA })).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});
