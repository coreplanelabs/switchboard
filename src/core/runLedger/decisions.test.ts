import { describe, expect, it } from "vitest";
import {
  checkFence,
  decideClaim,
  decideClaimWrite,
  phaseTransition,
  reclaimPhase,
  selectReclaim,
  transcriptCompleteness,
} from "./decisions.js";

// The ledger's decisions (docs/reference/specs/run-history.md items 28–31), pure: the
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

  // docs/reference/specs/run-history.md item 48: a refused claim names the live
  // run's idempotency key when it carries one, so a coordinator's retried spawn
  // can tell "already spawned" from "busy" without a second read.
  it("a refused claim carries the live run's idempotency key when it has one, and no key otherwise", () => {
    const keyed = { runId: "r0", agent: "coding", startedAt: 1_000, ownerGen: "g1", idempotencyKey: "inst_1:u/0/c" };
    expect(decideClaim(keyed, { runId: "r1", gen: "g1" })).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r0", agent: "coding", startedAt: 1_000, idempotencyKey: "inst_1:u/0/c" },
    });
    const plain = { runId: "r0", agent: "coding", startedAt: 1_000, ownerGen: "g1" };
    const refused = decideClaim(plain, { runId: "r1", gen: "g1" });
    expect(refused.ok === false && "idempotencyKey" in refused.live).toBe(false);
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
    { runId: "expired", leaseUntil: 900, phase: "live" as const, ownerGen: "g0" },
    { runId: "alive", leaseUntil: 2_000, phase: "live" as const, ownerGen: "g0" },
    { runId: "handoff", leaseUntil: 5_000, phase: "handoff" as const, ownerGen: "g0" },
    { runId: "finishing-expired", leaseUntil: 100, phase: "finishing" as const, ownerGen: "g0" },
  ];

  it("takes rows whose lease is past and rows marked handoff, never a live lease", () => {
    expect(selectReclaim(rows, 1_000, "g1").map((r) => r.runId)).toEqual(["expired", "handoff", "finishing-expired"]);
  });

  it("a lease that expires exactly now is expired (a heartbeat lands strictly before)", () => {
    expect(selectReclaim([{ runId: "x", leaseUntil: 1_000, phase: "live", ownerGen: "g0" }], 1_000, "g1")).toHaveLength(
      1,
    );
  });

  it("never takes a row the reclaiming generation owns itself, however stale its lease or whatever its phase: a lapsed lease on our own row is a heartbeat that could not land (a state Worker blip), not a dead owner — taking it would run the same run twice in one process", () => {
    const mine = [
      { runId: "mine-expired", leaseUntil: 0, phase: "live" as const, ownerGen: "g1" },
      { runId: "mine-handoff", leaseUntil: 0, phase: "handoff" as const, ownerGen: "g1" },
      { runId: "mine-attaching", leaseUntil: 0, phase: "attaching" as const, ownerGen: "g1" },
      { runId: "theirs-expired", leaseUntil: 0, phase: "live" as const, ownerGen: "g0" },
    ];
    expect(selectReclaim(mine, 1_000, "g1").map((r) => r.runId)).toEqual(["theirs-expired"]);
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

  it("an `attaching` row (reserved at admission, item 42) goes live when its prompt lands or finishing when the dispatch fails before that; nothing goes back to attaching and an attaching row is never handed off (it is not resumable — a restart re-dispatches it)", () => {
    expect(phaseTransition("attaching", "live")).toBe(true);
    expect(phaseTransition("attaching", "finishing")).toBe(true);
    expect(phaseTransition("attaching", "handoff")).toBe(false);
    expect(phaseTransition("live", "attaching")).toBe(false);
    expect(phaseTransition("handoff", "attaching")).toBe(false);
    expect(phaseTransition("finishing", "attaching")).toBe(false);
  });
});

describe("decideClaimWrite — what a claim does to the thread's row (item 42)", () => {
  const owner = { runId: "r1", ownerGen: "g1" };
  it("no row → insert; the owner's claim WITH a prompt on its attaching row → promote (the prompt lands, phase live); the owner's re-reserve → refresh (a retry after a lost response); anything on a live row → keep (idempotent, as before)", () => {
    expect(decideClaimWrite(undefined, { ...owner, gen: "g1" })).toBe("insert");
    expect(decideClaimWrite({ ...owner, phase: "attaching" }, { ...owner, gen: "g1" })).toBe("promote");
    expect(decideClaimWrite({ ...owner, phase: "attaching" }, { ...owner, gen: "g1", phase: "attaching" })).toBe(
      "refresh",
    );
    expect(decideClaimWrite({ ...owner, phase: "live" }, { ...owner, gen: "g1" })).toBe("keep");
    expect(decideClaimWrite({ ...owner, phase: "live" }, { ...owner, gen: "g1", phase: "attaching" })).toBe("keep");
    expect(decideClaimWrite({ ...owner, phase: "handoff" }, { ...owner, gen: "g1" })).toBe("keep");
  });
});

describe("reclaimPhase — the phase a reclaimed row lands in", () => {
  it("an attaching row stays attaching (the launcher restarts it from its request); every other phase becomes live", () => {
    expect(reclaimPhase("attaching")).toBe("attaching");
    expect(reclaimPhase("live")).toBe("live");
    expect(reclaimPhase("handoff")).toBe("live");
    expect(reclaimPhase("finishing")).toBe("live");
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
