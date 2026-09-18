// The pi registry as the card's catalog (record 0052): the JSON files the
// installed `@earendil-works/pi-ai` ships under `providers/data/`, keyed
// catalog file → wire → model id. A block's `catalog` names the file consulted
// for its cards (default, the block's own name when such a file exists; `none`
// for no catalog); a card is looked up under the block's wire first (our
// `openai-chat` is pi's `openai-completions`), then under any wire, since a
// card of another wire still carries levels, window and price. Nothing here
// knows a vendor or a model by name — and nothing here touches Node: this
// module is the seam's types alone, reachable from the Workers' typechecks
// through the run events' card type. The file-reading implementation is the
// bot's ./installedModelRegistry.ts; tests hand an in-memory table.

import type { Wire } from "./provider.js";

/** One card as pi's registry files carry it (only the fields the bot reads). */
export interface RegistryCard {
  id?: string;
  name?: string;
  /** pi's own wire word (`anthropic-messages`, `openai-completions`, `openai-responses`). */
  api?: string;
  reasoning?: boolean;
  /** Our tiers as pi spells them: `null` refuses a level, an absent tier is
   *  not named (the card's reader applies pi's rule). */
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

/** One registry file: pi's wire word → model id → card. */
export type RegistryFile = Record<string, Record<string, RegistryCard>>;

/** The catalog seam the card resolver reads (record 0052): a card by catalog
 *  name and wire, or by any wire; a catalog that does not exist reads as no
 *  card. The production implementation reads pi's installed files; tests hand
 *  a table. */
export interface ModelRegistry {
  /** The card for `model` in `catalog`, under `wire` first then any wire. */
  card(catalog: string | undefined, wire: Wire, model: string): RegistryCard | undefined;
  /** The file named, or undefined when the catalog does not exist. */
  file(catalog: string): RegistryFile | undefined;
  /** Every catalog file name the library ships. */
  names(): string[];
}

/** Our wire word as pi's registry spells it. */
export function piWireOf(wire: Wire): string {
  return wire === "openai-chat" ? "openai-completions" : wire;
}
