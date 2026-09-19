// A model provider as the bot sees one: the completion vocabulary — a
// `Provider` whose `complete` takes a `CompletionRequest` and answers a
// `CompletionResult` with its `TokenUsage`, and the tool definition a request
// carries (`ToolDef`) — the `providers:` block of
// `config.yaml` a provider is built from (`ProviderConfig`) and the
// `<provider>/<model>` ref that names one (`parseModelRef`). Implemented by
// pi's model library in the bot process (`src/core/harness/piAi.ts`) for the
// calls made outside a run loop, and by the native adapters in
// `src/providers/` until record 0032's series deletes them; the model proxy
// meters a run's calls in the same `TokenUsage`. Moved here from
// `src/providers/types.ts` so the vocabulary outlives the native provider layer
// (docs/decisions/0032-pi-is-the-harness-the-native-loop-retires.md, step 5 of
// the series). A leaf over ./chatMessage.ts and ../effort.ts: the run ledger's
// Node-free contract reads `ToolDef` from here, and nothing under src/tools/
// comes with it into the memory Worker's build.

import type { Effort } from "../effort.js";
import type { ChatMessage, ContentPart } from "./chatMessage.js";

/** How long a prompt-cache entry written by a request stays warm. `5m` is
 *  refreshed by every read (strictly cheaper while turns start < 5 min apart);
 *  `1h` costs 2× on write but survives the long model turns + tool runs of a
 *  coding run, where a 5m entry would expire between requests. */
export type CacheTtl = "5m" | "1h";

/** A tool as the model is told it: the name, the description and the JSON
 *  Schema of its input. A request carries a list of these; a `RunnableTool`
 *  (src/tools/runnableTool.ts) is one with its `run`; the relay serves them to
 *  pi's extension and the run ledger records the list a step saw. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string; // bare model id, provider prefix already stripped
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Force tool calling (the request router's shape, routing-and-config item
   *  21). `{type: "tool", name}` forces the named tool — Anthropic:
   *  `tool_choice: {type: "tool", name}`; Chat Completions: `tool_choice:
   *  {type: "function", function: {name}}` — so the call's input IS the answer
   *  and prose cannot occur. `{type: "any"}` forces one call to some tool of
   *  `tools` — spelled `"any"` on Anthropic's Messages API and `"required"` on
   *  Chat Completions, with parallel tool calls switched off on the wire so
   *  the answer is exactly one call. Absent → the model chooses. */
  toolChoice?: { type: "tool"; name: string } | { type: "any" };
  maxTokens: number;
  /** model effort hint; providers apply it only where the model supports it */
  effort?: Effort;
  /** Cancellation for a hard run stop: providers pass it to their HTTP
   *  call so an aborted run stops billing/streaming now. Absent → never aborts. */
  signal?: AbortSignal;
  /** Prompt-cache TTL for this call's breakpoints; providers that cache apply
   *  it to every breakpoint. Absent → the provider default (`5m`). */
  cacheTtl?: CacheTtl;
  /** Timing hooks for the call's span (docs/reference/specs/tracing.md): a streaming
   *  provider reports the first token; the span layer stamps the time. A
   *  provider that cannot observe its stream simply never calls them. */
  observer?: CompletionObserver;
}

export interface CompletionObserver {
  onFirstToken?(): void;
  /** A content block began / ended, by kind (`text`, `thinking`, `redacted_thinking`,
   *  `tool_use`, …) and stream index: the span layer sums a turn's thinking and
   *  writing time from these (docs/reference/specs/tracing.md; live-view item 15). */
  onBlockStart?(kind: string, index: number): void;
  onBlockEnd?(kind: string, index: number): void;
}

/** Token accounting for ONE model call, normalized across providers. Cache
 *  counters are present only when the provider reports them. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CompletionResult {
  // assistant content parts in order (text and tool_use)
  content: ContentPart[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  /** Absent when the provider did not report usage (or reported it malformed). */
  usage?: TokenUsage;
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** The three wire shapes a provider block may declare (record 0052):
 *  Anthropic's Messages API, OpenAI's Chat Completions and OpenAI's Responses
 *  API. Each is a proxy route of its own (`PROXY_PATHS`): an `openai-responses`
 *  block runs on `/v1/responses`, pinned and metered like the other two. */
