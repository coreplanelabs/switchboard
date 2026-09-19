// The ship preflight's entry cases (docs/reference/specs/agent-ship.md items 9
// and 10): adopt, resume, context, seeded — the repository lookup that is
// advisory only (no repository-level auto-merge check remains; the auto-merge
// fact is the pull request's own, named, never refused) — and the base ref
// existence check that keeps a misbound ref from aborting round 0 (issue 1827).
import { describe, expect, it, vi } from "vitest";
import type { PullRequestFacts, RepoShipInfo } from "../../execution/githubPulls.js";
import type { RefusalCause, RefusalCode } from "../refusal.js";
import { shipPreflight, shipTaskText, shipUnitText, type ShipPreflightInput } from "./preflight.js";

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

  it("context: a FOREIGN in-message pull request (not the thread's own) beside task text stays context — a fresh entry off the default branch, even when its facts cannot be fetched or its head is a fork", async () => {
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

  it("the no-repo refusal guesses the one resident the request's repo token is near (record 0054) — the corrected line and the evidence ride the sentence — and stays without a guess when two tie", async () => {
    const near = await shipPreflight(
      input({
        repoCtx: {},
        requestText: "in acme/infra: add the onboarding link",
        repoCandidates: ["acme/infrastructure", "acme/api"],
      }),
    );
    expect(near.ok).toBe(false);
    if (near.ok) return;
    expect(near.refusal.code).toBe("ship_preflight_no_repo");
    expect(near.reply).toContain("Did you mean:");
    expect(near.reply).toContain("`in acme/infrastructure: add the onboarding link`");
    expect(near.reply).toContain("which is onboarded");

    const tie = await shipPreflight(
      input({
        repoCtx: {},
        requestText: "in acme/infra: add the onboarding link",
        repoCandidates: ["acme/infrastructure", "acme/infra-tools"],
      }),
    );
    expect(tie.ok).toBe(false);
    if (tie.ok) return;
    expect(tie.reply).not.toContain("Did you mean:");
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

  it("every gate's refusal carries its own `ship_preflight_*` code and the table's cause — ten codes, one per gate, the result carrying it (record 0054)", async () => {
    const cases: Array<{ gate: string; code: RefusalCode; cause: RefusalCause; input: ShipPreflightInput }> = [
      {
        gate: "channel",
        code: "ship_preflight_channel",
        cause: "system",
        input: input({ channelId: "http:CX" }),
      },
      {
        gate: "permission",
        code: "ship_preflight_permission",
        cause: "policy",
        input: input({ gates: { canRunAgent: (a) => a !== "coding", adminsHint: () => "an admin" } }),
      },
      {
        gate: "no repo",
        code: "ship_preflight_no_repo",
        cause: "request",
        input: input({ repoCtx: {} }),
      },
      {
        gate: "thread PR unreachable",
        code: "ship_preflight_pr_unreachable",
        cause: "system",
        input: input({ repoCtx: { repo: "acme/api", prUnpostable: { number: 7, reason: "unreachable" } } }),
      },
      {
        gate: "PR facts unavailable",
        code: "ship_preflight_pr_facts",
        cause: "system",
        input: input({ repoCtx: { repo: "acme/api", pr: 7 } }),
      },
      {
        gate: "fork head",
        code: "ship_preflight_fork_head",
        cause: "request",
        input: input({ repoCtx: { repo: "acme/api", pr: 7 }, prFacts: async () => openPr({ sameRepoHead: false }) }),
      },
      {
        gate: "head branch unknown",
        code: "ship_preflight_head_unknown",
        cause: "system",
        input: input({ repoCtx: { repo: "acme/api", pr: 7 }, prFacts: async () => openPr({ headRef: undefined }) }),
      },
      {
        gate: "closed resume target",
        code: "ship_preflight_closed_resume",
        cause: "request",
        input: input({
          requestText: PR_URL,
          repoCtx: { repo: "acme/api", pr: 7 },
          prFacts: async () => openPr({ state: "closed" }),
        }),
      },
      {
        gate: "no task",
        code: "ship_preflight_no_task",
        cause: "request",
        input: input({ requestText: "" }),
      },
      {
        gate: "base ref missing",
        code: "ship_preflight_base_missing",
        cause: "request",
        input: input({
          requestText: "in acme/api: fix it on branch feat/gone",
          repoCtx: { repo: "acme/api", ref: "feat/gone" },
          refExists: async () => false,
        }),
      },
    ];
    const codes = new Set<string>();
    for (const c of cases) {
      const res = await shipPreflight(c.input);
      expect(res.ok, `${c.gate}: expected a refusal`).toBe(false);
      if (res.ok) continue;
      expect(res.refusal.code, c.gate).toBe(c.code);
      expect(res.refusal.cause, c.gate).toBe(c.cause);
      // The result carries the reply itself: the card and the refusal's text
      // are one sentence, byte-identical.
      expect(res.refusal.text, c.gate).toBe(res.reply);
      codes.add(res.refusal.code);
    }
    expect(codes.size, "one code per gate, never a shared one").toBe(10);
  });
});

describe("shipPreflight — the base ref existence check before the pipeline branch is cut (agent-ship item 10, issue 1827)", () => {
  const FLAKE_TASK = "in acme/api: the ci job flakes on web/src/pages/runPage.test.ts — fix it";

  it("an ambiguously bound ref that does not exist falls back to the default branch, the fallback named on the entry", async () => {
    const refExists = vi.fn(async () => false);
    const res = await shipPreflight(
      input({
        requestText: FLAKE_TASK,
        repoCtx: { repo: "acme/api", ref: "web/src/pages/runPage.test.ts" },
        refExists,
      }),
    );
    expect(res).toEqual({
      ok: true,
      entry: { repo: "acme/api", base: "main", baseFallback: { requested: "web/src/pages/runPage.test.ts" } },
    });
    expect(refExists).toHaveBeenCalledWith("acme/api", "web/src/pages/runPage.test.ts");
  });

  it("an explicitly named ref (branch keyword) that does not exist is refused fail-closed naming the ref", async () => {
    const res = await shipPreflight(
      input({
        requestText: "in acme/api: fix the login redirect on branch feat/gone",
        repoCtx: { repo: "acme/api", ref: "feat/gone" },
        refExists: async () => false,
      }),
    );
    expect(res).toMatchObject({ ok: false, where: "base ref missing" });
    if (res.ok) return;
    expect(res.refusal.code).toBe("ship_preflight_base_missing");
    expect(res.reply).toContain("`feat/gone`");
    expect(res.reply).toContain("acme/api");
  });

  it("an explicitly named ref (tree URL) that does not exist is refused the same way — slashes in the ref included", async () => {
    const res = await shipPreflight(
      input({
        requestText: "fix the login redirect on https://github.com/acme/api/tree/feat/gone",
        repoCtx: { repo: "acme/api", ref: "feat/gone" },
        refExists: async () => false,
      }),
    );
    expect(res).toMatchObject({ ok: false, where: "base ref missing" });
    if (!res.ok) expect(res.reply).toContain("`feat/gone`");
  });

  it("an existing ref is unchanged — the entry carries it as the base with no fallback", async () => {
    const res = await shipPreflight(
      input({
        requestText: "in acme/api: fix the login redirect on branch feat/trunk",
        repoCtx: { repo: "acme/api", ref: "feat/trunk" },
        refExists: async () => true,
      }),
    );
    expect(res).toEqual({ ok: true, entry: { repo: "acme/api", base: "feat/trunk" } });
  });

  it("an unanswerable lookup (undefined, or a throw) proceeds unchanged — advisory like the repository lookup, never a silent rebase", async () => {
    const unknown = await shipPreflight(
      input({
        requestText: FLAKE_TASK,
        repoCtx: { repo: "acme/api", ref: "feat/trunk" },
        refExists: async () => undefined,
      }),
    );
    expect(unknown).toEqual({ ok: true, entry: { repo: "acme/api", base: "feat/trunk" } });
    const throwing = await shipPreflight(
      input({
        requestText: FLAKE_TASK,
        repoCtx: { repo: "acme/api", ref: "feat/trunk" },
        refExists: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(throwing).toEqual({ ok: true, entry: { repo: "acme/api", base: "feat/trunk" } });
  });

  it("no seam given → no check (existing callers unchanged); no ref bound → the lookup is never spent", async () => {
    const unchecked = await shipPreflight(
      input({ requestText: FLAKE_TASK, repoCtx: { repo: "acme/api", ref: "web/src/pages/runPage.test.ts" } }),
    );
    expect(unchecked).toEqual({ ok: true, entry: { repo: "acme/api", base: "web/src/pages/runPage.test.ts" } });
    const refExists = vi.fn(async () => false);
    const noRef = await shipPreflight(input({ repoCtx: { repo: "acme/api" }, refExists }));
    expect(noRef).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
    expect(refExists).not.toHaveBeenCalled();
  });

  it("a pull request's own base that does not exist is refused fail-closed naming the ref — adopt and resume alike", async () => {
    const adopt = await shipPreflight(
      input({ repoCtx: { repo: "acme/api", pr: 7 }, prFacts: async () => openPr(), refExists: async () => false }),
    );
    expect(adopt).toMatchObject({ ok: false, where: "base ref missing" });
    if (!adopt.ok) expect(adopt.reply).toContain("`release/1.x`");
    const resume = await shipPreflight(
      input({
        requestText: PR_URL,
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts: async () => openPr(),
        refExists: async () => false,
      }),
    );
    expect(resume).toMatchObject({ ok: false, where: "base ref missing" });
  });

  it("a pull request's own base that exists leaves the adopt unchanged; a PR without its own base spends no lookup", async () => {
    const refExists = vi.fn(async () => true);
    const adopt = await shipPreflight(
      input({ repoCtx: { repo: "acme/api", pr: 7 }, prFacts: async () => openPr(), refExists }),
    );
    expect(adopt).toMatchObject({ ok: true, entry: { branch: "feat/rate-limit", base: "release/1.x" } });
    expect(refExists).toHaveBeenCalledWith("acme/api", "release/1.x");
    const noBase = vi.fn(async () => false);
    const fallback = await shipPreflight(
      input({
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts: async () => openPr({ baseRef: undefined }),
        refExists: noBase,
      }),
    );
    expect(fallback).toMatchObject({ ok: true, entry: { base: "main" } });
    expect(noBase).not.toHaveBeenCalled();
  });
});

describe("shipPreflight — the entry table over (task text, PR source, thread's own, PR facts) (agent-ship item 10, issue 1799)", () => {
  const OWN_TASK = `CI is red on ${PR_URL} — fix the failing check, keep one commit`;
  /** The thread's own pull request, named by URL in the current message — the
   *  re-issue shape of issue 1799. The resolver hands both facts: the reference
   *  is in-message (prFromMessage) AND the PR is the thread's own (prIsThreadOwn,
   *  off the thread's record PR / unit row). */
  const ownCtx = {
    repo: "acme/api",
    pr: 7,
    prFromMessage: true,
    prIsThreadOwn: true,
    ref: "feat/rate-limit",
    refFromPr: true,
  };
  /** A stranger's pull request cited as evidence inside the task text. */
  const foreignCtx = { repo: "acme/api", pr: 508, prFromMessage: true, ref: "feat/rate-limit", refFromPr: true };

  it("row 1 — task · PR from thread inference · open → adopt", async () => {
    const res = await shipPreflight(
      input({
        requestText: "in acme/api: also add rate limiting",
        repoCtx: { repo: "acme/api", pr: 7, ref: "feat/rate-limit", refFromPr: true },
        prFacts: async () => openPr(),
      }),
    );
    expect(res).toMatchObject({
      ok: true,
      entry: { branch: "feat/rate-limit", base: "release/1.x", adopt: { pr: 7, url: PR_URL } },
    });
  });

  it("row 2 — no task · PR from message · open, any author → resume", async () => {
    const res = await shipPreflight(
      input({
        requestText: PR_URL,
        repoCtx: { repo: "acme/api", pr: 7, prFromMessage: true, ref: "feat/rate-limit", refFromPr: true },
        prFacts: async () => openPr({ author: { login: "alice", id: 1 } }),
      }),
    );
    expect(res).toMatchObject({ ok: true, entry: { resume: { pr: 7, headSha: HEAD, url: PR_URL } } });
  });

  it("row 3 — task · PR from message · thread's own · open same-repo → ADOPT, never a fresh plan branch (the defect)", async () => {
    const res = await shipPreflight(input({ requestText: OWN_TASK, repoCtx: ownCtx, prFacts: async () => openPr() }));
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

  it("row 4 — task · PR from message · thread's own · unfetchable → refused ship_preflight_pr_facts (fail-closed like every adopt)", async () => {
    const res = await shipPreflight(input({ requestText: OWN_TASK, repoCtx: ownCtx, prFacts: async () => undefined }));
    expect(res).toMatchObject({ ok: false, where: "PR facts unavailable" });
    if (!res.ok) expect(res.refusal.code).toBe("ship_preflight_pr_facts");
  });

  it("row 5 — task · PR from message · thread's own · fork head → refused ship_preflight_fork_head", async () => {
    const res = await shipPreflight(
      input({ requestText: OWN_TASK, repoCtx: ownCtx, prFacts: async () => openPr({ sameRepoHead: false }) }),
    );
    expect(res).toMatchObject({ ok: false, where: "fork-head PR" });
    if (!res.ok) expect(res.refusal.code).toBe("ship_preflight_fork_head");
  });

  it("row 6 — task · PR from message · thread's own · closed → a fresh entry off the default branch", async () => {
    const res = await shipPreflight(
      input({ requestText: OWN_TASK, repoCtx: ownCtx, prFacts: async () => openPr({ state: "closed" }) }),
    );
    expect(res).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
  });

  it("row 7 — task · PR from message · NOT the thread's · open → a fresh entry off the default branch (context; the guard against a cited foreign PR hijacking a thread)", async () => {
    const res = await shipPreflight(
      input({
        requestText: "investigate the bug seen on acme/api#508",
        repoCtx: foreignCtx,
        prFacts: async () => openPr(),
      }),
    );
    expect(res).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
  });

  it("row 8 — task · PR from message · NOT the thread's · unfetchable or fork → a fresh entry (context stays context)", async () => {
    const unfetchable = await shipPreflight(
      input({
        requestText: "investigate the bug seen on acme/api#508",
        repoCtx: foreignCtx,
        prFacts: async () => undefined,
      }),
    );
    expect(unfetchable).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
    const fork = await shipPreflight(
      input({
        requestText: "investigate the bug seen on acme/api#508",
        repoCtx: foreignCtx,
        prFacts: async () => openPr({ sameRepoHead: false }),
      }),
    );
    expect(fork).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
  });

  it("row 9 — seeded `plan <path>` request · any PR → the graph's branches, the PR is context and its facts never read", async () => {
    const prFacts = vi.fn(async () => openPr());
    const res = await shipPreflight(
      input({ requestText: "in acme/api: plan docs/plans/fixture.md", repoCtx: ownCtx, prFacts }),
    );
    expect(res).toEqual({ ok: true, entry: { repo: "acme/api", base: "main" } });
    expect(prFacts).not.toHaveBeenCalled();
  });
});

describe("shipUnitText — the generated unit's text is the request as written (agent-ship item 16)", () => {
  it("keeps every url: a Slack `<url|label>` link unwraps to its bare url, a pasted url stays, an issue reference stays; only the mention and the `in <repo>:` prefix go (directives are the caller's)", () => {
    const text =
      "<@U0BOT> in acme/infra: change the <http://meet.example.com/onboarding|meet.example.com/onboarding> redirect to <https://calendar.example/TrrMBAg7|calendar.example/…> (the new booking page), see acme/infra#12 and https://example.com/why";
    expect(shipUnitText(text, "acme/infra")).toBe(
      "change the http://meet.example.com/onboarding redirect to https://calendar.example/TrrMBAg7 (the new booking page), see acme/infra#12 and https://example.com/why",
    );
    // The same request stripped for the entry probe loses every url — the two
    // helpers answer different questions and must never be swapped.
    expect(shipTaskText(text, "acme/infra")).not.toContain("calendar.example");
  });

  it("the repository prefix goes in either case with or without its colon, only at the front — `in <repo>` mid-sentence and the slug in prose stay; an uppercase scheme unwraps too; an empty remainder is empty", () => {
    expect(shipUnitText("in ACME/INFRA fix the thing in the acme/infra repo", "acme/infra")).toBe(
      "fix the thing in the acme/infra repo",
    );
    expect(shipUnitText("the redirect in acme/infra is stale", "acme/infra")).toBe(
      "the redirect in acme/infra is stale",
    );
    expect(shipUnitText("<HTTPS://Example.com/A|label>", "acme/infra")).toBe("HTTPS://Example.com/A");
    expect(shipUnitText("   in acme/infra:  ", "acme/infra")).toBe("");
  });
});
