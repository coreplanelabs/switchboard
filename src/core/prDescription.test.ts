import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FOLD_SUMMARIES,
  GENERATED_FOOTER,
  MAP_LABELS,
  PR_DESCRIPTION_CAPS,
  TITLE_GATE_REPOSITORY,
  anchorUrl,
  parsePrDescription,
  parsePrDescriptionMarkdown,
  renderPrDescriptionMarkdown,
  titleGateApplies,
  visibleLength,
  type PrDescription,
} from "./prDescription.js";
import { checkPrTitle, TITLE_MAX_LENGTH } from "./prTitle.mjs";
import PR_TITLE_VOCABULARY from "./prTitleVocabulary.json" with { type: "json" };

// Feature: docs/reference/specs/pr-description.md (shape: docs/decisions/0050) — the PR
// description is data; the GitHub body is one rendering of it: a fixed-size
// MAP above the fold and the collapsed blocks below. The fixture is a real
// PR's description — the PR that introduced the map, rewritten onto the
// fixture repo `acme/api` — and the golden file is its rendered body, so the
// pipeline is exercised end to end on a full-sized description, not a toy.

const CTX = { repo: "acme/api", headSha: "685c471f31feaadd725fb917b68a2eea31c0f81a" };
const URL_A = `https://github.com/acme/api/blob/${CTX.headSha}/src/a.ts#L3-L9`;

function desc(over: Partial<PrDescription> = {}): PrDescription {
  return {
    title: "A test PR title",
    tldr: "Two sentences.",
    why: "Because [#1](https://github.com/acme/api/issues/1).",
    pointers: [{ label: "The thing", text: "What it does.", anchor: { path: "src/a.ts", from: 3, to: 9 } }],
    feedbackWanted: "Whether the cap is right.",
    risk: "None — prompt only.",
    verified: "`npm test` green.",
    decisions: [{ title: "Chose X", rationale: "Y was worse." }],
    validation: { criteria: [{ criterion: "It renders", proof: "`[unit]` this test" }] },
    ...over,
  };
}

