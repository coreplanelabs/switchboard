// Feature: docs/reference/specs/slack-channel.md — bounded original-source media rehydration.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackNativeMedia } from "./nativeMedia.js";
import { acceptedStagedFile, fetchImages, fetchDocuments, stagedFiles, type SlackFile } from "./attachments.js";
afterEach(() => vi.unstubAllGlobals());
async function fixture(types = ["image/png"], large = false, staging = false, user = "UALICE") {
  let policy = { staging, maxBytesPerMessage: 100 * 1024 * 1024 };
  const files: SlackFile[] = types.map((type, index) => ({
    id: `F${index}`,
    name:
      type === "application/pdf"
        ? `${index}.pdf`
        : type === "text/csv"
          ? `${index}.csv`
          : type === "application/zip"
            ? `${index}.zip`
            : `${index}.png`,
    mimetype: type,
    size: large ? 3 * 1024 * 1024 : 12,
    url_private_download: `https://files.slack.com/F${index}`,
  }));
  let source = { ts: "1.1", thread_ts: "1.0", user, text: "Explain these files", files };
  const bytes = new Map(files.map((file) => [file.url_private_download!, new Uint8Array(file.size!).fill(7)]));
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(bytes.get(url) as BodyInit, {
        headers: {
          "content-type":
            files.find((file) => file.url_private_download === url)?.mimetype ?? "application/octet-stream",
        },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const replies = vi.fn(async () => ({ messages: [source] }));
  const reader = createSlackNativeMedia({ replies, policy: () => policy });
  const [images, documents] = await Promise.all([fetchImages(files, 10), fetchDocuments(files, 10)]);
  const unsupported = images.skippedFiles.filter((file) => documents.skippedFiles.includes(file));
  const staged = stagedFiles(unsupported, { ...policy, messageId: "1.1" });
  const original = {
    images: images.images.map((item, index) => ({
      ...item,
      ...(staging
        ? {
            staged: acceptedStagedFile(
              images.acceptedFiles[index]!,
              "1.1",
              files.indexOf(images.acceptedFiles[index]!.file),
            ),
          }
        : {}),
    })),
    documents: documents.documents.map((item, index) => ({
      ...item,
      ...(staging
        ? {
            staged: acceptedStagedFile(
              documents.acceptedFiles[index]!,
              "1.1",
              files.indexOf(documents.acceptedFiles[index]!.file),
            ),
          }
        : {}),
    })),
    staged: staged.staged,
  };
  const manifest = await reader.capture(
    {
      channelId: "slack:D1",
      userId: `slack:${user}`,
      threadKey: "slack:D1:1.0",
      messageId: "1.1",
      rawText: "Explain these files",
    },
    files,
    { images, documents },
    original,
  );
  if (!manifest) throw new Error("No initial source manifest");
  return {
    reader,
    manifest,
    original,
    files,
    bytes,
    fetcher,
    replies,
    source,
    setSource: (next: typeof source) => {
      source = next;
    },
    setPolicy: (next: typeof policy) => {
      policy = next;
    },
    skipped: staged.skipped,
  };
}
describe("Slack original media", () => {
  it("preserves a proved W-prefixed Slack user's accepted DM image", async () => {
    const f = await fixture(["image/png"], false, false, "WALICE");
    expect(await f.reader.materialize(f.manifest)).toEqual(f.original);
  });
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "restores an accepted %s larger than 2 MiB through its exact source and representation",
    async (type) => {
      const f = await fixture([type], true);
      expect(JSON.stringify(f.manifest).length).toBeLessThan(4096);
      expect(await f.reader.materialize(f.manifest)).toEqual(f.original);
      expect(f.replies.mock.calls.length).toBe(3);
    },
  );
  it.each(["application/pdf", "text/csv"])(
    "restores the original accepted %s representation without storing its bytes in the manifest",
    async (type) => {
      const f = await fixture([type], true);
      expect(await f.reader.materialize(f.manifest)).toEqual(f.original);
      expect(f.manifest.files[0]).toMatchObject({
        kind: "document",
        index: 0,
        slot: 0,
        representationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    },
  );
  it("retains mixed media order and zero-based staged positions while refusing staging policy loss", async () => {
    const f = await fixture(["image/png", "text/csv", "application/zip"], false, true);
    expect(await f.reader.materialize(f.manifest)).toEqual(f.original);
    expect(
      f.manifest.files.map((file) => ({
        kind: file.kind,
        slot: file.slot,
        index: file.index,
        workspaceIndex: file.staged?.workspaceIndex,
        digest: !!file.representationDigest,
      })),
    ).toEqual([
      { kind: "image", slot: 0, index: 0, workspaceIndex: 0, digest: true },
      { kind: "document", slot: 1, index: 0, workspaceIndex: 1, digest: true },
      { kind: "staged", slot: 2, index: 0, workspaceIndex: undefined, digest: false },
    ]);
    f.setPolicy({ staging: false, maxBytesPerMessage: 100 });
    expect(await f.reader.materialize(f.manifest)).toBeUndefined();
  });
  it("applies the current combined staging budget to inline references and staged-only files", async () => {
    const f = await fixture(["image/png", "text/csv", "application/zip"], false, true);
    expect(await f.reader.materialize(f.manifest)).toEqual(f.original);
    f.setPolicy({ staging: true, maxBytesPerMessage: 24 });
    expect(await f.reader.materialize(f.manifest)).toBeUndefined();
  });
  it.each([
    "text",
    "edit",
    "author",
    "message",
    "root",
    "name",
    "type",
    "size",
    "order",
    "missing",
    "duplicate",
    "new file",
    "foreign URL",
    "bytes",
  ])("refuses changed %s instead of substituting private media", async (change) => {
    const f = await fixture(["image/png", "text/csv"]);
    const changed = structuredClone(f.source);
    if (change === "text") changed.text = "Edited request";
    if (change === "edit") Object.assign(changed, { edited: { ts: "2.0" } });
    if (change === "author") changed.user = "UBOB";
    if (change === "message") changed.ts = "2.0";
    if (change === "root") changed.thread_ts = "2.0";
    if (change === "name") changed.files[0]!.name = "secret.env";
    if (change === "type") changed.files[0]!.mimetype = "text/plain";
    if (change === "size") changed.files[0]!.size = 13;
    if (change === "order") changed.files.reverse();
    if (change === "missing") changed.files.shift();
    if (change === "duplicate") changed.files[1]!.id = changed.files[0]!.id;
    if (change === "new file") changed.files.push({ ...changed.files[0], id: "FNEW" });
    if (change === "foreign URL") changed.files[0]!.url_private_download = "https://example.test/private";
    if (change === "bytes") f.bytes.set(f.files[0]!.url_private_download!, new Uint8Array(12).fill(8));
    f.setSource(changed);
    expect(await f.reader.materialize(f.manifest)).toBeUndefined();
  });
  it("rechecks exact source text after downloads before returning media", async () => {
    const f = await fixture();
    f.fetcher.mockImplementationOnce(async () => {
      f.setSource({ ...f.source, text: "Changed during download" });
      return new Response(new Uint8Array(12).fill(7), { headers: { "content-type": "image/png" } });
    });
    expect(await f.reader.materialize(f.manifest)).toBeUndefined();
  });
});
