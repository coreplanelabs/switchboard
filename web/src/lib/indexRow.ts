import type { RunIndexRowSeed } from "@core/channels/webSeed.js";
import { runDurationMs } from "@core/core/runDuration.js";
import { boundText, paceText, stalledFor } from "@core/core/runPace.js";
import { formatDuration, formatLocalIso } from "./format";

// The runs-index row model, ported from the old isomorphic `indexRowRenderer`:
// every display decision the row makes, as pure functions the RunRow component
// (the ONE renderer now — seed rows and feed upserts go through the same
// component) and the feed reconciliation share.

export type IndexRow = RunIndexRowSeed;

/** Display words, not the enum: succeeded / failed / killed / stopped early. */
export function statusLabel(status: string): string {
  return status === "completed"
    ? "succeeded"
    : status === "stopped_soft"
      ? "stopped early"
      : status === "stopped_hard"
        ? "killed"
        : status;
}

// The label for a provisional record — the tombstone-first run-start marker
// still in its provisional window (run-history item 27) — is shared with the
// CLI's renderers so every store-only surface says the same words.
import { PROVISIONAL_LABEL } from "@core/core/runRecord.js";
export { PROVISIONAL_LABEL };

/** The stop badge: "stopping (soft)" while in flight; once stopped, the same
 *  word the outcome badge would use (killed / stopped early). */
export function stopLabel(stop: { state: string; mode: string }): string {
  return stop.state === "stopped" ? statusLabel(`stopped_${stop.mode}`) : `${stop.state} (${stop.mode})`;
}

export function statusWord(run: IndexRow): string {
  if (!run.finished) return "live";
  // A provisional record: the tombstone-first start marker still in its window.
  // Never `interrupted` — that is a real terminal state for a confirmed dead run.
  if (run.provisional) return PROVISIONAL_LABEL;
  return run.status ? statusLabel(run.status) : "finished";
}

export type DotTone = "green" | "red" | "amber" | "grey";

/** A finished run whose stream has not been sealed yet: the agent stopped and
 *  the reply is in flight (docs/reference/specs/tracing.md). A persisted row is past that
 *  (its record was written after the seal); a row that never gets a seal — the
 *  process died, the reply hung — stays amber until the registry evicts it. */
export function delivering(run: IndexRow): boolean {
  return run.finished && !run.persisted && run.sealedAt === undefined;
}

export function statusDot(run: IndexRow): DotTone {
  if (!run.finished) return "green";
  if (delivering(run)) return "amber";
  // A provisional record: the tombstone-first marker still in its window — amber,
  // not red, because the run may still be live in a registry the store-only reader
  // cannot see. "Unknown" is closer to amber than to red.
  if (run.provisional) return "amber";
  // `interrupted`: the run was cut down before finish (container
  // replaced or crashed) — as red as a failure. The word itself passes through
  // `statusLabel` unchanged.
  if (run.status === "failed" || run.status === "stopped_hard" || run.status === "interrupted") return "red";
  if (run.status === "stopped_soft") return "amber";
  return "grey";
}

/** The chip hue for an agent name: one of the four built-in agents gets its
 *  own hue; anything else (a custom agent) the neutral chip. Never the raw
 *  name — a label is data, not a CSS token. */
export function agentHue(agent: string): "coding" | "review" | "research" | "general" | "other" {
  return agent === "coding" || agent === "review" || agent === "research" || agent === "general" ? agent : "other";
}

/** The agent chip's classes per hue — one map for every row that wears the
 *  chip (the index row, a unit's or a conductor's run row), so an agent reads
 *  the same colour wherever a run is listed. */
export const AGENT_HUE: Record<ReturnType<typeof agentHue>, string> = {
  coding: "text-ok bg-ok/8 border-ok/25",
  review: "text-review bg-review/8 border-review/25",
  research: "text-research bg-research/8 border-research/25",
  general: "text-info bg-info/8 border-info/25",
  other: "text-toned bg-accented/60 border-accented",
};

/** The count cell (live-view item 18; tracing.md): the content-event count
 *  when the row carries it — span records excluded — else the published total,
 *  under the word the cell always used. */
export function countText(run: Pick<IndexRow, "eventCount" | "stepCount">): string {
  const n = run.stepCount ?? run.eventCount;
  return `${n} event${n === 1 ? "" : "s"}`;
}

/** The count cell's tooltip: what the number counts — content events when the
 *  row carries `stepCount`, else everything the run published (span records
 *  included, once a run has them). */
export function countTip(run: Pick<IndexRow, "stepCount">): string {
  return run.stepCount !== undefined
    ? "content events; span records excluded"
    : "events published, span records included";
}

