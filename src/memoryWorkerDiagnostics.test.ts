import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const vitestBin = path.join(root, "node_modules/vitest/vitest.mjs");
const reporterPath = path.join(root, "deploy/cloudflare-memory/testDiagnosticsReporter.ts");
const setupPath = path.join(root, "deploy/cloudflare-memory/testDiagnostics.ts");

function fixtureDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `memory-diagnostics-${name}-`));
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

function runFixture(dir: string, config: string, testSource: string) {
  writeFileSync(path.join(dir, "vitest.config.ts"), config);
  writeFileSync(path.join(dir, "fixture.test.ts"), testSource);
  return spawnSync(process.execPath, [vitestBin, "run", "--config", "vitest.config.ts"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

describe("memory Worker diagnostics", () => {
  it("writes the diagnostic artifact and slowest-five summary for a green fixture run", () => {
    const dir = fixtureDir("reporter");
    const artifact = path.join(dir, "memory-test-diagnostics.json");
    const result = runFixture(
      dir,
      `import { defineConfig } from "vitest/config";\nimport { MemoryDiagnosticsReporter } from ${JSON.stringify(reporterPath)};\nexport default defineConfig({ test: { include: ["fixture.test.ts"], reporters: ["default", new MemoryDiagnosticsReporter({ outputFile: ${JSON.stringify(artifact)} })] } });\n`,
      `import { expect, it } from "vitest";\nit("green diagnostic fixture", () => { expect(2 + 2).toBe(4); });\n`,
    );

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(artifact, "utf8")) as {
      reason: string;
      tests: Array<{ test: string; durationMs: number; poolWorker: string; pendingPromises: string[] }>;
    };
    expect(report.reason).toBe("passed");
    expect(report.tests).toEqual([
      expect.objectContaining({
        test: "green diagnostic fixture",
        durationMs: expect.any(Number),
        poolWorker: expect.any(String),
        pendingPromises: [],
      }),
    ]);
    expect(result.stdout).toContain("[memory diagnostics] slowest 1: ");
    expect(result.stdout).toContain("green diagnostic fixture");
  });

  it("fails and clears a timer left open by its owner", () => {
    const dir = fixtureDir("timer");
    writeFileSync(
      path.join(dir, "setup.ts"),
      `import { installMemoryTestDiagnostics } from ${JSON.stringify(setupPath)};\ninstallMemoryTestDiagnostics();\n`,
    );
    const result = runFixture(
      dir,
      `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["fixture.test.ts"], setupFiles: ["./setup.ts"] } });\n`,
      `import { it } from "vitest";\nit("leaves a timer open", () => { setTimeout(() => {}, 60_000); });\n`,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "test ended with 1 pending timer(s): timeout anonymous (60000ms)",
    );
  });

  it("names the running test when a leaked promise rejects", () => {
    const dir = fixtureDir("unhandled");
    writeFileSync(
      path.join(dir, "setup.ts"),
      `import { installMemoryTestDiagnostics } from ${JSON.stringify(setupPath)};\ninstallMemoryTestDiagnostics();\n`,
    );
    const result = runFixture(
      dir,
      `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["fixture.test.ts"], setupFiles: ["./setup.ts"] } });\n`,
      `import { it } from "vitest";\nlet rejectLeak!: (reason: unknown) => void;\nit("leaks a promise", () => { void new Promise((_resolve, reject) => { rejectLeak = reject; }); });\nit("is running when the leak rejects", async () => { rejectLeak(new Error("fixture leak")); await new Promise((resolve) => setTimeout(resolve, 20)); });\n`,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'unhandled rejection while "is running when the leak rejects" was running: fixture leak',
    );
  });
});
