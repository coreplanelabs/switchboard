import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Reporter, TestRunEndReason } from "vitest/reporters";
import {
  MEMORY_DIAGNOSTICS_ANNOTATION,
  type MemoryTestAnnotation,
  type MemoryTestDiagnostic,
  type MemoryTestDiagnosticsArtifact,
} from "./testDiagnosticsProtocol.ts";

type TestCase = Parameters<NonNullable<Reporter["onTestCaseResult"]>>[0];

export interface MemoryDiagnosticsReporterOptions {
  outputFile?: string;
  writeLog?: (line: string) => void;
}

function annotationFor(testCase: TestCase): MemoryTestAnnotation {
  const annotation = (testCase.meta() as Record<string, unknown>)[MEMORY_DIAGNOSTICS_ANNOTATION];
  if (
    typeof annotation === "object" &&
    annotation !== null &&
    "poolWorker" in annotation &&
    typeof annotation.poolWorker === "string"
  ) {
    return annotation as MemoryTestAnnotation;
  }
  return {
    poolWorker: "unknown",
    registeredBackgroundTasks: [],
    pendingPromises: [],
    pendingTimers: [],
  };
}

function errorMessage(error: { message?: string } | unknown): string {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error);
}

export class MemoryDiagnosticsReporter implements Reporter {
  readonly #outputFile: string;
  readonly #writeLog: (line: string) => void;
  readonly #tests: MemoryTestDiagnostic[] = [];

  constructor(options: MemoryDiagnosticsReporterOptions = {}) {
    this.#outputFile =
      options.outputFile ??
      process.env.MEMORY_TEST_DIAGNOSTICS_PATH ??
      path.join(process.cwd(), "artifacts", "memory-test-diagnostics.json");
    this.#writeLog = options.writeLog ?? ((line) => process.stdout.write(`${line}\n`));
  }

  onTestCaseResult(testCase: TestCase): void {
    const diagnostic = testCase.diagnostic();
    const result = testCase.result();
    this.#tests.push({
      test: testCase.fullName,
      file: testCase.module.moduleId,
      state: result.state,
      durationMs: diagnostic?.duration ?? 0,
      startedAt: diagnostic?.startTime ?? 0,
      ...annotationFor(testCase),
    });
  }

  async onTestRunEnd(
    _testModules: Parameters<NonNullable<Reporter["onTestRunEnd"]>>[0],
    unhandledErrors: Parameters<NonNullable<Reporter["onTestRunEnd"]>>[1],
    reason: TestRunEndReason,
  ): Promise<void> {
    const artifact: MemoryTestDiagnosticsArtifact = {
      reason,
      unhandledErrors: unhandledErrors.map(errorMessage),
      tests: this.#tests,
    };
    await mkdir(path.dirname(this.#outputFile), { recursive: true });
    await writeFile(this.#outputFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    const slowest = [...this.#tests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    const summary =
      slowest.length === 0
        ? "no completed tests"
        : slowest.map((test) => `${Math.round(test.durationMs)}ms ${test.test}`).join("; ");
    this.#writeLog(`[memory diagnostics] slowest ${slowest.length}: ${summary}`);
  }
}
