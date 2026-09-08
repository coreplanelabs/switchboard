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
  it("names: company, sibling products, people, the private channel — case-insensitive; the English word beside them is left to the line allowlist, and 1Password's op:// scheme is an integration, not imprint", () => {
    for (const s of [
      "coreplanelabs/switchboard",
      "CorePlane",
      "the nominal repo",
      "polylane",
      "terrateam",
      "Justin merges",
      "Claude Tag",
      "#switchboard-prompting",
      "littlebird",
    ])
      expect(CLASSES.names.test(s), s).toBe(true);
    for (const s of ["a nominally fine backoff", "justinian", "op://Vault/Item/field", "1Password", "op://Employee/x"])
      expect(CLASSES.names.test(s), s).toBe(false);
    // A vault path that names the company is still caught — by the company, not the scheme.
    expect(CLASSES.names.test("op://CI/coreplane-bot/client-id")).toBe(true);
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
      new Set(),
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
    const allowed = new Set(['src/x.ts\tconst repo = "nominal"; // the English word: a nominal backoff']);
    const { counts, hits, used } = scanText(
      "src/x.ts",
      'const repo = "nominal"; // the English word: a nominal backoff\n// coreplane\n',
      allowed,
    );
    expect(counts).toEqual({ names: 1 });
    expect(hits).toHaveLength(1);
    expect([...used]).toEqual([...allowed]);
    expect(scanText("docs/decisions/0001-x.md", "cites #43\n", new Set()).counts).toEqual({});
  });

  it("an allow entry whose line no longer matches any class is not used — it reads as stale, so the allow file cannot carry dead weight", () => {
    const entry = "src/x.ts\tconst scheme = 'op://Vault/Item'; // plain integration syntax";
    const { counts, used } = scanText(
      "src/x.ts",
      "const scheme = 'op://Vault/Item'; // plain integration syntax\n",
      new Set([entry]),
    );
    expect(counts).toEqual({});
    expect(used.size).toBe(0);
    expect(staleAllowEntries(new Set([entry]), used)).toEqual([entry]);
  });
});

describe("the allow file", () => {
  it("one entry per line: path, a tab, the trimmed line text; comments and blanks ignored", () => {
    const allow = parseAllowLines(
      "# why each line is allowed\n\nsrc/a.ts\tconst x = 'nominal'; // English\n\nweb/a.css\tcolor: #111;\n",
    );
    expect([...allow]).toEqual(["src/a.ts\tconst x = 'nominal'; // English", "web/a.css\tcolor: #111;"]);
  });

  it("an entry whose line no longer exists is stale and named", () => {
    const allow = new Set(["src/a.ts\tgone line", "src/b.ts\tstill here"]);
    expect(staleAllowEntries(allow, new Set(["src/b.ts\tstill here"]))).toEqual(["src/a.ts\tgone line"]);
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
