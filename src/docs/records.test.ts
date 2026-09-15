import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  baseRecords,
  frozenFrontmatter,
  immutabilityProblems,
  MUTABLE_KEYS,
  parseFrontmatter,
  RECORD_DIRS,
  STATUSES,
  statusProblems,
  type BaseHistory,
} from "./records.js";

// The records gate (docs/reference/specs/docs-site.md, the documentation rule): every
// decision record and dated plan carries a status from the closed set, a
// superseded record names what replaced it, and an accepted record's body is
// frozen against the base branch — a change is a new record, never an edit.

const root = fileURLToPath(new URL("../..", import.meta.url));

const rec = (path: string, front: Record<string, string> | null, body = "# A record\n\nThe decision.\n") =>
  front
    ? {
        path,
        text: `---\n${Object.entries(front)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}\n---\n${body}`,
      }
    : { path, text: body };
const yes = () => true;

describe("parseFrontmatter", () => {
  it("reads the key: value lines between the fences and keeps the body verbatim; no fences → no fields", () => {
    const { fields, body } = parseFrontmatter("---\ntitle: X\nstatus: accepted\ndate: 2026-09-08\n---\n# X\n\nbody\n");
    expect(fields).toEqual({ title: "X", status: "accepted", date: "2026-09-08" });
    expect(body).toBe("# X\n\nbody\n");
    expect(parseFrontmatter("# no front\n")).toEqual({ fields: null, body: "# no front\n" });
    expect(parseFrontmatter("---\nunterminated\n")).toEqual({ fields: null, body: "---\nunterminated\n" });
  });

  it("frozenFrontmatter drops exactly the keys a record may change after acceptance", () => {
    expect(MUTABLE_KEYS).toEqual(["status", "superseded_by"]);
    expect(frozenFrontmatter({ title: "X", status: "accepted", superseded_by: "y.md", date: "d" })).toEqual({
      title: "X",
      date: "d",
    });
  });
});

describe("statusProblems", () => {
  const good = rec("docs/decisions/0001-x.md", { title: "X", status: "accepted", date: "2026-09-08" });

  it("a well-formed record has no problem; every status in the closed set is accepted", () => {
    expect(statusProblems([good], yes)).toEqual([]);
    for (const status of STATUSES)
      expect(
        statusProblems(
          [
            rec("docs/plans/p.md", {
              status,
              date: "d",
              ...(status === "superseded" ? { superseded_by: "q.md" } : {}),
            }),
          ],
          yes,
        ),
      ).toEqual([]);
    expect(RECORD_DIRS).toEqual(["docs/decisions", "docs/plans"]);
  });

  it("no frontmatter, no status, a status outside the set, no date, and a decision without a title are each named", () => {
    const problems = statusProblems(
      [
        rec("docs/plans/a.md", null),
        rec("docs/plans/b.md", { date: "d" }),
        rec("docs/plans/c.md", { status: "done", date: "d" }),
        rec("docs/plans/d.md", { status: "accepted" }),
        rec("docs/decisions/0002-e.md", { status: "accepted", date: "d" }),
      ],
      yes,
    );
    expect(problems.map((p) => [p.path, p.what.split(" — ")[0].split(" (")[0]])).toEqual([
      ["docs/plans/a.md", "has no frontmatter"],
      ["docs/plans/b.md", "has no `status:`"],
      ["docs/plans/c.md", 'status "done" is not one of proposed | accepted | implemented | superseded'],
      ["docs/plans/d.md", "has no `date:`"],
      ["docs/decisions/0002-e.md", "has no `title:`"],
    ]);
  });

  it("a superseded record must name a `superseded_by` that resolves (relative to its directory, or repo-relative) and is not itself; a non-superseded record must not name one", () => {
    const exists = (p: string) => p === "docs/decisions/0002-y.md";
    expect(
      statusProblems(
        [rec("docs/decisions/0001-x.md", { title: "X", status: "superseded", date: "d", superseded_by: "0002-y.md" })],
        exists,
      ),
    ).toEqual([]);
    expect(
      statusProblems(
        [
          rec("docs/decisions/0001-x.md", {
            title: "X",
            status: "superseded",
            date: "d",
            superseded_by: "docs/decisions/0002-y.md",
          }),
        ],
        exists,
      ),
    ).toEqual([]);
    const bad = statusProblems(
      [
        rec("docs/decisions/0001-x.md", { title: "X", status: "superseded", date: "d" }),
        rec("docs/decisions/0003-z.md", { title: "Z", status: "superseded", date: "d", superseded_by: "nope.md" }),
        rec("docs/decisions/0002-y.md", { title: "Y", status: "superseded", date: "d", superseded_by: "0002-y.md" }),
        rec("docs/decisions/0004-w.md", { title: "W", status: "accepted", date: "d", superseded_by: "0002-y.md" }),
      ],
      exists,
    );
    expect(bad.map((p) => p.what.split(" (")[0])).toEqual([
      "is superseded but names no `superseded_by:`",
      'superseded_by "nope.md" does not resolve',
      "supersedes itself",
      'names `superseded_by:` but its status is "accepted", not superseded',
    ]);
  });
});

