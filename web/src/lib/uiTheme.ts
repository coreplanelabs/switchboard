// Floating controls share the PR slideout's layer. Both paint above the
// navigation (z-40); a popup opened inside the slideout comes later in the
// portal and stays above it.

export const POPUP_LAYER = "z-50";

/** The Nuxt UI components that float a `content` slot over the page. */
export const POPUP_COMPONENTS = [
  "dropdownMenu",
  "inputMenu",
  "selectMenu",
  "contextMenu",
  "tooltip",
  "popover",
] as const;

export type PopupComponent = (typeof POPUP_COMPONENTS)[number];

/** The app-config `ui` entries that raise every popup's content to the one layer. */
export function popupLayers(): Record<PopupComponent, { slots: { content: string } }> {
  return Object.fromEntries(POPUP_COMPONENTS.map((c) => [c, { slots: { content: POPUP_LAYER } }])) as Record<
    PopupComponent,
    { slots: { content: string } }
  >;
}
