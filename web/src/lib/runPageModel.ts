import { isTimedOutExit } from "./durationTone";
import { reactive, type InjectionKey, type Ref } from "vue";
import {
  createRunTimeline,
  type TimelineCall,
  type TimelineChange,
  type TimelineSkill,
  type TimelineSource,
  type TimelineStep,
} from "@core/channels/runTimeline.js";
import { formatElapsed } from "./format";

// The run page's view model: the ONE fold for seeded history and live frames
// (both go through `handle`, exactly like the old inline script — a seeded
// page and a live page render identically by construction). It consumes
// `createRunTimeline`'s changes and maintains reactive state the components
// paint; the grouping/folding state machine ported from the old DOM code:
//
//   - from the 2nd non-quiet call, a step's cards fold into ONE group whose
//     summary tallies them; it stays open while a call runs or after a
//     failure; a clean step folds when the next begins (a manual toggle or
//     "expand all" sticks);
//   - failures and sandbox errors open by default (`?open=` overrides);
//   - a model turn is held for the step it produced and painted in that
//     step's head; a turn with no step after it is flushed as its own row.

export interface CallVm {
  id: string;
  tool: string;
  title: string;
  headline: string;
  shell: boolean;
  status: TimelineCall["status"];
  facts: string[];
  startedAt?: number;
  /** The card body: output, or the summary when output was elided. */
  output: string;
  hasResult: boolean;
  /** A call whose summary is only the tool name shows the chip alone. */
  chipOnly: boolean;
  durationMs?: number;
  /** The shell exit code when the sandbox reported one. */
  exitCode?: number;
  /** The sandbox killed the command at its deadline (exit 124 — the runtime's
   *  own timeout signal; a SIGKILL 137 is not one): over budget. */
  timedOut: boolean;
  open: boolean;
}

export interface QuietVm {
  kind: "quiet";
  at?: number;
  text: string;
}
export interface SkillVm {
  kind: "skill";
  skill: TimelineSkill;
}
export interface CallItemVm {
  kind: "call";
  call: CallVm;
}
export type StepItem = CallItemVm | QuietVm | SkillVm;

export interface TurnVm {
  label: string;
  /** The chip reads "5m 04s" — label minus the "Thought for " prefix. */
  chip: string;
  /** Under the friction analyzer's 60 s slow-turn threshold. */
  quick: boolean;
  durationMs: number;
  facts: string[];
  /** `<provider>/<model>` that took the turn, when the event named one. */
  model?: string;
  /** True when this turn's model differs from the model the run had before
   *  it (the previous stamped turn's, else `run_meta`'s) — the head flags it. */
  switched: boolean;
  at?: number;
}

export interface StepVm {
  kind: "step";
  key: string;
  index: number;
  at?: number;
  turn: TurnVm | null;
  narration: string | null;
  /** The muted filler when there is neither prose nor turn facts. */
  note: string;
  items: StepItem[];
  live: boolean;
  manual: boolean;
  groupOpen: boolean;
}

export interface TurnRowVm {
  kind: "turn";
  key: string;
  turn: TurnVm;
  note: string;
}

export interface NoteVm {
  kind: "note";
  key: string;
  at?: number;
  replay: boolean;
  text: string;
}

/** A thread follow-up steered into this run (features/thread-admission.md
 *  item 2): every `input` after the first, rendered as its own block in the
 *  timeline at the moment the run read it — the Request's visual treatment,
 *  not a note. One run, several inputs; never a second request block. */
export interface FollowUpVm {
  kind: "followup";
  key: string;
  input: RequestVm;
}

export type LogItem = StepVm | TurnRowVm | NoteVm | FollowUpVm;

export interface RequestVm {
  text: string;
  at?: number;
  source?: TimelineSource;
}

export interface MetaVm {
  agent: string;
  model: string;
  effort?: string;
  repo?: string;
  ref?: string;
  pr?: number;
}

export interface ContextTurnVm {
  key: string;
  at?: number;
  text: string;
}

export interface AnswerVm {
  text: string;
  at?: number;
}

