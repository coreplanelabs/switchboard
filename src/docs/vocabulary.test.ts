import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declaredRegions } from "./regions.js";
import {
  renderVocabularyTable,
  VOCABULARY_REGIONS,
  VOCABULARY_ROWS,
  type CarrierRef,
  type VocabularyRow,
} from "./vocabulary.js";

const NOUNS_IN_SCHEMA_ORDER = [
  "thread",
  "run",
  "agent",
  "pipeline",
  "unit",
  "round",
  "budget",
  "follow-up",
  "verdict",
  "outcome",
  "card",
  "pull request",
] as const;

const refsOf = (row: VocabularyRow): CarrierRef[] =>
  row.carriedBy.filter((p): p is CarrierRef => typeof p !== "string");

describe("renderVocabularyTable", () => {
  it("renders one row per noun in schema order", () => {
    const table = renderVocabularyTable(VOCABULARY_ROWS).split("\n");
    expect(table[0]).toBe("| Noun | Meaning | Holds | Belongs to | Carried by | Printed by |");
    const rows = table.slice(2);
    expect(rows).toHaveLength(NOUNS_IN_SCHEMA_ORDER.length);
    for (const [i, noun] of NOUNS_IN_SCHEMA_ORDER.entries()) {
      expect(rows[i]).toContain(`<a id="${VOCABULARY_ROWS[i]!.anchor}"></a>**${noun}**`);
    }
  });

  it("a row names the carrying type it imports", () => {
    // Every row's cell holds at least one CarrierRef — a key of the import-typed
    // `Carriers` interface, so the name cannot drift from the type — and the
    // rendered cell prints exactly that name as a code span.
    for (const row of VOCABULARY_ROWS) {
      const refs = refsOf(row);
      expect(refs.length, `${row.noun} carries no type reference`).toBeGreaterThan(0);
      const rendered = renderVocabularyTable([row]);
      for (const ref of refs) expect(rendered).toContain(`\`${ref.type}\``);
    }
  });

  it("states each type's file where the row gives one", () => {
    const rendered = renderVocabularyTable(VOCABULARY_ROWS);
    expect(rendered).toContain("`RunSummary` (`src/core/runRegistry/projections.ts`)");
    expect(rendered).toContain("`PlanePullRequestRow` (`src/core/plane/table.ts`)");
  });
});

describe("VOCABULARY_REGIONS", () => {
  it("matches the markers actually present in the vocabulary page (a renamed marker fails here, not silently)", () => {
    for (const [file, regions] of Object.entries(VOCABULARY_REGIONS)) {
      const text = readFileSync(new URL(`../../docs/${file}`, import.meta.url), "utf8");
      expect(declaredRegions(text).sort()).toEqual(Object.keys(regions).sort());
    }
  });
});
