import { describe, expect, it } from "vitest";
import {
  accountRegistryImage,
  containerImage,
  DOCKERFILES,
  IMAGE_KINDS,
  imagesFromFacts,
  parseRegistryListing,
  planImageCopies,
  publishedImagesFrom,
  registryHas,
  registryName,
  VERSION,
} from "./images.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES, TEST_REGISTRY_PROFILE } from "./testing/profile.js";

// Feature: docs/reference/specs/release-and-deploy.md items 25–26 — the three
// published images, the reference each Worker deploys under the profile's image
// mode, and the copy plan the copy runs from a registry listing. Pure: nothing
// here names a real account or moves anything.

const ACCOUNT = TEST_PROFILE.account;

describe("the published images", () => {
  it("reads the three names from project.json's `images`, and names the missing fact — the map or one kind", () => {
    expect(imagesFromFacts({ images: TEST_PUBLISHED_IMAGES.names })).toEqual({
      ok: true,
      names: TEST_PUBLISHED_IMAGES.names,
    });
    expect(imagesFromFacts({})).toEqual({ ok: false, problem: "`images` is missing" });
    expect(imagesFromFacts(null)).toEqual({ ok: false, problem: "`images` is missing" });
    const { sandbox: _sandbox, ...two } = TEST_PUBLISHED_IMAGES.names;
    expect(imagesFromFacts({ images: two })).toEqual({ ok: false, problem: "`images.sandbox` is missing" });
    expect(imagesFromFacts({ images: { ...TEST_PUBLISHED_IMAGES.names, bot: "" } })).toEqual({
      ok: false,
      problem: "`images.bot` is missing",
    });
  });

  it("from the facts file's text at a version: a missing or non-JSON file is a problem naming project.json", () => {
    expect(publishedImagesFrom(JSON.stringify({ images: TEST_PUBLISHED_IMAGES.names }), "2.0.0")).toEqual({
      ok: true,
      images: { version: "2.0.0", names: TEST_PUBLISHED_IMAGES.names },
    });
    expect(publishedImagesFrom(undefined, "2.0.0")).toEqual({ ok: false, problem: "project.json: no such file" });
    expect(publishedImagesFrom("{ not json", "2.0.0")).toEqual({ ok: false, problem: "project.json: not JSON" });
    expect(publishedImagesFrom("{}", "2.0.0")).toEqual({ ok: false, problem: "project.json: `images` is missing" });
  });

  it("a release version is three numbers, with an optional pre-release; a tag with a `v`, `latest` or a sha is not one", () => {
    for (const ok of ["1.2.3", "0.0.1", "10.20.30", "1.2.3-rc.1"]) expect(VERSION.test(ok), ok).toBe(true);
    for (const bad of ["v1.2.3", "latest", "1.2", "abc1234", "1.2.3 ", ""]) expect(VERSION.test(bad), bad).toBe(false);
  });
});

describe("the reference a Worker deploys", () => {
  it("in `build` mode each image Worker's Dockerfile, relative to its directory — the bot's at the repository root", () => {
    expect(IMAGE_KINDS).toEqual(["bot", "resident", "sandbox"]);
    expect(DOCKERFILES).toEqual({ bot: "../../Dockerfile", resident: "./Dockerfile", sandbox: "./Dockerfile" });
    for (const kind of IMAGE_KINDS)
      expect(containerImage(kind, TEST_PROFILE, TEST_PUBLISHED_IMAGES)).toBe(DOCKERFILES[kind]);
  });

  it("in `registry` mode the account registry's copy: `registry.cloudflare.com/<account>/<name>:<version>`, the name the published image's last segment", () => {
    expect(registryName("ghcr.io/example/switchboard-resident")).toBe("switchboard-resident");
    expect(registryName("switchboard")).toBe("switchboard");
    expect(accountRegistryImage(ACCOUNT, "switchboard", "1.2.3")).toBe(
      `registry.cloudflare.com/${ACCOUNT}/switchboard:1.2.3`,
    );
    expect(IMAGE_KINDS.map((kind) => containerImage(kind, TEST_REGISTRY_PROFILE, TEST_PUBLISHED_IMAGES))).toEqual([
      `registry.cloudflare.com/${ACCOUNT}/switchboard:1.2.3`,
      `registry.cloudflare.com/${ACCOUNT}/switchboard-resident:1.2.3`,
      `registry.cloudflare.com/${ACCOUNT}/switchboard-sandbox:1.2.3`,
    ]);
    // Another owner's fork publishes under its own name; the account registry copy keeps only the image's name.
    const fork = {
      ...TEST_PUBLISHED_IMAGES,
      names: { ...TEST_PUBLISHED_IMAGES.names, bot: "ghcr.io/someone/switchboard" },
    };
    expect(containerImage("bot", TEST_REGISTRY_PROFILE, fork)).toBe(
      `registry.cloudflare.com/${ACCOUNT}/switchboard:1.2.3`,
    );
  });
});

