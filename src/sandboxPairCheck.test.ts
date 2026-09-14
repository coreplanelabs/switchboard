import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PAIRS,
  imageTag,
  installAdvisories,
  installedSdkVersion,
  lockfileSdkVersion,
  pairMismatches,
  sdkPin,
} from "../scripts/check-sandbox-pair.mjs";

// The image/SDK gate's decision, and the repository's own Workers against it.
// A Worker built on the cloudflare/sandbox image drives its container through
// the @cloudflare/sandbox SDK of the same version. Nothing else fails when a
// dependency bump moves a Worker's SDK pin (0.3 → 0.12) while its Dockerfile
// stays at the old tag — the mismatch surfaces only at run time, so the pin must
// equal the tag and this check is what enforces it. The gate reads committed
// files only (Dockerfile, package.json, package-lock.json); the installed
// node_modules tree feeds an advisory, never a failure.

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

describe("check-sandbox-pair lockfileSdkVersion", () => {
  it("prefers the workspace's nested lockfile entry over the root's hoisted one", () => {
    const lockfile = {
      packages: {
        "node_modules/@cloudflare/sandbox": { version: "0.13.0-next.751.1" },
        "deploy/cloudflare-sandbox/node_modules/@cloudflare/sandbox": { version: "0.12.9" },
      },
    };
    expect(lockfileSdkVersion(lockfile, "deploy/cloudflare-sandbox")).toBe("0.12.9");
    expect(lockfileSdkVersion(lockfile, "deploy/cloudflare-resident")).toBe("0.13.0-next.751.1");
  });

  it("is null when the lockfile has no entry at all", () => {
    expect(lockfileSdkVersion({ packages: {} }, "deploy/cloudflare-sandbox")).toBeNull();
    expect(lockfileSdkVersion({}, "deploy/cloudflare-sandbox")).toBeNull();
  });
});

