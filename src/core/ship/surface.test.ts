import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Feature: docs/reference/specs/agent-ship.md — one ship implementation. Every
// `agent:ship` request hands to the plan runner, so the in-process round loop
// and the child rounds it ran are gone from the tree: `shipPipeline.ts` keeps
// the `ship` config block, the caps, the preset and the round header; the
// child modules under `src/core/ship/` keep only the prompt blocks the runner's
// spawn route composes a child's turn from. A source scan, because the
// property is "this code does not exist", which no behavioural test can hold.

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "..");
const read = (rel: string) => readFileSync(join(core, rel), "utf8");

/** Every `export` name a module declares, in source order — declarations and `export { … }` lists alike. */
function exportsOf(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^export (?:async )?(?:function|const|let|class|interface|type|enum) (\w+)/gm))
    names.push(m[1]!);
  for (const m of source.matchAll(/^export \{([^}]*)\}/gm))
    for (const part of m[1]!.split(","))
      names.push(
        part
          .trim()
          .replace(/^type /, "")
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      );
  return names.filter((n) => n.length > 0);
}

describe("the ship modules after the round loop's retirement — a source scan", () => {
  it("shipPipeline.ts keeps the config block, the caps, the preset and the round header, and nothing of the loop", () => {
    const src = read("shipPipeline.ts");
    expect(exportsOf(src).sort()).toEqual(
      [
        "ShipConfig",
        "shipInterruptedNote",
        "ShipCaps",
        "SHIP_DEFAULT_MAX_ROUNDS",
        "SHIP_DEFAULT_MAX_MINUTES",
        "resolveShipCaps",
        "shipPresetFor",
        "shipRoundHeader",
      ].sort(),
    );
    for (const gone of [
      "runShipPipeline",
      "runRounds",
      "ShipPipelineInput",
      "ShipOutcome",
      "ShipGithub",
      "coordinator?",
    ])
      expect(src, `${gone} is gone`).not.toContain(gone);
    expect(src).not.toMatch(/from "\.\/ship\/(codingChild|reviewChild|childRound)\.js"/);
  });

  it("the child modules export only the prompt blocks the spawn route composes a child's turn from", () => {
    expect(existsSync(join(core, "ship/childRound.ts"))).toBe(false);
    const coding = read("ship/codingChild.ts");
    const review = read("ship/reviewChild.ts");
    expect(exportsOf(coding)).toEqual(["buildShipFixTurn", "withContractInFirstUserTurn"]);
    expect(exportsOf(review)).toEqual(["buildShipReviewTurn"]);
    for (const src of [coding, review]) {
      expect(src).not.toMatch(/runner\.js"/);
      expect(src).not.toMatch(/reviewRound\.js"/);
      expect(src).not.toMatch(/codingPrPostStep\.js"/);
      expect(src).not.toContain("runShipCodingChild");
      expect(src).not.toContain("runShipReviewChild");
    }
  });

  it("the ship branch hands every request to the runner: it imports the hand-off and no loop, and reads no switch", () => {
    const src = read("dispatch/ship.ts");
    expect(src).toContain("handOffToCoordinator");
    expect(src).not.toContain("runShipPipeline");
    expect(src).not.toMatch(/ship\?\.coordinator|ship\.coordinator/);
    expect(src).not.toMatch(/from "\.\.\/ship\/(codingChild|reviewChild|childRound)\.js"/);
  });
});
