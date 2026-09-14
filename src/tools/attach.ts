import { contentTypeFor } from "../artifacts/contentType.js";
import { outboundKey } from "../artifacts/keys.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { parseExitPrefix } from "../core/runEvents.js";
import type { UploadTicket } from "../core/types.js";
import { BASH_TIMEOUT_MAX_MS, bashBudgetWithinRun } from "../execution/bashTimeout.js";
import { MAX_READ_BYTES, parseByteSize, statCommandFor } from "../execution/binaryRead.js";
import type { ExecOptions } from "../execution/executor.js";
import { shellQuote } from "../execution/shellQuote.js";
import type { RunnableTool, ToolContext } from "./workspace.js";

// A run's binary artifact — the screenshot `playwright screenshot` wrote, a
// PDF, a recording — handed to the person in the conversation
// (docs/reference/specs/agent-coding.md item 10). Two paths, one tool:
//
//   - With an artifact store (execution.md item 20, record 0033) the file
//     moves BY REFERENCE: the container `curl`s it to a presigned R2 PUT, the
//     bot verifies the object with a `HEAD`, records an `artifact` event, and
//     the container POSTs the same file to the channel's one-shot upload URL
//     (`uploadTicket`); the bot completes the share. The bot process never
//     holds the bytes, so a 1 GB recording costs it nothing.
//   - Without a store the bytes come off the Executor seam (`readBytes`,
//     capped at MAX_READ_BYTES) and go out through the channel's `attachFile`,
//     exactly as before the store existed.
//
// Where a half is missing, the tool says which, so the model links to the
// file instead of claiming it posted one.

/** The channel's file upload as the dispatcher hands it to a run: the
 *  `ChannelIO.attachFile` of the requesting thread, bound. */
export type AttachCapability = (file: { name: string; bytes: Uint8Array; lead: string }) => Promise<void>;

/** The channel's one-shot upload ticket, bound (`ChannelIO.uploadTicket`). */
export type UploadTicketCapability = (file: { name: string; size: number }) => Promise<UploadTicket>;

/** The artifact store as one run may use it (bound by the dispatcher). */
export interface ArtifactsCapability {
  store: ArtifactStore;
  /** The run whose keys the files land under (`runs/<runId>/out/<seq>-<name>`). */
  runId: string;
  /** The next per-run sequence: two files of one name never share a key. */
  nextSeq(): number;
  /** One stored file's link — the run page's artifact proxy for the key, tokened
   *  while the run is live — when the deployment has a public URL; undefined otherwise. */
  artifactUrl?(key: string): string | undefined;
  /** Post a line into the conversation: the lead for a channel that takes no upload ticket. */
  reply(text: string): Promise<void>;
}

/** The store path's ceiling: Slack's own per-file limit. Above it the tool
 *  refuses before minting anything. */
export const MAX_ARTIFACT_BYTES = 1_073_741_824;

/** The slowest transfer the budget check assumes, in bytes per millisecond
 *  (1 MiB/s): a file that cannot move at that rate inside the run's remaining
 *  command budget is refused before any mint, naming the budget. */
export const TRANSFER_FLOOR_BYTES_PER_MS = 1024;
/** Fixed cost the check adds to a transfer: two TLS handshakes and a mint. */
export const TRANSFER_SETUP_MS = 10_000;

/** How long moving `size` bytes may take at the floor rate, plus setup. */
export function transferBudgetMs(size: number): number {
  return Math.ceil(size / TRANSFER_FLOOR_BYTES_PER_MS) + TRANSFER_SETUP_MS;
}

/** The measuring command's own budget: a `stat` is instant, but a dead sandbox is not. */
const STAT_TIMEOUT_MS = 30_000;

/** The file's own name: the last path segment, so the upload is titled
 *  `verdict-dark.png`, not `shots/verdict-dark.png`. */
function fileNameOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/** The command the container runs to PUT the file to the store: the type is
 *  signed into the URL, so the header must be exactly what was presigned. */
export function putCommandFor(path: string, contentType: string, url: string): string {
  return `curl -fsS -T ${shellQuote(path)} -H ${shellQuote(`Content-Type: ${contentType}`)} ${shellQuote(url)}`;
}

/** The command the container runs to POST the file to the channel's ticket.
 *  `--upload-file` streams the file from disk with its Content-Length; `-X POST`
 *  keeps the method the one-shot URL expects. `--data-binary @file` would read
 *  the whole file into memory first — a 1 GiB attach died of
 *  "curl: option --data-binary: out of memory" live. */
export function postCommandFor(path: string, url: string): string {
  return `curl -fsS --upload-file ${shellQuote(path)} -X POST ${shellQuote(url)}`;
}

