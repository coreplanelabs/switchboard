import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { basicAuthorization, containersEditProblem, MEDIA_TYPES, MIN_PART_BYTES } from "./registryTransfer.js";
import {
  mintRegistryCredential,
  REGISTRY_ENDPOINTS,
  transferImage,
  type RegistryEndpoints,
  type TransferIO,
} from "./registryTransferHost.js";
import { TEST_PROFILE } from "./testing/profile.js";

// Feature: docs/reference/specs/release-and-deploy.md item 26 — the HTTP half of the
// registry-to-registry copy, against an in-process registry that implements the
// few endpoints the copy touches: the credentials mint, the anonymous source
// token, manifests and blobs by digest, the chunked upload with the registry's
// ≥ 5 MiB rule for every part but the last (416 otherwise), and a cross-repository
// mount that is accepted and ignored. Nothing here reaches the network.

const MiB = 1024 * 1024;
const ACCOUNT = TEST_PROFILE.account;
const REPO = "example/switchboard-resident";
const SOURCE = `ghcr.io/${REPO}:1.2.3`;
const COPY = { kind: "resident" as const, source: SOURCE, name: "switchboard-resident", version: "1.2.3" };
const TARGET_NAME = `${ACCOUNT}/switchboard-resident`;
const API_TOKEN = "cf-api-token";
const CREDENTIAL = { authorization: basicAuthorization("v1", "jwt") };

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

interface Upload {
  bytes: Buffer[];
  received: number;
  /** The size of the previous part — the registry refuses a new part when this was under the minimum. */
  lastPart?: number;
}

/** A source image: an index (or a bare manifest) over one linux/amd64 manifest with a config and layers. */
interface SourceImage {
  byTag: Record<string, { bytes: Buffer; type: string }>;
  byDigest: Record<string, { bytes: Buffer; type: string }>;
  blobs: Record<string, Buffer>;
}

function sourceImage(
  layers: Buffer[],
  shape: "index" | "manifest" = "index",
): SourceImage & { manifestDigest: string } {
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers" } }));
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.ociManifest,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(config), size: config.length },
      layers: layers.map((l) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: sha256(l),
        size: l.length,
      })),
    }),
  );
  const other = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA_TYPES.ociManifest, arm: true }));
  const attestation = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA_TYPES.ociManifest, att: true }));
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.ociIndex,
      manifests: [
        {
          mediaType: MEDIA_TYPES.ociManifest,
          digest: sha256(other),
          size: other.length,
          platform: { os: "linux", architecture: "arm64" },
        },
        {
          mediaType: MEDIA_TYPES.ociManifest,
          digest: sha256(manifest),
          size: manifest.length,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: MEDIA_TYPES.ociManifest,
          digest: sha256(attestation),
          size: attestation.length,
          platform: { os: "unknown", architecture: "unknown" },
        },
      ],
    }),
  );
  const docs = {
    [sha256(manifest)]: { bytes: manifest, type: MEDIA_TYPES.ociManifest },
    [sha256(other)]: { bytes: other, type: MEDIA_TYPES.ociManifest },
    [sha256(attestation)]: { bytes: attestation, type: MEDIA_TYPES.ociManifest },
    [sha256(index)]: { bytes: index, type: MEDIA_TYPES.ociIndex },
  };
  return {
    byTag: { "1.2.3": shape === "index" ? docs[sha256(index)] : docs[sha256(manifest)] },
    byDigest: docs,
    blobs: Object.fromEntries([config, ...layers].map((b) => [sha256(b), b])),
    manifestDigest: sha256(manifest),
  };
}

/** The fake: one server, three prefixes — the Cloudflare API, the source registry, the target registry. */
class FakeRegistries {
  server!: Server;
  base = "";
  source: SourceImage & { manifestDigest: string } = { byTag: {}, byDigest: {}, blobs: {}, manifestDigest: "" };
  /** Blobs the target already holds, by repository. */
  targetBlobs = new Map<string, Set<string>>();
  targetManifests = new Map<string, { bytes: Buffer; type: string }>();
  uploads = new Map<string, Upload>();
  requests: string[] = [];
  credentialRequests: { authorization: string | undefined; body: unknown }[] = [];
  mounts: string[] = [];
  /** Knobs the tests turn. */
  credentialStatus = 200;
  minPartBytes = MIN_PART_BYTES;
  failPatchOnce: number | undefined;
  corruptBlob: string | undefined;
  lieAboutManifestDigest = false;
  private patches = 0;
  private uploadIds = 0;

