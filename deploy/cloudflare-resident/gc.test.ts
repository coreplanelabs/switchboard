import { describe, expect, it } from "vitest";
import {
  decisivePull,
  effectiveLimits,
  parsePullsBody,
  parseRefListing,
  parseTestOverrides,
  pickEvictionCandidate,
  pullsFate,
  reclaimDecision,
  type ResidentView,
} from "./gc";

// ---------------------------------------------------------------------------
// Test overrides (#50 follow-up): lower the effective cap / LRU floor for live
// checks without touching the production constants — admin, deploy-scoped.
// ---------------------------------------------------------------------------

const DEFAULTS = { cap: 6, floorS: 3600 };

describe("parseTestOverrides — the /debug set-test-overrides body", () => {
  it("cap and floorS are accepted when they LOWER the defaults (equal allowed)", () => {
    expect(parseTestOverrides({ cap: 2, floorS: 600 }, DEFAULTS)).toEqual({ overrides: { cap: 2, floorS: 600 } });
    expect(parseTestOverrides({ cap: 6 }, DEFAULTS)).toEqual({ overrides: { cap: 6 } });
    expect(parseTestOverrides({ floorS: 0 }, DEFAULTS)).toEqual({ overrides: { floorS: 0 } });
  });
  it("neither field → clear (the op with an empty body removes the override)", () => {
    expect(parseTestOverrides({}, DEFAULTS)).toEqual({ clear: true });
    expect(parseTestOverrides({ op: "set-test-overrides", resource: "x" }, DEFAULTS)).toEqual({ clear: true });
  });
  it("an override can never RAISE a limit above the constant (no back door past max_instances)", () => {
    expect(parseTestOverrides({ cap: 7 }, DEFAULTS)).toEqual({ error: "cap must be an integer between 1 and 6 (the compiled RESIDENT_CAP); overrides only lower it" });
    expect(parseTestOverrides({ floorS: 3601 }, DEFAULTS)).toEqual({ error: "floorS must be an integer between 0 and 3600 (the compiled LRU_FLOOR_S); overrides only lower it" });
  });
  it("non-integers, zero cap, negatives, strings → named errors", () => {
    expect(parseTestOverrides({ cap: 0 }, DEFAULTS)).toMatchObject({ error: expect.stringContaining("cap must be") });
    expect(parseTestOverrides({ cap: 2.5 }, DEFAULTS)).toMatchObject({ error: expect.stringContaining("cap must be") });
    expect(parseTestOverrides({ cap: "2" }, DEFAULTS)).toMatchObject({ error: expect.stringContaining("cap must be") });
    expect(parseTestOverrides({ floorS: -1 }, DEFAULTS)).toMatchObject({ error: expect.stringContaining("floorS must be") });
  });
});

describe("effectiveLimits — what the registry actually enforces", () => {
  const stored = (o: { cap?: number; floorS?: number }, build = "gc51") => ({ ...o, setAt: "2026-08-29T23:00:00Z", build });
  it("no override → the compiled defaults, override null", () => {
    expect(effectiveLimits(undefined, "gc51", DEFAULTS)).toEqual({ cap: 6, floorS: 3600, override: null });
  });
  it("an active override lowers exactly the fields it names", () => {
    expect(effectiveLimits(stored({ cap: 2 }), "gc51", DEFAULTS)).toMatchObject({ cap: 2, floorS: 3600 });
    expect(effectiveLimits(stored({ floorS: 600 }), "gc51", DEFAULTS)).toMatchObject({ cap: 6, floorS: 600 });
    expect(effectiveLimits(stored({ cap: 2, floorS: 600 }), "gc51", DEFAULTS).override).toEqual(stored({ cap: 2, floorS: 600 }));
  });
  it("an override written by a PREVIOUS deploy is ignored (deploy-scoped: a forgotten test cap cannot outlive the build)", () => {
    expect(effectiveLimits(stored({ cap: 2 }, "gc50"), "gc51", DEFAULTS)).toEqual({ cap: 6, floorS: 3600, override: null, ignored: "stale-build gc50" });
  });
  it("a stored value above the compiled constant (constant lowered by a later deploy) is clamped, never honored", () => {
    expect(effectiveLimits(stored({ cap: 9, floorS: 9999 }), "gc51", DEFAULTS)).toMatchObject({ cap: 6, floorS: 3600 });
  });
});

// ---------------------------------------------------------------------------
// Event-triggered reclamation (#50): what happened to a thread's bound ref
// ---------------------------------------------------------------------------

