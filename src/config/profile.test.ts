import { describe, expect, it } from "vitest";
import { AGENTS } from "../agents/registry.js";
import {
  BOUNDARY_SCOPES,
  boundedByParent,
  budgetedAgent,
  clipSourceLabel,
  declaredProfile,
  effectiveProfile,
  identityWithin,
  intersectBoundaries,
  type ScopedBoundary,
} from "./profile.js";

// Feature: docs/reference/specs/routing-and-config.md item 2 (boundaries
// intersect where every other setting overrides) and item 4 (the profile
// gate's clip-or-refuse rule per axis) — the pure module behind both, tested
// without a config store or a dispatch.

const layer = (scope: ScopedBoundary["scope"], boundary: ScopedBoundary["boundary"]): ScopedBoundary => ({
  scope,
  boundary,
});

describe("intersectBoundaries — the smallest budget, the lowest identity, the intersection of machines", () => {
  it("no layer sets a boundary → nothing caps anything (undefined)", () => {
    expect(intersectBoundaries([])).toBeUndefined();
    expect(intersectBoundaries([layer("channel", {})])).toBeUndefined();
  });

  it("across three layers: the smallest maxMinutes, the lowest maxIdentity, the machines every layer allows — each axis naming the scope that set the tightest value", () => {
    const out = intersectBoundaries([
      layer("defaults", {
        maxMinutes: 60,
        maxIdentity: "write",
        machines: ["none", "blank", "repo-cold", "repo-resident"],
      }),
      layer("channel", { maxMinutes: 45, machines: ["none", "repo-cold", "repo-resident"] }),
      layer("user", { maxMinutes: 50, maxIdentity: "read", machines: ["repo-cold", "none", "blank"] }),
    ]);
    expect(out).toEqual({
      maxMinutes: { value: 45, scope: "channel" },
      maxIdentity: { value: "read", scope: "user" },
      machines: {
        value: ["none", "repo-cold"],
        by: [
          { scope: "defaults", machines: ["none", "blank", "repo-cold", "repo-resident"] },
          { scope: "channel", machines: ["none", "repo-cold", "repo-resident"] },
          { scope: "user", machines: ["repo-cold", "none", "blank"] },
        ],
      },
    });
  });

  it("an absent axis caps nothing: a layer that names only minutes leaves identity and machines to the others", () => {
    const out = intersectBoundaries([layer("channel", { maxMinutes: 30 }), layer("user", { maxIdentity: "none" })]);
    expect(out).toEqual({
      maxMinutes: { value: 30, scope: "channel" },
      maxIdentity: { value: "none", scope: "user" },
    });
  });

  it("a user boundary can only tighten what the channel set, never loosen it", () => {
    const out = intersectBoundaries([
      layer("channel", { maxMinutes: 20, maxIdentity: "read", machines: ["none"] }),
      layer("user", { maxMinutes: 120, maxIdentity: "write", machines: ["none", "repo-resident"] }),
    ]);
    expect(out?.maxMinutes).toEqual({ value: 20, scope: "channel" });
    expect(out?.maxIdentity).toEqual({ value: "read", scope: "channel" });
    expect(out?.machines?.value).toEqual(["none"]);
  });

  it("on a tie the first layer (the least specific scope) is named, and the intersected machine list is in canonical class order", () => {
    const out = intersectBoundaries([
      layer("defaults", { maxMinutes: 30, machines: ["repo-resident", "none"] }),
      layer("channel", { maxMinutes: 30, machines: ["none", "repo-resident"] }),
    ]);
    expect(out?.maxMinutes).toEqual({ value: 30, scope: "defaults" });
    expect(out?.machines?.value).toEqual(["none", "repo-resident"]);
  });
});

describe("identityWithin — the order none < read < write", () => {
  it("holds along the order and nowhere else", () => {
    expect(identityWithin("none", "none")).toBe(true);
    expect(identityWithin("none", "read")).toBe(true);
    expect(identityWithin("read", "write")).toBe(true);
    expect(identityWithin("write", "write")).toBe(true);
    expect(identityWithin("read", "none")).toBe(false);
    expect(identityWithin("write", "read")).toBe(false);
  });
});

