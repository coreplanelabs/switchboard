import { describe, expect, it } from "vitest";
import {
  createPullSweepService,
  createPullSweepThroughput,
  decideSweep,
  type PullSweepDeps,
  type RebaseOutcome,
  type SweepEffects,
  type SweepGit,
  type SweepPullRequest,
  type SweepNativePlan,
} from "./pullSweep.js";

const pr = (over: Partial<SweepPullRequest> = {}): SweepPullRequest => ({
  repo: "acme/api",
  number: 7,
  branch: "plan/x/u1",
  base: "main",
  headSha: "a".repeat(40),
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
      return opts.rebase ? opts.rebase(p) : { kind: "clean", newHead: "b".repeat(40) };
    },
    patchUnchanged: async (p) => {
      calls.push(`range-diff ${p.repo}#${p.number}`);
      return opts.unchanged ? opts.unchanged(p) : true;
    },
    canPush: async () => true,
    forcePushWithLease: async (p, head) => {
      calls.push(`push ${p.repo}#${p.number} ${head}`);
      return { state: "accepted", commitSha: head };
    },
  };
  const effects: SweepEffects = {
    prepareNativeCalls: async (_p, _head, options) => [
      { operation: "review_anchor", state: "unstarted", patch: { title: "Title", body: "Frozen" } },
      ...(options.carryApproval
        ? [{ operation: "approval_reset" as const, state: "unstarted" as const, body: "LGTM" }]
        : []),
      ...(options.deltaReview
        ? [
            {
              operation: "spawn" as const,
              state: "unstarted" as const,
              request: { channelId: "http:sweep", userId: "cli:owner", threadKey: "http:sweep:7", text: "Review" },
            },
          ]
        : []),
    ],
    canPerformNativeCall: () => true,
    performNativeCall: async (plan, index) => {
      const op = plan.calls[index]!.operation;
      calls.push(
        `${op === "review_anchor" ? "anchors" : op === "approval_reset" ? "carry" : "delta-review"} ${plan.pr.repo}#${plan.pr.number}`,
      );
      return op === "spawn" ? { state: "accepted", runId: "run-review" } : { state: "accepted" };
    },
    modelRoundSpent: async (p) => (opts.spent ? opts.spent(p) : false),
    startModelRound: async (p, bounds) => {
      calls.push(`round ${p.repo}#${p.number} lease=${bounds.leaseMinutes} cap=${bounds.spendCapUsd}`);
      if (opts.roundStarts === false || typeof opts.roundStarts === "string")
        return { started: false, reason: typeof opts.roundStarts === "string" ? opts.roundStarts : "refused" };
      return { started: true, runId: "coding-child" };
    },
  };
  const deps: PullSweepDeps = {
    listOwnedPullRequests: async () => opts.prs,
    effect: {
      read: async () => undefined,
      admit: async () => true,
      begin: async () => true,
      complete: async () => true,
      settle: async () => true,
    },
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

describe("saved sweep model admission", () => {
  it("replays the frozen actual coding plan without a second rebase or paid-model request", async () => {
    const h = fixture({ prs: [pr()] });
    const plan: SweepNativePlan = {
      pr: pr(),
      newHead: pr().headSha,
      decision: "fix-round",
      calls: [
        {
          operation: "spawn",
          agent: "coding",
          state: "accepted",
          request: {
            channelId: "cli:default",
            userId: "cli:owner",
            threadKey: "cli:default:7",
            text: "Original immutable coding request",
          },
        },
      ],
    };
    h.deps.effect!.read = async () => plan;
    const report = await createPullSweepService(h.deps).sweep({ repo: pr().repo, number: 7 });
    expect(report.results[0]?.outcome).toBe("fix-round");
    expect(h.calls).toEqual([]);
    const malformed = { ...plan, calls: [{ ...plan.calls[0]!, agent: undefined }] } as SweepNativePlan;
    h.deps.effect!.read = async () => malformed;
    expect((await createPullSweepService(h.deps).sweep({ repo: pr().repo, number: 7 })).results[0]?.outcome).toBe(
      "error",
    );
    expect(h.calls).toEqual([]);
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
      `push acme/api#7 ${"b".repeat(40)}`,
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
  it("an unavailable owner lookup is a per-PR error and leaves that target untouched while other results finish", async () => {
    const { service, calls } = fixture({
      prs: [pr({ number: 1 }), pr({ number: 2 })],
      runnerOwns: (pull) => {
        if (pull.number === 1) throw new Error("owner facts unavailable");
        return false;
      },
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.repo).toBe("acme/api");
    expect(report.results).toEqual([
      expect.objectContaining({ number: 1, outcome: "error", line: "#1 not rebased — owner facts unavailable" }),
      expect.objectContaining({ number: 2, outcome: "carried" }),
    ]);
    expect(calls.some((call) => call.includes("acme/api#1"))).toBe(false);
    expect(calls).toContain(`push acme/api#2 ${"b".repeat(40)}`);
  });
  it("a git failure on one pull request is its own line; the sweep goes on", async () => {
    const { service } = fixture({
      prs: [pr({ number: 1 }), pr({ number: 2 })],
      rebase: (p) => {
        if (p.number === 1) throw new Error("git push refused: stale info");
        return { kind: "clean", newHead: "b".repeat(40) };
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

describe("durable sweep native calls", () => {
  it("admits the full frozen plan before begin and performs nothing after a denied begin or lost result ACK", async () => {
    for (const denyBegin of [true, false]) {
      const h = fixture({ prs: [pr()] });
      const trace: string[] = [];
      h.deps.effect!.admit = async (plan) => {
        expect(plan.newHead).toBe("b".repeat(40));
        expect(plan.calls.map((call) => call.operation)).toEqual(["rebase_push", "review_anchor", "approval_reset"]);
        trace.push("admit");
        return true;
      };
      h.deps.effect!.begin = async (_plan, index) => {
        trace.push(`begin:${index}`);
        return !denyBegin;
      };
      h.deps.git.forcePushWithLease = async (_pr, head) => {
        trace.push("push");
        return { state: "accepted", commitSha: head };
      };
      h.deps.effect!.complete = async () => {
        trace.push("complete");
        return false;
      };
      expect((await h.service.sweep({ repo: "acme/api" })).results[0]?.outcome).toBe("error");
      expect(trace).toEqual(denyBegin ? ["admit", "begin:0"] : ["admit", "begin:0", "push", "complete"]);
      expect(h.calls.some((call) => call.startsWith("anchors") || call.startsWith("carry"))).toBe(false);
    }
  });
  it("preserves a known accepted push and executes only the frozen remaining payload", async () => {
    const h = fixture({ prs: [pr({ headSha: "b".repeat(40), mergeableState: "clean" })] });
    const plan = {
      pr: pr({ approved: false }),
      newHead: "b".repeat(40),
      decision: "carry" as const,
      calls: [
        { operation: "rebase_push" as const, state: "accepted" as const },
        {
          operation: "review_anchor" as const,
          state: "unstarted" as const,
          patch: { title: "Original", body: "Frozen" },
        },
      ],
    };
    h.deps.effect!.read = async () => plan;
    h.deps.effects.prepareNativeCalls = async () => {
      throw new Error("must never rerender");
    };
    const report = await h.service.sweep({ repo: "acme/api", number: 7 });
    expect(report.results[0]?.outcome).toBe("carried");
    expect(h.calls).toEqual(["anchors acme/api#7"]);
  });
  it("refuses absent native capability before admission and void spawn proof after begin", async () => {
    const h = fixture({ prs: [pr()], unchanged: () => false });
    let admitted = 0;
    h.deps.effect!.admit = async () => {
      admitted++;
      return true;
    };
    h.deps.effects.canPerformNativeCall = () => false;
    expect((await h.service.sweep({ repo: "acme/api" })).results[0]?.outcome).toBe("error");
    expect(admitted).toBe(0);
    expect(h.calls.some((call) => call.startsWith("push"))).toBe(false);
    const unknown = fixture({ prs: [pr()], unchanged: () => false });
    let credited = false;
    unknown.deps.effect!.complete = async (_plan, index, outcome) => {
      if (index === 2) credited = outcome.state === "accepted";
      return true;
    };
    unknown.deps.effects.performNativeCall = async () => ({ state: "accepted" });
    expect((await unknown.service.sweep({ repo: "acme/api" })).results[0]?.outcome).toBe("error");
    expect(credited).toBe(false);
  });
  it("retains an uncertain push response and does not begin later writes", async () => {
    const h = fixture({ prs: [pr()] });
    h.deps.git.forcePushWithLease = async () => undefined;
    let completions = 0;
    h.deps.effect!.complete = async (_p, _i, outcome) => {
      expect(outcome).toEqual({ state: "uncertain" });
      completions++;
      return true;
    };
    expect((await h.service.sweep({ repo: "acme/api" })).results[0]?.outcome).toBe("error");
    expect(completions).toBe(1);
    expect(h.calls.some((call) => call.startsWith("anchors") || call.startsWith("carry"))).toBe(false);
  });
  it("refuses dirty native mutation when the durable effect adapter is absent", async () => {
    const h = fixture({ prs: [pr()] });
    h.deps.effect = undefined;
    const report = await h.service.sweep({ repo: "acme/api", number: 7 });
    expect(report.results[0]?.outcome).toBe("error");
    expect(
      h.calls.some((call) => call.startsWith("push ") || call.startsWith("carry ") || call.startsWith("anchors ")),
    ).toBe(false);
  });
  it("does not replay an accepted push or regenerate a saved payload when a later response is lost", async () => {
    const h = fixture({ prs: [pr()] });
    const oldHead = "a".repeat(40),
      newHead = "b".repeat(40);
    const calls: string[] = [];
    const plan = {
      pr: pr({ headSha: oldHead, approved: false }),
      newHead,
      decision: "carry" as const,
      calls: [
        { operation: "rebase_push" as const, state: "accepted" as const },
        {
          operation: "review_anchor" as const,
          state: "uncertain" as const,
          patch: { title: "Original", body: "Frozen bytes" },
        },
      ],
    };
    h.deps.effect = {
      read: async () => plan,
      admit: async () => {
        calls.push("admit");
        return true;
      },
      begin: async () => {
        calls.push("begin");
        return true;
      },
      complete: async () => {
        calls.push("complete");
        return true;
      },
      settle: async () => {
        calls.push("settle");
        return true;
      },
    };
    h.deps.effects.prepareNativeCalls = async () => {
      calls.push("prepare");
      return [];
    };
    h.deps.effects.performNativeCall = async () => {
      calls.push("native");
      return { state: "accepted" };
    };
    const report = await h.service.sweep({ repo: "acme/api", number: 7 });
    expect(report.results[0]?.outcome).toBe("error");
    expect(h.calls).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the per-repository bound — one rebase in flight", () => {
  it.each(["command/command", "command/watch", "command/runner", "runner/runner", "watch/watch"])(
    "separate %s services serialize different PRs through one shared repository queue",
    async () => {
      const throughput = createPullSweepThroughput();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const calls: number[] = [];
      const first = fixture({
        prs: [pr({ number: 7 })],
        rebase: async (p) => {
          calls.push(p.number);
          entered();
          await blocked;
          return { kind: "clean", newHead: "b".repeat(40) };
        },
      });
      const second = fixture({
        prs: [pr({ number: 8 })],
        rebase: (p) => {
          calls.push(p.number);
          return { kind: "clean", newHead: "b".repeat(40) };
        },
      });
      const a = createPullSweepService({ ...first.deps, throughput }).sweep({ repo: "acme/api", number: 7 });
      await firstEntered;
      const b = createPullSweepService({ ...second.deps, throughput }).sweep({ repo: "ACME/API", number: 8 });
      await Promise.resolve();
      expect(calls).toEqual([7]);
      release();
      const results = await Promise.all([a, b]);
      expect(calls).toEqual([7, 8]);
      expect(results.map((r) => r.results[0]?.outcome)).toEqual(["carried", "carried"]);
    },
  );

  it("separate services can rebase different repositories concurrently", async () => {
    const throughput = createPullSweepThroughput();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = fixture({
      prs: [pr()],
      rebase: async () => {
        entered();
        await blocked;
        return { kind: "clean", newHead: "b".repeat(40) };
      },
    });
    const second = fixture({ prs: [pr({ repo: "acme/other" })] });
    const a = createPullSweepService({ ...first.deps, throughput }).sweep({ repo: "acme/api" });
    await firstEntered;
    const b = await createPullSweepService({ ...second.deps, throughput }).sweep({ repo: "acme/other" });
    expect(b.results[0]?.outcome).toBe("carried");
    expect(second.calls[0]).toBe("rebase acme/other#7");
    release();
    await a;
  });

  it("a failed sweep releases shared throughput without granting the next service any write authority", async () => {
    const throughput = createPullSweepThroughput();
    const first = fixture({ prs: [pr()] });
    first.deps.listOwnedPullRequests = async () => {
      throw new Error("listing unavailable");
    };
    const second = fixture({ prs: [pr({ number: 8 })] });
    second.deps.effect!.begin = async () => false;
    const a = createPullSweepService({ ...first.deps, throughput }).sweep({ repo: "acme/api" });
    const b = createPullSweepService({ ...second.deps, throughput }).sweep({ repo: "acme/api" });
    await expect(a).rejects.toThrow("listing unavailable");
    expect((await b).results[0]?.outcome).toBe("error");
    expect(second.calls.some((call) => call.startsWith("push "))).toBe(false);
  });

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
          return { kind: "clean", newHead: "b".repeat(40) };
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
