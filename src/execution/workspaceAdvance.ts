import type { ExecOptions, ExecResult, MoveOptions } from "./executor.js";
import { shellQuote } from "./shellQuote.js";

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
  const command = async (text: string) => {
    if (opts?.signal?.aborted) throw new Error("workspace advance stopped");
    const result = await run(text, opts);
    if (opts?.signal?.aborted) throw new Error("workspace advance stopped");
    if (result.exitCode !== 0 || result.truncated) throw new Error("workspace advance command did not complete");
    return result.stdout;
  };
  const before = (await command(`${git} rev-parse --verify HEAD`)).trim();
  if (!/^[a-f0-9]{40}$/.test(before)) throw new Error("workspace advance has no verified prior HEAD");
  if ((await command(`${git} status --porcelain --untracked-files=all`)).trim() !== "")
    throw new Error("workspace advance preserves changed private files");
  await command(`${git} fetch origin ${sha}`);
  if (
    (await command(`${git} rev-parse --verify HEAD`)).trim() !== before ||
    (await command(`${git} status --porcelain --untracked-files=all`)).trim() !== ""
  )
    throw new Error("workspace changed while its advance was prepared");
  if ((await command(`${git} rev-list --max-count=1 --branches HEAD --not --remotes`)).trim() !== "")
    throw new Error("workspace advance preserves unpublished commits");
  await command(`${git} checkout --no-overwrite-ignore --detach ${sha}`);
  const head = (await command(`${git} rev-parse --verify HEAD`)).trim();
  if (head !== sha) throw new Error("workspace advance did not reach its requested head");
  return { sha: head };
}
