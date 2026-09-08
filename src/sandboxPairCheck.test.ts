import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PAIRS,
  imageTag,
  installMismatches,
  installedSdkVersion,
  pairMismatches,
  sdkPin,
} from "../scripts/check-sandbox-pair.mjs";

// The image/SDK gate's decision, and the repository's own Workers against it.
// A Worker built on the cloudflare/sandbox image drives its container through
// the @cloudflare/sandbox SDK of the same version. Nothing else fails when a
// dependency bump moves a Worker's SDK pin (0.3 → 0.12) while its Dockerfile
// stays at the old tag — the mismatch surfaces only at run time, so the pin must
// equal the tag and this check is what enforces it.

describe("check-sandbox-pair imageTag", () => {
  it("reads the tag from a docker.io-qualified FROM line", () => {
    expect(imageTag("# comment\nFROM docker.io/cloudflare/sandbox:0.13.0-next.751.1\nRUN true\n")).toBe(
      "0.13.0-next.751.1",
    );
  });

  it("reads the tag from an unqualified FROM line", () => {
    expect(imageTag("FROM cloudflare/sandbox:0.3.7 AS base\n")).toBe("0.3.7");
  });

  it("is null when the Dockerfile builds from something else", () => {
    expect(imageTag("FROM node:22-slim\n")).toBeNull();
  });
});

describe("check-sandbox-pair sdkPin", () => {
  it("reads a runtime dependency", () => {
    expect(sdkPin({ dependencies: { "@cloudflare/sandbox": "0.3.7" } })).toBe("0.3.7");
  });

  it("falls back to a dev dependency and is null when absent", () => {
    expect(sdkPin({ devDependencies: { "@cloudflare/sandbox": "1.0.0" } })).toBe("1.0.0");
    expect(sdkPin({ dependencies: { wrangler: "^4" } })).toBeNull();
  });
});

describe("check-sandbox-pair pairMismatches", () => {
  it("passes when every pin equals its image tag exactly", () => {
    expect(
      pairMismatches([
        { label: "a", imageTag: "0.3.7", sdkPin: "0.3.7" },
        { label: "b", imageTag: "0.13.0-next.751.1", sdkPin: "0.13.0-next.751.1" },
      ]),
    ).toEqual([]);
  });

  it("fails a pin that differs from the tag (an SDK bump without the image)", () => {
    const problems = pairMismatches([{ label: "cold", imageTag: "0.3.7", sdkPin: "0.12.9" }]);
    expect(problems).toHaveLength(1);
    expect(problems[0].label).toBe("cold");
    expect(problems[0].reason).toContain('"0.12.9"');
    expect(problems[0].reason).toContain("cloudflare/sandbox:0.3.7");
  });

  it("fails a range pin even when it would resolve to the tag", () => {
    const problems = pairMismatches([{ label: "cold", imageTag: "0.3.7", sdkPin: "^0.3.7" }]);
    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toContain("range");
  });

  it("names a Dockerfile without the image and a manifest without the SDK", () => {
    const problems = pairMismatches([
      { label: "no-image", imageTag: null, sdkPin: "0.3.7" },
      { label: "no-sdk", imageTag: "0.3.7", sdkPin: null },
    ]);
    expect(problems.map((p) => p.label)).toEqual(["no-image", "no-sdk"]);
  });
});

// The pin and the lockfile can agree on 0.3.7 while a stale nested
// node_modules holds 0.12.9 — wrangler bundles what is INSTALLED, so a deploy
// from that tree would ship an SDK the image does not speak.
describe("check-sandbox-pair installMismatches", () => {
  it("passes when the installed SDK equals the pin, and when nothing is installed yet (a fresh clone)", () => {
    expect(
      installMismatches([
        { label: "a", sdkPin: "0.12.9", installed: "0.12.9" },
        { label: "b", sdkPin: "0.13.0-next.751.1", installed: null },
      ]),
    ).toEqual([]);
  });

  it("fails an installed SDK that differs from the pin and says how to fix it", () => {
    const problems = installMismatches([{ label: "cold", sdkPin: "0.3.7", installed: "0.12.9" }]);
    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toContain("0.12.9 is installed");
    expect(problems[0].reason).toContain("pins 0.3.7");
    expect(problems[0].reason).toContain("npm ci");
  });

  it("reads the version a Worker would bundle: its nested install first, else the root's", () => {
    // this repository: the cold sandbox nests its own pin; the resident's is hoisted
    const cold = installedSdkVersion("deploy/cloudflare-sandbox/package.json");
    const resident = installedSdkVersion("deploy/cloudflare-resident/package.json");
    expect(cold === null || /^\d/.test(cold)).toBe(true);
    expect(resident === null || /^\d/.test(resident)).toBe(true);
    expect(installedSdkVersion("does/not/exist/package.json")).toBeNull();
  });
});

describe("the repository's sandbox-image Workers", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

  it("covers the cold sandbox and the resident", () => {
    expect(PAIRS.map((p) => p.label).sort()).toEqual(["deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
  });

  it("pin @cloudflare/sandbox to exactly the image tag they build FROM, and the installed SDK matches", () => {
    const observed = PAIRS.map(({ label, dockerfile, manifest }) => ({
      label,
      imageTag: imageTag(read(dockerfile)),
      sdkPin: sdkPin(JSON.parse(read(manifest)) as Parameters<typeof sdkPin>[0]),
      installed: installedSdkVersion(new URL(manifest, `file://${root}`).pathname),
    }));
    expect(pairMismatches(observed)).toEqual([]);
    expect(installMismatches(observed)).toEqual([]);
  });
});
