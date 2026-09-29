import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../execution/executor.js";
import { slackContextTool } from "./slackContext.js";
import type { ToolContext } from "./runnableTool.js";

describe("slack_context tool", () => {
  it("refuses a missing capability or invalid request before reading", async () => {
    const executor = {} as Executor;
    expect(await slackContextTool.run({ kind: "thread" }, { executor })).toContain("not available");
    const read = vi.fn(async () => "source");
    const ctx: ToolContext = { executor, slackContext: { read } };
    expect(await slackContextTool.run({ kind: "unknown" }, ctx)).toContain("kind must be");
    expect(await slackContextTool.run({ kind: "link", url: "http://example.test" }, ctx)).toContain("permalink");
    expect(await slackContextTool.run({ kind: "file", url: "https://example.test", fileId: "bad" }, ctx)).toContain(
      "file ID",
    );
    expect(read).not.toHaveBeenCalled();
    expect(await slackContextTool.run({ kind: "thread" }, ctx)).toBe("source");
    expect(read).toHaveBeenCalledWith({ kind: "thread" });
  });
});