export const WIRES = ["anthropic-messages", "openai-chat", "openai-responses"] as const;
export type Wire = (typeof WIRES)[number];

/** The legacy `type` words, as the wires they load as for one release. */
export const WIRE_ALIASES: Readonly<Record<string, Wire>> = {
  anthropic: "anthropic-messages",
  "openai-compatible": "openai-chat",
};

/** One model's operator override under a block's `models.<id>` (record 0052,
 *  the operator layer of the card). Every field is optional and wins over the
 *  registry card and the wire defaults where it is set. */
export interface ProviderModelOverride {
  /** Our effort tiers → the wire's word, or null to refuse the tier. */
  levels?: Record<string, string | null>;
  /** The body field the output cap is spelled with on this model. */
  capField?: string;
  /** The model's context window in tokens. */
  window?: number;
  /** Which input kinds the model takes. */
  inputs?: { image?: boolean; document?: boolean };
  /** The model's cache rule. */
  cache?: "automatic" | "markers" | "none" | "unknown";
  /** USD per million tokens, by kind. */
  price?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** The answer shapes the model can produce for a forced one-call turn (the
   *  router's, intake's): `tool` — a forced tool call — and `text` — the
   *  one-JSON-object text contract. Absent, both are assumed; an empty list
   *  declares neither, and a load whose intake would classify on such a card
   *  is refused by name (routing-and-config item 27). */
  answers?: ("tool" | "text")[];
}

