import { shellQuote } from "../execution/shellQuote.js";
import type { RunnableTool } from "./runnableTool.js";

export interface ReviewReadTarget {
  repo: string;
  pr: number;
  head: string;
  baseRef: string;
  base: string;
}

// Runs inside the executor, never on the bot host. Git reads immutable objects:
// no checkout file, symlink, textconv, external diff, fetch or model shell runs.
// Bound both the source and the returned page before crossing the output seam.
const READER = String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const args = JSON.parse(process.argv[1]);
const cap = 10 * 1024 * 1024;
const git = (...parts) => execFileSync("git", ["--no-pager", "-C", args.checkout, ...parts], {
  maxBuffer: cap, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }
});
const fail = (error) => { process.stdout.write(JSON.stringify({ error })); };
try {
  const head = git("rev-parse", "--verify", "HEAD").toString().trim();
  if (head !== args.target.head) throw new Error("bound review head does not match the checkout");
  const base = args.target.base;
  const mergeBase = git("merge-base", base, head).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(mergeBase)) throw new Error("review base could not be pinned");
  const source = { ...args.target, base, mergeBase, kind: args.kind, ...(args.path ? { path: args.path } : {}) };
  const bytes = args.kind === "diff"
    ? git("diff", "--no-ext-diff", "--no-textconv", "--no-color", mergeBase, head, "--")
    : git("show", "--no-ext-diff", "--no-textconv", "--format=", "--end-of-options", head + ":" + args.path);
  const sourceHash = createHash("sha256").update(JSON.stringify(source)).update("\0").update(bytes).digest("hex");
  if (args.sourceHash && args.sourceHash !== sourceHash) throw new Error("source changed; start a new read at offset 0");
  if (args.offset > bytes.length) throw new Error("offset is past the source end");
  if (args.offset < bytes.length && (bytes[args.offset] & 0xc0) === 0x80) throw new Error("offset splits a UTF-8 character");
  let end = Math.min(bytes.length, args.offset + args.limit);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(args.offset, end));
  while (JSON.stringify(text).length > 64_000) {
    end = args.offset + Math.floor((end - args.offset) / 2);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(args.offset, end));
  }
  if (text.includes("\0")) throw new Error("binary source is not supported");
  process.stdout.write(JSON.stringify({ source, sourceHash, size: bytes.length, offset: args.offset, nextOffset: end, eof: end === bytes.length, text }));
} catch (error) {
  // Child stderr can contain private source or command details. Keep failures
  // bounded and distinguish our contract errors from Git/transport failures.
  fail(error && "status" in error ? "Git source could not be read completely within the 10 MiB limit" : String(error.message));
}
`;

export const reviewReadTool: RunnableTool = {
  name: "review_read",
  sideEffectFree: true,
  failsInText: true,
  description:
    "Read the bound PR's complete merge-base diff or a tracked file at its pinned head, including lines too large for read. No shell or public URL is needed. Returns UTF-8 text in byte pages, source identity, size, nextOffset and eof. Start at offset 0; continue with the returned nextOffset AND sourceHash until eof. Sources over 10 MiB are refused, never clipped. Reading is not proof that review is complete.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["diff", "file"] },
      path: { type: "string", description: "Repository-relative tracked file path; required for kind=file." },
      offset: { type: "integer", minimum: 0, description: "Byte offset, initially 0; then the returned nextOffset." },
      limit: {
        type: "integer",
        minimum: 4,
        maximum: 32768,
        description: "Maximum UTF-8 bytes per page, default 32768.",
      },
      sourceHash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
        description: "Returned sourceHash; required after the first page.",
      },
    },
    required: ["kind"],
  },
  async run(input, ctx) {
    const fail = (message: string) => `error: review_read: ${message}`;
    const target = ctx.reviewReadTarget?.();
    // Cold reviews prepare Git in the executor's cwd without a checkout binding.
    // The reader still verifies that directory's HEAD before returning source.
    const checkout = ctx.checkout?.() ?? ".";
    if (
      !target ||
      target.repo !== ctx.repo ||
      !ctx.github?.canWrite(target.repo) ||
      !/^[a-f0-9]{40}$/.test(target.head) ||
      !/^[a-f0-9]{40}$/.test(target.base) ||
      !target.baseRef ||
      !checkout ||
      !ctx.executor.execResult
    )
      return fail("review source access is unavailable");
    if (input.kind !== "diff" && input.kind !== "file") return fail("kind must be diff or file");
    const path = input.path;
    if (
      input.kind === "file" &&
      (typeof path !== "string" ||
        !path ||
        path.length > 4096 ||
        path.startsWith("/") ||
        path.split("/").some((p) => p === ".." || p === "." || p === "") ||
        /[\0\r\n]/.test(path))
    )
      return fail("path must name a file inside the repository");
    if (input.kind === "diff" && path !== undefined) return fail("path is only supported for kind=file");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 32768;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
      return fail("offset must be a non-negative safe integer");
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 4 || limit > 32768)
      return fail("limit must be an integer from 4 to 32768");
    if (offset > 0 && input.sourceHash === undefined) return fail("sourceHash is required after the first page");
    if (
      input.sourceHash !== undefined &&
      (typeof input.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceHash))
    )
      return fail("sourceHash must be the returned SHA-256 identity");
    ctx.github.recordRead?.(target.repo);
    const args = { target, checkout, kind: input.kind, path, offset, limit, sourceHash: input.sourceHash };
    try {
      const result = await ctx.executor.execResult(
        `node -e ${shellQuote(READER)} ${shellQuote(JSON.stringify(args))}`,
        { signal: ctx.signal },
      );
      if (result.exitCode !== 0 || result.truncated) return fail("source read did not complete; no page was accepted");
      const page = JSON.parse(result.stdout) as {
        error?: string;
        source?: ReviewReadTarget & { base: string; mergeBase: string; kind: string; path?: string };
        text?: string;
        sourceHash?: string;
        offset?: number;
        nextOffset?: number;
        size?: number;
        eof?: boolean;
      };
      if (page.error) return fail(page.error);
      if (
        page.source?.head !== target.head ||
        page.source?.repo !== target.repo ||
        page.source?.pr !== target.pr ||
        page.source?.baseRef !== target.baseRef ||
        page.source?.base !== target.base ||
        page.source?.kind !== input.kind ||
        page.source?.path !== path ||
        typeof page.text !== "string" ||
        page.offset !== offset ||
        !Number.isSafeInteger(page.size) ||
        page.size! < 0 ||
        page.size! > 10 * 1024 * 1024 ||
        page.nextOffset !== offset + Buffer.byteLength(page.text) ||
        page.nextOffset > page.size! ||
        page.eof !== (page.nextOffset === page.size) ||
        Buffer.byteLength(page.text) > limit ||
        !/^[a-f0-9]{64}$/.test(page.sourceHash ?? "") ||
        (input.sourceHash !== undefined && page.sourceHash !== input.sourceHash) ||
        !/^[a-f0-9]{40}$/.test(page.source.base) ||
        !/^[a-f0-9]{40}$/.test(page.source.mergeBase)
      )
        return fail("source read returned an invalid page");
      // Recheck access after the transport, before publishing private bytes.
      const current = ctx.reviewReadTarget?.();
      if (
        current?.head !== target.head ||
        current.repo !== target.repo ||
        current.pr !== target.pr ||
        current.baseRef !== target.baseRef ||
        current.base !== target.base ||
        !ctx.github.canWrite(target.repo)
      )
        return fail("review source access changed during the read");
      return result.stdout;
    } catch {
      return fail("source read did not complete; no page was accepted");
    }
  },
};
