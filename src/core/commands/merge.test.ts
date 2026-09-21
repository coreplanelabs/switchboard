import { describe, expect, it } from "vitest";
import { boundBlastRadius, CommandRegistry, renderText } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import {
  isReleasePullRequest,
  mergeCommands,
  registerMergeCommands,
  renderMergeReport,
  type MergeCommandDeps,
  type MergeDoorFacts,
  type MergeDoorService,
} from "./merge.js";

// Feature: docs/reference/specs/orchestration-plane.md item 13 — the merge and
// the merge-queue enqueue as registry commands born fenced (record 0070,
// criteria 4 and 6; plan 004 unit 3): authorized by the policy table against
// the person, destructive at every input, refusing an unapproved head and a
// red check by reason, answering the release pull request with the handoff
// card, and calling GitHub under the person's own bound identity — never the
// App credential acting as nobody.

const HEAD = "a".repeat(40);

const OPEN_FACTS: MergeDoorFacts = {
  state: "open",
  headSha: HEAD,
  headRef: "feat/the-change",
  title: "feat(core): the change",
  htmlUrl: "https://github.com/acme/api/pull/42",
};

function setup(
  over: {
    facts?: MergeDoorFacts | undefined;
    checks?: { total: number; pending: string[]; failed: string[] } | undefined;
    reviews?: Array<{ state: string; commitId?: string; author?: { login?: string; id?: number } }> | undefined;
    login?: string | undefined;
    mergeAnswer?: { ok: true; sha: string } | { ok: false; status: number; reason: string };
    enqueueAnswer?: { ok: true } | { ok: false; reason: string };
  } = {},
) {
  const calls: string[] = [];
  const mergedWith: Array<{
    pr: { repo: string; number: number };
    opts: { sha: string; title: string; mergedBy?: string };
  }> = [];
  const enqueuedWith: Array<{
    pr: { repo: string; number: number };
    opts: { sha: string };
  }> = [];
  const door: MergeDoorService = {
    facts: async (pr) => {
      calls.push(`facts ${pr.repo}#${pr.number}`);
      return "facts" in over ? over.facts : OPEN_FACTS;
    },
    checks: async (repo, sha) => {
      calls.push(`checks ${repo}@${sha.slice(0, 7)}`);
      return "checks" in over ? over.checks : { total: 1, pending: [], failed: [] };
    },
    reviews: async (pr) => {
      calls.push(`reviews ${pr.repo}#${pr.number}`);
      return "reviews" in over ? over.reviews : [{ state: "APPROVED", commitId: HEAD }];
    },
    merge: async (pr, opts) => {
      calls.push(`merge ${pr.repo}#${pr.number}`);
      mergedWith.push({ pr, opts });
      return over.mergeAnswer ?? { ok: true, sha: "b".repeat(40) };
    },
    enqueue: async (pr, opts) => {
      calls.push(`enqueue ${pr.repo}#${pr.number}`);
      enqueuedWith.push({ pr, opts });
      return over.enqueueAnswer ?? { ok: true };
    },
    githubLogin: async (userId) => {
      calls.push(`login ${userId}`);
      return "login" in over ? over.login : "ivy-dev";
    },
  };
  const registry = new CommandRegistry<MergeCommandDeps>({ audit: () => {} });
  registerMergeCommands(registry);
  const deps: MergeCommandDeps = { merge: { service: async () => door } };
  return { registry, deps, calls, mergedWith, enqueuedWith };
}

const person = (grants: readonly string[] = ["merge:write"]) => callerWith("chat", "web:alice", grants);

