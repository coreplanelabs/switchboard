// The tab favicons (live-view item 21). Two grammars:
//   - the DOT — run state: green while anything runs, gray when idle. Only
//     pages that speak run state wear it (the runs index, a run page).
//   - the MARK — a neutral rounded square for every other page (scheduled,
//     residents, costs, the 404): "this tab is switchboard", no state claim.
// Shipped as `data:` URIs the pages set on their <link rel="icon"> (no
// external asset); the raw mark SVG also answers `GET /favicon.ico`, the
// fallback every page without an inline icon link gets. Node-free and
// dependency-free: the web bundle imports it too.

export function faviconSvg(fill: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='${fill}'/></svg>`;
}
const FAVICON_MARK_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect x='2' y='2' width='12' height='12' rx='3.5' fill='#6e7681'/></svg>`;
/** What `GET /favicon.ico` serves: the neutral mark. */
export const FAVICON_ICO_SVG = FAVICON_MARK_SVG;
const dataUri = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;
export const FAVICON_LIVE = dataUri(faviconSvg("#2ea043"));
export const FAVICON_IDLE = dataUri(faviconSvg("#6e7681"));
export const FAVICON_DEFAULT = dataUri(FAVICON_MARK_SVG);
