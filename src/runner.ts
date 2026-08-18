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

  // update_status-only turns don't consume the budget (they're bookkeeping,
  // not work); the absolute cap below still bounds the loop.
  let turn = 0;
  for (let iteration = 0; turn < opts.agent.maxTurns && iteration < opts.agent.maxTurns * 2; iteration++) {
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

    if (!toolUses.every((t) => t.name === "update_status")) turn++;

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

  // Budget exhausted: make one final tool-less call so the work so far is
  // written up instead of discarded.
  opts.onProgress?.("turn budget exhausted — writing up findings so far");
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "You have reached the turn budget and can make no more tool calls. Write your final answer now from what you have learned so far: report your findings/results to date, then state plainly which parts of the task you did not get to and what a follow-up (in this thread, to reuse this workspace) should focus on.",
      },
    ],
  });
  const finale = await opts.provider.complete({
    model: opts.model,
    system: opts.agent.system,
    messages,
    maxTokens: opts.agent.maxTokens,
  });
  const text = collectText(finale.content);
  return text
    ? `⚠️ _Hit the ${opts.agent.maxTurns}-turn budget before finishing — findings so far:_\n\n${text}`
    : `Stopped after ${opts.agent.maxTurns} turns without finishing. Partial work may exist in the workspace — narrow the task and try again.`;
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
