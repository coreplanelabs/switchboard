// The dashboard's stacking order for Nuxt UI's floating layers (live-view.md
// item 20). Every menu, combobox list, tooltip and popover is portaled to the
// body with no z-index of its own, so it paints in DOM order among the page's
// positioned elements — and loses to anything the page raises: a run row's
// body (`z-[1]` over its stretched link), the shell's sticky header (`z-20`),
// the chat's composer dock (`z-10`). The view-as picker's list was drawn
// under the rows it dropped over. One layer for every popup, above the header
// and level with the slideover's overlay and content (`z-30`, RunPage): among
// equal z-indices DOM order decides, and a popup opened from inside the
// slideover is portaled after it, so it wins. The theme sets the layer once
// here and the Vite plugin hands it to each component's `content` slot.

/** The class every popup's content paints at: above the shell header (`z-20`). */
export const POPUP_LAYER = "z-30";

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
