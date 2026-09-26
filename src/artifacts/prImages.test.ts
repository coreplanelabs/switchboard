import { describe, expect, it } from "vitest";
import { MAX_PR_IMAGE_BYTES, readPrImage, validPrImagePath, validPrImageSource } from "./prImages.js";

const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS6kAAAAASUVORK5CYII=", "base64"),
);
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

describe("PR image validation", () => {
  it("accepts only outbound keys and opaque public paths, never arbitrary keys or URLs", () => {
    expect(validPrImageSource("runs/r1/out/1-shot.png")).toBe(true);
    for (const key of [
      "threads/t/in/1/1-shot.png",
      "runs/r1/out/../x",
      "runs/../out/1-x",
      "https://host/x",
      "published-pr/x.png",
    ]) {
      expect(validPrImageSource(key), key).toBe(false);
    }
    expect(validPrImagePath("/pr-images/12345678-1234-4123-8123-123456789abc.png")).toBe(true);
    for (const path of ["/pr-images/runs/r1/out/1-shot.png", "/pr-images/x.svg", "/pr-images/x.png?t=secret"]) {
      expect(validPrImagePath(path), path).toBe(false);
    }
  });

  it("requires PNG MIME and signature and exact bounded bytes, not just a png filename", async () => {
    expect(await readPrImage({ size: png.length, contentType: "image/png", body: stream(png) })).toEqual(png);
    for (const [contentType, bytes] of [
      ["text/html", png],
      ["image/svg+xml", png],
      ["image/png", new TextEncoder().encode("<html>secret</html>")],
    ] as const) {
      await expect(readPrImage({ size: bytes.length, contentType, body: stream(bytes) })).rejects.toThrow(/PNG/);
    }
    await expect(readPrImage({ size: 10, contentType: "image/png", body: stream(png) })).rejects.toThrow(/length/);
    await expect(readPrImage({ size: 1, contentType: "image/png", body: stream(png) })).rejects.toThrow(/length/);
    await expect(readPrImage({ size: 0, contentType: "image/png", body: stream(png) })).rejects.toThrow(/size/);
    await expect(
      readPrImage({ size: MAX_PR_IMAGE_BYTES + 1, contentType: "image/png", body: stream(png) }),
    ).rejects.toThrow(/size/);
  });
});
