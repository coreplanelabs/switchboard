import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERATED_FOOTER,
  anchorUrl,
  parsePrDescription,
  parsePrDescriptionMarkdown,
  renderPrDescriptionMarkdown,
  type PrDescription,
} from "./prDescription.js";

// Feature: docs/reference/specs/pr-description.md — the PR description is data; the GitHub
// body is one rendering of it. The fixture is a real PR's description — the
// PR that introduced the Tour, rewritten onto the fixture repo `acme/api` — and
// the golden file is its rendered body, so the pipeline is exercised end to end
// on a full-sized description, not a toy.

const CTX = { repo: "acme/api", headSha: "685c471f31feaadd725fb917b68a2eea31c0f81a" };

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
      "### 1. First\n\nOne.\n\n**Look for:** the guard\n\nhttps://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/a.ts#L3-L9\n\n### 2. Second\n\nTwo.\n\nhttps://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/b.ts#L10-L10\n\n### 3. Remaining changes",
    );
  });

  it("anchors take the sha from the render context — a repush is a re-render, never an edit of the data", () => {
    const d = desc();
    const a = renderPrDescriptionMarkdown(d, CTX);
    const b = renderPrDescriptionMarkdown(d, { ...CTX, headSha: "a".repeat(40) });
    expect(a).not.toBe(b);
    expect(b).toContain(`/blob/${"a".repeat(40)}/src/a.ts#L3-L9`);
    expect(anchorUrl(CTX, { path: "x/y.ts", from: 1, to: 2 })).toBe(
      `https://github.com/acme/api/blob/${CTX.headSha}/x/y.ts#L1-L2`,
    );
  });

  it("percent-encodes path segments (a space or `#` in a filename would break the link), keeping `/` as the separator", () => {
    expect(anchorUrl(CTX, { path: "docs/my file#1.md", from: 1, to: 2 })).toBe(
      `https://github.com/acme/api/blob/${CTX.headSha}/docs/my%20file%231.md#L1-L2`,
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
          { title: "No period", rationale: "One." },
          { title: "Has period.", rationale: "Two." },
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
    expect(md).toContain("- **No period.** One.\n- **Has period.** Two.\n");
    expect(md).toContain("## Validation\n\nAll green.\n\n| Criterion | Proof |\n|---|---|\n| a \\| b | multi line |\n");
    // A backslash in the input is escaped before the pipe is, so `\|` in a cell
    // renders as the two literal characters, not as an escaped-escape + row split.
    expect(md).toContain("| literal \\\\\\| stays literal | C:\\\\path |\n");
  });
});

// The golden: a real PR's description as data renders to the exact body that
// PR carried. `scripts/render-pr-description.ts` produced the golden file from
// the same fixture, and `gh pr edit --body-file` put it on the PR — so the PR
// body, the golden file, and this assertion are one artifact by construction.
const goldenFixture = () =>
  parsePrDescription(
    JSON.parse(readFileSync(new URL("./testing/goldenTour.description.json", import.meta.url), "utf8")),
  );

describe("golden: a full PR description rendered through the pipeline", () => {
  it("fixture → markdown equals the checked-in body byte for byte", () => {
    const golden = readFileSync(new URL("./testing/goldenTour.body.md", import.meta.url), "utf8");
    expect(renderPrDescriptionMarkdown(goldenFixture(), CTX)).toBe(golden);
  });
});

