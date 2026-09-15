import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64ByteLength,
  base64LengthOf,
  chunkPlan,
  MAX_READ_BASE64_CHARS,
  MAX_READ_BYTES,
  parseByteSize,
  READ_CHUNK_BYTES,
  readChunkCommandFor,
  readCommandFor,
  readEncodingOf,
  statCommandFor,
  tooLargeMessage,
} from "./binaryRead.js";
import { decodeBase64Read, ExecInfraError, LocalExecutor } from "./executor.js";

// Feature: docs/reference/specs/execution.md item 19 — a binary read on the
// Executor seam: whole files as bytes under one cap, through the same `/read`
// route asked for base64, with the Worker's answer decoded (or its refusal
// named) on the bot side.

describe("the /read encoding contract (item 19)", () => {
  it("no encoding is the text read every older client sends; base64 asks for bytes; anything else is refused by name", () => {
    expect(readEncodingOf({ path: "a.ts" })).toBe("utf8");
    expect(readEncodingOf({ path: "a.png", encoding: "base64" })).toBe("base64");
    expect(readEncodingOf({ path: "a.png", encoding: "hex" })).toEqual({
      error: 'encoding must be "base64" or absent, got "hex"',
    });
    expect(readEncodingOf({ encoding: 7 })).toMatchObject({ error: expect.stringContaining("got 7") });
  });

  it("the resident reads text with cat; bytes never ride one command (see the chunked read)", () => {
    expect(readCommandFor("/w/t/a.ts")).toBe("cat -- /w/t/a.ts");
  });

  it("the base64 cap is exactly what a MAX_READ_BYTES file encodes to, so the largest allowed file is never called truncated — and the decoded byte count, not the char count, tells a file one byte over apart", () => {
    const full = Buffer.alloc(MAX_READ_BYTES, 1).toString("base64");
    expect(full.length).toBe(MAX_READ_BASE64_CHARS);
    // Padding hides up to two extra bytes inside the same char count: the
    // Workers check bytes as well as the stream cap.
    const oneOver = Buffer.alloc(MAX_READ_BYTES + 1, 1).toString("base64");
    expect(oneOver.length).toBe(MAX_READ_BASE64_CHARS);
    expect(base64ByteLength(oneOver)).toBe(MAX_READ_BYTES + 1);
    expect(Buffer.alloc(MAX_READ_BYTES + 3, 1).toString("base64").length).toBeGreaterThan(MAX_READ_BASE64_CHARS);
  });

  it("base64ByteLength counts the decoded bytes, padding discounted", () => {
    for (const n of [0, 1, 2, 3, 4, 100, 1001]) {
      expect(base64ByteLength(Buffer.alloc(n, 7).toString("base64"))).toBe(n);
    }
  });
});

describe("the resident's chunked byte read (item 19)", () => {
  it("measures the file first with stat, and reads only a number", () => {
    expect(statCommandFor("/w/t/a.png")).toBe("stat -c %s -- /w/t/a.png");
    expect(parseByteSize("12000000\n")).toBe(12_000_000);
    expect(parseByteSize("0")).toBe(0);
    expect(parseByteSize("stat: cannot statx 'a.png': No such file or directory")).toBeNull();
    expect(parseByteSize("")).toBeNull();
  });

  it("the chunk is a multiple of 3 and well under the SDK's observed stream cut, so pieces have no padding and concatenate into the whole", () => {
    expect(READ_CHUNK_BYTES % 3).toBe(0);
    expect(READ_CHUNK_BYTES).toBeLessThan(1_764_096); // the bytes that survived the cut, live
    expect(base64LengthOf(READ_CHUNK_BYTES) % 4).toBe(0);
    const file = Buffer.alloc(READ_CHUNK_BYTES * 2 + 17, 3);
    const pieces = chunkPlan(file.byteLength).map((c) =>
      file.subarray(c.offset, c.offset + c.length).toString("base64"),
    );
    expect(pieces.join("")).toBe(file.toString("base64"));
  });

  it("the plan covers the size exactly, in order, with a short last chunk; an empty file has no chunks", () => {
    expect(chunkPlan(0)).toEqual([]);
    expect(chunkPlan(5, 3)).toEqual([
      { offset: 0, length: 3 },
      { offset: 3, length: 2 },
    ]);
    expect(chunkPlan(6, 3)).toEqual([
      { offset: 0, length: 3 },
      { offset: 3, length: 3 },
    ]);
    expect(chunkPlan(MAX_READ_BYTES)).toHaveLength(Math.ceil(MAX_READ_BYTES / READ_CHUNK_BYTES));
  });

  it("each chunk command seeks with tail, bounds with head and encodes unwrapped, and its expected base64 length is known before it runs", () => {
    expect(readChunkCommandFor("/w/t/a.png", { offset: 0, length: 3 })).toBe(
      "tail -c +1 -- /w/t/a.png | head -c 3 | base64 -w0",
    );
    expect(readChunkCommandFor("/w/t/a.png", { offset: 1_048_575, length: 17 })).toBe(
      "tail -c +1048576 -- /w/t/a.png | head -c 17 | base64 -w0",
    );
    for (const n of [1, 2, 3, 17, READ_CHUNK_BYTES])
      expect(base64LengthOf(n)).toBe(Buffer.alloc(n).toString("base64").length);
  });
});

