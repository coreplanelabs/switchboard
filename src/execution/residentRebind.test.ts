import { describe, expect, it } from "vitest";
import {
  boundByFor,
  boundByOf,
  canReturnToDefault,
  OWN_BRANCHES_MAX,
  parseOwnPr,
  parsePushed,
  parseRefByDefault,
  PUSHED_MAX,
  rebindPlan,
  rebindRefused,
  rebindVerdict,
  rememberOwnBranches,
  returnToDefault,
  type RebindableBinding,
} from "./residentRebind.js";

// Feature: docs/reference/specs/resident-repos.md item 16 — the one exception to
// the sticky ref binding: a thread bound to the repo default for want of a
// named branch moves onto the branch its OWN run opened a pull request on, once
// per pull request. The move is a decision about the binding alone — the
// attach provisions the tree at the moved ref (item 17). A ref a person named
// is never moved, a rebound thread never moves again until its move is
// returned, a branch that is neither remembered from a release nor local to
// the thread's surviving tree is refused — every refusal named in the attach
// answer. The second movement: a rebound binding whose branch is gone from the
// mirror goes back to the default; a person-named ref never does.

const OWN_PR = { number: 7, ref: "fix/exact-match" };
const DEFAULT_REF = "main";

const bound = (over: Partial<RebindableBinding> = {}): RebindableBinding => ({
  ref: DEFAULT_REF,
  user: "worker2",
  ...over,
});

describe("parseOwnPr: the `ownPr` body field", () => {
  it("absent → null (the body every bot always sent); a well-formed {number, ref} → itself", () => {
    expect(parseOwnPr(undefined)).toEqual({ ownPr: null });
    expect(parseOwnPr({ number: 7, ref: "fix/exact-match" })).toEqual({ ownPr: { number: 7, ref: "fix/exact-match" } });
  });

  it("anything else is a named 400-shaped error: a non-object, a non-positive or fractional number, an empty or non-string ref", () => {
    const error = "ownPr must be {number: <positive integer>, ref: <branch>} when present";
    expect(parseOwnPr("7")).toEqual({ error });
    expect(parseOwnPr(null)).toEqual({ error });
    expect(parseOwnPr({ number: 0, ref: "x" })).toEqual({ error });
    expect(parseOwnPr({ number: 1.5, ref: "x" })).toEqual({ error });
    expect(parseOwnPr({ number: "7", ref: "x" })).toEqual({ error });
    expect(parseOwnPr({ number: 7, ref: "" })).toEqual({ error });
    expect(parseOwnPr({ number: 7 })).toEqual({ error });
  });
});

describe("parseRefByDefault: the `refByDefault` body field", () => {
  it("absent → false; a boolean → itself; anything else → a named 400-shaped error", () => {
    expect(parseRefByDefault(undefined)).toEqual({ refByDefault: false });
    expect(parseRefByDefault(true)).toEqual({ refByDefault: true });
    expect(parseRefByDefault(false)).toEqual({ refByDefault: false });
    expect(parseRefByDefault("yes")).toEqual({ error: "refByDefault must be a boolean when present" });
    expect(parseRefByDefault(1)).toEqual({ error: "refByDefault must be a boolean when present" });
  });
});

describe("boundBy: how a binding's ref was chosen", () => {
  it("a new binding records `default` only when the caller bound the default branch for want of a name; any other ref, or a named default, is `name`", () => {
    expect(boundByFor({ refByDefault: true, ref: "main", defaultRef: "main" })).toBe("default");
    expect(boundByFor({ refByDefault: false, ref: "main", defaultRef: "main" })).toBe("name");
    expect(boundByFor({ refByDefault: true, ref: "feature", defaultRef: "main" })).toBe("name");
  });

  it("a binding made before the field reads as bound by default iff its ref is the default branch; a recorded value wins", () => {
    expect(boundByOf({ ref: "main" }, "main")).toBe("default");
    expect(boundByOf({ ref: "feature" }, "main")).toBe("name");
    expect(boundByOf({ ref: "main", boundBy: "name" }, "main")).toBe("name");
    expect(boundByOf({ ref: "feature", boundBy: "default" }, "main")).toBe("default");
  });
});

