import { afterEach, describe, expect, it, vi } from "vitest";
import { Secret } from "../secrets.js";
import {
  InMemoryArtifactStore,
  parseByteRange,
  PRESIGN_TTL_SECONDS,
  R2ArtifactStore,
  type ArtifactStore,
} from "./store.js";

// Feature: docs/reference/specs/execution.md item 20 — the artifact store seam.
// The bot signs URLs and reads sizes; it never carries a file. R2 through its
// S3 API and an in-memory store honour one contract, so a test of the tool or
// the dispatcher never needs a bucket.

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0); // 20260914T120000Z
const secret = (name: string, value: string) => new Secret(value, name);

function r2(overrides: Partial<ConstructorParameters<typeof R2ArtifactStore>[0]> = {}) {
  return new R2ArtifactStore({
    accountId: "acme-account",
    bucket: "switchboard-artifacts",
    accessKeyId: secret("ARTIFACTS_R2_ACCESS_KEY_ID", "example-access-key"),
    secretAccessKey: secret("ARTIFACTS_R2_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    copy: {
      baseUrl: "https://bot.example.com/",
      token: secret("ARTIFACTS_COPY_TOKEN", "copy-bearer"),
      timeoutMs: 5_000,
    },
    clock: () => NOW,
    ...overrides,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("R2ArtifactStore presigned URLs (item 20)", () => {
  it("a PUT URL names one key on the bucket's S3 endpoint, admits requests for 600 s, signs the content type and carries no secret", async () => {
    const url = new URL(await r2().presignPut("runs/r1/out/1-a.png", "image/png"));
    expect(url.origin).toBe("https://acme-account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/switchboard-artifacts/runs/r1/out/1-a.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(PRESIGN_TTL_SECONDS));
    expect(PRESIGN_TTL_SECONDS).toBe(600);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("example-access-key/20260914/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260914T120000Z");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain("wJalrXUtnFEMI");
  });

  it("a GET URL signs the host alone; the same inputs sign identically, another key does not", async () => {
    const store = r2();
    const get = new URL(await store.presignGet("runs/r1/out/1-a.png"));
    expect(get.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(get.searchParams.get("X-Amz-Expires")).toBe("600");
    const again = await store.presignGet("runs/r1/out/1-a.png");
    expect(again).toBe(get.toString());
    const other = new URL(await store.presignGet("runs/r1/out/2-a.png"));
    expect(other.searchParams.get("X-Amz-Signature")).not.toBe(get.searchParams.get("X-Amz-Signature"));
  });

  it("a key with spaces and a thread segment is percent-encoded per segment, the slashes kept", async () => {
    const url = new URL(await r2().presignGet("threads/slack-CX-1.0/in/1.0/1-my clip.mp4"));
    expect(url.pathname).toBe("/switchboard-artifacts/threads/slack-CX-1.0/in/1.0/1-my%20clip.mp4");
  });
});

describe("R2ArtifactStore.head (item 20)", () => {
  it("answers size and type from a signed HEAD, null on 404, and throws on any other status", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      calls.push(req);
      if (req.url.includes("gone")) return new Response(null, { status: 404 });
      if (req.url.includes("broken")) return new Response(null, { status: 503 });
      if (req.url.includes("unsized"))
        return new Response(null, { status: 200, headers: { "content-type": "text/plain" } });
      return new Response(null, { status: 200, headers: { "content-length": "3145728", "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const store = r2({ fetch: fetchImpl });
    expect(await store.head("runs/r1/out/1-sheet.png")).toEqual({ size: 3_145_728, contentType: "image/png" });
    expect(calls[0]!.method).toBe("HEAD");
    expect(calls[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=example-access-key\//);
    // Without this, Node's fetch advertises br/gzip/deflate/zstd, the edge compresses a text object's
    // answer and omits Content-Length — a text/plain file of 48 bytes or more then has no size to read.
    expect(calls[0]!.headers.get("accept-encoding")).toBe("identity");
    expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeTruthy(); // the header rides inside the signature
    expect(calls[0]!.headers.get("authorization")).toMatch(/SignedHeaders=[^,]*accept-encoding/);
    expect(await store.head("runs/r1/out/gone.png")).toBeNull();
    await expect(store.head("runs/r1/out/broken.png")).rejects.toThrow(
      /HEAD runs\/r1\/out\/broken\.png answered HTTP 503/,
    );
    // `Number(null)` is 0: a 200 with no length must throw, never read as an empty object.
    await expect(store.head("runs/r1/out/unsized.txt")).rejects.toThrow(
      /HEAD runs\/r1\/out\/unsized\.txt answered HTTP 200 without a length/,
    );
  });
});

describe("parseByteRange (item 20)", () => {
  it("reads the three single-range forms and nothing else", () => {
    expect(parseByteRange("bytes=0-99")).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=100-")).toEqual({ start: 100 });
    expect(parseByteRange("bytes=-500")).toEqual({ suffix: 500 });
    expect(parseByteRange(" Bytes=7-7 ")).toEqual({ start: 7, end: 7 });
    // Not a single byte range: an inverted pair, a multi-range list, another unit, an empty suffix, prose.
    for (const bad of ["bytes=9-3", "bytes=0-9,20-29", "items=0-9", "bytes=-", "bytes=", "0-99", "", undefined]) {
      expect(parseByteRange(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("R2ArtifactStore.get with a range (item 20)", () => {
  const BYTES = new Uint8Array(200).map((_, i) => i % 256);
  /** An S3 double that honours a single `Range` the way R2 does: 206 with `Content-Range`, 416 past the end. */
  function ranged(honour = true) {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      requests.push(req);
      const range = req.headers.get("range");
      if (!range || !honour) {
        return new Response(BYTES, {
          status: 200,
          headers: { "content-length": "200", "content-type": "video/mp4" },
        });
      }
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)!;
      const start = m[1] === "" ? Math.max(0, 200 - Number(m[2])) : Number(m[1]);
      const end = m[1] === "" || m[2] === "" ? 199 : Math.min(199, Number(m[2]));
      if (start > 199) {
        return new Response(null, { status: 416, headers: { "content-range": "bytes */200" } });
      }
      const part = BYTES.slice(start, end + 1);
      return new Response(part, {
        status: 206,
        headers: {
          "content-length": String(part.byteLength),
          "content-type": "video/mp4",
          "content-range": `bytes ${start}-${end}/200`,
        },
      });
    }) as unknown as typeof fetch;
    return { requests, store: r2({ fetch: fetchImpl }) };
  }

  it("forwards a valid single range on the wire (unsigned — aws4fetch leaves `range` out of the signature, as S3 expects) and maps a 206 to the part, the object's size and the type", async () => {
    const { requests, store } = ranged();
    const got = await store.get("runs/r1/out/1-clip.mp4", { range: "bytes=10-19" });
    expect(requests[0]!.headers.get("range")).toBe("bytes=10-19");
    expect(requests[0]!.headers.get("accept-encoding")).toBe("identity");
    expect(requests[0]!.headers.get("authorization")).not.toMatch(/SignedHeaders=[^,]*range/);
    expect(got).toMatchObject({ size: 200, contentType: "video/mp4", part: { start: 10, end: 19 } });
    expect(
      new Uint8Array(await new Response((got as { body: ReadableStream<Uint8Array> }).body).arrayBuffer()),
    ).toEqual(BYTES.slice(10, 20));
  });

  it("a store that ignores the range answers the whole object with no part; a range past the end is unsatisfiable, naming the total; bad syntax sends no range at all", async () => {
    const ignoring = ranged(false);
    const whole = await ignoring.store.get("runs/r1/out/1-clip.mp4", { range: "bytes=10-19" });
    expect(whole).toMatchObject({ size: 200, contentType: "video/mp4" });
    expect(whole).not.toHaveProperty("part");

    const { requests, store } = ranged();
    expect(await store.get("runs/r1/out/1-clip.mp4", { range: "bytes=500-" })).toMatchObject({
      unsatisfiable: true,
      size: 200,
    });
    const plain = await store.get("runs/r1/out/1-clip.mp4", { range: "bytes=0-9,20-29" });
    expect(requests.at(-1)!.headers.has("range")).toBe(false);
    expect(plain).toMatchObject({ size: 200 });
    expect(plain).not.toHaveProperty("part");
  });
});

describe("R2ArtifactStore.copyFromUrl (item 20)", () => {
  it("POSTs the copy to the bot's own Worker with the copy bearer and a timeout, and accepts only the size it asked for", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ key: "threads/t/in/1.0/1-clip.mp4", size: 312_441_600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const store = r2({ fetch: fetchImpl });
    const ref = await store.copyFromUrl({
      url: "https://files.slack.com/files-pri/T1-F1/download/clip.mp4",
      size: 312_441_600,
      key: "threads/t/in/1.0/1-clip.mp4",
    });
    expect(ref).toEqual({ key: "threads/t/in/1.0/1-clip.mp4", size: 312_441_600 });
    expect(calls[0]!.url).toBe("https://bot.example.com/artifacts/copy");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer copy-bearer");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      url: "https://files.slack.com/files-pri/T1-F1/download/clip.mp4",
      size: 312_441_600,
      key: "threads/t/in/1.0/1-clip.mp4",
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a non-2xx answer and a short answer are errors carrying the Worker's words; nothing is claimed", async () => {
    const answers = [
      new Response(JSON.stringify({ error: "read-inconsistent: 100 of 200 bytes" }), { status: 409 }),
      new Response(JSON.stringify({ key: "k", size: 100 }), { status: 200 }),
    ];
    const store = r2({ fetch: (async () => answers.shift()!) as unknown as typeof fetch });
    await expect(store.copyFromUrl({ url: "https://files.slack.com/x", size: 200, key: "k" })).rejects.toThrow(
      /copy of k answered HTTP 409: .*read-inconsistent/,
    );
    await expect(store.copyFromUrl({ url: "https://files.slack.com/x", size: 200, key: "k" })).rejects.toThrow(
      /not the 200 bytes asked for/,
    );
  });
});

/** The contract both implementations keep; run against each. */
function contract(
  name: string,
  make: () => Promise<{ store: ArtifactStore; seed: (key: string, bytes: Uint8Array, type: string) => Promise<void> }>,
) {
  describe(`${name} honours the store contract (item 20)`, () => {
    it("presigned URLs name the key and the window; head reads what was stored and null for nothing", async () => {
      const { store, seed } = await make();
      const put = await store.presignPut("runs/r1/out/1-a.png", "image/png");
      const get = await store.presignGet("runs/r1/out/1-a.png");
      for (const u of [put, get]) {
        expect(u).toContain("runs/r1/out/1-a.png");
        expect(u).toContain("600");
      }
      expect(await store.head("runs/r1/out/1-a.png")).toBeNull();
      expect(await store.get("runs/r1/out/1-a.png")).toBeNull();
      await seed("runs/r1/out/1-a.png", new Uint8Array([1, 2, 3]), "image/png");
      expect(await store.head("runs/r1/out/1-a.png")).toEqual({ size: 3, contentType: "image/png" });
      // `get` opens the object as a stream with the same head: what the proxy route pipes.
      const got = await store.get("runs/r1/out/1-a.png");
      expect(got).toMatchObject({ size: 3, contentType: "image/png" });
      expect(got).not.toHaveProperty("part");
      expect(
        new Uint8Array(await new Response((got as { body: ReadableStream<Uint8Array> }).body).arrayBuffer()),
      ).toEqual(new Uint8Array([1, 2, 3]));
    });

    // The proxy's players seek by byte range (live-view.md item 26): a single
    // range comes back as that slice with `part` naming it against the whole
    // size; an open end and a suffix are clamped; a start past the end is
    // unsatisfiable with the size the 416 must name.
    it("a single byte range reads the slice with `part` against the object's size; an open end and a suffix clamp; a start past the end is unsatisfiable", async () => {
      const { store, seed } = await make();
      await seed("runs/r1/out/2-clip.bin", new Uint8Array([10, 11, 12, 13, 14]), "video/mp4");
      const bytesOf = async (o: unknown) => [
        ...new Uint8Array(await new Response((o as { body: ReadableStream<Uint8Array> }).body).arrayBuffer()),
      ];
      const mid = await store.get("runs/r1/out/2-clip.bin", { range: "bytes=1-2" });
      expect(mid).toMatchObject({ size: 5, contentType: "video/mp4", part: { start: 1, end: 2 } });
      expect(await bytesOf(mid)).toEqual([11, 12]);
      const open = await store.get("runs/r1/out/2-clip.bin", { range: "bytes=3-" });
      expect(open).toMatchObject({ part: { start: 3, end: 4 } });
      expect(await bytesOf(open)).toEqual([13, 14]);
      const long = await store.get("runs/r1/out/2-clip.bin", { range: "bytes=2-99" });
      expect(long).toMatchObject({ part: { start: 2, end: 4 } });
      const suffix = await store.get("runs/r1/out/2-clip.bin", { range: "bytes=-2" });
      expect(suffix).toMatchObject({ part: { start: 3, end: 4 } });
      expect(await bytesOf(suffix)).toEqual([13, 14]);
      // The 416 names the size; its type is whatever the store's error answer carries, and the route never reads it.
      expect(await store.get("runs/r1/out/2-clip.bin", { range: "bytes=5-" })).toMatchObject({
        unsatisfiable: true,
        size: 5,
      });
      expect(await store.get("runs/r1/out/missing.bin", { range: "bytes=0-1" })).toBeNull();
    });
  });
}

contract("InMemoryArtifactStore", async () => {
  const store = new InMemoryArtifactStore({ bucket: "test" });
  return { store, seed: async (key, bytes, type) => store.put(key, bytes, type) };
});

contract("R2ArtifactStore (over a fetch double)", async () => {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const req = input as Request;
    const key = decodeURIComponent(new URL(req.url).pathname.replace("/switchboard-artifacts/", ""));
    const o = objects.get(key);
    if (!o) return new Response(null, { status: 404 });
    // A GET is signed in the Authorization header (no query signature): the URL is the bare object.
    if (req.method === "GET") expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    // Every read asks for the object's own bytes: no edge compression, so the length is on the wire.
    expect(req.headers.get("accept-encoding"), `${req.method} ${key}`).toBe("identity");
    const range = req.headers.get("range");
    if (req.method === "GET" && range) {
      // What R2's S3 endpoint does with one `Range`: the slice as a 206, or 416 past the end.
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)!;
      const total = o.bytes.byteLength;
      const start = m[1] === "" ? Math.max(0, total - Number(m[2])) : Number(m[1]);
      const end = m[1] === "" || m[2] === "" ? total - 1 : Math.min(total - 1, Number(m[2]));
      if (start >= total) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      const part = o.bytes.slice(start, end + 1);
      return new Response(part, {
        status: 206,
        headers: {
          "content-length": String(part.byteLength),
          "content-type": o.type,
          "content-range": `bytes ${start}-${end}/${total}`,
        },
      });
    }
    const headers = { "content-length": String(o.bytes.byteLength), "content-type": o.type };
    return new Response(req.method === "HEAD" ? null : o.bytes, { status: 200, headers });
  }) as unknown as typeof fetch;
  const store = r2({ fetch: fetchImpl });
  return {
    store,
    seed: async (key, bytes, type) => void objects.set(key, { bytes: bytes as Uint8Array<ArrayBuffer>, type }),
  };
});

describe("InMemoryArtifactStore.copyFromUrl (item 20)", () => {
  it("fetches the URL, stores exactly `size` bytes with the upstream type, records the copy, and refuses a short body", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const fetchImpl = (async (url: RequestInfo | URL) =>
      String(url).endsWith("short")
        ? new Response(new Uint8Array([1]), { status: 200 })
        : new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } })) as unknown as typeof fetch;
    const store = new InMemoryArtifactStore({ fetch: fetchImpl });
    await expect(
      store.copyFromUrl({ url: "memory://slack/clip", size: 4, key: "threads/t/in/1.0/1-clip.mp4" }),
    ).resolves.toEqual({
      key: "threads/t/in/1.0/1-clip.mp4",
      size: 4,
    });
    expect(await store.head("threads/t/in/1.0/1-clip.mp4")).toEqual({ size: 4, contentType: "video/mp4" });
    await expect(
      store.copyFromUrl({ url: "memory://slack/short", size: 4, key: "threads/t/in/1.0/2-x" }),
    ).rejects.toThrow(/received 1 of 4 bytes; nothing stored/);
    expect(await store.head("threads/t/in/1.0/2-x")).toBeNull();
    expect(store.copies).toHaveLength(2);
  });
});
