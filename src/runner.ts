import type { AgentDef } from "./agents/registry.js";
import type { Effort } from "./effort.js";
import {
  capToolResultContent,
  toolResultText,
  type ChatMessage,
  type CompletionResult,
  type ContentPart,
  type Provider,
} from "./providers/types.js";
import {
  COMMAND_CAP,
  parseExitPrefix,
  prepareToolResult,
  redactAndCap,
  redactSecrets,
  type RunEvent,
  type RunNoteKind,
  type StopMode,
} from "./core/runEvents.js";
import type { RunControl } from "./core/runRegistry.js";
import { followUpPrompt, followUpSnippet, type FollowUpInbox, type FollowUpInput } from "./core/threadAdmission.js";
import type { Settlement } from "./core/runLedger/resume.js";
import { ExecCapacityError, ExecHealthTracker, ExecInfraError } from "./execution/executor.js";
import { TracingExecutor } from "./execution/tracingExecutor.js";
import { TOOLSETS, type RunnableTool, type ToolContext } from "./tools/workspace.js";
import type { Backend } from "./core/trace/attrs.js";
import type { Span } from "./core/trace/types.js";
import { formatDuration } from "./core/time/formatDuration.js";

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
  /** Tools that exist for THIS run only, beside the agent's static toolset —
   *  today the bridged external MCP tools (features/mcp-tools.md item 12). A
   *  name that collides with a built-in throws at run start: a remote server
   *  must never shadow `bash`. Absent → the static toolset alone. */
  extraTools?: RunnableTool[];
  /** Per-run system prompt override — the dispatcher may choose an effective
   *  prompt after executor resolution (e.g. resident-repo context). Flows
   *  here, never by mutating the shared AgentDef (concurrent dispatches share
   *  it). Absent → `agent.system`. */
  system?: string;
  /** Effort resolved through the config layers for this run (directive >
   *  thread > user > channel > defaults). Same rule as `system`: flows here,
   *  never by mutating the AgentDef. Absent → `agent.effort`, else the
   *  provider's default. */
  effort?: Effort;
  /** called with short progress notes (wrap-up warnings, budget notices) */
  onProgress?: (note: string) => void;
  /** structured run-visibility events (tool calls + redacted result summaries),
   *  consumed live by the status card and, later, the external live-view page */
  onEvent?: (event: RunEvent) => void;
  /** injectable clock for tests; defaults to Date.now */
  now?: () => number;
  /** The parent of this run's spans (features/tracing.md): `run.agent` is
   *  opened under it, and every model turn (`model.turn`) and tool call
   *  (`tool.<name>`, with its `exec.*` children) under that. Absent (CLI,
   *  tests without a tracer) → the run emits no spans and is otherwise
   *  byte-identical. */
  span?: Span;
  /** Where the run's commands execute, recorded on its `exec.*` spans. */
  backend?: Backend;
  /** Operator stop control (#101), minted per run by the RunRegistry. Soft:
   *  the loop takes no new step and wraps up through the finale. Hard: the
   *  in-flight provider/tool call is abandoned (and cancelled where the
   *  implementation can) and the run ends at once with no finale. Absent (CLI,
   *  tests) → the loop can only end through its budgets. */
  control?: RunControl;
  /** Bound on the finale's single write-up call (default 3 min); injectable so
   *  tests can prove the timeout path without waiting. */
  finaleTimeoutMs?: number;
  /** Follow-ups steered into this run by the dispatcher while it is in flight
   *  (features/thread-admission.md). Drained at every step boundary the loop
   *  is about to cross — never mid-step, never when the loop is ending — and
   *  appended to the next user turn. Whatever is left when the loop ends is the
   *  dispatcher's to run as a fresh turn. Absent (CLI, tests) → the loop is
   *  byte-identical to a run without follow-ups. */
  inbox?: FollowUpInbox;
  /** Awaited BEFORE each step's tools run, with the transcript turns appended
   *  since the previous report and the calls about to be dispatched — what the
   *  run ledger's step write needs (features/run-history.md item 35). A throw
   *  fails the step before any tool runs: the hook decides whether a refused
   *  write may proceed, the runner never swallows it. Absent → no report. */
  onStep?: (step: StepReport) => Promise<void>;
  /** Re-enter the loop from a reclaimed run (features/run-history.md item 37):
   *  `messages` is then the transcript the ledger held, and this carries the
   *  last step record's counters and budget plus how each call in flight at the
   *  kill is settled (`planResume`). Absent → a fresh run. */
  resume?: ResumeEntry;
}

