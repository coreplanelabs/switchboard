// The run page's grouping model (docs/reference/specs/live-view.md item 13).
//
// The event stream is flat: `assistant` prose, then that turn's `tool_call`s,
// each followed by its `tool_result`. A human reads a run in STEPS — "the agent
// said X, then ran these commands, and here is how each went" — so this module
// folds the flat stream into steps → calls → results, incrementally, and
// derives everything the page shows on a call card (status, exit code, size,
// duration) so the page does DOM only and this stays unit-testable.
//
// Grouping rules (deterministic — no heuristics):
//   - an `assistant` event opens a new step, with that prose as its narration;
//   - a `tool_call` joins the current step (calls before any prose form one
//     un-narrated leading step);
//   - a `tool_result` attaches to its call by `callId`; a result whose call was
//     never seen (backlog trimmed mid-pair) or that carries no id becomes a
//     call of its own, so nothing is dropped;
//   - `context` (a thread turn the model was given) and `replay_note` (the
//     stream's own capped-replay notice) pass through as their own change
//     kinds — neither opens or joins a step.
//
// Pure and DOM-free (the page does DOM only), so it stays unit-testable and the
// dashboard bundle imports it as an ordinary module.

import { formatDuration } from "../core/time/formatDuration.js";

export interface TimelineResult {
  ok: boolean;
  exitCode?: number;
  infra: boolean;
  summary: string;
  output: string;
  at?: number;
}

export interface TimelineCall {
  /** The pair key: the event's callId, else a synthetic position id. */
  id: string;
  tool: string;
  /** What to show as the card's headline: the command for a shell call
   *  (without the `$ ` marker), the call summary otherwise. */
  title: string;
  shell: boolean;
  /** The collapsed card's one-line headline: the command's first line without
   *  its leading `cd … &&` hops (they say where, not what), with a trailing `…`
   *  when more follows. The full title shows when the card is open. */
  headline: string;
  /** Bookkeeping calls (update_status) render as one muted line, not a card. */
  quiet: boolean;
  /** What kind of call this is, for the page's open-by-default rules and any
   *  future filter: for a shell call one of `tests`, `build`, `install`,
   *  `git`, `read`, `network`, `shell`; for other tools the tool name. After a
   *  result, also `failed` or `infra`. Deterministic, from the command text. */
  tags: string[];
  status: "running" | "ok" | "failed" | "infra";
  startedAt?: number;
  result?: TimelineResult;
  durationMs?: number;
  /** The header's right-hand facts, e.g. ["exit 1", "14 lines", "1.2s"]. */
  facts: string[];
}

/** Where the request came from (from the `input` event's `source`). */
export interface TimelineSource {
  url?: string;
  channel?: string;
  user?: string;
  /** The run that sent the input, when a run did (a parent's steer). */
  run?: string;
}

export interface TimelineStep {
  index: number;
  narration?: { text: string; at?: number };
  calls: TimelineCall[];
}

