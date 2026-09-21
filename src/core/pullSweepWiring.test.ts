import { describe, expect, it } from "vitest";
import { buildPullSweepDeps, sweepThreadKey, type PullSweepWiringDeps, type SweepGithub } from "./pullSweepWiring.js";
import { createPullSweepService, type SweepGit, type SweepPullRequest } from "./pullSweep.js";
import { CommandRegistry, renderText, type Caller } from "./commandRegistry.js";
import { registerPullsCommands, type PullsCommandDeps } from "./commands/pulls.js";
import { callerWith } from "./testing/callers.js";
import { LGTM_TOKEN } from "./reviewVerdict.js";
import type { OpenPullRequestRow, PullRequestFacts } from "../execution/githubPulls.js";

// The pull sweep's production wiring (issue 2067; agent-ship.md item 20;
// record 0071, mechanism two): `buildPullSweepDeps` fills every dep of
// `PullSweepDeps` — the pipeline's listing with the facts read fresh, the
// LGTM carry pinned to the new head, the delta re-review and the one bounded
// model round through `dispatch()` (never started by the command handler),
// the anchor regeneration — so `pulls rebase` answers on every surface
// instead of `unavailable`.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const BOT = { login: "switchboard-app[bot]", id: 42 };

interface Recorded {
  factsAsked: number[];
  reviews: { number: number }[];
  posts: { number: number; commitId?: string; body: string }[];
  updates: { number: number; title: string; body: string }[];
  dispatched: { channelId: string; userId: string; threadKey: string; text: string }[];
}

function fakeGithub(rec: Recorded, body = ""): SweepGithub {
  const listing: OpenPullRequestRow[] = [
    { number: 7, headRef: "plan/demo/u1", baseRef: "main", headSha: SHA_A, sameRepoHead: true },
    { number: 9, headRef: "plan/demo/u2", baseRef: "main", headSha: SHA_B, sameRepoHead: true },
    // Not the pipeline's: a person's branch, and a fork's head.
    { number: 11, headRef: "feature/by-hand", baseRef: "main", headSha: SHA_B, sameRepoHead: true },
    { number: 12, headRef: "plan/demo/u3", baseRef: "main", headSha: SHA_B, sameRepoHead: false },
  ];
  const facts: Record<number, PullRequestFacts> = {
    7: {
      state: "open",
      sameRepoHead: true,
      headRef: "plan/demo/u1",
      baseRef: "main",
      headSha: SHA_A,
      mergeableState: "dirty",
    },
    9: {
      state: "open",
      sameRepoHead: true,
      headRef: "plan/demo/u2",
      baseRef: "main",
      headSha: SHA_B,
      mergeableState: "clean",
    },
    11: {
      state: "open",
      sameRepoHead: true,
      headRef: "feature/by-hand",
      baseRef: "main",
      headSha: SHA_B,
      mergeableState: "dirty",
    },
  };
  return {
    listOpen: async () => listing,
    facts: async (pr) => {
      rec.factsAsked.push(pr.number);
      return facts[pr.number];
    },
    reviews: async (pr) => {
      rec.reviews.push({ number: pr.number });
      // #7 carries an approval pinned at its head; #9 carries none at the head.
      return pr.number === 7
        ? [{ state: "APPROVED", commitId: SHA_A.toUpperCase(), body: "" }]
        : [{ state: "APPROVED", commitId: "d".repeat(40), body: "" }];
    },
    selfIdentity: async () => BOT,
    postReview: async (target, reviewBody) => {
      rec.posts.push({
        number: target.number,
        ...(target.commitId ? { commitId: target.commitId } : {}),
        body: reviewBody,
      });
    },
    titleBody: async () => ({ title: "feat(core): demo", body }),
    update: async (pr, patch) => {
      rec.updates.push({ number: pr.number, ...patch });
    },
  };
}

const stubGit: SweepGit = {
  rebase: async () => ({ kind: "clean", newHead: NEW_HEAD }),
  patchUnchanged: async () => true,
  forcePushWithLease: async () => {},
};

function wiring(rec: Recorded, over: Partial<PullSweepWiringDeps> = {}): PullSweepWiringDeps {
  return {
    github: fakeGithub(rec),
    git: stubGit,
    dispatch: async (request) => {
      rec.dispatched.push(request);
    },
    origin: { userId: "slack:UX", channelId: "slack:C1" },
    ...over,
  };
}

const record = (): Recorded => ({ factsAsked: [], reviews: [], posts: [], updates: [], dispatched: [] });

const pr7: SweepPullRequest = {
  repo: "acme/api",
  number: 7,
  branch: "plan/demo/u1",
  base: "main",
  headSha: SHA_A,
  mergeableState: "dirty",
  approved: true,
};

