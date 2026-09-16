// OpenCode's driver for the conformance table (docs/reference/specs/harness.md
// item 11): a run driven through the real `OpenCodeBridge` and `driveOpenCode`
// over a fake `serve` — an in-process scripted OpenCode that answers the
// bridge's writes (prompt, permission reply, interrupt) and appends the feed
// records the tailer would have written, from the row's scripted model turns.
// The bridge reads that feed through pi's log transport exactly as it reads a
// real run's, so a row reads what the record would hold. The real tailer is
// U10's and tested there; here the scripted serve stands in for the server and
// the tailer both. The driver plants the sentinel under the bot's provider-key
// variables (derived from the run's provider dialect, the config's table), and
// declares the one cannot the maintainer decided: OpenCode's gate cannot be
// unforgeable by construction — a forged approval is caught by detection, one
// tool call late, not prevented (record 0038's fifth amendment).

import type { AgentDef, Identity } from "../../../../agents/registry.js";
import type { Executor } from "../../../../execution/executor.js";
import { updateStatusTool } from "../../../../tools/status.js";
import type { ChatMessage, ContentPart } from "../../../chatMessage.js";
import type { ProviderConfig } from "../../../provider.js";
import type { RunEvent } from "../../../runEvents.js";
import type { StepReport } from "../../../runLedger/stepReport.js";
import { RunControl } from "../../../runRegistry/runControl.js";
import { FollowUpInbox } from "../../../threadAdmission.js";
import {
  openThroughSeam,
  type Finding,
  type Harness,
  type HarnessDeps,
  type HarnessFacts,
  type HarnessRun,
  type HarnessSession,
} from "../../contract.js";
import type { HarnessContainer, HarnessRequest } from "../../container.js";
import { HarnessRegistry } from "../../pi/relay.js";
import { FakeHarnessContainer } from "../../testing/fakeContainer.js";
import type { DrivenRun, HarnessDriver, ModelTurn, RunScript } from "../../testing/scenarios.js";
import { driveOpenCode, type OpenCodeConnection } from "../bridge.js";
import { OPENCODE_EVENT_DISPOSITION } from "../dispositions.js";
import { openCodeBuiltinToolsFor, openCodeFacts, openCodeProviderPackage, openCodeRunPaths } from "../process.js";

const RUN_ID = "run-c";
const SESSION_ID = "ses_c";
const BEARER = "sbr_run-c.conformance-secret-no-row-may-carry";
const CONTAINER_WORD = "vm-conformance";
const PASSWORD = "conformance-password";
const PROVIDER_KEY_SENTINEL = "provider-key-sentinel-no-harness-may-forward";
const NOW = 1_700_000_000_000;
const PORT = 41_000;

/** The bot's provider-key variable for a dialect: what a provider config could
 *  interpolate for a key, and so what must never reach the child's environment.
 *  Derived from the config's provider table (its `package`), not a hardcoded
 *  trio, so a new dialect brings its own variable. */
function providerKeyEnvs(providerType: ProviderConfig["type"]): string[] {
  return openCodeProviderPackage(providerType).includes("anthropic")
    ? ["ANTHROPIC_API_KEY"]
    : ["OPENAI_API_KEY", "OPENAI_API_BASE"];
}

const agentFor = (identity: Identity): AgentDef => ({
  name: "conformance",
  description: "",
  system: "You are the conformance run.",
  toolset: "full",
  machine: identity === "none" ? "none" : "repo-resident",
  identity,
  maxTurns: 50,
  maxTokens: 4096,
  maxMinutes: 10,
});

/** The executor a relayed tool runs over in the bot; OpenCode's own tools run in the fake serve. */
const executor: Executor = {
  exec: async (command) => `ran: ${command}`,
  readFile: async () => "",
  writeFile: async () => "",
};

/** One scenario tool call as OpenCode names and asserts it: the pi tool word the
 *  scenario scripts becomes OpenCode's tool name and permission action, and its
 *  resources are the command, path or pattern the gate reads. */
