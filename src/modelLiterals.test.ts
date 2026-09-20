// Feature: docs/reference/specs/routing-and-config.md item 2 (invariant 7) —
// every model a run or a tool uses comes from the configuration
// (defaults.models.<preset>, routing.model, intake.model,
// review.readingDiff.meatModel); no production code path defaults to a
// hard-coded Anthropic model. This guard greps the production source for
// vendor model literals so a new one fails verify by file and line. The price
// table (src/core/modelPricing.ts) is the one exemption: prices are keyed by
// the vendor's own model families, and pricing a model is not choosing one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./core/trace/clockScan.mjs";

const ROOT = join(import.meta.dirname, "..");

/** Where a production file may not name an Anthropic model — every extension
 *  `filesUnder`'s walk knows, so a production .mjs/.mts/.vue file under src is
 *  inside the ratchet too. */
const INCLUDE = ["src/**/*.ts", "src/**/*.mts", "src/**/*.mjs", "src/**/*.vue"];

/** Tests, test helpers and fixtures may pin model names; the price table must. */
const EXEMPT = [
  "**/*.test.ts",
  "**/*.test.mts",
  "src/**/testing/**",
  "src/**/fixtures/**",
  "src/**/*Fixture.ts",
  "src/**/*Fixtures.ts",
  "src/core/modelPricing.ts",
];

/** A vendor-qualified ref, or a Claude family name, hard-coded in source. */
const MODEL_LITERAL = /anthropic\/claude-|claude-(?:opus|sonnet|haiku|fable)/;

describe("no hard-coded Anthropic model in production source", () => {
  it(
    "every model comes from the configuration: src carries no anthropic/claude-… ref and no Claude family literal outside the price table and the test/fixture trees",
    { timeout: 60_000 },
    () => {
      const hits: string[] = [];
      for (const file of filesUnder(ROOT, INCLUDE, EXEMPT)) {
        const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (MODEL_LITERAL.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
      expect(hits, "read the model from the configuration instead (routing-and-config.md item 2)").toEqual([]);
    },
  );
});
