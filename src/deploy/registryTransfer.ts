// The pure half of the registry-to-registry image copy (docs/reference/specs/release-and-deploy.md
// item 26). A `registry`-mode installation needs the release's images in its own
// Cloudflare account registry, and Cloudflare cannot pull them from where the
// release published them (docs/decisions/0027-images-copied-into-the-account-registry.md),
// so the CLI moves them itself over the OCI distribution API — the way crane
// and skopeo do — with no container daemon anywhere: the source's manifest and
// blobs are read over HTTPS and written to `registry.cloudflare.com/<account>/…`
// with a credential minted from the operator's Cloudflare API token.
//
// This file knows the shapes: the requests, what the source's documents mean,
// which manifest is the one Cloudflare runs, and where a blob's upload parts
// begin and end. The HTTP itself is src/deploy/registryTransferHost.ts.

import { ACCOUNT_REGISTRY, type RegistryImage } from "./accountRegistry.js";

/** A published reference, `<registry>/<repository>:<tag>`, taken apart. */
export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

/** Pure: `ghcr.io/owner/name:1.2.3` → its parts; anything without a host and a tag is refused. */
export function parseImageRef(reference: string): { ok: true; ref: ImageRef } | { ok: false; problem: string } {
  const m = /^([^/:]+\.[^/:]+|[^/:]+:\d+)\/([^:@]+):([^/:@]+)$/.exec(reference);
  if (!m) return { ok: false, problem: `${reference}: expected <registry>/<repository>:<tag>` };
  return { ok: true, ref: { registry: m[1], repository: m[2], tag: m[3] } };
}

/** The repository the copy lands in: the account is the namespace in Cloudflare's registry. */
export function targetRepository(account: string, name: string): string {
  return `${account}/${name}`;
}

// --- the credential -----------------------------------------------------------

/** How long the minted credential lives — long enough to move the largest image; the expiry is exactly what is asked. */
export const CREDENTIAL_MINUTES = 45;

/** The body of the credentials request: push and pull on the account registry. */
export const CREDENTIAL_REQUEST = { expiration_minutes: CREDENTIAL_MINUTES, permissions: ["push", "pull"] } as const;

/** The Cloudflare API endpoint that mints a registry credential (what `wrangler containers registries credentials` calls). */
export function credentialsUrl(apiBase: string, account: string): string {
  return `${apiBase}/client/v4/accounts/${account}/containers/registries/${ACCOUNT_REGISTRY}/credentials`;
}

/** The registry takes the credential as HTTP Basic; a Bearer is refused. */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Pure: the credential out of the v4 envelope (`result.username`, `result.password`). */
export function parseCredential(
  json: unknown,
): { ok: true; username: string; password: string } | { ok: false; problem: string } {
  const result = (json as { result?: { username?: unknown; password?: unknown } } | null)?.result;
  if (typeof result?.username === "string" && typeof result.password === "string")
    return { ok: true, username: result.username, password: result.password };
  return { ok: false, problem: "the credentials response carries no result.username / result.password" };
}

/** The one refusal an operator fixes on the token, naming the endpoint that answered 403. Containers Edit is
 *  the permission Cloudflare documents for `containers` (wrangler gates every `containers` command on it);
 *  Cloudflare documents no permission for the registry endpoint itself, so a token that has Containers Edit
 *  and is still refused is said to be, rather than sent after a name nobody wrote down. */
export function containersEditProblem(endpoint: string): string {
  return `${endpoint} answered 403 — the Cloudflare API token needs Containers Edit to copy images into the account registry (the permission Cloudflare documents for \`containers\`); a token that has it is missing a permission Cloudflare does not document for this endpoint`;
}

/** Pure: why the mint failed — a 403 names the permission and the endpoint; anything else keeps the status and the API's words. */
export function credentialProblem(status: number, body: string, endpoint: string): string {
  if (status === 403) return containersEditProblem(`POST ${endpoint}`);
  const said = body.trim();
  return `minting the account registry credential failed — HTTP ${status}${said ? `: ${said}` : ""}`;
}

// --- the account registry's listing ---------------------------------------------------

/** What the account registry holds: `GET /v2/_catalog?tags=true` under the minted credential — the call
 *  `wrangler containers images list` makes. One page: an account holds a handful of repositories. */
