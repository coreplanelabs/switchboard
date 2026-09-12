// The wait behind `await_runs` (docs/reference/specs/agent-conductor.md item 8):
// a parent waits for its children's ends within its own budget, and a fan-out's
// write-ups come back to it as data. The decision is pure and lives here —
// which children are terminal, and what ends the wait: every named child
// ended, the parent's remaining budget less the wrap-up reserve, the caller's
// own timeout, a stop, or a follow-up landing in the parent's own inbox (so
// the steer is heard at the parent's next step). The tool that drives it
// (src/tools/runs.ts) reads each child through the one runs service — the
// registry for a child in this process, the ledger for one another generation
// drives, the store for one that finished — and is woken by the registry's
// lifecycle feed when a child ends here, so an in-process end never waits on
// the poll. An interrupted child is reported as that status and never
// restarted: telling is this module's whole job.
import { RUN_DEADLINE_RESERVE_MS } from "../../execution/bashTimeout.js";
import type { StopMode } from "../runEvents.js";
import type { RunStatus } from "../runRecord.js";
import type { RunRegistry } from "../runRegistry.js";
import type { RunControl } from "../runRegistry/runControl.js";
import type { FollowUpInbox, FollowUpInput } from "../threadAdmission.js";
import type { Clock } from "../trace/types.js";

/** How often the wait re-reads the children it cannot hear end in this
 *  process — a child another generation drives, one whose record the store
 *  holds — and re-checks the parent's own stop and inbox. A child ending here
 *  wakes it sooner through the registry's feed. */
export const AWAIT_POLL_MS = 5_000;

/** How a child ended, as the wait reports it: a record's terminal status; or,
 *  for a child whose row is gone with no record (refused at a gate after it
 *  registered, failed in setup — the spawn capability's memory), the dispatch
 *  outcome's own word (`refused`, `failed`, `stopped`). */
export type ChildEndStatus = RunStatus | "refused" | "stopped";

/** What the wait knows of one child at a moment. */
export type ChildState =
  /** Live — in this process, or under another generation (`elsewhere`). */
  | { kind: "running"; activity?: string; elsewhere?: boolean }
  /** Ended: its terminal status, its last activity line, its final reply when
   *  it wrote one, and the gate's name when a gate refused it. */
  | { kind: "ended"; status: ChildEndStatus; activity?: string; finalReply?: string; refusal?: string }
  /** Unknown, or a run the requester may not read — byte-identical on purpose. */
  | { kind: "not_found" };

/** A child the wait is done with: ended, or not there to wait for. */
export const isTerminal = (state: ChildState): boolean => state.kind !== "running";

/**
 * The children's states as the wait accumulates them, keyed by the ids the
 * wait was asked for. A terminal state, once seen, never changes: a second
 * `end` frame, a later read that finds nothing where a record was, or a stale
 * `running` read after an end all change nothing — so a duplicate frame can
 * neither flip a status nor make a child live again.
 */
export class ChildrenWatch {
  private readonly states: Map<string, ChildState>;

  constructor(ids: readonly string[]) {
    this.states = new Map(ids.map((id): [string, ChildState] => [id, { kind: "running" }]));
  }

  /** Record what a read found for `id`; false when the child is not this
   *  wait's or is already terminal (the observation is dropped). */
  observe(id: string, state: ChildState): boolean {
    const current = this.states.get(id);
    if (current === undefined || isTerminal(current)) return false;
    this.states.set(id, state);
    return true;
  }

  get(id: string): ChildState | undefined {
    return this.states.get(id);
  }

  /** The children still live — the ones the next tick re-reads. */
  pending(): string[] {
    return [...this.states].filter(([, s]) => !isTerminal(s)).map(([id]) => id);
  }

  get allEnded(): boolean {
    return [...this.states.values()].every(isTerminal);
  }

  snapshot(): ReadonlyMap<string, ChildState> {
    return this.states;
  }
}

/** Why the wait ended, in order of precedence. */
export type WaitEnd = "all_ended" | "stop" | "follow_up" | "budget" | "timeout";