export interface ProviderConfig {
  /** The legacy wire word: `anthropic` or `openai-compatible` (record
   *  0052). `wire` is the new spelling; `type` keeps loading as its alias for
   *  one release. A block may declare either; validation derives the one it
   *  did not. */
  type: "anthropic" | "openai-compatible";
  /** The wire the block speaks (`anthropic-messages`, `openai-chat`,
   *  `openai-responses`). Absent → derived from `type`. */
  wire?: Wire;
  /** The vendor whose models this block serves: a name (default, the block's
   *  own) or `model`, which makes the block an aggregator whose vendor is the
   *  model id's first segment. */
  vendor?: string;
  /** The pi registry file consulted for this block's cards (default, the
   *  block's own name when such a file exists; `none` otherwise). */
  catalog?: string;
  /** Per-model operator overrides, keyed by the model id as the ref spells it. */
  models?: Record<string, ProviderModelOverride>;
  /** Extra body fields merged into every request on the wires whose adapter
   *  takes one. Never a control: not decided, not noted, not in the matrix. */
  passthrough?: Record<string, unknown>;
  /** Env var holding the API key (never put keys in config files). */
  apiKeyEnv?: string;
  /** Env var holding the biller's INVOICE credential — not the completion key:
   *  Anthropic's Admin API key (`sk-ant-admin…`, the cost report), OpenRouter's
   *  management key (`GET /api/v1/activity`), OpenAI's admin key
   *  (`GET /v1/organization/costs`). Named on the block because the block IS the
   *  biller (record 0052): the costs page's per-biller tie-out reads each
   *  block's invoice through it (docs/reference/specs/costs.md item 4d). */
  invoiceKeyEnv?: string;
  /** Base URL for openai-compatible providers (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
}

/** The wire a block speaks: its `wire` when declared, else its legacy `type`. */
export function wireOf(block: Pick<ProviderConfig, "type" | "wire">): Wire {
  return block.wire ?? WIRE_ALIASES[block.type] ?? "openai-chat";
}

/** One `<block>/<model>` ref read for the vendor it serves (record 0052):
 *  the block, the model id as the ref spells it, the vendor, the vendor's own
 *  id (the model id less a vendor prefix) and which layer named the vendor. */
export interface VendorRef {
  block: string;
  model: string;
  vendor: string;
  vendorId: string;
  vendorSource: "declared" | "model" | "block";
}

/** The one vendor parse (record 0052): `parseModelRef` is the only other parser of a
 *  ref. A block that declares a vendor name uses it; a block that declares
 *  `vendor: model`, or a model id that carries its own vendor prefix
 *  (`openrouter/anthropic/claude-sonnet-5`), reads the vendor off the id's
 *  first segment; otherwise the block's own name is the vendor. `catalog`
 *  never enters: a block named unlike its catalog still serves the vendor the
 *  declaration or the id names. */
export function vendorOf(
  ref: string,
  blocks: Readonly<Record<string, Pick<ProviderConfig, "vendor">>> = {},
): VendorRef {
  const { provider: block, model } = parseModelRef(ref);
  const declared = blocks[block]?.vendor;
  const slash = model.indexOf("/");
  if (declared !== undefined && declared !== "model") {
    const prefix = `${declared}/`;
    return {
      block,
      model,
      vendor: declared,
      vendorId: model.startsWith(prefix) ? model.slice(prefix.length) : model,
      vendorSource: "declared",
    };
  }
  if (slash > 0 && (declared === "model" || declared === undefined)) {
    return {
      block,
      model,
      vendor: model.slice(0, slash),
      vendorId: model.slice(slash + 1),
      vendorSource: "model",
    };
  }
  return { block, model, vendor: block, vendorId: model, vendorSource: "block" };
}

/** The harness-side provider a block's biller implies (record 0052's
 *  amendment: the harness write names the biller's own provider, never a
 *  generic alias). Keyed by the biller — the block's name — for the billers
 *  whose protocol a harness bundles a provider for. The wires with a package
 *  of their own (`anthropic-messages` → `@ai-sdk/anthropic`,
 *  `openai-responses` → `@ai-sdk/openai`) need no entry: the wire names the
 *  package. A chat-wire biller not here is served generically
 *  (`@ai-sdk/openai-compatible`), under which a `markers` cache rule cannot be
 *  vouched for (`decideControls`): the generic provider places no cache
 *  breakpoints. */
export interface BillerHarnessProvider {
  /** The AI SDK package OpenCode's configuration names for the biller
   *  (`openCodeProviderPackage` adds the `aisdk:` prefix). */
  openCodePackage: string;
  /** The compat words pi keys on the biller's identity, copied once from pi's
   *  own completions detection of that biller and never inferred from a URL at
   *  run time: through the proxy pi sees the bot's URL, so `piModelsJson` must
   *  say the words the biller's own base URL would have made pi detect. */
  piCompat: {
    /** How the wire spells reasoning: `reasoning: { effort }` under
     *  `"openrouter"`, never the completions shape's flat `reasoning_effort`. */
    thinkingFormat: string;
    /** How a session id would ride the headers, were affinity ever turned on. */
    sessionAffinityFormat: string;
    /** The vendor-qualified id prefixes the biller grants the developer role:
     *  any other id is told `supportsDeveloperRole: false`, as pi's own
     *  detection would say against the biller directly. */
    developerRoleIdPrefixes: readonly string[];
  };
}

/** The biller-to-provider table: one row per biller a harness speaks natively
 *  — OpenCode's package (U44) and pi's compat words (U45) side by side. */
export const BILLER_HARNESS_PROVIDERS: Readonly<Record<string, BillerHarnessProvider>> = {
  openrouter: {
    openCodePackage: "@openrouter/ai-sdk-provider",
    piCompat: {
      thinkingFormat: "openrouter",
      sessionAffinityFormat: "openrouter",
      developerRoleIdPrefixes: ["anthropic/", "openai/"],
    },
  },
};

/** The biller's harness-side provider, or undefined when it is served generically. */
export function billerHarnessProvider(biller: string | undefined): BillerHarnessProvider | undefined {
  return biller === undefined ? undefined : BILLER_HARNESS_PROVIDERS[biller];
}

/** The env var Anthropic's own SDK reads when an `anthropic` provider block names none. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** "anthropic/claude-opus-5" -> { provider: "anthropic", model: "claude-opus-5" } */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i === -1) {
    throw new Error(`Model "${ref}" must be qualified as "<provider>/<model>", e.g. "anthropic/claude-opus-5"`);
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
