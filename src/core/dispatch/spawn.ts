// The spawn stage of the dispatch pipeline (docs/reference/specs/routing-and-config.md
// item 20; docs/reference/specs/thread-admission.md item 6;
// docs/reference/specs/agent-conductor.md): how one run starts another.
// `spawnChild()` is the ONE path a child run is born through, and the one
// orchestrator stays `dispatch()` (docs/decisions/0002-dispatcher-is-the-only-orchestrator.md):
// a child is a `dispatch()` run as the requesting user — the parent's user, in
// the parent's channel — in a thread the parent's channel opens for it, with
// `DispatchOptions.parent` naming the parent, the child's depth and the wall
// clock the parent had left. What this stage decides for itself it refuses by
// name before anything is opened: a child cannot spawn (`spawn_depth`), a
// parent with under two minutes left has no budget to hand on
// (`spawn_budget`), a parent at `spawn.maxChildren` live children waits
// (`spawn_fanout`), a channel with no thread to open has no child
// (`spawn_unsupported`). Everything else — the agent gate, the profile gate,
// admission, the repository gates — is the pipeline's, asked of the child as
// of any request (docs/decisions/0007-authorization-policy-table.md: a child is
// authorized like any run), and a refusal there reaches the parent as the tool
// result naming the gate, never as a child.
//
// The stage names no orchestrator: `dispatch()` is injected, and the
// dependency slice it reads is declared here (`SpawnCoreDeps`), so a program
// that types this file — the dashboard's `vue-tsc` types every core module the
// run tools reach — never pulls the dispatcher in behind it.
import type { ConfigStore } from "../../config.js";
import { MIN_BOUNDARY_MINUTES } from "../../config/validate.js";
import type { RunsReadCapability, SteerCapability } from "../../tools/runs.js";
import { resolveChatActor } from "../authz/actor.js";
import type { LedgerWriteThrough } from "../runLedger/writeThrough.js";
import type { RunRegistry } from "../runRegistry.js";
import type { RunControl } from "../runRegistry/runControl.js";
import type { RunStore } from "../runStore.js";
import { createRunsService, type RunsService } from "../runsService.js";
import type { FollowUpInbox, ThreadAdmission } from "../threadAdmission.js";
import type { Clock } from "../trace/types.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { defaultAdmission, steerRun, type DispatchFollowUp } from "./admission.js";
import { waitCapabilityFor, type WaitCapability } from "./awaitChildren.js";
import type { DispatchOutcome } from "./outcome.js";

/** The `spawn` block of `config.yaml` (docs/reference/specs/agent-conductor.md item 5). */
export interface SpawnConfig {
  /** The most children one run may have live at once (default 3, at least 1);
   *  a spawn past it is refused until one finishes. */
  maxChildren?: number;
}

export const DEFAULT_MAX_CHILDREN = 3;

/** The fan-out cap in force: the knob, or the default. */
export function maxChildrenOf(cfg: SpawnConfig | undefined): number {
  return cfg?.maxChildren ?? DEFAULT_MAX_CHILDREN;
}

/** How deep a tree goes: a run a person started is depth 0, its children are
 *  depth 1, and a child cannot spawn — the fan-out's cost has one bound. */
export const MAX_SPAWN_DEPTH = 1;

/** What a parent asks for: the preset the child runs, the prompt it is
 *  handed (everything it needs — it sees none of the parent's thread), the
 *  repository a repository preset works in, and a narrower budget. */
export interface SpawnRequest {
  preset: string;
  prompt: string;
  repo?: string;
  /** Whole minutes, at least 2: the child's `budget:` directive. */
  budget?: number;
}

/** What `dispatch()` is told about a child's parent (`DispatchOptions.parent`):
 *  the run that spawned it, the child's own depth, and the wall clock the
 *  parent had left at the spawn — the child's effective profile takes it as one
 *  more boundary (`boundedBy: "parent"`). */
export interface ParentRun {
  runId: string;
  depth: number;
  remainingMs: number;
}

