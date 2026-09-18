import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FORM_PAGE_CSP,
  makePageSender,
  PAGE_CSP,
  renderShell,
  wantsSeed,
  WEB_HTML_HEADERS,
  WEB_SEED_HEADERS,
  type ShellAssets,
} from "./webShell.js";
import { serializeSeed, SEED_ELEMENT_ID, type WebSeed } from "./webSeed.js";
import { FAVICON_BAD, FAVICON_DEFAULT, FAVICON_IDLE, FAVICON_LIVE, FAVICON_WARN } from "./favicon.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import type { Actor } from "../core/authz/types.js";

const assets: ShellAssets = { js: "/assets/main-AbC123.js", css: ["/assets/main-DeF456.css"] };
const seed: WebSeed = { page: "runNotFound", title: "Live runs", retentionDays: 14, capabilities: ALL_CAPABILITIES };
/** A seed of another page, as a view would hand it to the sender — the shape only, the sender stamps the rest. */
const withTitle = (title: string, over: Record<string, unknown>): WebSeed =>
  ({ ...over, title, capabilities: ALL_CAPABILITIES }) as unknown as WebSeed;

describe("WEB_HTML_HEADERS", () => {
  it("locks the page down: self-only scripts, no external assets, no framing, no caching", () => {
    expect(WEB_HTML_HEADERS["content-type"]).toBe("text/html; charset=utf-8");
    const csp = WEB_HTML_HEADERS["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    // A run's video or audio file plays from the same-origin artifact route (live-view.md item 26).
    expect(csp).toContain("media-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(WEB_HTML_HEADERS["x-frame-options"]).toBe("DENY");
    expect(WEB_HTML_HEADERS["cache-control"]).toBe("no-store");
  });

  it("both encodings of a page vary on Accept and are never stored: the seed answer carries the island's tokens too", () => {
    expect(WEB_HTML_HEADERS.vary).toBe("accept");
    expect(WEB_SEED_HEADERS.vary).toBe("accept");
    expect(WEB_SEED_HEADERS["cache-control"]).toBe("no-store");
    expect(WEB_SEED_HEADERS["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("FORM_PAGE_CSP (the MCP connect page) differs from the shell policy in exactly one directive: form-action 'self'", () => {
    expect(FORM_PAGE_CSP).toBe(PAGE_CSP.replace("form-action 'none'", "form-action 'self'"));
    expect(FORM_PAGE_CSP).toContain("form-action 'self'");
    expect(FORM_PAGE_CSP).not.toContain("form-action 'none'");
    expect(FORM_PAGE_CSP).toContain("script-src 'self'");
  });
});

describe("serializeSeed", () => {
  it("escapes every <, > and & so no tag — </script> included — survives in the JSON island", () => {
    const hostile: WebSeed = { page: "runNotFound", title: "x", retentionDays: null, capabilities: ALL_CAPABILITIES };
    const withText = { ...hostile, note: `</script><script>alert(1)</script> & <img>` } as unknown as WebSeed;
    const json = serializeSeed(withText);
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(json).not.toContain("&");
    expect(JSON.parse(json)).toEqual(withText);
  });

  it("escapes U+2028/U+2029 (JSON-legal, JS-string-illegal line terminators)", () => {
    const s = { page: "runNotFound", retentionDays: null, note: "a\u2028b\u2029c" } as unknown as WebSeed;
    const json = serializeSeed(s);
    expect(json).not.toContain("\u2028");
    expect(json).not.toContain("\u2029");
    expect(JSON.parse(json)).toEqual(s);
  });
});

describe("renderShell", () => {
  it("renders the app mount, the seed island, and the hashed asset references", () => {
    const html = renderShell(seed, assets);
    expect(html).toContain(`<div id="app"></div>`);
    expect(html).toContain(`<script type="application/json" id="${SEED_ELEMENT_ID}">`);
    expect(html).toContain(serializeSeed(seed));
    expect(html).toContain(`<script type="module" src="/assets/main-AbC123.js"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="/assets/main-DeF456.css">`);
  });

  it("has NO inline executable script — the only script elements are the JSON island and the module src", () => {
    const html = renderShell(seed, assets);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('type="application/json"');
    expect(scripts[1]).toContain('type="module"');
    expect(scripts[1]).toContain("src=");
  });

  it("the document title is the seed's, escaped, and so are the asset paths", () => {
    const html = renderShell({ ...seed, title: `<script>"x"</script>` }, { js: `/assets/a".js`, css: [] });
    expect(html).toContain("<title>&lt;script&gt;");
    expect(html).not.toContain(`<title><script>`);
    expect(html).toContain("&quot;");
    expect(renderShell(seed, assets)).toContain("<title>Live runs</title>");
  });

  it("is dark by default and not indexable", () => {
    const html = renderShell(seed, assets);
    expect(html).toContain(`<html lang="en" class="dark">`);
    expect(html).toContain(`<meta name="robots" content="noindex" />`);
  });

  it("run-state pages wear the idle dot (the app repaints it live by id); every other page wears the neutral mark", () => {
    const runs = renderShell(
      withTitle("Runs", { page: "runs", now: 0, rows: [], all: false, retentionDays: 30 }),
      assets,
    );
    expect(runs).toContain(`<link rel="icon" id="favicon" href="${FAVICON_IDLE}" />`);
    const run = renderShell(
      withTitle("Run", { page: "run", mode: "history", id: "r", events: [], eventCount: 0 }),
      assets,
    );
    expect(run).toContain(`<link rel="icon" id="favicon" href="${FAVICON_IDLE}" />`);
    for (const other of [seed, withTitle("x", { page: "costs", now: 0 })]) {
      expect(renderShell(other, assets)).toContain(`<link rel="icon" id="favicon" href="${FAVICON_DEFAULT}" />`);
    }
    expect(FAVICON_DEFAULT).not.toBe(FAVICON_IDLE);
  });

  it("the residents index wears the fleet's worst dot from the seed: red over amber over green, grey when empty or unknown", () => {
    const at = (state: string) => ({ resource: `repo:o/${state}`, live: { state } });
    const shell = (residents: unknown[]) =>
      renderShell(withTitle("Residents", { page: "residents", cap: 5, count: residents.length, residents }), assets);
    const icon = (href: string) => `<link rel="icon" id="favicon" href="${href}" />`;
    expect(shell([at("warm"), at("warm")])).toContain(icon(FAVICON_LIVE));
    expect(shell([at("warm"), at("refreshing")])).toContain(icon(FAVICON_WARN));
    expect(shell([at("warm"), at("refreshing"), at("down")])).toContain(icon(FAVICON_BAD));
    expect(shell([])).toContain(icon(FAVICON_IDLE));
    expect(shell([at("warm"), { resource: "repo:o/x", live: { error: "unreachable" } }])).toContain(icon(FAVICON_IDLE));
    expect(new Set([FAVICON_LIVE, FAVICON_WARN, FAVICON_BAD, FAVICON_IDLE, FAVICON_DEFAULT]).size).toBe(5);
  });
});

// Feature: docs/reference/specs/live-view.md item 31 — a page is one view, one seed,
// two encodings: the document for a browser, the seed alone for the web app's
// in-app navigation.
describe("wantsSeed — which requests ask for the seed rather than the document", () => {
  const req = (accept?: string) => ({ headers: accept === undefined ? {} : { accept } });

  it("the web app's request names application/json alone", () => {
    expect(wantsSeed(req("application/json"))).toBe(true);
    expect(wantsSeed(req("application/json; charset=utf-8"))).toBe(true);
    expect(wantsSeed(req("Application/JSON, */*;q=0.1"))).toBe(true);
  });

  it("a browser's document request names text/html (with */*), so it never gets the seed; no Accept is a document", () => {
    expect(wantsSeed(req("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"))).toBe(false);
    expect(wantsSeed(req("text/html, application/json"))).toBe(false);
    expect(wantsSeed(req("*/*"))).toBe(false);
    expect(wantsSeed(req())).toBe(false);
  });
});

describe("makePageSender — the shell for a document request, the seed for the app's own", () => {
  const capture = () => {
    let status = 0;
    let headers: Record<string, string> = {};
    let body = "";
    const res = {
      writeHead: (s: number, h: Record<string, string>) => {
        status = s;
        headers = h;
      },
      end: (b?: string) => {
        body = b ?? "";
      },
    } as unknown as ServerResponse;
    return {
      res,
      get status() {
        return status;
      },
      get headers() {
        return headers;
      },
      get body() {
        return body;
      },
    };
  };
  const request = (accept?: string) => ({ headers: accept ? { accept } : {} }) as unknown as IncomingMessage;
  const send = makePageSender(assets, ALL_CAPABILITIES);
  const pageSeed = { page: "runNotFound" as const, retentionDays: 30 };
  const viewingAs: Actor = { viewingAs: { id: "slack:UALICE", name: "alice" } } as unknown as Actor;

  it("a document request gets the shell under the HTML headers, at the view's status, title and stamps in the island", () => {
    const out = capture();
    send(request("text/html,*/*;q=0.8"), out.res, 404, undefined, "Run not found", pageSeed);
    expect(out.status).toBe(404);
    expect(out.headers).toEqual(WEB_HTML_HEADERS);
    expect(out.body).toContain("<title>Run not found</title>");
    expect(out.body).toContain(
      serializeSeed({ ...pageSeed, title: "Run not found", capabilities: ALL_CAPABILITIES } as WebSeed),
    );
  });

  it("a seed request gets the island alone as JSON: same status, same stamps, no markup", () => {
    const out = capture();
    send(request("application/json"), out.res, 404, viewingAs, "Run not found", pageSeed);
    expect(out.status).toBe(404);
    expect(out.headers).toEqual(WEB_SEED_HEADERS);
    expect(out.body).not.toContain("<");
    expect(JSON.parse(out.body)).toEqual({
      ...pageSeed,
      title: "Run not found",
      capabilities: ALL_CAPABILITIES,
      viewingAs: { id: "slack:UALICE", name: "alice" },
    });
  });

  it("the viewer's view-as rides both encodings, and a session that is its own has none to carry", () => {
    const html = capture();
    send(request(), html.res, 200, viewingAs, "Runs", pageSeed);
    const island = /id="sb-seed">(.*?)<\/script>/s.exec(html.body)?.[1];
    expect(island).toBeDefined();
    expect(JSON.parse(island!)).toMatchObject({ viewingAs: { id: "slack:UALICE", name: "alice" } });
    const own = capture();
    send(request("application/json"), own.res, 200, undefined, "Runs", pageSeed);
    expect(JSON.parse(own.body)).not.toHaveProperty("viewingAs");
  });

  it("builds the body before the head: a seed that cannot be serialized answers nothing, never a head without a body", () => {
    const out = capture();
    const cyclic: Record<string, unknown> = { page: "runNotFound", retentionDays: 1 };
    cyclic.self = cyclic;
    expect(() => send(request("application/json"), out.res, 200, undefined, "x", cyclic as never)).toThrow();
    expect(out.status).toBe(0);
  });
});
