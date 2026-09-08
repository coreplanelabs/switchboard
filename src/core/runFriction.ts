import type { RunEvent } from "./runEvents.js";
import { isSpanRecord } from "./runEvents.js";
import { lossesFromStream, normalizeSpans, spansFromEvents } from "./normalizeSpans.js";
import { formatShape } from "./runShape.js";
import { formatDuration } from "./time/formatDuration.js";
import { partition, type LossInterval, type Partition, type Window } from "./trace/partition.js";
import type { RunOwner } from "./trace/streamSpans.js";
import type { SpanRecord } from "./trace/types.js";

// Run-friction analyzer (docs/reference/specs/run-friction.md): a PURE, deterministic
// function from a run's RunEvent stream to a structured diagnosis of what cost
// the run time or made it stumble — slow/failed tool calls, slow model turns,
// retries, setup/install time, wrap-up, budget hits, exec-infrastructure
// failures — and, for a finished run with a window, its shape: how the window
// splits into getting ready, thinking, tools, finishing up and overhead
// (docs/reference/specs/tracing.md item 5). It is the observe→diagnose half of the
// self-improvement loop; proposing fix PRs from a diagnosis is a later piece
// and deliberately NOT here. No clock, no I/O: the same events always yield the
// same diagnosis, so it runs identically over a live backlog
// (`/runs/:id/friction`), a saved JSONL stream (`friction analyze`), or a test
// fixture.
//
// Every duration comes from ONE span set: the stream normalized through
// `normalizeSpans` (a legacy stream's turns, pairs and MCP facts become the
// spans a live run emits) and paired by `spansFromEvents`. Model time is the
// sum of the `model.turn` spans, tool time the sum of the `tool.*` spans, and
// each timed finding carries the duration of the span it is about — so a
// tool-denominated finding is a summand of tool time and a slow turn of model
// time, and no share can exceed 100 %.

export type FrictionCategory =
  | "slow_tool"
  | "slow_model_turn"
  | "failed_tool"
  | "retry"
  | "setup_install"
  | "wrap_up"
  | "budget_hit"
  | "infra_failure";

export const FRICTION_CATEGORIES: readonly FrictionCategory[] = [
  "slow_tool",
  "slow_model_turn",
  "failed_tool",
  "retry",
  "setup_install",
  "wrap_up",
  "budget_hit",
  "infra_failure",
];

/** Human labels — the verdict line, the report's table and its finding lines. */
export const CATEGORY_LABEL: Record<FrictionCategory, string> = {
  slow_tool: "slow tool calls",
  slow_model_turn: "slow model turns",
  failed_tool: "failed tool calls",
  retry: "retries",
  setup_install: "the repo's setup/install",
  wrap_up: "agent wind-down",
  budget_hit: "budget hits",
  infra_failure: "infra failures",
};

/** What a category's time is a share OF: tool time for the categories whose
 *  findings are tool calls (each a summand of `toolTimeMs`), run time for the
 *  rest. A new category must choose, so no share can exceed 100 %. */
export const DENOMINATOR_OF: Record<FrictionCategory, "tool" | "run"> = {
  slow_tool: "tool",
  failed_tool: "tool",
  retry: "tool",
  setup_install: "tool",
  slow_model_turn: "run",
  wrap_up: "run",
  budget_hit: "run",
  infra_failure: "run",
};

export type FrictionSeverity = "low" | "medium" | "high";

export interface FrictionFinding {
  category: FrictionCategory;
  severity: FrictionSeverity;
  /** One line: what happened. Derived from event summaries, which are already redacted upstream. */
  summary: string;
  /** Tool involved, for tool-anchored findings. */
  tool?: string;
  /** Wall time attributed to this finding, when the events carried timestamps:
   *  the duration of the span it is about. */
  durationMs?: number;
  /** The finding's own interval, for the run-denominated categories whose
   *  category time is the UNION of their findings (three calls of one batch
   *  dying together are one interval, not three). Absent on a note-anchored
   *  finding with no extent (a budget hit, a dead sandbox). */
  interval?: { start: number; end: number };
  /** Index into the input stream of the event the finding anchors to: the
   *  tool_call for tool findings, the note for note findings, the event a model
   *  turn produced (its `span_end`, or the synthesized twin's terminator) for a
   *  slow turn. */
  eventIndex: number;
}

