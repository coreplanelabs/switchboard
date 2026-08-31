// Shared HTML primitives for the server-rendered shells (webShell.ts). The
// response headers live there too (WEB_HTML_HEADERS) — this file keeps the one
// escaper every server-rendered dynamic string passes through.

/** HTML-escape a dynamic string for safe interpolation into server-rendered
 *  markup — `&` first so the entities it introduces aren't double-escaped, then
 *  the tag and quote characters. The web app renders everything else via DOM
 *  text bindings; only the shell itself (title, asset hrefs) interpolates. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