describe("rebindPlan: whether the binding may move, read off the binding alone", () => {
  it("no hint, no binding yet, or a binding already on the hinted branch → nothing to do", () => {
    expect(rebindPlan({ ownPr: null, reuse: false, binding: bound(), defaultRef: DEFAULT_REF })).toEqual({
      kind: "none",
    });
    expect(rebindPlan({ ownPr: OWN_PR, reuse: false, binding: undefined, defaultRef: DEFAULT_REF })).toEqual({
      kind: "none",
    });
    expect(
      rebindPlan({ ownPr: OWN_PR, reuse: false, binding: bound({ ref: OWN_PR.ref }), defaultRef: DEFAULT_REF }),
    ).toEqual({ kind: "none" });
  });

  it("a default-bound thread with a live tree is measured: the memory, else the tree, decides", () => {
    expect(rebindPlan({ ownPr: OWN_PR, reuse: false, binding: bound(), defaultRef: DEFAULT_REF })).toEqual({
      kind: "measure",
      from: "main",
      to: "fix/exact-match",
      pr: 7,
      own: false,
    });
    // A binding recorded as bound by default is measured whatever its ref.
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({ ref: "trunk", boundBy: "default" }),
        defaultRef: DEFAULT_REF,
      }),
    ).toMatchObject({ kind: "measure", from: "trunk" });
  });

  it("a ref a person named is never moved: a binding recorded `name`, or a pre-field binding whose ref is not the default", () => {
    expect(
      rebindPlan({ ownPr: OWN_PR, reuse: false, binding: bound({ boundBy: "name" }), defaultRef: DEFAULT_REF }),
    ).toEqual({
      kind: "refuse",
      refused: {
        to: "fix/exact-match",
        pr: 7,
        reason: "named-ref",
        why: 'the thread is bound to "main" by name; a named branch is never moved',
      },
    });
    expect(
      rebindPlan({ ownPr: OWN_PR, reuse: false, binding: bound({ ref: "release/2" }), defaultRef: DEFAULT_REF }),
    ).toMatchObject({ kind: "refuse", refused: { reason: "named-ref" } });
  });

  it("a thread already rebound is never moved again — until its move is returned, when the thread may follow its next pull request", () => {
    const rebound = { from: "main", to: "fix/first", pr: 5, at: "2000-01-01T00:00:00.000Z" };
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({ ref: "fix/first", boundBy: "default", rebound }),
        defaultRef: DEFAULT_REF,
      }),
    ).toEqual({
      kind: "refuse",
      refused: {
        to: "fix/exact-match",
        pr: 7,
        reason: "already-rebound",
        why: 'the thread was already rebound from "main" to "fix/first" (its pull request #5); a thread moves once',
      },
    });
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({ boundBy: "default", rebound: { ...rebound, returnedAt: "t1" } }),
        defaultRef: DEFAULT_REF,
      }),
    ).toMatchObject({ kind: "measure", from: "main", to: "fix/exact-match" });
  });

  it("an evicted binding with no memory of the branch has no tree to verify it in: refused as branch-absent", () => {
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({ evicted: true, user: "" }),
        defaultRef: DEFAULT_REF,
      }),
    ).toEqual({
      kind: "refuse",
      refused: {
        to: "fix/exact-match",
        pr: 7,
        reason: "branch-absent",
        why: "the thread's worktree was evicted and none of its runs pushed \"fix/exact-match\"; only a branch this thread's own run pushed moves it",
      },
    });
  });

  it("a resumed run's attach (reuse) never moves the tree under the run", () => {
    expect(rebindPlan({ ownPr: OWN_PR, reuse: true, binding: bound(), defaultRef: DEFAULT_REF })).toEqual({
      kind: "none",
    });
  });
});

