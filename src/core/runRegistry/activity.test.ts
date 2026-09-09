import { describe, expect, it } from "vitest";
import { RunRegistry } from "../runRegistry.js";

// Feature: docs/reference/specs/live-view.md item 20 — the one-line activity a
// run's summary carries, proven through the registry that refreshes it on
// every published event.

describe("RunRegistry — `activity` on the summary (live-view item 20)", () => {
  it("is the latest narration line / tool-call summary / the answer's first line, one line, capped; absent before the first such event", () => {
    const reg = new RunRegistry({ genId: () => "a1", genToken: () => "t" });
    const { id } = reg.create("x");
    expect("activity" in reg.listActive()[0]).toBe(false);
    reg.publish(id, { type: "input", text: "hello" }); // not an activity
    expect("activity" in reg.listActive()[0]).toBe(false);
    reg.publish(id, { type: "assistant", text: "Checking the\n  remaining   touchpoints." });
    expect(reg.listActive()[0].activity).toBe("Checking the remaining touchpoints.");
    reg.publish(id, { type: "tool_call", tool: "bash", summary: "$ npm test" });
    expect(reg.listActive()[0].activity).toBe("$ npm test");
    reg.publish(id, { type: "tool_result", tool: "bash", ok: true, summary: "exit 0" }); // results do not change it
    expect(reg.listActive()[0].activity).toBe("$ npm test");
    reg.publish(id, { type: "assistant", text: "x".repeat(300) });
    expect(reg.listActive()[0].activity).toHaveLength(120);
    expect(reg.listActive()[0].activity!.endsWith("…")).toBe(true);
    reg.publish(id, { type: "answer", text: "⚠️ resident not onboarded: acme/web\nsecond line" });
    expect(reg.listActive()[0].activity).toBe("⚠️ resident not onboarded: acme/web second line"); // a failed inline run's reply IS the failure
  });
});