function toolAsk(name: string, input: Record<string, unknown>): { name: string; action: string; resources: string[] } {
  switch (name) {
    case "bash":
      return { name: "shell", action: "shell", resources: [String(input.command ?? "")] };
    case "read":
      return { name: "read", action: "read", resources: [String(input.path ?? "")] };
    case "edit":
      return { name: "edit", action: "edit", resources: [String(input.path ?? "")] };
    case "write":
      return { name: "write", action: "edit", resources: [String(input.path ?? "")] };
    case "find":
      return { name: "glob", action: "glob", resources: [String(input.pattern ?? "*")] };
    case "grep":
      return { name: "grep", action: "grep", resources: [String(input.pattern ?? "")] };
    default:
      return { name, action: name, resources: ["*"] };
  }
}

/** The result text an allowed tool answers with. */
function toolResultText(name: string, input: Record<string, unknown>): string {
  if (name === "bash") return `ran: ${String(input.command ?? "")}`;
  return `${name} done`;
}

type ToolUse = Extract<ContentPart, { type: "tool_use" }>;

/** The scripted OpenCode: plays the row's turns, appending the feed records the
 *  tailer would have written (through `container.emit`) and answering the
 *  bridge's writes over the container. Its pending replies are the deferreds
 *  the reply route resolves. */
interface Decision {
  reply: "once" | "reject";
  message?: string;
}

/** Faults the fake serve can be told to commit, beyond the row's script. */
export interface FakeServeOptions {
  /** How many permission-reply POSTs answer 500 (and leave the ask pending) before one would succeed. */
  failReplyPosts?: number;
  /** Every permission-reply POST throws (the container gone under the request), the ask left pending. */
  replyPostThrows?: boolean;
}

class ScriptedServe {
  private readonly store: Record<string, unknown>[] = [];
  private readonly replies = new Map<string, (decision: Decision) => void>();
  private interrupted = false;
  private ordinal = 0;
  private replyFailuresLeft: number;
  private readonly replyPostThrows: boolean;

  constructor(
    private readonly container: FakeHarnessContainer,
    private readonly script: RunScript,
    request: string,
    options: FakeServeOptions = {},
  ) {
    this.store.push({ id: "msg_u0", type: "user", text: request, time: { created: NOW } });
    this.replyFailuresLeft = options.failReplyPosts ?? 0;
    this.replyPostThrows = options.replyPostThrows === true;
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    this.container.emit({
      feed: "event",
      at: NOW,
      event: { id: `evt_${type}_${this.ordinal++}`, type, created: NOW, data },
    });
  }
  private emitPermissions(pending: unknown[]): void {
    this.container.emit({
      feed: "permissions",
      at: NOW,
      sessionID: SESSION_ID,
      reason: "session.step.ended",
      data: pending,
    });
  }
  private emitMessages(): void {
    this.container.emit({
      feed: "messages",
      at: NOW,
      sessionID: SESSION_ID,
      reason: "session.step.ended",
      data: [...this.store],
    });
  }

  /** Route one of the bridge's writes: the prompt starts the play, a reply
   *  unblocks its ask, an interrupt ends it. */
  onRequest(req: HarnessRequest): { status: number; headers: Record<string, string>; body: string } {
    if (req.method === "POST" && req.path.endsWith("/prompt")) {
      if (parseBody(req.body).delivery !== "steer") void this.play();
      return { status: 200, headers: {}, body: JSON.stringify({ id: "inb_0" }) };
    }
    const reply = /\/permission\/([^/]+)\/reply$/.exec(req.path);
    if (req.method === "POST" && reply) {
      // A reply POST that never reaches the server, or one the server fails:
      // either way the ask stays pending, as the real failure would leave it.
      if (this.replyPostThrows) throw new Error("curl: (7) Failed to connect to 127.0.0.1: the container is gone");
      if (this.replyFailuresLeft > 0) {
        this.replyFailuresLeft--;
        return { status: 500, headers: {}, body: JSON.stringify({ error: "the store hiccuped" }) };
      }
      const resolve = this.replies.get(reply[1]);
      if (resolve) {
        this.replies.delete(reply[1]);
        const body = parseBody(req.body);
        resolve({
          reply: body.reply === "reject" ? "reject" : "once",
          ...(typeof body.message === "string" ? { message: body.message } : {}),
        });
      }
      return { status: 204, headers: {}, body: "" };
    }
    if (req.method === "POST" && req.path.endsWith("/interrupt")) {
      this.interrupted = true;
      for (const resolve of this.replies.values()) resolve({ reply: "reject" });
      this.replies.clear();
      return { status: 200, headers: {}, body: JSON.stringify({ interrupted: true }) };
    }
    return { status: 404, headers: {}, body: "" };
  }

