// The pi harness (docs/reference/specs/harness-pi.md): what drives a run whose
// preset is on pi, in place of `runAgent`. It writes pi's files into the run's
// container, starts pi detached with the run bearer as its only key on a
// session holding the thread's earlier turns, sends the request as the prompt
// (the seed rule, item 9), and then does what the native loop does
// around a model that pi now drives: it counts turns for the guard, warns at
// the wrap-up, forces the write-up at the deadline or the guard with every
// tool refused, honours a soft stop with a write-up and a hard stop with an
// abort, folds the thread's follow-ups in as steers, mirrors the transcript
// onto the ledger, and answers with the same words the loop would. A run that
// comes back after a bot restart re-attaches to its pi where it still runs,
// or restarts pi on a session rebuilt from the mirrored transcript.

import type { AgentDef } from "../../../agents/registry.js";
import type { Effort } from "../../../effort.js";
import type { ChatMessage, ProviderConfig } from "../../../providers/types.js";
import {
  HARD_STOP_MESSAGE,
  SOFT_STOP_INSTRUCTION,
  hardStopNote,
  softStopAnswer,
  softStopNote,
  timeBudgetAnswer,
  timeBudgetInstruction,
  timeBudgetNote,
  turnGuardAnswer,
  turnGuardInstruction,
  turnGuardNote,
  turnGuardPace,
  wrapUpInstruction,
  wrapUpNote,
  type StepReport,
} from "../../../runner.js";
import type { RunnableTool, ToolContext } from "../../../tools/workspace.js";
import type { RunBearerStore } from "../../modelProxy/runBearers.js";
import { redactAndCap, redactSecrets, type RunEvent, type RunNoteKind, type StopMode } from "../../runEvents.js";
import type { Settlement } from "../../runLedger/resume.js";
import type { AssembledCompaction } from "../../runLedger/transcript.js";
import type { RunControl } from "../../runRegistry/runControl.js";
import { followUpPrompt, followUpSnippet, type FollowUpInbox, type FollowUpInput } from "../../threadAdmission.js";
import type { Backend } from "../../trace/attrs.js";
import type { Clock, Span } from "../../trace/types.js";
import { PiBridge } from "./bridge.js";
import type { PiContainer } from "./container.js";
import { PiMirror, piSessionFile } from "./mirror.js";
import { piLaunchArgs, piLaunchEnv, piLaunchFiles, piRunPaths, type PiLaunchSpec } from "./process.js";
import { parsePiLine } from "./protocol.js";
import type { HarnessRegistry, LiveHarness } from "./relay.js";
import type { ToolRuleContext } from "./toolRules.js";
import { PiRpcTransport } from "./transport.js";

/** What a run's row remembers about its pi, so the next bot generation finds it (harness-pi item 8). */
export interface PiHarnessFacts {
  pid: number;
  /** The log byte the next read starts at. */
  logOffset: number;
  /** pi's session file, once `get_state` named it. */
  sessionFile?: string;
}

export interface PiHarnessResume {
  /** The transcript the ledger held, as `planResume` assembled it. */
  messages: ChatMessage[];
  /** pi's compaction entries among those messages (session-log item 6), rendered
   *  where they sat so the restarted pi's window is what pi had, not the raw
   *  turns compacted again. Absent on a plan from before the log kept them. */
  compactions?: AssembledCompaction[];
  /** The calls in flight at the kill; under pi none is re-run — its effects are the container's. */
  settlements: Settlement[];
  remainingMs: number;
  turn: number;
  inboxConsumedSeq: number;
  /** The row's harness facts, when the previous generation wrote them. */
  facts?: PiHarnessFacts;
}

