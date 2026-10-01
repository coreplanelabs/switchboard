/** Command facts shared by executor clients and Worker-safe receipt types. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}
