import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { floatingImagePins, imagePins } from "./imagePins.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const RESIDENT = "deploy/cloudflare-resident/Dockerfile";
const EXECUTION_IMAGES = [RESIDENT, "deploy/cloudflare-sandbox/Dockerfile"] as const;
const IMAGES = [...EXECUTION_IMAGES, "Dockerfile"] as const;

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// Feature: docs/reference/specs/execution.md item 10 — the execution images' toolchain is
// PINNED. `RUN npm install -g pnpm@latest yarn@latest` in the resident image
// meant the pnpm major changed with the image, not with a commit: a routine
// rebuild silently moved pnpm 10 → 11, which stopped reading `package.json`'s
// `pnpm` field (overrides, patches, build allowlist). This fence is the reason
// that cannot recur silently.

describe("imagePins (parser)", () => {
  it("reads an exact global install as pinned", () => {
    expect(imagePins("RUN npm install -g pnpm@10.34.5 yarn@1.22.22\n")).toEqual([
      { tool: "pnpm", spec: "10.34.5", line: 1, floating: false },
      { tool: "yarn", spec: "1.22.22", line: 1, floating: false },
    ]);
  });

  it("flags @latest, a range, and a bare name with no version", () => {
    const pins = imagePins(
      "RUN npm i -g pnpm@latest\nRUN npm install -g yarn@^1\nRUN corepack prepare pnpm --activate\n",
    );
    expect(pins.map((p) => [p.tool, p.spec, p.floating])).toEqual([
      ["pnpm", "latest", true],
      ["yarn", "^1", true],
      ["pnpm", "", true],
    ]);
  });

  it("flags a floating FROM tag and accepts an exact one", () => {
    expect(floatingImagePins("FROM docker.io/cloudflare/sandbox:latest\n").map((p) => p.tool)).toEqual([
      "docker.io/cloudflare/sandbox",
    ]);
    expect(floatingImagePins("FROM docker.io/cloudflare/sandbox\n").map((p) => p.tool)).toEqual([
      "docker.io/cloudflare/sandbox",
    ]);
    expect(floatingImagePins("FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1\n")).toEqual([]);
  });

  it("reads through a line continuation, and ignores flags and shell operators", () => {
    const pins = imagePins("RUN set -eux; \\\n  npm install -g --no-audit pnpm@10.34.5 && echo done\n");
    expect(pins).toEqual([{ tool: "pnpm", spec: "10.34.5", line: 2, floating: false }]);
  });

  it("does not mistake a comment mentioning @latest for an instruction", () => {
    expect(imagePins("# pnpm@latest used to be installed here — see item 10\nFROM node:24.0.0\n")).toEqual([
      { tool: "node", spec: "24.0.0", line: 2, floating: false },
    ]);
  });

  it("leaves a major-pinned base tag alone — only an absent or `latest` tag floats", () => {
    expect(floatingImagePins("FROM node:22-slim\n")).toEqual([]);
  });
});

describe.each(IMAGES)("%s", (path) => {
  it("pins every toolchain version — no floating tag reaches a built image", () => {
    const pins = floatingImagePins(readFileSync(resolve(ROOT, path), "utf8"));
    expect(pins.map((p) => `line ${p.line}: ${p.tool}@${p.spec || "(no version)"}`)).toEqual([]);
  });
});

// The browser is a toolchain version like pnpm's: `playwright@latest` would
// make the Chromium a run drives a property of the last image build, and a
// Playwright minor moves the browser build with it.
describe("the execution images' playwright", () => {
  const pins = EXECUTION_IMAGES.map((path) => imagePins(read(path)).filter((p) => p.tool === "playwright"));

  it("is one exact global install per image", () => {
    for (const [i, path] of EXECUTION_IMAGES.entries()) {
      expect(pins[i].length, `${path} installs playwright once`).toBe(1);
      expect(pins[i][0].floating, `${path}: playwright@${pins[i][0]?.spec}`).toBe(false);
    }
  });

  it("names the same version in both images", () => {
    expect(pins[0][0]?.spec).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(pins.map((p) => p[0]?.spec)).size).toBe(1);
  });
});

// bun is the one package manager the cloudflare/sandbox bases already ship —
// a real binary at /usr/local/bin/bun, on the 1.3 line — and the one whose
// baked version is the version that RUNS: unlike pnpm, bun does not
// self-manage `packageManager`, so a repo pinning a newer bun than the image
// fails its own lockfile at every install (a `bun.lock` at lockfileVersion 3
// — bun 1.4's stamp for scoped `overrides` — is "Unknown lockfile version"
// to the base's 1.3.x), and every resident attach to such a repo fell to a
// cold sandbox that way. So bun is installed at an
// exact pin like pnpm's, in both execution images, and the layer proves the
// bun on PATH IS the pin — after removing the base's binary, which npm would
// not write its `bun` link over, and which would otherwise stay behind as a
// second bun to find.
describe("the execution images' bun", () => {
  const sources = EXECUTION_IMAGES.map(read);
  const pins = sources.map((s) => imagePins(s).filter((p) => p.tool === "bun"));
  /** The version as the Dockerfile's `grep -x` pattern spells it: every regex metacharacter escaped (a semver has only the dots). */
  const escaped = (version: string) => version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("is one exact global install per image — the pin, not the base's binary, is the bun a run's install gets", () => {
    for (const [i, path] of EXECUTION_IMAGES.entries()) {
      expect(pins[i].length, `${path} installs bun once`).toBe(1);
      expect(pins[i][0].floating, `${path}: bun@${pins[i][0]?.spec}`).toBe(false);
    }
  });

  it("names the same version in both images", () => {
    expect(pins[0][0]?.spec).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(pins.map((p) => p[0]?.spec)).size).toBe(1);
  });

  it("removes the base's own bun before the install and proves the bun on PATH is the pin, in the same layer", () => {
    for (const [i, path] of EXECUTION_IMAGES.entries()) {
      const layer = instructions(sources[i]).find((l) => /^RUN\b.*\bnpm install -g .*\bbun@/.test(l)) ?? "";
      expect(layer, `${path}: a RUN layer installs bun`).not.toBe("");
      const removal = layer.indexOf("rm -f /usr/local/bin/bun");
      expect(removal, `${path}: the base's binary is removed`).toBeGreaterThan(-1);
      expect(removal, `${path}: removed BEFORE the install`).toBeLessThan(layer.indexOf("npm install -g"));
      // The npm package is a placeholder until its postinstall moves the real
      // binary in; npm's global installs are growing an allowlist for install
      // scripts, so the one this layer needs is allowed by name.
      expect(layer, `${path}: bun's postinstall is allowed by name`).toContain("--allow-scripts=bun");
      expect(layer).toContain(`bun --version | grep -qx '${escaped(pins[i][0]?.spec ?? "")}'`);
    }
  });

  it("the resident image proves it once more as worker1 after the pool exists — a thread's install runs through the same su", () => {
    const resident = EXECUTION_IMAGES.indexOf(RESIDENT);
    const lines = instructions(sources[resident]);
    const pool = lines.findIndex((l) => /useradd -m -u "\$\(\(2000 \+ i\)\)"/.test(l));
    const asWorker = lines.findIndex((l) => /^RUN su -s \/bin\/bash worker1 -c ".*bun --version \| grep -qx/.test(l));
    expect(pool, "the user pool layer").toBeGreaterThan(-1);
    expect(asWorker, "a bun version proof run through su as worker1").toBeGreaterThan(pool);
    expect(lines[asWorker]).toContain(`bun --version | grep -qx '${escaped(pins[resident][0]?.spec ?? "")}'`);
  });
});
