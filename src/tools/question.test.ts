import { describe, expect, it, vi } from "vitest";
import { requestInputTool } from "./question.js";
import type { ToolContext } from "./runnableTool.js";

describe("request_input", () => {
  it("records a bounded question and reports unavailable or invalid requests honestly", async () => {
    const onQuestion = vi.fn();
    const ctx = { onQuestion } as unknown as ToolContext;
    for (const question of [undefined, "   ", 4, "x".repeat(4001)]) {
      expect(await requestInputTool.run({ question }, ctx)).toMatch(/^error:/);
    }
    expect(onQuestion).not.toHaveBeenCalled();
    expect(await requestInputTool.run({ question: "Which repository?" }, {} as ToolContext)).toMatch(/^error:/);
    expect(await requestInputTool.run({ question: " Which repository? " }, ctx)).toContain("End your turn");
    expect(onQuestion).toHaveBeenCalledWith("Which repository?");
  });
});
