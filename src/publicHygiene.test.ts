import { describe, expect, it } from "vitest";
import {
  ALLOW_LINES_PATH,
  ALLOWLIST_PATH,
  CLASSES,
  classesFor,
  growthProblems,
  inScope,
  parseAllowLines,
  ratchetProblems,
  scanText,
  staleAllowEntries,
} from "../scripts/public-hygiene.mjs";

// The public-hygiene ratchet (docs/reference/specs/public-hygiene.md): the public tree
// carries no company, person, tracker, plan-id, platform-id or incident-date
// imprint. Every hit is counted per file and class; the committed allowlist can
// only shrink, and a line that is legitimately allowed is named verbatim.

const classNames = Object.keys(CLASSES);

describe("the classes", () => {
  it("names: company, sibling products, people, the private channel, vault paths — case-insensitive; the English word beside them is left to the line allowlist", () => {
    for (const s of [
      "coreplanelabs/switchboard",
      "CorePlane",
      "the nominal repo",
      "polylane",
      "terrateam",
      "Justin merges",
      "Claude Tag",
      "#switchboard-prompting",
      "op://Employee/x",
      "1Password",
      "littlebird",
    ])
      expect(CLASSES.names.test(s), s).toBe(true);
    expect(CLASSES.names.test("a nominally fine backoff")).toBe(false);
    expect(CLASSES.names.test("justinian")).toBe(false);
  });

  it("trackers: #NNN issue refs and the private org's GitHub URLs; not line anchors, HTML entities, headings or long hex", () => {
    for (const s of [
      "fixes #184",
      "(#43)",
      "github.com/coreplanelabs/switchboard/pull/1",
      "github.com/orgs/coreplanelabs/projects/1",
    ])
      expect(CLASSES.trackers.test(s), s).toBe(true);
    for (const s of ["#L12-L14", "&#39;", "## 2026", "#ff00aa", "#123456", "url/#1", "a#12b"])
      expect(CLASSES.trackers.test(s), s).toBe(false);
  });

  it("planIds: KTD/KD/OQ ids and the bare U/R markers; not Slack user ids, not Cloudflare R2", () => {
    for (const s of ["KTD16", "KD2", "OQ3", "plan U1", "R1 reversibility", "R12"])
      expect(CLASSES.planIds.test(s), s).toBe(true);
    for (const s of ["U0BQNU1AD27", "an R2 bucket", "U0", "URL", "R2D2"])
      expect(CLASSES.planIds.test(s), s).toBe(false);
  });

  it("ids: Slack channel/user/DM ids and 32-hex account ids", () => {
    for (const s of ["C0BQS7KPJHK", "<@U0BQNU1AD27>", "D0ABCDEFGHI", "0123456789abcdef0123456789abcdef"])
      expect(CLASSES.ids.test(s), s).toBe(true);
    for (const s of ["C0", "CORE", "abcdef", "0123456789abcdef0123456789abcdef0"])
      expect(CLASSES.ids.test(s), s).toBe(false);
  });

  it("dates: a full ISO date is an incident narrative until a line says otherwise", () => {
    expect(CLASSES.dates.test("on 2026-09-04 two runs")).toBe(true);
    expect(CLASSES.dates.test("2026-09")).toBe(false);
    expect(CLASSES.dates.test("v1.2.0")).toBe(false);
  });
});

