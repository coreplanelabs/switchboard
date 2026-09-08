import { describe, expect, it } from "vitest";
import { ACCOUNT_REGISTRY, registryHas } from "./accountRegistry.js";
import {
  appendDigest,
  basicAuthorization,
  blobsOf,
  catalogProblem,
  catalogUrl,
  challengeTokenUrl,
  containersEditProblem,
  contentRange,
  CREDENTIAL_MINUTES,
  CREDENTIAL_REQUEST,
  credentialProblem,
  credentialsUrl,
  MANIFEST_ACCEPT,
  MEDIA_TYPES,
  MIN_PART_BYTES,
  PART_BYTES,
  parseBearerChallenge,
  parseCatalog,
  parseCredential,
  parseImageRef,
  parseManifestDocument,
  parseSourceToken,
  partBoundaries,
  resolveLocation,
  selectPlatformManifest,
  TARGET_PLATFORM,
  targetRepository,
} from "./registryTransfer.js";

// Feature: docs/reference/specs/release-and-deploy.md item 26 — the pure half of the
// registry-to-registry copy: the requests' shapes, what the source's documents
// mean, which manifest is the one Cloudflare runs, and where each blob's upload
// parts begin and end. Nothing here fetches.

const MiB = 1024 * 1024;

describe("the references", () => {
  it("parses a published reference into registry, repository and tag, and refuses one without a tag or a host", () => {
    expect(parseImageRef("ghcr.io/example/switchboard-resident:1.2.3")).toEqual({
      ok: true,
      ref: { registry: "ghcr.io", repository: "example/switchboard-resident", tag: "1.2.3" },
    });
    expect(parseImageRef("ghcr.io/example/switchboard:1.2.3-rc.1")).toMatchObject({
      ok: true,
      ref: { tag: "1.2.3-rc.1" },
    });
    expect(parseImageRef("ghcr.io/example/switchboard")).toEqual({
      ok: false,
      problem: "ghcr.io/example/switchboard: expected <registry>/<repository>:<tag>",
    });
    expect(parseImageRef("switchboard:1.2.3")).toMatchObject({ ok: false });
    expect(parseImageRef("")).toMatchObject({ ok: false });
  });

  it("the target repository is `<account>/<name>` — the account is the namespace in Cloudflare's registry", () => {
    expect(targetRepository("acct", "switchboard-sandbox")).toBe("acct/switchboard-sandbox");
  });
});

describe("the credential", () => {
  it("is minted from the Cloudflare API on the account's registry, push and pull, for long enough to move a large image", () => {
    expect(credentialsUrl("https://api.cloudflare.com", "acct")).toBe(
      `https://api.cloudflare.com/client/v4/accounts/acct/containers/registries/${ACCOUNT_REGISTRY}/credentials`,
    );
    expect(CREDENTIAL_MINUTES).toBe(45);
    expect(CREDENTIAL_REQUEST).toEqual({ expiration_minutes: 45, permissions: ["push", "pull"] });
  });

  it("is used as HTTP Basic `<username>:<password>` — the registry refuses a Bearer", () => {
    expect(basicAuthorization("v1", "jwt")).toBe(`Basic ${Buffer.from("v1:jwt").toString("base64")}`);
  });

  it("parses the v4 envelope's result and names any other shape", () => {
    expect(parseCredential({ success: true, result: { username: "v1", password: "jwt" } })).toEqual({
      ok: true,
      username: "v1",
      password: "jwt",
    });
    expect(parseCredential({ success: true, result: {} })).toEqual({
      ok: false,
      problem: "the credentials response carries no result.username / result.password",
    });
    expect(parseCredential("nope")).toMatchObject({ ok: false });
    expect(parseCredential(null)).toMatchObject({ ok: false });
  });

  it("a 403 names the endpoint that answered it and the token permission Cloudflare documents — and says when a token that has it is still refused; any other failure keeps the status and the API's words", () => {
    const url = credentialsUrl("https://api.cloudflare.com", "acct");
    expect(credentialProblem(403, '{"errors":[{"message":"Unauthorized to access requested resource"}]}', url)).toBe(
      containersEditProblem(`POST ${url}`),
    );
    expect(containersEditProblem(`POST ${url}`)).toBe(
      `POST ${url} answered 403 — the Cloudflare API token needs Containers Edit to copy images into the account registry (the permission Cloudflare documents for \`containers\`); a token that has it is missing a permission Cloudflare does not document for this endpoint`,
    );
    expect(credentialProblem(500, "boom", url)).toBe("minting the account registry credential failed — HTTP 500: boom");
    expect(credentialProblem(401, "", url)).toBe("minting the account registry credential failed — HTTP 401");
  });
});

