import { inject, type InjectionKey } from "vue";
import { SEED_ELEMENT_ID, type ViewablePerson, type WebSeed } from "@core/channels/webSeed.js";

// The page's data, as the server hands it out: embedded as one JSON island in
// the document the shell served (webShell.ts), and answered alone as JSON when
// the app asks a page's address for it with `Accept: application/json` — the
// in-app navigation (lib/seedRouting.ts). Either way SeedScope provides it and
// pages inject the slice they expect. Tests provide a seed directly instead.

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

/** What the app's own request for a page accepts: the seed, never the document (webShell.ts `wantsSeed`). */
export const SEED_ACCEPT = "application/json";

/** A seed as the sender stamps it: a page name and a title, whatever else the page carries. */
function isSeed(value: unknown): value is WebSeed {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { page?: unknown; title?: unknown };
  return typeof v.page === "string" && typeof v.title === "string";
}

/**
 * Ask a page's address (path and query) for its seed. Null when the answer is
 * not one — a document, a file, a JSON twin, an error page, another origin's
 * login (a cross-origin redirect fails the fetch), a network failure — which
 * the caller turns into a full navigation, so the browser shows whatever the
 * address really is. Never throws. An answer that is not JSON is cancelled
 * unread: it may be a stream (`/runs/<id>/events`), which would otherwise hold
 * the connection — and the server's subscriber — until the page unloads.
 */
export async function fetchSeed(address: string, fetchImpl: typeof fetch = fetch): Promise<WebSeed | null> {
  try {
    const res = await fetchImpl(address, { headers: { accept: SEED_ACCEPT }, credentials: "same-origin" });
    const type = res.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) {
      await res.body?.cancel();
      return null;
    }
    const body: unknown = await res.json();
    return isSeed(body) ? body : null;
  } catch {
    return null;
  }
}

/** The person this session is viewing the page as (record 0053), as the shell stamped it on the
 *  seed — the banner and every write control read THIS, never a page's own data. Null when the
 *  session is its own. */
export function useViewingAs(): ViewablePerson | null {
  return inject(SeedKey, null)?.viewingAs ?? null;
}

/** The injected seed when it is the given page's, else null (a mismatched or
 *  missing seed renders the page's empty/error state, never a crash). */
export function useSeed<K extends WebSeed["page"]>(page: K): Extract<WebSeed, { page: K }> | null {
  const seed = inject(SeedKey, null);
  if (!seed || seed.page !== page) return null;
  return seed as Extract<WebSeed, { page: K }>;
}
