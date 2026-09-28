import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureOutputDirectory,
  listOutputFiles,
  publishOutputFile,
  readOutputFile,
  removeUnexpectedOutputFiles,
} from "./screenshotOutput.js";
import { withPinnedDirectory } from "./screenshotOutputPinned.js";

describe("screenshot output", () => {
  let root: string;
  let dir: string;
  let file: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "screenshot-output-"));
    dir = join(root, "screenshots");
    mkdirSync(dir);
    file = join(dir, "capture.png");
    outside = join(root, "outside.png");
    writeFileSync(outside, "outside bytes");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const inShots = <T>(action: Parameters<typeof withPinnedDirectory<T>>[2]): T | undefined =>
    withPinnedDirectory(root, "screenshots", action);

  it("rejects a symlinked prior PNG instead of reading its target", () => {
    symlinkSync(outside, file);
    expect(() => inShots((directory) => directory.read("capture.png"))).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside bytes");
  });

  it("replaces a swapped output symlink without writing through it", () => {
    writeFileSync(file, "old bytes");
    expect(inShots((directory) => directory.read("capture.png"))?.toString()).toBe("old bytes");
    unlinkSync(file);
    symlinkSync(outside, file);

    inShots((directory) => directory.publish("capture.png", Buffer.from("new bytes")));

    expect(lstatSync(file).isFile()).toBe(true);
    expect(inShots((directory) => directory.read("capture.png"))?.toString()).toBe("new bytes");
    expect(readFileSync(outside, "utf8")).toBe("outside bytes");
    expect(readdirSync(dir)).toEqual(["capture.png"]);
  });

  it("rejects a directory in place of a prior PNG", () => {
    mkdirSync(file);
    expect(() => inShots((directory) => directory.read("capture.png"))).toThrow();
  });

  it("creates a missing nested output directory and pins it before publication", () => {
    ensureOutputDirectory(root, "screenshots/nested");
    publishOutputFile(root, "screenshots/nested", "capture.png", Buffer.from("new bytes"));
    expect(readOutputFile(root, "screenshots/nested", "capture.png")?.toString()).toBe("new bytes");
  });

  it("rejects a symlinked screenshot directory before reading outside bytes", () => {
    rmSync(dir, { recursive: true });
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "capture.png"), "private bytes");
    symlinkSync(outsideDir, dir);

    expect(() => inShots((directory) => directory.read("capture.png"))).toThrow();
    expect(readFileSync(join(outsideDir, "capture.png"), "utf8")).toBe("private bytes");
  });

  it("rejects a symlinked screenshot directory before publishing outside bytes", () => {
    rmSync(dir, { recursive: true });
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "capture.png"), "private bytes");
    symlinkSync(outsideDir, dir);

    expect(() => inShots((directory) => directory.publish("capture.png", Buffer.from("new bytes")))).toThrow();
    expect(readFileSync(join(outsideDir, "capture.png"), "utf8")).toBe("private bytes");
  });

  it("rejects a symlinked manifest directory before removing an outside stray", () => {
    const manifest = join(dir, "manifest");
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "stray.json"), "private manifest");
    symlinkSync(outsideDir, manifest);

    expect(() =>
      withPinnedDirectory(root, "screenshots/manifest", (directory) => directory.remove("stray.json")),
    ).toThrow();
    expect(readFileSync(join(outsideDir, "stray.json"), "utf8")).toBe("private manifest");
  });

  it("keeps reads, publication, and stray cleanup in the pinned directory after a parent swap", () => {
    writeFileSync(file, "old bytes");
    writeFileSync(join(dir, "stray.png"), "old stray");
    const moved = join(root, "moved-shots");
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "capture.png"), "private bytes");
    writeFileSync(join(outsideDir, "stray.png"), "private stray");

    inShots((directory) => {
      renameSync(dir, moved);
      symlinkSync(outsideDir, dir);
      expect(directory.read("capture.png")?.toString()).toBe("old bytes");
      directory.publish("capture.png", Buffer.from("new bytes"));
      directory.remove("stray.png");
    });

    expect(readFileSync(join(moved, "capture.png"), "utf8")).toBe("new bytes");
    expect(readdirSync(moved)).toEqual(["capture.png"]);
    expect(readFileSync(join(outsideDir, "capture.png"), "utf8")).toBe("private bytes");
    expect(readFileSync(join(outsideDir, "stray.png"), "utf8")).toBe("private stray");
  });

  it("restores cwd after an operation throws", () => {
    const before = process.cwd();
    expect(() =>
      inShots(() => {
        throw new Error("expected failure");
      }),
    ).toThrow("expected failure");
    expect(process.cwd()).toBe(before);
  });

  it("rejects an asynchronous callback and restores cwd", () => {
    const before = process.cwd();
    expect(() => inShots(() => Promise.resolve())).toThrow("must be synchronous");
    expect(process.cwd()).toBe(before);
  });

  it("fails closed when the saved cwd path is replaced before restoration", () => {
    const before = process.cwd();
    const saved = join(root, "saved");
    const moved = join(root, "moved-saved");
    const outsideDir = join(root, "outside-dir");
    mkdirSync(saved);
    mkdirSync(outsideDir);
    process.chdir(saved);
    try {
      expect(() =>
        inShots(() => {
          renameSync(saved, moved);
          symlinkSync(outsideDir, saved);
        }),
      ).toThrow("Original working directory changed before restoration");
      expect(process.cwd()).toBe("/");
    } finally {
      process.chdir(before);
    }
  });

  it("does not redirect a concurrent worker's relative write", () => {
    const before = process.cwd();
    const ready = join(root, "probe-ready");
    const done = join(root, "probe-done");
    const probe = `
      import { existsSync, writeFileSync } from "node:fs";
      import { withPinnedDirectory } from ${JSON.stringify(join(before, "src/docs/screenshotOutputPinned.ts"))};
      withPinnedDirectory(${JSON.stringify(root)}, "screenshots", (directory) => {
        directory.names();
        writeFileSync(${JSON.stringify(ready)}, "ready");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(${JSON.stringify(done)})) Atomics.wait(wait, 0, 0, 5);
      });`;
    process.chdir(root);
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       const { existsSync, writeFileSync } = require("node:fs");
       const wait = new Int32Array(new SharedArrayBuffer(4));
       while (!existsSync(workerData.ready)) Atomics.wait(wait, 0, 0, 5);
       writeFileSync("worker-marker", "worker bytes");
       writeFileSync(workerData.done, "done");`,
      { eval: true, workerData: { ready, done } },
    );
    try {
      const child = spawnSync(join(before, "node_modules/.bin/tsx"), ["-e", probe], { timeout: 10_000 });
      expect(child.status, child.stderr.toString()).toBe(0);
      expect(existsSync(join(root, "worker-marker"))).toBe(true);
      expect(existsSync(join(dir, "worker-marker"))).toBe(false);
    } finally {
      process.chdir(before);
      void worker.terminate();
    }
  });

  it("routes capture reads, publication, and stray cleanup through the isolated worker", () => {
    writeFileSync(file, "old bytes");
    writeFileSync(join(dir, "stray.png"), "stray bytes");

    expect(readOutputFile(root, "screenshots", "capture.png")?.toString()).toBe("old bytes");
    publishOutputFile(root, "screenshots", "capture.png", Buffer.from("new bytes"));
    expect(listOutputFiles(root, "screenshots").sort()).toEqual(["capture.png", "stray.png"]);
    expect(removeUnexpectedOutputFiles(root, "screenshots", ".png", new Set(["capture.png"]))).toEqual(["stray.png"]);
    expect(readdirSync(dir)).toEqual(["capture.png"]);
  });

  it("isolated worker rejects a symlinked output parent for every operation", () => {
    rmSync(dir, { recursive: true });
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "capture.png"), "private bytes");
    writeFileSync(join(outsideDir, "stray.png"), "private stray");
    symlinkSync(outsideDir, dir);

    expect(() => readOutputFile(root, "screenshots", "capture.png")).toThrow();
    expect(() => publishOutputFile(root, "screenshots", "capture.png", Buffer.from("new bytes"))).toThrow();
    expect(() => removeUnexpectedOutputFiles(root, "screenshots", ".png", new Set(["capture.png"]))).toThrow();
    expect(readFileSync(join(outsideDir, "capture.png"), "utf8")).toBe("private bytes");
    expect(readFileSync(join(outsideDir, "stray.png"), "utf8")).toBe("private stray");
  });
});
import { spawnSync } from "node:child_process";