  private waitReply(requestID: string): Promise<Decision> {
    return new Promise((resolve) => this.replies.set(requestID, resolve));
  }

  private async play(): Promise<void> {
    if (this.script.unknownEventKind) this.emitEvent(this.script.unknownEventKind, { sessionID: SESSION_ID });
    for (let t = 0; t < this.script.turns.length && !this.interrupted; t++)
      await this.playTurn(this.script.turns[t], t);
    this.emitEvent(this.interrupted ? "session.execution.interrupted" : "session.execution.succeeded", {
      sessionID: SESSION_ID,
      ...(this.interrupted ? { reason: "user" } : {}),
    });
  }

  private async playTurn(turn: ModelTurn, index: number): Promise<void> {
    const assistantMessageID = `msg_a${index}`;
    this.emitEvent("session.step.started", { sessionID: SESSION_ID, assistantMessageID, agent: "switchboard" });
    const content: Record<string, unknown>[] = [];
    for (const part of turn.content) {
      if (part.type === "text") {
        const ordinal = this.ordinal;
        this.emitEvent("session.text.started", { sessionID: SESSION_ID, assistantMessageID, ordinal });
        this.emitEvent("session.text.ended", { sessionID: SESSION_ID, assistantMessageID, ordinal, text: part.text });
        content.push({ type: "text", text: part.text });
      } else if (part.type === "tool_use") {
        content.push(await this.playToolCall(part, assistantMessageID, index === 0));
        if (this.interrupted) break;
      }
    }
    this.emitEvent("session.step.ended", {
      sessionID: SESSION_ID,
      assistantMessageID,
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    this.store.push({
      id: assistantMessageID,
      type: "assistant",
      agent: "switchboard",
      model: { providerID: "switchboard", id: "claude-fable-5" },
      content,
      time: { created: NOW, completed: NOW },
    });
    this.emitMessages();
  }

  private async playToolCall(
    part: ToolUse,
    assistantMessageID: string,
    firstTurn: boolean,
  ): Promise<Record<string, unknown>> {
    const callId = part.id;
    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as Record<string, unknown>;
    const ask = toolAsk(part.name, input);
    this.emitEvent("session.tool.input.started", {
      sessionID: SESSION_ID,
      assistantMessageID,
      id: callId,
      name: ask.name,
    });
    this.emitEvent("session.tool.input.ended", {
      sessionID: SESSION_ID,
      assistantMessageID,
      id: callId,
      text: JSON.stringify(input),
    });
    this.emitEvent("session.tool.called", {
      sessionID: SESSION_ID,
      assistantMessageID,
      id: callId,
      input,
      executed: false,
    });
    const text = toolResultText(part.name, input);
    const success = () => {
      this.emitEvent("session.tool.success", {
        sessionID: SESSION_ID,
        assistantMessageID,
        id: callId,
        content: [{ type: "text", text }],
        executed: true,
      });
      return {
        type: "tool",
        id: callId,
        name: ask.name,
        state: { status: "completed", input, content: [{ type: "text", text }] },
      };
    };

    // A bypass (AE2): the tool runs with no ask the bot answered.
    if (firstTurn && this.script.bypassGate) return success();

    const requestID = `per_${callId}`;
    const request = {
      id: requestID,
      sessionID: SESSION_ID,
      action: ask.action,
      resources: ask.resources,
      source: { type: "tool", messageID: assistantMessageID, id: callId },
    };
    this.emitEvent("permission.asked", request);
    // The hard vector the declared cannot names: the model's shell, holding
    // the server's password, answers `once` under the REAL request id before
    // the bot's reply lands; the server echoes that reply and runs the tool
    // against the bot's decision. The bot's own POST arrives after — the fake
    // takes it without effect, as a real server would answer it not found.
    if (firstTurn && this.script.forgeApproval) {
      this.emitEvent("permission.replied", { sessionID: SESSION_ID, requestID, reply: "once" });
      return success();
    }
    this.emitPermissions([request]);
    const decision = await this.waitReply(requestID);
    this.emitPermissions([]);
    this.emitEvent("permission.replied", { sessionID: SESSION_ID, requestID, reply: decision.reply });
    if (decision.reply === "once") return success();
    // A reject WITH the bot's reason: OpenCode turns the feedback into the tool's
    // failure so the model reads it (`CorrectedError` → `ToolFailure`).
    const message = decision.message ?? "The user rejected permission to use this specific tool call.";
    this.emitEvent("session.tool.failed", {
      sessionID: SESSION_ID,
      assistantMessageID,
      id: callId,
      error: { type: "permission.rejected", message },
      content: [{ type: "text", text: message }],
      executed: false,
    });
    return {
      type: "tool",
      id: callId,
      name: ask.name,
      state: {
        status: "error",
        input,
        error: { type: "permission.rejected", message },
        content: [{ type: "text", text: message }],
      },
    };
  }
}

/** The test harness the driver drives the bridge through: OpenCode's object as
 *  far as the gate and record rows need it. Its `open` runs `driveOpenCode`
 *  over the fake serve the run already wired; the survival and relay pieces are
 *  U12's `harness.ts`. */
class FakeServeOpenCodeHarness implements Harness {
  readonly name = "opencode" as const;
  readonly history = "authored-session" as const;
  readonly dispositions = OPENCODE_EVENT_DISPOSITION;
  effort(): string | undefined {
    return undefined;
  }
  builtinTools(identity: Identity): readonly string[] {
    return openCodeBuiltinToolsFor(identity);
  }
  async open(deps: HarnessDeps, run: HarnessRun): Promise<HarnessSession> {
    const container = deps.container as FakeHarnessContainer;
    const paths = openCodeRunPaths(run.runId);
    const conn: OpenCodeConnection = {
      container,
      paths,
      port: PORT,
      password: PASSWORD,
      sessionID: SESSION_ID,
      feedOffset: 0,
      tailerPid: container.pid,
    };
    let answer: string;
    try {
      ({ answer } = await driveOpenCode(deps, run, conn));
    } catch (err) {
      // A loop that threw — a bypass, a forged approval, a failed model call —
      // ends the process before it propagates, as pi's loop ends pi on a throw.
      await container.kill(container.pid).catch(() => {});
      throw err;
    }
    run.saveFacts?.(
      openCodeFacts(
        { pid: container.pid, port: PORT, paths, tailerPid: container.pid },
        {
          sessionID: SESSION_ID,
          logOffset: 0,
          bearer: deps.bearer,
          container: await container.identity(),
          relaunches: run.resume?.facts?.relaunches ?? 0,
        },
      ),
    );
    return {
      answer,
      followUp: async () => {
        throw new Error("the OpenCode follow-up turn is U12's");
      },
      end: async () => {
        await container.kill(container.pid);
      },
    };
  }
  async find(_facts: HarnessFacts, _container: HarnessContainer): Promise<Finding> {
    // Survival is U12's `harness.ts`; the conformance subset U11 runs does not
    // walk the survival rows.
    return "dead";
  }
  async end(_facts: HarnessFacts, _container: HarnessContainer): Promise<void> {}
}

const object = new FakeServeOpenCodeHarness();

function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function promptTextOf(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  }
  return "";
}

export function openCodeDriver(options: FakeServeOptions = {}): HarnessDriver {
  return {
    harness: "opencode",
    object,
    bearer: BEARER,
    containerWord: CONTAINER_WORD,
    providerKeySentinel: PROVIDER_KEY_SENTINEL,
    // The maintainer's decision (record 0038's fifth amendment): OpenCode's gate
    // is enforcement by detection, so the bot's decision is not final by
    // construction — an effect the bot did not decide is caught one tool call
    // late, and the run fails closed.
    cannot: {
      "gate-approval-unforgeable":
        "OpenCode's approval lives in its server, whose password the model's shell shares, so an effect the bot did not decide — a call with no ask, a reply the bot did not send, a reply that differs from the bot's, a success after the bot's refusal — is caught by detection and fails the run closed, never prevented by construction",
    },
    facts: (partial) => ({
      harness: "opencode",
      pid: partial.pid,
      port: PORT,
      logOffset: 0,
      sessionID: SESSION_ID,
      root: partial.root ?? openCodeRunPaths(RUN_ID).dir,
      relaunches: 0,
      ...(partial.bearerHash !== undefined ? { bearerHash: partial.bearerHash } : {}),
      ...(partial.container !== undefined ? { container: partial.container } : {}),
    }),
    async find(facts, containerWord) {
      const container = new FakeHarnessContainer();
      container.vm = containerWord === null ? undefined : (containerWord ?? CONTAINER_WORD);
      return object.find(facts, container);
    },
    run: (script) => runOpenCode(script, options),
  };
}

async function runOpenCode(script: RunScript, options: FakeServeOptions = {}): Promise<DrivenRun> {
  const identity = script.identity ?? "write";
  const container = new FakeHarnessContainer();
  container.vm = script.containerWord === null ? undefined : (script.containerWord ?? CONTAINER_WORD);
  const control = new RunControl();
  const inbox = new FollowUpInbox();
  if (script.followUp !== undefined) inbox.push({ text: script.followUp, userId: "user:conformance", at: NOW });
  const events: RunEvent[] = [];
  const steps: StepReport[] = [];
  const facts: HarnessFacts[] = [];
  const progress: string[] = [];
  const statusReports: string[] = [];
  const run: HarnessRun = {
    runId: RUN_ID,
    agent: agentFor(identity),
    model: { id: "claude-fable-5", provider: "anthropic", providerType: "anthropic" },
    system: "You are the conformance run.",
    messages: [
      ...(script.seed ?? []),
      { role: "user", content: [{ type: "text", text: script.request ?? "do the thing" }] },
    ],
    tools: script.relayed ?? [updateStatusTool],
    toolContext: { executor, reportProgress: (list) => void statusReports.push(list) },
    rules: { checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
    control,
    inbox,
    onEvent: (e) => void events.push(e),
    onProgress: (n) => void progress.push(n),
    onStep: async (r) => void steps.push(r),
    saveFacts: (f) => void facts.push(f),
    ...(script.resume ? { resume: script.resume } : {}),
  };
  // Wire the fake serve before the seam opens: the two starts (server, then the
  // tailer whose log IS the feed) file the run and set the container's log to
  // the feed; the prompt the bridge posts starts the scripted play.
  const paths = openCodeRunPaths(RUN_ID);
  await container.start({
    paths,
    command: "opencode",
    args: ["serve", "--hostname", "127.0.0.1", "--port", "41000"],
    env: launchEnv(BEARER),
    port: PORT,
  });
  await container.start({
    paths: paths.tailer,
    command: "node",
    args: [paths.tailerScript],
    env: {},
    port: PORT,
    keepLog: true,
  });
  const serve = new ScriptedServe(container, script, promptTextOf(run.messages), options);
  container.onRequest = (req) => serve.onRequest(req);

  const registry = new HarnessRegistry();
  const deps: HarnessDeps = {
    container,
    bearer: BEARER,
    harnessUrl: "https://bot.example.com",
    registry,
    clock: () => NOW,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    pollMs: 1,
    tickMs: 5,
    finaleTimeoutMs: 60_000,
  };
  const restore = plantProviderKeys(run.model.providerType);
  let outcome: DrivenRun["outcome"];
  try {
    const session = await openThroughSeam(object, deps, run);
    outcome = { kind: "answered", answer: session.answer };
    await session.end();
  } catch (err) {
    outcome = { kind: "failed", error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    restore();
  }
  return {
    harness: "opencode",
    outcome,
    events,
    steps,
    facts,
    progress,
    starts: container.starts,
    killed: container.killed,
    requests: container.requests,
    modelCalls: [],
    statusReports,
  };
}

/** The launch environment the credential row reads: the bearer, no provider
 *  key, whatever the bot's own environment holds. */
function launchEnv(bearer: string): Record<string, string> {
  return {
    SWITCHBOARD_RUN_BEARER: bearer,
    SWITCHBOARD_HARNESS_URL: "https://bot.example.com",
    SWITCHBOARD_RUN_ID: RUN_ID,
  };
}

/** Plants the sentinel under the bot's provider-key variables for the run's
 *  own dialect, so a harness that forwarded one would leak it into the child's
 *  environment — and a row on an OpenAI-dialect provider plants that dialect's. */
function plantProviderKeys(providerType: ProviderConfig["type"]): () => void {
  const envs = providerKeyEnvs(providerType);
  const saved = envs.map((k) => [k, process.env[k]] as const);
  for (const k of envs) process.env[k] = PROVIDER_KEY_SENTINEL;
  return () => {
    for (const [k, v] of saved)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
}