export interface PiHarnessRun {
  runId: string;
  /** The preset with its effective budget (`budgetedAgent`). */
  agent: AgentDef;
  effort?: Effort;
  model: { id: string; provider: string; providerType: ProviderConfig["type"] };
  system: string;
  /** The seed conversation as the dispatcher composed it — the thread's earlier
   *  turns, then the request as the last user turn. The earlier turns become
   *  pi's session, the request its prompt (`splitSeed`). */
  messages: ChatMessage[];
  /** The tools pi relays to the bot — the preset's toolset less the workspace tools pi has of its own. */
  tools: RunnableTool[];
  toolContext: ToolContext;
  /** The thread's facts the gate judges pi's own tools by: the checkout, the
   *  run's branch, the protected ones. The identity is the preset's
   *  (`agent.identity`) and is folded in here, so the allowlist pi starts
   *  with and the reach the gate judges by read one word (harness-pi item 10). */
  rules: Omit<ToolRuleContext, "identity">;
  /** The OS user the run's executor runs its commands as: the resident's pool
   *  user for the thread (`ResidentBinding.user`). The run's files live under
   *  a root of that user's own (`piRunPaths`); absent on an executor with one
   *  user, and the files go under the shared root. */
  user?: string;
  backend?: Backend;
  span?: Span;
  control?: RunControl;
  inbox?: FollowUpInbox;
  onEvent?: (event: RunEvent) => void;
  onProgress?: (note: string) => void;
  onStep?: (report: StepReport) => Promise<void>;
  /** The row's write for the harness facts (`ledgerRun.setState({ harness })`). */
  saveFacts?: (facts: PiHarnessFacts) => void;
  resume?: PiHarnessResume;
}

export interface PiHarnessDeps {
  container: PiContainer;
  /** The run's bearer, revealed once into pi's environment. */
  bearer: string;
  /** The bot's base URL as the container reaches it. */
  harnessUrl: string;
  registry: HarnessRegistry;
  bearers?: RunBearerStore;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How often the loop wakes without an event to check budgets, stops and the inbox. */
  tickMs?: number;
  /** How long a write-up may take before pi is aborted (the native finale's bound). */
  finaleTimeoutMs?: number;
}

/** The workspace tools pi has of its own; the native names are not relayed. */
export const NATIVE_WORKSPACE_TOOLS: ReadonlySet<string> = new Set(["bash", "read_file", "write_file"]);

/** The tools a preset relays to the bot under pi: its toolset without the workspace tools. */
export function relayedTools(tools: readonly RunnableTool[]): RunnableTool[] {
  return tools.filter((t) => !NATIVE_WORKSPACE_TOOLS.has(t.name));
}

const FINALE_TIMEOUT_MS = 3 * 60_000;
const CONTINUE_PROMPT =
  "Continue where you left off: the bot restarted mid-run, so re-check the effects of your last command before relying on them.";

type WriteUp = { kind: "time" } | { kind: "turns"; pace: string } | { kind: "soft" };

class PromptRefused extends Error {
  constructor(reason: string) {
    super(`pi refused the prompt: ${reason}`);
    this.name = "PromptRefused";
  }
}

/** A tool call pi ran to its end without the extension ever asking the gate
 *  for it (harness-pi item 7): the run fails closed on the first one. */
class GateBypassed extends Error {
  constructor(tool: string, callId: string) {
    super(`the gate was bypassed: pi ran ${tool} (call ${callId}) without asking the bot`);
    this.name = "GateBypassed";
  }
}

/** The seed rule (harness-pi item 9). The dispatcher's seed is the thread so
 *  far with the request as its last user turn (`buildMessages` merges the
 *  alternation, so nothing follows it): the last user turn is the prompt pi is
 *  sent and every turn before it is the session pi starts on. A seed of one
 *  turn has no session; an empty seed has neither. */
export function splitSeed(seed: readonly ChatMessage[]): { session: ChatMessage[]; prompt?: ChatMessage } {
  for (let i = seed.length - 1; i >= 0; i--) {
    if (seed[i].role === "user") return { session: seed.slice(0, i), prompt: seed[i] };
  }
  return { session: [] };
}

/** The request — the seed's last user turn — as pi's `prompt`: its text parts
 *  joined, its images as pi's image blocks; a document is named in the text —
 *  pi's prompt carries none. */
export function promptOf(seed: readonly ChatMessage[]): {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
} {
  const { prompt } = splitSeed(seed);
  if (!prompt) return { message: "" };
  const texts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const part of prompt.content) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "image") images.push({ type: "image", data: part.data, mimeType: part.mediaType });
    else if (part.type === "document")
      texts.push(
        `[An attached document, ${part.name ?? "document"} (${part.mediaType}), could not be handed to this harness.]`,
      );
  }
  return { message: texts.join("\n\n"), ...(images.length > 0 ? { images } : {}) };
}

/** The settlement's text for a call in flight at the kill: pi ran the tool in
 *  the container and its result died with the bot's view of it, so every one
 *  reads as the ledger's restart result — never re-run from here. */