describe("the account registry's listing", () => {
  it("is the catalog with tags under the same credential — what `wrangler containers images list` reads", () => {
    expect(catalogUrl("https://registry.cloudflare.com")).toBe("https://registry.cloudflare.com/v2/_catalog?tags=true");
  });

  it("parses the catalog's repositories under the account — the prefix stripped, another account's skipped, non-string tags dropped — and refuses any other shape", () => {
    const catalog = {
      repositories: {
        "/acct/switchboard": ["1.2.2", "1.2.3", "latest"],
        "acct/switchboard-resident": ["1.2.2"],
        "/other/switchboard-sandbox": ["1.2.3"],
        "/acct/odd": ["1", 2, "3"],
      },
      cursor: "next",
    };
    expect(parseCatalog(catalog, "acct")).toEqual([
      { name: "switchboard", tags: ["1.2.2", "1.2.3", "latest"] },
      { name: "switchboard-resident", tags: ["1.2.2"] },
      { name: "odd", tags: ["1", "3"] },
    ]);
    expect(parseCatalog({ repositories: {} }, "acct")).toEqual([]);
    expect(parseCatalog({ repositories: [] }, "acct")).toBeUndefined();
    expect(parseCatalog({ repositories: { "/acct/x": "1.2.3" } }, "acct")).toBeUndefined();
    expect(parseCatalog({}, "acct")).toBeUndefined();
    expect(parseCatalog(null, "acct")).toBeUndefined();
  });

  it("holds `<name>:<version>` when that name lists that tag — another name's tag or another version does not count", () => {
    const listing = [
      { name: "switchboard", tags: ["1.2.2", "1.2.3", "latest"] },
      { name: "switchboard-resident", tags: ["1.2.2"] },
    ];
    expect(registryHas(listing, "switchboard", "1.2.3")).toBe(true);
    expect(registryHas(listing, "switchboard-resident", "1.2.3")).toBe(false);
    expect(registryHas([], "switchboard", "1.2.3")).toBe(false);
  });

  it("a 403 on the catalog names that endpoint and the permission; any other failure keeps the registry's words", () => {
    const url = catalogUrl("https://registry.cloudflare.com");
    expect(catalogProblem(403, "", url)).toBe(containersEditProblem(`GET ${url}`));
    expect(catalogProblem(401, '{"errors":[{"code":"UNAUTHORIZED"}]}', url)).toBe(
      'listing the account registry failed — HTTP 401: {"errors":[{"code":"UNAUTHORIZED"}]}',
    );
  });
});