/** The parent as the spawn sees it: the run's identity and clock, the preset
 *  its thread lead names, the request whose user and channel the child acts as,
 *  and the channel handle the child's thread is opened through. */
export interface SpawnParent extends ParentRun {
  agentName: string;
  msg: IncomingMessage;
  io: ChannelIO;
}

/** How a spawn ended: the child registered — its run id, its thread and a
 *  link to it — or a refusal by name with the text the child's thread (or the
 *  stage itself) said. `reason` is `spawn_depth`, `spawn_budget`,
 *  `spawn_fanout`, `spawn_unsupported`, `spawn_failed`, or a gate's own
 *  `dispatch.refuse` name (`agent_allowlist`, `profile_bounded`, …) relayed. */
export type SpawnOutcome =
  | { kind: "spawned"; runId: string; threadKey: string; url?: string }
  | { kind: "refused"; reason: string; message: string };

/** The registry as the stage reads it: a parent's live children, for the fan-out cap. */
export interface SpawnRegistry {
  listActive(): ReadonlyArray<{ id: string; finished: boolean; parentRunId?: string }>;
}

/** The slice of the dispatcher's dependency bag the stage and the run tools'
 *  capabilities read: the config (the fan-out knob, the requester's grants,
 *  the allowlist a steer passes), the run store and service the reads go
 *  through, the ledger and admission map a steer pushes into, the clock.
 *  `CoreDeps` satisfies it; the stage never names `CoreDeps`. */
export interface SpawnCoreDeps {
  config: Pick<ConfigStore, "config" | "grantsFor" | "canRunAgent">;
  runStore: RunStore;
  runs?: RunsService;
  runLedger: Pick<LedgerWriteThrough, "pushInbox">;
  admission?: ThreadAdmission<DispatchFollowUp>;
  clock?: Clock;
}

/** What the spawn needs: the dependency bag `dispatch()` runs the child with
 *  (`D`: the caller's whole bag, which satisfies `SpawnCoreDeps`), `dispatch()`
 *  itself — injected, so the stage names no orchestrator of its own and a test
 *  hands it a double — the registry the fan-out cap counts on, the clock the
 *  child's `receivedAt` reads, and a hook for how a child that registered
 *  ended: the parent's capability remembers it, so a refusal at a gate after
 *  registration is still readable. */
export interface SpawnDeps<D extends SpawnCoreDeps = SpawnCoreDeps> {
  core: D;
  dispatch: (deps: D, msg: IncomingMessage, io: ChannelIO, opts?: { parent?: ParentRun }) => Promise<DispatchOutcome>;
  registry: SpawnRegistry;
  clock: () => number;
  onChildEnded?: (child: { runId: string; threadKey: string }, outcome: DispatchOutcome) => void;
}

/** The child's request text: the preset directive, a `budget:` directive when
 *  the parent narrowed it, the repository as `in <owner/name>:` for a preset
 *  that works in one, then the prompt — the message the requester would have
 *  typed by hand. */
export function childRequestText(request: SpawnRequest): string {
  const directives = [`agent:${request.preset}`, ...(request.budget !== undefined ? [`budget:${request.budget}`] : [])];
  const repo = request.repo !== undefined ? ` in ${request.repo}:` : "";
  return `${directives.join(" ")}${repo} ${request.prompt}`;
}

/** The lead the parent's channel posts to start the child's thread: the child's
 *  preset, the requester, the parent (linked when its thread has a link), and
 *  the prompt's first line — what a reader in the channel needs to know why a
 *  new thread appeared. */
export function childThreadLead(parent: Pick<SpawnParent, "agentName" | "msg">, request: SpawnRequest): string {
  const who = parent.msg.userName ?? parent.msg.userId;
  const from =
    parent.msg.sourceUrl !== undefined
      ? `[the *${parent.agentName}* run](${parent.msg.sourceUrl})`
      : `the *${parent.agentName}* run`;
  const line = (request.prompt.split("\n")[0] ?? "").trim();
  const snippet = line.length > 140 ? `${line.slice(0, 137)}…` : line;
  return `↳ *${request.preset}* run for ${who}, spawned by ${from}: ${snippet}`;
}