export type TimelineChange =
  | { kind: "input"; text: string; source?: TimelineSource; at?: number }
  | { kind: "step"; step: TimelineStep }
  | { kind: "call"; step: TimelineStep; call: TimelineCall }
  | { kind: "result"; step: TimelineStep; call: TimelineCall }
  | { kind: "note"; text: string; noteKind: string; mode?: string; at?: number }
  /** One model call: `label` is "Thought for 5m 04s"; `facts` the token counts
   *  ("12.3k in", "800 out", "11.2k cached") when the event carries usage;
   *  `spanId` the turn's own span, so the page can address the step it heads. */
  | { kind: "turn"; spanId: string; label: string; facts: string[]; durationMs: number; model?: string; at?: number }
  /** What the run is about (item 19): agent, model and the resolved repo context, for the Request head. */
  | {
      kind: "meta";
      agent: string;
      model: string;
      effort?: string;
      repo?: string;
      ref?: string;
      pr?: number;
      headSha?: string;
      at?: number;
    }
  /** One thread turn the model was given (a `context` event) — the page's
   *  collapsed Context block, never a step. */
  | { kind: "context"; text: string; at?: number }
  /** A notice from the transport itself (the SSE replay was capped) — rendered
   *  like a note; it is not a run event and never reaches the run record. */
  | { kind: "replay_note"; text: string }
  | { kind: "answer"; text: string; at?: number }
  /** The coding post-step's PR (a `pr_opened` event): what the reply is about,
   *  for the Reply head — opened new, or an existing open PR edited. */
  | { kind: "pr_opened"; url: string; number: number; created: boolean; at?: number }
  /** A skill loaded into context (a `skill_use` event): rendered inside the
   *  step whose `use_skill` call it belongs to, as its own row — not a call
   *  card (the call card is the tool's; this is what the tool loaded). */
  | { kind: "skill"; step: TimelineStep; skill: TimelineSkill }
  /** A streamed span that is neither a model turn nor a tool call
   *  (docs/reference/specs/tracing.md): a `dispatch.*` / `run.*` / `post.*` / `ship.round`
   *  step, rendered as its own row. `open` is a start with no end yet; the end
   *  comes as a second change with the same `spanId`. `name` is the raw span
   *  name — the page renders it through the display table, never as is. */
  | {
      kind: "span";
      spanId: string;
      name: string;
      open: boolean;
      durationMs?: number;
      status?: "ok" | "error";
      at?: number;
      /** A closed span's own start — what a row born from a lone end (its start elided) is stamped with. */
      startedAt?: number;
    };

export interface TimelineSkill {
  name: string;
  description: string;
  agent: string;
  /** Only an http(s) URL is kept — the page turns it into a link with setAttribute. */
  source?: string;
  bodyBytes: number;
  at?: number;
}

export interface RunTimeline {
  /** Fold one stream event; returns the changes the view must apply (possibly
   *  none — an unknown/malformed event is ignored, never thrown on). */
  push(event: unknown): TimelineChange[];
  /** The call still waiting for its result, if any (for the live tail). */
  pending(): TimelineCall | null;
  steps(): TimelineStep[];
}

