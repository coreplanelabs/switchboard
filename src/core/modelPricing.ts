import type { ModelUsage, RunUsage } from "./runUsage.js";

// The price of a model's tokens (docs/reference/specs/costs.md): one table
// serves every dollar of token arithmetic — the open day's estimate from
// Anthropic's hourly usage report and the by-user report's run tokens. The
// list prices are Anthropic's, keyed by family and copied from the pricing
// page; re-check them when the page moves.

/** USD per million tokens of one kind, one model family. */
export interface AnthropicModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** Anthropic list prices per model family (platform.claude.com/docs/en/about-claude/pricing;
 *  re-check when it moves). Keyed by the family id the usage report spells — a dated
 *  release (`claude-haiku-4-5-20251001`) resolves to its family through
 *  `anthropicPriceOf`. Only what the estimate needs: the open day priced at
 *  the rate it will bill at; the cost report remains the invoice. */
export const ANTHROPIC_PRICES: Record<string, AnthropicModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
};

const DATED_RELEASE_SUFFIX = /^-\d{8}$/;

/** The family prices of a model id: the id itself, or the id less a dated
 *  release suffix (`-YYYYMMDD`). Nothing else counts as "the same family" —
 *  `claude-fable-5-1` is not `claude-fable-5` with a suffix, and its cache
 *  reads bill differently. Unknown → undefined, never a guess. */
export function anthropicPriceOf(modelId: string): AnthropicModelPrice | undefined {
  const exact = ANTHROPIC_PRICES[modelId];
  if (exact) return exact;
  for (const family of Object.keys(ANTHROPIC_PRICES)) {
    if (modelId.startsWith(family) && DATED_RELEASE_SUFFIX.test(modelId.slice(family.length)))
      return ANTHROPIC_PRICES[family];
  }
  return undefined;
}

/** Token counts of one usage-report row, in the report's own kinds. */
export interface AnthropicTokens {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** What those tokens cost at the family's list prices; undefined for a model
 *  the table does not know (the caller reports the tokens, never $0). */
export function anthropicTokensCostUsd(modelId: string, t: AnthropicTokens): number | undefined {
  const p = anthropicPriceOf(modelId);
  if (!p) return undefined;
  return (
    (t.uncachedInput * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
}

// ---- the operator's table: `costs.prices` over the list (costs.md item 4b) --------------

/** USD per million tokens of each kind a run's spans count, for one `<provider>/<model>` ref. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** `costs.prices`: the exact ref as the spans name it → its rates. */
export type ModelPriceTable = Readonly<Record<string, ModelPrice>>;

/** No table configured: the list alone prices. */
export const NO_PRICES: ModelPriceTable = Object.freeze({});

const PRICE_KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `costs.prices` as config spells it. Absent → the empty table. A key is a
 *  `<provider>/<model>` ref; a value names all four kinds as finite dollars per
 *  million ≥ 0 (a kind left out would price at $0 in silence); anything else
 *  is refused by name. */
export function parseModelPrices(raw: unknown): ModelPriceTable {
  if (raw === undefined || raw === null) return NO_PRICES;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("costs.prices must be a mapping of <provider>/<model> → rates");
  const out: Record<string, ModelPrice> = {};
  for (const [ref, value] of Object.entries(raw as Record<string, unknown>)) {
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1)
      throw new Error(`costs.prices.${ref} must be keyed <provider>/<model>, the ref a run's spans name`);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(
        `costs.prices.${ref} must be a mapping of { input, output, cacheRead, cacheWrite } in USD per million tokens`,
      );
    const v = value as Record<string, unknown>;
    const price: Partial<ModelPrice> = {};
    for (const kind of PRICE_KINDS) {
      if (!isRate(v[kind]))
        throw new Error(`costs.prices.${ref}.${kind} must be a finite number of USD per million tokens, 0 or more`);
      price[kind] = v[kind];
    }
    out[ref] = price as ModelPrice;
  }
  return out;
}

/** The price of a ref: the configured table first (the exact ref), else the
 *  Anthropic list by family after the provider prefix is dropped — cache
 *  writes at the 5-minute rate, the one cache-write count a span carries —
 *  and undefined for a model neither knows (the caller reports the tokens,
 *  never $0). */
export function modelPriceOf(ref: string, prices: ModelPriceTable = NO_PRICES): ModelPrice | undefined {
  const configured = prices[ref];
  if (configured) return configured;
  const list = anthropicPriceOf(modelIdOf(ref));
  if (!list) return undefined;
  return { input: list.input, output: list.output, cacheRead: list.cacheRead, cacheWrite: list.cacheWrite5m };
}

/** What a model's counted tokens cost at a price, USD. */
export function modelUsageUsd(m: ModelUsage, p: ModelPrice): number {
  return (
    (m.inputTokens * p.input +
      m.outputTokens * p.output +
      m.cacheReadTokens * p.cacheRead +
      m.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

// ---- a run's tokens, priced -----------------------------------------------------------

/** One model's tokens, priced; `usd` is null for a model the price table does not know. */
export interface PricedModelUsage extends ModelUsage {
  usd: number | null;
}

/** `anthropic/claude-fable-5` → `claude-fable-5`: the spans name the provider, the price table the model. */
export const modelIdOf = (ref: string): string => (ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref);

/** A usage priced through the table (`modelPriceOf`): dollars for the models a
 *  price is known for, and the tokens of the ones it is not (never $0 in silence). */
export function llmUsdOfUsage(
  usage: RunUsage,
  prices: ModelPriceTable = NO_PRICES,
): {
  usd: number;
  unpricedTokens: number;
  byModel: Record<string, PricedModelUsage>;
} {
  let usd = 0;
  let unpricedTokens = 0;
  const byModel: Record<string, PricedModelUsage> = {};
  for (const [ref, m] of Object.entries(usage.byModel)) {
    const price = modelPriceOf(ref, prices);
    const priced = price ? modelUsageUsd(m, price) : undefined;
    if (priced === undefined) unpricedTokens += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
    else usd += priced;
    byModel[ref] = { ...m, usd: priced ?? null };
  }
  return { usd, unpricedTokens, byModel };
}
