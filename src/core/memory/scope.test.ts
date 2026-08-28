import { describe, expect, it } from "vitest";
import { deriveScopeKey } from "./scope.js";

// Feature: features/memory.md — the pure scope deriver. PR1: org-scoped,
// namespaced per AGENTS.md invariant 4.

describe("deriveScopeKey", () => {
  it("derives the org scope key, platform-namespaced", () => {
    expect(deriveScopeKey("org")).toBe("org:coreplanelabs");
  });
});
