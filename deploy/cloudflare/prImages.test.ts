import { describe, expect, it, vi } from "vitest";
import { handlePrImage, publishPrImage, type PrImageBucket } from "./prImages.ts";
import { MAX_PR_IMAGE_BYTES, PR_IMAGE_PUBLISH_PATH } from "../../src/artifacts/prImages.ts";
import { readFileSync } from "node:fs";
import { DAY_MS } from "../../src/core/budgets.ts";
import { ARTIFACT_DEFAULTS } from "../../src/artifacts/config.ts";

const source = "runs/r1/out/1-shot.png";
const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS6kAAAAASUVORK5CYII=", "base64"),
);
function harness() {
  const time = { now: Date.UTC(2026, 8, 14) };
  const clock = () => time.now;
  const objects = new Map<
    string,
    {
      bytes: Uint8Array;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      size?: number;
    }
  >();
  objects.set(source, { bytes: png, httpMetadata: { contentType: "image/png" } });
  const bucket: PrImageBucket = {
    get: vi.fn(async (key) => {
      const o = objects.get(key);
      return o
        ? {
            ...o,
            size: o.size ?? o.bytes.length,
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(o.bytes);
                c.close();
              },
            }),
          }
        : null;
    }),
    put: vi.fn(async (key, bytes, options) => {
      objects.set(key, { bytes: new Uint8Array(bytes), ...options });
    }),
  };
  const publish = (
    key = source,
    auth = "Bearer internal",
    method = "POST",
    retentionDays: unknown = ARTIFACT_DEFAULTS.retentionDays,
  ) =>
    publishPrImage(
      new Request(`https://bot.example${PR_IMAGE_PUBLISH_PATH}`, {
        method,
        headers: { authorization: auth },
        ...(method === "POST" ? { body: JSON.stringify({ key, retentionDays }) } : {}),
      }),
      { bucket, token: "internal", clock },
    );
  const read = (path: string, method = "GET") =>
    handlePrImage(new Request(`https://bot.example${path}`, { method }), bucket, clock);
  return { objects, bucket, publish, read, time };
}