export function createRunTimeline(): RunTimeline {
  const steps: TimelineStep[] = [];
  let current: TimelineStep | null = null;
  let seq = 0;
  // Calls without a result yet, oldest first — kept alongside the steps so
  // `pending()` (asked once per incoming event by the page's tail) is a lookup,
  // not a rescan of every step's every call.
  const pendingCalls: TimelineCall[] = [];

  function num(v: unknown): number | undefined {
    return typeof v === "number" && isFinite(v) ? v : undefined;
  }
  function str(v: unknown): string {
    return typeof v === "string" ? v : "";
  }

  function openStep(narration?: { text: string; at?: number }): TimelineStep {
    const step: TimelineStep = { index: steps.length, calls: [] };
    if (narration) step.narration = narration;
    steps.push(step);
    current = step;
    return step;
  }

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (Math.round(n / 100) / 10).toFixed(1) + "k";
    return (Math.round(n / 100_000) / 10).toFixed(1) + "M";
  }

  // The summary's size note is computed over the FULL output upstream (the
  // event's `output` is capped), so it is the truthful line count.
  function lineCount(result: TimelineResult): number | undefined {
    const m = /\((\d+) chars(?:, (\d+) lines)?\)$/.exec(result.summary);
    if (m) return m[2] ? Number(m[2]) : 1;
    if (!result.output) return undefined;
    return result.output.split("\n").length;
  }

  function facts(call: TimelineCall): string[] {
    const out: string[] = [];
    const r = call.result;
    if (!r) return out;
    if (r.infra) out.push("sandbox error");
    else if (call.shell) out.push(r.exitCode === undefined ? (r.ok ? "exit 0" : "error") : "exit " + r.exitCode);
    else if (!r.ok) out.push("error");
    const lines = lineCount(r);
    if (lines !== undefined && lines > 1) out.push(lines + " lines");
    if (call.durationMs !== undefined) out.push(formatDuration(call.durationMs, "precise"));
    return out;
  }

  function attach(call: TimelineCall, e: Record<string, unknown>): void {
    const result: TimelineResult = {
      ok: e.ok === true,
      infra: e.infra === true,
      summary: str(e.summary),
      output: str(e.output),
      at: num(e.at),
    };
    const code = num(e.exitCode);
    if (code !== undefined) result.exitCode = code;
    call.result = result;
    const pendingAt = pendingCalls.indexOf(call);
    if (pendingAt !== -1) pendingCalls.splice(pendingAt, 1);
    call.status = result.infra ? "infra" : result.ok ? "ok" : "failed";
    if (call.status !== "ok") call.tags = call.tags.concat(call.status);
    if (call.startedAt !== undefined && result.at !== undefined && result.at >= call.startedAt) {
      call.durationMs = result.at - call.startedAt;
    }
    call.facts = facts(call);
  }

  // Classify a shell command by the FIRST thing that looks like a verb in it,
  // scanning its `&&`/`;`/`|`-separated parts, so `cd x && npm test` is `tests`
  // and `git diff | head` is `git`. One tag per call, most specific first.
  const SHELL_KINDS: Array<[string, RegExp]> = [
    ["tests", /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|pytest|mocha|go test|cargo test)\b/],
    [
      "build",
      /\b(npm|pnpm|yarn|bun)\s+run\s+(build|typecheck|lint)\b|\b(tsc|make|cargo build|go build|eslint|prettier)\b/,
    ],
    [
      "install",
      /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add)\b|\bpip3?\s+install\b|\bapt(-get)?\s+install\b|\bbrew\s+install\b/,
    ],
    ["git", /(^|[\s;&|(])(git|gh)\s/],
    ["network", /(^|[\s;&|(])(curl|wget)\s/],
    ["read", /(^|[\s;&|(])(cat|sed|head|tail|less|ls|find|grep|rg|wc|tree|pwd|echo|env|which|stat|file|diff)\b/],
  ];
  /** A command without its leading `cd …` hops (`cd x && …`, `cd x; …`,
   *  `cd "a dir" && …`). */
  function withoutCdHops(command: string): string {
    const body = command.replace(/^(\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, "");
    return body.trim() ? body : command;
  }
  function classifyShell(command: string): string {
    const body = withoutCdHops(command);
    for (const [tag, re] of SHELL_KINDS) if (re.test(body)) return tag;
    return "shell";
  }
  function headlineOf(title: string, shell: boolean): string {
    const body = shell ? withoutCdHops(title) : title;
    const nl = body.indexOf("\n");
    const first = nl === -1 ? body : body.slice(0, nl).trimEnd();
    return first.length < title.length ? first + " \u2026" : first;
  }

  function newCall(e: Record<string, unknown>, summary: string): TimelineCall {
    const tool = str(e.tool);
    const shell = tool === "bash";
    const raw = summary || tool;
    // Shell: the command without its `$ ` marker. Other tools: the target
    // without the tool-name prefix (the card shows the tool as a chip).
    const title =
      shell && raw.startsWith("$ ")
        ? raw.slice(2)
        : !shell && raw.startsWith(tool + " ")
          ? raw.slice(tool.length + 1)
          : raw;
    const call: TimelineCall = {
      id: str(e.callId) || "c" + ++seq,
      tool,
      title,
      headline: headlineOf(title, shell),
      shell,
      quiet: tool === "update_status",
      tags: [shell ? classifyShell(title) : tool],
      status: "running",
      startedAt: num(e.at),
      facts: [],
    };
    pendingCalls.push(call);
    return call;
  }

  function findCallById(id: string): { step: TimelineStep; call: TimelineCall } | null {
    for (let i = steps.length - 1; i >= 0; i--) {
      for (const call of steps[i].calls) if (call.id === id) return { step: steps[i], call };
    }
    return null;
  }

  function findCall(e: Record<string, unknown>): { step: TimelineStep; call: TimelineCall } | null {
    const id = str(e.callId);
    if (!id) return null;
    for (let i = steps.length - 1; i >= 0; i--) {
      for (const call of steps[i].calls) if (call.id === id && !call.result) return { step: steps[i], call };
    }
    return null;
  }

  function push(event: unknown): TimelineChange[] {
    if (!event || typeof event !== "object") return [];
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "input": {
        const change: TimelineChange = { kind: "input", text: str(e.text), at: num(e.at) };
        const src = e.source;
        if (src && typeof src === "object") {
          const o = src as Record<string, unknown>;
          const source: TimelineSource = {};
          if (str(o.url)) source.url = str(o.url);
          if (str(o.channel)) source.channel = str(o.channel);
          if (str(o.user)) source.user = str(o.user);
          if (str(o.run)) source.run = str(o.run);
          if (Object.keys(source).length > 0) change.source = source;
        }
        return [change];
      }
      case "answer":
        return [{ kind: "answer", text: str(e.text), at: num(e.at) }];
      case "pr_opened": {
        const number = num(e.number);
        if (!str(e.url) || number === undefined || !Number.isInteger(number) || number <= 0) return [];
        return [{ kind: "pr_opened", url: str(e.url), number, created: e.created === true, at: num(e.at) }];
      }
      case "run_meta": {
        // Optional fields ride only when present (and well-typed) — the page
        // shows exactly what was resolved, never an empty slot.
        if (!str(e.agent)) return [];
        // A command run's meta names no model (docs/reference/specs/tracing.md).
        const meta: TimelineChange = { kind: "meta", agent: str(e.agent), model: str(e.model), at: num(e.at) };
        if (str(e.effort)) meta.effort = str(e.effort);
        if (str(e.repo)) meta.repo = str(e.repo);
        if (str(e.ref)) meta.ref = str(e.ref);
        if (num(e.pr) !== undefined && Number.isInteger(e.pr) && (e.pr as number) > 0) meta.pr = e.pr as number;
        if (/^[0-9a-f]{7,40}$/i.test(str(e.headSha))) meta.headSha = str(e.headSha);
        return [meta];
      }
      case "context":
        return [{ kind: "context", text: str(e.text), at: num(e.at) }];
      case "replay_note":
        return [{ kind: "replay_note", text: str(e.summary) }];
      case "run_note":
        return [
          { kind: "note", text: str(e.summary), noteKind: str(e.kind), mode: str(e.mode) || undefined, at: num(e.at) },
        ];
      case "assistant":
        return [{ kind: "step", step: openStep({ text: str(e.text), at: num(e.at) }) }];
      case "review_artifact":
        // The reading diff is the review panel's material (docs/reference/specs/reading-diff.md
        // roadmap) — the timeline's step story does not change shape for it.
        return [];
      case "span_start": {
        const name = str(e.name);
        const spanId = str(e.spanId);
        if (!name || !spanId) return [];
        // A tool's span decorates its call card (twin rule) and a model turn
        // its step; neither opens a row of its own. Everything else streamed is
        // a step row, open until its end arrives.
        if (name.startsWith("tool.") || name.startsWith("mcp.") || name === "model.turn") return [];
        return [{ kind: "span", spanId, name, open: true, at: num(e.at) }];
      }
      case "span_end": {
        const name = str(e.name);
        const spanId = str(e.spanId);
        const durationMs = num(e.durationMs);
        if (!name || !spanId || durationMs === undefined) return [];
        const status = e.status === "error" ? "error" : "ok";
        const attrs = typeof e.attrs === "object" && e.attrs !== null ? (e.attrs as Record<string, unknown>) : {};
        if (name === "model.turn") {
          // The model turn's one timing record (docs/reference/specs/tracing.md): the
          // turn row, from the span's attrs — and the step boundary.
          current = null;
          const facts: string[] = [];
          const inTok = num(attrs.inputTokens);
          const outTok = num(attrs.outputTokens);
          const cached = num(attrs.cacheReadTokens);
          if (inTok !== undefined) facts.push(fmtTokens(inTok) + " in");
          if (outTok !== undefined) facts.push(fmtTokens(outTok) + " out");
          if (cached !== undefined) facts.push(fmtTokens(cached) + " cached");
          // The turn's own timing, when the provider streamed it (live-view item 15).
          const ttft = num(attrs.ttftMs);
          if (ttft !== undefined) facts.push("first token " + formatDuration(ttft, "precise"));
          const thinking = num(attrs.thinkingMs);
          if (thinking !== undefined) facts.push("thinking " + formatDuration(thinking, "precise"));
          const writing = num(attrs.textMs);
          if (writing !== undefined) facts.push("writing " + formatDuration(writing, "precise"));
          const model = str(attrs.model);
          return [
            {
              kind: "turn",
              spanId,
              label: "Thought for " + formatDuration(durationMs, "precise"),
              facts,
              durationMs,
              ...(model ? { model } : {}),
              at: num(e.at),
            },
          ];
        }
        if (name.startsWith("tool.") || name.startsWith("mcp.")) {
          // The twin rule: the span's measured duration decorates the call card
          // whose `tool_call` carries its callId — when the result had no clock
          // of its own. An MCP span decorates nothing here (its tool span does).
          if (!name.startsWith("tool.")) return [];
          const callId = str(attrs.callId);
          if (!callId) return [];
          const found = findCallById(callId);
          if (!found || found.call.durationMs !== undefined) return [];
          found.call.durationMs = durationMs;
          found.call.facts = facts(found.call);
          return [{ kind: "result", step: found.step, call: found.call }];
        }
        const startedAt = num(e.startedAt);
        return [
          {
            kind: "span",
            spanId,
            name,
            open: false,
            durationMs,
            status,
            at: num(e.at),
            ...(startedAt !== undefined ? { startedAt } : {}),
          },
        ];
      }
      case "skill_use": {
        const name = str(e.skill);
        if (!name) return [];
        const changes: TimelineChange[] = [];
        if (!current) changes.push({ kind: "step", step: openStep() });
        const source = str(e.source);
        const skill: TimelineSkill = {
          name,
          description: str(e.description),
          agent: str(e.agent),
          bodyBytes: num(e.bodyBytes) ?? 0,
          at: num(e.at),
        };
        if (/^https?:\/\//.test(source)) skill.source = source;
        changes.push({ kind: "skill", step: current as TimelineStep, skill });
        return changes;
      }
      case "tool_call": {
        const changes: TimelineChange[] = [];
        if (!current) changes.push({ kind: "step", step: openStep() });
        const call = newCall(e, str(e.summary));
        (current as TimelineStep).calls.push(call);
        changes.push({ kind: "call", step: current as TimelineStep, call });
        return changes;
      }
      case "tool_result": {
        const found = findCall(e);
        if (found) {
          attach(found.call, e);
          return [{ kind: "result", step: found.step, call: found.call }];
        }
        // Orphan result (its call was trimmed from the backlog): still shown.
        const changes: TimelineChange[] = [];
        if (!current) changes.push({ kind: "step", step: openStep() });
        const call = newCall(e, "");
        call.startedAt = undefined;
        attach(call, e);
        (current as TimelineStep).calls.push(call);
        changes.push({ kind: "call", step: current as TimelineStep, call });
        return changes;
      }
      default:
        return [];
    }
  }

  function pending(): TimelineCall | null {
    return pendingCalls.length > 0 ? pendingCalls[0] : null;
  }

  return { push, pending, steps: () => steps };
}
