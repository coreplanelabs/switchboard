import { describe, expect, it } from "vitest";
import { CLI_ACTOR, actorIdFor, resolveActor, resolveChatActor } from "./actor.js";
import {
  ALL_GRANTS,
  CHAT_OPEN_ACTIONS,
  grantsFor,
  parseGrantsConfig,
  parseRestrictConfig,
  type GrantsSource,
} from "./grants.js";
import { NO_GRANTS, type Grants } from "./types.js";

// Feature: features/authorization.md item 1 (docs/decisions/0007-authorization-policy-table.md).
// Adapters resolve identity, never authority: `resolveActor` turns what an
// adapter can prove into an `Actor` whose grants come from config.

const set = (...names: string[]) => new Set(names);
const grants = (g: Partial<Grants>): Grants => ({ actions: set(), channels: set(), repos: set(), ...g });

const nativeGrants = parseGrantsConfig({
  "slack:UADMIN": { actions: "all", channels: "all", repos: "all" },
  "slack:UMGR": { actions: ["repo:write", "friction:write"] },
  "slack:UDEV": { actions: ["agent:run:coding"] },
  "access:op-1": { actions: ["runs:read", "runs:write", "friction:read", "friction:write"], channels: "all" },
  "access:svc:reader-bot": { actions: ["runs:read"], channels: "all" },
  "http:alice": { actions: ["dispatch", "runs:read"], channels: ["http:ops"] },
  "mcp:alice": { actions: ["dispatch", "runs:read"], channels: ["mcp:ops"] },
  "http:ci": { actions: ["dispatch"] },
  "mcp:ci": { actions: ["dispatch"] },
  "schedule:self-improvement": { actions: ["friction:write"], channels: "all" },
});
if (!nativeGrants.ok) throw new Error(nativeGrants.errors.join("; "));
// Every agent restricted, so no "everyone" agent grant muddies the per-actor assertions.
const restrict = parseRestrictConfig({ agents: ["general", "coding"] }, ["general", "coding"]);
if (!restrict.ok) throw new Error(restrict.errors.join("; "));

const source: GrantsSource = {
  grants: nativeGrants.grants,
  restrict: restrict.restrict,
  agentNames: ["general", "coding"],
  commandGroups: ["runs", "friction"],
};
const lookup = (id: string) => grantsFor(id, source);

describe("actorIdFor — platform-namespaced ids (invariant 4)", () => {
  it("one prefix per surface; Access service tokens under access:svc:", () => {
    expect(actorIdFor("slack", "UALICE")).toBe("slack:UALICE");
    expect(actorIdFor("http", "alice")).toBe("http:alice");
    expect(actorIdFor("mcp", "alice")).toBe("mcp:alice");
    expect(actorIdFor("access-browser", "sub-1")).toBe("access:sub-1");
    expect(actorIdFor("access-service", "reader-bot")).toBe("access:svc:reader-bot");
    expect(actorIdFor("cli", "anything")).toBe("cli:local");
    expect(actorIdFor("schedule", "self-improvement")).toBe("schedule:self-improvement");
  });
});

