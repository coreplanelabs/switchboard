// `/docs` on the app origin → the docs site.
//
// The docs are a separate, assets-only Worker (deploy/cloudflare-docs/) on their
// own hostname, so that a docs change deploys in a second from CI without ever
// touching the bot's container. What lives HERE is the stable in-product path:
// `/docs` is what the dashboard header links to and what anyone can type or
// paste, and it survives the docs site moving hosts — one constant to change.
//
// The redirect itself is public (it is not in the Access-gated set in
// src/index.ts): the target hostname is all it reveals, and the docs site sits
// behind the same Cloudflare Access as the dashboards, so an unauthenticated
// follower lands on the SSO login, not on the docs.
//
// Pure: no fs, no clock, no I/O.

/** The project's published documentation — the `docs` fact in project.json,
 *  where `/docs` sends people when the installation publishes no docs site of
 *  its own. An installation's own site arrives as the `DOCS_BASE_URL` var the
 *  bot Worker renders from the deployment profile (`workers.docs`); the same
 *  env var points a local run at `npm run docs:dev`. */
export const PROJECT_DOCS_URL = "https://docs.switchboard.coreplanelabs.dev";

/** Where `/docs…` should send the caller, or undefined when the path is not a
 *  docs path at all. The subpath is carried across unchanged, so a deep link
 *  (`/docs/reference/cli`) lands on that page rather than on the docs home.
 *
 *  The path must already be query-stripped (what `src/index.ts` passes). A
 *  path is only ever appended to the configured base, never taken from the
 *  request's own host or from a query parameter — there is nothing here an
 *  open-redirect could steer. */
export function docsRedirectTarget(path: string, base: string = PROJECT_DOCS_URL): string | undefined {
  const root = base.replace(/\/+$/, "");
  if (path === "/docs" || path === "/docs/") return `${root}/`;
  if (!path.startsWith("/docs/")) return undefined;
  // Collapse `//` so `/docs//x` cannot produce a protocol-relative-looking tail.
  const rest = path.slice("/docs/".length).replace(/^\/+/, "");
  return `${root}/${rest}`;
}
