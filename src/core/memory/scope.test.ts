import { describe, expect, it } from "vitest";
import { deriveScopeKey, requestScopeKeys } from "./scope.js";

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

describe("requestScopeKeys", () => {
  it("returns the org key plus the requesting user's key", () => {
    expect(requestScopeKeys("slack:U0123")).toEqual({ org: "org:coreplanelabs", user: "user:slack:U0123" });
  });

  it("degrades to org-only when the request carries no user identity", () => {
    expect(requestScopeKeys(undefined)).toEqual({ org: "org:coreplanelabs" });
    expect(requestScopeKeys("")).toEqual({ org: "org:coreplanelabs" });
  });
});
