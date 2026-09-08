import { describe, expect, it } from "vitest";
import { BASE_URL_ENV, decide, main, readToken } from "./preflight.mjs";

describe("resident deploy preflight — main()", () => {
  it(`refuses (exit 2) before reading anything when ${BASE_URL_ENV} is not set — the Worker's origin is the deployment profile's, handed over by deploy all`, async () => {
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      expect(await main([], { RESIDENT_READ_TOKEN: "r" })).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain(`${BASE_URL_ENV} is not set`);
    expect(errors.join("\n")).toContain("deploy all");
  });
});

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
    const d = decide(payload([resident("repo:jshttp/vary", 0), resident("repo:acme/widgets", 0)]));
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
    const d = decide(
      payload([resident("repo:jshttp/vary", 0), resident("repo:acme/widgets", 2), resident("repo:a/b", 1)]),
    );
    expect(d.allow).toBe(false);
    expect(d.busy).toEqual([
      { resource: "repo:acme/widgets", inFlight: 2 },
      { resource: "repo:a/b", inFlight: 1 },
    ]);
    expect(d.message).toContain("repo:acme/widgets (2 in flight)");
    expect(d.message).toContain("repo:a/b (1 in flight)");
    expect(d.message).not.toContain("repo:jshttp/vary");
    expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
  });

  // #188: a deploy swaps every ResidentDO isolate; a refresh cycle's fetch/
  // rebuild or a restore in progress is killed just like a thread run (live
  // 2026-08-29: `degraded(build-failed: exit 143: Session terminated)` on
  // repo:acme/widgets right after a deploy that passed preflight).
  it("a resident provisioning (onboarding) → refuse, naming the state, even with 0 in flight: an isolate swap fails the provision and only a rebuild recovers it", () => {
    const d = decide(
      payload([
        resident("repo:jshttp/vary", 0),
        { resource: "repo:acme/widgets", live: { state: "onboarding", inFlight: 0 } },
      ]),
    );
    expect(d.allow).toBe(false);
    expect(d.provisioning).toEqual([{ resource: "repo:acme/widgets", state: "onboarding" }]);
    expect(d.interrupting).toEqual([]);
    expect(d.message).toContain("repo:acme/widgets (onboarding)");
    expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
  });

  it("a resident refreshing or restoring with 0 in flight → allow with a WARNING naming the state: the cycle re-arms in 45 s after the swap (item 44), a restore is retried by the next hydrate (item 61)", () => {
    for (const state of ["refreshing", "restoring"]) {
      const d = decide(
        payload([resident("repo:jshttp/vary", 0), { resource: "repo:acme/widgets", live: { state, inFlight: 0 } }]),
      );
      expect(d.allow, state).toBe(true);
      expect(d.forced).toBe(false);
      expect(d.provisioning).toEqual([]);
      expect(d.interrupting).toEqual([{ resource: "repo:acme/widgets", state }]);
      expect(d.message).toMatch(/^preflight ok:/);
      expect(d.message).toContain("WARNING");
      expect(d.message).toContain(`repo:acme/widgets (${state})`);
      expect(d.message).not.toContain("REFUSED");
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
    expect(d.provisioning).toEqual([]);
  });

  it("busy AND mid-cycle are both reported — neither shadows the other; runs in flight refuse even when the cycle alone would only warn", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "onboarding", inFlight: 2 } }]));
    expect(d.allow).toBe(false);
    expect(d.busy).toEqual([{ resource: "repo:x/y", inFlight: 2 }]);
    expect(d.provisioning).toEqual([{ resource: "repo:x/y", state: "onboarding" }]);
    expect(d.message).toContain("repo:x/y (2 in flight)");
    expect(d.message).toContain("repo:x/y (onboarding)");
    const refreshingBusy = decide(payload([{ resource: "repo:x/y", live: { state: "refreshing", inFlight: 1 } }]));
    expect(refreshingBusy.allow).toBe(false);
    expect(refreshingBusy.interrupting).toEqual([{ resource: "repo:x/y", state: "refreshing" }]);
    expect(refreshingBusy.message).toContain("repo:x/y (1 in flight)");
  });

  // Allow-list of settled states: this script is plain JS outside the shared
  // ResidentLifecycleState type, so a state it has never heard of must fail
  // closed rather than be assumed idle.
  it("an unrecognized lifecycle state is unknown → refuse (fail closed on vocabulary drift)", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "hibernating", inFlight: 0 } }]));
    expect(d.allow).toBe(false);
    expect(d.provisioning).toEqual([]);
    expect(d.unknown).toEqual([
      { resource: "repo:x/y", error: expect.stringContaining('unrecognized state "hibernating"') },
    ]);
  });

  it("force overrides a provisioning — allowed, flagged, and the warning names the state", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "onboarding", inFlight: 0 } }]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toContain("repo:x/y (onboarding)");
  });

  it("a resident whose live view failed is unknown → refuse (fail closed)", () => {
    const d = decide(
      payload([resident("repo:jshttp/vary", 0), { resource: "repo:x/y", live: { error: "DO timed out" } }]),
    );
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
    const d = decide(payload([resident("repo:acme/widgets", 1)]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("repo:acme/widgets (1 in flight)");
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