describe("the account registry listing", () => {
  const listing = [
    { name: "switchboard", tags: ["1.2.2", "1.2.3", "latest"] },
    { name: "switchboard-resident", tags: ["1.2.2"] },
    { name: "unrelated", tags: ["1.2.3"] },
  ];

  it("parses wrangler's `images list --json` rows (name + tags) and refuses any other shape", () => {
    expect(parseRegistryListing(listing)).toEqual(listing);
    expect(parseRegistryListing([{ name: "x", tags: ["1", 2, "3"] }])).toEqual([{ name: "x", tags: ["1", "3"] }]);
    expect(parseRegistryListing([])).toEqual([]);
    expect(parseRegistryListing({ name: "x", tags: [] })).toBeUndefined();
    expect(parseRegistryListing([{ name: "x" }])).toBeUndefined();
    expect(parseRegistryListing([null])).toBeUndefined();
    expect(parseRegistryListing("text")).toBeUndefined();
  });

  it("holds `<name>:<version>` when that name lists that tag — another name's tag or another version does not count", () => {
    expect(registryHas(listing, "switchboard", "1.2.3")).toBe(true);
    expect(registryHas(listing, "switchboard-resident", "1.2.3")).toBe(false);
    expect(registryHas(listing, "switchboard-sandbox", "1.2.3")).toBe(false);
    expect(registryHas([], "switchboard", "1.2.3")).toBe(false);
  });

  it("plans the copies: every image at the version with where it comes from and where it lands, and only the absent ones to copy, in deploy order", () => {
    const plan = planImageCopies(TEST_PUBLISHED_IMAGES, ACCOUNT, listing);
    expect(plan.version).toBe("1.2.3");
    expect(plan.account).toBe(ACCOUNT);
    expect(plan.images).toEqual([
      {
        kind: "bot",
        source: "ghcr.io/example/switchboard:1.2.3",
        target: `registry.cloudflare.com/${ACCOUNT}/switchboard:1.2.3`,
        present: true,
      },
      {
        kind: "resident",
        source: "ghcr.io/example/switchboard-resident:1.2.3",
        target: `registry.cloudflare.com/${ACCOUNT}/switchboard-resident:1.2.3`,
        present: false,
      },
      {
        kind: "sandbox",
        source: "ghcr.io/example/switchboard-sandbox:1.2.3",
        target: `registry.cloudflare.com/${ACCOUNT}/switchboard-sandbox:1.2.3`,
        present: false,
      },
    ]);
    // Each copy carries the bare name and the version it lands under in the account registry.
    expect(plan.copy).toEqual([
      {
        kind: "resident",
        source: "ghcr.io/example/switchboard-resident:1.2.3",
        target: `registry.cloudflare.com/${ACCOUNT}/switchboard-resident:1.2.3`,
        name: "switchboard-resident",
        version: "1.2.3",
      },
      {
        kind: "sandbox",
        source: "ghcr.io/example/switchboard-sandbox:1.2.3",
        target: `registry.cloudflare.com/${ACCOUNT}/switchboard-sandbox:1.2.3`,
        name: "switchboard-sandbox",
        version: "1.2.3",
      },
    ]);
    // Everything present: nothing to copy. Nothing present: all three.
    const all = [...IMAGE_KINDS].map((k) => ({ name: registryName(TEST_PUBLISHED_IMAGES.names[k]), tags: ["1.2.3"] }));
    expect(planImageCopies(TEST_PUBLISHED_IMAGES, ACCOUNT, all).copy).toEqual([]);
    expect(planImageCopies(TEST_PUBLISHED_IMAGES, ACCOUNT, []).copy.map((c) => c.kind)).toEqual([...IMAGE_KINDS]);
  });
});
