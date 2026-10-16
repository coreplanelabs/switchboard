import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeContext, validateToolArguments, type JsonObject, type Model, type Tool } from "@earendil-works/pi-ai";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryGithubApi } from "../execution/githubApi.js";
import { toolTextFailed } from "../core/runEvents.js";
import { LocalExecutor } from "../execution/executor.js";
import { TOOLSETS } from "./toolsets.js";
import type { ToolContext } from "./runnableTool.js";
import { shapeToolSchemasForWire } from "../core/providerToolSchemas.js";
import { reviewReadTool } from "./reviewRead.js";

let root: string;
let head: string;
let base: string;
const source = "// generated\n" + "é😀".repeat(170_000) + "\nend\n";
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 12_000_000 }).trim();
function context(): ToolContext {
  return {
    executor: new LocalExecutor(root),
    checkout: () => root,
    repo: "example/project",
    github: { api: new InMemoryGithubApi(), canWrite: () => true },
    reviewReadTarget: () => ({ repo: "example/project", pr: 7, head, baseRef: "main" }),
  };
}
async function read(input: Record<string, unknown>, ctx = context()) {
  const tool = TOOLSETS.readonly!.find((t) => t.name === "review_read");
  expect(tool?.name).toBe("review_read");
  const result = String(await tool!.run(input, ctx));
  return result.startsWith("error: review_read: ")
    ? { error: result.slice("error: review_read: ".length) }
    : JSON.parse(result);
}

