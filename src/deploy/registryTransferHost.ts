// The HTTP half of the registry-to-registry image copy (docs/reference/specs/release-and-deploy.md
// item 26; the shapes are src/deploy/registryTransfer.ts). Two calls a command
// makes: `mintRegistryCredential` turns the operator's Cloudflare API token into
// a short-lived push+pull credential on the account registry, and
// `transferImage` moves one published image into it — the source's linux/amd64
// manifest, its config and every layer the target lacks — over the OCI
// distribution API alone. No container daemon, no wrangler: Node's fetch and a
// sha256 per blob, verified while the bytes stream through.
//
// A blob streams from the source and is written to the target as chunked
// `PATCH` parts (one part's bytes in memory at a time, never a whole layer),
// each part but the last at least 5 MiB — the registry's rule — then committed
// with a `PUT ?digest=`. A part that fails is sent once more; a second failure
// stops the copy naming the part. The manifest goes last, byte-identical and
// under the source's media type, and the registry is asked for its digest
// afterwards: a push that returned 201 is not the proof, the digest is.
//
// Every endpoint is injectable so the tests run against an in-process registry.

import { createHash } from "node:crypto";
import { ACCOUNT_REGISTRY, type ImageCopy } from "./images.js";
import {
  appendDigest,
  basicAuthorization,
  blobsOf,
  contentRange,
  CREDENTIAL_REQUEST,
  credentialProblem,
  credentialsUrl,
  MANIFEST_ACCEPT,
  PART_BYTES,
  parseCredential,
  parseImageRef,
  parseManifestDocument,
  parseSourceToken,
  partBoundaries,
  resolveLocation,
  selectPlatformManifest,
  sourceTokenUrl,
  targetRepository,
  type Descriptor,
  type ManifestDocument,
  type Part,
} from "./registryTransfer.js";

/** Where the three parties are reached; the tests point every one at a fake. */
export interface RegistryEndpoints {
  /** Cloudflare's API — the credential mint. */
  api: string;
  /** The account registry the copies land in. */
  target: string;
  /** The registry a published reference names (`ghcr.io` → `https://ghcr.io`). */
  source: (registry: string) => string;
}

export const REGISTRY_ENDPOINTS: RegistryEndpoints = {
  api: "https://api.cloudflare.com",
  target: `https://${ACCOUNT_REGISTRY}`,
  source: (registry) => `https://${registry}`,
};

export interface TransferIO {
  fetch?: typeof fetch;
  endpoints?: RegistryEndpoints;
  /** The upload part size (default `PART_BYTES`); the tests move small blobs at the registry's minimum. */
  partBytes?: number;
  log?: (line: string) => void;
}

/** The minted credential as the registry takes it: the `Authorization` header value. */
export interface RegistryCredential {
  authorization: string;
}

/** What one copy moved. */
export interface TransferReport {
  /** The manifest's digest — the same in the source and, verified, in the target. */
  digest: string;
  /** Blobs the manifest names; how many had to be uploaded (the rest were present); their bytes. */
  blobs: number;
  uploaded: number;
  bytes: number;
}

export type TransferOutcome = { ok: true; report: TransferReport } | { ok: false; problem: string };

/** A small request's budget, and a part's or a blob stream's. */
const SHORT_MS = 60_000;
const LONG_MS = 30 * 60_000;

/** A failure with a place to go — the problem the command prints. */
class TransferProblem extends Error {}

const said = async (res: Response): Promise<string> => {
  const text = (await res.text().catch(() => "")).trim();
  return `HTTP ${res.status}${text ? `: ${text}` : ""}`;
};

const MiB = 1024 * 1024;
const mib = (n: number) => `${(n / MiB).toFixed(n >= 10 * MiB ? 0 : 1)} MiB`;
const short = (digest: string) => digest.slice(0, 19);

