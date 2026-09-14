import { describe, expect, it } from "vitest";
import {
  COPY_PATH,
  handleArtifactsCopy,
  MAX_COPY_BYTES,
  parseCopyRequest,
  sameToken,
  slackFileHost,
  validCopyKey,
  type CopyBucket,
  type CopyDeps,
} from "./artifactsCopy.ts";

// Feature: docs/reference/specs/execution.md item 20 (record 0033) — the Worker
// copies a Slack file into the artifacts bucket for the bot: bearer first, the
// request's shape before any fetch, Slack's answer checked before any put, and
// one fixed-length put that fails whole when the stream does. Plain Node: the
// bucket, the fetch and the length pipe are doubles.

const TOKEN = "copy-bearer-for-tests";
const KEY = "threads/slack-C1-1700000000.000100/in/1700000000.000200/0-clip.mp4";
const URL_PRIVATE = "https://files.slack.com/files-pri/T1-F1/clip.mp4";

/** A bucket double: records puts and drains the stream, so a short body is seen as a failure. */
function bucket() {
  const puts: Array<{ key: string; bytes: number; contentType: string | undefined }> = [];
  const b: CopyBucket = {
    put: async (key, value, options) => {
      let bytes = 0;
      for await (const chunk of value) bytes += chunk.byteLength;
      puts.push({ key, bytes, contentType: options?.httpMetadata?.contentType });
      return {};
    },
  };
  return { b, puts };
}

/** A length pipe that fails like FixedLengthStream: the writable rejects a byte count other than `size`. */
function fixedLength(size: number) {
  let seen = 0;
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > size) controller.error(new Error(`FixedLengthStream: more than ${size} bytes`));
      else controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen !== size) controller.error(new Error(`FixedLengthStream: ${seen} of ${size} bytes`));
    },
  });
  return { readable: ts.readable, writable: ts.writable };
}

function upstream(answer: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; auth: string | undefined; redirect: RequestRedirect | undefined }>;
} {
  const calls: Array<{ url: string; auth: string | undefined; redirect: RequestRedirect | undefined }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined, redirect: init?.redirect });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const body = (size: number) => {
  const bytes = new Uint8Array(size).fill(7);
  return new ReadableStream<Uint8Array>({
    start(c) {
      // Two chunks, so the pipe sees a stream rather than one buffer.
      c.enqueue(bytes.slice(0, Math.floor(size / 2)));
      c.enqueue(bytes.slice(Math.floor(size / 2)));
      c.close();
    },
  });
};

function deps(over: Partial<CopyDeps> & { puts?: ReturnType<typeof bucket>["puts"] } = {}) {
  const { b, puts } = bucket();
  const d: CopyDeps = {
    bucket: b,
    bucketName: "switchboard-artifacts",
    copyToken: TOKEN,
    slackToken: "xoxb-test-slack-token",
    fetch: upstream(() => new Response(null, { status: 500 })).fetch,
    lengthPipe: fixedLength,
    ...over,
  };
  return { d, puts };
}

/** A POST with the bearer (`null`: no authorization header at all). */
const post = (json: unknown, token: string | null = TOKEN) =>
  new Request(`https://bot.example.com${COPY_PATH}`, {
    method: "POST",
    headers: token !== null ? { authorization: `Bearer ${token}` } : {},
    body: typeof json === "string" ? json : JSON.stringify(json),
  });