describe("review_read", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "review-read-"));
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "catalog.txt"), "old\n");
    git("add", ".");
    git("commit", "-qm", "base");
    base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", base);
    writeFileSync(join(root, "catalog.txt"), source);
    writeFileSync(join(root, "other.txt"), "x".repeat(1_000_000));
    writeFileSync(join(root, "unicode.txt"), "\uFEFFé😀\r\nend\n");
    git("add", ".");
    git("commit", "-qm", "large source");
    head = git("rev-parse", "HEAD");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("keeps first-page inputs optional on the Responses wire and enforces pinned continuations", async () => {
    const model: Model<"openai-responses"> = {
      id: "fixture",
      name: "fixture",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://provider.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 100,
    };
    const tool: Tool = {
      name: reviewReadTool.name,
      description: reviewReadTool.description,
      parameters: reviewReadTool.inputSchema as Tool["parameters"],
    };
    let sent: { tools: Array<{ name: string; strict?: boolean; parameters: Tool["parameters"] }> } | undefined;
    await responsesStream(model, normalizeContext({ messages: [], tools: [tool] }), {
      apiKey: "fixture",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        sent = shapeToolSchemasForWire("openai-responses", body).body as typeof sent;
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    }).result();
    expect(sent?.tools.map((entry) => entry.name)).toEqual(["review_read"]);
    expect(sent?.tools[0].strict).toBe(false);
    const wireTool: Tool = { ...tool, parameters: sent!.tools[0].parameters };
    const checkedRead = (input: JsonObject) =>
      read(validateToolArguments(wireTool, { type: "toolCall", id: "read", name: tool.name, arguments: input }));
    const first = await checkedRead({ kind: "diff", limit: 4 });
    expect(first).toMatchObject({ text: "diff", offset: 0, nextOffset: 4, eof: false });
    expect(
      await checkedRead({ kind: "diff", path: null, offset: 4, limit: 4, sourceHash: first.sourceHash }),
    ).toMatchObject({ text: " --g", offset: 4, nextOffset: 8, eof: false });
    expect(
      await checkedRead({ kind: "file", path: "unicode.txt", offset: null, limit: null, sourceHash: null }),
    ).toMatchObject({ text: "\uFEFFé😀\r\nend\n", offset: 0, nextOffset: 15, eof: true });
    expect(await checkedRead({ kind: "diff", path: null, offset: 4, limit: 4, sourceHash: null })).toEqual({
      error: "sourceHash is required after the first page",
    });
    expect(await checkedRead({ kind: "diff", path: null, offset: 0, limit: 4, sourceHash: "0".repeat(64) })).toEqual({
      error: "source changed; start a new read at offset 0",
    });
    expect(await checkedRead({ kind: "diff", path: "other.txt", offset: 0, limit: 4, sourceHash: null })).toEqual({
      error: "path is only supported for kind=file",
    });
  });

  it("reconstructs a private full diff and oversized source line through bounded UTF8 byte pages", async () => {
    for (const input of [{ kind: "file", path: "catalog.txt" }, { kind: "diff" }]) {
      const expected =
        input.kind === "file"
          ? source
          : execFileSync("git", ["-C", root, "diff", "--no-color", `${base}...${head}`], {
              encoding: "utf8",
              maxBuffer: 12_000_000,
            });
      let offset = 0;
      let sourceHash: string | undefined;
      let actual = "";
      for (;;) {
        const page = await read({ ...input, offset, ...(sourceHash ? { sourceHash } : {}) });
        expect(page.source).toMatchObject({ repo: "example/project", pr: 7, head, base, mergeBase: base });
        expect(page.offset).toBe(offset);
        expect(page.nextOffset).toBe(offset + Buffer.byteLength(page.text));
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(32_768);
        expect(page.sourceHash).toMatch(/^[a-f0-9]{64}$/);
        if (sourceHash) expect(page.sourceHash).toBe(sourceHash);
        sourceHash = page.sourceHash;
        actual += page.text;
        offset = page.nextOffset;
        if (page.eof) break;
      }
      expect(actual).toBe(expected);
      expect(offset).toBe(Buffer.byteLength(expected));
      expect(await read({ ...input, offset, sourceHash })).toMatchObject({ text: "", eof: true, nextOffset: offset });
    }
  }, 30_000);

  it("refuses unpinned continuation, invalid offsets, and changed sources", async () => {
    const input = { kind: "file", path: "catalog.txt" };
    expect(await read({ ...input, offset: 1 })).toMatchObject({ error: "sourceHash is required after the first page" });
    const page = await read(input);
    expect(await read({ ...input, offset: 14, sourceHash: page.sourceHash })).toMatchObject({
      error: "offset splits a UTF-8 character",
    });
    expect(await read({ ...input, offset: page.size + 1, sourceHash: page.sourceHash })).toMatchObject({
      error: "offset is past the source end",
    });
    expect(await read({ ...input, offset: page.nextOffset, sourceHash: "0".repeat(64) })).toMatchObject({
      error: "source changed; start a new read at offset 0",
    });
    expect(await read({ ...input, offset: -1 })).toMatchObject({ error: "offset must be a non-negative safe integer" });
  });

  it("refuses access, foreign targets, missing pin, and paths outside the repository", async () => {
    const ctx = context();
    ctx.github!.canWrite = () => false;
    expect(await read({ kind: "diff" }, ctx)).toMatchObject({ error: "review source access is unavailable" });
    ctx.github!.canWrite = () => true;
    ctx.reviewReadTarget = () => ({ repo: "other/project", pr: 7, head, baseRef: "main" });
    expect(await read({ kind: "diff" }, ctx)).toMatchObject({ error: "review source access is unavailable" });
    delete ctx.reviewReadTarget;
    expect(await read({ kind: "diff" }, ctx)).toMatchObject({ error: "review source access is unavailable" });
    expect(await read({ kind: "file", path: "../secret" })).toMatchObject({
      error: "path must name a file inside the repository",
    });
    expect(await read({ kind: "file", path: "/etc/passwd" })).toMatchObject({
      error: "path must name a file inside the repository",
    });
    expect(await read({ kind: "file", path: ".git/config" })).toHaveProperty("error");
    expect(await read({ kind: "file", path: "catalog.txt" })).toMatchObject({ offset: 0, eof: false });
  });
  it("rejects unsupported transport and access revoked while reading without publishing a page", async () => {
    const ctx = context();
    const run = ctx.executor.execResult!.bind(ctx.executor);
    ctx.executor.execResult = async (command, options) => {
      const result = await run(command, options);
      ctx.github!.canWrite = () => false;
      return result;
    };
    expect(await read({ kind: "diff" }, ctx)).toMatchObject({ error: "review source access changed during the read" });
    ctx.github!.canWrite = () => true;
    ctx.executor.execResult = async () => ({ stdout: "cut", stderr: "", exitCode: 0, truncated: true });
    const tool = TOOLSETS.readonly!.find((t) => t.name === "review_read")!;
    const result = String(await tool.run({ kind: "diff" }, ctx));
    expect(result).toBe("error: review_read: source read did not complete; no page was accepted");
    expect(toolTextFailed(result)).toBe(true);
  });

  it("pins the original byte source across base movement and rejects larger sources", async () => {
    const page = await read({ kind: "diff" });
    git("update-ref", "refs/remotes/origin/main", head);
    try {
      expect(await read({ kind: "diff", offset: page.nextOffset, sourceHash: page.sourceHash })).toMatchObject({
        error: "source changed; start a new read at offset 0",
      });
    } finally {
      git("update-ref", "refs/remotes/origin/main", base);
    }
    writeFileSync(join(root, "too-big.txt"), "x".repeat(10 * 1024 * 1024 + 1));
    git("add", "too-big.txt");
    git("commit", "-qm", "oversize");
    const oldHead = head;
    head = git("rev-parse", "HEAD");
    try {
      expect(await read({ kind: "file", path: "too-big.txt" })).toMatchObject({
        error: "Git source could not be read completely within the 10 MiB limit",
      });
    } finally {
      git("reset", "--hard", oldHead);
      head = oldHead;
    }
  });
  it("preserves BOM, Unicode, and line endings even with four-byte pages", async () => {
    let offset = 0;
    let sourceHash: string | undefined;
    let text = "";
    for (;;) {
      const page = await read({ kind: "file", path: "unicode.txt", limit: 4, offset, sourceHash });
      expect(page.offset).toBe(offset);
      expect(page.nextOffset).toBe(offset + Buffer.byteLength(page.text));
      text += page.text;
      offset = page.nextOffset;
      sourceHash = page.sourceHash;
      if (page.eof) break;
    }
    expect(text).toBe("\uFEFFé😀\r\nend\n");
    expect(offset).toBe(15);
  });
});
