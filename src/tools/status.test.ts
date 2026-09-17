import { describe, expect, it } from "vitest";
import { updateStatusTool } from "./status.js";
import type { ToolContext } from "./runnableTool.js";

// docs/reference/specs/run-visibility.md item 2: the checklist is truthful at
// every moment — an item is ✱ while its command runs and ✓ only once its result
// has been read. The tool carries the rule in its description and repeats it in
// every result, so the model meets it on each call, whatever preset it runs on.
describe("update_status", () => {
  it("its description states the ordering — ✱ when the item's command is issued, ✓ only after its result is read, never in the same turn as the command", () => {
    const d = updateStatusTool.description;
    expect(d).toContain("✱");
    expect(d).toContain("✓");
    expect(d).toMatch(/only after (you have )?read (its|the) result/i);
    expect(d).toMatch(/never in the same turn/i);
    expect(d).toMatch(/never raw commands/);
  });

  it("reports the checklist to the card and answers with the rule, so every call re-reads it", async () => {
    const seen: string[] = [];
    const ctx = { reportProgress: (s: string) => void seen.push(s) } as unknown as ToolContext;
    const out = await updateStatusTool.run({ checklist: "✱ Clone\n○ Install" }, ctx);
    expect(seen).toEqual(["✱ Clone\n○ Install"]);
    expect(out).toMatch(/^status updated/);
    expect(out).toMatch(/✓ only for items whose result you have already read/);
    expect(out).toMatch(/✱/);
  });

  it("an empty or missing checklist still answers and reports an empty string (the dispatcher ignores it)", async () => {
    const seen: string[] = [];
    const ctx = { reportProgress: (s: string) => void seen.push(s) } as unknown as ToolContext;
    await updateStatusTool.run({}, ctx);
    expect(seen).toEqual([""]);
  });
});
