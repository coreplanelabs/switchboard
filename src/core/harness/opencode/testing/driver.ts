// OpenCode's driver for the conformance table (docs/reference/specs/harness.md
// item 11): a run driven through the REAL `OpenCodeHarness` object — its full
// `open` (the launch through the seam, the seed imported as an authored
// session, the request prompted, the relay registered, the follow-up drain, the
// gate-and-record loop `driveOpenCode`) — over a fake `opencode serve`. The
// fake serve is an in-process scripted OpenCode: it answers the launch's
// readiness probes, the session import and create, the prompt, the permission
// reply, the interrupt and the wait, and it plays the row's scripted model
// turns by appending the feed records the tailer would have written and by
// running the relayed tools through the bot exactly as the real plugin's
// `POST /harness/tool` would. The bridge reads that feed through pi's log
// transport exactly as it reads a real run's, and the model calls the driver
// records from the store stand in for the proxy's wire requests, so a row reads
// what the record — and the model — would hold. The real binary is the driver
// in `../../testing/drivers.ts`; here the scripted serve stands in for the
// server, the tailer and the model at once.
//
// The one declared cannot is the maintainer's decision (record 0038's fifth
// amendment): OpenCode's gate cannot be unforgeable by construction — a forged
// approval is caught by detection, one tool call late, not prevented.
//
// A row's resume may name a server a dead generation started that still answers
// in this container (`processAliveOnResume`): the fake plays that server too, on
// the port the row recorded — the same `ScriptedServe` in its `recorded` role,
// seeded from the resume's transcript with the calls in flight at the death
// still running (a pending ask for one of OpenCode's own tools, a relayed call
// the plugin re-asks the relay for by its id), guarding every route with the
// row's password, so the harness's re-attach is driven against what a real
// server would hold. `FakeServeOptions.reattach` names the faults that make a
// re-attach fall back.
//
// The same serve has a second door, `scriptOpenCodeServe`: bound to a bare
// container before any run exists, for a run the RUN LOOP opens (the
// configuration word's end-to-end tests in `src/core/dispatch/runLoop.test.ts`,
// where `containerFor` hands the loop a container and nothing of the run). That
// serve learns the run lazily — the run id from the launch's environment, the
// relayed tools and the identity from the relay registration the harness makes
// before it launches, the model and the system prompt from the configuration it
// wrote — so one implementation answers both doors and no second serve exists.

import type { AgentDef, Identity } from "../../../../agents/registry.js";
import type { Executor } from "../../../../execution/executor.js";
import { updateStatusTool } from "../../../../tools/status.js";
import type { ChatMessage, ContentPart } from "../../../chatMessage.js";
import type { CompletionRequest, ProviderConfig, ToolDef } from "../../../provider.js";
import type { RunEvent } from "../../../runEvents.js";
import type { StepReport } from "../../../runLedger/stepReport.js";
import { RunControl } from "../../../runRegistry/runControl.js";
import type { RunBearerStore } from "../../../modelProxy/runBearers.js";
import type { RunnableTool } from "../../../../tools/runnableTool.js";
import { FollowUpInbox } from "../../../threadAdmission.js";
import { openThroughSeam, type HarnessDeps, type HarnessFacts, type HarnessRun } from "../../contract.js";
import {
  HarnessContainerError,
  HarnessContainerRuntimeReplacedError,
  type HarnessRequest,
  type HarnessResponse,
} from "../../container.js";
import { authorizeToolCall, HarnessRegistry, relayToolCall, runRelayedTool } from "../../pi/relay.js";
import { FakeHarnessContainer } from "../../testing/fakeContainer.js";
import {
  CONFORMANCE_MAX_MINUTES,
  FAILED_MODEL_CALL_ERROR,
  type DrivenRun,
  type HarnessDriver,
  type ModelTurn,
  type RunScript,
} from "../../testing/scenarios.js";
import { openCodeToolNameWord } from "../bridge.js";
import { OpenCodeHarness } from "../harness.js";
import { openCodeAuthHeader, OPENCODE_VERSION } from "../client.js";
import {
  OPENCODE_AGENT,
  openCodePassword,
  openCodeProviderPackage,
  openCodeRunPaths,
  openCodeRunPathsAt,
} from "../process.js";
import { openCodeCompactionMessage, openCodeStoreMessages } from "../session.js";

const RUN_ID = "run-c";
const SESSION_ID = "ses_run-c";
const BEARER = "sbr_run-c.conformance-secret-no-row-may-carry";
const CONTAINER_WORD = "vm-conformance";
/** The word the container answers after it is replaced under the run, so the
 *  replaced verdict's `was`/`now` are two distinct words. */
const REPLACED_WORD = "vm-conformance-2";
const PROVIDER_KEY_SENTINEL = "provider-key-sentinel-no-harness-may-forward";
const NOW = 1_700_000_000_000;
/** The port the fake serve of THIS generation listens on: the free port every launch is given. */
const PORT = 41_000;
/** The port a row's facts record for a previous generation's server — another
 *  port than this generation's launch gets, so a probe of the recorded port is
 *  told apart from the launch's readiness probes and answered as the row's
 *  script says: the old server still up (`processAliveOnResume`), or gone. */
const RECORDED_PORT = 41_001;
const HARNESS_URL = "https://bot.example.com";
/** The tailer's readiness notes, as a subscribed tailer writes them first: what every driver run's feed begins with. */
export const TAILER_READY_NOTES: readonly unknown[] = [
  { feed: "tailer", at: 0, note: "started" },
  { feed: "tailer", at: 1, note: "connected", connections: 1 },
];
/** How many feed bytes these records take as the fake writes them (one JSON line each): what a row's `logOffset` is computed from. */
export function feedByteLength(records: readonly unknown[]): number {
  return records.reduce<number>((n, r) => n + Buffer.byteLength(JSON.stringify(r), "utf8") + 1, 0);
}

/** The bot's provider-key variable for a dialect, planted for the run's
 *  duration: what a harness that forwarded the bot's key would leak, derived
 *  from the run's provider dialect so a new dialect brings its own variable. */
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
  maxMinutes: CONFORMANCE_MAX_MINUTES,
});

/** The executor a relayed tool runs over in the bot; OpenCode's own tools run in the fake serve. */
const executor: Executor = {
  exec: async (command) => `ran: ${command}`,
  readFile: async () => "",
  writeFile: async () => "",
};

