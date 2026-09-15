// A pi driven by a scripted `Provider` (the tests' model double), behind the
// `FakePiContainer`. Where a real pi calls the model through the proxy and runs
// its tools in the container, this one asks the test's provider for each turn
// and does what pi would with the answer — the prompt echoed, the assistant
// message and its tool calls announced record by record, every tool call put
// to the bot's gate first (`authorizeToolCall`, as the extension's hook does),
// a relayed tool run through the relay (`relayToolCall`, as `POST /harness/tool`
// does), pi's own workspace tools run over the run's executor, the results fed
// back, and the turn settled — so a test that scripts a model and reads the
// run's events, record, ledger rows or replies exercises the real bridge,
// mirror, relay and gate with nothing of pi's process. The native loop used to
// be what a scripted provider drove end to end; since record 0032's series
// deleted it, this is how a test drives a run from a model script.
//
// What it is honest about: the RPC commands the harness sends (`prompt`,
// `steer`, `abort`, `get_state`, `set_auto_retry`), pi's refusal of a plain
// prompt while busy, the seed session read back from the file the harness
// wrote, a steer delivered at the next turn boundary, the turn guard metered
// through the run's bearer store when one is given (the proxy's meter). What
// it does not do: compaction, thinking, `model.turn` spans (the proxy's, not
// pi's), and pi's own output shaping beyond the executors' `exit N:` prefix.

import type { CompletionRequest, CompletionResult, Provider, ToolDef } from "../../../provider.js";
import type { ChatMessage, ContentPart } from "../../../chatMessage.js";
import type { RunBearerStore } from "../../../modelProxy/runBearers.js";
import type { Executor } from "../../../../execution/executor.js";
import { TracingExecutor } from "../../../../execution/tracingExecutor.js";
import { isEffort, type Effort } from "../../../../effort.js";
import { chatMessageOf } from "../mirror.js";
import { PI_BUILTIN_TOOLS } from "../process.js";
import {
  authorizeToolCall,
  relayToolCall,
  relayedToolDefinitions,
  type HarnessRegistry,
  type LiveHarness,
  type PiContent,
  type RelayedToolAnswer,
  type ToolCallAsk,
} from "../relay.js";
import type { FakePiContainer } from "./fakeContainer.js";

export const PI_BUSY_REFUSAL =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

export interface ProviderPiOptions {
  /** The model: asked once per turn with the conversation so far. */
  provider: Provider;
  /** Where the run is registered while pi runs: the gate, the relayed tools, the run's executor. */
  registry: HarnessRegistry;
  /** The proxy's meter, when the test wants the turn guard counted as the proxy counts it. */
  bearers?: RunBearerStore;
  /** The output cap a request carries when the bearer store names none. */
  maxTokens?: number;
  /** Awaited before every model call: a real pi's call takes seconds, during
   *  which the harness ticks — drains the inbox, steers, checks the budgets.
   *  A test gives the harness that room here (a few real milliseconds). */
  beforeModelCall?: () => Promise<void>;
}

export interface ProviderPi {
  /** Every request the provider was asked, in order. */
  readonly requests: CompletionRequest[];
  /** The steers pi was sent, in order. */
  readonly steers: string[];
}

/** pi's own workspace tools as their definitions (pi 0.85.1's names; the schemas
 *  are the fields this double reads). Which of them a run holds is `--tools`. */
export const PI_BUILTIN_TOOL_DEFS: readonly ToolDef[] = [
  { name: "read", description: "Read a file from the workspace.", inputSchema: schema({ path: "string" }, ["path"]) },
  {
    name: "bash",
    description: "Run a bash command in the workspace.",
    inputSchema: schema({ command: "string", timeout: "integer" }, ["command"]),
  },
  {
    name: "edit",
    description: "Replace text in a file.",
    inputSchema: schema({ path: "string", oldText: "string", newText: "string" }, ["path", "oldText", "newText"]),
  },
  {
    name: "write",
    description: "Write a whole file.",
    inputSchema: schema({ path: "string", content: "string" }, ["path", "content"]),
  },
  {
    name: "grep",
    description: "Search file contents.",
    inputSchema: schema({ pattern: "string", path: "string" }, ["pattern"]),
  },
  {
    name: "find",
    description: "Find files by glob.",
    inputSchema: schema({ pattern: "string", path: "string" }, ["pattern"]),
  },
  { name: "ls", description: "List a directory.", inputSchema: schema({ path: "string" }, []) },
];

function schema(props: Record<string, string>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])),
    required,
  };
}

