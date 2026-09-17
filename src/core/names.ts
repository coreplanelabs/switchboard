// Display names for the ids the dashboard and the chat replies show. An id
// (`slack:U…`, `slack:C…`) is what the platform authenticated and what the
// policy decides on; a name is what a person reads. This seam is the one place
// a surface asks for the reading, so every seed carries `<x>Name` beside
// `<x>Id` the same way and the id itself moves to a tooltip or a data
// attribute. Nothing decides on a name: `authorize` never sees one.
//
// Best-effort by contract: `undefined` means "no name known" — a non-Slack id,
// a nameless conversation (a DM), a lookup that failed — and the surface shows
// the id. The Slack directory (`src/channels/slackNames.ts`) answers from the
// adapter's bounded caches; the static one answers nothing, which is what the
// CLI and the tests get.

export interface NameDirectory {
  /** A person's display name for a platform-namespaced user id; undefined when unknown. */
  person(id: string): Promise<string | undefined>;
  /** A channel's name without its hash for a platform-namespaced channel id; undefined when
   *  unknown or nameless (a DM has no name Slack would give it). */
  channel(id: string): Promise<string | undefined>;
}

/** Knows nobody and no channel: every surface shows ids. */
export const NO_NAMES: NameDirectory = {
  person: async () => undefined,
  channel: async () => undefined,
};

/** The names of many ids at once, asked concurrently: a map with an entry only where
 *  the directory answered — a failing or empty lookup is an absence, never a throw. */
export async function namesOf(
  lookup: (id: string) => Promise<string | undefined>,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const found = await Promise.all(unique.map((id) => lookup(id).catch((): undefined => undefined)));
  const out = new Map<string, string>();
  unique.forEach((id, i) => {
    const name = found[i];
    if (name) out.set(id, name);
  });
  return out;
}
