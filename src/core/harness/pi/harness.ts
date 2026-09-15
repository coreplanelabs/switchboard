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
// comes back after a bot restart re-attaches to its pi where it still runs, at
// the root the row recorded, or restarts pi on a session rebuilt from the
// mirrored transcript.

import type { AgentDef } from "../../../agents/registry.js";
import type { PiCompactionConfig } from "../../../config.js";
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
import { bearerHashOf, type RunBearerStore } from "../../modelProxy/runBearers.js";
import { redactAndCap, redactSecrets, type RunEvent, type RunNoteKind, type StopMode } from "../../runEvents.js";
import type { Settlement } from "../../runLedger/resume.js";
import type { AssembledCompaction } from "../../runLedger/transcript.js";
import type { Notepad } from "../../runLedger/types.js";
import type { RunControl } from "../../runRegistry/runControl.js";
import { followUpPrompt, followUpSnippet, type FollowUpInbox, type FollowUpInput } from "../../threadAdmission.js";
import type { Backend } from "../../trace/attrs.js";
import type { Clock, Span } from "../../trace/types.js";
import { PiBridge } from "./bridge.js";
import type { PiContainer } from "./container.js";
import { PiMirror, piSessionFile } from "./mirror.js";
import {
  piLaunchArgs,
  piLaunchEnv,
  piLaunchFiles,
  piRunPathsAt,
  type PiLaunchSpec,
  type PiRunPaths,
} from "./process.js";
import { parsePiLine } from "./protocol.js";
import type { HarnessRegistry, LiveHarness, RelayedToolAnswer } from "./relay.js";
import type { ToolRuleContext } from "./toolRules.js";
import { PiRpcTransport } from "./transport.js";

/** What a run's row remembers about its pi, so the next bot generation finds it (harness-pi item 8). */
export interface PiHarnessFacts {
  pid: number;
  /** The log byte the next read starts at. */
  logOffset: number;
  /** pi's session file, once `get_state` named it. */
  sessionFile?: string;
  /** The directory pi was filed under by the build that started it, so the
   *  build that comes back after a restart reads the log and feeds the FIFO
   *  there whatever root it would choose for a run of its own. Absent on a
   *  row written before the root was recorded: that pi cannot be found, so it
   *  is ended and a fresh one started (harness-pi item 8). */
  root?: string;
  /** The SHA-256 (hex) of the secret in the bearer pi was started with
   *  (`bearerHashOf`; model-proxy item 2) — never the bearer. The generation
   *  that re-attaches adopts it onto its own proxy, so the calls pi keeps
   *  making with the previous generation's bearer verify. Absent on a row
   *  written before it was recorded: that pi's calls no proxy here can honour,
   *  so it is ended and a fresh one started with this generation's bearer. */
  bearerHash?: string;
  /** The identity of the container pi runs in (`PiContainer.identity`), so a
   *  generation handed another container reads "pi is elsewhere", never "pi
   *  is dead", and probes or ends nothing at that pid there. Absent on a row
   *  written before it was recorded, or on a container that cannot name
   *  itself: the pid alone is then judged, as before. */
  container?: string;
}

/** The harness facts a previous generation wrote on the row (`state.harness`),
 *  when they have the shape this build reads; anything else is no facts. */
export function piHarnessFactsOf(value: unknown): PiHarnessFacts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.pid !== "number" || typeof v.logOffset !== "number") return undefined;
  return {
    pid: v.pid,
    logOffset: v.logOffset,
    ...(typeof v.sessionFile === "string" ? { sessionFile: v.sessionFile } : {}),
    ...(typeof v.bearerHash === "string" ? { bearerHash: v.bearerHash } : {}),
    ...(typeof v.root === "string" ? { root: v.root } : {}),
    ...(typeof v.container === "string" ? { container: v.container } : {}),
  };
}