  reset() {
    this.source = { byTag: {}, byDigest: {}, blobs: {}, manifestDigest: "" };
    this.targetBlobs = new Map();
    this.targetManifests = new Map();
    this.uploads = new Map();
    this.requests = [];
    this.credentialRequests = [];
    this.mounts = [];
    this.credentialStatus = 200;
    this.minPartBytes = MIN_PART_BYTES;
    this.failPatchOnce = undefined;
    this.corruptBlob = undefined;
    this.lieAboutManifestDigest = false;
    this.patches = 0;
  }

  endpoints(): RegistryEndpoints {
    return { api: `${this.base}/api`, target: `${this.base}/target`, source: () => `${this.base}/source` };
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const body = await readBody(req);
    if (url.pathname.startsWith("/api/")) return this.api(req, res, url, body);
    if (url.pathname.startsWith("/source/")) return this.sourceRegistry(req, res, url);
    if (url.pathname.startsWith("/target/")) return this.targetRegistry(req, res, url, body);
    json(res, 404, { errors: [{ code: "NOT_FOUND" }] });
  }

  private api(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer) {
    const expected = `/api/client/v4/accounts/${ACCOUNT}/containers/registries/registry.cloudflare.com/credentials`;
    if (req.method !== "POST" || url.pathname !== expected) return json(res, 404, { success: false });
    this.credentialRequests.push({ authorization: req.headers.authorization, body: JSON.parse(body.toString()) });
    if (this.credentialStatus !== 200)
      return json(res, this.credentialStatus, {
        success: false,
        errors: [{ code: 10000, message: "Unauthorized to access requested resource" }],
      });
    json(res, 200, { success: true, result: { username: "v1", password: "jwt" } });
  }

  private sourceRegistry(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (url.pathname === "/source/token") return json(res, 200, { token: "src-token" });
    if (req.headers.authorization !== "Bearer src-token") return json(res, 401, { errors: [{ code: "UNAUTHORIZED" }] });
    const m = /^\/source\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname);
    if (!m || m[1] !== REPO) return json(res, 404, { errors: [{ code: "NAME_UNKNOWN" }] });
    if (m[2] === "manifests") {
      const doc = this.source.byTag[m[3]] ?? this.source.byDigest[m[3]];
      if (!doc) return json(res, 404, { errors: [{ code: "MANIFEST_UNKNOWN" }] });
      res.writeHead(200, { "content-type": doc.type, "docker-content-digest": sha256(doc.bytes) });
      return res.end(doc.bytes);
    }
    const blob = this.source.blobs[m[3]];
    if (!blob) return json(res, 404, { errors: [{ code: "BLOB_UNKNOWN" }] });
    const bytes = m[3] === this.corruptBlob ? Buffer.concat([blob.subarray(1), Buffer.from("!")]) : blob;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
    // Chunked on purpose: the client must not assume one read is one part.
    for (let i = 0; i < bytes.length; i += 64 * 1024) res.write(bytes.subarray(i, i + 64 * 1024));
    res.end();
  }

  private targetRegistry(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer) {
    if (req.headers.authorization !== CREDENTIAL.authorization)
      return json(res, 401, { errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] });
    const blobs = /^\/target\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
    if (blobs && req.method === "HEAD") {
      const has = this.targetBlobs.get(blobs[1])?.has(blobs[2]);
      res.writeHead(has ? 200 : 404, has ? { "docker-content-digest": blobs[2] } : {});
      return res.end();
    }
    const start = /^\/target\/v2\/(.+)\/blobs\/uploads\/$/.exec(url.pathname);
    if (start && req.method === "POST") {
      if (url.searchParams.has("mount")) this.mounts.push(url.search);
      const id = `u${++this.uploadIds}`;
      this.uploads.set(`${start[1]}/${id}`, { bytes: [], received: 0 });
      res.writeHead(202, { location: `/target/v2/${start[1]}/blobs/uploads/${id}?_state=0` });
      return res.end();
    }
    const upload = /^\/target\/v2\/(.+)\/blobs\/uploads\/([^/?]+)$/.exec(url.pathname);
    if (upload) {
      const key = `${upload[1]}/${upload[2]}`;
      const u = this.uploads.get(key);
      if (!u) return json(res, 404, { errors: [{ code: "BLOB_UPLOAD_UNKNOWN" }] });
      if (req.method === "PATCH") {
        this.patches++;
        if (this.failPatchOnce === this.patches) {
          this.failPatchOnce = undefined;
          return json(res, 503, { errors: [{ code: "UNAVAILABLE", message: "try again" }] });
        }
        const range = /^(\d+)-(\d+)$/.exec(req.headers["content-range"] ?? "");
        const from = range ? Number(range[1]) : NaN;
        const to = range ? Number(range[2]) : NaN;
        if (
          from !== u.received ||
          to - from + 1 !== body.length ||
          (u.lastPart !== undefined && u.lastPart < this.minPartBytes)
        )
          return json(
            res,
            416,
            { errors: [{ code: "RANGE_ERROR", message: "invalid content range" }] },
            { range: `0-${u.received - 1}` },
          );
        u.bytes.push(body);
        u.received += body.length;
        u.lastPart = body.length;
        res.writeHead(202, {
          location: `/target/v2/${upload[1]}/blobs/uploads/${upload[2]}?_state=${u.received}`,
          range: `0-${u.received - 1}`,
        });
        return res.end();
      }
      if (req.method === "PUT") {
        const digest = url.searchParams.get("digest");
        const all = Buffer.concat(u.bytes);
        if (digest !== sha256(all))
          return json(res, 400, {
            errors: [{ code: "DIGEST_INVALID", message: "provided digest did not match uploaded content" }],
          });
        if (!this.targetBlobs.has(upload[1])) this.targetBlobs.set(upload[1], new Set());
        this.targetBlobs.get(upload[1])!.add(digest);
        this.uploads.delete(key);
        res.writeHead(201, { "docker-content-digest": digest, location: `/target/v2/${upload[1]}/blobs/${digest}` });
        return res.end();
      }
    }
    const manifest = /^\/target\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname);
    if (manifest && req.method === "PUT") {
      this.targetManifests.set(`${manifest[1]}:${manifest[2]}`, {
        bytes: body,
        type: req.headers["content-type"] ?? "",
      });
      res.writeHead(201, { "docker-content-digest": sha256(body) });
      return res.end();
    }
    if (manifest && req.method === "HEAD") {
      const stored = this.targetManifests.get(`${manifest[1]}:${manifest[2]}`);
      if (!stored) return json(res, 404, { errors: [{ code: "MANIFEST_UNKNOWN" }] });
      res.writeHead(200, {
        "content-type": stored.type,
        "docker-content-digest": this.lieAboutManifestDigest ? `sha256:${"0".repeat(64)}` : sha256(stored.bytes),
      });
      return res.end();
    }
    json(res, 405, { errors: [{ code: "UNSUPPORTED" }] });
  }
}

