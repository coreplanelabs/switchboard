import { describe, expect, it } from "vitest";
import {
  ADDRESS_SEVERITIES,
  buildReviewChannelReply,
  buildReviewPostBody,
  CHANGES_TOKEN,
  FINDING_SEVERITIES,
  findingsAtOrAbove,
  formatFinding,
  isFindingDispositionsShape,
  isReviewPostShape,
  isReviewVerdictShape,
  LGTM_TOKEN,
  NO_VERDICT_LINE,
  parseDispositionsInput,
  parseVerdictInput,
  redactDispositions,
  redactReviewPost,
  redactVerdict,
  severityAtOrAbove,
  verdictLine,
} from "./reviewVerdict.js";

// Feature: docs/reference/specs/run-history.md items 2 and 3 — the verdict and
// the dispositions ride the finished run's record, checked for shape (never
// bounds) when read back and redacted at every string leaf when written.
describe("the stored shapes — isReviewVerdictShape, isFindingDispositionsShape, and their redaction", () => {
  const verdict = parseVerdictInput({
    verdict: "request_changes",
    summary: "one nit",
    head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    findings: [{ id: "F1", severity: "minor", file: "src/a.ts", line: 3, title: "off by one" }],
  })!;

  it("accepts a parsed verdict and its JSON round-trip, with or without findings and a head; refuses a non-object, an unknown verdict kind, a non-string summary, non-array findings and a finding missing its id, severity, file or title", () => {
    expect(isReviewVerdictShape(verdict)).toBe(true);
    expect(isReviewVerdictShape(JSON.parse(JSON.stringify(verdict)))).toBe(true);
    expect(isReviewVerdictShape({ verdict: "approve", summary: "" })).toBe(true);
    expect(isReviewVerdictShape(null)).toBe(false);
    expect(isReviewVerdictShape({ verdict: "maybe", summary: "x" })).toBe(false);
    expect(isReviewVerdictShape({ verdict: "approve", summary: 7 })).toBe(false);
    expect(isReviewVerdictShape({ verdict: "approve", summary: "x", findings: "F1" })).toBe(false);
    expect(isReviewVerdictShape({ verdict: "approve", summary: "x", head: 7 })).toBe(false);
    for (const missing of ["id", "severity", "file", "title"]) {
      const finding: Record<string, unknown> = { id: "F1", severity: "minor", file: "src/a.ts", title: "t" };
      delete finding[missing];
      expect(isReviewVerdictShape({ verdict: "approve", summary: "x", findings: [finding] }), missing).toBe(false);
    }
    expect(
      isReviewVerdictShape({
        verdict: "approve",
        summary: "x",
        findings: [{ id: "F1", severity: "huge", file: "a", title: "t" }],
      }),
    ).toBe(false);
  });

  it("accepts a parsed disposition set and its round-trip; refuses a non-array, a non-object entry, an unknown disposition and a non-string note", () => {
    const set = parseDispositionsInput({ dispositions: [{ findingId: "F1", disposition: "fixed", note: "done" }] })!;
    expect(isFindingDispositionsShape(set.dispositions)).toBe(true);
    expect(isFindingDispositionsShape(JSON.parse(JSON.stringify(set.dispositions)))).toBe(true);
    expect(isFindingDispositionsShape([])).toBe(true);
    expect(isFindingDispositionsShape({})).toBe(false);
    expect(isFindingDispositionsShape([7])).toBe(false);
    expect(isFindingDispositionsShape([{ findingId: "F1", disposition: "maybe", note: "x" }])).toBe(false);
    expect(isFindingDispositionsShape([{ findingId: "F1", disposition: "fixed", note: 7 }])).toBe(false);
  });

  it("redaction walks the summary, every finding's title and file, and every disposition's note — the input untouched", () => {
    const token = `ghp_${"a".repeat(24)}`;
    const leaky = parseVerdictInput({
      verdict: "approve",
      summary: `used ${token}`,
      findings: [{ id: "F1", severity: "nit", file: `src/${token}.ts`, title: `see ${token}` }],
    })!;
    const redacted = redactVerdict(leaky);
    expect(JSON.stringify(redacted)).not.toContain("ghp_");
    expect(redacted.summary).toBe("used «redacted-github-token»");
    expect(redacted.findings?.[0]).toMatchObject({ id: "F1", severity: "nit", title: "see «redacted-github-token»" });
    expect(leaky.summary).toContain("ghp_");
    const notes = redactDispositions([{ findingId: "F1", disposition: "declined", note: `because ${token}` }]);
    expect(notes).toEqual([{ findingId: "F1", disposition: "declined", note: "because «redacted-github-token»" }]);
  });
});

