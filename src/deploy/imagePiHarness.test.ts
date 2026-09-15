import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { imagePins } from "./imagePins.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const BOT = "Dockerfile";
const SANDBOX = "deploy/cloudflare-sandbox/Dockerfile";
const RESIDENT = "deploy/cloudflare-resident/Dockerfile";
const EXECUTION_IMAGES = [SANDBOX, RESIDENT] as const;
const ALL_IMAGES = [...EXECUTION_IMAGES, BOT] as const;

// Feature: docs/reference/specs/harness-pi.md items 3 and 12: every image
// carries pi (`@earendil-works/pi-coding-agent`) at one exact pin: the two
// execution images, where a preset with a workspace runs it inside the run's
// own container, and the bot image, where a preset without a workspace runs
// it as a child of the bot. Static, like imageToolchain.test.ts: the image is
// built by check:image, and the pin is PROVEN at build time by the layer
// itself: the version on PATH is the pin, and pi's own help names the RPC
// mode the harness drives. The model key never travels with it either way:
// the run bearer is pi's only key.

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_VERSION = "0.85.1";
const PI_PROOF = `pi --version | grep -qx '${PI_VERSION}'`;

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The one RUN layer that installs pi. */
function piLayer(lines: string[]): string {
  return lines.find((l) => new RegExp(`^RUN\\b.*\\bnpm install -g ${PI_PACKAGE.replace("/", "\\/")}@`).test(l)) ?? "";
}

describe.each(ALL_IMAGES)("%s", (path) => {
  const lines = instructions(read(path));
  const layer = piLayer(lines);

  it("installs pi once, globally, at exactly the pin — read by the pin parser like pnpm's and playwright's", () => {
    const pins = imagePins(read(path)).filter((p) => p.tool === PI_PACKAGE);
    expect(pins.length, "one global install").toBe(1);
    expect(pins[0]).toMatchObject({ spec: PI_VERSION, floating: false });
  });

  it("proves at build time that the pi on PATH is the pin and that it speaks RPC mode", () => {
    expect(layer, "a RUN layer installs pi").not.toBe("");
    expect(layer).toContain(PI_PROOF);
    expect(layer).toContain("pi --help | grep -q -- '--mode <mode>'");
  });

  it("drops npm's cache in the same layer", () => {
    expect(layer).toContain("npm cache clean --force");
  });
});

describe.each(EXECUTION_IMAGES)("%s", (path) => {
  it("installs pi after Node was swapped for the repository's line, so the install runs on that Node and pi's engines floor holds", () => {
    const lines = instructions(read(path));
    const nodeProof = lines.findIndex((l) => /^RUN\b.*node --version \| grep -qx 'v24\./.test(l));
    expect(nodeProof).toBeGreaterThan(-1);
    expect(lines.indexOf(piLayer(lines))).toBeGreaterThan(nodeProof);
  });
});

describe("the three images carry one pi", () => {
  it("the same exact version in all of them, so a release ships one harness everywhere", () => {
    const pins = ALL_IMAGES.map((path) => imagePins(read(path)).find((p) => p.tool === PI_PACKAGE)?.spec);
    expect(new Set(pins).size).toBe(1);
    expect(pins[0]).toBe(PI_VERSION);
  });
});

describe("the resident image proves pi as a thread user", () => {
  it("runs the version proof once more as worker1 after the pool exists — exactly how a run's pi is started", () => {
    const lines = instructions(read(RESIDENT));
    const pool = lines.findIndex((l) => /useradd -m -u "\$\(\(2000 \+ i\)\)"/.test(l));
    const asWorker = lines.findIndex((l) => /^RUN su -s \/bin\/bash worker1 -c ".*pi --version \| grep -qx/.test(l));
    expect(pool).toBeGreaterThan(-1);
    expect(asWorker).toBeGreaterThan(pool);
  });
});

describe("the bot image", () => {
  const lines = instructions(read(BOT));
  it("installs pi in the runtime stage as root, before the switch to the bot's user, so the bot's user finds it on PATH and cannot alter it", () => {
    const runtime = Math.max(...lines.map((l, i) => (/^FROM node:\d+\.\d+\.\d+-slim$/.test(l) ? i : -1)));
    const user = lines.findIndex((l) => /^USER switchboard$/.test(l));
    const layer = lines.indexOf(piLayer(lines));
    expect(runtime).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(runtime);
    expect(layer).toBeGreaterThan(runtime);
    expect(layer).toBeLessThan(user);
  });
});
