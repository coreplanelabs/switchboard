// Provider-neutral chat types. Each provider adapter maps these to its own
// wire format, so agents and the runner never depend on a specific vendor.

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string } // data is base64, no data: prefix
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}

export interface ToolDef {
  name: string;
  description: string;
  // JSON Schema for the tool input
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string; // bare model id, provider prefix already stripped
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens: number;
  /** model effort hint; providers apply it only where the model supports it */
  effort?: "low" | "medium" | "high";
}

export interface CompletionResult {
  // assistant content parts in order (text and tool_use)
  content: ContentPart[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface ProviderConfig {
  type: "anthropic" | "openai-compatible";
  /** Env var holding the API key (never put keys in config files). */
  apiKeyEnv?: string;
  /** Base URL for openai-compatible providers (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
}

/** "anthropic/claude-opus-5" -> { provider: "anthropic", model: "claude-opus-5" } */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i === -1) {
    throw new Error(
      `Model "${ref}" must be qualified as "<provider>/<model>", e.g. "anthropic/claude-opus-5"`,
    );
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
