// Shared HTML primitives for the live-view surfaces (the per-run page, the runs
// index, and the residents/costs pages that borrow them): the strict response
// headers, the escaper every server-rendered dynamic string passes through, and
// the `__name` shim each inlined `String(fn)` browser source is preceded by.

/** Content-Security-Policy for the run page: everything self/inline only, no
 *  external or CDN assets. `connect-src 'self'` allows the same-origin
 *  EventSource; `frame-ancestors 'none'` blocks the page being iframed
 *  (clickjacking), since `default-src 'none'` does NOT cover frame-ancestors. */
const PAGE_CSP =
  "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Response headers shared by every HTML surface here (the per-run page AND the
 *  runs index): the strict CSP, both clickjacking defenses (`frame-ancestors`
 *  in CSP + the legacy `X-Frame-Options`), and `no-store` so no proxy or browser
 *  caches a page that carries capability tokens. One constant so the two
 *  surfaces are provably identical. */
export const HTML_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": PAGE_CSP,
  "x-frame-options": "DENY", // belt-and-suspenders with CSP frame-ancestors
  "cache-control": "no-store",
};

/** HTML-escape a dynamic string for safe interpolation into server-rendered
 *  markup — `&` first so the entities it introduces aren't double-escaped, then
 *  the tag and quote characters. The per-run page renders event summaries client
 *  side with `textContent`; the runs index is server-rendered, so every dynamic
 *  string it emits (a run label may derive from a thread/repo name) MUST pass
 *  through here — otherwise a `<script>` in a label would inject. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The `__name` shim every inlined `String(fn)` browser source is preceded by (the
 *  rationale is on MARKDOWN_RENDERER_SCRIPT in runPage.ts). */
export const NAME_SHIM = "var __name = function (fn) { return fn; };";

/**
 * The tooltip component (live-view item 20) — one reusable, viewport-aware
 * tooltip for every dashboard page, instead of the native `title` (slow, easy
 * to miss, unstyled, absent on touch and keyboard).
 *
 * Usage: put the text on `data-tip` (newlines allowed). ONE `<div id="tooltip"
 * role="tooltip">` is created per page and moved to whatever is hovered or
 * focused (`focusin`, so keyboard users get it too). Placement: below the
 * anchor by default, flipped above when there is no room, clamped to the
 * viewport horizontally with an 8 px margin; hidden on mouseleave, blur, scroll
 * and Escape. Text goes in through `textContent` — never markup.
 *
 * Plain `function`s and `var`: this ships as `String(installTooltips)` behind
 * the `__name` shim, like every inlined helper.
 */
export function installTooltips(): void {
  var tip = document.getElementById("tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  var current: Element | null = null;
  function anchorOf(target: EventTarget | null): Element | null {
    var el = target instanceof Element ? target : null;
    return el ? el.closest("[data-tip]") : null;
  }
  function show(anchor: Element): void {
    var text = anchor.getAttribute("data-tip") || "";
    if (!text) return;
    current = anchor;
    (tip as HTMLElement).textContent = text;
    (tip as HTMLElement).hidden = false;
    var a = anchor.getBoundingClientRect();
    var t = (tip as HTMLElement).getBoundingClientRect();
    var margin = 8, gap = 8;
    var left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
    var below = a.bottom + gap;
    var top = below + t.height <= window.innerHeight - margin ? below : a.top - gap - t.height;
    (tip as HTMLElement).style.left = Math.round(left) + "px";
    (tip as HTMLElement).style.top = Math.round(top) + "px";
    tip!.setAttribute("data-placement", top === below ? "below" : "above");
  }
  function hide(): void {
    current = null;
    (tip as HTMLElement).hidden = true;
  }
  document.addEventListener("mouseover", function (ev) {
    var anchor = anchorOf(ev.target);
    if (anchor && anchor !== current) show(anchor);
    else if (!anchor && current) hide();
  });
  document.addEventListener("mouseleave", hide);
  document.addEventListener("focusin", function (ev) {
    var anchor = anchorOf(ev.target);
    if (anchor) show(anchor);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") hide();
  });
}

/** The tooltip as browser source. Drop `TOOLTIP_CSS` in the page's <style> and
 *  call `installTooltips()` once at the end of the inline script. */
export const TOOLTIP_SCRIPT = `${NAME_SHIM}\n${String(installTooltips)}`;
export const TOOLTIP_CSS = `
  #tooltip { position: fixed; z-index: 10; max-width: 26rem; padding: .45rem .65rem; border-radius: 6px; border: 1px solid #2a2f3a;
    background: #161b22; color: #b6bcc8; font: .75rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-line;
    box-shadow: 0 8px 24px #0009; pointer-events: none; }
  #tooltip[hidden] { display: none; }
  [data-tip] { cursor: default; }
`;
