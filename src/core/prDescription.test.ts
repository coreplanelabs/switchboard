import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERATED_FOOTER,
  anchorUrl,
  parsePrDescription,
  renderPrDescriptionMarkdown,
  type PrDescription,
} from "./prDescription.js";

// Feature: features/pr-description.md — the PR description is data; the GitHub
// body is one rendering of it. The fixture is PR #329's own description and
// the golden file is the body that PR carries, so the pipeline is exercised
// end to end on a real PR, not a toy.

const CTX = { repo: "coreplanelabs/switchboard", headSha: "685c471f31feaadd725fb917b68a2eea31c0f81a" };

function desc(over: Partial<PrDescription> = {}): PrDescription {
  return {
    title: "A test PR title",
    tldr: "Two sentences.",
    whatWhy: "Because.",
    tour: [{ title: "The thing", description: "What it does.", anchor: { path: "src/a.ts", from: 3, to: 9 } }],
    remaining: [],
    decisions: [{ title: "Chose X", rationale: "Y was worse." }],
    risks: "None — prompt only.",
    validation: { criteria: [{ criterion: "It renders", proof: "`[unit]` this test" }] },
    ...over,
  };
}

describe("parsePrDescription (the schema)", () => {
  it("accepts a complete description and normalizes whitespace on lines", () => {
    const d = parsePrDescription({ ...desc(), tldr: "  Two sentences.  " });
    expect(d.tldr).toBe("Two sentences.");
  });

  it("requires a title — the PR title's single source; missing or blank is rejected naming the field", () => {
    const { title: _t, ...noTitle } = desc();
    expect(() => parsePrDescription(noTitle)).toThrow(/title/);
    expect(() => parsePrDescription({ ...desc(), title: "   " })).toThrow(/title/);
    expect(parsePrDescription({ ...desc(), title: "  Fix the gate  " }).title).toBe("Fix the gate");
  });

  it("rejects an embedded newline on a `line` field — a multi-line PR title would split the `### N.` headings and go verbatim into the PR's own title", () => {
    const badTitle = () => parsePrDescription({ ...desc(), title: "Fix the gate\nand also the fence" });
    expect(badTitle).toThrow(/single line/);
    expect(badTitle).toThrow(/title/); // the zod error names the offending path
    expect(() => parsePrDescription({ ...desc(), title: "Fix\r\nthe gate" })).toThrow(/single line/);
    const badStep = () =>
      parsePrDescription({
        ...desc(),
        tour: [{ title: "The\nthing", description: "d", anchor: { path: "src/a.ts", from: 1, to: 2 } }],
      });
    expect(badStep).toThrow(/single line/);
    expect(badStep).toThrow(/tour/); // …for tour-step titles too
  });

  it("rejects an empty tour, missing sections, and empty strings", () => {
    expect(() => parsePrDescription({ ...desc(), tour: [] })).toThrow(/tour/);
    const { risks: _r, ...noRisks } = desc();
    expect(() => parsePrDescription(noRisks)).toThrow(/risks/);
    expect(() => parsePrDescription({ ...desc(), tldr: "   " })).toThrow(/tldr/);
    expect(() => parsePrDescription({ ...desc(), decisions: [] })).toThrow(/decisions/);
    expect(() => parsePrDescription({ ...desc(), validation: { criteria: [] } })).toThrow(/criteria/);
  });

  it("rejects a bad anchor: absolute or traversing path, non-positive lines, to < from", () => {
    const step = (anchor: Record<string, unknown>) => ({ ...desc(), tour: [{ title: "t", description: "d", anchor }] });
    expect(() => parsePrDescription(step({ path: "/etc/passwd", from: 1, to: 2 }))).toThrow(/repo-relative/);
    expect(() => parsePrDescription(step({ path: "../x.ts", from: 1, to: 2 }))).toThrow(/repo-relative/);
    expect(() => parsePrDescription(step({ path: "a.ts", from: 0, to: 2 }))).toThrow(/from/);
    expect(() => parsePrDescription(step({ path: "a.ts", from: 5, to: 2 }))).toThrow(/to must be >= from/);
    // `..` is rejected as a SEGMENT only — a filename containing dots is legitimate (review nit).
    expect(parsePrDescription(step({ path: "src/a..b.ts", from: 1, to: 2 })).tour[0].anchor.path).toBe("src/a..b.ts");
    expect(() => parsePrDescription(step({ path: "src/../x.ts", from: 1, to: 2 }))).toThrow(/repo-relative/);
  });
});

