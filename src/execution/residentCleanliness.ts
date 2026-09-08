/** The worktree clean-check as ONE spawn, kept pure and
 *  dependency-free so it is unit-testable from src/ and imported by the
 *  resident Worker (deploy/cloudflare-resident/worker.ts
 *  `worktreeCleanliness`) like residentDepCache — the tested code IS the
 *  shipped code.
 *
 *  Background: the check used to be three sequential container spawns per
 *  binding (`test -d`, `su … git status --porcelain`, `su … git rev-list
 *  --count HEAD --not --remotes`), and `isIdle()` ran it serially per live
 *  binding — every refresh cycle's idle gate paid 3×N process round-trips.
 *  The three probes fold into one `sh -c` script; the DECISION semantics are
 *  unchanged and encoded in `parseWorktreeCleanliness`:
 *    - no `.git` dir → clean ("worktree missing (disk recycled)" — nothing
 *      to preserve);
 *    - a git probe failing → NOT clean ("never destroy work on a guess"),
 *      reason `clean-check failed: <first error line>`;
 *    - tracked changes or unpushed commits → NOT clean, both counts named;
 *    - else clean.
 *
 *  Security posture, preserved exactly: the git probes run AS THE
 *  THREAD USER via `su` — the worktree is thread-owned, root git in it would
 *  be refused by safe.directory and would be the repo-local-config execution
 *  vector safe.directory exists to block. Only the `test -d` runs as the
 *  caller (root), same as before.
 *
 *  Output is tagged lines (the readRefreshDisk idiom): parsing keys on the
 *  tag, never line position, so a su/PAM banner cannot shift a field. */

import { shellQuote } from "./shellQuote.js";

/** Build the one-spawn probe script. Run it via `sh -c` as root with the
 *  usual GIT_TERMINAL_PROMPT=0 injection; feed the result to
 *  `parseWorktreeCleanliness`. */
export function worktreeCleanlinessScript(worktreePath: string, user: string): string {
  const gitDir = shellQuote(`${worktreePath}/.git`);
  const wt = shellQuote(worktreePath);
  // The inner script (as the thread user) captures each probe's stdout and
  // stderr separately — stderr via a temp file, first non-empty line kept —
  // so a stderr warning on a SUCCESSFUL probe can never inflate the change
  // count, and the failure reason stays the first stderr line exactly as the
  // old per-probe code reported it.
  const inner = [
    `t=$(mktemp) || { echo gitrc=1; echo 'giterr=mktemp failed'; exit 0; }`,
    `cd ${wt} 2>"$t" || { echo gitrc=1; printf 'giterr=%s\\n' "$(grep -m 1 . "$t" || echo 'cd failed')"; rm -f "$t"; exit 0; }`,
    `s_out=$(git status --porcelain 2>"$t"); s_rc=$?; s_err=$(grep -m 1 . "$t" || true)`,
    `a_out=$(git rev-list --count HEAD --not --remotes 2>"$t"); a_rc=$?; a_err=$(grep -m 1 . "$t" || true)`,
    `rm -f "$t"`,
    `if [ "$s_rc" -ne 0 ] || [ "$a_rc" -ne 0 ]; then`,
    `  echo gitrc=1`,
    `  if [ -n "$s_err" ]; then printf 'giterr=%s\\n' "$s_err"`,
    `  elif [ -n "$a_err" ]; then printf 'giterr=%s\\n' "$a_err"`,
    `  else echo 'giterr=git exited non-zero'; fi`,
    `  exit 0`,
    `fi`,
    `echo gitrc=0`,
    `printf 'changes=%s\\n' "$(printf '%s' "$s_out" | grep -c .)"`,
    `printf 'unpushed=%s\\n' "$a_out"`,
  ].join("\n");
  return [
    `if ! test -d ${gitDir}; then echo present=no; exit 0; fi`,
    `echo present=yes`,
    `su -s /bin/bash ${shellQuote(user)} -c ${shellQuote(inner)}`,
  ].join("\n");
}

export interface WorktreeCleanliness {
  clean: boolean;
  reason?: string;
}

/** Decide from the script's tagged output. Unknown (missing/failed tags,
 *  non-zero exit, timeout) counts as NOT clean — never destroy work on a
 *  guess — matching the pre-fold decision exactly. */
export function parseWorktreeCleanliness(r: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}): WorktreeCleanliness {
  const tags = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^(present|gitrc|giterr|changes|unpushed)=(.*)$/.exec(line.trim());
    if (m && !tags.has(m[1])) tags.set(m[1], m[2].trim());
  }
  if (tags.get("present") === "no") return { clean: true, reason: "worktree missing (disk recycled)" };
  if (r.timedOut || r.exitCode !== 0 || tags.get("gitrc") !== "0") {
    const why = tags.get("giterr") || (r.stderr || "git exited non-zero").trim().split("\n")[0];
    return { clean: false, reason: `clean-check failed: ${why}` };
  }
  const changes = Number(tags.get("changes")) || 0;
  const unpushed = Number(tags.get("unpushed")) || 0;
  if (changes > 0 || unpushed > 0)
    return { clean: false, reason: `dirty: ${changes} uncommitted change(s), ${unpushed} unpushed commit(s)` };
  return { clean: true };
}
