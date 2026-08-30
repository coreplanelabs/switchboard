import { escapeHtml } from "./liveView/html.js";
import { serializeSeed, SEED_ELEMENT_ID, type WebSeed } from "./webSeed.js";

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
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
${css}
</head>
<body>
<div id="app"></div>
<script type="application/json" id="${SEED_ELEMENT_ID}">${serializeSeed(seed)}</script>
<script type="module" src="${escapeHtml(assets.js)}"></script>
</body>
</html>`;
}

/** A bound shell renderer: what the page handlers receive (they know the title
 *  and the seed; the assets are wired once at startup). */
export type ShellRenderer = (title: string, seed: WebSeed) => string;

export function makeShellRenderer(assets: ShellAssets): ShellRenderer {
  return (title, seed) => renderShell(title, seed, assets);
}
