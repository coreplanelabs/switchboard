import { describe, expect, it } from "vitest";
import { GITHUB_READ_TOOLS } from "./github.js";
import type { RunnableTool } from "./runnableTool.js";
import { filterUnavailableTools, mergeTools, toolsForRun, TOOLSETS } from "./toolsets.js";

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

describe("filterUnavailableTools — run-bound private tools", () => {
  it("omits an unavailable tool from the model-visible list without changing other tools", () => {
    const tools = [named("plane_show"), named("work_progress"), named("recall")];
    expect(filterUnavailableTools(tools, ["work_progress"]).map((tool) => tool.name)).toEqual(["plane_show", "recall"]);
    expect(filterUnavailableTools(tools, [])).toBe(tools);
  });
});

describe("the toolset table", () => {
  // The main agent gets bounded reads and requester-bound linked-work tools;
  // it has no shell, public status, generic spawn or merge tool.
  it("orchestrator: source reads and private linked-work controls", () => {
    expect(TOOLSETS.orchestrator!.map((t) => t.name)).toEqual([
      "plane_show",
      "thread_work",
      "slack_context",
      "work_status",
      "work_steer",
      "work_stop",
      "work_start",
      "work_progress",
      ...GITHUB_READ_TOOLS.map((t) => t.name),
      "recall",
      "notes",
    ]);
    expect(GITHUB_READ_TOOLS.every((t) => t.sideEffectFree === true)).toBe(true);
  });

  it("a shared conversation's model tool list omits linked-work calls while a private one retains them", () => {
    expect(toolsForRun("orchestrator", false, false).map((tool) => tool.name)).toEqual([
      "plane_show",
      "thread_work",
      "slack_context",
      "work_progress",
      ...GITHUB_READ_TOOLS.map((t) => t.name),
      "recall",
      "notes",
    ]);
    expect(toolsForRun("orchestrator", true, false).map((tool) => tool.name)).toContain("work_stop");
    expect(toolsForRun("orchestrator", true, false).map((tool) => tool.name)).not.toContain("work_start");
    expect(toolsForRun("orchestrator", true, true).map((tool) => tool.name)).toContain("work_start");
    expect(toolsForRun("conductor", false, false)).toBe(TOOLSETS.conductor);
  });

  it("every preset's key indexes a toolset, and every tool has one name across the table", () => {
    for (const key of ["full", "readonly", "web", "assistant", "explore", "conductor", "orchestrator", "none"]) {
      const tools = TOOLSETS[key]!;
      expect(new Set(tools.map((t) => t.name)).size, key).toBe(tools.length);
    }
  });
});
