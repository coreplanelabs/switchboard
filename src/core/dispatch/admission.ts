// The admission stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// who may hold the thread. The claim — ONE live run per thread — a steer into
// the run in flight, a refusal, the boot-gap steer to a run live on another
// generation; then taking up a resumed or restarted run's row and the durable
// inbox it carried. The fast paths that answer a message before any of this
// are fastPath.ts.
//
// The stage is three functions because each thing it takes hold of — the
// thread slot, a ledger row, a reservation — is handed back to `dispatch()`
// before the next step that can throw, so its outer `finally` releases
// exactly what the inline code used to.
import type { ConfigStore } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import type { RequestDirectives } from "../../directives.js";
import type { LedgerRun, LedgerWriteThrough } from "../runLedger/writeThrough.js";
import type { AppendableEvent, InboxItem, LiveRunRow, StepRecord } from "../runLedger/types.js";
import type { ThreadsElsewhere } from "../runLedger/threadsElsewhere.js";
import type { ResumePlan } from "../runLedger/resume.js";
import { durableInboxMessage, messageFromInbox } from "../runLedger/inboxMessage.js";
import { systemClock } from "../trace/index.js";
import type { Clock, Span } from "../trace/types.js";
import type { RepoContext } from "../repoContext.js";
import type { StopMode } from "../runEvents.js";
import {
  decideFollowUp,
  refusalReply,
  steerAck,
  ThreadAdmission,
  type FollowUpInput,
  type LiveThread,
} from "../threadAdmission.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { reclaimedRunRecord } from "./record.js";

/** What thread admission reads off the dispatcher's dependencies. `CoreDeps`
 *  extends this; a caller's shape is unchanged. */
export interface AdmissionDeps {
  config: ConfigStore;
  /** The wall clock (docs/reference/specs/tracing.md): `systemClock` in production, a ticking clock in tests. */
  clock?: Clock;
  /**
   * Thread admission (docs/reference/specs/thread-admission.md): the per-process map of
   * threads with a run in flight, so a follow-up in such a thread is steered
   * into that run or refused instead of starting a rival one. Defaults to the
   * process-wide singleton; injectable for tests.
   */
  admission?: ThreadAdmission<DispatchFollowUp>;
  /**
   * The run ledger's write-through (docs/reference/specs/run-history.md item 35): every
   * agent run and ship pipeline is claimed on the state Worker's ledger when
   * its run is created, mirrors its steps/events/state while it runs, takes
   * `finishing` before the reply and finishes through the ledger's one
   * transaction (`runHistoryWriter.write(record, { via })`). Without a ledger
   * it is the `NullLedgerWriteThrough`: nothing is claimed and the run goes on
   * exactly as before the ledger existed. Production wires
   * `createLedgerWriteThrough` beside the run store (src/index.ts), so a
   * ledger always comes with a writer: without one the finish never reaches the
   * ledger and a claimed row closes only by lease expiry (a test-only pairing).
   */
  runLedger: LedgerWriteThrough;
  /** The threads whose live run is on the ledger but not in this process
   *  (thread-admission item 5), fed by the reclaim sweep: a follow-up on one
   *  is steered into that run's durable inbox instead of starting a rival.
   *  Empty in a process without a ledger. */
  threadsElsewhere: Pick<ThreadsElsewhere, "get" | "forget">;
}

/** A follow-up as the dispatcher admits it: the runner's `FollowUpInput` plus
 *  the message it arrived as and, for a person's, the channel handle it
 *  arrived on — what a fresh turn needs if the live run ends without consuming
 *  it (docs/reference/specs/thread-admission.md item 4). A steer a run sent
 *  (`from` set; item 7) has no handle: a program's message is never run fresh. */
export type DispatchFollowUp = FollowUpInput & { msg: IncomingMessage; io?: ChannelIO };

/** One follow-up as the slot's inbox holds it: the message's sender, link and
 *  attachments on the runner's shape, the arrival time, the durable seq when
 *  the ledger took a copy, the run that sent it when a run did, and the handle
 *  a fresh turn would reply on when a person did. The one literal every steer
 *  builds, so a thread reply and a parent's steer fold in as the same thing. */
