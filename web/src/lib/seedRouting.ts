import { ref, shallowRef, type InjectionKey, type Ref, type ShallowRef } from "vue";
import { START_LOCATION, type RouteLocationNormalized, type Router } from "vue-router";
import type { WebSeed } from "@core/channels/webSeed.js";

// Navigation in place (docs/reference/specs/live-view.md item 31): every page of
// the app is one view, one seed, two encodings. The document the shell served
// carries the first page's seed as an island; every navigation after it asks
// the next address for its seed (lib/seed.ts `fetchSeed`) before the route
// resolves, so the page mounts from its seed exactly as it would from the
// island — and the app never repaints from nothing. An address whose answer is
// not a seed (a file, a JSON twin, a login page, an error) is handed back to
// the browser as a full navigation: what the address really is, shown.

/** What the guard keeps: the seed loaded for one address, and whether a load is in flight. */
export interface SeedRouting {
  /** The seed for `address`, when it is the one loaded last; null for any other address. */
  seedAt(address: string): WebSeed | null;
  /** True while an in-app navigation waits for its seed (the progress cue). */
  loading: Ref<boolean>;
}

export interface SeedRoutingDeps {
  /** The island the shell served this document with: the first route's seed. */
  island: WebSeed | null;
  /** A page's seed by its address; null when the address is not a page of this app. */
  load: (address: string) => Promise<WebSeed | null>;
  /** A full navigation: the address handed back to the browser. */
  leave: (href: string) => void;
}

export const SeedRoutingKey: InjectionKey<SeedRouting> = Symbol("sb-seed-routing");

/** The address a page is keyed and loaded by: path and query, never the hash —
 *  a hash move (a step's anchor, a fold's `#run-…`) stays on the page. */
export function pageAddress(route: RouteLocationNormalized): string {
  const hash = route.fullPath.indexOf("#");
  return hash === -1 ? route.fullPath : route.fullPath.slice(0, hash);
}

/**
 * Install the seed loader on the router. The first navigation is the
 * document's own: its seed is the island. Every later one loads the seed for
 * the address before resolving; a hash-only move keeps the page and its seed.
 * Every navigation supersedes the load before it — a hash move too: the router
 * has dropped that navigation, so its late answer must neither land nor leave.
 * A load that is not a seed — or fails — becomes a full navigation and cancels
 * the in-app one.
 */
export function installSeedRouting(router: Router, deps: SeedRoutingDeps): SeedRouting {
  const current: ShallowRef<{ address: string; seed: WebSeed | null } | null> = shallowRef(null);
  const loading = ref(false);
  let generation = 0;
  router.beforeResolve(async (to, from) => {
    const mine = ++generation;
    loading.value = false;
    const address = pageAddress(to);
    if (from === START_LOCATION) {
      current.value = { address, seed: deps.island };
      return true;
    }
    if (address === pageAddress(from)) return true;
    loading.value = true;
    try {
      const seed = await deps.load(address);
      if (mine !== generation) return false;
      if (seed === null) {
        deps.leave(to.fullPath);
        return false;
      }
      current.value = { address, seed };
      return true;
    } catch {
      if (mine !== generation) return false;
      deps.leave(to.fullPath);
      return false;
    } finally {
      if (mine === generation) loading.value = false;
    }
  });
  return {
    seedAt: (address) => (current.value?.address === address ? current.value.seed : null),
    loading,
  };
}
