import { inject, type InjectionKey } from "vue";
import { SEED_ELEMENT_ID, type WebSeed } from "@core/channels/webSeed.js";

// The page's data, as the server embedded it (webShell.ts renders one JSON
// island per page). App.vue reads it once and provides it; pages inject the
// slice they expect. Tests provide a seed directly instead of a DOM island.

export const SeedKey: InjectionKey<WebSeed | null> = Symbol("sb-seed");

export function readSeed(doc: Document = document): WebSeed | null {
  const el = doc.getElementById(SEED_ELEMENT_ID);
  const text = el?.textContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as WebSeed;
  } catch {
    return null;
  }
}

/** The injected seed when it is the given page's, else null (a mismatched or
 *  missing seed renders the page's empty/error state, never a crash). */
export function useSeed<K extends WebSeed["page"]>(page: K): Extract<WebSeed, { page: K }> | null {
  const seed = inject(SeedKey, null);
  if (!seed || seed.page !== page) return null;
  return seed as Extract<WebSeed, { page: K }>;
}
