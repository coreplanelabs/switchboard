// The re-attach stage of a resumed dispatch (docs/reference/specs/run-history.md
// item 54): where the run's row says its workspace is, so the attach reuses it
// instead of provisioning as for a new run; and what happens when that
// workspace cannot be re-attached: the resumed run is closed with a note that
// says why, and its request is dispatched again in the thread — under the
// same run id, carrying the run's identity (`CarriedRunIdentity`) — never
// migrated silently onto another backend.
import { workspaceBindingOf, type WorkspaceBinding } from "../../execution/factory.js";
import { sendChildSignal, type CoordinatorTag, type WorkflowSender } from "../coordinator/contract.js";
import type { RunEvent } from "../runEvents.js";
import { messageFromInbox } from "../runLedger/inboxMessage.js";
import type { LiveRunRow } from "../runLedger/types.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { RunHandle, RunRegistry } from "../runRegistry.js";
import { channelOf, startRequestRoot, type RequestTrace, type RequestTraceDeps } from "../requestTrace.js";
import { mergeFollowUps } from "../threadAdmission.js";
import type { Clock } from "../trace/types.js";
import type { IncomingMessage } from "../types.js";
import { closeResumedRow, type ResumeContext } from "./admission.js";
import type { GateCard, GateContext } from "./authorize.js";
import type { RefusalCode } from "../refusal.js";
import type { PersonFollowUp } from "./settle.js";

/**
 * Where a resumed run's workspace is, as its row recorded it: the binding the
 * claim wrote (`state.binding`) or, on a row written before the binding was
 * recorded, what its meta still says: the backend it chose and, on the
 * resident, the worktree it named to the model. Undefined for a run without a
 * workspace, which has nothing to re-attach.
 */
export function carriedWorkspaceBinding(row: LiveRunRow): WorkspaceBinding | undefined {
  const recorded = workspaceBindingOf(row.state.binding);
  if (recorded) return recorded;
  if (row.meta.selection === "resident")
    return { backend: "resident", ...(row.meta.workspace ? { workspace: row.meta.workspace } : {}) };
  if (row.meta.selection === "sandbox" || row.meta.selection === "local") return { backend: row.meta.selection };
  return undefined;
}

/**
 * The coordinator tag a resumed run carries forward (run-history item 48a):
 * the instance and key off the row's meta — written at the claim — and the
 * plan's base off the `coordinator_tag` event the spawning process published
 * at dispatch, so a coding child re-attached after a bot roll still knows the
 * branch its pull request targets instead of calling the unit branch its own
 * base. Undefined for a run no coordinator spawned; a row written before the
 * event existed carries the two meta fields and no base — the post-step's
 * second guard (the coordinator store) covers it.
 */
export function carriedCoordinatorTag(row: LiveRunRow, events: readonly RunEvent[]): CoordinatorTag | undefined {
  const { parentInstanceId, idempotencyKey } = row.meta;
  if (typeof parentInstanceId !== "string" || typeof idempotencyKey !== "string") return undefined;
  const tag = events.find((e) => e.type === "coordinator_tag");
  const base = tag?.type === "coordinator_tag" ? tag.base : undefined;
  return { parentInstanceId, idempotencyKey, ...(base !== undefined ? { base } : {}) };
}

/** The `resumed` note's words for a workspace that could not be re-attached. */
export function lostWorkspaceNote(why: string, restarts: boolean): string {
  const lost = `resumed after a restart: the run's workspace could not be re-attached (${why})`;
  return restarts
    ? `${lost}; the run restarts from its request under the same run id`
    : `${lost}, and the row's request cannot be read, so the run ends here; re-send it to run it again`;
}

/**
 * The identity a restart from the request carries forward (run-history item
 * 54): the restarted run is the SAME run — one id, one page, one row on every
 * list — so the events the predecessor published are replayed under their
 * seqs (the record's first segment, as a renewed lease opens a new segment
 * under record 0046), the capability token is kept (every link already posted
 * — the card's, the unit thread's — keeps opening the page), the original
 * start stands, and the replacement itself is one `resumed` note on the
 * transcript, in user words.
 */
export interface CarriedRunIdentity {
  /** The predecessor's retained events, replayed under their seqs. */
  events: RunEvent[];
  /** The predecessor's capability token: posted links stay valid. */
  token: string;
  /** The run's original start, so the card and the record span the whole run. */
  startedAt: number;
  /** The replacement in user words — the one event line the page shows. */
  note: string;
}

