import { describe, expect, it } from "vitest";
import { REQUIRED_PAGES, siteProblems } from "../scripts/check-site.mjs";

// The built docs site is the site we expect to deploy: every required page is
// there, and the home page carries the product's display name — the tab title
// and the hero — as project.json states it. The site derives both from the
// file at build time, so this is the proof that the derivation reached the
// artifact, not a check of a hand-written copy.

const facts = { displayName: "OpenSwitchboard" };

const home = (title: string, hero: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>` +
  `<main class="landing"><section class="hero"><p class="eyebrow" data-v-1a2b><span class="product" data-v-1a2b>${hero}</span> · an agent gateway</p></section></main>` +
  `</body></html>`;

const complete = (index: string) =>
  Object.fromEntries(REQUIRED_PAGES.map((p) => [p, p === "index.html" ? index : "<html></html>"]));

describe("siteProblems", () => {
  const what = (files: Record<string, string>) => siteProblems((p) => files[p], facts);

  it("is silent when every required page exists and the home page names the product in its title and hero", () => {
    expect(what(complete(home("OpenSwitchboard", "OpenSwitchboard")))).toEqual([]);
  });

  it("names each missing page", () => {
    const files = complete(home("OpenSwitchboard", "OpenSwitchboard"));
    delete files["tutorials/index.html"];
    delete files["reference/specs/index.html"];
    expect(what(files)).toEqual(["missing: tutorials/index.html", "missing: reference/specs/index.html"]);
  });

  it("names a home page whose tab title or hero does not read displayName", () => {
    expect(what(complete(home("Switchboard", "OpenSwitchboard")))).toEqual([
      'index.html: <title> is "Switchboard" — project.json says displayName "OpenSwitchboard"',
    ]);
    expect(what(complete(home("OpenSwitchboard", "Switchboard")))).toEqual([
      'index.html: the hero names the product "Switchboard" — project.json says displayName "OpenSwitchboard"',
    ]);
    expect(what(complete("<html><head></head><body>no hero</body></html>"))).toEqual([
      "index.html: has no <title>",
      'index.html: the hero has no element of class "product" naming the product',
    ]);
  });
});
