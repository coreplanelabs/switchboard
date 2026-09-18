import { describe, expect, it, vi } from "vitest";
import { fileReferences, downloadLinearFiles, applyLinearFiles, LINEAR_FILE_LIMITS } from "./files.js";

const png = "https://uploads.linear.app/org/image";
const pdf = "https://uploads.linear.app/org/document";
const text = "https://uploads.linear.app/org/code";
const refs = fileReferences(`![screen.png](${png}) [guide.pdf](<${pdf}>) [example.ts](${text})`);

describe("Linear private file ingestion", () => {
  it("stages an image above the inline limit while leaving small images inline", async () => {
    const size = LINEAR_FILE_LIMITS.imageBytes + 1;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("unused", { headers: { "content-type": "image/png", "content-length": String(size) } }),
      )
      .mockResolvedValueOnce(
        new Response("small", { headers: { "content-type": "image/png", "content-length": "5" } }),
      );
    const files = await downloadLinearFiles([refs[0]!, { url: pdf, name: "small.png" }], {
      fetch,
      token: async () => "secret",
      maxStagedBytes: size,
    });
    expect(files[0]).toMatchObject({ staged: { size, type: "image/png" } });
    expect(files[0]?.image).toBeUndefined();
    expect(files[1]).toMatchObject({ image: { data: "c21hbGw=" } });
  });

  it("keeps oversized and binary files as bounded staging references without reading their bodies", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "application/zip", "content-length": "100" },
        }),
    );
    const file = { url: text, name: "source.zip" };
    const files = await downloadLinearFiles([file, { ...file, url: pdf }], {
      fetch,
      token: async () => "secret",
      maxStagedBytes: 150,
    });
    expect(files[0]).toMatchObject({ ...file, staged: { size: 100, type: "application/zip" } });
    expect(files[1]?.skipped).toContain("budget");
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(applyLinearFiles({ text: `[source.zip](${text})`, messageId: "prompt" }, files)).toMatchObject({
      staged: [{ ...file, size: 100, type: "application/zip", messageId: "prompt" }],
    });
  });

  it("encodes binary attachments in an edge runtime without Node Buffer", async () => {
    const response = new Response(new Uint8Array([0, 1, 2, 255]), { headers: { "content-type": "image/png" } });
    vi.stubGlobal("Buffer", undefined);
    try {
      const files = await downloadLinearFiles([refs[0]!], {
        fetch: vi.fn(async () => response),
        token: async () => "secret",
      });
      expect(files[0]?.image?.data).toBe("AAEC/w==");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("bounds the total bytes across files and refuses declared oversize before reading", async () => {
    const cancel = vi.fn();
    const payload = new Uint8Array(7 * 1024 * 1024);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(payload);
            },
            cancel,
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    );
    fetch.mockResolvedValueOnce(new Response(payload, { headers: { "content-type": "text/plain" } }));
    const result = await downloadLinearFiles(
      [
        { url: text, name: "one.txt" },
        { url: pdf, name: "two.txt" },
      ],
      { fetch, token: async () => "secret" },
    );
    expect(result[0]?.document?.data.length).toBe(payload.length);
    expect(result[1]?.skipped).toContain("limit");
    expect(cancel).toHaveBeenCalledOnce();
    const getReader = vi.fn();
    const response = new Response("small", {
      headers: { "content-type": "image/png", "content-length": String(LINEAR_FILE_LIMITS.imageBytes + 1) },
    });
    response.body!.getReader = getReader;
    fetch.mockResolvedValueOnce(response);
    expect((await downloadLinearFiles([refs[0]!], { fetch, token: async () => "secret" }))[0]?.skipped).toContain(
      "limit",
    );
    expect(getReader).not.toHaveBeenCalled();
  });
  it.each(["", "en"])(
    "rejects credential names from encoded headers (%s) and never follows redirects or authenticates another host",
    async (language) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response("private", {
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `attachment; filename* = UTF-8'${language}'%2Eenv`,
            },
          }),
      );
      const result = await downloadLinearFiles(
        [
          { url: text, name: "guide.pdf" },
          { url: "https://other.example/file", name: "file.txt" },
        ],
        { fetch, token: async () => "secret" },
      );
      expect(result[0]?.skipped).toContain("credential");
      expect(result[1]?.skipped).toContain("invalid");
      expect(fetch).toHaveBeenCalledOnce();
      fetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example/file" } }),
      );
      expect((await downloadLinearFiles([refs[0]!], { fetch, token: async () => "secret" }))[0]?.skipped).toContain(
        "not available",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]?.[1]?.redirect).toBe("error");
    },
  );
  it("extracts canonical private references without accepting other origins or retaining signatures", () => {
    expect(
      fileReferences(
        `![screen.png](${png}?signature=private) ${png} https://uploads.linear.app.evil.test/x https://uploads.linear.app@evil.test/x http://uploads.linear.app/x`,
      ),
    ).toEqual([{ url: png, name: "screen.png" }]);
    expect(fileReferences("https://uploads.linear.app:8443/x")).toEqual([]);
  });
  it("downloads images, PDFs and text through bounded authenticated requests and maps them onto the right turn", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url) =>
        new Response(url === text ? "const answer = 42;" : "bytes", {
          headers: { "content-type": url === png ? "image/png" : url === pdf ? "application/pdf" : "text/plain" },
        }),
    );
    const result = await downloadLinearFiles(refs, { fetch, token: async () => "edge-secret" });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls)
      expect(init).toMatchObject({ redirect: "error", headers: { authorization: "Bearer edge-secret" } });
    expect(result[0]).toMatchObject({
      url: png,
      image: { name: "screen.png", mediaType: "image/png", data: "Ynl0ZXM=" },
    });
    expect(result[1]).toMatchObject({
      document: { name: "guide.pdf", mediaType: "application/pdf", data: "Ynl0ZXM=" },
    });
    expect(result[2]).toMatchObject({ document: { name: "example.ts", data: "const answer = 42;" } });
    const turn = applyLinearFiles({ text: `Read [source](${text})` }, result);
    expect(turn.documents).toEqual([result[2]!.document]);
    expect(turn.images).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("edge-secret");
  });
  it("never reads credential-shaped files, unsupported bodies or over-budget streams", async () => {
    const read = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = new Response(new Uint8Array([1]), {
        headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="credentials.json"' },
      });
      response.body!.getReader = read;
      return response;
    });
    const result = await downloadLinearFiles(
      [
        { url: text, name: "innocent.txt" },
        { url: png, name: ".env" },
      ],
      { fetch, token: async () => "secret" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(result.every((r) => r.skipped?.includes("credential"))).toBe(true);
    fetch.mockResolvedValueOnce(new Response("zip", { headers: { "content-type": "application/zip" } }));
    expect(
      (await downloadLinearFiles([{ url: text, name: "file.zip" }], { fetch, token: async () => "secret" }))[0]
        ?.skipped,
    ).toContain("unsupported");
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(LINEAR_FILE_LIMITS.imageBytes + 1));
          },
          cancel,
        }),
        { headers: { "content-type": "image/png" } },
      ),
    );
    expect((await downloadLinearFiles([refs[0]!], { fetch, token: async () => "secret" }))[0]?.skipped).toContain(
      "limit",
    );
    expect(cancel).toHaveBeenCalled();
  });
  it("enforces count and shared byte limits, reports permanent omissions and retries transient failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("file", { headers: { "content-type": "text/plain" } }),
    );
    const files = Array.from({ length: LINEAR_FILE_LIMITS.count + 1 }, (_, i) => ({
      url: `${text}${i}`,
      name: `file${i}.txt`,
    }));
    const result = await downloadLinearFiles(files, { fetch, token: async () => "secret" });
    expect(fetch).toHaveBeenCalledTimes(LINEAR_FILE_LIMITS.count);
    expect(result.at(-1)?.skipped).toContain("limit");
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const missing = await downloadLinearFiles([refs[0]!], { fetch, token: async () => "secret" });
    expect(applyLinearFiles({ text: `![screen](${png})` }, missing).text).toContain("not available");
    for (const status of [429, 500]) {
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      await expect(downloadLinearFiles([refs[0]!], { fetch, token: async () => "secret" })).rejects.toThrow(
        "linear_file_unavailable",
      );
    }
    fetch.mockRejectedValueOnce(new Error("secret upstream URL"));
    await expect(downloadLinearFiles([refs[0]!], { fetch, token: async () => "secret" })).rejects.toThrow(
      "linear_file_unavailable",
    );
  });
});
