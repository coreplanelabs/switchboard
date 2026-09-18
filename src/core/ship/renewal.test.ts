import { describe, expect, it } from "vitest";
import { progressOf, renewalDecision, renderRenewal, type Progress } from "./renewal.js";
import type { Handoff } from "./handoff.js";

const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
const T0 = 1_700_000_000_000;
const BRANCH = "plan/fixture/u1";
const handoff = (followUps: number, deviations = 0): Handoff => ({
  deviations: Array.from({ length: deviations }, (_, i) => ({ from: `f${i}`, to: `t${i}`, why: "w" })),
  followUps: Array.from({ length: followUps }, (_, i) => ({ what: `w${i}`, where: "x" })),
  unproven: [],
});

// Decision 0046, Renewal: progress is a fact the row records and the runner
// reads without a model — a pushed sha that differs from the head the lease
// started at, or a handoff whose follow-ups shrank or whose deviations grew.
describe("progressOf — progress is read off the row, never asked of the model", () => {
  it("a head pushed to the unit's branch after the lease began, differing from the segment's start, is progress", () => {
    expect(
      progressOf({ branch: BRANCH, pushed: [{ ref: BRANCH, sha: B, at: T0 + 1 }], startHead: A, leaseStartedAt: T0 }),
    ).toEqual({ progressed: true, by: "push", sha: B });
    // A fresh branch has no start head: a push of a new head is progress.
    expect(progressOf({ branch: BRANCH, pushed: [{ ref: BRANCH, sha: A }] })).toEqual({
      progressed: true,
      by: "push",
      sha: A,
    });
    // On a fresh branch the base head stands in for the start head: a later
    // push of a genuinely new head after the lease began is progress.
    expect(
      progressOf({
        branch: BRANCH,
        pushed: [{ ref: BRANCH, sha: B, at: T0 + 1 }],
        baseHead: A,
        leaseStartedAt: T0,
      }),
    ).toEqual({ progressed: true, by: "push", sha: B });
    // The last push to the branch is the one that counts.
    expect(
      progressOf({
        branch: BRANCH,
        pushed: [
          { ref: BRANCH, sha: A },
          { ref: BRANCH, sha: B },
        ],
        startHead: A,
      }),
    ).toEqual({
      progressed: true,
      by: "push",
      sha: B,
    });
  });

  it("a push to another ref, a push of the start head itself (a short sha included) or a push stamped before the lease is not progress", () => {
    expect(progressOf({ branch: BRANCH, pushed: [{ ref: "main", sha: B }], startHead: A })).toMatchObject({
      progressed: false,
    });
    expect(progressOf({ branch: BRANCH, pushed: [{ ref: BRANCH, sha: A }], startHead: A })).toMatchObject({
      progressed: false,
    });
    expect(progressOf({ branch: BRANCH, pushed: [{ ref: BRANCH, sha: A.slice(0, 7) }], startHead: A })).toMatchObject({
      progressed: false,
    });
    expect(
      progressOf({ branch: BRANCH, pushed: [{ ref: BRANCH, sha: B, at: T0 - 1 }], startHead: A, leaseStartedAt: T0 }),
    ).toMatchObject({ progressed: false });
    // A fresh branch is created at the base head, so its push of that head is
    // the branch's creation, not the unit's progress.
    expect(progressOf({ branch: BRANCH, pushed: [{ ref: BRANCH, sha: A }], baseHead: A })).toMatchObject({
      progressed: false,
    });
    // A recorded start head outranks the base head: continuing past the base is progress.
    expect(progressOf({ branch: BRANCH, pushed: [{ ref: BRANCH, sha: B }], startHead: A, baseHead: B })).toEqual({
      progressed: true,
      by: "push",
      sha: B,
    });
    const none = progressOf({ branch: BRANCH, pushed: [], startHead: A });
    expect(none).toEqual({
      progressed: false,
      why: `no head newer than the lease's start was pushed to \`${BRANCH}\``,
    });
  });

  it("with no push, a handoff whose follow-ups shrank or whose deviations grew is progress; an unchanged or grown one is not", () => {
    expect(progressOf({ branch: BRANCH, pushed: [], handoff: { previous: handoff(3), current: handoff(2) } })).toEqual({
      progressed: true,
      by: "handoff",
    });
    expect(
      progressOf({ branch: BRANCH, pushed: [], handoff: { previous: handoff(2, 0), current: handoff(2, 1) } }),
    ).toEqual({
      progressed: true,
      by: "handoff",
    });
    expect(progressOf({ branch: BRANCH, pushed: [], handoff: { previous: handoff(2), current: handoff(2) } })).toEqual({
      progressed: false,
      why: `no head newer than the lease's start was pushed to \`${BRANCH}\` and the handoff is unchanged`,
    });
    expect(
      progressOf({ branch: BRANCH, pushed: [], handoff: { previous: handoff(2), current: handoff(3) } }),
    ).toMatchObject({
      progressed: false,
    });
  });
});

const progressed: Progress = { progressed: true, by: "push", sha: B };
const stuck: Progress = { progressed: false, why: "no head newer than the lease's start was pushed to `x`" };
const PIPELINE = { maxRounds: 3, maxMinutes: 240 };

