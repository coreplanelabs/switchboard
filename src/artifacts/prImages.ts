// Deliberate public copies, not a public bucket or an exception to the run reader.
export const PR_IMAGE_PUBLISH_PATH = "/artifacts/publish-pr-image";
export const MAX_PR_IMAGE_BYTES = 10 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PUBLIC_PATH = new RegExp(`^/pr-images/(${UUID})\\.png$`);

export function validPrImagePath(path: string): boolean {
  return PUBLIC_PATH.test(path);
}

export function prImageKey(path: string): string | undefined {
  const match = PUBLIC_PATH.exec(path);
  return match ? `published-pr/${match[1]}.png` : undefined;
}

export function validPrImageSource(key: string): boolean {
  return /^runs\/[A-Za-z0-9_-]+\/out\/\d+-[A-Za-z0-9._-]+$/.test(key);
}

/** Bounded to one small screenshot in the Worker, never in the bot process.
 *  Count the stream as well as its metadata: a dishonest length must not
 *  turn the public endpoint into an unbounded read or an active-content host. */
export async function readPrImage(object: {
  size: number;
  contentType: string;
  body: ReadableStream<Uint8Array>;
}): Promise<Uint8Array> {
  const reader = object.body.getReader();
  try {
    if (object.contentType !== "image/png") throw new Error("PR images require PNG content type");
    if (!Number.isInteger(object.size) || object.size < 1 || object.size > MAX_PR_IMAGE_BYTES) {
      throw new Error(`PR image size must be 1..${MAX_PR_IMAGE_BYTES} bytes`);
    }
    const bytes = new Uint8Array(object.size);
    let used = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (used + value.length > bytes.length) throw new Error("PR image length exceeds its declared size");
      bytes.set(value, used);
      used += value.length;
    }
    if (used !== bytes.length) throw new Error("PR image length differs from its declared size");
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error("PR images require a PNG signature");
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
