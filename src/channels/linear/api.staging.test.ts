import { describe, expect, it, vi } from "vitest";
import { DirectLinearApi } from "./api.js";
import { inboundKey } from "../../artifacts/keys.js";
import type { LinearFileCopy } from "./files.js";

const url = "https://uploads.linear.app/org/archive";
const file = { url, name: "data.zip", size: 100, type: "application/zip", messageId: "org:AgentSessionEvent:event" };
const key = inboundKey("linear:org:s", file.messageId, 1, file.name);

function fixture() {
  const stored: Uint8Array[] = [];
  const put = vi.fn<LinearFileCopy["put"]>(async (_key, stream) => {
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    stored.push(bytes);
  });
  const lengthPipe: LinearFileCopy["lengthPipe"] = (size) => {
    let count = 0;
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        count += bytes.length;
        if (count > size) throw new Error("long stream");
        controller.enqueue(bytes);
      },
      flush() {
        if (count !== size) throw new Error("short stream");
      },
    });
  };
  const download = vi.fn(
    async () =>
      new Response(new Uint8Array(100), {
        headers: { "content-type": "application/zip", "content-length": "100" },
      }),
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (String(input) === url) return download();
    return Response.json({
      data: {
        organization: { id: "org" },
        agentSession: {
          id: "s",
          appUser: { id: "bot" },
          issue: {
            description: `[data.zip](${url})`,
            comments: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });
  });
  const api = new DirectLinearApi({
    organizationId: "org",
    appUserId: "bot",
    token: async () => "oauth-secret",
    fetch,
    copy: { put, lengthPipe },
  });
  const access = vi.spyOn(api, "canRead").mockResolvedValue(true);
  vi.spyOn(api, "activities").mockResolvedValue([]);
  return { api, access, fetch, download, put, stored };
}

describe("Linear workspace file copy", () => {
  it("aborts an in-flight stream on cancellation and leaves no completed object", async () => {
    const h = fixture();
    const stop = new AbortController();
    const cancel = vi.fn();
    h.download.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(50));
          },
          cancel,
        }),
        { headers: { "content-type": "application/zip", "content-length": "100" } },
      ),
    );
    const copying = h.api.copyAttachment("s", "linear:org:alice", file, key, stop.signal);
    const rejected = expect(copying).rejects.toThrow("linear_file_copy_failed");
    await vi.waitFor(() => expect(h.put).toHaveBeenCalledOnce());
    stop.abort();
    await rejected;
    expect(h.stored).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the upstream when storage refuses the stream without echoing the storage error", async () => {
    const h = fixture();
    const cancel = vi.fn();
    h.download.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(100));
          },
          cancel,
        }),
        { headers: { "content-type": "application/zip", "content-length": "100" } },
      ),
    );
    h.put.mockRejectedValueOnce(new Error("internal credential-shaped detail"));
    await expect(h.api.copyAttachment("s", "linear:org:alice", file, key)).rejects.toThrow("linear_file_copy_failed");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it("streams only a current session file into that session's inbound key and rechecks access at copy time", async () => {
    const h = fixture();
    expect(await h.api.files("s", "linear:org:alice", [url], false, 1000)).toMatchObject([
      { staged: { size: 100, type: "application/zip" } },
    ]);
    expect(await h.api.copyAttachment("s", "linear:org:alice", file, key)).toEqual({ key, size: 100 });
    expect(h.put).toHaveBeenCalledWith(key, expect.any(ReadableStream), "application/zip");
    expect(h.stored[0]).toHaveLength(100);
    expect(h.access).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls.find(([input]) => String(input) === url)?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer oauth-secret" },
    });
    h.access.mockResolvedValue(false);
    await expect(h.api.copyAttachment("s", "linear:org:alice", file, key)).rejects.toThrow("linear_file_denied");
    expect(h.put).toHaveBeenCalledTimes(1);
  });

  it("refuses another session's key, a file absent from context, and credential-shaped names", async () => {
    const h = fixture();
    await expect(
      h.api.copyAttachment("s", "linear:org:alice", file, key.replace("linear-org-s/", "linear-org-other/")),
    ).rejects.toThrow("linear_invalid_files");
    expect(h.fetch).not.toHaveBeenCalled();
    await expect(
      h.api.copyAttachment("s", "linear:org:alice", { ...file, url: url + "-private" }, key),
    ).rejects.toThrow("linear_file_denied");
    const secret = { ...file, name: ".env" };
    await expect(
      h.api.copyAttachment("s", "linear:org:alice", secret, inboundKey("linear:org:s", file.messageId, 1, secret.name)),
    ).rejects.toThrow("linear_file_denied");
    expect(h.download).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
  });

  it.each(["size", "name", "short stream"])(
    "does not confirm an attachment changed during download: %s",
    async (change) => {
      const h = fixture();
      h.download.mockImplementation(
        async () =>
          new Response(new Uint8Array(change === "short stream" ? 99 : 100), {
            headers: {
              "content-type": "application/zip",
              "content-length": change === "size" ? "101" : "100",
              ...(change === "name" ? { "content-disposition": "attachment; filename=credentials.env" } : {}),
            },
          }),
      );
      await expect(h.api.copyAttachment("s", "linear:org:alice", file, key)).rejects.toThrow();
      expect(h.stored).toEqual([]);
    },
  );
});
