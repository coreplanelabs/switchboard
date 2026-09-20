import { expect, it } from "vitest";
import { growthProblems, ratchetProblems } from "../scripts/public-hygiene.mjs";
import {
  extractFile,
  extractTemplateText,
  extractTypeScriptStrings,
  scanSnippets,
  surfaceFor,
  WORDING,
  WORDS,
} from "../scripts/vocabulary-check.mjs";

// The vocabulary ratchet (docs/reference/specs/public-hygiene.md, record 0066):
// none of the fourteen internal words is printed where a user reads it. The
// check reads what is printed — extracted literals, template text nodes, docs
// lines — never what the code says to itself, and its baseline only shrinks.

it("extracts string literals, never identifiers or comments", () => {
  const snippets = extractTypeScriptStrings(
    "src/core/dispatch/x.ts",
    [
      'import { session } from "./session.js";', // a module path is not printed
      "// the session comment is unseen",
      "const session = 1; /* lease */",
      'const label = "the session ended";',
      "const card = `attempt ${session} of ${`inner segment`}`;",
    ].join("\n"),
    "all",
  );
  const texts = snippets.map((s) => s.text);
  expect(texts).toContain("the session ended");
  expect(texts).toContain("attempt");
  expect(texts).toContain("inner segment");
  // The identifier, the comments and the import specifier contribute nothing.
  expect(texts).not.toContain("./session.js");
  expect(texts.some((t) => t.includes("comment") || t.includes("lease"))).toBe(false);
  expect(scanSnippets(snippets).counts).toEqual({ session: 1, attempt: 1, segment: 1 });
});

it("the registry surface reads only the describe summaries the CLI and tool list print", () => {
  const snippets = extractTypeScriptStrings(
    "src/core/commands/x.ts",
    ['const def = { id: "runs.x", describe: "shows the session", handler: () => "a lease" };'].join("\n"),
    "describe",
  );
  expect(snippets.map((s) => s.text)).toEqual(["shows the session"]);
});

it("a web template text node hits; an attribute binding does not", () => {
  const sfc = [
    "<template>",
    '  <span :title="row.session" aria-label="lease held">',
    "    the session ended <!-- a segment comment -->",
    "    {{ row.lease }}",
    "  </span>",
    "</template>",
    "<script setup>",
    'const attempt = "attempt 2";',
    "</script>",
  ].join("\n");
  const snippets = extractTemplateText(sfc);
  expect(snippets).toEqual([{ line: 3, text: "the session ended" }]);
  expect(scanSnippets(snippets).counts).toEqual({ session: 1 });
});

it("the vocabulary page and the hygiene spec are exempt by path", () => {
  expect(surfaceFor("docs/reference/vocabulary.md")).toBeNull();
  expect(surfaceFor("docs/reference/specs/public-hygiene.md")).toBeNull();
  // The specs keep their internal precision; the non-spec docs trees are surfaces.
  expect(surfaceFor("docs/reference/specs/agent-ship.md")).toBeNull();
  expect(surfaceFor("docs/reference/dashboard-routes.md")).toBe("docs");
  expect(surfaceFor("docs/how-to/operate-production.md")).toBe("docs");
  expect(surfaceFor("docs/tutorials/first-run.md")).toBe("docs");
  expect(surfaceFor("docs/explanation/how-we-work.md")).toBe("docs");
  // The enumerated bot modules and the web templates, never the tests or the twins.
  expect(surfaceFor("src/core/dispatch/messages.ts")).toBe("bot");
  expect(surfaceFor("src/core/ship/coordinator.ts")).toBe("bot");
  expect(surfaceFor("src/core/commands/runs.ts")).toBe("registry");
  expect(surfaceFor("src/core/dispatch/messages.test.ts")).toBeNull();
  expect(surfaceFor("src/core/budgets.ts")).toBeNull();
  expect(surfaceFor("web/src/pages/RunPage.vue")).toBe("web");
  expect(surfaceFor("web/src/lib/api.ts")).toBeNull();
  expect(surfaceFor("scripts/vocabulary-check.mjs")).toBeNull();
  expect(extractFile("docs/reference/vocabulary.md", "the session lease")).toEqual([]);
});

it("the scoped senses — hosted run hits, GitHub-hosted runner does not", () => {
  expect(WORDS.hosted.test("a hosted run keeps its thread")).toBe(true);
  expect(WORDS.hosted.test("the hosted parent")).toBe(true);
  expect(WORDS.hosted.test("hosted pipelines idle")).toBe(true);
  expect(WORDS.hosted.test("a GitHub-hosted runner picks the job")).toBe(false);
  expect(WORDS.hosted.test("self-hosted hardware")).toBe(false);
  expect(WORDS.runner.test("the plan runner opens the pull request")).toBe(true);
  expect(WORDS.runner.test("a GitHub-hosted runner picks the job")).toBe(false);
  // The plain senses hit at word boundaries only.
  expect(WORDS.lease.test("two leases fit")).toBe(true);
  expect(WORDS.lease.test("the run was released")).toBe(false);
  expect(WORDS.tier.test("tier 2")).toBe(true);
  expect(WORDS.tier.test("the frontier")).toBe(false);
  expect(WORDS.handoff.test("the hand-off rows")).toBe(true);
  expect(WORDS["wind-down"].test("at the wind-down note")).toBe(true);
  expect(WORDS["host key"].test("the host keys rotate")).toBe(true);
  expect(Object.keys(WORDS)).toHaveLength(14);
});

it("growth is refused; shrink demands a re-recorded baseline", () => {
  const listed = { "docs/reference/x.md": { session: 2 }, "src/core/ship/y.ts": { lease: 1 } };
  // Equal passes; the shared ratchet speaks this check's own wording.
  expect(ratchetProblems(listed, listed, WORDING)).toEqual([]);
  expect(ratchetProblems({ ...listed, "docs/reference/x.md": { session: 3 } }, listed, WORDING)).toEqual([
    "docs/reference/x.md: session 2 → 3 — an internal word reached a user surface; rewrite it in the user's nouns (docs/reference/vocabulary.md)",
  ]);
  expect(ratchetProblems({ "docs/reference/x.md": { session: 2 } }, listed, WORDING)).toEqual([
    "src/core/ship/y.ts: lease 1 → 0 — the baseline only shrinks: run `npm run vocabulary:gen` to record the retirement",
  ]);
  // The gen refuses growth (nothing recorded) and records shrinkage freely.
  expect(growthProblems({ ...listed, "web/src/z.vue": { attempt: 1 } }, listed, WORDING)).toEqual([
    "web/src/z.vue: attempt 0 → 1 — an internal word reached a user surface; rewrite it in the user's nouns (docs/reference/vocabulary.md)",
  ]);
  expect(growthProblems({ "docs/reference/x.md": { session: 1 } }, listed, WORDING)).toEqual([]);
});