describe("renewalDecision — renew only when progress, a renewal and the cap all hold, else name the clause that failed", () => {
  it("renews when the row shows progress, the grant has a renewal left, spend is under the cap and the pipeline still fits; the next segment is numbered and the sha it continues from is named", () => {
    expect(
      renewalDecision({
        grant: { renewals: 6, costCapUsd: 50 },
        renewalsSpent: 0,
        spendUsd: 12.5,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toEqual({ renew: true, segment: 2, from: B, renewalsLeft: 5 });
    // The last renewal spends the grant to zero left.
    expect(
      renewalDecision({
        grant: { renewals: 6 },
        renewalsSpent: 5,
        spendUsd: null,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toEqual({ renew: true, segment: 7, from: B, renewalsLeft: 0 });
  });

  it("no progress stops first, whatever the grant holds", () => {
    expect(
      renewalDecision({ grant: { renewals: 6 }, renewalsSpent: 1, spendUsd: 1, progress: stuck, pipeline: PIPELINE }),
    ).toEqual({ renew: false, why: "no_progress", detail: stuck.why, renewalsLeft: 5 });
  });

  it("an exhausted grant stops — the default grant of zero renewals never renews", () => {
    expect(
      renewalDecision({
        grant: { renewals: 0 },
        renewalsSpent: 0,
        spendUsd: 0,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toEqual({ renew: false, why: "grant_exhausted", detail: "the grant holds no renewals", renewalsLeft: 0 });
    expect(
      renewalDecision({
        grant: { renewals: 2 },
        renewalsSpent: 2,
        spendUsd: 0,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toEqual({ renew: false, why: "grant_exhausted", detail: "the grant's 2 renewals are spent", renewalsLeft: 0 });
    // A grant of one reads singular: "1 renewal is spent", never "are".
    expect(
      renewalDecision({
        grant: { renewals: 1 },
        renewalsSpent: 1,
        spendUsd: 0,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toEqual({ renew: false, why: "grant_exhausted", detail: "the grant's 1 renewal is spent", renewalsLeft: 0 });
  });

  it("spend at or over the cap stops, and an unknown spend under a cap stops too — a cap never trusts a total that left a model's tokens out", () => {
    expect(
      renewalDecision({
        grant: { renewals: 6, costCapUsd: 50 },
        renewalsSpent: 1,
        spendUsd: 50,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toEqual({
      renew: false,
      why: "cost_cap",
      detail: "spend $50.00 reached the grant's cap of $50",
      renewalsLeft: 5,
    });
    expect(
      renewalDecision({
        grant: { renewals: 6, costCapUsd: 50 },
        renewalsSpent: 1,
        spendUsd: null,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toEqual({
      renew: false,
      why: "cost_cap",
      detail: "spend is unknown (a model had no price) under the grant's cap of $50",
      renewalsLeft: 5,
    });
    // No cap: spend never stops a renewal.
    expect(
      renewalDecision({
        grant: { renewals: 6 },
        renewalsSpent: 1,
        spendUsd: 9999,
        progress: progressed,
        pipeline: PIPELINE,
      }),
    ).toMatchObject({ renew: true });
  });

  it("a pipeline that no longer holds its loop stops naming the fit's sum", () => {
    expect(
      renewalDecision({
        grant: { renewals: 6 },
        renewalsSpent: 0,
        spendUsd: 0,
        progress: progressed,
        pipeline: { maxRounds: 3, maxMinutes: 40 },
      }),
    ).toEqual({
      renew: false,
      why: "unfit",
      detail: "a 40-minute segment cannot hold the ship loop (3 review rounds need 163 min)",
      renewalsLeft: 6,
    });
  });
});

describe("renderRenewal — the card's words, as the record's trace has them", () => {
  it("a renewal names its number of the grant's and the sha it continues from", () => {
    expect(renderRenewal({ renew: true, segment: 2, from: B, renewalsLeft: 5 }, { renewals: 6 })).toBe(
      `renewal 1 of 6, continues ${B.slice(0, 7)}`,
    );
    expect(renderRenewal({ renew: true, segment: 3, renewalsLeft: 4 }, { renewals: 6 })).toBe(
      "renewal 2 of 6, continues the branch's head",
    );
  });

  it("a stop names the clause and, when renewals remain, the reply that spends one by hand", () => {
    expect(renderRenewal({ renew: false, why: "no_progress", detail: "x", renewalsLeft: 5 }, { renewals: 6 })).toBe(
      "no progress in the last lease; grant holds 5 renewals; reply continue to spend one",
    );
    expect(renderRenewal({ renew: false, why: "no_progress", detail: "x", renewalsLeft: 1 }, { renewals: 6 })).toBe(
      "no progress in the last lease; grant holds 1 renewal; reply continue to spend one",
    );
    expect(renderRenewal({ renew: false, why: "no_progress", detail: "x", renewalsLeft: 0 }, { renewals: 0 })).toBe(
      "no progress in the last lease; the grant holds no renewals",
    );
    expect(
      renderRenewal(
        { renew: false, why: "grant_exhausted", detail: "the grant's 2 renewals are spent", renewalsLeft: 0 },
        { renewals: 2 },
      ),
    ).toBe("the grant's 2 renewals are spent");
    expect(
      renderRenewal(
        { renew: false, why: "cost_cap", detail: "spend $50.00 reached the grant's cap of $50", renewalsLeft: 5 },
        { renewals: 6, costCapUsd: 50 },
      ),
    ).toBe("spend $50.00 reached the grant's cap of $50; grant holds 5 renewals unspent");
    expect(
      renderRenewal(
        {
          renew: false,
          why: "unfit",
          detail: "a 40-minute segment cannot hold the ship loop (3 review rounds need 163 min)",
          renewalsLeft: 6,
        },
        { renewals: 6 },
      ),
    ).toBe("a 40-minute segment cannot hold the ship loop (3 review rounds need 163 min)");
  });
});
