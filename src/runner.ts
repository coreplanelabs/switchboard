import type { AgentDef } from "./agents/registry.js";
import { toolResultText, type ChatMessage, type ContentPart, type Provider } from "./providers/types.js";
import { redactAndCap, redactSecrets, summarizeToolResult, type RunEvent, type RunNoteKind, type StopMode } from "./core/runEvents.js";
import type { RunControl } from "./core/runRegistry.js";
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
  /** Operator stop control (#101), minted per run by the RunRegistry. Soft:
   *  the loop takes no new step and wraps up through the finale. Hard: the
   *  in-flight provider/tool call is abandoned (and cancelled where the
   *  implementation can) and the run ends at once with no finale. Absent (CLI,
   *  tests) → the loop can only end through its budgets. */
  control?: RunControl;
  /** Bound on the finale's single write-up call (default 3 min); injectable so
   *  tests can prove the timeout path without waiting. */
  finaleTimeoutMs?: number;
}

/** Thrown inside the loop the moment a hard stop is observed, so every await
 *  unwinds to one place. Never escapes `runAgent`. */
class HardStopError extends Error {
  constructor() {
    super("run hard-stopped by operator");
    this.name = "HardStopError";
  }
}

/** The one-line outcome of a hard stop: no finale was run, so this IS the
 *  answer the thread gets. */
const HARD_STOP_MESSAGE =
  "⛔ Run aborted by an operator (hard stop). No summary was written; partial work may exist in the workspace.";

export async function runAgent(opts: RunOptions): Promise<string> {
  const control = opts.control;
  // Every run event is stamped `at: now()` so the friction analyzer (#84) can
  // attribute wall time; lifecycle notices go out BOTH as free-text progress
  // (the card/log) and as a typed `run_note` event (the stream).
  const now = opts.now ?? Date.now;
  const emit = (event: RunEvent) => opts.onEvent?.({ ...event, at: now() });
  const note = (kind: RunNoteKind, summary: string, mode?: StopMode) => {
    opts.onProgress?.(summary);
    emit({ type: "run_note", kind, summary, ...(mode ? { mode } : {}) });
  };

  try {
    return await runLoop(opts, now, note, emit);
  } catch (err) {
    // A hard stop is the ONLY expected way out here: whatever was awaited (a
    // provider stream, a tool, even the soft-stop finale) was abandoned. Any
    // other throw is a real failure and keeps propagating to the dispatcher.
    if (control?.requested === "hard") {
      note("stopped", "hard stop — run aborted, no summary written", "hard");
      return HARD_STOP_MESSAGE;
    }
    throw err;
  }
}

