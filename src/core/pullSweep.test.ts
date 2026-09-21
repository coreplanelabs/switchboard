import { describe, expect, it } from "vitest";
import {
  createPullSweepService,
  decideSweep,
  type PullSweepDeps,
  type RebaseOutcome,
  type SweepEffects,
  type SweepGit,
  type SweepPullRequest,
} from "./pullSweep.js";

const pr = (over: Partial<SweepPullRequest> = {}): SweepPullRequest => ({
  repo: "acme/api",
  number: 7,
  branch: "plan/x/u1",
  base: "main",
  headSha: "aaa111",
  mergeableState: "dirty",
  approved: true,
  ...over,
});

/** A fake fixture: rebase outcomes per PR number, everything recorded. */
function fixture(opts: {
  prs: SweepPullRequest[];
  rebase?: (p: SweepPullRequest) => RebaseOutcome | Promise<RebaseOutcome>;
  unchanged?: (p: SweepPullRequest) => boolean;
  spent?: (p: SweepPullRequest) => boolean;
  roundStarts?: boolean | string;
  runnerOwns?: (p: SweepPullRequest) => boolean;
}) {
  const calls: string[] = [];
  const git: SweepGit = {
    rebase: async (p) => {
      calls.push(`rebase ${p.repo}#${p.number}`);
      return opts.rebase ? opts.rebase(p) : { kind: "clean", newHead: "bbb222" };
    },
    patchUnchanged: async (p) => {
      calls.push(`range-diff ${p.repo}#${p.number}`);
      return opts.unchanged ? opts.unchanged(p) : true;
    },
    forcePushWithLease: async (p, head) => {
      calls.push(`push ${p.repo}#${p.number} ${head}`);
    },
  };
  const effects: SweepEffects = {
    carryApproval: async (p) => {
      calls.push(`carry ${p.repo}#${p.number}`);
    },
    requestDeltaReview: async (p) => {
      calls.push(`delta-review ${p.repo}#${p.number}`);
    },
    regenerateAnchors: async (p) => {
      calls.push(`anchors ${p.repo}#${p.number}`);
    },
    modelRoundSpent: async (p) => (opts.spent ? opts.spent(p) : false),
    startModelRound: async (p, bounds) => {
      calls.push(`round ${p.repo}#${p.number} lease=${bounds.leaseMinutes} cap=${bounds.spendCapUsd}`);
      if (opts.roundStarts === false || typeof opts.roundStarts === "string")
        return { started: false, reason: typeof opts.roundStarts === "string" ? opts.roundStarts : "refused" };
      return { started: true };
    },
  };
  const deps: PullSweepDeps = {
    listOwnedPullRequests: async () => opts.prs,
    git,
    effects,
    bounds: { leaseMinutes: 15, spendCapUsd: 5 },
    ...(opts.runnerOwns ? { runnerOwns: async (p: SweepPullRequest) => opts.runnerOwns!(p) } : {}),
  };
  return { calls, deps, service: createPullSweepService(deps) };
}

describe("decideSweep — the resolver's decision table (record 0071, mechanism two)", () => {
  it("a pull request that is not dirty is skipped: stale-but-clean merges as it is", () => {
    expect(decideSweep({ dirty: false })).toEqual({ action: "skip" });
  });
  it("a clean rebase with the patch unchanged carries the approval — no re-review", () => {
    expect(decideSweep({ dirty: true, rebase: { kind: "clean", newHead: "b" }, patchUnchanged: true })).toEqual({
      action: "carry",
    });
  });
  it("a clean rebase whose patch changed gets a delta re-review", () => {
    expect(decideSweep({ dirty: true, rebase: { kind: "clean", newHead: "b" }, patchUnchanged: false })).toEqual({
      action: "delta-review",
    });
  });
  it("a conflict git leaves buys the one model round, the file named", () => {
    expect(
      decideSweep({ dirty: true, rebase: { kind: "conflict", file: "provision.ts" }, modelRoundSpent: false }),
    ).toEqual({ action: "model-round", file: "provision.ts" });
  });
  it("a second conflict — the round already spent — is the named ending, never a retry", () => {
    expect(
      decideSweep({ dirty: true, rebase: { kind: "conflict", file: "provision.ts" }, modelRoundSpent: true }),
    ).toEqual({ action: "end", file: "provision.ts" });
  });
});