describe("pulls merge and pulls enqueue — the merge door as commands (record 0070)", () => {
  it("registers both under merge:write, effect write, destructive at every input with a risk line naming the pull request", () => {
    expect(mergeCommands.map((c) => c.id)).toEqual(["pulls.merge", "pulls.enqueue"]);
    for (const cmd of mergeCommands) {
      expect(cmd).toMatchObject({ action: "merge:write", effect: "write" });
      expect(cmd.annotations?.destructive).toBe(true);
      expect(boundBlastRadius(cmd, { args: ["acme/api#42"], options: {} })).toBe("destructive");
      const risk = cmd.annotations?.risk;
      expect(typeof risk).toBe("function");
      expect(risk!({ args: ["acme/api#42"], options: {} })).toContain("acme/api#42");
    }
  });

  it("a grant-less person is refused by the policy table before the door is asked", async () => {
    const { registry, deps, calls } = setup();
    for (const id of ["pulls.merge", "pulls.enqueue"]) {
      const res = await registry.invoke(id, { args: ["acme/api#42"], options: {} }, person([]), deps);
      expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    }
    expect(calls).toEqual([]);
  });

  it("a person nobody bound to a GitHub login is refused by name — the App credential never merges as nobody (record 0062)", async () => {
    const { registry, deps, calls } = setup({ login: undefined });
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((res as { message?: string }).message).toContain("no GitHub login is bound to you");
    expect(calls).toEqual(["login web:alice"]);
  });

  it("merges an approved green head at exactly its sha, the person's bound login on the merge itself and in the answer", async () => {
    const { registry, deps, mergedWith } = setup();
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({
      ok: true,
      value: { kind: "merged", repo: "acme/api", number: 42, by: { user: "web:alice", login: "ivy-dev" } },
    });
    expect(mergedWith).toEqual([
      {
        pr: { repo: "acme/api", number: 42 },
        opts: { sha: HEAD, title: "feat(core): the change", mergedBy: "ivy-dev" },
      },
    ]);
    const text = renderText(
      mergeCommands[0],
      (res as { value: unknown }).value as Parameters<typeof renderMergeReport>[0],
    );
    expect(text).toContain("merged by ivy-dev (web:alice)");
  });
});

