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
import { runDurationMs } from "@core/core/runDuration.js";
import { displayNameOf } from "@core/core/trace/displayNames.js";
import { createLossTracker, foldSpanRecord } from "@core/core/normalizeSpans.js";
import { isSpanRecord, type RunEvent } from "@core/core/runEvents.js";
import type { LossInterval } from "@core/core/trace/partition.js";
import type { SpanRecord } from "@core/core/trace/types.js";
import { classOf } from "@core/core/trace/streamSpans.js";
import { reviewPostOptedOut } from "@core/core/reviewPost.js";
import { formatDuration } from "./format";
import { githubPrUrl, githubRepoUrl } from "./githubLinks";
import { wallNow } from "./wallClock";

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
  /** The turn's own span — the anchor the timeline's Longest steps scroll to. */
  spanId: string;
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
  /** The head names its model only where a reader learns something: the first
   *  head of the run, and every switch. A run on one model says it once. */
  showModel: boolean;
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

/** A streamed span that is a step of its own (docs/reference/specs/tracing.md): what it
 *  was (the display name), how long, and whether it is still open. */
export interface SpanRowVm {
  kind: "span";
  key: string;
  spanId: string;
  /** The display name — never the raw span name. */
  text: string;
  open: boolean;
  durationMs?: number;
  status?: "ok" | "error";
  at?: number;
}

/** A thread follow-up steered into this run (docs/reference/specs/thread-admission.md
 *  item 2): every `input` after the first, rendered as its own block in the
 *  timeline at the moment the run read it — the Request's visual treatment,
 *  not a note. One run, several inputs; never a second request block. */
export interface FollowUpVm {
  kind: "followup";
  key: string;
  input: RequestVm;
}

/** The two bookend phases of the timeline's bar, as groups of rows under one
 *  head each (docs/reference/specs/live-view.md item 25) — named with the bar's own
 *  words so a reader can correlate the two. `getting_ready`: `slack.receive`,
 *  every `dispatch.*` step and the attach's grafted resident steps; open while
 *  the run sets up, closed on its own when the agent loop starts. `finishing_up`:
 *  the post-loop steps the bar counts as finishing up; closed when delivery
 *  begins or the run ends. A reader's toggle wins from then on. */
export type Phase = "getting_ready" | "finishing_up";

export interface PhaseGroupVm {
  kind: "phase";
  phase: Phase;
  key: string;
  rows: SpanRowVm[];
  open: boolean;
}

export type LogItem = StepVm | TurnRowVm | NoteVm | FollowUpVm | SpanRowVm | PhaseGroupVm;

/** Which phase group a streamed span row belongs to, if any: the receipt and
 *  the dispatcher's steps before the loop (the attach's grafts included) are
 *  getting ready; the steps `classOf` counts as finishing up are finishing up.
 *  Everything else (`run.*` bodies, `post.*` delivery, `ship.round`) stands on
 *  its own. */
export function phaseOfSpan(name: string): Phase | undefined {
  if (name === "slack.receive" || name.startsWith("dispatch.")) return "getting_ready";
  const cls = classOf(name, "agent");
  return cls?.kind === "counted" && cls.bucket === "finishing_up" ? "finishing_up" : undefined;
}

/** The spans that ARE the page rather than a row on it: the request (the page)
 *  and the agent loop (the steps). Neither draws a row. */
export function isStructuralSpan(name: string): boolean {
  return name === "request" || name === "run.agent";
}

export const PHASE_WORD: Record<Phase, string> = { getting_ready: "Getting ready", finishing_up: "Finishing up" };

/** The head's text: the phase's word (the bar's), how many steps and, once
 *  every one has ended, their span from the first start to the last end. */
