import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../runEvents.js";
import type { RunSession } from "../runRecord.js";
import type { RunView } from "../runsService.js";
import {
  carriesArtifacts,
  runArtifacts,
  THREAD_ARTIFACTS_BUDGET_BYTES,
  THREAD_ARTIFACTS_BUDGET_TOKENS,
  THREAD_ARTIFACTS_MAX_RUNS,
  threadArtifactsBlock,
  threadArtifactsFor,
  tldrOf,
  type ArtifactRecord,
} from "./threadArtifacts.js";

// docs/reference/specs/session-log.md item 9 (record 0034 "The session", as
// amended): a follow-up is handed the typed artifacts of the thread's runs
// since the agent's previous run — every finished run's record, other agents'
// and a coordinator's children included — rendered as data in one block, the
// newest runs within a budget, a cut said out loud.

const description = (tldr: string): RunEvent =>
  ({
    type: "pr_description",
    description: {
      title: "t",
      tldr,
      why: "w",
      pointers: [],
      feedbackWanted: "none",
      risk: "none",
      verified: "none",
      decisions: [],
      validation: { criteria: [] },
    },
  }) as RunEvent;

/** A review run's record: a verdict with two findings, posted pinned to the head it read. */
const review: ArtifactRecord = {
  id: "r-review",
  agent: "review",
  verdict: {
    verdict: "request_changes",
    summary: "two findings",
    head: "abc1234",
    findings: [
      { id: "F1", severity: "major", file: "src/login.ts", line: 10, title: "drops the session cookie" },
      { id: "F2", severity: "nit", file: "src/login.ts", title: "rename shadowed variable" },
    ],
  },
  reviewPost: { posted: true, target: { repo: "acme/api", number: 42 }, head: "abc1234", verdict: "request_changes" },
  events: [],
};

/** A coding run's record: the pull request it edited, its dispositions, its handoff and its description. */
const coding: ArtifactRecord = {
  id: "r-fix",
  agent: "coding",
  pr: { number: 42, url: "https://github.com/acme/api/pull/42", head: "fix/login" },
  dispositions: [
    { findingId: "F1", disposition: "fixed", note: "cookie set on the redirect" },
    { findingId: "F2", disposition: "declined", note: "" },
  ],
  handoff: {
    deviations: [{ from: "one helper", to: "two helpers", why: "the test needed both" }],
    followUps: [{ what: "the lockfile drift", where: "a unit of its own" }],
    unproven: [{ criterion: "the end-to-end flow", why: "no browser in the sandbox" }],
  },
  events: [description("An earlier draft."), description("Fixes the login redirect.")],
};

