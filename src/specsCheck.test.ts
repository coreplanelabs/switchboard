import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_FILE,
  collectTestTitles,
  parseGapRows,
  parseHeaderPaths,
  parseProofRefs,
  partitionAgainstBaseline,
  refMatchesNode,
  resolveBareTestFile,
  resolveRefs,
  segmentMatches,
  titleReadings,
  explicitSegment,
  explicitSpan,
} from "../scripts/specs-check.mjs";

// The spec-binding gate's decisions: how a spec's proof references are read,
// how a test file's titles are read, when one names the other, and how the
// baseline of already-stale references shrinks and never grows.

const root = fileURLToPath(new URL("..", import.meta.url));

describe("parseProofRefs", () => {
  it("reads `file::describe::it` and splits the title path", () => {
    const [ref] = parseProofRefs("| c | `[unit]` `src/a.test.ts::outer::inner` |");
    expect(ref).toMatchObject({ line: 1, file: "src/a.test.ts", titles: ["outer", "inner"] });
  });

  it("a `::it` continuation borrows the row's file — the nearest before it, else the first after it", () => {
    const refs = parseProofRefs("| c | `::leaf A`, `src/a.test.ts::D`, `::leaf B`; `src/b.test.ts::E`, `::leaf C` |");
    expect(refs.map((r) => [r.file, r.titles.join("/")])).toEqual([
      ["src/a.test.ts", "leaf A"],
      ["src/a.test.ts", "D"],
      ["src/a.test.ts", "leaf B"],
      ["src/b.test.ts", "E"],
      ["src/b.test.ts", "leaf C"],
    ]);
  });

  it("a label inside the span, an escaped backtick, and a table-escaped pipe are all read", () => {
    const refs = parseProofRefs("| c | `[unit] src/a.test.ts::render::escapes a \\`delimiter\\` and a \\|pipe\\|` |");
    expect(refs[0]).toMatchObject({ file: "src/a.test.ts", titles: ["render", "escapes a `delimiter` and a |pipe|"] });
  });

  it("` > ` inside a title is kept: it may be vitest's nesting separator or a literal", () => {
    const [ref] = parseProofRefs("| c | `src/a.test.ts::render > escapes` |");
    expect(ref.titles).toEqual(["render > escapes"]);
    expect(titleReadings(ref.titles)).toEqual([["render > escapes"], ["render", "escapes"]]);
    expect(titleReadings(["plain"])).toEqual([["plain"]]);
  });

  it("ignores `::` that is not a proof: an IPv6 literal, a symbol, a row with no test file", () => {
    expect(parseProofRefs("| ACCESS | loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) |")).toEqual([]);
    expect(parseProofRefs("| c | `Foo::bar` is not a test |")).toEqual([]);
    expect(parseProofRefs("not a table row `src/a.test.ts::x`")).toEqual([]);
  });

  it("`file::` alone is a whole-file proof", () => {
    expect(parseProofRefs("| c | `src/a.test.ts::` |")[0]).toMatchObject({ file: "src/a.test.ts", titles: [] });
  });
});

describe("resolveBareTestFile", () => {
  const files = ["src/core/commands/runs.test.ts", "deploy/cloudflare-memory/runs.test.ts", "src/x/gc.test.ts"];
  it("keeps a path as it is", () => {
    expect(resolveBareTestFile("src/a.test.ts", files)).toEqual({ file: "src/a.test.ts", ambiguous: [] });
  });
  it("resolves a unique bare name", () => {
    expect(resolveBareTestFile("gc.test.ts", files)).toEqual({ file: "src/x/gc.test.ts", ambiguous: [] });
  });
  it("reports an ambiguous bare name with every candidate", () => {
    expect(resolveBareTestFile("runs.test.ts", files).ambiguous).toHaveLength(2);
  });
  it("an unknown bare name stays bare (reported as not found)", () => {
    expect(resolveBareTestFile("nope.test.ts", files)).toEqual({ file: "nope.test.ts", ambiguous: [] });
  });
});

