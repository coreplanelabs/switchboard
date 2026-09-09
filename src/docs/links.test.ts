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

const THEME = `${DOCS}/.vitepress/theme`;

/** The heading ids VitePress derives, as `## Add a provider` → `add-a-provider`. */
function headingIds(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(([, text]) =>
      text
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/\s+/g, "-"),
    ),
  );
}

/** The markdown file a site path is compiled from, honouring the config's README rewrites. */
function pageFor(sitePath: string): string | undefined {
  const rel = sitePath.replace(/^\//, "").replace(/\/$/, "");
  const candidates = rel === "" ? ["README.md"] : [`${rel}.md`, `${rel}/README.md`];
  return candidates.find((c) => existsSync(`${DOCS}/${c}`));
}

describe("site links in the theme's components", () => {
  // The landing page and the layout are Vue, not markdown: the site's
  // dead-link check compiles pages and never reads a component's `href`, so a
  // renamed tutorial would leave the landing page's button pointing at a 404.
  // Every internal path a component carries — an `href="/…"` attribute or a
  // `link: "/…"` entry in its data — must be a page in this tree, and a
  // fragment must be one of that page's headings.
  const components = globSync("**/*.vue", { cwd: THEME });

  it("finds the components (a glob that matches nothing would pass every assertion below)", () => {
    expect(components).toContain("LandingPage.vue");
  });

  it("every internal path names a page, and every fragment one of its headings", () => {
    const wrong: string[] = [];
    for (const rel of components) {
      const source = readFileSync(`${THEME}/${rel}`, "utf8");
      for (const m of source.matchAll(/\b(?:href|link):?\s*[=:]\s*"(\/[^"]*)"/g)) {
        const [path, hash] = m[1].split("#");
        const page = pageFor(path);
        if (!page) {
          wrong.push(`${rel}: ${m[1]} — no page`);
          continue;
        }
        if (hash && !headingIds(readFileSync(`${DOCS}/${page}`, "utf8")).has(hash)) {
          wrong.push(`${rel}: ${m[1]} — ${page} has no heading #${hash}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every image a component draws is a file under docs/public", () => {
    // The landing page's screenshots are `/screenshots/<name>-<theme>.png`,
    // built from a template string the dead-link check never sees; the names
    // it can take are the `name`s in the component's data.
    const wrong: string[] = [];
    const checked: string[] = [];
    for (const rel of components) {
      const source = readFileSync(`${THEME}/${rel}`, "utf8");
      const shots = /const shots = \[([\s\S]*?)\n\];/.exec(source)?.[1] ?? "";
      const names = [...shots.matchAll(/^\s*name: "([^"]+)",$/gm)].map((m) => m[1]);
      const paths = [
        ...[...source.matchAll(/:src="`(\/[^`]*)`"/g)].flatMap((m) =>
          names.map((n) => m[1].replace("${shot.name}", n)),
        ),
        ...[...source.matchAll(/\bsrc="(\/[^"]*)"/g)].map((m) => m[1]),
      ];
      for (const path of paths) {
        checked.push(path);
        if (!existsSync(`${DOCS}/public${path}`)) wrong.push(`${rel}: ${path} — no such file under docs/public`);
      }
    }
    expect(checked).toContain("/screenshots/run-page-light.png");
    expect(wrong).toEqual([]);
  });
});

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