function followUpOf(
  msg: IncomingMessage,
  text: string,
  at: number,
  opts: { io?: ChannelIO; ledgerSeq?: number; from?: { runId: string } },
): DispatchFollowUp {
  return {
    text,
    userId: msg.userId,
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(msg.images !== undefined ? { images: msg.images } : {}),
    ...(msg.documents !== undefined ? { documents: msg.documents } : {}),
    at,
    ...(opts.ledgerSeq !== undefined ? { ledgerSeq: opts.ledgerSeq } : {}),
    ...(opts.from !== undefined ? { from: opts.from } : {}),
    msg,
    ...(opts.io !== undefined ? { io: opts.io } : {}),
  };
}

/** The process-wide admission map (one bot process = one map; the registry's
 *  singleton is the same shape of default). */
export const defaultAdmission = new ThreadAdmission<DispatchFollowUp>();

/** A run this generation reclaimed at boot and is continuing (docs/reference/specs/
 *  run-history.md item 38): the ledger row as it stands, the last step record,
 *  the resume plan built from the transcript, the events published before the
 *  restart (replayed into the registry under their seqs), and the repo context
 *  rebuilt from the row's meta. */
export interface ResumeContext {
  row: LiveRunRow;
  lastStep: StepRecord;
  plan: Extract<ResumePlan, { kind: "resume" }>;
  events: AppendableEvent[];
  /** The highest event seq on the ledger; appends continue past it. */
  lastSeq: number;
  repoCtx: RepoContext;
  /** The durable inbox past the last record (item 40): folded in at the run's first boundary. */
  inbox: InboxItem[];
}

/** A run reserved at admission whose owner died while attaching (item 42):
 *  dispatched again from its request under the row's id and card. The row is
 *  still `attaching` and this generation's; the inbox holds the follow-ups
 *  steered in meanwhile. */
export interface RestartContext {
  row: LiveRunRow;
  inbox: InboxItem[];
}

export { DURABLE_INBOX_MAX_BYTES, durableInboxMessage } from "../runLedger/inboxMessage.js";

/** A durable inbox item back as a follow-up for the resumed run, on the
 *  resume's channel handle — none for a steer a run sent, which is never run
 *  fresh; undefined when the stored shape is not one this build wrote
 *  (skipped, never fatal). */
export function followUpFromInbox(item: InboxItem, io: ChannelIO, fallbackAt: number): DispatchFollowUp | undefined {
  const restored = messageFromInbox(item.message, fallbackAt);
  if (!restored) return undefined;
  const { msg, at, from } = restored;
  return followUpOf(msg, msg.text, at, { ledgerSeq: item.seq, ...(from ? { from } : { io }) });
}

/** Close a restart's row this dispatch will never run (item 42): the thread
 *  has a newer run — the user re-mentioned after the kill — so the reserved
 *  run is closed `interrupted` with a record of its identity and request,
 *  through an adopted handle so the ledger's finish removes the row.
 *  Best-effort, like `closeResumedRow` below. */
