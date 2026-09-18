// Artifact keys (docs/reference/specs/execution.md item 20): where a run's file
// lives in the store, built from facts the caller has at that moment. An
// inbound file arrives before any run exists, so its key is the thread and the
// message; a produced file belongs to its run. The leaf carries a per-file
// number so a run that attaches `screenshot.png` twice keeps both.

/** The one character class a basename may use. Everything else becomes `_`,
 *  and runs of `_` collapse, so a Slack filename is shell-, URL- and key-safe
 *  by construction: `clip"; echo pwned; ".mp4` → `clip_echo_pwned_.mp4`. */
const SAFE = /[^A-Za-z0-9._-]+/g;

/** A file's own name for a key and a workspace path: the last path segment,
 *  reduced to the safe class, never empty and never a run of dots. */
export function safeBasename(name: string): string {
  const segments = name.split(/[\\/]+/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  const reduced = last
    .replace(SAFE, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/_+/g, "_");
  if (reduced === "" || /^[._-]+$/.test(reduced)) return "file";
  return reduced;
}

/** A thread key as a key segment: `slack:CX:1.0` → `slack-CX-1.0`. */
export function threadKeySafe(threadKey: string): string {
  return threadKey.replace(/:/g, "-").replace(SAFE, "_");
}

/** A produced file: `runs/<runId>/out/<seq>-<basename>`, `seq` the run's artifact count so far. */
export function outboundKey(runId: string, seq: number, name: string): string {
  return `runs/${runId}/out/${seq}-${safeBasename(name)}`;
}

/** A received file: `threads/<thread>/in/<messageTs>/<index>-<basename>`, `index` the file's position in the message. */
export function inboundKey(threadKey: string, messageTs: string, index: number, name: string): string {
  return `threads/${threadKeySafe(threadKey)}/in/${threadKeySafe(messageTs)}/${index}-${safeBasename(name)}`;
}