export interface CategoryTotals {
  count: number;
  /** The category's attributed time: the sum of its findings' `durationMs` for
   *  the tool-denominated categories and `slow_model_turn` (whose turns are
   *  disjoint), the union of its findings' intervals for the other
   *  run-denominated ones; 0 without timings. */
  durationMs: number;
}

/** The run's shape (docs/reference/specs/tracing.md item 5): the seven terms of a finished
 *  window. Absent while a run is live or when no window was given. */
export type RunShape = Omit<Partition, "backgroundOnlyMs">;

export interface FrictionDiagnosis {
  eventCount: number;
  toolCalls: number;
  /** True iff at least one event carried a timestamp (durations are meaningful). */
  hasTimings: boolean;
  /** The window (`receivedAt` → `finishedAt`, or now) when one was given; else
   *  first→last content stamp. */
  runMs?: number;
  /** Sum of the `tool.*` span durations, when timed. */
  toolTimeMs?: number;
  /** Sum of the `model.turn` span durations, when the stream had a turn and
   *  timings. Thinking and tool time are the counted terms of the shape; the
   *  rest of the window is setup, finishing up and Switchboard overhead. */
  modelTimeMs?: number;
  /** Every category present, zeroed when absent. */
  byCategory: Record<FrictionCategory, CategoryTotals>;
  /** In detection order (stream order). */
  findings: FrictionFinding[];
  /** One-line headline: the dominant cause, or "no friction detected". */
  verdict: string;
  /** Present (true) when the analyzed stream lost records — the registry's
   *  bounded backlog or the record budget dropped some before the diagnosis
   *  ran — so the counts and timings describe part of the run, not all of it.
   *  Optional: a stored diagnosis from before this field reads as complete. */
  truncatedInput?: true;
  /** The finished window's shape, when a window was given and the run finished. */
  shape?: RunShape;
}

export interface FrictionOptions {
  /** A paired tool call taking at least this long is a `slow_tool`. Default 30s. */
  slowToolMs?: number;
  /** A model turn taking at least this long is a `slow_model_turn`. Default 60s. */
  slowModelTurnMs?: number;
  /** Whether the stream is complete (default true). For an in-flight run a
   *  trailing tool_call without a result is simply still running — only in a
   *  finished stream is it evidence the run died mid-tool. */
  finished?: boolean;
  /** Whether `events` is a truncated stream (`RunSnapshot.truncated`): the
   *  diagnosis is then stamped `truncatedInput: true`. Default false. */
  truncated?: boolean;
  /** The run's window (docs/reference/specs/tracing.md): `receivedAt` to `finishedAt` (a
   *  record), or to now (a live read). With it `runMs` is the window and a
   *  finished diagnosis carries `shape`; open spans run to its end while live.
   *  Absent (a stdin capture): `runMs` is first→last over the content events
   *  and there is no shape. */
  window?: Window;
  /** Who owns the run: `run.command` counts as tools for a command run and as
   *  getting ready for an agent run. Default `agent`. */
  owner?: RunOwner;
  /** The stream's schema (a record's, or `SPAN_SCHEMA` for a live stream);
   *  absent reads as legacy, which `normalizeSpans` adapts. */
  schema?: number;
}

const DEFAULT_SLOW_TOOL_MS = 30_000;
const DEFAULT_SLOW_MODEL_TURN_MS = 60_000;

