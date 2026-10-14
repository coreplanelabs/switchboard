/** Command facts shared by executor clients and Worker-safe receipt types. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

/** Closed infrastructure reasons shared with Worker-safe receipt validation. */
export const EXEC_INFRA_REASONS = [
  "transport-lost",
  "deadline-passed",
  "empty-failure",
  "worker-unavailable",
  "answered",
  "refused",
  "aborted",
] as const;
export type ExecInfraReason = (typeof EXEC_INFRA_REASONS)[number];
