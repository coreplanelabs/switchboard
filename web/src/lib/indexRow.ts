import type { RunIndexRowSeed } from "@core/channels/webSeed.js";
import { formatElapsed, formatLocalIso } from "./format";

// The runs-index row model, ported from the old isomorphic `indexRowRenderer`:
// every display decision the row makes, as pure functions the RunRow component
// (the ONE renderer now — seed rows and feed upserts go through the same
// component) and the feed reconciliation share.

export type IndexRow = RunIndexRowSeed;

/** Display words, not the enum: succeeded / failed / killed / stopped early. */
export function statusLabel(status: string): string {
  return status === "completed" ? "succeeded" : status === "stopped_soft" ? "stopped early" : status === "stopped_hard" ? "killed" : status;
}

/** The stop badge: "stopping (soft)" while in flight; once stopped, the same
 *  word the outcome badge would use (killed / stopped early). */
export function stopLabel(stop: { state: string; mode: string }): string {
  return stop.state === "stopped" ? statusLabel(`stopped_${stop.mode}`) : `${stop.state} (${stop.mode})`;
}

export function statusWord(run: IndexRow): string {
  return !run.finished ? "live" : run.status ? statusLabel(run.status) : "finished";
}

export type DotTone = "green" | "red" | "amber" | "grey";

export function statusDot(run: IndexRow): DotTone {
  if (!run.finished) return "green";
  // `interrupted` (#375): the run was cut down before finish (container
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

/** A live row links with its capability token; a finished row never does (R10). */
export function runHref(run: IndexRow): string {
  return `/runs/${encodeURIComponent(run.id)}${!run.finished && run.token ? `?t=${encodeURIComponent(run.token)}` : ""}`;
}

export function stopHref(run: IndexRow, mode: string): string {
  return `/runs/${encodeURIComponent(run.id)}/stop?t=${encodeURIComponent(run.token ?? "")}&mode=${encodeURIComponent(mode)}`;
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** The stopwatch cell: a finished row's start→finish, fixed; a live row's
 *  elapsed since `now`. */
export function elapsedText(run: IndexRow, now: number | undefined): string {
  if (run.finished) return typeof run.finishedAt === "number" ? formatElapsed(run.finishedAt - run.startedAt) : "";
  return typeof now === "number" ? formatElapsed(now - run.startedAt) : "";
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

export const SURFACE_GLYPH: Record<string, string> = { slack: "⁙", http: "⌁", mcp: "◈", cli: ">_" };
export const SURFACE_NAME: Record<string, string> = { slack: "Slack", http: "HTTP ingress", mcp: "MCP", cli: "CLI" };

/** The dot's tooltip: a live run's latest activity (or "starting…"); a
 *  finished run's outcome, duration, and — when it did not complete — what it
 *  was last doing. */
export function dotTip(run: IndexRow): string {
  if (!run.finished) return run.activity ? `now: ${run.activity}` : "starting…";
  let t = statusWord(run);
  if (typeof run.finishedAt === "number") t += ` in ${formatElapsed(run.finishedAt - run.startedAt)}`;
  if (run.status && run.status !== "completed" && run.activity) t += `\n${run.activity}`;
  return t;
}

/** The started column's tooltip: the exact stamps, one per line, in the viewer's zone. */
export function whenTip(run: IndexRow): string {
  let t = `started ${formatLocalIso(run.startedAt)}`;
  if (run.finished && typeof run.finishedAt === "number") t += `\nfinished ${formatLocalIso(run.finishedAt)}`;
  return t;
}

/** The source mark's tooltip: one line — surface · who. */
export function sourceTip(run: IndexRow): string {
  const s = surfaceOf(run);
  return `via ${SURFACE_NAME[s.kind] ?? s.kind}${s.identity ? ` · ${s.identity}` : ""}`;
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

export function feedAction(ev: { type?: string; run?: IndexRow; id?: string }, showAll: boolean, persisted: boolean): FeedAction {
  if (ev.type === "upsert" && ev.run) return !showAll && ev.run.finished ? { op: "remove", id: ev.run.id } : { op: "upsert", run: ev.run };
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
  return merged;
}

/** When the row leaves (finishedAt + retention), or undefined. */
export function expiresAt(run: IndexRow, retentionMs: number | undefined): number | undefined {
  return run.finished && typeof run.finishedAt === "number" && typeof retentionMs === "number" ? run.finishedAt + retentionMs : undefined;
}

export const LEAVING_WINDOW_MS = 86_400_000;