/** One scenario tool call as OpenCode names and asserts it: the pi tool word the
 *  scenario scripts becomes OpenCode's tool name and permission action, its
 *  resources the command, path or pattern the gate reads. */
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

/** The result text an allowed OpenCode-own tool answers with. */
function ownToolResultText(name: string, input: Record<string, unknown>): string {
  if (name === "bash") return `ran: ${String(input.command ?? "")}`;
  return `${name} done`;
}

type ToolUse = Extract<ContentPart, { type: "tool_use" }>;

interface Decision {
  reply: "once" | "reject";
  message?: string;
}

/** One clause's behaviour switched off, so the suite fails the clause's row once
 *  (record 0038's mutation requirement): `credential` leaks a provider key into the server's
 *  environment; `gate` runs a refused tool anyway; `relay` returns a canned
 *  result instead of running the tool in the bot; `record` drops the tool call
 *  from the stream; `conversation` never imports the seed; `survival` never
 *  writes the row's facts. */
export type MutatedClause = "credential" | "gate" | "relay" | "record" | "conversation" | "survival";

/** Faults the fake serve can be told to commit, beyond the row's script. */
export interface FakeServeOptions {
  /** How many permission-reply POSTs answer 500 (and leave the ask pending) before one would succeed. */
  failReplyPosts?: number;
  /** Every permission-reply POST throws (the container gone under the request), the ask left pending. */
  replyPostThrows?: boolean;
  /** Every steer POST (a follow-up) answers 500: the server never takes the follow-up. */
  steerPostFails?: boolean;
  /** The relay registry the run is opened on; a test hands one that already
   *  holds the run's registration with a relayed call still running, so a
   *  relaunch is seen to take it over rather than register anew. Fresh unless given. */
  registry?: HarnessRegistry;
  /** One clause's behaviour removed, for the mutation rows. */
  mutate?: MutatedClause;
  /** The word the container renames itself to when the script replaces it
   *  (`containerReplacedBeforeModelCall`); the fake's own replaced word unless given. */
  replacedWord?: string;
  /** How the row's still-answering server (`processAliveOnResume`) departs from
   *  one a re-attach can continue on, and what the dead generation's feed holds. */
  reattach?: ReattachOptions;
  /** Handed the run's container before the run opens, for a test that reads
   *  what the row's fields do not carry — every start the container was asked
   *  for, the tailer's among them. */
  inspectContainer?: (container: FakeHarnessContainer) => void;
  /** The run's bearer store, handed to the harness as `HarnessDeps.bearers`: a
   *  test reads whether a re-attach adopted the row's hash onto it. Absent, the
   *  harness is handed none and adopts nothing. */
  bearers?: RunBearerStore;
}

/** The recorded server's faults and the dead generation's feed. */
export interface ReattachOptions {
  /** The row's tailer is gone: only the server answers, so the re-attach restarts the tailer over the same feed. */
  tailerDead?: boolean;
  /** The server answers 401 whatever password it is shown: the re-attach falls back. */
  refusePassword?: boolean;
  /** The server answers 404 for the session's routes: the re-attach falls back. */
  refuseSession?: boolean;
  /** The health names another version than the pin: the re-attach falls back. */
  otherVersion?: string;
  /** Every store page answers a next cursor: the store never ends, and the re-attach refuses rather than continue on a partial one. */
  endlessStore?: boolean;
  /** The feed cannot be read at the re-attach (the container's next read fails): the re-attach falls back. */
  feedUnreadable?: boolean;
  /** Records the dead generation's tailer wrote before the row's offset, after
   *  the readiness notes: a test puts the row's `logOffset` past them
   *  (`feedByteLength`) and reads that nothing of them is said again. */
  feedBefore?: readonly unknown[];
  /** Records the dead generation's tailer wrote after the row's offset and
   *  after the in-flight calls' records (`seedFeed`): an exchange the ledger
   *  already holds, read catching up. */
  feedAfter?: readonly unknown[];
  /** The in-flight own-tool call's ask was answered `once` while the bot was
   *  away — by nobody the run can name — and the tool ran: the ask is not
   *  pending at the re-attach, the store holds the call completed, and the
   *  feed carries the ask, its echo and the success after the row's offset. */
  answeredWhileAway?: boolean;
}

/** What the serve knows of the run it answers for, resolved once at the first
 *  need: eagerly from the `HarnessRun` and `HarnessDeps` the conformance driver
 *  built, or lazily from the container and the relay registry for a run the
 *  run loop opened (`scriptOpenCodeServe`). */
interface ServeRun {
  runId: string;
  /** The run's root, `openCodeRunPaths(runId).dir`: where the configuration the launch wrote is read from. */
  root: string;
  identity: Identity;
  /** The relayed tools — Switchboard's, run in the bot through the registration. */
  tools: readonly RunnableTool[];
  model: { id: string };
  system: string | undefined;
  maxTokens: number;
  /** The run's control, for `hardStopBeforeModelCall`; a serve bound to a bare container has none. */
  control?: RunControl;
}

/** What the serve needs of the process: the relay registry the run is registered
 *  on, the pacing for a scripted hard stop, the bearer store to meter each
 *  model call on (pi's scripted double does the same), when a test hands one,
 *  and the driver's hand on the run's clock for a scripted budget end. */
interface ServeDeps {
  registry: HarnessRegistry;
  sleep: (ms: number) => Promise<void>;
  tickMs?: number;
  bearers?: RunBearerStore;
  /** Moves the run's clock past its deadline (`budgetBeforeModelCall`): the
   *  serve has no clock of its own, the driver that built the run does. */
  spendBudget?: () => void;
}

/** The serve as a test holds it: the model requests it recorded. */
export interface ScriptedOpenCode {
  readonly modelCalls: CompletionRequest[];
}

/** The scripted OpenCode: answers the harness's writes and plays the row's
 *  turns by appending the feed records the tailer would have written. */