describe("parsePushed and rememberOwnBranches: the `pushed` detach body field and the binding's memory of it", () => {
  const error = "pushed must be a list of {ref: <branch>, pr: <positive integer>} when present";

  it("absent → an empty list (the body every bot always sent); a well-formed list → itself", () => {
    expect(parsePushed(undefined)).toEqual({ pushed: [] });
    expect(parsePushed([])).toEqual({ pushed: [] });
    expect(parsePushed([{ ref: "fix/x", pr: 7 }])).toEqual({ pushed: [{ ref: "fix/x", pr: 7 }] });
  });

  it("anything else is a named 400-shaped error: a non-list, a malformed entry, or more than the cap", () => {
    expect(parsePushed({ ref: "fix/x", pr: 7 })).toEqual({ error });
    expect(parsePushed([{ ref: "", pr: 7 }])).toEqual({ error });
    expect(parsePushed([{ ref: "fix/x", pr: 0 }])).toEqual({ error });
    expect(parsePushed([{ ref: "fix/x" }])).toEqual({ error });
    expect(parsePushed([null])).toEqual({ error });
    expect(parsePushed(Array.from({ length: PUSHED_MAX + 1 }, (_, i) => ({ ref: `b${i}`, pr: i + 1 })))).toEqual({
      error,
    });
  });

  it("remembering appends new branches, replaces a re-pushed one in place (its PR and time move), and keeps the newest up to the cap", () => {
    const first = rememberOwnBranches(undefined, [{ ref: "fix/x", pr: 7 }], "2026-01-01T00:00:00.000Z");
    expect(first).toEqual([{ ref: "fix/x", pr: 7, at: "2026-01-01T00:00:00.000Z" }]);
    const second = rememberOwnBranches(
      first,
      [
        { ref: "fix/y", pr: 8 },
        { ref: "fix/x", pr: 9 },
      ],
      "2026-01-02T00:00:00.000Z",
    );
    expect(second).toEqual([
      { ref: "fix/y", pr: 8, at: "2026-01-02T00:00:00.000Z" },
      { ref: "fix/x", pr: 9, at: "2026-01-02T00:00:00.000Z" },
    ]);
    const many = Array.from({ length: OWN_BRANCHES_MAX + 3 }, (_, i) => ({ ref: `b${i}`, pr: i + 1, at: "t" }));
    const capped = rememberOwnBranches(many, [{ ref: "newest", pr: 999 }], "u");
    expect(capped).toHaveLength(OWN_BRANCHES_MAX);
    expect(capped.at(-1)).toEqual({ ref: "newest", pr: 999, at: "u" });
    // 53 remembered + 1 new = 54; the oldest four fall off.
    expect(capped[0]).toEqual({ ref: "b4", pr: 5, at: "t" });
  });
});

// The thread remembers the branches its runs pushed (item 16): a run's end
// releases its tree, so on the happy path the thread's own worktree never
// exists at the follow-up's attach and no local branch can be verified there.
// The run's release hands the resident the exact fact — `pushed: [{ref, pr}]`
// off its `pr_opened` events — and the binding keeps it as `ownBranches`,
// which survives the eviction by construction. A default-bound thread whose
// own branch is remembered moves, tree or no tree; a live tree whose binding
// remembers nothing is the fallback evidence.
describe("rebindPlan and rebindVerdict when the thread's tree is gone: the remembered branch decides", () => {
  const own = [{ ref: OWN_PR.ref, pr: OWN_PR.number, at: "2026-01-01T00:00:00.000Z" }];

  it("an evicted default-bound thread whose own run pushed the branch is recreated at it: the binding moves and the attach clones the branch", () => {
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({ evicted: true, user: "", ownBranches: own }),
        defaultRef: DEFAULT_REF,
      }),
    ).toEqual({ kind: "recreate", from: "main", to: "fix/exact-match", pr: 7 });
  });

  it("an evicted thread whose runs never pushed the branch is refused branch-absent, and the sentence says why", () => {
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({ evicted: true, user: "", ownBranches: [{ ref: "other", pr: 3, at: "t" }] }),
        defaultRef: DEFAULT_REF,
      }),
    ).toEqual({
      kind: "refuse",
      refused: {
        to: "fix/exact-match",
        pr: 7,
        reason: "branch-absent",
        why: "the thread's worktree was evicted and none of its runs pushed \"fix/exact-match\"; only a branch this thread's own run pushed moves it",
      },
    });
  });

  it("the memory never overrides the other guards: a named ref, a rebound thread and a resume stay put whatever was pushed", () => {
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({ evicted: true, user: "", boundBy: "name", ownBranches: own }),
        defaultRef: DEFAULT_REF,
      }),
    ).toMatchObject({ kind: "refuse", refused: { reason: "named-ref" } });
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: false,
        binding: bound({
          evicted: true,
          user: "",
          ownBranches: own,
          rebound: { from: "main", to: "fix/first", pr: 5, at: "t" },
          ref: "fix/first",
          boundBy: "default",
        }),
        defaultRef: DEFAULT_REF,
      }),
    ).toMatchObject({ kind: "refuse", refused: { reason: "already-rebound" } });
    expect(
      rebindPlan({
        ownPr: OWN_PR,
        reuse: true,
        binding: bound({ evicted: true, user: "", ownBranches: own }),
        defaultRef: DEFAULT_REF,
      }),
    ).toEqual({ kind: "none" });
  });

  it("a live binding's plan carries whether the branch is remembered, and the memory decides by itself: a tree that turns out missing, or never made the branch, moves all the same", () => {
    expect(
      rebindPlan({ ownPr: OWN_PR, reuse: false, binding: bound({ ownBranches: own }), defaultRef: DEFAULT_REF }),
    ).toEqual({
      kind: "measure",
      from: "main",
      to: "fix/exact-match",
      pr: 7,
      own: true,
    });
    expect(rebindPlan({ ownPr: OWN_PR, reuse: false, binding: bound(), defaultRef: DEFAULT_REF })).toMatchObject({
      kind: "measure",
      own: false,
    });
    const plan = { to: OWN_PR.ref, pr: OWN_PR.number };
    expect(rebindVerdict({ ...plan, own: true }, { exists: false })).toEqual({ kind: "rebind" });
    expect(rebindVerdict({ ...plan, own: true }, { exists: true, branchExists: false })).toEqual({ kind: "rebind" });
    expect(rebindVerdict({ ...plan, own: false }, { exists: false })).toEqual({
      kind: "refuse",
      refused: {
        ...plan,
        reason: "branch-absent",
        why: 'the thread\'s worktree is missing and none of its runs pushed "fix/exact-match"; the branch cannot be verified there',
      },
    });
  });
});