/** Mint a push+pull credential on the account registry from the operator's API token. */
export async function mintRegistryCredential(
  account: string,
  apiToken: string,
  io: TransferIO = {},
): Promise<{ ok: true; credential: RegistryCredential } | { ok: false; problem: string }> {
  const doFetch = io.fetch ?? fetch;
  const endpoints = io.endpoints ?? REGISTRY_ENDPOINTS;
  let res: Response;
  try {
    res = await doFetch(credentialsUrl(endpoints.api, account), {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify(CREDENTIAL_REQUEST),
      signal: AbortSignal.timeout(SHORT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      problem: `minting the account registry credential failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) return { ok: false, problem: credentialProblem(res.status, await res.text().catch(() => "")) };
  const parsed = parseCredential(await res.json().catch(() => null));
  if (!parsed.ok) return { ok: false, problem: `minting the account registry credential failed — ${parsed.problem}` };
  return { ok: true, credential: { authorization: basicAuthorization(parsed.username, parsed.password) } };
}

/** Copy one published image into the account registry as `<account>/<name>:<version>`. */
export async function transferImage(
  copy: Pick<ImageCopy, "source" | "name" | "version">,
  account: string,
  credential: RegistryCredential,
  io: TransferIO = {},
): Promise<TransferOutcome> {
  try {
    return { ok: true, report: await transfer(copy, account, credential, io) };
  } catch (err) {
    if (err instanceof TransferProblem) return { ok: false, problem: err.message };
    return {
      ok: false,
      problem: `copying ${copy.source} failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function transfer(
  copy: Pick<ImageCopy, "source" | "name" | "version">,
  account: string,
  credential: RegistryCredential,
  io: TransferIO,
): Promise<TransferReport> {
  const doFetch = io.fetch ?? fetch;
  const endpoints = io.endpoints ?? REGISTRY_ENDPOINTS;
  const partBytes = io.partBytes ?? PART_BYTES;
  const log = io.log ?? (() => {});
  const parsed = parseImageRef(copy.source);
  if (!parsed.ok) throw new TransferProblem(parsed.problem);
  const { registry, repository, tag } = parsed.ref;
  const sourceBase = endpoints.source(registry);
  const targetName = targetRepository(account, copy.name);
  const targetBase = `${endpoints.target}/v2/${targetName}`;
  const targetHeaders = { authorization: credential.authorization };

  // The source: an anonymous pull token, the manifest by tag, and — behind an index — the linux/amd64 one by digest.
  const tokenRes = await doFetch(sourceTokenUrl(sourceBase, repository), { signal: AbortSignal.timeout(SHORT_MS) });
  if (!tokenRes.ok) throw new TransferProblem(`reading ${copy.source}'s pull token failed — ${await said(tokenRes)}`);
  const token = parseSourceToken(await tokenRes.json().catch(() => null));
  if (!token.ok) throw new TransferProblem(`reading ${copy.source}'s pull token failed — ${token.problem}`);
  const sourceHeaders = { authorization: `Bearer ${token.token}` };
  const sourceManifests = `${sourceBase}/v2/${repository}/manifests`;
  const readManifest = async (reference: string): Promise<{ bytes: Buffer; document: ManifestDocument }> => {
    const res = await doFetch(`${sourceManifests}/${reference}`, {
      headers: { ...sourceHeaders, accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(SHORT_MS),
    });
    if (!res.ok) throw new TransferProblem(`reading ${copy.source}'s manifest failed — ${await said(res)}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const document = parseManifestDocument(bytes.toString("utf8"), res.headers.get("content-type"));
    if (!document.ok) throw new TransferProblem(`${copy.source}: ${document.problem}`);
    return { bytes, document: document.document };
  };
  let manifest = await readManifest(tag);
  if (manifest.document.kind === "index") {
    const selected = selectPlatformManifest(manifest.document);
    if (!selected.ok) throw new TransferProblem(`${copy.source}: ${selected.problem}`);
    manifest = await readManifest(selected.descriptor.digest);
    if (manifest.document.kind === "index")
      throw new TransferProblem(`${copy.source}: the ${selected.descriptor.digest} manifest is itself an index`);
  }
  const digest = sha256(manifest.bytes);
  const blobs = blobsOf(manifest.document);

  // The blobs: present ones are skipped by digest; the rest stream from the source into a chunked upload.
  const missing: Descriptor[] = [];
  for (const blob of blobs) {
    const head = await doFetch(`${targetBase}/blobs/${blob.digest}`, {
      method: "HEAD",
      headers: targetHeaders,
      signal: AbortSignal.timeout(SHORT_MS),
    });
    if (head.status === 404) missing.push(blob);
    else if (!head.ok)
      throw new TransferProblem(`asking ${targetName} for ${short(blob.digest)} failed — ${await said(head)}`);
  }
  const bytes = missing.reduce((n, b) => n + b.size, 0);
  log(
    `[images] ${copy.name}:${copy.version} ← ${copy.source}: ${missing.length} of ${blobs.length} blobs to upload (${mib(bytes)})`,
  );
  for (const blob of missing) {
    const parts = partBoundaries(blob.size, partBytes);
    log(`[images]   ${short(blob.digest)} ${mib(blob.size)} — ${parts.length} part${parts.length === 1 ? "" : "s"}`);
    const started = await doFetch(`${targetBase}/blobs/uploads/`, {
      method: "POST",
      headers: targetHeaders,
      signal: AbortSignal.timeout(SHORT_MS),
    });
    const startedAt = started.headers.get("location");
    if (started.status !== 202 || !startedAt)
      throw new TransferProblem(
        `starting the upload of ${short(blob.digest)} to ${targetName} failed — ${await said(started)}`,
      );
    let location = resolveLocation(startedAt, `${targetBase}/blobs/uploads/`);
    const source = await doFetch(`${sourceBase}/v2/${repository}/blobs/${blob.digest}`, {
      headers: sourceHeaders,
      signal: AbortSignal.timeout(LONG_MS),
    });
    if (!source.ok || !source.body)
      throw new TransferProblem(`reading ${short(blob.digest)} from ${copy.source} failed — ${await said(source)}`);
    const hash = createHash("sha256");
    let index = 0;
    for await (const { part, bytes: partBytesBuffer } of partsOf(source.body, parts, hash, blob, copy.source)) {
      index++;
      const label = `part ${index}/${parts.length} (${contentRange(part)})`;
      const patch = () =>
        doFetch(location, {
          method: "PATCH",
          headers: {
            ...targetHeaders,
            "content-type": "application/octet-stream",
            "content-range": contentRange(part),
          },
          body: asBody(partBytesBuffer),
          signal: AbortSignal.timeout(LONG_MS),
        });
      let res = await patch().catch((err: unknown) => err);
      if (!(res instanceof Response) || res.status !== 202) {
        log(
          `[images]   ${short(blob.digest)} ${label}: ${res instanceof Response ? `HTTP ${res.status}` : "no response"} — retrying once`,
        );
        res = await patch().catch((err: unknown) => err);
      }
      if (!(res instanceof Response))
        throw new TransferProblem(
          `uploading ${short(blob.digest)} ${label} to ${targetName} failed twice — ${res instanceof Error ? res.message : String(res)}`,
        );
      if (res.status !== 202)
        throw new TransferProblem(
          `uploading ${short(blob.digest)} ${label} to ${targetName} failed twice — ${await said(res)}`,
        );
      const next = res.headers.get("location");
      if (next) location = resolveLocation(next, location);
    }
    const hashed = `sha256:${hash.digest("hex")}`;
    if (hashed !== blob.digest)
      throw new TransferProblem(
        `${short(blob.digest)} from ${copy.source} does not hash to its digest (streamed ${hashed}) — not committed`,
      );
    const committed = await doFetch(appendDigest(location, blob.digest), {
      method: "PUT",
      headers: { ...targetHeaders, "content-length": "0" },
      signal: AbortSignal.timeout(SHORT_MS),
    });
    if (committed.status !== 201)
      throw new TransferProblem(`committing ${short(blob.digest)} to ${targetName} failed — ${await said(committed)}`);
  }

  // The manifest, byte-identical under the source's media type; then the registry's own word on the digest.
  const mediaType = manifest.document.kind === "manifest" ? manifest.document.mediaType : MANIFEST_ACCEPT;
  const pushed = await doFetch(`${targetBase}/manifests/${copy.version}`, {
    method: "PUT",
    headers: { ...targetHeaders, "content-type": mediaType },
    body: asBody(manifest.bytes),
    signal: AbortSignal.timeout(SHORT_MS),
  });
  if (pushed.status !== 201)
    throw new TransferProblem(`pushing the manifest as ${targetName}:${copy.version} failed — ${await said(pushed)}`);
  const landed = await doFetch(`${targetBase}/manifests/${copy.version}`, {
    method: "HEAD",
    headers: { ...targetHeaders, accept: mediaType },
    signal: AbortSignal.timeout(SHORT_MS),
  });
  const reported = landed.headers.get("docker-content-digest");
  if (!landed.ok || reported !== digest)
    throw new TransferProblem(
      `pushed the manifest as ${targetName}:${copy.version}, but the registry reports digest ${reported ?? `none (HTTP ${landed.status})`} where ${digest} was pushed`,
    );
  log(`[images]   ${copy.name}:${copy.version} landed — ${digest}`);
  return { digest, blobs: blobs.length, uploaded: missing.length, bytes };
}

/** A Buffer as fetch takes a body: the same bytes as a plain view, no copy. */
function asBody(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The blob's bytes as they stream, cut at the planned part boundaries — one part's buffer in memory at a
 *  time, every byte through the hash. A stream shorter or longer than the descriptor's size is a problem. */
async function* partsOf(
  body: ReadableStream<Uint8Array>,
  parts: readonly Part[],
  hash: ReturnType<typeof createHash>,
  blob: Descriptor,
  source: string,
): AsyncGenerator<{ part: Part; bytes: Buffer }> {
  let i = 0;
  let buffer = parts.length > 0 ? Buffer.allocUnsafe(parts[0].end - parts[0].start) : Buffer.alloc(0);
  let filled = 0;
  for await (const chunk of body) {
    hash.update(chunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (i >= parts.length)
        throw new TransferProblem(`${short(blob.digest)} from ${source} is longer than its ${blob.size} bytes`);
      const take = Math.min(chunk.byteLength - offset, buffer.length - filled);
      buffer.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === buffer.length) {
        yield { part: parts[i], bytes: buffer };
        i++;
        if (i < parts.length) {
          buffer = Buffer.allocUnsafe(parts[i].end - parts[i].start);
          filled = 0;
        }
      }
    }
  }
  if (i < parts.length)
    throw new TransferProblem(
      `${short(blob.digest)} from ${source} ended after ${parts[i].start + filled} of its ${blob.size} bytes`,
    );
}
