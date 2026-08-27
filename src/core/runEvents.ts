// Run visibility (Area 2 / R12): a typed stream of what an agent is doing —
// tool calls and their (redacted, summarized) results — emitted by the runner.
// Today the in-channel status card consumes it live; the external live-view
// page (a follow-up) will consume the same stream. Keeping it a small typed
// seam here means neither consumer reaches into the runner's internals.

export type RunEvent =
  | { type: "tool_call"; tool: string; summary: string }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string };

// Token shapes we must never surface in a run-visibility stream (which may be
// shown in-channel or on a shared page). Conservative and specific — we redact
// known credential formats rather than any long string, to avoid mangling
// legitimate output. Each entry replaces the secret (or its value) with a
// marker.
const REDACT: Array<{ re: RegExp; replace: string }> = [
  { re: /xox[baprs]-[A-Za-z0-9-]{8,}/g, replace: "«redacted-slack-token»" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: "«redacted-github-token»" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, replace: "«redacted-github-pat»" },
  { re: /x-access-token:[^@\s/'"]+/gi, replace: "x-access-token:«redacted»" },
  { re: /sk-ant-[A-Za-z0-9_-]{16,}/g, replace: "«redacted-anthropic-key»" },
  { re: /sk-[A-Za-z0-9_-]{16,}/g, replace: "«redacted-api-key»" },
  { re: /AKIA[0-9A-Z]{16}/g, replace: "«redacted-aws-key»" },
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replace: "Bearer «redacted»" },
  // key/secret/token/password = value  →  keep the name, hide the value
  {
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b(\s*[=:]\s*)["']?[A-Za-z0-9._\-/+]{8,}["']?/gi,
    replace: "$1$2«redacted»",
  },
];

/** Strip known credential formats from text before it enters a run-visibility
 *  stream. Conservative: only recognized token shapes and `key=value` secrets. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of REDACT) out = out.replace(re, replace);
  return out;
}

const SUMMARY_CAP = 200;

/** One-line, redacted, length-capped summary of a tool's output for the run
 *  stream — the first non-empty line plus a size note. */
export function summarizeToolResult(output: string): string {
  const redacted = redactSecrets(output);
  const trimmed = redacted.trim();
  if (trimmed === "") return "(no output)";
  const firstLine = trimmed.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const head = firstLine.length > SUMMARY_CAP ? `${firstLine.slice(0, SUMMARY_CAP)}…` : firstLine;
  const lineCount = trimmed.split("\n").length;
  const more = trimmed.length > head.length ? ` (${trimmed.length} chars${lineCount > 1 ? `, ${lineCount} lines` : ""})` : "";
  return head + more;
}
