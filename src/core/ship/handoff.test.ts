import { describe, expect, it } from "vitest";
import {
  HANDOFF_LEDGER_HEADER,
  HANDOFF_MAX_FIELD_CHARS,
  HANDOFF_MAX_ITEMS,
  emptyHandoff,
  isEmptyHandoff,
  isHandoffShape,
  parseHandoff,
  redactHandoff,
  renderHandoffComment,
  renderHandoffLedgerRows,
  type Handoff,
} from "./handoff.js";

// Feature: docs/reference/specs/agent-ship.md item 14, agent-coding.md item 9 —
// the handoff a coding child hands back beside its description: three typed
// lists, a validator the tool answers with, one renderer for the unit's board
// issue and one for the plan's follow-ups ledger. Pure: nothing here reads a
// disk, the network or a clock.

const PR = { number: 7, url: "https://github.com/acme/api/pull/7" };

const FULL: Handoff = {
  deviations: [
    {
      from: "an empty handoff records nothing",
      to: "an empty handoff is recorded as three empty lists",
      why: "an affirmed empty handoff must stay distinguishable from none",
    },
  ],
  followUps: [{ what: "the review child posts its own handoff", where: "src/core/ship/reviewChild.ts" }],
  unproven: [
    { criterion: "the board comment appears on a live unit issue", why: "no plan runner exists to post it yet" },
  ],
};

describe("parseHandoff — the validator the submit_handoff tool answers with", () => {
  it("accepts the three lists, trims every field, drops unknown keys, and accepts empty lists", () => {
    const out = parseHandoff({
      deviations: [{ from: "  a ", to: "b", why: "c\n", extra: 1 }],
      followUps: [],
      unproven: [{ criterion: "x", why: "y" }],
      note: "ignored",
    });
    expect(out).toEqual({
      ok: true,
      handoff: {
        deviations: [{ from: "a", to: "b", why: "c" }],
        followUps: [],
        unproven: [{ criterion: "x", why: "y" }],
      },
    });
    expect(parseHandoff({ deviations: [], followUps: [], unproven: [] })).toEqual({
      ok: true,
      handoff: emptyHandoff(),
    });
  });

  it("refuses a non-object, a missing or non-array list, a non-object entry, a blank, non-string or over-long field, and too many entries — each as a string naming the path, never a throw", () => {
    const error = (input: unknown) => {
      const out = parseHandoff(input);
      if (out.ok) throw new Error("expected a refusal");
      return out.error;
    };
    expect(error(null)).toMatch(/^handoff: must be an object/);
    expect(error("x")).toMatch(/^handoff: must be an object/);
    expect(error({ deviations: [], followUps: [] })).toMatch(/^unproven: must be an array/);
    expect(error({ deviations: "none", followUps: [], unproven: [] })).toMatch(/^deviations: must be an array/);
    expect(error({ deviations: ["a"], followUps: [], unproven: [] })).toMatch(
      /^deviations\.0: must be an object with from, to and why/,
    );
    expect(error({ deviations: [], followUps: [{ what: "w", where: "  " }], unproven: [] })).toMatch(
      /^followUps\.0\.where: must be a non-empty string/,
    );
    expect(error({ deviations: [], followUps: [], unproven: [{ criterion: 3, why: "y" }] })).toMatch(
      /^unproven\.0\.criterion: must be a non-empty string/,
    );
    expect(
      error({
        deviations: [],
        followUps: [{ what: "w".repeat(HANDOFF_MAX_FIELD_CHARS + 1), where: "x" }],
        unproven: [],
      }),
    ).toMatch(new RegExp(`^followUps\\.0\\.what: .*at most ${HANDOFF_MAX_FIELD_CHARS} characters`));
    const many = Array.from({ length: HANDOFF_MAX_ITEMS + 1 }, () => ({ what: "w", where: "x" }));
    expect(error({ deviations: [], followUps: many, unproven: [] })).toMatch(
      new RegExp(`^followUps: at most ${HANDOFF_MAX_ITEMS} entries`),
    );
    // exactly the bound is fine
    expect(parseHandoff({ deviations: [], followUps: many.slice(0, HANDOFF_MAX_ITEMS), unproven: [] }).ok).toBe(true);
    expect(
      parseHandoff({
        deviations: [],
        followUps: [{ what: "w".repeat(HANDOFF_MAX_FIELD_CHARS), where: "x" }],
        unproven: [],
      }).ok,
    ).toBe(true);
  });
});