// Setup/install commands, matched at the START of a shell segment (after `$ `,
// `&&`, `;`, `|`), so `echo npm install` and `npm test` don't match while
// `cd repo && npm install` does. `(?=\s|$)` (not `\b`) ends each subcommand
// word, so `npm ci-lockfile-report` is not `npm ci`. Optional wrappers: `sudo`,
// `corepack`, `python -m` (for pip).
const INSTALL_SEGMENT =
  /(?:^|&&|;|\|\|?)\s*(?:sudo\s+)?(?:corepack\s+)?(?:(?:npm|pnpm|bun)\s+(?:install|i|ci|add)(?=\s|$)|yarn(?:\s+(?:install|add)(?=\s|$)|\s*$)|npx\s+playwright\s+install(?=\s|$)|(?:python3?\s+-m\s+)?pip3?\s+install(?=\s|$)|poetry\s+install(?=\s|$)|uv\s+(?:sync|pip\s+install)(?=\s|$)|apt(?:-get)?\s+install(?=\s|$)|apk\s+add(?=\s|$)|brew\s+install(?=\s|$)|bundle\s+install(?=\s|$)|gem\s+install(?=\s|$)|cargo\s+(?:fetch|build)(?=\s|$)|go\s+mod\s+download(?=\s|$)|git\s+clone(?=\s|$)|make\s+(?:deps|install|setup)(?=\s|$))/;

// Quoted string literals ("…" / '…'): prose to the shell, not command segments.
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

/** True for a bash tool_call summary (`$ <command>`) that is a setup/install
 *  step. Quoted text is blanked first so `echo "cd x && npm install"` is not
 *  an install. Tolerates a non-string (a corrupted external capture) → false. */
export function isSetupInstallCommand(summary: unknown): boolean {
  if (typeof summary !== "string") return false;
  const cmd = summary.startsWith("$ ") ? summary.slice(2) : summary;
  return INSTALL_SEGMENT.test(cmd.replace(QUOTED, '""'));
}

interface PendingCall {
  index: number;
  event: Extract<RunEvent, { type: "tool_call" }>;
}

/** The event types that tell the run's story rather than its steps — the
 *  narrative (`input`/`context`/`assistant`/`answer`) and the model call's own
 *  legacy receipt (`turn`), which sits above the step it produced but is not one. */
type NarrativeEvent = Extract<RunEvent, { type: "input" | "context" | "assistant" | "answer" | "turn" | "run_meta" }>;
function isNarrative(ev: RunEvent): ev is NarrativeEvent {
  return (
    ev.type === "input" ||
    ev.type === "context" ||
    ev.type === "assistant" ||
    ev.type === "answer" ||
    ev.type === "turn" ||
    ev.type === "run_meta"
  );
}

/** The span set the analyzer reads, with two indices per span end into the
 *  ORIGINAL stream: `anchorOf` — the event the span ended at (its own `span_end`
 *  when the stream carried one, else the first original event after the
 *  synthesized end) — and `producedOf` — the first content event after it, the
 *  event a model turn produced (its tool call, its narration, the answer). */
function spanSet(events: readonly RunEvent[], schema: number | undefined) {
  const normalized = normalizeSpans(events, { schema });
  const spans = spansFromEvents(normalized, "run");
  const originalIndex = new Map<RunEvent, number>();
  events.forEach((e, i) => originalIndex.set(e, i));
  const anchorOf = new Map<string, number>();
  const producedOf = new Map<string, number>();
  // Walk from the end so each span end learns the originals that follow it.
  let nextOriginal = events.length - 1;
  let nextContent: number | undefined;
  for (let p = normalized.length - 1; p >= 0; p--) {
    const x = normalized[p]!;
    const own = originalIndex.get(x);
    if (x.type === "span_end") {
      anchorOf.set(x.spanId, own ?? nextOriginal);
      if (nextContent !== undefined) producedOf.set(x.spanId, nextContent);
    }
    if (own !== undefined) {
      nextOriginal = own;
      if (!isSpanRecord(x)) nextContent = own;
    }
  }
  return { spans, anchorOf, producedOf };
}

