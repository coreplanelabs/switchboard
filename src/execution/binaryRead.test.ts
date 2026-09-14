import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64ByteLength,
  MAX_READ_BASE64_CHARS,
  MAX_READ_BYTES,
  readCommandFor,
  readEncodingOf,
  tooLargeMessage,
} from "./binaryRead.js";
import { decodeBase64Read, ExecHealthTracker, ExecInfraError, LocalExecutor, type Executor } from "./executor.js";

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

  it("the resident reads text with cat and bytes with an unwrapped base64 — one line for the char cap to slice", () => {
    expect(readCommandFor("utf8", "/w/t/a.ts")).toBe("cat -- /w/t/a.ts");
    expect(readCommandFor("base64", "/w/t/a.png")).toBe("base64 -w0 -- /w/t/a.png");
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

describe("decodeBase64Read — the bot side of a Worker's answer (item 19)", () => {
  it("decodes a base64 answer to the bytes", () => {
    const bytes = decodeBase64Read(
      { encoding: "base64", content: Buffer.from([137, 80, 78, 71]).toString("base64") },
      { where: "sandbox worker /read", path: "shot.png" },
    );
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
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

describe("ExecHealthTracker.readBytes (item 19)", () => {
  it("is present exactly when the inner executor reads bytes, and counts its infra failures like every op", async () => {
    const plain: Executor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    expect(new ExecHealthTracker(plain).readBytes).toBeUndefined();
    let fail = true;
    const withBytes: Executor = {
      ...plain,
      readBytes: async () => {
        if (fail) throw new ExecInfraError("resident /read HTTP 502");
        return new Uint8Array([1]);
      },
    };
    const t = new ExecHealthTracker(withBytes);
    await expect(t.readBytes!("a.png")).rejects.toBeInstanceOf(ExecInfraError);
    expect(t.consecutiveInfraFailures).toBe(1);
    fail = false;
    expect(Array.from(await t.readBytes!("a.png"))).toEqual([1]);
    expect(t.consecutiveInfraFailures).toBe(0);
  });
});
