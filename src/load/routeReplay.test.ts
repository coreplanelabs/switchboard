import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import type { RunEvent } from "../core/runEvents.js";
import {
  confusionTable,
  labelledRequests,
  NO_ROUTE,
  renderConfusion,
  replayRoutes,
  type ReplayRequest,
} from "./routeReplay.js";

// `load:route` (docs/reference/specs/load-harness.md item 17): the router
// scored against the presets people typed — the label hidden from the text,
// the table's arithmetic, the misroutes listed.

const record = (
  id: string,
  agent: string | undefined,
  text: string | undefined,
  over: Partial<RunRecord> & { agentSource?: "directive" | "sticky" | "default" | "route"; routed?: boolean } = {},
): RunRecord => {
  const { agentSource, routed, ...rest } = over;
  const events: RunEvent[] = [];
  if (text !== undefined) events.push({ type: "input", text });
  if (agent !== undefined) events.push({ type: "run_meta", agent, ...(agentSource ? { agentSource } : {}) });
  if (routed) events.push({ type: "route", preset: agent ?? "?", reason: "r", model: "m" });
  return {
    id,
    ...(agent !== undefined ? { agent } : {}),
    channelId: "slack:CX",
    userId: "slack:UX",
    threadKey: `slack:CX:${id}`,
    channelVisibility: "unknown",
    startedAt: 1,
    finishedAt: 2,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events, { finished: true, truncated: false }),
    ...rest,
  };
};

describe("labelledRequests — which finished runs are labelled examples, and the label hidden from the text", () => {
  it("a directive or sticky stamp labels the run with the preset it ran on; the text loses every directive token", () => {
    const { requests, skipped } = labelledRequests(
      [
        record("a", "coding", "agent:coding fix the bug model:x/y", { agentSource: "directive" }),
        record("b", "review", "look at this again", { agentSource: "sticky" }),
      ],
      { defaultPreset: "general" },
    );
    expect(requests).toEqual([
      { id: "a", label: "coding", text: "fix the bug", labelSource: "directive" },
      { id: "b", label: "review", text: "look at this again", labelSource: "sticky" },
    ]);
    expect(Object.values(skipped).every((n) => n === 0)).toBe(true);
  });

  it("a record without the stamp is labelled by the heuristic — a preset other than the default was a typed choice; the default is unlabelled", () => {
    const { requests, skipped } = labelledRequests(
      [record("a", "research", "what is the latest on X"), record("b", "general", "hello")],
      { defaultPreset: "general" },
    );
    expect(requests).toEqual([
      { id: "a", label: "research", text: "what is the latest on X", labelSource: "heuristic" },
    ]);
    expect(skipped["legacy-default"]).toBe(1);
  });

  it("never a label: a routed run, a spawned child, a coordinator's child, a schedule's run, a default or scope choice, an unknown preset, an empty text", () => {
    const { requests, skipped } = labelledRequests(
      [
        record("routed", "review", "x", { agentSource: "route", routed: true }),
        record("child", "coding", "x", { agentSource: "directive", parentRunId: "p" }),
        record("unit", "coding", "x", { agentSource: "directive", parentInstanceId: "i", idempotencyKey: "i:1" }),
        record("cron", "research", "x", { agentSource: "directive", userId: "schedule:daily" }),
        record("dflt", "general", "x", { agentSource: "default" }),
        record("unknown", "nonesuch", "x", { agentSource: "directive" }),
        record("noagent", undefined, "x"),
        record("empty", "coding", "agent:coding", { agentSource: "directive" }),
        record("notext", "coding", undefined, { agentSource: "directive" }),
      ],
      { defaultPreset: "general" },
    );
    expect(requests).toEqual([]);
    expect(skipped).toEqual({
      routed: 1,
      child: 2,
      schedule: 1,
      "not-the-requesters-choice": 1,
      "unknown-preset": 2,
      "no-text": 2,
      "legacy-default": 0,
    });
  });
});