describe("buildPullSweepDeps — the listing", () => {
  it("runner lookup includes an adopted same-repo branch that the command sweep correctly excludes", async () => {
    const rec = record();
    const deps = buildPullSweepDeps(wiring(rec));
    expect(await deps.findPullRequest?.("acme/api", 11)).toMatchObject({
      number: 11,
      branch: "feature/by-hand",
      mergeableState: "dirty",
    });
    expect((await deps.listOwnedPullRequests("acme/api")).map((pr) => pr.number)).toEqual([7, 9]);
  });

  it("keeps the plan branches on the base repository, reads each one's facts fresh and the approval at the head", async () => {
    const rec = record();
    const deps = buildPullSweepDeps(wiring(rec));
    const prs = await deps.listOwnedPullRequests("acme/api");
    // pull request 11 (a person's branch) and 12 (a fork's head) never reach the facts read.
    expect(rec.factsAsked).toEqual([7, 9]);
    expect(prs).toEqual([
      {
        repo: "acme/api",
        number: 7,
        branch: "plan/demo/u1",
        base: "main",
        headSha: SHA_A,
        mergeableState: "dirty",
        approved: true,
      },
      {
        repo: "acme/api",
        number: 9,
        branch: "plan/demo/u2",
        base: "main",
        headSha: SHA_B,
        mergeableState: "clean",
        approved: false,
      },
    ]);
  });

  it("counts the bot's own LGTM: review pinned at the head as the approval — the merge door's read", async () => {
    // The pipeline posts its approvals with event COMMENT (state COMMENTED on
    // GitHub), so without the auto-approve workflow no APPROVED state exists;
    // the carry must still fire off the bot's pinned LGTM.
    const rec = record();
    const github: SweepGithub = {
      ...fakeGithub(rec),
      reviews: async (pr) =>
        pr.number === 7
          ? [{ state: "COMMENTED", author: BOT, commitId: SHA_A, body: `${LGTM_TOKEN} pinned at the head` }]
          : [
              // Someone else's LGTM-shaped comment, and the bot's off the head: neither counts.
              {
                state: "COMMENTED",
                author: { login: "someone-else", id: 7 },
                commitId: SHA_B,
                body: `${LGTM_TOKEN} x`,
              },
              { state: "COMMENTED", author: BOT, commitId: "d".repeat(40), body: `${LGTM_TOKEN} stale` },
            ],
    };
    const deps = buildPullSweepDeps(wiring(rec, { github }));
    const prs = await deps.listOwnedPullRequests("acme/api");
    expect(prs.map((p) => [p.number, p.approved])).toEqual([
      [7, true],
      [9, false],
    ]);
  });

  it("an unknown bot identity counts only genuine APPROVED reviews, never an LGTM body", async () => {
    const rec = record();
    const github: SweepGithub = {
      ...fakeGithub(rec),
      selfIdentity: async () => undefined,
      reviews: async (pr) =>
        pr.number === 7
          ? [{ state: "COMMENTED", author: BOT, commitId: SHA_A, body: `${LGTM_TOKEN} unverifiable` }]
          : [{ state: "APPROVED", commitId: SHA_B, body: "" }],
    };
    const deps = buildPullSweepDeps(wiring(rec, { github }));
    const prs = await deps.listOwnedPullRequests("acme/api");
    expect(prs.map((p) => [p.number, p.approved])).toEqual([
      [7, false],
      [9, true],
    ]);
  });

  it("drops a pull request whose facts cannot be read or that closed between the listing and the read", async () => {
    const rec = record();
    const deps = buildPullSweepDeps(wiring(rec, { github: { ...fakeGithub(rec), facts: async () => undefined } }));
    expect(await deps.listOwnedPullRequests("acme/api")).toEqual([]);
  });
});