describe("parseHeaderPaths / parseGapRows", () => {
  it("takes paths with a directory from the Code and Tests headers, not symbols or routes", () => {
    const md = [
      "- **Code**: `src/a.ts`, `Actor`, `conversations.info`, `/runs`, `deploy/cloudflare/`",
      "- **Docs**: `docs/x.md`",
      "- **Tests**: `src/a.test.ts`",
    ].join("\n");
    expect(parseHeaderPaths(md).map((p) => p.path)).toEqual(["src/a.ts", "deploy/cloudflare/", "src/a.test.ts"]);
  });

  it("a [gap] row is linked when it carries a GitHub issue or PR URL", () => {
    const md = [
      "| a | `[gap]` nothing yet |",
      "| b | `[gap]` tracked in https://github.com/o/r/issues/12 |",
      "| c | `[unit]` fine |",
    ].join("\n");
    expect(parseGapRows(md)).toEqual([
      { line: 1, linked: false, criterion: "a" },
      { line: 2, linked: true, criterion: "b" },
    ]);
  });
});

describe("collectTestTitles", () => {
  const src = `
    describe("outer", () => {
      it("plain", () => {});
      describe.each([1, 2])("case %s", (n) => {
        it(\`nested \${n} title\`, () => {});
      });
      it.skip("skipped still counts", () => {});
      test.each(rows)("row $name", () => {});
    });
    it("top level", () => {});
    z.string().describe("not a test");
  `;
  const nodes = collectTestTitles(src);

  it("lists describes and leaves with their ancestry", () => {
    expect(nodes.map((n) => n.parts.join(" > "))).toEqual([
      "outer",
      "outer > plain",
      "outer > case %s",
      "outer > case %s > nested * title",
      "outer > skipped still counts",
      "outer > row $name",
      "top level",
    ]);
  });

  it("marks leaves", () => {
    expect(nodes.find((n) => n.parts.at(-1) === "outer")?.leaf).toBe(false);
    expect(nodes.find((n) => n.parts.at(-1) === "plain")?.leaf).toBe(true);
  });
});

describe("segmentMatches", () => {
  it.each([
    ["exact title", "exact title", true],
    ["prefix…", "prefix and more", true],
    ["prefix *", "prefix and more", true],
    ["capped at 200 …", "capped at 200, with a cursor", true],
    ["*suffix", "some suffix", true],
    ["a … c", "a b c", true],
    ["a … c", "a b d", false],
    ["case 3", "case %s", true],
    ["row two", "row $name", true],
    ["nested 5 title", "nested * title", true],
    ["* — RunStore contract", "* — RunStore contract", true],
    ["different", "title", false],
    // A wildcard-free segment must match exactly: an old title that survives
    // as a substring of the renamed one is drift, not a match.
    ["escapes", "escapes the delimiter twice", false],
    ["escapes the", "escapes the delimiter twice", false],
    ["escapes *", "escapes the %s twice", true],
    ["delimiter …", "escapes the %s twice", false],
  ])("%s vs %s → %s", (segment, part, expected) => {
    expect(segmentMatches(segment, part)).toBe(expected);
  });
});

describe("refMatchesNode", () => {
  const node = { parts: ["outer", "middle", "the leaf"], leaf: true };
  it("matches the full path", () => {
    expect(refMatchesNode(["outer", "middle", "the leaf"], node)).toBe(true);
  });
  it("may skip intermediate describes", () => {
    expect(refMatchesNode(["outer", "the leaf"], node)).toBe(true);
    expect(refMatchesNode(["the leaf"], node)).toBe(true);
  });
  it("the last segment must name the node itself", () => {
    expect(refMatchesNode(["outer", "middle"], node)).toBe(false);
    expect(refMatchesNode(["outer", "middle"], { parts: ["outer", "middle"], leaf: false })).toBe(true);
  });
  it("segments must appear in order", () => {
    expect(refMatchesNode(["middle", "outer", "the leaf"], node)).toBe(false);
  });
});

