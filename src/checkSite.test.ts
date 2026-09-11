import { describe, expect, it } from "vitest";
import { REQUIRED_PAGES, siteProblems } from "../scripts/check-site.mjs";

// The built docs site is the site we expect to deploy: every required page is
// there, the home page carries the product's display name — the tab title and
// the hero — as project.json states it, and every required page names its
// social card under the docs origin with the card's PNG in the tree. The site
// derives all of it from the file at build time, so this is the proof that the
// derivation reached the artifact, not a check of a hand-written copy.

const facts = { displayName: "Acme Switchboard", docs: "https://docs.switchboard.example.com" };

/** The card a built page names: `tutorials/index.html` → `og/tutorials/index.png`. */
const cardOf = (page: string) => `og/${page.replace(/\.html$/, ".png")}`;
const ogTag = (page: string) => `<meta property="og:image" content="${facts.docs}/${cardOf(page)}">`;

const home = (title: string, hero: string, head = ogTag("index.html")) =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body>` +
  `<main class="landing"><section class="hero"><p class="eyebrow" data-v-1a2b><span class="product" data-v-1a2b>${hero}</span> · an agent gateway</p></section></main>` +
  `</body></html>`;

const page = (p: string, head = ogTag(p)) => `<html><head>${head}</head></html>`;

/** A complete tree: every required page naming its card, every card present. */
const complete = (index: string) =>
  Object.fromEntries([
    ...REQUIRED_PAGES.map((p) => [p, p === "index.html" ? index : page(p)]),
    ...REQUIRED_PAGES.map((p) => [cardOf(p), "png bytes"]),
  ]);

describe("siteProblems", () => {
  const what = (files: Record<string, string>) => siteProblems((p) => files[p], facts);

  it("is silent when every required page exists, the home page names the product in its title and hero, and every page's card is in the tree", () => {
    expect(what(complete(home("Acme Switchboard", "Acme Switchboard")))).toEqual([]);
  });

  it("names each missing page", () => {
    const files = complete(home("Acme Switchboard", "Acme Switchboard"));
    delete files["tutorials/index.html"];
    delete files["reference/specs/index.html"];
    expect(what(files)).toEqual(["missing: tutorials/index.html", "missing: reference/specs/index.html"]);
  });

  it("names a home page whose tab title or hero does not read displayName", () => {
    expect(what(complete(home("Switchboard", "Acme Switchboard")))).toEqual([
      'index.html: <title> is "Switchboard" — project.json says displayName "Acme Switchboard"',
    ]);
    expect(what(complete(home("Acme Switchboard", "Switchboard")))).toEqual([
      'index.html: the hero names the product "Switchboard" — project.json says displayName "Acme Switchboard"',
    ]);
    expect(what(complete(`<html><head>${ogTag("index.html")}</head><body>no hero</body></html>`))).toEqual([
      "index.html: has no <title>",
      'index.html: the hero has no element of class "product" naming the product',
    ]);
  });

  it("names a page that names no og:image", () => {
    const files = complete(home("Acme Switchboard", "Acme Switchboard"));
    files["reference/cli.html"] = page("reference/cli.html", "");
    expect(what(files)).toEqual(["reference/cli.html: names no og:image"]);
  });

  it("names an og:image that is not a PNG under the docs origin's og/ — a relative path, another host, another format", () => {
    const files = complete(home("Acme Switchboard", "Acme Switchboard"));
    files["tutorials/index.html"] = page(
      "tutorials/index.html",
      '<meta property="og:image" content="/og/tutorials/index.png">',
    );
    files["how-to/index.html"] = page(
      "how-to/index.html",
      '<meta property="og:image" content="https://example.com/og/how-to/index.png">',
    );
    files["reference/cli.html"] = page(
      "reference/cli.html",
      `<meta property="og:image" content="${facts.docs}/og/reference/cli.svg">`,
    );
    expect(what(files)).toEqual([
      'tutorials/index.html: og:image is "/og/tutorials/index.png" — expected a PNG under https://docs.switchboard.example.com/og/ (project.json\'s docs URL)',
      'how-to/index.html: og:image is "https://example.com/og/how-to/index.png" — expected a PNG under https://docs.switchboard.example.com/og/ (project.json\'s docs URL)',
      'reference/cli.html: og:image is "https://docs.switchboard.example.com/og/reference/cli.svg" — expected a PNG under https://docs.switchboard.example.com/og/ (project.json\'s docs URL)',
    ]);
  });

  it("names a card a page points at that the tree does not carry", () => {
    const files = complete(home("Acme Switchboard", "Acme Switchboard"));
    delete files["og/reference/cli.png"];
    expect(what(files)).toEqual([
      "reference/cli.html: og:image names og/reference/cli.png, which is not in the built site",
    ]);
  });

  it("accepts a docs URL with a trailing slash as the same origin", () => {
    const files = complete(home("Acme Switchboard", "Acme Switchboard"));
    expect(siteProblems((p) => files[p], { ...facts, docs: `${facts.docs}/` })).toEqual([]);
  });
});