export async function closeRestartRow(adopted: LedgerRun, restart: RestartContext, why: string): Promise<void> {
  try {
    await adopted.sink.put(
      reclaimedRunRecord({ row: restart.row, events: [], status: "interrupted", finishedAt: systemClock() }),
    );
  } catch (err) {
    console.warn(
      `[restart] ${restart.row.runId} could not be closed (${why}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Close a reclaimed row this dispatch adopted but will never finish (item
 *  38): the record is the row plus the events published before the restart,
 *  status `interrupted`, through the adopted run's sink so the ledger's finish
 *  removes the row. Best-effort: a failure is a warning, the sweep's next pass
 *  finds the row again. */
export async function closeResumedRow(adopted: LedgerRun, resume: ResumeContext, why: string): Promise<void> {
  try {
    await adopted.sink.put(
      reclaimedRunRecord({ row: resume.row, events: resume.events, status: "interrupted", finishedAt: systemClock() }),
    );
  } catch (err) {
    console.warn(
      `[resume] ${resume.row.runId} could not be closed (${why}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The stop and fence hooks a ledger row is taken with: they reach the run's
 *  registry control, which `dispatch()` owns. */
export interface RunHooks {
  onStop: (mode: StopMode) => void;
  onFenced: () => void;
}

/** What the admission claim and the carried-run steps read of the dispatch:
 *  built once by `dispatch()` after the agent gate, handed to `admit`,
 *  `adoptCarriedRun` and `foldCarriedInbox` in turn. */
export interface AdmissionContext {
  msg: IncomingMessage;
  io: ChannelIO;
  directives: RequestDirectives;
  /** The resolved agent the thread is claimed for. */
  agentName: AgentDef["name"];
  resume: ResumeContext | undefined;
  restart: RestartContext | undefined;
  /** A resume's or restart's ledger row; undefined for a fresh request. */
  carriedRow: LiveRunRow | undefined;
  clock: Clock;
  /** The request's root; the stage's spans are its children. */
  root: Span;
  /** The dispatch's refusal wrap: one `dispatch.refuse` span naming why, and the request ends refused. */
  refuse: <T>(outcome: string, fn: () => Promise<T>) => Promise<T>;
  /** The per-process admission map (`deps.admission`, or the default). */
  admission: ThreadAdmission<DispatchFollowUp>;
  hooks: {
    /** For a reservation (item 42): a fence during the attach stops the run and marks it another generation's. */
    reservation: RunHooks;
    /** For an adopted row (item 38): a stop or a fence reaches the run's control. */
    adopt: RunHooks;
  };
}

/** How the admission claim ended. Every kind but `proceed` and `redispatch`
 *  means the thread has been answered and the dispatch is over — no card, no
 *  run, no workspace. */
export type AdmissionOutcome =
  /** The thread is this dispatch's: `admitted` is the slot it holds until its outer finally releases it. */
  | { kind: "proceed"; admitted: LiveThread<DispatchFollowUp> }
  /** The run this message was steered into ended during the round trip: the message runs fresh, as its own dispatch. */
  | { kind: "redispatch" }
  /** Folded into the run in flight — here, or on another generation through its durable inbox — and acked. */
  | { kind: "steered"; where: "here" | "elsewhere" }
  /** Not run, and told why: the sender may not run the live agent, or asked for a different one. */
  | {
      kind: "refused";
      reason:
        "live_agent_allowlist" | "follow_up_refused" | "elsewhere_agent_allowlist" | "elsewhere_follow_up_refused";
    }
  /** A resume or restart found a newer run on the thread: its row was closed `interrupted`, nothing said. */
  | { kind: "superseded"; of: "resume" | "restart" };

/**
 * Thread admission (docs/reference/specs/thread-admission.md item 1): ONE live run per
 * thread. Claimed after the agent gate and before anything slow, so no window
 * exists in which two runs can attach the same per-thread workspace.
 */
export async function admit(deps: AdmissionDeps, ctx: AdmissionContext): Promise<AdmissionOutcome> {
  const { msg, io, directives, agentName, resume, restart, carriedRow, clock, root, refuse, admission } = ctx;
  // Thread admission (docs/reference/specs/thread-admission.md item 1): ONE live run per
  // thread. Claimed HERE — after the agent gate (a follow-up's sender must be
  // allowed to run the live agent, exactly like a first message) and before
  // anything slow (the setup card, repo resolution, the executor attach), so
  // no window exists in which two runs can attach the same per-thread
  // workspace. A thread with a run in flight either folds this message into
  // that run (its inbox; the runner reads it at the next step boundary — for
  // a ship run, the child round in flight) or refuses it with a pointer to
  // the live run when a DIFFERENT agent was asked for explicitly. Either way
  // this dispatch ends here: no card, no run, no workspace.
  // A resumed run's slot carries the row's original start (run-history item 38):
  // the steer ack's "N in" is the run's elapsed time, not the resume's.
  let claim = admission.claim(msg.threadKey, {
    agent: agentName,
    ...(carriedRow ? { now: carriedRow.startedAt } : {}),
  });
  if (claim.kind === "live" && restart) {
    // A restart is not a follow-up either (item 42): a live run here means
    // the user re-mentioned after the kill; the reserved run is closed
    // `interrupted` on the ledger with no reply to the thread.
    const adopted = deps.runLedger.adopt({
      runId: restart.row.runId,
      threadKey: msg.threadKey,
      state: restart.row.state,
      lastStep: 0,
      lastSeq: 0,
    });
    await root.span(
      "dispatch.admission",
      () => closeRestartRow(adopted, restart, "the thread has a newer run in flight"),
      { attrs: { outcome: "restart_superseded" } },
    );
    console.log(
      `[restart] ${msg.threadKey} run ${restart.row.runId} not restarted: the thread has a newer run in flight — closed interrupted`,
    );
    return { kind: "superseded", of: "restart" };
  }
  if (claim.kind === "live" && resume) {
    // A resume is not a follow-up (run-history item 38): its message is
    // synthetic, so it must never be steered into — or refuse against — the
    // run that now holds the thread. A live run here means the user moved on
    // after the kill (a re-mention started a fresh run); the reclaimed run
    // is closed `interrupted` on the ledger, with no reply to the thread.
    const adopted = deps.runLedger.adopt({
      runId: resume.row.runId,
      threadKey: msg.threadKey,
      state: resume.row.state,
      lastStep: resume.lastStep.step,
      lastSeq: resume.lastSeq,
    });
    await root.span(
      "dispatch.admission",
      () => closeResumedRow(adopted, resume, "the thread has a newer run in flight"),
      { attrs: { outcome: "resume_superseded" } },
    );
    console.log(
      `[resume] ${msg.threadKey} run ${resume.row.runId} not resumed: the thread has a newer run in flight — closed interrupted`,
    );
    return { kind: "superseded", of: "resume" };
  }
  if (claim.kind === "live") {
    // The gate above ran against THIS message's resolved agent; a steered
    // follow-up is read by the LIVE agent, so its sender must be allowed to
    // run that one too (invariant 3 — no path runs an agent for a user the
    // allowlist excludes, and "run" includes "is heard by").
    if (!deps.config.canRunAgent(msg.userId, claim.live.agent)) {
      await refuse("live_agent_allowlist", () =>
        io.reply(
          `🚫 You're not on the allowlist for the \`${claim.live.agent}\` agent, whose run is in flight in this thread. Ask ${deps.config.adminsHint()} for access.`,
        ),
      );
      return { kind: "refused", reason: "live_agent_allowlist" };
    }
    const decision = decideFollowUp(claim.live, { agent: directives.agent });
    if (decision.kind === "refuse") {
      console.log(
        `[dispatch] ${msg.threadKey} follow-up refused (${decision.reason}): ${claim.live.agent} run in flight`,
      );
      await refuse("follow_up_refused", () => io.reply(refusalReply(claim.live, decision, clock())));
      return { kind: "refused", reason: "follow_up_refused" };
    }
    // The durable copy first (run-history item 40), so its seq rides on the
    // in-memory item and the next step record says the run consumed it. A
    // run with no row yet (still in setup) has no durable copy: it is not
    // resumable until its seed lands anyway.
    const at = clock();
    const ledgerSeq = claim.live.runId
      ? await deps.runLedger.pushInbox(claim.live.runId, durableInboxMessage(msg, directives.text, at))
      : undefined;
    if (admission.get(msg.threadKey) !== claim.live) {
      // The run finished and released the thread during the round trip: an
      // item pushed now would sit on a dead slot (and its durable copy went
      // with the finish). Nothing is dropped silently — the follow-up is a
      // request of its own now (item 4's rule, taken early).
      console.log(`[dispatch] ${msg.threadKey} the run finished during the steer — running the follow-up fresh`);
      return { kind: "redispatch" };
    }
    claim.live.inbox.push(followUpOf(msg, directives.text, at, { io, ledgerSeq }));
    console.log(
      `[dispatch] ${msg.threadKey} follow-up steered into the ${claim.live.agent} run in flight (${claim.live.inbox.size} pending${ledgerSeq !== undefined ? `, durable seq ${ledgerSeq}` : ""})`,
    );
    await root.span("dispatch.admission", () => io.reply(steerAck(claim.live, at)), {
      attrs: { outcome: "steered" },
    });
    return { kind: "steered", where: "here" };
  }
  // The thread is free here, but its live run may be on the ledger under
  // another generation, or reclaimed and not yet launched (thread-admission
  // item 5 — the boot gap). Then the follow-up is steered into that run's
  // durable inbox: the resume folds it in. The same gates as an in-process
  // steer apply (the live agent's allowlist, no agent switch). A push the
  // ledger refuses means the row is gone — the map is stale — so the message
  // runs fresh and the thread is forgotten until the next sweep.
  // (A restart's own row is in that map: it is not steered into itself.)
  const elsewhere = resume || restart ? undefined : deps.threadsElsewhere.get(msg.threadKey);
  const farAgent = elsewhere?.agent;
  if (elsewhere && farAgent === undefined) {
    // No agent on the row: the no-agent-switch gate cannot be judged, so the
    // message is not steered into it (a claim always records the agent; this
    // is a guard, not a path).
    console.log(`[dispatch] ${msg.threadKey} run ${elsewhere.runId} on the ledger names no agent — running fresh`);
  } else if (elsewhere && farAgent !== undefined) {
    // This dispatch holds the slot for nothing but a steer: release it NOW,
    // before any round trip, so the resume's own dispatch (which may launch
    // this instant) finds the thread free instead of a rival that closes its
    // row as "a newer run in flight".
    admission.release(msg.threadKey, claim.live);
    const far: LiveThread<DispatchFollowUp> = {
      agent: farAgent,
      inbox: claim.live.inbox,
      startedAt: elsewhere.startedAt,
      runId: elsewhere.runId,
    };
    if (!deps.config.canRunAgent(msg.userId, far.agent)) {
      await io.reply(
        `🚫 You're not on the allowlist for the \`${far.agent}\` agent, whose run is in flight in this thread. Ask ${deps.config.adminsHint()} for access.`,
      );
      return { kind: "refused", reason: "elsewhere_agent_allowlist" };
    }
    const decision = decideFollowUp(far, { agent: directives.agent });
    const now = clock();
    if (decision.kind === "refuse") {
      console.log(
        `[dispatch] ${msg.threadKey} follow-up refused (${decision.reason}): ${far.agent} run ${far.runId} live on another generation`,
      );
      await io.reply(refusalReply(far, decision, now));
      return { kind: "refused", reason: "elsewhere_follow_up_refused" };
    }
    const seq = await deps.runLedger.pushInbox(elsewhere.runId, durableInboxMessage(msg, directives.text, now));
    if (seq !== undefined) {
      // The run may have been launched here during the round trip (its
      // adopt-time re-read ran before this push landed, or after — either
      // way the inbox folds one seq in once): hand the item to it as well.
      const nowLive = admission.get(msg.threadKey);
      if (nowLive && nowLive.runId === elsewhere.runId)
        nowLive.inbox.push(followUpOf(msg, directives.text, now, { io, ledgerSeq: seq }));
      console.log(
        `[dispatch] ${msg.threadKey} follow-up steered into run ${elsewhere.runId} live on another generation (durable seq ${seq}${nowLive ? ", now live here" : ""})`,
      );
      await io.reply(steerAck(far, now));
      return { kind: "steered", where: "elsewhere" };
    }
    deps.threadsElsewhere.forget(msg.threadKey);
    console.log(`[dispatch] ${msg.threadKey} run ${elsewhere.runId} is no longer on the ledger — running fresh`);
    // Take the slot back for the fresh run below.
    const again = admission.claim(msg.threadKey, { agent: agentName });
    if (again.kind === "live") {
      // Someone claimed it during the round trip: this message steers into them as any follow-up would.
      return { kind: "redispatch" };
    }
    claim = again;
  }
  return { kind: "proceed", admitted: claim.live };
}

/** A run a steer is aimed at: its id, the thread it holds, and the agent live
 *  in it — the allowlist the sender must pass, as for a thread reply. */
export interface SteerTarget {
  runId: string;
  threadKey: string;
  agent: string;
}

/** Who sends a steer on a run's behalf: the requesting user, in the channel
 *  the parent runs in, with the parent's thread as the link — and the run
 *  itself as `from`. */
export interface SteerSender {
  userId: string;
  userName?: string;
  channelId: string;
  channelName?: string;
  sourceUrl?: string;
  from: { runId: string };
}

/** How a steer ended: folded into the run here (its slot's inbox, the durable
 *  copy's seq riding the item) or on another generation (the durable inbox
 *  alone); refused because the sender may not run the live agent; or aimed at
 *  a run that is not live anywhere — no slot here, and a push the ledger
 *  refused — so nothing landed. */
export type SteerOutcome =
  | { kind: "steered"; where: "here" | "elsewhere"; at: number; ledgerSeq?: number }
  | { kind: "refused"; reason: "live_agent_allowlist" }
  | { kind: "not_live" };

/**
 * A steer by a run rather than a thread reply (docs/reference/specs/thread-admission.md
 * item 7; agent-conductor item 8): `send_to_run`'s path into a live child. The
 * same gate a thread reply passes — the sender must be allowed to run the live
 * agent, since being heard by an agent counts as running it — then the same
 * two pushes in the same order: the durable copy first (item 5, so its seq
 * rides the in-memory item and the next step record says the run consumed
 * it), then the slot that holds the target run NOW (matched by run id — a
 * newer run on the same thread is never handed another run's steer). No
 * agent-switch gate: a steer names no agent. No ack: nothing was said in the
 * target's thread to answer. No channel handle on the item: a program's
 * message is never run fresh (settle). A target with no slot here whose push
 * the ledger refused is not live, and the caller says so by name.
 */
export async function steerRun(
  deps: {
    config: Pick<ConfigStore, "canRunAgent">;
    runLedger: Pick<LedgerWriteThrough, "pushInbox">;
    clock?: Clock;
    admission: ThreadAdmission<DispatchFollowUp>;
  },
  sender: SteerSender,
  target: SteerTarget,
  text: string,
): Promise<SteerOutcome> {
  if (!deps.config.canRunAgent(sender.userId, target.agent)) return { kind: "refused", reason: "live_agent_allowlist" };
  const at = (deps.clock ?? systemClock)();
  const msg: IncomingMessage = {
    channelId: sender.channelId,
    userId: sender.userId,
    ...(sender.userName !== undefined ? { userName: sender.userName } : {}),
    ...(sender.channelName !== undefined ? { channelName: sender.channelName } : {}),
    threadKey: target.threadKey,
    text,
    ...(sender.sourceUrl !== undefined ? { sourceUrl: sender.sourceUrl } : {}),
    receivedAt: at,
  };
  const ledgerSeq = await deps.runLedger.pushInbox(target.runId, durableInboxMessage(msg, text, at, sender.from));
  const live = deps.admission.get(target.threadKey);
  if (live && live.runId === target.runId) {
    live.inbox.push(followUpOf(msg, text, at, { ledgerSeq, from: sender.from }));
    console.log(
      `[steer] run ${sender.from.runId} → ${target.agent} run ${target.runId} in ${target.threadKey} (${live.inbox.size} pending${ledgerSeq !== undefined ? `, durable seq ${ledgerSeq}` : ""})`,
    );
    return { kind: "steered", where: "here", at, ...(ledgerSeq !== undefined ? { ledgerSeq } : {}) };
  }
  if (ledgerSeq !== undefined) {
    console.log(
      `[steer] run ${sender.from.runId} → ${target.agent} run ${target.runId} live on another generation (durable seq ${ledgerSeq})`,
    );
    return { kind: "steered", where: "elsewhere", at, ledgerSeq };
  }
  return { kind: "not_live" };
}

/** The ledger handles a resumed or restarted run is taken up with: the adopted
 *  row (a resume), or the re-taken reservation and the request it carries (a
 *  restart). All undefined for a fresh request. */
export interface CarriedRun {
  ledgerRun: LedgerRun | undefined;
  reserved: LedgerRun | undefined;
  requestRow: Record<string, unknown> | undefined;
}

/**
 * Take up a carried run's row NOW — after the claim, before the card, the repo
 * resolution and the workspace attach — so its heartbeat keeps the lease
 * through a slow attach. `dispatch()` records what came back before the next
 * step that can throw; a throw here leaves nothing taken.
 */
export async function adoptCarriedRun(deps: AdmissionDeps, ctx: AdmissionContext): Promise<CarriedRun> {
  const { msg, resume, restart, root } = ctx;
  const carried: CarriedRun = { ledgerRun: undefined, reserved: undefined, requestRow: undefined };
  // A resumed run (run-history item 38): its ledger row has been this
  // generation's since the boot reclaim — take it up NOW, before the card,
  // the repo resolution and the workspace attach, so the heartbeat keeps
  // the lease through a slow resident attach. No claim, no seed.
  if (resume) {
    carried.ledgerRun = deps.runLedger.adopt({
      runId: resume.row.runId,
      threadKey: msg.threadKey,
      state: resume.row.state,
      lastStep: resume.lastStep.step,
      lastSeq: resume.lastSeq,
      ...ctx.hooks.adopt,
    });
  }
  if (restart) {
    // A restart (item 42): the row is this generation's since the reclaim and
    // still `attaching` — take it up NOW, as a resume adopts its row, so the
    // heartbeat keeps the lease through this attach as well. The reserve is
    // the owner's idempotent re-claim; the request rides on the row already.
    carried.requestRow = restart.row.meta.request;
    carried.reserved = await root.span("dispatch.ledger_reserve", () =>
      deps.runLedger.reserve({
        runId: restart.row.runId,
        threadKey: msg.threadKey,
        startedAt: restart.row.startedAt,
        meta: restart.row.meta,
        card: restart.row.card,
        ...ctx.hooks.reservation,
      }),
    );
  }
  return carried;
}

/**
 * The follow-ups a carried run's durable inbox holds (run-history item 40) —
 * the reclaim's snapshot plus whatever landed since — folded into the slot the
 * dispatch now holds, so the runner reads them at its first boundary. Nothing
 * for a fresh request.
 */
export async function foldCarriedInbox(
  deps: AdmissionDeps,
  ctx: AdmissionContext,
  admitted: LiveThread<DispatchFollowUp>,
): Promise<void> {
  const { msg, io, resume, restart, carriedRow, clock } = ctx;
  const carriedInbox = resume
    ? { tag: "resume", known: resume.lastStep.inboxConsumedSeq, items: resume.inbox }
    : restart
      ? { tag: "restart", known: 0, items: restart.inbox }
      : undefined;
  if (carriedInbox && carriedRow) {
    // The follow-ups steered in after the last record (item 40): the reclaim's
    // snapshot PLUS whatever landed since — a boot-gap steer between the
    // reclaim and this claim wrote to the ledger and was acked, so the inbox
    // is re-read here, past the highest seq already known. From this point
    // the thread is claimed in-process and steers reach the run directly. The
    // runner folds them in at its first boundary and records the seq it
    // reached. Their acks were the admitting generation's — none is sent again.
    // Name the run on the slot NOW — its id is the row's — so a boot-gap steer
    // whose push lands after the re-read below finds the run it belongs to and
    // hands the item over in memory (the registry row is created at the
    // reservation below, after this re-read — too late for that check).
    admitted.runId = carriedRow.runId;
    const known = Math.max(carriedInbox.known, ...carriedInbox.items.map((i) => i.seq));
    const late = await deps.runLedger.readInbox(carriedRow.runId, known);
    const items = [...carriedInbox.items, ...late.filter((i) => i.seq > known)];
    const fallbackAt = clock();
    let folded = 0;
    for (const item of items) {
      const followUp = followUpFromInbox(item, io, fallbackAt);
      if (!followUp) {
        console.warn(
          `[${carriedInbox.tag}] ${msg.threadKey} run ${carriedRow.runId}: inbox item ${item.seq} has a shape this build cannot read — skipped`,
        );
        continue;
      }
      admitted.inbox.push(followUp);
      folded++;
    }
    if (folded > 0)
      console.log(
        `[${carriedInbox.tag}] ${msg.threadKey} run ${carriedRow.runId}: ${folded} follow-up(s) from the durable inbox pending (${late.length} landed after the reclaim)`,
      );
  }
}
