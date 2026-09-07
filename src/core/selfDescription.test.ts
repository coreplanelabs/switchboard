import { describe, expect, it } from "vitest";
import { AGENTS } from "../agents/registry.js";
import { buildCoreCommands } from "./commandCatalogue.js";
import { RunRegistry } from "./runRegistry.js";
import {
  RESIDENT_CAP_NOTE,
  SELF_DESCRIPTION_HEADER,
  SWITCHBOARD_REPO,
  selfDescriptionBlock,
} from "./selfDescription.js";

// Feature: features/routing-and-config.md behavior 11 — the self-description
// block every agent carries. Pinned against the live registries so the block
// can never name an agent or a chat command that does not exist.

describe("selfDescriptionBlock", () => {
  const block = selfDescriptionBlock(AGENTS);

  it("leads with the header and names every registered agent with its description", () => {
    expect(block.startsWith(SELF_DESCRIPTION_HEADER)).toBe(true);
    for (const a of Object.values(AGENTS)) {
      expect(block).toContain(`\`${a.name}\` — ${a.description}`);
    }
  });

  it("every `<group> <verb>` chat command it names is a registered, chat-exposed command", () => {
    const commands = buildCoreCommands(
      () => {
        throw new Error("config never read by list()");
      },
      null,
      { registry: new RunRegistry(), env: {}, dataDir: ".", warn: () => {} },
    );
    const ids = new Set(
      commands
        .list()
        .filter((c) => c.surfaces?.chat !== false)
        .map((c) => c.id),
    );
    const named = [...block.matchAll(/`(repo|memory|config|runs) ([a-z]+)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(named.length).toBeGreaterThan(4);
    for (const id of named) expect(ids.has(id), id).toBe(true);
    expect(block).toContain("`help`");
  });

  it("states the resident mechanism, the cap, that onboarded = warm (no priority list), and where the source + specs live", () => {
    expect(block).toContain("always-warm per-repo environment");
    expect(block).toContain(RESIDENT_CAP_NOTE);
    expect(block).toContain('no separate "priority repos" setting: onboarded = warm');
    expect(block).toContain(SWITCHBOARD_REPO);
    expect(block).toContain("features/resident-repos.md");
    expect(block).toContain("github_file");
    expect(block).toMatch(/Never describe yourself as stateless/);
  });

  it("names the resident cap the resident Worker compiles in", async () => {
    const { readFileSync } = await import("node:fs");
    const worker = readFileSync(new URL("../../deploy/cloudflare-resident/worker.ts", import.meta.url), "utf8");
    const cap = /const RESIDENT_CAP = (\d+);/.exec(worker)?.[1];
    expect(cap).toBeDefined();
    expect(RESIDENT_CAP_NOTE).toContain(`capped at ${cap} residents`);
  });

  it("is a few lines, not a manual", () => {
    expect(block.split("\n")).toHaveLength(5);
    expect(block.length).toBeLessThan(3200);
  });
});