describe("the sweep — one line per pull request, in user words", () => {
  it("a pull request owned by a live pipeline runner defers to that runner instead of spending the sweep's fix path", async () => {
    const { calls, service } = fixture({ prs: [pr()], runnerOwns: () => true });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe("#7 deferred — its pipeline runner owns the rebase");
    expect(calls).toEqual([]);
  });

  it("a dirty pull request rebased clean and unchanged: force-push, anchors regenerated, approval carried", async () => {
    const { calls, service } = fixture({ prs: [pr()] });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results.map((r) => r.line)).toEqual(["#7 rebased, patch unchanged, approval carried"]);
    expect(calls).toEqual([
      "rebase acme/api#7",
      "range-diff acme/api#7",
      "push acme/api#7 bbb222",
      "anchors acme/api#7",
      "carry acme/api#7",
    ]);
  });
  it("an unapproved pull request with an unchanged patch carries nothing and requests nothing", async () => {
    const { calls, service } = fixture({ prs: [pr({ approved: false })] });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe("#7 rebased, patch unchanged");
    expect(calls.some((c) => c.startsWith("carry") || c.startsWith("delta-review"))).toBe(false);
  });
  it("a changed patch gets the delta re-review after the push", async () => {
    const { calls, service } = fixture({ prs: [pr()], unchanged: () => false });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe("#7 rebased, patch changed, a re-review is requested");
    expect(calls).toContain("delta-review acme/api#7");
    expect(calls.some((c) => c.startsWith("carry"))).toBe(false);
  });
  it("a conflict starts the one bounded model round under the per-pull-request bounds", async () => {
    const { calls, service } = fixture({ prs: [pr()], rebase: () => ({ kind: "conflict", file: "provision.ts" }) });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe("#7 conflict in provision.ts, a fix round is running");
    expect(calls).toContain("round acme/api#7 lease=15 cap=5");
    expect(calls.some((c) => c.startsWith("push"))).toBe(false);
  });
  it("a conflict whose round is already spent ends with the conflict named in one line", async () => {
    const { calls, service } = fixture({
      prs: [pr()],
      rebase: () => ({ kind: "conflict", file: "provision.ts" }),
      spent: () => true,
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe(
      "#7 this is a bug: the conflict in provision.ts remained after the sweep's fix round, and no automatic recovery remains",
    );
    expect(calls.some((c) => c.startsWith("round"))).toBe(false);
  });
  it("a model round that will not start ends the line with the reason — no retry loop", async () => {
    const { service } = fixture({
      prs: [pr()],
      rebase: () => ({ kind: "conflict", file: "provision.ts" }),
      roundStarts: "the spend cap is reached",
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe("#7 conflict in provision.ts, no fix round ran — the spend cap is reached");
  });
  it("a stale-but-clean pull request is skipped — never rebased", async () => {
    const { calls, service } = fixture({ prs: [pr({ number: 9, mergeableState: "behind" })] });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe("#9 skipped, already current");
    expect(calls).toEqual([]);
  });
  it("an unknown mergeable state — GitHub still recomputing — is named, never claimed current", async () => {
    const { calls, service } = fixture({ prs: [pr({ number: 9, mergeableState: "unknown" })] });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.outcome).toBe("skipped");
    expect(report.results[0]?.line).toBe("#9 mergeability still computing — no rebase was attempted");
    expect(calls).toEqual([]);
  });
  it("one named pull request sweeps that one alone; an unknown number answers one honest line", async () => {
    const { service } = fixture({ prs: [pr({ number: 7 }), pr({ number: 2061 })] });
    const one = await service.sweep({ repo: "acme/api", number: 2061 });
    expect(one.results.map((r) => r.number)).toEqual([2061]);
    const none = await service.sweep({ repo: "acme/api", number: 9 });
    expect(none.results[0]?.line).toBe("#9 not swept — no open pull request the pipeline owns has this number");
  });
  it("a git failure on one pull request is its own line; the sweep goes on", async () => {
    const { service } = fixture({
      prs: [pr({ number: 1 }), pr({ number: 2 })],
      rebase: (p) => {
        if (p.number === 1) throw new Error("git push refused: stale info");
        return { kind: "clean", newHead: "bbb222" };
      },
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).toBe("#1 not rebased — git push refused: stale info");
    expect(report.results[1]?.outcome).toBe("carried");
  });
  it("a git failure that quotes a credential surfaces redacted — the line never carries a token", async () => {
    // Git quotes the remote URL verbatim on a network error or 403; the line
    // rides to chat, the CLI and MCP with no other redaction pass.
    const { service } = fixture({
      prs: [pr()],
      rebase: () => {
        throw new Error(
          "git clone failed: fatal: unable to access 'https://x-access-token:ghs_secret1234567890abcdefghij@github.com/acme/api.git/': The requested URL returned error: 403",
        );
      },
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.line).not.toContain("ghs_secret1234567890abcdefghij");
    expect(report.results[0]?.line).toContain("x-access-token:«redacted»");
    expect(report.results[0]?.line).toContain("error: 403");
  });
});

describe("the per-repository bound — one rebase in flight", () => {
  it("two sweeps of the same repository never overlap: the second queues behind the first", async () => {
    let inFlight = 0;
    let overlapped = false;
    const gate: { release?: () => void } = {};
    const { deps } = fixture({ prs: [pr()] });
    const slowDeps: PullSweepDeps = {
      ...deps,
      git: {
        ...deps.git,
        rebase: async () => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          if (gate.release === undefined) await new Promise<void>((res) => (gate.release = res));
          inFlight -= 1;
          return { kind: "clean", newHead: "bbb222" };
        },
      },
    };
    const service = createPullSweepService(slowDeps);
    const first = service.sweep({ repo: "acme/api" });
    const second = service.sweep({ repo: "acme/api" });
    await new Promise((res) => setTimeout(res, 0));
    gate.release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(overlapped).toBe(false);
    expect(a.results).toHaveLength(1);
    expect(b.results).toHaveLength(1);
  });
});
