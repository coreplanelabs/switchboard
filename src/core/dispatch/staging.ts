// Inbound staging (docs/reference/specs/execution.md item 20, record 0033): a
// file a person dropped on the thread that the inline path cannot carry — a
// 300 MB recording, a 6 MiB screenshot, a PDF over the document cap — reaches
// the run's workspace as `attachments/<index>-<basename>` before the turn
// that names it, without the bot's process ever holding the bytes. The bot
// asks its Worker to copy the file into the store (`copyFromUrl`), records the
// `artifact` event, mints a presigned GET, and the CONTAINER pulls it with
// `curl`. Pure command builders and the line the model reads live here so
// the shell-injection and quoting cases are unit tests; `stageIntoWorkspace`
// runs the two halves in order for one turn.
import { inboundKey, safeBasename } from "../../artifacts/keys.js";
import type { ArtifactStore } from "../../artifacts/store.js";
import { BASH_TIMEOUT_MAX_MS } from "../../execution/bashTimeout.js";
import type { Executor } from "../../execution/executor.js";
import { shellQuote } from "../../execution/shellQuote.js";
import { parseExitPrefix, type RunEvent } from "../runEvents.js";
import type { StagedFile } from "../types.js";

/** Where staged files land, relative to the workspace root. */
export const ATTACHMENTS_DIR = "attachments";

/** The file's name in the workspace and in its key: the 1-based index keeps two
 *  files of one name apart, the basename is one character class. */
export function stagedBasename(index: number, name: string): string {
  return `${index}-${safeBasename(name)}`;
}

/** The command the container runs to pull one staged file: the directory made,
 *  the presigned GET fetched to the basename. Both operands are single-quoted,
 *  so a name like `clip"; echo pwned; ".mp4` is a filename, not a command. */
export function pullCommandFor(url: string, basename: string): string {
  return `mkdir -p ${ATTACHMENTS_DIR} && curl -fsS -o ${shellQuote(`${ATTACHMENTS_DIR}/${basename}`)} ${shellQuote(url)}`;
}

/** The resident's worktree must stay clean by `git status` (its refresh and
 *  release gates read it): the attachments directory is excluded through
 *  `.git/info/exclude`, appended once and never committed. */
export function excludeCommand(): string {
  const entry = shellQuote(`${ATTACHMENTS_DIR}/`);
  return `mkdir -p .git/info && { grep -qxF ${entry} .git/info/exclude 2>/dev/null || echo ${entry} >> .git/info/exclude; }`;
}

/** A size as the line reads it: `312 MB`, `6 MB`, `840 KB`, `1.2 GB`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** One staged file after the copy (and, when it got that far, the pull). */
export interface StagedOutcome {
  file: StagedFile;
  /** `<index>-<basename>` — the file's name under `attachments/` and the key's leaf. */
  basename: string;
  key: string;
  /** Why the file is not in the workspace, when it is not. */
  error?: string;
}

/** The sentence appended to the turn the files ride on. Every file is named
 *  once: in the workspace with its size and type, or with the reason it is
 *  not there — the model is never left to guess whether a file arrived. */
export function attachmentsLine(outcomes: readonly StagedOutcome[]): string {
  const landed = outcomes.filter((o) => o.error === undefined);
  const failed = outcomes.filter((o) => o.error !== undefined);
  const parts: string[] = [];
  if (landed.length > 0) {
    parts.push(
      `Attached files are in ./${ATTACHMENTS_DIR}/: ${landed
        .map((o) => `${o.basename} (${formatSize(o.file.size)}, ${o.file.type})`)
        .join(", ")}`,
    );
  }
  for (const o of failed) parts.push(`${o.file.name} could not be staged: ${o.error}`);
  return parts.join(". ");
}

/** The line for a run that has no workspace to stage into (a `general`
 *  answer, a `research` run): the file is named and the way to it is said. */
export function noWorkspaceLine(files: readonly StagedFile[]): string {
  return files
    .map(
      (f) =>
        `this agent has no workspace for ${f.name} (${formatSize(f.size)}, ${f.type}); ask \`agent:coding\` to work with it`,
    )
    .join(". ");
}

export interface CopyDeps {
  store: ArtifactStore;
  /** The thread the files belong to: the key's first segment. */
  threadKey: string;
  /** The run's staging counter (`stagingIndex()`): ONE sequence across every
   *  round a run stages — the request and each steer — so two files of one
   *  name from different messages never share a workspace path. */
  nextIndex: () => number;
  /** Where the `artifact` event goes once the copy answered. */
  publish?: (event: RunEvent) => void;
}

/** A run's staging counter: 1, 2, 3… across its rounds. The dispatcher makes
 *  one per run and hands it to the request's staging and the loop's hook. */
export function stagingIndex(): () => number {
  let n = 0;
  return () => ++n;
}

/** The copies, all at once: the bot asks its Worker for each file and records
 *  the `artifact` event when the store holds it. A copy that fails is an
 *  outcome with the reason, never a throw — the turn still runs, naming it. */
export async function copyStaged(files: readonly StagedFile[], deps: CopyDeps): Promise<StagedOutcome[]> {
  return Promise.all(
    files.map(async (file): Promise<StagedOutcome> => {
      const index = deps.nextIndex();
      const basename = stagedBasename(index, file.name);
      const key = inboundKey(deps.threadKey, file.messageId, index, file.name);
      try {
        await deps.store.copyFromUrl({ url: file.url, size: file.size, key });
        deps.publish?.({
          type: "artifact",
          direction: "in",
          key,
          name: file.name,
          size: file.size,
          contentType: file.type,
        });
        return { file, basename, key };
      } catch (err) {
        return { file, basename, key, error: `the copy into the store failed: ${describe(err)}` };
      }
    }),
  );
}

export interface PullDeps {
  store: ArtifactStore;
  executor: Executor;
  /** A resident worktree: the exclude line is appended before the first pull. */
  resident: boolean;
  /** Per pull; default the bash cap. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The pulls, in order, for every copy that landed: one presigned GET each,
 *  one `curl` in the workspace as the thread user. A pull that exits non-zero
 *  is an outcome with curl's words; nothing is retried. */
export async function pullStaged(outcomes: readonly StagedOutcome[], deps: PullDeps): Promise<StagedOutcome[]> {
  const landed = outcomes.filter((o) => o.error === undefined);
  if (landed.length === 0) return [...outcomes];
  const timeoutMs = deps.timeoutMs ?? BASH_TIMEOUT_MAX_MS;
  const opts = { timeoutMs, ...(deps.signal ? { signal: deps.signal } : {}) };
  if (deps.resident) await deps.executor.exec(excludeCommand(), opts);
  const pulled = new Map<string, string | undefined>();
  for (const o of landed) {
    const url = await deps.store.presignGet(o.key);
    const out = await deps.executor.exec(pullCommandFor(url, o.basename), opts);
    pulled.set(o.key, parseExitPrefix(out).failed ? `the pull into the workspace failed: ${out.trim()}` : undefined);
  }
  return outcomes.map((o) => {
    const error = o.error ?? pulled.get(o.key);
    return error === undefined ? { file: o.file, basename: o.basename, key: o.key } : { ...o, error };
  });
}

/** Both halves for one turn: copy every file, pull every copy, and the line. */
export async function stageIntoWorkspace(
  files: readonly StagedFile[],
  deps: CopyDeps & PullDeps,
): Promise<{ line: string; outcomes: StagedOutcome[] }> {
  const outcomes = await pullStaged(await copyStaged(files, deps), deps);
  return { line: attachmentsLine(outcomes), outcomes };
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
