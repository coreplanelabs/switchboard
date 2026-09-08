// Types for the landing page's picture list (docs/.vitepress/theme/screenshots.mjs).

export interface Shot {
  /** The file stem under docs/public/screenshots/. */
  name: string;
  alt: string;
}

export const SHOTS: ReadonlyArray<Shot>;
export function shotSrc(name: string, theme: "light" | "dark"): string;