interface Session {
  runId: string;
  model: string;
  /** The effort tier pi was started with, read back off the model's thinking suffix (`<id>:<level>`). */
  effort: Effort | undefined;
  system: string | undefined;
  builtins: string[];
  sessionFile: string;
  messages: ChatMessage[];
}

/**
 * Script the container's pi from the provider: from here on every command the
 * harness writes to pi's stdin is answered as pi would answer it, and each turn
 * of a prompt is one `provider.complete`.
 */
export function scriptPiFromProvider(container: FakePiContainer, opts: ProviderPiOptions): ProviderPi {
  const requests: CompletionRequest[] = [];
  const steers: string[] = [];
  let session: Session | undefined;
  let busy = false;
  let aborted: AbortController | undefined;
  let settled = false;
  const queued: string[] = [];

  const respond = (cmd: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    container.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, ...extra });

  container.onStdin = (line) => {
    const cmd = JSON.parse(line) as Record<string, unknown>;
    if (cmd.type === "set_auto_retry" || cmd.type === "set_thinking_level") {
      respond(cmd);
      return;
    }
    if (cmd.type === "get_state") {
      const s = current();
      respond(cmd, { data: { sessionFile: s.sessionFile, sessionId: "sid", isStreaming: busy } });
      return;
    }
    if (cmd.type === "steer" || cmd.type === "follow_up") {
      const text = String(cmd.message ?? "");
      steers.push(text);
      container.emit({ type: "response", command: cmd.type, success: true });
      // pi queues a steer for the next turn boundary while its loop runs; to an
      // idle agent the message is the prompt of a new turn.
      if (busy) queued.push(text);
      else void run(text, []);
      return;
    }
    if (cmd.type === "abort") {
      container.emit({ type: "response", command: "abort", success: true });
      aborted?.abort();
      if (!settled) {
        settled = true;
        container.emit({ type: "agent_settled" });
      }
      busy = false;
      return;
    }
    if (cmd.type !== "prompt") return;
    const text = String(cmd.message ?? "");
    if (busy) {
      if (cmd.streamingBehavior === undefined) {
        container.emit({ id: cmd.id, type: "response", command: "prompt", success: false, error: PI_BUSY_REFUSAL });
        return;
      }
      steers.push(text);
      queued.push(text);
      respond(cmd);
      return;
    }
    respond(cmd);
    const images = Array.isArray(cmd.images) ? (cmd.images as Array<Record<string, unknown>>) : [];
    void run(text, images);
  };

  /** The session pi started on: read once from the last start's arguments and files. */
  function current(): Session {
    if (session) return session;
    const start = container.starts.at(-1);
    if (!start) throw new Error("providerPi: a command arrived before pi was started");
    const arg = (flag: string) => {
      const i = start.args.indexOf(flag);
      return i >= 0 ? start.args[i + 1] : undefined;
    };
    const modelArg = arg("--model") ?? "model";
    const thinking = modelArg.split(":")[1];
    const tools = (arg("--tools") ?? "").split(",").filter((t) => t.length > 0);
    const sessionPath = arg("--session");
    const messages: ChatMessage[] = [];
    if (sessionPath) {
      const file = container.files.get(sessionPath) ?? "";
      for (const raw of file.split("\n")) {
        if (!raw.trim()) continue;
        const entry = JSON.parse(raw) as Record<string, unknown>;
        if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
        const turn = chatMessageOf(entry.message as Record<string, unknown>);
        if (turn) appendMerged(messages, turn);
      }
    }
    session = {
      runId: start.env.SWITCHBOARD_RUN_ID ?? "run",
      model: modelArg.split(":")[0],
      effort: isEffort(thinking) ? thinking : undefined,
      system: container.files.get(`${start.paths.agentDir}/SYSTEM.md`),
      builtins: tools.filter((t) => (PI_BUILTIN_TOOLS as readonly string[]).includes(t)),
      sessionFile: sessionPath ?? `${start.paths.sessionDir}/session.jsonl`,
      messages,
    };
    return session;
  }

  async function run(prompt: string, images: Array<Record<string, unknown>>): Promise<void> {
    const s = current();
    busy = true;
    settled = false;
    aborted = new AbortController();
    const signal = aborted.signal;
    container.emit({ type: "agent_start" });
    const userParts: ContentPart[] = [
      ...images.map((img) => ({
        type: "image" as const,
        mediaType: String(img.mimeType ?? "image/png"),
        data: String(img.data ?? ""),
      })),
      { type: "text", text: prompt },
    ];
    const echo = {
      role: "user",
      content: userParts.map((p) =>
        p.type === "image" ? { type: "image", data: p.data, mimeType: p.mediaType } : { type: "text", text: prompt },
      ),
    };
    container.emit({ type: "message_start", message: echo }, { type: "message_end", message: echo });
    appendMerged(s.messages, { role: "user", content: userParts });
    const live = () => opts.registry.get(s.runId);
    for (;;) {
      if (signal.aborted) return;
      // A steer waits for the turn boundary, then is the next user text pi reads.
      while (queued.length > 0) {
        const text = queued.shift()!;
        const msg = { role: "user", content: [{ type: "text", text }] };
        container.emit({ type: "message_start", message: msg }, { type: "message_end", message: msg });
        appendMerged(s.messages, { role: "user", content: [{ type: "text", text }] });
      }
      const entry = live();
      const tools: ToolDef[] = [
        ...PI_BUILTIN_TOOL_DEFS.filter((t) => s.builtins.includes(t.name)),
        ...(entry ? relayedToolDefinitions(entry) : []),
      ];
      const grant = opts.bearers?.grantOf(s.runId);
      const request: CompletionRequest = {
        model: s.model,
        ...(s.system !== undefined ? { system: s.system } : {}),
        ...(s.effort !== undefined ? { effort: s.effort } : {}),
        messages: s.messages.map((m) => ({ role: m.role, content: [...m.content] })),
        tools,
        maxTokens: grant?.maxTokens ?? opts.maxTokens ?? 4096,
        signal,
      };
      requests.push(request);
      container.emit({ type: "turn_start" });
      await opts.beforeModelCall?.();
      if (signal.aborted) return;
      const turn = opts.bearers ? opts.bearers.consumeTurn(s.runId) : { ok: true as const, turn: requests.length };
      let result: CompletionResult;
      try {
        if (!turn.ok)
          throw new Error(
            turn.reason === "budget"
              ? `403 turn_budget_exhausted: the run is past its ${turn.maxTurns}-turn guard (${turn.turns} turns used)`
              : "403 revoked: the run ended and its bearer with it",
          );
        // The proxy's meter opens one `model.turn` under the run's re-parented span
        // per proxied call (model-proxy item 6); this double does the same.
        const meter = opts.bearers?.spanOf(s.runId);
        result = meter
          ? await meter.span("model.turn", () => opts.provider.complete(request), { attrs: { model: s.model } })
          : await opts.provider.complete(request);
      } catch (err) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: message, model: s.model };
        container.emit(
          { type: "message_start", message: { ...failed, stopReason: "pending" } },
          { type: "message_end", message: failed },
          { type: "turn_end", message: failed, toolResults: [] },
          { type: "agent_end", messages: [], willRetry: false },
        );
        finish();
        return;
      }
      if (signal.aborted) return;
      const calls = result.content.filter(
        (p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use",
      );
      const assistant = {
        role: "assistant",
        content: result.content.flatMap((p): Record<string, unknown>[] =>
          p.type === "text"
            ? [{ type: "text", text: p.text }]
            : p.type === "tool_use"
              ? [{ type: "toolCall", id: p.id, name: p.name, arguments: isRecord(p.input) ? p.input : {} }]
              : p.type === "thinking"
                ? [{ type: "thinking", thinking: p.thinking }]
                : [],
        ),
        stopReason: calls.length > 0 ? "toolUse" : result.stopReason === "max_tokens" ? "length" : "stop",
        model: s.model,
      };
      container.emit(
        { type: "message_start", message: { ...assistant, content: [], stopReason: "pending" } },
        { type: "message_end", message: assistant },
      );
      appendMerged(s.messages, { role: "assistant", content: [...result.content] });
      for (const call of calls) {
        if (signal.aborted) return;
        const ask: ToolCallAsk = { toolCallId: call.id, tool: call.name, input: call.input };
        container.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.input });
        // The harness reads pi's log on its own cadence; wait for it to have seen
        // the call — and so the assistant turn before it, which the mirror wrote
        // as this step's record — before the call runs, so a test reads the
        // ledger in the order a real run's tools land in.
        await (entry ?? live())?.callSeen?.(call.id);
        const answer = await runCall(s, entry ?? live(), ask, signal);
        if (signal.aborted) return;
        const toolResult = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: answer.content,
          isError: answer.isError,
        };
        container.emit(
          {
            type: "tool_execution_end",
            toolCallId: call.id,
            toolName: call.name,
            result: { content: answer.content },
            isError: answer.isError,
          },
          { type: "message_end", message: toolResult },
        );
        // …and for the harness to have read the end, so the next model turn's
        // span follows the result on the stream as it does on a real run's.
        await (entry ?? live())?.callEnded?.(call.id);
        const asTurn = chatMessageOf(toolResult);
        if (asTurn) appendMerged(s.messages, asTurn);
      }
      container.emit({ type: "turn_end", message: assistant, toolResults: [] });
      // A text-only turn ends the loop — unless a steer arrived meanwhile: pi
      // then continues with the steer as the next user turn, so a follow-up that
      // lands while the model writes its final answer supersedes it.
      if (calls.length === 0 && queued.length === 0) {
        container.emit({ type: "agent_end", messages: [], willRetry: false });
        finish();
        return;
      }
    }
  }

  function finish(): void {
    busy = false;
    if (settled) return;
    settled = true;
    container.emit({ type: "agent_settled" });
  }

  /** One tool call as pi would run it: the gate first, then the relay or pi's own tool over the run's executor. */
  async function runCall(
    s: Session,
    entry: LiveHarness | undefined,
    ask: ToolCallAsk,
    signal: AbortSignal,
  ): Promise<RelayedToolAnswer> {
    if (!entry) return { content: text(`the run ${s.runId} is not registered on the harness`), isError: true };
    const verdict = authorizeToolCall(entry, ask);
    if (!verdict.allow) return { content: text(verdict.reason), isError: true };
    if (s.builtins.includes(ask.tool)) {
      // pi's own tool runs in the container. This double runs it over the run's
      // executor under the bridge's `tool.<name>` span, as the relay runs a
      // relayed tool, so the time it takes lands in the tool's span on the
      // stream — never a gap — while the stream itself carries no exec span
      // for a real pi's own tools.
      const span = entry.toolSpan(ask.toolCallId);
      const executor = span
        ? new TracingExecutor(entry.toolContext.executor, span, entry.backend)
        : entry.toolContext.executor;
      return runBuiltin(executor, ask, signal);
    }
    const calls = opts.registry.calls(s.runId);
    if (!calls) return { content: text(`the run ${s.runId} is not registered on the harness`), isError: true };
    let progress = await relayToolCall(entry, calls, ask, { windowMs: 50 });
    while (!progress.done) {
      if (signal.aborted) return { content: text("aborted"), isError: true };
      progress = await relayToolCall(entry, calls, ask, { windowMs: 50 });
    }
    return progress.answer;
  }
  return { requests, steers };
}