describe("buildPullSweepDeps — the effects", () => {
  it("the approval carry is the bot's LGTM review pinned to the new head", async () => {
    const rec = record();
    const deps = buildPullSweepDeps(wiring(rec));
    await deps.effects.carryApproval(pr7, NEW_HEAD);
    expect(rec.posts).toEqual([
      { number: 7, commitId: NEW_HEAD, body: expect.stringMatching(/^LGTM: approval carried/) as string },
    ]);
    expect(rec.posts[0]!.body.startsWith(LGTM_TOKEN)).toBe(true);
  });

  it("the delta re-review is a review request through dispatch(), as the requester, on the sweep's own thread", async () => {
    const rec = record();
    const deps = buildPullSweepDeps(wiring(rec));
    await deps.effects.requestDeltaReview(pr7, NEW_HEAD);
    expect(rec.dispatched).toEqual([
      {
        channelId: "slack:C1",
        userId: "slack:UX",
        threadKey: sweepThreadKey(pr7),
        text: expect.stringContaining("agent:review https://github.com/acme/api/pull/7") as string,
      },
    ]);
  });

  it("the model round goes through dispatch() under the lease budget, is spent once per pull request, and a refused dispatch names why", async () => {
    const rec = record();
    const deps = buildPullSweepDeps(wiring(rec));
    expect(await deps.effects.modelRoundSpent(pr7)).toBe(false);
    const round = await deps.effects.startModelRound(pr7, { leaseMinutes: 15, spendCapUsd: 5 });
    expect(round).toEqual({ started: true });
    expect(rec.dispatched).toHaveLength(1);
    expect(rec.dispatched[0]!.text).toContain("agent:coding budget:15");
    expect(rec.dispatched[0]!.text).toContain("plan/demo/u1");
    expect(rec.dispatched[0]!.threadKey).toBe("http:pulls:acme/api#7");
    expect(await deps.effects.modelRoundSpent(pr7)).toBe(true);

    const failing = record();
    const refused = buildPullSweepDeps(
      wiring(failing, {
        dispatch: async () => {
          throw new Error("admission refused");
        },
      }),
    );
    expect(await refused.effects.startModelRound(pr7, { leaseMinutes: 15, spendCapUsd: 5 })).toEqual({
      started: false,
      reason: "admission refused",
    });
    // A round that never started is not spent.
    expect(await refused.effects.modelRoundSpent(pr7)).toBe(false);
  });

  it("the spent-round flag rides the shared state across per-requester instances", async () => {
    const rec = record();
    const state = { roundSpent: new Set<string>() };
    const one = buildPullSweepDeps(wiring(rec, { state }));
    await one.effects.startModelRound(pr7, { leaseMinutes: 15, spendCapUsd: 5 });
    const two = buildPullSweepDeps(wiring(record(), { state, origin: { userId: "slack:UY" } }));
    expect(await two.effects.modelRoundSpent(pr7)).toBe(true);
  });

  it("the anchor regeneration rewrites the description's blob permalinks to the new head, and a body without one is left alone", async () => {
    const rec = record();
    const body = [
      `1. [door](https://github.com/acme/api/blob/${SHA_A}/src/door.ts#L10-L20) the door`,
      `2. [other repo](https://github.com/acme/other/blob/${SHA_A}/x.ts#L1-L2) untouched`,
    ].join("\n");
    const deps = buildPullSweepDeps(wiring(rec, { github: fakeGithub(rec, body) }));
    await deps.effects.regenerateAnchors(pr7, NEW_HEAD);
    expect(rec.updates).toEqual([
      {
        number: 7,
        title: "feat(core): demo",
        body: [
          `1. [door](https://github.com/acme/api/blob/${NEW_HEAD}/src/door.ts#L10-L20) the door`,
          `2. [other repo](https://github.com/acme/other/blob/${SHA_A}/x.ts#L1-L2) untouched`,
        ].join("\n"),
      },
    ]);

    const noLinks = record();
    const untouched = buildPullSweepDeps(wiring(noLinks, { github: fakeGithub(noLinks, "no permalink here") }));
    await untouched.effects.regenerateAnchors(pr7, NEW_HEAD);
    expect(noLinks.updates).toEqual([]);
  });
});

describe("the wired command — no `unavailable` on any surface", () => {
  function wiredRegistry(rec: Recorded) {
    const registry = new CommandRegistry<PullsCommandDeps>({ audit: () => {} });
    registerPullsCommands(registry);
    const deps: PullsCommandDeps = {
      pulls: {
        service: async (origin) => createPullSweepService(buildPullSweepDeps(wiring(rec, { origin }))),
      },
    };
    return { registry, deps };
  }

  it.each([
    ["chat", callerWith("chat", "slack:UX", "all", { origin: { channelId: "slack:C1", threadKey: "slack:C1:1" } })],
    ["cli", callerWith("cli", "cli:local", "all")],
    ["mcp", callerWith("mcp", "mcp:ops", "all")],
  ] as [string, Caller][])("the wiring resolves every dep on %s", async (_surface, caller) => {
    const rec = record();
    const { registry, deps } = wiredRegistry(rec);
    const res = await registry.invoke("pulls.rebase", { options: { repo: "acme/api" } }, caller, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const text = renderText(registry.get("pulls.rebase")!, (res as unknown as { value: unknown }).value as never);
    // The dirty one walked rung one (the stub git), the clean one was skipped.
    expect(text).toContain("#7 rebased, patch unchanged, approval carried");
    expect(text).toContain("#9 skipped, already current");
    // The carry posted the pinned LGTM; nothing was dispatched (no conflict).
    expect(rec.posts).toEqual([{ number: 7, commitId: NEW_HEAD, body: expect.stringContaining("LGTM:") as string }]);
    expect(rec.dispatched).toEqual([]);
  });
});
