import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prCommitsSince, repoFromThread, resolveRepoContext } from "./repoContext.js";

// Feature: docs/reference/specs/resident-repos.md item 29 — repo/ref resolution BEFORE the
// model turn: explicit signals in the current message (owner/name slug,
// github.com repo/PR URL, conservative branch phrasing) → the thread's
// previously-established repo (derived from history, restart-safe, never
// stored) → none. Ref extraction is conservative by design (binding is
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
    await expect(resolveRepoContext(msg("fix the bug in acme/api on branch fix/x"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "fix/x",
    });
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
    await expect(resolveRepoContext(msg("fix it in Acme/Api"), [])).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("'on <slug-shaped>' with no other repo signal is a repo mention, not a ref", async () => {
    await expect(resolveRepoContext(msg("run the tests on jshttp/vary"), [])).resolves.toEqual({
      repo: "jshttp/vary",
    });
  });

  it("'on <slug-shaped>' WITH a repo signal present is a ref", async () => {
    await expect(resolveRepoContext(msg("on fix/x in acme/api please"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "fix/x",
    });
  });
});

describe("resolveRepoContext: PR URLs and shorthand", () => {
  it("a PR URL yields repo + head ref via the GitHub REST API", async () => {
    const { fn, calls } = stubFetch({ body: { head: { ref: "patch-1", repo: { full_name: "jshttp/vary" } } } });
    await expect(resolveRepoContext(msg("review <https://github.com/jshttp/vary/pull/42|PR 42>"), [])).resolves.toEqual(
      {
        repo: "jshttp/vary",
        ref: "patch-1",
        refFromPr: true,
        pr: 42,
        prFromMessage: true,
      },
    );
    // Two reads: the PR object, then the head branch's ref tip (the PR object lags the ref after a force-push).
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[0].url).toBe("https://api.github.com/repos/jshttp/vary/pulls/42");
    expect(calls[1].url).toBe("https://api.github.com/repos/jshttp/vary/git/ref/heads/patch-1");
  });

  it("owner/name#N shorthand resolves the same way", async () => {
    stubFetch({ body: { head: { ref: "patch-1", repo: { full_name: "acme/api" } } } });
    await expect(resolveRepoContext(msg("agent:review acme/api#7"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "patch-1",
      refFromPr: true,
      pr: 7,
      prFromMessage: true,
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
      prFromMessage: true,
    });
  });

  it("an HTTP-level PR fetch failure degrades the same way", async () => {
    stubFetch({ status: 404, body: { message: "Not Found" } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
      prFromMessage: true,
    });
  });

  it("cross-fork PR head refs are NOT bound (they don't resolve in the mirror)", async () => {
    stubFetch({ body: { head: { ref: "fork-branch", repo: { full_name: "other/fork" } } } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
      prFromMessage: true,
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
      prFromMessage: true,
    });
  });

  it("a missing head.repo.full_name likewise leaves the ref undefined (repo only)", async () => {
    stubFetch({ body: { head: { ref: "patch-1", repo: {} } } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      pr: 42,
      prFromMessage: true,
    });
  });

  // A re-review reading "re-review: rebuilt on main after the caching PR
  // landed …" once bound `ref: "main"` from the prose "on main", which skipped
  // the PR head fetch entirely → no headSha → the resident kept the stale
  // worktree, the agent could not find the new head, and the reviewed-head
  // guard refused the post ("PR head unknown at resolution time"). A PR named
  // in the message is the explicit target: its head is ALWAYS fetched, and its
  // branch is the ref — prose "on X" in the same message never redirects it.
  const SHA = "5".repeat(40);
  it("a PR URL plus a prose 'on main' in the same message: the head is still fetched, the PR's branch is the ref", async () => {
    const { calls } = stubFetch({
      body: {
        state: "open",
        head: { ref: "feat/prompt-caching", sha: SHA, repo: { full_name: "acme/api" } },
        base: { ref: "main" },
      },
    });
    await expect(
      resolveRepoContext(
        msg(
          "agent:review https://github.com/acme/api/pull/300 — re-review: rebuilt on main after the caching PR landed. Head 517cfeb.",
        ),
        [],
      ),
    ).resolves.toEqual({
      repo: "acme/api",
      ref: "feat/prompt-caching",
      refFromPr: true,
      pr: 300,
      prFromMessage: true,
      headSha: SHA,
      baseRef: "main",
    });
    // The PR object, then the head branch's ref tip (the PR object lags the ref after a force-push).
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/300");
    expect(calls[1].url).toBe("https://api.github.com/repos/acme/api/git/ref/heads/feat/prompt-caching");
  });

  it("an explicit 'on branch X' beside a PR URL does not redirect the review either — the PR head is fetched and its branch bound", async () => {
    stubFetch({ body: { state: "open", head: { ref: "patch-1", sha: SHA, repo: { full_name: "jshttp/vary" } } } });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42 on branch main"), [])).resolves.toEqual(
      { repo: "jshttp/vary", ref: "patch-1", refFromPr: true, pr: 42, prFromMessage: true, headSha: SHA },
    );
  });

  it("a PR URL whose head fetch fails, with a prose ref beside it: the prose ref binds as a fallback, the head stays unknown", async () => {
    stubFetch({ reject: "fetch failed" });
    await expect(resolveRepoContext(msg("https://github.com/jshttp/vary/pull/42 on main"), [])).resolves.toEqual({
      repo: "jshttp/vary",
      ref: "main", // the prose fallback, NOT the PR head — so refFromPr stays unset
      pr: 42,
      prFromMessage: true,
    });
  });

  // The PR number carries the deterministic review post-step: set
  // only when the CURRENT message names a PR of the resolved repo.
  it("a bare repo mention (no PR reference) carries no pr — nowhere to post", async () => {
    const { fn } = stubFetch();
    await expect(resolveRepoContext(msg("review acme/api"), [])).resolves.toEqual({
      repo: "acme/api",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a follow-up with no PR reference inherits the thread's OPEN PR for the post-step (pr + headSha, ref untouched)", async () => {
    const SHA = "b".repeat(40);
    const { fn, calls } = stubFetch({
      body: { state: "open", head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } },
    });
    const history = [{ role: "user" as const, text: "review https://github.com/acme/api/pull/7" }];
    // A re-review reply names no PR — the thread's PR is the target, pinned to
    // the head SHA fetched NOW (not the one the first review saw). The ref is
    // deliberately not rebound: inheritance serves the post-step only.
    await expect(resolveRepoContext(msg("re-review please — head abc1234"), history)).resolves.toEqual({
      repo: "acme/api",
      pr: 7,
      headSha: SHA,
    });
    expect(fn).toHaveBeenCalledTimes(2); // the PR object, then its head branch's ref tip
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/7");
  });
});

