// The model card (record 0052): the resolved description of one
// `<block>/<model>` for one run — the wire, the vendor, the effort levels, the
// output-cap field, the window, the input kinds, the cache rule and the price
// source — layered operator over registry over wire defaults, each field with
// the layer that named it. `decideControls` then answers, before the first
// call, whether each control is native, degraded with a reason, or refused.
//
// Node-free on purpose: the resolver reads a `CardRegistry` seam, never pi's
// files, so the memory Worker's build can carry this leaf. The production
// catalog lives in ./modelRegistry.ts.

import { EFFORT_LEVELS, type Effort } from "../effort.js";
import { vendorOf, wireOf, type ProviderConfig, type Wire } from "./provider.js";
import type { RegistryCard } from "./modelRegistry.js";

/** Which layer named a field: the operator's block, the registry card, or the
 *  wire's structural default (the one place a vendor's name may appear). */
export type Provenance = "operator" | "registry" | "wire";

/** One tier's wire word and how the card arrived at it: `named` when the
 *  layer names this tier itself (its own wire word, whatever the spelling —
 *  `LOW`, `default` — or pi's rule for an unlisted low/medium/high), false
 *  when the word is a lower tier's, reached by pi's fallback rule. */
export interface LevelWord {
  word: string;
  named: boolean;
}

/** The card's levels: each of our tiers → the wire's word with its standing,
 *  or `refused`; or `unknown` as a whole (no layer names this model's levels). */
export type LevelMap = Record<Effort, LevelWord | "refused"> | "unknown";
export type InputSupport = boolean | "unknown";
export type CacheRule = "automatic" | "markers" | "none" | "unknown";

export interface CardPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCard {
  ref: string;
  block: string;
  model: string;
  vendor: string;
  wire: Wire;
  levels: LevelMap;
  /** The body field the output cap is spelled with on this model's wire. */
  capField: string;
  window: number;
  inputs: { image: InputSupport; document: InputSupport };
  cache: CacheRule;
  /** The rate card when a layer names one; the meter applies it in a later slice. */
  price?: CardPrice;
  provenance: Record<"levels" | "capField" | "window" | "inputs" | "cache" | "price", Provenance>;
}

/** The catalog seam `resolveModelCard` reads — pi's registry behind
 *  ./modelRegistry.ts in production, a table in tests. */
export interface CardRegistry {
  card(catalog: string | undefined, wire: Wire, model: string): RegistryCard | undefined;
}

/** The output-cap field each wire spells the cap with, unvouched. */
const WIRE_CAP_FIELD: Readonly<Record<Wire, string>> = {
  "anthropic-messages": "max_tokens",
  "openai-chat": "max_completion_tokens",
  "openai-responses": "max_output_tokens",
};

/** pi's own default for a `models.json` card without a window: compacting
 *  early beats overflowing a window no layer can vouch for. */
export const UNKNOWN_WINDOW = 128_000;

/** The vendor-keyed cache table, the wire defaults' one vendor-name table
 *  (record 0052): the vendors whose caches are automatic, and Anthropic, whose
 *  cache needs explicit markers. A vendor not here is `unknown`. */
const VENDOR_CACHE: Readonly<Record<string, CacheRule>> = {
  anthropic: "markers",
  openai: "automatic",
  deepseek: "automatic",
  groq: "automatic",
  moonshot: "automatic",
  moonshotai: "automatic",
  grok: "automatic",
  xai: "automatic",
  gemini: "automatic",
  google: "automatic",
};

/** The highest tier below `tier` the map names (pi's fallback rule), or
 *  undefined when it names none. */
function highestNamedBelow(map: Record<string, string | null> | undefined, tier: Effort): string | undefined {
  const at = EFFORT_LEVELS.indexOf(tier);
  for (let i = at - 1; i >= 0; i--) {
    const word = map?.[EFFORT_LEVELS[i]!];
    if (typeof word === "string") return word;
  }
  return undefined;
}