describe("scope", () => {
  it("the public tree: src, deploy, web, scripts, config, docs, .github and the root markdown; not plans, the changelog, generated notices, lockfiles, binaries, or the ratchet's own files", () => {
    for (const p of [
      "src/core/dispatcher.ts",
      "deploy/cloudflare/wrangler.template.jsonc",
      "web/src/App.vue",
      "scripts/docs-gen.ts",
      "config/config.example.yaml",
      "docs/explanation/x.md",
      "docs/decisions/0001-x.md",
      "docs/reference/specs/memory.md",
      ".github/workflows/ci.yml",
      "README.md",
      "AGENTS.md",
      "package.json",
    ])
      expect(inScope(p), p).toBe(true);
    for (const p of [
      "docs/plans/2026-09-04-001-feat-x-plan.md",
      "CHANGELOG.md",
      "THIRD_PARTY_NOTICES.md",
      "package-lock.json",
      "web/package-lock.json",
      "docs/public/logo.svg",
      "docs/images/run.png",
      "skills/pr-tour/SKILL.md",
      ALLOWLIST_PATH,
      ALLOW_LINES_PATH,
      "scripts/public-hygiene.mjs",
      "scripts/public-hygiene.d.mts",
      "src/publicHygiene.test.ts",
      ".nvmrc",
    ])
      expect(inScope(p), p).toBe(false);
  });

  it("decision records and their generated index carry dates and may cite PRs for provenance, so trackers and dates are not counted there; everything else gets every class", () => {
    expect(classesFor("docs/decisions/0007-authorization-policy-table.md")).toEqual(
      classNames.filter((c) => c !== "trackers" && c !== "dates"),
    );
    expect(classesFor("docs/explanation/design-decisions.md")).toEqual(classesFor("docs/decisions/0001-x.md"));
    expect(classesFor("src/core/x.ts")).toEqual(classNames);
  });
});

describe("scanText", () => {
  it("counts hits per class per line and names each hit; one line can hit several classes", () => {
    const { counts, hits } = scanText(
      "src/x.ts",
      ["// see #157 and KTD16", "const ok = 1;", "// Justin on 2026-09-04: coreplane"].join("\n"),
      parseAllowLines(""),
    );
    expect(counts).toEqual({ names: 1, trackers: 1, planIds: 1, dates: 1 });
    expect(hits.map((h) => [h.line, h.cls])).toEqual([
      [1, "trackers"],
      [1, "planIds"],
      [3, "names"],
      [3, "dates"],
    ]);
    expect(hits[0].text).toBe("// see #157 and KTD16");
  });

  it("a line named verbatim in the allow file is skipped and reported as used; classes the path is exempt from are not counted", () => {
    const entry = 'src/x.ts\tconst repo = "nominal"; // the English word: a nominal backoff';
    const { counts, hits, used } = scanText(
      "src/x.ts",
      'const repo = "nominal"; // the English word: a nominal backoff\n// coreplane\n',
      parseAllowLines(entry),
    );
    expect(counts).toEqual({ names: 1 });
    expect(hits).toHaveLength(1);
    expect([...used]).toEqual([entry]);
    expect(scanText("docs/decisions/0001-x.md", "cites #43\n", parseAllowLines("")).counts).toEqual({});
  });

  it("a pattern entry skips every line of its path the pattern matches whole, and is reported used once; another path's identical line is not covered", () => {
    const entry = ".github/workflows/ci.yml\t=~ uses: 1password/load-secrets-action@[0-9a-f]{40} # v\\S+";
    const pinned = "uses: 1password/load-secrets-action@70062d7a876d3eb6334754fa26efd2fbd90c32f2 # v5.0.1";
    const bumped = "uses: 1password/load-secrets-action@eb2efd0703da22a93c467f2d1ffbb6826c11e19c # v4.1.1";
    const allow = parseAllowLines(entry);
    const { counts, hits, used } = scanText(
      ".github/workflows/ci.yml",
      `${pinned}\n${bumped}\n# uses: 1password/load-secrets-action@70062d7a876d3eb6334754fa26efd2fbd90c32f2 # v5.0.1\n`,
      allow,
    );
    expect(counts).toEqual({ names: 1 });
    expect(hits.map((h) => h.line)).toEqual([3]);
    expect([...used]).toEqual([entry]);
    expect(scanText(".github/workflows/other.yml", `${pinned}\n`, allow).counts).toEqual({ names: 1 });
  });
});

