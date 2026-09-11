/** The site's inputs: `docs/`, the docs Worker under `deploy/cloudflare-docs/`, and the root `project.json`. */
export const DOCS_PATHS: RegExp;
/** Of the paths one push changed, the ones that are the site's inputs — empty when the push does not deploy the site. */
export function docsTouched(files: string[]): string[];