describe("pullsFate — the GitHub pulls list for one head ref", () => {
  it("no PR for the head → no-pr", () => {
    expect(pullsFate([])).toBe("no-pr");
  });
  it("any open PR wins — the branch is still being worked", () => {
    expect(pullsFate([{ number: 2, state: "closed", merged: true }, { number: 3, state: "open", merged: false }])).toBe("open");
  });
  it("a merged PR (no open one) → merged, even alongside an older closed one", () => {
    expect(pullsFate([{ number: 3, state: "closed", merged: false }, { number: 2, state: "closed", merged: true }])).toBe("merged");
  });
  it("closed-unmerged only → closed", () => {
    expect(pullsFate([{ number: 4, state: "closed", merged: false }])).toBe("closed");
  });
});

describe("decisivePull — which PR the fate is attributed to", () => {
  it("the open PR, else the merged one, else the newest closed one, else null", () => {
    const open = { number: 3, state: "open" as const, merged: false };
    const merged = { number: 2, state: "closed" as const, merged: true };
    const closed = { number: 4, state: "closed" as const, merged: false };
    expect(decisivePull([merged, open])).toBe(open);
    expect(decisivePull([closed, merged])).toBe(merged);
    expect(decisivePull([closed])).toBe(closed);
    expect(decisivePull([])).toBeNull();
  });
});

describe("parsePullsBody — defensive parse of the REST answer", () => {
  it("keeps number/state/merged_at from each element", () => {
    expect(parsePullsBody([{ number: 7, state: "closed", merged_at: "2026-08-29T10:00:00Z" }, { number: 8, state: "open", merged_at: null }])).toEqual([
      { number: 7, state: "closed", merged: true },
      { number: 8, state: "open", merged: false },
    ]);
  });
  it("a non-array (error object, HTML, null) → null, never a fake empty list", () => {
    expect(parsePullsBody({ message: "Not Found" })).toBeNull();
    expect(parsePullsBody(null)).toBeNull();
    expect(parsePullsBody("<html>")).toBeNull();
  });
  it("malformed elements are dropped, not guessed at", () => {
    expect(parsePullsBody([{ number: "x" }, 42, { number: 9, state: "weird", merged_at: null }, { number: 10, state: "open", merged_at: null }])).toEqual([
      { number: 10, state: "open", merged: false },
    ]);
  });
});

describe("reclaimDecision — evict this binding now?", () => {
  const base = { fate: "merged" as const, isDefaultRef: false, busy: 0, clean: true as boolean | null };
  it("merged PR, clean tree, idle → reclaim", () => {
    expect(reclaimDecision(base)).toEqual({ reclaim: true, why: "merged" });
  });
  it("branch deleted upstream → reclaim; PR closed without merge → reclaim", () => {
    expect(reclaimDecision({ ...base, fate: "gone" })).toEqual({ reclaim: true, why: "gone" });
    expect(reclaimDecision({ ...base, fate: "closed" })).toEqual({ reclaim: true, why: "closed" });
  });
  it("open PR / no PR / unknown (GitHub unreachable) → keep, naming why", () => {
    expect(reclaimDecision({ ...base, fate: "open" })).toEqual({ reclaim: false, why: "pr-open" });
    expect(reclaimDecision({ ...base, fate: "no-pr" })).toEqual({ reclaim: false, why: "no-pr" });
    expect(reclaimDecision({ ...base, fate: "unknown" })).toEqual({ reclaim: false, why: "fate-unknown" });
  });
  it("the default branch is never reclaimed, whatever the PR list says", () => {
    expect(reclaimDecision({ ...base, fate: "gone", isDefaultRef: true })).toEqual({ reclaim: false, why: "default-ref" });
  });
  it("an op in flight on the thread → keep (busy)", () => {
    expect(reclaimDecision({ ...base, busy: 2 })).toEqual({ reclaim: false, why: "busy" });
  });
  it("a dirty or unverifiable tree → keep (dirty): a merged PR can still have unpushed local work", () => {
    expect(reclaimDecision({ ...base, clean: false })).toEqual({ reclaim: false, why: "dirty" });
  });
  it("runtime down (tree already gone with the disk) → nothing to preserve → reclaim", () => {
    expect(reclaimDecision({ ...base, clean: null })).toEqual({ reclaim: true, why: "merged" });
  });
});

// ---------------------------------------------------------------------------
// Resident-level LRU eviction (#50): the coldest warm resident makes room
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-29T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const view = (resource: string, over: Partial<ResidentView> = {}): ResidentView => ({
  resource,
  state: "warm",
  inFlight: 0,
  onboardedAt: ago(48 * HOUR),
  provisionedAt: ago(47 * HOUR),
  threads: [],
  ...over,
});
const thread = (lastAttachAt: string, live: boolean) => ({ lastAttachAt, evicted: !live, user: live ? "worker3" : "" });