function unionMs(intervals: ReadonlyArray<{ start: number; end: number }>): number {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cur: { start: number; end: number } | undefined;
  for (const i of sorted) {
    if (cur && i.start <= cur.end) {
      cur.end = Math.max(cur.end, i.end);
      continue;
    }
    if (cur) total += cur.end - cur.start;
    cur = i;
  }
  if (cur) total += cur.end - cur.start;
  return total;
}

/** Analyze a run's event stream. Pure and deterministic; never mutates `events`. */
export function analyzeRunFriction(events: readonly RunEvent[], opts: FrictionOptions = {}): FrictionDiagnosis {
  const slowToolMs = opts.slowToolMs ?? DEFAULT_SLOW_TOOL_MS;
  const slowModelTurnMs = opts.slowModelTurnMs ?? DEFAULT_SLOW_MODEL_TURN_MS;
  const finished = opts.finished ?? true;
  const owner: RunOwner = opts.owner ?? "agent";
  const window = opts.window;

  // ---- the content pass: what happened, in stream order -------------------
  const findings: FrictionFinding[] = [];
  // Pending calls awaiting their result, FIFO per tool name (the runner emits
  // call→result sequentially; pairing per tool is robust to interleaving).
  const pending = new Map<string, PendingCall[]>();
  // `tool summary` keys that have failed at least once → a later identical call is a retry.
  const failedCalls = new Set<string>();
  let toolCalls = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  // The content events' stamps: `context` is replayed thread history published
  // at run start with timestamps of its own, so it never moves the clock; span
  // records are timing, not steps, and never move it either.
  for (const ev of events) {
    if (isSpanRecord(ev) || ev.type === "context") continue;
    if (ev.at !== undefined) {
      firstAt ??= ev.at;
      lastAt = ev.at;
    }
  }
  const windowEnd = window?.end ?? lastAt;
  // A stream whose content carried no stamps has no durations — a legacy or
  // hand-written capture: the same classification, nothing timed.
  const hasTimings = firstAt !== undefined;

  // ---- the span set: every duration comes from here -------------------------
  const { spans, anchorOf, producedOf } = spanSet(events, opts.schema);
  const losses: LossInterval[] = window ? lossesFromStream(events, { windowStart: window.start }) : [];
  const lossStarts = losses.map((l) => l.from).sort((a, b) => a - b);
  /** A span's end: its own, or — open — the window's end while live, the next
   *  loss after its start once finished (nothing can still be running; the end
   *  was lost), else the last content stamp. */
  const endOf = (s: SpanRecord): number | undefined => {
    if (s.endedAt !== undefined) return s.endedAt;
    if (!finished) return windowEnd;
    const next = lossStarts.find((at) => at > s.startedAt);
    return next ?? windowEnd;
  };
  const durationOfSpan = (s: SpanRecord): number | undefined => {
    if (!hasTimings) return undefined;
    const end = endOf(s);
    return end === undefined ? undefined : Math.max(0, end - s.startedAt);
  };
  const toolSpans = spans.filter((s) => s.name.startsWith("tool."));
  const turnSpans = spans.filter((s) => s.name === "model.turn");
  const toolSpanByCallId = new Map<string, SpanRecord>();
  const toolSpanById = new Map<string, SpanRecord>();
  for (const s of toolSpans) {
    toolSpanById.set(s.spanId, s);
    const callId = s.attrs.callId;
    if (typeof callId === "string") toolSpanByCallId.set(callId, s);
  }
  /** The span a call/result pair is about: by the stamped `spanId`, by
   *  `callId`, or by the synthesized id the Adapter minted from the call's index. */
  const spanOfCall = (
    call: PendingCall | undefined,
    result: Extract<RunEvent, { type: "tool_result" }>,
  ): SpanRecord | undefined => {
    const stamped = result.spanId ?? call?.event.spanId;
    if (stamped !== undefined && toolSpanById.has(stamped)) return toolSpanById.get(stamped);
    const callId = result.callId ?? call?.event.callId;
    if (callId !== undefined && toolSpanByCallId.has(callId)) return toolSpanByCallId.get(callId);
    if (callId !== undefined && toolSpanById.has(`synth:${callId}`)) return toolSpanById.get(`synth:${callId}`);
    return call ? toolSpanById.get(`synth:${call.index}`) : undefined;
  };

  // Slow turns, keyed by the event they produced, so they land in stream order
  // before that event's own findings (a turn is over before its tool starts).
  const turnFindingsAt = new Map<number, FrictionFinding[]>();
  let modelTimeMs: number | undefined;
  for (const s of turnSpans) {
    const durationMs = durationOfSpan(s);
    if (durationMs === undefined) continue;
    modelTimeMs = (modelTimeMs ?? 0) + durationMs;
    if (durationMs < slowModelTurnMs) continue;
    const anchor = anchorOf.get(s.spanId) ?? events.length - 1;
    const produced = events[producedOf.get(s.spanId) ?? anchor];
    const what =
      produced?.type === "tool_call"
        ? typeof produced.summary === "string"
          ? produced.summary
          : produced.tool
        : produced?.type === "assistant"
          ? "(narration)"
          : produced?.type === "answer"
            ? "(answer)"
            : typeof s.attrs.stopReason === "string"
              ? `(${s.attrs.stopReason})`
              : "(a model turn)";
    const finding: FrictionFinding = {
      category: "slow_model_turn",
      severity: durationMs >= 2 * slowModelTurnMs ? "high" : "medium",
      summary: `model turn took ${formatDuration(durationMs, "report")} before: ${what}`,
      durationMs,
      interval: { start: s.startedAt, end: s.startedAt + durationMs },
      eventIndex: anchor,
    };
    turnFindingsAt.set(anchor, [...(turnFindingsAt.get(anchor) ?? []), finding]);
  }
  const flushTurns = (index: number) => {
    const list = turnFindingsAt.get(index);
    if (list) {
      findings.push(...list);
      turnFindingsAt.delete(index);
    }
  };

  // The narrative events — the request (`input`), the thread context fed to
  // the model (`context`), the model's prose between tools (`assistant`), the
  // final answer (`answer`) — are the run's story, not its steps: none counts
  // toward `eventCount`.
  let narrativeEvents = 0;
  let sideFactEvents = 0; // skill_use / review_artifact / pr_description / pr_opened / ship_round: facts about the run, not steps
  let spanEvents = 0; // span_start / span_end (docs/reference/specs/tracing.md): timing records, not steps
  let wrapUp: { index: number; at?: number } | undefined;
  events.forEach((ev, index) => {
    flushTurns(index);
    if (isSpanRecord(ev)) {
      spanEvents++;
      return;
    }
    if (isNarrative(ev)) narrativeEvents++;
    // The narrative, the legacy `turn` receipt and `run_meta` are neither steps nor findings.
    if (ev.type === "context" || ev.type === "input" || ev.type === "assistant" || ev.type === "answer") return;
    if (ev.type === "turn" || ev.type === "run_meta") return;
    // Side facts about the run, not steps: skill_use rides beside a use_skill
    // call that already produced its own tool pair; review_artifact,
    // pr_description, pr_opened and the ship_round boundaries are published
    // by the dispatcher/pipeline outside the model loop entirely. Counting
    // any of them would distort the story.
    if (
      ev.type === "skill_use" ||
      ev.type === "mcp_tool_use" ||
      ev.type === "review_artifact" ||
      ev.type === "pr_description" ||
      ev.type === "pr_opened" ||
      ev.type === "ship_round"
    ) {
      sideFactEvents++;
      return;
    }

    if (ev.type === "tool_call") {
      toolCalls++;
      if (failedCalls.has(`${ev.tool} ${ev.summary}`)) {
        findings.push({
          category: "retry",
          severity: "low",
          summary: `retried after failure: ${ev.summary}`,
          tool: ev.tool,
          eventIndex: index,
        });
      }
      const queue = pending.get(ev.tool) ?? [];
      queue.push({ index, event: ev });
      pending.set(ev.tool, queue);
      return;
    }

    if (ev.type === "tool_result") {
      const callEntry = pending.get(ev.tool)?.shift();
      const anchor = callEntry?.index ?? index;
      const callSummary = callEntry?.event.summary ?? ev.tool;
      const span = spanOfCall(callEntry, ev);
      const durationMs = span ? durationOfSpan(span) : undefined;
      const timed = (f: FrictionFinding): FrictionFinding => (durationMs !== undefined ? { ...f, durationMs } : f);
      const interval =
        span && durationMs !== undefined
          ? { interval: { start: span.startedAt, end: span.startedAt + durationMs } }
          : {};

      if (!ev.ok) failedCalls.add(`${ev.tool} ${callSummary}`);

      if (ev.infra) {
        // An infra-level failure is the sandbox, not the command: classify once,
        // as infra — but name the command that was running, so "the sandbox died
        // during installs" is readable from the findings alone.
        findings.push(
          timed({
            category: "infra_failure",
            severity: "high",
            summary: `exec infrastructure failed during ${callSummary} → ${ev.summary}`,
            tool: ev.tool,
            ...interval,
            eventIndex: anchor,
          }),
        );
        return;
      }
      if (ev.tool === "bash" && isSetupInstallCommand(callSummary)) {
        // Setup/install is reported once, as setup — a slow or failed install is
        // still setup cost — so the category total is the true install bill.
        const slow = durationMs !== undefined && durationMs >= slowToolMs;
        const label = !ev.ok ? "install failed" : slow ? "slow install" : "install";
        findings.push(
          timed({
            category: "setup_install",
            severity: !ev.ok ? "high" : slow ? "medium" : "low",
            summary: `${label}: ${callSummary}${!ev.ok ? ` → ${ev.summary}` : ""}`,
            tool: ev.tool,
            eventIndex: anchor,
          }),
        );
        return;
      }
      if (!ev.ok) {
        // A failure that was ALSO slow cost more than a fast one: high once it
        // crosses the slow threshold (the same bar slow_tool uses).
        const slowFailure = durationMs !== undefined && durationMs >= slowToolMs;
        findings.push(
          timed({
            category: "failed_tool",
            severity: slowFailure ? "high" : "medium",
            summary: `${callSummary} → ${ev.summary}`,
            tool: ev.tool,
            eventIndex: anchor,
          }),
        );
        return;
      }
      if (durationMs !== undefined && durationMs >= slowToolMs) {
        findings.push(
          timed({
            category: "slow_tool",
            severity: durationMs >= 2 * slowToolMs ? "high" : "medium",
            summary: `took ${formatDuration(durationMs, "report")}: ${callSummary}`,
            tool: ev.tool,
            eventIndex: anchor,
          }),
        );
      }
      return;
    }

    switch (ev.kind) {
      case "wrap_up":
        // Its extent is the time from the warning to the end of the window (how
        // long the wind-down actually took); filled in after the loop.
        wrapUp = { index, at: ev.at };
        findings.push({ category: "wrap_up", severity: "medium", summary: ev.summary, eventIndex: index });
        return;
      case "time_budget_exhausted":
        findings.push({
          category: "budget_hit",
          severity: "high",
          summary: `budget hit (time): ${ev.summary}`,
          eventIndex: index,
        });
        return;
      case "turn_budget_exhausted":
        findings.push({
          category: "budget_hit",
          severity: "high",
          summary: `budget hit (turns): ${ev.summary}`,
          eventIndex: index,
        });
        return;
      case "sandbox_dead":
        findings.push({
          category: "infra_failure",
          severity: "high",
          summary: `sandbox dead: ${ev.summary}`,
          eventIndex: index,
        });
        return;
      case "fleet_busy":
        // Capacity, not a dead sandbox: the run went on, but the minutes spent
        // waiting for an instance are friction the fleet's sizing owns.
        findings.push({
          category: "infra_failure",
          severity: "medium",
          summary: `fleet busy: ${ev.summary}`,
          eventIndex: index,
        });
        return;
    }
  });
  // A slow turn whose produced event is past the stream (a turn that ended the run).
  for (const index of [...turnFindingsAt.keys()].sort((a, b) => a - b)) flushTurns(index);

  // In a FINISHED stream, a call with no result means the run ended mid-tool
  // (process died, stream cut) — infrastructure friction that must not vanish
  // silently. Mid-run it is just the tool still executing. Its extent is the
  // open tool span's: to the next loss, else to the window's end.
  for (const queue of finished ? pending.values() : []) {
    for (const { index, event } of queue) {
      const open =
        (event.spanId !== undefined ? toolSpanById.get(event.spanId) : undefined) ??
        (event.callId !== undefined ? toolSpanByCallId.get(event.callId) : undefined) ??
        toolSpanById.get(`synth:${index}`);
      const durationMs = open ? durationOfSpan(open) : undefined;
      findings.push({
        category: "infra_failure",
        severity: "high",
        summary: `no result for tool call (run ended mid-tool): ${event.summary}`,
        tool: event.tool,
        eventIndex: index,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(open && durationMs !== undefined
          ? { interval: { start: open.startedAt, end: open.startedAt + durationMs } }
          : {}),
      });
    }
  }
  if (wrapUp !== undefined) {
    const { index, at } = wrapUp;
    const f = findings.find((x) => x.category === "wrap_up" && x.eventIndex === index);
    if (at !== undefined && windowEnd !== undefined && f) {
      f.durationMs = Math.max(0, windowEnd - at);
      f.interval = { start: at, end: Math.max(at, windowEnd) };
    }
  }

  // ---- totals ----------------------------------------------------------------
  let toolTimeMs: number | undefined;
  for (const s of toolSpans) {
    const d = durationOfSpan(s);
    if (d !== undefined) toolTimeMs = (toolTimeMs ?? 0) + d;
  }
  const byCategory = Object.fromEntries(
    FRICTION_CATEGORIES.map((c) => [c, { count: 0, durationMs: 0 } satisfies CategoryTotals]),
  ) as Record<FrictionCategory, CategoryTotals>;
  for (const f of findings) byCategory[f.category].count++;
  for (const c of FRICTION_CATEGORIES) {
    const own = findings.filter((f) => f.category === c);
    // Turns are disjoint (one loop runs at a time), so their sum is their union.
    byCategory[c].durationMs =
      DENOMINATOR_OF[c] === "run" && c !== "slow_model_turn"
        ? unionMs(own.flatMap((f) => (f.interval ? [f.interval] : [])))
        : own.reduce((sum, f) => sum + (f.durationMs ?? 0), 0);
  }
  const runMs =
    window !== undefined
      ? Math.max(0, window.end - window.start)
      : firstAt !== undefined && lastAt !== undefined
        ? lastAt - firstAt
        : undefined;
  let shape: RunShape | undefined;
  if (window !== undefined && finished) {
    const { backgroundOnlyMs: _background, ...terms } = partition(spans, { window, owner, finished, losses });
    shape = terms;
  }

  const diagnosis: FrictionDiagnosis = {
    eventCount: events.length - narrativeEvents - sideFactEvents - spanEvents,
    toolCalls,
    hasTimings: hasTimings || window !== undefined,
    ...(runMs !== undefined ? { runMs } : {}),
    ...(runMs !== undefined && hasTimings ? { toolTimeMs: toolTimeMs ?? 0 } : {}),
    ...(runMs !== undefined && hasTimings && modelTimeMs !== undefined ? { modelTimeMs } : {}),
    byCategory,
    findings,
    verdict: "",
    ...(opts.truncated ? { truncatedInput: true as const } : {}),
    ...(shape ? { shape } : {}),
  };
  diagnosis.verdict = verdictOf(diagnosis);
  return diagnosis;
}

