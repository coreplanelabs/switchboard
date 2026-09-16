import type { Capabilities } from "@core/core/capabilities.js";
import type { SettingsTab } from "@core/channels/webSeed.js";

// The tabs of the /settings page (docs/reference/specs/settings-page.md item 6):
// MCPs · Channels · Installation. One list, one rule for which exist: MCPs
// needs the `mcp` capability (from the seed) or the viewer on it; Channels and
// Installation exist in every installation, so the bar always has a choice.
// A plain module rather than a named export of SettingsTabs.vue, as
// navSections.ts is for the nav: the component and the tests read the one
// list, and a `.vue` file's named exports are invisible to static analysis of
// the TypeScript beside it.

export interface SettingsTabItem {
  id: SettingsTab;
  href: string;
  label: string;
  /** The capability this tab needs; absent → always there. */
  on?: (caps: Capabilities) => boolean;
}

const TABS: ReadonlyArray<SettingsTabItem> = [
  { id: "mcps", href: "/settings/mcps", label: "MCPs", on: (c) => c.mcp },
  { id: "channels", href: "/settings/channels", label: "Channels" },
  { id: "installation", href: "/settings/installation", label: "Installation" },
];

/** The tabs this installation has: each one whose capability is on, and the current one. */
export function settingsTabs(caps: Capabilities | null, current: SettingsTab): SettingsTabItem[] {
  return TABS.filter((t) => t.id === current || t.on === undefined || (caps !== null && t.on(caps)));
}