describe("pickEvictionCandidate — coldest eligible warm resident", () => {
  it("picks the resident whose last activity (attach or provisioning) is oldest", () => {
    const pick = pickEvictionCandidate(
      [
        view("repo:a/hot", { threads: [thread(ago(2 * HOUR), false)] }),
        view("repo:b/cold", { threads: [thread(ago(30 * HOUR), false)] }),
        view("repo:c/never-attached", { provisionedAt: ago(20 * HOUR) }),
      ],
      NOW,
      HOUR,
    );
    expect(pick.candidate).toEqual({ resource: "repo:b/cold", lastActivityAt: ago(30 * HOUR) });
    expect(pick.rejected).toEqual([]);
  });

  it("last activity is the NEWEST attach across all bindings, evicted ones included", () => {
    const pick = pickEvictionCandidate(
      [
        view("repo:a/x", { threads: [thread(ago(40 * HOUR), false), thread(ago(3 * HOUR), false)] }),
        view("repo:b/y", { threads: [thread(ago(10 * HOUR), false)] }),
      ],
      NOW,
      HOUR,
    );
    expect(pick.candidate?.resource).toBe("repo:b/y");
  });

  it("the floor keeps a just-used resident: nothing eligible → null with the reason", () => {
    const pick = pickEvictionCandidate([view("repo:a/x", { threads: [thread(ago(10 * 60_000), false)] })], NOW, HOUR);
    expect(pick.candidate).toBeNull();
    expect(pick.rejected).toEqual([{ resource: "repo:a/x", why: "active 10m ago (floor 60m)" }]);
  });

  it("a resident with a LIVE worktree is never evicted — it may hold uncommitted work", () => {
    const pick = pickEvictionCandidate([view("repo:a/x", { threads: [thread(ago(30 * HOUR), true)] })], NOW, HOUR);
    expect(pick.candidate).toBeNull();
    expect(pick.rejected).toEqual([{ resource: "repo:a/x", why: "1 live worktree(s)" }]);
  });

  it("only `warm` residents are candidates; busy or unknown in-flight are not", () => {
    const pick = pickEvictionCandidate(
      [
        view("repo:a/down", { state: "down" }),
        view("repo:b/refreshing", { state: "refreshing" }),
        view("repo:c/busy", { inFlight: 1 }),
        view("repo:d/unknown", { inFlight: null }),
      ],
      NOW,
      HOUR,
    );
    expect(pick.candidate).toBeNull();
    expect(pick.rejected).toEqual([
      { resource: "repo:a/down", why: "state down" },
      { resource: "repo:b/refreshing", why: "state refreshing" },
      { resource: "repo:c/busy", why: "1 operation(s) in flight" },
      { resource: "repo:d/unknown", why: "in-flight count unknown" },
    ]);
  });

  it("a view that failed to load (live view error) is rejected, never treated as cold", () => {
    const pick = pickEvictionCandidate([view("repo:a/x", { state: "unknown", inFlight: null })], NOW, HOUR);
    expect(pick.candidate).toBeNull();
    expect(pick.rejected[0]?.why).toBe("state unknown");
  });

  it("ties break on resource name so the choice is deterministic", () => {
    const t = ago(30 * HOUR);
    const pick = pickEvictionCandidate([view("repo:b/y", { provisionedAt: t }), view("repo:a/x", { provisionedAt: t })], NOW, HOUR);
    expect(pick.candidate?.resource).toBe("repo:a/x");
  });

  it("an empty fleet → null (the cap cannot be full, but the function stays total)", () => {
    expect(pickEvictionCandidate([], NOW, HOUR)).toEqual({ candidate: null, rejected: [] });
  });
});

describe("parseRefListing — one for-each-ref listing replaces a rev-parse per ref (#356 item 5)", () => {
  it("parses each line into a branch name, trimming whitespace", () => {
    const refs = parseRefListing("main\nfeat/x\n  perf/y  \n");
    expect(refs).toEqual(new Set(["main", "feat/x", "perf/y"]));
  });
  it("blank lines and a trailing newline are dropped, an empty listing is an empty set (a fully pruned mirror)", () => {
    expect(parseRefListing("")).toEqual(new Set());
    expect(parseRefListing("\n\nmain\n\n")).toEqual(new Set(["main"]));
  });
});
