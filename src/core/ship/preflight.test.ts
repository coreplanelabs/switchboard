// The ship preflight's entry cases (docs/reference/specs/agent-ship.md items 9
// and 10): adopt, resume, context, seeded — and the repository lookup that is
// advisory only (no repository-level auto-merge check remains; the auto-merge
// fact is the pull request's own, named, never refused).
import { describe, expect, it, vi } from "vitest";
import type { PullRequestFacts, RepoShipInfo } from "../../execution/githubPulls.js";
import { shipPreflight, type ShipPreflightInput } from "./preflight.js";

const HEAD = "a".repeat(40);
const PR_URL = "https://github.com/acme/api/pull/7";

const openPr = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  state: "open",
  author: { login: "alice", id: 42 },
  headRef: "feat/rate-limit",
  headSha: HEAD,
  sameRepoHead: true,
  baseRef: "release/1.x",
  htmlUrl: PR_URL,
  ...over,
});

function input(over: Partial<ShipPreflightInput> = {}): ShipPreflightInput {
  return {
    channelId: "slack:CX",
    threadKey: "slack:CX:1.0",
    requestText: "in acme/api: add a rate limit",
    repoCtx: { repo: "acme/api" },
    gates: { canRunAgent: () => true, adminsHint: () => "an admin" },
    repoInfo: async (): Promise<RepoShipInfo | undefined> => ({ defaultBranch: "main" }),
    prFacts: async () => undefined,
    ...over,
  };
}

