import { describe, expect, it } from "vitest";
import type { RunEvent } from "./runEvents.js";
import { analyzeRunFriction } from "./runFriction.js";

// docs/reference/specs/run-visibility.md item 1 — an `artifact` event is a side
// fact about a file that moved through the store, published beside the tool
// pair (or the dispatcher's staging) that moved it; the analyzer must not count
// it as a step, a tool call, or a turn boundary.
describe("analyzeRunFriction — artifact is invisible to friction", () => {
  const T0 = 1_700_000_000_000;
  const base: RunEvent[] = [
    { type: "input", text: "screenshot the dashboard", at: T0 },
    { type: "tool_call", tool: "attach_file", summary: "attach_file dashboard.png", callId: "c1", at: T0 + 1000 },
    {
      type: "tool_result",
      tool: "attach_file",
      ok: true,
      summary: "attached dashboard.png",
      callId: "c1",
      at: T0 + 1100,
    },
    { type: "answer", text: "done", at: T0 + 5000 },
  ];
  const withArtifacts: RunEvent[] = [
    {
      type: "artifact",
      direction: "in",
      key: "threads/slack-C1-1.0/in/1.0/0-brief.pdf",
      name: "brief.pdf",
      size: 12_000,
      contentType: "application/pdf",
      at: T0, // staged before the turn, stamped with the receipt
    },
    ...base.slice(0, 2),
    {
      type: "artifact",
      direction: "out",
      key: "runs/r1/out/1-dashboard.png",
      name: "dashboard.png",
      size: 3_145_728,
      contentType: "image/png",
      at: T0 + 1050,
    },
    ...base.slice(2),
  ];

  it("the diagnosis is identical with or without the artifact events", () => {
    const a = analyzeRunFriction(base, { finished: true });
    const b = analyzeRunFriction(withArtifacts, { finished: true });
    expect(b.eventCount).toBe(a.eventCount);
    expect(b.toolCalls).toBe(a.toolCalls);
    expect(b.findings).toEqual(a.findings);
    expect(b.runMs).toBe(a.runMs);
  });
});