export interface WaitInputs {
  children: ReadonlyMap<string, ChildState>;
  now: number;
  /** The parent's deadline less the wrap-up reserve (`budgetEndOf`): when the
   *  wait must hand back so the parent can still write up. */
  budgetEndsAt: number;
  /** The caller's own cap (`timeoutMinutes`), absolute; absent → the budget alone bounds the wait. */
  timeoutAt?: number;
  /** The parent's own stop control, read at the tick. */
  stop: StopMode | undefined;
  /** A follow-up sits in the parent's own inbox. */
  followUpPending: boolean;
}

export type WaitDecision = { kind: "end"; why: WaitEnd } | { kind: "wait"; until: number };

/**
 * The one rule. A wait whose every child is terminal is complete and says so,
 * whatever else is true — the result is whole. Then a stop ends it at once
 * (soft or hard: no new step is owed, the parent wraps up); then a follow-up
 * in the parent's inbox (the parent's next step reads it); then the budget's
 * edge (the parent writes up what returned and names what still runs); then
 * the caller's timeout — the budget is named when both have passed, being the
 * stronger fact. Otherwise the wait goes on until the earlier bound.
 */
export function decideWait(inputs: WaitInputs): WaitDecision {
  const { children, now, budgetEndsAt, timeoutAt, stop, followUpPending } = inputs;
  if ([...children.values()].every(isTerminal)) return { kind: "end", why: "all_ended" };
  if (stop !== undefined) return { kind: "end", why: "stop" };
  if (followUpPending) return { kind: "end", why: "follow_up" };
  if (now >= budgetEndsAt) return { kind: "end", why: "budget" };
  if (timeoutAt !== undefined && now >= timeoutAt) return { kind: "end", why: "timeout" };
  return { kind: "wait", until: Math.min(budgetEndsAt, timeoutAt ?? Number.POSITIVE_INFINITY) };
}

/** The budget's edge: the parent's deadline less the same reserve the bash
 *  tool keeps back from its last command (execution.md item 12), so the wait
 *  returns while the parent can still write up from what came back. */
export function budgetEndOf(now: number, remainingMs: number): number {
  return now + remainingMs - RUN_DEADLINE_RESERVE_MS;
}

/**
 * What a waiting tool watches beyond the runs service: the parent's own stop
 * control and inbox, the registry's lifecycle feed for its children's ends in
 * this process, and the clock and sleep the wait is paced by. Built by the
 * dispatcher for a run (`waitCapabilityFor`); absent — a unit context, a round
 * outside `dispatch()` — the tool says so.
 */
export interface WaitCapability {
  /** The run's own stop request, read at every tick. */
  stopRequested(): StopMode | undefined;
  /** How many follow-ups wait in this run's own inbox. */
  followUpsPending(): number;
  /** Call `onChange` whenever one of `ids` finishes, is sealed, discarded or
   *  evicted in this process's registry — a child that already ended is
   *  reported at once. Returns the unsubscribe. */
  watch(ids: ReadonlySet<string>, onChange: () => void): () => void;
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts (a hard stop). Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real sleep: a timer, cut short by the signal. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The capability over a run's own control and inbox and the process's
 *  registry. The feed's `upsert` of a watched child is an end only once it is
 *  finished (the finish, then the seal); its `removed` is a discard or an
 *  eviction. A child's mere activity never wakes the wait. */
export function waitCapabilityFor(deps: {
  registry: Pick<RunRegistry, "subscribeIndex">;
  control: Pick<RunControl, "requested">;
  inbox: Pick<FollowUpInbox<FollowUpInput>, "size">;
  clock: Clock;
  sleep?: WaitCapability["sleep"];
}): WaitCapability {
  return {
    stopRequested: () => deps.control.requested,
    followUpsPending: () => deps.inbox.size,
    watch: (ids, onChange) =>
      deps.registry.subscribeIndex((event) => {
        if (event.type === "removed" ? ids.has(event.id) : ids.has(event.run.id) && event.run.finished) onChange();
      }),
    now: deps.clock,
    sleep: deps.sleep ?? sleepUnlessAborted,
  };
}
