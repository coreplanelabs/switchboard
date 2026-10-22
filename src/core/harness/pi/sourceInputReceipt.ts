import { createHash } from "node:crypto";
import { sourceSnapshot } from "../../runLedger/sourceEvents.js";
import { DEFAULT_SESSION_LOG_MAX_BYTES } from "../../runLedger/sessionLog.js";
import { sourceInputIntentsOf, type SourceInputIntent } from "../../runLedger/sourceInputIntent.js";

export interface PiSourceInputReceipt {
  version: 1;
  inputId: string;
  intentHash: string;
  native: {
    harness: "pi";
    sessionFile: string;
    sessionId: string;
    entryId: string;
    entryHash: string;
  };
}

type ReceiptRead =
  | { ok: true; receipt: PiSourceInputReceipt }
  | { ok: false; reason: "input-unproved" | "session-unproved" | "native-unproved" | "native-ambiguous" | "capacity" };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Readback evidence only. The owning host must read this exact native file
 * through its executor. This does not authorize submission, commit a canonical
 * checkpoint, acknowledge an inbox row or release retained source evidence. */
export function readPiSourceInputReceipt(
  original: SourceInputIntent,
  file: { path: string; content: string },
): ReceiptRead {
  const intent = sourceInputIntentsOf({ version: 1, entries: [original] })?.entries[0];
  if (!intent || intent.phase !== "begun" || intent.native.harness !== "pi")
    return { ok: false, reason: "input-unproved" };
  if (file.path !== intent.native.sessionId || !file.content.endsWith("\n"))
    return { ok: false, reason: "session-unproved" };
  // Reuse the retained session-log bound. Over-capacity native proof is held,
  // never truncated into an apparently complete read or treated as absent.
  if (Buffer.byteLength(file.content, "utf8") > DEFAULT_SESSION_LOG_MAX_BYTES) return { ok: false, reason: "capacity" };
  const lines = file.content.trimEnd().split("\n");
  let records: unknown[];
  try {
    records = lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    return { ok: false, reason: "session-unproved" };
  }
  const header = records[0];
  if (!object(header) || header.type !== "session" || header.version !== 3 || !identity(header.id))
    return { ok: false, reason: "session-unproved" };
  const seen = new Set<string>();
  const candidates: Array<{ entry: Record<string, unknown>; line: string }> = [];
  for (let index = 1; index < records.length; index++) {
    const entry = records[index];
    if (
      !object(entry) ||
      entry.type === "session" ||
      !identity(entry.id) ||
      seen.has(entry.id) ||
      (entry.parentId !== null && (!identity(entry.parentId) || !seen.has(entry.parentId)))
    )
      return { ok: false, reason: "session-unproved" };
    seen.add(entry.id);
    if (
      entry.type === "custom_message" &&
      entry.customType === "switchboard-source-input" &&
      object(entry.details) &&
      object(entry.details.intent) &&
      entry.details.intent.id === intent.id
    )
      candidates.push({ entry, line: lines[index]! });
  }
  if (candidates.length > 1) return { ok: false, reason: "native-ambiguous" };
  const candidate = candidates[0];
  if (!candidate) return { ok: false, reason: "native-unproved" };
  const { entry, line } = candidate;
  const details = entry.details as Record<string, unknown>;
  const saved = sourceInputIntentsOf({ version: 1, entries: [details.intent] })?.entries[0];
  if (
    details.version !== 1 ||
    !saved ||
    JSON.stringify(sourceSnapshot(saved)) !== JSON.stringify(sourceSnapshot(intent)) ||
    entry.display !== false ||
    typeof entry.content !== "string" ||
    digest(entry.content) !== intent.renderedHash
  )
    return { ok: false, reason: "native-unproved" };
  return {
    ok: true,
    receipt: {
      version: 1,
      inputId: intent.id,
      intentHash: digest(JSON.stringify(sourceSnapshot(intent))),
      native: {
        harness: "pi",
        sessionFile: file.path,
        sessionId: header.id,
        entryId: entry.id as string,
        entryHash: digest(line),
      },
    },
  };
}
