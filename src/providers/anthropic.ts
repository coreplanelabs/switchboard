import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Provider,
  ProviderConfig,
} from "./types.js";

export class AnthropicProvider implements Provider {
  readonly name: string;
  private client: Anthropic;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    // Falls back to ANTHROPIC_API_KEY / ambient credentials when apiKeyEnv is unset.
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Stream to avoid HTTP timeouts on large max_tokens; collect the final message.
    // effort is supported on Opus 4.5+/Sonnet 4.6+/Fable; it 400s on Haiku —
    // apply only where safe, since per-request model overrides can be anything.
    const effortSupported = req.effort && !/haiku|claude-3|claude-2/.test(req.model);
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map(toAnthropicMessage),
      ...(effortSupported ? { output_config: { effort: req.effort } } : {}),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
    });
    const msg = await stream.finalMessage();

    const content: ContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
      // thinking blocks are intentionally dropped from the normalized result
    }

    let stopReason: CompletionResult["stopReason"];
    // widen: older SDK typings don't include newer stop reasons like "refusal"
    switch (msg.stop_reason as string | null) {
      case "end_turn":
      case "stop_sequence":
        stopReason = "end_turn";
        break;
      case "tool_use":
        stopReason = "tool_use";
        break;
      case "max_tokens":
        stopReason = "max_tokens";
        break;
      case "refusal":
        stopReason = "refusal";
        break;
      default:
        stopReason = "other";
    }
    return { content, stopReason };
  }
}

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = m.content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType as Anthropic.Base64ImageSource["media_type"],
            data: part.data,
          },
        };
      case "tool_use":
        return {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.input as Record<string, unknown>,
        };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: part.toolUseId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        };
    }
  });
  return { role: m.role, content };
}
