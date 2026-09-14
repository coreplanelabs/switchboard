import { MAX_READ_BYTES } from "../execution/binaryRead.js";
import type { RunnableTool } from "./workspace.js";

// A run's binary artifact — the screenshot `playwright screenshot` wrote, a
// PDF, a recording — handed to the person in the conversation
// (docs/reference/specs/agent-coding.md item 10). The bytes come off the
// Executor seam (`readBytes`, capped) and go out through the channel's
// `attachFile`; the tool touches neither host nor platform SDK. Where either
// half is missing, the tool says which, so the model links to the file
// instead of claiming it posted one.

/** The channel's file upload as the dispatcher hands it to a run: the
 *  `ChannelIO.attachFile` of the requesting thread, bound. */
export type AttachCapability = (file: { name: string; bytes: Uint8Array; lead: string }) => Promise<void>;

/** The file's own name: the last path segment, so the upload is titled
 *  `verdict-dark.png`, not `shots/verdict-dark.png`. */
function fileNameOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export const attachFileTool: RunnableTool = {
  name: "attach_file",
  description:
    "Post a file from the workspace into the conversation so the person sees it inline — a screenshot " +
    "(e.g. from `playwright screenshot`), a rendered PDF, a recording, a log. Use it whenever you produce an " +
    `image worth showing: a link to a file is not a picture. Whole files only, up to ${MAX_READ_BYTES} bytes.`,
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
      return `error: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (bytes.byteLength === 0) return `error: ${path} is empty — nothing to attach`;
    try {
      await ctx.attach({ name, bytes, lead });
    } catch (err) {
      return `error: the channel refused the upload of ${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `attached ${name} (${bytes.byteLength} bytes) to the conversation`;
  },
};