describe("check-sandbox-pair pairMismatches", () => {
  it("passes when every pin equals its image tag and the lockfile agrees", () => {
    expect(
      pairMismatches([
        { label: "a", imageTag: "0.3.7", sdkPin: "0.3.7", locked: "0.3.7" },
        { label: "b", imageTag: "0.13.0-next.751.1", sdkPin: "0.13.0-next.751.1", locked: "0.13.0-next.751.1" },
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

  it("fails a lockfile that resolves the pin to a different version, or has no entry", () => {
    const problems = pairMismatches([
      { label: "stale-lock", imageTag: "0.12.9", sdkPin: "0.12.9", locked: "0.3.7" },
      { label: "no-lock", imageTag: "0.12.9", sdkPin: "0.12.9", locked: null },
    ]);
    expect(problems.map((p) => p.label)).toEqual(["stale-lock", "no-lock"]);
    expect(problems[0].reason).toContain("package-lock.json resolves it to 0.3.7");
    expect(problems[0].reason).toContain("npm install");
    expect(problems[1].reason).toContain("no entry");
  });

  it("names a Dockerfile without the image and a manifest without the SDK", () => {
    const problems = pairMismatches([
      { label: "no-image", imageTag: null, sdkPin: "0.3.7" },
      { label: "no-sdk", imageTag: "0.3.7", sdkPin: null },
    ]);
    expect(problems.map((p) => p.label)).toEqual(["no-image", "no-sdk"]);
  });
});

// The lockfile can pin one version while the tree on disk holds another — a
// stale install `npm ci` fixes. That is local drift, not a committed mismatch:
// it earns a one-line advisory naming the workspace and both versions, never a
// failure.
describe("check-sandbox-pair installAdvisories", () => {
  it("says nothing when the installed SDK equals the lockfile, or nothing is installed (a fresh clone)", () => {
    expect(
      installAdvisories([
        { label: "a", locked: "0.12.9", installed: "0.12.9" },
        { label: "b", locked: "0.13.0-next.751.1", installed: null },
      ]),
    ).toEqual([]);
  });

  it("emits one line naming the workspace, both versions, and npm ci when the install drifts", () => {
    const advisories = installAdvisories([
      { label: "deploy/cloudflare-resident", locked: "0.12.9", installed: "0.13.0-next.751.1" },
    ]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).not.toContain("\n");
    expect(advisories[0]).toContain("deploy/cloudflare-resident");
    expect(advisories[0]).toContain("0.13.0-next.751.1");
    expect(advisories[0]).toContain("0.12.9");
    expect(advisories[0]).toContain("npm ci");
  });

  it("fixture: a lockfile pinning one version with another installed is an advisory, not a failure", () => {
    // A miniature repo on disk: the lockfile pins 0.12.9 for the Worker while
    // the installed package.json under its node_modules carries 0.13.0-next.751.1.
    const root = mkdtempSync(join(tmpdir(), "sandbox-pair-"));
    try {
      const worker = "deploy/cloudflare-resident";
      mkdirSync(join(root, worker, "node_modules", "@cloudflare", "sandbox"), { recursive: true });
      writeFileSync(
        join(root, worker, "package.json"),
        JSON.stringify({ dependencies: { "@cloudflare/sandbox": "0.12.9" } }),
      );
      writeFileSync(
        join(root, worker, "node_modules", "@cloudflare", "sandbox", "package.json"),
        JSON.stringify({ name: "@cloudflare/sandbox", version: "0.13.0-next.751.1" }),
      );
      const lockfile = { packages: { "node_modules/@cloudflare/sandbox": { version: "0.12.9" } } };

      const manifestPath = join(root, worker, "package.json");
      const observed = {
        label: worker,
        imageTag: "0.12.9",
        sdkPin: sdkPin(JSON.parse(readFileSync(manifestPath, "utf8")) as Parameters<typeof sdkPin>[0]),
        locked: lockfileSdkVersion(lockfile, worker),
        installed: installedSdkVersion(manifestPath, root),
      };
      expect(observed.installed).toBe("0.13.0-next.751.1");
      expect(pairMismatches([observed])).toEqual([]); // committed truth agrees — no failure
      const advisories = installAdvisories([observed]);
      expect(advisories).toHaveLength(1);
      expect(advisories[0]).toContain(worker);
      expect(advisories[0]).toContain("npm ci");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the repository's sandbox-image Workers", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

  it("covers the cold sandbox and the resident", () => {
    expect(PAIRS.map((p) => p.label).sort()).toEqual(["deploy/cloudflare-resident", "deploy/cloudflare-sandbox"]);
  });

  it("pin @cloudflare/sandbox to exactly the image tag they build FROM, and the lockfile agrees", () => {
    const lockfile = JSON.parse(read("package-lock.json")) as Parameters<typeof lockfileSdkVersion>[0];
    const observed = PAIRS.map(({ label, dockerfile, manifest }) => ({
      label,
      imageTag: imageTag(read(dockerfile)),
      sdkPin: sdkPin(JSON.parse(read(manifest)) as Parameters<typeof sdkPin>[0]),
      locked: lockfileSdkVersion(lockfile, label),
    }));
    expect(pairMismatches(observed)).toEqual([]);
  });
});

// installedSdkVersion never gates: it only feeds the advisory, so it must
// tolerate any state of the tree.
describe("check-sandbox-pair installedSdkVersion", () => {
  it("reads the version a Worker would bundle: its nested install first, else the root's, else null", () => {
    const cold = installedSdkVersion("deploy/cloudflare-sandbox/package.json");
    const resident = installedSdkVersion("deploy/cloudflare-resident/package.json");
    expect(cold === null || /^\d/.test(cold)).toBe(true);
    expect(resident === null || /^\d/.test(resident)).toBe(true);
    expect(installedSdkVersion("does/not/exist/package.json")).toBeNull();
  });
});
