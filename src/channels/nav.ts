// Site navigation shared by every Access-gated browser surface (/runs,
// /residents, /costs). One list, one markup, one place to add the next page —
// so the three dashes stop growing their own ad-hoc cross-links.
//
// The markup is static (no dynamic strings) and the CSS inherits the host
// page's color so the same nav sits on the dark runs/residents shells and the
// light costs page. The current section carries `aria-current="page"`, which is
// both the styling hook and the accessible signal.

export type NavSection = "runs" | "residents" | "costs";

/** Order is the order rendered. Adding a surface = adding a row here (and its
 *  path to the Access gate in src/index.ts). */
export const NAV_SECTIONS: ReadonlyArray<{ id: NavSection; label: string; href: string }> = [
  { id: "runs", label: "Runs", href: "/runs" },
  { id: "residents", label: "Residents", href: "/residents" },
  { id: "costs", label: "Costs", href: "/costs" },
];

export function renderNav(current: NavSection): string {
  const items = NAV_SECTIONS.map((s) => (s.id === current ? `<a href="${s.href}" aria-current="page">${s.label}</a>` : `<a href="${s.href}">${s.label}</a>`)).join("");
  return `<nav class="site" aria-label="Sections">${items}</nav>`;
}

/** Drop into any page's <style>. Colors come from the host page (`inherit`),
 *  emphasis is opacity + an underline on the current item — legible on both
 *  the dark monospace shells and the light costs page. */
export const NAV_CSS = `
  nav.site { display: inline-flex; gap: .85rem; font-size: .8rem; font-family: inherit; }
  nav.site a { color: inherit; opacity: .6; text-decoration: none; }
  nav.site a:hover, nav.site a:focus-visible { opacity: 1; text-decoration: underline; text-underline-offset: .3em; }
  nav.site a[aria-current="page"] { opacity: 1; font-weight: 600; text-decoration: underline; text-underline-offset: .3em; }
`;
