import { describe, expect, it } from "vitest";
import type { RunnableTool } from "./runnableTool.js";
import { mergeTools, TOOLSETS, toolsForRun } from "./toolsets.js";

// Feature: docs/reference/specs/harness-pi.md item 7 and docs/reference/specs/mcp-tools.md
// item 12 — the toolset table is what the bot relays to a preset's pi, and a
// run's extra tools join it under one rule: a name may appear once.

const named = (name: string): RunnableTool => ({ name, description: "", inputSchema: {}, run: async () => "" });

describe("mergeTools — the static toolset plus a run's extra tools", () => {
  it("appends the extra tools after the static ones and hands the static list back untouched when there are none", () => {
    const base = [named("update_status"), named("web_fetch")];
    expect(mergeTools(base, undefined)).toBe(base);
    expect(mergeTools(base, [])).toBe(base);
    expect(mergeTools(base, [named("mcp__linear__search")]).map((t) => t.name)).toEqual([
      "update_status",
      "web_fetch",
      "mcp__linear__search",
    ]);
  });

  it("a name collision — an extra tool shadowing a built-in, or two extras with one name — throws before the first model turn, never a silent shadow", () => {
    expect(() => mergeTools([named("web_fetch")], [named("web_fetch")])).toThrow(
      'extra tool "web_fetch" collides with an existing tool name',
    );
    expect(() => mergeTools([], [named("mcp__a__x"), named("mcp__a__x")])).toThrow(/collides/);
  });
});

describe("the toolset table", () => {
  // The orchestrator has bounded Slack reads and linked-work controls in a
  // verified requester DM; it has no shell, generic spawn, or merge tool.
  it("orchestrator: linked work controls and bounded Slack reads beside plane and session tools", () => {
    expect(TOOLSETS.orchestrator!.map((t) => t.name)).toEqual([
      "update_status",
      "plane_show",
      "slack_context",
      "work_status",
      "work_steer",
      "work_stop",
      "recall",
      "notes",
    ]);
  });

  it("a shared conversation's model tool list omits linked-work calls while a private one retains them", () => {
    expect(toolsForRun("orchestrator", false).map((tool) => tool.name)).toEqual([
      "update_status",
      "plane_show",
      "slack_context",
      "recall",
      "notes",
    ]);
    expect(toolsForRun("orchestrator", true).map((tool) => tool.name)).toContain("work_stop");
    expect(toolsForRun("conductor", false)).toBe(TOOLSETS.conductor);
  });

  it("every preset's key indexes a toolset, and every tool has one name across the table", () => {
    for (const key of ["full", "readonly", "web", "assistant", "explore", "conductor", "orchestrator", "none"]) {
      const tools = TOOLSETS[key]!;
      expect(new Set(tools.map((t) => t.name)).size, key).toBe(tools.length);
    }
  });
});
