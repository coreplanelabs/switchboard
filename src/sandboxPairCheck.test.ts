import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAIRS, imageTag, pairMismatches, sdkPin } from "../scripts/check-sandbox-pair.mjs";

// The image/SDK gate's decision, and the repository's own Workers against it.
// A Worker built on the cloudflare/sandbox image drives its container through
// the @cloudflare/sandbox SDK of the same version; #503 moved the cold
// sandbox Worker's SDK from 0.3 to 0.12 while its Dockerfile stayed at 0.3.7,
// and nothing failed until this check existed.

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

  it("fails a pin that differs from the tag (the #503 shape)", () => {
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

describe("the repository's sandbox-image Workers", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

  it("covers the cold sandbox and the resident", () => {
    expect(PAIRS.map((p) => p.label).sort()).toEqual(["deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
  });

  it("pin @cloudflare/sandbox to exactly the image tag they build FROM", () => {
    const observed = PAIRS.map(({ label, dockerfile, manifest }) => ({
      label,
      imageTag: imageTag(read(dockerfile)),
      sdkPin: sdkPin(JSON.parse(read(manifest)) as Parameters<typeof sdkPin>[0]),
    }));
    expect(pairMismatches(observed)).toEqual([]);
  });
});