// Feature: docs/reference/specs/agent-ship.md item 10 — the resolver flags a PR
// named in the CURRENT message (`prFromMessage`) and a ref taken from a cited
// PR's head branch (`refFromPr`). Ship reads both: prFromMessage tells a foreign
// PR quoted as evidence from the thread's own in-flight PR, and refFromPr keeps
// round 0 off the stranger's PR head even when a later facts fetch fails and the
// head ref is otherwise unknown.
describe("resolveRepoContext: PR-source flags for ship", () => {
  const SHA = "e".repeat(40);

  it("a PR named in the current message sets prFromMessage, and its bound head ref sets refFromPr", async () => {
    stubFetch({ body: { state: "open", head: { ref: "feat/x", sha: SHA, repo: { full_name: "acme/api" } } } });
    const ctx = await resolveRepoContext(msg("look into https://github.com/acme/api/pull/508 for the regression"), []);
    expect(ctx.pr).toBe(508);
    expect(ctx.prFromMessage).toBe(true);
    expect(ctx.ref).toBe("feat/x");
    expect(ctx.refFromPr).toBe(true);
  });

  it("a PR INHERITED from the thread sets neither flag — it is not an in-message reference", async () => {
    stubFetch({ body: { state: "open", head: { ref: "p9", sha: SHA, repo: { full_name: "acme/api" } } } });
    const history = [{ role: "user" as const, text: "review https://github.com/acme/api/pull/7" }];
    const ctx = await resolveRepoContext(msg("re-review"), history);
    expect(ctx.pr).toBe(7);
    expect(ctx.prFromMessage).toBeUndefined();
    // The ref is never rebound from an inherited PR, so refFromPr never applies.
    expect(ctx.refFromPr).toBeUndefined();
  });

  it("an in-message PR whose head fetch FAILS keeps prFromMessage but never sets refFromPr (the guard holds on the failed-fetch path)", async () => {
    stubFetch({ reject: "fetch failed" });
    const ctx = await resolveRepoContext(msg("look into https://github.com/acme/api/pull/508 for the regression"), []);
    expect(ctx.pr).toBe(508);
    expect(ctx.prFromMessage).toBe(true);
    expect(ctx.ref).toBeUndefined();
    expect(ctx.refFromPr).toBeUndefined();
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
      refFromPr: true,
      pr: 9,
      prFromMessage: true,
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

  // A re-review reply saying "(index.ts + docs/reference/specs/memory.md §22)" carries a
  // bare path token outside backticks. Parsed as repo `docs/reference/specs/memory.md` it
  // would unbind the thread's PR, so the second LGTM never reaches GitHub and
  // the run goes to a cold sandbox for a repo that does not exist. A thread
  // bound to a repo by a STRONG signal (PR URL, repo URL, owner/name#N) is
  // never rebound by a bare slug-shaped token.
  it("a bare slug-shaped token never rebinds a thread bound by URL — the PR is still inherited", async () => {
    stubFetch({ body: { state: "open", head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const text = "both nits addressed (index.ts + docs/reference/specs/memory.md §22). Please re-review; comment only.";
    await expect(resolveRepoContext(msg(text), history)).resolves.toEqual({ repo: "acme/api", pr: 7, headSha: SHA });
  });

  it("a bare slug in an EARLIER follow-up does not rebind a URL-bound thread either", async () => {
    stubFetch({ body: { state: "open", head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const h = [...history, { role: "user" as const, text: "see docs/reference/specs/memory.md for the rule" }];
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

  it("`on <the established repo's own slug>` restates the repo — it never becomes the ref (else ship's base branch becomes 'acme/api')", async () => {
    await expect(
      resolveRepoContext(msg("auto-merge is now disabled on acme/api — retry the task"), history),
    ).resolves.toEqual({ repo: "acme/api" });
  });

  it("a STRONG repo signal in the current message beats the thread's; a bare slug does not", async () => {
    // URL form: unambiguously a repository → it rebinds.
    await expect(resolveRepoContext(msg("also check https://github.com/acme/other"), history)).resolves.toEqual({
      repo: "acme/other",
    });
    // Bare token: the thread's established repo stays (weak signals never rebind).
    await expect(resolveRepoContext(msg("also check acme/other"), history)).resolves.toEqual({ repo: "acme/api" });
  });

  // A review follow-up saying "the `unset/unset` sentinel is gone" once ran
  // against repo `unset/unset` in a cold sandbox — a prose token in backticks
  // outranked both the PR URL in the same message and the thread's repo, and
  // the verdict never reached GitHub.
  it("a token inside a code span never establishes a repo — the thread's repo is kept", async () => {
    const { fn } = stubFetch();
    await expect(
      resolveRepoContext(msg("the `unset/unset` sentinel is gone; re-review please"), history),
    ).resolves.toEqual({
      repo: "acme/api",
    });
    await expect(resolveRepoContext(msg("see `src/core` for the seam"), [])).resolves.toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });

  it("a slug inside a fenced ``` block (pasted logs/diffs) never establishes a repo either", async () => {
    const fence =
      "here is the log:\n```\n$ cd deploy/cloudflare && npm test\nFAIL src/core/x.test.ts\n```\nplease look";
    await expect(resolveRepoContext(msg(fence), history)).resolves.toEqual({ repo: "acme/api" });
    await expect(resolveRepoContext(msg(fence), [])).resolves.toEqual({});
  });

  it("a backticked ref still binds: `on \\`main\\`` and `on \\`fix/x\\`` (code spans only exclude the bare-slug branch)", async () => {
    await expect(resolveRepoContext(msg("on `main`"), history)).resolves.toEqual({ repo: "acme/api", ref: "main" });
    await expect(resolveRepoContext(msg("on `fix/x`"), history)).resolves.toEqual({ repo: "acme/api", ref: "fix/x" });
    await expect(resolveRepoContext(msg("in acme/api on branch `release-2`"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "release-2",
    });
  });

  it("a PR URL's repo outranks a bare slug elsewhere in the same message", async () => {
    stubFetch({ body: { head: { ref: "feat/x", sha: "b".repeat(40), repo: { full_name: "acme/api" } } } });
    await expect(
      resolveRepoContext(msg("re-review https://github.com/acme/api/pull/9 — I removed the unset/unset sentinel"), []),
    ).resolves.toEqual({
      repo: "acme/api",
      ref: "feat/x",
      refFromPr: true,
      pr: 9,
      prFromMessage: true,
      headSha: "b".repeat(40),
    });
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

// Feature: docs/reference/specs/agent-review.md item 9 — the PR's base branch rides along
// from the same REST call so the review agent can be told its diff base.
describe("PR base branch for the review target", () => {
  const SHA = "d".repeat(40);
  it("an explicit PR carries baseRef from base.ref (validated as a ref)", async () => {
    stubFetch({
      body: {
        state: "open",
        base: { ref: "release/2.x" },
        head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } },
      },
    });
    await expect(resolveRepoContext(msg("review https://github.com/acme/api/pull/3"), [])).resolves.toEqual({
      repo: "acme/api",
      ref: "p1",
      refFromPr: true,
      pr: 3,
      prFromMessage: true,
      headSha: SHA,
      baseRef: "release/2.x",
    });
  });

  it("an inherited PR carries baseRef too", async () => {
    stubFetch({ body: { state: "open", base: { ref: "main" }, head: { sha: SHA, repo: { full_name: "acme/api" } } } });
    const history = [{ role: "user" as const, text: "review https://github.com/acme/api/pull/3" }];
    await expect(resolveRepoContext(msg("re-review"), history)).resolves.toEqual({
      repo: "acme/api",
      pr: 3,
      headSha: SHA,
      baseRef: "main",
    });
  });

  it("a malformed or missing base.ref leaves baseRef unset (never partial garbage)", async () => {
    stubFetch({
      body: { state: "open", base: { ref: "../evil" }, head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } } },
    });
    const ctx = await resolveRepoContext(msg("review https://github.com/acme/api/pull/3"), []);
    expect(ctx.baseRef).toBeUndefined();
    stubFetch({ body: { state: "open", head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } } } });
    expect((await resolveRepoContext(msg("review https://github.com/acme/api/pull/3"), [])).baseRef).toBeUndefined();
  });
});

// Feature: docs/reference/specs/agent-review.md item 15 — the PR's size rides along
// from the same GET so the post-step can hold the review's digest against it.
describe("PR size for the digest-coverage guard", () => {
  const SHA = "c".repeat(40);
  const size = { changed_files: 41, additions: 2459, deletions: 579 };

  it("an explicit PR carries prSize from changed_files/additions/deletions; an inherited PR too", async () => {
    stubFetch({ body: { state: "open", head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } }, ...size } });
    expect((await resolveRepoContext(msg("review https://github.com/acme/api/pull/3"), [])).prSize).toEqual({
      changedFiles: 41,
      additions: 2459,
      deletions: 579,
    });
    stubFetch({ body: { state: "open", head: { sha: SHA, repo: { full_name: "acme/api" } }, ...size } });
    const history = [{ role: "user" as const, text: "review https://github.com/acme/api/pull/3" }];
    expect((await resolveRepoContext(msg("re-review"), history)).prSize).toEqual({
      changedFiles: 41,
      additions: 2459,
      deletions: 579,
    });
  });

  it("a missing or non-integer field leaves prSize unset — never a partial size", async () => {
    stubFetch({
      body: {
        state: "open",
        head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } },
        changed_files: 41,
        additions: 2459,
      },
    });
    expect((await resolveRepoContext(msg("https://github.com/acme/api/pull/3"), [])).prSize).toBeUndefined();
    stubFetch({
      body: {
        state: "open",
        head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } },
        ...size,
        deletions: "579",
      },
    });
    expect((await resolveRepoContext(msg("https://github.com/acme/api/pull/3"), [])).prSize).toBeUndefined();
  });

  it("a PR object lagging the head ref (force-push) describes the OLD head: its size is dropped with it", async () => {
    const TIP = "d".repeat(40);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(
      { body: { head: { ref: "p1", sha: SHA, repo: { full_name: "acme/api" } }, ...size } },
      { body: { ref: "refs/heads/p1", object: { sha: TIP, type: "commit" } } },
    );
    const ctx = await resolveRepoContext(msg("https://github.com/acme/api/pull/3"), []);
    expect(ctx.headSha).toBe(TIP);
    expect(ctx.prSize).toBeUndefined();
    log.mockRestore();
  });
});

// Feature: docs/reference/specs/agent-review.md — the PR head SHA rides along with the PR
// number so the posted review is pinned via commit_id.
describe("PR head SHA for review pinning", () => {
  const SHA = "a".repeat(40);

  it("a same-repo PR carries headSha alongside ref and pr", async () => {
    stubFetch({ body: { head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } });
    const ctx = await resolveRepoContext({ text: "review https://github.com/acme/api/pull/7" });
    expect(ctx).toEqual({
      repo: "acme/api",
      ref: "patch-1",
      refFromPr: true,
      pr: 7,
      prFromMessage: true,
      headSha: SHA,
    });
  });

  it("a cross-fork PR still carries headSha even though its ref is not bound — and asks for no ref tip (the fork's ref is not on this repo)", async () => {
    const { calls } = stubFetch({
      body: { head: { ref: "fork-branch", sha: SHA, repo: { full_name: "other/fork" } } },
    });
    const ctx = await resolveRepoContext({ text: "review https://github.com/acme/api/pull/7" });
    expect(ctx.ref).toBeUndefined();
    expect(ctx.headSha).toBe(SHA);
    expect(ctx.pr).toBe(7);
    expect(calls).toHaveLength(1);
  });

  // GitHub's pull-request object lags the branch ref after a force-push (seen
  // live: four minutes, the new commit already fetchable by sha). The ref IS
  // the PR's head; a review attached at the lagging head.sha refuses with a
  // mismatch. So the head is read from the ref when it can be.
  it("the head branch's ref tip wins over a lagging PR head.sha, and the disagreement is logged with both shas", async () => {
    const TIP = "b".repeat(40);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = stubFetch(
      { body: { head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } },
      { body: { ref: "refs/heads/patch-1", object: { sha: TIP, type: "commit" } } },
    );
    const ctx = await resolveRepoContext({ text: "review https://github.com/acme/api/pull/7" });
    expect(ctx.headSha).toBe(TIP);
    expect(ctx.ref).toBe("patch-1");
    expect(calls[1].url).toBe("https://api.github.com/repos/acme/api/git/ref/heads/patch-1");
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[pr-head] acme/api#7"));
    expect(line).toContain(SHA.slice(0, 7));
    expect(line).toContain(TIP.slice(0, 7));
    expect(line).toContain("refs/heads/patch-1");
    log.mockRestore();
  });

  it("ref tip equal to head.sha → that sha, no log line; an unreadable ref (404, network) → the PR object's sha stands", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(
      { body: { head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } },
      { body: { object: { sha: SHA, type: "commit" } } },
    );
    expect((await resolveRepoContext({ text: "https://github.com/acme/api/pull/7" })).headSha).toBe(SHA);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith("[pr-head]"))).toBe(false);
    stubFetch({ body: { head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } }, { status: 404 });
    expect((await resolveRepoContext({ text: "https://github.com/acme/api/pull/7" })).headSha).toBe(SHA);
    stubFetch(
      { body: { head: { ref: "patch-1", sha: SHA, repo: { full_name: "acme/api" } } } },
      { reject: "fetch failed" },
    );
    expect((await resolveRepoContext({ text: "https://github.com/acme/api/pull/7" })).headSha).toBe(SHA);
    log.mockRestore();
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

// Three replies in a thread whose real repo is acme/api, each containing an
// un-backticked prose token shaped like an owner/name slug —
// `reflection/review-post`, `try/catch`, `comment/spec` — must not rebind the
// thread's repo and send a review into a cold sandbox for a repo that does not
// exist. Excluding code-spanned tokens and making STRONG bindings sticky is
// not enough: a weakly-bound thread (a bare `in acme/api` opener) would still
// be hijacked by the next prose slug. The guard: a bare token NEVER overrides a repo the thread
// already established (any strength), and in an unbound thread it binds only
// when the injectable resident probe confirms an onboarded resource (no probe
// configured → binds as before: there is no registry to consult).
describe("bare prose slugs never hijack a thread", () => {
  const PAYLOADS = [
    "the reflection/review-post step is deduped now — one verdict per head SHA. please re-review",
    "good catch — wrapped the resolver in try/catch so a probe failure degrades to repo-only",
    "renamed per the comment/spec mismatch you flagged; criteria only, no receipts",
  ];
  const boundHistory = [
    {
      role: "user" as const,
      text: "agent:coding in acme/api: the resolver reads prose as a repo slug — fix it",
    },
    { role: "assistant" as const, text: "on it — branch pushed" },
  ];

  for (const payload of PAYLOADS) {
    it(`resolveRepoContext keeps the weakly-bound thread repo: ${JSON.stringify(payload.slice(0, 40))}…`, async () => {
      const { fn } = stubFetch();
      const probe = vi.fn(async (slug: string) => slug === "acme/api");
      await expect(resolveRepoContext(msg(payload), boundHistory, probe)).resolves.toEqual({
        repo: "acme/api",
      });
      // A prose slug is never even a candidate — only the thread's repo is
      // vetted. The one exception is an ADDRESS: `in try/catch` is probed once
      // (item 29), refused, and changes nothing; never more than that.
      expect(probe).toHaveBeenCalledWith("acme/api");
      expect(probe).not.toHaveBeenCalledWith(expect.stringMatching(/review-post|spec/));
      expect(probe.mock.calls.length).toBeLessThanOrEqual(2);
      expect(fn).not.toHaveBeenCalled();
    });

    it(`resolveRepoContext in a FRESH thread refuses the not-onboarded slug — and names it as rejected: ${JSON.stringify(payload.slice(0, 40))}…`, async () => {
      const probe = vi.fn(async () => false);
      const ctx = await resolveRepoContext(msg(payload), [], probe);
      expect(ctx.repo).toBeUndefined();
      // The dispatcher tells the user the slug was refused instead of starting
      // a repo-less run — but only for this fresh-thread case.
      expect(ctx.rejectedRepo).toMatch(/^[a-z]+\/[a-z-]+$/);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it(`repoFromThread keeps the weakly-bound thread repo: ${JSON.stringify(payload.slice(0, 40))}…`, () => {
      const h = [...boundHistory, { role: "user" as const, text: payload }];
      expect(repoFromThread(h, (slug) => slug === "acme/api")).toBe("acme/api");
      // The no-override rule holds even without a probe (sync callers may have none).
      expect(repoFromThread(h)).toBe("acme/api");
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

  it("a fresh thread whose only signal is a rejected bare slug reports it as rejectedRepo, no repo", async () => {
    const probe = vi.fn(async () => false);
    await expect(resolveRepoContext(msg("agent:coding in acme/try-catch: say hi"), [], probe)).resolves.toEqual({
      rejectedRepo: "acme/try-catch",
    });
  });

  it("a thread weakly bound to a repo the probe rejects reports THAT repo as rejected on a signal-less follow-up", async () => {
    const probe = vi.fn(async () => false);
    const h = [{ role: "user" as const, text: "agent:coding in acme/try-catch: say hi" }];
    await expect(resolveRepoContext(msg("now run git status"), h, probe)).resolves.toEqual({
      rejectedRepo: "acme/try-catch",
    });
  });

  it("a rejected `on <slug>` mention is reported too; an accepted candidate never leaves rejectedRepo behind", async () => {
    await expect(resolveRepoContext(msg("agent:coding on acme/nope: fix it"), [], async () => false)).resolves.toEqual({
      rejectedRepo: "acme/nope",
    });
    // Thread repo rejected, but this message's own slug accepted → bound, nothing rejected.
    const probe = vi.fn(async (slug: string) => slug === "acme/api");
    const h = [{ role: "user" as const, text: "agent:coding in acme/nope: fix it" }];
    await expect(resolveRepoContext(msg("actually use acme/api"), h, probe)).resolves.toEqual({ repo: "acme/api" });
  });

  it("without a probe nothing is ever rejected (local/dev binds unvetted, as before)", async () => {
    await expect(resolveRepoContext(msg("agent:coding in acme/nope: fix it"), [])).resolves.toEqual({
      repo: "acme/nope",
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

// Addressed repos (resident-repos.md item 29):
// `in <owner/name>` / `in <name>` names the TARGET of a request. Vetted
// against the resident registry, an addressed repo is a STRONG signal — it
// binds a fresh thread and rebinds a bound one — because a registry-confirmed
// repo is unambiguous in a way a prose slug (`docs/reference/specs/memory.md`) never is.
// A bare NAME resolves only through the registry listing and only when exactly
// one onboarded repo carries it ("in atlas" → acme/atlas); an
// unknown or ambiguous name is prose and binds nothing.
describe("addressed repos: `in <owner/name>` and `in <name>` bind and rebind once the registry vets them", () => {
  const onboarded = ["acme/api", "acme/web", "acme/atlas"];
  const probe = vi.fn(async (slug: string) => onboarded.includes(slug));
  const slugs = vi.fn(async () => onboarded);
  // A thread bound by URL to acme/api (no PR, so no inherited-PR fetch).
  const boundToApi = [{ role: "user" as const, text: "look at https://github.com/acme/api first" }];

  it("`in <slug>` naming an onboarded repo rebinds a URL-bound thread", async () => {
    await expect(
      resolveRepoContext(msg("agent:coding in acme/web: fix the login page"), boundToApi, probe, slugs),
    ).resolves.toEqual({ repo: "acme/web" });
  });

  it("`in <slug>` naming a repo the probe refuses does NOT rebind — the thread's repo stays, nothing rejected", async () => {
    await expect(
      resolveRepoContext(msg("agent:coding in acme/nope: fix it"), boundToApi, probe, slugs),
    ).resolves.toEqual({ repo: "acme/api" });
  });

  it("an onboarded slug that is merely mentioned (not addressed with `in`) still never rebinds — the strong-binding guard stands", async () => {
    await expect(resolveRepoContext(msg("also check acme/web"), boundToApi, probe, slugs)).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("an addressed slug inside a code span is a path being talked about, not an address", async () => {
    await expect(
      resolveRepoContext(msg("the bug is in `acme/web` (the module), re-run"), boundToApi, probe, slugs),
    ).resolves.toEqual({ repo: "acme/api" });
  });

  it("`in <name>`: a bare repo name carried by exactly one onboarded resident binds it in a fresh thread", async () => {
    await expect(
      resolveRepoContext(msg("agent:coding in atlas, the consent page is impossibly long"), [], probe, slugs),
    ).resolves.toEqual({
      repo: "acme/atlas",
    });
  });

  it("`in <name>` rebinds a URL-bound thread too (the target was named explicitly)", async () => {
    await expect(
      resolveRepoContext(msg("agent:coding in atlas: same fix there"), boundToApi, probe, slugs),
    ).resolves.toEqual({ repo: "acme/atlas" });
  });

  it("an ambiguous name (two owners) binds nothing — fresh thread stays repo-less, a bound thread keeps its repo", async () => {
    const two = vi.fn(async () => ["acme/atlas", "beta/atlas"]);
    await expect(resolveRepoContext(msg("agent:coding in atlas: fix"), [], probe, two)).resolves.toEqual({});
    await expect(resolveRepoContext(msg("agent:coding in atlas: fix"), boundToApi, probe, two)).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("a bare name counts only in the directive position — `in api` deep in prose never rebinds, even when a repo is called api", async () => {
    await expect(
      resolveRepoContext(
        msg("the crash is in api, see the logs"),
        boundToApi.map((h) => ({ ...h, text: "look at https://github.com/acme/web first" })),
        probe,
        slugs,
      ),
    ).resolves.toEqual({ repo: "acme/web" });
    await expect(resolveRepoContext(msg("the crash is in api, see the logs"), [], probe, slugs)).resolves.toEqual({});
    // Directives and a mention may precede it; anything else is prose.
    await expect(
      resolveRepoContext(
        msg("<@U0AAAAAAAAA> agent:coding model:anthropic/claude-fable-5 in api: fix it"),
        [],
        probe,
        slugs,
      ),
    ).resolves.toEqual({ repo: "acme/api" });
    await expect(resolveRepoContext(msg("please work in api: fix it"), [], probe, slugs)).resolves.toEqual({});
    // A slug is unambiguous enough to be addressed anywhere.
    await expect(
      resolveRepoContext(msg("the crash is in acme/web, see the logs"), boundToApi, probe, slugs),
    ).resolves.toEqual({ repo: "acme/web" });
  });

  it("the registry did not ANSWER for an addressed slug in the current message → unverifiedRepo, never a fall back to the thread's old repo", async () => {
    const down = vi.fn(async (): Promise<boolean | "unreachable"> => "unreachable");
    await expect(resolveRepoContext(msg("agent:coding in acme/web: fix it"), boundToApi, down, slugs)).resolves.toEqual(
      { unverifiedRepo: "acme/web" },
    );
    await expect(resolveRepoContext(msg("agent:coding in acme/web: fix it"), [], down, slugs)).resolves.toEqual({
      unverifiedRepo: "acme/web",
    });
    // A probe that throws is "did not answer" too — not a refusal.
    const throwing = vi.fn(async (): Promise<boolean> => {
      throw new Error("ECONNRESET");
    });
    await expect(
      resolveRepoContext(msg("agent:coding in acme/web: fix it"), boundToApi, throwing, slugs),
    ).resolves.toEqual({ unverifiedRepo: "acme/web" });
    // A URL in the same message still wins — it needs no vetting.
    await expect(
      resolveRepoContext(msg("agent:coding in acme/web: see https://github.com/acme/atlas"), boundToApi, down, slugs),
    ).resolves.toEqual({ repo: "acme/atlas" });
  });

  it("an unanswered address in HISTORY is no answer: older strong signals still bind; a fresh thread's unvetted weak slug reports unverifiedRepo, not rejectedRepo", async () => {
    const down = vi.fn(async (): Promise<boolean | "unreachable"> => "unreachable");
    const h = [...boundToApi, { role: "user" as const, text: "agent:coding in acme/web: port it" }];
    await expect(resolveRepoContext(msg("now run the tests"), h, down, slugs)).resolves.toEqual({ repo: "acme/api" });
    await expect(resolveRepoContext(msg("agent:coding fix login in acme/web"), [], down, slugs)).resolves.toEqual({
      unverifiedRepo: "acme/web",
    });
  });

  it("an unknown name is prose (`in production`): nothing bound, nothing rejected", async () => {
    await expect(resolveRepoContext(msg("deploy it in production please"), [], probe, slugs)).resolves.toEqual({});
    await expect(resolveRepoContext(msg("deploy it in production please"), boundToApi, probe, slugs)).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("no registry lister → names are ignored; slug addressing still works", async () => {
    await expect(resolveRepoContext(msg("agent:coding in atlas: fix"), [], probe)).resolves.toEqual({});
    await expect(resolveRepoContext(msg("agent:coding in acme/web: fix"), boundToApi, probe)).resolves.toEqual({
      repo: "acme/web",
    });
  });

  it("a lister that fails is no answer: the addressed name binds nothing and the thread's repo stays", async () => {
    const failing = vi.fn(async (): Promise<string[] | undefined> => {
      throw new Error("resident admin unreachable");
    });
    await expect(resolveRepoContext(msg("agent:coding in atlas: fix"), boundToApi, probe, failing)).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("without a probe (local/dev, no registry) nothing can be vetted: an addressed slug stays weak — binds a fresh thread, never rebinds a bound one", async () => {
    await expect(resolveRepoContext(msg("agent:coding in acme/web: fix"), [])).resolves.toEqual({ repo: "acme/web" });
    await expect(resolveRepoContext(msg("agent:coding in acme/web: fix"), boundToApi)).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("the registry is listed at most once per resolution, however many names the thread carries", async () => {
    const lister = vi.fn(async () => onboarded);
    const h = [
      { role: "user" as const, text: "agent:coding in atlas: fix the page" },
      { role: "user" as const, text: "and in web the same" },
    ];
    await expect(resolveRepoContext(msg("in atlas again: run the tests"), h, probe, lister)).resolves.toEqual({
      repo: "acme/atlas",
    });
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it("an address in HISTORY binds the follow-up (the thread's binding is derived from every user turn)", async () => {
    const h = [{ role: "user" as const, text: "agent:coding in atlas, the consent page is impossibly long" }];
    await expect(resolveRepoContext(msg("now run the tests"), h, probe, slugs)).resolves.toEqual({
      repo: "acme/atlas",
    });
  });

  it("last strong wins across URLs and addresses alike", async () => {
    const url = { role: "user" as const, text: "look at https://github.com/acme/api first" };
    const addressed = { role: "user" as const, text: "agent:coding in acme/web: port it" };
    await expect(resolveRepoContext(msg("go"), [url, addressed], probe, slugs)).resolves.toEqual({ repo: "acme/web" });
    await expect(resolveRepoContext(msg("go"), [url, addressed, url], probe, slugs)).resolves.toEqual({
      repo: "acme/api",
    });
  });

  it("repoFromThread (sync): an addressed slug the predicate confirms counts strong; names cannot be resolved without the registry and are ignored", () => {
    const isOnboarded = (slug: string) => onboarded.includes(slug);
    expect(
      repoFromThread([...boundToApi, { role: "user", text: "agent:coding in acme/web: port it" }], isOnboarded),
    ).toBe("acme/web");
    expect(
      repoFromThread([...boundToApi, { role: "user", text: "agent:coding in acme/nope: port it" }], isOnboarded),
    ).toBe("acme/api");
    expect(repoFromThread([...boundToApi, { role: "user", text: "agent:coding in atlas: port it" }], isOnboarded)).toBe(
      "acme/api",
    );
    // No predicate (local/dev): nothing can be vetted, so an addressed slug stays weak like any other.
    expect(repoFromThread([...boundToApi, { role: "user", text: "agent:coding in acme/web: port it" }])).toBe(
      "acme/api",
    );
    expect(repoFromThread([...boundToApi, { role: "user", text: "also check acme/web" }])).toBe("acme/api");
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