const fake = new FakeRegistries();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** The transfer's I/O against the fake, parts at the registry's minimum so a few MiB exercise the chunking. */
const io = (log: string[] = []): TransferIO => ({
  endpoints: fake.endpoints(),
  partBytes: MIN_PART_BYTES,
  log: (l) => log.push(l),
});

describe("the real endpoints", () => {
  it("are Cloudflare's API, the account registry, and whichever registry a published reference names", () => {
    expect(REGISTRY_ENDPOINTS.api).toBe("https://api.cloudflare.com");
    expect(REGISTRY_ENDPOINTS.target).toBe("https://registry.cloudflare.com");
    expect(REGISTRY_ENDPOINTS.source("ghcr.io")).toBe("https://ghcr.io");
  });
});

describe("mintRegistryCredential", () => {
  it("POSTs the push+pull request with the API token as a Bearer and answers with the Basic header the registry takes", async () => {
    const r = await mintRegistryCredential(ACCOUNT, API_TOKEN, io());
    expect(r).toEqual({ ok: true, credential: CREDENTIAL });
    expect(fake.credentialRequests).toEqual([
      { authorization: `Bearer ${API_TOKEN}`, body: { expiration_minutes: 45, permissions: ["push", "pull"] } },
    ]);
  });

  it("a 403 is the token's missing Containers Edit, by name; another status keeps the API's words; an unreachable API is named too", async () => {
    fake.credentialStatus = 403;
    expect(await mintRegistryCredential(ACCOUNT, API_TOKEN, io())).toEqual({
      ok: false,
      problem: containersEditProblem(),
    });
    fake.credentialStatus = 500;
    const r = await mintRegistryCredential(ACCOUNT, API_TOKEN, io());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.problem).toContain("HTTP 500");
    expect(r.problem).toContain("Unauthorized to access requested resource");
    const down = await mintRegistryCredential(ACCOUNT, API_TOKEN, {
      ...io(),
      endpoints: { ...fake.endpoints(), api: "http://127.0.0.1:1" },
    });
    expect(down.ok).toBe(false);
    if (down.ok) throw new Error("unreachable");
    expect(down.problem).toMatch(/^minting the account registry credential failed — /);
  });
});