// The stall signal (live-view item 32; issue #1836): the pace cell, the stall
// predicate the sort and the badge share, and the bound-exceeded mark — the
// core's one rule (`runPace.ts`, the words the status card uses), gated here
// on LIVE rows that carry the fact: a persisted row, and a live row an older
// writer built (no `eventsLast5m`), shows no signal rather than a false stall.

/** The pace cell: `2.8/min`, or `no tool call for N min` once stalled; empty
 *  for a finished row and for one without the fact. */
export function rowPace(run: IndexRow, now: number): string {
  return run.finished ? "" : paceText(run, now);
}

/** A live row with no tool call for the whole window — what sorts and badges first. */
export function rowStalled(run: IndexRow, now: number): boolean {
  return !run.finished && stalledFor(run, now) !== undefined;
}

/** The bound-exceeded mark — `bash 2083s, bound 600s` — for a live row whose
 *  in-flight call outran the bound it declared; undefined otherwise. */
export function rowBound(run: IndexRow, now: number): string | undefined {
  return !run.finished && run.inFlight ? boundText(run.inFlight, now) : undefined;
}

/** The pace cell's tooltip: what the number (or the mark) means. */
export function paceTip(run: IndexRow, now: number): string {
  if (rowBound(run, now)) return "this call ran past the bound it declared — it should have been cut";
  if (rowStalled(run, now)) return "time since the run's last tool call";
  return "events per minute over the last five minutes";
}

/** A live row links with its capability token; a finished row never does. */
export function runHref(run: IndexRow): string {
  return `/runs/${encodeURIComponent(run.id)}${!run.finished && run.token ? `?t=${encodeURIComponent(run.token)}` : ""}`;
}

