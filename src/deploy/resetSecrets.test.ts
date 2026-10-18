import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareResetSecrets } from "./resetSecrets.js";
import { TEST_PROFILE } from "./testing/profile.js";

const values = {
  MEMORY_TOKEN: "original-memory",
  SANDBOX_TOKEN: "original-sandbox",
  RESIDENT_READ_TOKEN: "original-read",
  RESIDENT_DRAIN_TOKEN: "original-drain",
};
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "reset-secret-test-"));
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  vi.stubEnv("RESET_ENVIRONMENT", "staging");
  vi.stubEnv("RESET_ACCOUNT", TEST_PROFILE.account);
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const profile = () => ({ ...TEST_PROFILE, secretsSource: join(directory, "secrets") });

describe("reset original secret preparation", () => {
  it("creates private files and reuses an identical original without rewriting its bytes", () => {
    const selected = profile();
    expect(prepareResetSecrets(selected, JSON.stringify(values))).toEqual({
      directory: selected.secretsSource,
      names: 4,
    });
    const path = join(selected.secretsSource, "MEMORY_TOKEN");
    expect(readFileSync(path, "utf8")).toBe("original-memory");
    writeFileSync(path, "original-memory\n");
    expect(prepareResetSecrets(selected, JSON.stringify(values))).toEqual({
      directory: selected.secretsSource,
      names: 4,
    });
    expect(readFileSync(path, "utf8")).toBe("original-memory\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a different existing value and leaves the original intact", () => {
    const selected = profile();
    mkdirSync(selected.secretsSource);
    const path = join(selected.secretsSource, "MEMORY_TOKEN");
    writeFileSync(path, "different-original");
    expect(() => prepareResetSecrets(selected, JSON.stringify(values))).toThrow("existing original secret differs");
    expect(readFileSync(path, "utf8")).toBe("different-original");
  });

  it("refuses a symbolic link and leaves its target intact", () => {
    const selected = profile();
    mkdirSync(selected.secretsSource);
    const target = join(directory, "unrelated-file");
    writeFileSync(target, "unrelated value");
    symlinkSync(target, join(selected.secretsSource, "MEMORY_TOKEN"));
    expect(() => prepareResetSecrets(selected, JSON.stringify(values))).toThrow(/ELOOP|symbolic link/);
    expect(readFileSync(target, "utf8")).toBe("unrelated value");
  });
});