// Feature: docs/reference/specs/agent-review.md — deterministic verdict token. The
// auto-approve workflow keys on `startsWith(body, "LGTM:")`, so the first line
// is produced by code from the structured verdict, never by the model's prose.
// Feature: docs/reference/specs/agent-review.md item 5b — both surfaces are
// rendered from the typed verdict. The GitHub comment: the token line first
// (the auto-approve contract), a GitHub alert callout with the verdict word,
// the pinned head and the finding counts, a findings table linked at the head,
// the model's text folded under `Full review`, a machine-readable marker last.
describe("review verdict → post body", () => {
  const NIT = {
    id: "F2",
    severity: "nit",
    file: "src/pages/prompts/[slug].astro",
    line: 48,
    title: "Comment says 34 recipes; there are 32",
  };
  const MINOR = {
    id: "F1",
    severity: "minor",
    file: "src/data/removed-pages.mjs",
    title: "Removed use-case URLs 404 with no redirect",
  };
  const HEAD = "ca726ad9d4f3b1c2e5a6b7c8d9e0f1a2b3c4d5e6";
  const TARGET = { repo: "acme/site", head: HEAD };

  it("approve → the exact `LGTM:` token line first, a NOTE callout with the verdict word, the pinned head and the counts, the prose folded under `Full review`", () => {
    const v = parseVerdictInput({ verdict: "approve", summary: "no blocking issues", findings: [NIT] })!;
    const body = buildReviewPostBody("F2: the comment predates the two recipes that were cut.", v, TARGET);
    expect(
      body.startsWith(
        `${LGTM_TOKEN} no blocking issues\n\n> [!NOTE]\n> **Approved** · head \`ca726ad\` · 1 finding: 1 nit\n`,
      ),
    ).toBe(true);
    expect(body).toContain(
      "<details>\n<summary>Full review</summary>\n\nF2: the comment predates the two recipes that were cut.\n\n</details>",
    );
  });

  it("request_changes → WARNING callout, never starts with LGTM even if the prose does", () => {
    const v = parseVerdictInput({
      verdict: "request_changes",
      summary: "null deref in handler",
      findings: [MINOR, NIT],
    })!;
    const body = buildReviewPostBody("LGTM overall but one blocker...", v, TARGET);
    expect(
      body.startsWith(
        `${CHANGES_TOKEN} null deref in handler\n\n> [!WARNING]\n> **Changes requested** · head \`ca726ad\` · 2 findings: 1 minor, 1 nit\n`,
      ),
    ).toBe(true);
    expect(body.startsWith("LGTM")).toBe(false);
  });

  it("no verdict → fail-closed: the non-approving line, a CAUTION callout, no table, the prose preserved", () => {
    const body = buildReviewPostBody("LGTM: ship it", undefined, TARGET);
    expect(
      body.startsWith(
        `${NO_VERDICT_LINE}\n\n> [!CAUTION]\n> **No verdict** · head \`ca726ad\` · the run ended without a submit_verdict call\n`,
      ),
    ).toBe(true);
    expect(body.startsWith("LGTM")).toBe(false);
    expect(body).not.toContain("| Severity |");
    expect(body).toContain("LGTM: ship it"); // the prose is kept, just not first
  });

  it("findings render as a table — severity, id + title, the file linked at the pinned head, `#L<line>` when the finding has one", () => {
    const v = parseVerdictInput({ verdict: "request_changes", summary: "two", findings: [MINOR, NIT] })!;
    const body = buildReviewPostBody("prose", v, TARGET);
    expect(body).toContain(
      "| Severity | Finding | Where |\n| --- | --- | --- |\n" +
        `| minor | **F1** Removed use-case URLs 404 with no redirect | [\`src/data/removed-pages.mjs\`](https://github.com/acme/site/blob/${HEAD}/src/data/removed-pages.mjs) |\n` +
        `| nit | **F2** Comment says 34 recipes; there are 32 | [\`src/pages/prompts/[slug].astro:48\`](https://github.com/acme/site/blob/${HEAD}/src/pages/prompts/%5Bslug%5D.astro#L48) |\n`,
    );
  });

  it("without a target the Where cell is plain code and the callout names no head; a pipe in a title is escaped so the row holds", () => {
    const v = parseVerdictInput({
      verdict: "request_changes",
      summary: "s",
      findings: [{ ...MINOR, title: "a | b" }],
    })!;
    const body = buildReviewPostBody("prose", v);
    expect(body).toContain("> **Changes requested** · 1 finding: 1 minor\n");
    expect(body).toContain("| minor | **F1** a \\| b | `src/data/removed-pages.mjs` |");
  });

  it("a file that is not a path (spaces, a URL) is never linked", () => {
    const v = parseVerdictInput({
      verdict: "request_changes",
      summary: "s",
      findings: [
        { ...MINOR, file: "PR description" },
        { ...NIT, file: "https://x.test/a" },
      ],
    })!;
    const body = buildReviewPostBody("prose", v, TARGET);
    expect(body).toContain("| minor | **F1** Removed use-case URLs 404 with no redirect | `PR description` |");
    expect(body).toContain("| nit | **F2** Comment says 34 recipes; there are 32 | `https://x.test/a:48` |");
    expect(body).not.toContain("blob/");
  });

  it("the counts: an empty findings array says `no findings`, no array says `findings not itemized`; neither renders a table", () => {
    const empty = buildReviewPostBody(
      "Fine.",
      parseVerdictInput({ verdict: "approve", summary: "ok", findings: [] })!,
      TARGET,
    );
    expect(empty).toContain("> **Approved** · head `ca726ad` · no findings\n");
    expect(empty).not.toContain("| Severity |");
    const none = buildReviewPostBody("Fine.", parseVerdictInput({ verdict: "approve", summary: "ok" })!, TARGET);
    expect(none).toContain("> **Approved** · head `ca726ad` · findings not itemized\n");
    expect(none).not.toContain("| Severity |");
  });

  it("an empty answer renders no `Full review` block; the body ends with the machine-readable verdict marker", () => {
    const v = parseVerdictInput({ verdict: "approve", summary: "ok", findings: [NIT] })!;
    const body = buildReviewPostBody("  \n", v, TARGET);
    expect(body).not.toContain("<details>");
    const marker = body.split("\n").at(-1)!;
    const m = /^<!-- switchboard:verdict (.*) -->$/.exec(marker);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual({
      verdict: "approve",
      head: HEAD,
      findings: [{ id: "F2", severity: "nit", file: "src/pages/prompts/[slug].astro", line: 48 }],
    });
    expect(buildReviewPostBody("x", undefined).split("\n").at(-1)).toBe(
      '<!-- switchboard:verdict {"verdict":"none"} -->',
    );
  });

  it("summary is collapsed to one line so the token line cannot be split", () => {
    expect(verdictLine({ verdict: "approve", summary: "  ok\n\nreally\n" })).toBe("LGTM: ok really");
    expect(verdictLine({ verdict: "approve", summary: "" })).toBe("LGTM:");
  });

  it("parseVerdictInput accepts only the two verdict values", () => {
    expect(parseVerdictInput({ verdict: "approve", summary: "fine" })).toEqual({ verdict: "approve", summary: "fine" });
    expect(parseVerdictInput({ verdict: "request_changes" })).toEqual({ verdict: "request_changes", summary: "" });
    expect(parseVerdictInput({ verdict: "LGTM" })).toBeNull();
    expect(parseVerdictInput({ verdict: "approved" })).toBeNull();
    expect(parseVerdictInput({})).toBeNull();
    expect(parseVerdictInput({ verdict: 1 })).toBeNull();
  });

  // Feature: docs/reference/specs/agent-ship.md item 6 — typed findings on the verdict.
  // Validated fail-closed PER finding: a malformed finding drops with a note,
  // a malformed findings array drops the whole field — the verdict itself
  // still stands either way.
  describe("findings (agent-ship item 6)", () => {
    const F1 = { id: "F1", severity: "blocking", file: "src/a.ts", line: 12, title: "Null deref in handler" } as const;
    const F2 = { id: "F2", severity: "nit", file: "src/b.ts", title: "Rename x" } as const;

    it("parses valid findings in order", () => {
      const v = parseVerdictInput({ verdict: "request_changes", summary: "two issues", findings: [F1, F2] });
      expect(v).toEqual({ verdict: "request_changes", summary: "two issues", findings: [F1, F2] });
    });

    it("a malformed single finding drops with a note naming it; the verdict and the other findings stand", () => {
      const v = parseVerdictInput({
        verdict: "request_changes",
        summary: "s",
        findings: [
          { id: "F1", severity: "major", file: "a.ts", title: "ok" },
          { id: "F2", severity: "meh", file: "b.ts", title: "bad severity" },
          { id: "", severity: "nit", file: "c.ts", title: "no id" },
        ],
      })!;
      expect(v.verdict).toBe("request_changes");
      expect(v.findings).toEqual([{ id: "F1", severity: "major", file: "a.ts", title: "ok" }]);
      expect(v.droppedFindings).toHaveLength(2);
      expect(v.droppedFindings![0]).toContain("F2");
      expect(v.droppedFindings![1]).toContain("findings[2]");
    });

    it("a malformed findings array drops the whole field; the verdict stands", () => {
      const v = parseVerdictInput({ verdict: "approve", summary: "ok", findings: "none" })!;
      expect(v.verdict).toBe("approve");
      expect(v.findings).toBeUndefined();
      expect(v.droppedFindings?.join(" ")).toMatch(/findings/);
    });

    it("approve carrying a blocking finding is downgraded to request_changes with the reason in the summary", () => {
      const v = parseVerdictInput({
        verdict: "approve",
        summary: "ship it",
        findings: [{ id: "F1", severity: "blocking", file: "a.ts", title: "Data loss on retry" }],
      })!;
      expect(v.verdict).toBe("request_changes");
      expect(v.summary).toContain("ship it");
      expect(v.summary).toMatch(/downgraded/i);
      expect(v.summary).toContain("F1");
      const body = buildReviewPostBody("prose", v);
      expect(body.startsWith("LGTM")).toBe(false);
      expect(body.startsWith(CHANGES_TOKEN)).toBe(true);
    });

    it("approve is downgraded even when the blocking finding itself is malformed and drops — never LGTM over a self-declared blocking defect", () => {
      const v = parseVerdictInput({
        verdict: "approve",
        summary: "ok",
        findings: [{ id: "F1", severity: "blocking", file: "a.ts" }], // missing title → the entry drops
      })!;
      expect(v.findings).toEqual([]);
      expect(v.droppedFindings).toHaveLength(1);
      expect(v.verdict).toBe("request_changes");
      expect(v.summary).toContain("F1");
      expect(buildReviewPostBody("prose", v).startsWith("LGTM")).toBe(false);
    });

    // Feature: docs/reference/specs/agent-review.md item 5 — the human-gated
    // flag beside the severity (issue 1990): a reviewer marks a finding whose
    // remedy is a receipt only a person can produce, and ship's coordinator
    // reads that flag — never prose — so the flag must round-trip the parser,
    // the stored shape, the redaction and the rendered surfaces.
    it("humanGated round-trips: `true` survives the parse, the stored shape, the redaction, the compact line and the marker; anything else is dropped and the finding stands actionable", () => {
      const v = parseVerdictInput({
        verdict: "request_changes",
        summary: "one receipt is a person's",
        findings: [
          { id: "F1", severity: "minor", file: "docs/replay.md", title: "entry replay receipt", humanGated: true },
          { id: "F2", severity: "minor", file: "src/b.ts", title: "off by one", humanGated: "yes" },
          { id: "F3", severity: "minor", file: "src/c.ts", title: "naming", humanGated: false },
        ],
      })!;
      expect(v.findings).toEqual([
        { id: "F1", severity: "minor", file: "docs/replay.md", title: "entry replay receipt", humanGated: true },
        { id: "F2", severity: "minor", file: "src/b.ts", title: "off by one" },
        { id: "F3", severity: "minor", file: "src/c.ts", title: "naming" },
      ]);
      expect(v.droppedFindings).toBeUndefined();
      // The stored shape admits the flag (true or absent, nothing else).
      expect(isReviewVerdictShape(v)).toBe(true);
      expect(
        isReviewVerdictShape({
          verdict: "approve",
          summary: "",
          findings: [{ id: "F1", severity: "minor", file: "a", title: "t", humanGated: false }],
        }),
      ).toBe(false);
      // Redaction keeps it — the coordinator reads the flag off the record.
      expect(redactVerdict(v).findings![0]!.humanGated).toBe(true);
      expect(redactVerdict(v).findings![1]!.humanGated).toBeUndefined();
      // The compact line names it for the fix round's brief; the marker carries
      // it for a scanner.
      expect(formatFinding(v.findings![0]!)).toBe("[minor] F1 docs/replay.md — entry replay receipt (human-gated)");
      expect(formatFinding(v.findings![1]!)).toBe("[minor] F2 src/b.ts — off by one");
      const body = buildReviewPostBody("prose", v);
      expect(body).toContain('"humanGated":true');
      expect(body.match(/humanGated/g)).toHaveLength(1);
    });

    it("LGTM token contract holds with findings present: approve + findings below the level still starts with the exact token", () => {
      const v = parseVerdictInput({ verdict: "approve", summary: "minor nits only", findings: [F2] })!;
      expect(v.verdict).toBe("approve");
      const body = buildReviewPostBody("prose", v);
      expect(body.startsWith(`${LGTM_TOKEN} minor nits only\n`)).toBe(true);
      expect(body).toContain("| nit | **F2** Rename x | `src/b.ts` |");
    });

    // Feature: docs/reference/specs/agent-review.md item 5a — the severity gate
    // lives where the verdict is parsed: an approve carrying a finding at or
    // above the severity to address is a request_changes, whatever the
    // reviewer's prose says, so `LGTM:` is never minted over a finding the loop
    // must act on. Seen live: a `[major]` under an `LGTM:` line auto-approved
    // a pull request.
    describe("the severity gate — an approve is held to the severity to address (default minor)", () => {
      const at = (severity: string) => ({
        id: "F3",
        severity,
        file: "a.ts",
        line: 149,
        title: "drops the first key's ref",
      });

      it("by default an approve carrying a major finding is downgraded to request_changes naming the finding, its severity and the level", () => {
        const v = parseVerdictInput({ verdict: "approve", summary: "ship it", findings: [at("major")] })!;
        expect(v.verdict).toBe("request_changes");
        expect(v.summary).toContain("ship it");
        expect(v.summary).toMatch(/downgraded from approve/);
        expect(v.summary).toContain("F3 (major)");
        expect(v.summary).toContain("at or above minor");
        expect(buildReviewPostBody("prose", v).startsWith(CHANGES_TOKEN)).toBe(true);
      });

      it("by default an approve carrying a minor finding is downgraded too — minor is the level, and the gate is at-or-above", () => {
        const v = parseVerdictInput({ verdict: "approve", summary: "ok", findings: [at("minor")] })!;
        expect(v.verdict).toBe("request_changes");
        expect(buildReviewPostBody("prose", v).startsWith("LGTM")).toBe(false);
      });

      it("every level × every declared severity: the body starts with `LGTM:` exactly when the finding sits below the level", () => {
        for (const level of ADDRESS_SEVERITIES) {
          for (const severity of FINDING_SEVERITIES) {
            const v = parseVerdictInput(
              { verdict: "approve", summary: "s", findings: [at(severity)] },
              { addressSeverity: level },
            )!;
            const below = FINDING_SEVERITIES.indexOf(severity) > FINDING_SEVERITIES.indexOf(level);
            expect(v.verdict, `level ${level}, finding ${severity}`).toBe(below ? "approve" : "request_changes");
            expect(buildReviewPostBody("p", v).startsWith(LGTM_TOKEN), `level ${level}, finding ${severity}`).toBe(
              below,
            );
          }
        }
      });

      it("the level in force widens or narrows the gate: at `major` a minor finding passes, at `nit` nothing passes", () => {
        const loose = parseVerdictInput(
          { verdict: "approve", summary: "s", findings: [at("minor")] },
          { addressSeverity: "major" },
        )!;
        expect(loose.verdict).toBe("approve");
        const strict = parseVerdictInput(
          { verdict: "approve", summary: "s", findings: [{ ...at("nit"), id: "F9" }] },
          { addressSeverity: "nit" },
        )!;
        expect(strict.verdict).toBe("request_changes");
        expect(strict.summary).toContain("F9 (nit)");
        expect(strict.summary).toContain("at or above nit");
      });

      it("the gate keys on the RAW declared severity: a major finding that drops for a missing title still poisons the approve", () => {
        const v = parseVerdictInput({
          verdict: "approve",
          summary: "ok",
          findings: [{ id: "F3", severity: "major", file: "a.ts" }],
        })!;
        expect(v.findings).toEqual([]);
        expect(v.droppedFindings).toHaveLength(1);
        expect(v.verdict).toBe("request_changes");
        expect(v.summary).toContain("F3 (major)");
      });

      it("a severity outside the ladder (`fyi`) drops with a note and never opens the gate", () => {
        const v = parseVerdictInput({
          verdict: "approve",
          summary: "ok",
          findings: [{ id: "F1", severity: "fyi", file: "a.ts", title: "note" }],
        })!;
        expect(v.verdict).toBe("approve");
        expect(v.findings).toEqual([]);
        expect(v.droppedFindings![0]).toMatch(/invalid severity "fyi"/);
      });

      it("several gated findings are all named once, in order; findings below the level are not", () => {
        const v = parseVerdictInput({
          verdict: "approve",
          summary: "ok",
          findings: [
            { id: "F1", severity: "nit", file: "a.ts", title: "n" },
            { id: "F2", severity: "major", file: "a.ts", title: "m" },
            { id: "F3", severity: "minor", file: "a.ts", title: "mi" },
          ],
        })!;
        expect(v.verdict).toBe("request_changes");
        expect(v.summary).toContain("F2 (major), F3 (minor)");
        expect(v.summary).not.toContain("F1");
      });

      it("request_changes is untouched by the gate: no downgrade note is appended", () => {
        const v = parseVerdictInput({ verdict: "request_changes", summary: "one bug", findings: [at("major")] })!;
        expect(v.summary).toBe("one bug");
      });

      it("severityAtOrAbove and findingsAtOrAbove agree with the ladder; a value off the ladder is never at or above", () => {
        expect(severityAtOrAbove("blocking", "minor")).toBe(true);
        expect(severityAtOrAbove("minor", "minor")).toBe(true);
        expect(severityAtOrAbove("nit", "minor")).toBe(false);
        expect(severityAtOrAbove("fyi", "nit")).toBe(false);
        expect(severityAtOrAbove(undefined, "nit")).toBe(false);
        const all = FINDING_SEVERITIES.map((severity, i) => ({ id: `F${i}`, severity, file: "a", title: "t" }));
        expect(findingsAtOrAbove(all, "major").map((f) => f.severity)).toEqual(["blocking", "major"]);
        expect(findingsAtOrAbove(all, "nit")).toHaveLength(4);
      });
    });

    it("request_changes with findings never yields an LGTM-prefixed body", () => {
      const v = parseVerdictInput({ verdict: "request_changes", summary: "one bug", findings: [F1] })!;
      expect(buildReviewPostBody("prose", v).startsWith("LGTM")).toBe(false);
    });

    it("an unusable optional line is dropped like a malformed head — the finding stands without it", () => {
      const v = parseVerdictInput({
        verdict: "request_changes",
        summary: "s",
        findings: [
          { id: "F1", severity: "major", file: "a.ts", line: "twelve", title: "t" },
          { id: "F2", severity: "major", file: "b.ts", line: 0, title: "t" },
          { id: "F3", severity: "major", file: "c.ts", line: 3.5, title: "t" },
        ],
      })!;
      expect(v.findings).toEqual([
        { id: "F1", severity: "major", file: "a.ts", title: "t" },
        { id: "F2", severity: "major", file: "b.ts", title: "t" },
        { id: "F3", severity: "major", file: "c.ts", title: "t" },
      ]);
      expect(v.droppedFindings).toBeUndefined();
    });

    it("finding text fields are collapsed to one line so the compact list cannot be split", () => {
      const v = parseVerdictInput({
        verdict: "request_changes",
        summary: "s",
        findings: [{ id: " F1 ", severity: "minor", file: " src/a.ts ", title: "  broken\n\nacross lines " }],
      })!;
      expect(v.findings).toEqual([{ id: "F1", severity: "minor", file: "src/a.ts", title: "broken across lines" }]);
    });

    it("an empty findings array is valid and renders no table", () => {
      const v = parseVerdictInput({ verdict: "approve", summary: "ok", findings: [] })!;
      expect(v.findings).toEqual([]);
      const body = buildReviewPostBody("prose", v);
      expect(body.startsWith(`${LGTM_TOKEN} ok\n\n> [!NOTE]\n> **Approved** · no findings\n`)).toBe(true);
      expect(body).not.toContain("| Severity |");
    });
  });

  // docs/reference/specs/agent-ship.md item 6 — the coding side's typed dispositions,
  // validated in parseVerdictInput's fail-closed style: a malformed entry
  // drops with a note, a non-array input rejects the whole call (null).
  describe("dispositions (agent-ship item 6)", () => {
    it("parses a valid set", () => {
      const parsed = parseDispositionsInput({
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
          { findingId: "F2", disposition: "declined", note: "by design" },
        ],
      });
      expect(parsed).toEqual({
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
          { findingId: "F2", disposition: "declined", note: "by design" },
        ],
        dropped: [],
      });
    });

    it("a non-array dispositions input is null (the call is rejected, nothing recorded)", () => {
      expect(parseDispositionsInput({})).toBeNull();
      expect(parseDispositionsInput({ dispositions: "all fixed" })).toBeNull();
    });

    it("a malformed entry drops with a note naming it; the rest stand", () => {
      const parsed = parseDispositionsInput({
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "done" },
          { findingId: "F2", disposition: "wontfix", note: "nope" },
          { disposition: "fixed", note: "no id" },
        ],
      })!;
      expect(parsed.dispositions).toEqual([{ findingId: "F1", disposition: "fixed", note: "done" }]);
      expect(parsed.dropped).toHaveLength(2);
      expect(parsed.dropped[0]).toContain("F2");
      expect(parsed.dropped[1]).toContain("dispositions[2]");
    });

    it("a missing note is tolerated as empty (the summary convention), never a dropped entry", () => {
      const parsed = parseDispositionsInput({ dispositions: [{ findingId: "F1", disposition: "declined" }] })!;
      expect(parsed.dispositions).toEqual([{ findingId: "F1", disposition: "declined", note: "" }]);
    });
  });

  // docs/reference/specs/agent-review.md item 8: the agent reports the commit it reviewed
  // (`git rev-parse HEAD`); the dispatcher checks it against the PR head.
  it("parseVerdictInput carries a well-formed reported head (7–40 hex, lowercased) and drops anything else", () => {
    const sha = "E8E43F480a09b76989b85ebe6a2a254d99a4d2a3";
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: sha })).toEqual({
      verdict: "approve",
      summary: "ok",
      head: sha.toLowerCase(),
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: " e8e43f4 " })).toEqual({
      verdict: "approve",
      summary: "ok",
      head: "e8e43f4",
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: "HEAD" })).toEqual({
      verdict: "approve",
      summary: "ok",
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: "e8e43f" })).toEqual({
      verdict: "approve",
      summary: "ok",
    });
    expect(parseVerdictInput({ verdict: "approve", summary: "ok", head: 42 })).toEqual({
      verdict: "approve",
      summary: "ok",
    });
  });
});