export function stopHref(run: IndexRow, mode: string): string {
  return `/runs/${encodeURIComponent(run.id)}/stop?t=${encodeURIComponent(run.token ?? "")}&mode=${encodeURIComponent(mode)}`;
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** The stopwatch cell: the one duration (docs/reference/specs/tracing.md) — received (or
 *  started) to finished, fixed; a live row's to `now`; a tombstone or a live
 *  row with no clock → empty. */
export function elapsedText(run: IndexRow, now: number | undefined): string {
  const ms = runDurationMs(run, run.finished ? undefined : now);
  return ms === undefined ? "" : formatDuration(ms, "clock");
}

/** The tooltips say what the stopwatch measures only once a run carries
 *  `receivedAt` (` (received to finish)`); a run without the stamp reads as it
 *  always did. Every tooltip switches on this one predicate, so the row never
 *  says two different things. */
export function basisNote(run: IndexRow): string {
  return typeof run.receivedAt === "number" ? " (received to finish)" : "";
}

/** The trigger surface: the platform prefix of the ids (AGENTS.md invariant 4)
 *  and the identity behind it — the resolved name, never a raw member id. */
export function surfaceOf(run: IndexRow): { kind: string; identity: string } {
  const id = run.channelId ?? "";
  const colon = id.indexOf(":");
  const kind = colon === -1 ? "unknown" : id.slice(0, colon);
  if (run.userName) return { kind, identity: run.userName };
  const uid = run.userId ?? "";
  const ucolon = uid.indexOf(":");
  return { kind, identity: ucolon === -1 ? uid : uid.slice(ucolon + 1) };
}

/** The thread a run belongs to, as a page on this dashboard: the Threads page takes a
 *  whole thread key (`web:<sub>:<id>`, `slack:C…:1712.34`) as its `<id>`, and shows the
 *  thread's runs as turns — read-only when the thread lives on another channel. */
export function threadHref(threadKey: string): string {
  return `/threads/${encodeURIComponent(threadKey)}`;
}

/** The runs index's two remembered toggles (live-view.md item 29): what this browser
 *  keeps when the URL names neither; a URL that names one wins. */
export const RUNS_PREF = { mine: "sb.runs.mine", all: "sb.runs.all" } as const;

/** The surface's name in words, for tooltips and menu labels. The row itself
 *  labels a surface with the channel id's own prefix word (`slack`, `http`,
 *  `mcp`, `cli`) — a text label, never a glyph a reader would need a legend for. */
export const SURFACE_NAME: Record<string, string> = {
  slack: "Slack",
  http: "HTTP ingress",
  mcp: "MCP",
  cli: "CLI",
  web: "Web",
};

/** The dot's tooltip: a live run's latest activity (or "starting…"); a
 *  finished run's outcome, duration, and — when it did not complete — what it
 *  was last doing. */
export function dotTip(run: IndexRow): string {
  if (!run.finished) return run.activity ? `now: ${run.activity}` : "starting…";
  let t = statusWord(run);
  const ms = runDurationMs(run);
  if (ms !== undefined) t += ` in ${formatDuration(ms, "clock")}${basisNote(run)}`;
  if (delivering(run)) t += " · delivering the reply";
  if (run.status && run.status !== "completed" && run.activity) t += `\n${run.activity}`;
  return t;
}

/** The started column's tooltip: the exact stamps, one per line, in the viewer's zone. */
export function whenTip(run: IndexRow): string {
  let t = typeof run.receivedAt === "number" ? `received ${formatLocalIso(run.receivedAt)}\n` : "";
  t += `started ${formatLocalIso(run.startedAt)}`;
  if (run.finished && typeof run.finishedAt === "number") t += `\nfinished ${formatLocalIso(run.finishedAt)}`;
  return t;
}

/** The source mark's tooltip: one line — surface · who. */
export function sourceTip(run: IndexRow): string {
  const s = surfaceOf(run);
  return `via ${SURFACE_NAME[s.kind] ?? s.kind}${s.identity ? ` · ${s.identity}` : ""}`;
}

/** The requester cell: who asked for the run — the resolved name (or the id
 *  suffix), always visible, so a page of rows says whose runs they are without
 *  a hover. Its tooltip is the source mark's sentence. */
export function whoText(run: IndexRow): string {
  return surfaceOf(run).identity;
}

/** The repo the row tags: `RunView.repo`, or a repo-shaped label scope. */
export function repoOf(run: IndexRow, labelScope: string): string {
  return run.repo ?? (/^[\w.-]+\/[\w.-]+$/.test(labelScope) ? labelScope : "");
}

/** Only an http(s) sourceUrl becomes a link — a foreign or hand-built record
 *  cannot plant a javascript: click target. */
export function safeSourceUrl(run: IndexRow): string {
  return run.sourceUrl && /^https?:\/\//.test(run.sourceUrl) ? run.sourceUrl : "";
}

/** What the index feed does with one `IndexEvent`, given the view mode and
 *  whether the addressed row is store-confirmed (`persisted`): the default
 *  view drops a `finished` upsert (the row leaves as the run ends) and honors
 *  every `removed`; `?all=1` keeps finished rows and ignores `removed` only
 *  for a store-confirmed row, so a run the writer lost still disappears at
 *  eviction and no ghost row survives a reload. */
export type FeedAction = { op: "upsert"; run: IndexRow } | { op: "remove"; id: string } | { op: "keep" };

export function feedAction(
  ev: { type?: string; run?: IndexRow; id?: string },
  showAll: boolean,
  persisted: boolean,
): FeedAction {
  if (ev.type === "upsert" && ev.run)
    return !showAll && ev.run.finished ? { op: "remove", id: ev.run.id } : { op: "upsert", run: ev.run };
  if (ev.type === "removed" && ev.id) return showAll && persisted ? { op: "keep" } : { op: "remove", id: ev.id };
  return { op: "keep" };
}

/** The `?all=1` repaint rule: a registry `upsert` carries a `RunSummary` — no
 *  `finishedAt`/`status`, the record's fields — so repainting a finished row
 *  from it alone would wipe its duration and dot. The incoming row overrides
 *  only what it carries. */
export function mergeRow(prev: IndexRow | undefined, run: IndexRow): IndexRow {
  if (!prev || !prev.finished) return run;
  const merged: IndexRow = { ...run };
  if (merged.finishedAt === undefined && prev.finishedAt !== undefined) merged.finishedAt = prev.finishedAt;
  if (merged.status === undefined && prev.status !== undefined) merged.status = prev.status;
  // The tracing stamps (docs/reference/specs/tracing.md) ride the record, not a registry upsert.
  if (merged.receivedAt === undefined && prev.receivedAt !== undefined) merged.receivedAt = prev.receivedAt;
  if (merged.sealedAt === undefined && prev.sealedAt !== undefined) merged.sealedAt = prev.sealedAt;
  if (merged.replyOk === undefined && prev.replyOk !== undefined) merged.replyOk = prev.replyOk;
  return merged;
}

/** When the row leaves (finishedAt + retention), or undefined. */
export function expiresAt(run: IndexRow, retentionMs: number | undefined): number | undefined {
  return run.finished && typeof run.finishedAt === "number" && typeof retentionMs === "number"
    ? run.finishedAt + retentionMs
    : undefined;
}

export const LEAVING_WINDOW_MS = 86_400_000;