function goldenFixture(): PrDescription {
  return parsePrDescription(
    JSON.parse(readFileSync(new URL("./testing/goldenMap.description.json", import.meta.url), "utf8")),
  );
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

  it("rejects an embedded newline on a `line` field — a multi-line title goes verbatim into the PR's own title, a multi-line pointer would split its row", () => {
    const badTitle = () => parsePrDescription({ ...desc(), title: "Fix the gate\nand also the fence" });
    expect(badTitle).toThrow(/single line/);
    expect(badTitle).toThrow(/title/);
    expect(() => parsePrDescription({ ...desc(), title: "Fix\r\nthe gate" })).toThrow(/single line/);
    const badPointer = () =>
      parsePrDescription({
        ...desc(),
        pointers: [{ label: "The\nthing", text: "d", anchor: { path: "src/a.ts", from: 1, to: 2 } }],
      });
    expect(badPointer).toThrow(/single line/);
    expect(badPointer).toThrow(/pointers/);
  });

  it("rejects no pointers, missing fields and empty strings; decisions may be empty, criteria may not", () => {
    expect(() => parsePrDescription({ ...desc(), pointers: [] })).toThrow(/at least 1 pointers \(got 0\)/);
    const { risk: _r, ...noRisk } = desc();
    expect(() => parsePrDescription(noRisk)).toThrow(/risk/);
    const { feedbackWanted: _f, ...noFeedback } = desc();
    expect(() => parsePrDescription(noFeedback)).toThrow(/feedbackWanted/);
    const { verified: _v, ...noVerified } = desc();
    expect(() => parsePrDescription(noVerified)).toThrow(/verified/);
    expect(() => parsePrDescription({ ...desc(), tldr: "   " })).toThrow(/tldr/);
    expect(parsePrDescription({ ...desc(), decisions: [] }).decisions).toEqual([]);
    expect(() => parsePrDescription({ ...desc(), validation: { criteria: [] } })).toThrow(/at least 1 criteria/);
  });

  // docs/decisions/0050 "The cap": the map's size is the schema's, not the
  // author's restraint — every field capped, the message naming cap and count.
  /** The zod issue at `path`, so a test can assert the field AND the message. */
  function issueAt(fn: () => unknown, path: string): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issue = err.issues.find((i) => i.path.join(".") === path);
        if (!issue)
          throw new Error(`no issue at ${path}; got ${err.issues.map((i) => i.path.join(".")).join(", ")}`, {
            cause: err,
          });
        return issue.message;
      }
      throw err;
    }
    throw new Error("did not throw");
  }

  it("caps every map field in visible characters and names the cap and the count; a link's target is not counted", () => {
    const long = (n: number) => "x".repeat(n);
    // The title is the squash subject and the changelog line: 72, the title
    // gate's own number, counted raw on EVERY repository (GitHub renders no
    // markdown in a title, so a link's target is characters the reader sees);
    // the gate's grammar and vocabulary apply on one repository only — the
    // block below.
    expect(PR_DESCRIPTION_CAPS.title).toBe(72);
    expect(issueAt(() => parsePrDescription({ ...desc(), title: long(73) }), "title")).toBe(
      "at most 72 characters (got 73)",
    );
    expect(parsePrDescription({ ...desc(), title: long(72) }).title).toBe(long(72));
    const linkedTitle = `fix: [x](${"h".repeat(63)})`;
    expect(linkedTitle).toHaveLength(73);
    expect(issueAt(() => parsePrDescription({ ...desc(), title: linkedTitle }), "title")).toBe(
      "at most 72 characters (got 73)",
    );
    expect(issueAt(() => parsePrDescription({ ...desc(), tldr: long(301) }), "tldr")).toBe(
      "at most 300 visible characters (got 301)",
    );
    expect(issueAt(() => parsePrDescription({ ...desc(), why: long(401) }), "why")).toMatch(/at most 400/);
    expect(issueAt(() => parsePrDescription({ ...desc(), feedbackWanted: long(201) }), "feedbackWanted")).toMatch(
      /at most 200/,
    );
    expect(issueAt(() => parsePrDescription({ ...desc(), risk: long(301) }), "risk")).toMatch(/at most 300/);
    expect(issueAt(() => parsePrDescription({ ...desc(), verified: long(201) }), "verified")).toMatch(/at most 200/);
    const p = (over: Record<string, string>) => ({
      ...desc(),
      pointers: [{ label: "l", text: "t", anchor: { path: "a.ts", from: 1, to: 1 }, ...over }],
    });
    expect(issueAt(() => parsePrDescription(p({ label: long(61) })), "pointers.0.label")).toMatch(/at most 60/);
    expect(issueAt(() => parsePrDescription(p({ text: long(161) })), "pointers.0.text")).toMatch(/at most 160/);
    expect(issueAt(() => parsePrDescription(p({ risk: long(101) })), "pointers.0.risk")).toMatch(/at most 100/);
    // A why of three links: 300 characters of URL count for nothing.
    const linked = Array.from(
      { length: 3 },
      (_, i) => `[#${i}](https://github.com/acme/api/pull/${i}${long(90)})`,
    ).join(" ");
    expect(visibleLength(linked)).toBeLessThan(30);
    expect(parsePrDescription({ ...desc(), why: `Stacked on ${linked}.` }).why).toContain("Stacked on");
    // …and the collapsed half is bounded too, so the coverage instinct cannot move there.
    expect(
      issueAt(
        () =>
          parsePrDescription({
            ...desc(),
            decisions: Array.from({ length: 11 }, () => ({ title: "t", rationale: "r" })),
          }),
        "decisions",
      ),
    ).toBe("at most 10 decisions (got 11)");
    expect(
      issueAt(
        () => parsePrDescription({ ...desc(), decisions: [{ title: "t", rationale: long(401) }] }),
        "decisions.0.rationale",
      ),
    ).toMatch(/at most 400/);
    expect(
      issueAt(
        () =>
          parsePrDescription({
            ...desc(),
            validation: { criteria: Array.from({ length: 31 }, () => ({ criterion: "c", proof: "p" })) },
          }),
        "validation.criteria",
      ),
    ).toBe("at most 30 criteria (got 31)");
    expect(
      issueAt(
        () => parsePrDescription({ ...desc(), validation: { criteria: [{ criterion: long(201), proof: "p" }] } }),
        "validation.criteria.0.criterion",
      ),
    ).toMatch(/at most 200/);
    expect(
      issueAt(
        () => parsePrDescription({ ...desc(), validation: { criteria: [{ criterion: "c", proof: long(301) }] } }),
        "validation.criteria.0.proof",
      ),
    ).toMatch(/at most 300/);
    expect(issueAt(() => parsePrDescription({ ...desc(), agentNotes: long(2001) }), "agentNotes")).toMatch(
      /at most 2000/,
    );
  });

  it("caps the pointers at seven, naming the count — an 80-file PR gets the same rows as a 3-file PR", () => {
    const pointer = (i: number) => ({ label: `p${i}`, text: "t", anchor: { path: `src/${i}.ts`, from: 1, to: 1 } });
    expect(
      parsePrDescription({ ...desc(), pointers: Array.from({ length: 7 }, (_, i) => pointer(i)) }).pointers,
    ).toHaveLength(7);
    expect(
      issueAt(
        () => parsePrDescription({ ...desc(), pointers: Array.from({ length: 12 }, (_, i) => pointer(i)) }),
        "pointers",
      ),
    ).toBe("at most 7 pointers (got 12)");
    expect(PR_DESCRIPTION_CAPS.pointers).toBe(7);
  });

  it("rejects a pointer text carrying the ` ⚠ ` risk separator — it would parse back with its tail as the risk", () => {
    const p = (text: string) => ({
      ...desc(),
      pointers: [{ label: "l", text, anchor: { path: "a.ts", from: 1, to: 1 } }],
    });
    expect(issueAt(() => parsePrDescription(p("one ⚠ two")), "pointers.0.text")).toMatch(/risk separator/);
    expect(parsePrDescription(p("one⚠two")).pointers[0].text).toBe("one⚠two"); // no spaces: not the separator
  });

  it("rejects a bad anchor: absolute or traversing path, non-positive lines, to < from", () => {
    const p = (anchor: Record<string, unknown>) => ({ ...desc(), pointers: [{ label: "l", text: "t", anchor }] });
    expect(() => parsePrDescription(p({ path: "/etc/passwd", from: 1, to: 2 }))).toThrow(/repo-relative/);
    expect(() => parsePrDescription(p({ path: "../x.ts", from: 1, to: 2 }))).toThrow(/repo-relative/);
    expect(() => parsePrDescription(p({ path: "a.ts", from: 0, to: 2 }))).toThrow(/from/);
    expect(() => parsePrDescription(p({ path: "a.ts", from: 5, to: 2 }))).toThrow(/to must be >= from/);
    // `..` is rejected as a SEGMENT only — a filename containing dots is legitimate.
    expect(parsePrDescription(p({ path: "src/a..b.ts", from: 1, to: 2 })).pointers[0].anchor.path).toBe("src/a..b.ts");
    expect(() => parsePrDescription(p({ path: "src/../x.ts", from: 1, to: 2 }))).toThrow(/repo-relative/);
  });
});

