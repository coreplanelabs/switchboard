import { execFile } from "node:child_process";

// Rung one of the sweep's two-rung resolver (record 0071, mechanism two;
// docs/reference/specs/agent-ship.md item 20): git alone, in a checkout of the
// pull request's branch. The rebase runs with whatever merge drivers the
// repository itself declares in `.gitattributes` — git reads them from the
// checkout, nothing here names a technology — and with `git rerere` enabled
// (with `rerere.autoUpdate`, so a resolution recorded once is replayed AND
// staged on a later rebase of the same hunks, and the rebase continues without
// a model round). After a clean rebase, `git range-diff` against the pre-rebase
// head says whether the patch itself changed: unchanged means only the parent
// moved, so the existing approval carries. The push is `--force-with-lease`,
// refused when the remote head moved under the sweep.

/** Runs one git invocation; the seam the tests and any sandbox fill. */
export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The default runner: `git` as a child process, never a shell. */
export const localGitRunner: GitRunner = {
  run: (args, cwd) =>
    new Promise((resolve) => {
      execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : (((err as { code?: unknown }).code as number | undefined) ?? 1);
        resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
      });
    }),
};

/** rerere on, resolutions staged when replayed, no editor ever opened — the
 *  sweep's whole git config. */
const RERERE = ["-c", "rerere.enabled=true", "-c", "rerere.autoUpdate=true", "-c", "core.editor=true"] as const;

export type GitRebaseOutcome = { kind: "clean"; newHead: string } | { kind: "conflict"; file: string };

const trimmed = async (git: GitRunner, args: readonly string[], cwd: string): Promise<string> => {
  const r = await git.run(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
};

/** Fetch the base and rebase the checkout's branch onto it. On a stop where
 *  rerere replayed every resolution (nothing left unmerged), the rebase is
 *  continued; a hunk git cannot take aborts the rebase — the checkout is left
 *  as it was — and the conflict comes back named. A failure that is not a
 *  conflict stop at all — a dirty checkout, no rebase in progress, a
 *  `--continue` that cannot advance (a commit rerere emptied, which demands
 *  `--skip`) — is thrown with git's own words, never reported as a conflict. */
export async function rebaseOntoBase(
  git: GitRunner,
  opts: { dir: string; base: string; remote?: string },
): Promise<GitRebaseOutcome> {
  const remote = opts.remote ?? "origin";
  const fetch = await git.run(["fetch", remote, opts.base], opts.dir);
  if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr.trim()}`);
  let step = await git.run([...RERERE, "rebase", `${remote}/${opts.base}`], opts.dir);
  let lastStop: string | undefined;
  while (step.code !== 0) {
    const gitSaid = step.stderr.trim() || step.stdout.trim();
    // Only a rebase actually stopped mid-replay answers `--show-current-patch`
    // (a stale REBASE_HEAD from an earlier rebase does not); any other non-zero
    // exit — a dirty checkout, no rebase in progress — is not a conflict and
    // must say what happened.
    const inProgress = await git.run(["rebase", "--show-current-patch"], opts.dir);
    if (inProgress.code !== 0) throw new Error(`git rebase failed: ${gitSaid}`);
    const at = await git.run(["rev-parse", "--verify", "REBASE_HEAD"], opts.dir);
    if (at.code !== 0) throw new Error(`git rebase failed: ${gitSaid}`);
    const unmerged = await git.run(["diff", "--name-only", "--diff-filter=U"], opts.dir);
    const conflicted = unmerged.stdout
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim();
    if (conflicted !== undefined) {
      await git.run(["rebase", "--abort"], opts.dir);
      return { kind: "conflict", file: conflicted };
    }
    // Nothing unmerged: rerere resolved and staged everything this stop held.
    // A rebase stops at most once per commit it replays, so REBASE_HEAD moves
    // between stops; a `--continue` stopped on the same commit again (a commit
    // rerere emptied, which demands `--skip`) cannot progress — abort and say so.
    const stopAt = at.stdout.trim();
    if (stopAt === lastStop) {
      await git.run(["rebase", "--abort"], opts.dir);
      throw new Error(`git rebase --continue made no progress at ${stopAt}: ${gitSaid}`);
    }
    lastStop = stopAt;
    step = await git.run([...RERERE, "rebase", "--continue"], opts.dir);
  }
  return { kind: "clean", newHead: await trimmed(git, ["rev-parse", "HEAD"], opts.dir) };
}

/** One `git range-diff` commit-pair header row: `<n>: <sha>` (or `-: ---` for a
 *  commit only one side has), the marker column (`=` unchanged, `!` changed,
 *  `<`/`>` only on one side), the other side's pair. Anchored to the row's
 *  shape so a ` = ` inside a subject or an interdiff line never counts. */
const RANGE_DIFF_HEADER = /^\s*(?:\d+:\s+[0-9a-f]+|-:\s+-+)\s+([=!<>])\s+(?:\d+:\s+[0-9a-f]+|-:\s+-+)(?:\s|$)/;

/** After a clean rebase: `git range-diff` between the pre-rebase branch and the
 *  rebased one — unchanged means every line is a header row whose marker is `=`
 *  (a changed patch prints `!` headers plus an interdiff): the patch is
 *  byte-identical and only the parent moved. */
export async function patchUnchanged(
  git: GitRunner,
  opts: { dir: string; base: string; preRebaseHead: string; newHead: string; remote?: string },
): Promise<boolean> {
  const remote = opts.remote ?? "origin";
  const out = await git.run(
    ["range-diff", `${remote}/${opts.base}..${opts.preRebaseHead}`, `${remote}/${opts.base}..${opts.newHead}`],
    opts.dir,
  );
  if (out.code !== 0) return false;
  const rows = out.stdout.split("\n").filter((l) => l.trim() !== "");
  return rows.length > 0 && rows.every((l) => RANGE_DIFF_HEADER.exec(l)?.[1] === "=");
}

/** Force-push the rebased branch, with lease on the pre-rebase head: a remote
 *  that moved under the sweep refuses the push instead of losing the move. */
export async function forcePushWithLease(
  git: GitRunner,
  opts: { dir: string; branch: string; preRebaseHead: string; remote?: string },
): Promise<void> {
  const remote = opts.remote ?? "origin";
  const out = await git.run(
    [
      "push",
      "--force-with-lease=" + `refs/heads/${opts.branch}:${opts.preRebaseHead}`,
      remote,
      `HEAD:refs/heads/${opts.branch}`,
    ],
    opts.dir,
  );
  if (out.code !== 0) throw new Error(`git push refused: ${out.stderr.trim()}`);
}