describe("effectiveProfile — preset ∩ directives ∩ boundary, clip or refuse per axis", () => {
  it("with no boundary and no directive every preset runs exactly its declared profile", () => {
    for (const agent of Object.values(AGENTS)) {
      expect(effectiveProfile(agent, {}, undefined)).toEqual({ kind: "profile", profile: declaredProfile(agent) });
    }
  });

  it("a budget cap under the preset's minutes clips, naming the scope; one at or above it changes nothing", () => {
    const clipped = effectiveProfile(AGENTS.coding, {}, intersectBoundaries([layer("channel", { maxMinutes: 30 })]));
    expect(clipped).toEqual({
      kind: "profile",
      profile: { machine: "repo-resident", identity: "write", minutes: 30, boundedBy: "channel" },
    });
    const loose = effectiveProfile(AGENTS.coding, {}, intersectBoundaries([layer("channel", { maxMinutes: 45 })]));
    expect(loose).toEqual({ kind: "profile", profile: declaredProfile(AGENTS.coding) });
    const looser = effectiveProfile(AGENTS.coding, {}, intersectBoundaries([layer("user", { maxMinutes: 120 })]));
    expect(looser).toEqual({ kind: "profile", profile: declaredProfile(AGENTS.coding) });
  });

  it("a directive narrows the budget as the caller's own boundary and never widens it; a boundary under the directive wins the attribution", () => {
    expect(effectiveProfile(AGENTS.coding, { budget: 30 }, undefined)).toEqual({
      kind: "profile",
      profile: { machine: "repo-resident", identity: "write", minutes: 30, boundedBy: "directive" },
    });
    expect(effectiveProfile(AGENTS.coding, { budget: 200 }, undefined)).toEqual({
      kind: "profile",
      profile: declaredProfile(AGENTS.coding),
    });
    expect(
      effectiveProfile(AGENTS.coding, { budget: 30 }, intersectBoundaries([layer("channel", { maxMinutes: 20 })])),
    ).toEqual({
      kind: "profile",
      profile: { machine: "repo-resident", identity: "write", minutes: 20, boundedBy: "channel" },
    });
    expect(
      effectiveProfile(AGENTS.coding, { budget: 10 }, intersectBoundaries([layer("channel", { maxMinutes: 20 })])),
    ).toEqual({
      kind: "profile",
      profile: { machine: "repo-resident", identity: "write", minutes: 10, boundedBy: "directive" },
    });
  });

  it("an identity above the cap is refused — never clipped — naming the axis, the cap and its scope; one at or under it passes", () => {
    const bounded = intersectBoundaries([layer("channel", { maxIdentity: "read" })]);
    expect(effectiveProfile(AGENTS.coding, {}, bounded)).toEqual({
      kind: "refused",
      refusal: { axis: "identity", needs: "write", cap: "read", scope: "channel" },
    });
    expect(effectiveProfile(AGENTS.review, {}, bounded)).toEqual({
      kind: "profile",
      profile: declaredProfile(AGENTS.review),
    });
    expect(effectiveProfile(AGENTS.general, {}, bounded)).toEqual({
      kind: "profile",
      profile: declaredProfile(AGENTS.general),
    });
  });

  it("a machine class outside the allowed set is refused naming the class, the set and every scope whose list excludes it", () => {
    const bounded = intersectBoundaries([
      layer("defaults", { machines: ["none", "blank", "repo-cold", "repo-resident"] }),
      layer("channel", { machines: ["none", "repo-cold"] }),
      layer("user", { machines: ["none", "blank"] }),
    ]);
    expect(effectiveProfile(AGENTS.coding, {}, bounded)).toEqual({
      kind: "refused",
      refusal: { axis: "machine", needs: "repo-resident", allowed: ["none"], scopes: ["channel", "user"] },
    });
    expect(effectiveProfile(AGENTS.general, {}, bounded)).toEqual({
      kind: "profile",
      profile: declaredProfile(AGENTS.general),
    });
  });

  it("identity is judged before the class, and a refusal on either axis is never softened by a budget cap; a cap equal to the preset's budget changes nothing", () => {
    const bounded = intersectBoundaries([layer("channel", { maxMinutes: 3, maxIdentity: "none", machines: ["none"] })]);
    expect(effectiveProfile(AGENTS.coding, {}, bounded)).toMatchObject({
      kind: "refused",
      refusal: { axis: "identity", needs: "write", cap: "none", scope: "channel" },
    });
    expect(effectiveProfile(AGENTS.general, {}, bounded)).toEqual({
      kind: "profile",
      profile: { machine: "none", identity: "none", minutes: 3, boundedBy: "channel" },
    });
    const equal = intersectBoundaries([layer("channel", { maxMinutes: AGENTS.general.maxMinutes })]);
    expect(effectiveProfile(AGENTS.general, {}, equal)).toEqual({
      kind: "profile",
      profile: declaredProfile(AGENTS.general),
    });
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 20 — a child run's
// effective profile takes the parent's remaining wall clock as one more
// boundary, on the minutes axis alone, attributed to `parent`.
describe("boundedByParent — the parent's remaining wall clock as one more boundary", () => {
  it("caps the minutes at the whole minutes the parent has left, attributed to `parent`, and touches no other axis", () => {
    const channel = intersectBoundaries([layer("channel", { maxIdentity: "read", maxMinutes: 45 })]);
    expect(boundedByParent(channel, 7 * 60_000 + 59_000)).toEqual({
      maxMinutes: { value: 7, scope: "parent" },
      maxIdentity: { value: "read", scope: "channel" },
    });
    expect(boundedByParent(undefined, 30 * 60_000)).toEqual({ maxMinutes: { value: 30, scope: "parent" } });
  });

  it("a parent with more time left than the tightest cap on the path changes nothing", () => {
    const channel = intersectBoundaries([layer("channel", { maxMinutes: 10 })]);
    expect(boundedByParent(channel, 60 * 60_000)).toBe(channel);
    expect(boundedByParent(channel, 10 * 60_000)).toBe(channel);
  });

  it("the profile then clips as for any boundary: the child of a parent with 5 minutes left runs 5 as `parent`; the source label reads `parent run's budget`", () => {
    const bounded = boundedByParent(undefined, 5 * 60_000 + 200);
    expect(effectiveProfile(AGENTS.research, {}, bounded)).toEqual({
      kind: "profile",
      profile: { machine: "none", identity: "none", minutes: 5, boundedBy: "parent" },
    });
    expect(clipSourceLabel("parent")).toBe("parent run's budget");
    expect(BOUNDARY_SCOPES).toContain("parent");
  });
});

describe("declaredProfile and budgetedAgent", () => {
  it("the declared profile is the preset's three axes; the budgeted agent is a copy with the profile's minutes and nothing else changed", () => {
    expect(declaredProfile(AGENTS.review)).toEqual({ machine: "repo-resident", identity: "read", minutes: 25 });
    const budgeted = budgetedAgent(AGENTS.coding, { machine: "repo-resident", identity: "write", minutes: 12 });
    expect(budgeted).toEqual({ ...AGENTS.coding, maxMinutes: 12 });
    expect(budgeted).not.toBe(AGENTS.coding);
    expect(AGENTS.coding.maxMinutes).toBe(45);
  });
});
