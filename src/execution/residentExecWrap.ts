// Source-side output capping for resident thread commands.
//
// The resident DO used to collect a command's ENTIRE stdout/stderr through the
// sandbox RPC (`proc.output()`) and only then slice to the per-stream cap — a
// verbose vitest/build run materialized tens of MB inside a 128 MB DO isolate
// before truncation, which is an OOM (→ `runtime-replaced` mid-run) waiting to
// happen. This wrapper bounds the streams INSIDE the container: the command's
// full output goes to two temp files on the container disk (disk is a cache
// and is recycled freely), and only the capped head of each crosses the
// RPC.
//
// Contract preserved exactly:
// - exit code is the command's own (`exit $ec` after the heads);
// - stdout and stderr stay separate streams;
// - the DO-side char-count slice + `truncated` flag logic is UNCHANGED — the
//   byte cap here is 4×(charCap)+4, and UTF-8 spends at most 4 bytes per char,
//   so whenever the real output held more than charCap chars, the capped bytes
//   still decode to more than charCap chars and the flag stays exact;
// - a `cd` failure surfaces as before: message on stderr, non-zero exit.
//
// Known, accepted edges (named in docs/reference/specs/resident-repos.md item 21):
// - ANY timeout kill (the SDK's is TERM-based; KILL behaves the same here)
//   ends the wrapper before its own head/cleanup lines run, leaving the two
//   files behind. That is why callers that care about hung-run output pass
//   FIXED file paths (`execCapFiles`) — the DO salvages the capped heads with
//   one follow-up command and cleans up (before this module, `proc.output()`
//   returned whatever streamed pre-kill; with mktemp-only paths a timeout
//   would return nothing at all). Recoverable mode deliberately sets NO EXIT
//   trap — bash runs EXIT traps when TERM ends it, and a cleanup trap deleted
//   the files before recovery could read them;
// - `mktemp` failing (disk full) exits 125 before the command runs — legible,
//   and a full disk would have failed the command anyway.

/** Bytes that guarantee at least `charCap` + 1 UTF-16 chars survive whenever
 *  the stream really held more than `charCap` chars (UTF-8 ≤ 4 bytes/char). */
export function capBytesFor(charCap: number): number {
  return charCap * 4 + 4;
}

/** The fixed stream-file pair for one exec, unguessable via `crypto.randomUUID`
 *  (nobody can pre-plant a symlink or reader at the path). Fixed — rather than
 *  `mktemp` — so a timeout kill, which skips the wrapper's own head/cleanup
 *  lines, leaves files the DO can still find: `recoverCapturedOutput` salvages
 *  the capped heads and removes them. */
export function execCapFiles(): { out: string; err: string } {
  const id = crypto.randomUUID();
  return { out: `/tmp/exec-${id}.out`, err: `/tmp/exec-${id}.err` };
}

/**
 * The `bash -c` body for one thread command with source-side stream caps:
 * run `command` in `cwd` (a subshell, so arbitrary command text cannot escape
 * the redirections), buffer full streams to files, emit only the first
 * `capBytes` of each, preserve the command's exit code. With `files` (the
 * timeout-recoverable mode) the pair comes from `execCapFiles`; without, two
 * `mktemp` files that die with the EXIT trap.
 */
export function capWrappedCommand(
  cwd: string,
  command: string,
  capBytes: number,
  files?: { out: string; err: string },
): string {
  if (!Number.isInteger(capBytes) || capBytes <= 0)
    throw new Error(`capBytes must be a positive integer, got ${capBytes}`);
  return [
    files ? `o=${files.out}` : `o=$(mktemp) || exit 125`,
    files ? `e=${files.err}` : `e=$(mktemp) || exit 125`,
    // Recoverable (fixed-file) mode sets NO trap, deliberately: the sandbox
    // SDK's timeout kill is TERM-based, and bash runs EXIT traps when TERM
    // ends it — a cleanup trap deleted the files BEFORE the caller's recovery
    // leg could salvage them (a salvage under a TERM kill returned empty
    // while a SIGKILL-based test stayed green). Cleanup in this mode is the
    // explicit rm after the heads (normal completion) or the recovery command
    // (any kill). mktemp mode has no recovery reader, so the trap remains the
    // right tool there.
    files ? `:` : `trap 'rm -f "$o" "$e"' EXIT`,
    // The newline before `)` keeps a trailing `#comment` (or an unterminated
    // last line) in the command from swallowing the closing paren.
    `( cd ${cwd} && ${command}`,
    `) >"$o" 2>"$e"`,
    `ec=$?`,
    `head -c ${capBytes} "$o"`,
    `head -c ${capBytes} "$e" >&2`,
    `rm -f "$o" "$e"`,
    `exit $ec`,
  ].join("\n");
}

/** The follow-up command a caller runs AFTER a timeout kill to salvage what the
 *  command had written before it died — the same capped heads the wrapper would
 *  have emitted — and remove the files. Exit 0 even when the files are gone. */
export function recoverCapturedOutput(files: { out: string; err: string }, capBytes: number): string {
  return [
    `head -c ${capBytes} -- ${files.out} 2>/dev/null`,
    `head -c ${capBytes} -- ${files.err} >&2 2>/dev/null`,
    `rm -f -- ${files.out} ${files.err}`,
    `exit 0`,
  ].join("\n");
}
