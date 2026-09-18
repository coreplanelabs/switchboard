import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { escapeHtml } from "./liveView/html.js";
import { pageFavicon } from "./pageFavicon.js";
import { serializeSeed, SEED_ELEMENT_ID, type PageSeed, type WebSeed } from "./webSeed.js";
import type { Capabilities } from "../core/capabilities.js";
import type { Actor } from "../core/authz/types.js";

// The one HTML document the server renders: a shell that mounts the web app
// (web/, built by Vite into hashed assets under /assets/*) and hands it the
// page's data as a JSON island. Rendering logic lives in the Vue components;
// this file only carries the mount point, the seed, and the asset references.
//
// The same page is also a JSON resource: the web app navigates in place
// (web/src/lib/seedRouting.ts) and asks each page's URL for its seed with
// `Accept: application/json`; the page sender below answers the seed alone,
// at the status the view chose, and the app mounts the page from it exactly
// as it would from the island. One view, one seed, two encodings.

/** Content-Security-Policy for every HTML page. Stricter than the old
 *  inline-script pages: no inline JS executes at all (`script-src 'self'` — the
 *  seed island is `type="application/json"`, a non-executing data block CSP
 *  does not govern), styles are the built stylesheet plus inline style
 *  attributes (Reka UI positions floating elements that way), same-origin
 *  connections only (the SSE streams, the seed requests), same-origin media
 *  only (a run's video or audio file plays from the artifact route,
 *  live-view.md item 26), and no framing. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The same policy for a page that carries a same-origin form (the MCP connect
 *  page): `form-action 'self'` — a post anywhere else is still blocked. */
export const FORM_PAGE_CSP = PAGE_CSP.replace("form-action 'none'", "form-action 'self'");

/** Response headers shared by every HTML surface: the strict CSP, both
 *  clickjacking defenses, and `no-store` so no proxy or browser caches a page
 *  that carries capability tokens. The hashed /assets/* files are the cacheable
 *  part (webAssets.ts). `Vary: Accept` because the same URL answers the seed
 *  as JSON (`WEB_SEED_HEADERS`). */
export const WEB_HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": PAGE_CSP,
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  vary: "accept",
};

/** Response headers of a page answered as its seed (the web app's in-app
 *  navigation): JSON, never cached — it carries the same tokens the island does. */
export const WEB_SEED_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  vary: "accept",
};

/** The hashed asset paths the shell references — from the Vite manifest
 *  (webAssets.ts) in production, fixed strings in tests. */
export interface ShellAssets {
  js: string;
  css: string[];
}

/**
 * One page shell: `<div id="app">` for the Vue mount, the seed as a JSON
 * island (`serializeSeed` keeps every `<`/`>`/`&` escaped, so hostile seeded
 * text can never close the element), and the hashed entry assets. The title
 * is the seed's. Dark is the document default (`class="dark"`); the token set
 * in web/ defines light too, so a future color-mode toggle is a class flip.
 */
export function renderShell(seed: WebSeed, assets: ShellAssets): string {
  const css = assets.css.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join("\n");
  const favicon = pageFavicon(seed);
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(seed.title)}</title>
<link rel="icon" id="favicon" href="${favicon}" />
${css}
</head>
<body>
<div id="app"></div>
<script type="application/json" id="${SEED_ELEMENT_ID}">${serializeSeed(seed)}</script>
<script type="module" src="${escapeHtml(assets.js)}"></script>
</body>
</html>`;
}

/** Whether a request for a page asks for its seed rather than the document:
 *  its `Accept` names `application/json` and not `text/html`. A browser's
 *  document request names `text/html` (and `*\/*`, which is not a name); the
 *  web app's seed request (web/src/lib/seed.ts) names JSON alone. */
export function wantsSeed(req: Pick<HttpRequest, "headers">): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== "string") return false;
  const types = accept.split(",").map((t) => t.split(";")[0].trim().toLowerCase());
  return types.includes("application/json") && !types.includes("text/html");
}

/** Sends one page: what the page handlers receive. They know the request, the
 *  response, the status, the viewer, the title and the page's seed; the assets
 *  and the process's capabilities are wired once at startup — a view never
 *  stamps `capabilities`, `viewingAs` or `title` into the seed itself. The
 *  viewer is the request's actor: while it views as a person (record 0053)
 *  every page wears the banner, so a view cannot forget it. A surface without
 *  a viewer (a costs page in a test) passes `undefined`. A document request
 *  gets the HTML shell; a seed request (`wantsSeed`) gets the seed as JSON —
 *  the same status, so a 404 page is a 404 seed. The body is built before the
 *  head is written: a sender that throws never answers twice. */
export type PageSender = (
  req: HttpRequest,
  res: ServerResponse,
  status: number,
  viewer: Actor | undefined,
  title: string,
  seed: PageSeed,
) => void;

export function makePageSender(assets: ShellAssets, capabilities: Capabilities): PageSender {
  return (req, res, status, viewer, title, seed) => {
    const island: WebSeed = {
      ...seed,
      title,
      capabilities,
      ...(viewer?.viewingAs ? { viewingAs: viewer.viewingAs } : {}),
    };
    if (wantsSeed(req)) {
      const body = JSON.stringify(island);
      res.writeHead(status, WEB_SEED_HEADERS);
      res.end(body);
      return;
    }
    const html = renderShell(island, assets);
    res.writeHead(status, WEB_HTML_HEADERS);
    res.end(html);
  };
}
