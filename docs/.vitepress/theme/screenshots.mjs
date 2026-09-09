// The landing page's three pictures of the dashboard (LandingPage.vue draws
// them; src/docs/links.test.ts holds each to a file under docs/public/). The
// `name` is the picture's file stem in docs/public/screenshots/, rendered by
// `npm run screenshots:gen` in both appearances. Plain JS with a .d.mts twin,
// so the bot's test can import it without the docs theme entering its program.

/** @type {ReadonlyArray<{ name: string; caption: string; alt: string }>} */
export const SHOTS = [
  {
    name: "runs-index",
    caption: "The runs index: what is running now, what finished, and what leaves the dashboard next.",
    alt: "Screenshot of the runs index on the dashboard: live runs with their agent, duration and stop controls, then finished ones.",
  },
  {
    name: "run-page",
    caption: "The run page: every step timed — the model turns, the tool calls, the reply.",
    alt: "Screenshot of a run page on the dashboard: a timeline of the run's steps with their durations.",
  },
  {
    name: "residents",
    caption: "Residents: the repositories you onboard, kept warm, with the threads working in each.",
    alt: "Screenshot of the residents page on the dashboard: one row per onboarded repository with its state.",
  },
];

/** The site path of one picture: `/screenshots/<name>-<theme>.png`. */
export function shotSrc(name, theme) {
  return `/screenshots/${name}-${theme}.png`;
}
