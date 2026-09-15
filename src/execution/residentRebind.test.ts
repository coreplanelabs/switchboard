import { describe, expect, it } from "vitest";
import {
  boundByFor,
  boundByOf,
  parseOwnPr,
  parseRefByDefault,
  rebindPlan,
  rebindRefused,
  rebindVerdict,
  type RebindableBinding,
} from "./residentRebind.js";

// Feature: docs/reference/specs/resident-repos.md item 16 — the one exception to
// the sticky ref binding: a thread bound to the repo default for want of a
// named branch moves onto the branch its OWN run opened a pull request on, once,
// when that branch is a local branch of the thread's worktree and the tree is
// clean. A ref a person named is never moved, a rebound thread never moves
// again, a branch the tree never made is refused, and a dirty tree keeps its
// binding — every refusal named in the attach answer.

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

  it("a default-bound thread with a live tree is measured: the tree decides", () => {
    expect(rebindPlan({ ownPr: OWN_PR, reuse: false, binding: bound(), defaultRef: DEFAULT_REF })).toEqual({
      kind: "measure",
      from: "main",
      to: "fix/exact-match",
      pr: 7,
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

  it("a thread already rebound is never moved again", () => {
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
  });

  it("an evicted binding has no tree to verify the branch in: refused as branch-absent", () => {
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
        why: "the thread's worktree was evicted; the branch cannot be verified there",
      },
    });
  });

  it("a resumed run's attach (reuse) never moves the tree under the run", () => {
    expect(rebindPlan({ ownPr: OWN_PR, reuse: true, binding: bound(), defaultRef: DEFAULT_REF })).toEqual({
      kind: "none",
    });
  });
});

describe("rebindVerdict: the tree decides a measured plan", () => {
  const plan = { to: OWN_PR.ref, pr: OWN_PR.number };

  it("the branch is a local branch of the thread's worktree and the tree is clean → rebind", () => {
    expect(rebindVerdict(plan, { exists: true, branchExists: true, dirty: false })).toEqual({ kind: "rebind" });
  });

  it("a branch the tree never made is refused: the physical fact this thread's run created it is missing", () => {
    expect(rebindVerdict(plan, { exists: true, branchExists: false, dirty: false })).toEqual({
      kind: "refuse",
      refused: {
        ...plan,
        reason: "branch-absent",
        why: "\"fix/exact-match\" is not a local branch of the thread's worktree; only a branch this thread's own run made moves it",
      },
    });
    expect(rebindVerdict(plan, { exists: false })).toMatchObject({
      kind: "refuse",
      refused: {
        reason: "branch-absent",
        why: "the thread's worktree is missing; the branch cannot be verified there",
      },
    });
    // A tree git cannot read verifies nothing either — whatever rev-parse said.
    expect(rebindVerdict(plan, { exists: true, branchExists: true, readable: false })).toMatchObject({
      kind: "refuse",
      refused: {
        reason: "branch-absent",
        why: "the thread's worktree cannot be read; the branch cannot be verified there",
      },
    });
  });

  it("a dirty tree keeps its binding: never at the cost of uncommitted work", () => {
    expect(rebindVerdict(plan, { exists: true, branchExists: true, dirty: true })).toEqual({
      kind: "refuse",
      refused: {
        ...plan,
        reason: "dirty",
        why: "the worktree has uncommitted changes on the bound branch; the binding stands until they are committed or discarded",
      },
    });
  });

  it("a checkout that fails is a refusal naming git's first line, never an attach failure", () => {
    expect(rebindRefused(plan, "checkout-failed", "error: pathspec did not match")).toEqual({
      ...plan,
      reason: "checkout-failed",
      why: "error: pathspec did not match",
    });
  });
});