describe("the title is judged as the CI title gate judges it (release-and-deploy item 22)", () => {
  // A title the gate refuses used to reach GitHub: the tool checked only the
  // cap, and a run whose loop was cut had no shell left to run
  // `npm run check:pr-title` itself. On the repository that carries the gate
  // the schema now runs the gate's own predicate against the generated
  // vocabulary and reports the gate's own sentence, so the model cuts and
  // resubmits inside the same turn. The vocabulary is one repository's house
  // convention, so every other repository keeps the cap alone.
  const gated = (over: Partial<PrDescription>) =>
    parsePrDescription({ ...desc(), ...over }, { repo: TITLE_GATE_REPOSITORY });
  const gateProblems = (title: string): string[] => {
    const v = checkPrTitle(title, PR_TITLE_VOCABULARY);
    return v.ok ? [] : v.problems;
  };
  const issuesAt = (fn: () => unknown, path: string): string[] => {
    try {
      fn();
    } catch (err) {
      if (err instanceof z.ZodError) return err.issues.filter((i) => i.path.join(".") === path).map((i) => i.message);
      throw err;
    }
    throw new Error("did not throw");
  };
  const issueAt = (fn: () => unknown, path: string): string => {
    const [first, ...rest] = issuesAt(fn, path);
    if (first === undefined) throw new Error(`no issue at ${path}`);
    expect(rest, `one issue at ${path}`).toEqual([]);
    return first;
  };

  it("an unknown scope is refused at `title` with the gate's sentence — the scope, the whole vocabulary and the code map named", () => {
    const title = "feat(dispatch): every gate refusal is a Refusal with a cause, counted";
    const message = issueAt(() => gated({ title }), "title");
    expect(message).toBe(gateProblems(title)[0]);
    expect(message).toMatch(/^unknown scope "dispatch" — use one of: dispatcher, core, /);
    expect(message).toContain("(the Areas in docs/reference/code-map.md), or no scope for a tree-wide change");
  });

  it("an unknown type, a title outside the grammar and a trailing period are refused with the gate's sentence too", () => {
    for (const title of ["feature: new thing", "Fix the gate", "fix:no space", "fix(core): stop here."]) {
      expect(gateProblems(title)).not.toEqual([]);
      expect(issueAt(() => gated({ title }), "title")).toBe(gateProblems(title)[0]);
    }
  });

  it("every problem the gate finds is one issue at `title`, in the gate's order", () => {
    const title = "feature(readme): x.";
    expect(issuesAt(() => gated({ title }), "title")).toEqual(gateProblems(title));
    expect(gateProblems(title)).toHaveLength(3);
  });

  it("a code-map scope, no scope, the bots' scopes over the cap and a revert pass, as they pass the gate", () => {
    for (const title of [
      "fix(tools): the tool refuses the title the gate refuses",
      "docs: a tree-wide change carries no scope",
      `chore(deps): bump ${"x".repeat(80)}`,
      "chore(main): release 1.2.3",
      `revert: feat(core): ${"x".repeat(80)}`,
    ]) {
      expect(gateProblems(title)).toEqual([]);
      expect(gated({ title }).title).toBe(title);
    }
  });

  it("the golden description's title passes the gate and the schema alike", () => {
    expect(gateProblems(goldenFixture().title)).toEqual([]);
    expect(gated({ title: goldenFixture().title }).title).toBe(goldenFixture().title);
  });

  it("only a description bound for the repository that carries the gate is judged by it — another repository, or none, keeps the cap alone", () => {
    // The vocabulary and the file the refusal names belong to one repository;
    // a run on any other must not be told to use its Areas.
    const foreign = "fix(api): handle 429 retries";
    expect(gateProblems(foreign)).not.toEqual([]);
    expect(parsePrDescription({ ...desc(), title: foreign }, { repo: "acme/api" }).title).toBe(foreign);
    expect(parsePrDescription({ ...desc(), title: foreign }).title).toBe(foreign);
    expect(parsePrDescription({ ...desc(), title: "Fix the gate" }, { repo: "acme/api" }).title).toBe("Fix the gate");
    expect(issueAt(() => gated({ title: foreign }), "title")).toMatch(/^unknown scope "api" — use one of: /);
    // The cap still holds everywhere, in the universal wording.
    const long = "x".repeat(73);
    expect(issueAt(() => parsePrDescription({ ...desc(), title: long }, { repo: "acme/api" }), "title")).toBe(
      "at most 72 characters (got 73)",
    );
    // The repository is matched as the dispatcher resolves it: a lowercase slug; case never decides.
    expect(titleGateApplies(TITLE_GATE_REPOSITORY)).toBe(true);
    expect(titleGateApplies(TITLE_GATE_REPOSITORY.toUpperCase())).toBe(true);
    expect(titleGateApplies("acme/api")).toBe(false);
    expect(titleGateApplies(undefined)).toBe(false);
  });

  it("the cap is the gate's number: 72 raw characters, a link's target counted, refused naming the count in the gate's words", () => {
    expect(PR_DESCRIPTION_CAPS.title).toBe(TITLE_MAX_LENGTH);
    const fill = (prefix: string, n: number) => prefix + "x".repeat(n - prefix.length);
    expect(gated({ title: fill("fix(core): ", 72) }).title).toHaveLength(72);
    expect(issueAt(() => gated({ title: fill("fix(core): ", 73) }), "title")).toBe(
      "the title is 73 characters; at most 72 — one change, one clause, present tense; the PR body carries the rest",
    );
    // GitHub renders no markdown in a title, so a link's target is characters the reader sees.
    const linkedTitle = `fix: [x](${"h".repeat(63)})`;
    expect(linkedTitle).toHaveLength(73);
    expect(issueAt(() => gated({ title: linkedTitle }), "title")).toMatch(/^the title is 73 characters/);
  });
});