export function settlementResults(settlements: Settlement[]): ChatMessage | undefined {
  if (settlements.length === 0) return undefined;
  return {
    role: "user",
    content: settlements.map((s) => ({
      type: "tool_result" as const,
      toolUseId: s.toolUse.id,
      content:
        s.action === "synthetic"
          ? s.text
          : `The bot restarted while this ${s.toolUse.name} call was in flight; its result was lost — re-check its effects before re-running it.`,
      isError: true as const,
    })),
  };
}

export async function runPiHarness(deps: PiHarnessDeps, run: PiHarnessRun): Promise<string> {
  const { container, clock } = deps;
  const now = () => clock();
  const agentSpan = run.span?.start("run.agent");
  if (agentSpan) deps.bearers?.reparent(run.runId, agentSpan);
  const emit = (event: RunEvent) => run.onEvent?.(event.at === undefined ? { ...event, at: now() } : event);
  const note = (kind: RunNoteKind, summary: string, mode?: StopMode) => {
    run.onProgress?.(summary);
    emit({ type: "run_note", kind, summary, ...(mode ? { mode } : {}) });
  };
  const bridge = new PiBridge({ emit, onProgress: run.onProgress, agentSpan, clock });
  const paths = piRunPaths(run.runId, run.user);
  const remainingMs = run.resume?.remainingMs ?? run.agent.maxMinutes * 60_000;
  const deadline = now() + remainingMs;
  const warnAt = deadline - Math.min(3 * 60_000, run.agent.maxMinutes * 15_000);
  run.toolContext.remainingMs = () => deadline - now();
  bridge.turns = run.resume?.turn ?? 0;
  const mirror = new PiMirror({
    onStep: run.onStep,
    seedLength: run.resume?.messages.length ?? run.messages.length,
    remainingMs: () => deadline - now(),
  });
  mirror.inboxConsumedSeq = run.resume?.inboxConsumedSeq ?? 0;

  let writeUp: WriteUp | undefined;
  let writeUpAt: number | undefined;
  let hardStopped = false;
  let bypass: GateBypassed | undefined;
  const toolsBlocked = (): string | undefined => {
    if (!writeUp) return undefined;
    if (writeUp.kind === "time")
      return "the run has reached its time budget: no more tool calls — write your final answer now";
    if (writeUp.kind === "turns")
      return "the run has hit its turn guard: no more tool calls — write your final answer now";
    return "an operator asked this run to stop: no more tool calls — write your final answer now";
  };
  const rules: ToolRuleContext = { ...run.rules, identity: run.agent.identity };
  const live: LiveHarness = {
    runId: run.runId,
    tools: run.tools,
    toolContext: run.toolContext,
    ...(run.backend ? { backend: run.backend } : {}),
    rules,
    emit,
    toolSpan: (callId) => bridge.openSpan(callId),
    gateSaw: (callId) => bridge.gateSaw(callId),
    toolsBlocked,
  };
  const forget = deps.registry.register(live);

  const spec: PiLaunchSpec = {
    runId: run.runId,
    paths,
    model: { id: run.model.id, providerType: run.model.providerType, maxTokens: run.agent.maxTokens },
    harnessUrl: deps.harnessUrl,
    ...(run.effort ? { effort: run.effort } : {}),
    identity: run.agent.identity,
    system: run.system,
    relayTools: run.tools.map((t) => t.name),
  };

  let pid: number | undefined;
  let transport: PiRpcTransport | undefined;
  let facts: PiHarnessFacts | undefined;
  const save = () => {
    if (facts) {
      if (transport) facts = { ...facts, logOffset: transport.offset };
      run.saveFacts?.(facts);
    }
  };
  /** Catching up on a re-attach: what the log holds before our own prompt is
   *  answered happened while the bot was away — a failed model call and pi's
   *  settling on it belong to the death, not to this generation's run. */
  let catchingUp = false;

  try {
    const reattached = run.resume?.facts !== undefined && (await container.alive(run.resume.facts.pid));
    if (reattached && run.resume?.facts) {
      // The container's pi outlived the bot: read from where the last generation stopped.
      pid = run.resume.facts.pid;
      facts = { ...run.resume.facts };
      transport = new PiRpcTransport({
        container,
        paths,
        pid,
        pollMs: deps.pollMs ?? 750,
        sleep: deps.sleep,
        offset: run.resume.facts.logOffset,
      });
      catchingUp = true;
      note(
        "resumed",
        `resumed after a restart: pi still runs in the container (pid ${pid}); continuing its session with ${Math.round(remainingMs / 60_000)} min of budget left`,
      );
    } else {
      // What pi starts on. After a restart where pi died with its container
      // (or its facts never landed): a session rebuilt from the mirrored
      // transcript. A fresh run: the seed rule — the thread's earlier turns
      // as a session written the same way, and no session at all for a seed
      // of one turn, which starts on the bare session directory.
      let session:
        { stem: "resumed" | "seed"; messages: ChatMessage[]; compactions: readonly AssembledCompaction[] } | undefined;
      if (run.resume) {
        const settled = settlementResults(run.resume.settlements);
        // The settlement turn follows every message, so the compaction positions hold.
        session = {
          stem: "resumed",
          messages: settled ? [...run.resume.messages, settled] : run.resume.messages,
          compactions: run.resume.compactions ?? [],
        };
      } else {
        const earlier = splitSeed(run.messages).session;
        if (earlier.length > 0) session = { stem: "seed", messages: earlier, compactions: [] };
      }
      let sessionPath: string | undefined;
      if (session) {
        sessionPath = `${paths.sessionDir}/${session.stem}-${now()}.jsonl`;
        await container.writeFile(
          sessionPath,
          piSessionFile(
            session.messages,
            {
              cwd: run.rules.checkout,
              model: {
                provider: run.model.provider,
                id: run.model.id,
                api: run.model.providerType === "anthropic" ? "anthropic-messages" : "openai-completions",
              },
              at: now(),
            },
            session.compactions,
          ),
        );
      }
      if (run.resume) {
        const lost = run.resume.settlements.length;
        note(
          "resumed",
          `resumed after a restart: pi restarted on the mirrored transcript — ${lost} call(s) were in flight, each answered with a restart note; ${Math.round(remainingMs / 60_000)} min of budget left`,
        );
      }
      const launch = sessionPath ? { ...spec, sessionPath } : spec;
      for (const file of piLaunchFiles(launch)) await container.writeFile(file.path, file.content);
      ({ pid } = await container.start({ paths, args: piLaunchArgs(launch), env: piLaunchEnv(launch, deps.bearer) }));
      facts = { pid, logOffset: 0 };
      save();
      transport = new PiRpcTransport({ container, paths, pid, pollMs: deps.pollMs ?? 750, sleep: deps.sleep });
    }

    transport.send({ id: "retry", type: "set_auto_retry", enabled: false });
    transport.send({ id: "state", type: "get_state" });
    if (reattached || run.resume) transport.send({ id: "prompt", type: "prompt", message: CONTINUE_PROMPT });
    else transport.send({ id: "prompt", type: "prompt", ...promptOf(run.messages) });

    let warned = false;
    let settled = false;
    let stopMode: StopMode | undefined;
    const startWriteUp = (kind: WriteUp, instruction: string) => {
      writeUp = kind;
      writeUpAt = now();
      transport!.send({ type: "steer", message: instruction });
    };
    const drainFollowUps = () => {
      const inputs: FollowUpInput[] = run.inbox?.drain() ?? [];
      if (inputs.length === 0) return;
      for (const input of inputs) {
        if (input.ledgerSeq !== undefined && input.ledgerSeq > mirror.inboxConsumedSeq)
          mirror.inboxConsumedSeq = input.ledgerSeq;
        const source = {
          ...(input.sourceUrl ? { url: input.sourceUrl } : {}),
          ...(input.userName ? { user: input.userName } : {}),
          ...(input.from ? { run: input.from.runId } : {}),
        };
        emit({ type: "input", text: redactSecrets(input.text), ...(Object.keys(source).length > 0 ? { source } : {}) });
        note("follow_up", `follow-up folded in: ${redactSecrets(followUpSnippet(input))}`);
      }
      const images = inputs.flatMap((i) =>
        (i.images ?? []).map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mediaType })),
      );
      transport!.send({ type: "steer", message: followUpPrompt(inputs), ...(images.length > 0 ? { images } : {}) });
    };
    /** The budgets, the stops and the inbox — on every event and every tick. */
    const check = () => {
      const requested = run.control?.requested;
      if (requested === "hard") {
        if (!hardStopped) {
          hardStopped = true;
          transport!.send({ type: "abort" });
        }
        return;
      }
      if (writeUp) {
        if (writeUpAt !== undefined && now() - writeUpAt >= (deps.finaleTimeoutMs ?? FINALE_TIMEOUT_MS)) {
          // The write-up itself is bounded, like the native finale: past it the run closes without one.
          writeUpAt = undefined;
          run.onProgress?.("finale timed out — closing the run without a write-up");
          transport!.send({ type: "abort" });
        }
        return;
      }
      if (requested === "soft") {
        stopMode = "soft";
        note("stopped", softStopNote(), "soft");
        startWriteUp({ kind: "soft" }, SOFT_STOP_INSTRUCTION);
        return;
      }
      if (now() >= deadline) {
        note("time_budget_exhausted", timeBudgetNote());
        startWriteUp({ kind: "time" }, timeBudgetInstruction());
        return;
      }
      if (bridge.turns >= run.agent.maxTurns) {
        const pace = turnGuardPace(bridge.turns, run.agent.maxMinutes * 60_000 - (deadline - now()));
        note("turn_budget_exhausted", turnGuardNote(pace));
        startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
        return;
      }
      if (!warned && now() >= warnAt) {
        warned = true;
        const minutesLeft = Math.max(1, Math.round((deadline - now()) / 60_000));
        note("wrap_up", wrapUpNote(minutesLeft));
        transport!.send({ type: "steer", message: wrapUpInstruction(minutesLeft) });
      }
      drainFollowUps();
    };

    const iterator = transport.lines[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<string>> | undefined;
    let providerError: string | undefined;
    check();
    for (;;) {
      pending ??= iterator.next();
      const tick = deps.sleep(deps.tickMs ?? 1000).then(() => "tick" as const);
      const next = await Promise.race([pending, tick]);
      if (next === "tick") {
        check();
        if (hardStopped) break;
        continue;
      }
      pending = undefined;
      if (next.done) break;
      const event = parsePiLine(next.value);
      if (!event) continue;
      // A call that starts while catching up was vetted by the generation that died.
      bridge.judgeGate = !catchingUp;
      const obs = bridge.observe(event);
      for (const reply of obs.replies) transport.send(reply);
      if (obs.gateBypassed) {
        // Fail closed: a tool ran that the gate never saw. Stop pi now; the
        // run fails naming the call once the loop is left.
        bypass = new GateBypassed(obs.gateBypassed.tool, obs.gateBypassed.callId);
        note("harness_error", `${bypass.message} — the run is stopped`);
        transport.send({ type: "abort" });
        break;
      }
      if (obs.response) {
        const r = obs.response;
        if (
          r.id === "state" &&
          r.success === true &&
          typeof (r.data as Record<string, unknown> | undefined)?.sessionFile === "string"
        ) {
          const data = r.data as Record<string, unknown>;
          facts = { ...(facts ?? { pid: pid!, logOffset: 0 }), sessionFile: String(data.sessionFile) };
          save();
        }
        if (r.id === "prompt") {
          catchingUp = false;
          if (r.success === false) throw new PromptRefused(String(r.error ?? "no reason"));
        }
      }
      if (obs.message) await mirror.onMessage(obs.message, bridge.turns);
      if (obs.compaction) await mirror.onCompaction(obs.compaction, bridge.turns);
      if (obs.providerError !== undefined) {
        if (catchingUp)
          note("harness_error", `a model call failed while the bot was away (${obs.providerError}); continuing`);
        else providerError = obs.providerError;
      }
      if (obs.turnEnded) save();
      if (obs.settled && !catchingUp) {
        settled = true;
        break;
      }
      check();
      if (hardStopped) break;
    }

    if (hardStopped) {
      note("stopped", hardStopNote(), "hard");
      return HARD_STOP_MESSAGE;
    }
    if (bypass) throw bypass;
    if (!settled) {
      const tail = await container.tail(paths.errLog, 2000);
      throw new Error(`pi exited before the run settled${tail.trim() ? `: ${redactAndCap(tail.trim(), 400)}` : ""}`);
    }
    if (providerError !== undefined) throw new Error(`the model call failed: ${providerError}`);
    const text = bridge.answer() ?? "";
    if (writeUp?.kind === "time") return timeBudgetAnswer(text, run.agent.maxMinutes);
    if (writeUp?.kind === "turns") return turnGuardAnswer(text, writeUp.pace);
    if (writeUp?.kind === "soft" || stopMode === "soft") return softStopAnswer(text);
    return text || "_(no response)_";
  } finally {
    transport?.close();
    bridge.closeOpenSpans(
      hardStopped
        ? "the run was hard-stopped"
        : bypass
          ? "the run was stopped: a tool call bypassed the gate"
          : "the run ended",
    );
    save();
    forget();
    if (pid !== undefined) await container.kill(pid).catch(() => {});
    agentSpan?.end(hardStopped || bypass ? "error" : "ok");
  }
}