describe("renderPrDescriptionMarkdown", () => {
  it("renders every section as a ## heading in the contract order, TL;DR first", () => {
    const md = renderPrDescriptionMarkdown(desc(), CTX);
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## TL;DR",
      "## What & why",
      "## Tour",
      "## Decisions",
      "## Risks & implications",
      "## Validation",
    ]);
    expect(md.startsWith("## TL;DR\n\nTwo sentences.\n")).toBe(true);
    expect(md.trimEnd().endsWith(GENERATED_FOOTER)).toBe(true);
  });

  it("the title is metadata for the PR's own title field — never rendered into the body", () => {
    const md = renderPrDescriptionMarkdown(desc({ title: "UNIQUE-TITLE-NEVER-IN-BODY" }), CTX);
    expect(md).not.toContain("UNIQUE-TITLE-NEVER-IN-BODY");
  });

  it("a Tour step is `### N. title` → description → optional Look for → permalink LAST, numbered from 1", () => {
    const md = renderPrDescriptionMarkdown(
      desc({
        tour: [
          { title: "First", description: "One.", lookFor: "the guard", anchor: { path: "src/a.ts", from: 3, to: 9 } },
          { title: "Second", description: "Two.", anchor: { path: "src/b.ts", from: 10, to: 10 } },
        ],
      }),
      CTX,
    );
    expect(md).toContain(
      "### 1. First\n\nOne.\n\n**Look for:** the guard\n\nhttps://github.com/coreplanelabs/switchboard/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/a.ts#L3-L9\n\n### 2. Second\n\nTwo.\n\nhttps://github.com/coreplanelabs/switchboard/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/b.ts#L10-L10\n\n### 3. Remaining changes",
    );
  });

  it("anchors take the sha from the render context — a repush is a re-render, never an edit of the data", () => {
    const d = desc();
    const a = renderPrDescriptionMarkdown(d, CTX);
    const b = renderPrDescriptionMarkdown(d, { ...CTX, headSha: "a".repeat(40) });
    expect(a).not.toBe(b);
    expect(b).toContain(`/blob/${"a".repeat(40)}/src/a.ts#L3-L9`);
    expect(anchorUrl(CTX, { path: "x/y.ts", from: 1, to: 2 })).toBe(
      `https://github.com/coreplanelabs/switchboard/blob/${CTX.headSha}/x/y.ts#L1-L2`,
    );
  });

  it("percent-encodes path segments (a space or `#` in a filename would break the link), keeping `/` as the separator", () => {
    expect(anchorUrl(CTX, { path: "docs/my file#1.md", from: 1, to: 2 })).toBe(
      `https://github.com/coreplanelabs/switchboard/blob/${CTX.headSha}/docs/my%20file%231.md#L1-L2`,
    );
  });

  it("refuses a short sha or a non owner/name repo (a branch or short ref would not embed as code)", () => {
    expect(() => renderPrDescriptionMarkdown(desc(), { ...CTX, headSha: "5bf806a" })).toThrow(/full 40-char/);
    expect(() => renderPrDescriptionMarkdown(desc(), { ...CTX, headSha: "coding/pr-tour-template" })).toThrow(
      /full 40-char/,
    );
    expect(() => renderPrDescriptionMarkdown(desc(), { ...CTX, repo: "https://github.com/a/b" })).toThrow(
      /owner\/name/,
    );
  });

  it("Remaining changes lists each file with its note, or says none is left", () => {
    expect(renderPrDescriptionMarkdown(desc(), CTX)).toContain(
      "### 2. Remaining changes\n\n- none — every touched file is covered by a step above\n",
    );
    const md = renderPrDescriptionMarkdown(desc({ remaining: [{ path: "package.json", note: "new script" }] }), CTX);
    expect(md).toContain("### 2. Remaining changes\n\n- `package.json` — new script\n");
  });

  it("decisions read `- **Title.** rationale` (one trailing period, never two); validation is an optional summary + a criterion/proof table with pipes escaped", () => {
    const md = renderPrDescriptionMarkdown(
      desc({
        decisions: [
          { title: "No period", rationale: "R1." },
          { title: "Has period.", rationale: "R2." },
        ],
        validation: {
          summary: "All green.",
          criteria: [
            { criterion: "a | b", proof: "multi\nline" },
            { criterion: "literal \\| stays literal", proof: "C:\\path" },
          ],
        },
      }),
      CTX,
    );
    expect(md).toContain("- **No period.** R1.\n- **Has period.** R2.\n");
    expect(md).toContain("## Validation\n\nAll green.\n\n| Criterion | Proof |\n|---|---|\n| a \\| b | multi line |\n");
    // A backslash in the input is escaped before the pipe is, so `\|` in a cell
    // renders as the two literal characters, not as an escaped-escape + row split.
    expect(md).toContain("| literal \\\\\\| stays literal | C:\\\\path |\n");
  });
});

// The golden: PR #329's description as data renders to the exact body #329
// carries. `scripts/render-pr-description.ts` produced the golden file from the
// same fixture, and `gh pr edit --body-file` put it on the PR — so the PR body,
// the golden file, and this assertion are one artifact by construction.
describe("golden: PR #329 rendered through the pipeline", () => {
  it("fixture → markdown equals the checked-in body byte for byte", () => {
    const fixture = parsePrDescription(
      JSON.parse(readFileSync(new URL("./testing/pr329.description.json", import.meta.url), "utf8")),
    );
    const golden = readFileSync(new URL("./testing/pr329.body.md", import.meta.url), "utf8");
    expect(renderPrDescriptionMarkdown(fixture, CTX)).toBe(golden);
  });
});