export function catalogUrl(targetBase: string): string {
  return `${targetBase}/v2/_catalog?tags=true`;
}

/** Pure: the catalog's `repositories` (`"/<account>/<name>": [tags]`) as names under the account, or
 *  `undefined` for any other shape. A repository outside the account is not the account's. */
export function parseCatalog(json: unknown, account: string): RegistryImage[] | undefined {
  const repositories = (json as { repositories?: unknown } | null)?.repositories;
  if (repositories === null || typeof repositories !== "object" || Array.isArray(repositories)) return undefined;
  const out: RegistryImage[] = [];
  for (const [repository, tags] of Object.entries(repositories as Record<string, unknown>)) {
    if (!Array.isArray(tags)) return undefined;
    const stripped = repository.replace(/^\/+/, "");
    if (!stripped.startsWith(`${account}/`)) continue;
    out.push({
      name: stripped.slice(account.length + 1),
      tags: tags.filter((t): t is string => typeof t === "string"),
    });
  }
  return out;
}

/** Pure: why the listing failed — a 403 names the permission and the endpoint; anything else keeps the status and the registry's words. */
export function catalogProblem(status: number, body: string, endpoint: string): string {
  if (status === 403) return containersEditProblem(`GET ${endpoint}`);
  const said = body.trim();
  return `listing the account registry failed — HTTP ${status}${said ? `: ${said}` : ""}`;
}

// --- the source ------------------------------------------------------------------

/** A registry's `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge, taken apart. */
export interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

/** Pure: the Bearer challenge in a 401's `WWW-Authenticate`, or `undefined` when there is none to answer
 *  (no header, another scheme, no realm). */
export function parseBearerChallenge(header: string | null): BearerChallenge | undefined {
  if (!header || !/^bearer\s/i.test(header)) return undefined;
  const params: Record<string, string> = {};
  for (const m of header.slice("bearer ".length).matchAll(/(\w+)="([^"]*)"/g)) params[m[1].toLowerCase()] = m[2];
  if (!params.realm) return undefined;
  return {
    realm: params.realm,
    ...(params.service !== undefined ? { service: params.service } : {}),
    ...(params.scope !== undefined ? { scope: params.scope } : {}),
  };
}

/** The anonymous token request a challenge asks for: its realm, with the service and scope it named. */
export function challengeTokenUrl(challenge: BearerChallenge): string {
  const url = new URL(challenge.realm);
  if (challenge.service !== undefined) url.searchParams.set("service", challenge.service);
  if (challenge.scope !== undefined) url.searchParams.set("scope", challenge.scope);
  return url.toString();
}

/** Pure: the token out of the token response (`token`, or the OAuth-shaped `access_token`). */
export function parseSourceToken(json: unknown): { ok: true; token: string } | { ok: false; problem: string } {
  const r = json as { token?: unknown; access_token?: unknown } | null;
  const token =
    typeof r?.token === "string" ? r.token : typeof r?.access_token === "string" ? r.access_token : undefined;
  return token ? { ok: true, token } : { ok: false, problem: "the token response carries no token" };
}

/** The media types a manifest request accepts and a manifest push names. */
export const MEDIA_TYPES = {
  ociIndex: "application/vnd.oci.image.index.v1+json",
  dockerList: "application/vnd.docker.distribution.manifest.list.v2+json",
  ociManifest: "application/vnd.oci.image.manifest.v1+json",
  dockerManifest: "application/vnd.docker.distribution.manifest.v2+json",
} as const;

const INDEX_TYPES: readonly string[] = [MEDIA_TYPES.ociIndex, MEDIA_TYPES.dockerList];
const MANIFEST_TYPES: readonly string[] = [MEDIA_TYPES.ociManifest, MEDIA_TYPES.dockerManifest];

/** The `Accept` header of a manifest request: an index or a manifest, OCI or Docker. */
export const MANIFEST_ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(", ");

/** A content-addressed thing in the registry: a blob or a manifest, by digest and size. */
export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}

export interface Platform {
  os: string;
  architecture: string;
  variant?: string;
}

/** What a manifest request returned: an index over per-platform manifests, or one manifest's config and layers. */
export type ManifestDocument =
  | { kind: "index"; manifests: (Descriptor & { platform?: Platform })[] }
  | { kind: "manifest"; mediaType: string; config: Descriptor; layers: Descriptor[] };