// Feature: docs/reference/specs/pr-description.md item 6 — the inverse of the renderer: a
// body GitHub holds, read back into the object (what a review run's panel
// gets when the PR was described by a human or an older pipeline). Strict
// where the renderer is strict (a step needs a well-formed permalink), never
// a throw on a body without the shape.
describe("parsePrDescriptionMarkdown — the inverse of the renderer", () => {
  it("golden round trip: tldr, whatWhy, tour (anchors + the render sha), remaining, decisions, risks and validation come back equal; the title is not in the body", () => {
    const fixture = goldenFixture();
    const parsed = parsePrDescriptionMarkdown(renderPrDescriptionMarkdown(fixture, CTX));
    expect(parsed.problems).toEqual([]);
    expect(parsed.complete).toBe(true);
    const d = parsed.description;
    expect(d.title).toBeUndefined();
    expect(d.tldr).toBe(fixture.tldr);
    expect(d.whatWhy).toBe(fixture.whatWhy);
    expect(d.risks).toBe(fixture.risks);
    expect(d.tour).toEqual(fixture.tour.map((s) => ({ ...s, anchor: { ...s.anchor, sha: CTX.headSha } })));
    expect(d.remaining).toEqual(fixture.remaining);
    expect(d.decisions).toEqual(fixture.decisions);
    expect(d.validation).toEqual(fixture.validation);
  });

  it("a small description round-trips too: an empty Remaining list, a multi-paragraph description, a single-line anchor, a decision title already ending in a period (lossy: the period is the renderer's)", () => {
    const small = desc({
      tour: [
        {
          title: "The thing",
          description: "First paragraph.\n\nSecond paragraph, with a `##` in code.",
          lookFor: "the guard",
          anchor: { path: "src/a b.ts", from: 3, to: 3 },
        },
      ],
      decisions: [{ title: "Chose X.", rationale: "Y was worse." }],
      validation: { summary: "All green.", criteria: [{ criterion: "a | b", proof: "c\\d\nnext line" }] },
    });
    const parsed = parsePrDescriptionMarkdown(renderPrDescriptionMarkdown(small, CTX));
    expect(parsed.complete).toBe(true);
    expect(parsed.description.tour).toEqual([
      { ...small.tour[0], anchor: { ...small.tour[0].anchor, sha: CTX.headSha } },
    ]);
    expect(parsed.description.remaining).toEqual([]);
    expect(parsed.description.decisions).toEqual([{ title: "Chose X", rationale: "Y was worse." }]);
    // table cells: `|` and `\` unescaped, a newline inside a cell was flattened by the renderer
    expect(parsed.description.validation).toEqual({
      summary: "All green.",
      criteria: [{ criterion: "a | b", proof: "c\\d next line" }],
    });
  });

  it("a body without the shape never throws: the tldr is the first paragraph that is not a heading, the tour is empty, complete is false and the problems name the missing sections", () => {
    const plain = parsePrDescriptionMarkdown("# Summary\n\nJust a plain body.\nSecond line.\n\nMore.");
    expect(plain.description).toEqual({ tldr: "Just a plain body.\nSecond line.", tour: [] });
    expect(plain.complete).toBe(false);
    expect(plain.problems.join("\n")).toMatch(/## Tour/);
    expect(parsePrDescriptionMarkdown("")).toEqual({
      description: { tour: [] },
      complete: false,
      problems: expect.any(Array),
    });
    expect(parsePrDescriptionMarkdown("   \n\n")).toEqual({
      description: { tour: [] },
      complete: false,
      problems: expect.any(Array),
    });
  });

  it("a hand-written body in the house shape (TL;DR without a heading, no Risks section, CRLF line ends) gets its Tour parsed, the leading paragraph as tldr, and complete: false naming the missing sections", () => {
    const body = [
      "Two sentences a stranger can act on. That is the TL;DR.",
      "",
      "## What & why",
      "",
      "Because the panel needs it.",
      "",
      "## Tour",
      "",
      "### 1. The parser",
      "",
      "Reads the body back.",
      "",
      "**Look for:** the strictness on permalinks.",
      "",
      `https://github.com/acme/api/blob/${CTX.headSha}/src/core/prDescription.ts#L200-L260`,
      "",
      "### 2. Remaining changes",
      "",
      "- `docs/reference/specs/pr-description.md` — item 6 and its rows",
      "",
      "## Decisions",
      "",
      "- **Strict permalinks.** A step without one is dropped.",
      "",
      "## Validation",
      "",
      "| Criterion | Proof |",
      "|---|---|",
      "| It parses | `[unit]` this test |",
      "",
    ].join("\r\n");
    const parsed = parsePrDescriptionMarkdown(body);
    expect(parsed.description.tldr).toBe("Two sentences a stranger can act on. That is the TL;DR.");
    expect(parsed.description.whatWhy).toBe("Because the panel needs it.");
    expect(parsed.description.tour).toEqual([
      {
        title: "The parser",
        description: "Reads the body back.",
        lookFor: "the strictness on permalinks.",
        anchor: { path: "src/core/prDescription.ts", from: 200, to: 260, sha: CTX.headSha },
      },
    ]);
    expect(parsed.description.remaining).toEqual([
      { path: "docs/reference/specs/pr-description.md", note: "item 6 and its rows" },
    ]);
    expect(parsed.description.decisions).toEqual([
      { title: "Strict permalinks", rationale: "A step without one is dropped." },
    ]);
    expect(parsed.description.risks).toBeUndefined();
    expect(parsed.complete).toBe(false);
    expect(parsed.problems).toEqual([
      "no `## TL;DR` section — the tldr is the body's first paragraph",
      "no `## Risks & implications` section",
    ]);
  });

  it("step strictness: a step without a bare github permalink, a non-github link, an absolute or traversing path, or to < from is a problem and is dropped; a short sha and a single-line anchor are accepted; a `## ` inside a fence is not a section", () => {
    const sha7 = CTX.headSha.slice(0, 7);
    const body = [
      "## TL;DR",
      "",
      "t",
      "",
      "## Tour",
      "",
      "### 1. No link",
      "",
      "prose only",
      "",
      "### 2. Not github",
      "",
      "https://gitlab.com/acme/api/blob/abc/src/a.ts#L1-L2",
      "",
      "### 3. Traversing path",
      "",
      `https://github.com/acme/api/blob/${CTX.headSha}/../etc/passwd#L1-L2`,
      "",
      "### 4. Backwards range",
      "",
      `https://github.com/acme/api/blob/${CTX.headSha}/src/a.ts#L9-L3`,
      "",
      "### 5. Fine, short sha, one line",
      "",
      "```",
      "## not a section",
      "```",
      "",
      `https://github.com/acme/api/blob/${sha7}/src/a.ts#L4`,
      "",
      "### 6. Remaining changes",
      "",
      "- none — every touched file is covered by a step above",
      "",
    ].join("\n");
    const parsed = parsePrDescriptionMarkdown(body);
    expect(parsed.description.tour).toEqual([
      {
        title: "Fine, short sha, one line",
        description: "```\n## not a section\n```",
        anchor: { path: "src/a.ts", from: 4, to: 4, sha: sha7 },
      },
    ]);
    expect(parsed.description.remaining).toEqual([]);
    expect(parsed.complete).toBe(false);
    expect(parsed.problems).toEqual([
      "step 1 (No link): no permalink line — dropped",
      "step 2 (Not github): no permalink line — dropped",
      expect.stringMatching(/^step 3 \(Traversing path\): anchor\.path/),
      expect.stringMatching(/^step 4 \(Backwards range\): anchor/),
      "no `## What & why` section",
      "no `## Decisions` section",
      "no `## Risks & implications` section",
      "no `## Validation` section",
    ]);
  });

  it("a percent-encoded path is decoded; a malformed escape is a problem; a duplicate section keeps the first; an unrecognized Remaining line is a problem", () => {
    const body = [
      "## TL;DR",
      "",
      "first",
      "",
      "## TL;DR",
      "",
      "second",
      "",
      "## Tour",
      "",
      "### 1. Encoded",
      "",
      `https://github.com/acme/api/blob/${CTX.headSha}/src/a%20b%23c.ts#L1-L2`,
      "",
      "### 2. Bad escape",
      "",
      `https://github.com/acme/api/blob/${CTX.headSha}/src/%E0%A4%A.ts#L1-L2`,
      "",
      "### 3. Remaining changes",
      "",
      "- `ok.ts` — fine",
      "  continued note",
      "- not a path line",
      "",
    ].join("\n");
    const parsed = parsePrDescriptionMarkdown(body);
    expect(parsed.description.tldr).toBe("first");
    expect(parsed.description.tour.map((s) => s.anchor.path)).toEqual(["src/a b#c.ts"]);
    expect(parsed.description.remaining).toEqual([{ path: "ok.ts", note: "fine\ncontinued note" }]);
    expect(parsed.problems).toEqual(
      expect.arrayContaining([
        "duplicate `## TL;DR` section — the first one stands",
        "step 2 (Bad escape): permalink path is not valid percent-encoding — dropped",
        "Remaining changes: unrecognized line `- not a path line`",
      ]),
    );
  });
});
