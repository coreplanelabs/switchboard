// The providers catalogue behind the loop's `provider_models` read tool
// (issue 2088; routing-and-config item 29): the model refs this deployment can
// actually run, so a write proposal names a real ref — `openai` resolves to
// the openrouter OpenAI refs that exist (`openrouter/openai/gpt-5…`), never a
// provider the config does not define. Each aggregator block's own `/models`
// catalogue is read through the same injectable fetch `providers check` uses
// (openrouter's list, whose entries carry `architecture` fields beside `id`),
// the configured refs (the defaults' per-agent models — the anthropic models a
// deployment names — and each block's `models.<id>` overrides) ride whether or
// not any catalogue answers, and a catalogue that cannot be read costs the
// answer its refs, never the turn. A successful read is cached per block for
// the process's life (the catalogue moves on the provider's schedule, not the
// thread's); a failed one is never cached, so one transient 503 at boot does
// not silence a provider's refs until restart — the next call retries.
import type { ProviderConfig } from "../provider.js";

/** The catalogue's reader: one call per `provider_models` read, the optional
 *  filter the tool's own argument (a vendor, a model family). */
export interface ProviderModelsReader {
  read(filter?: string): Promise<string>;
}

/** How many refs one answer carries: the turn is a prompt, not a dump — past
 *  the cap the answer says how many more the filter would narrow. */
export const PROVIDER_MODELS_MAX = 40;

/** What the reader is built from: the loaded provider blocks, the refs the
 *  configuration names, and the injectable fetch (`providers check`'s shape —
 *  never the global by itself, so tests answer canned). */
export interface ProviderModelsSource {
  blocks: Readonly<Record<string, ProviderConfig>>;
  refs: readonly string[];
  fetch(url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** One block's `/models` answer parsed to its model ids; garbage is an empty
 *  list, never a throw. */
export function modelIdsFromJson(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (typeof m === "object" && m !== null ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * The production reader: the refs are `<block>/<id>` for every id each
 * block's `/models` catalogue lists (blocks without a `baseUrl` list nothing
 * — their refs are the configured ones), plus the configuration's own refs,
 * deduplicated in that order. Each block's successful read is kept for the
 * process's life; a fetch that fails leaves a named note on the answer, is
 * dropped from the cache so the next call retries, and the configured refs
 * still ride.
 */
export function providerModelsReader(source: ProviderModelsSource): ProviderModelsReader {
  const cache = new Map<string, Promise<{ refs: string[]; note?: string }>>();
  const catalogue = (name: string, baseUrl: string): Promise<{ refs: string[]; note?: string }> => {
    const cached = cache.get(name);
    if (cached) return cached;
    const read = (async () => {
      try {
        const res = await source.fetch(`${baseUrl.replace(/\/+$/, "")}/models`);
        if (!res.ok) {
          cache.delete(name);
          return { refs: [], note: `\`${name}\`: catalogue read failed (HTTP ${res.status})` };
        }
        return { refs: modelIdsFromJson(await res.json()).map((id) => `${name}/${id}`) };
      } catch (err) {
        cache.delete(name);
        const why = err instanceof Error ? err.message : String(err);
        return { refs: [], note: `\`${name}\`: catalogue read failed (${why})` };
      }
    })();
    cache.set(name, read);
    return read;
  };
  return {
    async read(filter?: string): Promise<string> {
      const reads = await Promise.all(
        Object.entries(source.blocks)
          .filter(([, block]) => typeof block.baseUrl === "string" && block.baseUrl.length > 0)
          .map(([name, block]) => catalogue(name, block.baseUrl!)),
      );
      const all = [...new Set([...reads.flatMap((r) => r.refs), ...source.refs])];
      const needle = filter?.trim().toLowerCase();
      const matched =
        needle !== undefined && needle.length > 0 ? all.filter((r) => r.toLowerCase().includes(needle)) : all;
      const shown = matched.slice(0, PROVIDER_MODELS_MAX);
      const notes = reads.map((r) => r.note).filter((n): n is string => n !== undefined);
      const head =
        matched.length === 0
          ? `No ref matches${needle ? ` \`${needle}\`` : ""}; the deployment's refs are \`<provider>/<model>\` on the configured providers.`
          : `Model refs this deployment can run${needle ? ` matching \`${needle}\`` : ""}:`;
      const more =
        matched.length > shown.length ? [`…and ${matched.length - shown.length} more — pass a narrower filter.`] : [];
      return [head, ...shown.map((r) => `- \`${r}\``), ...more, ...notes].join("\n");
    },
  };
}
