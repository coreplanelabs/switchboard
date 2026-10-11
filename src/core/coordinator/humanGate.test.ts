import { describe, expect, it } from "vitest";
import { assignHumanGate } from "./humanGate.js";
import { isHumanGatePending } from "./contract.js";
const gate = {
  pr: { number: 1, url: "https://example.test/pr/1" },
  round: 1,
  findings: [],
  verdict: "approve" as const,
  askedAt: 10,
};
describe("original human question assignment", () => {
  it("accepts explicit bounded primary actions and keeps legacy questions valid without inferring an action", () => {
    expect(isHumanGatePending(gate)).toBe(true);
    expect(
      isHumanGatePending({ ...gate, primaryAction: { label: "Merge", text: "Merge the reviewed pull request" } }),
    ).toBe(true);
    for (const action of [
      null,
      {},
      { label: "Merge" },
      { label: " ", text: "Merge" },
      { label: "Merge", text: "\n" },
      { label: "x".repeat(65), text: "Merge" },
      { label: "Merge", text: "x".repeat(4097) },
      { label: "Merge", text: "Merge", command: "pulls.merge" },
    ])
      expect(isHumanGatePending({ ...gate, primaryAction: action })).toBe(false);
  });

  it("assigns only a new question from the trusted owner and preserves known or unknown assignments on replay", () => {
    expect(assignHumanGate({ ...gate, assignedTo: "slack:forged" }, "access:alice")).toEqual({
      ...gate,
      assignedTo: "access:alice",
    });
    expect(
      assignHumanGate({ ...gate, assignedTo: "slack:forged" }, "access:alice", { ...gate, assignedTo: "slack:bob" }),
    ).toEqual({ ...gate, assignedTo: "slack:bob" });
    expect(assignHumanGate({ ...gate, assignedTo: "slack:forged" }, "access:alice", gate)).toEqual(gate);
    expect(
      assignHumanGate(
        { askedAt: gate.askedAt, verdict: gate.verdict, findings: gate.findings, round: gate.round, pr: gate.pr },
        "access:alice",
        gate,
      ),
    ).toEqual(gate);
    expect(assignHumanGate({ ...gate, round: 2, askedAt: 20 }, "access:alice", gate)).toEqual({
      ...gate,
      round: 2,
      askedAt: 20,
      assignedTo: "access:alice",
    });
    expect(isHumanGatePending({ ...gate, assignedTo: "access:alice" })).toBe(true);
    expect(isHumanGatePending({ ...gate, assignedTo: "unnamespaced" })).toBe(false);
  });
});
