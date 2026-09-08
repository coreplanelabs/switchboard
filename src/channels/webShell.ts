import { escapeHtml } from "./liveView/html.js";
import { FAVICON_BY_TONE, FAVICON_DEFAULT, FAVICON_IDLE } from "./favicon.js";
import { residentsFleetTone, type ResidentRecordView } from "./residentsModel.js";
import { serializeSeed, SEED_ELEMENT_ID, type PageSeed, type WebSeed } from "./webSeed.js";
import type { Capabilities } from "../core/capabilities.js";

// The one HTML document the server renders: a shell that mounts the web app
// (web/, built by Vite into hashed assets under /assets/*) and hands it the
// page's data as a JSON island. Rendering logic lives in the Vue components;
// this file only carries the mount point, the seed, and the asset references.

/** Content-Security-Policy for every HTML page. Stricter than the old
 *  inline-script pages: no inline JS executes at all (`script-src 'self'` — the
 *  seed island is `type="application/json"`, a non-executing data block CSP
 *  does not govern), styles are the built stylesheet plus inline style
 *  attributes (Reka UI positions floating elements that way), same-origin
 *  connections only (the SSE streams), and no framing. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The same policy for a page that carries a same-origin form (the MCP connect
 *  page): `form-action 'self'` — a post anywhere else is still blocked. */
export const FORM_PAGE_CSP = PAGE_CSP.replace("form-action 'none'", "form-action 'self'");

/** Response headers shared by every HTML surface: the strict CSP, both
 *  clickjacking defenses, and `no-store` so no proxy or browser caches a page
 *  that carries capability tokens. The hashed /assets/* files are the cacheable
 *  part (webAssets.ts). */
export const WEB_HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": PAGE_CSP,
  "x-frame-options": "DENY",
  "cache-control": "no-store",
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
 * text can never close the element), and the hashed entry assets. Dark is the
 * document default (`class="dark"`); the token set in web/ defines light too,
 * so a future color-mode toggle is a class flip.
 */
export function renderShell(title: string, seed: WebSeed, assets: ShellAssets): string {
  const css = assets.css.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join("\n");
  const favicon = pageFavicon(seed);
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
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

/** Pages with a state to claim wear the dot: run-state pages start idle (the
 *  app repaints it green/gray by id as the feed moves); the residents index
 *  wears the fleet's worst tone straight from the seed (a snapshot page — no
 *  feed to repaint from, so this render is the truth). Every other page wears
 *  the neutral mark — a dot there would claim a state the page does not have. */
function pageFavicon(seed: WebSeed): string {
  switch (seed.page) {
    case "runs":
    case "run":
      return FAVICON_IDLE;
    case "residents":
      return FAVICON_BY_TONE[residentsFleetTone(seed.residents as ResidentRecordView[])];
    default:
      return FAVICON_DEFAULT;
  }
}

/** A bound shell renderer: what the page handlers receive (they know the title
 *  and the page's seed; the assets and the process's capabilities are wired
 *  once at startup — a view never stamps `capabilities` itself). */
export type ShellRenderer = (title: string, seed: PageSeed) => string;

export function makeShellRenderer(assets: ShellAssets, capabilities: Capabilities): ShellRenderer {
  return (title, seed) => renderShell(title, { ...seed, capabilities }, assets);
}