export interface RunPageModel {
  state: {
    /** The FIRST `input` event — what started the run. Every later `input`
     *  is a steered follow-up and lives in `log` as a `FollowUpVm`. */
    request: RequestVm | null;
    meta: MetaVm | null;
    context: ContextTurnVm[];
    log: LogItem[];
    answer: AnswerVm | null;
    /** True until the first painted change of any kind (#209). */
    placeholder: boolean;
    allOpen: boolean;
    stopMode: "soft" | "hard" | null;
    /** The model the run is on right now: `run_meta`'s, then whatever the
     *  newest stamped `turn` named. What the pending-turn row badges. */
    model: string | null;
    /** Runner-clock span of the run so far (first event's `at` → last). */
    firstAt: number | null;
    lastAt: number | null;
    /** Wall-clock receipt time of the event stamped `lastAt` — the anchor
     *  `runnerNow` projects from. Only a stamped event moves it: a replay
     *  notice or any other unstamped frame leaves both untouched, so a
     *  reconnect can never restart a stopwatch. */
    lastAtWall: number | null;
  };
  handle(event: unknown): void;
  /** The oldest call card still without a result (never a quiet call) — what
   *  the run is waiting on right now, or null while the model is thinking. */
  pendingCall(): CallVm | null;
  /** Flush a held model turn as its own row (the page calls this at `end`: a
   *  run that ended without an answer still shows its last turn). */
  flushPendingTurn(note: string): void;
  setAllOpen(open: boolean): void;
  toggleGroup(step: StepVm): void;
  toggleCall(call: CallVm): void;
  markStopping(mode: "soft" | "hard"): void;
  /** True when the call's tags open it by default (failed/infra, or ?open=). */
  opensByDefault(tags: string[]): boolean;
}

function turnVm(change: Extract<TimelineChange, { kind: "turn" }>, modelBefore: string | null): TurnVm {
  return {
    label: change.label,
    chip: change.label.replace(/^Thought for /, ""),
    quick: change.durationMs < 60_000,
    durationMs: change.durationMs,
    facts: change.facts,
    ...(change.model ? { model: change.model } : {}),
    // A switch is a change from a KNOWN model; the first stamped turn of a
    // run whose meta never named one is not a switch.
    switched: !!change.model && modelBefore !== null && change.model !== modelBefore,
    at: change.at,
  };
}

function callVm(call: TimelineCall, open: boolean): CallVm {
  return {
    id: call.id,
    tool: call.tool,
    title: call.title,
    headline: call.headline,
    shell: call.shell,
    status: call.status,
    facts: [...call.facts],
    startedAt: call.startedAt,
    output: call.result ? call.result.output || call.result.summary : "",
    hasResult: call.result !== undefined,
    chipOnly: !call.shell && call.title === call.tool,
    durationMs: call.durationMs,
    exitCode: call.result?.exitCode,
    timedOut: isTimedOutExit(call.result?.exitCode),
    open,
  };
}

