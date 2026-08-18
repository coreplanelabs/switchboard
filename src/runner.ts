import type { AgentDef } from "./agents/registry.js";
import type { ChatMessage, ContentPart, Provider } from "./providers/types.js";
import { TOOLSETS, type RunnableTool, type ToolContext } from "./tools/workspace.js";

// The runner is the provider-neutral agent loop: send messages, execute any
// requested tools, feed results back, repeat until the model stops or the
// turn budget runs out.

export interface RunOptions {
  provider: Provider;
  model: string;
  agent: AgentDef;
  messages: ChatMessage[];
  toolContext: ToolContext;
  /** called with short progress notes (e.g. tool activity) for Slack updates */
  onProgress?: (note: string) => void;
}

export async function runAgent(opts: RunOptions): Promise<string> {
  const tools: RunnableTool[] = TOOLSETS[opts.agent.toolset] ?? [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [...opts.messages];

  for (let turn = 0; turn < opts.agent.maxTurns; turn++) {
    const result = await opts.provider.complete({
      model: opts.model,
      system: opts.agent.system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens: opts.agent.maxTokens,
    });

    if (result.stopReason === "refusal") {
      return "The model declined this request (safety refusal). Try rephrasing, or switch models with `model:<provider>/<model>`.";
    }

    const toolUses = result.content.filter(
      (p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use",
    );

    if (toolUses.length === 0 || result.stopReason !== "tool_use") {
      const text = collectText(result.content);
      if (result.stopReason === "max_tokens") {
        return text + "\n\n_(output truncated: hit the token limit)_";
      }
      return text || "_(no response)_";
    }

    // Echo the assistant turn, run tools, append results as one user turn.
    messages.push({ role: "assistant", content: result.content });
    const results: ContentPart[] = [];
    for (const tu of toolUses) {
      opts.onProgress?.(describeToolCall(tu));
      const tool = toolsByName.get(tu.name);
      if (!tool) {
        results.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: `Unknown tool: ${tu.name}`,
          isError: true,
        });
        continue;
      }
      try {
        const output = await tool.run((tu.input ?? {}) as Record<string, unknown>, opts.toolContext);
        results.push({ type: "tool_result", toolUseId: tu.id, content: output });
      } catch (err) {
        results.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return `Stopped after ${opts.agent.maxTurns} turns without finishing. Partial work may exist in the workspace — narrow the task and try again.`;
}

function collectText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function describeToolCall(tu: Extract<ContentPart, { type: "tool_use" }>): string {
  const input = tu.input as Record<string, unknown> | undefined;
  if (tu.name === "bash" && input?.command) {
    return `$ ${String(input.command).slice(0, 120)}`;
  }
  if (input?.path) return `${tu.name} ${String(input.path)}`;
  return tu.name;
}