const isDescriptor = (d: unknown): d is Descriptor => {
  const x = d as Descriptor | null;
  return typeof x?.mediaType === "string" && typeof x.digest === "string" && typeof x.size === "number";
};

/** Pure: the document behind a manifest response — the content type decides its kind, the body's
 *  `mediaType` stands in when the header is absent; anything else is named. */
export function parseManifestDocument(
  text: string,
  contentType: string | null,
): { ok: true; document: ManifestDocument } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "the manifest is not JSON" };
  }
  const body = json as { mediaType?: unknown; manifests?: unknown; config?: unknown; layers?: unknown } | null;
  const type = (contentType?.split(";")[0].trim() || (typeof body?.mediaType === "string" ? body.mediaType : "")) ?? "";
  if (INDEX_TYPES.includes(type)) {
    const manifests = Array.isArray(body?.manifests) ? body.manifests.filter(isDescriptor) : [];
    return { ok: true, document: { kind: "index", manifests } };
  }
  if (MANIFEST_TYPES.includes(type)) {
    if (!isDescriptor(body?.config)) return { ok: false, problem: "the manifest has no config descriptor" };
    const layers = Array.isArray(body.layers) ? body.layers.filter(isDescriptor) : [];
    return { ok: true, document: { kind: "manifest", mediaType: type, config: body.config, layers } };
  }
  return { ok: false, problem: `${type || "an untyped document"} is not an image manifest or index` };
}

/** The platform Cloudflare's Containers run. */
export const TARGET_PLATFORM: Platform = { os: "linux", architecture: "amd64" };

/** Pure: the one manifest in an index Cloudflare can run — attestation manifests (`unknown/unknown`)
 *  and other architectures are skipped; none there names what was. */
export function selectPlatformManifest(
  index: Extract<ManifestDocument, { kind: "index" }>,
): { ok: true; descriptor: Descriptor } | { ok: false; problem: string } {
  const match = index.manifests.find(
    (m) => m.platform?.os === TARGET_PLATFORM.os && m.platform.architecture === TARGET_PLATFORM.architecture,
  );
  if (match) return { ok: true, descriptor: match };
  const seen = index.manifests.map((m) => (m.platform ? `${m.platform.os}/${m.platform.architecture}` : "no platform"));
  return {
    ok: false,
    problem: `the index has no ${TARGET_PLATFORM.os}/${TARGET_PLATFORM.architecture} manifest (it has ${seen.length > 0 ? seen.join(", ") : "nothing"})`,
  };
}

/** The blobs a manifest needs in the target before it can be pushed: its config, then every layer. */
export function blobsOf(manifest: Extract<ManifestDocument, { kind: "manifest" }>): Descriptor[] {
  return [manifest.config, ...manifest.layers];
}

// --- the upload --------------------------------------------------------------------

/** The registry's rule for a chunked upload: every part but the last is at least this large, or it answers `416 RANGE_ERROR`. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

/** The part size the copy uses: few round trips for a gigabyte image, one buffer of this size in memory at a time. */
export const PART_BYTES = 64 * 1024 * 1024;

/** One part of a blob's upload: `[start, end)` byte offsets. */
export interface Part {
  start: number;
  end: number;
}

/** Pure: where a blob's parts begin and end. A blob smaller than a part is one part; an empty blob has none. */
export function partBoundaries(size: number, partBytes: number = PART_BYTES): Part[] {
  if (partBytes < MIN_PART_BYTES) throw new Error("a part size below 5 MiB is refused by the registry (416)");
  const parts: Part[] = [];
  for (let start = 0; start < size; start += partBytes) parts.push({ start, end: Math.min(start + partBytes, size) });
  return parts;
}

/** A part's bytes as the `Content-Range` header names them: inclusive, no total. */
export function contentRange(part: Part): string {
  return `${part.start}-${part.end - 1}`;
}

/** The upload's final `PUT`: the location the registry handed back, with the blob's digest as a query parameter. */
export function appendDigest(location: string, digest: string): string {
  return `${location}${location.includes("?") ? "&" : "?"}digest=${encodeURIComponent(digest)}`;
}

/** A `Location` header may be relative to the registry; the absolute URL to follow. */
export function resolveLocation(location: string, requestUrl: string): string {
  return new URL(location, requestUrl).toString();
}
