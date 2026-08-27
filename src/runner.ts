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
  /** Per-run system prompt override — the dispatcher may choose an effective
   *  prompt after executor resolution (e.g. resident-repo context). Flows
   *  here, never by mutating the shared AgentDef (concurrent dispatches share
   *  it). Absent → `agent.system`. */
  system?: string;
  /** called with short progress notes (e.g. tool activity) for Slack updates */
  onProgress?: (note: string) => void;
  /** injectable clock for tests; defaults to Date.now */
  now?: () => number;
}

export async function runAgent(opts: RunOptions): Promise<string> {
  const tools: RunnableTool[] = TOOLSETS[opts.agent.toolset] ?? [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [...opts.messages];
  const system = opts.system ?? opts.agent.system;

  // The wall clock is the real budget; turns are a backstop. At the deadline
  // the loop ends and the agent is forced to write up findings so far.
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.agent.maxMinutes * 60_000;
  const warnAt = deadline - Math.min(3 * 60_000, opts.agent.maxMinutes * 15_000);
  let warned = false;

  // update_status-only turns don't consume the turn budget (bookkeeping,
  // not work); the absolute iteration cap still bounds the loop.
  let turn = 0;
  for (let iteration = 0; turn < opts.agent.maxTurns && iteration < opts.agent.maxTurns * 2 && now() < deadline; iteration++) {
    const result = await opts.provider.complete({
      model: opts.model,
      system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens: opts.agent.maxTokens,
      effort: opts.agent.effort,
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
    // One-time wrap-up warning as time runs low, attached to the tool results.
    if (!warned && now() >= warnAt) {
      warned = true;
      const minutesLeft = Math.max(1, Math.round((deadline - now()) / 60_000));
      opts.onProgress?.(`~${minutesLeft} min left — signaling wrap-up`);
      results.push({
        type: "text",
        text: `⏱ Time budget: about ${minutesLeft} minute(s) of tool time remain before cutoff. Finish your current check and start consolidating your answer; prefer writing up over starting new exploration.`,
      });
    }
    messages.push({ role: "user", content: results });
  }

  // Budget exhausted (time or turns): one final tool-less call so the work
  // so far is written up instead of discarded.
  const wasTimeout = now() >= deadline;
  opts.onProgress?.(`${wasTimeout ? "time" : "turn"} budget exhausted — writing up findings so far`);
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
    system,
    messages,
    maxTokens: opts.agent.maxTokens,
  });
  const text = collectText(finale.content);
  const budgetLabel = wasTimeout ? `${opts.agent.maxMinutes}-minute` : `${opts.agent.maxTurns}-turn`;
  return text
    ? `⚠️ _Hit the ${budgetLabel} budget before finishing — findings so far:_\n\n${text}`
    : `Stopped at the ${budgetLabel} budget without finishing. Partial work may exist in the workspace — narrow the task and try again.`;
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