describe("shipPreflight — the entry cases (agent-ship item 10) and the auto-merge fact (item 9)", () => {
  it("adopt: a generated task in a thread carrying an open pull request runs ON it — branch is the PR's head, base its own base, the PR named on the entry", async () => {
    const res = await shipPreflight(
      input({
        repoCtx: { repo: "acme/api", pr: 7, baseRef: "main", ref: "feat/rate-limit" },
        prFacts: async () => openPr(),
      }),
    );
    expect(res).toEqual({
      ok: true,
      entry: {
        repo: "acme/api",
        branch: "feat/rate-limit",
        base: "release/1.x",
        adopt: { pr: 7, url: PR_URL },
      },
    });
  });

  it("adopt works for a person-authored pull request identically — no bot-authorship check remains", async () => {
    const res = await shipPreflight(
      input({
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts: async () => openPr({ author: { login: "alice", id: 1 } }),
      }),
    );
    expect(res).toMatchObject({ ok: true, entry: { branch: "feat/rate-limit", adopt: { pr: 7 } } });
  });

  it("adopt carries the pull request's own auto-merge fact at entry, never a refusal", async () => {
    const res = await shipPreflight(
      input({ repoCtx: { repo: "acme/api", pr: 7 }, prFacts: async () => openPr({ autoMergeEnabled: true }) }),
    );
    expect(res).toMatchObject({ ok: true, entry: { autoMergeEnabled: true } });
  });

  it("resume: a bare reference to a person's open pull request resumes at review — any author", async () => {
    const res = await shipPreflight(
      input({
        requestText: PR_URL,
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts: async () => openPr({ autoMergeEnabled: false }),
      }),
    );
    expect(res).toEqual({
      ok: true,
      entry: {
        repo: "acme/api",
        branch: "feat/rate-limit",
        base: "release/1.x",
        resume: { pr: 7, headSha: HEAD, url: PR_URL },
        autoMergeEnabled: false,
      },
    });
  });

  it("context: an in-message pull request beside task text stays context — a fresh entry off the default branch, even when its facts cannot be fetched or its head is a fork", async () => {
    const unfetchable = await shipPreflight(
      input({
        requestText: "investigate the bug seen on acme/api#508",
        repoCtx: { repo: "acme/api", pr: 508, prFromMessage: true, ref: "feat/rate-limit", refFromPr: true },
        prFacts: async () => undefined,
      }),
    );
    expect(unfetchable).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
    const fork = await shipPreflight(
      input({
        requestText: "investigate the bug seen on acme/api#508",
        repoCtx: { repo: "acme/api", pr: 508, prFromMessage: true, ref: "feat/rate-limit", refFromPr: true },
        prFacts: async () => openPr({ sameRepoHead: false }),
      }),
    );
    expect(fork).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
  });

  it("a unit branch of ship's own is never a fresh task's base: a thread an earlier plan left bound at `plan/<id>/<slug>` starts the next generated plan off the default branch, while a person's own `on <ref>` still wins", async () => {
    // The shape two re-issued plans were born with today: the earlier plan's coding
    // child bound the thread at its unit branch; a plain-words re-issue then
    // made a new generated plan whose base became that unit branch.
    const rebound = await shipPreflight(
      input({
        requestText: "in acme/api: fix the login redirect, start from the pushed head",
        repoCtx: { repo: "acme/api", ref: "plan/fix-the-login-redirect-a1b2c3/u1" },
      }),
    );
    expect(rebound).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
    const named = await shipPreflight(
      input({ requestText: "in acme/api: fix the login redirect", repoCtx: { repo: "acme/api", ref: "feat/trunk" } }),
    );
    expect(named).toEqual({ ok: true, entry: { repo: "acme/api", base: "feat/trunk" } });
  });

  it("seeded: a `plan <path>.md` request in a pull-request thread keeps the graph's branches — the PR is context, the entry names no branch", async () => {
    const prFacts = vi.fn(async () => openPr());
    const res = await shipPreflight(
      input({
        requestText: "in acme/api: plan docs/plans/fixture.md",
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts,
      }),
    );
    expect(res).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
    expect(prFacts).not.toHaveBeenCalled();
  });

  it("seeded: a thread pull request that could not be fetched refuses nothing — the seeded path never needs its facts", async () => {
    const prFacts = vi.fn(async () => undefined);
    const res = await shipPreflight(
      input({
        requestText: "in acme/api: plan docs/plans/fixture.md",
        repoCtx: { repo: "acme/api", prUnpostable: { number: 7, reason: "unreachable" } },
        prFacts,
      }),
    );
    expect(res).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
    expect(prFacts).not.toHaveBeenCalled();
    // The same unreachable pull request still refuses a task or a bare
    // reference fail-closed: those paths need the facts.
    const task = await shipPreflight(
      input({ repoCtx: { repo: "acme/api", prUnpostable: { number: 7, reason: "unreachable" } }, prFacts }),
    );
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.reply).toContain("could not be fetched");
  });

  it("fork head refused on adopt and on resume", async () => {
    const forkFacts = async () => openPr({ sameRepoHead: false });
    const adopt = await shipPreflight(input({ repoCtx: { repo: "acme/api", pr: 7 }, prFacts: forkFacts }));
    expect(adopt).toMatchObject({ ok: false, where: "fork-head PR" });
    const resume = await shipPreflight(
      input({ requestText: PR_URL, repoCtx: { repo: "acme/api", pr: 7 }, prFacts: forkFacts }),
    );
    expect(resume).toMatchObject({ ok: false, where: "fork-head PR" });
  });

  it("a closed resume target is refused — nothing to resume", async () => {
    const res = await shipPreflight(
      input({
        requestText: PR_URL,
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts: async () => openPr({ state: "closed" }),
      }),
    );
    expect(res).toMatchObject({ ok: false, where: "closed resume target" });
  });

  it("an unfetchable adopt or resume target is refused fail-closed", async () => {
    const adopt = await shipPreflight(input({ repoCtx: { repo: "acme/api", pr: 7 } }));
    expect(adopt).toMatchObject({ ok: false, where: "PR facts unavailable" });
    const resume = await shipPreflight(input({ requestText: PR_URL, repoCtx: { repo: "acme/api", pr: 7 } }));
    expect(resume).toMatchObject({ ok: false, where: "PR facts unavailable" });
  });

  it("a failed repository lookup proceeds — an adopt still carries the pull request's base", async () => {
    const res = await shipPreflight(
      input({
        repoInfo: async () => undefined,
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts: async () => openPr(),
      }),
    );
    expect(res).toMatchObject({ ok: true, entry: { branch: "feat/rate-limit", base: "release/1.x" } });
  });

  it("a failed repository lookup with a fresh unit proceeds with no base — the hand-off's own refusal names it later; a repository with auto-merge allowed proceeds too (no repository-level check remains)", async () => {
    const fresh = await shipPreflight(input({ repoInfo: async () => undefined }));
    expect(fresh).toEqual({ ok: true, entry: { repo: "acme/api", base: undefined } });
    const throwing = await shipPreflight(
      input({
        repoInfo: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(throwing).toEqual({ ok: true, entry: { repo: "acme/api", base: undefined } });
  });
});