describe("isHandoffShape — the structural check a stored record runs", () => {
  it("accepts a parsed handoff and its JSON round-trip, and an over-long field (shape only: redaction may lengthen a stored string)", () => {
    expect(isHandoffShape(FULL)).toBe(true);
    expect(isHandoffShape(JSON.parse(JSON.stringify(FULL)))).toBe(true);
    expect(isHandoffShape(emptyHandoff())).toBe(true);
    const long = { ...FULL, followUps: [{ what: "w".repeat(HANDOFF_MAX_FIELD_CHARS * 4), where: "x" }] };
    expect(isHandoffShape(long)).toBe(true);
    expect(parseHandoff(long).ok).toBe(false);
  });

  it("refuses a non-object, a missing list, a non-array list, a non-object entry and a non-string field", () => {
    expect(isHandoffShape(undefined)).toBe(false);
    expect(isHandoffShape({ deviations: [], followUps: [] })).toBe(false);
    expect(isHandoffShape({ ...FULL, unproven: {} })).toBe(false);
    expect(isHandoffShape({ ...FULL, deviations: [null] })).toBe(false);
    expect(isHandoffShape({ ...FULL, followUps: [{ what: "w", where: 2 }] })).toBe(false);
  });

  it("isEmptyHandoff: true only when every list is empty", () => {
    expect(isEmptyHandoff(emptyHandoff())).toBe(true);
    expect(isEmptyHandoff({ ...emptyHandoff(), unproven: FULL.unproven })).toBe(false);
  });
});

describe("redactHandoff — every string leaf through the redaction seam", () => {
  it("redacts a credential in any field with the default redactor, keeps the structure, and never mutates the input", () => {
    const token = `ghp_${"a".repeat(24)}`;
    const leaky: Handoff = {
      deviations: [{ from: `used ${token}`, to: "b", why: "c" }],
      followUps: [{ what: "w", where: `.env has ${token}` }],
      unproven: [{ criterion: token, why: "y" }],
    };
    const out = redactHandoff(leaky);
    expect(out.deviations[0].from).toBe("used «redacted-github-token»");
    expect(out.followUps[0].where).toBe(".env has «redacted-github-token»");
    expect(out.unproven[0].criterion).toBe("«redacted-github-token»");
    expect(out.deviations[0].to).toBe("b");
    expect(leaky.deviations[0].from).toContain("ghp_");
    expect(redactHandoff(FULL, (s) => `[${s}]`).followUps[0]).toEqual({
      what: "[the review child posts its own handoff]",
      where: "[src/core/ship/reviewChild.ts]",
    });
  });
});