export function phaseHeadText(group: Pick<PhaseGroupVm, "rows" | "phase">): string {
  const n = group.rows.length;
  const steps = `${n} step${n === 1 ? "" : "s"}`;
  const word = PHASE_WORD[group.phase];
  if (n === 0 || group.rows.some((r) => r.open || r.at === undefined || r.durationMs === undefined))
    return `${word} · ${steps}`;
  const start = Math.min(...group.rows.map((r) => r.at!));
  const end = Math.max(...group.rows.map((r) => r.at! + r.durationMs!));
  return `${word} · ${steps} · ${formatDuration(Math.max(0, end - start), "precise")}`;
}

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
  /** The PR head the run was resolved at (7–40 hex, as the fold verified it). */
  headSha?: string;
}

export interface ContextTurnVm {
  key: string;
  at?: number;
  text: string;
}

/** What the run sent back: the `answer` event — a review's verdict, a coding
 *  run's PR note, the general agent's answer. The page's word is Reply. */
export interface ReplyVm {
  text: string;
  at?: number;
}

/** The coding post-step's PR, as the `pr_opened` event recorded it. */
export interface PrOpenedVm {
  url: string;
  number: number;
  created: boolean;
}

export interface RunPageModel {
  state: {
    /** The FIRST `input` event — what started the run. Every later `input`
     *  is a steered follow-up and lives in `log` as a `FollowUpVm`. */
    request: RequestVm | null;
    meta: MetaVm | null;
    context: ContextTurnVm[];
    log: LogItem[];
    reply: ReplyVm | null;
    /** The PR the coding post-step opened or edited, once the stream said so. */
    prOpened: PrOpenedVm | null;
    /** True until the first painted change of any kind. */
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
    /** Retained `seq` ranges the live replay did not send (`replay_elided`
     *  frames, docs/reference/specs/live-view.md item 5): the record still has them. Kept
     *  for the partition's `not loaded` term (docs/reference/specs/tracing.md). */
    elided: ReplayElidedRange[];
    /** Bumped on every frame the fold saw: what the timeline recomputes on. */
    traceVersion: number;
  };
  handle(event: unknown): void;
  /** The span set so far (docs/reference/specs/tracing.md), folded per frame from the same
   *  stream the log reads — the timeline's input. */
  spanSet(): SpanRecord[];
  /** The loss intervals so far — `seq` gaps (lost, or elided when a
   *  `replay_elided` range covers them) and `spans_dropped` notes — from the
   *  window's start. Tracked per frame, read per tick without a rescan. */
  losses(windowStart: number): LossInterval[];
  /** A `replay_elided` frame: note the range in the log (a replay row, like a
   *  stored stream's omission marker) and keep it on the state. */
  noteElided(range: ReplayElidedRange): void;
  /** The oldest call card still without a result (never a quiet call) — what
   *  the run is waiting on right now, or null while the model is thinking. */
  pendingCall(): CallVm | null;
  /** Flush a held model turn as its own row (the page calls this at `end`: a
   *  run that ended without a reply still shows its last turn). */
  flushPendingTurn(note: string): void;
  /** The run is over (`end`, or a seeded record): every phase head the reader
   *  did not touch closes — nothing is in progress under them any more. */
  closePhases(): void;
  setAllOpen(open: boolean): void;
  toggleGroup(step: StepVm): void;
  /** The reader opens or closes a phase head; from then on it stays as they left it. */
  togglePhase(group: PhaseGroupVm): void;
  toggleCall(call: CallVm): void;
  /** Make the row behind an anchor (`call-<id>` / `span-<id>`, the ids the
   *  page stamps) visible: the group or phase head that folds it opens, as a
   *  reader's own toggle would. Returns false for an anchor no row carries. */
  reveal(anchor: string): boolean;
  /** The collapsed headline of a call card, by call id — what the timeline
   *  names a tool step by (`$ npm test`, not `bash`). */
  callHeadline(callId: string): string | undefined;
  markStopping(mode: "soft" | "hard"): void;
  /** True when the call's tags open it by default (failed/infra, or ?open=). */
  opensByDefault(tags: string[]): boolean;
}

export interface ReplayElidedRange {
  fromSeq: number;
  toSeq: number;
}

