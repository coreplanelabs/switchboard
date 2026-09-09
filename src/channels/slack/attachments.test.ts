import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyDocument, fetchDocuments, fetchImages } from "./attachments.js";

// Feature: docs/reference/specs/slack-channel.md — attachment ingestion within budgets.

describe("fetchImages (attachment ingestion within budgets)", () => {
  const png = (name: string, size = 100) => ({
    id: name,
    name,
    mimetype: "image/png",
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });

  function stubFetch(bytes = 8, contentType = "image/png", status = 200) {
    const fetchMock = vi.fn(async () => {
      return new Response(new Uint8Array(bytes).fill(7), {
        status,
        headers: { "content-type": contentType },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("downloads accepted images and returns base64 payloads", async () => {
    stubFetch();
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(skipped).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe("image/png");
    expect(Buffer.from(images[0].data, "base64")).toHaveLength(8);
  });

  it("skips non-image types, oversize files, and over-count files without fetching them", async () => {
    const fetchMock = stubFetch();
    const files = [
      { id: "doc", name: "notes.pdf", mimetype: "application/pdf", size: 10, url_private_download: "https://x/d" },
      { ...png("huge.png"), size: 6 * 1024 * 1024 },
      png("ok1.png"),
      png("ok2.png"),
    ];
    const { images, skipped } = await fetchImages(files, 1);
    expect(images).toHaveLength(1);
    expect(skipped).toEqual([
      "notes.pdf (application/pdf)",
      "huge.png (image/png)",
      "ok2.png (image/png)", // over the per-message count budget
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats Slack's HTML login page (HTTP 200) as a failed download", async () => {
    stubFetch(8, "text/html; charset=utf-8");
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(images).toEqual([]);
    expect(skipped).toEqual(["a.png (image/png)"]);
  });

  it("skips downloads that would blow the total byte budget and reports bytes spent", async () => {
    stubFetch(10);
    const { images, skipped, bytes } = await fetchImages([png("a.png"), png("b.png")], 10, 15);
    expect(images).toHaveLength(1); // second download would exceed 15 bytes total
    expect(skipped).toEqual(["b.png (image/png)"]);
    expect(bytes).toBe(10);
  });

  it("survives a failed fetch and names the skipped file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(images).toEqual([]);
    expect(skipped).toEqual(["a.png (image/png)"]);
  });

  it("survives a thrown non-Error too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "string failure";
      }),
    );
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(images).toEqual([]);
    expect(skipped).toEqual(["a.png (image/png)"]);
  });
});

describe("fetchDocuments (PDF + text/code ingestion within budgets)", () => {
  const pdf = (name: string, size = 100) => ({
    id: name,
    name,
    mimetype: "application/pdf",
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });
  const textFile = (name: string, mimetype: string, size = 100) => ({
    id: name,
    name,
    mimetype,
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });

  /** Body defaults to bytes for PDFs; pass a string to simulate a text download. */
  function stubFetch(body: BodyInit = new Uint8Array(8).fill(7), contentType = "application/pdf", status = 200) {
    const fetchMock = vi.fn(async () => {
      return new Response(body, { status, headers: { "content-type": contentType } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("downloads a PDF and returns a base64 payload with the application/pdf media type", async () => {
    stubFetch(new Uint8Array(8).fill(7), "application/pdf");
    const { documents, skipped } = await fetchDocuments([pdf("report.pdf")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].mediaType).toBe("application/pdf");
    expect(documents[0].name).toBe("report.pdf");
    expect(Buffer.from(documents[0].data, "base64")).toHaveLength(8);
  });

  it("decodes a text/code/csv file to UTF-8 text (not base64)", async () => {
    stubFetch("hello,world\n1,2\n", "text/csv");
    const { documents, skipped } = await fetchDocuments([textFile("data.csv", "text/csv")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].mediaType).toBe("text/csv");
    expect(documents[0].data).toBe("hello,world\n1,2\n");
  });

  it("accepts code files by extension when the mimetype is generic", async () => {
    stubFetch("export const x = 1;\n", "application/octet-stream");
    const { documents, skipped } = await fetchDocuments([textFile("main.ts", "application/octet-stream")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].data).toBe("export const x = 1;\n");
  });

  it("skips images and unsupported types without fetching them", async () => {
    const fetchMock = stubFetch();
    const files = [
      { id: "img", name: "shot.png", mimetype: "image/png", size: 10, url_private_download: "https://x/i" },
      {
        id: "bin",
        name: "app.bin",
        mimetype: "application/octet-stream",
        size: 10,
        url_private_download: "https://x/b",
      },
      pdf("ok.pdf"),
    ];
    const { documents, skipped } = await fetchDocuments(files, 10);
    expect(documents).toHaveLength(1);
    expect(documents[0].name).toBe("ok.pdf");
    expect(skipped).toEqual(["shot.png (image/png)", "app.bin (application/octet-stream)"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips oversize files and over-count files without fetching them", async () => {
    const fetchMock = stubFetch();
    const files = [{ ...pdf("huge.pdf"), size: 11 * 1024 * 1024 }, pdf("one.pdf"), pdf("two.pdf")];
    const { documents, skipped } = await fetchDocuments(files, 1);
    expect(documents).toHaveLength(1);
    expect(skipped).toEqual([
      "huge.pdf (application/pdf)",
      "two.pdf (application/pdf)", // over the per-message count budget
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats Slack's HTML login page as a failed PDF download", async () => {
    stubFetch("<html>login</html>", "text/html; charset=utf-8");
    const { documents, skipped } = await fetchDocuments([pdf("report.pdf")], 10);
    expect(documents).toEqual([]);
    expect(skipped).toEqual(["report.pdf (application/pdf)"]);
  });

  it("accepts a real .html text file (its own text/html type is not the login page)", async () => {
    stubFetch("<h1>Doc</h1>", "text/html; charset=utf-8");
    const { documents, skipped } = await fetchDocuments([textFile("page.html", "text/html")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].data).toBe("<h1>Doc</h1>");
  });

  it("skips downloads that would blow the total byte budget and reports bytes spent", async () => {
    stubFetch(new Uint8Array(10).fill(7), "application/pdf");
    const { documents, skipped, bytes } = await fetchDocuments([pdf("a.pdf"), pdf("b.pdf")], 10, 15);
    expect(documents).toHaveLength(1); // second download would exceed 15 bytes total
    expect(skipped).toEqual(["b.pdf (application/pdf)"]);
    expect(bytes).toBe(10);
  });

  it("survives a failed fetch and names the skipped file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { documents, skipped } = await fetchDocuments([pdf("a.pdf")], 10);
    expect(documents).toEqual([]);
    expect(skipped).toEqual(["a.pdf (application/pdf)"]);
  });
});

// Feature: docs/reference/specs/slack-channel.md — secret-file denylist. A file whose name
// looks like credentials/keys/private config is never inlined into the model
// prompt, even when its mimetype or extension would otherwise mark it text.
describe("classifyDocument (secret-file denylist overrides text classification)", () => {
  it("denies every secret-shaped filename even with a text-ish mimetype", () => {
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      "config.env",
      "prod.env",
      "credentials.json",
      "gcp-service-account.json",
      "app-key.json",
      "id_rsa",
      "id_rsa.pub",
      "foo.pem",
      "server.key",
      "cert.p12",
      "cert.pfx",
      ".npmrc",
      ".netrc",
      "db.cfg",
      "app.conf",
      "settings.ini",
    ]) {
      expect(classifyDocument("text/plain", name), name).toBeNull();
    }
  });

  it("denies credentials.json even when Slack reports application/json", () => {
    expect(classifyDocument("application/json", "credentials.json")).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(classifyDocument("text/plain", "CONFIG.ENV")).toBeNull();
    expect(classifyDocument("text/plain", "ID_RSA")).toBeNull();
    expect(classifyDocument("application/json", "Credentials.JSON")).toBeNull();
  });

  it("no longer treats plain .json / config files as inlinable text (conservative gating)", () => {
    expect(classifyDocument("application/json", "data.json")).toBeNull();
    expect(classifyDocument("application/octet-stream", "data.json")).toBeNull();
    expect(classifyDocument("application/octet-stream", "settings.ini")).toBeNull();
  });

  it("keeps genuinely-safe pdf / text / code / log files working", () => {
    expect(classifyDocument("application/pdf", "report.pdf")).toBe("pdf");
    expect(classifyDocument("text/plain", "notes.txt")).toBe("text");
    expect(classifyDocument("text/csv", "data.csv")).toBe("text");
    expect(classifyDocument("application/octet-stream", "main.ts")).toBe("text");
    expect(classifyDocument("text/plain", "app.log")).toBe("text");
  });
});

describe("fetchDocuments (secret files skipped-with-note, never decoded)", () => {
  const secretFile = (name: string, mimetype: string, size = 100) => ({
    id: name,
    name,
    mimetype,
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });
  function stubFetch(body: BodyInit = "SECRET=hunter2\n", contentType = "text/plain") {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": contentType } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  afterEach(() => vi.unstubAllGlobals());

  // The reviewer's PoC files, carrying the text-ish mimetypes Slack actually
  // reports for them — so this proves the denylist OVERRIDES text classification.
  const poc = [
    secretFile("config.env", "text/plain"),
    secretFile("credentials.json", "application/json"),
    secretFile("prod.env", "text/plain"),
    secretFile("db.cfg", "text/plain"),
    secretFile("app.conf", "text/plain"),
    secretFile(".env.local", "text/plain"),
    secretFile("id_rsa", "text/plain"),
    secretFile("foo.pem", "text/plain"),
  ];

  it("skips every PoC secret file, returns none as a document, and never fetches them", async () => {
    const fetchMock = stubFetch();
    const { documents, skipped } = await fetchDocuments(poc, 10);
    expect(documents).toEqual([]);
    expect(skipped).toEqual([
      "config.env (text/plain)",
      "credentials.json (application/json)",
      "prod.env (text/plain)",
      "db.cfg (text/plain)",
      "app.conf (text/plain)",
      ".env.local (text/plain)",
      "id_rsa (text/plain)",
      "foo.pem (text/plain)",
    ]);
    // Never decoded into the prompt: a denied file is skipped before any download.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still ingests genuinely-safe files alongside a secret one", async () => {
    const fetchMock = stubFetch("hello\n", "text/plain");
    const files = [
      secretFile("config.env", "text/plain"),
      { id: "n", name: "notes.txt", mimetype: "text/plain", size: 10, url_private_download: "https://x/n" },
      { id: "d", name: "data.csv", mimetype: "text/csv", size: 10, url_private_download: "https://x/d" },
      { id: "m", name: "main.ts", mimetype: "application/octet-stream", size: 10, url_private_download: "https://x/m" },
    ];
    const { documents, skipped } = await fetchDocuments(files, 10);
    expect(documents.map((d) => d.name)).toEqual(["notes.txt", "data.csv", "main.ts"]);
    expect(skipped).toEqual(["config.env (text/plain)"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
