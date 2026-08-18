import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Provider,
  ProviderConfig,
} from "./types.js";

// Generic adapter for any OpenAI-compatible Chat Completions endpoint:
// OpenAI, Azure OpenAI, Groq, Together, Ollama, vLLM, LM Studio, etc.
// Uses plain fetch so adding a provider is config-only — no new SDK.

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private baseUrl: string;
  private apiKey?: string;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    if (!cfg.baseUrl) {
      throw new Error(`Provider "${name}": openai-compatible providers require baseUrl`);
    }
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages: OAIMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push(...toOAIMessages(m));

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Provider "${this.name}" HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: OAIMessage; finish_reason: string }>;
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error(`Provider "${this.name}": empty choices in response`);

    const content: ContentPart[] = [];
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }
    for (const tc of choice.message.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }

    let stopReason: CompletionResult["stopReason"];
    switch (choice.finish_reason) {
      case "stop":
        stopReason = "end_turn";
        break;
      case "tool_calls":
        stopReason = "tool_use";
        break;
      case "length":
        stopReason = "max_tokens";
        break;
      case "content_filter":
        stopReason = "refusal";
        break;
      default:
        stopReason = (choice.message.tool_calls?.length ?? 0) > 0 ? "tool_use" : "other";
    }
    return { content, stopReason };
  }
}

function toOAIMessages(m: ChatMessage): OAIMessage[] {
  if (m.role === "assistant") {
    const text = m.content
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    const toolCalls: OAIToolCall[] = m.content
      .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
      .map((p) => ({
        id: p.id,
        type: "function",
        function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
      }));
    return [
      {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  // user message: tool_results become role:"tool" messages, text becomes role:"user"
  const out: OAIMessage[] = [];
  for (const part of m.content) {
    if (part.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: part.toolUseId, content: part.content });
    } else if (part.type === "text") {
      out.push({ role: "user", content: part.text });
    }
  }
  return out;
}