/** pi's own workspace tools, over the run's executor as pi would run them in
 *  the container: a shell command as it is (the executors' `exit N:` first
 *  line is what the bridge reads a failure from), a file read, a whole-file
 *  write, an edit as a first-occurrence replace, and the three listings as
 *  their shell commands. */
async function runBuiltin(executor: Executor, ask: ToolCallAsk, signal: AbortSignal): Promise<RelayedToolAnswer> {
  const input = isRecord(ask.input) ? ask.input : {};
  const str = (k: string) => String(input[k] ?? "");
  const exec = async (command: string) => {
    const out = await executor.exec(command, { signal });
    return { content: text(out), isError: /^exit \d+:/.test(out) };
  };
  try {
    switch (ask.tool) {
      case "bash":
        return await exec(str("command"));
      case "read":
        return { content: text(await executor.readFile(str("path"))), isError: false };
      case "write":
        return { content: text(await executor.writeFile(str("path"), str("content"))), isError: false };
      case "edit": {
        const before = await executor.readFile(str("path"));
        const at = before.indexOf(str("oldText"));
        if (at < 0) return { content: text(`oldText not found in ${str("path")}`), isError: true };
        const after = before.slice(0, at) + str("newText") + before.slice(at + str("oldText").length);
        return { content: text(await executor.writeFile(str("path"), after)), isError: false };
      }
      case "ls":
        return await exec(`ls -la ${shellQuote(str("path") || ".")}`);
      case "grep":
        return await exec(`grep -rn ${shellQuote(str("pattern"))} ${shellQuote(str("path") || ".")}`);
      case "find":
        return await exec(`find ${shellQuote(str("path") || ".")} -name ${shellQuote(str("pattern"))}`);
      default:
        return { content: text(`Unknown tool: ${ask.tool}`), isError: true };
    }
  } catch (err) {
    return { content: text(`Error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
  }
}

const text = (t: string): PiContent => [{ type: "text", text: t }];
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Append a turn, merging into the previous one when the roles match, as the seed builder merges them. */
function appendMerged(messages: ChatMessage[], turn: ChatMessage): void {
  const last = messages[messages.length - 1];
  if (last && last.role === turn.role) last.content.push(...turn.content);
  else messages.push({ role: turn.role, content: [...turn.content] });
}