describe("immutabilityProblems", () => {
  const accepted = rec("docs/decisions/0001-x.md", { title: "X", status: "accepted", date: "d" });
  const base = new Map([[accepted.path, accepted.text]]);

  it("an unchanged record, a new record, and a status-only change (accepted → implemented, → superseded with superseded_by) are fine", () => {
    expect(immutabilityProblems([accepted], base)).toEqual([]);
    expect(
      immutabilityProblems(
        [accepted, rec("docs/decisions/0009-new.md", { title: "N", status: "proposed", date: "d" })],
        base,
      ),
    ).toEqual([]);
    expect(
      immutabilityProblems([rec("docs/decisions/0001-x.md", { title: "X", status: "implemented", date: "d" })], base),
    ).toEqual([]);
    expect(
      immutabilityProblems(
        [rec("docs/decisions/0001-x.md", { title: "X", status: "superseded", date: "d", superseded_by: "0002-y.md" })],
        base,
      ),
    ).toEqual([]);
  });

  it("a proposed record may still change; an accepted one may not — body edits and frozen-frontmatter edits are named, with the remedy", () => {
    const proposed = rec("docs/plans/p.md", { status: "proposed", date: "d" });
    expect(
      immutabilityProblems(
        [rec("docs/plans/p.md", { status: "proposed", date: "d" }, "# rewritten\n")],
        new Map([[proposed.path, proposed.text]]),
      ),
    ).toEqual([]);
    const edited = immutabilityProblems(
      [
        rec(
          "docs/decisions/0001-x.md",
          { title: "X renamed", status: "accepted", date: "d" },
          "# A record\n\nA different decision.\n",
        ),
      ],
      base,
    );
    expect(edited.map((p) => p.what)).toEqual([
      expect.stringContaining(
        "was accepted on the base and its body changed — a record is never edited; write a new one",
      ),
      expect.stringContaining("frontmatter changed beyond status/superseded_by"),
    ]);
    expect(immutabilityProblems([rec("docs/decisions/0001-x.md", null)], base).map((p) => p.what)).toEqual([
      "was accepted and lost its frontmatter",
    ]);
  });

  it("an accepted record may grow by an appended dated `## Amended` section that carries a re-evaluation; anything else about the change is named", () => {
    const original = "# A record\n\nThe decision.\n";
    const amendment = (heading: string, text: string) => `${original}\n${heading}\n\n${text}\n`;
    const amended = (body: string) =>
      rec("docs/decisions/0001-x.md", { title: "X", status: "accepted", date: "d" }, body);
    // The one allowed edit: the original text byte-identical, then a dated heading and its re-evaluation.
    expect(
      immutabilityProblems(
        [
          amended(
            amendment(
              "## Amended 1999-12-31 — the proof is the real binary",
              "*Re-evaluation.* Checked against both grounds; the change strengthens the second.",
            ),
          ),
        ],
        base,
      ),
    ).toEqual([]);
    // Two amendments appended at once, each with its re-evaluation, are fine too.
    expect(
      immutabilityProblems(
        [
          amended(
            `${amendment("## Amended 1999-12-31 — first", "*Re-evaluation.* One.")}\n## Amended 1999-12-30 — second\n\nRe-evaluation: two.\n`,
          ),
        ],
        base,
      ),
    ).toEqual([]);
    // An appended section under any other heading is an edit.
    expect(
      immutabilityProblems([amended(amendment("## Addendum", "*Re-evaluation.* Text."))], base).map((p) => p.what),
    ).toEqual([expect.stringContaining("its body changed")]);
    // An amendment without a re-evaluation is an edit: the documentation rule requires one after acceptance.
    expect(
      immutabilityProblems(
        [amended(amendment("## Amended 1999-12-31 — no reasoning", "We changed our minds."))],
        base,
      ).map((p) => p.what),
    ).toEqual([expect.stringContaining("its body changed")]);
    // A change above the amendment heading is an edit, however good the amendment.
    expect(
      immutabilityProblems(
        [amended(`# A record\n\nA different decision.\n\n## Amended 1999-12-31 — x\n\n*Re-evaluation.* Text.\n`)],
        base,
      ).map((p) => p.what),
    ).toEqual([expect.stringContaining("its body changed")]);
    // A section under another heading smuggled inside an amendment is an edit too.
    expect(
      immutabilityProblems(
        [amended(amendment("## Amended 1999-12-31 — x", "*Re-evaluation.* Text.\n\n## New policy\n\nSomething else."))],
        base,
      ).map((p) => p.what),
    ).toEqual([expect.stringContaining("its body changed")]);
    // The heading must open a line of its own: glued to a body without a trailing newline it is text.
    const unterminated = rec(
      "docs/decisions/0002-u.md",
      { title: "U", status: "accepted", date: "d" },
      "# U\n\nThe decision.",
    );
    const unterminatedBase = new Map([[unterminated.path, unterminated.text]]);
    const grown = (tail: string) =>
      rec("docs/decisions/0002-u.md", { title: "U", status: "accepted", date: "d" }, `# U\n\nThe decision.${tail}`);
    expect(
      immutabilityProblems([grown("## Amended 1999-12-31 — x\n\n*Re-evaluation.* Text.\n")], unterminatedBase).map(
        (p) => p.what,
      ),
    ).toEqual([expect.stringContaining("its body changed")]);
    expect(
      immutabilityProblems([grown("\n\n## Amended 1999-12-31 — x\n\n*Re-evaluation.* Text.\n")], unterminatedBase),
    ).toEqual([]);
    // The remedy names both roads.
    expect(immutabilityProblems([amended("# A record\n\nA different decision.\n")], base).map((p) => p.what)).toEqual([
      expect.stringContaining("append a dated `## Amended <date>` section carrying a re-evaluation"),
    ]);
  });

  it("an accepted record that is gone from the tree (deleted or renamed) is named; a proposed one may go", () => {
    const proposed = rec("docs/plans/p.md", { status: "proposed", date: "d" });
    const b = new Map([
      [accepted.path, accepted.text],
      [proposed.path, proposed.text],
    ]);
    expect(immutabilityProblems([], b)).toEqual([
      {
        path: "docs/decisions/0001-x.md",
        what: "was accepted on the base and is gone from the tree — a record is never deleted or renamed; supersede it",
      },
    ]);
    expect(
      immutabilityProblems([rec("docs/decisions/0001-x.md", { title: "X", status: "accepted", date: "d" })], b),
    ).toEqual([]);
  });

  it("status never moves backwards from implemented or superseded (implemented → superseded is the one forward step)", () => {
    const implemented = rec("docs/plans/i.md", { status: "implemented", date: "d" });
    const b = new Map([[implemented.path, implemented.text]]);
    expect(
      immutabilityProblems([rec("docs/plans/i.md", { status: "accepted", date: "d" })], b).map((p) => p.what),
    ).toEqual(["status may not go from implemented back to accepted"]);
    expect(
      immutabilityProblems([rec("docs/plans/i.md", { status: "superseded", date: "d", superseded_by: "j.md" })], b),
    ).toEqual([]);
  });
});