describe("renderPrDescriptionMarkdown", () => {
  it("renders the map in the contract order — tldr first with no heading, the bold labels, the numbered pointers — then the folds, then the footer", () => {
    const md = renderPrDescriptionMarkdown(desc(), CTX);
    expect(md).toBe(
      [
        "Two sentences.",
        "",
        "**Why:** Because [#1](https://github.com/acme/api/issues/1).",
        "",
        "**Where to look**",
        "",
        `1. [The thing](${URL_A}) What it does.`,
        "",
        "**Feedback wanted:** Whether the cap is right.",
        "",
        "**Risk:** None — prompt only.",
        "",
        "**Verified:** `npm test` green.",
        "",
        "<details>",
        "<summary>Decisions (1)</summary>",
        "",
        "- **Chose X.** Y was worse.",
        "",
        "</details>",
        "",
        "<details>",
        "<summary>Validation (1 criterion)</summary>",
        "",
        "| Criterion | Proof |",
        "|---|---|",
        "| It renders | `[unit]` this test |",
        "",
        "</details>",
        "",
        GENERATED_FOOTER,
        "",
      ].join("\n"),
    );
    expect(md.split("\n").filter((l) => /^#{1,6}\s/.test(l))).toEqual([]); // no headings anywhere
  });

  it("the title is metadata for the PR's own title field — never rendered into the body", () => {
    const md = renderPrDescriptionMarkdown(desc({ title: "UNIQUE-TITLE-NEVER-IN-BODY" }), CTX);
    expect(md).not.toContain("UNIQUE-TITLE-NEVER-IN-BODY");
  });

  it("a pointer is `N. [label](permalink) text ⚠ risk`, numbered from 1, the ⚠ only when a risk is set; a `]` in a label is escaped", () => {
    const md = renderPrDescriptionMarkdown(
      desc({
        pointers: [
          { label: "First", text: "One.", risk: "the guard", anchor: { path: "src/a.ts", from: 3, to: 9 } },
          { label: "Second [x]", text: "Two.", anchor: { path: "src/b.ts", from: 10, to: 10 } },
        ],
      }),
      CTX,
    );
    expect(md).toContain(
      `1. [First](${URL_A}) One. ⚠ the guard\n2. [Second [x\\]](https://github.com/acme/api/blob/${CTX.headSha}/src/b.ts#L10-L10) Two.\n\n${MAP_LABELS.feedbackWanted}`,
    );
  });

  // docs/decisions/0050 "Links, not embeds": a bare permalink on its own line
  // is what GitHub embeds as a code block; the map is links.
  it("never writes a bare permalink line — every anchor sits inside link syntax", () => {
    const md = renderPrDescriptionMarkdown(goldenFixture(), CTX);
    const bare = md.split("\n").filter((l) => /^https:\/\/github\.com\/\S+\/blob\//.test(l.trim()));
    expect(bare).toEqual([]);
    expect(md).toMatch(/\]\(https:\/\/github\.com\/acme\/api\/blob\/[0-9a-f]{40}\/[^)]+#L\d+-L\d+\)/);
  });

  it("anchors take the sha from the render context — a repush is a re-render, never an edit of the data", () => {
    const d = desc();
    const a = renderPrDescriptionMarkdown(d, CTX);
    const b = renderPrDescriptionMarkdown(d, { ...CTX, headSha: "1234567890abcdef1234567890abcdef12345678" });
    expect(a).toContain(`blob/${CTX.headSha}/src/a.ts#L3-L9`);
    expect(b).toContain("blob/1234567890abcdef1234567890abcdef12345678/src/a.ts#L3-L9");
    expect(anchorUrl(CTX, { path: "src/a.ts", from: 3, to: 9 })).toBe(URL_A);
  });

  it("percent-encodes path segments (a space or `#` in a filename would break the link), keeping `/` as the separator", () => {
    expect(anchorUrl(CTX, { path: "docs/a b#c.md", from: 1, to: 2 })).toBe(
      `https://github.com/acme/api/blob/${CTX.headSha}/docs/a%20b%23c.md#L1-L2`,
    );
  });

  it("refuses a short sha or a non owner/name repo", () => {
    expect(() => renderPrDescriptionMarkdown(desc(), { ...CTX, headSha: "685c471" })).toThrow(/40-char/);
    expect(() => renderPrDescriptionMarkdown(desc(), { ...CTX, headSha: "coding/pr-description-map" })).toThrow(
      /40-char/,
    );
    expect(() => renderPrDescriptionMarkdown(desc(), { ...CTX, repo: "acme" })).toThrow(/owner\/name/);
  });

  it("the folds: no decisions → no Decisions block; agentNotes → a For agents block; the validation fold names its count", () => {
    const md = renderPrDescriptionMarkdown(
      desc({
        decisions: [],
        agentNotes: "Skip the lockfile churn.",
        validation: {
          criteria: [
            { criterion: "a", proof: "b" },
            { criterion: "c", proof: "d" },
          ],
        },
      }),
      CTX,
    );
    expect(md).not.toContain("<summary>Decisions");
    expect(md).toContain(`<summary>${FOLD_SUMMARIES.validation(2)}</summary>`);
    expect(md).toContain("<details>\n<summary>For agents</summary>\n\nSkip the lockfile churn.\n\n</details>");
    // Every fold is `<details>`, `<summary>`, a blank line (GitHub renders the markdown inside only after one), the body, `</details>`.
    expect(md.match(/<details>\n<summary>[^\n]+<\/summary>\n\n/g)?.length).toBe(2);
  });

  it("decisions read `- **Title.** rationale` (one trailing period, never two); table cells escape `|` and flatten newlines", () => {
    const md = renderPrDescriptionMarkdown(
      desc({
        decisions: [
          { title: "Ends with period.", rationale: "r1" },
          { title: "No period", rationale: "r2" },
        ],
        validation: { criteria: [{ criterion: "a | b", proof: "c\nd" }] },
      }),
      CTX,
    );
    expect(md).toContain("- **Ends with period.** r1\n- **No period.** r2");
    expect(md).toContain("| a \\| b | c d |");
  });

  // docs/decisions/0050 invariants: the map never exceeds 3,800 visible
  // characters, and the whole body never exceeds 26,000.
  it("a maximal object renders a map under 3,800 visible characters and a body under 26,000", () => {
    const fill = (n: number) => "x".repeat(n);
    const maximal = desc({
      tldr: fill(300),
      why: fill(400),
      pointers: Array.from({ length: 7 }, (_, i) => ({
        label: fill(60),
        text: fill(160),
        risk: fill(100),
        anchor: { path: `src/${i}.ts`, from: 1, to: 25 },
      })),
      feedbackWanted: fill(200),
      risk: fill(300),
      verified: fill(200),
      decisions: Array.from({ length: 10 }, () => ({ title: fill(60), rationale: fill(400) })),
      validation: { criteria: Array.from({ length: 30 }, () => ({ criterion: fill(200), proof: fill(300) })) },
      agentNotes: fill(2000),
    });
    const md = renderPrDescriptionMarkdown(parsePrDescription(maximal), CTX);
    const map = md.slice(0, md.indexOf("<details>"));
    expect(visibleLength(map)).toBeLessThan(3800);
    expect(visibleLength(md)).toBeLessThan(26000);
  });
});

describe("golden: a full PR description rendered through the pipeline", () => {
  it("fixture → markdown equals the checked-in body byte for byte", () => {
    const golden = readFileSync(new URL("./testing/goldenMap.body.md", import.meta.url), "utf8");
    expect(renderPrDescriptionMarkdown(goldenFixture(), CTX)).toBe(golden);
  });
});

// Feature: docs/reference/specs/pr-description.md item 6 — the inverse of the renderer: a
// body GitHub holds, read back into the object (what a review run's panel
// gets when the PR was described by a person or an older pipeline). Strict
// where the renderer is strict (a pointer needs a well-formed permalink),
// never a throw on a body without the shape.
describe("parsePrDescriptionMarkdown — the inverse of the renderer", () => {
  it("golden round trip: tldr, why, pointers (anchors + the render sha), feedbackWanted, risk, verified, decisions, validation and agentNotes come back equal; the title is not in the body", () => {
    const fixture = goldenFixture();
    const parsed = parsePrDescriptionMarkdown(renderPrDescriptionMarkdown(fixture, CTX));
    expect(parsed.problems).toEqual([]);
    expect(parsed.complete).toBe(true);
    const d = parsed.description;
    expect(d.title).toBeUndefined();
    expect(d.tldr).toBe(fixture.tldr);
    expect(d.why).toBe(fixture.why);
    expect(d.feedbackWanted).toBe(fixture.feedbackWanted);
    expect(d.risk).toBe(fixture.risk);
    expect(d.verified).toBe(fixture.verified);
    expect(d.pointers).toEqual(fixture.pointers.map((p) => ({ ...p, anchor: { ...p.anchor, sha: CTX.headSha } })));
    expect(d.decisions).toEqual(fixture.decisions);
    expect(d.validation).toEqual(fixture.validation);
    expect(d.agentNotes).toEqual(fixture.agentNotes);
  });

  it("a small description round-trips too: no decisions, a risk on a pointer, an escaped label, a single-line anchor, a decision title already ending in a period (lossy: the period is the renderer's)", () => {
    const small = desc({
      tldr: "First paragraph.\n\nSecond paragraph, with a `##` in code.",
      pointers: [
        { label: "The [thing]", text: "One.", risk: "the guard", anchor: { path: "src/a b.ts", from: 3, to: 3 } },
      ],
      decisions: [{ title: "Chose X.", rationale: "Y was worse." }],
      validation: { criteria: [{ criterion: "a | b", proof: "c\\d\nnext line" }] },
    });
    const parsed = parsePrDescriptionMarkdown(renderPrDescriptionMarkdown(small, CTX));
    expect(parsed.problems).toEqual([]);
    expect(parsed.description.tldr).toBe(small.tldr);
    expect(parsed.description.pointers).toEqual([
      { ...small.pointers[0], anchor: { ...small.pointers[0].anchor, sha: CTX.headSha } },
    ]);
    expect(parsed.description.decisions).toEqual([{ title: "Chose X", rationale: "Y was worse." }]);
    // table cells: `|` and `\` unescaped, a newline inside a cell was flattened by the renderer
    expect(parsed.description.validation).toEqual({ criteria: [{ criterion: "a | b", proof: "c\\d next line" }] });
    const none = parsePrDescriptionMarkdown(renderPrDescriptionMarkdown(desc({ decisions: [] }), CTX));
    expect(none.problems).toEqual([]);
    expect(none.description.decisions).toEqual([]);
  });

  it("a body without either shape never throws: the tldr is the first text that is not a heading, no pointers, complete is false and the problems name the missing labels", () => {
    const plain = parsePrDescriptionMarkdown("# Summary\n\nJust a plain body.\nSecond line.\n\nMore.");
    expect(plain.description.tldr).toBe("Just a plain body.\nSecond line.\n\nMore.");
    expect(plain.description.pointers).toEqual([]);
    expect(plain.complete).toBe(false);
    expect(plain.problems.join("\n")).toMatch(/\*\*Why:\*\*/);
    expect(plain.problems.join("\n")).toMatch(/Where to look/);
    expect(parsePrDescriptionMarkdown("")).toMatchObject({
      description: { pointers: [], decisions: [] },
      complete: false,
    });
    expect(parsePrDescriptionMarkdown("   \n\n")).toMatchObject({ description: { pointers: [] }, complete: false });
  });

  it("a hand-written body in the map shape (CRLF, a bold note inside the tldr, no folds, a short sha) parses: the note stays in the tldr, the pointer's sha is the body's, complete is false naming the missing folds", () => {
    const body = [
      "Deliveries are tried once today.",
      "**Note:** this is inside the tldr.",
      "",
      "**Why:** A flaky receiver loses the event.",
      "",
      "**Where to look**",
      "",
      "1. [The retry](https://github.com/acme/api/blob/685c471/src/retry.ts#L4-L12) Bounded to three attempts. ⚠ the backoff table",
      "2. [Its test](https://github.com/acme/api/blob/685c471/src/retry.test.ts#L1) Pins the bound.",
      "",
      "**Feedback wanted:** the bound.",
      "**Risk:** none.",
      "**Verified:** ran the suite.",
    ].join("\r\n");
    const parsed = parsePrDescriptionMarkdown(body);
    expect(parsed.description.tldr).toBe("Deliveries are tried once today.\n**Note:** this is inside the tldr.");
    expect(parsed.description.why).toBe("A flaky receiver loses the event.");
    expect(parsed.description.pointers).toEqual([
      {
        label: "The retry",
        text: "Bounded to three attempts.",
        risk: "the backoff table",
        anchor: { path: "src/retry.ts", from: 4, to: 12, sha: "685c471" },
      },
      {
        label: "Its test",
        text: "Pins the bound.",
        anchor: { path: "src/retry.test.ts", from: 1, to: 1, sha: "685c471" },
      },
    ]);
    expect(parsed.description.feedbackWanted).toBe("the bound.");
    expect(parsed.description.risk).toBe("none.");
    expect(parsed.description.verified).toBe("ran the suite.");
    expect(parsed.complete).toBe(false);
    expect(parsed.problems).toEqual(["no `Validation` fold"]);
  });

  it("pointer strictness: a row without a github permalink, a non-github link, a traversing path or to < from is a problem and dropped; a `##` inside a fence is not structure; a duplicate label keeps the first", () => {
    const body = [
      "Tldr.",
      "",
      "**Why:** w.",
      "",
      "**Where to look**",
      "",
      "1. [No link] just text",
      "2. [Elsewhere](https://gitlab.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/a.ts#L1-L2) text",
      `3. [Traversing](https://github.com/acme/api/blob/${CTX.headSha}/src/../x.ts#L1-L2) text`,
      `4. [Backwards](https://github.com/acme/api/blob/${CTX.headSha}/src/a.ts#L9-L3) text`,
      `5. [Good](https://github.com/acme/api/blob/${CTX.headSha}/src/a.ts#L3-L9) text`,
      "",
      "**Feedback wanted:** f.",
      "",
      "```",
      "## Tour",
      "**Risk:** inside a fence",
      "```",
      "",
      "**Risk:** r.",
      "",
      "**Risk:** second.",
      "",
      "**Verified:** v.",
      "",
      "<details>",
      "<summary>Validation (1 criterion)</summary>",
      "",
      "| Criterion | Proof |",
      "|---|---|",
      "| a | b |",
      "",
      "</details>",
    ].join("\n");
    const parsed = parsePrDescriptionMarkdown(body);
    expect(parsed.description.pointers.map((p) => p.label)).toEqual(["Good"]);
    expect(parsed.description.risk).toBe("r.");
    expect(parsed.description.feedbackWanted).toBe("f.\n\n```\n## Tour\n**Risk:** inside a fence\n```");
    expect(parsed.problems).toEqual([
      "duplicate `**Risk:**` — the first one stands",
      "pointer row without a github permalink — dropped: `1. [No link] just text`",
      "pointer row without a github permalink — dropped: `2. [Elsewhere](https://gitlab.com/acme/api/blob/685c471f31fe`",
      "pointer 3: anchor.path path must be repo-relative — dropped",
      "pointer 4: anchor to must be >= from — dropped",
    ]);
    expect(parsed.complete).toBe(false);
  });

  // docs/decisions/0050 "The parser": every PR already on GitHub carries the
  // previous contract; it still reaches the artifact, as pointers.
  it("a legacy Tour body parses by the old grammar: What & why → why, each step → a pointer (title → label, description → text, Look for appended), Risks → risk, decisions and the table kept, Remaining changes and the summary dropped, `legacy Tour shape` as a problem", () => {
    const body = [
      "## TL;DR",
      "",
      "Old tldr.",
      "",
      "## What & why",
      "",
      "Old why.",
      "",
      "## Tour",
      "",
      "### 1. The template",
      "",
      "Every section is a heading.",
      "",
      "**Look for:** the ordering.",
      "",
      `https://github.com/acme/api/blob/${CTX.headSha}/src/agents/registry.ts#L46-L60`,
      "",
      "### 2. No link",
      "",
      "Dropped.",
      "",
      "### 3. Remaining changes",
      "",
      "- `a.ts` — note",
      "",
      "## Decisions",
      "",
      "- **Author-written.** More context.",
      "",
      "## Risks & implications",
      "",
      "Prompt-only.",
      "",
      "## Validation",
      "",
      "All green.",
      "",
      "| Criterion | Proof |",
      "|---|---|",
      "| a | b |",
      "",
      GENERATED_FOOTER,
    ].join("\n");
    const parsed = parsePrDescriptionMarkdown(body);
    expect(parsed.description).toEqual({
      tldr: "Old tldr.",
      why: "Old why.",
      risk: "Prompt-only.",
      pointers: [
        {
          label: "The template",
          text: "Every section is a heading. Look for: the ordering.",
          anchor: { path: "src/agents/registry.ts", from: 46, to: 60, sha: CTX.headSha },
        },
      ],
      decisions: [{ title: "Author-written", rationale: "More context." }],
      validation: { criteria: [{ criterion: "a", proof: "b" }] },
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.problems).toEqual(["step 2 (No link): no permalink line — dropped", "legacy Tour shape"]);
    // A legacy body whose TL;DR has no heading: the leading paragraph is the tldr.
    const headless = parsePrDescriptionMarkdown(
      `Lead.\n\n## Tour\n\n### 1. S\n\nd\n\nhttps://github.com/acme/api/blob/685c471/a.ts#L1\n`,
    );
    expect(headless.description.tldr).toBe("Lead.");
    expect(headless.description.pointers).toEqual([
      { label: "S", text: "d", anchor: { path: "a.ts", from: 1, to: 1, sha: "685c471" } },
    ]);
  });

  it("a percent-encoded path is decoded; a malformed escape is a problem; an unknown fold is skipped; an unrecognized decision line is a problem", () => {
    const body = [
      "Tldr.",
      "",
      "**Why:** w.",
      "",
      "**Where to look**",
      "",
      `1. [Spaces](https://github.com/acme/api/blob/${CTX.headSha}/docs/a%20b%23c.md#L1-L2) text`,
      `2. [Bad escape](https://github.com/acme/api/blob/${CTX.headSha}/docs/%E0%A4%A.md#L1-L2) text`,
      "",
      "**Feedback wanted:** f.",
      "",
      "**Risk:** r.",
      "",
      "**Verified:** v.",
      "",
      "<details>",
      "<summary>Something else</summary>",
      "",
      "ignored",
      "",
      "</details>",
      "",
      "<details>",
      "<summary>Decisions (1)</summary>",
      "",
      "- **Chose X.** Because.",
      "not a decision",
      "- plain bullet",
      "",
      "</details>",
      "",
      "<details>",
      "<summary>Validation (1 criterion)</summary>",
      "",
      "| Criterion | Proof |",
      "|---|---|",
      "| a | b |",
      "",
      "</details>",
    ].join("\n");
    const parsed = parsePrDescriptionMarkdown(body);
    expect(parsed.description.pointers).toEqual([
      { label: "Spaces", text: "text", anchor: { path: "docs/a b#c.md", from: 1, to: 2, sha: CTX.headSha } },
    ]);
    expect(parsed.description.decisions).toEqual([{ title: "Chose X", rationale: "Because.\nnot a decision" }]);
    expect(parsed.problems).toEqual([
      "pointer 2: permalink path is not valid percent-encoding — dropped",
      "Decisions: unrecognized line `- plain bullet`",
    ]);
  });
});
