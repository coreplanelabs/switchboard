// The tab's dot favicon (live-view item 21): green while anything runs, gray
// when idle. One SVG shape, shipped two ways: `data:` URIs the pages set on
// their <link rel="icon"> (no external asset), and the raw idle SVG at
// `GET /favicon.ico` — the fallback every page without an inline icon link
// gets. Node-free and dependency-free: the web bundle imports it too.

export function faviconSvg(fill: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='${fill}'/></svg>`;
}
export const FAVICON_ICO_SVG = faviconSvg("#6e7681");
const dataUri = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;
export const FAVICON_LIVE = dataUri(faviconSvg("#2ea043"));
export const FAVICON_IDLE = dataUri(FAVICON_ICO_SVG);