/** The store path (record 0033). Returns the tool's result text. */
async function attachThroughStore(
  path: string,
  name: string,
  lead: string,
  artifacts: ArtifactsCapability,
  ctx: ToolContext,
): Promise<string> {
  const exec = (command: string, timeoutMs: number): Promise<string> => {
    const opts: ExecOptions = { timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) };
    return ctx.executor.exec(command, opts);
  };
  // 1. Measure. `stat` runs in the workspace as the thread user; its words are the error's.
  const statOut = await exec(statCommandFor(shellQuote(path)), STAT_TIMEOUT_MS);
  if (parseExitPrefix(statOut).failed) return `error: could not read ${path}: ${statOut.trim()}`;
  const size = parseByteSize(statOut);
  if (size === null) return `error: could not measure ${path}: ${statOut.trim()}`;
  if (size === 0) return `error: ${path} is empty — nothing to attach`;
  if (size > MAX_ARTIFACT_BYTES) {
    return `error: ${path} is ${size} bytes; attach_file takes files up to ${MAX_ARTIFACT_BYTES} bytes (1 GiB) — link to the file instead`;
  }
  // 2. The budget, before anything is minted: each transfer is one command
  // under the bash cap, clipped to the run's remaining clock like any command;
  // a file that cannot move inside that at the floor rate is refused by name.
  let timeoutMs = BASH_TIMEOUT_MAX_MS;
  if (ctx.remainingMs) {
    const budget = bashBudgetWithinRun(BASH_TIMEOUT_MAX_MS, ctx.remainingMs());
    if (budget.kind === "exhausted") return `error: ${budget.note}`;
    if (budget.kind === "clipped") timeoutMs = budget.timeoutMs;
  }
  const needed = transferBudgetMs(size);
  if (needed > timeoutMs) {
    return (
      `error: ${name} is ${size} bytes and needs about ${secs(needed)}s to move at ${TRANSFER_FLOOR_BYTES_PER_MS} KB/s; ` +
      `the run has ${secs(timeoutMs)}s of command budget left — write up what you have and link to the file instead`
    );
  }
  // 3. Into the store: the container PUTs to a presigned URL; the bot verifies
  // the object by HEAD before it claims anything, and records the fact.
  const contentType = contentTypeFor(name);
  const key = outboundKey(artifacts.runId, artifacts.nextSeq(), name);
  const putUrl = await artifacts.store.presignPut(key, contentType);
  const putOut = await exec(putCommandFor(path, contentType, putUrl), timeoutMs);
  if (parseExitPrefix(putOut).failed) {
    return `error: the upload of ${name} to the artifact store failed: ${putOut.trim()}`;
  }
  const head = await artifacts.store.head(key);
  if (!head)
    return `error: the artifact store holds nothing under ${key} after the upload of ${name} — nothing was posted`;
  if (head.size !== size) {
    return `error: the artifact store holds ${head.size} bytes for ${name}, not the ${size} measured — nothing was posted`;
  }
  ctx.publish?.({ type: "artifact", direction: "out", key, name, size, contentType });
  // 4. Into the conversation. A channel with an upload ticket gets the same
  // file from the container; one without (the CLI harness, HTTP, MCP) gets the
  // lead and the file's own link — the run page's artifact proxy, tokened while
  // the run is live — or, with no public URL, the key it sits under.
  if (!ctx.uploadTicket) {
    const link = artifacts.artifactUrl?.(key);
    const where = link ? ` — ${link}` : ` is on the run page as ${key}`;
    await artifacts.reply(`${lead}\n📎 ${name} (${size} bytes)${where}`);
    return `attached ${name} (${size} bytes) to the run page as ${key}; this conversation's channel takes no file uploads, so the lead and the file's link were posted instead`;
  }
  const kept = "the file is kept on the run page";
  let ticket: UploadTicket;
  try {
    ticket = await ctx.uploadTicket({ name, size });
  } catch (err) {
    return `error: the channel refused an upload ticket for ${name}: ${describe(err)}; ${kept}`;
  }
  const postOut = await exec(postCommandFor(path, ticket.url), timeoutMs);
  if (parseExitPrefix(postOut).failed) {
    return `error: the upload of ${name} to the channel failed: ${postOut.trim()}; ${kept}`;
  }
  try {
    await ticket.complete(lead);
  } catch (err) {
    return `error: the channel refused to complete the upload of ${name}: ${describe(err)}; ${kept}`;
  }
  return `attached ${name} (${size} bytes) to the conversation and the run page`;
}

export const attachFileTool: RunnableTool = {
  name: "attach_file",
  description:
    "Post a file from the workspace into the conversation so the person sees it inline — a screenshot " +
    "(e.g. from `playwright screenshot`), a rendered PDF, a recording, a log. Use it whenever you produce an " +
    `image worth showing: a link to a file is not a picture. Whole files only: up to ${MAX_ARTIFACT_BYTES} bytes ` +
    `(1 GiB) where the artifact store is configured, ${MAX_READ_BYTES} bytes otherwise — the result says which.`,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path of the file in the workspace" },
      comment: {
        type: "string",
        description: "One line posted with the file saying what it shows (default: the file name)",
      },
    },
    required: ["path"],
  },
  async run(input, ctx) {
    const path = String(input.path ?? "").trim();
    if (!path) return "error: path is required";
    const name = fileNameOf(path);
    const lead = typeof input.comment === "string" && input.comment.trim() ? input.comment.trim() : name;
    if (ctx.artifacts) return attachThroughStore(path, name, lead, ctx.artifacts, ctx);
    if (!ctx.attach) {
      return "attach_file is not available here: this conversation's channel takes no file uploads — link to the file instead";
    }
    const readBytes = ctx.executor.readBytes?.bind(ctx.executor);
    if (!readBytes) {
      return "attach_file is not available here: this workspace cannot hand files over — link to the file instead";
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBytes(path);
    } catch (err) {
      return `error: could not read ${path}: ${describe(err)}`;
    }
    if (bytes.byteLength === 0) return `error: ${path} is empty — nothing to attach`;
    try {
      await ctx.attach({ name, bytes, lead });
    } catch (err) {
      return `error: the channel refused the upload of ${name}: ${describe(err)}`;
    }
    return `attached ${name} (${bytes.byteLength} bytes) to the conversation`;
  },
};
