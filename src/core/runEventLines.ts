import { RUN_NOTE_KINDS, type RunEvent, type RunNoteKind } from "./runEvents.js";

// Parsing a SAVED run-event stream — the input of
// `friction analyze`: one JSON object per line, OR a raw SSE capture of
// `/runs/:id/events` (`data: {...}` frames). Analysis-only input handling;
// nothing here touches a run, a sandbox, or GitHub.

// Derived from the union, so a new note kind reaches `friction analyze` the day
// it is added (features/tracing.md).
const NOTE_KINDS = new Set<RunNoteKind>(RUN_NOTE_KINDS);

/**
 * Parse run events from text: one JSON object per line, OR a raw SSE capture of
 * `/runs/:id/events` (only `data:` lines carry events; `retry:`/`event:`/
 * comment/blank lines are transport; the `{}` payload of the terminal `end`
 * frame is ignored). Malformed lines and non-event payloads are skipped and
 * counted, never thrown — a partially garbled capture still yields a diagnosis.
 */
export function parseRunEventLines(text: string): { events: RunEvent[]; skipped: number } {
  const events: RunEvent[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith(":") || /^(retry|event|id):/.test(line)) continue;
    const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      skipped++;
      continue;
    }
    if (isRunEvent(parsed)) events.push(parsed);
    else if (!isTransportFrame(parsed)) skipped++; // garbage, or an event-shaped payload this reader does not know
  }
  return { events, skipped };
}

/** A plain object with no `type` is a transport frame — `end`'s `{}` today,
 *  `{ sealedAt, replyOk }` and the `finished`/`replay_elided` payloads later
 *  (features/tracing.md) — never garbage. Anything else that is not an event
 *  (a number, a string, an array, an object whose `type` this reader does not
 *  know) is skipped and counted. */
function isTransportFrame(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type !== "string";
}

/** Structural check of the fields the analyzer actually relies on — a recognized
 *  `type` alone is not enough, since this input is external (a hand-edited or
 *  corrupted capture must be skipped, never crash the analysis). */
function isRunEvent(v: unknown): v is RunEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.at !== undefined && typeof o.at !== "number") return false;
  switch (o.type) {
    case "tool_call":
      return typeof o.summary === "string" && typeof o.tool === "string";
    case "tool_result":
      return typeof o.summary === "string" && typeof o.tool === "string" && typeof o.ok === "boolean";
    case "run_note":
      return typeof o.summary === "string" && typeof o.kind === "string" && NOTE_KINDS.has(o.kind as RunNoteKind);
    case "answer":
    case "input":
    case "assistant":
    case "context":
      return typeof o.text === "string"; // the narrative events carry text, not a summary
    case "turn":
      return typeof o.startedAt === "number" && typeof o.durationMs === "number";
    case "run_meta":
      return typeof o.agent === "string" && (o.model === undefined || typeof o.model === "string");
    case "span_start":
      return typeof o.spanId === "string" && typeof o.name === "string";
    case "span_end":
      return (
        typeof o.spanId === "string" &&
        typeof o.name === "string" &&
        typeof o.startedAt === "number" &&
        typeof o.durationMs === "number" &&
        (o.status === "ok" || o.status === "error")
      );
    case "skill_use":
      return typeof o.skill === "string" && typeof o.agent === "string" && typeof o.bodyBytes === "number";
    case "mcp_tool_use":
      return (
        typeof o.server === "string" &&
        typeof o.tool === "string" &&
        typeof o.ok === "boolean" &&
        typeof o.durationMs === "number"
      );
    case "review_artifact":
      return (
        o.artifact === "reading_diff" && typeof o.diff === "string" && (o.poweredBy === "git" || o.poweredBy === "meat")
      );
    case "pr_description":
      return typeof o.description === "object" && o.description !== null;
    case "pr_opened":
      return typeof o.url === "string" && typeof o.number === "number" && typeof o.created === "boolean";
    case "ship_round":
      return typeof o.index === "number" && typeof o.agent === "string" && typeof o.outcome === "string";
    default:
      return false;
  }
}