describe("artifacts copy — the request, before any fetch", () => {
  it("a missing or wrong bearer is 401 and nothing is fetched or put; GET with the bearer names the bucket", async () => {
    const up = upstream(() => new Response(null, { status: 200 }));
    const { d, puts } = deps({ fetch: up.fetch });
    for (const req of [
      post({ url: URL_PRIVATE, size: 4, key: KEY }, null),
      post({ url: URL_PRIVATE, size: 4, key: KEY }, "wrong"),
      post({ url: URL_PRIVATE, size: 4, key: KEY }, `${TOKEN}x`),
    ]) {
      const res = await handleArtifactsCopy(req, d);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "artifacts copy: bearer refused" });
    }
    expect(up.calls).toEqual([]);
    expect(puts).toEqual([]);
    const get = await handleArtifactsCopy(
      new Request(`https://bot.example.com${COPY_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      d,
    );
    expect(await get.json()).toEqual({ ok: true, bucket: "switchboard-artifacts" });
    // Without the binding the GET says so — and the bearer is still checked first.
    const bare = await handleArtifactsCopy(
      new Request(`https://bot.example.com${COPY_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      { ...d, bucket: undefined, bucketName: undefined },
    );
    expect(bare.status).toBe(503);
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abc", "abd")).toBe(false);
    expect(sameToken("abc", "abcd")).toBe(false);
  });

  it("a url off Slack's hosts, a bad size, an over-ceiling size and a key that is not an inbound key are refused by name with no fetch and no token sent", async () => {
    const up = upstream(() => new Response(null, { status: 200 }));
    const { d, puts } = deps({ fetch: up.fetch });
    const cases: Array<[unknown, number, RegExp]> = [
      [{ url: "https://evil.example/x", size: 4, key: KEY }, 400, /not a Slack file host/],
      [{ url: "http://files.slack.com/x", size: 4, key: KEY }, 400, /not a Slack file host/],
      [{ url: URL_PRIVATE, size: 0, key: KEY }, 400, /size must be a positive integer/],
      [{ url: URL_PRIVATE, size: 4.5, key: KEY }, 400, /size must be a positive integer/],
      [{ url: URL_PRIVATE, size: MAX_COPY_BYTES + 1, key: KEY }, 413, /over the 1073741824-byte ceiling/],
      [{ url: URL_PRIVATE, size: 4, key: "runs/r1/out/1-a.png" }, 400, /not an inbound artifact key/],
      [{ url: URL_PRIVATE, size: 4, key: "threads/t/in/1.0/../x" }, 400, /not an inbound artifact key/],
      ["not json", 400, /body is not JSON/],
      [[1, 2], 400, /body is not an object/],
    ];
    for (const [json, status, re] of cases) {
      const res = await handleArtifactsCopy(post(json), d);
      expect(res.status, JSON.stringify(json)).toBe(status);
      expect(((await res.json()) as { error: string }).error).toMatch(re);
    }
    expect(up.calls).toEqual([]);
    expect(puts).toEqual([]);
    expect(slackFileHost("files.slack.com")).toBe(true);
    expect(slackFileHost("acme.slack.com")).toBe(true);
    expect(slackFileHost("slack.com.evil.example")).toBe(false);
    expect(validCopyKey(KEY)).toBe(true);
    expect(validCopyKey("threads/t/in/1.0/0-a b.png")).toBe(false);
    const parsed = parseCopyRequest(JSON.stringify({ url: URL_PRIVATE, size: 4, key: KEY }), MAX_COPY_BYTES);
    expect(parsed.ok && parsed.value.key).toBe(KEY);
  });

  it("without the bucket binding or the Slack token the route is 503 (after the bearer), and a non-POST is 405", async () => {
    const up = upstream(() => new Response(null, { status: 200 }));
    const noBucket = deps({ fetch: up.fetch, bucket: undefined }).d;
    expect((await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 4, key: KEY }), noBucket)).status).toBe(503);
    const noSlack = deps({ fetch: up.fetch, slackToken: undefined }).d;
    expect((await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 4, key: KEY }), noSlack)).status).toBe(503);
    const put = new Request(`https://bot.example.com${COPY_PATH}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((await handleArtifactsCopy(put, deps().d)).status).toBe(405);
    expect(up.calls).toEqual([]);
  });
});

describe("artifacts copy — Slack's answer, before any put", () => {
  it("the login page (a 200 text/html) is refused as unauthorized; a non-200 is Slack's status; nothing is put", async () => {
    const login = upstream(
      () =>
        new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const { d, puts } = deps({ fetch: login.fetch });
    const res = await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 4, key: KEY }), d);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/login page.*not authorized/);
    // The token went to Slack — in the header, never on the URL — and redirects are not followed.
    expect(login.calls).toEqual([{ url: URL_PRIVATE, auth: "Bearer xoxb-test-slack-token", redirect: "manual" }]);
    const redirected = deps({ fetch: upstream(() => new Response(null, { status: 302 })).fetch });
    const r = await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 4, key: KEY }), redirected.d);
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([
      502,
      "artifacts copy: slack answered HTTP 302",
    ]);
    expect(puts).toEqual([]);
    expect(redirected.puts).toEqual([]);
  });

  it("a Content-Length absent or other than the declared size is 409 with both numbers; nothing is put", async () => {
    const other = deps({
      fetch: upstream(
        () => new Response(body(8), { status: 200, headers: { "content-length": "8", "content-type": "video/mp4" } }),
      ).fetch,
    });
    const res = await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 4, key: KEY }), other.d);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "artifacts copy: slack states 8 bytes, not the 4 declared" });
    const none = deps({
      fetch: upstream(() => {
        const r = new Response(body(4), { status: 200, headers: { "content-type": "video/mp4" } });
        r.headers.delete("content-length");
        return r;
      }).fetch,
    });
    const r2 = await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 4, key: KEY }), none.d);
    expect([r2.status, ((await r2.json()) as { error: string }).error]).toEqual([
      409,
      "artifacts copy: slack stated no length for the file",
    ]);
    expect(other.puts).toEqual([]);
    expect(none.puts).toEqual([]);
  });

  it("a Slack fetch that throws is 502 with the reason", async () => {
    const { d, puts } = deps({
      fetch: (async () => {
        throw new Error("connect ETIMEDOUT");
      }) as unknown as typeof fetch,
    });
    const res = await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 4, key: KEY }), d);
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([
      502,
      "artifacts copy: slack did not answer: connect ETIMEDOUT",
    ]);
    expect(puts).toEqual([]);
  });
});

describe("artifacts copy — the copy itself", () => {
  it("happy path: one put under the key through the fixed-length pipe with Slack's content type; the answer names the key and size", async () => {
    const SIZE = 1_000;
    const up = upstream(
      () =>
        new Response(body(SIZE), {
          status: 200,
          headers: { "content-length": String(SIZE), "content-type": "video/mp4" },
        }),
    );
    const { d, puts } = deps({ fetch: up.fetch });
    const res = await handleArtifactsCopy(post({ url: URL_PRIVATE, size: SIZE, key: KEY }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, key: KEY, size: SIZE });
    expect(puts).toEqual([{ key: KEY, bytes: SIZE, contentType: "video/mp4" }]);
  });

  it("an upstream body that ends short fails the pipe: the put rejects, the route is 502, and the bucket holds nothing", async () => {
    // Slack promised 1000 bytes and sent 600: the fixed-length pipe errors at flush.
    const up = upstream(
      () =>
        new Response(body(600), { status: 200, headers: { "content-length": "1000", "content-type": "video/mp4" } }),
    );
    const stored: string[] = [];
    const strict: CopyBucket = {
      put: async (key, value) => {
        // R2 rejects a stream that errors; nothing is stored.
        for await (const _ of value) void _;
        stored.push(key);
        return {};
      },
    };
    const { d } = deps({ fetch: up.fetch, bucket: strict });
    const res = await handleArtifactsCopy(post({ url: URL_PRIVATE, size: 1000, key: KEY }), d);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /failed mid-stream: FixedLengthStream: 600 of 1000 bytes/,
    );
    expect(stored).toEqual([]);
  });
});

// worker.ts rebuilds every request for tracing (`withTraceContext`: `new Request(inbound, { headers })`),
// and a rebuilt Request takes the body stream with it. The route must be handed the rebuilt request —
// live, handed the original, it read an empty body and answered 400 "body is not JSON" for a 300 MB
// video dropped on a thread. worker.ts itself is never loaded in tests
// (Cloudflare bindings), so the wiring is held by its source text, and the mechanism by the route.
describe("artifacts copy — the wiring hands the route the request that still has its body", () => {
  it("a request rebuilt for tracing carries the body; the original it was built from answers 400 not JSON", async () => {
    const up = upstream(() => new Response(null, { status: 500 }));
    const { d, puts } = deps({ fetch: up.fetch });
    const inbound = post({ url: URL_PRIVATE, size: 4, key: KEY });
    const forwarded = new Request(inbound, { headers: new Headers(inbound.headers) });
    const fromOriginal = await handleArtifactsCopy(inbound, d);
    expect(fromOriginal.status).toBe(400);
    expect(await fromOriginal.json()).toEqual({ ok: false, error: "artifacts copy: body is not JSON" });
    expect(up.calls).toEqual([]);
    const fromForwarded = await handleArtifactsCopy(forwarded, d);
    expect(fromForwarded.status).toBe(502); // parsed and past the request checks: the upstream's 500 is Slack's word
    expect(up.calls.map((c) => c.url)).toEqual([URL_PRIVATE]);
    expect(puts).toEqual([]);
  });

  it("worker.ts hands handleArtifactsCopy the traced request, never the inbound one", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./worker.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/handleArtifactsCopy\(forwarded,/);
    expect(source).not.toMatch(/handleArtifactsCopy\(inbound,/);
  });
});