describe("the merge refuses unapproved heads and hands the release to a person", () => {
  it("an unapproved head is refused naming the head, and nothing is merged", async () => {
    const { registry, deps, calls } = setup({ reviews: [{ state: "APPROVED", commitId: "c".repeat(40) }] });
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((res as { message?: string }).message).toContain(`no review approves the head \`${HEAD.slice(0, 7)}\``);
    expect(calls).not.toContain("merge acme/api#42");
  });

  it("a red check at the approved head is refused naming the check", async () => {
    const { registry, deps, calls } = setup({ checks: { total: 2, pending: [], failed: ["ci / bot"] } });
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((res as { message?: string }).message).toContain("red check");
    expect((res as { message?: string }).message).toContain("ci / bot");
    expect(calls).not.toContain("merge acme/api#42");
  });

  it("a head with no check reported refuses the merge by that reason — the fresh-head window never merges unverified", async () => {
    const { registry, deps, calls } = setup({ checks: { total: 0, pending: [], failed: [] } });
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((res as { message?: string }).message).toContain("no check reported at the head of acme/api#42");
    expect(calls).not.toContain("merge acme/api#42");
  });

  it("a changes-requested review standing at the head refuses even beside an approval; a re-approval by the same reviewer clears it", async () => {
    const { registry, deps, calls } = setup({
      reviews: [
        { state: "CHANGES_REQUESTED", commitId: HEAD, author: { login: "rex" } },
        { state: "APPROVED", commitId: HEAD, author: { login: "ivy" } },
      ],
    });
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((res as { message?: string }).message).toContain(
      `a review requests changes at the head \`${HEAD.slice(0, 7)}\``,
    );
    expect(calls).not.toContain("merge acme/api#42");

    const cleared = setup({
      reviews: [
        { state: "CHANGES_REQUESTED", commitId: HEAD, author: { login: "rex" } },
        { state: "APPROVED", commitId: HEAD, author: { login: "rex" } },
      ],
    });
    const ok = await cleared.registry.invoke(
      "pulls.merge",
      { args: ["acme/api#42"], options: {} },
      person(),
      cleared.deps,
    );
    expect(ok).toMatchObject({ ok: true, value: { kind: "merged" } });
  });

  it("a check still running refuses the merge — green is the merge's own gate, not the queue's", async () => {
    const { registry, deps, calls } = setup({ checks: { total: 2, pending: ["ci / bot"], failed: [] } });
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((res as { message?: string }).message).toContain("still running");
    expect(calls).not.toContain("merge acme/api#42");
  });

  it("the release pull request is handed to a person with the handoff card — no merge is called, on either command", async () => {
    for (const id of ["pulls.merge", "pulls.enqueue"]) {
      const { registry, deps, calls } = setup({
        facts: { ...OPEN_FACTS, headRef: "release-please--branches--main", title: "chore(main): release 1.258.0" },
      });
      const res = await registry.invoke(id, { args: ["acme/api#42"], options: {} }, person(), deps);
      expect(res).toMatchObject({ ok: true, value: { kind: "handed", repo: "acme/api", number: 42 } });
      const card = renderMergeReport((res as { value: unknown }).value as Parameters<typeof renderMergeReport>[0]);
      expect(card).toContain("Release pull request acme/api#42");
      expect(card).toContain("This deploys production");
      expect(card).toContain("a person's click");
      expect(card).toContain("https://github.com/acme/api/pull/42");
      expect(calls).not.toContain("merge acme/api#42");
      expect(calls).not.toContain("enqueue acme/api#42");
    }
  });

  it("either release marker hands: the release-please branch, or the release title on any branch", () => {
    expect(isReleasePullRequest({ headRef: "release-please--branches--main" })).toBe(true);
    expect(isReleasePullRequest({ title: "chore(main): release 1.258.0" })).toBe(true);
    expect(isReleasePullRequest({ headRef: "feat/x", title: "feat(core): the change" })).toBe(false);
  });

  it("GitHub's own refusal (a moved head, a branch protection) is answered in GitHub's words", async () => {
    const { registry, deps } = setup({ mergeAnswer: { ok: false, status: 409, reason: "Head branch was modified" } });
    const res = await registry.invoke("pulls.merge", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect((res as { message?: string }).message).toContain("Head branch was modified");
  });
});

describe("the enqueue recorded under the person's name", () => {
  it("a head with no check reported still enqueues — running the checks is the queue's job", async () => {
    const { registry, deps, calls } = setup({ checks: { total: 0, pending: [], failed: [] } });
    const res = await registry.invoke("pulls.enqueue", { args: ["acme/api#42"], options: {} }, person(), deps);
    expect(res).toMatchObject({ ok: true, value: { kind: "enqueued", repo: "acme/api", number: 42 } });
    expect(calls).toContain("enqueue acme/api#42");
  });

  it("enqueues exactly the approved head and records who asked: the person's id and bound login in the answer", async () => {
    const { registry, deps, calls, enqueuedWith } = setup({
      checks: { total: 2, pending: ["ci / bot"], failed: [] },
    });
    const res = await registry.invoke("pulls.enqueue", { args: ["acme/api#42"], options: {} }, person(), deps);
    // A still-running check passes here: running the checks is the queue's job.
    expect(res).toMatchObject({
      ok: true,
      value: { kind: "enqueued", repo: "acme/api", number: 42, by: { user: "web:alice", login: "ivy-dev" } },
    });
    expect(calls).toContain("enqueue acme/api#42");
    expect(enqueuedWith).toEqual([{ pr: { repo: "acme/api", number: 42 }, opts: { sha: HEAD } }]);
    const text = renderText(
      mergeCommands[1],
      (res as { value: unknown }).value as Parameters<typeof renderMergeReport>[0],
    );
    expect(text).toContain("asked by ivy-dev (web:alice)");
  });

  it("the enqueue keeps the merge's fences: an unapproved head, a standing changes-requested and a red check refuse it", async () => {
    for (const over of [
      { reviews: [] as Array<{ state: string; commitId?: string }> },
      {
        reviews: [
          { state: "APPROVED", commitId: HEAD, author: { login: "ivy" } },
          { state: "CHANGES_REQUESTED", commitId: HEAD, author: { login: "rex" } },
        ],
      },
      { checks: { total: 1, pending: [], failed: ["ci / bot"] } },
    ]) {
      const { registry, deps, calls } = setup(over);
      const res = await registry.invoke("pulls.enqueue", { args: ["acme/api#42"], options: {} }, person(), deps);
      expect(res).toMatchObject({ ok: false, error: "conflict" });
      expect(calls).not.toContain("enqueue acme/api#42");
    }
  });
});