/** Parse a `replay_elided` frame's payload: two positive integers in order, or
 *  null for anything else (a malformed frame marks nothing). */
export function parseReplayElided(data: string | undefined): ReplayElidedRange | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { fromSeq, toSeq } = parsed as { fromSeq?: unknown; toSeq?: unknown };
  const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  if (!int(fromSeq) || !int(toSeq) || fromSeq > toSeq) return null;
  return { fromSeq, toSeq };
}

/** The replay row for an elided range: what was skipped and where it still is. */
export function elidedText(range: ReplayElidedRange): string {
  const n = range.toSeq - range.fromSeq + 1;
  const span = n === 1 ? `event ${range.fromSeq}` : `events ${range.fromSeq}–${range.toSeq}`;
  return `${n} ${n === 1 ? "event" : "events"} not loaded (${span}) — the record has them`;
}

function turnVm(
  change: Extract<TimelineChange, { kind: "turn" }>,
  modelBefore: string | null,
  modelShownBefore: boolean,
): TurnVm {
  // The model that took the turn: the stamp when the event carries one, else
  // the model the run was on — a stream from before per-turn stamps still
  // names its `run_meta` model. A bare stamp that names the model the run was
  // on (v0.4.0 stamped bare ids) keeps the fuller ref.
  const same = !!change.model && modelBefore !== null && sameModel(change.model, modelBefore);
  const model = same ? (modelBefore as string) : (change.model ?? modelBefore ?? undefined);
  // A switch is a change from a KNOWN model; the first stamped turn of a
  // run whose meta never named one is not a switch.
  const switched = !!change.model && modelBefore !== null && !same;
  return {
    spanId: change.spanId,
    label: change.label,
    chip: change.label.replace(/^Thought for /, ""),
    quick: change.durationMs < 60_000,
    durationMs: change.durationMs,
    facts: change.facts,
    ...(model ? { model } : {}),
    switched,
    showModel: !!model && (!modelShownBefore || switched),
    at: change.at,
  };
}

/** The muted line a step's group summary reads — the tally as a reader says
 *  it. Every state: all succeeded; some failed (`failed` is the tool's own
 *  failure, `sandbox error` the executor's); some still running; nothing
 *  settled yet. Successes are implied unless they are the only news. */
export function callSummary(t: { n: number; ok: number; bad: number; infra: number; running: number }): string {
  const calls = `${t.n} tool call${t.n === 1 ? "" : "s"}`;
  if (t.n === 0) return "no tool calls";
  if (t.ok === t.n) return `${calls}, all succeeded`;
  if (t.running === t.n) return `${calls}, all running`;
  const parts: string[] = [];
  if (t.bad) parts.push(`${t.bad} failed`);
  if (t.infra) parts.push(`${t.infra} sandbox error${t.infra === 1 ? "" : "s"}`);
  if (t.running) parts.push(`${t.running} still running`);
  return `${calls}, ${parts.join(", ")}`;
}

/** What the Reply is, from the run's facts alone — never from its text:
 *  a review's verdict (for the PR the run was resolved against; `Slack only`
 *  when the request opted out of the GitHub post — the same parser the
 *  dispatcher decides with, so page and bot agree), a coding run's pull
 *  request (opened, or an existing one updated, from `pr_opened`), a command
 *  run's output, otherwise the general agent's answer. The record carries no
 *  fact about whether a verdict reached GitHub (the post-step runs after the
 *  seal), so the caption says what the verdict is FOR, not where it landed. */
