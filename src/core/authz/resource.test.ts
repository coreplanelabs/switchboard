import { describe, expect, it } from "vitest";
import { attributesOf, targetOf, targetOfResource } from "./resource.js";
import { scope } from "./testing.js";

// Plan U1 / KTD1: the attributes a condition may read off each resource, and
// the (type, kind) targets a rule row may name.

describe("attributesOf", () => {
  it("run: channel, user, repo, and its channel visibility (absent → unknown)", () => {
    expect(attributesOf({ type: "run", id: "r", channelId: "slack:C1", userId: "slack:U1", repo: "o/r", channelVisibility: "private" })).toEqual({
      channelId: "slack:C1",
      userId: "slack:U1",
      repo: "o/r",
      visibility: "private",
      channelVisibility: "private",
    });
    expect(attributesOf({ type: "run", id: "r", channelId: "slack:C1", userId: "slack:U1" })).toEqual({ channelId: "slack:C1", userId: "slack:U1", visibility: "unknown", channelVisibility: "unknown" });
  });
  it("channel: its own id and visibility — the channel IS the resource, so both visibility attributes are its own", () => {
    expect(attributesOf({ type: "channel", id: "slack:C1", visibility: "dm" })).toEqual({ channelId: "slack:C1", visibility: "dm", channelVisibility: "dm" });
  });
  it("memory-scope: the id behind the kind's key prefix; org carries nothing but its origin visibility", () => {
    expect(attributesOf(scope("org", "org:coreplanelabs", "public"))).toEqual({ visibility: "public" });
    expect(attributesOf(scope("org", "org:coreplanelabs"))).toEqual({ visibility: "unknown" });
    expect(attributesOf(scope("user", "user:slack:U1"))).toEqual({ userId: "slack:U1", visibility: "unknown" });
    expect(attributesOf(scope("channel", "channel:slack:C1"))).toEqual({ channelId: "slack:C1", visibility: "unknown" });
    expect(attributesOf(scope("repo", "repo:o/r"))).toEqual({ repo: "o/r", visibility: "unknown" });
  });
  it("memory-scope: a key without the kind's prefix yields no relation attribute (fail-closed)", () => {
    expect(attributesOf(scope("user", "slack:U1"))).toEqual({ visibility: "unknown" });
    expect(attributesOf(scope("channel", "user:slack:U1"))).toEqual({ visibility: "unknown" });
    expect(attributesOf(scope("repo", "repo:"))).toEqual({ visibility: "unknown" });
  });
  it("repo, config-scope, agent, command", () => {
    expect(attributesOf({ type: "repo", owner: "o", name: "r" })).toEqual({ repo: "o/r", visibility: "unknown" });
    expect(attributesOf({ type: "config-scope", kind: "channel", id: "slack:C1" })).toEqual({ channelId: "slack:C1", visibility: "unknown" });
    expect(attributesOf({ type: "config-scope", kind: "user", id: "slack:U1" })).toEqual({ userId: "slack:U1", visibility: "unknown" });
    expect(attributesOf({ type: "agent", name: "coding" })).toEqual({ name: "coding", visibility: "unknown" });
    expect(attributesOf({ type: "command", id: "runs.list" })).toEqual({ visibility: "unknown" });
  });
});

describe("targetOf", () => {
  it("plain types stand alone; kinded types need a valid kind", () => {
    expect(targetOf("run")).toBe("run");
    expect(targetOf("run", "org")).toBeUndefined();
    expect(targetOf("memory-scope")).toBeUndefined();
    expect(targetOf("memory-scope", "org")).toBe("memory-scope/org");
    expect(targetOf("memory-scope", "channel")).toBe("memory-scope/channel");
    expect(targetOf("config-scope", "org")).toBeUndefined();
    expect(targetOf("nope")).toBeUndefined();
  });
  it("targetOfResource reads the kind off the resource", () => {
    expect(targetOfResource(scope("repo", "repo:o/r"))).toBe("memory-scope/repo");
    expect(targetOfResource({ type: "command", id: "x" })).toBe("command");
  });
});
