import type { AgentDef } from "./agents/registry.js";
import { toolResultText, type ChatMessage, type ContentPart, type Provider } from "./providers/types.js";
import { redactAndCap, summarizeToolResult, type RunEvent, type RunNoteKind } from "./core/runEvents.js";
import { ExecHealthTracker, ExecInfraError } from "./execution/executor.js";
import { TOOLSETS, type RunnableTool, type ToolContext } from "./tools/workspace.js";

// The runner is the provider-neutral agent loop: send messages, execute any
// requested tools, feed results back, repeat until the model stops or the
// turn budget runs out.

// #92: a sandbox that becomes unrecoverable (e.g. a heavy `pnpm install` OOMs
// or fills the disk and wedges the exec worker) surfaces every command — even a
// bare `echo` — as an ExecInfraError, distinct from a normal nonzero exit.
// After this many CONSECUTIVE infra-level failures with no successful exec
// between them, the sandbox is treated as dead: the run fails fast through the
// guaranteed finale with a diagnostic, instead of toiling commands into a dead
// sandbox until the wall-clock budget kills it. A single success resets the
// count, so a one-off blip never aborts.
const MAX_CONSECUTIVE_INFRA_FAILURES = 2;

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
  /** called with short progress notes (wrap-up warnings, budget notices) */
  onProgress?: (note: string) => void;
  /** structured run-visibility events (tool calls + redacted result summaries),
   *  consumed live by the status card and, later, the external live-view page */
  onEvent?: (event: RunEvent) => void;
  /** injectable clock for tests; defaults to Date.now */
  now?: () => number;
}

export async function runAgent(opts: RunOptions): Promise<string> {
  const tools: RunnableTool[] = TOOLSETS[opts.agent.toolset] ?? [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [...opts.messages];
  const system = opts.system ?? opts.agent.system;

  // Watch exec-infrastructure health through the executor seam: the tracker
  // counts consecutive ExecInfraError throws (a dead/wedged sandbox) and resets
  // on any successful op. Tools consume the wrapped executor via ToolContext, so
  // the runner reads sandbox health without knowing which tool ran (#92).
  const execTracker = new ExecHealthTracker(opts.toolContext.executor);
  const toolContext: ToolContext = { ...opts.toolContext, executor: execTracker };

  // The wall clock is the real budget; turns are a backstop. At the deadline
  // the loop ends and the agent is forced to write up findings so far.
  const now = opts.now ?? Date.now;
  // Every run event is stamped `at: now()` so the friction analyzer (#84) can
  // attribute wall time; lifecycle notices go out BOTH as free-text progress
  // (the card/log) and as a typed `run_note` event (the stream).
  const emit = (event: RunEvent) => opts.onEvent?.({ ...event, at: now() });
  const note = (kind: RunNoteKind, summary: string) => {
    opts.onProgress?.(summary);
    emit({ type: "run_note", kind, summary });
  };
  const deadline = now() + opts.agent.maxMinutes * 60_000;
  const warnAt = deadline - Math.min(3 * 60_000, opts.agent.maxMinutes * 15_000);
  let warned = false;
  // Set when consecutive exec-infra failures cross the threshold: the loop ends
  // and the finale reports a dead sandbox instead of the ordinary budget notice.
  let sandboxDead = false;

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
      // Redact THEN cap (redactAndCap): a pre-truncated command could sever a
      // token below its detector's length floor and leak a raw fragment.
      emit({ type: "tool_call", tool: tu.name, summary: redactAndCap(describeToolCall(tu)) });
      const tool = toolsByName.get(tu.name);
      if (!tool) {
        emit({ type: "tool_result", tool: tu.name, ok: false, summary: redactAndCap(`Unknown tool: ${tu.name}`) });
        results.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: `Unknown tool: ${tu.name}`,
          isError: true,
        });
        continue;
      }
      try {
        const output = await tool.run((tu.input ?? {}) as Record<string, unknown>, toolContext);
        emit({ type: "tool_result", tool: tu.name, ok: true, summary: summarizeToolResult(toolResultText(output)) });
        results.push({ type: "tool_result", toolUseId: tu.id, content: output });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // `infra` marks a sandbox/transport failure (not the command's own error)
        // so downstream analysis never mistakes a dead sandbox for a failing command.
        emit({
          type: "tool_result",
          tool: tu.name,
          ok: false,
          summary: summarizeToolResult(message),
          ...(err instanceof ExecInfraError ? { infra: true as const } : {}),
        });
        results.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: `Error: ${message}`,
          isError: true,
        });
      }
    }
    // One-time wrap-up warning as time runs low, attached to the tool results.
    if (!warned && now() >= warnAt) {
      warned = true;
      const minutesLeft = Math.max(1, Math.round((deadline - now()) / 60_000));
      note("wrap_up", `~${minutesLeft} min left — signaling wrap-up`);
      results.push({
        type: "text",
        text: `⏱ Time budget: about ${minutesLeft} minute(s) of tool time remain before cutoff. Finish your current check and start consolidating your answer; prefer writing up over starting new exploration.`,
      });
    }
    messages.push({ role: "user", content: results });

    // Results are appended (every tool_use has its tool_result, so the finale
    // call stays valid) — now check exec health and bail out of a dead sandbox
    // before issuing another command into it.
    if (execTracker.consecutiveInfraFailures >= MAX_CONSECUTIVE_INFRA_FAILURES) {
      sandboxDead = true;
      break;
    }
  }

  // The loop ended for one of two reasons; both end through this one guaranteed
  // finale (a final tool-less call) so the run always closes with a useful
  // message instead of a silent drain.
  if (sandboxDead) {
    const diagnostic = sandboxDeadMessage(execTracker.consecutiveInfraFailures, execTracker.lastInfraError);
    note("sandbox_dead", diagnostic);
    return await finishSandboxDead(opts, messages, system, diagnostic);
  }

  // Budget exhausted (time or turns): one final tool-less call so the work
  // so far is written up instead of discarded.
  const wasTimeout = now() >= deadline;
  note(
    wasTimeout ? "time_budget_exhausted" : "turn_budget_exhausted",
    `${wasTimeout ? "time" : "turn"} budget exhausted — writing up findings so far`,
  );
  const text = await runFinale(
    opts,
    messages,
    system,
    "You have reached the turn budget and can make no more tool calls. Write your final answer now from what you have learned so far: report your findings/results to date, then state plainly which parts of the task you did not get to and what a follow-up (in this thread, to reuse this workspace) should focus on.",
  );
  const budgetLabel = wasTimeout ? `${opts.agent.maxMinutes}-minute` : `${opts.agent.maxTurns}-turn`;
  return text
    ? `⚠️ _Hit the ${budgetLabel} budget before finishing — findings so far:_\n\n${text}`
    : `Stopped at the ${budgetLabel} budget without finishing. Partial work may exist in the workspace — narrow the task and try again.`;
}

