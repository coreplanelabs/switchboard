import { describe, expect, it } from "vitest";
import { AGENTS } from "../agents/registry.js";
import { ALL_CAPABILITIES, NO_CAPABILITIES, type Capabilities } from "./capabilities.js";
import { buildCoreCommands } from "./commandCatalogue.js";
import { RunRegistry } from "./runRegistry.js";
import {
  RESIDENT_CAP_UNKNOWN_NOTE,
  residentCapNote,
  SELF_DESCRIPTION_HEADER,
  SWITCHBOARD_REPO,
  selfDescriptionBlock,
} from "./selfDescription.js";

// Feature: docs/reference/specs/routing-and-config.md behavior 11 — the self-description
// block every agent carries, a function of the process's capabilities. Pinned
// against the live registries so the block can never name an agent or a chat
// command that does not exist in the installation it describes.

const allOn = selfDescriptionBlock(AGENTS, "acme", ALL_CAPABILITIES, 6);
const allOff = selfDescriptionBlock(AGENTS, "acme", NO_CAPABILITIES, undefined);

/** The chat-exposed command ids of the catalogue a process with `caps` binds. */
function chatCommands(caps: Capabilities): Set<string> {
  const commands = buildCoreCommands(
    () => {
      throw new Error("config never read by list()");
    },
    null,
    { registry: new RunRegistry(), env: {}, dataDir: ".", warn: () => {}, capabilities: caps },
  );
  return new Set(
    commands
      .list()
      .filter((c) => c.surfaces?.chat !== false)
      .map((c) => c.id),
  );
}

const named = (block: string) =>
  [...block.matchAll(/`(repo|memory|config|runs) ([a-z]+)/g)].map((m) => `${m[1]}.${m[2]}`);

describe("selfDescriptionBlock", () => {
  it("leads with the header and names every registered agent with its description, whatever is on", () => {
    for (const block of [allOn, allOff]) {
      expect(block.startsWith(SELF_DESCRIPTION_HEADER)).toBe(true);
      // Whose gateway: the config's organization, never a name baked into the code.
      expect(block).toContain("the agent gateway of the acme organization");
      for (const a of Object.values(AGENTS)) expect(block).toContain(`\`${a.name}\` — ${a.description}`);
    }
    expect(selfDescriptionBlock(AGENTS, "other-org", ALL_CAPABILITIES, 6)).toContain(
      "the agent gateway of the other-org organization",
    );
  });

  it("every `<group> <verb>` chat command it names is a registered, chat-exposed command OF THAT INSTALLATION — with everything on it names the resident and memory commands, with nothing on only what still exists", () => {
    const onIds = chatCommands(ALL_CAPABILITIES);
    const onNamed = named(allOn);
    expect(onNamed.length).toBeGreaterThan(4);
    for (const id of onNamed) expect(onIds.has(id), id).toBe(true);
    expect(onNamed).toEqual(expect.arrayContaining(["repo.onboard", "repo.list", "memory.list", "memory.forget"]));
    const offIds = chatCommands(NO_CAPABILITIES);
    for (const id of named(allOff)) expect(offIds.has(id), id).toBe(true);
    expect(named(allOff)).toEqual([]);
    for (const block of [allOn, allOff]) expect(block).toContain("`help`");
  });

  it("with residents on: the mechanism, onboarded = warm (no priority list), and the cap the resident Worker reported — or where to read it when it has not answered yet", () => {
    expect(allOn).toContain("always-warm per-repo environment");
    expect(allOn).toContain("capped at 6 residents");
    expect(allOn).toContain('no separate "priority repos" setting: onboarded = warm');
    expect(selfDescriptionBlock(AGENTS, "acme", ALL_CAPABILITIES, 9)).toContain("capped at 9 residents");
    const unknown = selfDescriptionBlock(AGENTS, "acme", ALL_CAPABILITIES, undefined);
    expect(unknown).toContain(RESIDENT_CAP_UNKNOWN_NOTE);
    expect(unknown).not.toMatch(/capped at \d+/);
    expect(residentCapNote(4)).toBe("capped at 4 residents");
    expect(residentCapNote(undefined)).toBe(RESIDENT_CAP_UNKNOWN_NOTE);
  });

  it("with residents off: no resident paragraph — no onboarding, no cap, no warm fleet — and where a per-thread workspace lives follows the execution type", () => {
    expect(allOff).not.toContain("repo onboard");
    expect(allOff).not.toContain("always-warm per-repo environment");
    expect(allOff).not.toContain("capped");
    expect(allOff).toContain("no resident (always-warm) repo environments");
    expect(allOff).toContain("on the bot host");
    expect(selfDescriptionBlock(AGENTS, "acme", { ...NO_CAPABILITIES, execution: "e2b" }, undefined)).toContain(
      "in an E2B micro-VM",
    );
    expect(selfDescriptionBlock(AGENTS, "acme", { ...NO_CAPABILITIES, execution: "cloudflare" }, undefined)).toContain(
      "in a Cloudflare sandbox",
    );
  });

  it("run history, memory and the MCP surface appear only when on", () => {
    expect(allOn).toContain("kept as run history");
    expect(allOn).toContain("Cross-session memory is per org/repo/channel/user");
    expect(allOn).toContain("an MCP surface");
    expect(allOff).toContain("keeps no run history");
    expect(allOff).not.toContain("kept as run history");
    expect(allOff).toContain("no cross-session memory");
    expect(allOff).not.toContain("memory list");
    expect(allOff).not.toContain("MCP");
    const memoryOnly = selfDescriptionBlock(AGENTS, "acme", { ...NO_CAPABILITIES, memory: true }, undefined);
    expect(memoryOnly).toContain("`memory list`");
    expect(memoryOnly).toContain("keeps no run history");
  });

  it("always says where the source and specs live, and never lets the model call itself stateless", () => {
    for (const block of [allOn, allOff]) {
      expect(block).toContain(SWITCHBOARD_REPO);
      expect(block).toContain("docs/reference/specs/resident-repos.md");
      expect(block).toContain("github_file");
      expect(block).toMatch(/Never describe yourself as stateless/);
    }
  });

  it("is a few lines, not a manual, in every configuration", () => {
    for (const block of [allOn, allOff]) {
      expect(block.split("\n")).toHaveLength(5);
      expect(block.length).toBeLessThan(3200);
    }
  });
});
