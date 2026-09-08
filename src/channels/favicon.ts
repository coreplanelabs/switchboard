// The tab favicons (live-view item 21). Two grammars:
//   - the DOT — a state claim, one color per tone: green all-good/live, amber
//     something transitional, red something failed/down, grey idle/no claim.
//     Only pages that have a state to claim wear it: the runs index and a run
//     page (green while anything runs, grey when idle — the app repaints it),
//     and the residents index (the fleet's worst resident, server-rendered from
//     the seed: the page is a snapshot with no live feed, so the shell is the
//     truth — `residentsFleetTone`).
//   - the MARK — the project's mark for every other page (scheduled, a
//     resident's detail, costs, the 404): "this tab is switchboard", no claim.
//     Three planes, one message routed to two lanes; the same drawing as
//     docs/public/favicon.svg and the dashboard header's BrandMark.
// Shipped as `data:` URIs the pages set on their <link rel="icon"> (no
// external asset); the raw mark SVG also answers `GET /favicon.ico`, the
// fallback every page without an inline icon link gets. Node-free and
// dependency-free: the web bundle imports it too.

export function faviconSvg(fill: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='${fill}'/></svg>`;
}
const FAVICON_MARK_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><g transform='translate(0 2)' stroke-linejoin='round' stroke-linecap='round' stroke-width='5'>` +
  `<polygon points='32,30 59,43 32,56 5,43' fill='none' stroke='#15151a'/><polygon points='32,17 59,30 32,43 5,30' fill='#15151a' stroke='#15151a'/>` +
  `<polygon points='32,4 59,17 32,30 5,17' fill='#fafaf7' stroke='#15151a'/><path d='M32 17 L32 30 L19 37 M32 30 L45 37' fill='none' stroke='#1a7f37'/>` +
  `<circle cx='32' cy='17' r='5' fill='#1a7f37' stroke='#fafaf7' stroke-width='3'/><circle cx='19' cy='37' r='5' fill='#1a7f37' stroke='#15151a' stroke-width='3'/>` +
  `<circle cx='45' cy='37' r='5' fill='#1a7f37' stroke='#15151a' stroke-width='3'/></g></svg>`;
/** What `GET /favicon.ico` serves: the neutral mark. */
export const FAVICON_ICO_SVG = FAVICON_MARK_SVG;
const dataUri = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;
export const FAVICON_LIVE = dataUri(faviconSvg("#2ea043"));
export const FAVICON_WARN = dataUri(faviconSvg("#d29922"));
export const FAVICON_BAD = dataUri(faviconSvg("#f85149"));
export const FAVICON_IDLE = dataUri(faviconSvg("#6e7681"));
export const FAVICON_DEFAULT = dataUri(FAVICON_MARK_SVG);

/** The dot for a status tone — the same four tones `StatusDot.vue` paints in
 *  a row, so a tab agrees with the dots on its page. */
export type FaviconTone = "green" | "amber" | "red" | "grey";
export const FAVICON_BY_TONE: Readonly<Record<FaviconTone, string>> = {
  green: FAVICON_LIVE,
  amber: FAVICON_WARN,
  red: FAVICON_BAD,
  grey: FAVICON_IDLE,
};
