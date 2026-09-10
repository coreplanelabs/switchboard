// The landing page's pictures of the dashboard (LandingPage.vue draws them;
// src/docs/links.test.ts holds each to a file under docs/public/). The `name`
// is the picture's file stem in docs/public/screenshots/, rendered by
// `npm run screenshots:gen` in both appearances. Plain JS with a .d.mts twin,
// so the bot's test can import it without the docs theme entering its program.

/** @type {ReadonlyArray<{ name: string; alt: string }>} */
export const SHOTS = [
  {
    name: "run-page",
    alt: "Screenshot of a run page on the dashboard: a timeline of the run's steps with their durations.",
  },
  {
    name: "runs-index",
    alt: "Screenshot of the runs index on the dashboard: live runs with their agent, duration and stop controls, then finished ones.",
  },
  {
    name: "residents",
    alt: "Screenshot of the residents page on the dashboard: one row per onboarded repository with its state.",
  },
  {
    name: "costs",
    alt: "Screenshot of the costs page on the dashboard: spend by agent, by model and by day.",
  },
];

/** The site path of one picture: `/screenshots/<name>-<theme>.png`. */
export function shotSrc(name, theme) {
  return `/screenshots/${name}-${theme}.png`;
}
