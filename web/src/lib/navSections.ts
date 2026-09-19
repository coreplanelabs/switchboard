import type { Capabilities } from "@core/core/capabilities.js";

// Which sections the site nav lists (docs/reference/specs/live-view.md item 18):
// one list, one place to add the next section — and one rule for which exist:
// a section needs its capability on (src/core/capabilities.ts, via the seed),
// except Runs, which is the dashboard itself, and the section the viewer is on.
// A plain module rather than a named export of AppNav.vue: the component, the
// shell's phone menu and the tests all read the one list, and a `.vue` file's
// named exports are invisible to static analysis of the TypeScript beside it.

// `home` is the threads page at `/threads` (docs/reference/specs/web-chat.md): the first
// section, always on — the dashboard's front door — and the brand mark's target.
export type NavSection = "home" | "runs" | "plane" | "residents" | "costs" | "metrics" | "delivery" | "settings";

export interface NavItem {
  id: NavSection;
  label: string;
  href: string;
  icon: string;
  /** The capability this section needs; absent → always there (Runs). */
  on?: (caps: Capabilities) => boolean;
}

const SECTIONS: ReadonlyArray<NavItem> = [
  { id: "home", label: "Threads", href: "/threads", icon: "i-lucide-message-square" },
  { id: "runs", label: "Runs", href: "/runs", icon: "i-lucide-list" },
  // The plane's table (record 0064) grows out of the run ledger: the section exists where the ledger does.
  { id: "plane", label: "Plane", href: "/plane", icon: "i-lucide-radar", on: (c) => c.runLedger },
  { id: "residents", label: "Residents", href: "/residents", icon: "i-lucide-server", on: (c) => c.residents },
  { id: "costs", label: "Costs", href: "/costs", icon: "i-lucide-circle-dollar-sign", on: (c) => c.costs },
  // The run trend over the metrics dataset (run-metrics.md item 10): the section exists where the reader does.
  { id: "metrics", label: "Metrics", href: "/metrics", icon: "i-lucide-trending-up", on: (c) => c.metrics },
  // The delivery indicators read GitHub with the App's token: the page exists where a credential does.
  { id: "delivery", label: "Delivery", href: "/delivery", icon: "i-lucide-git-merge", on: (c) => c.github },
  // Settings is chrome, not a section: the cog in the header (SettingsLink.vue)
  // is the way there, and `settings` stays in `NavSection` only so a page can
  // say it is the current one.
];

/** The sections this installation has, in fixed order: Threads, Runs, each one
 *  whose capability is on, and the current one (the viewer is on it — it
 *  exists). No capabilities (no seed) → Threads, Runs and the current section only. */
export function navSections(caps: Capabilities | null, current: NavSection): NavItem[] {
  return SECTIONS.filter((s) => s.id === current || s.on === undefined || (caps !== null && s.on(caps)));
}