describe("renderHandoffLedgerRows — rows in the plan's follow-ups ledger shape", () => {
  it("one `| Follow-up | Source | Disposition |` row per entry, disposition `open`, the unit and PR as the source", () => {
    const source = "U17 handoff ([#7](https://github.com/acme/api/pull/7))";
    expect(renderHandoffLedgerRows(FULL, { unitId: "U17", pr: PR })).toBe(
      [
        `| Deviation: an empty handoff records nothing → an empty handoff is recorded as three empty lists — an affirmed empty handoff must stay distinguishable from none | ${source} | open |`,
        `| the review child posts its own handoff — src/core/ship/reviewChild.ts | ${source} | open |`,
        `| Unproven: the board comment appears on a live unit issue — no plan runner exists to post it yet | ${source} | open |`,
      ].join("\n"),
    );
    expect(HANDOFF_LEDGER_HEADER).toBe("| Follow-up | Source | Disposition |\n|---|---|---|");
  });

  it("no PR → the source names the unit alone; an empty handoff renders no rows", () => {
    const rows = renderHandoffLedgerRows({ ...emptyHandoff(), followUps: FULL.followUps }, { unitId: "U30" });
    expect(rows).toBe("| the review child posts its own handoff — src/core/ship/reviewChild.ts | U30 handoff | open |");
    expect(renderHandoffLedgerRows(emptyHandoff(), { unitId: "U30", pr: PR })).toBe("");
  });

  it("a pipe, a backslash or a newline inside a field cannot break the row", () => {
    const rows = renderHandoffLedgerRows(
      { ...emptyHandoff(), followUps: [{ what: "a | b\\c", where: "line one\nline two" }] },
      { unitId: "U30" },
    );
    expect(rows).toBe("| a \\| b\\\\c — line one line two | U30 handoff | open |");
    expect(rows.split("\n")).toHaveLength(1);
  });
});

describe("renderHandoffComment — the unit's board-issue comment", () => {
  it("the unit id and the PR link lead; each non-empty list under its own heading; the ledger rows in a fenced block a person can paste; the same bytes for the same object", () => {
    const source = "U17 handoff ([#7](https://github.com/acme/api/pull/7))";
    const expected = [
      "**Handoff — U17** · pull request [#7](https://github.com/acme/api/pull/7)",
      "",
      "### Deviations",
      "",
      "- an empty handoff records nothing → an empty handoff is recorded as three empty lists — an affirmed empty handoff must stay distinguishable from none",
      "",
      "### Follow-ups",
      "",
      "- the review child posts its own handoff — src/core/ship/reviewChild.ts",
      "",
      "### Unproven",
      "",
      "- the board comment appears on a live unit issue — no plan runner exists to post it yet",
      "",
      "### Ledger rows",
      "",
      "Paste into the plan's follow-ups ledger while the plan is `proposed`; a person decides each disposition.",
      "",
      "```markdown",
      HANDOFF_LEDGER_HEADER,
      `| Deviation: an empty handoff records nothing → an empty handoff is recorded as three empty lists — an affirmed empty handoff must stay distinguishable from none | ${source} | open |`,
      `| the review child posts its own handoff — src/core/ship/reviewChild.ts | ${source} | open |`,
      `| Unproven: the board comment appears on a live unit issue — no plan runner exists to post it yet | ${source} | open |`,
      "```",
    ].join("\n");
    expect(renderHandoffComment(FULL, { unitId: "U17", pr: PR })).toBe(expected);
    expect(renderHandoffComment(FULL, { unitId: "U17", pr: PR })).toBe(
      renderHandoffComment(FULL, { unitId: "U17", pr: PR }),
    );
  });

  it("an empty list is omitted with its heading; no PR → the first line says so", () => {
    const out = renderHandoffComment({ ...emptyHandoff(), unproven: FULL.unproven }, { unitId: "U30" })!;
    expect(out.split("\n")[0]).toBe("**Handoff — U30** · no pull request");
    expect(out).not.toContain("### Deviations");
    expect(out).not.toContain("### Follow-ups");
    expect(out).toContain(
      "### Unproven\n\n- the board comment appears on a live unit issue — no plan runner exists to post it yet",
    );
    expect(out).toContain("| U30 handoff | open |");
  });

  it("an entirely empty handoff renders nothing", () => {
    expect(renderHandoffComment(emptyHandoff(), { unitId: "U17", pr: PR })).toBeUndefined();
  });

  it("a newline inside a field is flattened so a bullet stays one list item", () => {
    const out = renderHandoffComment(
      { ...emptyHandoff(), followUps: [{ what: "split\nfile", where: "here" }] },
      { unitId: "U30" },
    )!;
    expect(out).toContain("- split file — here");
  });
});
