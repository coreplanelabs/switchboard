import type { ExecOptions, ExecResult, MoveOptions } from "./executor.js";
import { BASH_TIMEOUT_MS } from "./bashTimeout.js";
import { shellQuote } from "./shellQuote.js";
import { redactAndCap } from "../core/redact.js";

/** Check controller-owned setup commands before their output can prove a checkout. */
export async function runWorkspaceCommand(
  run: (command: string, opts?: ExecOptions) => Promise<ExecResult>,
  text: string,
  stage: string,
  opts?: ExecOptions,
): Promise<string> {
  const execute = async (span = opts?.span) => {
    const result = await run(text, { ...opts, ...(span ? { span } : {}) });
    span?.setAttrs({ exitCode: result.exitCode, outputTruncated: result.truncated });
    // The caller's stop gate owns an answered command cut by that stop.
    if (opts?.signal?.aborted) return result.stdout;
    if (result.exitCode !== 0 || result.truncated)
      throw new Error(
        `${stage} failed (exit ${result.exitCode}, truncated ${result.truncated}): ${redactAndCap(result.stderr || result.stdout, 1000)}`,
      );
    return result.stdout;
  };
  return opts?.span ? opts.span.span(`${opts.span.name}.${stage}`, execute) : execute();
}

/** The acknowledged checkout is independent of a transport's default cwd.
 * Legacy callers without one keep their executor's existing cwd contract. */
export function gitInCheckout(checkout?: string): string {
  if (checkout === undefined) return "git";
  if (typeof checkout !== "string" || !checkout.startsWith("/") || checkout.length > 4096 || /[\r\n\0]/.test(checkout))
    throw new Error("workspace checkout binding is invalid");
  return `git -C ${shellQuote(checkout)}`;
}

/** Cold executors advance their bound checkout through typed command facts.
 * Missing Git state or private changes cannot become a model's checkout task. */
export async function advanceWorkspace(
  run: (command: string, opts?: ExecOptions) => Promise<ExecResult>,
  sha: string,
  opts?: MoveOptions,
): Promise<{ sha: string }> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("workspace advance requires a full commit SHA");
  const git = gitInCheckout(opts?.checkout);
  const command = async (text: string, stage: string) => {
    if (opts?.signal?.aborted) throw new Error("workspace advance stopped");
    const output = await runWorkspaceCommand(run, text, stage, opts);
    if (opts?.signal?.aborted) throw new Error("workspace advance stopped");
    return output;
  };
  const before = (await command(`${git} rev-parse --verify HEAD`, "prior_head")).trim();
  if (!/^[a-f0-9]{40}$/.test(before)) throw new Error("workspace advance has no verified prior HEAD");
  if ((await command(`${git} status --porcelain --untracked-files=all`, "prior_status")).trim() !== "")
    throw new Error("workspace advance preserves changed private files");
  await command(`${git} fetch origin ${sha}`, "fetch");
  if (
    (await command(`${git} rev-parse --verify HEAD`, "recheck_head")).trim() !== before ||
    (await command(`${git} status --porcelain --untracked-files=all`, "recheck_status")).trim() !== ""
  )
    throw new Error("workspace changed while its advance was prepared");
  if (
    (await command(`${git} rev-list --max-count=1 --branches HEAD --not --remotes`, "unpublished_commits")).trim() !==
    ""
  )
    throw new Error("workspace advance preserves unpublished commits");
  await command(`${git} checkout --no-overwrite-ignore --detach ${sha}`, "checkout");
  const head = (await command(`${git} rev-parse --verify HEAD`, "confirmed_head")).trim();
  if (head !== sha) throw new Error("workspace advance did not reach its requested head");
  return { sha: head };
}

/** Refresh only the resolved review base. The run's Git door credential stays
 * in its existing environment; the controller never moves HEAD or rewrites origin. */