async function runLoop(
  opts: RunOptions,
  now: () => number,
  note: (kind: RunNoteKind, summary: string, mode?: StopMode) => void,
  emit: (event: RunEvent) => void,
): Promise<string> {
  const tools: RunnableTool[] = TOOLSETS[opts.agent.toolset] ?? [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [...opts.messages];
  const system = opts.system ?? opts.agent.system;
  const control = opts.control;
  const hardSignal = control?.hardSignal;

  // Watch exec-infrastructure health through the executor seam: the tracker
  // counts consecutive ExecInfraError throws (a dead/wedged sandbox) and resets
  // on any successful op. Tools consume the wrapped executor via ToolContext, so
  // the runner reads sandbox health without knowing which tool ran (#92).
  const execTracker = new ExecHealthTracker(opts.toolContext.executor);
  const toolContext: ToolContext = {
    ...opts.toolContext,
    executor: execTracker,
    ...(hardSignal ? { signal: hardSignal } : {}),
  };

  // Every await inside the loop goes through here: the promise is raced against
  // a signal, so the wait ends the moment the signal fires regardless of
  // whether the provider/executor underneath honors the AbortSignal it was
  // handed. The abandoned promise is never left dangling: on the race path
  // `then(resolve, reject)` is its handler, and on the already-aborted fast
  // path an explicit no-op catch swallows its eventual rejection (a provider
  // handed an aborted signal rejects promptly — without this that rejection
  // would be unhandled and, under Node's default policy, kill the process).
  const raceSignal = <T>(p: Promise<T>, signal: AbortSignal | undefined, onAbort: () => Error): Promise<T> => {
    if (!signal) return p;
    if (signal.aborted) {
      p.catch(() => {});
      return Promise.reject(onAbort());
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(onAbort());
      signal.addEventListener("abort", abort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
  const untilHardStop = <T>(p: Promise<T>): Promise<T> => raceSignal(p, hardSignal, () => new HardStopError());
  // A provider call under the hard signal, optionally joined with a deadline
  // (the finale's timeout). A hard stop always unwinds as HardStopError; a
  // deadline that fires first is a FinaleTimeoutError the finale caller handles.
  const complete: Complete = (req, deadline) => {
    const signal = hardSignal && deadline ? AbortSignal.any([hardSignal, deadline]) : (hardSignal ?? deadline);
    return raceSignal(opts.provider.complete(signal ? { ...req, signal } : req), signal, () =>
      hardSignal?.aborted ? new HardStopError() : new FinaleTimeoutError(),
    );
  };

  // The wall clock is the real budget; turns are a backstop. At the deadline
  // the loop ends and the agent is forced to write up findings so far.
  const deadline = now() + opts.agent.maxMinutes * 60_000;
  const warnAt = deadline - Math.min(3 * 60_000, opts.agent.maxMinutes * 15_000);
  let warned = false;
  // Set when consecutive exec-infra failures cross the threshold: the loop ends
  // and the finale reports a dead sandbox instead of the ordinary budget notice.
  let sandboxDead = false;

  // update_status-only turns don't consume the turn budget (bookkeeping,
  // not work); the absolute iteration cap still bounds the loop.
  let turn = 0;
  // A requested stop (soft or hard) ends the loop before the NEXT step — the
  // step already in flight completes (soft) or is abandoned (hard, via the race
  // above). Checked as a loop condition so a stop can never start a new step.
  for (
    let iteration = 0;
    turn < opts.agent.maxTurns && iteration < opts.agent.maxTurns * 2 && now() < deadline && !control?.requested;
    iteration++
  ) {
    const result = await complete({
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

    // The model "talking" between tool calls is part of the run's timeline:
    // text that rode alongside this turn's tool_use goes out as an `assistant`
    // event (redacted, uncapped like `answer`) BEFORE the tool rows it explains.
    // A text-only completion never reaches here — it returned above as the
    // answer, which the dispatcher publishes — so nothing is emitted twice.
    const spoken = collectText(result.content);
    if (spoken) emit({ type: "assistant", text: redactSecrets(spoken) });

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
        const output = await untilHardStop(tool.run((tu.input ?? {}) as Record<string, unknown>, toolContext));
        emit({ type: "tool_result", tool: tu.name, ok: true, summary: summarizeToolResult(toolResultText(output)) });
        results.push({ type: "tool_result", toolUseId: tu.id, content: output });
      } catch (err) {
        // A hard stop is not a tool error to feed back to the model — unwind.
        // A genuine tool error that merely coincides with the hard request is
        // unwound too (the outcome is the abort either way), but logged first
        // so it is not silently swallowed behind the abort message.
        if (err instanceof HardStopError) throw err;
        if (control?.requested === "hard") {
          console.warn(`[runner] tool ${tu.name} failed while hard-stopping: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
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

  // The loop ended for one of three reasons; all end through this one
  // guaranteed finale (a final tool-less call) so the run always closes with a
  // useful message instead of a silent drain. (A HARD stop never reaches here —
  // it unwinds through runAgent's catch with no finale.)
  if (control?.requested === "soft") {
    note("stopped", "soft stop — no further steps, writing up findings so far", "soft");
    return await finishSoftStop(complete, opts, messages, system);
  }

  if (sandboxDead) {
    const diagnosis = sandboxDeadDiagnosis(execTracker.lastInfraError);
    note("sandbox_dead", `${diagnosis} — aborting instead of retrying into a dead sandbox`);
    return await finishSandboxDead(complete, opts, messages, system, diagnosis);
  }

  // Budget exhausted (time or turns): one final tool-less call so the work
  // so far is written up instead of discarded.
  const wasTimeout = now() >= deadline;
  note(
    wasTimeout ? "time_budget_exhausted" : "turn_budget_exhausted",
    `${wasTimeout ? "time" : "turn"} budget exhausted — writing up findings so far`,
  );
  const text = await runFinale(
    complete,
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

/** A provider call already wrapped with the run's hard-stop race + signal; an
 *  optional `deadline` signal is joined in (the finale's timeout). */
type Complete = (req: Parameters<Provider["complete"]>[0], deadline?: AbortSignal) => ReturnType<Provider["complete"]>;

/** Thrown by `complete` when the finale's deadline fires before the provider
 *  answers. Handled inside `runFinale` (→ empty write-up, so each caller's
 *  fallback message applies); never escapes `runAgent`. */
class FinaleTimeoutError extends Error {
  constructor() {
    super("finale timed out");
    this.name = "FinaleTimeoutError";
  }
}

/** Upper bound on the finale's single inference call. The loop's budgets end
 *  the loop, but nothing else bounds the write-up call itself — a provider that
 *  hangs there would otherwise keep the run alive indefinitely (an operator
 *  could only escalate to a hard stop). Generous: a full write-up is one call. */
const FINALE_TIMEOUT_MS = 3 * 60_000;

/** The guaranteed finale shared by every wind-down path (budget exhaustion, a
 *  dead sandbox #92, a soft stop #101): push one final tool-less instruction
 *  and make a single inference-only call, so the run always closes with a
 *  written-up answer even when no more tools can run. Each caller supplies the
 *  instruction and formats the returned text into its own outcome message.
 *  Bounded by `FINALE_TIMEOUT_MS` (`RunOptions.finaleTimeoutMs` in tests): on
 *  timeout the write-up is empty, so the caller's "no findings" fallback is the
 *  answer instead of a hung run. A hard stop still unwinds through the caller. */
async function runFinale(
  complete: Complete,
  opts: RunOptions,
  messages: ChatMessage[],
  system: string,
  instruction: string,
): Promise<string> {
  messages.push({ role: "user", content: [{ type: "text", text: instruction }] });
  try {
    const finale = await complete(
      {
        model: opts.model,
        system,
        messages,
        maxTokens: opts.agent.maxTokens,
      },
      AbortSignal.timeout(opts.finaleTimeoutMs ?? FINALE_TIMEOUT_MS),
    );
    return collectText(finale.content);
  } catch (err) {
    if (err instanceof FinaleTimeoutError) {
      opts.onProgress?.("finale timed out — closing the run without a write-up");
      return "";
    }
    throw err;
  }
}

/** Soft stop (#101): an operator asked the run to wind down. Same guaranteed
 *  finale as budget exhaustion — the model is told to stop and write up — so the
 *  thread gets a real summary, labeled as an early stop rather than a budget. */
async function finishSoftStop(
  complete: Complete,
  opts: RunOptions,
  messages: ChatMessage[],
  system: string,
): Promise<string> {
  const text = await runFinale(
    complete,
    opts,
    messages,
    system,
    "An operator has asked this run to stop. You can make no more tool calls. Write your final answer now from what " +
      "you have learned so far: report your findings/results to date, then state plainly which parts of the task you " +
      "did not get to and what a follow-up (in this thread, to reuse this workspace) should focus on.",
  );
  return text
    ? `⏹ _Stopped early by an operator (soft stop) — findings so far:_\n\n${text}`
    : "⏹ Stopped early by an operator (soft stop) before any findings were written. Partial work may exist in the workspace.";
}

/** The one-line diagnostic surfaced when the run aborts into an unrecoverable
 *  sandbox (#92) — the run outcome the user acts on. It states what was
 *  OBSERVED (the count and the last exec-transport error, verbatim) and never
 *  asserts a cause: the 2026-08-29 abort blamed "OOM/disk" when the real cause
 *  was three `wrangler deploy`s replacing the resident isolate mid-run. The
 *  generic hint appears only when no error text was captured. */
function sandboxDeadDiagnosis(lastInfraError: string | undefined): string {
  const evidence = lastInfraError?.trim()
    ? `last: ${lastInfraError.trim()}`
    : "no error text was captured; possible causes include the sandbox running out of memory or disk, or its exec transport dying";
  return `Sandbox exec transport failed ${MAX_CONSECUTIVE_INFRA_FAILURES} times in a row (${evidence})`;
}

/** Fail fast on an unrecoverable sandbox: the same guaranteed-finale path as
 *  budget exhaustion — one tool-less call — but the model is told the sandbox
 *  is dead (so it summarizes what it learned before it died rather than trying
 *  more commands) and given the same evidence-only diagnosis the user sees, and
 *  the answer leads with that diagnosis. The finale is pure inference, so it
 *  works even though the sandbox does not. */
async function finishSandboxDead(
  complete: Complete,
  opts: RunOptions,
  messages: ChatMessage[],
  system: string,
  diagnosis: string,
): Promise<string> {
  const text = await runFinale(
    complete,
    opts,
    messages,
    system,
    `The execution sandbox is unrecoverable: ${diagnosis}. These failed at the infrastructure level (the exec ` +
      "transport itself, not normal command errors), so no further commands can run. Do not attempt any more " +
      "tools. Write your final answer now from what you learned before it died: report your findings/results to " +
      "date, quote that infrastructure error as the reason the run is aborting (do not speculate about a different " +
      "cause), and state what a follow-up (a fresh run in this thread once the sandbox is healthy) should focus on.",
  );
  const headline = `${diagnosis}. Aborting instead of retrying into a dead sandbox.`;
  return text ? `⚠️ _${headline}_\n\n${text}` : `⚠️ ${headline}`;
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