describe("rebindVerdict: without a memory of the branch, the surviving tree decides a measured plan", () => {
  const plan = { to: OWN_PR.ref, pr: OWN_PR.number };

  it("the branch is a local branch of the thread's worktree → rebind, whatever the tree's dirt or HEAD: the attach provisions the tree at the branch", () => {
    expect(rebindVerdict(plan, { exists: true, branchExists: true })).toEqual({ kind: "rebind" });
    expect(rebindVerdict({ ...plan, own: false }, { exists: true, branchExists: true })).toEqual({ kind: "rebind" });
  });

  it("a branch the tree never made — or a tree git cannot read, which verifies nothing — is refused: the physical fact this thread's run created it is missing", () => {
    expect(rebindVerdict(plan, { exists: true, branchExists: false })).toEqual({
      kind: "refuse",
      refused: {
        ...plan,
        reason: "branch-absent",
        why: "\"fix/exact-match\" is not a local branch of the thread's worktree and none of its runs pushed it; only a branch this thread's own run made moves it",
      },
    });
    expect(rebindVerdict(plan, { exists: true })).toMatchObject({
      kind: "refuse",
      refused: { reason: "branch-absent" },
    });
    expect(rebindVerdict(plan, { exists: false })).toMatchObject({
      kind: "refuse",
      refused: {
        reason: "branch-absent",
        why: 'the thread\'s worktree is missing and none of its runs pushed "fix/exact-match"; the branch cannot be verified there',
      },
    });
  });

  it("a refusal carries the plan's branch and pull request beside its reason", () => {
    expect(rebindRefused(plan, "branch-absent", "the mirror does not hold it")).toEqual({
      ...plan,
      reason: "branch-absent",
      why: "the mirror does not hold it",
    });
  });
});

