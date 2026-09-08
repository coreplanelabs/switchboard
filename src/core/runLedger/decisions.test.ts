import { describe, expect, it } from "vitest";
import { checkFence, decideClaim, phaseTransition, selectReclaim, transcriptCompleteness } from "./decisions.js";

// The ledger's decisions (features/run-history.md items 28–31), pure: the
// Durable Object applies them inside one transaction and the in-memory ledger
// applies them in tests. One live run per thread; every write fenced by the
// owner generation; reclaim takes exactly the expired and handed-off rows; the
// transcript-completeness rule decides what a resume does.

describe("decideClaim — one live run per thread", () => {
  it("no live run on the thread → claim", () => {
    expect(decideClaim(undefined, { runId: "r1", gen: "g1" })).toEqual({ ok: true });
  });

  it("a different live run on the thread → refused, naming it (the steer message needs the agent and start)", () => {
    const live = { runId: "r0", agent: "coding", startedAt: 1_000, ownerGen: "g1" };
    expect(decideClaim(live, { runId: "r1", gen: "g1" })).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r0", agent: "coding", startedAt: 1_000 },
    });
  });

  it("the same run re-claimed by its owner is idempotent; by another generation it is refused as live", () => {
    const live = { runId: "r1", agent: "coding", startedAt: 1_000, ownerGen: "g1" };
    expect(decideClaim(live, { runId: "r1", gen: "g1" })).toEqual({ ok: true });
    expect(decideClaim(live, { runId: "r1", gen: "g2" })).toMatchObject({ ok: false, reason: "thread-live" });
  });
});

describe("checkFence — the owner generation on every write", () => {
  it("the owner passes; another generation is fenced; an unknown run is named as such", () => {
    expect(checkFence({ ownerGen: "g1" }, "g1")).toEqual({ ok: true });
    expect(checkFence({ ownerGen: "g1" }, "g2")).toEqual({ ok: false, reason: "fenced" });
    expect(checkFence(undefined, "g2")).toEqual({ ok: false, reason: "unknown-run" });
  });
});

describe("selectReclaim — expired leases and handed-off runs", () => {
  const rows = [
    { runId: "expired", leaseUntil: 900, phase: "live" as const },
    { runId: "alive", leaseUntil: 2_000, phase: "live" as const },
    { runId: "handoff", leaseUntil: 5_000, phase: "handoff" as const },
    { runId: "finishing-expired", leaseUntil: 100, phase: "finishing" as const },
  ];

  it("takes rows whose lease is past and rows marked handoff, never a live lease", () => {
    expect(selectReclaim(rows, 1_000).map((r) => r.runId)).toEqual(["expired", "handoff", "finishing-expired"]);
  });

  it("a lease that expires exactly now is expired (a heartbeat lands strictly before)", () => {
    expect(selectReclaim([{ runId: "x", leaseUntil: 1_000, phase: "live" }], 1_000)).toHaveLength(1);
  });
});

describe("phaseTransition — the CAS table", () => {
  it("allows live→handoff, live→finishing, handoff→live (reclaim), handoff→finishing (the owner finished inside its handoff window), finishing→live (reclaim), and nothing else", () => {
    expect(phaseTransition("live", "handoff")).toBe(true);
    expect(phaseTransition("live", "finishing")).toBe(true);
    expect(phaseTransition("handoff", "live")).toBe(true);
    expect(phaseTransition("finishing", "live")).toBe(true);
    expect(phaseTransition("finishing", "handoff")).toBe(false);
    expect(phaseTransition("handoff", "finishing")).toBe(true);
    expect(phaseTransition("live", "live")).toBe(false);
  });
});

describe("transcriptCompleteness — what a resume does with what it finds", () => {
  it("no step record and the transcript is exactly the seed → resume from the seed with nothing in flight", () => {
    expect(transcriptCompleteness({ lastStep: null, seedTurns: 3, transcriptTurns: 3 })).toEqual({ kind: "resume" });
  });

  it("the transcript has the turns the last step recorded → resume from that step (its in-flight calls get settled)", () => {
    expect(transcriptCompleteness({ lastStep: { turnIndex: 5 }, seedTurns: 3, transcriptTurns: 5 })).toEqual({
      kind: "resume",
    });
  });

  it("two more turns than the last step recorded → the next step's turns landed but its record did not: run that step's tools fresh", () => {
    expect(transcriptCompleteness({ lastStep: { turnIndex: 5 }, seedTurns: 3, transcriptTurns: 7 })).toEqual({
      kind: "run-step-fresh",
    });
    // The same shape with no step record yet: seed + the first assistant turn's pair.
    expect(transcriptCompleteness({ lastStep: null, seedTurns: 3, transcriptTurns: 5 })).toEqual({
      kind: "run-step-fresh",
    });
  });

  it("anything else — fewer turns than recorded, an odd count, no seed — closes the run interrupted, naming why", () => {
    expect(transcriptCompleteness({ lastStep: { turnIndex: 5 }, seedTurns: 3, transcriptTurns: 4 })).toEqual({
      kind: "interrupted",
      why: "transcript has 4 turns but the last step recorded 5",
    });
    expect(transcriptCompleteness({ lastStep: { turnIndex: 5 }, seedTurns: 3, transcriptTurns: 6 })).toEqual({
      kind: "interrupted",
      why: "transcript has 6 turns, one past the last step's 5: a partial step write",
    });
    expect(transcriptCompleteness({ lastStep: null, seedTurns: 3, transcriptTurns: 0 })).toEqual({
      kind: "interrupted",
      why: "no transcript stored",
    });
  });
});