export function createRunPageModel(options: { openTags?: string[] } = {}): RunPageModel {
  const OPEN_BY_DEFAULT = options.openTags && options.openTags.length > 0 ? options.openTags : ["failed", "infra"];
  const timeline = createRunTimeline();

  const state: RunPageModel["state"] = reactive({
    request: null,
    meta: null,
    context: [],
    log: [],
    answer: null,
    placeholder: true,
    allOpen: false,
    stopMode: null,
    model: null,
    firstAt: null,
    lastAt: null,
    lastAtWall: null,
  });

  const stepVms = new Map<number, StepVm>();
  const callVms = new Map<string, CallVm>();
  /** Quiet calls (update_status) render once; their results only refresh the tally. */
  const quietIds = new Set<string>();
  let pendingTurn: TurnVm | null = null;
  let lastStepIndex = -1;
  let keySeq = 0;
  const key = (prefix: string) => `${prefix}-${keySeq++}`;

  function opensByDefault(tags: string[]): boolean {
    if (OPEN_BY_DEFAULT.includes("all")) return true;
    return tags.some((t) => OPEN_BY_DEFAULT.includes(t));
  }

  function tallyOf(step: StepVm): { bad: number; infra: number; running: number } {
    let bad = 0;
    let infra = 0;
    let running = 0;
    for (const item of step.items) {
      if (item.kind !== "call") continue;
      if (item.call.status === "failed") bad++;
      else if (item.call.status === "infra") infra++;
      else if (item.call.status === "running") running++;
    }
    return { bad, infra, running };
  }

  // Groups stay OPEN by default and are never auto-folded (a UX revision over
  // the string-rendered page, which folded a clean step when the next began:
  // an all-collapsed page did not read — the group bars ARE the narrative).
  // Only a viewer's own toggle closes one; a failure or a still-running call
  // re-opens even that, because it is what they came to see. The cards INSIDE
  // stay collapsed (except failed/infra, item 13's open-by-default rules).
  function refreshGroup(step: StepVm): void {
    const { bad, infra, running } = tallyOf(step);
    if (bad || infra || running) step.groupOpen = true;
  }

  function addStep(step: TimelineStep): StepVm {
    const previous = stepVms.get(lastStepIndex);
    if (previous) previous.live = false;
    lastStepIndex = step.index;
    const turn = pendingTurn;
    pendingTurn = null;
    const vm: StepVm = reactive({
      kind: "step" as const,
      key: key("step"),
      index: step.index,
      at: step.narration ? step.narration.at : turn?.at,
      turn,
      narration: step.narration ? step.narration.text : null,
      // The turn produced calls only — they are the rows below (no filler when
      // the facts can head the row).
      note: "no commentary",
      items: [],
      live: true,
      manual: false,
      groupOpen: true,
    });
    stepVms.set(step.index, vm);
    state.log.push(vm);
    return vm;
  }

  function stepFor(step: TimelineStep): StepVm {
    return stepVms.get(step.index) ?? addStep(step);
  }

  function addCall(step: TimelineStep, call: TimelineCall): void {
    const vm = stepFor(step);
    if (call.quiet) {
      quietIds.add(call.id);
      vm.items.push({
        kind: "quiet",
        at: call.startedAt,
        text: `✎ ${call.tool === "update_status" ? "status checklist updated" : call.title}`,
      });
      refreshGroup(vm);
      return;
    }
    const c = reactive(callVm(call, state.allOpen || opensByDefault(call.tags)));
    callVms.set(call.id, c);
    vm.items.push({ kind: "call", call: c });
    refreshGroup(vm);
  }

  function settleCall(step: TimelineStep, call: TimelineCall): void {
    if (quietIds.has(call.id)) {
      const vm = stepVms.get(step.index);
      if (vm) refreshGroup(vm);
      return;
    }
    const existing = callVms.get(call.id);
    if (!existing) {
      addCall(step, call);
      return;
    }
    Object.assign(existing, callVm(call, existing.open));
    if (opensByDefault(call.tags)) existing.open = true;
    const vm = stepVms.get(step.index);
    if (vm) refreshGroup(vm);
  }

  /** A turn with no step after it (the answer's own thinking, or the run
   *  ended mid-thought): its own row, `note` saying what came of it. */
  function flushTurn(note: string): void {
    if (!pendingTurn) return;
    state.log.push({ kind: "turn", key: key("turn"), turn: pendingTurn, note });
    pendingTurn = null;
  }

  function apply(change: TimelineChange): void {
    state.placeholder = false;
    switch (change.kind) {
      case "input": {
        const vm: RequestVm = { text: change.text, at: change.at, ...(change.source ? { source: change.source } : {}) };
        // The first input is the request; a later one is a steered follow-up
        // and must never replace it (live 2026-09-05: the header showed the
        // follow-up as THE request). It takes its place in the timeline —
        // the runner emits it at the step boundary that read it.
        if (state.request) state.log.push({ kind: "followup", key: key("followup"), input: vm });
        else state.request = vm;
        return;
      }
      case "step":
        addStep(change.step);
        return;
      case "call":
        addCall(change.step, change.call);
        return;
      case "result":
        settleCall(change.step, change.call);
        return;
      case "turn":
        flushTurn("");
        pendingTurn = turnVm(change, state.model);
        if (change.model) state.model = change.model;
        return;
      case "meta":
        // The declared model until a stamped turn says otherwise.
        if (state.model === null && change.model) state.model = change.model;
        state.meta = {
          agent: change.agent,
          model: change.model,
          ...(change.effort ? { effort: change.effort } : {}),
          ...(change.repo ? { repo: change.repo } : {}),
          ...(change.ref ? { ref: change.ref } : {}),
          ...(change.pr !== undefined ? { pr: change.pr } : {}),
        };
        return;
      case "skill":
        stepFor(change.step).items.push({ kind: "skill", skill: change.skill });
        return;
      case "context":
        state.context.push({ key: key("ctx"), at: change.at, text: change.text });
        return;
      case "note":
        // The follow-up's snippet note stays on the record for the card; on
        // the page the follow-up block that precedes it is the marker.
        if (change.noteKind === "follow_up") return;
        state.log.push({ kind: "note", key: key("note"), at: change.at, replay: false, text: change.text });
        if (
          (change.noteKind === "stop_requested" || change.noteKind === "stopped") &&
          (change.mode === "soft" || change.mode === "hard")
        ) {
          markStopping(change.mode);
        }
        return;
      case "replay_note":
        state.log.push({ kind: "note", key: key("note"), replay: true, text: change.text });
        return;
      case "answer":
        flushTurn("wrote the answer below"); // the answer's own thinking has no step to sit on
        state.answer = { text: change.text, at: change.at };
        return;
    }
  }

  function handle(event: unknown): void {
    const e = event as { at?: unknown } | null;
    if (e && typeof e.at === "number") {
      if (state.firstAt === null || e.at < state.firstAt) state.firstAt = e.at;
      if (state.lastAt === null || e.at >= state.lastAt) {
        state.lastAt = e.at;
        state.lastAtWall = Date.now();
      }
    }
    for (const change of timeline.push(event)) apply(change);
  }

  function pendingCall(): CallVm | null {
    // Arrival order: the Map keeps insertion order, and quiet calls never enter it.
    for (const c of callVms.values()) if (c.status === "running") return c;
    return null;
  }

  function setAllOpen(open: boolean): void {
    state.allOpen = open;
    for (const c of callVms.values()) c.open = open;
  }

  function markStopping(mode: "soft" | "hard"): void {
    state.stopMode = mode;
  }

  return {
    state,
    handle,
    pendingCall,
    flushPendingTurn: flushTurn,
    setAllOpen,
    toggleGroup(step) {
      step.manual = true; // the auto-fold then leaves this group alone forever
      step.groupOpen = !step.groupOpen;
    },
    toggleCall(call) {
      call.open = !call.open;
    },
    markStopping,
    opensByDefault,
  };
}