/** The dominant cause: most attributed time when timed (ties → most findings →
 *  category order), else most findings. Names the share of its denominator
 *  (`DENOMINATOR_OF`) so the reader knows whether the cause is the whole story. */
function verdictOf(d: FrictionDiagnosis): string {
  if (d.findings.length === 0) return "no friction detected";
  const ranked = FRICTION_CATEGORIES.filter((c) => d.byCategory[c].count > 0).sort(
    (a, b) => d.byCategory[b].durationMs - d.byCategory[a].durationMs || d.byCategory[b].count - d.byCategory[a].count,
  );
  const top = ranked[0];
  const t = d.byCategory[top];
  const what = `${CATEGORY_LABEL[top]} dominated: ${t.count} finding${t.count === 1 ? "" : "s"}`;
  if (!d.hasTimings || t.durationMs === 0) return what;
  const [denominator, of] = DENOMINATOR_OF[top] === "run" ? [d.runMs, "run time"] : [d.toolTimeMs, "tool time"];
  const share = denominator ? ` (${Math.round((t.durationMs / denominator) * 100)}% of ${of})` : "";
  return `${what}, ${formatDuration(t.durationMs, "report")}${share}`;
}

/** Plain-text report for the CLI / terminal. */
export function formatFrictionReport(d: FrictionDiagnosis): string {
  const lines: string[] = [`verdict: ${d.verdict}`];
  const totals = [`events: ${d.eventCount}`];
  if (d.toolCalls > 0) totals.push(`tool calls: ${d.toolCalls}`);
  if (d.runMs !== undefined) totals.push(`run: ${formatDuration(d.runMs, "report")}`);
  if (d.toolCalls > 0 && d.toolTimeMs !== undefined)
    totals.push(`tool time: ${formatDuration(d.toolTimeMs, "report")}`);
  if (d.modelTimeMs !== undefined) totals.push(`model time: ${formatDuration(d.modelTimeMs, "report")}`);
  if (!d.hasTimings) totals.push("(no timestamps — durations unavailable)");
  if (d.truncatedInput) totals.push("(input truncated — some records were dropped before analysis)");
  lines.push(totals.join(" · "));
  if (d.shape) {
    const shape = formatShape(d.shape);
    lines.push(`shape: ${shape ?? `${formatDuration(d.shape.windowMs, "report")} (one bucket)`}`);
  }
  const width = Math.max(...FRICTION_CATEGORIES.map((c) => CATEGORY_LABEL[c].length), "category".length);
  lines.push("", `${"category".padEnd(width)}  count  time`);
  for (const c of FRICTION_CATEGORIES) {
    const t = d.byCategory[c];
    const time = t.count && d.hasTimings && t.durationMs > 0 ? formatDuration(t.durationMs, "report") : "-";
    lines.push(`${CATEGORY_LABEL[c].padEnd(width)}  ${String(t.count).padStart(5)}  ${time}`);
  }
  if (d.findings.length > 0) {
    lines.push("", "findings (stream order):");
    for (const f of d.findings) {
      const dur = f.durationMs !== undefined ? ` (${formatDuration(f.durationMs, "report")})` : "";
      lines.push(`  #${f.eventIndex} [${CATEGORY_LABEL[f.category]}] ${f.severity}${dur} ${f.summary}`);
    }
  }
  return lines.join("\n");
}