class ScriptedServe {
  private readonly store: Record<string, unknown>[] = [];
  private readonly replies = new Map<string, (decision: Decision) => void>();
  private readonly pendingSteers: string[] = [];
  private interrupted = false;
  /** The container was replaced with the last turn's call in flight: the play
   *  stops, having left that call open (no success event). */
  private replaced = false;
  /** The platform's rollout with the last turn's call in flight: the server and
   *  its tailer die with the call open and no read fails with the word; the play
   *  stops there. */
  private deadWithoutWord = false;
  private ordinal = 0;
  private replyFailuresLeft: number;
  private readonly replyPostThrows: boolean;
  private readonly steerPostFails: boolean;
  private readonly mutate: MutatedClause | undefined;
  private readonly replacedWord: string;
  private readonly reattach: ReattachOptions;
  /** The run, resolved at the first need and kept (see `ServeRun`). */
  private resolved: (ServeRun & { offered: Set<string>; relayNames: Set<string>; toolDefs: ToolDef[] }) | undefined;
  /** The model requests the driver records — the proxy's wire, from the store the model saw. */
  readonly modelCalls: CompletionRequest[] = [];
  /** The recorded server's calls in flight at the dead generation's death, by
   *  call id: each a tool content still `running` in the store's last assistant
   *  message — an own tool blocked on its pending ask, or a relayed call the
   *  plugin re-asks the relay for once the run is registered again. */
  private readonly inFlight = new Map<
    string,
    { name: string; action: string; input: Record<string, unknown>; assistantMessageID: string; relayed: boolean }
  >();
  /** The asks pending on the recorded server, by request id: what `GET …/permission` lists. */
  private readonly pendingAsks = new Map<string, Record<string, unknown>>();
  /** Every in-flight own-tool call's ask, pending or answered while the bot was away, for the feed. */
  private readonly asksOfInFlight = new Map<string, Record<string, unknown>>();
  /** The recorded server's execution is under way, blocked on its calls in flight:
   *  a steer lands at the step boundary those calls settle at. */
  private running = false;
  private playing = false;
  private reasked = false;

  constructor(
    private readonly container: FakeHarnessContainer,
    private readonly source: () => ServeRun,
    private readonly script: RunScript,
    private readonly deps: ServeDeps,
    options: FakeServeOptions = {},
    /** `recorded`: the server a dead generation started, still answering on the row's port, seeded from the resume. */
    private readonly role: "live" | "recorded" = "live",
  ) {
    this.replyFailuresLeft = options.failReplyPosts ?? 0;
    this.replyPostThrows = options.replyPostThrows === true;
    this.steerPostFails = options.steerPostFails === true;
    this.mutate = options.mutate;
    this.replacedWord = options.replacedWord ?? REPLACED_WORD;
    this.reattach = options.reattach ?? {};
    if (role === "recorded") this.seedFromResume();
  }

  /** The recorded server's store as the dead generation left it: the resume's
   *  transcript as store messages (the same shape a rebuild's import writes),
   *  each call in flight at the death a `running` tool content of the last
   *  assistant message, and — with nothing in flight — the `idle` marker the
   *  execution's failure left when the proxy died with the bot. The dead
   *  generation's tailer wrote the in-flight call's start and its ask before it
   *  died, so those records are in the feed too. */
  private seedFromResume(): void {
    const resume = this.script.resume;
    if (resume === undefined) throw new Error("a recorded server needs the script's resume: the row it answers for");
    const settled = new Map(resume.settlements.map((st) => [st.toolUse.id, st.toolUse]));
    const store = openCodeStoreMessages(resume.messages, {
      sessionID: this.sessionID,
      location: { directory: "/workspace/threads/t/main" },
      model: { providerID: "switchboard", id: this.run.model.id },
      agent: OPENCODE_AGENT,
      at: NOW,
      settlements: new Map([...settled.keys()].map((id) => [id, ""])),
    });
    for (const message of store) {
      if (message.type !== "assistant") continue;
      const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
      for (const part of content) {
        if (part.type !== "tool" || !settled.has(String(part.id))) continue;
        const toolUse = settled.get(String(part.id))!;
        const input = (typeof toolUse.input === "object" && toolUse.input !== null ? toolUse.input : {}) as Record<
          string,
          unknown
        >;
        const ask = toolAsk(toolUse.name, input);
        part.name = ask.name;
        part.state = { status: "running", input };
        this.inFlight.set(toolUse.id, {
          name: ask.name,
          action: ask.action,
          input,
          assistantMessageID: String(message.id),
          relayed: this.relayNames.has(toolUse.name),
        });
      }
    }
    this.store.push(...store);
    // The ledger's compaction rows as the store holds them: compaction messages
    // after the transcript, as a rebuild's import writes them.
    (resume.compactions ?? []).forEach((c, i) =>
      this.store.push(openCodeCompactionMessage(`msg_${this.sessionID}_c${i}`, c.entry, NOW)),
    );
    if (this.inFlight.size === 0) {
      this.store.push({ id: "msg_idle_death", type: "idle", outcome: "failed", time: { created: NOW } });
      return;
    }
    this.running = true;
    for (const [callId, call] of this.inFlight) {
      if (call.relayed) continue;
      const requestID = `per_${callId}`;
      this.asksOfInFlight.set(requestID, {
        id: requestID,
        sessionID: this.sessionID,
        action: call.action,
        resources: toolAsk(openCodeToolNameWord(call.name), call.input).resources,
        source: { type: "tool", messageID: call.assistantMessageID, id: callId },
      });
      if (!this.reattach.answeredWhileAway) this.pendingAsks.set(requestID, this.asksOfInFlight.get(requestID)!);
    }
  }

