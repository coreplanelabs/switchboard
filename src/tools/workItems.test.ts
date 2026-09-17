import { describe, expect, it, vi } from "vitest";
import { TOOLSETS } from "./toolsets.js";
import { WORK_ITEM_READ_TOOLS, WORK_ITEM_WRITE_TOOLS } from "./workItems.js";
import type { ToolContext } from "./runnableTool.js";

describe("work-item tools", () => {
  it("keeps writes out of read-only presets and ignores model-supplied identity and assignment fields", async () => {
    for (const preset of ["readonly", "web", "explore", "conductor"])
      expect(TOOLSETS[preset]!.some((tool) => WORK_ITEM_WRITE_TOOLS.includes(tool))).toBe(false);
    for (const preset of ["full", "assistant"])
      expect(WORK_ITEM_WRITE_TOOLS.every((tool) => TOOLSETS[preset]!.includes(tool))).toBe(true);
    const request = vi.fn(async () => ({ url: "https://tracker.example/issue" }));
    const ctx = { workItems: { request } } as unknown as ToolContext;
    const update = WORK_ITEM_WRITE_TOOLS.find((t) => t.name === "work_item_update")!;
    await update.run({ id: "ENG-1", title: "Fix", actor: "admin", assigneeId: "bot", delegateId: "other" }, ctx);
    expect(request).toHaveBeenCalledWith({
      op: "update",
      id: "ENG-1",
      title: "Fix",
      description: undefined,
      priority: undefined,
      state: undefined,
    });
  });
  it("reports an unavailable capability or a refused write as failure", async () => {
    expect(await WORK_ITEM_READ_TOOLS[0]!.run({ id: "ENG-1" }, {} as ToolContext)).toMatch(/^error:/);
    const ctx = {
      workItems: {
        request: async () => {
          throw new Error("request denied");
        },
      },
    } as unknown as ToolContext;
    expect(await WORK_ITEM_WRITE_TOOLS[0]!.run({ id: "ENG-1", title: "Fix" }, ctx)).toBe("error: request denied");
  });
});