describe("decodeBase64Read — the bot side of a Worker's answer (item 19)", () => {
  it("decodes a base64 answer to the bytes when they are exactly the size the Worker measured", () => {
    const bytes = decodeBase64Read(
      { encoding: "base64", content: Buffer.from([137, 80, 78, 71]).toString("base64"), size: 4 },
      { where: "sandbox worker /read", path: "shot.png" },
    );
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
  });

  it("bytes that are not the named size are read-inconsistent and nothing is handed on; an answer without a size predates the verified read", () => {
    const content = Buffer.from([137, 80, 78]).toString("base64");
    expect(() =>
      decodeBase64Read({ encoding: "base64", content, size: 4 }, { where: "resident /read", path: "a.png" }),
    ).toThrow("resident /read: read-inconsistent — a.png is 4 bytes but 3 arrived; nothing was handed on");
    expect(() => decodeBase64Read({ encoding: "base64", content }, { where: "resident /read", path: "a.png" })).toThrow(
      /answered without the file's size — it predates the verified read; redeploy it/,
    );
  });

  it("a Worker that predates binary reads answers text — named as a rollout gap, never decoded as base64, never infra", () => {
    const attempt = () => decodeBase64Read({ content: "PNG..." }, { where: "resident /read", path: "shot.png" });
    expect(attempt).toThrow(/resident \/read: the Worker answered a text read to a request for bytes.*redeploy/);
    expect(attempt).not.toThrow(ExecInfraError);
  });

  it("a `tooLarge` answer is the cap's one message, naming the file", () => {
    const attempt = () =>
      decodeBase64Read({ encoding: "base64", tooLarge: true }, { where: "resident /read", path: "video.mp4" });
    expect(attempt).toThrow(tooLargeMessage("video.mp4"));
    expect(attempt).toThrow(new RegExp(`video.mp4 is over the ${MAX_READ_BYTES}-byte cap`));
  });
});

describe("LocalExecutor.readBytes (item 19)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-readbytes-"));
  const ex = new LocalExecutor(dir);

  it("hands back the file's exact bytes — a PNG header survives where a utf8 read would mangle it", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    writeFileSync(join(dir, "shot.png"), png);
    expect(Buffer.from(await ex.readBytes("shot.png")).equals(png)).toBe(true);
    // The text read of the same file is not the bytes — the reason the seam exists.
    expect(Buffer.from(await ex.readFile("shot.png"), "utf8").equals(png)).toBe(false);
  });

  it("refuses a path that escapes the workspace, like every other op", async () => {
    await expect(ex.readBytes("../outside.png")).rejects.toThrow(/escapes workspace/);
  });

  it("refuses a file over the cap by name with its size, before reading it", async () => {
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_READ_BYTES + 1));
    await expect(ex.readBytes("big.bin")).rejects.toThrow(tooLargeMessage("big.bin", MAX_READ_BYTES + 1));
  });
});