describe("threadArtifacts — the thread's typed artifacts since the previous run", () => {
  it("the cap is the newest six runs within 6,000 tokens at four characters a token", () => {
    expect(THREAD_ARTIFACTS_MAX_RUNS).toBe(6);
    expect(THREAD_ARTIFACTS_BUDGET_TOKENS).toBe(6_000);
    expect(THREAD_ARTIFACTS_BUDGET_BYTES).toBe(24_000);
  });

  it("tldrOf reads the last description's TL;DR; none, or a blank one, is nothing", () => {
    expect(tldrOf(coding.events)).toBe("Fixes the login redirect.");
    expect(tldrOf([])).toBeUndefined();
    expect(tldrOf(undefined)).toBeUndefined();
    expect(tldrOf([description("   ")])).toBeUndefined();
  });

  it("renders every artifact kind a record carries, as data, in one order: the pull request, the verdict with its findings by id, the dispositions by finding id, the handoff, the description's TL;DR, the review post", () => {
    const both: ArtifactRecord = { ...coding, ...review, id: "r-both", agent: "coding", events: coding.events };
    const text = runArtifacts(both)!;
    const lines = text.split("\n");
    expect(lines[0]).toBe("### run r-both (coding)");
    expect(text).toContain(
      "- pull request opened or edited: acme/api#42 (https://github.com/acme/api/pull/42), head branch fix/login",
    );
    expect(text).toContain("- verdict: request_changes — two findings");
    expect(text).toContain(
      "- findings:\n  - [major] F1 src/login.ts:10 — drops the session cookie\n  - [nit] F2 src/login.ts — rename shadowed variable",
    );
    expect(text).toContain("- dispositions:\n  - F1: fixed — cookie set on the redirect\n  - F2: declined");
    expect(text).toContain(
      "- handoff:\n  - Deviation: one helper → two helpers — the test needed both\n  - the lockfile drift — a unit of its own\n  - Unproven: the end-to-end flow — no browser in the sandbox",
    );
    expect(text).toContain("- description TL;DR: Fixes the login redirect.");
    expect(text).toContain("- review post: posted to acme/api#42 at abc1234 (request_changes)");
    const at = (needle: string) => text.indexOf(needle);
    expect(at("- pull request")).toBeLessThan(at("- verdict:"));
    expect(at("- verdict:")).toBeLessThan(at("- findings:"));
    expect(at("- findings:")).toBeLessThan(at("- dispositions:"));
    expect(at("- dispositions:")).toBeLessThan(at("- handoff:"));
    expect(at("- handoff:")).toBeLessThan(at("- description TL;DR:"));
    expect(at("- description TL;DR:")).toBeLessThan(at("- review post:"));
  });

  it("says what is absent out loud: a verdict without findings, an affirmed empty handoff, a post that did not land, a pull request without a head branch, a record with no agent", () => {
    const text = runArtifacts({
      id: "r-x",
      verdict: { verdict: "approve", summary: "clean" },
      handoff: { deviations: [], followUps: [], unproven: [] },
      reviewPost: { posted: false, reason: "reviewed head unknown" },
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      events: [],
    })!;
    expect(text.split("\n")[0]).toBe("### run r-x (agent unknown)");
    expect(text).toContain("- pull request opened or edited: acme/api#7 (https://github.com/acme/api/pull/7)\n");
    // A pull request whose URL is not GitHub's shape is named by number and URL as they are.
    expect(
      runArtifacts({ id: "r-y", pr: { number: 9, url: "https://forge.example/acme/api/merge/9" }, events: [] }),
    ).toContain("- pull request opened or edited: pull request 9 at https://forge.example/acme/api/merge/9");
    expect(text).toContain("- verdict: approve — clean\n- findings: none recorded");
    expect(text).toContain("- handoff: nothing to hand off (three empty lists)");
    expect(text).toContain("- review post: not posted — reviewed head unknown");
    expect(text).not.toContain("head branch");
    expect(text).not.toContain("TL;DR");
  });

  it("a record that carries no artifact renders nothing — a description whose pull request never opened is not one — and the view says so before any record is read", () => {
    expect(runArtifacts({ id: "r-chat", agent: "general", events: [] })).toBeUndefined();
    expect(runArtifacts({ id: "r-desc-only", agent: "coding", events: [description("unposted")] })).toBeUndefined();
    expect(carriesArtifacts({})).toBe(false);
    expect(carriesArtifacts({ verdict: review.verdict })).toBe(true);
    expect(carriesArtifacts({ dispositions: [] })).toBe(true);
    expect(carriesArtifacts({ handoff: coding.handoff })).toBe(true);
    expect(carriesArtifacts({ pr: coding.pr })).toBe(true);
    expect(carriesArtifacts({ reviewPost: review.reviewPost })).toBe(true);
  });

  it("the block: the heading names the window (since the previous run, or every run of the thread), the runs render oldest first with their ids, nothing is cut", () => {
    const since = threadArtifactsBlock([review, coding], { sincePrevious: true })!;
    expect(since.text.startsWith("ARTIFACTS OF THIS THREAD'S RUNS SINCE YOUR PREVIOUS RUN HERE (")).toBe(true);
    expect(since.text.indexOf("### run r-review (review)")).toBeLessThan(since.text.indexOf("### run r-fix (coding)"));
    expect(since.runs).toEqual(["r-review", "r-fix"]);
    expect(since.cut).toBe(0);
    expect(since.total).toBe(2);
    expect(since.text).not.toContain("(cut to");
    const all = threadArtifactsBlock([review], { sincePrevious: false })!;
    expect(all.text.startsWith("ARTIFACTS OF THIS THREAD'S RUNS (")).toBe(true);
    expect(all.text).not.toContain("SINCE YOUR PREVIOUS RUN");
  });

  it("the empty case: no records, or records carrying nothing, is no block", () => {
    expect(threadArtifactsBlock([], { sincePrevious: true })).toBeUndefined();
    expect(
      threadArtifactsBlock([{ id: "r-chat", agent: "general", events: [] }], { sincePrevious: false }),
    ).toBeUndefined();
  });

  it("the run cap keeps the newest runs, oldest first in the text, and the block says how many were cut", () => {
    const records = Array.from({ length: 8 }, (_, i) => ({ ...review, id: `r${i + 1}` }));
    const block = threadArtifactsBlock(records, { sincePrevious: true })!;
    expect(block.runs).toEqual(["r3", "r4", "r5", "r6", "r7", "r8"]);
    expect(block.cut).toBe(2);
    expect(block.total).toBe(8);
    expect(block.text).toContain(
      "(cut to the newest 6 of 8 runs that carried artifacts; the earlier records are on the runs' pages)",
    );
    expect(block.text).not.toContain("### run r2 ");
    expect(block.text.indexOf("### run r3 ")).toBeLessThan(block.text.indexOf("### run r8 "));
  });

  it("the byte budget keeps the newest whole runs that fit; when even the newest run's block is over it, the block names that run and renders none", () => {
    const one = runArtifacts(review)!;
    const budget = Buffer.byteLength(one, "utf8") * 2 + 10;
    const records = [review, { ...review, id: "r-mid" }, { ...review, id: "r-new" }];
    const two = threadArtifactsBlock(records, { sincePrevious: true, maxBytes: budget })!;
    expect(two.runs).toEqual(["r-mid", "r-new"]);
    expect(two.cut).toBe(1);
    expect(two.text).toContain("(cut to the newest 2 of 3 runs that carried artifacts");
    const none = threadArtifactsBlock(records, { sincePrevious: true, maxBytes: 100 })!;
    expect(none.runs).toEqual([]);
    expect(none.cut).toBe(3);
    expect(none.text).toContain(
      "the newest run's artifacts alone exceed the 100-byte budget — read them on its run page: run r-new",
    );
    expect(none.text).not.toContain("### run");
  });
});

