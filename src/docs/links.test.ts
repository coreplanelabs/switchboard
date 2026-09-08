import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The docs tree's absolute URLs, linted.
//
// The site's dead-link check covers INTERNAL links only, so a malformed
// absolute URL keeps the build green — which is how a batch of
// `https:///github.com/…` links (an extra slash) reached review unnoticed.
// Nothing else catches that shape: for http(s) the WHATWG URL parser collapses
// the extra slashes, so browsers follow such a link to the right page and
// `new URL(...)` reports the correct host. It is wrong-but-working, and the
// only thing that can hold the line is a literal check on the separator.

const DOCS = fileURLToPath(new URL("../../docs", import.meta.url));
// Scheme + at least one slash. The slash is what separates a URL from this
// codebase's platform-namespaced ids, which look scheme-ish (`http:cron`,
// `http:*` — see AGENTS.md invariant 4) and are not URLs at all.
const ABSOLUTE_URL = /\bhttps?:\/+[^\s)"'<>\]]*/g;
/** `https:` must be followed by exactly two slashes, then a host character. */
const WELL_FORMED_SCHEME = /^https?:\/\/[^/]/;

/**
 * The markdown with fenced blocks and inline code spans blanked, line count
 * preserved. A span closes on a backtick run of the same length; a `\`` inside
 * one is the specs' notation for a literal backtick (see `specs-check.mjs`).
 */
function withoutCode(markdown: string): string {
  return markdown
    .replace(/\\`/g, "  ")
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(`+)[^`\n][^\n]*?\1/g, (span) => " ".repeat(span.length));
}

function docsPages(): string[] {
  return globSync("**/*.md", { cwd: DOCS }).filter(
    (rel) => !rel.startsWith("node_modules/") && !rel.startsWith(".vitepress/"),
  );
}

describe("absolute URLs in docs/", () => {
  const pages = docsPages();

  it("finds the docs tree (a glob that matches nothing would pass every assertion below)", () => {
    expect(pages.length).toBeGreaterThan(15);
    expect(pages).toContain("README.md");
  });

  it("every absolute URL is `scheme://host` — not `https:///host` (which browsers silently repair) and not a hostless one", () => {
    const broken: string[] = [];
    for (const rel of pages) {
      // Code is quoted text, not a link: a spec that shows the scheme alone
      // (`https://`) or a namespaced-id list (`http:/mcp:`) is not malformed.
      const text = withoutCode(readFileSync(`${DOCS}/${rel}`, "utf8"));
      for (const [line, i] of text.split("\n").map((l, i) => [l, i] as const)) {
        for (const raw of line.match(ABSOLUTE_URL) ?? []) {
          // Trailing punctuation belongs to the prose, not the URL.
          const url = raw.replace(/[.,;:]+$/, "");
          if (!WELL_FORMED_SCHEME.test(url)) {
            broken.push(`${rel}:${i + 1} ${url}`);
            continue;
          }
          try {
            if (new URL(url).hostname === "") broken.push(`${rel}:${i + 1} ${url}`);
          } catch {
            broken.push(`${rel}:${i + 1} ${url}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("a relative link that leaves the tree names a file that exists — the site rewrites it to the repository URL, so only the target's existence can be checked here", () => {
    const wrong: string[] = [];
    // `plans/**` are frozen records (decisions:check) and are not published:
    // a target they named may since have moved, and that is not a defect.
    for (const rel of pages.filter((p) => !p.startsWith("plans/"))) {
      const text = readFileSync(`${DOCS}/${rel}`, "utf8");
      // A relative link that climbs out of docs/ resolves on GitHub to the file
      // and, on the site, to that file's page in the repository (the config's
      // link rule). The site's dead-link check never sees it, so this is the
      // one place a renamed or deleted target is caught.
      for (const [line, i] of text.split("\n").map((l, i) => [l, i] as const)) {
        for (const m of line.matchAll(/\]\((\.\.\/[^)#]+)(?:#[^)]*)?\)/g)) {
          const target = m[1];
          const climbs = rel.split("/").length - 1;
          const ups = (target.match(/\.\.\//g) ?? []).length;
          if (ups <= climbs) continue; // stays inside docs/: the site checks it
          if (!existsSync(resolve(DOCS, dirname(rel), target))) wrong.push(`${rel}:${i + 1} ${target}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
