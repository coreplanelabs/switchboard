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
//     The patch cable and ports use the browser's color scheme, as in
//     docs/public/favicon.svg and the dashboard sidebar.
// Shipped as `data:` URIs the pages set on their <link rel="icon"> (no
// external asset); the raw mark SVG also answers `GET /favicon.ico`, the
// fallback every page without an inline icon link gets. Node-free and
// dependency-free: the web bundle imports it too.

export function faviconSvg(fill: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='${fill}'/></svg>`;
}
const FAVICON_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">\n  <style>.dark { display: none; } @media (prefers-color-scheme: dark) { .light { display: none; } .dark { display: inline; } }</style>\n  <g class="light"><defs>\n    \n    <linearGradient id="activeWireLight" x1="0%" y1="100%" x2="100%" y2="0%">\n      <stop offset="0%" stop-color="#65A30D" /> \n      <stop offset="100%" stop-color="#0D9488" /> \n    </linearGradient>\n    \n    \n    <filter id="glowLight" x="-20%" y="-20%" width="140%" height="140%">\n      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000000" flood-opacity="0.15" />\n    </filter>\n  </defs>\n\n  \n  <rect width="256" height="256" fill="transparent" />\n\n  \n  <circle cx="64" cy="64" r="12" fill="#F3F4F6" stroke="#D1D5DB" stroke-width="4" />\n  <circle cx="192" cy="192" r="12" fill="#F3F4F6" stroke="#D1D5DB" stroke-width="4" />\n  <circle cx="64" cy="128" r="12" fill="#F3F4F6" stroke="#D1D5DB" stroke-width="4" />\n  <circle cx="192" cy="128" r="12" fill="#F3F4F6" stroke="#D1D5DB" stroke-width="4" />\n\n  \n  <path d="M 64 192 C 64 96, 192 160, 192 64" fill="none" stroke="url(#activeWireLight)" stroke-width="16" stroke-linecap="round" filter="url(#glowLight)" />\n\n  \n  <g transform="translate(64, 192)">\n    <circle cx="0" cy="0" r="20" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="4" />\n    <circle cx="0" cy="0" r="8" fill="#65A30D" />\n  </g>\n\n  \n  <g transform="translate(192, 64)">\n    <circle cx="0" cy="0" r="20" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="4" />\n    <circle cx="0" cy="0" r="8" fill="#0D9488" />\n  </g></g>\n  <g class="dark"><defs>\n    \n    <linearGradient id="activeWireDark" x1="0%" y1="100%" x2="100%" y2="0%">\n      <stop offset="0%" stop-color="#8DC63F" /> \n      <stop offset="100%" stop-color="#2DD4BF" /> \n    </linearGradient>\n    \n    \n    <filter id="glowDark" x="-20%" y="-20%" width="140%" height="140%">\n      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#8DC63F" flood-opacity="0.3" />\n    </filter>\n  </defs>\n\n  \n  <rect width="256" height="256" fill="transparent" />\n\n  \n  <circle cx="64" cy="64" r="12" fill="#1F2937" stroke="#374151" stroke-width="4" />\n  <circle cx="192" cy="192" r="12" fill="#1F2937" stroke="#374151" stroke-width="4" />\n  <circle cx="64" cy="128" r="12" fill="#1F2937" stroke="#374151" stroke-width="4" />\n  <circle cx="192" cy="128" r="12" fill="#1F2937" stroke="#374151" stroke-width="4" />\n\n  \n  <path d="M 64 192 C 64 96, 192 160, 192 64" fill="none" stroke="url(#activeWireDark)" stroke-width="16" stroke-linecap="round" filter="url(#glowDark)" />\n\n  \n  <g transform="translate(64, 192)">\n    <circle cx="0" cy="0" r="20" fill="#374151" stroke="#4B5563" stroke-width="4" />\n    <circle cx="0" cy="0" r="8" fill="#8DC63F" />\n  </g>\n\n  \n  <g transform="translate(192, 64)">\n    <circle cx="0" cy="0" r="20" fill="#374151" stroke="#4B5563" stroke-width="4" />\n    <circle cx="0" cy="0" r="8" fill="#2DD4BF" />\n  </g></g>\n</svg>\n';
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
