import { describe, expect, it } from "vitest";
import { deriveScopeKey, listScopeKeys, requestScopeKeys } from "./scope.js";

// Feature: features/memory.md — the pure scope deriver. Org-scoped (#85 PR1) +
// user-scoped (#107 PR B), namespaced per AGENTS.md invariant 4.

describe("deriveScopeKey", () => {
  it("derives the org scope key, platform-namespaced", () => {
    expect(deriveScopeKey("org")).toBe("org:coreplanelabs");
  });

  it("derives the user scope key from the request's platform-namespaced user id", () => {
    expect(deriveScopeKey("user", { userId: "slack:U0123" })).toBe("user:slack:U0123");
  });

  it("refuses a user scope without a user id (never a shared `user:` bucket)", () => {
    expect(() => deriveScopeKey("user", {})).toThrow(/userId/);
    expect(() => deriveScopeKey("user", { userId: "" })).toThrow(/userId/);
  });
});

// #253 — repo and channel scopes: shared by everyone who runs in that repo /
// channel, namespaced per invariant 4 (channelId arrives already namespaced).
describe("deriveScopeKey — repo / channel (#253)", () => {
  it("derives repo and channel keys", () => {
    expect(deriveScopeKey("repo", { repo: "acme/api" })).toBe("repo:acme/api");
    expect(deriveScopeKey("channel", { channelId: "slack:C0123" })).toBe("channel:slack:C0123");
  });

  it("refuses a repo/channel scope without its input (never an anonymous shared bucket)", () => {
    expect(() => deriveScopeKey("repo", {})).toThrow(/repo/);
    expect(() => deriveScopeKey("repo", { repo: "" })).toThrow(/repo/);
    expect(() => deriveScopeKey("channel", {})).toThrow(/channelId/);
  });
});

describe("requestScopeKeys", () => {
  it("returns the org key plus the requesting user's key", () => {
    expect(requestScopeKeys("slack:U0123")).toEqual({ org: "org:coreplanelabs", user: "user:slack:U0123" });
  });

  it("adds repo and channel keys when the request has them; listScopeKeys orders org, repo, channel, user (#253)", () => {
    const keys = requestScopeKeys("slack:U0123", { repo: "acme/api", channelId: "slack:C0123" });
    expect(keys).toEqual({
      org: "org:coreplanelabs",
      user: "user:slack:U0123",
      repo: "repo:acme/api",
      channel: "channel:slack:C0123",
    });
    expect(listScopeKeys(keys)).toEqual([
      "org:coreplanelabs",
      "repo:acme/api",
      "channel:slack:C0123",
      "user:slack:U0123",
    ]);
    expect(requestScopeKeys("slack:U0123", { channelId: "slack:C0123" })).toEqual({
      org: "org:coreplanelabs",
      user: "user:slack:U0123",
      channel: "channel:slack:C0123",
    });
    expect(requestScopeKeys(undefined, { repo: "", channelId: "" })).toEqual({ org: "org:coreplanelabs" });
  });

  it("degrades to org-only when the request carries no user identity", () => {
    expect(requestScopeKeys(undefined)).toEqual({ org: "org:coreplanelabs" });
    expect(requestScopeKeys("")).toEqual({ org: "org:coreplanelabs" });
  });
});