describe("transferImage", () => {
  it("moves the linux/amd64 manifest's config and layers the target lacks, in ≥ 5 MiB parts, commits each by digest, pushes the manifest with the source's media type and proves the digest landed", async () => {
    const [small, big, present] = [randomBytes(200), randomBytes(12 * MiB), randomBytes(7 * MiB)];
    fake.source = sourceImage([big, present, small]);
    fake.targetBlobs.set(TARGET_NAME, new Set([sha256(present)]));
    const log: string[] = [];
    const r = await transferImage(COPY, ACCOUNT, CREDENTIAL, io(log));
    const uploadedBytes = Object.entries(fake.source.blobs)
      .filter(([digest]) => digest !== sha256(present))
      .reduce((n, [, bytes]) => n + bytes.length, 0);
    expect(r).toEqual({
      ok: true,
      report: { digest: fake.source.manifestDigest, blobs: 4, uploaded: 3, bytes: uploadedBytes },
    });
    expect(uploadedBytes).toBeGreaterThan(12 * MiB + 200);
    // Every blob the manifest names is in the target; the manifest is byte-identical to the source's and typed as it was.
    expect([...fake.targetBlobs.get(TARGET_NAME)!].sort()).toEqual(Object.keys(fake.source.blobs).sort());
    const pushed = fake.targetManifests.get(`${TARGET_NAME}:1.2.3`)!;
    expect(pushed.type).toBe(MEDIA_TYPES.ociManifest);
    expect(sha256(pushed.bytes)).toBe(fake.source.manifestDigest);
    // The source was read by tag once, then by the selected digest; blobs by digest; the arm64 and attestation manifests were never fetched.
    const reads = fake.requests.filter((q) => q.startsWith("GET /source/"));
    expect(reads[0]).toBe(`GET /source/token?scope=repository%3A${encodeURIComponent(REPO)}%3Apull`);
    expect(reads[1]).toBe(`GET /source/v2/${REPO}/manifests/1.2.3`);
    expect(reads[2]).toBe(`GET /source/v2/${REPO}/manifests/${fake.source.manifestDigest}`);
    expect(reads.filter((q) => q.includes("/manifests/"))).toHaveLength(2);
    // The present layer was HEADed and never fetched or uploaded; the 12 MiB layer went as 5 + 5 + 2 MiB.
    expect(reads.some((q) => q.endsWith(sha256(present)))).toBe(false);
    const patches = fake.requests.filter((q) => q.startsWith("PATCH "));
    expect(patches).toHaveLength(1 + 3 + 1);
    expect(fake.requests.filter((q) => q.startsWith("POST ") && q.includes("/blobs/uploads/"))).toHaveLength(3);
    expect(fake.requests.filter((q) => q.startsWith("PUT ") && q.includes("digest="))).toHaveLength(3);
    // The upload's location (relative, with the registry's own query state) was followed and the digest appended to it.
    expect(
      fake.requests.some((q) => /^PUT \/target\/v2\/.+\/blobs\/uploads\/u\d+\?_state=\d+&digest=sha256%3A/.test(q)),
    ).toBe(true);
    expect(fake.requests.at(-2)).toBe(`PUT /target/v2/${TARGET_NAME}/manifests/1.2.3`);
    expect(fake.requests.at(-1)).toBe(`HEAD /target/v2/${TARGET_NAME}/manifests/1.2.3`);
    expect(fake.mounts).toEqual([]);
    expect(log.some((l) => l.includes("3 of 4 blobs to upload"))).toBe(true);
  });

  it("a source that is one manifest, not an index, is copied as it is", async () => {
    fake.source = sourceImage([randomBytes(10)], "manifest");
    const r = await transferImage(COPY, ACCOUNT, CREDENTIAL, io());
    expect(r).toMatchObject({ ok: true, report: { digest: fake.source.manifestDigest, blobs: 2, uploaded: 2 } });
    expect(fake.requests.filter((q) => q.includes("/source/v2/") && q.includes("/manifests/"))).toHaveLength(1);
  });

  it("retries a failed part once and goes on; a part the registry refuses twice stops the copy naming the part, the status and the registry's code, with no manifest pushed", async () => {
    fake.source = sourceImage([randomBytes(11 * MiB)]);
    fake.failPatchOnce = 2;
    const r = await transferImage(COPY, ACCOUNT, CREDENTIAL, io());
    expect(r).toMatchObject({ ok: true, report: { uploaded: 2 } });
    expect(fake.requests.filter((q) => q.startsWith("PATCH "))).toHaveLength(1 + 3 + 1);
    // The registry's own rule, seen from the client: a part under its minimum is 416, and that is not retried into success.
    fake.reset();
    fake.source = sourceImage([randomBytes(11 * MiB)]);
    fake.minPartBytes = 6 * MiB;
    const refused = await transferImage(COPY, ACCOUNT, CREDENTIAL, io());
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.problem).toContain("part 2/3");
    expect(refused.problem).toContain("HTTP 416");
    expect(refused.problem).toContain("RANGE_ERROR");
    expect(fake.targetManifests.size).toBe(0);
  });

  it("verifies each blob's sha256 while streaming: bytes that do not hash to the digest are never committed and the copy stops naming the blob", async () => {
    const layer = randomBytes(6 * MiB);
    fake.source = sourceImage([layer]);
    fake.corruptBlob = sha256(layer);
    const r = await transferImage(COPY, ACCOUNT, CREDENTIAL, io());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.problem).toContain(`${sha256(layer).slice(0, 19)}`);
    expect(r.problem).toContain("does not hash to its digest");
    expect(
      fake.requests.filter((q) => q.startsWith("PUT ") && q.endsWith(`digest=${encodeURIComponent(sha256(layer))}`)),
    ).toEqual([]);
    expect(fake.targetBlobs.get(TARGET_NAME)?.has(sha256(layer)) ?? false).toBe(false);
    expect(fake.targetManifests.size).toBe(0);
  });

  it("a manifest the registry reports under another digest afterwards is a failure naming both", async () => {
    fake.source = sourceImage([randomBytes(10)]);
    fake.lieAboutManifestDigest = true;
    const r = await transferImage(COPY, ACCOUNT, CREDENTIAL, io());
    expect(r).toEqual({
      ok: false,
      problem: `pushed the manifest as ${TARGET_NAME}:1.2.3, but the registry reports digest sha256:${"0".repeat(64)} where ${fake.source.manifestDigest} was pushed`,
    });
  });

  it("names what the source refuses: a reference without a tag, a tag the registry does not have, an index without linux/amd64", async () => {
    const noTag = await transferImage(
      { ...COPY, source: "ghcr.io/example/switchboard-resident" },
      ACCOUNT,
      CREDENTIAL,
      io(),
    );
    expect(noTag).toEqual({
      ok: false,
      problem: "ghcr.io/example/switchboard-resident: expected <registry>/<repository>:<tag>",
    });
    const unknown = await transferImage(COPY, ACCOUNT, CREDENTIAL, io());
    expect(unknown).toEqual({
      ok: false,
      problem: `reading ${SOURCE}'s manifest failed — HTTP 404: {"errors":[{"code":"MANIFEST_UNKNOWN"}]}`,
    });
    const image = sourceImage([randomBytes(10)]);
    const amd64 = JSON.parse(image.byTag["1.2.3"].bytes.toString()) as {
      manifests: { platform: { architecture: string } }[];
    };
    amd64.manifests = amd64.manifests.filter((m) => m.platform.architecture !== "amd64");
    fake.source = {
      ...image,
      byTag: { "1.2.3": { bytes: Buffer.from(JSON.stringify(amd64)), type: MEDIA_TYPES.ociIndex } },
    };
    const noPlatform = await transferImage(COPY, ACCOUNT, CREDENTIAL, io());
    expect(noPlatform).toEqual({
      ok: false,
      problem: `${SOURCE}: the index has no linux/amd64 manifest (it has linux/arm64, unknown/unknown)`,
    });
  });

  it("a credential the target refuses is named with the status before anything is uploaded (a HEAD carries no words)", async () => {
    fake.source = sourceImage([randomBytes(10)]);
    const r = await transferImage(COPY, ACCOUNT, { authorization: basicAuthorization("v1", "expired") }, io());
    expect(r).toEqual({
      ok: false,
      problem: `asking ${TARGET_NAME} for ${sha256(Object.values(fake.source.blobs)[0]).slice(0, 19)} failed — HTTP 401`,
    });
    expect(fake.requests.filter((q) => q.startsWith("POST /target/"))).toEqual([]);
  });

  it("the fake accepts a cross-repository mount and ignores it — the blob is uploaded like any other (why the copy never asks for one)", async () => {
    const res = await fetch(`${fake.base}/target/v2/${TARGET_NAME}/blobs/uploads/?mount=sha256:aa&from=other`, {
      method: "POST",
      headers: { authorization: CREDENTIAL.authorization },
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("location")).toMatch(/\/blobs\/uploads\/u\d+\?_state=0$/);
    expect(fake.mounts).toEqual(["?mount=sha256:aa&from=other"]);
  });
});