/** A registry or operator level map read by pi's rule: `null` refuses a tier;
 *  `low`, `medium`, `high` are native unless null; `xhigh` and `max` are
 *  native only when named, else the highest named tier below them (refused
 *  when none is named). `reasoning: false` refuses every tier. */
function levelMapOf(map: Record<string, string | null> | undefined, reasoning: boolean | undefined): LevelMap {
  const out = {} as Record<Effort, LevelWord | "refused">;
  for (const tier of EFFORT_LEVELS) {
    if (reasoning === false) {
      out[tier] = "refused";
      continue;
    }
    const word = map?.[tier];
    if (word === null) out[tier] = "refused";
    else if (typeof word === "string") out[tier] = { word, named: true };
    else if (tier === "low" || tier === "medium" || tier === "high") out[tier] = { word: tier, named: true };
    else {
      const below = highestNamedBelow(map, tier);
      out[tier] = below === undefined ? "refused" : { word: below, named: false };
    }
  }
  return out;
}

function priceOf(
  raw: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
): CardPrice | undefined {
  if (!raw) return undefined;
  const { input, output, cacheRead, cacheWrite } = raw;
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined)
    return undefined;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * One run's card: the operator's `models.<id>` override over the registry card
 * the block's `catalog` names over the wire's structural defaults, each field
 * carrying the layer that named it (record 0052). The block must exist —
 * the dispatcher checks it first — and a ref the block does not cover still
 * resolves, from the wire defaults, saying so.
 */
export function resolveModelCard(
  ref: string,
  blocks: Readonly<Record<string, ProviderConfig>>,
  registry: CardRegistry,
): ModelCard {
  const vendor = vendorOf(ref, blocks);
  const block = blocks[vendor.block];
  const wire = block ? wireOf(block) : "openai-chat";
  const override = block?.models?.[vendor.model];
  const card: RegistryCard | undefined = registry.card(block?.catalog ?? vendor.block, wire, vendor.model);

  const levels: LevelMap =
    override?.levels !== undefined
      ? levelMapOf(override.levels, undefined)
      : card?.thinkingLevelMap !== undefined || card?.reasoning !== undefined
        ? levelMapOf(card?.thinkingLevelMap, card?.reasoning)
        : "unknown";
  const levelsProvenance: Provenance =
    override?.levels !== undefined ? "operator" : levels === "unknown" ? "wire" : "registry";

  const capField = override?.capField ?? (card?.compat?.maxTokensField as string | undefined) ?? WIRE_CAP_FIELD[wire];
  const capProvenance: Provenance =
    override?.capField !== undefined ? "operator" : card?.compat?.maxTokensField !== undefined ? "registry" : "wire";

  const window = override?.window ?? card?.contextWindow ?? UNKNOWN_WINDOW;
  const windowProvenance: Provenance =
    override?.window !== undefined ? "operator" : card?.contextWindow !== undefined ? "registry" : "wire";

  const image: InputSupport =
    override?.inputs?.image ?? (card?.input !== undefined ? card.input.includes("image") : "unknown");
  const document: InputSupport = override?.inputs?.document ?? "unknown";
  const inputsProvenance: Provenance =
    override?.inputs !== undefined ? "operator" : card?.input !== undefined ? "registry" : "wire";

  const cache = override?.cache ?? VENDOR_CACHE[vendor.vendor] ?? "unknown";
  const cacheProvenance: Provenance = override?.cache !== undefined ? "operator" : "wire";

  const price = priceOf(override?.price) ?? priceOf(card?.cost);
  const priceProvenance: Provenance =
    priceOf(override?.price) !== undefined ? "operator" : price !== undefined ? "registry" : "wire";

  return {
    ref,
    block: vendor.block,
    model: vendor.model,
    vendor: vendor.vendor,
    wire,
    levels,
    capField,
    window,
    inputs: { image, document },
    cache,
    ...(price ? { price } : {}),
    provenance: {
      levels: levelsProvenance,
      capField: capProvenance,
      window: windowProvenance,
      inputs: inputsProvenance,
      cache: cacheProvenance,
      price: priceProvenance,
    },
  };
}

