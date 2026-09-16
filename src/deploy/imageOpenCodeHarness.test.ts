import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPENCODE_VERSION, OPENCODE_VERSION_TEXT } from "../core/harness/opencode/client.js";
import { imagePins } from "./imagePins.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const BOT = "Dockerfile";
const SANDBOX = "deploy/cloudflare-sandbox/Dockerfile";
const RESIDENT = "deploy/cloudflare-resident/Dockerfile";
const EXECUTION_IMAGES = [SANDBOX, RESIDENT] as const;
const ALL_IMAGES = [...EXECUTION_IMAGES, BOT] as const;

// Feature: docs/reference/specs/harness.md, the OpenCode process item; record
// 0038's fourth amendment: every image carries OpenCode (`@opencode/cli`) at
// one exact pin beside pi — the two execution images, where a preset with a
// workspace runs its server inside the run's own container, and the bot
// image, where a preset without a workspace runs it as a child of the bot.
// Static, like imagePiHarness.test.ts: the image is built by check:image, and
// the pin is PROVEN at build time by the layer itself: the binary on PATH
// prints the pin's version text. The wrapper's postinstall picks and links the
// platform binary, so it is the one install script the layer allows, by name.
// The model key never travels with it: the run bearer is the server's only key.

export const OPENCODE_PACKAGE = "@opencode/cli";
const OPENCODE_PROOF = `opencode --version | grep -qx '${OPENCODE_VERSION_TEXT}'`;

/** A literal for a RegExp: every metacharacter escaped, the backslash included. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALLOW_SCRIPTS = `--allow-scripts=${OPENCODE_PACKAGE}`;

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The one RUN layer that installs OpenCode. */
function openCodeLayer(lines: string[]): string {
  return (
    lines.find((l) => new RegExp(`^RUN\\b.*\\bnpm install -g .*${OPENCODE_PACKAGE.replace("/", "\\/")}@`).test(l)) ?? ""
  );
}

describe.each(ALL_IMAGES)("%s", (path) => {
  const lines = instructions(read(path));
  const layer = openCodeLayer(lines);

  it("installs OpenCode once, globally, at exactly the pin — read by the pin parser like pi's", () => {
    const pins = imagePins(read(path)).filter((p) => p.tool === OPENCODE_PACKAGE);
    expect(pins.length, "one global install").toBe(1);
    expect(pins[0]).toMatchObject({ spec: OPENCODE_VERSION, floating: false });
  });

  it("allows the wrapper's install script by name, scoped to the one package and nothing else in the layer", () => {
    expect(layer, "a RUN layer installs OpenCode").not.toBe("");
    const flags = layer.match(/--allow-scripts=\S+/g) ?? [];
    expect(flags).toEqual([ALLOW_SCRIPTS]);
    // The install carries the one package: the allowlist could not quietly cover another.
    expect(layer).toMatch(
      new RegExp(
        `npm install -g ${escapeRegExp(ALLOW_SCRIPTS)} ${escapeRegExp(OPENCODE_PACKAGE)}@${escapeRegExp(OPENCODE_VERSION)} `,
      ),
    );
  });

  it("proves at build time that the opencode on PATH prints the pin's version text, exactly", () => {
    expect(layer).toContain(OPENCODE_PROOF);
  });

  it("drops npm's cache in the same layer", () => {
    expect(layer).toContain("npm cache clean --force");
  });

  it("is its own layer beside pi's, so a bump of one never rebuilds the other's proof", () => {
    expect(layer).not.toContain("pi-coding-agent");
    const pi = lines.find((l) => /^RUN\b.*\bnpm install -g @earendil-works\/pi-coding-agent@/.test(l)) ?? "";
    expect(pi).not.toBe("");
    expect(lines.indexOf(layer)).toBeGreaterThan(lines.indexOf(pi));
  });
});

describe.each(EXECUTION_IMAGES)("%s", (path) => {
  it("installs OpenCode after Node was swapped for the repository's line, so the wrapper's postinstall runs on that Node", () => {
    const lines = instructions(read(path));
    const nodeProof = lines.findIndex((l) => /^RUN\b.*node --version \| grep -qx 'v24\./.test(l));
    expect(nodeProof).toBeGreaterThan(-1);
    expect(lines.indexOf(openCodeLayer(lines))).toBeGreaterThan(nodeProof);
  });
});

describe("the three images carry one OpenCode", () => {
  it("the same exact version in all of them, so a release ships one second harness everywhere — a change to one image without the others fails here", () => {
    const pins = ALL_IMAGES.map((path) => imagePins(read(path)).find((p) => p.tool === OPENCODE_PACKAGE)?.spec);
    expect(new Set(pins).size).toBe(1);
    expect(pins[0]).toBe(OPENCODE_VERSION);
  });

  it("the version the images prove is the version the readiness probe demands of the health answer", () => {
    expect(OPENCODE_VERSION_TEXT).toBe(`opencode v${OPENCODE_VERSION}`);
    for (const path of ALL_IMAGES)
      expect(openCodeLayer(instructions(read(path)))).toContain(`'opencode v${OPENCODE_VERSION}'`);
  });

  it("the protocol and schema packages the client is derived from are devDependencies at the same exact pin, so a bump moves the client's test with the images", () => {
    const pkg = JSON.parse(read("package.json")) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.["@opencode/protocol"]).toBe(OPENCODE_VERSION);
    expect(pkg.devDependencies?.["@opencode/schema"]).toBe(OPENCODE_VERSION);
  });
});

describe("the resident image proves OpenCode as a thread user", () => {
  it("runs the version proof once more as worker1 after the pool exists — exactly how a run's server is started", () => {
    const lines = instructions(read(RESIDENT));
    const pool = lines.findIndex((l) => /useradd -m -u "\$\(\(2000 \+ i\)\)"/.test(l));
    const asWorker = lines.findIndex((l) =>
      new RegExp(`^RUN su -s /bin/bash worker1 -c ".*${escapeRegExp(OPENCODE_PROOF)}`).test(l),
    );
    expect(pool).toBeGreaterThan(-1);
    expect(asWorker).toBeGreaterThan(pool);
  });
});

describe("the bot image", () => {
  const lines = instructions(read(BOT));
  it("installs OpenCode in the runtime stage as root, before the switch to the bot's user, so the bot's user finds it on PATH and cannot alter it", () => {
    const runtime = Math.max(...lines.map((l, i) => (/^FROM node:\d+\.\d+\.\d+-slim$/.test(l) ? i : -1)));
    const user = lines.findIndex((l) => /^USER switchboard$/.test(l));
    const layer = lines.indexOf(openCodeLayer(lines));
    expect(runtime).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(runtime);
    expect(layer).toBeGreaterThan(runtime);
    expect(layer).toBeLessThan(user);
  });
});