describe("baseRecords", () => {
  const path = "docs/decisions/0038-x.md";
  const proposed = rec(path, { title: "X", status: "proposed", date: "d" }, "# X\n\nFirst draft.\n");
  const accepted = rec(path, { title: "X", status: "accepted", date: "d" }, "# X\n\nFirst draft.\n\nAccepted words.\n");
  /** A history: `origin/main` at `tip`, the branch cut at `cut`; each commit's records by path. */
  const history = (commits: Record<string, Record<string, string>>, mergeBase: string | null = "cut"): BaseHistory => ({
    commitOf: (ref) => (ref === "origin/main" ? "tip" : ref in commits ? ref : null),
    mergeBase: (a, b) => (a === "HEAD" && b === "tip" ? mergeBase : null),
    recordPaths: (commit) => Object.keys(commits[commit] ?? {}),
    textAt: (commit, p) => commits[commit][p],
  });

  it("reads the copies at the merge-base of HEAD and the ref, not the ref's tip: a branch behind a record accepted on main since it was cut passes, and a branch that itself edits a frozen record still fails", () => {
    // The false positive: main accepted the record after the branch was cut; the branch never touched it.
    const behind = baseRecords(
      "origin/main",
      history({ cut: { [path]: proposed.text }, tip: { [path]: accepted.text } }),
    );
    expect(behind).toMatchObject({ kind: "found", commit: "cut" });
    if (behind.kind !== "found") throw new Error("unreachable");
    expect(behind.texts.get(path)).toBe(proposed.text);
    expect(immutabilityProblems([proposed], behind.texts)).toEqual([]);
    // Measured from the tip the same branch would have been an edit — the defect this rule removes.
    expect(immutabilityProblems([proposed], new Map([[path, accepted.text]]))).toHaveLength(1);
    // The rule still bites: a branch cut after acceptance that edits the body differs from its own merge-base.
    const edited = rec(
      path,
      { title: "X", status: "accepted", date: "d" },
      "# X\n\nFirst draft.\n\nAccepted words, reworded.\n",
    );
    const editing = baseRecords(
      "origin/main",
      history({ cut: { [path]: accepted.text }, tip: { [path]: accepted.text } }),
    );
    if (editing.kind !== "found") throw new Error("unreachable");
    expect(immutabilityProblems([edited], editing.texts).map((p) => p.what)).toEqual([
      expect.stringContaining("was accepted on the base and its body changed"),
    ]);
  });

  it("a ref that does not resolve, or a history that connects HEAD to no common ancestor, is unreachable by name — the host skips the immutability half and says so", () => {
    expect(baseRecords("origin/main", { ...history({}), commitOf: () => null })).toEqual({
      kind: "unreachable",
      why: "origin/main is not reachable here",
    });
    expect(baseRecords("origin/main", history({ tip: {} }, null))).toEqual({
      kind: "unreachable",
      why: "HEAD and origin/main share no ancestor here",
    });
  });
});

describe("the records in this tree", () => {
  it("every decision record and dated plan carries a valid status, and every superseded_by resolves", () => {
    const records = RECORD_DIRS.flatMap((dir) => {
      const abs = join(root, dir);
      if (!existsSync(abs)) return [];
      return readdirSync(abs)
        .filter((n) => n.endsWith(".md") && n !== "README.md")
        .sort()
        .map((n) => ({ path: `${dir}/${n}`, text: readFileSync(join(abs, n), "utf8") }));
    });
    expect(records.length).toBeGreaterThan(0);
    expect(statusProblems(records, (p) => existsSync(join(root, p)))).toEqual([]);
  });
});
