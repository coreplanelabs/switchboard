import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanText } from "../../scripts/public-hygiene.mjs";
import {
  OPERATOR_BIND_TOOL,
  operatorPresets,
  runOperator,
  type OperatorDecision,
  type OperatorInput,
} from "../core/dispatch/operator.js";
import type { RouteModel } from "../core/dispatch/route.js";
import { ROUTE_ATTACH_FIXTURES } from "./routeAttachFixtures.js";
import { ROUTE_COMPOUND_FIXTURES } from "./routeCompoundFixtures.js";
import { ROUTE_DIRECTIVE_FIXTURES } from "./routeDirectiveFixtures.js";
import { ROUTE_IMPERATIVE_FIXTURES } from "./routeImperativeFixtures.js";
import { ROUTE_MISS_FIXTURES } from "./routeMissFixtures.js";
import { ROUTE_DOOR_FIXTURES } from "./routeDoorFixtures.js";
import {
  compoundExamples,
  compoundScore,
  judgeDoorFixture,
  renderCompound,
  replayCompound,
  replayDoorFixtures,
} from "./routeReplay.js";

const input = (text: string): OperatorInput => ({
  text,
  projection: { presets: operatorPresets(), commands: [] },
  tail: [],
});

const bindModel =
  (preset: string): RouteModel =>
  async () => ({
    tool: OPERATOR_BIND_TOOL,
    input: { preset, reason: "fixture route" },
  });

const boundPreset = (decision: OperatorDecision): string | undefined => {
  if (decision.kind !== "binds") return undefined;
  return /^agent:([^\s]+)/.exec(decision.binds[0]?.line ?? "")?.[1];
};

describe("the door row owns every checked-in routed fixture", () => {
  const cases = [
    ...ROUTE_IMPERATIVE_FIXTURES.map((fixture) => ({
      id: `imperative:${fixture.id}`,
      text: fixture.text,
      preset: fixture.presets[0]!,
    })),
    ...ROUTE_ATTACH_FIXTURES.map((fixture) => ({
      id: `attach:${fixture.id}`,
      text: fixture.text,
      preset: fixture.presets[0]!,
    })),
    ...ROUTE_DIRECTIVE_FIXTURES.map((fixture) => ({
      id: `directive:${fixture.id}`,
      text: fixture.text,
      preset: fixture.presets[0]!,
    })),
    ...ROUTE_MISS_FIXTURES.flatMap((fixture) =>
      fixture.meant === "preset" ? [{ id: `miss:${fixture.id}`, text: fixture.text, preset: fixture.presets[0]! }] : [],
    ),
    ...ROUTE_COMPOUND_FIXTURES.map((fixture) => ({
      id: `compound:${fixture.id}`,
      text: fixture.text,
      preset: fixture.collapsesTo ?? (fixture.kind === "compound" ? "conductor" : fixture.presets[0]!),
    })),
  ];

  it("every existing preset fixture lands through bind_preset without the readers' router", async () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
    for (const fixture of cases) {
      const answer = await runOperator(input(fixture.text), bindModel(fixture.preset));
      expect(boundPreset(answer.decision), fixture.id).toBe(fixture.preset);
      expect(answer.decision, fixture.id).toMatchObject({ reason: "fixture route" });
    }
  });

  it("a no-call turn is re-asked once and the second no-call lands on general with no_decision recorded", async () => {
    const fixture = ROUTE_DOOR_FIXTURES.find((row) => row.defect === "D14")!;
    let calls = 0;
    const answer = await runOperator(input(fixture.text), async () => {
      calls++;
      return "I do not have an action";
    });
    expect(calls).toBe(2);
    expect(answer.decision).toMatchObject({
      kind: "binds",
      reason: "no_decision",
      binds: [{ line: `agent:general ${fixture.text}`, reason: "no_decision" }],
    });
    expect(judgeDoorFixture(answer.decision, fixture)).toMatchObject({ hit: true, reason: "no_decision" });
    const replayed = await replayDoorFixtures([fixture], async () => answer.decision, { now: () => 0 });
    expect(replayed).toMatchObject([{ hit: true, outcome: "binds", reason: "no_decision" }]);
  });
});

describe("the compound row scores the one door's typed conductor bind", () => {
  it("counts conductor as detection without retired router parts", async () => {
    const fixture = ROUTE_COMPOUND_FIXTURES.find((row) => row.kind === "compound" && row.collapsesTo === undefined)!;
    const results = await replayCompound(
      compoundExamples([fixture]),
      async () => ({ preset: "conductor", reason: "independent asks" }),
      { now: () => 0 },
    );

    expect(results).toMatchObject([
      {
        id: fixture.id,
        routed: "conductor",
        detected: true,
        collapsed: false,
      },
    ]);
    expect(compoundScore(results)).toMatchObject({ compounds: 1, detected: 1, misses: [] });
    expect(renderCompound(compoundScore(results))[0]).toBe(
      "compound: bound conductor 1/1 (100%), collapsed to its write preset 0/0, decoys bound conductor 0/0",
    );
  });
});

describe("public hygiene over every replay fixture file", () => {
  it("no fixture file carries a name, tracker, plan id, platform id or current date", () => {
    for (const path of [
      "routeAttachFixtures.ts",
      "routeCommandFixtures.ts",
      "routeCompoundFixtures.ts",
      "routeDirectiveFixtures.ts",
      "routeDoorFixtures.ts",
      "routeImperativeFixtures.ts",
      "routeMissFixtures.ts",
      "routePlantedFixtures.ts",
      "routeWriteFixtures.ts",
    ]) {
      const text = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(scanText(`src/load/${path}`, text, new Set()).counts, path).toEqual({});
    }
  });
});