describe("resolveActor — kind, id, grants, origin per surface", () => {
  it("Slack admin → user with every grant, speaking from its channel + thread", () => {
    const a = resolveActor(
      { surface: "slack", subjectId: "UADMIN", channelId: "slack:C1", threadKey: "slack:C1:1.0" },
      lookup,
    );
    expect(a).toEqual({
      kind: "user",
      id: "slack:UADMIN",
      grants: ALL_GRANTS,
      origin: { channelId: "slack:C1", threadKey: "slack:C1:1.0" },
    });
  });

  it("Slack plain user → user holding exactly the chat baseline: the `open` commands (never `config:write`), no channel, no repo", () => {
    const a = resolveActor(
      { surface: "slack", subjectId: "UNOBODY", channelId: "slack:C1", threadKey: "slack:C1:1.0" },
      lookup,
    );
    expect(a.kind).toBe("user");
    expect(a.id).toBe("slack:UNOBODY");
    expect(a.grants).toEqual(grants({ actions: set(...CHAT_OPEN_ACTIONS) }));
  });

  it("Slack plain user when an agent is unrestricted → agent:run:<name> for it on top of the baseline (canRunAgent today)", () => {
    const onlyCoding = parseRestrictConfig({ agents: ["coding"] }, ["general", "coding"]);
    if (!onlyCoding.ok) throw new Error(onlyCoding.errors.join("; "));
    const open = (id: string) => grantsFor(id, { ...source, restrict: onlyCoding.restrict });
    expect(resolveActor({ surface: "slack", subjectId: "UNOBODY" }, open).grants).toEqual(
      grants({ actions: set(...CHAT_OPEN_ACTIONS, "agent:run:general") }),
    );
  });

  it("Slack user granted repo:write → repo:write + friction:write on top of the baseline", () => {
    const a = resolveActor({ surface: "slack", subjectId: "UMGR" }, lookup);
    expect(a.grants).toEqual(grants({ actions: set(...CHAT_OPEN_ACTIONS, "repo:write", "friction:write") }));
    expect(a.origin).toBeUndefined();
  });

  it("ingress token WITH channel → service `http:<subject>` pinned to http:<channel>", () => {
    const a = resolveActor(
      { surface: "http", subjectId: "alice", channelId: "http:ops", threadKey: "http:ops:default" },
      lookup,
    );
    expect(a).toEqual({
      kind: "service",
      id: "http:alice",
      grants: grants({ actions: set("dispatch", "runs:read"), channels: set("http:ops") }),
      origin: { channelId: "http:ops", threadKey: "http:ops:default" },
    });
  });

  it("ingress token whose entry names no channel → service with NO channel (nothing until config names its channels)", () => {
    const a = resolveActor({ surface: "http", subjectId: "ci" }, lookup);
    expect(a).toEqual({ kind: "service", id: "http:ci", grants: grants({ actions: set("dispatch") }) });
  });

  it("MCP token with pin → service `mcp:<subject>` pinned to mcp:<channel>", () => {
    const a = resolveActor({ surface: "mcp", subjectId: "alice" }, lookup);
    expect(a).toEqual({
      kind: "service",
      id: "mcp:alice",
      grants: grants({ actions: set("dispatch", "runs:read"), channels: set("mcp:ops") }),
    });
  });

  it("Access browser sub → user; granted every group's read + write everywhere → holds them; unlisted → every group's read, no channel", () => {
    expect(resolveActor({ surface: "access-browser", subjectId: "op-1" }, lookup)).toEqual({
      kind: "user",
      id: "access:op-1",
      grants: grants({ actions: set("runs:read", "runs:write", "friction:read", "friction:write"), channels: "all" }),
    });
    expect(resolveActor({ surface: "access-browser", subjectId: "viewer" }, lookup)).toEqual({
      kind: "user",
      id: "access:viewer",
      grants: grants({ actions: set("runs:read", "friction:read") }),
    });
  });

  it("Access service token cn → service `access:svc:<cn>` with exactly its entry; unlisted cn → no grants", () => {
    expect(resolveActor({ surface: "access-service", subjectId: "reader-bot" }, lookup)).toEqual({
      kind: "service",
      id: "access:svc:reader-bot",
      grants: grants({ actions: set("runs:read"), channels: "all" }),
    });
    expect(resolveActor({ surface: "access-service", subjectId: "stranger" }, lookup).grants).toBe(NO_GRANTS);
  });

  it("cli → user `cli:local` with every grant, whatever config says", () => {
    const a = resolveActor({ surface: "cli", subjectId: "local" }, () => NO_GRANTS);
    expect(a).toEqual({ kind: "user", id: "cli:local", grants: ALL_GRANTS });
    expect(CLI_ACTOR).toEqual(a);
  });

  it("schedule → kind schedule, `schedule:<name>`, grants from the native block", () => {
    const a = resolveActor({ surface: "schedule", subjectId: "self-improvement" }, lookup);
    expect(a).toEqual({
      kind: "schedule",
      id: "schedule:self-improvement",
      grants: grants({ actions: set("friction:write"), channels: "all" }),
    });
    expect(resolveActor({ surface: "schedule", subjectId: "unknown-job" }, lookup).grants).toBe(NO_GRANTS);
  });

  it("origin needs both channel and thread; it is context, never authority", () => {
    expect(
      resolveActor({ surface: "slack", subjectId: "UALICE", channelId: "slack:C1" }, lookup).origin,
    ).toBeUndefined();
    const a = resolveActor(
      { surface: "slack", subjectId: "UNOBODY", channelId: "slack:CADMIN", threadKey: "slack:CADMIN:1" },
      lookup,
    );
    expect(a.grants).toEqual(resolveActor({ surface: "slack", subjectId: "UNOBODY" }, lookup).grants);
    expect(a.grants.channels).toEqual(set());
  });
});

describe("resolveChatActor — a chat message's namespaced user id chooses the surface", () => {
  const msg = (userId: string, channelId = "slack:C1") => ({ userId, channelId, threadKey: `${channelId}:1.0` });

  it("slack:/http:/mcp:/cli: prefixes resolve like their adapters would", () => {
    expect(resolveChatActor(msg("slack:UADMIN"), lookup)).toEqual({
      kind: "user",
      id: "slack:UADMIN",
      grants: ALL_GRANTS,
      origin: { channelId: "slack:C1", threadKey: "slack:C1:1.0" },
    });
    expect(resolveChatActor(msg("http:alice", "http:ops"), lookup)).toMatchObject({
      kind: "service",
      id: "http:alice",
      grants: { channels: set("http:ops") },
    });
    expect(resolveChatActor(msg("mcp:alice", "mcp:ops"), lookup)).toMatchObject({ kind: "service", id: "mcp:alice" });
    expect(resolveChatActor(msg("cli:local", "cli:local"), lookup)).toMatchObject({
      kind: "user",
      id: "cli:local",
      grants: ALL_GRANTS,
    });
    // A schedule firing that reaches chat as `schedule:<name>` is the `schedule` kind, grants by that id.
    expect(resolveChatActor(msg("schedule:self-improvement", "http:cron"), lookup)).toMatchObject({
      kind: "schedule",
      id: "schedule:self-improvement",
      grants: { channels: "all" },
    });
  });

  it("an unknown namespace stays a user with the id as given and whatever grants config names for it — never a crash, never widened", () => {
    expect(resolveChatActor(msg("discord:123", "discord:general"), lookup)).toEqual({
      kind: "user",
      id: "discord:123",
      grants: NO_GRANTS,
      origin: { channelId: "discord:general", threadKey: "discord:general:1.0" },
    });
    expect(resolveChatActor(msg("nocolon"), lookup)).toMatchObject({ kind: "user", id: "nocolon", grants: NO_GRANTS });
  });
});
