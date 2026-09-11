import type { Capabilities } from "@core/core/capabilities.js";

// Which sections the site nav lists (docs/reference/specs/live-view.md item 18):
// one list, one place to add the next section — and one rule for which exist:
// a section needs its capability on (src/core/capabilities.ts, via the seed),
// except Runs, which is the dashboard itself, and the section the viewer is on.
// A plain module rather than a named export of AppNav.vue: the component, the
// shell's phone menu and the tests all read the one list, and a `.vue` file's
// named exports are invisible to static analysis of the TypeScript beside it.

export type NavSection = "runs" | "residents" | "costs" | "delivery";

export interface NavItem {
  id: NavSection;
  label: string;
  href: string;
  icon: string;
  /** The capability this section needs; absent → always there (Runs). */
  on?: (caps: Capabilities) => boolean;
}

const SECTIONS: ReadonlyArray<NavItem> = [
  { id: "runs", label: "Runs", href: "/runs", icon: "i-lucide-list" },
  { id: "residents", label: "Residents", href: "/residents", icon: "i-lucide-server", on: (c) => c.residents },
  { id: "costs", label: "Costs", href: "/costs", icon: "i-lucide-circle-dollar-sign", on: (c) => c.costs },
  // The delivery indicators read GitHub with the App's token: the page exists where a credential does.
  { id: "delivery", label: "Delivery", href: "/delivery", icon: "i-lucide-git-merge", on: (c) => c.github },
];

/** The sections this installation has, in fixed order: Runs, each one whose
 *  capability is on, and the current one (the viewer is on it — it exists).
 *  No capabilities (no seed) → Runs and the current section only. */
export function navSections(caps: Capabilities | null, current: NavSection): NavItem[] {
  return SECTIONS.filter((s) => s.id === current || s.on === undefined || (caps !== null && s.on(caps)));
}