describe("the source", () => {
  it("answers the registry's Bearer challenge — realm, service, scope — with an anonymous token request at the realm; another scheme, no header or no realm is nothing to answer", () => {
    const challenge = parseBearerChallenge(
      'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:example/switchboard:pull"',
    );
    expect(challenge).toEqual({
      realm: "https://ghcr.io/token",
      service: "ghcr.io",
      scope: "repository:example/switchboard:pull",
    });
    expect(challengeTokenUrl(challenge!)).toBe(
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aexample%2Fswitchboard%3Apull",
    );
    // Case and parameter order are the registry's; a realm alone is a complete challenge.
    expect(parseBearerChallenge('bearer scope="x",realm="https://r.example/t"')).toEqual({
      realm: "https://r.example/t",
      scope: "x",
    });
    expect(challengeTokenUrl({ realm: "https://r.example/t" })).toBe("https://r.example/t");
    expect(parseBearerChallenge('Basic realm="registry"')).toBeUndefined();
    expect(parseBearerChallenge('Bearer service="x"')).toBeUndefined();
    expect(parseBearerChallenge(null)).toBeUndefined();
    expect(parseSourceToken({ token: "t" })).toEqual({ ok: true, token: "t" });
    expect(parseSourceToken({ access_token: "t" })).toEqual({ ok: true, token: "t" });
    expect(parseSourceToken({})).toEqual({ ok: false, problem: "the token response carries no token" });
  });

  it("accepts an index or a manifest, OCI or Docker, and reads whichever came back", () => {
    expect(MANIFEST_ACCEPT.split(", ").sort()).toEqual(Object.values(MEDIA_TYPES).sort());
    const index = {
      mediaType: MEDIA_TYPES.ociIndex,
      manifests: [
        {
          mediaType: MEDIA_TYPES.ociManifest,
          digest: "sha256:aa",
          size: 1,
          platform: { os: "linux", architecture: "arm64" },
        },
        {
          mediaType: MEDIA_TYPES.ociManifest,
          digest: "sha256:bb",
          size: 2,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: MEDIA_TYPES.ociManifest,
          digest: "sha256:cc",
          size: 3,
          platform: { os: "unknown", architecture: "unknown" },
        },
      ],
    };
    expect(parseManifestDocument(JSON.stringify(index), MEDIA_TYPES.ociIndex)).toEqual({
      ok: true,
      document: { kind: "index", manifests: index.manifests },
    });
    // The content type decides; the body's `mediaType` stands in when the header is absent.
    expect(parseManifestDocument(JSON.stringify(index), null)).toMatchObject({ ok: true, document: { kind: "index" } });
    const manifest = {
      mediaType: MEDIA_TYPES.dockerManifest,
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: "sha256:c0", size: 10 },
      layers: [{ mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", digest: "sha256:l0", size: 20 }],
    };
    expect(parseManifestDocument(JSON.stringify(manifest), `${MEDIA_TYPES.dockerManifest}; charset=utf-8`)).toEqual({
      ok: true,
      document: {
        kind: "manifest",
        mediaType: MEDIA_TYPES.dockerManifest,
        config: manifest.config,
        layers: manifest.layers,
      },
    });
    expect(parseManifestDocument("{ not json", MEDIA_TYPES.ociManifest)).toEqual({
      ok: false,
      problem: "the manifest is not JSON",
    });
    expect(parseManifestDocument(JSON.stringify({ foo: 1 }), "text/plain")).toEqual({
      ok: false,
      problem: "text/plain is not an image manifest or index",
    });
    expect(parseManifestDocument(JSON.stringify({ layers: [] }), MEDIA_TYPES.ociManifest)).toEqual({
      ok: false,
      problem: "the manifest has no config descriptor",
    });
  });

  it("picks the linux/amd64 manifest out of an index — what Cloudflare runs — skipping attestations and other platforms, and names what was there when it is absent", () => {
    expect(TARGET_PLATFORM).toEqual({ os: "linux", architecture: "amd64" });
    const manifests = [
      {
        mediaType: MEDIA_TYPES.ociManifest,
        digest: "sha256:aa",
        size: 1,
        platform: { os: "linux", architecture: "arm64" },
      },
      {
        mediaType: MEDIA_TYPES.ociManifest,
        digest: "sha256:bb",
        size: 2,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: MEDIA_TYPES.ociManifest,
        digest: "sha256:cc",
        size: 3,
        platform: { os: "unknown", architecture: "unknown" },
      },
    ];
    expect(selectPlatformManifest({ kind: "index", manifests })).toEqual({ ok: true, descriptor: manifests[1] });
    expect(selectPlatformManifest({ kind: "index", manifests: [manifests[0], manifests[2]] })).toEqual({
      ok: false,
      problem: "the index has no linux/amd64 manifest (it has linux/arm64, unknown/unknown)",
    });
    expect(selectPlatformManifest({ kind: "index", manifests: [] })).toEqual({
      ok: false,
      problem: "the index has no linux/amd64 manifest (it has nothing)",
    });
  });

  it("the blobs to move are the config and then every layer, in order", () => {
    const config = { mediaType: "c", digest: "sha256:c0", size: 1 };
    const layers = [
      { mediaType: "l", digest: "sha256:l0", size: 2 },
      { mediaType: "l", digest: "sha256:l1", size: 3 },
    ];
    expect(blobsOf({ kind: "manifest", mediaType: MEDIA_TYPES.ociManifest, config, layers })).toEqual([
      config,
      ...layers,
    ]);
  });
});

describe("the upload parts", () => {
  it("cuts a blob into parts of the part size where every part but the last is at least 5 MiB — the registry answers 416 to a smaller one", () => {
    expect(MIN_PART_BYTES).toBe(5 * MiB);
    expect(PART_BYTES).toBe(64 * MiB);
    expect(partBoundaries(0)).toEqual([]);
    expect(partBoundaries(10)).toEqual([{ start: 0, end: 10 }]);
    expect(partBoundaries(64 * MiB)).toEqual([{ start: 0, end: 64 * MiB }]);
    expect(partBoundaries(64 * MiB + 1)).toEqual([
      { start: 0, end: 64 * MiB },
      { start: 64 * MiB, end: 64 * MiB + 1 },
    ]);
    expect(partBoundaries(200 * MiB)).toEqual([
      { start: 0, end: 64 * MiB },
      { start: 64 * MiB, end: 128 * MiB },
      { start: 128 * MiB, end: 192 * MiB },
      { start: 192 * MiB, end: 200 * MiB },
    ]);
    // A smaller part size is allowed down to the minimum (the tests move small blobs); below it, refused.
    expect(partBoundaries(12 * MiB, 5 * MiB)).toEqual([
      { start: 0, end: 5 * MiB },
      { start: 5 * MiB, end: 10 * MiB },
      { start: 10 * MiB, end: 12 * MiB },
    ]);
    expect(() => partBoundaries(10, MiB)).toThrow("a part size below 5 MiB is refused by the registry (416)");
    for (const parts of [partBoundaries(1000 * MiB), partBoundaries(11 * MiB, 5 * MiB)])
      for (const p of parts.slice(0, -1)) expect(p.end - p.start).toBeGreaterThanOrEqual(MIN_PART_BYTES);
  });

  it("names a part's bytes as an inclusive Content-Range, commits with the digest on the upload's location, and resolves a relative location against the registry", () => {
    expect(contentRange({ start: 0, end: 10 })).toBe("0-9");
    expect(contentRange({ start: 64 * MiB, end: 64 * MiB + 1 })).toBe(`${64 * MiB}-${64 * MiB}`);
    expect(appendDigest("https://r.example/v2/a/b/blobs/uploads/u1", "sha256:ab")).toBe(
      "https://r.example/v2/a/b/blobs/uploads/u1?digest=sha256%3Aab",
    );
    expect(appendDigest("https://r.example/v2/a/b/blobs/uploads/u1?_state=x", "sha256:ab")).toBe(
      "https://r.example/v2/a/b/blobs/uploads/u1?_state=x&digest=sha256%3Aab",
    );
    expect(resolveLocation("/v2/a/b/blobs/uploads/u1", "https://r.example/v2/a/b/blobs/uploads/")).toBe(
      "https://r.example/v2/a/b/blobs/uploads/u1",
    );
    expect(resolveLocation("https://other.example/u1", "https://r.example/x")).toBe("https://other.example/u1");
  });
});
