import { globSync, readFileSync } from "node:fs";
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
      const text = readFileSync(`${DOCS}/${rel}`, "utf8");
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

  it("links that leave the tree point at the repo over https, the one form that resolves on GitHub and on the site", () => {
    const wrong: string[] = [];
    // `plans/**` is not published (srcExclude), so its pages only ever render
    // on GitHub — a relative link out of the tree is correct there.
    for (const rel of pages.filter((p) => !p.startsWith("plans/"))) {
      const text = readFileSync(`${DOCS}/${rel}`, "utf8");
      // A relative link that climbs out of docs/ resolves on GitHub but has no
      // page on the site — the convention is an absolute repo URL instead.
      for (const [line, i] of text.split("\n").map((l, i) => [l, i] as const)) {
        for (const m of line.matchAll(/\]\((\.\.\/[^)]+)\)/g)) {
          const target = m[1];
          const climbs = rel.split("/").length - 1;
          const ups = (target.match(/\.\.\//g) ?? []).length;
          if (ups > climbs) wrong.push(`${rel}:${i + 1} ${target}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
