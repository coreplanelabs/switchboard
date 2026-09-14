import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import type { RunEvent } from "../core/runEvents.js";
import { routablePresets, route, type RouteDecision, type RouteModel } from "../core/dispatch/route.js";
import { ROUTE_COMPOUND_FIXTURES } from "./routeCompoundFixtures.js";
import { ROUTE_IMPERATIVE_FIXTURES } from "./routeImperativeFixtures.js";
import {
  compoundExamples,
  compoundScore,
  confusionTable,
  historyCompounds,
  imperativeScore,
  labelledRequests,
  NO_ROUTE,
  readToWriteRoutes,
  renderCompound,
  renderConfusion,
  renderImperative,
  replayCompound,
  replayImperative,
  replayRoutes,
  routeChecks,
  type CompoundExample,
  type ReplayRequest,
  type ReplayResult,
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
    // Every part preset is a row of the table — ship and conductor never.
    expect(ROUTE_COMPOUND_FIXTURES.flatMap((f) => f.presets)).not.toContain("ship");
    expect(ROUTE_COMPOUND_FIXTURES.flatMap((f) => f.presets)).not.toContain("conductor");
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
    { id: "d1", kind: "decoy", text: "clone, test, report", presets: ["explore"], source: "fixture" },
    { id: "d2", kind: "decoy", text: "fix it: reproduce, patch, prove", presets: ["coding"], source: "fixture" },
  ];
  const split = (presets: string[], reason = "independent"): RouteDecision => ({
    preset: "conductor",
    reason,
    parts: presets.map((preset, i) => ({ preset, text: `part ${i + 1}` })),
  });
  const single = (preset: string): RouteDecision => ({ preset, reason: "one ask" });

  it("a perfect router: every compound detected with its parts, no decoy split, every part preset right", async () => {
    const results = await replayCompound(
      examples,
      async (text) => {
        const e = examples.find((x) => x.text === text)!;
        return e.kind === "compound" ? split([...e.presets]) : single(e.presets[0]);
      },
      { now: () => 0 },
    );
    expect(results.map((r) => [r.id, r.detected, r.matchedParts, r.expectedParts])).toEqual([
      ["c1", true, 2, 2],
      ["c2", true, 2, 2],
      ["c3", true, 3, 3],
      ["d1", false, 0, 0],
      ["d2", false, 0, 0],
    ]);
    const score = compoundScore(results);
    expect(score).toMatchObject({
      compounds: 3,
      detected: 3,
      detectionRate: 1,
      decoys: 2,
      decoysSplit: 0,
      expectedParts: 7,
      matchedParts: 7,
      partAccuracy: 1,
      misses: [],
    });
    expect(renderCompound(score)[0]).toBe("compound: detected 3/3 (100%), decoys split 0/2, part presets 7/7 (100%)");
    expect(renderCompound(score)).toContain("misses: none");
  });

  it("a fallible router: a compound left single is a miss, a decoy split is a miss, a part on the wrong preset counts against the parts and lists the miss; order is kept and the decision timed", async () => {
    let t = 0;
    const answers: Record<string, RouteDecision> = {
      c1: single("review"), // not detected
      c2: split(["coding", "research"]), // detected, one part off (review → research)
      c3: split(["general", "research", "explore"]), // right
      d1: split(["explore", "general"]), // a decoy split
      d2: single("coding"),
    };
    const results = await replayCompound(examples, async (text) => answers[examples.find((x) => x.text === text)!.id], {
      now: () => (t += 5),
      concurrency: 1,
    });
    expect(results.map((r) => r.id)).toEqual(["c1", "c2", "c3", "d1", "d2"]);
    expect(results.every((r) => r.ms === 5)).toBe(true);
    const score = compoundScore(results);
    expect(score).toMatchObject({
      compounds: 3,
      detected: 2,
      decoys: 2,
      decoysSplit: 1,
      expectedParts: 7,
      matchedParts: 4, // c1 undetected contributes none of its two; c2 one of two; c3 three
    });
    expect(score.detectionRate).toBeCloseTo(2 / 3);
    expect(score.partAccuracy).toBeCloseTo(4 / 7);
    expect(score.misses.map((m) => m.id)).toEqual(["c1", "c2", "d1"]);
    const lines = renderCompound(score);
    expect(lines[0]).toBe("compound: detected 2/3 (66.7%), decoys split 1/2, part presets 4/7 (57.1%)");
    expect(lines).toContain("misses (3):");
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
    expect(score).toMatchObject({ compounds: 2, detected: 1, expectedParts: 0, matchedParts: 0 });
    expect(score.partAccuracy).toBeNaN();
    expect(renderCompound(score)[0]).toBe("compound: detected 1/2 (50%), decoys split 0/0, part presets 0/0 (—)");
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
      "compound: detected 0/0 (—), decoys split 0/0, part presets 0/0 (—)",
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

  it("a router that answers every fixture as labelled: 20/20 detected, 0/5 decoys split, every part preset right — the bar met", async () => {
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
    const score = compoundScore(results);
    const expectedParts = ROUTE_COMPOUND_FIXTURES.filter((f) => f.kind === "compound").reduce(
      (n, f) => n + f.presets.length,
      0,
    );
    expect(score).toMatchObject({
      compounds: 20,
      detected: 20,
      detectionRate: 1,
      decoys: 5,
      decoysSplit: 0,
      expectedParts,
      matchedParts: expectedParts,
      partAccuracy: 1,
      misses: [],
    });
    expect(renderCompound(score)[0]).toBe(
      `compound: detected 20/20 (100%), decoys split 0/5, part presets ${expectedParts}/${expectedParts} (100%)`,
    );
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

  it("is twenty terse imperatives expecting a write preset, five read-only decoys expecting research or general, five review-shaped asks expecting review; every preset a row of the table, every id unique", () => {
    const imperatives = ROUTE_IMPERATIVE_FIXTURES.filter((f) => f.kind === "imperative");
    const decoys = ROUTE_IMPERATIVE_FIXTURES.filter((f) => f.kind === "decoy");
    const reviews = ROUTE_IMPERATIVE_FIXTURES.filter((f) => f.kind === "review");
    expect(imperatives).toHaveLength(20);
    expect(decoys).toHaveLength(5);
    expect(reviews).toHaveLength(5);
    for (const f of imperatives) expect(f.presets, f.id).toEqual(writers);
    for (const f of decoys) expect([...f.presets].sort(), f.id).toEqual(["general", "research"]);
    for (const f of reviews) expect(f.presets, f.id).toEqual(["review"]);
    for (const f of ROUTE_IMPERATIVE_FIXTURES) {
      // Terse: the point of the set is the ask with no detail to route on.
      expect(f.text.trim().length, f.id).toBeGreaterThan(5);
      expect(f.text.trim().length, f.id).toBeLessThanOrEqual(80);
      for (const preset of f.presets) expect(names, `${f.id}: ${preset}`).toContain(preset);
    }
    expect(new Set(ROUTE_IMPERATIVE_FIXTURES.map((f) => f.id)).size).toBe(ROUTE_IMPERATIVE_FIXTURES.length);
    // The one real misroute the replay at the flip found is on the set, verbatim.
    expect(imperatives.map((f) => f.text)).toContain("looks like the ci failed, fix it");
  });
});

describe("the imperative set through route() over a scripted model", () => {
  const presets = routablePresets();
  const allowed = presets.map((p) => p.name);
  const byText = new Map(ROUTE_IMPERATIVE_FIXTURES.map((f) => [f.text, f]));
  const decideWith =
    (model: RouteModel) =>
    (text: string): Promise<RouteDecision> =>
      route({ text, recentDirectives: {}, presets, allowed, fallback: "general", compound: { maxParts: 3 } }, model);
  const textOf = (prompt: { user: string }) => /<request>\n([\s\S]*)\n<\/request>/.exec(prompt.user)![1];

  it("a router that reads the rule: every imperative to coding, every look-alike read-only, every review-shaped ask to review — both rows pass", async () => {
    const knowing: RouteModel = async (prompt) =>
      JSON.stringify({ preset: byText.get(textOf(prompt))!.presets[0], reason: "as the rule says" });
    const results = await replayImperative(ROUTE_IMPERATIVE_FIXTURES, decideWith(knowing), { now: () => 0 });
    const score = imperativeScore(results);
    expect(score).toMatchObject({
      imperatives: 20,
      imperativesHit: 20,
      hitRate: 1,
      lookalikes: 10,
      lookalikesToWrite: 0,
      decoys: 5,
      decoysHit: 5,
      reviews: 5,
      reviewsHit: 5,
      misses: [],
    });
    expect(renderImperative(score)).toEqual([
      "imperatives: 20/20 to coding (100%); look-alikes to a write preset 0/10 (decoys 5/5 read-only as expected, review-shaped 5/5 to review)",
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
    }).filter((c) => /imperative|look-alike/.test(c.name));
    expect(rows.map((c) => [c.pass, c.actual, c.limit])).toEqual([
      [true, "20/20 (100%)", "≥ 90%"],
      [true, "0/10", "0"],
    ]);
  });

  it("a keyword router — fix, ci, tests, build mean coding — gets every imperative but sends the decoys to coding too: the look-alike row is what catches it", async () => {
    const keyword: RouteModel = async (prompt) => {
      const text = textOf(prompt);
      const preset = /\b(pr|pull request)\b/i.test(text)
        ? "review"
        : /fix|ci\b|tests?|build|add|rename|bump|make|green|red|lint|typecheck|docs|version|retries|delete|update/i.test(
              text,
            )
          ? "coding"
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
    }).filter((c) => /imperative|look-alike/.test(c.name));
    expect(rows.map((c) => c.pass)).toEqual([true, false]);
    expect(rows[1].actual).toBe(`${score.lookalikesToWrite}/10`);
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
    expect(renderImperative(score)).toEqual([
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
    });
    expect(checks.map((c) => c.name)).toEqual([
      "routing accuracy ≥ 95% against the presets people typed (record 0026's bar)",
      "every request answered with a preset",
      "read-only labels routed to a write preset: 0 (record 0026's clause)",
      "compound detected on ≥ 90% of the checked-in compound asks",
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
      [false, "0/0 (—)", "≥ 90%"],
      [true, "0/0", "0"],
    ]);
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
