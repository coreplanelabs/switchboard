import { describe, expect, it } from "vitest";
import type { Scope } from "../config.js";
import { boundaryProblem, validateBoundaries } from "./validate.js";

/** A scope as a stored document carries it — any shape, typed as nothing yet — so the test can hand the validator the words it must refuse. */
const stored = (boundary: Record<string, unknown>): Scope => ({ boundary }) as unknown as Scope;

// Feature: docs/reference/specs/routing-and-config.md item 2 (record 0044, the
// confirm axis) — the validator holds `boundary.confirm` to its two settable
// classes wherever config can carry a boundary. `exec` and `never` are words
// on or beside the ladder that no scope may set yet, each refused with its own
// reason; any other word is refused with the class list; a stored `never` or
// `exec` stops the load exactly as a bad `maxMinutes` does.
describe("boundaryProblem — the confirm axis", () => {
  it("accepts the two settable classes, `write` and `destructive`, alone or beside the run axes", () => {
    expect(boundaryProblem("defaults.boundary", { confirm: "write" })).toBeUndefined();
    expect(boundaryProblem("defaults.boundary", { confirm: "destructive" })).toBeUndefined();
    expect(
      boundaryProblem("users.slack:UX.boundary", { maxMinutes: 45, maxIdentity: "read", confirm: "destructive" }),
    ).toBeUndefined();
  });

  it("refuses `exec` by name with its reason: a test or build never asks", () => {
    expect(boundaryProblem("channels.slack:CX.boundary", { confirm: "exec" })).toBe(
      'channels.slack:CX.boundary.confirm is "exec" — a test or build never asks (record 0044)',
    );
  });

  it("refuses `never` by name with its reason: the door's write misbind rate has not been measured over a period", () => {
    expect(boundaryProblem("users.slack:UX.boundary", { confirm: "never" })).toBe(
      'users.slack:UX.boundary.confirm is "never" — not allowed until the door\'s write misbind rate has been measured over a period (record 0044, open question 2)',
    );
  });

  it("refuses any other word with the two classes, in the shape of the identity message; a non-string too", () => {
    expect(boundaryProblem("defaults.boundary", { confirm: "read" })).toBe(
      'defaults.boundary.confirm is "read" — valid classes: write, destructive',
    );
    expect(boundaryProblem("defaults.boundary", { confirm: "always" })).toBe(
      'defaults.boundary.confirm is "always" — valid classes: write, destructive',
    );
    expect(boundaryProblem("defaults.boundary", { confirm: 1 })).toBe(
      'defaults.boundary.confirm is "1" — valid classes: write, destructive',
    );
  });

  it("the run axes are judged first, so a bad minutes cap is named before a bad confirm; an unknown field still wins over both", () => {
    expect(boundaryProblem("defaults.boundary", { maxMinutes: 1, confirm: "never" })).toBe(
      "defaults.boundary.maxMinutes must be an integer >= 2",
    );
    expect(boundaryProblem("defaults.boundary", { confirms: "write" })).toBe(
      "defaults.boundary: unknown field confirms",
    );
  });
});

describe("validateBoundaries — a stored confirm is held to the same rule at load", () => {
  it("a `never` under a user, an `exec` under the defaults and an unknown class under a channel each stop the load naming the source and the path", () => {
    expect(() => validateBoundaries({ users: { "slack:UX": stored({ confirm: "never" }) } }, "overrides.json")).toThrow(
      'overrides.json: users.slack:UX.boundary.confirm is "never" — not allowed until the door\'s write misbind rate has been measured over a period (record 0044, open question 2)',
    );
    expect(() => validateBoundaries({ defaults: { boundary: { confirm: "exec" } } }, "config.yaml")).toThrow(
      'config.yaml: defaults.boundary.confirm is "exec" — a test or build never asks (record 0044)',
    );
    expect(() =>
      validateBoundaries({ channels: { "slack:CX": stored({ confirm: "sometimes" }) } }, "config.yaml"),
    ).toThrow('config.yaml: channels.slack:CX.boundary.confirm is "sometimes" — valid classes: write, destructive');
  });

  it("the two classes load under every scope, alone or beside the run axes", () => {
    expect(() =>
      validateBoundaries(
        {
          defaults: { boundary: { maxMinutes: 120, confirm: "write" } },
          channels: { "slack:CX": { boundary: { confirm: "destructive" } } },
          users: { "slack:UX": { boundary: { maxIdentity: "read", confirm: "write" } } },
        },
        "config.yaml",
      ),
    ).not.toThrow();
  });
});