/** What `planResume` decided, as the runner takes it. */
export interface ResumeEntry {
  settlements: Settlement[];
  stepRecorded: boolean;
  turn: number;
  iteration: number;
  remainingMs: number;
}

/** One step of the loop as reported to `onStep`, before its tools run. */
export interface StepReport {
  /** The messages appended since the previous report (or since `messages`,
   *  the seed, for the first): the previous step's results turn and this step's
   *  assistant turn — every turn the model has seen, without gaps. */
  turns: ChatMessage[];
  /** The index of `turns[0]` in the run's conversation (`messages` counts from 0). */
  firstIdx: number;
  /** The tool calls this step is about to dispatch, by call id. */
  inFlight: { callId: string; tool: string }[];
  turn: number;
  iteration: number;
  remainingMs: number;
}

/** The static toolset plus this run's extra tools. A duplicate name is a
 *  programming error (an extra tool shadowing a built-in, or two extras with
 *  one name) and throws before the first model turn. Exported for tests. */
export function mergeTools(base: RunnableTool[], extra: RunnableTool[] | undefined): RunnableTool[] {
  if (!extra || extra.length === 0) return base;
  const seen = new Set(base.map((t) => t.name));
  for (const t of extra) {
    if (seen.has(t.name)) throw new Error(`extra tool "${t.name}" collides with an existing tool name`);
    seen.add(t.name);
  }
  return [...base, ...extra];
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
  // An event that already carries `at` keeps it (the `turn` event stamps its own
  // end time so `at - startedAt === durationMs` holds exactly).
  const emit = (event: RunEvent) => opts.onEvent?.(event.at === undefined ? { ...event, at: now() } : event);
  const note = (kind: RunNoteKind, summary: string, mode?: StopMode) => {
    opts.onProgress?.(summary);
    emit({ type: "run_note", kind, summary, ...(mode ? { mode } : {}) });
  };

  try {
    // The whole loop is one `run.agent` span (uncounted: its own time, minus
    // its turns and tools, is Switchboard overhead by design).
    const loop = (agentSpan: Span | undefined) => runLoop(opts, now, note, emit, agentSpan);
    return opts.span ? await opts.span.span("run.agent", loop) : await loop(undefined);
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
  agentSpan: Span | undefined,
): Promise<string> {
  const tools: RunnableTool[] = mergeTools(TOOLSETS[opts.agent.toolset] ?? [], opts.extraTools);
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
    // Tools publish through the same emitter as the runner's own events, so a
    // tool-known fact (a skill load) lands in the stream stamped and ordered
    // like everything else.
    publish: emit,
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
  // Every provider call is one `model.turn` span (features/tracing.md;
  // live-view item 15): the span ends the moment the provider returns, before
  // anything the completion produced is emitted, carrying the stop reason, the
  // token counts and the time to first token. A call that throws (hard stop,
  // finale deadline, provider error) is a turn that failed — the span says so
  // and nothing was produced. The card's `💭 thought for …` line is a progress
  // note from here; the stream carries the span, never a `turn` event.
  const complete: Complete = async (req, deadline) => {
    const signal = hardSignal && deadline ? AbortSignal.any([hardSignal, deadline]) : (hardSignal ?? deadline);
    const call = async (turnSpan: Span | undefined) => {
      const startedAt = now();
      let firstTokenAt: number | undefined;
      const observer = { onFirstToken: () => void (firstTokenAt ??= now()) };
      const result = await raceSignal(
        opts.provider.complete({ ...req, ...(signal ? { signal } : {}), observer }),
        signal,
        () => (hardSignal?.aborted ? new HardStopError() : new FinaleTimeoutError()),
      );
      const at = now();
      turnSpan?.setAttrs({
        model: `${opts.provider.name}/${opts.model}`, // the same ref `run_meta` carries (live-view item 15)
        stopReason: turnStopReason(result.stopReason),
        ...(result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
              ...(result.usage.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: result.usage.cacheWriteTokens }
                : {}),
            }
          : {}),
        ...(firstTokenAt !== undefined ? { ttftMs: firstTokenAt - startedAt } : {}),
      });
      opts.onProgress?.(`💭 thought for ${formatDuration(at - startedAt, "precise")}`);
      return result;
    };
    return agentSpan ? agentSpan.span("model.turn", call) : call(undefined);
  };

  // The wall clock is the real budget; turns are a backstop. At the deadline
  // the loop ends and the agent is forced to write up findings so far. Tools
  // get the deadline too, so the bash tool can clip a command that would
  // otherwise outlive the run (features/execution.md item 12).
  const deadline = now() + (opts.resume ? opts.resume.remainingMs : opts.agent.maxMinutes * 60_000);
  const warnAt = deadline - Math.min(3 * 60_000, opts.agent.maxMinutes * 15_000);
  toolContext.remainingMs = () => deadline - now();
  let warned = false;
  // Set when consecutive exec-infra failures cross the threshold: the loop ends
  // and the finale reports a dead sandbox instead of the ordinary budget notice.
  let sandboxDead = false;

  // update_status-only turns don't consume the turn budget (bookkeeping,
  // not work); the absolute iteration cap still bounds the loop.
  let turn = 0;
  // The loop condition below, as a predicate over a prospective (turn,
  // iteration): "would the loop take another step from here?" — what decides
  // whether a pending follow-up is drained now (it would be read by that step)
  // or left for the dispatcher (the loop is ending; a fresh turn runs it).
  const wouldStep = (turns: number, iteration: number) =>
    turns < opts.agent.maxTurns && iteration < opts.agent.maxTurns * 2 && now() < deadline && !control?.requested;
  // Follow-ups steered into this run (features/thread-admission.md item 2):
  // everything pending becomes ONE text part (plus the inputs' attachments) on
  // the next user turn, each input recorded on the stream as it is consumed.
  const pendingFollowUps = () => (opts.inbox?.size ?? 0) > 0;
  const drainFollowUps = (superseded = false): ContentPart[] => {
    const inputs: FollowUpInput[] = opts.inbox?.drain() ?? [];
    for (const input of inputs) {
      const source = {
        ...(input.sourceUrl ? { url: input.sourceUrl } : {}),
        ...(input.userName ? { user: input.userName } : {}),
      };
      emit({ type: "input", text: redactSecrets(input.text), ...(Object.keys(source).length > 0 ? { source } : {}) });
      note("follow_up", `follow-up folded in: ${redactSecrets(followUpSnippet(input))}`);
    }
    const parts: ContentPart[] = [{ type: "text", text: followUpPrompt(inputs, { superseded }) }];
    for (const input of inputs) {
      for (const img of input.images ?? []) parts.push({ type: "image", mediaType: img.mediaType, data: img.data });
      for (const doc of input.documents ?? [])
        parts.push({
          type: "document",
          mediaType: doc.mediaType,
          data: doc.data,
          ...(doc.name ? { name: doc.name } : {}),
        });
    }
    return parts;
  };
  // One tool_use → its tool_result part (and the events it produces), inside
  // its own `tool.<name>` span (features/tracing.md): the `tool_call` is
  // announced inside the span so it carries the span's id, the tool runs with
  // a per-call context (the span, a tracing executor, a publisher that stamps
  // the span on what the tool publishes), and the span ends with the call's
  // outcome as attrs — `error` when the tool did not succeed. Only a hard stop
  // escapes as a rejection; every tool failure is a result.
  const runOne = async (tu: ToolUsePart, announceIt = true): Promise<ContentPart> => {
    const body = async (callSpan: Span | undefined): Promise<ContentPart> => {
      if (announceIt) announce(tu, callSpan?.id);
      const spanId = callSpan ? { spanId: callSpan.id } : {};
      const settle = (ok: boolean, extra: { exitCode?: number; infra?: true } = {}) =>
        callSpan?.end(ok ? "ok" : "error", {
          callId: tu.id,
          ok,
          ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
          ...(extra.infra ? { infra: true } : {}),
        });
      const tool = toolsByName.get(tu.name);
      if (!tool) {
        emit({
          type: "tool_result",
          tool: tu.name,
          ok: false,
          summary: redactAndCap(`Unknown tool: ${tu.name}`),
          callId: tu.id,
          ...spanId,
        });
        settle(false);
        return { type: "tool_result", toolUseId: tu.id, content: `Unknown tool: ${tu.name}`, isError: true };
      }
      const ctx: ToolContext = callSpan
        ? {
            ...toolContext,
            span: callSpan,
            executor: new TracingExecutor(execTracker, callSpan, opts.backend),
            publish: (e) => emit(withSpanId(e, callSpan.id)),
          }
        : toolContext;
      try {
        const output = await untilHardStop(tool.run((tu.input ?? {}) as Record<string, unknown>, ctx));
        const text = toolResultText(output);
        // A bash command that exited nonzero did not succeed, whatever the tool
        // returned — the executors say so with an `exit N:` prefix (runEvents).
        const exit = tu.name === "bash" ? parseExitPrefix(text) : undefined;
        emit({
          type: "tool_result",
          tool: tu.name,
          ok: !exit?.failed,
          callId: tu.id,
          ...(exit?.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
          ...prepareToolResult(text),
          ...spanId,
        });
        settle(!exit?.failed, exit?.exitCode !== undefined ? { exitCode: exit.exitCode } : {});
        // The model never receives more than MAX_TOOL_RESULT_CHARS of text from
        // one tool, whatever the tool returned (providers/types.ts, #615).
        return { type: "tool_result", toolUseId: tu.id, content: capToolResultContent(output) };
      } catch (err) {
        // A hard stop is not a tool error to feed back to the model — unwind.
        // A genuine tool error that merely coincides with the hard request is
        // unwound too (the outcome is the abort either way), but logged first
        // so it is not silently swallowed behind the abort message.
        if (err instanceof HardStopError) throw err;
        if (control?.requested === "hard") {
          console.warn(
            `[runner] tool ${tu.name} failed while hard-stopping: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        // A full sandbox fleet (features/execution.md item 14) is capacity, not
        // a dead sandbox: the executor already waited its bounded time, nothing
        // ran, and the tracker did not count it — so the run goes on. The model
        // is told plainly what happened and its two ways forward; the stream
        // carries a typed note so the friction analyzer sees the minutes lost.
        if (err instanceof ExecCapacityError) {
          const text = `⏳ Sandbox fleet busy — ${message}. Retry the command in a minute or finish with what you have.`;
          emit({ type: "tool_result", tool: tu.name, ok: false, callId: tu.id, ...prepareToolResult(text), ...spanId });
          note("fleet_busy", text);
          settle(false, { infra: true });
          return { type: "tool_result", toolUseId: tu.id, content: text, isError: true };
        }
        // `infra` marks a sandbox/transport failure (not the command's own error)
        // so downstream analysis never mistakes a dead sandbox for a failing command.
        const infra = err instanceof ExecInfraError;
        emit({
          type: "tool_result",
          tool: tu.name,
          ok: false,
          callId: tu.id,
          ...prepareToolResult(message),
          ...(infra ? { infra: true as const } : {}),
          ...spanId,
        });
        callSpan?.fail(err);
        settle(false, infra ? { infra: true } : {});
        // The same ceiling on the error path: a tool that throws with a huge
        // message (an executor echoing its output into the error) is still a
        // tool result the model reads.
        return {
          type: "tool_result",
          toolUseId: tu.id,
          content: capToolResultContent(`Error: ${message}`),
          isError: true,
        };
      }
    };
    return agentSpan ? agentSpan.span(`tool.${tu.name}`, body) : body(undefined);
  };
  // Redact THEN cap (redactAndCap): a pre-truncated command could sever a
  // token below its detector's length floor and leak a raw fragment.
  // A bash call also carries its full command (redacted, capped far above the
  // summary) so the pushed-branch tracker can see a `git push` that a chained
  // command pushed past the 200-char summary (runEvents `tool_call.command`).
  const announce = (tu: ToolUsePart, spanId?: string) => {
    const input = tu.input as Record<string, unknown> | undefined;
    const command =
      tu.name === "bash" && typeof input?.command === "string"
        ? { command: redactAndCap(input.command, COMMAND_CAP) }
        : {};
    emit({
      type: "tool_call",
      tool: tu.name,
      summary: redactAndCap(describeToolCall(tu)),
      callId: tu.id,
      ...command,
      ...(spanId !== undefined ? { spanId } : {}),
    });
  };
  // Execution order: a mutating tool runs alone, in the model's order; a run
  // of consecutive side-effect-free tools (several read_file/web_fetch in one
  // turn — each a round trip to the resident or the web) runs concurrently.
  // Results are appended in the model's order regardless of completion order,
  // so `messages` is byte-identical to the serial loop. `allSettled` so a hard
  // stop that rejects several in-flight tools rejects ONCE, never unhandled.
  /** Run one assistant turn's tool calls in the model's order — a run of
   *  consecutive side-effect-free calls concurrently, everything else alone —
   *  and return their results in that order. Shared by the loop and the resume
   *  settlement (item 37). */
  const dispatchToolUses = async (
    toolUses: ToolUsePart[],
    opts: { announce?: boolean } = {},
  ): Promise<ContentPart[]> => {
    // A settlement re-run (item 37) has its `tool_call` on the stream already,
    // replayed from the ledger under its original seq; announcing again would
    // put two calls with one callId on the record. The announce happens inside
    // each call's span (`runOne`), so a batch's calls are announced as they
    // start — together, since they start together.
    const announceIt = opts.announce !== false;
    const results: ContentPart[] = [];
    const runBatch = async (batch: ToolUsePart[]) => {
      const settled = await Promise.allSettled(batch.map((tu) => runOne(tu, announceIt)));
      for (const s of settled) if (s.status === "rejected") throw s.reason;
      for (const s of settled) if (s.status === "fulfilled") results.push(s.value);
    };
    let batch: ToolUsePart[] = [];
    for (const tu of toolUses) {
      if (toolsByName.get(tu.name)?.sideEffectFree) {
        batch.push(tu);
        continue;
      }
      if (batch.length > 0) await runBatch(batch);
      batch = [];
      results.push(await runOne(tu, announceIt));
    }
    if (batch.length > 0) await runBatch(batch);
    return results;
  };
  // How much of `messages` the last step report covered: the seed to begin with.
  let reportedUpTo = messages.length;
  // Resume (features/run-history.md item 37): re-enter from a reclaimed run's
  // transcript. The counters and the wall-clock budget come from its last step
  // record; the calls that were in flight at the kill are settled by the plan
  // (re-run, or answered with a synthetic result) and their results appended
  // as the user turn the next model call needs. A step whose record never
  // landed (`stepRecorded: false`) is reported first, with no new turns — its
  // turns are already on the ledger.
  const resume = opts.resume;
  let iteration0 = 0;
  if (resume) {
    turn = resume.turn;
    const rerun = resume.settlements.filter((x) => x.action === "rerun").length;
    note(
      "resumed",
      `resumed after a restart: ${resume.settlements.length} call(s) were in flight — ${rerun} re-run, ${resume.settlements.length - rerun} answered with a restart note; ${Math.round(resume.remainingMs / 60_000)} min of budget left`,
    );
    iteration0 = resume.iteration;
    if (resume.settlements.length > 0) {
      if (!resume.stepRecorded && opts.onStep) {
        await opts.onStep({
          turns: [],
          firstIdx: messages.length,
          inFlight: resume.settlements.map((x) => ({ callId: x.toolUse.id, tool: x.toolUse.name })),
          turn,
          iteration: resume.iteration,
          remainingMs: deadline - now(),
        });
      }
      const settled: ContentPart[] = [];
      for (const x of resume.settlements) {
        if (x.action === "rerun") {
          settled.push(...(await dispatchToolUses([x.toolUse], { announce: false })));
        } else {
          emit({
            type: "tool_result",
            tool: x.toolUse.name,
            ok: false,
            callId: x.toolUse.id,
            summary: redactAndCap(x.text),
          });
          settled.push({ type: "tool_result", toolUseId: x.toolUse.id, content: x.text, isError: true });
        }
      }
      messages.push({ role: "user", content: settled });
      iteration0 = resume.iteration + 1;
    }
  }
  // A requested stop (soft or hard) ends the loop before the NEXT step — the
  // step already in flight completes (soft) or is abandoned (hard, via the race
  // above). Checked as a loop condition so a stop can never start a new step.
  for (
    let iteration = iteration0;
    turn < opts.agent.maxTurns && iteration < opts.agent.maxTurns * 2 && now() < deadline && !control?.requested;
    iteration++
  ) {
    const result = await complete({
      model: opts.model,
      system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens: opts.agent.maxTokens,
      effort: opts.effort ?? opts.agent.effort,
      ...(opts.agent.cacheTtl ? { cacheTtl: opts.agent.cacheTtl } : {}),
    });

    if (result.stopReason === "refusal") {
      return "The model declined this request (safety refusal). Try rephrasing, or switch models with `model:<provider>/<model>`.";
    }

    const toolUses = result.content.filter((p): p is ToolUsePart => p.type === "tool_use");

    if (toolUses.length === 0 || result.stopReason !== "tool_use") {
      const text = collectText(result.content);
      if (result.stopReason === "max_tokens") {
        return text + "\n\n_(output truncated: hit the token limit)_";
      }
      // A follow-up landed while the model wrote this answer (thread-admission
      // item 3): the answer is superseded — it becomes narration on the
      // stream, the follow-up the next user turn, and the loop goes on. The
      // follow-up prompt says so (`superseded`): the thread never saw that
      // answer, so the next one must cover the original request too, not be
      // an increment on it. Only when another step is allowed: at a budget or
      // a stop the answer stands and the follow-up stays in the inbox for the
      // dispatcher's fresh turn.
      if (pendingFollowUps() && wouldStep(turn + 1, iteration + 1)) {
        turn++;
        if (text) emit({ type: "assistant", text: redactSecrets(text) });
        messages.push({ role: "assistant", content: result.content });
        messages.push({ role: "user", content: drainFollowUps(true) });
        continue;
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
    // The step report (features/run-history.md item 35): everything appended
    // since the last report — so the seed plus every report is the exact
    // conversation — and the calls about to run, awaited before any of them
    // does. Its order against the tools is the contract a resume rests on.
    if (opts.onStep) {
      await opts.onStep({
        turns: messages.slice(reportedUpTo),
        firstIdx: reportedUpTo,
        inFlight: toolUses.map((tu) => ({ callId: tu.id, tool: tu.name })),
        turn,
        iteration,
        remainingMs: deadline - now(),
      });
      reportedUpTo = messages.length;
    }
    const results = await dispatchToolUses(toolUses);
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
    // Pending follow-ups ride on this turn — after the results, before the
    // step that reads them — but only if that step will happen: a loop about to
    // end (budget, stop, dead sandbox) leaves them unconsumed for a fresh turn
    // rather than burying them in a write-up that can no longer act.
    const dead = execTracker.consecutiveInfraFailures >= MAX_CONSECUTIVE_INFRA_FAILURES;
    if (pendingFollowUps() && !dead && wouldStep(turn, iteration + 1)) results.push(...drainFollowUps());
    messages.push({ role: "user", content: results });

    // Results are appended (every tool_use has its tool_result, so the finale
    // call stays valid) — now check exec health and bail out of a dead sandbox
    // before issuing another command into it.
    if (dead) {
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
        ...(opts.agent.cacheTtl ? { cacheTtl: opts.agent.cacheTtl } : {}),
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

type ToolUsePart = Extract<ContentPart, { type: "tool_use" }>;

function describeToolCall(tu: ToolUsePart): string {
  const input = tu.input as Record<string, unknown> | undefined;
  if (tu.name === "bash" && input?.command) {
    // Full command — redaction + capping happens at the call site (redactAndCap),
    // so we never truncate before redacting.
    return `$ ${String(input.command)}`;
  }
  // The call's target, when the input names one: a path, a skill name, a URL…
  // — so `use_skill code-review-and-quality` reads as what it is, not just the
  // tool name. First short string field among the conventional keys wins.
  for (const key of ["path", "name", "url", "query"]) {
    const v = input?.[key];
    if (typeof v === "string" && v.trim() && v.length <= 200) return `${tu.name} ${v.trim()}`;
  }
  return tu.name;
}

/** The `stopReason` attr domain (attrs.ts) folds the provider's `refusal` into `other`. */
function turnStopReason(r: CompletionResult["stopReason"]): "end_turn" | "tool_use" | "max_tokens" | "other" {
  return r === "end_turn" || r === "tool_use" || r === "max_tokens" ? r : "other";
}

/** Stamp the tool call's span on what the tool itself publishes (a skill load,
 *  a legacy MCP fact); events with no `spanId` field pass through. */
function withSpanId(e: RunEvent, spanId: string): RunEvent {
  switch (e.type) {
    case "tool_call":
    case "tool_result":
    case "run_note":
    case "assistant":
    case "skill_use":
    case "mcp_tool_use":
      return { ...e, spanId };
    default:
      return e;
  }
}