/** The predecessor's identity read off the registry — taken BEFORE the
 *  dispatch's wind-down discards or evicts its row. Undefined when the row is
 *  already gone: the restart then runs under a fresh id, exactly as every
 *  restart did before the identity was kept — a page that moved, never a
 *  request that vanished. */
export function carriedRunIdentity(
  registry: Pick<RunRegistry, "snapshotById" | "getById">,
  runId: string,
  note: string,
): CarriedRunIdentity | undefined {
  const snap = registry.snapshotById(runId);
  const summary = registry.getById(runId);
  if (!snap || !summary) return undefined;
  return { events: snap.events, token: summary.token, startedAt: snap.startedAt, note };
}

/** What `abandonLostWorkspace` reads off the dispatch. */
export interface LostWorkspaceContext extends Omit<GateContext, "refuse">, GateCard {
  /** The dispatch's silent refusal wrap: the card and the run's own note say
   *  why, so nothing is rendered in the thread — stamped and counted like any
   *  other refusal. */
  refuse: <T>(outcome: RefusalCode, side: () => Promise<T>) => Promise<T>;
  run: RunHandle;
  registry: RunRegistry;
  resume: ResumeContext;
  /** The row the resume adopted; undefined only in a process without a ledger. */
  ledgerRun: LedgerRun | undefined;
  /** The factory's refusal, one line. */
  why: string;
  /** The coordinator tag the resumed run carried (run-history item 48a):
   *  present, the interruption is said to the parent too — the typed
   *  `child_interrupted` event on the child's record and its Workflow twin. */
  coordinator?: CoordinatorTag;
  /** The Workflow sender the twin rides (the shim's event relay); absent in a
   *  process without one, and the parent's wait falls back to `read-record`. */
  workflow?: WorkflowSender;
}

/** What a resumed coordinator child's roll outcome says to its parent
 *  (run-history item 47a): the typed event on the child's own record — read
 *  back by the parent's `read-record` and the run page alike — and its
 *  Workflow twin (`child-interrupted-<runId>` / `child-resumed-<runId>`), sent
 *  best effort so the parent's wait settles (interrupted) or keeps waiting
 *  (resumed) instead of walking out the chunk. Returns the published event so
 *  a closing row can append it to its record past the highest replayed seq. */
export async function announceChildRoll(ctx: {
  registry: RunRegistry;
  runId: string;
  coordinator: CoordinatorTag;
  kind: "interrupted" | "resumed";
  reason: string;
  clock: Clock;
  workflow?: WorkflowSender;
}): Promise<Extract<RunEvent, { type: "child_interrupted" | "child_resumed" }>> {
  const { registry, runId, coordinator, kind, reason, clock, workflow } = ctx;
  const at = clock();
  const event: Extract<RunEvent, { type: "child_interrupted" | "child_resumed" }> =
    kind === "interrupted"
      ? { type: "child_interrupted", parentInstanceId: coordinator.parentInstanceId, reason, at }
      : { type: "child_resumed", parentInstanceId: coordinator.parentInstanceId, summary: reason, at };
  registry.publish(runId, event);
  const sent = await sendChildSignal(workflow, {
    runId,
    parentInstanceId: coordinator.parentInstanceId,
    kind,
    reason,
    at,
  });
  if (sent.kind === "failed")
    console.warn(`[resume] ${runId} → ${sent.type} not delivered to ${sent.instance}: ${sent.reason}`);
  return event;
}

/**
 * A resumed run whose workspace could not be re-attached (run-history item
 * 54): the run's work was on that backend or nowhere, so nothing else is
 * provisioned. The `resumed` note saying why goes on the run's stream and
 * into its record, the card closes, the adopted row closes `interrupted`, and
 * the request the row carries is handed back for a fresh dispatch (the same
 * run id continued in the thread, provisioned as a fresh run is) once this
 * dispatch has freed the thread. Undefined when the row's request cannot be read: the run ends
 * here, the note and the card say so.
 */