export async function prepareReviewBase(
  run: (command: string, opts?: ExecOptions) => Promise<ExecResult>,
  head: string | undefined,
  baseRef: string | undefined,
  base: { baseRef: string; baseSha: string } | undefined,
  opts?: MoveOptions,
): Promise<void> {
  if (!head || !/^[a-f0-9]{40}$/.test(head) || !baseRef)
    throw new Error("review base preparation requires a pinned head and base ref");
  if (!base || base.baseRef !== baseRef || !/^[a-f0-9]{40}$/.test(base.baseSha))
    throw new Error("review base does not match the current pull request");
  const git = gitInCheckout(opts?.checkout);
  const ref = shellQuote(`refs/heads/${baseRef}`);
  const tracking = shellQuote(`refs/remotes/origin/${baseRef}`);
  const helper = `!f() { test -n "$GH_ENTERPRISE_TOKEN" || exit 1; printf '%s\\n' 'username=x-access-token' "password=$GH_ENTERPRISE_TOKEN"; }; f`;
  const transport = `${git} -c credential.helper= -c credential.helper=${shellQuote(helper)}`;
  const command = [
    "set -eu",
    "review_fail() { printf 'review base: %s\\n' \"$1\" >&2; exit 1; }",
    `${git} check-ref-format ${ref} >/dev/null 2>&1 || review_fail 'invalid base ref'`,
    `test "$(${git} rev-parse --verify HEAD 2>/dev/null)" = ${shellQuote(head)} || review_fail 'checkout HEAD changed'`,
    `test -n "\${GH_ENTERPRISE_TOKEN:-}" || review_fail 'Git credential unavailable'`,
    `review_remote="\${GIT_DOOR_REMOTE:-origin}"`,
    `review_before=$(${transport} ls-remote --exit-code "$review_remote" ${ref} 2>/dev/null) || review_fail 'remote base lookup failed'`,
    `test "$review_before" = "$(printf '%s\\t%s' ${shellQuote(base.baseSha)} ${ref})" || review_fail 'GitHub and remote base tips differ'`,
    `review_fetch_error=$(${transport} fetch --force --no-tags "$review_remote" ${shellQuote(`+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`)} 2>&1) || {`,
    '  case "$review_fetch_error" in',
    "    *'cannot lock ref'*) review_fail 'base fetch failed (local ref update)' ;;",
    "    *'Authentication failed'*|*'could not read Username'*|*'HTTP 401'*|*'HTTP 403'*) review_fail 'base fetch failed (authentication)' ;;",
    "    *'Could not resolve host'*|*'Failed to connect'*|*'RPC failed'*|*'early EOF'*) review_fail 'base fetch failed (transport)' ;;",
    "    *) review_fail 'base fetch failed (cause unknown)' ;;",
    "  esac",
    "}",
    `review_base=$(${git} rev-parse --verify --end-of-options ${shellQuote(`refs/remotes/origin/${baseRef}^{commit}`)} 2>/dev/null) || review_fail 'fetched base is unavailable'`,
    `test "$review_before" = "$(printf '%s\\t%s' "$review_base" ${ref})" || review_fail 'fetched base tip changed'`,
    `test "$(${transport} ls-remote --exit-code "$review_remote" ${ref} 2>/dev/null)" = "$review_before" || review_fail 'remote base tip changed'`,
    `test "$(${git} rev-parse --verify HEAD 2>/dev/null)" = ${shellQuote(head)} || review_fail 'checkout HEAD changed'`,
    `${git} merge-base ${tracking} ${shellQuote(head)} >/dev/null 2>&1 || review_fail 'base and head have no known merge base'`,
  ].join("\n");
  if (opts?.signal?.aborted) throw new Error("review base preparation stopped");
  await runWorkspaceCommand(run, command, "prepare_review_base", { ...opts, timeoutMs: BASH_TIMEOUT_MS });
  if (opts?.signal?.aborted) throw new Error("review base preparation stopped");
}