/** "the run ended here" flushes are the caller's (the page knows when the
 *  stream ended); exposed as a helper so the wording lives in one place. */
export const TURN_END_NOTE = "the run ended here";

/** The runner's clock as the page best knows it: the newest stamped event's
 *  `at` plus the wall time since that event arrived. Every live stopwatch on
 *  the page subtracts a runner stamp from THIS — never browser-minus-runner
 *  math, so clock skew cannot show in a tick. Null until a stamped event. */
export function runnerNow(state: RunPageModel["state"], nowWall: number): number | null {
  if (state.lastAt === null || state.lastAtWall === null) return null;
  return state.lastAt + (nowWall - state.lastAtWall);
}

/** The header stopwatch while live (item 22): the whole run, from its first
 *  event to the projected runner clock. */
export function runningHeader(state: RunPageModel["state"], nowWall: number): string | null {
  const now = runnerNow(state, nowWall);
  if (state.firstAt === null || now === null) return null;
  return `running · ${formatElapsed(now - state.firstAt)}`;
}

/** The projected runner clock, provided by the run page to every card so a
 *  running card can tick its own elapsed in place (null on a history page:
 *  nothing there is live, so nothing ticks). */
export const RunnerClockKey: InjectionKey<Ref<number | null>> = Symbol("sb-runner-clock");

/** The short name a badge shows for a `<provider>/<model>` ref: the part after
 *  the last slash (`anthropic/claude-fable-5` → `claude-fable-5`); a bare
 *  model name is itself; nothing known reads `model`. The full ref is the
 *  badge's hover. */
export function modelName(ref: string | null | undefined): string {
  if (!ref) return "model";
  const slash = ref.lastIndexOf("/");
  const name = slash === -1 ? ref : ref.slice(slash + 1);
  return name || ref;
}

/** A pending model turn this long is amber — the same minute at which the
 *  finished `thought …` head it becomes turns amber (`TurnVm.quick`). */
export const SLOW_TURN_MS = 60_000;

export type LiveWait =
  /** No stamped event yet — nothing to time. */
  | { kind: "starting" }
  /** A command or tool is running: timed from ITS start on the runner clock
   *  (its card ticks in place — the page draws nothing extra). */
  | { kind: "call"; call: CallVm; elapsedMs: number }
  /** Every call has settled and the model has not spoken: timed from the last
   *  stamped event — the turn began when the last result landed. The page
   *  draws it as a provisional step head that becomes the real one. */
  | { kind: "thinking"; elapsedMs: number; slow: boolean };

/** What the run is waiting on right now, and for how long. `pending` is
 *  `model.pendingCall()`. */
export function liveWait(state: RunPageModel["state"], pending: CallVm | null, nowWall: number): LiveWait {
  const now = runnerNow(state, nowWall);
  if (now === null || state.lastAt === null) return { kind: "starting" };
  if (pending)
    return { kind: "call", call: pending, elapsedMs: Math.max(0, now - (pending.startedAt ?? state.lastAt)) };
  const elapsedMs = Math.max(0, now - state.lastAt);
  return { kind: "thinking", elapsedMs, slow: elapsedMs >= SLOW_TURN_MS };
}

/** The finished duration on the runner clock (first → last event). */
export function runSpan(state: RunPageModel["state"]): string {
  return state.firstAt !== null && state.lastAt !== null && state.lastAt > state.firstAt
    ? formatElapsed(state.lastAt - state.firstAt)
    : "";
}
