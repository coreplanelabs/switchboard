import { describe, expect, it } from "vitest";
import { decide, readToken } from "./preflight.mjs";

const payload = (residents) => ({
  ok: true,
  payload: {
    cap: 8,
    count: residents.length,
    inFlight: residents.reduce((a, r) => a + (r.live?.inFlight ?? 0), 0),
    residents,
  },
});
const resident = (resource, inFlight) => ({ resource, live: { state: "warm", inFlight } });

describe("resident deploy preflight — decide()", () => {
  it("idle everywhere → allow, not forced", () => {
    const d = decide(payload([resident("repo:jshttp/vary", 0), resident("repo:coreplanelabs/switchboard", 0)]));
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
    expect(d.busy).toEqual([]);
    expect(d.message).toMatch(/no resident has work in flight/);
  });

  it("no residents onboarded → allow", () => {
    const d = decide(payload([]));
    expect(d.allow).toBe(true);
    expect(d.message).toMatch(/0 residents/);
  });

  it("busy → refuse, naming every busy resident with its count", () => {
    const d = decide(payload([resident("repo:jshttp/vary", 0), resident("repo:coreplanelabs/switchboard", 2), resident("repo:a/b", 1)]));
    expect(d.allow).toBe(false);
    expect(d.busy).toEqual([
      { resource: "repo:coreplanelabs/switchboard", inFlight: 2 },
      { resource: "repo:a/b", inFlight: 1 },
    ]);
    expect(d.message).toContain("repo:coreplanelabs/switchboard (2 in flight)");
    expect(d.message).toContain("repo:a/b (1 in flight)");
    expect(d.message).not.toContain("repo:jshttp/vary");
    expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
  });

  // #188: a deploy swaps every ResidentDO isolate; a refresh cycle's fetch/
  // rebuild or a restore in progress is killed just like a thread run (live
  // 2026-08-29: `degraded(build-failed: exit 143: Session terminated)` on
  // repo:coreplanelabs/switchboard right after a deploy that passed preflight).
  it("a resident mid-cycle (refreshing / restoring / onboarding) → refuse, naming the state, even with 0 in flight", () => {
    for (const state of ["refreshing", "restoring", "onboarding"]) {
      const d = decide(payload([resident("repo:jshttp/vary", 0), { resource: "repo:coreplanelabs/switchboard", live: { state, inFlight: 0 } }]));
      expect(d.allow, state).toBe(false);
      expect(d.midCycle).toEqual([{ resource: "repo:coreplanelabs/switchboard", state }]);
      expect(d.message).toContain(`repo:coreplanelabs/switchboard (${state})`);
      expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
    }
  });

  it("warm / degraded / down with 0 in flight are not mid-cycle → allow", () => {
    const d = decide(
      payload([
        { resource: "repo:a/b", live: { state: "warm", inFlight: 0 } },
        { resource: "repo:c/d", live: { state: "degraded", reason: "github-unreachable: x", inFlight: 0 } },
        { resource: "repo:e/f", live: { state: "down", reason: "provision-failed at clone: y", inFlight: 0 } },
      ]),
    );
    expect(d.allow).toBe(true);
    expect(d.midCycle).toEqual([]);
  });

  it("busy AND mid-cycle are both reported — neither shadows the other", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "refreshing", inFlight: 2 } }]));
    expect(d.allow).toBe(false);
    expect(d.busy).toEqual([{ resource: "repo:x/y", inFlight: 2 }]);
    expect(d.midCycle).toEqual([{ resource: "repo:x/y", state: "refreshing" }]);
    expect(d.message).toContain("repo:x/y (2 in flight)");
    expect(d.message).toContain("repo:x/y (refreshing)");
  });

  // Allow-list of settled states: this script is plain JS outside the shared
  // ResidentLifecycleState type, so a state it has never heard of must fail
  // closed rather than be assumed idle.
  it("an unrecognized lifecycle state is unknown → refuse (fail closed on vocabulary drift)", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "hibernating", inFlight: 0 } }]));
    expect(d.allow).toBe(false);
    expect(d.midCycle).toEqual([]);
    expect(d.unknown).toEqual([{ resource: "repo:x/y", error: expect.stringContaining('unrecognized state "hibernating"') }]);
  });

  it("force overrides mid-cycle — allowed, flagged, and the warning names the state", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "refreshing", inFlight: 0 } }]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toContain("repo:x/y (refreshing)");
  });

  it("a resident whose live view failed is unknown → refuse (fail closed)", () => {
    const d = decide(payload([resident("repo:jshttp/vary", 0), { resource: "repo:x/y", live: { error: "DO timed out" } }]));
    expect(d.allow).toBe(false);
    expect(d.unknown).toEqual([{ resource: "repo:x/y", error: "DO timed out" }]);
    expect(d.message).toContain("repo:x/y");
    expect(d.message).toContain("DO timed out");
  });

  it("a payload without per-resident inFlight (old Worker) is unknown → refuse", () => {
    const d = decide({ ok: true, payload: { residents: [{ resource: "repo:x/y", live: { state: "warm" } }] } });
    expect(d.allow).toBe(false);
    expect(d.unknown[0].resource).toBe("repo:x/y");
  });

  it("a negative or non-integer inFlight (counter bug) is unknown, never idle → refuse", () => {
    for (const bad of [-1, 0.5, NaN, Infinity]) {
      const d = decide(payload([resident("repo:x/y", bad)]));
      expect(d.allow, `inFlight=${bad}`).toBe(false);
      expect(d.busy).toEqual([]);
      expect(d.unknown[0].resource).toBe("repo:x/y");
      expect(d.message).toContain(`inFlight=${bad}`);
    }
  });

  it("malformed payload → refuse", () => {
    expect(decide({ ok: true, payload: null }).allow).toBe(false);
    expect(decide({ ok: true, payload: { residents: "nope" } }).allow).toBe(false);
    expect(decide(undefined).allow).toBe(false);
  });

  it("unreachable / no token → refuse with the operator hint", () => {
    const d = decide({ ok: false, error: "no bearer in the environment" });
    expect(d.allow).toBe(false);
    expect(d.message).toContain("no bearer in the environment");
    expect(d.message).toMatch(/RESIDENT_ADMIN_TOKEN/);
    expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
  });

  it("force overrides busy — allowed, flagged, and the warning still names the busy residents", () => {
    const d = decide(payload([resident("repo:coreplanelabs/switchboard", 1)]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("repo:coreplanelabs/switchboard (1 in flight)");
  });

  it("force overrides unreachable — allowed and flagged", () => {
    const d = decide({ ok: false, error: "fetch failed" }, { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("fetch failed");
  });

  it("force on an idle fleet is a plain allow, not flagged", () => {
    const d = decide(payload([resident("repo:jshttp/vary", 0)]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
  });
});

describe("readToken()", () => {
  it("prefers admin, then operator, then read; never returns a blank", () => {
    expect(readToken({ RESIDENT_ADMIN_TOKEN: "a", RESIDENT_OPERATOR_TOKEN: "o", RESIDENT_READ_TOKEN: "r" })).toBe("a");
    expect(readToken({ RESIDENT_OPERATOR_TOKEN: "o", RESIDENT_READ_TOKEN: "r" })).toBe("o");
    expect(readToken({ RESIDENT_READ_TOKEN: "r" })).toBe("r");
    expect(readToken({ RESIDENT_ADMIN_TOKEN: "  " })).toBeNull();
    expect(readToken({})).toBeNull();
  });
});
