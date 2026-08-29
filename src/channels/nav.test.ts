import { describe, expect, it } from "vitest";
import { NAV_CSS, NAV_SECTIONS, renderNav } from "./nav.js";

describe("renderNav", () => {
  it("renders every section in a fixed order as a labelled <nav>", () => {
    const html = renderNav("runs");
    expect(html).toMatch(/^<nav class="site" aria-label="Sections">/);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/runs", "/residents", "/costs"]);
    expect(html).toContain(">Runs</a>");
    expect(html).toContain(">Residents</a>");
    expect(html).toContain(">Costs</a>");
  });

  it("marks exactly the current section with aria-current", () => {
    for (const s of NAV_SECTIONS) {
      const html = renderNav(s.id);
      expect(html.match(/aria-current="page"/g)?.length).toBe(1);
      expect(html).toContain(`<a href="${s.href}" aria-current="page">${s.label}</a>`);
    }
  });

  it("carries no token or query string — every link is to an Access-gated index", () => {
    expect(renderNav("costs")).not.toMatch(/href="[^"]*\?/);
  });

  it("styles through inheritance so it sits on both the dark and light shells", () => {
    expect(NAV_CSS).toContain("color: inherit");
    expect(NAV_CSS).toContain('a[aria-current="page"]');
    expect(NAV_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i); // no hard-coded palette
  });
});