describe("resolveRefs", () => {
  const titlesFor = (file: string) =>
    file === "src/a.test.ts"
      ? [
          { parts: ["d"], leaf: false },
          { parts: ["d", "works"], leaf: true },
        ]
      : null;

  it("passes a reference that names a real test, a describe, a whole file, or nests with ` > `", () => {
    const refs = [
      { line: 1, file: "src/a.test.ts", titles: ["d", "works"], raw: "" },
      { line: 1, file: "src/a.test.ts", titles: ["d"], raw: "" },
      { line: 1, file: "src/a.test.ts", titles: [], raw: "" },
      { line: 1, file: "src/a.test.ts", titles: ["d > works"], raw: "" },
    ];
    expect(resolveRefs(refs, titlesFor)).toEqual([]);
  });

  it("a literal ` > ` in a test title binds without being split", () => {
    const nodes = [{ parts: ["seq > afterSeq is a cursor"], leaf: true }];
    const refs = [{ line: 1, file: "src/b.test.ts", titles: ["seq > afterSeq is a cursor"], raw: "" }];
    expect(resolveRefs(refs, () => nodes)).toEqual([]);
  });

  it("names the missing file, the ambiguous name, or the title nothing matches", () => {
    const problems = resolveRefs(
      [
        { line: 3, file: "src/gone.test.ts", titles: ["x"], raw: "src/gone.test.ts::x" },
        {
          line: 4,
          file: "runs.test.ts",
          titles: ["x"],
          raw: "runs.test.ts::x",
          ambiguous: ["a/runs.test.ts", "b/runs.test.ts"],
        },
        { line: 5, file: "src/a.test.ts", titles: ["d", "renamed"], raw: "src/a.test.ts::d::renamed" },
      ],
      titlesFor,
    );
    expect(problems.map((p) => p.reason)).toEqual([
      "test file not found: src/gone.test.ts",
      '"runs.test.ts" names 2 test files — write the path: a/runs.test.ts, b/runs.test.ts',
      'no test in src/a.test.ts is titled "d" › "renamed"',
    ]);
  });
});

describe("fix mode — explicitSegment / explicitSpan", () => {
  const parts = [
    "reviewed-head guard (fail closed)",
    "classifyHeadMove — what a moved head means",
    "review agent",
    "review post-step",
    "exact",
  ];

  it.each([
    ["reviewed-head guard", "reviewed-head guard…"],
    ["what a moved head means", "…what a moved head means…"],
    ["exact", "exact"],
    ["review", "review"],
    ["already…", "already…"],
    ["absent", "absent"],
  ])("%s → %s", (segment, expected) => {
    expect(explicitSegment(segment, parts)).toBe(expected);
  });

  const nodes = [
    { parts: ["reviewed-head guard (fail closed)"], leaf: false },
    { parts: ["reviewed-head guard (fail closed)", "the PR head is unknown, so the run never starts"], leaf: true },
    { parts: ["escapes a `delimiter` echo"], leaf: true },
    { parts: ["review agent"], leaf: false },
    { parts: ["review post-step"], leaf: false },
  ];

  it("rewrites each truncated segment and keeps the label, the file, and the escapes", () => {
    expect(explicitSpan("[unit] src/a.test.ts::reviewed-head guard::the PR head is unknown", nodes)).toBe(
      "[unit] src/a.test.ts::reviewed-head guard…::the PR head is unknown…",
    );
    expect(explicitSpan("::escapes a \\`delimiter\\`", nodes)).toBe("::escapes a \\`delimiter\\`…");
  });

  it("returns null when the rewrite still would not bind (ambiguous or absent)", () => {
    expect(explicitSpan("src/a.test.ts::review", nodes)).toBeNull();
    expect(explicitSpan("src/a.test.ts::nothing like this", nodes)).toBeNull();
  });
});

describe("partitionAgainstBaseline", () => {
  const problems = [{ key: "spec.md a" }, { key: "spec.md b" }];
  it("a problem outside the baseline is fresh; a baseline key with no problem is stale", () => {
    const r = partitionAgainstBaseline(problems, ["spec.md b", "spec.md fixed-already"]);
    expect(r.fresh.map((p) => p.key)).toEqual(["spec.md a"]);
    expect(r.known.map((p) => p.key)).toEqual(["spec.md b"]);
    expect(r.stale).toEqual(["spec.md fixed-already"]);
  });
  it("an exact baseline passes with nothing fresh and nothing stale", () => {
    const r = partitionAgainstBaseline(problems, ["spec.md a", "spec.md b"]);
    expect(r.fresh).toEqual([]);
    expect(r.stale).toEqual([]);
  });
});

describe("the repository's own specs", () => {
  it("carry over a thousand proof references, so the parser is reading the real convention", () => {
    const md = readFileSync(new URL("docs/reference/specs/slack-channel.md", `file://${root}`), "utf8");
    expect(parseProofRefs(md).length).toBeGreaterThan(20);
  });

  it("the baseline, while it exists, is sorted, unique, and only ever names spec files", () => {
    const abs = new URL(BASELINE_FILE, `file://${root}`);
    if (!existsSync(abs)) return;
    const { known } = JSON.parse(readFileSync(abs, "utf8")) as { known: string[] };
    expect(known).toEqual([...new Set(known)].sort());
    for (const k of known) expect(k).toMatch(/^features\/[a-z0-9-]+\.md /);
  });
});
