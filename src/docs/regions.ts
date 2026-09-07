// Generated regions in hand-written markdown.
//
// A reference page is part prose (hand-written, and worth writing well) and part
// mechanical table (every command, every flag, every route) that can only be
// right if it comes from the code. A generated region is how the two share one
// file: the generator owns the text BETWEEN the markers and never touches a
// byte outside them.
//
//   <!-- generated:cli-commands · npm run docs:gen -->
//   …table…
//   <!-- /generated:cli-commands -->
//
// Pure string surgery: no fs, no clock. `scripts/docs-gen.ts` is the only
// caller that reads or writes files, and CI runs it as `--check`.

/** The note carried in every opening marker, so a reader who lands on the raw
 *  markdown knows what wrote the block and how to change it. */
export const REGION_NOTE = "npm run docs:gen — generated from the code, do not edit by hand";

export function openMarker(name: string): string {
  return `<!-- generated:${name} · ${REGION_NOTE} -->`;
}

export function closeMarker(name: string): string {
  return `<!-- /generated:${name} -->`;
}

/** An opening marker for `name` with ANY note text (so re-running the generator
 *  after the note changes still finds the region it wrote last time). */
function openPattern(name: string): RegExp {
  return new RegExp(`^<!-- generated:${escapeRegExp(name)}(?: [^\\n]*)? -->$`, "m");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type RegionOutcome = { ok: true; text: string; changed: boolean } | { ok: false; problem: string };

/** Replace one region's body. The markers themselves are rewritten too, so the
 *  note text stays current. A missing or unclosed marker is a problem, never a
 *  silent no-op — a region that quietly stopped being generated is the exact
 *  drift this mechanism exists to prevent. */
export function replaceRegion(text: string, name: string, body: string): RegionOutcome {
  const open = openPattern(name).exec(text);
  if (!open)
    return { ok: false, problem: `no opening marker for region '${name}' (expected a line ${openMarker(name)})` };
  const close = closeMarker(name);
  const closeAt = text.indexOf(close, open.index + open[0].length);
  if (closeAt === -1) return { ok: false, problem: `region '${name}' is never closed (expected a line ${close})` };
  const rendered = `${openMarker(name)}\n\n${body.trim()}\n\n${close}`;
  const next = text.slice(0, open.index) + rendered + text.slice(closeAt + close.length);
  return { ok: true, text: next, changed: next !== text };
}

/** Every region name a file declares, in order — used to catch a marker whose
 *  region nothing generates (a typo, or a renderer that was removed). */
export function declaredRegions(text: string): string[] {
  return [...text.matchAll(/^<!-- generated:([a-z0-9-]+)(?: [^\n]*)? -->$/gm)].map((m) => m[1]);
}
