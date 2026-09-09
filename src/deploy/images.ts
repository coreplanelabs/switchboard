// The three container images — bot, resident, sandbox — and the two ways a
// Worker's `image` reaches wrangler (docs/reference/specs/release-and-deploy.md
// items 20, 21, 25, 26; docs/decisions/0027-images-copied-into-the-account-registry.md).
//
// A release publishes each image to GitHub Container Registry under the names
// `project.json` records (`images`). Cloudflare cannot pull from that registry,
// and an image it pulls from any external registry is fetched uncached on every
// container start, so an installation that deploys published images COPIES them
// once per version into its own account registry (`deploy images`: pull, tag,
// `wrangler containers push`) and its Worker configs reference the copy —
// `registry.cloudflare.com/<account>/<name>:<version>`. That is the profile's
// `images: "registry"` mode. The other mode, `build`, is the checkout's: each
// Worker's `image` is its Dockerfile and wrangler builds it at deploy time.
//
// Pure: the names, the references, the planner over a registry listing, and the
// parser for wrangler's `images list --json`. Docker and wrangler run in
// src/deploy/imagesHost.ts.

import type { DeploymentProfile } from "./profile.js";

/** The Workers with a container image, in deploy order (the memory Worker has none). */
export const IMAGE_KINDS = ["bot", "resident", "sandbox"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

/** Each image's Dockerfile relative to its Worker's directory — what `image`
 *  renders to in `build` mode, and the build context CI proves (`check:image`). */
export const DOCKERFILES: Readonly<Record<ImageKind, string>> = {
  bot: "../../Dockerfile",
  resident: "./Dockerfile",
  sandbox: "./Dockerfile",
};

/** Cloudflare's managed registry — the one Containers pull from cached and pre-fetched. */
export const ACCOUNT_REGISTRY = "registry.cloudflare.com";

/** A release version as the tags carry it: `1.2.3`, or a pre-release `1.2.3-rc.1`. */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The images a release published: the version and each image's registry name
 *  (project.json `images`, `ghcr.io/<owner>/<repo>[-resident|-sandbox]`). */
export interface PublishedImages {
  version: string;
  names: Readonly<Record<ImageKind, string>>;
}

/** Pure: the three published names from project.json (parsed), or the problem with the facts. */
export function imagesFromFacts(
  facts: unknown,
): { ok: true; names: Record<ImageKind, string> } | { ok: false; problem: string } {
  const f = facts as { images?: unknown } | null;
  const images = f?.images as Record<string, unknown> | undefined;
  if (images === null || typeof images !== "object") return { ok: false, problem: "`images` is missing" };
  const names = {} as Record<ImageKind, string>;
  for (const kind of IMAGE_KINDS) {
    const name = images[kind];
    if (typeof name !== "string" || name === "") return { ok: false, problem: `\`images.${kind}\` is missing` };
    names[kind] = name;
  }
  return { ok: true, names };
}

/** The facts file (project.json), repo-relative — the path the commands ask their file access for, and what errors name. */
export const PROJECT_FACTS_FILE = "project.json";

/** Pure: the release's images from the facts file's text (undefined when absent) and the version
 *  they were published at — the CLI's own, or the one an operator names. Every problem names the file. */
export function publishedImagesFrom(
  factsText: string | undefined,
  version: string,
): { ok: true; images: PublishedImages } | { ok: false; problem: string } {
  if (factsText === undefined) return { ok: false, problem: `${PROJECT_FACTS_FILE}: no such file` };
  let facts: unknown;
  try {
    facts = JSON.parse(factsText);
  } catch {
    return { ok: false, problem: `${PROJECT_FACTS_FILE}: not JSON` };
  }
  const names = imagesFromFacts(facts);
  if (!names.ok) return { ok: false, problem: `${PROJECT_FACTS_FILE}: ${names.problem}` };
  return { ok: true, images: { version, names: names.names } };
}

/** `ghcr.io/owner/switchboard-resident` → `switchboard-resident`: the image's
 *  repository name inside the account registry, where the owner is the account. */
export function registryName(published: string): string {
  return published.slice(published.lastIndexOf("/") + 1);
}

/** The reference a Worker deploys in `registry` mode. */
export function accountRegistryImage(account: string, name: string, version: string): string {
  return `${ACCOUNT_REGISTRY}/${account}/${name}:${version}`;
}

/** Pure: what one Worker's `image` renders to under the profile's mode. */
export function containerImage(
  kind: ImageKind,
  profile: Pick<DeploymentProfile, "account" | "images">,
  published: PublishedImages,
): string {
  return profile.images === "build"
    ? DOCKERFILES[kind]
    : accountRegistryImage(profile.account, registryName(published.names[kind]), published.version);
}

/** One row of `wrangler containers images list --json`: the name without the account prefix, and its tags. */
export interface RegistryImage {
  name: string;
  tags: string[];
}

/** Pure: wrangler's listing, or `undefined` for any other shape. */
export function parseRegistryListing(json: unknown): RegistryImage[] | undefined {
  if (!Array.isArray(json)) return undefined;
  const out: RegistryImage[] = [];
  for (const row of json) {
    const r = row as { name?: unknown; tags?: unknown } | null;
    if (typeof r?.name !== "string" || !Array.isArray(r.tags)) return undefined;
    out.push({ name: r.name, tags: r.tags.filter((t): t is string => typeof t === "string") });
  }
  return out;
}

/** Pure: does the account registry hold `<name>:<version>`? */
export function registryHas(listing: readonly RegistryImage[], name: string, version: string): boolean {
  return listing.some((r) => r.name === name && r.tags.includes(version));
}

/** One image to copy: pull `source`, tag it `localTag` (a bare name, so wrangler
 *  namespaces it under the account instead of pushing it back where it came
 *  from), push it, and it appears as `target`. */
export interface ImageCopy {
  kind: ImageKind;
  source: string;
  localTag: string;
  target: string;
  name: string;
  version: string;
}

export interface ImagesPlan {
  version: string;
  account: string;
  /** Every image at the version: where it is published, where it lands, and whether the account registry already has it. */
  images: { kind: ImageKind; source: string; target: string; present: boolean }[];
  /** The images not yet present — what `deploy images` copies, in order. */
  copy: ImageCopy[];
}

/** Pure: which images the account registry already holds at the version and which to copy. */
export function planImageCopies(
  published: PublishedImages,
  account: string,
  listing: readonly RegistryImage[],
): ImagesPlan {
  const images = IMAGE_KINDS.map((kind) => {
    const name = registryName(published.names[kind]);
    return {
      kind,
      name,
      source: `${published.names[kind]}:${published.version}`,
      target: accountRegistryImage(account, name, published.version),
      present: registryHas(listing, name, published.version),
    };
  });
  return {
    version: published.version,
    account,
    images: images.map(({ kind, source, target, present }) => ({ kind, source, target, present })),
    copy: images
      .filter((i) => !i.present)
      .map(({ kind, source, target, name }) => ({
        kind,
        source,
        localTag: `${name}:${published.version}`,
        target,
        name,
        version: published.version,
      })),
  };
}

/** What `deploy images` reports for one image. */
export type ImageStatus = "present" | "copied" | "would copy";

/** The one refusal that has a place to go: no Docker where the command runs. */
export function dockerUnavailableProblem(said: string): string {
  return `docker is not available here${said ? ` (${said})` : ""} — \`deploy images\` pulls and pushes with Docker; run it where Docker is: the reusable deploy workflow (.github/workflows/deploy-production.yml), whose runner has it`;
}
