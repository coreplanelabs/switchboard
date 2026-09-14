// The bot's side of the extension (docs/reference/specs/harness-pi.md item 7):
// what a run's pi asks over the three harness routes. `tools` — the run's
// relayed tool definitions, one JSON Schema each, so the extension registers
// them; `authorize` — the gate before every tool call, pi's own tools judged
// by the tool rules for the run's identity and every tool refused during the write-up, a
// refusal recorded as `tool_refused` on the run; `tool` — a relayed tool run in
// the bot with the run's own context (the executor, the GitHub gate, the
// dispatcher's recorders) under the span the bridge opened for the call, its
// result in pi's shape. The registry says which runs are live: a bearer names
// its run, and a run that is not driving a pi answers nothing.

import { TracingExecutor } from "../../../execution/tracingExecutor.js";
import { capToolResultContent, type ToolDef, type ToolResultContent } from "../../../providers/types.js";
import type { RunnableTool, ToolContext } from "../../../tools/workspace.js";
import type { Backend } from "../../trace/attrs.js";
import { redactAndCap, type RunEvent } from "../../runEvents.js";
import type { Span } from "../../trace/types.js";
import { judgeToolCall, type ToolRuleContext } from "./toolRules.js";

/** One run driving a pi, as the routes see it. */
export interface LiveHarness {
  runId: string;
  /** The tools pi relays to the bot — the native definitions, run here. */
  tools: RunnableTool[];
  toolContext: ToolContext;
  backend?: Backend;
  /** The checkout and the run's branch the tool rules judge pi's own tools against. */
  rules: ToolRuleContext;
  emit: (event: RunEvent) => void;
  /** The span the bridge opened for a call still running, so a relayed tool's work hangs under it. */
  toolSpan: (callId: string) => Span | undefined;
  /** The gate saw this call — the extension asked for it, whatever the
   *  answer. The bridge keeps the ids, so a call that ends without one is
   *  known to have run unvetted (or to have been answered by pi itself). */
  gateSaw: (callId: string) => void;
  /** The reason every tool is refused right now — the write-up — or nothing. */
  toolsBlocked: () => string | undefined;
}

export interface ToolCallAsk {
  toolCallId: string;
  tool: string;
  input: unknown;
}

export type AuthorizeAnswer = { allow: true } | { allow: false; reason: string };

/** pi's tool result content: text and image blocks. */
export type PiContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export interface RelayedToolAnswer {
  content: PiContent;
  isError: boolean;
}

export class HarnessRegistry {
  private readonly live = new Map<string, LiveHarness>();

  /** The run drives a pi from here; the returned function forgets it. */
  register(harness: LiveHarness): () => void {
    this.live.set(harness.runId, harness);
    return () => {
      if (this.live.get(harness.runId) === harness) this.live.delete(harness.runId);
    };
  }

  get(runId: string): LiveHarness | undefined {
    return this.live.get(runId);
  }

  size(): number {
    return this.live.size;
  }
}

/** The definitions the extension registers: name, description, schema — the native tool table's own. */
export function relayedToolDefinitions(harness: LiveHarness): ToolDef[] {
  return harness.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** The gate: a write-up refuses every tool; a relayed tool runs under the
 *  bot's own gates when it runs; pi's own tools are judged by the tool rules
 *  for the run's identity from the call alone. A refusal is a `tool_refused` note and
 *  the reason the model reads. Whatever the answer, the harness is told the
 *  gate saw the call first. */
export function authorizeToolCall(harness: LiveHarness, ask: ToolCallAsk): AuthorizeAnswer {
  harness.gateSaw(ask.toolCallId);
  const blocked = harness.toolsBlocked();
  const refuse = (reason: string): AuthorizeAnswer => {
    harness.emit({
      type: "run_note",
      kind: "tool_refused",
      summary: redactAndCap(`${ask.tool} refused: ${reason}`, 300),
    });
    return { allow: false, reason };
  };
  if (blocked !== undefined) return refuse(blocked);
  if (harness.tools.some((t) => t.name === ask.tool)) return { allow: true };
  const verdict = judgeToolCall(ask.tool, ask.input, harness.rules);
  if (verdict.verdict === "allowed") return { allow: true };
  return refuse(verdict.reason);
}

/** A relayed tool, run as the native loop runs it: the run's context, the
 *  call's span with a tracing executor and a publisher stamping the span, the
 *  result capped as the model would see it — and every failure a result,
 *  never a throw. An unknown tool is an error result naming it. */
export async function runRelayedTool(harness: LiveHarness, ask: ToolCallAsk): Promise<RelayedToolAnswer> {
  const tool = harness.tools.find((t) => t.name === ask.tool);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${ask.tool}` }], isError: true };
  const span = harness.toolSpan(ask.toolCallId);
  const base = harness.toolContext;
  const ctx: ToolContext = span
    ? {
        ...base,
        span,
        executor: new TracingExecutor(base.executor, span, harness.backend),
        publish: (e) => harness.emit(withSpanId(e, span.id)),
        ...(base.github?.api.withSpan ? { github: { ...base.github, api: base.github.api.withSpan(span) } } : {}),
      }
    : { ...base, publish: (e) => harness.emit(e) };
  try {
    const input = typeof ask.input === "object" && ask.input !== null ? (ask.input as Record<string, unknown>) : {};
    const output = await tool.run(input, ctx);
    return { content: piContentOf(capToolResultContent(output)), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: piContentOf(capToolResultContent(`Error: ${message}`)), isError: true };
  }
}

/** The runner's tool result in pi's content shape: text and images as blocks, a document as its descriptor. */
export function piContentOf(content: ToolResultContent): PiContent {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : p.type === "image"
        ? { type: "image", data: p.data, mimeType: p.mediaType }
        : { type: "text", text: `[document ${p.name ?? "document"} (${p.mediaType})]` },
  );
}

/** Stamp the call's span on what the tool itself publishes — the native `withSpanId`. */
function withSpanId(e: RunEvent, spanId: string): RunEvent {
  switch (e.type) {
    case "tool_call":
    case "tool_result":
    case "run_note":
    case "assistant":
    case "skill_use":
      return { ...e, spanId };
    default:
      return e;
  }
}
