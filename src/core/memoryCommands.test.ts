import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../config.js";
import { InMemoryMemoryStore } from "./memory/stores.js";
import type { MemoryRecord } from "./memory/types.js";
import { handleMemoryCommand, parseMemoryCommand } from "./memoryCommands.js";

// Feature: features/memory.md §24 (#278) — `memory list` / `memory forget <id>`
// chat commands: deterministic (no model turn), channel-agnostic, and scope-
// gated: a user manages their OWN scope freely, the org scope is admin-gated
// (fail-closed like repo management), and another user's scope is unreachable.

const YAML = `
providers:
  anthropic: { type: anthropic, apiKeyEnv: X }
defaults:
  agent: general
  models: { general: anthropic/general-model }
permissions:
  admins: [slack:UADMIN]
memory:
  enabled: true
`;
const YAML_OFF = YAML.replace("enabled: true", "enabled: false");

const NOW = 1_700_000_000_000;
function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "mem:org:coreplanelabs:0",
    scopeKey: "org:coreplanelabs",
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy"],
    sourceThreadKey: "slack:C1:1.0",
    createdAt: NOW,
    useCount: 0,
    status: "active",
    ...over,
  };
}
// Built fresh per store: `forget` mutates records in place, so sharing them
// across tests would leak one test's forget into the next.
const ORG = () => rec({});
const MINE = () => rec({ id: "mem:user:slack:U1:0", scopeKey: "user:slack:U1", text: "this user likes TL;DR lines", kind: "fact" });
const THEIRS = () => rec({ id: "mem:user:slack:U2:0", scopeKey: "user:slack:U2", text: "that user likes bullet points" });

const msg = (text: string, userId = "slack:U1") => ({ channelId: "slack:C1", userId, threadKey: "slack:C1:1.0", text });
function config(yaml = YAML): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "memcmd-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
}
const seeded = () => new InMemoryMemoryStore([ORG(), MINE(), THEIRS()], { now: () => NOW });

describe("parseMemoryCommand", () => {
  it("parses list with an optional scope word and forget with an id; anything else is not a command", () => {
    expect(parseMemoryCommand("memory list")).toEqual({ verb: "list", scope: "all" });
    expect(parseMemoryCommand("Memory list me")).toEqual({ verb: "list", scope: "me" });
    expect(parseMemoryCommand("memory list org")).toEqual({ verb: "list", scope: "org" });
    expect(parseMemoryCommand("memory forget mem:org:coreplanelabs:3")).toEqual({ verb: "forget", id: "mem:org:coreplanelabs:3" });
    expect(parseMemoryCommand("what does memory list do?")).toBeNull();
    expect(parseMemoryCommand("remember this for me")).toBeNull();
  });

  it("reports usage errors instead of guessing", () => {
    expect(parseMemoryCommand("memory forget")).toEqual({ error: expect.stringContaining("memory forget <id>") });
    expect(parseMemoryCommand("memory list everything")).toEqual({ error: expect.stringContaining("me") });
    expect(parseMemoryCommand("memory purge")).toEqual({ error: expect.stringContaining("memory list") });
  });
});

describe("handleMemoryCommand", () => {
  it("returns null for non-commands (prose passes through to the model)", async () => {
    expect(await handleMemoryCommand(config(), msg("tell me about memory"), seeded())).toBeNull();
  });

  it("memory disabled → says so, touches no store", async () => {
    const reply = await handleMemoryCommand(config(YAML_OFF), msg("memory list"), seeded());
    expect(reply).toMatch(/memory is (off|disabled)/i);
  });

  it("`memory list` shows the caller's own scope and the org scope with ids — never another user's", async () => {
    const reply = (await handleMemoryCommand(config(), msg("memory list"), seeded()))!;
    expect(reply).toContain("user:slack:U1");
    expect(reply).toContain("mem:user:slack:U1:0");
    expect(reply).toContain("this user likes TL;DR lines");
    expect(reply).toContain("org:coreplanelabs");
    expect(reply).toContain("mem:org:coreplanelabs:0");
    expect(reply).not.toContain("slack:U2");
    expect(reply).not.toContain("bullet points");
  });

  it("`memory list me` / `memory list org` narrow to one scope; an empty scope says so", async () => {
    const me = (await handleMemoryCommand(config(), msg("memory list me"), seeded()))!;
    expect(me).toContain("mem:user:slack:U1:0");
    expect(me).not.toContain("mem:org:coreplanelabs:0");
    const org = (await handleMemoryCommand(config(), msg("memory list org"), seeded()))!;
    expect(org).toContain("mem:org:coreplanelabs:0");
    expect(org).not.toContain("mem:user:slack:U1:0");
    const empty = (await handleMemoryCommand(config(), msg("memory list me", "slack:U9"), seeded()))!;
    expect(empty).toMatch(/no active records/i);
  });

  it("an identity-less request (no userId) gets an explicit 'no personal scope' line instead of an empty reply", async () => {
    const reply = (await handleMemoryCommand(config(), msg("memory list me", ""), seeded()))!;
    expect(reply).toMatch(/no user identity/i);
    expect(reply).not.toContain("mem:");
  });

  it("a user can forget a record in their OWN scope", async () => {
    const store = seeded();
    const reply = (await handleMemoryCommand(config(), msg("memory forget mem:user:slack:U1:0"), store))!;
    expect(reply).toMatch(/forgot/i);
    expect(reply).toContain("mem:user:slack:U1:0");
    expect(await store.list("user:slack:U1", 10)).toEqual([]);
  });

  it("forgetting an ORG record is admin-gated (fail-closed): refused with a reason for a plain user, allowed for an admin", async () => {
    const store = seeded();
    const refused = (await handleMemoryCommand(config(), msg("memory forget mem:org:coreplanelabs:0"), store))!;
    expect(refused).toMatch(/restricted|🚫/);
    expect(await store.list("org:coreplanelabs", 10)).toHaveLength(1);
    const ok = (await handleMemoryCommand(config(), msg("memory forget mem:org:coreplanelabs:0", "slack:UADMIN"), store))!;
    expect(ok).toMatch(/forgot/i);
    expect(await store.list("org:coreplanelabs", 10)).toEqual([]);
  });

  it("another user's scope is unreachable — even for an admin", async () => {
    const store = seeded();
    for (const user of ["slack:U1", "slack:UADMIN"]) {
      const reply = (await handleMemoryCommand(config(), msg("memory forget mem:user:slack:U2:0", user), store))!;
      expect(reply).toMatch(/only your own|another user/i);
    }
    expect(await store.list("user:slack:U2", 10)).toHaveLength(1);
  });

  it("an id that is not a memory id, or that names nothing active, is reported — nothing is changed", async () => {
    const store = seeded();
    expect(await handleMemoryCommand(config(), msg("memory forget not-a-memory-id"), store)).toMatch(/mem:<scope>:<n>/);
    expect(await handleMemoryCommand(config(), msg("memory forget mem:user:slack:U1:42"), store)).toMatch(/nothing (to forget|forgotten)|no active record/i);
    expect(await store.list("user:slack:U1", 10)).toHaveLength(1);
  });

  it("a store failure surfaces as a ⚠️ reply, never a throw", async () => {
    const broken = seeded();
    broken.list = async () => {
      throw new Error("worker down");
    };
    expect(await handleMemoryCommand(config(), msg("memory list"), broken)).toMatch(/⚠️.*worker down/);
  });
});
