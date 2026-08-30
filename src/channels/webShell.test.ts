import { describe, expect, it } from "vitest";
import { renderShell, WEB_HTML_HEADERS, type ShellAssets } from "./webShell.js";
import { serializeSeed, SEED_ELEMENT_ID, type WebSeed } from "./webSeed.js";

const assets: ShellAssets = { js: "/assets/main-AbC123.js", css: ["/assets/main-DeF456.css"] };
const seed: WebSeed = { page: "runNotFound", retentionDays: 14 };

describe("WEB_HTML_HEADERS", () => {
  it("locks the page down: self-only scripts, no external assets, no framing, no caching", () => {
    expect(WEB_HTML_HEADERS["content-type"]).toBe("text/html; charset=utf-8");
    const csp = WEB_HTML_HEADERS["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(WEB_HTML_HEADERS["x-frame-options"]).toBe("DENY");
    expect(WEB_HTML_HEADERS["cache-control"]).toBe("no-store");
  });
});

describe("serializeSeed", () => {
  it("escapes every <, > and & so no tag — </script> included — survives in the JSON island", () => {
    const hostile: WebSeed = { page: "runNotFound", retentionDays: null };
    const withText = { ...hostile, note: `</script><script>alert(1)</script> & <img>` } as unknown as WebSeed;
    const json = serializeSeed(withText);
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(json).not.toContain("&");
    expect(JSON.parse(json)).toEqual(withText);
  });

  it("escapes U+2028/U+2029 (JSON-legal, JS-string-illegal line terminators)", () => {
    const s = { page: "runNotFound", retentionDays: null, note: "a b c" } as unknown as WebSeed;
    const json = serializeSeed(s);
    expect(json).not.toContain(" ");
    expect(json).not.toContain(" ");
    expect(JSON.parse(json)).toEqual(s);
  });
});

describe("renderShell", () => {
  it("renders the app mount, the seed island, and the hashed asset references", () => {
    const html = renderShell("Live runs", seed, assets);
    expect(html).toContain(`<div id="app"></div>`);
    expect(html).toContain(`<script type="application/json" id="${SEED_ELEMENT_ID}">`);
    expect(html).toContain(serializeSeed(seed));
    expect(html).toContain(`<script type="module" src="/assets/main-AbC123.js"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="/assets/main-DeF456.css">`);
  });

  it("has NO inline executable script — the only script elements are the JSON island and the module src", () => {
    const html = renderShell("Live runs", seed, assets);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('type="application/json"');
    expect(scripts[1]).toContain('type="module"');
    expect(scripts[1]).toContain("src=");
  });

  it("escapes the title and asset paths", () => {
    const html = renderShell(`<script>"x"</script>`, seed, { js: `/assets/a".js`, css: [] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(`<title><script>`);
    expect(html).toContain("&quot;");
  });

  it("is dark by default and not indexable", () => {
    const html = renderShell("Runs", seed, assets);
    expect(html).toContain(`<html lang="en" class="dark">`);
    expect(html).toContain(`<meta name="robots" content="noindex" />`);
  });
});
