import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const SANDBOX = "deploy/cloudflare-sandbox/Dockerfile";
const RESIDENT = "deploy/cloudflare-resident/Dockerfile";
const EXECUTION_IMAGES = [SANDBOX, RESIDENT] as const;

// Feature: docs/reference/specs/execution.md item 10 — both execution images
// carry the same toolchain for what a run builds and looks at: python3, make
// and g++ (node-gyp rebuilds a native module — node-pty — from source in a
// cold sandbox and died on "no Python"), ffmpeg with libx264 (frames out of a
// video, video out of frames or a recording) and a headless Chromium through
// Playwright at an exact pin (screenshots, PDFs, recorded video; the apt
// `chromium` on Ubuntu 22.04 is a snap stub that does not run in a container).
// Static, like imageNode.test.ts: the image is built by check:image, and each
// claim below is also PROVEN at build time by a command in the layer itself —
// this file holds the two Dockerfiles to one shape and to each other.

/** The one apt set both images install for the toolchain, without recommends. */
const TOOLCHAIN_APT = ["python3", "make", "g++", "ffmpeg", "fonts-liberation", "fonts-noto-color-emoji"];
const PLAYWRIGHT_VERSION = "1.63.0";
const BROWSERS_PATH = "/opt/ms-playwright";
const GLOBAL_NODE_MODULES = "/usr/local/lib/node_modules";
const SCREENSHOT_PROOF = `playwright screenshot --viewport-size=640,480 'data:text/html,<h1>ok</h1>' /tmp/ok.png && test -s /tmp/ok.png`;

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The one RUN layer that installs playwright — the toolchain layer. */
function toolchainLayer(lines: string[]): string {
  return lines.find((l) => /^RUN\b.*\bnpm install -g playwright@/.test(l)) ?? "";
}

/** Every package named by an `apt-get install -y --no-install-recommends …` in a layer. */
function aptPackages(layer: string): string[] {
  const installs = layer.match(/apt-get install -y --no-install-recommends [^&;|]+/g) ?? [];
  return installs.flatMap((i) => i.split(/\s+/).slice(4));
}

/** The `KEY=value` pairs every ENV instruction before `index` sets. */
function envBefore(lines: string[], index: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines.slice(0, index)) {
    if (!/^ENV\b/.test(line)) continue;
    for (const m of line.matchAll(/([A-Z_][A-Z0-9_]*)=(\S+)/g)) env[m[1]] = m[2];
  }
  return env;
}

describe.each(EXECUTION_IMAGES)("%s", (path) => {
  const lines = instructions(read(path));
  const layer = toolchainLayer(lines);
  const layerIndex = lines.indexOf(layer);

  it("installs the toolchain's apt set in the playwright layer, without recommends", () => {
    expect(layer, "a RUN layer installs playwright").not.toBe("");
    const packages = aptPackages(layer);
    for (const name of TOOLCHAIN_APT) expect(packages, name).toContain(name);
  });

  it("pins playwright to an exact version by npm, globally", () => {
    expect(layer).toContain(`npm install -g playwright@${PLAYWRIGHT_VERSION}`);
  });

  it("sets PLAYWRIGHT_BROWSERS_PATH to /opt/ms-playwright BEFORE the install, so the browser lands outside root's home where every user can reach it", () => {
    expect(envBefore(lines, layerIndex).PLAYWRIGHT_BROWSERS_PATH).toBe(BROWSERS_PATH);
  });

  it("sets NODE_PATH to the global tree, so `require('playwright')` resolves from any working directory", () => {
    expect(envBefore(lines, lines.length).NODE_PATH).toBe(GLOBAL_NODE_MODULES);
  });

  it("installs chromium's headless shell only, with its system dependencies — no display, so the shell is the whole browser", () => {
    expect(layer).toContain("playwright install --with-deps --only-shell chromium");
  });

  it("opens the browser tree to every user, so an unprivileged user can drive it", () => {
    expect(layer).toContain(`chmod -R a+rX ${BROWSERS_PATH}`);
  });

  it("proves the native-module compilers at build time", () => {
    expect(layer).toContain("python3 --version");
    expect(layer).toContain("g++ --version");
    expect(layer).toContain("make --version");
  });

  it("proves ffmpeg by encoding a one-second test clip to h264 and decoding a frame back out of it", () => {
    expect(layer).toContain("ffmpeg -version");
    expect(layer).toContain("-f lavfi -i testsrc=duration=1:size=320x240:rate=10");
    expect(layer).toContain("-c:v libx264");
    expect(layer).toContain("-vf fps=1 /tmp/proof_%03d.png");
    expect(layer).toContain("test -s /tmp/proof_001.png");
  });

  it("proves the playwright CLI is on PATH at exactly the pin", () => {
    expect(layer).toContain(`playwright --version | grep -qx 'Version ${PLAYWRIGHT_VERSION}'`);
  });

  it("proves a real headless screenshot of a page to a non-empty png", () => {
    expect(layer).toContain(SCREENSHOT_PROOF);
  });

  it("drops the apt lists, apt's .deb archive, npm's cache and its own /tmp artefacts in the same layer", () => {
    // The base has no docker-clean hook: without `apt-get clean` the layer kept
    // 400 MB of .deb archives, and `npm install -g` leaves its cache under /root.
    expect(layer).toContain("apt-get clean && rm -rf /var/lib/apt/lists/* && npm cache clean --force");
    const cleanup = layer.lastIndexOf("rm -f /tmp/proof.mp4 /tmp/proof_*.png /tmp/ok.png");
    expect(cleanup, "the artefacts are removed").toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(layer.indexOf(SCREENSHOT_PROOF));
  });
});

describe("the two execution images carry one toolchain", () => {
  const layers = Object.fromEntries(EXECUTION_IMAGES.map((path) => [path, toolchainLayer(instructions(read(path)))]));

  it("the same apt set", () => {
    const sets = EXECUTION_IMAGES.map((path) =>
      aptPackages(layers[path])
        .filter((p) => TOOLCHAIN_APT.includes(p))
        .sort(),
    );
    expect(sets[0]).toEqual([...TOOLCHAIN_APT].sort());
    expect(sets[1]).toEqual(sets[0]);
  });

  it("the same playwright pin, so a release ships one browser everywhere", () => {
    const pins = EXECUTION_IMAGES.map((path) => /npm install -g playwright@(\S+)/.exec(layers[path])?.[1]);
    expect(new Set(pins).size).toBe(1);
    expect(pins[0]).toBe(PLAYWRIGHT_VERSION);
  });
});

describe("the resident image", () => {
  const lines = instructions(read(RESIDENT));

  it("runs the screenshot proof a second time as worker1, after the user pool exists — the build proves an unprivileged thread user can drive the browser", () => {
    const users = lines.findIndex((l) => /^RUN\b.*\buseradd\b/.test(l));
    const asWorker = lines.findIndex((l) => /^RUN su -s \/bin\/bash worker1 -c "playwright screenshot /.test(l));
    expect(users, "the user pool layer").toBeGreaterThan(-1);
    expect(asWorker, "a screenshot proof run through su as worker1").toBeGreaterThan(users);
    expect(lines[asWorker]).toContain(SCREENSHOT_PROOF);
    expect(lines[asWorker]).toContain("rm -f /tmp/ok.png");
  });
});