  /** What the dead generation's tailer wrote of the calls in flight before it
   *  died — each call's start, and the ask of one blocked on the gate — appended
   *  to the feed after whatever the fault says came before the row's offset.
   *  With `answeredWhileAway`, the ask was answered and the tool ran while the
   *  bot was away: the echo and the success follow the ask, and the store
   *  holds the call completed. */
  seedFeed(): void {
    for (const [callId, call] of this.inFlight) {
      this.emitEvent("session.tool.input.started", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        name: call.name,
      });
      this.emitEvent("session.tool.called", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        input: call.input,
        executed: false,
      });
      const request = this.asksOfInFlight.get(`per_${callId}`);
      if (request !== undefined) this.emitEvent("permission.asked", request);
    }
    if (this.pendingAsks.size > 0) this.emitPermissions([...this.pendingAsks.values()]);
    if (this.reattach.answeredWhileAway)
      for (const [callId, call] of [...this.inFlight]) {
        if (call.relayed) continue;
        this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID: `per_${callId}`, reply: "once" });
        this.settleInFlight(callId, {
          content: [{ type: "text", text: ownToolResultText(openCodeToolNameWord(call.name), call.input) }],
        });
      }
  }

  /** The plugin, still waiting on the bot for a relayed call when the bot died,
   *  asks the relay again by the same call id once the run is registered: the
   *  record's settlement answers it and the tool never runs; the call settles
   *  on that note, as the real plugin settles it on the relay's error answer. */
  private reaskRelayed(): void {
    if (this.reasked) return;
    this.reasked = true;
    for (const [callId, call] of this.inFlight) {
      if (!call.relayed) continue;
      void (async () => {
        const live = this.deps.registry.get(this.run.runId);
        const calls = this.deps.registry.calls(this.run.runId);
        if (!live || !calls) return;
        const ask = { toolCallId: callId, tool: call.name, input: call.input };
        // The plugin's window, asked again after each `pending` as the real one asks.
        let progress = await relayToolCall(live, calls, ask, { windowMs: 50 });
        while (!progress.done) progress = await relayToolCall(live, calls, ask, { windowMs: 50 });
        const text = progress.answer.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
        this.settleInFlight(callId, progress.answer.isError ? { error: text } : { content: [{ type: "text", text }] });
      })();
    }
  }

  /** One call in flight at the death settles on the recorded server: the store's
   *  tool content completes or errors, the event lands, the store refills, and
   *  with no call left in flight the execution reaches its step boundary. */
  private settleInFlight(
    callId: string,
    outcome: { content: Array<{ type: string; text: string }> } | { error: string },
  ): void {
    const call = this.inFlight.get(callId);
    if (call === undefined) return;
    this.inFlight.delete(callId);
    for (const message of this.store) {
      if (message.id !== call.assistantMessageID) continue;
      const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
      for (const part of content) {
        if (part.type !== "tool" || part.id !== callId) continue;
        part.state =
          "content" in outcome
            ? { status: "completed", input: call.input, content: outcome.content }
            : {
                status: "error",
                input: call.input,
                error: { type: "permission.rejected", message: outcome.error },
                content: [{ type: "text", text: outcome.error }],
              };
      }
    }
    if ("content" in outcome)
      this.emitEvent("session.tool.success", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        content: outcome.content,
        executed: true,
      });
    else
      this.emitEvent("session.tool.failed", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        executed: false,
        error: { type: "permission.rejected", message: outcome.error },
        content: [{ type: "text", text: outcome.error }],
      });
    this.emitMessages();
    this.stepBoundary();
  }

  /** The recorded server's execution reaches a step boundary once nothing is in
   *  flight: a steer waiting there — the re-attach's continue — is the next user
   *  turn, and the play goes on from it. */
  private stepBoundary(): void {
    if (this.running && this.inFlight.size === 0 && this.pendingSteers.length > 0 && !this.playing) void this.play();
  }

  /** The run this serve answers for, with the tool tables derived from it once. */
  private get run(): ServeRun & { offered: Set<string>; relayNames: Set<string>; toolDefs: ToolDef[] } {
    if (this.resolved === undefined) {
      const run = this.source();
      const builtins = new OpenCodeHarness().builtinTools(run.identity);
      const relayNames = new Set(run.tools.map((t) => t.name));
      this.resolved = {
        ...run,
        relayNames,
        offered: new Set([...builtins, ...relayNames]),
        toolDefs: [
          ...builtins.map((name): ToolDef => ({ name, description: "", inputSchema: {} })),
          ...run.tools.map((t): ToolDef => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        ],
      };
    }
    return this.resolved;
  }
  /** The session the fake mints for the run: one per run, named after it. */
  private get sessionID(): string {
    return `ses_${this.run.runId}`;
  }
  private get offered(): Set<string> {
    return this.run.offered;
  }
  private get relayNames(): Set<string> {
    return this.run.relayNames;
  }
  private get toolDefs(): ToolDef[] {
    return this.run.toolDefs;
  }
  /** The configuration the launch wrote, under the run's root. */
  private configPath(): string {
    return openCodeRunPathsAt(this.run.root).config;
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
      sessionID: this.sessionID,
      reason: "session.step.ended",
      data: pending,
    });
  }
  private emitMessages(): void {
    this.container.emit({
      feed: "messages",
      at: NOW,
      sessionID: this.sessionID,
      reason: "session.step.ended",
      data: [...this.store],
    });
  }

  /** Route one of the harness's writes: the readiness probes, the session
   *  import and create, the prompt (a queue starts the play, a steer injects a
   *  user turn), the permission reply, the interrupt, the wait. */
  onRequest(req: HarnessRequest): HarnessResponse {
    const j = (status: number, obj: unknown): HarnessResponse => ({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj),
    });
    if (this.role === "recorded") {
      // The dead generation's server guards every route with the password its
      // launch derived from the bearer: a probe without it is answered 401 (up,
      // as `find` reads it), a re-attach with it is let in — unless the fault says
      // the password is refused whatever is shown.
      const expected = openCodeAuthHeader(openCodePassword(BEARER));
      if (this.reattach.refusePassword || req.secretHeaders?.Authorization !== expected)
        return { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' }, body: "" };
      // The run is registered again by the time the harness probes: the plugin's re-ask reaches the relay.
      this.reaskRelayed();
      if (req.method === "GET" && req.path === "/api/health")
        return j(200, { healthy: true, version: this.reattach.otherVersion ?? OPENCODE_VERSION, pid: 77 });
      if (this.reattach.refuseSession && req.path.startsWith(`/api/session/${this.sessionID}/`))
        return j(404, { error: "no such session" });
    }
    if (req.method === "GET" && req.path === "/api/health")
      return j(200, { healthy: true, version: OPENCODE_VERSION, pid: 77 });
    // The store and the pending asks as the server holds them: what a re-attach reads back.
    if (req.method === "GET" && req.path.split("?")[0] === `/api/session/${this.sessionID}/message`)
      return j(200, {
        data: [...this.store],
        cursor: this.role === "recorded" && this.reattach.endlessStore ? { next: "more" } : {},
      });
    if (req.method === "GET" && req.path === `/api/session/${this.sessionID}/permission`)
      return j(200, { data: [...this.pendingAsks.values()] });
    if (req.method === "GET" && req.path === "/api/config") {
      // The document the launch actually wrote, so readiness holds the run's own config.
      const written = this.container.files.get(this.configPath());
      const info = written ? (JSON.parse(written) as Record<string, unknown>) : {};
      return j(200, [{ type: "document", path: this.configPath(), info }]);
    }
    if (req.method === "POST" && req.path === "/api/plugin/await-activation")
      return { status: 204, headers: {}, body: "" };
    if (req.method === "POST" && req.path === "/api/session/import") {
      const body = parseBody(req.body);
      // The conversation clause switched off: the seed is never imported, so the
      // model's first call does not see the thread's earlier turns.
      if (this.mutate !== "conversation")
        for (const m of Array.isArray(body.messages) ? body.messages : [])
          this.store.push(m as Record<string, unknown>);
      return j(200, { data: { id: (body.info as { id?: string })?.id ?? this.sessionID } });
    }
    if (req.method === "POST" && req.path === "/api/session") return j(200, { data: { id: this.sessionID } });
    if (req.method === "POST" && req.path.endsWith("/wait")) return { status: 204, headers: {}, body: "" };
    if (req.method === "POST" && req.path.endsWith("/prompt")) {
      const body = parseBody(req.body);
      const text = String(body.text ?? "");
      if (body.delivery === "steer") {
        // The steer POST the server never takes (F1): the follow-up drainer must
        // record it as undelivered and hand it back to the inbox, never as read.
        if (this.steerPostFails) return j(500, { error: "the store hiccuped" });
        this.pendingSteers.push(text);
        // A steer into the recorded server's execution lands at its next step
        // boundary: at once when nothing is in flight, else when the calls settle.
        this.stepBoundary();
      } else {
        // A rebuild's prompt is the continue that triggers the session; the
        // imported record already holds the conversation and the settlement, so
        // the continue's echo is elided (the mirror starts from the settlement
        // turn it primed). A fresh run's prompt is the request, a store turn.
        if (!this.script.resume)
          this.store.push({ id: `msg_u${this.store.length}`, type: "user", text, time: { created: NOW } });
        void this.play();
      }
      return j(200, { data: { id: `inb_${this.ordinal++}` } });
    }
    const reply = /\/permission\/([^/]+)\/reply$/.exec(req.path);
    if (req.method === "POST" && reply) {
      if (this.replyPostThrows) throw new Error("curl: (7) Failed to connect to 127.0.0.1: the container is gone");
      if (this.replyFailuresLeft > 0) {
        this.replyFailuresLeft--;
        return j(500, { error: "the store hiccuped" });
      }
      const body = parseBody(req.body);
      const decision: Decision = {
        reply: body.reply === "reject" ? "reject" : "once",
        ...(typeof body.message === "string" ? { message: body.message } : {}),
      };
      // An ask pending since the death, decided now: the tool runs or fails on
      // the recorded server as it would have under the dead generation's reply.
      const pending = this.pendingAsks.get(reply[1]);
      if (pending !== undefined) {
        this.pendingAsks.delete(reply[1]);
        const callId = String((pending.source as { id?: string } | undefined)?.id ?? reply[1]);
        const call = this.inFlight.get(callId);
        this.emitPermissions([...this.pendingAsks.values()]);
        this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID: reply[1], reply: decision.reply });
        if (call !== undefined)
          this.settleInFlight(
            callId,
            decision.reply === "once"
              ? { content: [{ type: "text", text: ownToolResultText(openCodeToolNameWord(call.name), call.input) }] }
              : { error: decision.message ?? "The user rejected permission to use this specific tool call." },
          );
        return { status: 204, headers: {}, body: "" };
      }
      const resolve = this.replies.get(reply[1]);
      if (resolve) {
        this.replies.delete(reply[1]);
        resolve(decision);
      }
      return { status: 204, headers: {}, body: "" };
    }
    if (req.method === "POST" && req.path.endsWith("/interrupt")) {
      this.interrupted = true;
      for (const resolve of this.replies.values()) resolve({ reply: "reject" });
      this.replies.clear();
      return j(200, { interrupted: true });
    }
    return j(404, { error: "no such route" });
  }

  private waitReply(requestID: string): Promise<Decision> {
    return new Promise((resolve) => this.replies.set(requestID, resolve));
  }

  /** Any steers posted since the last turn, injected into the store as user
   *  turns, so the model's next call sees them (as OpenCode delivers a steer at
   *  the next step boundary). */
  private flushSteers(): void {
    for (const text of this.pendingSteers.splice(0))
      this.store.push({ id: `msg_s${this.store.length}`, type: "user", text, time: { created: NOW } });
  }

  /** The store the model saw, as the completion request the proxy would carry. */
  private recordModelCall(): void {
    this.deps.bearers?.consumeTurn(this.run.runId);
    this.modelCalls.push({
      model: this.run.model.id,
      system: this.run.system,
      messages: storeToMessages(this.store),
      tools: this.toolDefs,
      maxTokens: this.run.maxTokens,
    });
  }

  private async play(): Promise<void> {
    this.playing = true;
    if (this.script.unknownEventKind) this.emitEvent(this.script.unknownEventKind, { sessionID: this.sessionID });
    for (let t = 0; t < this.script.turns.length && !this.interrupted; t++) {
      // A hard stop before this model call (`hardStopBeforeModelCall`): request
      // it, then wait for the loop to see it and interrupt the session (the
      // interrupt route sets `interrupted`) before this turn plays — so the run
      // ends hard-stopped, never on this turn's answer.
      if (this.script.hardStopBeforeModelCall === t + 1) {
        if (this.run.control === undefined)
          throw new Error(
            "hardStopBeforeModelCall needs the run's control: hand the serve a run, not a bare container",
          );
        this.run.control.requestStop("hard");
        for (let i = 0; i < 200 && !this.interrupted; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
      }
      if (this.interrupted) break;
      if (this.script.budgetBeforeModelCall === t + 1) {
        // The wall clock runs out with this model call under way: the step has
        // started, the clock passes the deadline, and the harness's tick notes
        // the budget and steers the write-up before the call answers — waited
        // for, as the hard stop above waits for its interrupt.
        if (this.deps.spendBudget === undefined)
          throw new Error("budgetBeforeModelCall needs the driver's clock: hand the serve `spendBudget`");
        this.emitEvent("session.step.started", {
          sessionID: this.sessionID,
          assistantMessageID: `msg_a${t}`,
          agent: "switchboard",
        });
        // The step's start is read off the feed before the clock moves, so the
        // budget note finds the model call in flight and not the tool before it.
        for (let i = 0; i < 8; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
        this.deps.spendBudget();
        for (let i = 0; i < 200 && this.pendingSteers.length === 0; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
      }
      if (this.script.failModelCall === t + 1) {
        // The model call fails: the execution fails with the provider's words
        // and the session goes idle, as the server reports a call the proxy
        // answered with an error. A steer queued meanwhile was for the turn
        // after this one, which never comes.
        this.recordModelCall();
        this.emitEvent("session.execution.failed", {
          sessionID: this.sessionID,
          error: { message: FAILED_MODEL_CALL_ERROR },
        });
        this.emitEvent("session.idle", { sessionID: this.sessionID });
        return;
      }
      this.flushSteers();
      this.recordModelCall();
      await this.playTurn(this.script.turns[t], t);
      if (this.replaced) {
        // The container was replaced with this turn's call in flight: rename the
        // container (so the verdict's was → now are two words) and arm the next
        // feed read to fail with the executor's word once the records already
        // written — this turn among them — are read. No further turns; the call
        // stays open, its result never delivered.
        this.container.vm = this.replacedWord;
        this.container.failOnceDrained = new HarnessContainerRuntimeReplacedError(
          "read",
          "runtime-replaced: the sandbox was replaced under the run",
        );
        return;
      }
      if (this.deadWithoutWord) {
        // The platform's rollout: the server and its tailer are killed first
        // while exec still answers, so the feed ends with this turn's call open
        // and no read fails with the word; what the harness's one more command
        // finds is the script's. No further turns.
        this.container.dieWithoutWord(this.script.deadWithoutWordThen ?? "word", this.replacedWord);
        return;
      }
    }
    this.emitEvent(this.interrupted ? "session.execution.interrupted" : "session.execution.succeeded", {
      sessionID: this.sessionID,
      ...(this.interrupted ? { reason: "user" } : {}),
    });
  }

  private async playTurn(turn: ModelTurn, index: number): Promise<void> {
    const assistantMessageID = `msg_a${index}`;
    this.emitEvent("session.step.started", { sessionID: this.sessionID, assistantMessageID, agent: "switchboard" });
    const content: Record<string, unknown>[] = [];
    for (const part of turn.content) {
      if (part.type === "text") {
        this.emitEvent("session.text.started", { sessionID: this.sessionID, assistantMessageID });
        this.emitEvent("session.text.ended", { sessionID: this.sessionID, assistantMessageID, text: part.text });
        content.push({ type: "text", text: part.text });
      } else if (part.type === "tool_use") {
        content.push(await this.playToolCall(part, assistantMessageID, index));
        if (this.interrupted || this.replaced) break;
      }
    }
    this.emitEvent("session.step.ended", {
      sessionID: this.sessionID,
      assistantMessageID,
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    this.store.push({
      id: assistantMessageID,
      type: "assistant",
      agent: "switchboard",
      model: { providerID: "switchboard", id: this.run.model.id },
      content,
      time: { created: NOW, completed: NOW },
    });
    this.emitMessages();
  }

  private toolContent(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    status: "completed" | "error" | "running",
    body: unknown,
  ): Record<string, unknown> {
    return {
      type: "tool",
      id: callId,
      name,
      state:
        status === "completed"
          ? { status, input, content: body as unknown[] }
          : status === "running"
            ? // A call in flight when the container was replaced: the store holds it
              // still running, so the rebuilt record projects an assistant turn with
              // the call and no result, and the settlement note stands in its place.
              { status, input }
            : {
                status,
                input,
                error: { type: "permission.rejected", message: String(body) },
                content: [{ type: "text", text: String(body) }],
              },
    };
  }

  private async playToolCall(
    part: ToolUse,
    assistantMessageID: string,
    turnIndex: number,
  ): Promise<Record<string, unknown>> {
    const firstTurn = turnIndex === 0;
    const callId = part.id;
    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as Record<string, unknown>;
    const ask = toolAsk(part.name, input);
    this.emitEvent("session.tool.input.started", {
      sessionID: this.sessionID,
      assistantMessageID,
      id: callId,
      name: ask.name,
    });
    this.emitEvent("session.tool.input.ended", {
      sessionID: this.sessionID,
      assistantMessageID,
      id: callId,
      text: JSON.stringify(input),
    });
    // The record clause switched off: the tool call never reaches the stream, so
    // the record loses its `tool_call` vocabulary.
    if (this.mutate !== "record")
      this.emitEvent("session.tool.called", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        input,
        executed: false,
      });

    // A tool the identity's deny rules removed: OpenCode fails it with no ask
    // because the tool was never there — the walls held, nothing ran.
    if (!this.offered.has(part.name)) {
      const message = `No tool named "${ask.name}" is currently available. Please use a tool from the available tool list.`;
      this.emitEvent("session.tool.failed", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        executed: false,
        error: { type: "tool.execution", message },
      });
      return this.toolContent(callId, ask.name, input, "error", message);
    }

    // A bypass (AE2): the tool runs with no ask the bot answered.
    if (firstTurn && this.script.bypassGate) {
      const content = [{ type: "text", text: ownToolResultText(part.name, input) }];
      this.emitEvent("session.tool.success", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        content,
        executed: true,
      });
      return this.toolContent(callId, ask.name, input, "completed", content);
    }

    const requestID = `per_${callId}`;
    const request = {
      id: requestID,
      sessionID: this.sessionID,
      action: ask.action,
      resources: ask.resources,
      source: { type: "tool", messageID: assistantMessageID, id: callId },
    };
    this.emitEvent("permission.asked", request);
    // The declared cannot: the model's shell forges a `once` under the real
    // request id before the bot's reply lands; the server runs the tool against
    // the bot's decision.
    if (firstTurn && this.script.forgeApproval) {
      this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID, reply: "once" });
      const content = [{ type: "text", text: ownToolResultText(part.name, input) }];
      this.emitEvent("session.tool.success", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        content,
        executed: true,
      });
      return this.toolContent(callId, ask.name, input, "completed", content);
    }
    this.emitPermissions([request]);
    const decision = await this.waitReply(requestID);
    this.emitPermissions([]);
    this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID, reply: decision.reply });
    // The container is replaced with this call in flight (survival's ceiling):
    // the bot decided, but the result never comes back — the server and the tool
    // die with the old container's disk. Leave the call open (a `running` tool
    // state, no success/failed event), so the bridge holds its span for the
    // replaced verdict's settlement; the play stops after this turn. The 1-based
    // model call that would carry this call's result is `containerReplaced…`, so
    // the call itself is the turn two before it.
    if (
      this.script.containerReplacedBeforeModelCall !== undefined &&
      turnIndex === this.script.containerReplacedBeforeModelCall - 2
    ) {
      this.replaced = true;
      return this.toolContent(callId, ask.name, input, "running", []);
    }
    // The platform's rollout with this call in flight (`deadWithoutWordBeforeModelCall`):
    // the same open call, the process dead without the word once the turn is played.
    if (
      this.script.deadWithoutWordBeforeModelCall !== undefined &&
      turnIndex === this.script.deadWithoutWordBeforeModelCall - 2
    ) {
      this.deadWithoutWord = true;
      return this.toolContent(callId, ask.name, input, "running", []);
    }
    // The gate clause switched off: a refused tool runs anyway (the bot's reject
    // is ignored), so a push to a protected branch is not stopped.
    if (decision.reply === "once" || this.mutate === "gate") {
      // A relayed tool runs in the bot exactly as the plugin's POST /harness/tool
      // would — the run's registration, its context, the bot's own gates. The
      // relay clause switched off returns a canned result, so the tool never
      // runs in the bot and its side effect never lands.
      const content =
        this.relayNames.has(part.name) && this.mutate !== "relay"
          ? await this.runRelay(callId, part.name, input)
          : [{ type: "text", text: ownToolResultText(part.name, input) }];
      this.emitEvent("session.tool.success", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        content,
        executed: true,
      });
      return this.toolContent(callId, ask.name, input, "completed", content);
    }
    const message = decision.message ?? "The user rejected permission to use this specific tool call.";
    this.emitEvent("session.tool.failed", {
      sessionID: this.sessionID,
      assistantMessageID,
      id: callId,
      executed: false,
      error: { type: "permission.rejected", message },
      content: [{ type: "text", text: message }],
    });
    return this.toolContent(callId, ask.name, input, "error", message);
  }

  /** The relayed tool run through the bot, as the plugin's POST /harness/tool
   *  would — the registered run's context, so its side effect lands. */
  private async runRelay(
    callId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<Array<{ type: string; text: string }>> {
    const live = this.deps.registry.get(this.run.runId);
    if (!live) return [{ type: "text", text: "the run is not on the relay" }];
    // The plugin asks `/harness/authorize` before `/harness/tool`: during the
    // run's write-up the LiveHarness's `toolsBlocked` refuses the call (the same
    // refusal pi's relay makes), and the tool never runs in the bot.
    const authorized = authorizeToolCall(live, { toolCallId: callId, tool, input });
    if (!authorized.allow) return [{ type: "text", text: authorized.reason }];
    const answer = await runRelayedTool(live, { toolCallId: callId, tool, input });
    const text = answer.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    return [{ type: "text", text: text || "(no output)" }];
  }
}

