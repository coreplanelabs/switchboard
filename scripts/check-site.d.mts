/** The pages every build of the docs site must contain, relative to docs/.vitepress/dist. */
export const REQUIRED_PAGES: string[];
/** Pure: the problems with a built site — a missing page, a home page whose `<title>` or hero does not read `displayName`, a page whose `og:image` is not a PNG under `<docs>/og/` or names a card the tree lacks. */
export function siteProblems(
  read: (relativePath: string) => string | undefined,
  facts: { displayName: string; docs: string },
): string[];