// The second movement (item 16): a binding can sit on a branch that dies —
// its pull request merges and the branch is deleted. Left there, every later
// attach of the thread would fail `unknown-ref` and fall to a cold sandbox for
// the rest of the thread's life. So a binding whose gone ref is EITHER the
// branch a rebind moved it onto OR one of the branches this thread itself
// pushed (`ownBranches`, whatever `boundBy` says — a ship unit's coding child
// binds its unit branch by name and pushes it) goes back to the default, the
// move recorded (`returned`, and `rebound.returnedAt` for a rebind's move), and
// the thread is default-bound again. A ref a person named that the thread
// never pushed never returns: that branch is the person's to sort out.
describe("canReturnToDefault and returnToDefault: a binding whose own branch is gone goes back to the default", () => {
  const rebound = { from: "main", to: "fix/exact-match", pr: 7, at: "t0" };
  const own = [{ ref: "plan/slug/u1", pr: 12, at: "t0" }];

  it("a default-bound binding a rebind moved, still on that branch, may return", () => {
    expect(canReturnToDefault({ ref: "fix/exact-match", boundBy: "default", rebound }, DEFAULT_REF)).toBe(true);
  });

  it("a binding on a branch this thread itself pushed may return whatever boundBy says: bound by name, bound by default, or made before the field", () => {
    expect(canReturnToDefault({ ref: "plan/slug/u1", boundBy: "name", ownBranches: own }, DEFAULT_REF)).toBe(true);
    expect(canReturnToDefault({ ref: "plan/slug/u1", boundBy: "default", ownBranches: own }, DEFAULT_REF)).toBe(true);
    expect(canReturnToDefault({ ref: "plan/slug/u1", ownBranches: own }, DEFAULT_REF)).toBe(true);
  });

  it("a ref a person named that the thread never pushed never returns — that branch is the person's to sort out — and neither does a binding never moved, one already returned, or one on the default", () => {
    expect(canReturnToDefault({ ref: "fix/exact-match", boundBy: "name", rebound }, DEFAULT_REF)).toBe(false);
    // A binding made before `boundBy` and sitting off the default reads as named.
    expect(canReturnToDefault({ ref: "fix/exact-match", rebound }, DEFAULT_REF)).toBe(false);
    expect(canReturnToDefault({ ref: "release/2", boundBy: "name" }, DEFAULT_REF)).toBe(false);
    // The thread pushed OTHER branches; the one it is bound to is not among them.
    expect(canReturnToDefault({ ref: "release/2", boundBy: "name", ownBranches: own }, DEFAULT_REF)).toBe(false);
    expect(canReturnToDefault({ ref: "main", boundBy: "default" }, DEFAULT_REF)).toBe(false);
    expect(canReturnToDefault({ ref: "main", boundBy: "default", ownBranches: own }, DEFAULT_REF)).toBe(false);
    expect(
      canReturnToDefault(
        { ref: "fix/exact-match", boundBy: "default", rebound: { ...rebound, returnedAt: "t" } },
        DEFAULT_REF,
      ),
    ).toBe(false);
    // The binding is no longer on the branch the move named: nothing to return from.
    expect(canReturnToDefault({ ref: "main", boundBy: "default", rebound }, DEFAULT_REF)).toBe(false);
    // A binding that may not return has no move back to make.
    expect(returnToDefault({ ref: "release/2", user: "worker2", boundBy: "name" }, DEFAULT_REF, "t1")).toBeUndefined();
  });

  it("the return of a rebind's move puts the ref back on the default, stamps the move returned, records the move back, and answers it for the card", () => {
    const binding = { ref: "fix/exact-match", user: "worker2", boundBy: "default" as const, rebound };
    const at = "t1";
    const back = returnToDefault(binding, DEFAULT_REF, at);
    expect(back).toBeDefined();
    expect(back!.binding).toEqual({
      ref: "main",
      user: "worker2",
      boundBy: "default",
      rebound: { ...rebound, returnedAt: at },
      returned: { from: "fix/exact-match", to: "main", pr: 7, at },
    });
    expect(back!.returned).toEqual({ from: "fix/exact-match", to: "main", pr: 7, at });
    // Default-bound again: the next own pull request may move the thread once more.
    expect(canReturnToDefault(back!.binding, DEFAULT_REF)).toBe(false);
    expect(
      rebindPlan({
        ownPr: { number: 9, ref: "fix/next" },
        reuse: false,
        binding: back!.binding,
        defaultRef: DEFAULT_REF,
      }),
    ).toMatchObject({ kind: "measure", from: "main", to: "fix/next", pr: 9 });
  });

  it("the return from a branch the thread pushed under a name it was bound to names that branch's pull request, leaves the binding default-bound with its memory, and frees the thread to follow its next pull request", () => {
    const binding = { ref: "plan/slug/u1", user: "worker2", boundBy: "name" as const, ownBranches: own };
    const at = "t1";
    const back = returnToDefault(binding, DEFAULT_REF, at);
    expect(back).toBeDefined();
    expect(back!.binding).toEqual({
      ref: "main",
      user: "worker2",
      boundBy: "default",
      ownBranches: own,
      returned: { from: "plan/slug/u1", to: "main", pr: 12, at },
    });
    expect(back!.binding).not.toHaveProperty("rebound");
    expect(back!.returned).toEqual({ from: "plan/slug/u1", to: "main", pr: 12, at });
    // Already returned: on the default, nothing to return from.
    expect(canReturnToDefault(back!.binding, DEFAULT_REF)).toBe(false);
    expect(returnToDefault(back!.binding, DEFAULT_REF, "t2")).toBeUndefined();
    // Default-bound now: the thread's next own pull request moves it as a rebind, once.
    expect(
      rebindPlan({
        ownPr: { number: 13, ref: "fix/next" },
        reuse: false,
        binding: back!.binding,
        defaultRef: DEFAULT_REF,
      }),
    ).toMatchObject({ kind: "measure", from: "main", to: "fix/next", pr: 13 });
  });

  it("a binding both rebound onto and remembered as its own returns by the rebind's record: the move is stamped returned and the pull request is the rebind's", () => {
    const binding = {
      ref: "fix/exact-match",
      user: "worker2",
      boundBy: "default" as const,
      rebound,
      ownBranches: [{ ref: "fix/exact-match", pr: 7, at: "t0" }],
    };
    const back = returnToDefault(binding, DEFAULT_REF, "t1");
    expect(back!.binding.rebound).toEqual({ ...rebound, returnedAt: "t1" });
    expect(back!.returned).toEqual({ from: "fix/exact-match", to: "main", pr: 7, at: "t1" });
  });
});