describe("threadArtifactsFor — the records read off the thread's page", () => {
  const session = (agent: string): RunSession => ({
    key: `slack:C1:1.0:${agent}`,
    seedFrom: 0,
    request: 0,
    range: { from: 0, to: 3 },
  });
  const view = (over: Partial<RunView> & { id: string }): RunView => ({
    startedAt: 1_000,
    finished: true,
    eventCount: 0,
    ...over,
  });
  /** The page newest first: a live run, a review the runner spawned, the coding run, an older review. */
  const page: RunView[] = [
    view({ id: "r-live", agent: "general", finished: false }),
    view({
      id: "r-review",
      agent: "review",
      finishedAt: 9_000,
      session: session("review"),
      verdict: review.verdict,
      parentInstanceId: "inst-1",
      idempotencyKey: "inst-1:review-1",
    }),
    view({
      id: "r-fix",
      agent: "coding",
      finishedAt: 8_000,
      session: session("coding"),
      pr: coding.pr,
      dispositions: coding.dispositions,
    }),
    view({
      id: "r-old",
      agent: "review",
      finishedAt: 7_000,
      session: session("review"),
      verdict: { verdict: "request_changes", summary: "older" },
    }),
    view({ id: "r-chat", agent: "general", finishedAt: 6_000, session: session("general") }),
  ];
  const records: Record<string, ArtifactRecord> = {
    "r-review": review,
    "r-fix": coding,
    "r-old": { id: "r-old", agent: "review", verdict: { verdict: "request_changes", summary: "older" }, events: [] },
  };
  const service = () => ({
    getRun: vi.fn(async (id: string) => {
      const r = records[id];
      return r
        ? { ok: true as const, value: { ...view({ id }), ...r } }
        : { ok: false as const, error: "not_found" as const };
    }),
  });

  it("a coding follow-up reads the runs newer than its previous run — the runner's review child included — with their events, and hands the block and one seed note naming them", async () => {
    const runs = service();
    const out = await threadArtifactsFor({ runs, thread: page, agent: "coding" });
    expect(runs.getRun).toHaveBeenCalledTimes(1);
    expect(runs.getRun).toHaveBeenCalledWith("r-review", { include: "messages" });
    expect(out.block?.runs).toEqual(["r-review"]);
    expect(out.block?.text).toContain("SINCE YOUR PREVIOUS RUN HERE");
    expect(out.block?.text).toContain("[major] F1 src/login.ts:10 — drops the session cookie");
    expect(out.notes).toEqual(["thread artifacts: 1 run since the previous run rides the prompt (r-review)"]);
  });

  it("an agent with no previous run in the thread reads every finished run that carries artifacts — a live run and a run carrying none are never read — oldest first", async () => {
    const runs = service();
    const out = await threadArtifactsFor({ runs, thread: page, agent: "explore" });
    expect(runs.getRun.mock.calls.map((c) => c[0])).toEqual(["r-old", "r-fix", "r-review"]);
    expect(out.block?.runs).toEqual(["r-old", "r-fix", "r-review"]);
    expect(out.block?.text.startsWith("ARTIFACTS OF THIS THREAD'S RUNS (")).toBe(true);
    expect(out.notes).toEqual(["thread artifacts: 3 runs of the thread ride the prompt (r-old, r-fix, r-review)"]);
  });

  it("nothing since the previous run is no block and no note", async () => {
    const runs = service();
    const out = await threadArtifactsFor({ runs, thread: page, agent: "review" });
    expect(runs.getRun).not.toHaveBeenCalled();
    expect(out).toEqual({ notes: [] });
  });

  it("a record that cannot be read is left out with a note naming it, and the rest still ride", async () => {
    const runs = service();
    runs.getRun.mockImplementation(async (id: string) => {
      if (id === "r-fix") throw new Error("store down");
      const r = records[id];
      return r
        ? { ok: true as const, value: { ...view({ id }), ...r } }
        : { ok: false as const, error: "not_found" as const };
    });
    const out = await threadArtifactsFor({ runs, thread: page, agent: "explore" });
    expect(out.block?.runs).toEqual(["r-old", "r-review"]);
    expect(out.notes).toEqual([
      "thread artifacts: the record of run r-fix could not be read (store down) — left out",
      "thread artifacts: 2 runs of the thread ride the prompt (r-old, r-review)",
    ]);
    const gone = service();
    gone.getRun.mockResolvedValue({ ok: false as const, error: "not_found" as const });
    const none = await threadArtifactsFor({ runs: gone, thread: page, agent: "coding" });
    expect(none.block).toBeUndefined();
    expect(none.notes).toEqual([
      "thread artifacts: the record of run r-review could not be read (not_found) — left out",
    ]);
  });

  it("a cut is in the note too", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      view({ id: `r${i + 1}`, agent: "review", finishedAt: 10_000 - i, verdict: review.verdict }),
    );
    const runs = {
      getRun: vi.fn(async (id: string) => ({ ok: true as const, value: { ...view({ id }), ...review, id } })),
    };
    const out = await threadArtifactsFor({ runs, thread: many, agent: "coding" });
    expect(out.block?.runs).toEqual(["r6", "r5", "r4", "r3", "r2", "r1"]);
    expect(out.notes).toEqual([
      "thread artifacts: 6 runs of the thread ride the prompt (r6, r5, r4, r3, r2, r1); 1 older run cut by the run cap or the byte budget",
    ]);
  });
});
