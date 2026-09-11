// `/docs` on the app origin → the project's docs site.
//
// The docs are the project's website — an assets-only Worker
// (deploy/cloudflare-docs/) the project's own CI deploys on every docs push,
// never a copy an installation runs — so every installation's `/docs` points at
// the one published site. What lives HERE is the stable in-product path: `/docs`
// is what the dashboard header links to and what anyone can type or paste, and
// it survives the docs site moving hosts — one fact to change, in project.json.
//
// The redirect itself is public (it is not in the Access-gated set in
// src/index.ts): the target hostname is all it reveals, and the site is public.
//
// Pure: no fs, no clock, no I/O.

/** The project's published documentation — the `docs` fact in project.json,
 *  which `check:project-facts` holds this constant equal to. */
export const PROJECT_DOCS_URL = "https://switchboard.space";

/** Where `/docs…` should send the caller, or undefined when the path is not a
 *  docs path at all. The subpath is carried across unchanged, so a deep link
 *  (`/docs/reference/cli`) lands on that page rather than on the docs home.
 *
 *  The path must already be query-stripped (what `src/index.ts` passes). A
 *  path is only ever appended to the project's docs URL, never taken from the
 *  request's own host or from a query parameter — there is nothing here an
 *  open-redirect could steer. */
export function docsRedirectTarget(path: string): string | undefined {
  if (path === "/docs" || path === "/docs/") return `${PROJECT_DOCS_URL}/`;
  if (!path.startsWith("/docs/")) return undefined;
  // Collapse `//` so `/docs//x` cannot produce a protocol-relative-looking tail.
  const rest = path.slice("/docs/".length).replace(/^\/+/, "");
  return `${PROJECT_DOCS_URL}/${rest}`;
}