export interface PiHarnessResume {
  /** The transcript the ledger held, as `planResume` assembled it. */
  messages: ChatMessage[];
  /** pi's compaction entries among those messages (session-log item 6), rendered
   *  where they sat so the restarted pi's window is what pi had, not the raw
   *  turns compacted again. Absent on a plan from before the log kept them. */
  compactions?: AssembledCompaction[];
  /** The calls in flight at the kill; under pi none is re-run — its effects
   *  are the container's. A restarted pi reads each one's restart note as a
   *  tool result in its rebuilt session; a re-attached pi's extension, still
   *  asking for the call the dead generation never answered, is answered the
   *  same note over the relay (item 8). */
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
  /** The session's notepad as the `notes` tool last wrote it (session-log item
   *  10), read when pi compacts so the steer that follows carries it; absent
   *  for a run without a session, and the steer says the notes are empty. */
  notepad?: () => Promise<Notepad | null>;
  /** The run's conversation as its session log holds it (session-log item 3),
   *  read at the call: what the relayed `spawn_run` hands `spawnChild` as the
   *  child's seed (agent-conductor item 3), since pi keeps the transcript in
   *  its own process and the bot's copy is the mirror's rows on the ledger.
   *  Absent for a run without a session: a child then starts from its thread. */
  conversation?: () => Promise<readonly ChatMessage[]>;
  backend?: Backend;
  span?: Span;
  control?: RunControl;
  inbox?: FollowUpInbox;
  /** A steered follow-up's staged files (record 0033): awaited before the steer is sent, so the
   *  files are copied into the store and pulled into the container's workspace first; the line
   *  it answers with (the attachments line, or empty) ends the steer's text. Bound by the loop
   *  only when the deployment configures a store — absent, the steer is sent as it always was. */
  stageFollowUps?: (inputs: readonly FollowUpInput[]) => Promise<string>;
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
  /** The deployment's compaction thresholds for pi's settings (`pi.compaction`;
   *  harness-pi item 4), the same for every run on pi; absent, pi's defaults. */
  compaction?: PiCompactionConfig;
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
/** How long a relayed request waits for the bridge to read its call's start off
 *  the log (`LiveHarness.callSeen`): a few polls of the transport, counted in
 *  ticks of the harness's own sleep so a fixed clock cannot stall it. */
const CALL_SEEN_WAIT_MS = 3_000;
const CALL_SEEN_TICK_MS = 50;
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
/** The steer pi is sent after a compaction (session-log item 10): the notepad
 *  as it stands — or that it is empty and how to keep one, or that it could
 *  not be read just now — and that every earlier turn is still within reach. */
export function compactionSteer(notepad: string | undefined, opts: { unavailable?: boolean } = {}): string {
  const notes = notepad?.trim();
  const reach =
    "Your context was just compacted: the summary now standing in for the earlier turns is pi's, and every one of " +
    "those turns is still reachable with the `recall` tool (search by words, or read a turn by its number).\n\n";
  if (opts.unavailable)
    return (
      reach +
      "Your notes for this thread could not be read just now; `notes {}` reads them on demand, and `notes { text }` still writes them."
    );
  return (
    reach +
    (notes
      ? `YOUR NOTES FOR THIS THREAD, as you last wrote them with \`notes\`:\n${notes}`
      : "Your notes for this thread are empty. Write them with the `notes` tool when you have decisions, the names of things " +
        "you found and what is not yet proven worth keeping — they survive every compaction and reach the next run in this thread.")
  );
}

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

/** The restart note a call in flight at the kill is answered with: pi ran the
 *  tool in the container and its result died with the bot's view of it, so
 *  every one reads as the ledger's restart result — never re-run from here. A
 *  synthetic settlement carries its own words. */
export function settlementText(s: Settlement): string {
  return s.action === "synthetic"
    ? s.text
    : `The bot restarted while this ${s.toolUse.name} call was in flight; its result was lost — re-check its effects before re-running it.`;
}

/** The settlements as the user turn a rebuilt session ends on (item 8): one error tool result per call in flight. */
export function settlementResults(settlements: Settlement[]): ChatMessage | undefined {
  if (settlements.length === 0) return undefined;
  return {
    role: "user",
    content: settlements.map((s) => ({
      type: "tool_result" as const,
      toolUseId: s.toolUse.id,
      content: settlementText(s),
      isError: true as const,
    })),
  };
}

/** The same note as the relay's answer (item 8): what a re-attached pi's extension reads when it asks again for the call. */
export function settlementAnswer(s: Settlement): RelayedToolAnswer {
  return { content: [{ type: "text", text: settlementText(s) }], isError: true };
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
  const bridge = new PiBridge({
    emit,
    onProgress: run.onProgress,
    agentSpan,
    clock,
    textFailing: new Set(run.tools.filter((t) => t.failsInText).map((t) => t.name)),
  });
  // Where pi's files are: the root the row recorded for a pi another build
  // started (the re-attach below), else the root the container makes for a
  // fresh start (`makeRoot`: the exec container's predictable one, the bot
  // host's own). Nothing is filed before one of the two is known.
  let paths: PiRunPaths | undefined;
  const remainingMs = run.resume?.remainingMs ?? run.agent.maxMinutes * 60_000;
  const deadline = now() + remainingMs;
  const warnAt = deadline - Math.min(3 * 60_000, run.agent.maxMinutes * 15_000);
  run.toolContext.remainingMs = () => deadline - now();
  // The conversation the run's tools read (agent-conductor item 3): the native
  // loop hands its own array; here it is the session log's rows, so a read the
  // ledger cannot answer costs the child its seed, never the spawn: the tool
  // is told there is none, and the record says why.
  if (run.conversation) {
    const readConversation = run.conversation;
    run.toolContext.conversation = async () => {
      try {
        return await readConversation();
      } catch (err) {
        emit({
          type: "run_note",
          kind: "seed",
          summary: redactAndCap(
            `the conversation could not be read from the session log for a child's seed (${err instanceof Error ? err.message : String(err)}); a child spawned now starts from its own thread`,
            300,
          ),
        });
        return undefined;
      }
    };
  }
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
    callSeen: async (callId) => {
      for (let waited = 0; !bridge.callOpen(callId) && waited < CALL_SEEN_WAIT_MS; waited += CALL_SEEN_TICK_MS)
        await deps.sleep(CALL_SEEN_TICK_MS);
    },
  };
  const forget = deps.registry.register(live);
  // A call the row says was in flight when the bot died is answered from the
  // record if pi asks the relay for it again (item 8): a re-attached pi's
  // extension does, with the call id whose answer died with the previous
  // generation; a pi restarted on the mirrored transcript never does — its
  // session file carries the same note. Settled before anything is awaited, so
  // no ask can start the tool between the registration and here.
  const calls = deps.registry.calls(run.runId);
  for (const s of run.resume?.settlements ?? []) calls?.settle(s.toolUse.id, settlementAnswer(s));

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
    // The container's pi outlived the bot when its pid answers and the row
    // says where it was filed: the re-attach reads its log and feeds its FIFO
    // there, whatever root this build files a fresh run under. A row without
    // a root (written before the root was recorded) names a pi this build
    // cannot find: it is ended where it runs and a fresh pi starts below, as
    // after a death. A dead pi's root, when known and not the one the fresh
    // start is filed under, goes with it (below).
    const recorded = run.resume?.facts;
    let reattached = false;
    /** Why a live pi was ended here for the fresh start: the row named no
     *  root for it, or carried no bearer this generation could honour. */
    let ended: string | undefined;
    /** The row's pi runs in another container than this run was handed: it
     *  is named by pid and container, and neither probed nor ended here: a
     *  pid in this container is a stranger's. */
    let elsewhere: string | undefined;
    // Which container this is, asked once: compared with the row's word on a
    // resume, recorded on the facts of every pi started here.
    const here = await container.identity();
    /** The bearer pi holds is the one the generation that started it revealed
     *  (model-proxy item 2): this generation's proxy honours it only once the
     *  hash the row carries joins the run's entry — the entry this generation
     *  minted before coming here. Without a store nobody verifies, so nothing
     *  needs adopting. */
    const honoured = (hash: string | undefined): boolean =>
      hash !== undefined && (deps.bearers === undefined || deps.bearers.adopt(run.runId, hash));
    if (recorded !== undefined) {
      if (recorded.container !== undefined && here !== undefined && recorded.container !== here) {
        elsewhere = `pi is elsewhere: the row's pi (pid ${recorded.pid}) ran in container ${recorded.container}, not the one this run was handed (${here}), so it was neither probed nor ended here`;
      } else {
        const alive = await container.alive(recorded.pid);
        if (alive && recorded.root !== undefined && honoured(recorded.bearerHash)) {
          reattached = true;
          paths = piRunPathsAt(recorded.root);
        } else if (alive) {
          ended =
            recorded.root === undefined
              ? "named no directory for its pi"
              : "carried no bearer this generation could honour for its pi";
          await container.kill(recorded.pid).catch(() => {});
        }
      }
    }
    if (reattached && recorded && paths !== undefined) {
      pid = recorded.pid;
      // The row learns the container it was found in, when it did not say.
      facts = { ...recorded, ...(recorded.container === undefined && here !== undefined ? { container: here } : {}) };
      transport = new PiRpcTransport({
        container,
        paths,
        pid,
        pollMs: deps.pollMs ?? 750,
        sleep: deps.sleep,
        offset: recorded.logOffset,
      });
      catchingUp = true;
      const inFlight = run.resume?.settlements.length ?? 0;
      note(
        "resumed",
        `resumed after a restart: pi still runs in the container (pid ${pid}); continuing its session with ${Math.round(remainingMs / 60_000)} min of budget left` +
          (inFlight > 0
            ? ` — ${inFlight} call(s) were in flight, each answered with a restart note if pi asks for it again`
            : ""),
      );
    } else {
      // The fresh start's root is the container's to make; a dead pi's
      // recorded root, when it is another, goes with it.
      paths = await container.makeRoot(run.runId);
      // A dead pi's root elsewhere on THIS container goes; a pi in another
      // container left nothing here to remove.
      if (recorded?.root !== undefined && recorded.root !== paths.dir && elsewhere === undefined)
        await container.remove(piRunPathsAt(recorded.root)).catch(() => {});
      const spec: PiLaunchSpec = {
        runId: run.runId,
        paths,
        model: { id: run.model.id, providerType: run.model.providerType, maxTokens: run.agent.maxTokens },
        harnessUrl: deps.harnessUrl,
        ...(run.effort ? { effort: run.effort } : {}),
        identity: run.agent.identity,
        system: run.system,
        relayTools: run.tools.map((t) => t.name),
        ...(deps.compaction ? { compaction: deps.compaction } : {}),
      };
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
        // The session's working directory is where THIS pi runs, the
        // container's answer for the root just made: pi refuses a session
        // whose stored directory does not exist where it runs, and the bot
        // host has no checkout and a new root in each generation (item 12).
        await container.writeFile(
          sessionPath,
          piSessionFile(
            session.messages,
            {
              cwd: container.cwd(paths, run.rules.checkout),
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
        const how =
          elsewhere !== undefined
            ? `${elsewhere}, and pi restarted`
            : ended !== undefined && recorded !== undefined
              ? `the row ${ended} (pid ${recorded.pid}), so it was ended and pi restarted`
              : "pi restarted";
        note(
          "resumed",
          `resumed after a restart: ${how} on the mirrored transcript — ${lost} call(s) were in flight, each answered with a restart note; ${Math.round(remainingMs / 60_000)} min of budget left`,
        );
      }
      const launch = sessionPath ? { ...spec, sessionPath } : spec;
      for (const file of piLaunchFiles(launch)) await container.writeFile(file.path, file.content);
      ({ pid } = await container.start({ paths, args: piLaunchArgs(launch), env: piLaunchEnv(launch, deps.bearer) }));
      // The root rides the first facts, so the build that comes back after a
      // restart looks for this pi where it is, not where it would file its own;
      // the bearer's hash rides beside it, so that build's proxy can honour
      // the bearer this pi keeps presenting (model-proxy item 2).
      const bearerHash = bearerHashOf(deps.bearer);
      facts = {
        pid,
        logOffset: 0,
        root: paths.dir,
        ...(bearerHash !== undefined ? { bearerHash } : {}),
        ...(here !== undefined ? { container: here } : {}),
      };
      save();
      transport = new PiRpcTransport({ container, paths, pid, pollMs: deps.pollMs ?? 750, sleep: deps.sleep });
    }

    transport.send({ id: "retry", type: "set_auto_retry", enabled: false });
    transport.send({ id: "state", type: "get_state" });
    if (reattached)
      // The pi found alive may be inside a tool call — its extension waiting on
      // the relay for the answer the dead generation never sent — and pi
      // refuses a plain `prompt` while its loop runs ("Agent is already
      // processing"), a refusal that failed the run and ended pi. Queued as a
      // steer, the continue lands after the call as the next user turn; an
      // idle pi (a model call failed while the bot was away, the loop ended)
      // takes the same command as the prompt it is. The row cannot tell the
      // two apart — its calls in flight name both — so pi decides.
      transport.send({ id: "prompt", type: "prompt", message: CONTINUE_PROMPT, streamingBehavior: "steer" });
    else if (run.resume) transport.send({ id: "prompt", type: "prompt", message: CONTINUE_PROMPT });
    else transport.send({ id: "prompt", type: "prompt", ...promptOf(run.messages) });

    let warned = false;
    let settled = false;
    let stopMode: StopMode | undefined;
    const startWriteUp = (kind: WriteUp, instruction: string) => {
      writeUp = kind;
      writeUpAt = now();
      transport!.send({ type: "steer", message: instruction });
    };
    // Steers go out in the order their follow-ups were drained: the staging of one
    // batch (a copy into the store, a pull over the container) is awaited before
    // its steer is sent, and the next batch queues behind it, so a second drop is
    // never steered ahead of the first. The queue is `check`'s only asynchronous
    // work; `check` itself stays synchronous for the event loop below.
    let steers: Promise<void> = Promise.resolve();
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
      steers = steers.then(async () => {
        // The staged files land before pi reads the steer that names them — the
        // native loop's order (src/runner.ts `drainFollowUps`). A hook that throws
        // (a store the bot cannot reach) still steers the words, saying so, rather
        // than dropping the person's message on the floor.
        let stagedLine = "";
        if (run.stageFollowUps) {
          try {
            stagedLine = await run.stageFollowUps(inputs);
          } catch (err) {
            stagedLine = `Attached files could not be staged: ${err instanceof Error ? err.message : String(err)}`;
            note("follow_up", `staging the follow-up's files failed: ${redactSecrets(stagedLine)}`);
          }
        }
        if (settled) return;
        const prompt = followUpPrompt(inputs);
        transport!.send({
          type: "steer",
          message: stagedLine ? `${prompt}\n\n${stagedLine}` : prompt,
          ...(images.length > 0 ? { images } : {}),
        });
      });
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
          facts = { ...(facts ?? { pid: pid!, logOffset: 0, root: paths.dir }), sessionFile: String(data.sessionFile) };
          save();
        }
        if (r.id === "prompt") {
          catchingUp = false;
          if (r.success === false) throw new PromptRefused(String(r.error ?? "no reason"));
        }
      }
      if (obs.message) await mirror.onMessage(obs.message, bridge.turns);
      if (obs.compaction) {
        await mirror.onCompaction(obs.compaction, bridge.turns);
        // The notepad's second read point (session-log item 10): after every
        // compaction, at pi's next turn boundary, unless the run is winding
        // down or this is history a re-attach is catching up on. pi compacts
        // after a tool batch and before its next response, so the steer lands
        // one response late; the summary and the newest turns cover that one.
        if (!writeUp && !hardStopped && !catchingUp) {
          // The steer is advisory: a notepad read that fails — a ledger blip,
          // a Worker without the route — costs the steer its notes, never the run.
          let notepad: string | undefined;
          let unavailable = false;
          try {
            notepad = run.notepad ? (await run.notepad())?.text : undefined;
          } catch (err) {
            unavailable = true;
            note(
              "harness_error",
              `the notepad could not be read for the compaction steer (${err instanceof Error ? err.message : String(err)}); steered without it`,
            );
          }
          transport.send({ type: "steer", message: compactionSteer(notepad, { unavailable }) });
        }
      }
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
    // The run's directory goes with the run: pi has ended, and nothing reads
    // its log, session or FIFO again — a later run in the thread seeds from
    // the record, and a resume that finds pi alive belongs to a generation
    // that never reached this line. Best-effort, like the kill.
    if (paths !== undefined) await container.remove(paths).catch(() => {});
    agentSpan?.end(hardStopped || bypass ? "error" : "ok");
  }
}
