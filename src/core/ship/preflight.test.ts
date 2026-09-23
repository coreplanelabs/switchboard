// The ship preflight's entry cases (docs/reference/specs/agent-ship.md items 9
// and 10): adopt, resume, context, seeded — the repository lookup that is
// advisory only (no repository-level auto-merge check remains; the auto-merge
// fact is the pull request's own, named, never refused) — and the base ref
// existence check that keeps a misbound ref from aborting round 0 (issue 1827).
import { describe, expect, it, vi } from "vitest";
import type { PullRequestFacts, RepoShipInfo } from "../../execution/githubPulls.js";
import type { RefusalCause, RefusalCode } from "../refusal.js";
import { resolveRepoContext } from "../repoContext.js";
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
    canOpenThread: true,
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
        adopt: { pr: 7, headSha: HEAD, url: PR_URL },
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
    expect(near.reply).not.toContain("e.g.");
    expect(near.guess).toMatchObject({
      line: "agent:ship in acme/infrastructure: add the onboarding link",
      evidence: expect.stringContaining("which is onboarded") as unknown as string,
    });

    const tie = await shipPreflight(
      input({
        repoCtx: {},
        requestText: "in acme/infra: add the onboarding link",
        repoCandidates: ["acme/infrastructure", "acme/infra-tools"],
      }),
    );
    expect(tie.ok).toBe(false);
    if (tie.ok) return;
    expect(tie.guess).toBeUndefined();
  });

  it("a write ask with one candidate repository asks one yes/no question with a runnable guess, never a syntax example", async () => {
    const one = await shipPreflight(
      input({
        repoCtx: {},
        requestText: "fix issue 2131",
        repoCandidates: ["acme/api"],
      }),
    );
    expect(one.ok).toBe(false);
    if (one.ok) return;
    expect(one.reply).toBe("🚫 `agent:ship` needs a target repository. Is `acme/api` the target?");
    expect(one.guess).toEqual({
      line: "agent:ship in acme/api: fix issue 2131",
      evidence: "`acme/api` is the one available repository",
    });
    expect(one.reply).not.toContain("e.g.");
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

  it("every gate's refusal carries its own `ship_preflight_*` code and the table's cause — nine codes, one per gate, the result carrying it (record 0054)", async () => {
    const cases: Array<{ gate: string; code: RefusalCode; cause: RefusalCause; input: ShipPreflightInput }> = [
      {
        gate: "channel",
        code: "ship_preflight_channel",
        cause: "system",
        input: input({ channelId: "http:CX", canOpenThread: false }),
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
    expect(codes.size, "one code per gate, never a shared one").toBe(9);
  });
});

describe("shipPreflight — the channel capability (agent-ship item 1, record 0060)", () => {
  it("admits by the request handle's capability: a web or CLI handle that can open a thread passes", async () => {
    const web = await shipPreflight(input({ channelId: "web:s", threadKey: "web:s:c9", canOpenThread: true }));
    expect(web.ok).toBe(true);
    const cli = await shipPreflight(input({ channelId: "cli:local", threadKey: "cli:local:t1", canOpenThread: true }));
    expect(cli.ok).toBe(true);
  });

  it("refuses a handle that cannot open a thread — HTTP and MCP — with the spawn's reason and the run-page pointer, never calling the channel single-shot", async () => {
    for (const channelId of ["http:ingress", "mcp:client"]) {
      const res = await shipPreflight(input({ channelId, canOpenThread: false, runsBase: "https://bot.example" }));
      expect(res.ok, channelId).toBe(false);
      if (res.ok) continue;
      expect(res.refusal.code, channelId).toBe("ship_preflight_channel");
      expect(res.reply, channelId).toContain("cannot open a thread of its own");
      expect(res.reply, channelId).toContain(channelId.split(":")[0]);
      expect(res.reply, channelId).toContain("https://bot.example/runs");
      expect(res.reply.toLowerCase(), channelId).not.toContain("single-shot");
    }
  });
});

describe("shipPreflight — the base ref existence check before the pipeline branch is cut (agent-ship item 10, issues 1827 and 2161)", () => {
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

  it("a missing branch token falls back to the default branch instead of refusing or naming a command", async () => {
    const res = await shipPreflight(
      input({
        requestText: "in acme/api branch:feat/gone fix the login redirect",
        repoCtx: { repo: "acme/api", ref: "feat/gone" },
        refExists: async () => false,
      }),
    );
    expect(res).toEqual({
      ok: true,
      entry: { repo: "acme/api", base: "main", baseFallback: { requested: "feat/gone" } },
    });
    expect(JSON.stringify(res)).not.toMatch(/agent:ship|repo test|Name an existing branch|Retarget/);
  });

  it("a missing tree-URL ref falls back the same way — slashes in the ref included", async () => {
    const res = await shipPreflight(
      input({
        requestText: "fix the login redirect on https://github.com/acme/api/tree/feat/gone",
        repoCtx: { repo: "acme/api", ref: "feat/gone" },
        refExists: async () => false,
      }),
    );
    expect(res).toEqual({
      ok: true,
      entry: { repo: "acme/api", base: "main", baseFallback: { requested: "feat/gone" } },
    });
  });

  it("the 20:05Z narrative fixture binds no ref and runs on the default branch", async () => {
    const repo = ["core", "planelabs/switchboard"].join("");
    const requestText = `in coreplanelabs/switchboard: fix issue #2154 — a human-gated review finding has no way back into the pipeline once the person answers. Today on PR #2140 the review found F2 "cold-reader acceptance gate was not independently run" (minor, humanGated: true); the coding child rightly declined it ("this coding context cannot manufacture independent evidence") and the pipeline ended held; the maintainer posted the receipt as a PR comment; a re-issue (attempt 3, run d69afa9a) adopted the PR and went straight to a review round, the reviewer re-raised the same human-gated finding, and the pipeline ended held again three minutes later, having never read the comment that answered it. The recovery took two hand-posted steps (a directive coding run on the branch with the answer, then another re-issue). Hold the invariant from record 0054: a human-gated finding is a question to a person, and the person's answer resumes the unit. Direction: when a review round yields only human-gated findings, the unit does not end — it parks with the question (record 0051's idle state, the finding as the pending state on the thread) and resumes on the next human input on the pull request or in the unit thread (a PR comment or a thread reply from a person), which becomes the fix round's brief (the finding plus the answer); an adopted attempt on a pull request whose newest human comment postdates the last verdict runs that fix round before the review, never review-first. Tests: a review with one human-gated finding parks the unit instead of ending it held; a person's PR comment resumes it into a fix round carrying the comment; an adopted attempt with a newer human comment runs fix-then-review; a human-gated finding alone never ends a pipeline held. Spec rows in agent-ship.md (the round's endings) and agent-review.md (humanGated). Receipt runnable when: worker:bot ≥ this PR's merge sha and a review posts a human-gated finding on a live unit (the next record acceptance is the natural fixture).`;
    const repoCtx = await resolveRepoContext({ text: requestText }, []);
    const refExists = vi.fn(async () => false);
    const res = await shipPreflight(
      input({
        requestText,
        repoCtx,
        repoInfo: async () => ({ defaultBranch: "main" }),
        refExists,
      }),
    );
    expect(repoCtx).toEqual({ repo });
    expect(res).toEqual({ ok: true, entry: { repo, base: "main" } });
    expect(refExists).not.toHaveBeenCalled();
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

  it("an existing pull request whose bound base is missing fails closed instead of publishing against a fallback", async () => {
    const adopt = await shipPreflight(
      input({ repoCtx: { repo: "acme/api", pr: 7 }, prFacts: async () => openPr(), refExists: async () => false }),
    );
    expect(adopt).toMatchObject({ ok: false, where: "pull request base branch missing" });
    const resume = await shipPreflight(
      input({
        requestText: PR_URL,
        repoCtx: { repo: "acme/api", pr: 7 },
        prFacts: async () => openPr(),
        refExists: async () => false,
      }),
    );
    expect(resume).toMatchObject({ ok: false, where: "pull request base branch missing" });
  });

  it("a pull request's own base that exists leaves the adopt unchanged; a PR without its own base fails before a lookup", async () => {
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
    expect(fallback).toMatchObject({ ok: false, where: "base branch unknown" });
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
        adopt: { pr: 7, headSha: HEAD, url: PR_URL },
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