export function replyCaption(input: { meta: MetaVm | null; requestText: string; prOpened: PrOpenedVm | null }): {
  text: string;
  href?: string;
} {
  const { meta, prOpened } = input;
  const repo = meta?.repo && githubRepoUrl(meta.repo) ? meta.repo : undefined;
  if (meta?.agent === "review") {
    if (reviewPostOptedOut(input.requestText)) return { text: "verdict, Slack only" };
    if (repo && meta.pr !== undefined) {
      const href = githubPrUrl(repo, meta.pr);
      return href ? { text: `verdict for ${repo}#${meta.pr}`, href } : { text: "verdict" };
    }
    return { text: "verdict" };
  }
  if (meta?.agent === "coding" && prOpened) {
    const what = prOpened.created ? "pull request opened" : "pull request updated";
    const href = repo ? githubPrUrl(repo, prOpened.number) : undefined;
    return href ? { text: `${what} ${repo}#${prOpened.number}`, href } : { text: what };
  }
  if (meta?.agent === "command") return { text: "output" };
  return { text: "answer" };
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
    reply: null,
    prOpened: null,
    placeholder: true,
    allOpen: false,
    stopMode: null,
    model: null,
    firstAt: null,
    lastAt: null,
    lastAtWall: null,
    elided: [],
    traceVersion: 0,
  });
  /** The loss intervals, tracked per frame; the span records folded. Neither
   *  holds the stream: a long run costs the page its spans and its gaps, not
   *  its events. */
  const losses = createLossTracker();
  const spans = new Map<string, SpanRecord>();

  const stepVms = new Map<number, StepVm>();
  const spanRows = new Map<string, SpanRowVm>();
  /** Which phase group each span row sits under, for `reveal`. */
  const phaseOfRow = new Map<string, PhaseGroupVm>();
  // One group per phase, once its first span arrived; `toggled` records that
  // the reader decided its state, so nothing closes it on its own any more.
  const phaseGroups = new Map<Phase, { group: PhaseGroupVm; toggled: boolean }>();
  const callVms = new Map<string, CallVm>();
  /** The step each call card sits in, for `reveal`. */
  const stepOfCall = new Map<string, StepVm>();
  /** Quiet calls (update_status) render once; their results only refresh the tally. */
  const quietIds = new Set<string>();
  let pendingTurn: TurnVm | null = null;
  /** A head has named the run's model: later heads on the same model stay quiet. */
  let modelShown = false;
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
    stepOfCall.set(call.id, vm);
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

  /** A turn with no step after it (the reply's own thinking, or the run
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
        // and must never replace it, or the header would show the follow-up
        // as THE request. It takes its place in the timeline —
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
        pendingTurn = turnVm(change, state.model, modelShown);
        if (pendingTurn.model) modelShown = true;
        // A stamp names the run's model from here on — unless it is a bare id
        // for the model already known by its fuller ref, which stays.
        if (change.model && !(state.model !== null && sameModel(change.model, state.model))) state.model = change.model;
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
          ...(change.headSha ? { headSha: change.headSha } : {}),
        };
        return;
      case "pr_opened":
        state.prOpened = { url: change.url, number: change.number, created: change.created };
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
      case "span": {
        // The request and the agent loop are the page's own structure — the
        // one span that draws nothing while still marking a boundary is the
        // loop's start, which closes the getting-ready head.
        if (isStructuralSpan(change.name)) {
          if (change.name === "run.agent" && change.open) closePhase("getting_ready");
          return;
        }
        // Delivery begins (`post.*`): whatever finishing-up rows there were are done.
        if (change.name.startsWith("post.") && change.open) closePhase("finishing_up");
        // One row per span: the start opens it, the end closes the same row.
        const existing = spanRows.get(change.spanId);
        if (existing) {
          existing.open = change.open;
          if (change.durationMs !== undefined) existing.durationMs = change.durationMs;
          if (change.status) existing.status = change.status;
          return;
        }
        const row: SpanRowVm = reactive({
          kind: "span",
          key: key("span"),
          spanId: change.spanId,
          text: displayNameOf(change.name),
          open: change.open,
          ...(change.durationMs !== undefined ? { durationMs: change.durationMs } : {}),
          ...(change.status ? { status: change.status } : {}),
          // A row born from a lone end (its start elided from the replay) is stamped
          // with the span's start, so the Setup head's span is not inflated.
          at: change.open ? change.at : (change.startedAt ?? change.at),
        });
        spanRows.set(change.spanId, row);
        const phase = phaseOfSpan(change.name);
        if (phase) {
          let entry = phaseGroups.get(phase);
          if (!entry) {
            entry = {
              group: reactive<PhaseGroupVm>({ kind: "phase", phase, key: key(phase), rows: [], open: true }),
              toggled: false,
            };
            phaseGroups.set(phase, entry);
            state.log.push(entry.group);
          }
          entry.group.rows.push(row);
          phaseOfRow.set(change.spanId, entry.group);
          return;
        }
        state.log.push(row);
        return;
      }
      case "answer":
        flushTurn("wrote the reply below"); // the reply's own thinking has no step to sit on
        state.reply = { text: change.text, at: change.at };
        return;
    }
  }

  /** A phase's head closes on its own only while the reader has left it alone. */
  function closePhase(phase: Phase): void {
    const entry = phaseGroups.get(phase);
    if (entry && !entry.toggled) entry.group.open = false;
  }

  function handle(event: unknown): void {
    const e = event as { at?: unknown; type?: unknown } | null;
    // Span records (docs/reference/specs/tracing.md) are timing, not content: they never
    // move the stream's first/last stamps or the runner clock.
    const isSpan = e?.type === "span_start" || e?.type === "span_end";
    if (e && typeof e.type === "string") {
      const ev = event as RunEvent;
      losses.push(ev);
      if (isSpanRecord(ev)) foldSpanRecord(spans, ev, "");
      state.traceVersion++;
    }
    if (e && !isSpan && typeof e.at === "number") {
      if (state.firstAt === null || e.at < state.firstAt) state.firstAt = e.at;
      if (state.lastAt === null || e.at >= state.lastAt) {
        state.lastAt = e.at;
        state.lastAtWall = wallNow();
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
    for (const entry of phaseGroups.values()) {
      entry.group.open = open;
      entry.toggled = true;
    }
    for (const c of callVms.values()) c.open = open;
  }

  function reveal(anchor: string): boolean {
    if (anchor.startsWith("call-")) {
      const id = anchor.slice("call-".length);
      const step = stepOfCall.get(id);
      if (!step || !callVms.has(id)) return false;
      step.manual = true;
      step.groupOpen = true;
      return true;
    }
    if (anchor.startsWith("span-")) {
      const id = anchor.slice("span-".length);
      const group = phaseOfRow.get(id);
      if (group) {
        group.open = true;
        const entry = phaseGroups.get(group.phase);
        if (entry) entry.toggled = true;
        return true;
      }
      if (spanRows.has(id)) return true;
      // A model turn's span heads the step it produced (or its own flushed row).
      for (const item of state.log) {
        if (item.kind === "step" && item.turn?.spanId === id) return true;
        if (item.kind === "turn" && item.turn.spanId === id) return true;
      }
    }
    return false;
  }

  function markStopping(mode: "soft" | "hard"): void {
    state.stopMode = mode;
  }

  function noteElided(range: ReplayElidedRange): void {
    state.elided.push(range);
    state.log.push({ kind: "note", key: key("note"), replay: true, text: elidedText(range) });
    state.placeholder = false;
    state.traceVersion++;
  }

  return {
    state,
    handle,
    noteElided,
    spanSet: () => [...spans.values()],
    losses: (windowStart) => losses.losses({ windowStart, elided: state.elided }),
    pendingCall,
    flushPendingTurn: flushTurn,
    closePhases() {
      closePhase("getting_ready");
      closePhase("finishing_up");
    },
    setAllOpen,
    togglePhase(group) {
      group.open = !group.open;
      const entry = phaseGroups.get(group.phase);
      if (entry) entry.toggled = true;
    },
    reveal,
    callHeadline: (callId) => callVms.get(callId)?.headline,
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

/** The header's one duration (live-view item 22; docs/reference/specs/tracing.md): the
 *  whole run from `receivedAt` (falling back to `startedAt`) on the SERVER
 *  clock, projected forward arrival-relative — `serverNow` plus the browser
 *  time since the seed arrived — so the tick never subtracts a server stamp
 *  from the browser's clock. `finishedAt` on the seed freezes it. The same
 *  `runDurationMs` the index row, `runs list` and the history seed use. */
export interface RunClockSeed {
  serverNow: number;
  startedAt: number;
  receivedAt?: number;
  finishedAt?: number;
}

export interface RunClock {
  /** The projected server clock at `browserNow`. */
  now(browserNow: number): number;
  /** The run's duration at `browserNow`: frozen once `finishedAt` is known. */
  elapsedMs(browserNow: number): number;
  /** The run's duration frozen at a server stamp — the `finished` frame's
   *  `finishedAt` — through the same one definition, never a browser clock. */
  elapsedAt(finishedAt: number): number;
}

export function createRunClock(seed: RunClockSeed, browserNowAtSeed: number): RunClock {
  return {
    now: (browserNow) => seed.serverNow + (browserNow - browserNowAtSeed),
    elapsedMs(browserNow) {
      return runDurationMs(seed, this.now(browserNow)) ?? 0;
    },
    elapsedAt(finishedAt) {
      return runDurationMs({ receivedAt: seed.receivedAt, startedAt: seed.startedAt, finishedAt }) ?? 0;
    },
  };
}

/** Parse an `end` frame's payload: the seal stamp and the tri-state `replyOk`
 *  (docs/reference/specs/tracing.md). A stored stream's `end` carries `{}` — no stamp, no
 *  caption; anything malformed reads the same. */
export function parseEndFrame(data: string | undefined): { sealedAt?: number; replyOk?: boolean } {
  if (typeof data !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const { sealedAt, replyOk } = parsed as { sealedAt?: unknown; replyOk?: unknown };
  return {
    ...(typeof sealedAt === "number" && Number.isFinite(sealedAt) && sealedAt > 0 ? { sealedAt } : {}),
    ...(typeof replyOk === "boolean" ? { replyOk } : {}),
  };
}

/** The delivery caption beside a finished run's duration: `delivered in 2s`
 *  when the first reply attempt landed (`replyOk` true, and both stamps known),
 *  `reply failed` when it threw, nothing when none was measured — a fall-through
 *  command run, a backstop or sweep seal, a record without the stamps. */
export function deliveryCaption(run: { finishedAt?: number; sealedAt?: number; replyOk?: boolean }): string {
  if (run.replyOk === false) return "reply failed";
  if (run.replyOk !== true || run.finishedAt === undefined || run.sealedAt === undefined) return "";
  return `delivered in ${formatDuration(Math.max(0, run.sealedAt - run.finishedAt), "clock")}`;
}

/** Parse a `finished` frame's payload — one finite server stamp — or null. */
export function parseFinishedFrame(data: string | undefined): { finishedAt: number } | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { finishedAt } = parsed as { finishedAt?: unknown };
  return typeof finishedAt === "number" && Number.isFinite(finishedAt) && finishedAt > 0 ? { finishedAt } : null;
}

/** The projected runner clock, provided by the run page to every card so a
 *  running card can tick its own elapsed in place (null on a history page:
 *  nothing there is live, so nothing ticks). */
export const RunnerClockKey: InjectionKey<Ref<number | null>> = Symbol("sb-runner-clock");

/** Two model refs name one model when they are equal, or when one is a bare id
 *  (no provider) and the other is a ref whose name is that id — v0.4.0's runner
 *  stamped turns with the bare id while `run_meta` carried the ref, which read
 *  as a model switch on every run's first turn. Two refs with different
 *  providers are different models even when the names match. */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const aBare = !a.includes("/");
  const bBare = !b.includes("/");
  if (aBare === bBare) return false;
  return modelName(a) === modelName(b);
}

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