/** The store as the conversation the model saw (`ChatMessage[]`): a user
 *  message is a user turn; an assistant message is its text and tool calls, and
 *  a settled tool's result the user turn after it — projectStore's shape, for
 *  the model-call record. */
function storeToMessages(store: readonly Record<string, unknown>[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of store) {
    if (m.type === "user") {
      out.push({ role: "user", content: [{ type: "text", text: String(m.text ?? "") }] });
    } else if (m.type === "assistant") {
      const content: ContentPart[] = [];
      const results: ContentPart[] = [];
      for (const part of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []) {
        if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
        else if (part.type === "tool") {
          const state = (typeof part.state === "object" && part.state !== null ? part.state : {}) as Record<
            string,
            unknown
          >;
          content.push({
            type: "tool_use",
            id: String(part.id),
            name: openCodeToolNameWord(String(part.name)),
            input: (state.input as Record<string, unknown>) ?? {},
          });
          if (state.status === "completed" || state.status === "error") {
            const c = Array.isArray(state.content) ? (state.content as Record<string, unknown>[]) : [];
            results.push({
              type: "tool_result",
              toolUseId: String(part.id),
              content: c.map((p) => (p.type === "text" ? String(p.text) : "")).join("\n"),
              ...(state.status === "error" ? { isError: true } : {}),
            });
          }
        }
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      for (const r of results) out.push({ role: "user", content: [r] });
    }
  }
  return out;
}

function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The container's loopback as the harness sees it: this generation's launch
 *  answers on the free port; the port a row recorded for a dead generation's
 *  server answers as that server only when the script says it is still up
 *  (`processAliveOnResume`) — the same scripted serve in its `recorded` role —
 *  and refuses the connection otherwise, as the container answers for a port
 *  nothing listens on. The recorded server's feed is the dead generation's: the
 *  readiness notes, then whatever the fault names as written before the row's
 *  offset, then the in-flight call's records the recorded server seeds. */
function bindServes(
  container: FakeHarnessContainer,
  script: RunScript,
  live: ScriptedServe,
  recorded: ScriptedServe | undefined,
  options: FakeServeOptions,
): void {
  container.onRequest = (req) => {
    if (req.port === container.freePort) return live.onRequest(req);
    if (recorded !== undefined) return recorded.onRequest(req);
    throw new HarnessContainerError(
      "request",
      `curl: (7) Failed to connect to 127.0.0.1 port ${req.port}: Connection refused`,
    );
  };
  container.emit(...TAILER_READY_NOTES);
  for (const record of options.reattach?.feedBefore ?? []) container.emit(record);
  if (script.processAliveOnResume && script.resume?.facts !== undefined) {
    const facts = script.resume.facts;
    container.alivePids.add(facts.pid);
    if (facts.harness === "opencode" && facts.tailerPid !== undefined && !options.reattach?.tailerDead)
      container.alivePids.add(facts.tailerPid);
  }
  recorded?.seedFeed();
  for (const record of options.reattach?.feedAfter ?? []) container.emit(record);
  if (options.reattach?.feedUnreadable)
    container.failNext = {
      operation: "read",
      error: new HarnessContainerError("read", "tail: cannot open 'feed.jsonl' for reading: No such file or directory"),
    };
}

/** Plants the sentinel under the bot's provider-key variables for the run's
 *  dialect, so a harness that forwarded one would leak it into the child's env. */
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

export function openCodeDriver(options: FakeServeOptions = {}): HarnessDriver {
  const object = new OpenCodeHarness();
  return {
    harness: "opencode",
    object,
    bearer: BEARER,
    containerWord: CONTAINER_WORD,
    providerKeySentinel: PROVIDER_KEY_SENTINEL,
    cannot: {
      "gate-approval-unforgeable":
        "OpenCode's approval lives in its server, whose password the model's shell shares, so an effect the bot did not decide — a call with no ask, a reply the bot did not send, a reply that differs from the bot's, a success after the bot's refusal — is caught by detection and fails the run closed, never prevented by construction",
    },
    facts: (partial) => ({
      harness: "opencode",
      pid: partial.pid,
      port: RECORDED_PORT,
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
  container.freePort = PORT;
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
    // The survival clause switched off: the row's facts are never written.
    ...(options.mutate === "survival" ? {} : { saveFacts: (f: HarnessFacts) => void facts.push(f) }),
    ...(script.resume ? { resume: script.resume } : {}),
  };
  // The credential clause switched off: a provider key rides the server's
  // environment, the leak the credential row hunts for.
  if (options.mutate === "credential") {
    const origStart = container.start.bind(container);
    container.start = async (s) => {
      const started = await origStart(s);
      if (s.command === "opencode") {
        const last = container.starts.length - 1;
        container.starts[last] = {
          ...container.starts[last],
          env: { ...container.starts[last].env, ANTHROPIC_API_KEY: PROVIDER_KEY_SENTINEL },
        };
      }
      return started;
    };
  }
  const registry = options.registry ?? new HarnessRegistry();
  /** The run's clock: fixed, until a script spends the budget under a model call. */
  const clock = { now: NOW };
  const deps: HarnessDeps = {
    container,
    bearer: BEARER,
    harnessUrl: HARNESS_URL,
    registry,
    ...(options.bearers ? { bearers: options.bearers } : {}),
    clock: () => clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    pollMs: 1,
    tickMs: 5,
    finaleTimeoutMs: 60_000,
  };

  const harness = new OpenCodeHarness();
  const source = () => ({
    runId: run.runId,
    root: openCodeRunPaths(run.runId).dir,
    identity: run.agent.identity,
    tools: run.tools,
    model: run.model,
    system: run.system,
    maxTokens: run.agent.maxTokens,
    control: run.control,
  });
  const serveDeps: ServeDeps = {
    registry,
    sleep: deps.sleep,
    ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
    spendBudget: () => void (clock.now = NOW + run.agent.maxMinutes * 60_000 + 1),
  };
  const serve = new ScriptedServe(container, source, script, serveDeps, options);
  const recorded = script.processAliveOnResume
    ? new ScriptedServe(container, source, script, serveDeps, options, "recorded")
    : undefined;
  bindServes(container, script, serve, recorded, options);
  options.inspectContainer?.(container);

  const restore = plantProviderKeys(run.model.providerType);
  let outcome: DrivenRun["outcome"];
  try {
    const session = await openThroughSeam(harness, deps, run);
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
    // The row means "the run's process": OpenCode's server, not the tailer beside it.
    starts: container.starts.filter((s) => s.command === "opencode"),
    killed: container.killed,
    removed: container.removed,
    requests: container.requests,
    // The model's calls in the order they happened: the recorded server's (the session continued) before this generation's launch's.
    modelCalls: [...(recorded?.modelCalls ?? []), ...serve.modelCalls],
    statusReports,
  };
}

/** What `scriptOpenCodeServe` is handed: the row's script, the relay registry
 *  the run loop registers the run on, and the bearer store to meter each model
 *  call on (so the loop's rotation can be read off the meter, as pi's scripted
 *  double lets it); `options` are the serve's faults. */
export interface ScriptOpenCodeServeOptions {
  script: RunScript;
  registry: HarnessRegistry;
  bearers?: RunBearerStore;
  options?: FakeServeOptions;
}

/** The scripted serve bound to a bare container, for a run the RUN LOOP opens
 *  through `containerFor`: nothing of the run exists when the container is
 *  handed over, so the serve learns it at its first request — the run id from
 *  the `opencode` start's environment (the launch sets `SWITCHBOARD_RUN_ID`),
 *  the relayed tools and the identity from the relay registration the harness
 *  makes before it launches (`registry.get(runId)`), the model, the system
 *  prompt and the token cap from the configuration the launch wrote under the
 *  run's root. The tailer's readiness notes are written at bind, as a
 *  subscribed tailer would have written them. The same `ScriptedServe` as the
 *  conformance driver's, through a second door. */
export function scriptOpenCodeServe(
  container: FakeHarnessContainer,
  opts: ScriptOpenCodeServeOptions,
): ScriptedOpenCode {
  const source = (): ServeRun => {
    const start = container.starts.find((st) => st.command === "opencode");
    if (start === undefined)
      throw new Error("the scripted serve was asked before the launch: no opencode start on the container");
    const runId = start.env.SWITCHBOARD_RUN_ID;
    if (runId === undefined)
      throw new Error("the opencode start names no run: SWITCHBOARD_RUN_ID is missing from its environment");
    const live = opts.registry.get(runId);
    if (live === undefined)
      throw new Error(`the run ${runId} is not registered on the relay: the harness registers before it launches`);
    const root = openCodeRunPaths(runId).dir;
    const config = JSON.parse(container.files.get(openCodeRunPathsAt(root).config) ?? "{}") as {
      model?: string;
      providers?: Record<string, { models?: Record<string, { limit?: { output?: number } }> }>;
      agents?: Record<string, { system?: string }>;
    };
    const modelRef = config.model ?? "";
    const id = modelRef.slice(modelRef.indexOf("/") + 1);
    const provider = Object.values(config.providers ?? {})[0];
    return {
      runId,
      root,
      identity: live.rules.identity,
      tools: live.tools,
      model: { id },
      system: config.agents?.[OPENCODE_AGENT]?.system,
      maxTokens: provider?.models?.[id]?.limit?.output ?? 0,
    };
  };
  const serve = new ScriptedServe(
    container,
    source,
    opts.script,
    {
      registry: opts.registry,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
      tickMs: 5,
      ...(opts.bearers ? { bearers: opts.bearers } : {}),
    },
    opts.options,
  );
  bindServes(container, opts.script, serve, undefined, opts.options ?? {});
  return serve;
}
