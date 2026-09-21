export const MEMORY_DIAGNOSTICS_ANNOTATION = "memory-worker-diagnostics";

export interface MemoryTestAnnotation {
  poolWorker: string;
  registeredBackgroundTasks: string[];
  pendingPromises: string[];
  pendingTimers: string[];
}

export interface MemoryTestDiagnostic extends MemoryTestAnnotation {
  test: string;
  file: string;
  state: "passed" | "failed" | "skipped" | "pending";
  durationMs: number;
  startedAt: number;
}

export interface MemoryTestDiagnosticsArtifact {
  reason: "passed" | "failed" | "interrupted";
  unhandledErrors: string[];
  tests: MemoryTestDiagnostic[];
}