/** What the request asks of the model's controls, for `decideControls`. */
export interface AskedControls {
  effort?: Effort;
  images?: number;
  documents?: number;
}

export type ControlName = "effort" | "cap" | "inputs" | "window" | "cache";

/** One control's decision before the first call (record 0052): `native`
 *  (the wire's own word goes out, vouched for by a layer), `degraded` (the
 *  card cannot vouch — a fallback with `applied` differing from `asked`, or an
 *  unvouched send with `vouched: false`), or `refused` (the run never starts). */
export interface ControlDecision {
  control: ControlName;
  outcome: "native" | "degraded" | "refused";
  asked?: string;
  applied?: string;
  vouched: boolean;
  why: string;
}

/** Every control decided against the card (record 0052). A control the request does
 *  not ask about is not decided at all — no note, no refusal. The output cap
 *  and the window are always decided: every run sends one and compacts
 *  somewhere. */
export function decideControls(card: ModelCard, asked: AskedControls): ControlDecision[] {
  const decisions: ControlDecision[] = [];

  if (asked.effort !== undefined) {
    const tier = asked.effort;
    if (card.levels === "unknown") {
      decisions.push({
        control: "effort",
        outcome: "degraded",
        asked: tier,
        applied: tier,
        vouched: false,
        why: `no layer names ${card.model}'s levels; the word goes out unvouched`,
      });
    } else {
      const level = card.levels[tier];
      if (level === "refused") {
        decisions.push({
          control: "effort",
          outcome: "refused",
          asked: tier,
          vouched: false,
          why: `${card.model} does not take effort "${tier}"`,
        });
      } else if (level.named) {
        decisions.push({
          control: "effort",
          outcome: "native",
          asked: tier,
          applied: level.word,
          vouched: true,
          why: "",
        });
      } else {
        decisions.push({
          control: "effort",
          outcome: "degraded",
          asked: tier,
          applied: level.word,
          vouched: true,
          why: `${card.model} does not take effort "${tier}"; the highest named tier below it is "${level.word}"`,
        });
      }
    }
  }

  const capVouched = card.provenance.capField !== "wire";
  decisions.push({
    control: "cap",
    outcome: capVouched ? "native" : "degraded",
    applied: card.capField,
    vouched: capVouched,
    why: capVouched ? "" : `no layer names the cap field; the cap goes out as ${card.capField} unvouched`,
  });

  const images = asked.images ?? 0;
  const documents = asked.documents ?? 0;
  if (images > 0) {
    if (card.inputs.image === true)
      decisions.push({
        control: "inputs",
        outcome: "native",
        asked: "image",
        applied: "image",
        vouched: true,
        why: "",
      });
    else if (card.inputs.image === false)
      decisions.push({
        control: "inputs",
        outcome: "refused",
        asked: "image",
        vouched: false,
        why: `${card.model} takes no images`,
      });
    else
      decisions.push({
        control: "inputs",
        outcome: "degraded",
        asked: "image",
        applied: "image",
        vouched: false,
        why: `no layer names ${card.model}'s image support; the image goes out unvouched`,
      });
  }
  if (documents > 0) {
    decisions.push({
      control: "inputs",
      outcome: "degraded",
      asked: "document",
      applied: "text",
      vouched: false,
      why: "documents reach a provider as a text stub until the harness carries files",
    });
  }

  const windowVouched = card.provenance.window !== "wire";
  decisions.push({
    control: "window",
    outcome: windowVouched ? "native" : "degraded",
    applied: String(card.window),
    vouched: windowVouched,
    why: windowVouched ? "" : `no layer names the window; compacting at ${card.window}`,
  });

  const cacheNative = card.cache !== "unknown";
  decisions.push({
    control: "cache",
    outcome: cacheNative ? "native" : "degraded",
    applied: card.cache,
    vouched: cacheNative,
    why: cacheNative ? "" : `no layer names ${card.model}'s cache rule`,
  });

  return decisions;
}