// docs/reference/specs/run-history.md item 2, agent-review.md item 18 — the review
// post as the record carries it: posted to a named pull request at a pinned
// head, or not posted with the reason; shape-checked when read back, the
// reason redacted when written (it may carry GitHub's own words).
describe("the stored review post — isReviewPostShape and its redaction", () => {
  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const posted = {
    posted: true as const,
    target: { repo: "acme/api", number: 42 },
    head: HEAD,
    verdict: "approve" as const,
  };
  const skipped = { posted: false as const, reason: "digest covered 3 of 5 files" };

  it("accepts a posted outcome (with or without a verdict) and a skipped one, also after a JSON round-trip", () => {
    expect(isReviewPostShape(posted)).toBe(true);
    expect(isReviewPostShape(JSON.parse(JSON.stringify(posted)))).toBe(true);
    const { verdict: _verdict, ...noVerdict } = posted;
    expect(isReviewPostShape(noVerdict)).toBe(true);
    expect(isReviewPostShape({ ...posted, head: HEAD.slice(0, 7) })).toBe(true);
    expect(isReviewPostShape(skipped)).toBe(true);
  });

  it("refuses a non-object, a posted outcome without its target, head or with a head outside the pattern or an unknown verdict, and a skip without a string reason", () => {
    expect(isReviewPostShape(null)).toBe(false);
    expect(isReviewPostShape("posted")).toBe(false);
    expect(isReviewPostShape({ posted: "yes" })).toBe(false);
    expect(isReviewPostShape({ posted: true, head: HEAD })).toBe(false);
    expect(isReviewPostShape({ posted: true, target: { repo: "acme/api" }, head: HEAD })).toBe(false);
    expect(isReviewPostShape({ posted: true, target: { repo: "acme/api", number: 0 }, head: HEAD })).toBe(false);
    expect(isReviewPostShape({ posted: true, target: { repo: "acme/api", number: 42 } })).toBe(false);
    expect(isReviewPostShape({ ...posted, head: "MAIN" })).toBe(false);
    expect(isReviewPostShape({ ...posted, head: "abc" })).toBe(false);
    expect(isReviewPostShape({ ...posted, verdict: "maybe" })).toBe(false);
    expect(isReviewPostShape({ posted: false })).toBe(false);
    expect(isReviewPostShape({ posted: false, reason: 7 })).toBe(false);
  });

  it("redaction walks the skip's reason and leaves a posted outcome as it is", () => {
    const token = `ghp_${"a".repeat(24)}`;
    expect(redactReviewPost({ posted: false, reason: `HTTP 401 for ${token}` })).toEqual({
      posted: false,
      reason: "HTTP 401 for «redacted-github-token»",
    });
    expect(redactReviewPost(posted)).toEqual(posted);
  });
});