describe("PR image routes", () => {
  it("publishes a separate marked PNG and serves it anonymously without redirecting to R2", async () => {
    const h = harness();
    const res = await h.publish();
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path).toMatch(/^\/pr-images\/[\da-f-]+\.png$/);
    const key = path.replace("/pr-images/", "published-pr/");
    expect(h.objects.get(key)).toMatchObject({
      bytes: png,
      customMetadata: {
        publishedForPr: "true",
        sourceKey: source,
        expiresAt: String(h.time.now + ARTIFACT_DEFAULTS.retentionDays * DAY_MS),
      },
    });
    h.objects.delete(source);
    const image = await h.read(path);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toBe('inline; filename="screenshot.png"');
    expect(image.headers.get("cache-control")).toBe("no-store");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    const head = await h.read(path, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    h.objects.delete(key);
    expect((await h.read(path)).status).toBe(404);
  });

  it("publishes an R2 host object whose fields are not enumerable", async () => {
    const h = harness();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png);
        controller.close();
      },
    });
    const object = Object.create(null) as Awaited<ReturnType<PrImageBucket["get"]>> & object;
    Object.defineProperties(object, {
      size: { value: png.length },
      body: { value: body },
      httpMetadata: { value: { contentType: "image/png" } },
    });
    vi.mocked(h.bucket.get).mockResolvedValueOnce(object);

    const response = await h.publish();
    expect(response.status).toBe(200);
    const { path } = (await response.json()) as { path: string };
    expect(h.objects.get(path.replace("/pr-images/", "published-pr/"))?.bytes).toEqual(png);
  });

  it("GET and HEAD expire at the publication deadline even before lifecycle deletion", async () => {
    const h = harness();
    const retentionDays = 2;
    const res = await h.publish(source, "Bearer internal", "POST", retentionDays);
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    const key = path.replace("/pr-images/", "published-pr/");
    const expiresAt = h.time.now + retentionDays * DAY_MS;
    expect(h.objects.get(key)?.customMetadata?.expiresAt).toBe(String(expiresAt));
    h.time.now = expiresAt - 1;
    for (const method of ["GET", "HEAD"]) expect((await h.read(path, method)).status).toBe(200);
    for (const now of [expiresAt, expiresAt + DAY_MS]) {
      h.time.now = now;
      for (const method of ["GET", "HEAD"]) {
        const expired = await h.read(path, method);
        expect(expired.status).toBe(404);
        expect(expired.headers.get("cache-control")).toBe("no-store");
        expect(expired.headers.get("content-type")).not.toBe("image/png");
      }
      expect(h.objects.has(key)).toBe(true);
    }
    expect(h.objects.get(source)?.bytes).toEqual(png);
  });

  it("public reads fail closed for missing or invalid expiry metadata", async () => {
    const h = harness();
    const { path } = (await (await h.publish()).json()) as { path: string };
    const key = path.replace("/pr-images/", "published-pr/");
    const object = h.objects.get(key)!;
    for (const expiresAt of [
      undefined,
      "",
      "not-a-date",
      "NaN",
      "Infinity",
      "-1",
      "0",
      "9007199254740992",
      `${h.time.now + 0.5}`,
    ]) {
      object.customMetadata = { publishedForPr: "true", ...(expiresAt === undefined ? {} : { expiresAt }) };
      for (const method of ["GET", "HEAD"]) expect((await h.read(path, method)).status).toBe(404);
    }
  });

  it("refuses missing or invalid retention before reading storage", async () => {
    const h = harness();
    for (const retentionDays of [null, "30", 0, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect((await h.publish(source, "Bearer internal", "POST", retentionDays)).status).toBe(400);
    }
    const missing = new Request(`https://bot.example${PR_IMAGE_PUBLISH_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer internal" },
      body: JSON.stringify({ key: source }),
    });
    expect((await publishPrImage(missing, { bucket: h.bucket, token: "internal" })).status).toBe(400);
    expect(h.bucket.get).not.toHaveBeenCalled();
    expect(h.bucket.put).not.toHaveBeenCalled();
  });

  it("refuses wrong or missing publication credentials before reading any object", async () => {
    const h = harness();
    for (const auth of ["", "Bearer wrong"]) expect((await h.publish(source, auth)).status).toBe(401);
    expect((await publishPrImage(new Request("https://bot.example"), { bucket: h.bucket })).status).toBe(401);
    expect(h.bucket.get).not.toHaveBeenCalled();
    expect(h.bucket.put).not.toHaveBeenCalled();
    expect((await h.publish(source, "Bearer internal", "GET")).status).toBe(405);
  });

  it("refuses inbound keys, malformed requests, absent storage and non-PNG or oversized content", async () => {
    const h = harness();
    for (const key of ["threads/t/in/1/1-shot.png", "runs/../out/1-shot.png", "published-pr/x.png"])
      expect((await h.publish(key)).status).toBe(400);
    expect(h.bucket.get).not.toHaveBeenCalled();
    const request = () =>
      new Request("https://bot.example", {
        method: "POST",
        headers: { authorization: "Bearer internal" },
        body: "not json",
      });
    expect((await publishPrImage(request(), { bucket: h.bucket, token: "internal" })).status).toBe(400);
    expect((await publishPrImage(request(), { token: "internal" })).status).toBe(503);
    expect((await h.publish("runs/r1/out/2-missing.png")).status).toBe(404);
    for (const object of [
      { bytes: png, httpMetadata: { contentType: "image/svg+xml" } },
      { bytes: new TextEncoder().encode("<html>private</html>"), httpMetadata: { contentType: "image/png" } },
      { bytes: png, size: MAX_PR_IMAGE_BYTES + 1, httpMetadata: { contentType: "image/png" } },
      { bytes: png, size: 100, httpMetadata: { contentType: "image/png" } },
    ]) {
      h.objects.set(source, object);
      expect((await h.publish()).status).toBe(400);
    }
    expect(h.bucket.put).not.toHaveBeenCalled();
  });

  it("does not expose a stored image read failure in the publication response", async () => {
    const h = harness();
    vi.mocked(h.bucket.get).mockResolvedValueOnce({
      size: png.length,
      httpMetadata: { contentType: "image/png" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private storage stack and path"));
        },
      }),
    });

    const response = await h.publish();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid PR image" });
    expect(h.bucket.put).not.toHaveBeenCalled();
  });

  it("public reads refuse private keys, unmarked copies, queries and unsupported methods", async () => {
    const h = harness();
    for (const path of ["/pr-images/", `/pr-images/${source}`, "/pr-images/../private", "/pr-images/nope.png"])
      expect((await h.read(path)).status).toBe(404);
    expect(h.bucket.get).not.toHaveBeenCalled();
    const path = "/pr-images/12345678-1234-4123-8123-123456789abc.png";
    const key = path.replace("/pr-images/", "published-pr/");
    expect((await h.read(path)).status).toBe(404);
    h.objects.set(key, {
      bytes: png,
      httpMetadata: { contentType: "image/png" },
      customMetadata: { expiresAt: String(h.time.now + DAY_MS) },
    });
    expect((await h.read(path)).status).toBe(404);
    h.objects.set(key, {
      bytes: png,
      httpMetadata: { contentType: "text/html" },
      customMetadata: { publishedForPr: "true", expiresAt: String(h.time.now + DAY_MS) },
    });
    expect((await h.read(path)).status).toBe(404);
    expect((await h.read(`${path}?key=${source}`)).status).toBe(404);
    expect((await h.read(path, "POST")).status).toBe(405);
  });

  it("the Worker routes public copies independently of the authenticated run reader", () => {
    const worker = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
    expect(worker).toContain('pathname.startsWith("/pr-images/")');
    expect(worker).toContain("handlePrImage(request, env.ARTIFACTS)");
    expect(worker).toContain("publishPrImage(request, { bucket: env.ARTIFACTS, token: env.ARTIFACTS_COPY_TOKEN })");
  });
});