/** The channel's platform prefix (`slack`, `http`, `mcp`, `cli`; AGENTS.md
 *  invariant 4), for a refusal that names the channel that cannot open a thread. */
function platformOf(channelId: string): string {
  const colon = channelId.indexOf(":");
  return colon > 0 ? channelId.slice(0, colon) : "requesting";
}

/** The child's channel: the opened thread's handle with two ears on it — the
 *  registration (`runStarted`, the moment the spawn is a run) and every reply
 *  (a gate's refusal is the last one before the dispatch ends). Delegation by
 *  method, never a spread: the adapter's IO is a class instance. */
function watchedChild(
  io: ChannelIO,
  on: { started: (id: string) => void; replied: (text: string) => void },
): ChannelIO {
  const watched: ChannelIO = {
    reply: async (text) => {
      on.replied(text);
      await io.reply(text);
    },
    status: (initial) => io.status(initial),
    history: () => io.history(),
    runStarted: (started) => {
      io.runStarted?.(started);
      on.started(started.id);
    },
  };
  if (io.attach) watched.attach = (file) => io.attach!(file);
  if (io.runFinished) watched.runFinished = (receipt) => io.runFinished!(receipt);
  if (io.openThread) watched.openThread = (lead) => io.openThread!(lead);
  return watched;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Start a child run as the requesting user (docs/reference/specs/routing-and-config.md
 * item 20). Refuses depth, budget and fan-out before anything is opened, then
 * asks the parent's channel for a thread, builds the child's message — the
 * parent's user and channel, the opened thread, the preset directive plus the
 * prompt, `receivedAt` from the clock — and hands it to `dispatch()` with
 * `parent` set. Resolves the moment the child is REGISTERED (its row exists
 * on every surface; the parent has an id to ask after) or the moment the
 * dispatch ended without a run — a gate's refusal, relayed by name with the
 * reply the child's thread saw. The child's dispatch runs on in the process
 * (counted in flight like any run); how it ends reaches `onChildEnded`.
 */
export async function spawnChild<D extends SpawnCoreDeps>(
  deps: SpawnDeps<D>,
  parent: SpawnParent,
  request: SpawnRequest,
): Promise<SpawnOutcome> {
  const refused = (reason: string, message: string): SpawnOutcome => ({ kind: "refused", reason, message });
  if (parent.depth >= MAX_SPAWN_DEPTH) {
    return refused(
      "spawn_depth",
      `a child run cannot spawn: this run is itself a child, and a tree is ${MAX_SPAWN_DEPTH} level deep — the run that started it is the one to ask`,
    );
  }
  const minutesLeft = Math.floor(parent.remainingMs / 60_000);
  if (minutesLeft < MIN_BOUNDARY_MINUTES) {
    return refused(
      "spawn_budget",
      `this run has under ${MIN_BOUNDARY_MINUTES} minutes left — too little to hand a child, which could never run a command in it; wrap up instead`,
    );
  }
  const live = deps.registry.listActive().filter((s) => !s.finished && s.parentRunId === parent.runId).length;
  const cap = maxChildrenOf(deps.core.config.config.spawn);
  if (live >= cap) {
    return refused(
      "spawn_fanout",
      `${live} child run${live === 1 ? " is" : "s are"} live already — the cap is ${cap} (\`spawn.maxChildren\`); wait for one to finish before spawning another`,
    );
  }
  if (!parent.io.openThread) {
    return refused(
      "spawn_unsupported",
      `the ${platformOf(parent.msg.channelId)} channel cannot open a thread of its own, so a child run cannot be spawned from it`,
    );
  }
  // A channel that could not open the thread (a Slack answer without a `ts`,
  // a transport failure) is a spawn that failed, by name — never a throw into
  // the parent's tool call.
  let opened: Awaited<ReturnType<NonNullable<ChannelIO["openThread"]>>>;
  try {
    opened = await parent.io.openThread(childThreadLead(parent, request));
  } catch (err) {
    return refused("spawn_failed", `the channel could not open the child's thread: ${describe(err)}`);
  }
  const child: IncomingMessage = {
    channelId: parent.msg.channelId,
    userId: parent.msg.userId,
    ...(parent.msg.userName !== undefined ? { userName: parent.msg.userName } : {}),
    ...(parent.msg.channelName !== undefined ? { channelName: parent.msg.channelName } : {}),
    threadKey: opened.thread.threadKey,
    ...(opened.thread.sourceUrl !== undefined ? { sourceUrl: opened.thread.sourceUrl } : {}),
    text: childRequestText(request),
    receivedAt: deps.clock(),
  };
  let startedId: string | undefined;
  let lastReply: string | undefined;
  let resolveStarted!: (id: string) => void;
  const started = new Promise<string>((resolve) => {
    resolveStarted = resolve;
  });
  const io = watchedChild(opened.io, {
    started: (id) => {
      startedId = id;
      resolveStarted(id);
    },
    replied: (text) => {
      lastReply = text;
    },
  });
  const settled = deps
    .dispatch(deps.core, child, io, {
      parent: { runId: parent.runId, depth: parent.depth + 1, remainingMs: parent.remainingMs },
    })
    .then(
      (outcome) => ({ kind: "ended" as const, outcome }),
      (err: unknown) => ({ kind: "threw" as const, err }),
    );
  // A child that registered ends later, on its own: its outcome reaches the
  // parent's capability; a throw after registration is a log line, never an
  // unhandled rejection (the child's own reply path told its thread).
  void settled.then((end) => {
    if (end.kind === "threw") {
      console.error(`[spawn] ${parent.msg.threadKey} child ${child.threadKey} threw: ${describe(end.err)}`);
      return;
    }
    if (startedId !== undefined) deps.onChildEnded?.({ runId: startedId, threadKey: child.threadKey }, end.outcome);
  });
  const first = await Promise.race([started.then((id) => ({ kind: "started" as const, id })), settled]);
  if (first.kind === "started" || startedId !== undefined) {
    const runId = first.kind === "started" ? first.id : startedId!;
    console.log(
      `[spawn] ${parent.msg.threadKey} run ${parent.runId} spawned ${request.preset} run ${runId} in ${child.threadKey}`,
    );
    return {
      kind: "spawned",
      runId,
      threadKey: opened.thread.threadKey,
      ...(opened.thread.sourceUrl !== undefined ? { url: opened.thread.sourceUrl } : {}),
    };
  }
  if (first.kind === "threw") return refused("spawn_failed", describe(first.err));
  // The dispatch ended before the child was a run: a gate refused it (by its
  // own name, with the reply its thread saw) or setup failed.
  const reason = first.outcome.refusal ?? "spawn_failed";
  console.log(`[spawn] ${parent.msg.threadKey} run ${parent.runId}: ${request.preset} child not started (${reason})`);
  return refused(reason, lastReply ?? `the child ended (${first.outcome.status}) before it started`);
}

/** What a spawning run's tools hold (docs/reference/specs/agent-conductor.md
 *  item 3): a spawn as this run, with the wall clock it has left at the call,
 *  and how a child it spawned ended once its dispatch returned — undefined while
 *  the child runs, and for a run this capability did not spawn. */
export interface SpawnCapability {
  spawn(request: SpawnRequest, remainingMs: number): Promise<SpawnOutcome>;
  childOutcome(runId: string): DispatchOutcome | undefined;
}

/** The capability the dispatcher builds for a run once it is registered: the
 *  run's id and depth fixed, the remaining wall clock read at every call. Spawns
 *  are admitted one at a time: the fan-out check counts the registry's live
 *  children, and a child is not in the registry until its dispatch registers
 *  it, so two spawns issued at once would both count the same — the next spawn
 *  waits for the previous to register or refuse, and the cap holds however the
 *  caller batches its calls. */
export function spawnCapabilityFor<D extends SpawnCoreDeps>(
  deps: SpawnDeps<D>,
  parent: Omit<SpawnParent, "remainingMs">,
): SpawnCapability {
  const outcomes = new Map<string, DispatchOutcome>();
  const withHook: SpawnDeps<D> = {
    ...deps,
    onChildEnded: (child, outcome) => {
      outcomes.set(child.runId, outcome);
      deps.onChildEnded?.(child, outcome);
    },
  };
  let previous: Promise<unknown> = Promise.resolve();
  return {
    spawn: (request, remainingMs) => {
      const turn = previous.then(() => spawnChild(withHook, { ...parent, remainingMs }, request));
      previous = turn.catch(() => {}); // a failed turn never blocks the next
      return turn;
    },
    childOutcome: (runId) => outcomes.get(runId),
  };
}

/**
 * What a run's tools may do to other runs (docs/reference/specs/agent-conductor.md
 * items 3–4 and 8), built by `dispatch()` for every run once it is registered:
 * the spawn as THIS run — its id and depth fixed, the remaining wall clock
 * read at every call; the reads as the REQUESTER, through the one runs service
 * every surface reads (production's, or one over the registry and the store
 * without a ledger's foreign rows) under the actor the chat surface resolves
 * for the same user; the steer as the requester from this run (`steerRun`:
 * the parent's user, channel and thread link as the sender, the run as
 * `from`); and the wait over this run's own stop control and inbox and the
 * process's registry. Only a toolset that holds the run tools reaches any of
 * them, so nothing else in the tree starts, steers or awaits a run.
 */
export function runToolCapabilities<D extends SpawnCoreDeps>(
  deps: SpawnDeps<D> & {
    registry: SpawnRegistry & Parameters<typeof createRunsService>[0]["registry"] & Pick<RunRegistry, "subscribeIndex">;
  },
  run: Omit<SpawnParent, "remainingMs"> & {
    control: Pick<RunControl, "requested">;
    inbox: Pick<FollowUpInbox<DispatchFollowUp>, "size">;
  },
): { spawn: SpawnCapability; runs: RunsReadCapability; steer: SteerCapability; wait: WaitCapability } {
  const { core } = deps;
  return {
    spawn: spawnCapabilityFor(deps, run),
    runs: {
      service: core.runs ?? createRunsService({ registry: deps.registry, store: core.runStore }),
      actor: resolveChatActor(run.msg, (id) => core.config.grantsFor(id)),
      runId: run.runId,
    },
    steer: {
      steer: (target, text) =>
        steerRun(
          {
            config: core.config,
            runLedger: core.runLedger,
            ...(core.clock ? { clock: core.clock } : {}),
            admission: core.admission ?? defaultAdmission,
          },
          {
            userId: run.msg.userId,
            ...(run.msg.userName !== undefined ? { userName: run.msg.userName } : {}),
            channelId: run.msg.channelId,
            ...(run.msg.channelName !== undefined ? { channelName: run.msg.channelName } : {}),
            ...(run.msg.sourceUrl !== undefined ? { sourceUrl: run.msg.sourceUrl } : {}),
            from: { runId: run.runId },
          },
          target,
          text,
        ),
    },
    wait: waitCapabilityFor({ registry: deps.registry, control: run.control, inbox: run.inbox, clock: deps.clock }),
  };
}

/** The capability outside a spawning run (docs/decisions/0018-capabilities-computed-once-null-objects.md):
 *  a tool called where no run is spawning answers honestly instead of
 *  starting anything. */
export const nullSpawnCapability: SpawnCapability = {
  spawn: async () => ({
    kind: "refused",
    reason: "spawn_unavailable",
    message: "no run is spawning here — spawn_run works only inside a run that holds the spawn tool",
  }),
  childOutcome: () => undefined,
};
