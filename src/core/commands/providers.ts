import {
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { resolveModelCard, type CardRegistry, type ModelCard } from "../modelCard.js";
import type { ModelRegistry } from "../modelRegistry.js";
import { vendorOf, wireOf, type ProviderConfig } from "../provider.js";

// `providers.check` (docs/reference/specs/model-proxy.md item 12, record 0052):
// read the provider's own `GET <baseUrl>/models/<vendor>/<model>/endpoints`
// for each AGGREGATOR model the configuration names — a block declaring
// `vendor: model`, the one kind whose registry card may lag the provider —
// and report where `supported_parameters`, the context length and the input
// modalities disagree with the card the dispatcher would resolve, each drift
// with the `models.<id>` override that would pin it. Action `providers:read`:
// the read a browser session's baseline holds; a chat user needs the grant (an
// on-request provider read, like `costs snapshot`, is never a chat baseline).
// The endpoints read goes through the deps' own fetch, so tests and the
// conformance fixture answer canned and nothing here touches the network by
// itself. `registryDrift` is the same module's consistency half: the gate
// `scripts/registry-drift.ts` runs under `check:consistency`, naming every
// model the example config carries that the pinned pi registry no longer does.

export interface ProvidersCommandDeps {
  providers: {
    /** The loaded provider blocks and every model ref the configuration names. */
    configured(): Promise<{ blocks: Readonly<Record<string, ProviderConfig>>; refs: readonly string[] }>;
    /** The catalog the dispatcher resolves cards against. */
    registry(): CardRegistry;
    /** The endpoints read — injectable, never the global fetch. */
    fetch(url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  };
}

const defineCommand = commandDefiner<ProvidersCommandDeps>();

/** The provider's endpoints answer, the fields the comparison reads: the
 *  model's input modalities and, per endpoint, the context length and the
 *  parameter names it takes (names only — the API states no values). */
export interface ModelEndpoints {
  inputModalities: string[];
  endpoints: { contextLength?: number; supportedParameters: string[] }[];
}

/** One disagreement between the resolved card and the endpoint: the field, what
 *  each side says, and the `models.<id>` override line that would pin the
 *  endpoint's fact (absent when the endpoint states nothing pinnable). */
export interface DriftRow {
  field: "levels" | "capField" | "window" | "inputs.image";
  card: string;
  endpoint: string;
  pin?: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** OpenRouter's endpoints answer parsed to `ModelEndpoints`; garbage is
 *  undefined, never a throw. */
export function endpointsFromJson(json: unknown): ModelEndpoints | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const data = (json as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const raw = (data as { endpoints?: unknown }).endpoints;
  if (!Array.isArray(raw)) return undefined;
  const architecture = (data as { architecture?: { input_modalities?: unknown } }).architecture;
  return {
    inputModalities: strings(architecture?.input_modalities),
    endpoints: raw
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((e) => ({
        ...(typeof e.context_length === "number" ? { contextLength: e.context_length } : {}),
        supportedParameters: strings(e.supported_parameters),
      })),
  };
}

/** The cap spellings the three wires know, the alternatives a pin may name. */
const CAP_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;

const vouch = (card: ModelCard, field: keyof ModelCard["provenance"]): string =>
  card.provenance[field] === "wire" ? " (wire default, unvouched)" : "";

/**
 * The pure comparison (record 0052): where the endpoint disagrees with the
 * card, and the override that would pin each. The endpoints API lists
 * parameter NAMES, never effort values, so a reasoning drift's pin names the
 * wire's own words for the tiers pi's rule would otherwise refuse — the
 * operator confirms them against the vendor's documentation before pinning.
 */
export function compareCardToEndpoints(card: ModelCard, answer: ModelEndpoints): DriftRow[] {
  const drift: DriftRow[] = [];
  const params = [...new Set(answer.endpoints.flatMap((e) => e.supportedParameters))];
  const windows = answer.endpoints.map((e) => e.contextLength).filter((w): w is number => typeof w === "number");
  const window = windows.length > 0 ? Math.max(...windows) : undefined;

  const reasoning = params.includes("reasoning");
  if (card.levels === "unknown" && reasoning)
    drift.push({
      field: "levels",
      card: "unknown (no layer names them)",
      endpoint: "reasoning supported (levels not stated)",
      pin: "levels: {high: high, xhigh: xhigh}",
    });
  else if (params.length > 0 && !reasoning)
    drift.push({
      field: "levels",
      card: card.levels === "unknown" ? "unknown (no layer names them)" : "named",
      endpoint: "reasoning not listed",
      pin: "levels: {low: null, medium: null, high: null, xhigh: null, max: null}",
    });

  if (params.length > 0 && !params.includes(card.capField)) {
    const alternative = CAP_FIELDS.find((f) => params.includes(f));
    drift.push({
      field: "capField",
      card: `${card.capField}${vouch(card, "capField")}`,
      endpoint: alternative ? `takes ${alternative}` : "no cap field among the wires' spellings",
      ...(alternative ? { pin: `capField: ${alternative}` } : {}),
    });
  }

  if (window !== undefined && window !== card.window)
    drift.push({
      field: "window",
      card: `${card.window}${vouch(card, "window")}`,
      endpoint: String(window),
      pin: `window: ${window}`,
    });

  if (answer.inputModalities.length > 0) {
    const image = answer.inputModalities.includes("image");
    if (card.inputs.image === "unknown" || card.inputs.image !== image)
      drift.push({
        field: "inputs.image",
        card: card.inputs.image === "unknown" ? "unknown" : String(card.inputs.image),
        endpoint: image ? "image input listed" : "no image input",
        pin: `inputs: {image: ${image}}`,
      });
  }

  return drift;
}

/** One checked model in the command's answer: its drift rows, or the error the
 *  endpoints read met (never the whole check's failure). */
export interface CheckedModel {
  ref: string;
  block: string;
  model: string;
  drift?: DriftRow[];
  error?: string;
}

function renderCheck(output: JsonValue): string {
  const o = output as JsonObject;
  const models = (Array.isArray(o.models) ? o.models : []) as unknown as CheckedModel[];
  if (models.length === 0) return "providers check — no aggregator model configured; nothing to read";
  const drifts = models.reduce((n, m) => n + (m.drift?.length ?? 0), 0);
  const lines = [`providers check — ${models.length} aggregator model(s), ${drifts} drift(s)`];
  for (const m of models) {
    if (m.error !== undefined) {
      lines.push(`${m.ref}: ${m.error}`);
      continue;
    }
    if (!m.drift || m.drift.length === 0) {
      lines.push(`${m.ref}: the card agrees with the endpoint`);
      continue;
    }
    lines.push(`${m.ref} — pins go under providers.${m.block}.models.${m.model}:`);
    for (const d of m.drift)
      lines.push(`• ${d.field} — card ${d.card}; endpoint ${d.endpoint}${d.pin ? ` → pin ${d.pin}` : ""}`);
  }
  return lines.join("\n");
}

export const providersCheck = defineCommand({
  id: "providers.check",
  action: "providers:read",
  effect: "read",
  describe:
    "Read the provider's own endpoints for each aggregator model the configuration names and report where the resolved model card disagrees — supported parameters, context length, modalities — with the override that would pin each.",
  render: renderCheck,
  handler: async ({ deps }) => {
    const { blocks, refs } = await deps.providers.configured();
    const registry = deps.providers.registry();
    const models: CheckedModel[] = [];
    for (const ref of [...new Set(refs)]) {
      const vendor = vendorOf(ref, blocks);
      const block = blocks[vendor.block];
      if (!block || block.vendor !== "model") continue;
      const base = { ref, block: vendor.block, model: vendor.model };
      if (!block.baseUrl) {
        models.push({ ...base, error: `providers.${vendor.block} names no baseUrl to read endpoints from` });
        continue;
      }
      const url = `${block.baseUrl.replace(/\/+$/, "")}/models/${vendor.vendor}/${vendor.vendorId}/endpoints`;
      try {
        const res = await deps.providers.fetch(url);
        if (!res.ok) {
          models.push({ ...base, error: `endpoints read failed: HTTP ${res.status}` });
          continue;
        }
        const answer = endpointsFromJson(await res.json());
        if (!answer) {
          models.push({ ...base, error: "endpoints answer carries no data.endpoints" });
          continue;
        }
        models.push({ ...base, drift: compareCardToEndpoints(resolveModelCard(ref, blocks, registry), answer) });
      } catch (err) {
        models.push({ ...base, error: `endpoints read failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return { checked: models.length, models } as unknown as JsonValue;
  },
});

/** Every model ref a configuration shape names: the defaults' per-agent models
 *  and each block's `models.<id>` override keys, once each. Read by the command
 *  wiring and by `scripts/registry-drift.ts` over the example config. */
export function configuredModelRefs(cfg: {
  defaults?: { models?: Record<string, string> };
  providers?: Record<string, { models?: Record<string, unknown> }>;
}): string[] {
  const refs = Object.values(cfg.defaults?.models ?? {});
  for (const [name, block] of Object.entries(cfg.providers ?? {}))
    for (const id of Object.keys(block.models ?? {})) refs.push(`${name}/${id}`);
  return [...new Set(refs)];
}

/**
 * The drift gate's pure half: every ref whose block reads a catalog the
 * registry ships but whose model the registry no longer carries — what a pi
 * bump drops fails `check:consistency` by name instead of surfacing on a run.
 * A block without a catalog (`none`, or no file of its name) has no registry
 * to disagree with and is never drift.
 */
export function registryDrift(
  refs: readonly string[],
  blocks: Readonly<Record<string, ProviderConfig>>,
  registry: ModelRegistry,
): string[] {
  const lines: string[] = [];
  for (const ref of [...new Set(refs)]) {
    const vendor = vendorOf(ref, blocks);
    const block = blocks[vendor.block];
    if (!block) continue; // an unknown block is the config validator's refusal, not registry drift
    const catalog = block.catalog ?? (registry.file(vendor.block) !== undefined ? vendor.block : "none");
    if (catalog === "none" || registry.file(catalog) === undefined) continue;
    if (registry.card(catalog, wireOf(block), vendor.model) === undefined)
      lines.push(
        `${ref}: the ${catalog} registry no longer carries ${vendor.model} — pin it under providers.${vendor.block}.models.${vendor.model} or name a model the registry knows`,
      );
  }
  return lines;
}

export const providersCommands: readonly CommandDef<ProvidersCommandDeps>[] = [
  providersCheck,
] as unknown as CommandDef<ProvidersCommandDeps>[];

export function registerProvidersCommands<D extends ProvidersCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of providersCommands) registry.register(cmd as unknown as CommandDef<D>);
}