// Feature: docs/reference/specs/agent-review.md item 5b — the thread reply is
// rendered from the typed verdict too: the token line, one bullet per finding,
// where it was posted and the run link. The model's write-up rides along only
// when it landed nowhere else (no GitHub post, or findings not itemized), so
// the review's text is always somewhere a person reads it.
describe("review verdict → channel reply (item 5b: Slack gets the verdict and the findings, the prose only when it lands nowhere else)", () => {
  const v = parseVerdictInput({
    verdict: "request_changes",
    summary: "two issues",
    findings: [
      {
        id: "F1",
        severity: "minor",
        file: "src/data/removed-pages.mjs",
        title: "Removed use-case URLs 404 with no redirect",
      },
      {
        id: "F2",
        severity: "nit",
        file: "src/pages/prompts/[slug].astro",
        line: 48,
        title: "Comment says 34 recipes; there are 32",
      },
    ],
  })!;
  const head =
    `${CHANGES_TOKEN} two issues\n` +
    "- [minor] F1 src/data/removed-pages.mjs — Removed use-case URLs 404 with no redirect\n" +
    "- [nit] F2 src/pages/prompts/[slug].astro:48 — Comment says 34 recipes; there are 32";
  const posted = { repo: "acme/site", number: 359 };
  const liveUrl = "https://bot.example/runs/run-x?t=tok";
  const answer = "F1: the redirect table lost two rows.\n\nF2: the count predates the cut.";

  it("posted with itemized findings → the token line, one bullet per finding, the post and the run link — none of the prose", () => {
    expect(buildReviewChannelReply({ answer, verdict: v, posted, liveUrl })).toBe(
      `${head}\n\nPosted to acme/site#359 · [Live run](${liveUrl})`,
    );
  });

  it("not posted (Slack-only, an opt-out, a guard refusal) → the same head, then the prose", () => {
    expect(buildReviewChannelReply({ answer, verdict: v, posted: undefined, liveUrl })).toBe(
      `${head}\n\n${answer}\n\n[Live run](${liveUrl})`,
    );
  });

  it("posted but findings not itemized → the prose rides along: a list that says nothing is no substitute", () => {
    const bare = parseVerdictInput({ verdict: "approve", summary: "fine" })!;
    expect(buildReviewChannelReply({ answer, verdict: bare, posted, liveUrl })).toBe(
      `${LGTM_TOKEN} fine\n\n${answer}\n\nPosted to acme/site#359 · [Live run](${liveUrl})`,
    );
  });

  it("no verdict → the bare answer with the run link, as before; nothing is appended without a URL or a post", () => {
    expect(buildReviewChannelReply({ answer: "answer", verdict: undefined, posted, liveUrl })).toBe(
      `answer\n\n[Live run](${liveUrl})`,
    );
    expect(
      buildReviewChannelReply({ answer: "answer", verdict: undefined, posted: undefined, liveUrl: undefined }),
    ).toBe("answer");
    expect(buildReviewChannelReply({ answer, verdict: v, posted, liveUrl: undefined })).toBe(
      `${head}\n\nPosted to acme/site#359`,
    );
  });
});
