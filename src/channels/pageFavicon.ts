import { FAVICON_BY_TONE, FAVICON_DEFAULT, FAVICON_IDLE } from "./favicon.js";
import { residentsFleetTone, type ResidentRecordView } from "./residentsModel.js";
import type { WebSeed } from "./webSeed.js";

// The favicon a page wears on its first paint, decided from its seed. Shared
// by the shell (the `<link rel="icon">` of a full load) and the web app (which
// sets it on an in-app navigation, before a page's own feed repaints it).
// Node-free and dependency-free: the web bundle imports it.

/** Pages with a state to claim wear the dot: run-state pages start idle (the
 *  app repaints it green/gray by id as the feed moves); the residents index
 *  wears the fleet's worst tone from the seed on this first paint (the app
 *  repaints it from each listing its feed pushes). Every other page wears the
 *  neutral mark — a dot there would claim a state the page does not have. */
export function pageFavicon(seed: WebSeed): string {
  switch (seed.page) {
    case "runs":
    case "run":
      return FAVICON_IDLE;
    case "residents":
      return FAVICON_BY_TONE[residentsFleetTone(seed.residents as ResidentRecordView[])];
    default:
      return FAVICON_DEFAULT;
  }
}
