import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFileIfPresent } from "./envFile.js";

const A = "SWITCHBOARD_ENVFILE_TEST_A";
const B = "SWITCHBOARD_ENVFILE_TEST_B";
let dir: string | undefined;

afterEach(() => {
  delete process.env[A];
  delete process.env[B];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("loadEnvFileIfPresent", () => {
  it("loads the file's variables into the environment, and an already-set variable wins over the file", () => {
    dir = mkdtempSync(join(tmpdir(), "envfile-"));
    const path = join(dir, ".env");
    writeFileSync(path, `${A}=from-file\n${B}=from-file\n`);
    process.env[B] = "from-shell";
    expect(loadEnvFileIfPresent(path)).toBe(true);
    expect(process.env[A]).toBe("from-file");
    expect(process.env[B]).toBe("from-shell");
  });

  it("a missing file is not an error: nothing is loaded and it says so", () => {
    dir = mkdtempSync(join(tmpdir(), "envfile-"));
    expect(loadEnvFileIfPresent(join(dir, ".env"))).toBe(false);
    expect(process.env[A]).toBeUndefined();
  });

  it("any other failure is raised, never swallowed (a directory where the file should be)", () => {
    dir = mkdtempSync(join(tmpdir(), "envfile-"));
    expect(() => loadEnvFileIfPresent(dir!)).toThrow();
  });
});
