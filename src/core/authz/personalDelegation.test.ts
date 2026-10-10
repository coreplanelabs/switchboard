import { describe, expect, it } from "vitest";
import { resolveChatActor } from "./actor.js";
import { authorize } from "./authorize.js";
import { predicateFor, matchesPredicate } from "./predicate.js";
import { NO_GRANTS, type Grants } from "./types.js";

// Feature: docs/reference/specs/authorization.md — a verified person's rights and delegated scope.
describe("verified personal delegation", () => {
  const message = {
    userId: "slack:UALICE",
    authenticatedAs: "mcp:device",
    channelId: "mcp:ops",
    threadKey: "mcp:ops:one",
  };
  function actor(
    actions: string[] = ["config:write", "runs:read", "memory:read"],
    person: Grants = {
      actions: new Set(["runs:read", "memory:read"]),
      channels: new Set<string>(),
      repos: new Set<string>(),
      repoAccess: { except: new Set(["acme/closed"]) },
    },
  ) {
    return resolveChatActor(message, (id) =>
      id === "mcp:device"
        ? { actions: new Set(actions), channels: new Set<string>(), repos: new Set(["acme/open", "acme/closed"]) }
        : id === "slack:UALICE"
          ? person
          : NO_GRANTS,
    );
  }
  it("preserves native personal-setting rights while requiring the connection's write grant", () => {
    expect(authorize(actor(), "config:write", { type: "command", id: "config.set" })).toEqual({ allow: true });
    expect(authorize(actor(), "config:write", { type: "config-scope", kind: "user", id: "slack:UALICE" })).toEqual({
      allow: true,
    });
    expect(authorize(actor(["config:read"]), "config:write", { type: "command", id: "config.set" })).toMatchObject({
      allow: false,
    });
    expect(
      authorize(actor(), "config:write", { type: "config-scope", kind: "channel", id: "slack:COTHER" }),
    ).toMatchObject({ allow: false });
  });
  it("does not borrow code restrictions, repo memory ownership or private-channel access", () => {
    expect(authorize(actor(), "repo:use", { type: "repo", owner: "acme", name: "open" })).toEqual({ allow: true });
    expect(authorize(actor(), "repo:use", { type: "repo", owner: "acme", name: "closed" })).toMatchObject({
      allow: false,
    });
    expect(
      authorize(actor(), "memory:read", { type: "memory-scope", kind: "repo", key: "repo:acme/open" }),
    ).toMatchObject({ allow: false });
    const predicate = predicateFor(actor(), "runs:read", "run");
    expect(
      matchesPredicate(predicate, { userId: "mcp:device", channelId: "slack:CPRIVATE", channelVisibility: "private" }),
    ).toBe(true);
    expect(
      matchesPredicate(predicate, {
        userId: "slack:UOTHER",
        channelId: "slack:CPRIVATE",
        channelVisibility: "private",
      }),
    ).toBe(false);
    expect(authorize(actor([], NO_GRANTS), "runs:read", { type: "command", id: "runs.list" })).toMatchObject({
      allow: false,
    });
  });
});