describe("the allow file", () => {
  it("one entry per line: path, a tab, the trimmed line text; comments and blanks ignored", () => {
    const allow = parseAllowLines(
      "# why each line is allowed\n\nsrc/a.ts\tconst x = 'nominal'; // English\n\nweb/a.css\tcolor: #111;\n",
    );
    expect(allow.size).toBe(2);
    expect([...allow]).toEqual(["src/a.ts\tconst x = 'nominal'; // English", "web/a.css\tcolor: #111;"]);
  });

  it("a line part starting `=~ ` is a regular expression the whole trimmed line must match; a literal line that merely starts with a slash is not one", () => {
    const allow = parseAllowLines(
      'src/a.ts\t=~ const pin = "[0-9a-f]{40}";\nsrc/b.ts\t/** the 1Password item */\nsrc/c.ts\t=~ v\\d+\n',
    );
    expect(allow.size).toBe(3);
    expect(allow.match("src/a.ts", 'const pin = "0123456789abcdef0123456789abcdef01234567";')).toBe(
      'src/a.ts\t=~ const pin = "[0-9a-f]{40}";',
    );
    expect(allow.match("src/a.ts", 'const pin = "short";')).toBeUndefined();
    expect(allow.match("src/b.ts", "/** the 1Password item */")).toBe("src/b.ts\t/** the 1Password item */");
    expect(allow.match("src/b.ts", "/** the 1Password item */ // more")).toBeUndefined();
    expect(allow.match("src/c.ts", "v12")).toBe("src/c.ts\t=~ v\\d+");
    expect(allow.match("src/c.ts", "v12 and more"), "anchored at both ends").toBeUndefined();
    expect(allow.match("src/a.ts", "v12"), "another path's pattern does not apply").toBeUndefined();
  });

  it("a pattern that does not compile names its entry instead of crashing the scan", () => {
    expect(() => parseAllowLines("src/a.ts\t=~ v(\n")).toThrow(
      /scripts\/public-hygiene\.allow: bad pattern in entry `src\/a\.ts\t=~ v\(` — /,
    );
  });

  it("an entry whose line no longer exists is stale and named — a pattern no line matched too", () => {
    const allow = parseAllowLines("src/a.ts\tgone line\nsrc/b.ts\tstill here\nsrc/c.ts\t=~ nothing .*\n");
    expect(staleAllowEntries(allow, new Set(["src/b.ts\tstill here"]))).toEqual([
      "src/a.ts\tgone line",
      "src/c.ts\t=~ nothing .*",
    ]);
  });
});

describe("growthProblems — what `hygiene:gen` refuses to record", () => {
  it("names only the classes that grew or the files that are new; shrinkage is what gen exists to record", () => {
    const listed = { "src/a.ts": { names: 2 }, "src/b.ts": { planIds: 3 } };
    expect(growthProblems({ "src/a.ts": { names: 1 }, "src/b.ts": { planIds: 3 } }, listed)).toEqual([]);
    expect(growthProblems({ "src/a.ts": { names: 3 }, "src/c.ts": { dates: 1 } }, listed)).toEqual([
      "src/a.ts: names 2 → 3 — new imprint; rewrite the line, or allow it by name in scripts/public-hygiene.allow",
      "src/c.ts: dates 0 → 1 — new imprint; rewrite the line, or allow it by name in scripts/public-hygiene.allow",
    ]);
  });
});

describe("ratchetProblems", () => {
  const listed = { "src/a.ts": { names: 2, trackers: 1 }, "src/b.ts": { planIds: 3 } };

  it("the tree equal to the list is fine; a file that shrank or vanished says to regenerate; a file that grew or is new names the class and the delta", () => {
    expect(ratchetProblems(listed, listed)).toEqual([]);
    expect(ratchetProblems({ "src/a.ts": { names: 1, trackers: 1 }, "src/b.ts": { planIds: 3 } }, listed)).toEqual([
      "src/a.ts: names 2 → 1 — the list only shrinks: run `npm run hygiene:gen` to record the progress",
    ]);
    expect(ratchetProblems({ "src/a.ts": { names: 2, trackers: 1 } }, listed)).toEqual([
      "src/b.ts: planIds 3 → 0 — the list only shrinks: run `npm run hygiene:gen` to record the progress",
    ]);
    expect(
      ratchetProblems(
        { "src/a.ts": { names: 3, trackers: 1 }, "src/b.ts": { planIds: 3 }, "src/c.ts": { dates: 1 } },
        listed,
      ),
    ).toEqual([
      "src/a.ts: names 2 → 3 — new imprint; rewrite the line, or allow it by name in scripts/public-hygiene.allow",
      "src/c.ts: dates 0 → 1 — new imprint; rewrite the line, or allow it by name in scripts/public-hygiene.allow",
    ]);
  });
});