/** The guaranteed finale shared by both wind-down paths (budget exhaustion and a
 *  dead sandbox, #92): push one final tool-less instruction and make a single
 *  inference-only call, so the run always closes with a written-up answer even
 *  when no more tools can run. Each caller supplies the instruction and formats
 *  the returned text into its own outcome message. */
async function runFinale(
  opts: RunOptions,
  messages: ChatMessage[],
  system: string,
  instruction: string,
): Promise<string> {
  messages.push({ role: "user", content: [{ type: "text", text: instruction }] });
  const finale = await opts.provider.complete({
    model: opts.model,
    system,
    messages,
    maxTokens: opts.agent.maxTokens,
  });
  return collectText(finale.content);
}

/** The one-line diagnostic surfaced when the run aborts into an unreachable
 *  sandbox (#92) — the run outcome the user acts on. Cause-NEUTRAL by design:
 *  the runner only observes that the exec transport failed N times in a row;
 *  it cannot tell a wedged/OOM'd sandbox from one that was replaced or
 *  redeployed under the run (the 2026-08-29 incident, where a guessed "likely
 *  OOM" misled the operator). So it states what it saw and quotes the last
 *  transport error verbatim (redacted + capped) so the real cause is on the
 *  card and the live view. */
function sandboxDeadMessage(failures: number, lastError: Error | null): string {
  const last = lastError ? ` Last error: ${redactAndCap(lastError.message, 300)}` : "";
  return (
    `Execution sandbox unreachable: ${failures} consecutive exec-transport failures ` +
    "(the sandbox was wedged, or replaced/redeployed mid-run) — aborting instead of retrying into it." +
    last
  );
}

/** Fail fast on an unreachable sandbox: the same guaranteed-finale path as
 *  budget exhaustion — one tool-less call — but the model is told the sandbox
 *  is gone (so it summarizes what it learned before that rather than trying
 *  more commands), and the answer leads with the diagnostic. The finale is pure
 *  inference, so it works even though the sandbox does not. */
async function finishSandboxDead(
  opts: RunOptions,
  messages: ChatMessage[],
  system: string,
  diagnostic: string,
): Promise<string> {
  const text = await runFinale(
    opts,
    messages,
    system,
    `The execution sandbox is unreachable: the last ${MAX_CONSECUTIVE_INFRA_FAILURES} commands failed at the ` +
      "infrastructure level (the exec transport itself, not normal command errors), so no further commands can run. " +
      "The runner cannot tell WHY — the sandbox may be wedged, or it may have been replaced/redeployed under this run; " +
      `the transport reported: ${JSON.stringify(diagnostic)}. Do not attempt any more tools. Write your final answer ` +
      "now from what you learned before the transport failed: report your findings/results to date, note that the " +
      "last command(s) may have completed without their results being collected, and state plainly that the run is " +
      "aborting because the sandbox is unreachable and what a follow-up (a fresh run) should focus on.",
  );
  return text ? `⚠️ _${diagnostic}_\n\n${text}` : `⚠️ ${diagnostic}`;
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
    // Full command — redaction + capping happens at the call site (redactAndCap),
    // so we never truncate before redacting.
    return `$ ${String(input.command)}`;
  }
  if (input?.path) return `${tu.name} ${String(input.path)}`;
  return tu.name;
}