describe("replayRoutes — the router asked about each request, in order", () => {
  const requests: ReplayRequest[] = [
    { id: "1", label: "coding", text: "fix it", labelSource: "directive" },
    { id: "2", label: "review", text: "review it", labelSource: "directive" },
    { id: "3", label: "research", text: "what is X", labelSource: "heuristic" },
  ];

  it("marks each answer correct or not, keeps the order, and times the decision", async () => {
    let t = 0;
    const results = await replayRoutes(
      requests,
      async (text) =>
        text === "fix it" ? { preset: "coding", reason: "a change" } : { preset: "general", reason: "q" },
      { concurrency: 1, now: () => (t += 5) },
    );
    expect(results.map((r) => [r.id, r.routed, r.correct])).toEqual([
      ["1", "coding", true],
      ["2", "general", false],
      ["3", "general", false],
    ]);
    expect(results.every((r) => r.ms === 5)).toBe(true);
  });

  it("no route is an answer too: undefined, never correct", async () => {
    const [r] = await replayRoutes([requests[0]], async () => ({ preset: undefined, reason: "router failed: x" }), {
      now: () => 0,
    });
    expect(r.routed).toBeUndefined();
    expect(r.correct).toBe(false);
    expect(r.reason).toBe("router failed: x");
  });

  it("no requests → no results and no call", async () => {
    let calls = 0;
    expect(
      await replayRoutes(
        [],
        async () => {
          calls++;
          return { preset: "general", reason: "" };
        },
        { now: () => 0 },
      ),
    ).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("confusionTable + renderConfusion — the arithmetic and the misroutes", () => {
  const results = [
    {
      id: "1",
      label: "coding",
      text: "fix it",
      labelSource: "directive" as const,
      routed: "coding",
      reason: "a",
      correct: true,
      ms: 1,
    },
    {
      id: "2",
      label: "coding",
      text: "add tests",
      labelSource: "directive" as const,
      routed: "explore",
      reason: "b",
      correct: false,
      ms: 1,
    },
    {
      id: "3",
      label: "review",
      text: "review it",
      labelSource: "sticky" as const,
      routed: "review",
      reason: "c",
      correct: true,
      ms: 1,
    },
    {
      id: "4",
      label: "review",
      text: "look",
      labelSource: "sticky" as const,
      routed: undefined,
      reason: "router failed: down",
      correct: false,
      ms: 1,
    },
    {
      id: "5",
      label: "research",
      text: "what is X",
      labelSource: "heuristic" as const,
      routed: "research",
      reason: "d",
      correct: true,
      ms: 1,
    },
  ];

  it("one row per preset in table order, per-label and overall accuracy, no-route counted as (none), misroutes in order", () => {
    const table = confusionTable(results, ["general", "coding", "review", "research"]);
    expect(table.rows.map((r) => r.label)).toEqual(["general", "coding", "review", "research"]);
    expect(table.rows[0]).toEqual({ label: "general", n: 0, correct: 0, accuracy: NaN, routedAs: {} });
    expect(table.rows[1]).toEqual({
      label: "coding",
      n: 2,
      correct: 1,
      accuracy: 0.5,
      routedAs: { coding: 1, explore: 1 },
    });
    expect(table.rows[2].routedAs).toEqual({ review: 1, [NO_ROUTE]: 1 });
    expect(table.total).toBe(5);
    expect(table.correct).toBe(3);
    expect(table.accuracy).toBe(0.6);
    expect(table.misroutes.map((m) => m.id)).toEqual(["2", "4"]);
  });

  it("a label outside the preset list still gets a row, after the listed ones", () => {
    const table = confusionTable(results, ["coding"]);
    expect(table.rows.map((r) => r.label)).toEqual(["coding", "review", "research"]);
  });

  it("renders the accuracy line, the table and each misroute with run id, label, routed, reason and the text", () => {
    const lines = renderConfusion(confusionTable(results, ["coding", "review", "research"]));
    expect(lines[0]).toBe("accuracy: 3/5 (60%)");
    expect(lines).toContain("| coding | 2 | 1 | 50% | coding=1 explore=1 |");
    expect(lines).toContain("misroutes (2):");
    expect(lines).toContain('- 2: label coding, routed explore — b — "add tests"');
    expect(lines).toContain(`- 4: label review, routed ${NO_ROUTE} — router failed: down — "look"`);
    expect(renderConfusion(confusionTable([], ["coding"]))[0]).toBe("accuracy: 0/0 (—)");
    expect(renderConfusion(confusionTable([], ["coding"]))).toContain("misroutes: none");
  });
});
