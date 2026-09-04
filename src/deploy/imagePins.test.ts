import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { floatingImagePins, imagePins } from "./imagePins.js";

const ROOT = resolve(import.meta.dirname, "../..");
const IMAGES = ["deploy/cloudflare-resident/Dockerfile", "deploy/cloudflare-sandbox/Dockerfile", "Dockerfile"] as const;

// Feature: features/execution.md item 10 — the execution images' toolchain is
// PINNED. 2026-09-04: `RUN npm install -g pnpm@latest yarn@latest` in the
// resident image meant the pnpm major changed with the image, not with a
// commit; the 2026-09-03 rebuild ([#396](…)) silently moved pnpm 10 → 11,
// which stopped reading `package.json`'s `pnpm` field (overrides, patches,
// build allowlist). This fence is the reason that cannot recur silently.

describe("imagePins (parser)", () => {
  it("reads an exact global install as pinned", () => {
    expect(imagePins("RUN npm install -g pnpm@10.34.5 yarn@1.22.22\n")).toEqual([
      { tool: "pnpm", spec: "10.34.5", line: 1, floating: false },
      { tool: "yarn", spec: "1.22.22", line: 1, floating: false },
    ]);
  });

  it("flags @latest, a range, and a bare name with no version", () => {
    const pins = imagePins("RUN npm i -g pnpm@latest\nRUN npm install -g yarn@^1\nRUN corepack prepare pnpm --activate\n");
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
