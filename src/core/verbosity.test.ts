import { describe, expect, it } from "vitest";
import { DEFAULT_VERBOSITY, isVerbosity, resolveVerbosity, shows, VERBOSITY_LEVELS } from "./verbosity.js";

// Feature: docs/reference/specs/routing-and-config.md item 28 — the verbosity ladder.

describe("verbosity — the ladder", () => {
  it("has exactly three levels, quiet first, and quiet is the default", () => {
    expect(VERBOSITY_LEVELS).toEqual(["quiet", "verbose", "debug"]);
    expect(DEFAULT_VERBOSITY).toBe("quiet");
  });

  it("isVerbosity accepts the three words and nothing else", () => {
    for (const v of VERBOSITY_LEVELS) expect(isVerbosity(v)).toBe(true);
    expect(isVerbosity("loud")).toBe(false);
    expect(isVerbosity("")).toBe(false);
    expect(isVerbosity(2)).toBe(false);
    expect(isVerbosity(undefined)).toBe(false);
  });

  it("shows: a level shows its own messages and every lower level's, never a higher one's", () => {
    expect(shows("quiet", "quiet")).toBe(true);
    expect(shows("quiet", "verbose")).toBe(false);
    expect(shows("quiet", "debug")).toBe(false);
    expect(shows("verbose", "quiet")).toBe(true);
    expect(shows("verbose", "verbose")).toBe(true);
    expect(shows("verbose", "debug")).toBe(false);
    expect(shows("debug", "quiet")).toBe(true);
    expect(shows("debug", "verbose")).toBe(true);
    expect(shows("debug", "debug")).toBe(true);
  });

  it("resolveVerbosity: request > user > channel > defaults > quiet", () => {
    expect(resolveVerbosity({})).toBe("quiet");
    expect(resolveVerbosity({ defaults: "verbose" })).toBe("verbose");
    expect(resolveVerbosity({ defaults: "verbose", channel: "debug" })).toBe("debug");
    expect(resolveVerbosity({ defaults: "verbose", channel: "debug", user: "quiet" })).toBe("quiet");
    expect(resolveVerbosity({ defaults: "verbose", channel: "debug", user: "quiet", request: "debug" })).toBe("debug");
  });
});
