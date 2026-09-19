import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CommandRegistry, type CommandDef, type CommandInput } from "../core/commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../core/commands/all.js";
import { chatInvocation, mcpToolName } from "../core/commandSurface.js";
import type { CompletionRequest, Provider } from "../core/provider.js";
import { AGENTS } from "../agents/registry.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import type { RunEvent } from "../core/runEvents.js";
import {
  providerRouteModel,
  routableCommands,
  routablePresets,
  route,
  VERIFY_TOOL_NAME,
  type RouteDecision,
  type RouteModel,
  type RoutePrompt,
  type RouteToolCall,
} from "../core/dispatch/route.js";
import {
  ROUTE_COMMAND_DECOYS,
  ROUTE_COMMAND_EXAMPLES,
  ROUTE_COMMAND_FIXTURES,
  type RouteCommandExample,
} from "./routeCommandFixtures.js";
import { ROUTE_COMPOUND_FIXTURES, type RouteCompoundFixture } from "./routeCompoundFixtures.js";
import { ROUTE_IMPERATIVE_FIXTURES } from "./routeImperativeFixtures.js";
import { ROUTE_ATTACH_FIXTURES } from "./routeAttachFixtures.js";
import {
  compoundExamples,
  compoundScore,
  confusionTable,
  type RouteFacts,
  historyCompounds,
  imperativeScore,
  labelledRequests,
  mapHistoricalLabels,
  NO_ROUTE,
  readToWriteRoutes,
  renderCompound,
  renderConfusion,
  renderImperative,
  commandScore,
  emptyCounters,
  renderCommands,
  renderCounters,
  renderVerifier,
  replayCommands,
  replayCompound,
  replayImperative,
  replayRoutes,
  routeChecks,
  tableWritePreset,
  tallyingProvider,
  type CompoundExample,
  type ReplayRequest,
  type ReplayResult,
  typedLabels,
  verifierScore,
  verifyBind,
  verifyCommands,
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
  if (text !== undefined) events.push({ type: "input", messageId: "m1", text });
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

  it("a record without the stamp on a preset other than the default is labelled `unstamped` — typed, sticky or a scope's agent, the record cannot say; the default is unlabelled", () => {
    const { requests, skipped } = labelledRequests(
      [record("a", "research", "what is the latest on X"), record("b", "general", "hello")],
      { defaultPreset: "general" },
    );
    expect(requests).toEqual([
      { id: "a", label: "research", text: "what is the latest on X", labelSource: "unstamped" },
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
    { id: "3", label: "research", text: "what is X", labelSource: "unstamped" },
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
      labelSource: "unstamped" as const,
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

// The compound half of `load:route` (load-harness item 17): the checked-in set
// scored on detection, on decoys kept single and on per-part presets; the
// history's conductor requests scored on detection alone, their count printed.
describe("the checked-in compound set (src/load/routeCompoundFixtures.ts)", () => {
  const table = routablePresets().map((p) => p.name);

  it("is twenty compounds of two or more parts and five decoys of one, every preset a row of the router's table, every id unique", () => {
    const compounds = ROUTE_COMPOUND_FIXTURES.filter((f) => f.kind === "compound");
    const decoys = ROUTE_COMPOUND_FIXTURES.filter((f) => f.kind === "decoy");
    expect(compounds).toHaveLength(20);
    expect(decoys).toHaveLength(5);
    for (const f of compounds) expect(f.presets.length, f.id).toBeGreaterThanOrEqual(2);
    for (const f of decoys) expect(f.presets, f.id).toHaveLength(1);
    for (const f of ROUTE_COMPOUND_FIXTURES) {
      expect(f.text.trim().length, f.id).toBeGreaterThan(20);
      for (const preset of f.presets) expect(table, `${f.id}: ${preset}`).toContain(preset);
    }
    expect(new Set(ROUTE_COMPOUND_FIXTURES.map((f) => f.id)).size).toBe(ROUTE_COMPOUND_FIXTURES.length);
    // Every part preset is a row of the table — coding and conductor never.
    expect(ROUTE_COMPOUND_FIXTURES.flatMap((f) => f.presets)).not.toContain("coding");
    expect(ROUTE_COMPOUND_FIXTURES.flatMap((f) => f.presets)).not.toContain("conductor");
  });

  it("the seven compounds whose parts include a write preset expect that preset, single (`collapsesTo`, the first write part, read off the registry); every other compound expects the split and no decoy collapses", () => {
    const writer = (f: RouteCompoundFixture) => f.presets.find((p) => AGENTS[p]?.identity === "write");
    const compounds = ROUTE_COMPOUND_FIXTURES.filter((f) => f.kind === "compound");
    for (const f of compounds) expect(f.collapsesTo, f.id).toBe(writer(f));
    expect(compounds.filter((f) => f.collapsesTo !== undefined).map((f) => f.id)).toEqual([
      "c02",
      "c05",
      "c09",
      "c12",
      "c13",
      "c15",
      "c18",
    ]);
    expect(compounds.filter((f) => f.collapsesTo !== undefined).every((f) => f.collapsesTo === "ship")).toBe(true);
    for (const f of ROUTE_COMPOUND_FIXTURES.filter((f) => f.kind === "decoy"))
      expect(f.collapsesTo, f.id).toBeUndefined();
  });

  it("compoundExamples tags each fixture as the checked-in source; historyCompounds takes the conductor-labelled requests with their parts unknown", () => {
    const examples = compoundExamples(ROUTE_COMPOUND_FIXTURES);
    expect(examples).toHaveLength(25);
    expect(examples[0]).toEqual({ ...ROUTE_COMPOUND_FIXTURES[0], source: "fixture" });
    const requests: ReplayRequest[] = [
      { id: "h1", label: "conductor", text: "review #7 and also the outage", labelSource: "directive" },
      { id: "h2", label: "review", text: "review #8", labelSource: "directive" },
    ];
    expect(historyCompounds(requests)).toEqual([
      { id: "h1", kind: "compound", text: "review #7 and also the outage", presets: [], source: "history" },
    ]);
  });
});

describe("replayCompound + compoundScore + renderCompound — the split scored", () => {
  const examples: CompoundExample[] = [
    {
      id: "c1",
      kind: "compound",
      text: "review #7 and also the outage",
      presets: ["review", "research"],
      source: "fixture",
    },
    { id: "c2", kind: "compound", text: "fix X and review #9", presets: ["coding", "review"], source: "fixture" },
    {
      id: "c3",
      kind: "compound",
      text: "A and B and C",
      presets: ["general", "research", "explore"],
      source: "fixture",
    },
    {
      id: "c4",
      kind: "compound",
      text: "review #9 and fix X",
      presets: ["review", "coding"],
      collapsesTo: "coding",
      source: "fixture",
    },
    { id: "d1", kind: "decoy", text: "clone, test, report", presets: ["explore"], source: "fixture" },
    { id: "d2", kind: "decoy", text: "fix it: reproduce, patch, prove", presets: ["coding"], source: "fixture" },
  ];
  const split = (presets: string[], reason = "independent"): RouteDecision => ({
    preset: "conductor",
    reason,
    parts: presets.map((preset, i) => ({ preset, text: `part ${i + 1}` })),
  });
  const single = (preset: string): RouteDecision => ({ preset, reason: "one ask" });
  /** The parse's collapse of a compound answer with a write part (route.ts): the write preset, single. */
  const collapsed = (preset: string, presets: string[]): RouteDecision => ({
    preset,
    reason: "a review and a fix",
    collapsed: { presets },
  });

  it("a perfect router: every compound detected with its parts, the one with a write part collapsed to it, no decoy split, every part preset right", async () => {
    const results = await replayCompound(
      examples,
      async (text) => {
        const e = examples.find((x) => x.text === text)!;
        if (e.collapsesTo) return single(e.collapsesTo);
        return e.kind === "compound" ? split([...e.presets]) : single(e.presets[0]);
      },
      { now: () => 0 },
    );
    expect(results.map((r) => [r.id, r.detected, r.collapsed, r.matchedParts, r.expectedParts])).toEqual([
      ["c1", true, false, 2, 2],
      ["c2", true, false, 2, 2],
      ["c3", true, false, 3, 3],
      ["c4", false, true, 0, 0],
      ["d1", false, false, 0, 0],
      ["d2", false, false, 0, 0],
    ]);
    const score = compoundScore(results);
    expect(score).toMatchObject({
      compounds: 3,
      detected: 3,
      detectionRate: 1,
      collapseExpected: 1,
      collapsed: 1,
      decoys: 2,
      decoysSplit: 0,
      expectedParts: 7,
      matchedParts: 7,
      partAccuracy: 1,
      misses: [],
    });
    expect(renderCompound(score)[0]).toBe(
      "compound: detected 3/3 (100%), collapsed to its write preset 1/1, decoys split 0/2, part presets 7/7 (100%)",
    );
    expect(renderCompound(score)).toContain("misses: none");
  });

  it("a compound with a write part is scored on the collapse alone: the write preset single is the hit, answered outright or through the parse's collapse; the conductor with read parts, another single or no route is a miss; its parts never enter the parts arithmetic", async () => {
    const c4 = examples.find((e) => e.id === "c4")!;
    const answers: RouteDecision[] = [
      single("coding"),
      collapsed("coding", ["review", "coding"]),
      split(["review", "research"]),
      single("review"),
      { preset: undefined, reason: "router failed: x" },
    ];
    const results = await Promise.all(
      answers.map(async (a) => (await replayCompound([c4], async () => a, { now: () => 0 }))[0]),
    );
    expect(results.map((r) => [r.collapsed, r.detected, r.expectedParts, r.matchedParts])).toEqual([
      [true, false, 0, 0],
      [true, false, 0, 0],
      [false, true, 0, 0],
      [false, false, 0, 0],
      [false, false, 0, 0],
    ]);
    const scores = results.map((r) => compoundScore([r]));
    expect(scores.map((s) => [s.compounds, s.detected, s.collapseExpected, s.collapsed, s.misses.length])).toEqual([
      [0, 0, 1, 1, 0],
      [0, 0, 1, 1, 0],
      [0, 0, 1, 0, 1],
      [0, 0, 1, 0, 1],
      [0, 0, 1, 0, 1],
    ]);
    expect(renderCompound(scores[2])).toContain(
      '- c4: compound, expected coding single (a write part among review+coding), answered review+research — independent — "review #9 and fix X"',
    );
    expect(renderCompound(scores[3])).toContain(
      '- c4: compound, expected coding single (a write part among review+coding), answered review — one ask — "review #9 and fix X"',
    );
    expect(renderCompound(scores[4])).toContain(
      '- c4: compound, expected coding single (a write part among review+coding), answered (none) — router failed: x — "review #9 and fix X"',
    );
  });

  it("a fallible router: a compound left single is a miss, a decoy split is a miss, a part on the wrong preset counts against the parts and lists the miss; order is kept and the decision timed", async () => {
    let t = 0;
    const answers: Record<string, RouteDecision> = {
      c1: single("review"), // not detected
      c2: split(["coding", "research"]), // detected, one part off (review → research)
      c3: split(["general", "research", "explore"]), // right
      c4: split(["review", "research"]), // the fix dropped: a conductor of readers where coding, single, was due
      d1: split(["explore", "general"]), // a decoy split
      d2: single("coding"),
    };
    const results = await replayCompound(examples, async (text) => answers[examples.find((x) => x.text === text)!.id], {
      now: () => (t += 5),
      concurrency: 1,
    });
    expect(results.map((r) => r.id)).toEqual(["c1", "c2", "c3", "c4", "d1", "d2"]);
    expect(results.every((r) => r.ms === 5)).toBe(true);
    const score = compoundScore(results);
    expect(score).toMatchObject({
      compounds: 3,
      detected: 2,
      collapseExpected: 1,
      collapsed: 0,
      decoys: 2,
      decoysSplit: 1,
      expectedParts: 7,
      matchedParts: 4, // c1 undetected contributes none of its two; c2 one of two; c3 three; c4 has no parts to match
    });
    expect(score.detectionRate).toBeCloseTo(2 / 3);
    expect(score.partAccuracy).toBeCloseTo(4 / 7);
    expect(score.misses.map((m) => m.id)).toEqual(["c1", "c2", "c4", "d1"]);
    const lines = renderCompound(score);
    expect(lines[0]).toBe(
      "compound: detected 2/3 (66.7%), collapsed to its write preset 0/1, decoys split 1/2, part presets 4/7 (57.1%)",
    );
    expect(lines).toContain("misses (4):");
    expect(lines).toContain(
      '- c1: compound, expected review+research, answered review — one ask — "review #7 and also the outage"',
    );
    expect(lines).toContain(
      '- c2: compound, expected coding+review, answered coding+research — independent — "fix X and review #9"',
    );
    expect(lines).toContain(
      '- d1: decoy, expected explore, answered explore+general — independent — "clone, test, report"',
    );
  });

  it("a history conductor request is scored on detection alone — its parts are not on the record — and the parts arithmetic ignores it", async () => {
    const history: CompoundExample[] = [
      { id: "h1", kind: "compound", text: "two things", presets: [], source: "history" },
      { id: "h2", kind: "compound", text: "two other things", presets: [], source: "history" },
    ];
    const results = await replayCompound(
      history,
      async (text) => (text === "two things" ? split(["review", "research"]) : single("general")),
      { now: () => 0 },
    );
    const score = compoundScore(results);
    expect(score).toMatchObject({ compounds: 2, detected: 1, collapseExpected: 0, expectedParts: 0, matchedParts: 0 });
    expect(score.partAccuracy).toBeNaN();
    expect(renderCompound(score)[0]).toBe(
      "compound: detected 1/2 (50%), collapsed to its write preset 0/0, decoys split 0/0, part presets 0/0 (—)",
    );
    expect(score.misses.map((m) => m.id)).toEqual(["h2"]);
  });

  it("no route on a compound is not detected; an answer with more parts than expected matches only the expected count and is a miss", async () => {
    const results = await replayCompound([examples[0]], async () => split(["review", "research", "general"]), {
      now: () => 0,
    });
    expect(results[0]).toMatchObject({ detected: true, expectedParts: 2, matchedParts: 2 });
    expect(compoundScore(results).misses.map((m) => m.id)).toEqual(["c1"]);
    const none = await replayCompound([examples[0]], async () => ({ preset: undefined, reason: "router failed: x" }), {
      now: () => 0,
    });
    expect(none[0]).toMatchObject({ detected: false, matchedParts: 0 });
    expect(compoundScore([]).detectionRate).toBeNaN();
    expect(renderCompound(compoundScore([]))[0]).toBe(
      "compound: detected 0/0 (—), collapsed to its write preset 0/0, decoys split 0/0, part presets 0/0 (—)",
    );
  });
});

// The whole checked-in set through the dispatcher's own `route` — the real
// prompt and parse, the model scripted — the way `load -- route` runs it: the
// receipt's fixture scores under a router that answers right, and under a
// naive one that splits on every "and", which the decoy check must catch.
describe("the checked-in set through route() over a scripted model", () => {
  const presets = routablePresets();
  const allowed = presets.map((p) => p.name);
  const byText = new Map(ROUTE_COMPOUND_FIXTURES.map((f) => [f.text, f]));
  const decideWith =
    (model: RouteModel) =>
    (text: string): Promise<RouteDecision> =>
      route({ text, recentDirectives: {}, presets, allowed, fallback: "general", compound: { maxParts: 3 } }, model);
  const textOf = (prompt: { user: string }) => /<request>\n([\s\S]*)\n<\/request>/.exec(prompt.user)![1];

  it("a router that answers every fixture as a split of its parts: 13/13 splittable compounds detected, the 7 with a ship part collapsed to ship by the parse, 0/5 decoys split, every part preset right, the bars met", async () => {
    const knowing: RouteModel = async (prompt) => {
      const f = byText.get(textOf(prompt))!;
      return f.kind === "compound"
        ? JSON.stringify({
            preset: "conductor",
            parts: f.presets.map((preset, i) => ({ preset, text: `part ${i + 1} of ${f.id}` })),
            reason: "independent asks",
          })
        : JSON.stringify({ preset: f.presets[0], reason: "one ask with steps" });
    };
    const results = await replayCompound(compoundExamples(ROUTE_COMPOUND_FIXTURES), decideWith(knowing), {
      now: () => 0,
    });
    // The parse collapsed every compound answer that named ship: the decision was ship, single.
    for (const r of results.filter((r) => r.collapsesTo !== undefined))
      expect([r.id, r.routed, r.collapsed, r.detected]).toEqual([r.id, "ship", true, false]);
    const score = compoundScore(results);
    const expectedParts = ROUTE_COMPOUND_FIXTURES.filter((f) => f.kind === "compound" && !f.collapsesTo).reduce(
      (n, f) => n + f.presets.length,
      0,
    );
    expect(score).toMatchObject({
      compounds: 13,
      detected: 13,
      detectionRate: 1,
      collapseExpected: 7,
      collapsed: 7,
      decoys: 5,
      decoysSplit: 0,
      expectedParts,
      matchedParts: expectedParts,
      partAccuracy: 1,
      misses: [],
    });
    expect(renderCompound(score)[0]).toBe(
      `compound: detected 13/13 (100%), collapsed to its write preset 7/7, decoys split 0/5, part presets ${expectedParts}/${expectedParts} (100%)`,
    );
  });

  it("a router that answers ship outright for a compound with a ship part, as the prompt asks, scores the same collapse: 7/7", async () => {
    const direct: RouteModel = async (prompt) => {
      const f = byText.get(textOf(prompt))!;
      if (f.collapsesTo) return JSON.stringify({ preset: f.collapsesTo, reason: "a write part: one ship run" });
      return f.kind === "compound"
        ? JSON.stringify({
            preset: "conductor",
            parts: f.presets.map((preset, i) => ({ preset, text: `part ${i + 1} of ${f.id}` })),
            reason: "independent asks",
          })
        : JSON.stringify({ preset: f.presets[0], reason: "one ask with steps" });
    };
    const score = compoundScore(
      await replayCompound(compoundExamples(ROUTE_COMPOUND_FIXTURES), decideWith(direct), { now: () => 0 }),
    );
    expect(score).toMatchObject({ compounds: 13, detected: 13, collapseExpected: 7, collapsed: 7, misses: [] });
  });

  it("a naive router that splits on every 'and' detects the compounds but splits every decoy — the decoy check is what catches it", async () => {
    const naive: RouteModel = async (prompt) => {
      const text = textOf(prompt);
      const pieces = text
        .split(/\band\b|;/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 3);
      return JSON.stringify({
        preset: "conductor",
        parts: pieces.map((t) => ({
          preset: /review/i.test(t) ? "review" : /fix|add|rename|bump/i.test(t) ? "coding" : "general",
          text: t,
        })),
        reason: "split on and",
      });
    };
    const results = await replayCompound(compoundExamples(ROUTE_COMPOUND_FIXTURES), decideWith(naive), {
      now: () => 0,
    });
    const score = compoundScore(results);
    expect(score.detectionRate).toBeGreaterThanOrEqual(0.9);
    // Four of the five decoys carry an "and"; the fifth (steps joined by "then") stays single even here.
    expect(score.decoysSplit).toBe(4);
    expect(score.partAccuracy).toBeLessThan(1);
    expect(score.misses.filter((m) => m.kind === "decoy")).toHaveLength(4);
  });
});

describe("the checked-in imperative set (src/load/routeImperativeFixtures.ts)", () => {
  const table = routablePresets();
  const names = table.map((p) => p.name);
  const writers = table.filter((p) => p.identity === "write").map((p) => p.name);

  it("is twenty-seven imperatives expecting a write preset — twenty terse, three spec-shaped on a named repository, two whose task is in a linked conversation, two post-approval follow-ups on an open pull request — eight read-only decoys, six review-shaped asks expecting review; every preset a row of the table, every id unique", () => {
    const imperatives = ROUTE_IMPERATIVE_FIXTURES.filter((f) => f.kind === "imperative");
    const decoys = ROUTE_IMPERATIVE_FIXTURES.filter((f) => f.kind === "decoy");
    const reviews = ROUTE_IMPERATIVE_FIXTURES.filter((f) => f.kind === "review");
    expect(imperatives).toHaveLength(27);
    expect(decoys).toHaveLength(8);
    expect(reviews).toHaveLength(6);
    for (const f of imperatives) expect(f.presets, f.id).toEqual(writers);
    // A decoy expects read-only presets only — a question is answered, never
    // acted on — and the five about a failure expect exactly research or general.
    const readOnly = table.filter((p) => p.identity !== "write" && p.name !== "review").map((p) => p.name);
    for (const f of decoys) for (const preset of f.presets) expect(readOnly, `${f.id}: ${preset}`).toContain(preset);
    for (const f of decoys.slice(0, 5)) expect([...f.presets].sort(), f.id).toEqual(["general", "research"]);
    for (const f of reviews) expect(f.presets, f.id).toEqual(["review"]);
    for (const f of ROUTE_IMPERATIVE_FIXTURES) {
      expect(f.text.trim().length, f.id).toBeGreaterThan(5);
      for (const preset of f.presets) expect(names, `${f.id}: ${preset}`).toContain(preset);
      // `references` says how many conversations the text links: present exactly
      // when the text carries a permalink, and then the count of them.
      const links = (f.text.match(/https:\/\/acme\.slack\.com\//g) ?? []).length;
      expect(f.references, f.id).toBe(links === 0 ? undefined : links);
    }
    // Post-approval follow-ups: the production thread after an approved unit
    // whose pull request stayed open (record 0057's two failure classes; the
    // grounding case of record 0060's ownership amendment) — a correction and
    // a follow-on order, no repository named, each an ask for work.
    const followUps = imperatives.filter((f) => f.id.startsWith("p"));
    expect(followUps.map((f) => f.id)).toEqual(["p01", "p02"]);
    expect(followUps[0]!.text).toContain("sorry, maybe i have this wrong");
    expect(followUps[1]!.text).toBe("add bottom-left sidebar update stack component with dismiss behavior");
    const orders = imperatives.filter((f) => !f.id.startsWith("p"));
    // Terse: twenty imperatives with no detail to route on, one short line each.
    const terse = orders.filter((f) => f.references === undefined && f.text.length <= 80);
    expect(terse.map((f) => f.id)).toEqual(Array.from({ length: 20 }, (_, i) => `i${String(i + 1).padStart(2, "0")}`));
    // Spec-shaped: longer, on a named repository, saying how something should
    // behave — and naming no "fix" or "implement".
    const spec = orders.filter((f) => f.references === undefined && f.text.length > 80);
    expect(spec.map((f) => f.id)).toEqual(["s01", "s02", "s03"]);
    for (const f of spec) {
      expect(f.text, f.id).toMatch(/\bacme\b/);
      expect(f.text, f.id).toMatch(/\bshould\b/);
      expect(f.text, f.id).not.toMatch(/\b(fix|implement)\b/i);
    }
    // Referenced: the order's verb in the sentence, the task in the linked thread.
    const referenced = orders.filter((f) => f.references !== undefined);
    expect(referenced.map((f) => f.id)).toEqual(["t01", "t02"]);
    // The read-only decoy about a linked thread: the link alone never makes an order.
    expect(decoys.filter((f) => f.references !== undefined).map((f) => f.id)).toEqual(["d08"]);
    expect(new Set(ROUTE_IMPERATIVE_FIXTURES.map((f) => f.id)).size).toBe(ROUTE_IMPERATIVE_FIXTURES.length);
    // The one real misroute the replay at the flip found is on the set, verbatim.
    expect(imperatives.map((f) => f.text)).toContain("looks like the ci failed, fix it");
    // The spec-shaped production ask that routed to explore — "do this for me",
    // "should show", "send me screenshots", no verb of change — verbatim except
    // the repository; and the production ask whose task was in the linked thread,
    // routed to general — verbatim except the repository and the permalink.
    expect(spec.find((f) => f.id === "s01")!.text).toContain("I need you to do this for me and send me screenshots");
    expect(spec.find((f) => f.id === "s01")!.text).toContain(
      "*On the acme repo:* the topology screen should show connect github single button if there's nothing connected (currently shows the install script)",
    );
    expect(referenced.find((f) => f.id === "t01")!.text).toBe(
      "in acme ship https://acme.slack.com/archives/C1ABCDEF/p1700000000000000 - this, (read the whole thread)",
    );
    // The one real read-to-write misroute the replay after the ship door found — a
    // pull request named with a note about the request's own history — is on the
    // set as a review-shaped ask, on a neutral repository.
    expect(reviews.map((f) => f.text)).toContain(
      "https://github.com/acme/api/pull/3179 (retry at head c6583d2: the run died)",
    );
  });
});

// The attach set: the production requests that named `attach_file` and were
// routed to a preset without it. `route()` settles them in code, before the
// model — so a router that is never asked scores them all; the control that
// names no tool is the model's as before.
describe("the checked-in attach set (src/load/routeAttachFixtures.ts)", () => {
  it("is four asks that name attach_file expecting the holder, one control that does not, every id unique, every text on a neutral repository", () => {
    const naming = ROUTE_ATTACH_FIXTURES.filter((f) => f.kind === "imperative");
    const controls = ROUTE_ATTACH_FIXTURES.filter((f) => f.kind === "decoy");
    expect(naming).toHaveLength(4);
    expect(controls).toHaveLength(1);
    for (const f of naming) expect(f.text, f.id).toMatch(/(?<![\w-])attach_file(?![\w-])/);
    for (const f of controls) expect(f.text, f.id).not.toContain("attach_file");
    const holder = routablePresets()
      .filter((p) => p.attaches)
      .map((p) => p.name);
    for (const f of naming) expect([...f.presets]).toEqual(holder);
    expect(new Set(ROUTE_ATTACH_FIXTURES.map((f) => f.id)).size).toBe(ROUTE_ATTACH_FIXTURES.length);
    for (const f of ROUTE_ATTACH_FIXTURES) expect(f.text).toMatch(/^in acme\//);
  });

  it("through route(): every ask that names the tool reaches the holder with no model call, the control reaches whatever the model says — scored as routes, never skips", async () => {
    const presets = routablePresets();
    const allowed = presets.map((p) => p.name);
    let asked = 0;
    const model: RouteModel = async () => {
      asked += 1;
      return JSON.stringify({ preset: "explore", reason: "a polling loop, read-only" });
    };
    const results = await replayImperative(
      ROUTE_ATTACH_FIXTURES,
      (text) => route({ text, recentDirectives: {}, presets, allowed, fallback: "general" }, model),
      { now: () => 0 },
    );
    expect(asked).toBe(1);
    expect(results.map((r) => [r.id, r.routed, r.hit])).toEqual([
      ["a01", "ship", true],
      ["a02", "ship", true],
      ["a03", "ship", true],
      ["a04", "ship", true],
      ["a05", "explore", true],
    ]);
    for (const r of results.slice(0, 4)) expect(r.reason).toBe("names attach_file, which only ship holds");
    const score = imperativeScore(results);
    expect(score).toMatchObject({ imperatives: 4, imperativesHit: 4, hitRate: 1, decoys: 1, decoysHit: 1, misses: [] });
  });
});

describe("the imperative set through route() over a scripted model", () => {
  const presets = routablePresets();
  const allowed = presets.map((p) => p.name);
  const byText = new Map(ROUTE_IMPERATIVE_FIXTURES.map((f) => [f.text, f]));
  const decideWith =
    (model: RouteModel) =>
    (text: string, facts?: RouteFacts): Promise<RouteDecision> =>
      route(
        { text, recentDirectives: {}, presets, allowed, fallback: "general", compound: { maxParts: 3 }, ...facts },
        model,
      );
  const textOf = (prompt: { user: string }) => /<request>\n([\s\S]*)\n<\/request>/.exec(prompt.user)![1];

  it("a router that reads the rule: every imperative to ship, every look-alike read-only, every review-shaped ask to review — both rows pass", async () => {
    const knowing: RouteModel = async (prompt) =>
      JSON.stringify({ preset: byText.get(textOf(prompt))!.presets[0], reason: "as the rule says" });
    const results = await replayImperative(ROUTE_IMPERATIVE_FIXTURES, decideWith(knowing), { now: () => 0 });
    const score = imperativeScore(results);
    expect(score).toMatchObject({
      imperatives: 27,
      imperativesHit: 27,
      hitRate: 1,
      lookalikes: 14,
      lookalikesToWrite: 0,
      decoys: 8,
      decoysHit: 8,
      reviews: 6,
      reviewsHit: 6,
      misses: [],
    });
    expect(renderImperative(score, { writePreset: "ship" })).toEqual([
      "imperatives: 27/27 to ship (100%); look-alikes to a write preset 0/14 (decoys 8/8 read-only as expected, review-shaped 6/6 to review)",
      "",
      "misses: none",
    ]);
    const rows = routeChecks({
      table: confusionTable([], allowed),
      answered: 0,
      readToWrite: 0,
      compound: compoundScore([]),
      compoundBar: { detection: 0.9 },
      imperative: score,
      imperativeBar: { hit: 0.9 },
      writePreset: "coding",
    }).filter((c) => /imperative|look-alike/.test(c.name));
    expect(rows.map((c) => [c.pass, c.actual, c.limit])).toEqual([
      [true, "27/27 (100%)", "≥ 90%"],
      [true, "0/14", "0"],
    ]);
  });

  it("a fixture's linked conversations reach the router's user turn as the count the route stage puts there; a fixture linking none puts no line", async () => {
    const seen = new Map<string, string>();
    const watching: RouteModel = async (prompt) => {
      seen.set(byText.get(textOf(prompt))!.id, prompt.user);
      return JSON.stringify({ preset: "general", reason: "watching" });
    };
    const byId = new Map(ROUTE_IMPERATIVE_FIXTURES.map((f) => [f.id, f]));
    await replayImperative([byId.get("t01")!, byId.get("d08")!, byId.get("i01")!], decideWith(watching), {
      now: () => 0,
    });
    expect(seen.get("t01")).toContain("The request links 1 conversation this bot can read");
    expect(seen.get("d08")).toContain("The request links 1 conversation this bot can read");
    expect(seen.get("i01")).not.toContain("conversation this bot can read");
  });

  it("a keyword router — fix, ci, tests, build, should, ship mean ship — gets every imperative but sends the decoys to ship too: the look-alike row is what catches it", async () => {
    const keyword: RouteModel = async (prompt) => {
      const text = textOf(prompt);
      const preset = /\b(pr|pull request)\b/i.test(text)
        ? "review"
        : /fix|ci\b|tests?|build|add|rename|bump|make|green|red|lint|typecheck|docs|version|retries|delete|update|should|\bship\b|do (this|the above)|take care/i.test(
              text,
            )
          ? "ship"
          : "general";
      return JSON.stringify({ preset, reason: "keyword" });
    };
    const results = await replayImperative(ROUTE_IMPERATIVE_FIXTURES, decideWith(keyword), { now: () => 0 });
    const score = imperativeScore(results);
    expect(score.hitRate).toBeGreaterThanOrEqual(0.9);
    expect(score.lookalikesToWrite).toBeGreaterThan(0);
    expect(score.misses.every((m) => m.kind !== "imperative")).toBe(true);
    const rows = routeChecks({
      table: confusionTable([], allowed),
      answered: 0,
      readToWrite: 0,
      compound: compoundScore([]),
      compoundBar: { detection: 0.9 },
      imperative: score,
      imperativeBar: { hit: 0.9 },
      writePreset: "coding",
    }).filter((c) => /imperative|look-alike/.test(c.name));
    expect(rows.map((c) => c.pass)).toEqual([true, false]);
    expect(rows[1].actual).toBe(`${score.lookalikesToWrite}/14`);
    expect(renderImperative(score).slice(2)[0]).toBe(`misses (${score.misses.length}):`);
  });

  it("the arithmetic: a miss is an answer outside the expected presets; a write answer on a look-alike is counted apart from a plain miss; no route is a miss and never a write; order kept, decisions timed", async () => {
    const fixtures = [
      { id: "i1", kind: "imperative" as const, text: "fix it", presets: ["coding"] },
      { id: "i2", kind: "imperative" as const, text: "make it pass", presets: ["coding"] },
      { id: "d1", kind: "decoy" as const, text: "why did ci fail?", presets: ["research", "general"] },
      { id: "d2", kind: "decoy" as const, text: "list the failing tests", presets: ["research", "general"] },
      { id: "r1", kind: "review" as const, text: "look at PR 42", presets: ["review"] },
    ];
    const answers: Record<string, RouteDecision> = {
      "fix it": { preset: "coding", reason: "order" },
      "make it pass": { preset: undefined, reason: "router failed: boom" },
      "why did ci fail?": { preset: "research", reason: "question" },
      "list the failing tests": { preset: "coding", reason: "keyword" },
      "look at PR 42": { preset: "explore", reason: "wrong" },
    };
    let t = 0;
    const results = await replayImperative(fixtures, async (text) => answers[text], {
      concurrency: 1,
      now: () => (t += 5),
    });
    expect(results.map((r) => [r.id, r.routed ?? NO_ROUTE, r.hit, r.toWrite])).toEqual([
      ["i1", "coding", true, true],
      ["i2", NO_ROUTE, false, false],
      ["d1", "research", true, false],
      ["d2", "coding", false, true],
      ["r1", "explore", false, false],
    ]);
    for (const r of results) expect(r.ms).toBe(5);
    const score = imperativeScore(results);
    expect(score).toMatchObject({
      imperatives: 2,
      imperativesHit: 1,
      hitRate: 0.5,
      lookalikes: 3,
      lookalikesToWrite: 1,
      decoys: 2,
      decoysHit: 1,
      reviews: 1,
      reviewsHit: 0,
    });
    expect(score.misses.map((m) => m.id)).toEqual(["i2", "d2", "r1"]);
    expect(renderImperative(score, { writePreset: "coding" })).toEqual([
      "imperatives: 1/2 to coding (50%); look-alikes to a write preset 1/3 (decoys 1/2 read-only as expected, review-shaped 0/1 to review)",
      "",
      "misses (3):",
      '- i2: imperative, expected coding, routed (none) — router failed: boom — "make it pass"',
      '- d2: decoy, expected research or general, routed coding — keyword — "list the failing tests"',
      '- r1: review, expected review, routed explore — wrong — "look at PR 42"',
    ]);
    expect(imperativeScore([]).hitRate).toBeNaN();
  });
});

// The checks the receipt's verdict is made of (load-harness item 17): the
// accuracy bar, every request answered, record 0026's read-only-to-write
// clause as a row of its own, the compound bars and the imperative bars.
describe("typedLabels — the table's requests are the ones whose preset was typed for the message", () => {
  const req = (id: string, labelSource: ReplayRequest["labelSource"]): ReplayRequest => ({
    id,
    label: "review",
    text: "look at PR 9",
    labelSource,
  });

  it("keeps a directive label and drops a sticky or unstamped one: a sticky label is the thread's preset carried onto a later message, not the message's own", () => {
    const kept = typedLabels([
      req("d", "directive"),
      req("s", "sticky"),
      req("u", "unstamped"),
      req("d2", "directive"),
    ]);
    expect(kept.map((r) => r.id)).toEqual(["d", "d2"]);
    expect(typedLabels([])).toEqual([]);
  });
});

describe("readToWriteRoutes + routeChecks — the verdict's rows", () => {
  const result = (
    label: string,
    routed: string | undefined,
    source: ReplayResult["labelSource"] = "directive",
  ): ReplayResult => ({
    id: `${label}->${routed ?? "none"}`,
    label,
    text: "t",
    labelSource: source,
    routed,
    reason: "r",
    correct: routed === label,
    ms: 1,
  });

  it("readToWriteRoutes: a read-only label (identity none or read) routed to a write preset counts; a write label to write, a read label to read or to the conductor, and no route do not", () => {
    const hits = readToWriteRoutes([
      result("review", "coding"),
      result("general", "coding"),
      result("research", "ship"),
      result("explore", "explore"),
      result("coding", "coding"),
      result("review", "conductor"),
      result("general", undefined),
    ]);
    expect(hits.map((r) => r.id)).toEqual(["review->coding", "general->coding", "research->ship"]);
  });

  it("a clean run: every row passes and the verdict is green", () => {
    const results = [result("review", "review"), result("coding", "coding"), result("research", "research")];
    const checks = routeChecks({
      table: confusionTable(results, ["review", "coding", "research"]),
      answered: 3,
      readToWrite: readToWriteRoutes(results).length,
      compound: compoundScore([]),
      compoundBar: { detection: 0.9 },
      imperative: imperativeScore([]),
      imperativeBar: { hit: 0.9 },
      writePreset: "coding",
    });
    expect(checks.map((c) => c.name)).toEqual([
      "routing accuracy ≥ 95% against the presets people typed for the message (directive labels; record 0026's bar)",
      "every request answered with a preset",
      "read-only labels routed to a write preset: 0 (record 0026's clause)",
      "compound detected on ≥ 90% of the checked-in compound asks",
      "compound with a write part collapsed to that preset, single: every checked-in one",
      "no decoy split — one ask with several steps stays one route",
      "terse imperatives routed to coding on ≥ 90% of the checked-in imperative asks",
      "read-only look-alikes of an imperative routed to a write preset: 0",
    ]);
    expect(checks.map((c) => [c.pass, c.actual, c.limit])).toEqual([
      [true, "100%", "≥ 95%"],
      [true, "3/3", "3"],
      [true, "0", "0"],
      [false, "0/0 (—)", "≥ 90%"],
      [true, "0/0", "0"],
      [true, "0/0", "0"],
      [false, "0/0 (—)", "≥ 90%"],
      [true, "0/0", "0"],
    ]);
  });

  it("a compound with a write part collapsed to it is counted on its own row and never as read-to-write; one left uncollapsed fails that row alone while the read-to-write row stays at 0", async () => {
    const fixture: CompoundExample = {
      id: "c02",
      kind: "compound",
      text: "review #9 and fix X",
      presets: ["review", "coding"],
      collapsesTo: "coding",
      source: "fixture",
    };
    const results = [result("review", "review"), result("coding", "coding")];
    const input = {
      table: confusionTable(results, ["review", "coding"]),
      answered: 2,
      readToWrite: readToWriteRoutes(results).length,
      compoundBar: { detection: 0.9 },
      imperative: imperativeScore([]),
      imperativeBar: { hit: 0.9 },
      writePreset: "coding",
    };
    const rowOf = (checks: ReturnType<typeof routeChecks>, prefix: string) =>
      checks.find((c) => c.name.startsWith(prefix))!;
    const collapsed = compoundScore(
      await replayCompound(
        [fixture],
        async () => ({ preset: "coding", reason: "a review and a fix", collapsed: { presets: ["review", "coding"] } }),
        { now: () => 0 },
      ),
    );
    const green = routeChecks({ ...input, compound: collapsed });
    expect(rowOf(green, "compound with a write part")).toEqual({
      name: "compound with a write part collapsed to that preset, single: every checked-in one",
      pass: true,
      actual: "1/1",
      limit: "1",
    });
    expect(rowOf(green, "read-only labels routed to a write preset")).toMatchObject({ pass: true, actual: "0" });
    const kept = compoundScore(
      await replayCompound([fixture], async () => ({ preset: "review", reason: "a review" }), { now: () => 0 }),
    );
    const red = routeChecks({ ...input, compound: kept });
    expect(rowOf(red, "compound with a write part")).toMatchObject({ pass: false, actual: "0/1", limit: "1" });
    expect(rowOf(red, "read-only labels routed to a write preset")).toMatchObject({ pass: true, actual: "0" });
    expect(rowOf(red, "compound detected")).toMatchObject({ actual: "0/0 (—)" }); // a collapsing compound is not a split to detect
  });

  it("the imperative bar's label names the table's write preset, never a hardcoded name", () => {
    const checks = routeChecks({
      table: confusionTable([], ["general", "ship"]),
      answered: 0,
      readToWrite: 0,
      compound: compoundScore([]),
      compoundBar: { detection: 0.9 },
      imperative: imperativeScore([]),
      imperativeBar: { hit: 0.9 },
      writePreset: tableWritePreset(["general", "ship"])!,
    });
    expect(checks.map((c) => c.name)).toContain(
      "terse imperatives routed to ship on ≥ 90% of the checked-in imperative asks",
    );
  });

  it("a historical label whose preset left the table but shares its write identity maps onto the table's write preset and is counted; a read label stays and scores wrong", () => {
    const table = ["general", "ship", "review", "research", "explore"];
    expect(tableWritePreset(table)).toBe("ship");
    const requests = [
      { id: "h1", label: "coding", text: "fix the bug", labelSource: "directive" as const },
      { id: "h2", label: "review", text: "look at PR 9", labelSource: "directive" as const },
      { id: "h3", label: "zebra", text: "stripes", labelSource: "directive" as const },
    ];
    const { requests: mappedReqs, mapped } = mapHistoricalLabels(requests, table);
    // `coding` left the table when `ship` took its write seat: the request
    // asked for a write run, so a `ship` answer is correct — and counted.
    expect(mappedReqs.map((r) => r.label)).toEqual(["ship", "review", "zebra"]);
    expect(mapped).toBe(1);
    const results: ReplayResult[] = mappedReqs.map((r) => ({
      id: r.id,
      label: r.label,
      text: r.text,
      labelSource: r.labelSource,
      routed: "ship",
      correct: r.label === "ship", // as replayRoutes scores it: routed === label
      reason: "r",
      ms: 0,
    }));
    const scored = confusionTable(results, table);
    const row = (label: string) => scored.rows.find((r) => r.label === label)!;
    expect(row("ship").correct).toBe(1); // the mapped coding label, correct on a ship answer
    expect(row("review").correct).toBe(0); // a review label answered ship is still a misroute
  });

  it("one read-only label routed to coding fails the read-only-to-write row — and with it the verdict — even when the accuracy bar still passes", () => {
    const results: ReplayResult[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ ...result("review", "review"), id: `ok${i}` })),
      result("general", "coding"),
    ];
    const table = confusionTable(results, ["general", "review", "coding"]);
    expect(table.accuracy).toBeGreaterThanOrEqual(0.95);
    const checks = routeChecks({
      table,
      answered: 31,
      readToWrite: readToWriteRoutes(results).length,
      compound: compoundScore([]),
      compoundBar: { detection: 0.9 },
      imperative: imperativeScore([]),
      imperativeBar: { hit: 0.9 },
      writePreset: "coding",
    });
    const row = checks.find((c) => c.name.startsWith("read-only labels routed to a write preset"))!;
    expect(row).toEqual({
      name: "read-only labels routed to a write preset: 0 (record 0026's clause)",
      pass: false,
      actual: "1 (general->coding)",
      limit: "0",
    });
    expect(checks.every((c) => c.pass)).toBe(false);
  });
});

// The command half (load-harness item 17; record 0036, unit 3): the checked-in
// set through the real `route()` parse over a scripted model — the command
// named, the input bound and compared after `parseInput`, nothing invoked.
describe("the checked-in command set through route() over a scripted model", () => {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  const menu = routableCommands(registry);
  const defs = menu.map((c) => c.def);
  const byId = new Map(menu.map((c) => [c.id, c]));
  const presets = routablePresets();
  const allowed = presets.map((p) => p.name);
  const byText = new Map(ROUTE_COMMAND_EXAMPLES.map((e) => [e.text, e]));
  const textOf = (prompt: { user: string }) => /<request>\n([\s\S]*)\n<\/request>/.exec(prompt.user)![1];
  const decideWith =
    (model: RouteModel) =>
    (text: string, facts?: RouteFacts): Promise<RouteDecision> =>
      route(
        {
          text,
          recentDirectives: {},
          presets,
          allowed,
          fallback: "general",
          commands: menu,
          ...facts,
        },
        model,
      );

  /** The fixture's expected input spelled the way a tool call carries it:
   *  one object, argument names beside camelCase options. */
  const namedOf = (commandId: string, input: CommandInput): Record<string, unknown> => {
    const def = byId.get(commandId)!.def;
    const named: Record<string, unknown> = { ...(input.options ?? {}) };
    (def.args ?? []).forEach((arg, i) => {
      const v = (input.args ?? [])[i];
      if (v !== undefined) named[arg.name] = v;
    });
    return named;
  };

  /** A router that reads every fixture right: the command's tool with the
   *  expected input for a fixture, a plain route for a decoy. */
  const knowing: RouteModel = async (prompt) => {
    const example = byText.get(textOf(prompt))!;
    if (example.kind === "decoy") return JSON.stringify({ preset: "general", reason: "a judgement, not a command" });
    return { tool: mcpToolName(example.command), input: namedOf(example.command, example.input) };
  };

  it("a knowing router: the command row passes at 100 percent, the input row at 100 percent, and nothing is invoked", async () => {
    const invoke = vi.spyOn(registry, "invoke");
    const results = await replayCommands(ROUTE_COMMAND_EXAMPLES, decideWith(knowing), { now: () => 0 }, defs);
    const score = commandScore(results);
    expect(score.fixtures).toBe(ROUTE_COMMAND_FIXTURES.length);
    expect(score.decoys).toBe(ROUTE_COMMAND_DECOYS.length);
    expect(score.commandHits).toBe(score.fixtures);
    expect(score.inputHits).toBe(score.fixtures);
    expect(score.decoysBound).toBe(0);
    expect(score.commandRate).toBe(1);
    expect(score.inputRate).toBe(1);
    expect(score.misses).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    expect(renderCommands(score)[0]).toContain("bound right 76/76");
  });

  it("one wrong command fails the command row (bar 1.0); the miss carries the bound and the expected input", async () => {
    const oneWrong: RouteModel = async (prompt) => {
      const example = byText.get(textOf(prompt))!;
      if (example.id === "c09h") return { tool: mcpToolName("repo.list"), input: {} };
      return knowing(prompt, { maxTokens: 1, signal: new AbortController().signal });
    };
    const results = await replayCommands(ROUTE_COMMAND_EXAMPLES, decideWith(oneWrong), { now: () => 0 }, defs);
    const score = commandScore(results);
    expect(score.commandHits).toBe(score.fixtures - 1);
    expect(score.commandRate).toBeLessThan(1);
    expect(score.misses.map((m) => m.id)).toEqual(["c09h"]);
    const rows = routeChecks({
      table: confusionTable([], allowed),
      answered: 0,
      readToWrite: 0,
      compound: compoundScore([]),
      compoundBar: { detection: 0.9 },
      imperative: imperativeScore([]),
      imperativeBar: { hit: 0.9 },
      writePreset: "ship",
      command: { score, bars: { command: 1.0, input: 0.9 } },
    });
    const commandRow = rows.find((r) => r.name.startsWith("command named right"))!;
    expect(commandRow.pass).toBe(false);
    // The wrong command is also an input miss, but 63/64 stays above the 0.9 bar:
    // one wrong command fails the command row alone.
    const inputRow = rows.find((r) => r.name.startsWith("bound input equals"))!;
    expect(inputRow.pass).toBe(true);
    const line = renderCommands(score).find((l) => l.startsWith("- c09h"))!;
    expect(line).toContain("expected runs.list");
    expect(line).toContain("bound repo.list");
  });

  it("a decoy bound to any command is a miss — unless its allow list names the command", async () => {
    const tempted: RouteModel = async (prompt) => {
      const example = byText.get(textOf(prompt))!;
      if (example.id === "c09d") return { tool: mcpToolName("runs.list"), input: {} }; // no allow: a miss
      if (example.id === "c23d") return { tool: mcpToolName("memory.list"), input: {} }; // allowed
      return knowing(prompt, { maxTokens: 1, signal: new AbortController().signal });
    };
    const results = await replayCommands(ROUTE_COMMAND_EXAMPLES, decideWith(tempted), { now: () => 0 }, defs);
    const score = commandScore(results);
    expect(score.decoysBound).toBe(1);
    expect(score.misses.map((m) => m.id)).toEqual(["c09d"]);
    expect(score.commandRate).toBeLessThan(1);
  });

  it("a right command with a wrong post-parse input is an input miss, not a command miss", async () => {
    const sloppy: RouteModel = async (prompt) => {
      const example = byText.get(textOf(prompt))!;
      if (example.id === "c10h") return { tool: mcpToolName("runs.stop"), input: { id: "r-123", mode: "hard" } };
      return knowing(prompt, { maxTokens: 1, signal: new AbortController().signal });
    };
    const results = await replayCommands(ROUTE_COMMAND_EXAMPLES, decideWith(sloppy), { now: () => 0 }, defs);
    const score = commandScore(results);
    expect(score.commandHits).toBe(score.fixtures);
    expect(score.inputHits).toBe(score.fixtures - 1);
    expect(score.misses.map((m) => m.id)).toEqual(["c10h"]);
  });

  it("the input row compares after parseInput, so a coerced number equals its string", async () => {
    const coercing: CommandDef<unknown> = {
      id: "demo.count",
      action: "demo:read",
      effect: "read",
      describe: "a demo command with a coercing numeric argument",
      args: [{ name: "n", schema: z.coerce.number(), describe: "a count" }],
      handler: async () => ({}),
    } as CommandDef<unknown>;
    const example: RouteCommandExample = {
      id: "x01",
      kind: "happy",
      text: "count to seven",
      command: "demo.count",
      input: { args: [7], options: {} },
    };
    const results = await replayCommands(
      [example],
      async () => ({
        preset: undefined,
        reason: "command demo.count",
        command: { id: "demo.count", input: { args: ["7"], options: {} } },
      }),
      { now: () => 0 },
      [coercing],
    );
    expect(results[0]!.commandHit).toBe(true);
    expect(results[0]!.inputHit).toBe(true);
  });

  it("a fixture's threadRepo reaches the router's user turn as the thread's repository", async () => {
    const seen: string[] = [];
    const watching: RouteModel = async (prompt) => {
      seen.push(prompt.user);
      return knowing(prompt, { maxTokens: 1, signal: new AbortController().signal });
    };
    const withRepo = ROUTE_COMMAND_FIXTURES.find((f) => f.id === "c21h")!;
    await replayCommands([withRepo], decideWith(watching), { now: () => 0 }, defs);
    expect(seen[0]).toContain("The thread's repository: acme/api");
  });

  it("repo.test and repo.build each carry a threadRepo form", () => {
    for (const command of ["repo.test", "repo.build"]) {
      const forms = ROUTE_COMMAND_FIXTURES.filter((f) => f.command === command);
      expect(
        forms.some((f) => f.threadRepo !== undefined),
        command,
      ).toBe(true);
    }
  });
});

describe("the verifier on the command replay — one more call on every write-class bind (record 0044)", () => {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  const menu = routableCommands(registry);
  const defs = menu.map((c) => c.def);
  const byId = new Map(menu.map((c) => [c.id, c.def]));
  const presets = routablePresets();
  const allowed = presets.map((p) => p.name);
  const byText = new Map(ROUTE_COMMAND_EXAMPLES.map((e) => [e.text, e]));
  const textOf = (prompt: { user: string }) => /<request>\n([\s\S]*)\n<\/request>/.exec(prompt.user)![1]!;
  const lineOf = (prompt: { user: string }) => /^The line the router bound it to: (.*)$/m.exec(prompt.user)![1]!;
  const pick = (...ids: string[]) => ids.map((id) => ROUTE_COMMAND_EXAMPLES.find((e) => e.id === id)!);
  const fixture = (id: string) => ROUTE_COMMAND_FIXTURES.find((f) => f.id === id)!;
  const now = () => 0;

  /** An input spelled the way a tool call carries it: one object, argument
   *  names beside camelCase options. */
  const namedOf = (commandId: string, input: CommandInput): Record<string, unknown> => {
    const def = byId.get(commandId)!;
    const named: Record<string, unknown> = { ...(input.options ?? {}) };
    (def.args ?? []).forEach((arg, i) => {
      const v = (input.args ?? [])[i];
      if (v !== undefined) named[arg.name] = v;
    });
    return named;
  };

  /** A router that binds every fixture to its own command and input, routes
   *  every decoy to general, and binds the examples `binds` names as it says
   *  — a wrong command, a wrong input, a decoy bound to a write. */
  const router = (binds: Record<string, { command: string; input: CommandInput }> = {}) => {
    const model: RouteModel = async (prompt) => {
      const example = byText.get(textOf(prompt))!;
      const bind =
        binds[example.id] ??
        (example.kind === "decoy" ? undefined : { command: example.command, input: example.input });
      if (bind === undefined) return JSON.stringify({ preset: "general", reason: "a judgement, not a command" });
      return { tool: mcpToolName(bind.command), input: namedOf(bind.command, bind.input) };
    };
    return (text: string, facts?: RouteFacts): Promise<RouteDecision> =>
      route(
        {
          text,
          recentDirectives: {},
          presets,
          allowed,
          fallback: "general",
          commands: menu,
          ...facts,
        },
        model,
      );
  };

  /** A verifier that answers `agrees(line, text)` through the forced call and
   *  remembers every prompt it was handed. */
  const verifier = (agrees: (line: string, text: string) => boolean) => {
    const prompts: RoutePrompt[] = [];
    const model: RouteModel = async (prompt) => {
      prompts.push(prompt);
      return { tool: VERIFY_TOOL_NAME, input: { agrees: agrees(lineOf(prompt), textOf(prompt)), reason: "scripted" } };
    };
    return { model, prompts };
  };

  it("is asked only about a write- or destructive-class bind — a read bind, an exec bind and an unbound decoy never reach it — and the call carries the sentence and the bound chat line; nothing is invoked", async () => {
    const invoke = vi.spyOn(registry, "invoke");
    const examples = pick("c01h", "c21h", "c06h", "c10h", "c09d");
    const results = await replayCommands(examples, router(), { now }, defs);
    expect(results.map((r) => r.bound?.id)).toEqual(["help.show", "repo.test", "config.set", "runs.stop", undefined]);
    const v = verifier(() => true);
    const verified = await verifyCommands(results, v.model, defs, { now });
    expect(v.prompts.map(textOf)).toEqual([fixture("c06h").text, fixture("c10h").text]);
    expect(lineOf(v.prompts[0]!)).toBe(chatInvocation(byId.get("config.set")!, fixture("c06h").input));
    expect(lineOf(v.prompts[1]!)).toBe("runs stop r-123 --mode soft");
    expect(verified.map((r) => r.id)).toEqual(examples.map((e) => e.id));
    expect(verified.map((r) => r.verdict?.agrees)).toEqual([undefined, undefined, true, true, undefined]);
    expect(verified[2]!.verdict).toEqual({ agrees: true, reason: "scripted", line: lineOf(v.prompts[0]!), ms: 0 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a wrong write bind the verifier rejects is a write misbind removed; a right write bind it rejects is a correct bind rejected; a bind it agrees with is neither; a read bind enters no count", async () => {
    // c06h bound to config.clear — a write, the wrong command; c07h and c10h bound right; c01h a read.
    const results = await replayCommands(
      pick("c01h", "c06h", "c07h", "c10h"),
      router({ c06h: { command: "config.clear", input: { args: ["channel"], options: {} } } }),
      { now },
      defs,
    );
    expect(commandScore(results).misses.map((m) => m.id)).toEqual(["c06h"]);
    const v = verifier((line) => !line.startsWith("config clear"));
    const score = verifierScore(await verifyCommands(results, v.model, defs, { now }));
    expect(v.prompts).toHaveLength(3);
    expect(score).toMatchObject({ asked: 3, misbinds: 1, misbindsRemoved: 1, correct: 2, correctRejected: 1 });
    expect(score.removedRate).toBe(1);
    expect(score.rejectedRate).toBe(0.5);
    expect(score.rejected.map((r) => r.id)).toEqual(["c06h", "c07h"]);
  });

  it("a decoy bound to a write outside its allow list and a right command with the wrong post-parse input are write misbinds too: the verifier removing them counts, agreeing with them counts nothing", async () => {
    const results = await replayCommands(
      pick("c06d", "c10h", "c06h"),
      router({
        c06d: { command: "config.set", input: { args: ["channel"], options: { models: { coding: "any/model" } } } },
        c10h: { command: "runs.stop", input: { args: ["r-123"], options: { mode: "hard" } } },
      }),
      { now },
      defs,
    );
    expect(commandScore(results).misses.map((m) => m.id)).toEqual(["c06d", "c10h"]);
    const removing = verifier((_line, text) => text === fixture("c06h").text);
    expect(verifierScore(await verifyCommands(results, removing.model, defs, { now }))).toMatchObject({
      asked: 3,
      misbinds: 2,
      misbindsRemoved: 2,
      correct: 1,
      correctRejected: 0,
    });
    const agreeing = verifier(() => true);
    expect(verifierScore(await verifyCommands(results, agreeing.model, defs, { now }))).toMatchObject({
      asked: 3,
      misbinds: 2,
      misbindsRemoved: 0,
      correct: 1,
      correctRejected: 0,
      rejected: [],
    });
  });

  it("a verifier that fails, calls another tool or answers prose is a disagreement naming why — never a silent agreement — so a broken verifier shows as rejections on the line", async () => {
    const results = await replayCommands(pick("c06h", "c07h", "c10h"), router(), { now }, defs);
    const answers: Array<() => Promise<RouteToolCall | string>> = [
      async () => {
        throw new Error("boom");
      },
      async () => ({ tool: "route", input: { preset: "general", reason: "x" } }),
      async () => "yes, looks right",
    ];
    let i = 0;
    const broken: RouteModel = async () => answers[i++]!();
    const verified = await verifyCommands(results, broken, defs, { now, concurrency: 1 });
    expect(verified.map((r) => r.verdict?.agrees)).toEqual([false, false, false]);
    expect(verified[0]!.verdict!.reason).toBe("verifier failed: boom");
    expect(verified[1]!.verdict!.reason).toMatch(/verifier called tool "route", not verify/);
    expect(verified[2]!.verdict!.reason).toMatch(/not a single JSON object: yes, looks right/);
    expect(verifierScore(verified)).toMatchObject({ asked: 3, misbinds: 0, correct: 3, correctRejected: 3 });
  });

  it("the line beside the command rows: removed n of m write misbinds · rejected k of j correct write binds, the two ratios, the record's bar named and not judged, and every rejected bind with its reason", async () => {
    const results = await replayCommands(
      pick("c06h", "c07h", "c10h", "c24h"),
      router({ c06h: { command: "config.clear", input: { args: ["channel"], options: {} } } }),
      { now },
      defs,
    );
    const v = verifier((line) => !line.startsWith("config clear"));
    const lines = renderVerifier(verifierScore(await verifyCommands(results, v.model, defs, { now })));
    expect(lines[0]).toBe(
      "verifier: removed 1 of 1 write misbinds · rejected 1 of 3 correct write binds (4 write-class binds asked; removed 100%, rejected 33.3%; the bar for the production decision is at least half removed under one in twenty rejected — not judged here)",
    );
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("rejected (2):");
    expect(lines[3]).toBe(
      `- c06h: happy, a misbind — bound config clear channel, expected config.set {"args":["channel"],"options":{"models":{"coding":"anthropic/claude-opus-5"}}} — scripted — "${fixture("c06h").text}"`,
    );
    expect(lines[4]).toBe(
      `- c07h: happy, a correct bind — bound config clear me — scripted — "${fixture("c07h").text}"`,
    );
    expect(lines).toHaveLength(5);
  });

  it("no write-class bind in the run: the verifier is never called, both counters read zero and the line still prints", async () => {
    const results = await replayCommands(pick("c01h", "c09h", "c21h", "c09d"), router(), { now }, defs);
    const v = verifier(() => false);
    const score = verifierScore(await verifyCommands(results, v.model, defs, { now }));
    expect(v.prompts).toHaveLength(0);
    expect(score).toEqual({
      asked: 0,
      misbinds: 0,
      misbindsRemoved: 0,
      removedRate: NaN,
      correct: 0,
      correctRejected: 0,
      rejectedRate: NaN,
      rejected: [],
    });
    expect(renderVerifier(score)).toEqual([
      "verifier: removed 0 of 0 write misbinds · rejected 0 of 0 correct write binds (0 write-class binds asked; removed —, rejected —; the bar for the production decision is at least half removed under one in twenty rejected — not judged here)",
      "",
      "rejected: none",
    ]);
  });

  it("one verifier call rides the router's seam — providerRouteModel forces the verify tool alone, the prompt's two halves as system and the one user turn — so the tallying provider counts it beside the router's calls", async () => {
    const counters = emptyCounters();
    const requests: CompletionRequest[] = [];
    const inner: Provider = {
      name: "fake",
      complete: async (req) => {
        requests.push(req);
        return {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: VERIFY_TOOL_NAME,
              input: { agrees: true, reason: "the same command and value" },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    const model = providerRouteModel(tallyingProvider(inner, counters), "fast-model");
    const set = fixture("c06h");
    const verdict = await verifyBind(set.text, byId.get("config.set")!, set.input, model);
    expect(verdict).toEqual({ agrees: true, reason: "the same command and value", line: lineOfSet() });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools?.map((t) => t.name)).toEqual([VERIFY_TOOL_NAME]);
    expect(requests[0]!.toolChoice).toEqual({ type: "tool", name: VERIFY_TOOL_NAME });
    expect(requests[0]!.system).toMatch(/^You check one binding\./);
    expect(requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: `<request>\n${set.text}\n</request>\n\nThe line the router bound it to: ${lineOfSet()}` },
    ]);
    expect(counters).toMatchObject({ calls: 1, inputTokens: 10 });
    function lineOfSet() {
      return chatInvocation(byId.get("config.set")!, set.input);
    }
  });
});

describe("the counters line — cost, caching and the two-call refusals", () => {
  const completion = (
    usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
    tools = 1,
  ) => ({
    content: Array.from({ length: tools }, (_, i) => ({
      type: "tool_use" as const,
      id: `t${i}`,
      name: "route",
      input: {},
    })),
    stopReason: "tool_use" as const,
    usage: { outputTokens: 5, ...usage },
  });

  it("sums the three usage fields over the calls, counts a two-call answer, and renders the means and the refusal count", async () => {
    const counters = emptyCounters();
    const inner: Provider = {
      name: "fake",
      complete: vi
        .fn()
        .mockResolvedValueOnce(completion({ inputTokens: 100, cacheWriteTokens: 90 }))
        .mockResolvedValueOnce(completion({ inputTokens: 100, cacheReadTokens: 80 }))
        .mockResolvedValueOnce(completion({ inputTokens: 40 }, 2)),
    };
    const tallied = tallyingProvider(inner, counters);
    const req = { model: "m", messages: [], maxTokens: 1 } as never;
    await tallied.complete(req);
    await tallied.complete(req);
    await tallied.complete(req);
    expect(counters).toEqual({
      calls: 3,
      inputTokens: 240,
      cacheReadTokens: 80,
      cacheWriteTokens: 90,
      twoCallAnswers: 1,
    });
    expect(renderCounters(counters)).toBe(
      "model calls: 3; mean input tokens 80, cache read 27, cache write 30; two-call answers refused: 1",
    );
  });

  it("a provider reporting no usage still counts the call; no calls renders dashes", async () => {
    const counters = emptyCounters();
    const inner: Provider = {
      name: "fake",
      complete: async () => ({ content: [], stopReason: "end_turn" as const }),
    };
    await tallyingProvider(inner, counters).complete({ model: "m", messages: [], maxTokens: 1 } as never);
    expect(counters).toEqual({ calls: 1, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, twoCallAnswers: 0 });
    expect(renderCounters(emptyCounters())).toContain("mean input tokens —");
  });
});