export async function abandonLostWorkspace(ctx: LostWorkspaceContext): Promise<IncomingMessage | undefined> {
  const { refuse, card, shell, closeLines, clock, run, registry, resume, ledgerRun, why, coordinator, workflow } = ctx;
  const restored = messageFromInbox(resume.row.meta.request ?? {}, resume.row.startedAt);
  const summary = lostWorkspaceNote(why, restored !== undefined);
  const note = { type: "run_note" as const, kind: "resumed" as const, summary, at: clock() };
  await refuse("workspace_lost", async () => {
    registry.publish(run.id, note);
    // A coordinator's child says the roll to its parent too (run-history item
    // 47a). When the request restarts in this thread (issue 1903:
    // a replaced container's child resumes from its request by itself), the
    // word is `resumed` — the parent's wait keeps waiting and follows the
    // successor through `read-record`'s `restartedAs`, so the pipeline never
    // ends over a resume that succeeded (issue 1876). Only a request that
    // cannot be read — no restart — settles the wait as `interrupted`.
    const rollEvent = coordinator
      ? await announceChildRoll({
          registry,
          runId: run.id,
          coordinator,
          kind: restored ? "resumed" : "interrupted",
          reason: summary,
          clock,
          ...(workflow ? { workflow } : {}),
        })
      : undefined;
    await card.done(
      shell.close({
        kind: "not_started",
        icon: "🔁",
        reason: restored
          ? "workspace lost across the restart; restarting from the request"
          : "workspace lost across the restart; re-send to run again",
        ...closeLines(clock(), false),
      }),
    );
    // The record carries the note: the events replayed from the ledger plus this one, past the highest seq.
    if (ledgerRun)
      await closeResumedRow(
        ledgerRun,
        {
          ...resume,
          events: [
            ...resume.events,
            { ...note, seq: resume.lastSeq + 1 },
            ...(rollEvent ? [{ ...rollEvent, seq: resume.lastSeq + 2 }] : []),
          ],
        },
        "the run's workspace could not be re-attached",
        "interrupted",
        // A close a restart follows is not the run's end (record 0064; item
        // 47a): the record says `restarting`, so a waiting parent re-arms on
        // `child_resumed` instead of ending its unit.
        restored ? { restarting: true } : undefined,
      );
  });
  console.log(
    `[resume] ${resume.row.threadKey} run ${resume.row.runId} ${restored ? "restarts from its request" : "ends"}: ${why}`,
  );
  return restored?.msg;
}

/** The fresh dispatch a restart runs as: its own root, the request as the row
 *  carried it, with the follow-ups the resumed run never consumed appended as
 *  the fresh turn appends them — and the run it restarts named, so admission
 *  never steers the request into that run's row (thread-admission item 5):
 *  the row is closing, its finish in flight, and the boot-gap map may still
 *  list it. */
export interface RestartTurn {
  msg: IncomingMessage;
  opts: { trace: RequestTrace; restartOf?: string; restartCarried?: CarriedRunIdentity; coordinator?: CoordinatorTag };
}

export function prepareRestartTurn(
  deps: RequestTraceDeps,
  ctx: {
    request: IncomingMessage;
    pending: PersonFollowUp[];
    clock: Clock;
    restartOf?: string;
    /** The predecessor's identity when its registry row could still be read:
     *  the restart keeps the run's id, token, start and events. */
    carried?: CarriedRunIdentity;
    /** The tag the interrupted run carried (run-history item 48a): the
     *  restart is the same instance's child, or no coordinator's. */
    coordinator?: CoordinatorTag;
  },
): RestartTurn {
  const { request, pending, clock, restartOf, carried, coordinator } = ctx;
  const merged = mergeFollowUps(pending);
  const receivedAt = clock();
  const msg: IncomingMessage = {
    ...request,
    ...(merged
      ? {
          text: `${request.text}\n\n${merged.text}`,
          ...(merged.images || request.images ? { images: [...(request.images ?? []), ...(merged.images ?? [])] } : {}),
          ...(merged.documents || request.documents
            ? { documents: [...(request.documents ?? []), ...(merged.documents ?? [])] }
            : {}),
          ...(merged.staged || request.staged ? { staged: [...(request.staged ?? []), ...(merged.staged ?? [])] } : {}),
        }
      : {}),
    receivedAt,
    originAt: undefined,
  };
  // The restart's own dispatch opens the window (`receivedAt` is this clock
  // read, `originAt` cleared above): its queue lines measure from here, and
  // the root names the run it restarts so the page says `restarted from run
  // <id>` instead of counting the predecessor's lifetime as a wait.
  const trace = startRequestRoot(deps, {
    channel: channelOf(msg.channelId),
    receivedAt,
    ...(restartOf !== undefined ? { restartOfRunId: restartOf } : {}),
  });
  return {
    msg,
    opts: {
      trace,
      ...(restartOf !== undefined ? { restartOf } : {}),
      ...(carried !== undefined ? { restartCarried: carried } : {}),
      ...(coordinator !== undefined ? { coordinator } : {}),
    },
  };
}
